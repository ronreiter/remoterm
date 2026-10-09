import WebSocket from 'ws'
import { AttachClient, CloseCode, type AttachMode, type SessionInfo } from '@remoterm/protocol'
import { AccountError } from './account'

/**
 * Remote client (main process only): lists the user's other devices and their sessions,
 * and runs one AttachClient per remote tab, bridging bytes/control to the renderer.
 * Every network call lives here so tokens never reach the renderer and there is no CORS.
 */

export const DEFAULT_TUNNEL_DOMAIN = 'remoterm.io'
export const tunnelDomainFromEnv = (env: NodeJS.ProcessEnv = process.env): string =>
  env.REMOTERM_TUNNEL_DOMAIN || DEFAULT_TUNNEL_DOMAIN

export type RemoteTabStatus = 'connecting' | 'live' | 'offline' | 'ended' | 'auth'

export interface TabStatusEvent {
  tabId: string
  status: RemoteTabStatus
  /** Close code that caused `ended` / `auth` (4404, 4401, 4409), when known. */
  code?: number
  /** Exit code of the remote process, when it exited. */
  exitCode?: number
}

export type TabOutputEvent =
  | { tabId: string; kind: 'snapshot'; data: string; cols: number; rows: number }
  | { tabId: string; kind: 'data'; data: Uint8Array }

export interface RemoteDevice {
  id: string
  name: string
  online: boolean
  lastSeen: number | null
  /** Running sessions only. Empty for offline devices. */
  sessions: SessionInfo[]
  /** Set when an online device could not be queried. */
  error?: 'offline' | 'auth'
}

export type ListResult =
  | { ok: true; devices: RemoteDevice[] }
  | { ok: false; error: 'signed_out' | 'network' | 'server' }

export interface AttachRequest {
  tabId: string
  deviceId: string
  sessionId: string
  mode: AttachMode
}

export interface RemoteClientOptions {
  apiBase: string
  /** `force` skips the cache (used after the API rejects a token). */
  getAccessToken: (force?: boolean) => Promise<string>
  /** This Mac's own device id, excluded from the list. */
  ownDeviceId: () => string | undefined
  emitOutput: (e: TabOutputEvent) => void
  emitStatus: (e: TabStatusEvent) => void
  fetch?: typeof fetch
  WebSocketImpl?: typeof WebSocket
  tunnelDomain?: string
  /** Override how a device id maps to its agent's http/ws origins (tests). */
  agentOrigin?: (deviceId: string) => { http: string; ws: string }
  backoff?: { initialMs?: number; maxMs?: number; factor?: number }
}

interface Tab {
  client: AttachClient
  mode: AttachMode
  /** The terminal reached a final state (ended / auth); later close events must not override it. */
  final: boolean
}

class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`)
  }
}

const isSignedOut = (e: unknown): boolean => e instanceof AccountError && e.code === 'signed_out'
const isOfflineStatus = (s: number): boolean => s === 502 || s === 503 || s === 504 || s >= 520

export class RemoteClient {
  private tabs = new Map<string, Tab>()
  private base: string
  private domain: string

  constructor(private o: RemoteClientOptions) {
    this.base = o.apiBase.replace(/\/+$/, '')
    this.domain = o.tunnelDomain ?? DEFAULT_TUNNEL_DOMAIN
  }

  private f(): typeof fetch {
    return this.o.fetch ?? fetch
  }

  private origin(deviceId: string): { http: string; ws: string } {
    if (this.o.agentOrigin) return this.o.agentOrigin(deviceId)
    const loopback = this.domain.startsWith('localhost') || this.domain.startsWith('127.')
    const host = `${deviceId}.${this.domain}`
    return loopback ? { http: `http://${host}`, ws: `ws://${host}` } : { http: `https://${host}`, ws: `wss://${host}` }
  }

  /** Authenticated API call; retries once with a forced token refresh on 401. */
  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const call = async (force: boolean): Promise<Response> =>
      this.f()(`${this.base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${await this.o.getAccessToken(force)}` }
      })
    const res = await call(false)
    return res.status === 401 ? call(true) : res
  }

  /** A fresh device-scoped (aud = deviceId) JWT. */
  private async attachToken(deviceId: string): Promise<string> {
    const res = await this.api(`/devices/${encodeURIComponent(deviceId)}/attach-token`, { method: 'POST' })
    if (!res.ok) throw new HttpStatusError(res.status)
    return ((await res.json()) as { token: string }).token
  }

  // --- listing ---

  async listDevices(): Promise<ListResult> {
    let raw: any[]
    try {
      const res = await this.api('/devices')
      if (res.status === 401) return { ok: false, error: 'signed_out' }
      if (!res.ok) return { ok: false, error: 'server' }
      raw = (await res.json()) as any[]
    } catch (e) {
      return { ok: false, error: isSignedOut(e) ? 'signed_out' : 'network' }
    }
    const own = this.o.ownDeviceId()
    const others = (Array.isArray(raw) ? raw : []).filter((d) => d && typeof d.id === 'string' && d.id !== own)
    const devices = await Promise.all(
      others.map(async (d): Promise<RemoteDevice> => {
        const base: RemoteDevice = {
          id: d.id,
          name: typeof d.name === 'string' ? d.name : d.id,
          online: !!d.online,
          lastSeen: typeof d.last_seen === 'number' ? d.last_seen : null,
          sessions: []
        }
        if (!base.online) return base
        try {
          return { ...base, sessions: (await this.deviceSessions(d.id)).filter((s) => s.running) }
        } catch (e) {
          return { ...base, error: e instanceof HttpStatusError && e.status === 401 ? 'auth' : 'offline' }
        }
      })
    )
    return { ok: true, devices }
  }

  private async deviceSessions(deviceId: string): Promise<SessionInfo[]> {
    const url = `${this.origin(deviceId).http}/api/sessions`
    const call = async (): Promise<Response> =>
      this.f()(url, { headers: { authorization: `Bearer ${await this.attachToken(deviceId)}` } })
    let res = await call()
    if (res.status === 401) res = await call() // fresh attach token, once
    if (res.status === 401) throw new HttpStatusError(401)
    if (isOfflineStatus(res.status)) throw new HttpStatusError(res.status)
    if (!res.ok) throw new HttpStatusError(res.status)
    const j = await res.json()
    return Array.isArray(j) ? (j as SessionInfo[]) : []
  }

  // --- tabs ---

  /** Attaches (or re-attaches, e.g. to change mode) the tab to a remote session. */
  attach(req: AttachRequest): void {
    this.detach(req.tabId)
    const { tabId, deviceId, sessionId, mode } = req
    const emit = (status: RemoteTabStatus, extra: Partial<TabStatusEvent> = {}): void => {
      const t = this.tabs.get(tabId)
      if (!t || t.client !== client || t.final) return
      if (status === 'ended' || status === 'auth') t.final = true
      this.o.emitStatus({ tabId, status, ...extra })
    }
    const client: AttachClient = new AttachClient({
      url: `${this.origin(deviceId).ws}/ws/attach/${encodeURIComponent(sessionId)}?mode=${mode}`,
      WebSocketImpl: (this.o.WebSocketImpl ?? WebSocket) as unknown as typeof globalThis.WebSocket,
      backoff: this.o.backoff,
      getToken: async () => {
        try {
          return await this.attachToken(deviceId)
        } catch (e) {
          if (isSignedOut(e) || (e instanceof HttpStatusError && e.status === 401)) {
            // Credentials are gone: stop retrying and ask for sign-in.
            emit('auth', { code: CloseCode.Unauthorized })
            setImmediate(() => client.close())
          }
          throw e
        }
      }
    })
    this.tabs.set(tabId, { client, mode, final: false })

    client.on('state', (s) => {
      if (s === 'connecting') emit('connecting')
      else if (s === 'open') emit('live')
      else if (s === 'reconnecting') emit('offline')
    })
    client.on('snapshot', (s) => {
      this.o.emitOutput({ tabId, kind: 'snapshot', data: s.data, cols: s.cols, rows: s.rows })
      if (mode === 'control') client.focus()
    })
    client.on('data', (data) => this.o.emitOutput({ tabId, kind: 'data', data }))
    client.on('exit', (exitCode) => emit('ended', { exitCode }))
    client.on('close', (code) => {
      if (code === CloseCode.Unauthorized) emit('auth', { code })
      else if (code === CloseCode.NotFound || code === CloseCode.Replaced) emit('ended', { code })
      else emit('offline', { code })
    })
    client.connect().catch(() => {
      /* surfaced through status events */
    })
  }

  write(tabId: string, data: string): void {
    const t = this.tabs.get(tabId)
    if (t && t.mode === 'control') t.client.write(data) // the host drops view-mode input anyway
  }

  resize(tabId: string, cols: number, rows: number): void {
    const t = this.tabs.get(tabId)
    if (t && t.mode === 'control') t.client.resize(cols, rows)
  }

  detach(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.tabs.delete(tabId)
    t.client.close()
  }

  /** Signed out: every attached tab stops retrying and shows "sign-in needed". */
  failAllAuth(): void {
    for (const [tabId, t] of [...this.tabs]) {
      t.client.close()
      if (!t.final) {
        t.final = true
        this.o.emitStatus({ tabId, status: 'auth', code: CloseCode.Unauthorized })
      }
    }
  }

  detachAll(): void {
    for (const id of [...this.tabs.keys()]) this.detach(id)
  }
}
