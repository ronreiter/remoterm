import { describe, expect, it, vi } from 'vitest'
import { AuthError, TokenManager } from '../src/lib/tokens'
import { agentHttpOrigin, agentWsUrl } from '../src/config'

const API = 'https://api.example'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let t = 1_000_000
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(String(url), init ?? {}))
  const tm = new TokenManager(fetchImpl as unknown as typeof fetch, API, () => t)
  return { tm, fetchImpl, advance: (ms: number) => (t += ms) }
}

describe('TokenManager access token', () => {
  it('refreshes with the cookie (credentials include) and caches until near expiry', async () => {
    const { tm, fetchImpl, advance } = setup(() => jsonRes({ access_token: 'A1', expires_in: 600 }))
    expect(await tm.getAccessToken()).toBe('A1')
    expect(await tm.getAccessToken()).toBe('A1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API}/auth/refresh`)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    advance(571_000)
    await tm.getAccessToken()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent refreshes', async () => {
    const { tm, fetchImpl } = setup(() => jsonRes({ access_token: 'A', expires_in: 600 }))
    const r = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()])
    expect(r).toEqual(['A', 'A', 'A'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('force bypasses the cache', async () => {
    let n = 0
    const { tm } = setup(() => jsonRes({ access_token: `A${++n}`, expires_in: 600 }))
    expect(await tm.getAccessToken()).toBe('A1')
    expect(await tm.getAccessToken(true)).toBe('A2')
  })

  it('throws AuthError on 401 and does not cache failures', async () => {
    let ok = false
    const { tm } = setup(() => (ok ? jsonRes({ access_token: 'A', expires_in: 600 }) : jsonRes({ error: 'unauthorized' }, 401)))
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(AuthError)
    ok = true
    expect(await tm.getAccessToken()).toBe('A')
  })

  it('does not treat network errors as sign-out', async () => {
    const { tm } = setup(() => {
      throw new TypeError('network')
    })
    await expect(tm.getAccessToken()).rejects.not.toBeInstanceOf(AuthError)
  })
})

describe('TokenManager attach token', () => {
  it('fetches a fresh attach token each time using the api bearer', async () => {
    let n = 0
    const { tm, fetchImpl } = setup((url) =>
      url.endsWith('/auth/refresh') ? jsonRes({ access_token: 'API', expires_in: 600 }) : jsonRes({ token: `T${++n}`, expires_in: 600 })
    )
    expect(await tm.getAttachToken('dev1')).toBe('T1')
    expect(await tm.getAttachToken('dev1')).toBe('T2')
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/attach-token'))!
    expect(String(call[0])).toBe(`${API}/devices/dev1/attach-token`)
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer API')
  })

  it('retries once with a forced refresh when the api rejects the access token', async () => {
    let refreshes = 0
    const { tm } = setup((url, init) => {
      if (url.endsWith('/auth/refresh')) return jsonRes({ access_token: `API${++refreshes}`, expires_in: 600 })
      const auth = (init.headers as Record<string, string>).authorization
      return auth === 'Bearer API2' ? jsonRes({ token: 'T' }) : jsonRes({ error: 'unauthorized' }, 401)
    })
    expect(await tm.getAttachToken('d')).toBe('T')
    expect(refreshes).toBe(2)
  })

  it('maps a 404 to a DeviceNotFound-style error', async () => {
    const { tm } = setup((url) =>
      url.endsWith('/auth/refresh') ? jsonRes({ access_token: 'API', expires_in: 600 }) : jsonRes({ error: 'not_found' }, 404)
    )
    await expect(tm.getAttachToken('x')).rejects.toThrow(/404/)
  })
})

describe('TokenManager logout', () => {
  it('posts /auth/logout with credentials and drops the cached token', async () => {
    const { tm, fetchImpl } = setup((url) =>
      url.endsWith('/auth/logout') ? jsonRes({ ok: true }) : jsonRes({ access_token: 'A', expires_in: 600 })
    )
    await tm.getAccessToken()
    await tm.logout()
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/auth/logout'))!
    expect((call[1] as RequestInit).credentials).toBe('include')
    await tm.getAccessToken()
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'))).toHaveLength(2)
  })
})

describe('token hygiene', () => {
  it('never uses web storage and never puts tokens in URLs', async () => {
    const getItem = vi.fn()
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })
    vi.stubGlobal('sessionStorage', { getItem, setItem })
    const { tm, fetchImpl } = setup((url) =>
      url.endsWith('/auth/refresh') ? jsonRes({ access_token: 'SECRET-API', expires_in: 600 }) : jsonRes({ token: 'SECRET-ATTACH' })
    )
    await tm.getAttachToken('d')
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    for (const c of fetchImpl.mock.calls) expect(String(c[0])).not.toMatch(/SECRET|token=/)
    vi.unstubAllGlobals()
  })
})

describe('agent URLs', () => {
  it('uses TLS for real domains and plain http for loopback', () => {
    expect(agentHttpOrigin('d1', 'remoterm.io')).toBe('https://d1.remoterm.io')
    expect(agentWsUrl('d1', 's 1', 'view', 'remoterm.io')).toBe('wss://d1.remoterm.io/ws/attach/s%201?mode=view')
    expect(agentHttpOrigin('d1', 'localhost:9000')).toBe('http://d1.localhost:9000')
    expect(agentWsUrl('d1', 's', 'control', 'localhost:9000')).toBe('ws://d1.localhost:9000/ws/attach/s?mode=control')
  })
})
