import type { SessionInfo } from '@remoterm/protocol'
import { agentHttpOrigin, TUNNEL_DOMAIN } from '../config'
import { AuthError, HttpError, type TokenManager } from './tokens'

export interface Device {
  id: string
  name: string
  hostname: string
  port: number
  created_at: number
  last_seen: number | null
  online: boolean
}

export interface Me {
  id: string
  login: string
}

/** The device's tunnel is down or unreachable (cloudflared 52x/53x, 502-504, or a network/CORS failure). */
export class DeviceOfflineError extends Error {
  constructor(message = 'Device is offline') {
    super(message)
    this.name = 'DeviceOfflineError'
  }
}

export class ApiClient {
  constructor(
    private tokens: TokenManager,
    private fetchImpl: typeof fetch,
    private tunnelDomain: string = TUNNEL_DOMAIN
  ) {}

  async me(): Promise<Me> {
    const res = await this.tokens.apiFetch('/me')
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()) as Me
  }

  async devices(): Promise<Device[]> {
    const res = await this.tokens.apiFetch('/devices')
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()) as Device[]
  }

  /** Sessions come straight from the device agent, authenticated with an attach JWT (aud = deviceId). */
  async sessions(deviceId: string): Promise<SessionInfo[]> {
    const url = `${agentHttpOrigin(deviceId, this.tunnelDomain)}/api/sessions`
    const call = async () => {
      const token = await this.tokens.getAttachToken(deviceId)
      try {
        return await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
      } catch {
        throw new DeviceOfflineError()
      }
    }
    let res = await call()
    if (res.status === 401) res = await call()
    if (res.status === 401) throw new AuthError()
    if (res.status === 502 || res.status === 503 || res.status === 504 || res.status >= 520) throw new DeviceOfflineError()
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()) as SessionInfo[]
  }
}
