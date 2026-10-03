import { createLocalJWKSet, jwtVerify, errors, type JWK } from 'jose'
import type { AccessClaims } from '@remoterm/protocol'

/** Response of GET /devices/:id/agent-config. */
export interface AgentConfig {
  ownerUserId: string
  ownerLogin: string
  /** Unix seconds; tokens with iat <= this are revoked. */
  revokedBefore: number | null
  jwks: { keys: JWK[] }
}

export type AuthFailure = 'malformed' | 'invalid' | 'wrong_subject' | 'revoked' | 'unavailable'

export class AuthError extends Error {
  constructor(public reason: AuthFailure, message?: string) {
    super(message ?? reason)
  }
}

export const CONFIG_TTL_MS = 5 * 60_000

export interface AgentAuthOptions {
  deviceId: string
  getConfig: () => Promise<AgentConfig>
  nowMs?: () => number
  ttlMs?: number
}

export class AgentAuth {
  private config: AgentConfig | null = null
  private fetchedAt = 0
  private inflight: Promise<AgentConfig> | null = null
  private listeners = new Set<(revokedBefore: number) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private now: () => number
  private ttl: number

  constructor(private opts: AgentAuthOptions) {
    this.now = opts.nowMs ?? Date.now
    this.ttl = opts.ttlMs ?? CONFIG_TTL_MS
  }

  get ownerLogin(): string | null {
    return this.config?.ownerLogin ?? null
  }

  /** Called whenever a refresh observes a (new) revokedBefore. */
  onRevokedBefore(cb: (revokedBefore: number) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Re-fetch config now. Throws if the backend is unreachable. */
  async refresh(): Promise<void> {
    await this.load(true)
  }

  /** Periodically refresh (so revocations close open sockets within the TTL). */
  start(): void {
    this.stop()
    this.timer = setInterval(() => {
      this.refresh().catch(() => {
        /* keep the stale config */
      })
    }, this.ttl)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private load(force: boolean): Promise<AgentConfig> {
    if (!force && this.config && this.now() - this.fetchedAt < this.ttl) return Promise.resolve(this.config)
    if (this.inflight) return this.inflight
    const p = this.opts
      .getConfig()
      .then((cfg) => {
        const prev = this.config?.revokedBefore ?? null
        this.config = cfg
        this.fetchedAt = this.now()
        if (cfg.revokedBefore != null && cfg.revokedBefore !== prev) {
          for (const cb of this.listeners) cb(cfg.revokedBefore)
        }
        return cfg
      })
      .finally(() => {
        this.inflight = null
      })
    this.inflight = p
    return p
  }

  async verify(token: string): Promise<AccessClaims> {
    if (typeof token !== 'string' || token.split('.').length !== 3) throw new AuthError('malformed')
    let cfg: AgentConfig
    try {
      cfg = await this.load(false)
    } catch (e) {
      // Prefer a stale config over locking the owner out during a backend blip.
      if (!this.config) throw new AuthError('unavailable', String(e))
      cfg = this.config
    }
    let claims: AccessClaims
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(cfg.jwks), {
        audience: this.opts.deviceId,
        algorithms: ['EdDSA'],
        currentDate: new Date(this.now())
      })
      claims = payload as unknown as AccessClaims
    } catch (e) {
      if (e instanceof errors.JWSInvalid || e instanceof errors.JWTInvalid) throw new AuthError('malformed')
      throw new AuthError('invalid', e instanceof Error ? e.message : String(e))
    }
    if (typeof claims.iat !== 'number' || typeof claims.sub !== 'string') throw new AuthError('invalid')
    if (claims.sub !== cfg.ownerUserId) throw new AuthError('wrong_subject')
    if (cfg.revokedBefore != null && claims.iat <= cfg.revokedBefore) throw new AuthError('revoked')
    return claims
  }
}

export interface FetchConfigOptions {
  apiBase: string
  deviceId: string
  getAccessToken: () => Promise<string>
  fetch?: typeof fetch
}

export async function fetchAgentConfig(o: FetchConfigOptions): Promise<AgentConfig> {
  const f = o.fetch ?? fetch
  const token = await o.getAccessToken()
  const res = await f(`${o.apiBase.replace(/\/+$/, '')}/devices/${encodeURIComponent(o.deviceId)}/agent-config`, {
    headers: { authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`agent-config failed: ${res.status}`)
  const j = (await res.json()) as AgentConfig
  if (!j || typeof j.ownerUserId !== 'string' || !j.jwks || !Array.isArray(j.jwks.keys)) {
    throw new Error('agent-config: malformed response')
  }
  return { ...j, revokedBefore: j.revokedBefore ?? null }
}
