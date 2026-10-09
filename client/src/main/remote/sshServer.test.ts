import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as nodePty from 'node-pty'
import WebSocket from 'ws'
import { BaseAgent, Client, utils, type ClientChannel, type ParsedKey } from 'ssh2'
import { encodeMessage } from '@remoterm/protocol'
import { AgentServer, type SessionMeta } from './agentServer'
import { AgentAuth } from './auth'
import { GithubKeys } from './githubKeys'
import { loadOrCreateHostKey } from './hostKey'
import { PtyHub, type PtyLike } from './ptyHub'
import { resolveSession, slugify } from './sshServer'
import { WsDuplex } from './wsDuplex'
import { makeKeys, staticConfig, type TestKeys } from './testUtil'
import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const DEVICE = 'devabc'
const OWNER = 'user-1'

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

let keys: TestKeys
let hub: PtyHub
let server: AgentServer
let ptys: PtyLike[] = []
let metas: SessionMeta[] = []
let clients: Client[] = []
let sockets: WebSocket[] = []
let allowed: string[] = []
let fetches = 0
const userKey = utils.generateKeyPairSync('ed25519')
const otherKey = utils.generateKeyPairSync('ed25519')

const spawn = (cmd: string, args: string[] = []): PtyLike => {
  const p = nodePty.spawn(cmd, args, { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } })
  ptys.push(p)
  return p
}

const addSession = (id: string, name: string, cmd = '/bin/cat'): void => {
  metas.push({ id, name, tool: 'shell', cwd: '/tmp', folder: null, color: null })
  hub.create(id, spawn(cmd))
}

beforeEach(async () => {
  keys = await makeKeys()
  hub = new PtyHub()
  metas = []
  allowed = [userKey.public]
  fetches = 0
  const dir = mkdtempSync(join(tmpdir(), 'remoterm-ssh-'))
  server = new AgentServer({
    hub,
    auth: new AgentAuth({ deviceId: DEVICE, getConfig: async () => staticConfig(keys, OWNER) }),
    listSessions: () => metas,
    port: 0,
    authTimeoutMs: 300,
    ssh: {
      hostKey: loadOrCreateHostKey(dir),
      keys: new GithubKeys({
        missRefetchMs: 0,
        fetchText: async (login) => {
          expect(login).toBe('octocat')
          fetches++
          return allowed.join('\n')
        }
      })
    }
  })
  await server.start()
})

afterEach(async () => {
  for (const c of clients) c.end()
  for (const s of sockets) s.terminate()
  clients = []
  sockets = []
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

interface Opts {
  username: string
  privateKey?: string
  token?: string
}

async function openWs(token?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/ssh`)
  sockets.push(ws)
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res())
    ws.once('error', rej)
  })
  ws.send(encodeMessage({ t: 'auth', token: token ?? (await keys.sign({ sub: OWNER, aud: DEVICE })) }))
  return ws
}

async function connect(o: Opts): Promise<Client> {
  const ws = await openWs(o.token)
  const client = new Client()
  clients.push(client)
  await new Promise<void>((res, rej) => {
    client.once('ready', () => res())
    client.once('error', rej)
    client.connect({ sock: new WsDuplex(ws) as never, username: o.username, privateKey: o.privateKey ?? userKey.private })
  })
  return client
}

const shell = (c: Client, window: { cols: number; rows: number } | false = { cols: 100, rows: 30 }) =>
  new Promise<ClientChannel>((res, rej) =>
    c.shell(window as never, (e, ch) => {
      if (e) return rej(e)
      // Registered immediately so a fast exit cannot be missed.
      ;(ch as ClientChannel & { exited: Promise<number> }).exited = new Promise<number>((r) => ch.on('exit', (code: number) => r(code)))
      const cap = ch as Captured
      cap.captured = ''
      ch.on('data', (d: Buffer) => (cap.captured += d.toString()))
      res(ch)
    })
  )
type Captured = ClientChannel & { captured: string }
type Exiting = ClientChannel & { exited: Promise<number> }

const collect = (ch: ClientChannel) => ({
  get out() {
    return (ch as Captured).captured
  }
})

describe('resolveSession', () => {
  const s = (id: string, name: string, running = true) => ({ id, name, tool: '', cwd: '', folder: null, color: null, running, busy: false, cols: 80, rows: 24 })
  const list = [s('a1', 'Claude API'), s('b2', 'build'), s('c3', 'Old', false)]
  it('matches by id, case-insensitive name, and slug; ignores non-running', () => {
    expect(resolveSession('a1', list)?.id).toBe('a1')
    expect(resolveSession('BUILD', list)?.id).toBe('b2')
    expect(resolveSession('claude api', list)?.id).toBe('a1')
    expect(resolveSession('claude-api', list)?.id).toBe('a1')
    expect(resolveSession('old', list)).toBeNull()
    expect(resolveSession('nope', list)).toBeNull()
  })
  it('slugifies', () => expect(slugify('  My Session_1! ')).toBe('my-session-1'))
})

describe('host key', () => {
  it('is generated once with mode 0600 and reused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remoterm-hk-'))
    const a = loadOrCreateHostKey(dir)
    expect(a).toContain('OPENSSH PRIVATE KEY')
    expect(statSync(join(dir, 'ssh_host_ed25519')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateHostKey(dir)).toBe(a)
  })
})

describe('SSH over /ws/ssh', () => {
  it('accepts a listed key and attaches the shell to the session (I/O both ways)', async () => {
    addSession('s1', 'api')
    const c = await connect({ username: 'api' })
    const ch = await shell(c)
    const got = collect(ch)
    ch.write('hello-ssh\r')
    await until(() => got.out.includes('hello-ssh'))
    expect(hub.remoteCount('s1')).toBe(1)
  })

  it('rejects an unlisted key', async () => {
    addSession('s1', 'api')
    await expect(connect({ username: 'api', privateKey: otherKey.private })).rejects.toThrow(/authentication methods failed/i)
    expect(hub.remoteCount('s1')).toBe(0)
  })

  it('rejects a listed public key whose signature was made by a different private key', async () => {
    addSession('s1', 'api')
    // Offers the owner's (public, GitHub-listed) key but signs with an unrelated key.
    class ForgingAgent extends BaseAgent {
      getIdentities(cb: (err: Error | null, keys?: ParsedKey[]) => void): void {
        cb(null, [utils.parseKey(userKey.public) as ParsedKey])
      }
      sign(_pub: ParsedKey, data: Buffer, _opts: unknown, cb?: (err: Error | null, sig?: Buffer) => void): void {
        const done = (typeof _opts === 'function' ? _opts : cb) as (err: Error | null, sig?: Buffer) => void
        done(null, (utils.parseKey(otherKey.private) as ParsedKey).sign(data))
      }
    }
    const ws = await openWs()
    const client = new Client()
    clients.push(client)
    await expect(
      new Promise<void>((res, rej) => {
        client.once('ready', () => res())
        client.once('error', rej)
        client.connect({ sock: new WsDuplex(ws) as never, username: 'api', agent: new ForgingAgent() as never })
      })
    ).rejects.toThrow(/authentication methods failed/i)
    expect(hub.remoteCount('s1')).toBe(0)
  })

  it('refetches keys on a miss (key added after caching)', async () => {
    addSession('s1', 'api')
    allowed = [otherKey.public]
    await expect(connect({ username: 'api' })).rejects.toThrow()
    const before = fetches
    allowed = [userKey.public]
    const c = await connect({ username: 'api' })
    expect(fetches).toBeGreaterThan(before)
    c.end()
  })

  it('closes with 4401 before any SSH data on a bad JWT', async () => {
    const ws = await openWs('garbage')
    let binary = 0
    ws.on('message', (_d, isBinary) => isBinary && binary++)
    const code = await new Promise<number>((res) => ws.on('close', (c) => res(c)))
    expect(code).toBe(4401)
    expect(binary).toBe(0)
  })

  it('selects the session by name (any case), slug, or id', async () => {
    addSession('id-one', 'Claude API')
    addSession('id-two', 'build')
    for (const [user, id] of [['claude api', 'id-one'], ['claude-api', 'id-one'], ['BUILD', 'id-two'], ['id-two', 'id-two']] as const) {
      const c = await connect({ username: user })
      await shell(c)
      await until(() => hub.remoteCount(id) === 1)
      c.end()
      await until(() => hub.remoteCount(id) === 0)
    }
  })

  it('reports an unknown session and exits non-zero without attaching', async () => {
    addSession('s1', 'api')
    const c = await connect({ username: 'ghost' })
    const ch = await shell(c)
    const got = collect(ch)
    const code = await (ch as Exiting).exited
    expect(code).toBe(1)
    expect(got.out).toContain('no running session matches "ghost"')
    expect(got.out).toContain('api')
    expect(hub.remoteCount('s1')).toBe(0)
  })

  it('menu: lists running sessions and attaches the chosen number', async () => {
    addSession('s1', 'alpha')
    addSession('s2', 'beta')
    const c = await connect({ username: 'menu' })
    const ch = await shell(c)
    const got = collect(ch)
    await until(() => got.out.includes('2) beta'))
    expect(got.out).toContain('1) alpha')
    ch.write('2\r')
    await until(() => hub.remoteCount('s2') === 1)
    expect(hub.remoteCount('s1')).toBe(0)
    ch.write('typed-after-menu\r')
    await until(() => got.out.includes('typed-after-menu'))
  })

  it('drives resize from pty-req and window-change', async () => {
    addSession('s1', 'api')
    const c = await connect({ username: 'api' })
    const ch = await shell(c, { cols: 100, rows: 30 })
    await until(() => hub.info('s1')?.cols === 100 && hub.info('s1')?.rows === 30)
    ch.setWindow(30, 120, 0, 0) // rows, cols
    await until(() => hub.info('s1')?.cols === 120 && hub.info('s1')?.rows === 30)
  })

  it('rejects exec and subsystem requests', async () => {
    addSession('s1', 'api')
    const c = await connect({ username: 'api' })
    await expect(new Promise((res, rej) => c.exec('ls', (e, s) => (e ? rej(e) : res(s))))).rejects.toThrow()
    await expect(new Promise((res, rej) => c.subsys('sftp', (e, s) => (e ? rej(e) : res(s))))).rejects.toThrow()
    expect(hub.remoteCount('s1')).toBe(0)
  })

  it('rejects port forwarding', async () => {
    addSession('s1', 'api')
    const c = await connect({ username: 'api' })
    await expect(new Promise((res, rej) => c.forwardOut('127.0.0.1', 1, '127.0.0.1', 80, (e, s) => (e ? rej(e) : res(s))))).rejects.toThrow()
    await expect(new Promise((res, rej) => c.forwardIn('127.0.0.1', 0, (e) => (e ? rej(e) : res(null))))).rejects.toThrow()
  })

  it('detaches the hub client when the channel or connection closes', async () => {
    addSession('s1', 'api')
    const c = await connect({ username: 'api' })
    const ch = await shell(c)
    await until(() => hub.remoteCount('s1') === 1)
    ch.close()
    await until(() => hub.remoteCount('s1') === 0)
    const c2 = await connect({ username: 'api' })
    await shell(c2)
    await until(() => hub.remoteCount('s1') === 1)
    c2.end()
    await until(() => hub.remoteCount('s1') === 0)
  })

  it('tells the client the exit code when the session ends', async () => {
    addSession('s1', 'api', '/bin/sh')
    const c = await connect({ username: 'api' })
    const ch = await shell(c)
    await until(() => hub.remoteCount('s1') === 1)
    ch.write('exit 3\r')
    expect(await (ch as Exiting).exited).toBe(3)
  })
})
