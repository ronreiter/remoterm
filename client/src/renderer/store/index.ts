import { create } from 'zustand'
import type { RemoteAttachMode, RemoteTabStatus, RemotermSettings } from '../services/api'

export type ColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink'

export const COLOR_LABELS: ColorLabel[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

export const COLOR_HEX: Record<ColorLabel, string> = {
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#4ade80',
  blue: '#60a5fa',
  purple: '#c084fc',
  pink: '#f472b6'
}

export interface Session {
  id: string
  name: string
  status: 'open' | 'closed'
  workDir?: string
  displayDir?: string
  toolSessionId?: string
  skipPermissions?: boolean
  // When true, the tool launches with its native worktree flag (for Claude:
  // `--worktree`). The tool creates and manages the worktree itself.
  useWorktree?: boolean
  // True when the user manually renamed this session. Auto-rename from
  // terminal title-change events should not override a user-set name.
  nameIsUserSet?: boolean
  createdAt: string
  colorLabel?: ColorLabel
  folderId?: string
  // 'remote' tabs are views of a session running on another Mac. They have no
  // local PTY, are never served by the local agent, and are persisted only so
  // they can be re-attached on restart (dropped quietly if the session is gone).
  kind?: 'local' | 'remote'
  remote?: { deviceId: string; sessionId: string; deviceName: string }
}

export const isRemoteSession = (s: { kind?: string } | undefined | null): boolean => s?.kind === 'remote'

export interface RemoteTabState {
  status: RemoteTabStatus
  code?: number
  exitCode?: number
  mode: RemoteAttachMode
  // Reached 'live' at least once in this app run.
  everLive: boolean
}

export interface Folder {
  id: string
  name: string
  expanded: boolean
}

type SessionData = {
  sessions: Session[]
  openTabs: string[]
  activeSessionId: string | null
  folders?: Folder[]
}

function migrateData(data: SessionData): SessionData {
  // Migrate old status values and reopen sessions that had tabs open
  const openTabSet = new Set(data.openTabs || [])
  // Remote tabs only survive a restart as "reattach if still running" entries:
  // drop the ones whose tab was closed.
  data.sessions = (data.sessions || []).filter((s: Session) => s.kind !== 'remote' || openTabSet.has(s.id))
  data.sessions = data.sessions.map((s: Session & { status: string; claudeSessionId?: string }) => {
    // Migrate claudeSessionId → toolSessionId
    const toolSessionId = s.toolSessionId || s.claudeSessionId
    const { claudeSessionId: _, ...rest } = s as any
    return {
      ...rest,
      toolSessionId,
      status: openTabSet.has(s.id) ? ('open' as const) : ('closed' as const),
      // Lock the saved name on every restored session. Sessions saved before
      // v1.30 didn't carry `nameIsUserSet`, so a later OSC title from the
      // running tool (e.g. Claude Code's "✳ <activity>") would silently
      // overwrite manually-renamed tabs via autoRenameSession. Treat anything
      // that survived a save as deliberate; the OSC title sync still works
      // for newly-created sessions in the current run.
      nameIsUserSet: true
    }
  })
  data.folders = data.folders || []
  return data
}

function saveSessions(
  sessions: Session[],
  openTabs: string[],
  activeSessionId: string | null,
  folders: Folder[]
): void {
  if (window.electronAPI?.saveSessions) {
    window.electronAPI.saveSessions(JSON.stringify({ sessions, openTabs, activeSessionId, folders }))
  }
}

interface AppState {
  sessions: Session[]
  folders: Folder[]
  activeSessionId: string | null
  openTabs: string[]
  loadedSessionIds: Set<string>
  activeTabIds: Set<string>
  busySessionIds: Set<string>
  // sessionId -> number of remote clients currently attached (host agent)
  remoteViewerCounts: Record<string, number>
  // Remote tabs: connection state + view/control mode (not persisted)
  remoteTabs: Record<string, RemoteTabState>
  // Remote tabs restored from disk that have not been confirmed live yet
  restoredRemoteIds: Set<string>
  lastFinishedAt: Record<string, number>
  restartCounters: Record<string, number>
  editorFilePath: string | null
  editorLine: number | null
  hydrated: boolean
  settings: RemotermSettings | null
  settingsLoaded: boolean
  fontSize: number

  hydrate: () => Promise<void>
  setSessions: (sessions: Session[]) => void
  addSession: (session: Session) => void
  removeSession: (id: string) => void
  renameSession: (id: string, name: string) => void
  // Auto-rename triggered by the terminal's title-change event. Only takes
  // effect if the session name was not user-set; never sets the user-set flag.
  autoRenameSession: (id: string, name: string) => void
  setActiveSession: (id: string | null) => void
  openTab: (id: string) => void
  closeTab: (id: string) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
  markSessionLoaded: (id: string) => void
  markSessionUnloaded: (id: string) => void
  markSessionClosed: (id: string) => void
  setToolSessionId: (id: string, toolSessionId: string) => void
  markTabActivity: (id: string) => void
  clearTabActivity: (id: string) => void
  markSessionBusy: (id: string) => void
  markSessionIdle: (id: string) => void
  markSessionFinished: (id: string) => void
  reopenSession: (id: string) => void
  restartSession: (id: string) => void
  cloneSession: (id: string) => string | null
  setSessionColor: (id: string, color: ColorLabel | undefined) => void
  setEditorFile: (filePath: string | null, line?: number | null) => void
  addFolder: (name: string) => string
  removeFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void
  toggleFolder: (id: string) => void
  setSessionFolder: (sessionId: string, folderId: string | undefined) => void
  setSettings: (settings: RemotermSettings) => void
  setFontSize: (size: number) => void
  setRemoteViewerCounts: (counts: Record<string, number>) => void
  openRemoteTab: (target: { deviceId: string; sessionId: string; deviceName: string; name: string }) => string
  setRemoteMode: (id: string, mode: RemoteAttachMode) => void
  applyRemoteStatus: (id: string, e: { status: RemoteTabStatus; code?: number; exitCode?: number }) => void
}

function dropRemoteTab(state: AppState, id: string): Partial<AppState> {
  const openTabs = state.openTabs.filter((t) => t !== id)
  let activeSessionId = state.activeSessionId
  if (activeSessionId === id) {
    const idx = state.openTabs.indexOf(id)
    activeSessionId = openTabs.length > 0 ? openTabs[Math.min(idx, openTabs.length - 1)] : null
  }
  const { [id]: _gone, ...remoteTabs } = state.remoteTabs
  const restored = new Set(state.restoredRemoteIds)
  restored.delete(id)
  return {
    sessions: state.sessions.filter((s) => s.id !== id),
    openTabs,
    activeSessionId,
    remoteTabs,
    restoredRemoteIds: restored
  }
}

export const useStore = create<AppState>((set) => ({
  sessions: [],
  folders: [],
  activeSessionId: null,
  openTabs: [],
  loadedSessionIds: new Set<string>(),
  activeTabIds: new Set<string>(),
  busySessionIds: new Set<string>(),
  remoteViewerCounts: {},
  remoteTabs: {},
  restoredRemoteIds: new Set<string>(),
  lastFinishedAt: {},
  restartCounters: {},
  editorFilePath: null,
  editorLine: null,
  hydrated: false,
  settings: null,
  settingsLoaded: false,
  fontSize: 14,

  hydrate: async () => {
    try {
      const [data, settings] = await Promise.all([
        window.electronAPI.loadSessions(),
        window.electronAPI.loadSettings()
      ])
      if (data) {
        const migrated = migrateData(data)
        set({
          restoredRemoteIds: new Set(migrated.sessions.filter((s) => s.kind === 'remote').map((s) => s.id)),
          sessions: migrated.sessions,
          folders: migrated.folders || [],
          openTabs: migrated.openTabs || [],
          activeSessionId: migrated.activeSessionId || null,
          hydrated: true,
          settings,
          settingsLoaded: true
        })
        return
      }
      set({ hydrated: true, settings, settingsLoaded: true })
      return
    } catch {
      // electronAPI not available (e.g. in browser tests)
    }
    set({ hydrated: true, settingsLoaded: true })
  },

  setSessions: (sessions) => set({ sessions }),

  addSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions],
      openTabs: [...state.openTabs, session.id],
      activeSessionId: session.id
    })),

  removeSession: (id) =>
    set((state) => {
      if (isRemoteSession(state.sessions.find((s) => s.id === id))) return dropRemoteTab(state, id)
      const openTabs = state.openTabs.filter((t) => t !== id)
      let activeSessionId = state.activeSessionId
      if (activeSessionId === id) {
        activeSessionId = openTabs.length > 0 ? openTabs[openTabs.length - 1] : null
      }
      if (!activeSessionId && openTabs.length > 0) {
        activeSessionId = openTabs[0]
      }
      // Kill PTY immediately
      window.electronAPI?.killLocalPty(id)
      return {
        sessions: state.sessions.filter((s) => s.id !== id),
        openTabs,
        activeSessionId
      }
    }),

  renameSession: (id, name) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, name, nameIsUserSet: true } : s
      )
    })),

  autoRenameSession: (id, name) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id && !s.nameIsUserSet ? { ...s, name } : s
      )
    })),

  setActiveSession: (id) =>
    set((state) => ({
      activeSessionId: id,
      openTabs: id && !state.openTabs.includes(id) ? [...state.openTabs, id] : state.openTabs
    })),

  openTab: (id) =>
    set((state) => ({
      activeSessionId: id,
      openTabs: state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id]
    })),

  closeTab: (id) =>
    set((state) => {
      // Closing a remote tab forgets it; the session keeps running on its host.
      if (isRemoteSession(state.sessions.find((s) => s.id === id))) return dropRemoteTab(state, id)
      const openTabs = state.openTabs.filter((t) => t !== id)
      let activeSessionId = state.activeSessionId
      if (activeSessionId === id) {
        const idx = state.openTabs.indexOf(id)
        activeSessionId =
          openTabs.length > 0 ? openTabs[Math.min(idx, openTabs.length - 1)] : null
      }
      // Safety: if we still have tabs but no active one, pick the first
      if (!activeSessionId && openTabs.length > 0) {
        activeSessionId = openTabs[0]
      }
      // Kill PTY immediately instead of waiting for component unmount
      window.electronAPI?.killLocalPty(id)
      return {
        openTabs,
        activeSessionId,
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, status: 'closed' as const } : s))
      }
    }),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const tabs = [...state.openTabs]
      const [moved] = tabs.splice(fromIndex, 1)
      tabs.splice(toIndex, 0, moved)
      return { openTabs: tabs }
    }),

  markSessionLoaded: (id) =>
    set((state) => {
      const next = new Set(state.loadedSessionIds)
      next.add(id)
      return { loadedSessionIds: next }
    }),

  markSessionUnloaded: (id) =>
    set((state) => {
      const next = new Set(state.loadedSessionIds)
      next.delete(id)
      return { loadedSessionIds: next }
    }),

  markSessionClosed: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, status: 'closed' as const } : s))
    })),

  setToolSessionId: (id, toolSessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, toolSessionId } : s))
    })),

  markTabActivity: (id) =>
    set((state) => {
      if (state.activeSessionId === id) return state
      const next = new Set(state.activeTabIds)
      next.add(id)
      return { activeTabIds: next }
    }),

  clearTabActivity: (id) =>
    set((state) => {
      if (!state.activeTabIds.has(id)) return state
      const next = new Set(state.activeTabIds)
      next.delete(id)
      return { activeTabIds: next }
    }),

  setRemoteViewerCounts: (counts) => set({ remoteViewerCounts: counts }),

  openRemoteTab: ({ deviceId, sessionId, deviceName, name }) => {
    let id = ''
    set((state) => {
      const existing = state.sessions.find(
        (s) => s.kind === 'remote' && s.remote?.deviceId === deviceId && s.remote.sessionId === sessionId
      )
      if (existing) {
        id = existing.id
        return {
          activeSessionId: id,
          openTabs: state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id]
        }
      }
      id = crypto.randomUUID()
      const session: Session = {
        id,
        name,
        status: 'open',
        kind: 'remote',
        remote: { deviceId, sessionId, deviceName },
        nameIsUserSet: true,
        createdAt: new Date().toISOString()
      }
      return {
        sessions: [session, ...state.sessions],
        openTabs: [...state.openTabs, id],
        activeSessionId: id
      }
    })
    return id
  },

  setRemoteMode: (id, mode) =>
    set((state) => {
      const cur = state.remoteTabs[id]
      if (cur?.mode === mode) return state
      return {
        remoteTabs: {
          ...state.remoteTabs,
          [id]: { ...(cur ?? { status: 'connecting' as const, everLive: false }), mode }
        }
      }
    }),

  applyRemoteStatus: (id, e) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!isRemoteSession(session)) return state
      const cur = state.remoteTabs[id]
      // A tab restored from a previous run whose session is gone is dropped quietly.
      if (e.status === 'ended' && e.code === 4404 && !cur?.everLive && state.restoredRemoteIds.has(id)) {
        return dropRemoteTab(state, id)
      }
      const restored = new Set(state.restoredRemoteIds)
      if (e.status === 'live') restored.delete(id)
      return {
        restoredRemoteIds: restored,
        remoteTabs: {
          ...state.remoteTabs,
          [id]: {
            ...cur,
            mode: cur?.mode ?? 'control',
            status: e.status,
            code: e.code,
            exitCode: e.exitCode,
            everLive: !!cur?.everLive || e.status === 'live'
          }
        }
      }
    }),

  markSessionBusy: (id) =>
    set((state) => {
      if (state.busySessionIds.has(id)) return state
      const next = new Set(state.busySessionIds)
      next.add(id)
      return { busySessionIds: next }
    }),

  markSessionIdle: (id) =>
    set((state) => {
      if (!state.busySessionIds.has(id)) return state
      const next = new Set(state.busySessionIds)
      next.delete(id)
      return { busySessionIds: next }
    }),

  markSessionFinished: (id) =>
    set((state) => ({
      lastFinishedAt: { ...state.lastFinishedAt, [id]: Date.now() }
    })),

  restartSession: (id) =>
    set((state) => {
      // Kill the PTY; the new mount (after key change) will re-spawn it.
      // Remote tabs just remount (the old mount detaches, the new one re-attaches).
      if (!isRemoteSession(state.sessions.find((s) => s.id === id))) window.electronAPI?.killLocalPty(id)
      const loaded = new Set(state.loadedSessionIds)
      loaded.delete(id)
      const busy = new Set(state.busySessionIds)
      busy.delete(id)
      const activity = new Set(state.activeTabIds)
      activity.delete(id)
      return {
        loadedSessionIds: loaded,
        busySessionIds: busy,
        activeTabIds: activity,
        restartCounters: {
          ...state.restartCounters,
          [id]: (state.restartCounters[id] ?? 0) + 1
        }
      }
    }),

  reopenSession: (id) =>
    set((state) => {
      const old = state.sessions.find((s) => s.id === id)
      if (!old) return state
      const newId = crypto.randomUUID()
      // Spread the old session so we carry every field (folderId, colorLabel,
      // nameIsUserSet, displayDir, skipPermissions, useWorktree, …). The old
      // implementation listed fields one-by-one and silently dropped folder
      // assignment and the user-set-name flag on every reopen.
      const newSession: Session = {
        ...old,
        id: newId,
        status: 'open',
        createdAt: new Date().toISOString()
      }
      return {
        sessions: [newSession, ...state.sessions.filter((s) => s.id !== id)],
        openTabs: [...state.openTabs, newId],
        activeSessionId: newId
      }
    }),

  cloneSession: (id) => {
    let newId: string | null = null
    set((state) => {
      const old = state.sessions.find((s) => s.id === id)
      if (!old) return state
      newId = crypto.randomUUID()
      const cloned: Session = {
        id: newId,
        name: `${old.name} (copy)`,
        status: 'open',
        workDir: old.workDir,
        displayDir: old.displayDir,
        // Don't carry the toolSessionId — cloning starts a fresh tool session
        // in the same directory; otherwise both clone and original would
        // resume the same conversation.
        toolSessionId: undefined,
        skipPermissions: old.skipPermissions,
        colorLabel: old.colorLabel,
        folderId: old.folderId,
        createdAt: new Date().toISOString()
      }
      return {
        sessions: [cloned, ...state.sessions],
        openTabs: [...state.openTabs, newId],
        activeSessionId: newId
      }
    })
    return newId
  },

  setSessionColor: (id, color) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, colorLabel: color } : s
      )
    })),

  setEditorFile: (filePath, line) =>
    set({ editorFilePath: filePath, editorLine: line ?? null }),

  addFolder: (name) => {
    const id = crypto.randomUUID()
    set((state) => ({
      folders: [...state.folders, { id, name, expanded: true }]
    }))
    return id
  },

  removeFolder: (id) =>
    set((state) => ({
      folders: state.folders.filter((f) => f.id !== id),
      sessions: state.sessions.map((s) => (s.folderId === id ? { ...s, folderId: undefined } : s))
    })),

  renameFolder: (id, name) =>
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f))
    })),

  toggleFolder: (id) =>
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, expanded: !f.expanded } : f))
    })),

  setSessionFolder: (sessionId, folderId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, folderId } : s
      )
    })),

  setSettings: (settings) => {
    set({ settings })
    window.electronAPI?.saveSettings(JSON.stringify(settings))
  },

  setFontSize: (size) => set({ fontSize: Math.max(8, Math.min(24, size)) })
}))

// Save to main process on every state change (skip until hydrated)
useStore.subscribe((state) => {
  if (state.hydrated) {
    saveSessions(state.sessions, state.openTabs, state.activeSessionId, state.folders)
  }
})
