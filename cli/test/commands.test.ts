import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pollDeviceToken, Api, CliError, findSession } from '../src/api'
import { login, logout, ls, sshConfig, SSH_CONFIG, type Ctx } from '../src/commands'
import { readCredentials, writeCredentials } from '../src/credentials'

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined

function mockFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    const r = handler(u, init)
    if (!r) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { f, calls }
}

function ctxWith(fetch: typeof globalThis.fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'remoterm-cmd-'))
  const out: string[] = []
  const opened: string[] = []
  const ctx: Ctx = {
    config: { api: 'https://api.test', tunnelDomain: 't.test', credentialsPath: join(dir, 'remoterm', 'credentials') },
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    fetch,
    openBrowser: (u) => opened.push(u),
    sleep: async () => undefined
  }
  return { ctx, out, opened }
}

const start = { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://api.test/link', expires_in: 600, interval: 5 }

describe('pollDeviceToken', () => {
  it('keeps polling while pending then returns the refresh token', async () => {
    let n = 0
    const { f, calls } = mockFetch(() => (++n < 3 ? { status: 400, body: { error: 'authorization_pending' } } : { body: { refresh_token: 'RT', expires_in: 1 } }))
    const sleeps: number[] = []
    const rt = await pollDeviceToken('https://api.test', start, { fetch: f, sleep: async (ms) => void sleeps.push(ms) })
    expect(rt).toBe('RT')
    expect(calls).toHaveLength(3)
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ device_code: 'dc' })
    expect(sleeps).toEqual([5000, 5000, 5000])
  })
  it('fails on expired_token and invalid_grant', async () => {
    for (const error of ['expired_token', 'invalid_grant']) {
      const { f } = mockFetch(() => ({ status: 400, body: { error } }))
      await expect(pollDeviceToken('https://api.test', start, { fetch: f, sleep: async () => undefined })).rejects.toThrow(CliError)
    }
  })
  it('gives up after expires_in', async () => {
    let t = 0
    const { f } = mockFetch(() => ({ status: 400, body: { error: 'authorization_pending' } }))
    await expect(
      pollDeviceToken('https://api.test', { ...start, expires_in: 12 }, { fetch: f, now: () => t, sleep: async (ms) => void (t += ms) })
    ).rejects.toThrow(/timed out/)
  })
})

describe('login / logout', () => {
  it('uses colour only when ctx.color is set', async () => {
    const { f } = mockFetch((url) => {
      if (url.endsWith('/auth/device')) return { body: start }
      if (url.endsWith('/auth/device/token')) return { body: { refresh_token: 'RT' } }
      if (url.endsWith('/auth/refresh')) return { body: { access_token: 'AT', expires_in: 600 } }
      if (url.endsWith('/me')) return { body: { id: 'u1', login: 'octocat' } }
    })
    const { ctx, out } = ctxWith(f)
    ctx.color = true
    await login(ctx)
    expect(out.join('')).toMatch(/\x1b\[1m.*ABCD-EFGH/)
  })

  it('prints code + URL, opens the browser, stores credentials 0600', async () => {
    const { f } = mockFetch((url) => {
      if (url.endsWith('/auth/device')) return { body: start }
      if (url.endsWith('/auth/device/token')) return { body: { refresh_token: 'RT' } }
      if (url.endsWith('/auth/refresh')) return { body: { access_token: 'AT', expires_in: 600 } }
      if (url.endsWith('/me')) return { body: { id: 'u1', login: 'octocat' } }
    })
    const { ctx, out, opened } = ctxWith(f)
    await login(ctx)
    expect(out.join('')).toContain('ABCD-EFGH')
    expect(out.join('')).toContain('https://api.test/link')
    expect(opened).toEqual(['https://api.test/link?code=ABCD-EFGH'])
    expect(readCredentials(ctx.config.credentialsPath)).toEqual({ refresh_token: 'RT', api: 'https://api.test', login: 'octocat' })
    expect(statSync(ctx.config.credentialsPath).mode & 0o777).toBe(0o600)
    const text = out.join('')
    expect(text).toContain('Sign in to Remoterm')
    expect(text).toMatch(/Your code:\s+ABCD-EFGH/)
    expect(text).toContain('✓ Signed in as @octocat')
    expect(text).not.toMatch(/\x1b\[/) // no colour codes unless enabled
    logout(ctx)
    expect(readCredentials(ctx.config.credentialsPath)).toBeNull()
    expect(out.join('')).toContain('Logged out.')
  })
})

describe('Api', () => {
  it('refreshes once, caches the access token and uses it as Bearer', async () => {
    const { f, calls } = mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) return { body: { access_token: 'AT', expires_in: 600 } }
      if (url.endsWith('/devices')) return { body: [] }
      if (url.endsWith('/attach-token')) return { body: { token: 'ATT' } }
    })
    const api = new Api('https://api.test', 'RT', f)
    await api.devices()
    expect(await api.attachToken('d1')).toBe('ATT')
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1)
    expect((calls[1].init!.headers as Record<string, string>).authorization).toBe('Bearer AT')
    expect(calls[2].url).toBe('https://api.test/devices/d1/attach-token')
  })
  it('maps a rejected refresh token to a login hint', async () => {
    const { f } = mockFetch(() => ({ status: 401, body: { error: 'unauthorized' } }))
    await expect(new Api('https://api.test', 'RT', f).devices()).rejects.toThrow(/remoterm login/)
    await expect(new Api('https://api.test', null, f).devices()).rejects.toThrow(/not logged in/)
  })
  it('finds devices by name case-insensitively and explains misses', async () => {
    const devs = [{ id: 'abc', name: 'My-Mac', hostname: 'abc.t.test', port: 1, created_at: 0, last_seen: null, online: true }]
    const { f } = mockFetch((url) => (url.endsWith('/auth/refresh') ? { body: { access_token: 'AT', expires_in: 600 } } : { body: devs }))
    const api = new Api('https://api.test', 'RT', f)
    expect((await api.findDevice('my-mac')).id).toBe('abc')
    await expect(api.findDevice('nope')).rejects.toThrow(/yours: My-Mac/)
  })
})

describe('ls', () => {
  it('lists devices with running sessions; offline devices are not contacted', async () => {
    const session = (name: string, running = true) => ({ id: name, name, tool: '', cwd: '/w', folder: null, color: null, running, busy: false, cols: 80, rows: 24 })
    const { f, calls } = mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) return { body: { access_token: 'AT', expires_in: 600 } }
      if (url === 'https://api.test/devices')
        return {
          body: [
            { id: 'on1', name: 'mac', hostname: 'on1.t.test', port: 1, created_at: 0, last_seen: 5, online: true },
            { id: 'off1', name: 'old', hostname: 'off1.t.test', port: 1, created_at: 0, last_seen: 1700000000, online: false }
          ]
        }
      if (url.endsWith('/devices/on1/attach-token')) return { body: { token: 'ATT' } }
      if (url === 'https://on1.t.test/api/sessions') return { body: [session('api'), session('dead', false)] }
    })
    const { ctx, out } = ctxWith(f)
    writeCredentials(ctx.config.credentialsPath, { refresh_token: 'RT', api: 'https://api.test' })
    await ls(ctx)
    const text = out.join('')
    expect(text).toContain('mac  online, 1 running session')
    expect(text).toContain('  mac/api')
    expect(text).not.toContain('dead')
    expect(text).toContain('old  offline (last seen 2023-')
    expect(calls.some((c) => c.url.includes('off1.t.test'))).toBe(false)
    expect(calls.find((c) => c.url.includes('on1.t.test'))!.init!.headers).toEqual({ authorization: 'Bearer ATT' })
  })
  it('requires login', async () => {
    const { ctx } = ctxWith(mockFetch(() => undefined).f)
    await expect(ls(ctx)).rejects.toThrow(/remoterm login/)
  })
})

describe('misc', () => {
  it('ssh-config prints the Host block', () => {
    const { ctx, out } = ctxWith(mockFetch(() => undefined).f)
    sshConfig(ctx)
    expect(out.join('')).toBe(SSH_CONFIG)
    expect(SSH_CONFIG).toBe('Host *.remoterm\n  ProxyCommand remoterm connect %h\n')
  })
  it('findSession matches id, name, slug among running sessions', () => {
    const s = (id: string, name: string, running = true) => ({ id, name, tool: '', cwd: '', folder: null, color: null, running, busy: false, cols: 80, rows: 24 })
    const l = [s('i1', 'Claude API'), s('i2', 'x', false)]
    expect(findSession('claude-api', l)?.id).toBe('i1')
    expect(findSession('I1', l)).toBeNull()
    expect(findSession('i1', l)?.id).toBe('i1')
    expect(findSession('x', l)).toBeNull()
  })
})
