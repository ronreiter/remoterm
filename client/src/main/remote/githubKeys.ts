import { utils } from 'ssh2'

export const KEYS_TTL_MS = 60 * 60_000

export type FetchKeysText = (login: string) => Promise<string>

export const defaultFetchKeysText: FetchKeysText = async (login) => {
  const r = await fetch(`https://github.com/${encodeURIComponent(login)}.keys`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`github keys: HTTP ${r.status}`)
  return r.text()
}

export interface GithubKeysOptions {
  fetchText?: FetchKeysText
  ttlMs?: number
  /** Minimum gap between forced refetches triggered by key misses. */
  missRefetchMs?: number
  now?: () => number
}

interface Entry {
  keys: Buffer[]
  fetchedAt: number
}

/** The owner's GitHub public keys, cached for an hour and refetched when an unknown key shows up. */
export class GithubKeys {
  private cache = new Map<string, Entry>()
  private lastForced = new Map<string, number>()
  private fetchText: FetchKeysText
  private ttl: number
  private missGap: number
  private now: () => number

  constructor(o: GithubKeysOptions = {}) {
    this.fetchText = o.fetchText ?? defaultFetchKeysText
    this.ttl = o.ttlMs ?? KEYS_TTL_MS
    this.missGap = o.missRefetchMs ?? 10_000
    this.now = o.now ?? Date.now
  }

  private async load(login: string): Promise<Entry | null> {
    try {
      const text = await this.fetchText(login)
      const entry = { keys: parseAuthorizedKeys(text), fetchedAt: this.now() }
      this.cache.set(login, entry)
      return entry
    } catch {
      return this.cache.get(login) ?? null // keep serving stale keys if GitHub is unreachable
    }
  }

  /** `blob` is the SSH wire-format public key (ssh2's `ctx.key.data`). */
  async isAllowed(login: string, blob: Buffer): Promise<boolean> {
    let entry = this.cache.get(login) ?? null
    if (!entry || this.now() - entry.fetchedAt > this.ttl) entry = await this.load(login)
    if (entry?.keys.some((k) => k.equals(blob))) return true
    // Miss: the user may have just added the key on GitHub.
    const last = this.lastForced.get(login)
    if (last !== undefined && this.now() - last < this.missGap) return false
    this.lastForced.set(login, this.now())
    entry = await this.load(login)
    return !!entry?.keys.some((k) => k.equals(blob))
  }
}

export function parseAuthorizedKeys(text: string): Buffer[] {
  const out: Buffer[] = []
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    const k = utils.parseKey(l)
    const key = Array.isArray(k) ? k[0] : k
    if (!key || key instanceof Error) continue
    out.push(key.getPublicSSH())
  }
  return out
}
