import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { decodeClientMessage, encodeMessage, type ServerMessage, type SessionInfo } from '@remoterm/protocol'
import { AccountError } from './account'
import { RemoteClient, type TabOutputEvent, type TabStatusEvent } from './remoteClient'

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sess = (id: string, running = true): SessionInfo => ({
  id,
  name: id,
  tool: 'claude',
  cwd: '/x',
  folder: null,
  color: null,
  running,
  busy: false,
  cols: 80,
  rows: 24
})

/** Fake agent: serves /<deviceId>/api/sessions and /<deviceId>/ws/attach/:sid on one port. */
interface Conn {
  ws: WebSocket
  device: string
  session: string
  mode: string | null
  token: string | null
  texts: any[]
  bin: Buffer[]
}
let httpServer: http.Server
let wss: WebSocketServer
let port = 0
let conns: Conn[] = []
let sessionsByDevice: Record<string, SessionInfo[]> = {}
let sessionsStatus: Record<string, number> = {}
let acceptToken: (token: string, device: string) => boolean
let onAuthed: (c: Conn) => void

// API side
let apiCalls: { method: string; path: string; auth: string | null }[] = []
let devicesJson: any[] = []
let attachCount = 0
let apiStatus: Record<string, number> = {}
let accessCalls: boolean[] = []
let accessError: Error | null = null
let statuses: TabStatusEvent[] = []
let outputs: TabOutputEvent[] = []
let client: RemoteClient

const fakeFetch = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url)
  const method = init.method ?? 'GET'
  const auth = new Headers(init.headers).get('authorization')
  if (u.port === String(port)) {
    // agent http
    const m = /^\/([^/]+)\/api\/sessions$/.exec(u.pathname)!
    const st = sessionsStatus[m[1]] ?? 200
    if (st !== 200) return new Response('{}', { status: st })
    if (!acceptToken(auth!.replace('Bearer ', ''), m[1])) return new Response('{}', { status: 401 })
    return new Response(JSON.stringify(sessionsByDevice[m[1]] ?? []), { status: 200 })
  }
  apiCalls.push({ method, path: u.pathname, auth })
  if (apiStatus[u.pathname]) return new Response('{}', { status: apiStatus[u.pathname] })
  if (method === 'GET' && u.pathname === '/devices') return new Response(JSON.stringify(devicesJson), { status: 200 })
  const m = /^\/devices\/([^/]+)\/attach-token$/.exec(u.pathname)
  if (method === 'POST' && m) return new Response(JSON.stringify({ token: `AT-${m[1]}-${++attachCount}` }), { status: 200 })
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

beforeEach(async () => {
  conns = []
  sessionsByDevice = {}
  sessionsStatus = {}
  apiCalls = []
  apiStatus = {}
  devicesJson = []
  attachCount = 0
  accessCalls = []
  accessError = null
  statuses = []
  outputs = []
  acceptToken = () => true
  onAuthed = (c) => c.ws.send(encodeMessage({ t: 'snapshot', data: 'hello', cols: 80, rows: 24 }))

  httpServer = http.createServer()
  wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, req) => {
    const m = /^\/([^/]+)\/ws\/attach\/([^/?]+)$/.exec(new URL(req.url!, 'http://x').pathname)!
    const c: Conn = {
      ws,
      device: m[1],
      session: decodeURIComponent(m[2]),
      mode: new URL(req.url!, 'http://x').searchParams.get('mode'),
      token: null,
      texts: [],
      bin: []
    }
    conns.push(c)
    ws.on('message', (data, isBinary) => {
      if (isBinary) return void c.bin.push(Buffer.from(data as Buffer))
      const msg = decodeClientMessage(data.toString())
      if (!msg) return
      if (msg.t === 'auth') {
        c.token = msg.token
        if (!acceptToken(msg.token, c.device)) return ws.close(4401, 'unauthorized')
        return onAuthed(c)
      }
      c.texts.push(msg)
    })
  })
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r))
  port = (httpServer.address() as { port: number }).port

  client = new RemoteClient({
    apiBase: 'https://api.test/',
    getAccessToken: async (force) => {
      accessCalls.push(!!force)
      if (accessError) throw accessError
      return force ? 'API-FRESH' : 'API-1'
    },
    ownDeviceId: () => 'me',
    emitOutput: (e) => outputs.push(e),
    emitStatus: (e) => statuses.push(e),
    fetch: fakeFetch,
    agentOrigin: (id) => ({ http: `http://127.0.0.1:${port}/${id}`, ws: `ws://127.0.0.1:${port}/${id}` }),
    backoff: { initialMs: 20, maxMs: 40 }
  })
})

afterEach(async () => {
  client.detachAll()
  for (const c of wss.clients) c.terminate()
  await new Promise<void>((r) => wss.close(() => r()))
  await new Promise<void>((r) => httpServer.close(() => r()))
})

const lastStatus = (tab = 't1') => statuses.filter((s) => s.tabId === tab).at(-1)?.status

describe('listDevices', () => {
  it('excludes this Mac, fetches sessions for online devices only, keeps running sessions', async () => {
    devicesJson = [
      { id: 'me', name: 'this', online: true, last_seen: 1 },
      { id: 'd1', name: 'studio', online: true, last_seen: 100 },
      { id: 'd2', name: 'laptop', online: false, last_seen: 50 }
    ]
    sessionsByDevice.d1 = [sess('s1'), sess('s2', false)]
    const r = await client.listDevices()
    expect(r).toEqual({
      ok: true,
      devices: [
        { id: 'd1', name: 'studio', online: true, lastSeen: 100, sessions: [sess('s1')] },
        { id: 'd2', name: 'laptop', online: false, lastSeen: 50, sessions: [] }
      ]
    })
    expect(apiCalls.filter((c) => c.path.endsWith('/attach-token')).map((c) => c.path)).toEqual(['/devices/d1/attach-token'])
    expect(apiCalls.find((c) => c.path === '/devices')!.auth).toBe('Bearer API-1')
  })

  it('marks an online device whose agent is unreachable as offline', async () => {
    devicesJson = [{ id: 'd1', name: 'studio', online: true, last_seen: 1 }]
    sessionsStatus.d1 = 502
    const r = await client.listDevices()
    expect(r).toMatchObject({ ok: true, devices: [{ id: 'd1', online: true, error: 'offline', sessions: [] }] })
  })

  it('retries a rejected attach token once for /api/sessions, then reports auth', async () => {
    devicesJson = [{ id: 'd1', name: 'studio', online: true, last_seen: 1 }]
    sessionsByDevice.d1 = [sess('s1')]
    let n = 0
    acceptToken = () => ++n > 1
    expect(await client.listDevices()).toMatchObject({ ok: true, devices: [{ sessions: [sess('s1')] }] })
    expect(attachCount).toBe(2)

    acceptToken = () => false
    expect(await client.listDevices()).toMatchObject({ ok: true, devices: [{ error: 'auth', sessions: [] }] })
  })

  it('refreshes the api token once on 401, then reports signed_out', async () => {
    apiStatus['/devices'] = 401
    expect(await client.listDevices()).toEqual({ ok: false, error: 'signed_out' })
    expect(accessCalls).toEqual([false, true])
  })

  it('reports signed_out when there is no refresh token, and server/network failures', async () => {
    accessError = new AccountError('signed_out', 'not signed in')
    expect(await client.listDevices()).toEqual({ ok: false, error: 'signed_out' })
    accessError = new AccountError('network', 'offline')
    expect(await client.listDevices()).toEqual({ ok: false, error: 'network' })
    accessError = null
    apiStatus['/devices'] = 500
    expect(await client.listDevices()).toEqual({ ok: false, error: 'server' })
  })
})

describe('attach', () => {
  it('authenticates with a fresh attach token, bridges snapshot / output / input / resize', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 'sess 1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    expect(statuses[0]).toEqual({ tabId: 't1', status: 'connecting' })
    expect(conns[0]).toMatchObject({ device: 'd1', session: 'sess 1', mode: 'control' })
    expect(conns[0].token).toMatch(/^AT-d1-/)
    expect(outputs[0]).toEqual({ tabId: 't1', kind: 'snapshot', data: 'hello', cols: 80, rows: 24 })

    conns[0].ws.send(Buffer.from('world'))
    await until(() => outputs.length === 2)
    expect(outputs[1].kind).toBe('data')
    expect(Buffer.from((outputs[1] as any).data).toString()).toBe('world')

    client.write('t1', 'ls\r')
    client.resize('t1', 100, 30)
    await until(() => conns[0].bin.length === 1 && conns[0].texts.some((m) => m.t === 'resize'))
    expect(conns[0].bin[0].toString()).toBe('ls\r')
    expect(conns[0].texts).toContainEqual({ t: 'resize', cols: 100, rows: 30 })
    expect(conns[0].texts).toContainEqual({ t: 'focus' }) // control mode claims focus on attach
  })

  it('view mode connects with mode=view and never sends input or resize', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'view' })
    await until(() => lastStatus() === 'live')
    expect(conns[0].mode).toBe('view')
    client.write('t1', 'x')
    client.resize('t1', 10, 10)
    await new Promise((r) => setTimeout(r, 60))
    expect(conns[0].bin).toHaveLength(0)
    expect(conns[0].texts).toHaveLength(0)
  })

  it('re-attaching a tab (mode change) closes the old socket and opens a new one', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'view' })
    await until(() => conns.length === 2 && outputs.filter((o) => o.kind === 'snapshot').length === 2)
    expect(conns[1].mode).toBe('view')
    expect(conns[0].ws.readyState).not.toBe(WebSocket.OPEN)
  })

  it('a snapshot after a re-send (another client resized) is forwarded as a snapshot again', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    conns[0].ws.send(encodeMessage({ t: 'snapshot', data: 'redraw', cols: 120, rows: 40 } as ServerMessage))
    await until(() => outputs.filter((o) => o.kind === 'snapshot').length === 2)
    expect(outputs.at(-1)).toEqual({ tabId: 't1', kind: 'snapshot', data: 'redraw', cols: 120, rows: 40 })
  })

  it('4401 on the first connect: fetches a new token and retries once, then goes live', async () => {
    let first = true
    acceptToken = () => (first ? ((first = false), false) : true)
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    expect(conns).toHaveLength(2)
    expect(conns[0].token).not.toBe(conns[1].token)
    expect(statuses.some((s) => s.status === 'auth')).toBe(false)
  })

  it('two consecutive 4401s end in the auth status (sign-in needed) and stop retrying', async () => {
    acceptToken = () => false
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'auth')
    expect(statuses.at(-1)).toMatchObject({ status: 'auth', code: 4401 })
    const n = conns.length
    expect(n).toBe(2)
    await new Promise((r) => setTimeout(r, 120))
    expect(conns).toHaveLength(n)
  })

  it('4404 means the session ended (no retry)', async () => {
    onAuthed = (c) => c.ws.close(4404, 'not found')
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 'gone', mode: 'control' })
    await until(() => lastStatus() === 'ended')
    expect(statuses.at(-1)).toMatchObject({ status: 'ended', code: 4404 })
    await new Promise((r) => setTimeout(r, 100))
    expect(conns).toHaveLength(1)
  })

  it('an exit frame ends the tab with the exit code and is not overridden by the close', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    conns[0].ws.send(encodeMessage({ t: 'exit', code: 3 }))
    conns[0].ws.close(1000)
    await until(() => lastStatus() === 'ended')
    await new Promise((r) => setTimeout(r, 60))
    expect(statuses.at(-1)).toEqual({ tabId: 't1', status: 'ended', exitCode: 3 })
  })

  it('a dropped connection shows offline, auto-reconnects with a new token, and resnapshots', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    conns[0].ws.terminate()
    await until(() => lastStatus() === 'offline')
    await until(() => lastStatus() === 'live' && conns.length === 2)
    expect(conns[1].token).not.toBe(conns[0].token)
    expect(outputs.filter((o) => o.kind === 'snapshot')).toHaveLength(2)
  })

  it('an unreachable device stays offline and keeps retrying', async () => {
    const dead = new RemoteClient({
      apiBase: 'https://api.test',
      getAccessToken: async () => 'x',
      ownDeviceId: () => undefined,
      emitOutput: () => {},
      emitStatus: (e) => statuses.push(e),
      fetch: fakeFetch,
      agentOrigin: () => ({ http: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:1' }),
      backoff: { initialMs: 10, maxMs: 20 }
    })
    dead.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'offline')
    await new Promise((r) => setTimeout(r, 100))
    expect(lastStatus()).toBe('offline')
    dead.detachAll()
  })

  it('losing the API credentials mid-attach reports auth and stops', async () => {
    accessError = new AccountError('signed_out', 'not signed in')
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'auth')
    expect(conns).toHaveLength(0)
  })

  it('detach closes the socket and emits nothing further', async () => {
    client.attach({ tabId: 't1', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    await until(() => lastStatus() === 'live')
    const n = statuses.length
    client.detach('t1')
    await until(() => conns[0].ws.readyState === WebSocket.CLOSED)
    await new Promise((r) => setTimeout(r, 50))
    expect(statuses).toHaveLength(n)
    client.write('t1', 'x') // no-op, no throw
  })

  it('detachAll closes every tab', async () => {
    client.attach({ tabId: 'a', deviceId: 'd1', sessionId: 's1', mode: 'control' })
    client.attach({ tabId: 'b', deviceId: 'd2', sessionId: 's2', mode: 'view' })
    await until(() => conns.length === 2 && conns.every((c) => c.token))
    client.detachAll()
    await until(() => conns.every((c) => c.ws.readyState === WebSocket.CLOSED))
  })
})
