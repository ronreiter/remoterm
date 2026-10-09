import { createHash, randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const DEFAULT_API = 'https://api.remoterm.io'
export const apiBaseFromEnv = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.REMOTERM_API || DEFAULT_API).replace(/\/+$/, '')

export interface TokenStore {
  load(): string | null
  save(token: string): void
  clear(): void
}

export class MemoryTokenStore implements TokenStore {
  private t: string | null = null
  load(): string | null {
    return this.t
  }
  save(token: string): void {
    this.t = token
  }
  clear(): void {
    this.t = null
  }
}

/** The subset of Electron's safeStorage we use (Keychain-backed on macOS). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export class EncryptedFileTokenStore implements TokenStore {
  constructor(private file: string, private safe: SafeStorageLike) {}

  load(): string | null {
    try {
      if (!existsSync(this.file)) return null
      return this.safe.decryptString(readFileSync(this.file)) || null
    } catch {
      return null
    }
  }

  save(token: string): void {
    if (!this.safe.isEncryptionAvailable()) throw new Error('Secure storage (encryption) is not available on this system')
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, this.safe.encryptString(token), { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* best effort */
    }
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export interface AccountState {
  signedIn: boolean
  login?: string
  userId?: string
}

export class AccountError extends Error {
  constructor(public code: 'signed_out' | 'network' | 'server', message: string) {
    super(message)
  }
}

export interface AccountOptions {
  apiBase: string
  store: TokenStore
  openExternal: (url: string) => Promise<void> | void
  fetch?: typeof fetch
  nowMs?: () => number
  onChange?: (s: AccountState) => void
}

const SKEW_MS = 60_000
const PENDING_TTL_MS = 10 * 60_000

export class Account {
  state: AccountState = { signedIn: false }
  private pending: { verifier: string; at: number } | null = null
  private access: { token: string; expiresAt: number } | null = null
  private inflight: Promise<string> | null = null
  private base: string
  private now: () => number

  constructor(private o: AccountOptions) {
    this.base = o.apiBase.replace(/\/+$/, '')
    this.now = o.nowMs ?? Date.now
  }

  private f(): typeof fetch {
    return this.o.fetch ?? fetch
  }

  private setState(s: AccountState): void {
    this.state = s
    this.o.onChange?.(s)
  }

  /** Restore signed-in state from the stored refresh token (best effort, offline tolerant). */
  async init(): Promise<void> {
    if (!this.o.store.load()) return
    try {
      await this.loadProfile()
    } catch {
      // Offline or signed out: signed-out errors already cleared the store.
      if (this.o.store.load()) this.setState({ signedIn: true })
    }
  }

  async startSignIn(): Promise<void> {
    const { verifier, challenge } = pkcePair()
    this.pending = { verifier, at: this.now() }
    const url = `${this.base}/auth/github?client=app&challenge=${encodeURIComponent(challenge)}`
    await this.o.openExternal(url)
  }

  /** Handles `remoterm://auth?code=...`. Returns false if the URL is not for us / no sign-in is pending. */
  async handleCallbackUrl(raw: string): Promise<boolean> {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return false
    }
    if (u.protocol !== 'remoterm:' || u.hostname !== 'auth') return false
    const code = u.searchParams.get('code')
    const pending = this.pending
    if (!code || !pending || this.now() - pending.at > PENDING_TTL_MS) return false
    this.pending = null // single use
    const res = await this.post('/auth/token', { code, verifier: pending.verifier })
    if (!res.ok) throw new AccountError('server', `sign-in failed: ${await errText(res)}`)
    const { refresh_token } = (await res.json()) as { refresh_token?: string }
    if (!refresh_token) throw new AccountError('server', 'sign-in failed: no token returned')
    this.o.store.save(refresh_token)
    this.access = null
    await this.loadProfile()
    return true
  }

  private async loadProfile(): Promise<void> {
    const token = await this.getAccessToken()
    const res = await this.f()(`${this.base}/me`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new AccountError('server', `profile failed: ${res.status}`)
    const me = (await res.json()) as { id: string; login: string }
    this.setState({ signedIn: true, login: me.login, userId: me.id })
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.f()(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  /** A fresh aud=api access JWT, refreshed via the stored refresh token. */
  getAccessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.expiresAt - this.now() > SKEW_MS) return Promise.resolve(this.access.token)
    if (this.inflight) return this.inflight
    const p = this.refresh().finally(() => {
      this.inflight = null
    })
    this.inflight = p
    return p
  }

  private async refresh(): Promise<string> {
    const rt = this.o.store.load()
    if (!rt) throw new AccountError('signed_out', 'not signed in')
    let res: Response
    try {
      res = await this.post('/auth/refresh', { refresh_token: rt })
    } catch (e) {
      throw new AccountError('network', e instanceof Error ? e.message : String(e))
    }
    if (res.status === 401) {
      this.signOut()
      throw new AccountError('signed_out', 'session expired, please sign in again')
    }
    if (!res.ok) throw new AccountError('server', `refresh failed: ${res.status}`)
    const j = (await res.json()) as { access_token: string; expires_in: number }
    this.access = { token: j.access_token, expiresAt: this.now() + j.expires_in * 1000 }
    return j.access_token
  }

  signOut(): void {
    this.o.store.clear()
    this.access = null
    this.pending = null
    this.setState({ signedIn: false })
  }
}

async function errText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string }
    return j.error ?? String(res.status)
  } catch {
    return String(res.status)
  }
}
