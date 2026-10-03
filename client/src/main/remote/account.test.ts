import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Account, EncryptedFileTokenStore, MemoryTokenStore, pkcePair, type SafeStorageLike } from './account'

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

interface Call {
  url: string
  method: string
  body: any
  auth: string | null
}

function setup(handlers: Record<string, (body: any, call: Call) => { status?: number; json?: unknown }>, store = new MemoryTokenStore()) {
  const calls: Call[] = []
  const opened: string[] = []
  const changes: unknown[] = []
  let t = 1_000_000
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: new Headers(init.headers).get('authorization')
    }
    calls.push(call)
    const h = handlers[`${call.method} ${u.pathname}`]
    if (!h) return new Response('{}', { status: 404 })
    const r = h(call.body, call)
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  const account = new Account({
    apiBase: 'https://api.test/',
    store,
    fetch: fetchFn,
    openExternal: async (u) => void opened.push(u),
    nowMs: () => t,
    onChange: (s) => changes.push(s)
  })
  return { account, calls, opened, changes, store, advance: (ms: number) => (t += ms) }
}

describe('pkcePair', () => {
  it('produces an S256 challenge of the verifier', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challenge).toBe(b64url(createHash('sha256').update(verifier).digest()))
    expect(challenge).toHaveLength(43)
    expect(pkcePair().verifier).not.toBe(verifier)
  })
})

describe('Account sign-in', () => {
  it('opens the system browser with the PKCE challenge', async () => {
    const s = setup({})
    await s.account.startSignIn()
    const u = new URL(s.opened[0])
    expect(u.origin + u.pathname).toBe('https://api.test/auth/github')
    expect(u.searchParams.get('client')).toBe('app')
    expect(u.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('exchanges the code with the stored verifier and saves the refresh token', async () => {
    const s = setup({
      'POST /auth/token': () => ({ json: { refresh_token: 'RT1', expires_in: 7776000 } }),
      'POST /auth/refresh': () => ({ json: { access_token: 'AT1', expires_in: 600 } }),
      'GET /me': () => ({ json: { id: 'u1', login: 'octocat' } })
    })
    await s.account.startSignIn()
    const challenge = new URL(s.opened[0]).searchParams.get('challenge')!
    const ok = await s.account.handleCallbackUrl('remoterm://auth?code=ONETIME')
    expect(ok).toBe(true)
    const exchange = s.calls.find((c) => c.url.endsWith('/auth/token'))!
    expect(exchange.body.code).toBe('ONETIME')
    expect(b64url(createHash('sha256').update(exchange.body.verifier).digest())).toBe(challenge)
    expect(s.store.load()).toBe('RT1')
    expect(s.account.state).toEqual({ signedIn: true, login: 'octocat', userId: 'u1' })
    expect(s.changes.at(-1)).toEqual({ signedIn: true, login: 'octocat', userId: 'u1' })
  })

  it('ignores callbacks without a pending sign-in, wrong scheme/host, or missing code', async () => {
    const s = setup({ 'POST /auth/token': () => ({ json: { refresh_token: 'X' } }) })
    expect(await s.account.handleCallbackUrl('remoterm://auth?code=A')).toBe(false)
    await s.account.startSignIn()
    expect(await s.account.handleCallbackUrl('https://evil.test/auth?code=A')).toBe(false)
    expect(await s.account.handleCallbackUrl('remoterm://other?code=A')).toBe(false)
    expect(await s.account.handleCallbackUrl('remoterm://auth')).toBe(false)
    expect(s.calls).toHaveLength(0)
    expect(s.store.load()).toBeNull()
  })

  it('a verifier is single-use', async () => {
    const s = setup({
      'POST /auth/token': () => ({ json: { refresh_token: 'RT' } }),
      'GET /me': () => ({ json: { id: 'u', login: 'l' } }),
      'POST /auth/refresh': () => ({ json: { access_token: 'AT', expires_in: 600 } })
    })
    await s.account.startSignIn()
    expect(await s.account.handleCallbackUrl('remoterm://auth?code=A')).toBe(true)
    expect(await s.account.handleCallbackUrl('remoterm://auth?code=A')).toBe(false)
  })

  it('reports failure when the exchange is rejected', async () => {
    const s = setup({ 'POST /auth/token': () => ({ status: 400, json: { error: 'invalid_grant' } }) })
    await s.account.startSignIn()
    await expect(s.account.handleCallbackUrl('remoterm://auth?code=BAD')).rejects.toThrow(/invalid_grant|400/)
    expect(s.store.load()).toBeNull()
    expect(s.account.state.signedIn).toBe(false)
  })
})

describe('Account access tokens', () => {
  let refreshes: number
  const handlers = () => ({
    'POST /auth/refresh': (body: any) => {
      refreshes++
      return body.refresh_token === 'RT' ? { json: { access_token: `AT${refreshes}`, expires_in: 600 } } : { status: 401, json: { error: 'unauthorized' } }
    },
    'GET /me': () => ({ json: { id: 'u1', login: 'octocat' } })
  })
  beforeEach(() => (refreshes = 0))

  it('refreshes once and caches until near expiry', async () => {
    const store = new MemoryTokenStore()
    store.save('RT')
    const s = setup(handlers(), store)
    expect(await s.account.getAccessToken()).toBe('AT1')
    expect(await s.account.getAccessToken()).toBe('AT1')
    s.advance(9 * 60_000 + 10_000) // within 60s of expiry
    expect(await s.account.getAccessToken()).toBe('AT2')
    expect(s.calls.find((c) => c.url.endsWith('/auth/refresh'))!.body).toEqual({ refresh_token: 'RT' })
  })

  it('shares a single in-flight refresh', async () => {
    const store = new MemoryTokenStore()
    store.save('RT')
    const s = setup(handlers(), store)
    const [a, b] = await Promise.all([s.account.getAccessToken(), s.account.getAccessToken()])
    expect(a).toBe(b)
    expect(refreshes).toBe(1)
  })

  it('signs out when the refresh token is rejected', async () => {
    const store = new MemoryTokenStore()
    store.save('STALE')
    const s = setup(handlers(), store)
    await expect(s.account.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' })
    expect(store.load()).toBeNull()
    expect(s.account.state.signedIn).toBe(false)
  })

  it('keeps the refresh token on network errors', async () => {
    const store = new MemoryTokenStore()
    store.save('RT')
    const account = new Account({
      apiBase: 'https://api.test',
      store,
      fetch: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      openExternal: async () => {}
    })
    await expect(account.getAccessToken()).rejects.toMatchObject({ code: 'network' })
    expect(store.load()).toBe('RT')
  })

  it('getAccessToken without any refresh token is signed_out', async () => {
    const s = setup(handlers())
    await expect(s.account.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' })
  })

  it('init() restores signed-in state from storage', async () => {
    const store = new MemoryTokenStore()
    store.save('RT')
    const s = setup(handlers(), store)
    await s.account.init()
    expect(s.account.state).toEqual({ signedIn: true, login: 'octocat', userId: 'u1' })
  })

  it('signOut clears storage and cached token', async () => {
    const store = new MemoryTokenStore()
    store.save('RT')
    const s = setup(handlers(), store)
    await s.account.getAccessToken()
    s.account.signOut()
    expect(store.load()).toBeNull()
    await expect(s.account.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' })
  })
})

describe('EncryptedFileTokenStore', () => {
  const fakeSafe = (available = true): SafeStorageLike => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('enc:' + s.split('').reverse().join('')),
    decryptString: (b) => b.toString().replace(/^enc:/, '').split('').reverse().join('')
  })

  it('stores the token encrypted on disk and reads it back', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rt-')), 'remote-auth.bin')
    const st = new EncryptedFileTokenStore(file, fakeSafe())
    expect(st.load()).toBeNull()
    st.save('super-secret-refresh-token')
    const raw = readFileSync(file)
    expect(raw.toString()).not.toContain('super-secret-refresh-token')
    expect(new EncryptedFileTokenStore(file, fakeSafe()).load()).toBe('super-secret-refresh-token')
    st.clear()
    expect(existsSync(file)).toBe(false)
    expect(st.load()).toBeNull()
  })

  it('refuses to store plaintext when encryption is unavailable', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rt-')), 'remote-auth.bin')
    const st = new EncryptedFileTokenStore(file, fakeSafe(false))
    expect(() => st.save('x')).toThrow(/encryption/i)
    expect(existsSync(file)).toBe(false)
  })

  it('treats a corrupt file as signed out', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rt-')), 'remote-auth.bin')
    const good = new EncryptedFileTokenStore(file, fakeSafe())
    good.save('x')
    const broken: SafeStorageLike = {
      ...fakeSafe(),
      decryptString: () => {
        throw new Error('bad')
      }
    }
    expect(new EncryptedFileTokenStore(file, broken).load()).toBeNull()
  })
})
