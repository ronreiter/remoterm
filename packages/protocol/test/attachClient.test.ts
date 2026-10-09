import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { AttachClient, CloseCode, encodeMessage, decodeClientMessage, type ClientMessage } from '../src'

interface Conn {
  ws: WebSocket
  frames: ClientMessage[]
  binary: Buffer[]
}

let wss: WebSocketServer | null = null
let clients: AttachClient[] = []

async function server(onConn: (c: Conn) => void) {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss!.on('listening', () => r()))
  wss.on('connection', (ws) => {
    const c: Conn = { ws, frames: [], binary: [] }
    ws.on('message', (data, isBinary) => {
      if (isBinary) c.binary.push(data as Buffer)
      else {
        const m = decodeClientMessage(data.toString())
        if (m) c.frames.push(m)
        // like the real host: respond only once the auth frame has arrived
        if (m?.t === 'auth' && c.frames.length === 1) onConn(c)
      }
    })
  })
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws/attach/s1`
}

function mk(url: string, extra: Partial<ConstructorParameters<typeof AttachClient>[0]> = {}) {
  const c = new AttachClient({
    url,
    getToken: async () => 'tok',
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    backoff: { initialMs: 10, maxMs: 40, factor: 2 },
    ...extra
  })
  clients.push(c)
  return c
}

const until = async (fn: () => boolean, ms = 3000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

afterEach(async () => {
  clients.forEach((c) => c.close())
  clients = []
  wss?.clients.forEach((w) => w.terminate())
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()))
  wss = null
})

describe('AttachClient', () => {
  it('sends auth as the first frame, then handles snapshot and binary output', async () => {
    let conn!: Conn
    const url = await server((c) => {
      conn = c
      c.ws.send(encodeMessage({ t: 'snapshot', data: 'SNAP', cols: 100, rows: 30 }))
      c.ws.send(Buffer.from('live'))
    })
    const c = mk(url)
    const snaps: unknown[] = []
    const data: string[] = []
    c.on('snapshot', (s) => snaps.push(s))
    c.on('data', (b) => data.push(Buffer.from(b).toString()))
    await c.connect()
    await until(() => data.length === 1)
    expect(conn.frames[0]).toEqual({ t: 'auth', token: 'tok' })
    expect(snaps).toEqual([{ data: 'SNAP', cols: 100, rows: 30 }])
    expect(data).toEqual(['live'])
    expect(c.state).toBe('open')
  })

  it('sends binary input, resize and focus', async () => {
    let conn!: Conn
    const url = await server((c) => {
      conn = c
      c.ws.send(encodeMessage({ t: 'snapshot', data: '', cols: 80, rows: 24 }))
    })
    const c = mk(url)
    await c.connect()
    c.write('ls\r')
    c.write(new Uint8Array([1, 2, 3]))
    c.resize(120, 40)
    c.focus()
    await until(() => conn.binary.length === 2 && conn.frames.length === 3)
    expect(conn.binary[0].toString()).toBe('ls\r')
    expect([...conn.binary[1]]).toEqual([1, 2, 3])
    expect(conn.frames.slice(1)).toEqual([{ t: 'resize', cols: 120, rows: 40 }, { t: 'focus' }])
  })

  it('answers ping with pong and surfaces meta/exit', async () => {
    let conn!: Conn
    const url = await server((c) => {
      conn = c
      c.ws.send(encodeMessage({ t: 'snapshot', data: '', cols: 80, rows: 24 }))
    })
    const c = mk(url)
    const metas: unknown[] = []
    let exitCode: number | null = null
    c.on('meta', (m) => metas.push(m))
    c.on('exit', (code) => (exitCode = code))
    await c.connect()
    conn.ws.send(encodeMessage({ t: 'ping' }))
    conn.ws.send(encodeMessage({ t: 'meta', busy: true }))
    conn.ws.send(encodeMessage({ t: 'exit', code: 7 }))
    await until(() => exitCode !== null)
    expect(conn.frames.some((f) => f.t === 'pong')).toBe(true)
    expect(metas).toEqual([{ busy: true }])
    expect(exitCode).toBe(7)
  })

  it('does not reconnect after exit, close(), 4404 or 4409', async () => {
    let n = 0
    const url = await server((c) => {
      n++
      c.ws.close(CloseCode.NotFound, 'nope')
    })
    const c = mk(url)
    const closes: number[] = []
    c.on('close', (code) => closes.push(code))
    await c.connect().catch(() => {})
    await until(() => closes.length === 1)
    await new Promise((r) => setTimeout(r, 120))
    expect(n).toBe(1)
    expect(c.state).toBe('closed')
  })

  it('reconnects with backoff and a fresh token after an abnormal close', async () => {
    const conns: Conn[] = []
    const url = await server((c) => {
      conns.push(c)
      c.ws.send(encodeMessage({ t: 'snapshot', data: `S${conns.length}`, cols: 80, rows: 24 }))
      if (conns.length < 3) setTimeout(() => c.ws.close(CloseCode.TooSlow, 'slow'), 5)
    })
    let tokens = 0
    const c = mk(url, { getToken: async () => `t${++tokens}` })
    const snaps: string[] = []
    const states: string[] = []
    c.on('snapshot', (s) => snaps.push(s.data))
    c.on('state', (s) => states.push(s))
    await c.connect()
    await until(() => snaps.length === 3)
    expect(snaps).toEqual(['S1', 'S2', 'S3'])
    expect(conns.map((x) => x.frames[0])).toEqual([
      { t: 'auth', token: 't1' },
      { t: 'auth', token: 't2' },
      { t: 'auth', token: 't3' }
    ])
    expect(states).toContain('reconnecting')
    expect(c.state).toBe('open')
  })

  it('stops after a repeated 4401 (token rejected twice)', async () => {
    let n = 0
    const url = await server((c) => {
      n++
      c.ws.close(CloseCode.Unauthorized, 'bad')
    })
    const c = mk(url)
    const closes: number[] = []
    c.on('close', (code) => closes.push(code))
    await c.connect().catch(() => {})
    await until(() => c.state === 'closed')
    expect(n).toBe(2)
  })

  it('retries when getToken fails, and gives up reporting error on close()', async () => {
    const url = await server((c) => c.ws.send(encodeMessage({ t: 'snapshot', data: 'x', cols: 1, rows: 1 })))
    let calls = 0
    const c = mk(url, {
      getToken: async () => {
        if (++calls < 3) throw new Error('offline')
        return 'ok'
      }
    })
    const errors: string[] = []
    c.on('error', (e) => errors.push(e.message))
    c.connect().catch(() => {})
    await until(() => c.state === 'open')
    expect(errors).toEqual(['offline', 'offline'])
  })
})
