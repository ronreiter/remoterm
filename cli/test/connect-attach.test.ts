import { describe, it, expect, afterEach } from 'vitest'
import { PassThrough } from 'stream'
import { WebSocketServer, WebSocket } from 'ws'
import { decodeClientMessage, encodeMessage } from '@remoterm/protocol'
import { runConnect, connectCommand, describeClose } from '../src/connect'
import { DetachDetector, runAttach, type TtyIn, type TtyOut } from '../src/attach'
import { CliError } from '../src/api'
import { writeCredentials } from '../src/credentials'
import type { Ctx } from '../src/commands'
import http from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const until = async (fn: () => boolean, ms = 3000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

let servers: WebSocketServer[] = []
let httpServers: http.Server[] = []
afterEach(async () => {
  for (const s of servers) {
    for (const c of s.clients) c.terminate()
    s.close()
  }
  for (const h of httpServers) h.close()
  servers = []
  httpServers = []
})

function mockServer(onConn: (ws: WebSocket, req: http.IncomingMessage) => void): string {
  const wss = new WebSocketServer({ port: 0 })
  servers.push(wss)
  wss.on('connection', onConn)
  return `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
}

describe('runConnect', () => {
  it('sends the auth frame first, then pipes bytes both ways and exits 0 when stdin ends', async () => {
    const received: { text: string[]; bin: Buffer[] } = { text: [], bin: [] }
    const url = mockServer((ws) => {
      ws.on('message', (d, isBinary) => {
        if (!isBinary) received.text.push(d.toString())
        else {
          received.bin.push(d as Buffer)
          ws.send(Buffer.concat([Buffer.from('echo:'), d as Buffer]), { binary: true })
        }
      })
    })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out: Buffer[] = []
    stdout.on('data', (d) => out.push(d))
    const done = runConnect({ url, token: 'TOK', stdin, stdout, err: () => undefined })
    stdin.write('SSH-2.0-test\r\n')
    await until(() => Buffer.concat(out).toString() === 'echo:SSH-2.0-test\r\n')
    expect(decodeClientMessage(received.text[0])).toEqual({ t: 'auth', token: 'TOK' })
    expect(received.text).toHaveLength(1)
    stdin.end()
    expect(await done).toBe(0)
  })

  it('exits 0 when the server closes cleanly (1000)', async () => {
    const url = mockServer((ws) => ws.on('message', () => ws.close(1000)))
    const stdin = new PassThrough()
    const done = runConnect({ url, token: 't', stdin, stdout: new PassThrough(), err: () => undefined })
    expect(await done).toBe(0)
  })

  it('reports 4401 with a login hint and exits 1', async () => {
    const url = mockServer((ws) => ws.on('message', () => ws.close(4401, 'unauthorized')))
    const errs: string[] = []
    const code = await runConnect({ url, token: 't', stdin: new PassThrough(), stdout: new PassThrough(), err: (s) => errs.push(s) })
    expect(code).toBe(1)
    expect(errs.join('')).toMatch(/4401.*remoterm login|remoterm login.*/s)
  })

  it('reports an unreachable device on HTTP errors (e.g. 530 from the tunnel)', async () => {
    const srv = http.createServer((_q, r) => {
      r.writeHead(530)
      r.end()
    })
    httpServers.push(srv)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const errs: string[] = []
    const code = await runConnect({
      url: `ws://127.0.0.1:${(srv.address() as { port: number }).port}/ws/ssh`,
      token: 't',
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      err: (s) => errs.push(s)
    })
    expect(code).toBe(1)
    expect(errs.join('')).toContain('unreachable')
  })

  it('describeClose maps codes', () => {
    expect(describeClose(1000, '')).toBeNull()
    expect(describeClose(4404, '')).toMatch(/not found/)
    expect(describeClose(4401, '')).toMatch(/login/)
    expect(describeClose(1006, '')).toMatch(/1006/)
  })
})

describe('connectCommand', () => {
  const mkCtx = (devices: unknown[]): Ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'remoterm-conn-'))
    const f = (async (url: string) => {
      const u = String(url)
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (u.endsWith('/auth/refresh')) return j({ access_token: 'AT', expires_in: 600 })
      if (u.endsWith('/devices')) return j(devices)
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const config = { api: 'https://api.test', tunnelDomain: 't.test', credentialsPath: join(dir, 'c') }
    writeCredentials(config.credentialsPath, { refresh_token: 'RT', api: config.api })
    return { config, out: () => undefined, err: () => undefined, fetch: f, openBrowser: () => undefined }
  }

  it('fails fast for offline devices', async () => {
    const ctx = mkCtx([{ id: 'abc', name: 'mac', hostname: 'abc.t.test', port: 1, created_at: 0, last_seen: 1700000000, online: false }])
    await expect(connectCommand(ctx, 'mac.remoterm', new PassThrough(), new PassThrough())).rejects.toThrow(/offline/)
  })
  it('rejects unknown devices and malformed hosts', async () => {
    const ctx = mkCtx([])
    await expect(connectCommand(ctx, 'ghost.remoterm', new PassThrough(), new PassThrough())).rejects.toThrow(CliError)
    await expect(connectCommand(ctx, 'example.com', new PassThrough(), new PassThrough())).rejects.toThrow(/unrecognized host/)
  })
})

describe('DetachDetector', () => {
  it('detaches on ~. at session start and after a newline; forwards preceding bytes', () => {
    expect(new DetachDetector().feed('~.')).toEqual({ forward: '', detach: true })
    const d = new DetachDetector()
    expect(d.feed('ls\r')).toEqual({ forward: 'ls\r', detach: false })
    expect(d.feed('~')).toEqual({ forward: '', detach: false })
    expect(d.feed('.')).toEqual({ forward: '', detach: true })
    expect(new DetachDetector().feed('x\n~.after')).toEqual({ forward: 'x\n', detach: true })
  })
  it('does not detach mid-line', () => {
    const d = new DetachDetector()
    expect(d.feed('echo ~.')).toEqual({ forward: 'echo ~.', detach: false })
  })
  it('forwards a tilde that is not followed by a dot, and ~~ is a literal tilde', () => {
    expect(new DetachDetector().feed('~x')).toEqual({ forward: '~x', detach: false })
    const d = new DetachDetector()
    expect(d.feed('~~')).toEqual({ forward: '~', detach: false })
    expect(d.feed('.')).toEqual({ forward: '.', detach: false }) // no longer at line start
    expect(new DetachDetector().feed('~\r')).toEqual({ forward: '~\r', detach: false })
  })
  it('works across chunk boundaries', () => {
    const d = new DetachDetector()
    d.feed('a\r')
    expect(d.feed('~').detach).toBe(false)
    expect(d.feed('.').detach).toBe(true)
  })
})

describe('runAttach', () => {
  const tty = () => {
    const stdin = new PassThrough() as PassThrough & TtyIn & { raw: boolean[] }
    stdin.isTTY = true
    stdin.raw = []
    stdin.setRawMode = (r: boolean) => void stdin.raw.push(r)
    const stdout = new PassThrough() as unknown as TtyOut
    stdout.columns = 100
    stdout.rows = 30
    const out: string[] = []
    stdout.on('data', (d: Buffer) => out.push(d.toString()))
    return { stdin, stdout, out }
  }

  function protocolServer() {
    const log: { auth?: string; resizes: { cols: number; rows: number }[]; input: string; url?: string } = { resizes: [], input: '' }
    let sock: WebSocket | null = null
    const url = mockServer((ws, req) => {
      sock = ws
      log.url = req.url
      let authed = false
      ws.on('message', (d, isBinary) => {
        if (isBinary) {
          log.input += d.toString()
          ws.send(Buffer.from(`out:${d.toString()}`), { binary: true })
          return
        }
        const m = decodeClientMessage(d.toString())
        if (!m) return
        if (m.t === 'auth' && !authed) {
          authed = true
          log.auth = m.token
          ws.send(encodeMessage({ t: 'snapshot', data: 'SNAP', cols: 80, rows: 24 }))
        } else if (m.t === 'resize') log.resizes.push({ cols: m.cols, rows: m.rows })
      })
    })
    return { url, log, sock: () => sock! }
  }

  it('attaches in raw mode, sends size, forwards input, detaches on ~. and restores the terminal', async () => {
    const srv = protocolServer()
    const { stdin, stdout, out } = tty()
    let winch: (() => void) | null = null
    const done = runAttach({
      url: srv.url + '/ws/attach/s1?mode=control',
      getToken: async () => 'JWT',
      mode: 'control',
      stdin,
      stdout,
      err: () => undefined,
      onResize: (cb) => {
        winch = cb
        return () => (winch = null)
      }
    })
    await until(() => stdin.raw.includes(true))
    expect(srv.log.auth).toBe('JWT')
    expect(out.join('')).toContain('SNAP')
    await until(() => srv.log.resizes.length === 1)
    expect(srv.log.resizes[0]).toEqual({ cols: 100, rows: 30 })

    ;(stdout as TtyOut).columns = 120
    winch!()
    await until(() => srv.log.resizes.length === 2)
    expect(srv.log.resizes[1]).toEqual({ cols: 120, rows: 30 })

    stdin.write('ls\r')
    await until(() => out.join('').includes('out:ls\r'))
    stdin.write('~.')
    expect(await done).toBe(0)
    expect(srv.log.input).toBe('ls\r') // the escape sequence is not forwarded
    expect(stdin.raw).toEqual([true, false])
    expect(winch).toBeNull()
  })

  it('view mode never sends input or size', async () => {
    const srv = protocolServer()
    const { stdin, stdout, out } = tty()
    const done = runAttach({ url: srv.url, getToken: async () => 'J', mode: 'view', stdin, stdout, err: () => undefined })
    await until(() => out.join('').includes('SNAP'))
    await until(() => stdin.raw.includes(true))
    stdin.write('rm -rf\r')
    await new Promise((r) => setTimeout(r, 50))
    expect(srv.log.input).toBe('')
    expect(srv.log.resizes).toEqual([])
    stdin.write('~.')
    expect(await done).toBe(0)
  })

  it('shows session exit and returns its code', async () => {
    const srv = protocolServer()
    const { stdin, stdout } = tty()
    const errs: string[] = []
    const done = runAttach({ url: srv.url, getToken: async () => 'J', mode: 'control', stdin, stdout, err: (s) => errs.push(s) })
    await until(() => stdin.raw.includes(true))
    srv.sock().send(encodeMessage({ t: 'exit', code: 7 }))
    expect(await done).toBe(7)
    expect(errs.join('')).toContain('session ended (exit 7)')
    expect(stdin.raw).toEqual([true, false])
  })

  it('maps 4404 on connect to a clear error and exits 1 without touching raw mode', async () => {
    const url = mockServer((ws) => ws.on('message', () => ws.close(4404, 'session not found or not running')))
    const { stdin, stdout } = tty()
    const errs: string[] = []
    const code = await runAttach({ url, getToken: async () => 'J', mode: 'control', stdin, stdout, err: (s) => errs.push(s) })
    expect(code).toBe(1)
    expect(errs.join('')).toContain('session not found or not running (4404)')
    expect(stdin.raw).toEqual([])
  })
})
