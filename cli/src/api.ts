import type { SessionInfo } from '@remoterm/protocol'

export class CliError extends Error {
  constructor(message: string, public exitCode = 1) {
    super(message)
  }
}

export interface Device {
  id: string
  name: string
  hostname: string
  port: number
  created_at: number
  last_seen: number | null
  online: boolean
}

export type FetchLike = typeof fetch

export interface DeviceLoginStart {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export async function startDeviceLogin(api: string, f: FetchLike = fetch): Promise<DeviceLoginStart> {
  const r = await f(`${api}/auth/device`, { method: 'POST' })
  if (!r.ok) throw new CliError(`could not start login (HTTP ${r.status})`)
  return (await r.json()) as DeviceLoginStart
}

export interface PollOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Polls POST /auth/device/token until approved. Returns the refresh token. */
export async function pollDeviceToken(api: string, start: DeviceLoginStart, o: PollOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  let intervalMs = Math.max(1, start.interval || 5) * 1000
  const deadline = now() + start.expires_in * 1000
  for (;;) {
    await sleep(intervalMs)
    if (now() > deadline) throw new CliError('login timed out; run `remoterm login` again')
    const r = await f(`${api}/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code })
    })
    const body = (await r.json().catch(() => ({}))) as { refresh_token?: string; error?: string }
    if (r.ok && body.refresh_token) return body.refresh_token
    switch (body.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        intervalMs += 5000
        continue
      case 'expired_token':
        throw new CliError('login code expired; run `remoterm login` again')
      default:
        throw new CliError(`login failed: ${body.error ?? `HTTP ${r.status}`}`)
    }
  }
}

/** Authenticated API access: exchanges the stored refresh token for short-lived access tokens. */
export class Api {
  private access: { token: string; exp: number } | null = null

  constructor(
    public readonly origin: string,
    private refreshToken: string | null,
    private f: FetchLike = fetch,
    private now: () => number = Date.now
  ) {}

  private async accessToken(): Promise<string> {
    if (!this.refreshToken) throw new CliError('not logged in; run `remoterm login`')
    if (this.access && this.access.exp - 30_000 > this.now()) return this.access.token
    const r = await this.f(`${this.origin}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken })
    })
    if (r.status === 401) throw new CliError('session expired or revoked; run `remoterm login`')
    if (!r.ok) throw new CliError(`could not refresh credentials (HTTP ${r.status})`)
    const b = (await r.json()) as { access_token: string; expires_in: number }
    this.access = { token: b.access_token, exp: this.now() + b.expires_in * 1000 }
    return b.access_token
  }

  private async call<T>(method: string, path: string): Promise<T> {
    const token = await this.accessToken()
    const r = await this.f(`${this.origin}${path}`, { method, headers: { authorization: `Bearer ${token}` } })
    if (r.status === 401) throw new CliError('session expired or revoked; run `remoterm login`')
    if (r.status === 404) throw new CliError('not found')
    if (!r.ok) throw new CliError(`API error (HTTP ${r.status})`)
    return (await r.json()) as T
  }

  me(): Promise<{ id: string; login: string }> {
    return this.call('GET', '/me')
  }

  devices(): Promise<Device[]> {
    return this.call('GET', '/devices')
  }

  async attachToken(deviceId: string): Promise<string> {
    const r = await this.call<{ token: string }>('POST', `/devices/${encodeURIComponent(deviceId)}/attach-token`)
    return r.token
  }

  /** Resolves a device by name (case-insensitive) or id. */
  async findDevice(nameOrId: string): Promise<Device> {
    const all = await this.devices()
    const q = nameOrId.toLowerCase()
    const d = all.find((x) => x.name.toLowerCase() === q) ?? all.find((x) => x.id.toLowerCase() === q)
    if (!d) {
      throw new CliError(`no device named "${nameOrId}"` + (all.length ? ` (yours: ${all.map((x) => x.name).join(', ')})` : ''))
    }
    return d
  }
}

export function offlineMessage(d: Device): string {
  const seen = d.last_seen ? `, last seen ${new Date(d.last_seen * 1000).toISOString()}` : ''
  return `device "${d.name}" is offline${seen}. Is Remoterm running on it with remote access enabled?`
}

/** GET /api/sessions on a device, through its tunnel. */
export async function fetchSessions(
  tunnelOrigin: string,
  attachToken: string,
  f: FetchLike = fetch
): Promise<SessionInfo[]> {
  let r: Response
  try {
    r = await f(`${tunnelOrigin}/api/sessions`, { headers: { authorization: `Bearer ${attachToken}` }, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new CliError('could not reach the device (it may have just gone offline)')
  }
  if (r.status === 401) throw new CliError('device rejected credentials (401); run `remoterm login`')
  if (!r.ok) throw new CliError(`device returned HTTP ${r.status}`)
  return (await r.json()) as SessionInfo[]
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export function findSession(query: string, sessions: SessionInfo[]): SessionInfo | null {
  const running = sessions.filter((s) => s.running)
  const q = query.trim()
  return (
    running.find((s) => s.id === q) ??
    running.find((s) => s.name.toLowerCase() === q.toLowerCase()) ??
    (slugify(q) ? running.find((s) => slugify(s.name) === slugify(q)) : undefined) ??
    null
  )
}
