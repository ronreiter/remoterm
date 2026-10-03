import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc-channels'

contextBridge.exposeInMainWorld('electronAPI', {
  loadSessions: () => ipcRenderer.invoke(IPC.LOAD_SESSIONS),
  saveSessions: (data: string) => ipcRenderer.invoke(IPC.SAVE_SESSIONS, data),
  loadSettings: () => ipcRenderer.invoke(IPC.LOAD_SETTINGS),
  saveSettings: (data: string) => ipcRenderer.invoke(IPC.SAVE_SETTINGS, data),
  listClaudeSessions: () =>
    ipcRenderer.invoke(IPC.LIST_CLAUDE_SESSIONS) as Promise<
      { sessionId: string; cwd: string; updatedAt: string; size: number; summary: string }[]
    >,
  pickFolder: () => ipcRenderer.invoke(IPC.PICK_FOLDER) as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  openPath: (filePath: string) => ipcRenderer.invoke(IPC.OPEN_PATH, filePath),
  spawnLocalPty: (sessionId: string, command: string, workDir: string, loadZshrc?: boolean) =>
    ipcRenderer.invoke(IPC.LOCAL_PTY_SPAWN, sessionId, command, workDir, loadZshrc) as Promise<{ ok: boolean; error?: string }>,
  sendLocalPtyInput: (sessionId: string, data: string) =>
    ipcRenderer.send(IPC.LOCAL_PTY_INPUT, sessionId, data),
  resizeLocalPty: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC.LOCAL_PTY_RESIZE, sessionId, cols, rows),
  killLocalPty: (sessionId: string) =>
    ipcRenderer.invoke(IPC.LOCAL_PTY_KILL, sessionId),
  onLocalPtyOutput: (cb: (sessionId: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => cb(sessionId, data)
    ipcRenderer.on(IPC.LOCAL_PTY_OUTPUT, listener)
    return () => ipcRenderer.removeListener(IPC.LOCAL_PTY_OUTPUT, listener)
  },
  onLocalPtyExit: (cb: (sessionId: string, exitCode: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number) => cb(sessionId, exitCode)
    ipcRenderer.on(IPC.LOCAL_PTY_EXIT, listener)
    return () => ipcRenderer.removeListener(IPC.LOCAL_PTY_EXIT, listener)
  },
  onClaudeSessionDetected: (cb: (sessionId: string, claudeSessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, claudeSessionId: string) => cb(sessionId, claudeSessionId)
    ipcRenderer.on(IPC.CLAUDE_SESSION_DETECTED, listener)
    return () => ipcRenderer.removeListener(IPC.CLAUDE_SESSION_DETECTED, listener)
  },
  onToolSessionDetected: (cb: (sessionId: string, toolSessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, toolSessionId: string) => cb(sessionId, toolSessionId)
    ipcRenderer.on(IPC.TOOL_SESSION_DETECTED, listener)
    return () => ipcRenderer.removeListener(IPC.TOOL_SESSION_DETECTED, listener)
  },
  getGitBranch: (workDir: string) => ipcRenderer.invoke(IPC.GET_GIT_BRANCH, workDir) as Promise<string | null>,
  createGitWorktree: (workDir: string) => ipcRenderer.invoke(IPC.CREATE_GIT_WORKTREE, workDir) as Promise<{ ok: boolean; path?: string; branch?: string; error?: string }>,
  readFile: (filePath: string) => ipcRenderer.invoke(IPC.READ_FILE, filePath) as Promise<{ ok: boolean; content?: string; isDirectory?: boolean; error?: string }>,
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke(IPC.WRITE_FILE, filePath, content) as Promise<{ ok: boolean; error?: string }>,
  getToolSessionSummary: (tool: string, toolSessionId: string) =>
    ipcRenderer.invoke(IPC.GET_TOOL_SESSION_SUMMARY, tool, toolSessionId) as Promise<string>,
  showNotification: (title: string, body: string, sessionId?: string) => ipcRenderer.send(IPC.SHOW_NOTIFICATION, title, body, sessionId),
  onFocusSession: (cb: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => cb(sessionId)
    ipcRenderer.on('focus-session', listener)
    return () => ipcRenderer.removeListener('focus-session', listener)
  },
  sendFileDrop: (text: string) => ipcRenderer.send(IPC.FILE_DROP, text),
  setActiveSessionMain: (sessionId: string) => ipcRenderer.send(IPC.SET_ACTIVE_SESSION, sessionId),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  forceQuit: () => ipcRenderer.send(IPC.FORCE_QUIT),
  onQuitConfirm: (cb: (show: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, show: boolean) => cb(show)
    ipcRenderer.on('quit-confirm', listener)
    return () => ipcRenderer.removeListener('quit-confirm', listener)
  },

  // Remote access (host agent)
  remoteGetStatus: () => ipcRenderer.invoke(IPC.REMOTE_GET_STATUS),
  onRemoteStatus: (cb: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => cb(status)
    ipcRenderer.on(IPC.REMOTE_STATUS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.REMOTE_STATUS_CHANGED, listener)
  },
  remoteSignIn: () => ipcRenderer.invoke(IPC.REMOTE_SIGN_IN),
  remoteSignOut: () => ipcRenderer.invoke(IPC.REMOTE_SIGN_OUT),
  remoteSetEnabled: (on: boolean) => ipcRenderer.invoke(IPC.REMOTE_SET_ENABLED, on),
  remoteSetDeviceName: (name: string) => ipcRenderer.invoke(IPC.REMOTE_SET_DEVICE_NAME, name),
  remoteSetPreventSleep: (on: boolean) => ipcRenderer.invoke(IPC.REMOTE_SET_PREVENT_SLEEP, on),
  remoteReset: () => ipcRenderer.invoke(IPC.REMOTE_RESET),
  remoteGetViewers: () => ipcRenderer.invoke(IPC.REMOTE_GET_VIEWERS),
  onRemoteViewers: (cb: (counts: Record<string, number>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, counts: Record<string, number>) => cb(counts)
    ipcRenderer.on(IPC.REMOTE_VIEWERS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.REMOTE_VIEWERS_CHANGED, listener)
  },
  // Remote client (tabs on other devices); tokens stay in the main process.
  remoteList: () => ipcRenderer.invoke(IPC.REMOTE_LIST),
  remoteAttach: (req: { tabId: string; deviceId: string; sessionId: string; mode: 'control' | 'view' }) =>
    ipcRenderer.invoke(IPC.REMOTE_ATTACH, req),
  remoteTabInput: (tabId: string, data: string) => ipcRenderer.send(IPC.REMOTE_INPUT, tabId, data),
  remoteTabResize: (tabId: string, cols: number, rows: number) => ipcRenderer.send(IPC.REMOTE_RESIZE, tabId, cols, rows),
  remoteDetach: (tabId: string) => ipcRenderer.send(IPC.REMOTE_DETACH, tabId),
  onRemoteTabOutput: (cb: (e: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, e: unknown) => cb(e)
    ipcRenderer.on(IPC.REMOTE_TAB_OUTPUT, listener)
    return () => ipcRenderer.removeListener(IPC.REMOTE_TAB_OUTPUT, listener)
  },
  onRemoteTabStatus: (cb: (e: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, e: unknown) => cb(e)
    ipcRenderer.on(IPC.REMOTE_TAB_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC.REMOTE_TAB_STATUS, listener)
  },
  reportSessionBusy: (sessionId: string, busy: boolean) => ipcRenderer.send(IPC.SESSION_BUSY_CHANGED, sessionId, busy)
})
