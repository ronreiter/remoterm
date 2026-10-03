import { describe, it, expect } from 'vitest'
import { AgentAuth, AuthError, fetchAgentConfig, type AgentConfig } from './auth'
import { makeKeys, badSignatureToken, staticConfig } from './testUtil'

const DEVICE = 'dev123'
const OWNER = 'user-1'
const nowS = () => Math.floor(Date.now() / 1000)

async function setup(over: Partial<AgentConfig> = {}) {
  const keys = await makeKeys()
  let config: AgentConfig = { ...staticConfig(keys, OWNER), ...over }
  let fetches = 0
  let t = Date.now()
  const auth = new AgentAuth({
    deviceId: DEVICE,
    getConfig: async () => {
      fetches++
      return config
    },
    nowMs: () => t
  })
  return {
    keys,
    auth,
    fetches: () => fetches,
    setConfig: (c: Partial<AgentConfig>) => (config = { ...config, ...c }),
    advance: (ms: number) => (t += ms)
  }
}

const reject = async (p: Promise<unknown>, reason: string) => {
  const e = await p.then(
    () => null,
    (x) => x
  )
  expect(e).toBeInstanceOf(AuthError)
  expect((e as AuthError).reason).toBe(reason)
}

describe('AgentAuth.verify', () => {
  it('accepts a valid token and returns claims', async () => {
    const s = await setup()
    const c = await s.auth.verify(await s.keys.sign({ sub: OWNER, aud: DEVICE }))
    expect(c.sub).toBe(OWNER)
    expect(typeof c.iat).toBe('number')
  })

  it('rejects garbage, bad signature, wrong aud, wrong sub, expired', async () => {
    const s = await setup()
    await reject(s.auth.verify('nope'), 'malformed')
    await reject(s.auth.verify(await badSignatureToken(s.keys.kid, { sub: OWNER, aud: DEVICE })), 'invalid')
    await reject(s.auth.verify(await s.keys.sign({ sub: OWNER, aud: 'other' })), 'invalid')
    await reject(s.auth.verify(await s.keys.sign({ sub: 'someone-else', aud: DEVICE })), 'wrong_subject')
    const n = nowS()
    await reject(s.auth.verify(await s.keys.sign({ sub: OWNER, aud: DEVICE, iat: n - 1000, exp: n - 500 })), 'invalid')
  })

  it('rejects tokens issued at or before revokedBefore', async () => {
    const n = nowS()
    const s = await setup({ revokedBefore: n - 100 })
    await reject(s.auth.verify(await s.keys.sign({ sub: OWNER, aud: DEVICE, iat: n - 200, exp: n + 400 })), 'revoked')
    await reject(s.auth.verify(await s.keys.sign({ sub: OWNER, aud: DEVICE, iat: n - 100, exp: n + 400 })), 'revoked')
    await s.auth.verify(await s.keys.sign({ sub: OWNER, aud: DEVICE, iat: n - 99, exp: n + 400 }))
  })

  it('rejects a token whose kid is unknown even if well formed', async () => {
    const s = await setup()
    const other = await makeKeys()
    await reject(s.auth.verify(await other.sign({ sub: OWNER, aud: DEVICE })), 'invalid')
  })

  it('fails closed when config cannot be fetched and nothing is cached', async () => {
    const keys = await makeKeys()
    const auth = new AgentAuth({
      deviceId: DEVICE,
      getConfig: async () => {
        throw new Error('offline')
      }
    })
    await reject(auth.verify(await keys.sign({ sub: OWNER, aud: DEVICE })), 'unavailable')
  })
})

describe('AgentAuth config cache', () => {
  it('caches config for 5 minutes then refetches; uses stale on fetch failure', async () => {
    const s = await setup()
    const tok = await s.keys.sign({ sub: OWNER, aud: DEVICE, exp: nowS() + 3600 })
    await s.auth.verify(tok)
    await s.auth.verify(tok)
    expect(s.fetches()).toBe(1)
    s.advance(4 * 60_000)
    await s.auth.verify(tok)
    expect(s.fetches()).toBe(1)
    s.advance(2 * 60_000)
    await s.auth.verify(tok)
    expect(s.fetches()).toBe(2)
  })

  it('refresh() reports revokedBefore changes to onRevoked listeners', async () => {
    const s = await setup()
    const seen: number[] = []
    s.auth.onRevokedBefore((v) => seen.push(v))
    await s.auth.refresh()
    expect(seen).toEqual([])
    s.setConfig({ revokedBefore: 1234 })
    await s.auth.refresh()
    expect(seen).toEqual([1234])
    await s.auth.refresh()
    expect(seen).toEqual([1234])
  })
})

describe('fetchAgentConfig', () => {
  it('calls the backend with the bearer access token and parses the result', async () => {
    const keys = await makeKeys()
    const calls: { url: string; auth: string | null }[] = []
    const cfg = await fetchAgentConfig({
      apiBase: 'https://api.example.test/',
      deviceId: 'abc',
      getAccessToken: async () => 'AT',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get('authorization') })
        return new Response(JSON.stringify(staticConfig(keys, OWNER, 5)), { status: 200 })
      }) as unknown as typeof fetch
    })
    expect(calls).toEqual([{ url: 'https://api.example.test/devices/abc/agent-config', auth: 'Bearer AT' }])
    expect(cfg.ownerUserId).toBe(OWNER)
    expect(cfg.revokedBefore).toBe(5)
  })

  it('throws on non-2xx', async () => {
    await expect(
      fetchAgentConfig({
        apiBase: 'https://x',
        deviceId: 'a',
        getAccessToken: async () => 't',
        fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
      })
    ).rejects.toThrow(/404/)
  })
})
