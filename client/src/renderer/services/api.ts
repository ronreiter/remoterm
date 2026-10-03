export type ClaudeSession = {
  sessionId: string
  cwd: string
  updatedAt: string
  size: number
  summary: string
}

export type CodingTool = 'claude' | 'opencode' | 'gemini' | 'codex' | 'aider'

export type RemotermSettings = {
  codingTool: CodingTool
  loadZshrc: boolean
  theme?: string
  notifications?: boolean
  autoUpdate?: boolean
  // Per-terminal scrollback line limit. Lower values reduce memory/GC pressure
  // when many sessions stay open for a long time. Defaults to 10000.
  scrollback?: number
}

// Per-tool session config:
// - resumeArg: CLI flag to resume an existing session (e.g. `--resume <id>`).
// - sessionsDir: home-relative path where the tool persists session files;
//   the main process polls this after spawn to capture the new session ID
//   so we can resume on reload.
export const CODING_TOOLS: {
  id: CodingTool
  name: string
  command: string
  description: string
  resumeArg?: string
  sessionsDir?: string
}[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', description: 'Anthropic', resumeArg: '--resume' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', description: 'Open source' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', description: 'Google', resumeArg: '--resume', sessionsDir: '.gemini/sessions' },
  { id: 'codex', name: 'Codex', command: 'codex', description: 'OpenAI' },
  { id: 'aider', name: 'Aider', command: 'aider', description: 'Open source' },
]

export type RemoteTunnelStatus =
  | { state: 'stopped' }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; message: string }

export type RemoteStatus = {
  signedIn: boolean
  login?: string
  enabled: boolean
  busy: boolean
  deviceName: string
  deviceId?: string
  hostname?: string
  port?: number
  tunnel: RemoteTunnelStatus
  preventSleep: boolean
  error?: string
}

export type RemoteTabStatus = 'connecting' | 'live' | 'offline' | 'ended' | 'auth'

export type RemoteSessionInfo = {
  id: string
  name: string
  tool: string
  cwd: string
  folder: string | null
  color: string | null
  running: boolean
  busy: boolean
  cols: number
  rows: number
}

export type RemoteDevice = {
  id: string
  name: string
  online: boolean
  lastSeen: number | null
  sessions: RemoteSessionInfo[]
  error?: 'offline' | 'auth'
}

export type RemoteListResult =
  | { ok: true; devices: RemoteDevice[] }
  | { ok: false; error: 'signed_out' | 'network' | 'server' }

export type RemoteAttachMode = 'control' | 'view'

export type RemoteTabOutputEvent =
  | { tabId: string; kind: 'snapshot'; data: string; cols: number; rows: number }
  | { tabId: string; kind: 'data'; data: Uint8Array }

export type RemoteTabStatusEvent = {
  tabId: string
  status: RemoteTabStatus
  code?: number
  exitCode?: number
}

declare global {
  interface Window {
    electronAPI: {
      loadSessions: () => Promise<any>
      saveSessions: (data: string) => Promise<void>
      loadSettings: () => Promise<RemotermSettings | null>
      saveSettings: (data: string) => Promise<void>
      listClaudeSessions: () => Promise<ClaudeSession[]>
      pickFolder: () => Promise<string | null>
      openExternal: (url: string) => Promise<void>
      openPath: (filePath: string) => Promise<void>
      spawnLocalPty: (sessionId: string, command: string, workDir: string, loadZshrc?: boolean) => Promise<{ ok: boolean; reattached?: boolean; error?: string }>
      sendLocalPtyInput: (sessionId: string, data: string) => void
      resizeLocalPty: (sessionId: string, cols: number, rows: number) => void
      killLocalPty: (sessionId: string) => Promise<void>
      onLocalPtyOutput: (cb: (sessionId: string, data: string) => void) => () => void
      onLocalPtyExit: (cb: (sessionId: string, exitCode: number) => void) => () => void
      onToolSessionDetected: (cb: (sessionId: string, toolSessionId: string) => void) => () => void
      getGitBranch: (workDir: string) => Promise<string | null>
      createGitWorktree: (workDir: string) => Promise<{ ok: boolean; path?: string; branch?: string; error?: string }>
      readFile: (filePath: string) => Promise<{ ok: boolean; content?: string; isDirectory?: boolean; error?: string }>
      writeFile: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>
      getToolSessionSummary: (tool: string, toolSessionId: string) => Promise<string>
      showNotification: (title: string, body: string, sessionId?: string) => void
      onFocusSession: (cb: (sessionId: string) => void) => () => void
      sendFileDrop: (text: string) => void
      setActiveSessionMain: (sessionId: string) => void
      getPathForFile: (file: File) => string
      forceQuit: () => void
      onQuitConfirm: (cb: (show: boolean) => void) => () => void
      remoteGetStatus: () => Promise<RemoteStatus>
      onRemoteStatus: (cb: (status: RemoteStatus) => void) => () => void
      remoteSignIn: () => Promise<{ ok: boolean; error?: string }>
      remoteSignOut: () => Promise<void>
      remoteSetEnabled: (on: boolean) => Promise<void>
      remoteSetDeviceName: (name: string) => Promise<{ ok: boolean; error?: string }>
      remoteSetPreventSleep: (on: boolean) => Promise<void>
      remoteReset: () => Promise<void>
      remoteGetViewers: () => Promise<Record<string, number>>
      onRemoteViewers: (cb: (counts: Record<string, number>) => void) => () => void
      remoteList: () => Promise<RemoteListResult>
      remoteAttach: (req: { tabId: string; deviceId: string; sessionId: string; mode: RemoteAttachMode }) => Promise<void>
      remoteTabInput: (tabId: string, data: string) => void
      remoteTabResize: (tabId: string, cols: number, rows: number) => void
      remoteDetach: (tabId: string) => void
      onRemoteTabOutput: (cb: (e: RemoteTabOutputEvent) => void) => () => void
      onRemoteTabStatus: (cb: (e: RemoteTabStatusEvent) => void) => () => void
      reportSessionBusy: (sessionId: string, busy: boolean) => void
    }
  }
}
