import { CloseCode } from './messages'
import type { ServerMessage } from './messages'
import { encodeMessage, decodeServerMessage } from './codec'

export type AttachState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface BackoffOptions {
  initialMs: number
  maxMs: number
  factor: number
}

export interface AttachClientOptions {
  /** Full ws(s):// URL including `/ws/attach/:id?mode=`. Tokens never go in the URL. */
  url: string
  /** Returns a fresh attach JWT; called on every (re)connect. */
  getToken: () => Promise<string>
  /** WebSocket constructor (defaults to globalThis.WebSocket). */
  WebSocketImpl?: typeof WebSocket
  reconnect?: boolean
  backoff?: Partial<BackoffOptions>
}

interface Events {
  state: (s: AttachState) => void
  snapshot: (s: { data: string; cols: number; rows: number }) => void
  data: (bytes: Uint8Array) => void
  meta: (m: { title?: string; busy?: boolean }) => void
  exit: (code: number) => void
  error: (e: Error) => void
  close: (code: number, reason: string) => void
}

const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 500, maxMs: 15_000, factor: 2 }
const FATAL_CODES: number[] = [CloseCode.NotFound, CloseCode.Replaced]

export class AttachClient {
  state: AttachState = 'idle'
  private ws: WebSocket | null = null
  private listeners: { [K in keyof Events]?: Events[K][] } = {}
  private backoff: BackoffOptions
  private attempt = 0
  private unauthorizedStreak = 0
  private everOpened = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingConnect: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(private opts: AttachClientOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
  }

  on<K extends keyof Events>(ev: K, cb: Events[K]): () => void {
    ;(this.listeners[ev] ??= [] as never).push(cb as never)
    return () => {
      this.listeners[ev] = (this.listeners[ev] as Events[K][]).filter((f) => f !== cb) as never
    }
  }

  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>): void {
    for (const cb of (this.listeners[ev] ?? []) as ((...a: unknown[]) => void)[]) cb(...args)
  }

  private setState(s: AttachState): void {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  /** Resolves on the first snapshot; rejects if the connection ends fatally before that. */
  connect(): Promise<void> {
    if (this.pendingConnect) return Promise.reject(new Error('already connecting'))
    this.stopped = false
    const p = new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject }
    })
    void this.open()
    return p
  }

  private async open(): Promise<void> {
    if (this.stopped) return
    this.setState(this.everOpened || this.attempt > 0 ? 'reconnecting' : 'connecting')
    let token: string
    try {
      token = await this.opts.getToken()
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
      this.scheduleReconnect()
      return
    }
    if (this.stopped) return
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket
    const ws = new WS(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('open', () => {
      if (this.ws === ws) ws.send(encodeMessage({ t: 'auth', token }))
    })
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (this.ws !== ws) return
      const d = ev.data
      if (typeof d === 'string') this.onText(d)
      else if (d instanceof ArrayBuffer) this.emit('data', new Uint8Array(d))
      else if (ArrayBuffer.isView(d)) this.emit('data', new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
    })
    ws.addEventListener('error', () => {
      /* a 'close' event always follows */
    })
    ws.addEventListener('close', (ev: CloseEvent) => {
      if (this.ws !== ws) return
      this.ws = null
      this.onClose(ev.code, ev.reason)
    })
  }

  private onText(raw: string): void {
    const m: ServerMessage | null = decodeServerMessage(raw)
    if (!m) return
    switch (m.t) {
      case 'snapshot':
        this.attempt = 0
        this.unauthorizedStreak = 0
        this.everOpened = true
        this.setState('open')
        this.emit('snapshot', { data: m.data, cols: m.cols, rows: m.rows })
        this.pendingConnect?.resolve()
        this.pendingConnect = null
        break
      case 'meta':
        this.emit('meta', { title: m.title, busy: m.busy })
        break
      case 'exit':
        this.stopped = true
        this.emit('exit', m.code)
        break
      case 'ping':
        this.sendJson({ t: 'pong' })
        break
      case 'error':
        this.emit('error', new Error(`${m.code}: ${m.message}`))
        break
    }
  }

  private onClose(code: number, reason: string): void {
    const fatal =
      this.stopped ||
      this.opts.reconnect === false ||
      FATAL_CODES.includes(code) ||
      (code === CloseCode.Unauthorized && ++this.unauthorizedStreak >= 2)
    if (fatal) {
      this.finish(code, reason)
      return
    }
    this.scheduleReconnect()
  }

  private finish(code: number, reason: string): void {
    this.stopped = true
    this.setState('closed')
    this.emit('close', code, reason)
    this.pendingConnect?.reject(new Error(`closed ${code} ${reason}`.trim()))
    this.pendingConnect = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.setState('reconnecting')
    const { initialMs, maxMs, factor } = this.backoff
    const delay = Math.min(maxMs, initialMs * Math.pow(factor, this.attempt++))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.open()
    }, delay)
  }

  private sendJson(m: Parameters<typeof encodeMessage>[0]): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encodeMessage(m))
  }

  /** Terminal input (binary frame). Dropped by the host in view mode. */
  write(data: string | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1) return
    this.ws.send(typeof data === 'string' ? new TextEncoder().encode(data) : data)
  }

  resize(cols: number, rows: number): void {
    this.sendJson({ t: 'resize', cols, rows })
  }

  focus(): void {
    this.sendJson({ t: 'focus' })
  }

  close(): void {
    const wasStopped = this.stopped
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000)
    } catch {
      /* ignore */
    }
    if (this.state !== 'closed') {
      this.setState('closed')
      if (!wasStopped) this.emit('close', 1000, 'client closed')
    }
    this.pendingConnect?.reject(new Error('closed'))
    this.pendingConnect = null
  }
}
