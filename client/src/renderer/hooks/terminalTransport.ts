import type { RemoteAttachMode, RemoteTabOutputEvent, RemoteTabStatusEvent } from '../services/api'

/**
 * What `useTerminal` needs from "the thing behind the terminal": a local PTY
 * (IPC to the main process) or a session on another Mac (IPC to the main-side
 * remoteClient). Rendering, WebGL, search, themes and links stay shared.
 */
export interface TransportHandlers {
  /** First bytes (or snapshot) arrived: the terminal is showing real content. */
  onReady(): void
  /** Incremental output. Strings for local PTYs, bytes for remote sessions. */
  onData(data: string | Uint8Array): void
  /** Full screen state from a remote host. Every snapshot is a full reset. */
  onSnapshot(s: { data: string; cols: number; rows: number }): void
  /** Local PTY process exited. */
  onExit(code: number): void
  /** Remote connection state (connecting / live / offline / ended / auth). */
  onStatus(s: RemoteTabStatusEvent): void
  /** The transport could not start. */
  onError(message: string): void
}

export interface TerminalTransport {
  readonly kind: 'local' | 'remote'
  connect(h: TransportHandlers, size: { cols: number; rows: number }): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Re-establish the connection (remote tabs: after ended/sign-in/offline). */
  reconnect(): void
  /** Stop listening (the terminal went away). Does not end the underlying session. */
  dispose(): void
  /** The tab is going away for good: kill the local PTY / detach the remote session. */
  end(): void
}

// --- local ---

export interface LocalApi {
  onLocalPtyOutput(cb: (sessionId: string, data: string) => void): () => void
  onLocalPtyExit(cb: (sessionId: string, exitCode: number) => void): () => void
  sendLocalPtyInput(sessionId: string, data: string): void
  resizeLocalPty(sessionId: string, cols: number, rows: number): void
  killLocalPty(sessionId: string): Promise<void> | void
}

export interface SpawnResult {
  ok: boolean
  reattached?: boolean
  error?: string
}

export function createLocalTransport(
  sessionId: string,
  api: LocalApi,
  /** Builds the command and asks the main process to spawn (or reattach to) the PTY. */
  spawn: () => Promise<SpawnResult>
): TerminalTransport {
  let unsubs: (() => void)[] = []
  return {
    kind: 'local',
    connect(h, size) {
      let ready = false
      unsubs.push(
        api.onLocalPtyOutput((sid, data) => {
          if (sid !== sessionId) return
          if (!ready) {
            ready = true
            h.onReady()
          }
          h.onData(data)
        }),
        api.onLocalPtyExit((sid, code) => {
          if (sid === sessionId) h.onExit(code)
        })
      )
      void spawn().then((r) => {
        if (!r.ok) return h.onError(r.error ?? 'unknown error')
        api.resizeLocalPty(sessionId, size.cols, size.rows)
        if (r.reattached && !ready) {
          ready = true
          h.onReady()
        }
      })
    },
    write: (data) => api.sendLocalPtyInput(sessionId, data),
    resize: (cols, rows) => api.resizeLocalPty(sessionId, cols, rows),
    reconnect() {
      /* local PTYs are restarted through the store (restartSession) */
    },
    dispose() {
      for (const u of unsubs) u()
      unsubs = []
    },
    end() {
      void api.killLocalPty(sessionId)
    }
  }
}

// --- remote ---

export interface RemoteApi {
  remoteAttach(req: { tabId: string; deviceId: string; sessionId: string; mode: RemoteAttachMode }): Promise<void>
  remoteTabInput(tabId: string, data: string): void
  remoteTabResize(tabId: string, cols: number, rows: number): void
  remoteDetach(tabId: string): void
  onRemoteTabOutput(cb: (e: RemoteTabOutputEvent) => void): () => void
  onRemoteTabStatus(cb: (e: RemoteTabStatusEvent) => void): () => void
}

export function createRemoteTransport(
  tabId: string,
  target: { deviceId: string; sessionId: string },
  /** The tab's current mode (read live: the user can toggle it at any time). */
  getMode: () => RemoteAttachMode,
  api: RemoteApi
): TerminalTransport {
  let unsubs: (() => void)[] = []
  const attach = (): void => {
    void api.remoteAttach({ tabId, ...target, mode: getMode() })
  }
  return {
    kind: 'remote',
    connect(h) {
      let ready = false
      const markReady = (): void => {
        if (ready) return
        ready = true
        h.onReady()
      }
      unsubs.push(
        api.onRemoteTabOutput((e) => {
          if (e.tabId !== tabId) return
          markReady()
          if (e.kind === 'snapshot') h.onSnapshot({ data: e.data, cols: e.cols, rows: e.rows })
          else h.onData(e.data)
        }),
        api.onRemoteTabStatus((e) => {
          if (e.tabId === tabId) h.onStatus(e)
        })
      )
      attach()
    },
    // Input / resize are dropped in view mode (the host would drop them too).
    write(data) {
      if (getMode() === 'control') api.remoteTabInput(tabId, data)
    },
    resize(cols, rows) {
      if (getMode() === 'control') api.remoteTabResize(tabId, cols, rows)
    },
    reconnect: attach,
    dispose() {
      for (const u of unsubs) u()
      unsubs = []
    },
    end() {
      api.remoteDetach(tabId)
    }
  }
}
