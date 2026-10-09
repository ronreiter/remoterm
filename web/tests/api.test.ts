import { describe, expect, it, vi } from 'vitest'
import { ApiClient, DeviceOfflineError } from '../src/lib/api'
import { AuthError, TokenManager } from '../src/lib/tokens'

const API = 'https://api.example'
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

function make(agent: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let n = 0
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const u = String(url)
    if (u.startsWith(API)) {
      if (u.endsWith('/auth/refresh')) return j({ access_token: 'API', expires_in: 600 })
      if (u.endsWith('/attach-token')) return j({ token: `ATT${++n}`, expires_in: 600 })
      if (u.endsWith('/devices')) return j([{ id: 'd1', name: 'Mac', online: true }])
      if (u.endsWith('/me')) return j({ id: 'u', login: 'octocat' })
    }
    return agent(u, init)
  })
  const tokens = new TokenManager(fetchImpl as unknown as typeof fetch, API)
  return { api: new ApiClient(tokens, fetchImpl as unknown as typeof fetch, 't.example.io'), fetchImpl }
}

describe('ApiClient', () => {
  it('lists devices and me with the api bearer', async () => {
    const { api, fetchImpl } = make(() => j([]))
    expect((await api.devices())[0].id).toBe('d1')
    expect((await api.me()).login).toBe('octocat')
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/devices'))!
    expect(((call[1] as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer API')
  })

  it('fetches sessions from the device tunnel host with an attach bearer', async () => {
    const { api, fetchImpl } = make(() => j([{ id: 's1', name: 'zsh', running: true }]))
    const s = await api.sessions('d1')
    expect(s[0].id).toBe('s1')
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes('t.example.io'))!
    expect(String(call[0])).toBe('https://d1.t.example.io/api/sessions')
    expect(((call[1] as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer ATT1')
  })

  it('retries once with a new attach token on 401, then raises AuthError', async () => {
    const seen: string[] = []
    const { api } = make((_u, init) => {
      seen.push((init.headers as Record<string, string>).authorization)
      return seen.length === 1 ? j({}, 401) : j([])
    })
    await api.sessions('d1')
    expect(seen).toEqual(['Bearer ATT1', 'Bearer ATT2'])
    const { api: api2 } = make(() => j({}, 401))
    await expect(api2.sessions('d1')).rejects.toBeInstanceOf(AuthError)
  })

  it('reports offline for network failures and tunnel errors', async () => {
    const { api } = make(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(api.sessions('d1')).rejects.toBeInstanceOf(DeviceOfflineError)
    const { api: api2 } = make(() => new Response('', { status: 530 }))
    await expect(api2.sessions('d1')).rejects.toBeInstanceOf(DeviceOfflineError)
  })
})
