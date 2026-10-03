import http from 'http'
import type { Socket } from 'net'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import {
  AUTH_TIMEOUT_MS,
  CloseCode,
  PING_INTERVAL_MS,
  decodeClientMessage,
  encodeMessage,
  type AccessClaims,
  type AttachMode,
  type SessionInfo
} from '@remoterm/protocol'
import type { AgentAuth } from './auth'
import type { HubClient, HubHandle, PtyHub } from './ptyHub'
import { SshService, type SshServiceOptions } from './sshServer'
import { WsDuplex } from './wsDuplex'

/** Persisted metadata for a session (from the sessions file via the renderer). */
export interface SessionMeta {
  id: string
  name: string
  tool: string
  cwd: string
  folder: string | null
  color: string | null
}

export interface AgentServerOptions {
  hub: PtyHub
  auth: AgentAuth
  listSessions: () => SessionMeta[]
  port: number
  host?: string
  authTimeoutMs?: number
  pingIntervalMs?: number
  /** Enables `WS /ws/ssh`. */
  ssh?: Pick<SshServiceOptions, 'hostKey' | 'keys' | 'mode'>
}

interface Conn {
  ws: WebSocket
  iat: number
}

const ATTACH_PATH = /^\/ws\/attach\/([^/]+)$/

export class AgentServer {
  private server: http.Server | null = null
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  private conns = new Set<Conn>()
  private unsubRevoke: (() => void) | null = null
  private sockets = new Set<Socket>()
  private sshService: SshService | null = null
  port = 0

  constructor(private o: AgentServerOptions) {
    if (o.ssh) {
      this.sshService = new SshService({
        ...o.ssh,
        hub: o.hub,
        ownerLogin: () => o.auth.ownerLogin,
        listSessions: () => this.sessions()
      })
    }
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.handleHttp(req, res))
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head))
    server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.o.port, this.o.host ?? '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    this.unsubRevoke = this.o.auth.onRevokedBefore((v) => {
      for (const c of [...this.conns]) {
        if (c.iat <= v) c.ws.close(CloseCode.Unauthorized, 'revoked')
      }
    })
    return this.port
  }

  async stop(): Promise<void> {
    this.unsubRevoke?.()
    this.unsubRevoke = null
    this.sshService?.closeAll()
    for (const c of [...this.conns]) c.ws.close(CloseCode.Unauthorized, 'agent stopping')
    const server = this.server
    this.server = null
    if (!server) return
    // Give close frames a moment to flush, then force the rest.
    const force = setTimeout(() => {
      for (const c of this.conns) c.ws.terminate()
      for (const s of this.sockets) s.destroy()
    }, 500)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    clearTimeout(force)
  }

  // --- HTTP ---

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
      if (!m) return json(401, { error: 'unauthorized' })
      try {
        await this.o.auth.verify(m[1])
      } catch {
        return json(401, { error: 'unauthorized' })
      }
      return json(200, this.sessions())
    }
    json(404, { error: 'not_found' })
  }

  private sessions(): SessionInfo[] {
    const metas = this.o.listSessions()
    const seen = new Set<string>()
    const out: SessionInfo[] = metas.map((m) => {
      seen.add(m.id)
      const h = this.o.hub.info(m.id)
      return {
        id: m.id,
        name: m.name,
        tool: m.tool,
        cwd: m.cwd,
        folder: m.folder,
        color: m.color,
        running: !!h?.running,
        busy: !!h?.busy,
        cols: h?.cols ?? 80,
        rows: h?.rows ?? 24
      }
    })
    for (const h of this.o.hub.list()) {
      if (seen.has(h.id)) continue
      out.push({
        id: h.id,
        name: h.id,
        tool: '',
        cwd: '',
        folder: null,
        color: null,
        running: h.running,
        busy: h.busy,
        cols: h.cols,
        rows: h.rows
      })
    }
    return out
  }

  // --- WebSocket ---

  private handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/ws/ssh' && this.sshService) {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSshSocket(ws, this.sshService!))
      return
    }
    const m = ATTACH_PATH.exec(url.pathname)
    const modeParam = url.searchParams.get('mode') ?? 'control'
    if (!m || (modeParam !== 'control' && modeParam !== 'view')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const sessionId = decodeURIComponent(m[1])
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, sessionId, modeParam))
  }

  /** `/ws/ssh`: first-frame JWT auth, then the remaining binary frames are an SSH byte stream. */
  private onSshSocket(ws: WebSocket, ssh: SshService): void {
    let state: 'unauthenticated' | 'verifying' | 'ssh' | 'closed' = 'unauthenticated'
    let duplex: WsDuplex | null = null
    let conn: Conn | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    const early: Buffer[] = [] // SSH client bytes that arrive while the token is being verified

    const authTimer = setTimeout(() => {
      if (state !== 'ssh') ws.close(CloseCode.Unauthorized, 'auth timeout')
    }, this.o.authTimeoutMs ?? AUTH_TIMEOUT_MS)

    ws.on('close', () => {
      state = 'closed'
      clearTimeout(authTimer)
      if (ping) clearInterval(ping)
      if (conn) this.conns.delete(conn)
    })
    ws.on('error', () => ws.terminate())

    const authenticate = async (token: string): Promise<void> => {
      state = 'verifying'
      let claims: AccessClaims
      try {
        claims = await this.o.auth.verify(token)
      } catch {
        if (state === 'verifying') ws.close(CloseCode.Unauthorized, 'unauthorized')
        return
      }
      if (state !== 'verifying') return
      clearTimeout(authTimer)
      conn = { ws, iat: claims.iat }
      this.conns.add(conn)
      // Constructed after ws 'message' handling below so frames are never lost: bytes seen so far are replayed.
      duplex = new WsDuplex(ws)
      state = 'ssh'
      ssh.handle(duplex)
      for (const b of early) duplex.feed(b)
      early.length = 0
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping()
      }, this.o.pingIntervalMs ?? PING_INTERVAL_MS)
      ping.unref?.()
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (state === 'ssh') return // WsDuplex has its own listener
      if (state === 'verifying') {
        if (isBinary) early.push(rawToBuffer(data))
        return
      }
      if (state !== 'unauthenticated') return
      const msg = isBinary ? null : decodeClientMessage(rawToBuffer(data).toString('utf8'))
      if (!msg || msg.t !== 'auth') {
        ws.close(CloseCode.Unauthorized, 'auth required')
        return
      }
      void authenticate(msg.token)
    })
  }

  private onSocket(ws: WebSocket, sessionId: string, mode: AttachMode): void {
    let state: 'unauthenticated' | 'verifying' | 'attached' | 'closed' = 'unauthenticated'
    let handle: HubHandle | null = null
    let conn: Conn | null = null
    let ping: ReturnType<typeof setInterval> | null = null

    const authTimer = setTimeout(() => {
      if (state !== 'attached') ws.close(CloseCode.Unauthorized, 'auth timeout')
    }, this.o.authTimeoutMs ?? AUTH_TIMEOUT_MS)

    const cleanup = (): void => {
      state = 'closed'
      clearTimeout(authTimer)
      if (ping) clearInterval(ping)
      handle?.detach()
      if (conn) this.conns.delete(conn)
    }
    ws.on('close', cleanup)
    ws.on('error', () => ws.terminate())

    const client: HubClient = {
      kind: 'remote',
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true })
      },
      snapshot: (s) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage({ t: 'snapshot', ...s }))
      },
      meta: (m) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage({ t: 'meta', ...m }))
      },
      exit: (code) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeMessage({ t: 'exit', code }))
          ws.close(1000, 'session exited')
        }
      },
      bufferedAmount: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason)
    }

    const authenticate = async (token: string): Promise<void> => {
      state = 'verifying'
      let claims: AccessClaims
      try {
        claims = await this.o.auth.verify(token)
      } catch {
        if (state === 'verifying') ws.close(CloseCode.Unauthorized, 'unauthorized')
        return
      }
      if (state !== 'verifying') return // socket closed while verifying
      clearTimeout(authTimer)
      const h = this.o.hub.attach(sessionId, client, mode)
      if (!h) {
        ws.close(CloseCode.NotFound, 'session not found or not running')
        return
      }
      handle = h
      conn = { ws, iat: claims.iat }
      this.conns.add(conn)
      state = 'attached'
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage({ t: 'ping' }))
      }, this.o.pingIntervalMs ?? PING_INTERVAL_MS)
      ping.unref?.()
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (state === 'attached') {
        if (isBinary) {
          handle?.write(rawToBuffer(data).toString('utf8'))
          return
        }
        const msg = decodeClientMessage(rawToBuffer(data).toString('utf8'))
        if (!msg) return
        if (msg.t === 'resize') handle?.resize(msg.cols, msg.rows)
        else if (msg.t === 'focus') handle?.focus()
        // pong needs no action; any traffic proves liveness
        return
      }
      if (state !== 'unauthenticated') return
      // The first frame must be a text auth frame.
      const msg = isBinary ? null : decodeClientMessage(rawToBuffer(data).toString('utf8'))
      if (!msg || msg.t !== 'auth') {
        ws.close(CloseCode.Unauthorized, 'auth required')
        return
      }
      void authenticate(msg.token)
    })
  }
}

function rawToBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d
  if (Array.isArray(d)) return Buffer.concat(d)
  return Buffer.from(d)
}
