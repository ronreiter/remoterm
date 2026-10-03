import type { Duplex } from 'stream'
import { StringDecoder } from 'string_decoder'
import { Server, utils, type AuthContext, type Connection, type ServerChannel, type Session } from 'ssh2'
import type { AttachMode, SessionInfo } from '@remoterm/protocol'
import type { GithubKeys } from './githubKeys'
import type { HubClient, HubHandle, PtyHub } from './ptyHub'

export interface SshServiceOptions {
  hub: PtyHub
  hostKey: string | Buffer
  keys: Pick<GithubKeys, 'isAllowed'>
  /** Owner's GitHub login; null until the agent config has been fetched. */
  ownerLogin: () => string | null
  /** Sessions known to the agent (running flag decides what can be attached). */
  listSessions: () => SessionInfo[]
  mode?: AttachMode
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Maps an SSH username to a running session: id, exact name (any case), or slugified name. */
export function resolveSession(username: string, sessions: SessionInfo[]): SessionInfo | null {
  const running = sessions.filter((s) => s.running)
  const u = username.trim()
  const byId = running.find((s) => s.id === u)
  if (byId) return byId
  const lower = u.toLowerCase()
  const byName = running.find((s) => s.name.toLowerCase() === lower)
  if (byName) return byName
  const slug = slugify(u)
  if (!slug) return null
  return running.find((s) => slugify(s.name) === slug) ?? null
}

/** Serves SSH over arbitrary byte streams (no TCP listener); one ssh2 Server shared by all streams. */
export class SshService {
  private server: Server
  private active = new Set<Connection>()

  constructor(private o: SshServiceOptions) {
    this.server = new Server({ hostKeys: [o.hostKey] }, (conn) => this.onConnection(conn))
  }

  /** Runs an SSH server connection over `stream`. */
  handle(stream: Duplex): void {
    this.server.injectSocket(stream as never)
  }

  closeAll(): void {
    for (const c of [...this.active]) c.end()
  }

  private onConnection(conn: Connection): void {
    this.active.add(conn)
    let username = ''
    let handle: HubHandle | null = null
    conn.on('error', () => {
      /* peer reset etc. */
    })
    conn.on('close', () => {
      this.active.delete(conn)
      handle?.detach()
      handle = null
    })

    conn.on('authentication', (ctx: AuthContext) => {
      username = ctx.username
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      const login = this.o.ownerLogin()
      if (!login) return ctx.reject(['publickey'])
      this.o.keys
        .isAllowed(login, ctx.key.data)
        .then((ok) => {
          if (!ok) return ctx.reject(['publickey'])
          // No signature = the client is only asking whether this key is acceptable.
          if (!ctx.signature) return ctx.accept()
          // Otherwise it must prove possession of the matching private key.
          const parsed = utils.parseKey(ctx.key.data)
          const valid =
            !(parsed instanceof Error) &&
            !Array.isArray(parsed) &&
            parsed.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) === true
          return valid ? ctx.accept() : ctx.reject(['publickey'])
        })
        .catch(() => ctx.reject(['publickey']))
    })

    // No port forwarding of any kind.
    conn.on('request', (_accept, reject) => reject?.())
    conn.on('tcpip', (_accept, reject) => reject())

    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept()
        this.onSession(conn, session, () => username, (h) => (handle = h))
      })
    })
  }

  private onSession(conn: Connection, session: Session, getUser: () => string, setHandle: (h: HubHandle | null) => void): void {
    let cols = 80
    let rows = 24
    let hasPty = false
    let started = false
    let active: HubHandle | null = null

    session.on('pty', (accept, _reject, info) => {
      cols = info.cols || 80
      rows = info.rows || 24
      hasPty = true
      accept()
    })
    session.on('window-change', (accept, _reject, info) => {
      cols = info.cols || cols
      rows = info.rows || rows
      accept?.()
      active?.resize(cols, rows)
    })
    session.on('env', (accept) => accept?.())
    session.on('exec', (_accept, reject) => reject())
    session.on('subsystem', (_accept, reject) => reject())
    session.on('auth-agent', (_accept, reject) => reject())
    session.on('shell', (accept, reject) => {
      if (started) return reject()
      started = true
      const channel = accept()
      const attachTo = (s: SessionInfo): void => {
        active = this.attach(conn, channel, s, cols, rows)
        setHandle(active)
        if (!active) this.finish(channel, 'session is no longer running', 1)
      }
      const user = getUser()
      if (user === 'menu') {
        this.menu(channel, hasPty, (s) => attachTo(s))
        return
      }
      const s = resolveSession(user, this.o.listSessions())
      if (!s) {
        const names = this.o.listSessions().filter((x) => x.running).map((x) => x.name)
        this.finish(
          channel,
          `no running session matches "${user}"` + (names.length ? `\r\nrunning: ${names.join(', ')}` : '') + '\r\n(use user "menu" to pick)',
          1
        )
        return
      }
      attachTo(s)
    })

    session.on('close', () => {
      active?.detach()
      active = null
    })
  }

  private finish(channel: ServerChannel, message: string, code: number): void {
    channel.write(message + '\r\n')
    channel.exit(code)
    channel.end()
  }

  private menu(channel: ServerChannel, _hasPty: boolean, pick: (s: SessionInfo) => void): void {
    const running = this.o.listSessions().filter((s) => s.running)
    if (running.length === 0) return this.finish(channel, 'No running sessions.', 1)
    channel.write('Running sessions:\r\n')
    running.forEach((s, i) => channel.write(`  ${i + 1}) ${s.name}${s.cwd ? `  (${s.cwd})` : ''}\r\n`))
    channel.write('Select a session number (q to quit): ')
    let buf = ''
    const dec = new StringDecoder('utf8')
    const onData = (d: Buffer): void => {
      for (const ch of dec.write(d)) {
        if (ch === '\r' || ch === '\n') {
          channel.write('\r\n')
          const line = buf.trim()
          buf = ''
          if (line === 'q' || line === 'Q') {
            channel.removeListener('data', onData)
            return this.finish(channel, 'bye', 0)
          }
          const n = Number(line)
          if (Number.isInteger(n) && n >= 1 && n <= running.length) {
            channel.removeListener('data', onData)
            return pick(running[n - 1])
          }
          channel.write('Invalid choice. Select a session number (q to quit): ')
        } else if (ch === '\x7f' || ch === '\b') {
          if (buf) {
            buf = buf.slice(0, -1)
            channel.write('\b \b')
          }
        } else if (ch === '\x03' || ch === '\x04') {
          channel.removeListener('data', onData)
          return this.finish(channel, '', 0)
        } else if (ch >= ' ') {
          buf += ch
          channel.write(ch)
        }
      }
    }
    channel.on('data', onData)
  }

  private attach(conn: Connection, channel: ServerChannel, s: SessionInfo, cols: number, rows: number): HubHandle | null {
    const client: HubClient = {
      kind: 'remote',
      send: (data) => {
        if (channel.writable) channel.write(data)
      },
      snapshot: ({ data }) => {
        if (channel.writable) channel.write('\x1b[0m\x1b[2J\x1b[H' + data)
      },
      exit: (code) => {
        if (!channel.writable) return
        channel.exit(code)
        channel.end()
      },
      bufferedAmount: () => channel.writableLength,
      close: () => {
        channel.close()
        conn.end()
      }
    }
    const handle = this.o.hub.attach(s.id, client, this.o.mode ?? 'control')
    if (!handle) return null
    handle.resize(cols, rows)
    const dec = new StringDecoder('utf8')
    channel.on('data', (d: Buffer) => handle.write(dec.write(d)))
    channel.on('close', () => handle.detach())
    return handle
  }
}
