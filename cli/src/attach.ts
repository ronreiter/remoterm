import type { Readable, Writable } from 'stream'
import WebSocket from 'ws'
import { AttachClient, type AttachMode } from '@remoterm/protocol'
import { CliError, fetchSessions, findSession, offlineMessage } from './api'
import { apiFromCredentials, tunnelOrigin, type Ctx } from './commands'
import { describeClose } from './connect'
import { parseTarget } from './args'

/**
 * Detects the ssh-style escape `~.` typed at the start of a line (or of the session).
 * Feed it raw input; it returns what should be forwarded and whether to detach.
 */
export class DetachDetector {
  private atLineStart = true
  private pendingTilde = false

  feed(input: string): { forward: string; detach: boolean } {
    let out = ''
    for (const ch of input) {
      if (this.pendingTilde) {
        this.pendingTilde = false
        if (ch === '.') return { forward: out, detach: true }
        if (ch === '~') {
          out += '~' // `~~` sends a literal tilde
          this.atLineStart = false
          continue
        }
        out += '~'
        // fall through: handle `ch` normally
      } else if (ch === '~' && this.atLineStart) {
        this.pendingTilde = true
        continue
      }
      out += ch
      this.atLineStart = ch === '\r' || ch === '\n'
    }
    return { forward: out, detach: false }
  }
}

export interface TtyIn extends Readable {
  isTTY?: boolean
  setRawMode?(raw: boolean): unknown
}
export interface TtyOut extends Writable {
  columns?: number
  rows?: number
}

export interface AttachOptions {
  url: string
  getToken: () => Promise<string>
  mode: AttachMode
  stdin: TtyIn
  stdout: TtyOut
  err: (s: string) => void
  /** Register a SIGWINCH handler; returns an unsubscribe function. */
  onResize?: (cb: () => void) => () => void
  WebSocketImpl?: typeof WebSocket
}

const RESET_SCREEN = '\x1b[0m\x1b[2J\x1b[H'

/** Raw-mode attach in the local terminal. Resolves with the process exit code; always restores the terminal. */
export async function runAttach(o: AttachOptions): Promise<number> {
  const client = new AttachClient({
    url: o.url,
    getToken: o.getToken,
    WebSocketImpl: (o.WebSocketImpl ?? WebSocket) as unknown as typeof globalThis.WebSocket,
    reconnect: false
  })
  const detector = new DetachDetector()
  const dec = new TextDecoder()
  let raw = false
  let unsubResize: (() => void) | null = null

  const restore = (): void => {
    unsubResize?.()
    unsubResize = null
    o.stdin.removeListener('data', onInput)
    if (raw) {
      try {
        o.stdin.setRawMode?.(false)
      } catch {
        /* ignore */
      }
      raw = false
    }
    o.stdin.pause()
  }

  let result: ((code: number) => void) | null = null
  const finish = (code: number, msg?: string): void => {
    if (!result) return
    const r = result
    result = null
    restore()
    client.close()
    if (msg) o.err(`\r\n[remoterm] ${msg}\r\n`)
    r(code)
  }

  const sendSize = (): void => {
    if (o.mode === 'control' && o.stdout.columns && o.stdout.rows) client.resize(o.stdout.columns, o.stdout.rows)
  }

  function onInput(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const { forward, detach } = detector.feed(text)
    if (forward && o.mode === 'control') client.write(forward)
    if (detach) finish(0, 'detached')
  }

  client.on('snapshot', (s) => o.stdout.write(RESET_SCREEN + s.data))
  client.on('data', (b) => o.stdout.write(dec.decode(b, { stream: true })))
  client.on('exit', (code) => finish(code, `session ended (exit ${code})`))
  client.on('close', (code, reason) => {
    const m = describeClose(code, reason)
    finish(m ? 1 : 0, m ?? undefined)
  })

  const done = new Promise<number>((res) => (result = res))
  try {
    await client.connect()
  } catch (e) {
    // `close` has already produced the message for server-side closes.
    if (result) finish(1, `could not attach: ${e instanceof Error ? e.message : String(e)}`)
    return done
  }
  o.err(`[remoterm] attached${o.mode === 'view' ? ' (view only)' : ''}; type ~. at the start of a line to detach\r\n`)
  if (o.stdin.isTTY) {
    o.stdin.setRawMode?.(true)
    raw = true
  }
  o.stdin.on('data', onInput)
  o.stdin.resume()
  sendSize()
  unsubResize = o.onResize?.(sendSize) ?? null
  return done
}

/** `remoterm attach <device>/<session> [--view]` */
export async function attachCommand(ctx: Ctx, target: string, view: boolean, stdin: TtyIn, stdout: TtyOut): Promise<number> {
  const { device: deviceName, session: sessionName } = parseTarget(target)
  const api = apiFromCredentials(ctx)
  const device = await api.findDevice(deviceName)
  if (!device.online) throw new CliError(offlineMessage(device))
  const origin = tunnelOrigin(device.id, ctx.config.tunnelDomain)
  const sessions = await fetchSessions(origin, await api.attachToken(device.id), ctx.fetch)
  const s = findSession(sessionName, sessions)
  if (!s) {
    const names = sessions.filter((x) => x.running).map((x) => x.name)
    throw new CliError(`no running session "${sessionName}" on ${device.name}` + (names.length ? ` (running: ${names.join(', ')})` : ''))
  }
  const mode: AttachMode = view ? 'view' : 'control'
  return runAttach({
    url: `wss://${device.id}.${ctx.config.tunnelDomain}/ws/attach/${encodeURIComponent(s.id)}?mode=${mode}`,
    getToken: () => api.attachToken(device.id),
    mode,
    stdin,
    stdout,
    err: ctx.err,
    onResize: (cb) => {
      process.on('SIGWINCH', cb)
      return () => process.off('SIGWINCH', cb)
    }
  })
}
