import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { CloseCode, MAX_BUFFERED_BYTES, type AttachMode } from '@remoterm/protocol'

/** The subset of node-pty's IPty used by the hub. */
export interface PtyLike {
  readonly cols: number
  readonly rows: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): { dispose(): void } | void
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void } | void
}

/**
 * A consumer of a session's output: the local renderer (via IPC), a WebSocket
 * attach connection, and later an SSH channel.
 */
export interface HubClient {
  kind: 'local' | 'remote'
  /** Live terminal output. */
  send(data: string): void
  /** Screen state sent on attach and after another client changes the size (remote only). */
  snapshot?(s: { data: string; cols: number; rows: number }): void
  meta?(m: { title?: string; busy?: boolean }): void
  exit(code: number): void
  /** Bytes queued but not yet flushed to the peer; over 1 MB the client is dropped (4408). */
  bufferedAmount?(): number
  close(code: number, reason: string): void
}

export interface HubHandle {
  /** Terminal input. Ignored for view clients. */
  write(data: string): void
  /** Ignored for view clients. */
  resize(cols: number, rows: number): void
  /** Makes this client the size owner (control clients only). */
  focus(): void
  detach(): void
}

export interface HubInfo {
  id: string
  running: boolean
  busy: boolean
  cols: number
  rows: number
}

interface Entry {
  id: string
  pty: PtyLike
  term: Terminal
  serialize: SerializeAddon
  clients: Map<HubClient, ClientState>
  busy: boolean
  cols: number
  rows: number
  latest: HubClient | null
  exited: boolean
}

interface ClientState {
  mode: AttachMode
  size: { cols: number; rows: number } | null
}

export const MIRROR_SCROLLBACK = 1000

export class PtyHub {
  private entries = new Map<string, Entry>()
  private remoteCountListeners = new Set<(id: string, count: number) => void>()
  private exitListeners = new Set<(id: string, code: number) => void>()

  constructor(private opts: { scrollback?: number } = {}) {}

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Registers a running PTY and starts mirroring its output. */
  create(id: string, pty: PtyLike): HubInfo {
    const term = new Terminal({
      cols: pty.cols,
      rows: pty.rows,
      scrollback: this.opts.scrollback ?? MIRROR_SCROLLBACK,
      allowProposedApi: true
    })
    const serialize = new SerializeAddon()
    term.loadAddon(serialize as never)
    const e: Entry = {
      id,
      pty,
      term,
      serialize,
      clients: new Map(),
      busy: false,
      cols: pty.cols,
      rows: pty.rows,
      latest: null,
      exited: false
    }
    this.entries.set(id, e)

    term.onTitleChange((title) => this.broadcastMeta(e, { title }))

    pty.onData((data) => {
      if (this.entries.get(id) !== e) return
      // Local clients get output immediately (same latency as before the hub existed).
      for (const [c] of e.clients) if (c.kind === 'local') c.send(data)
      // The mirror is updated first, so a snapshot taken at any later moment already
      // contains everything remote clients were sent.
      term.write(data, () => {
        for (const [c] of [...e.clients]) if (c.kind === 'remote') this.sendRemote(e, c, data)
      })
    })
    pty.onExit(({ exitCode }) => {
      if (this.entries.get(id) !== e) return
      // Let pending mirror writes flush so remote clients see all output before exit.
      term.write('', () => this.finish(e, exitCode))
    })
    return this.infoOf(e)
  }

  private finish(e: Entry, code: number): void {
    if (e.exited) return
    e.exited = true
    this.entries.delete(e.id)
    const clients = [...e.clients.keys()]
    const hadRemote = clients.some((c) => c.kind === 'remote')
    e.clients.clear()
    for (const c of clients) c.exit(code)
    if (hadRemote) this.emitRemoteCount(e.id, 0)
    e.term.dispose()
    for (const cb of this.exitListeners) cb(e.id, code)
  }

  /** Detaches everything and drops the session without notifying clients of an exit code (killed by the app). */
  remove(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    this.finish(e, 0)
  }

  private sendRemote(e: Entry, c: HubClient, data: string): void {
    if (!e.clients.has(c)) return
    if ((c.bufferedAmount?.() ?? 0) > MAX_BUFFERED_BYTES) {
      this.dropClient(e, c)
      c.close(CloseCode.TooSlow, 'client too slow')
      return
    }
    c.send(data)
  }

  private dropClient(e: Entry, c: HubClient): void {
    const st = e.clients.get(c)
    if (!st) return
    e.clients.delete(c)
    if (e.latest === c) e.latest = null
    if (c.kind === 'remote') this.emitRemoteCount(e.id, this.remoteCountOf(e))
  }

  attach(id: string, client: HubClient, mode: AttachMode): HubHandle | null {
    const e = this.entries.get(id)
    if (!e) return null
    const st: ClientState = { mode, size: null }
    // Snapshot and registration happen synchronously, after the data-callback ordering
    // guarantee above, so no output is lost or duplicated.
    if (client.kind === 'remote') {
      client.snapshot?.({ data: e.serialize.serialize(), cols: e.cols, rows: e.rows })
    }
    e.clients.set(client, st)
    if (client.kind === 'remote') this.emitRemoteCount(id, this.remoteCountOf(e))

    const own = (): boolean => e.clients.get(client) === st
    const applySize = (cols: number, rows: number): void => {
      if (e.exited) return
      if (cols === e.cols && rows === e.rows) return
      try {
        e.pty.resize(cols, rows)
      } catch {
        return // may fail while the process is exiting
      }
      e.cols = cols
      e.rows = rows
      e.term.resize(cols, rows)
      // Remote clients render at their own size; a fresh snapshot resets them to the new one.
      e.term.write('', () => {
        for (const [c] of [...e.clients]) {
          if (c !== client && c.kind === 'remote') {
            c.snapshot?.({ data: e.serialize.serialize(), cols: e.cols, rows: e.rows })
          }
        }
      })
    }
    const takeOwnership = (): void => {
      e.latest = client
      if (st.size) applySize(st.size.cols, st.size.rows)
    }

    return {
      write: (data) => {
        if (!own() || st.mode !== 'control' || e.exited) return
        if (e.latest !== client) takeOwnership()
        e.pty.write(data)
      },
      resize: (cols, rows) => {
        if (!own() || st.mode !== 'control') return
        st.size = { cols, rows }
        e.latest = client
        applySize(cols, rows)
      },
      focus: () => {
        if (!own() || st.mode !== 'control') return
        takeOwnership()
      },
      detach: () => {
        if (own()) this.dropClient(e, client)
      }
    }
  }

  setBusy(id: string, busy: boolean): void {
    const e = this.entries.get(id)
    if (!e || e.busy === busy) return
    e.busy = busy
    this.broadcastMeta(e, { busy })
  }

  private broadcastMeta(e: Entry, m: { title?: string; busy?: boolean }): void {
    for (const [c] of e.clients) if (c.kind === 'remote') c.meta?.(m)
  }

  info(id: string): HubInfo | null {
    const e = this.entries.get(id)
    return e ? this.infoOf(e) : null
  }

  private infoOf(e: Entry): HubInfo {
    return { id: e.id, running: !e.exited, busy: e.busy, cols: e.cols, rows: e.rows }
  }

  list(): HubInfo[] {
    return [...this.entries.values()].map((e) => this.infoOf(e))
  }

  private remoteCountOf(e: Entry): number {
    let n = 0
    for (const [c] of e.clients) if (c.kind === 'remote') n++
    return n
  }

  remoteCount(id: string): number {
    const e = this.entries.get(id)
    return e ? this.remoteCountOf(e) : 0
  }

  remoteCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.entries.values()) {
      const n = this.remoteCountOf(e)
      if (n > 0) out[e.id] = n
    }
    return out
  }

  /** Subscribe to per-session remote client count changes. */
  onRemoteCount(cb: (id: string, count: number) => void): () => void {
    this.remoteCountListeners.add(cb)
    return () => this.remoteCountListeners.delete(cb)
  }

  private emitRemoteCount(id: string, n: number): void {
    for (const cb of this.remoteCountListeners) cb(id, n)
  }

  /** Subscribe to PTY exits (after clients have been notified). */
  onExit(cb: (id: string, code: number) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  /** Closes every remote client (disable / sign out / revoke). */
  closeRemoteClients(code: number, reason: string): void {
    for (const e of this.entries.values()) {
      for (const [c] of [...e.clients]) {
        if (c.kind !== 'remote') continue
        this.dropClient(e, c)
        c.close(code, reason)
      }
    }
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) {
      e.exited = true
      e.term.dispose()
    }
    this.entries.clear()
  }
}
