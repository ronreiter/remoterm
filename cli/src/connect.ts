import type { Readable, Writable } from 'stream'
import WebSocket from 'ws'
import { CloseCode, encodeMessage } from '@remoterm/protocol'
import { CliError, offlineMessage } from './api'
import { apiFromCredentials, type Ctx } from './commands'
import { parseHost, HostError } from './host'

/** Human-readable explanation for a WS close code, or null for a clean close. */
export function describeClose(code: number, reason: string): string | null {
  switch (code) {
    case 1000:
    case 1005:
      return null
    case CloseCode.Unauthorized:
      return 'the device rejected your credentials (4401); run `remoterm login` and try again'
    case CloseCode.NotFound:
      return 'session not found or not running (4404)'
    case CloseCode.TooSlow:
      return 'connection dropped: too slow to keep up with output (4408)'
    case CloseCode.Replaced:
      return 'connection replaced by another client (4409)'
    default:
      return `connection closed (${code}${reason ? ` ${reason}` : ''})`
  }
}

export interface PipeOptions {
  url: string
  token: string
  stdin: Readable
  stdout: Writable
  err: (s: string) => void
  WebSocketImpl?: typeof WebSocket
}

/** Pipes stdin/stdout to a device's `/ws/ssh`, after the first-frame auth. Resolves with the exit code. */
export function runConnect(o: PipeOptions): Promise<number> {
  const WS = o.WebSocketImpl ?? WebSocket
  return new Promise<number>((resolve) => {
    const ws = new WS(o.url)
    let done = false
    const finish = (code: number, msg?: string): void => {
      if (done) return
      done = true
      if (msg) o.err(`remoterm: ${msg}\n`)
      o.stdin.removeAllListeners('data')
      o.stdin.pause()
      resolve(code)
    }

    o.stdin.pause()
    ws.on('open', () => {
      ws.send(encodeMessage({ t: 'auth', token: o.token }))
      o.stdin.on('data', (d: Buffer) => ws.send(d, { binary: true }))
      o.stdin.on('end', () => ws.close(1000))
      o.stdin.resume()
    })
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      o.stdout.write(buf)
    })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      const code = res.statusCode ?? 0
      finish(1, code === 404 || code >= 500 ? `the device is unreachable (HTTP ${code}); is Remoterm running with remote access enabled?` : `unexpected response (HTTP ${code})`)
    })
    ws.on('error', (e: Error) => finish(1, `connection failed: ${e.message}`))
    ws.on('close', (code: number, reason: Buffer) => {
      const msg = describeClose(code, reason.toString())
      finish(msg ? 1 : 0, msg ?? undefined)
    })
  })
}

/** `remoterm connect <host>`: resolves the device, fetches an attach token and pipes stdio. */
export async function connectCommand(ctx: Ctx, host: string, stdin: Readable, stdout: Writable): Promise<number> {
  let ref
  try {
    ref = parseHost(host, ctx.config.tunnelDomain)
  } catch (e) {
    if (e instanceof HostError) throw new CliError(e.message)
    throw e
  }
  const api = apiFromCredentials(ctx)
  const device = await api.findDevice(ref.kind === 'name' ? ref.name : ref.id)
  if (!device.online) throw new CliError(offlineMessage(device))
  const token = await api.attachToken(device.id)
  return runConnect({ url: `wss://${device.id}.${ctx.config.tunnelDomain}/ws/ssh`, token, stdin, stdout, err: ctx.err })
}
