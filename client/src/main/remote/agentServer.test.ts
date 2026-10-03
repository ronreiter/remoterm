import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as nodePty from 'node-pty'
import WebSocket from 'ws'
import { decodeServerMessage, encodeMessage, type ServerMessage, type SessionInfo } from '@remoterm/protocol'
import { AgentServer, type SessionMeta } from './agentServer'
import { AgentAuth, type AgentConfig } from './auth'
import { PtyHub, type PtyLike } from './ptyHub'
import { makeKeys, badSignatureToken, staticConfig, type TestKeys } from './testUtil'

const DEVICE = 'devabc'
const OWNER = 'user-1'
const nowS = () => Math.floor(Date.now() / 1000)

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Peer {
  ws: WebSocket
  texts: ServerMessage[]
  bin: string
  closed: { code: number; reason: string } | null
}

let keys: TestKeys
let config: AgentConfig
let hub: PtyHub
let auth: AgentAuth
let server: AgentServer
let ptys: PtyLike[] = []
let peers: Peer[] = []
let metas: SessionMeta[] = []

const spawn = (cmd: string, args: string[] = []): PtyLike => {
  const p = nodePty.spawn(cmd, args, { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } })
  ptys.push(p)
  return p
}

beforeEach(async () => {
  keys = await makeKeys()
  config = staticConfig(keys, OWNER)
  hub = new PtyHub()
  auth = new AgentAuth({ deviceId: DEVICE, getConfig: async () => config })
  metas = []
  server = new AgentServer({
    hub,
    auth,
    listSessions: () => metas,
    port: 0,
    authTimeoutMs: 300
  })
  await server.start()
})

afterEach(async () => {
  for (const p of peers) p.ws.terminate()
  peers = []
  await server.stop()
  hub.dispose()
  for (const p of ptys) {
    try {
      p.kill()
    } catch {
      /* gone */
    }
  }
  ptys = []
})

const wsUrl = (id: string, mode = 'control') => `ws://127.0.0.1:${server.port}/ws/attach/${id}?mode=${mode}`

function connect(id: string, mode = 'control', opts: { auth?: string | null } = {}): Peer {
  const ws = new WebSocket(wsUrl(id, mode))
  const peer: Peer = { ws, texts: [], bin: '', closed: null }
  peers.push(peer)
  ws.on('open', () => {
    if (opts.auth !== null) ws.send(encodeMessage({ t: 'auth', token: opts.auth ?? '' }))
  })
  ws.on('message', (d, isBinary) => {
    if (isBinary) peer.bin += d.toString()
    else {
      const m = decodeServerMessage(d.toString())
      if (m) peer.texts.push(m)
    }
  })
  ws.on('close', (code, reason) => (peer.closed = { code, reason: reason.toString() }))
  return peer
}

const good = () => keys.sign({ sub: OWNER, aud: DEVICE })

describe('auth rejections close with 4401', () => {
  beforeEach(() => {
    hub.create('s1', spawn('/bin/cat'))
  })

  it('no token (no auth frame within the timeout)', async () => {
    const p = connect('s1', 'control', { auth: null })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('first frame is not auth', async () => {
    const p = connect('s1', 'control', { auth: null })
    p.ws.on('open', () => p.ws.send(encodeMessage({ t: 'focus' })))
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('empty/garbage token', async () => {
    const p = connect('s1', 'control', { auth: 'garbage' })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('bad signature', async () => {
    const p = connect('s1', 'control', { auth: await badSignatureToken(keys.kid, { sub: OWNER, aud: DEVICE }) })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('wrong audience', async () => {
    const p = connect('s1', 'control', { auth: await keys.sign({ sub: OWNER, aud: 'other-device' }) })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('wrong subject', async () => {
    const p = connect('s1', 'control', { auth: await keys.sign({ sub: 'intruder', aud: DEVICE }) })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('expired', async () => {
    const n = nowS()
    const p = connect('s1', 'control', { auth: await keys.sign({ sub: OWNER, aud: DEVICE, iat: n - 900, exp: n - 300 }) })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('revoked (iat <= revokedBefore)', async () => {
    config = staticConfig(keys, OWNER, nowS() + 5)
    const p = connect('s1', 'control', { auth: await good() })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
  })

  it('never attached the PTY for rejected sockets', async () => {
    const p = connect('s1', 'control', { auth: 'garbage' })
    await until(() => p.closed !== null)
    expect(hub.remoteCount('s1')).toBe(0)
  })
})

describe('attach', () => {
  it('closes with 4404 for an unknown / non-running session', async () => {
    const p = connect('nope', 'control', { auth: await good() })
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4404)
  })

  it('sends a snapshot of earlier output, then streams live output', async () => {
    hub.create('s1', spawn('/bin/bash', ['-c', 'echo earlier-output; exec cat']))
    await new Promise((r) => setTimeout(r, 400))
    const p = connect('s1', 'control', { auth: await good() })
    await until(() => p.texts.some((t) => t.t === 'snapshot'))
    const snap = p.texts.find((t) => t.t === 'snapshot') as Extract<ServerMessage, { t: 'snapshot' }>
    expect(snap.data).toContain('earlier-output')
    expect([snap.cols, snap.rows]).toEqual([80, 24])
    expect(p.bin).toBe('') // snapshot arrives before any live bytes
    p.ws.send(Buffer.from('typed-after\n'))
    await until(() => p.bin.includes('typed-after'))
  })

  it('control input reaches the PTY; view input is dropped and view cannot resize', async () => {
    const pty = spawn('/bin/cat')
    hub.create('s1', pty)
    const ctl = connect('s1', 'control', { auth: await good() })
    const view = connect('s1', 'view', { auth: await good() })
    await until(() => hub.remoteCount('s1') === 2)
    view.ws.send(Buffer.from('from-view\n'))
    view.ws.send(encodeMessage({ t: 'resize', cols: 200, rows: 60 }))
    await new Promise((r) => setTimeout(r, 200))
    expect(ctl.bin).not.toContain('from-view')
    expect(pty.cols).toBe(80)
    ctl.ws.send(Buffer.from('from-control\n'))
    await until(() => ctl.bin.includes('from-control') && view.bin.includes('from-control'))
    expect(view.bin).not.toContain('from-view')
  })

  it('resize follows the most recent controlling client (resize/focus)', async () => {
    const pty = spawn('/bin/cat')
    hub.create('s1', pty)
    const a = connect('s1', 'control', { auth: await good() })
    const b = connect('s1', 'control', { auth: await good() })
    await until(() => hub.remoteCount('s1') === 2)
    a.ws.send(encodeMessage({ t: 'resize', cols: 100, rows: 30 }))
    await until(() => pty.cols === 100)
    b.ws.send(encodeMessage({ t: 'resize', cols: 70, rows: 20 }))
    await until(() => pty.cols === 70 && pty.rows === 20)
    a.ws.send(encodeMessage({ t: 'focus' }))
    await until(() => pty.cols === 100 && pty.rows === 30)
  })

  it('delivers exit to clients and closes', async () => {
    hub.create('s1', spawn('/bin/bash', ['-c', 'sleep 0.5; exit 5']))
    const p = connect('s1', 'view', { auth: await good() })
    await until(() => p.closed !== null)
    expect(p.texts).toContainEqual({ t: 'exit', code: 5 })
  })

  it('pings periodically', async () => {
    await server.stop()
    server = new AgentServer({ hub, auth, listSessions: () => metas, port: 0, pingIntervalMs: 50 })
    await server.start()
    hub.create('s1', spawn('/bin/cat'))
    const p = connect('s1', 'view', { auth: await good() })
    await until(() => p.texts.some((t) => t.t === 'ping'))
  })

  it('drops a slow client with 4408', async () => {
    hub.create('s1', spawn('/bin/bash', ['-c', 'sleep 0.5; head -c 45000000 /dev/urandom | base64; sleep 5']))
    const slow = connect('s1', 'view', { auth: await good() })
    await until(() => slow.texts.some((t) => t.t === 'snapshot'))
    slow.ws.pause() // stop reading: the server-side send buffer fills up
    await until(() => hub.remoteCount('s1') === 0, 15000)
    slow.ws.resume()
    await until(() => slow.closed !== null, 15000)
    expect(slow.closed!.code).toBe(4408)
  }, 30000)

  it('closes open sockets when a JWKS refresh reports they were revoked', async () => {
    hub.create('s1', spawn('/bin/cat'))
    const p = connect('s1', 'control', { auth: await keys.sign({ sub: OWNER, aud: DEVICE, iat: nowS() - 10 }) })
    await until(() => hub.remoteCount('s1') === 1)
    config = staticConfig(keys, OWNER, nowS())
    await auth.refresh()
    await until(() => p.closed !== null)
    expect(p.closed!.code).toBe(4401)
    expect(hub.remoteCount('s1')).toBe(0)
  })

  it('stays open after the token expires', async () => {
    hub.create('s1', spawn('/bin/cat'))
    const n = nowS()
    const p = connect('s1', 'control', { auth: await keys.sign({ sub: OWNER, aud: DEVICE, iat: n - 1, exp: n + 1 }) })
    await until(() => hub.remoteCount('s1') === 1)
    await new Promise((r) => setTimeout(r, 2200))
    p.ws.send(Buffer.from('still-here\n'))
    await until(() => p.bin.includes('still-here'))
    expect(p.closed).toBeNull()
  })

  it('rejects unknown paths and bad modes without upgrading', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws/other`)
    const err = await new Promise<Error>((r) => bad.on('error', r))
    expect(err.message).toMatch(/404/)
    const bad2 = new WebSocket(wsUrl('s1', 'admin'))
    const err2 = await new Promise<Error>((r) => bad2.on('error', r))
    expect(err2.message).toMatch(/404/)
  })
})

describe('GET /api/sessions', () => {
  const url = () => `http://127.0.0.1:${server.port}/api/sessions`

  it('requires a bearer token', async () => {
    expect((await fetch(url())).status).toBe(401)
    expect((await fetch(url(), { headers: { authorization: 'Bearer junk' } })).status).toBe(401)
    expect((await fetch(url(), { headers: { authorization: `Bearer ${await keys.sign({ sub: 'x', aud: DEVICE })}` } })).status).toBe(401)
  })

  it('returns persisted metadata merged with hub state', async () => {
    metas = [
      { id: 's1', name: 'API', tool: 'claude', cwd: '/tmp/api', folder: 'work', color: 'red' },
      { id: 's2', name: 'Closed', tool: 'codex', cwd: '/tmp/c', folder: null, color: null }
    ]
    hub.create('s1', spawn('/bin/cat'))
    hub.setBusy('s1', true)
    const res = await fetch(url(), { headers: { authorization: `Bearer ${await good()}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionInfo[]
    expect(body).toEqual([
      { id: 's1', name: 'API', tool: 'claude', cwd: '/tmp/api', folder: 'work', color: 'red', running: true, busy: true, cols: 80, rows: 24 },
      { id: 's2', name: 'Closed', tool: 'codex', cwd: '/tmp/c', folder: null, color: null, running: false, busy: false, cols: 80, rows: 24 }
    ])
  })

  it('404s other paths and binds to loopback only', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404)
    const addr = (server as unknown as { server: import('http').Server }).server!.address() as { address: string }
    expect(addr.address).toBe('127.0.0.1')
  })
})
