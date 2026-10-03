/** Thrown when the refresh cookie is missing/invalid or the API rejects our credentials: the user must sign in. */
export class AuthError extends Error {
  constructor(message = 'unauthorized') {
    super(message)
    this.name = 'AuthError'
  }
}

export class HttpError extends Error {
  constructor(public status: number, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.name = 'HttpError'
  }
}

const SKEW_MS = 30_000

/**
 * Holds the short-lived api JWT in memory only (never storage, never URLs).
 * The long-lived credential is the HttpOnly `rt` cookie, used only by POST /auth/refresh.
 */
export class TokenManager {
  private access: { token: string; expiresAt: number } | null = null
  private inflight: Promise<string> | null = null

  constructor(
    private fetchImpl: typeof fetch,
    private apiOrigin: string,
    private now: () => number = () => Date.now()
  ) {}

  async getAccessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.expiresAt - SKEW_MS > this.now()) return this.access.token
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  private async refresh(): Promise<string> {
    this.access = null
    const res = await this.fetchImpl(`${this.apiOrigin}/auth/refresh`, { method: 'POST', credentials: 'include' })
    if (res.status === 401 || res.status === 403) throw new AuthError()
    if (!res.ok) throw new HttpError(res.status)
    const body = (await res.json()) as { access_token: string; expires_in: number }
    this.access = { token: body.access_token, expiresAt: this.now() + body.expires_in * 1000 }
    return body.access_token
  }

  /** Authenticated call to the API; retries once with a forced refresh on 401. */
  async apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const call = async (force: boolean) =>
      this.fetchImpl(`${this.apiOrigin}${path}`, {
        ...init,
        credentials: 'include',
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await this.getAccessToken(force)}` }
      })
    let res = await call(false)
    if (res.status === 401) res = await call(true)
    if (res.status === 401) throw new AuthError()
    return res
  }

  /** Always fetches a fresh device-scoped (aud=deviceId) JWT; AttachClient calls this on every (re)connect. */
  async getAttachToken(deviceId: string): Promise<string> {
    const res = await this.apiFetch(`/devices/${encodeURIComponent(deviceId)}/attach-token`, { method: 'POST' })
    if (!res.ok) throw new HttpError(res.status)
    return ((await res.json()) as { token: string }).token
  }

  async logout(): Promise<void> {
    this.access = null
    try {
      await this.fetchImpl(`${this.apiOrigin}/auth/logout`, { method: 'POST', credentials: 'include' })
    } catch {
      /* best effort: the cookie is HttpOnly so we cannot clear it ourselves */
    }
  }
}
