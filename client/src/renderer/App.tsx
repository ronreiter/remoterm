import React, { useEffect, useRef, useCallback, useState } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import Terminal, { TerminalHandle } from './components/Terminal'
import Onboarding from './components/Onboarding'
import QuickSwitcher from './components/QuickSwitcher'
import CodeEditor from './components/CodeEditor'
import { getTheme, type ThemeId } from '@remoterm/themes'

export default function App() {
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeSession = useStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId))
  const openTabs = useStore((s) => s.openTabs)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const hydrated = useStore((s) => s.hydrated)
  const hydrate = useStore((s) => s.hydrate)
  const settings = useStore((s) => s.settings)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())
  const [updateInfo, setUpdateInfo] = useState<{ version: string; notes: string; dmgUrl: string } | null>(null)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const editorFilePath = useStore((s) => s.editorFilePath)
  const restartCounters = useStore((s) => s.restartCounters)
  const [quitProgress, setQuitProgress] = useState(0) // 0 = hidden, 1-100 = holding
  const clearTabActivity = useStore((s) => s.clearTabActivity)
  const setFontSize = useStore((s) => s.setFontSize)
  const fontSize = useStore((s) => s.fontSize)

  // Hydrate store from main process on mount
  useEffect(() => {
    hydrate()
  }, [hydrate])

  // Remote viewers (host agent): per-session count of attached remote clients
  useEffect(() => {
    const api = window.electronAPI
    api?.remoteGetViewers?.().then((c) => useStore.getState().setRemoteViewerCounts(c || {})).catch(() => {})
    const cleanup = api?.onRemoteViewers?.((c) => useStore.getState().setRemoteViewerCounts(c || {}))
    return () => { cleanup?.() }
  }, [])

  // Report busy transitions to the main process so remote clients get `meta {busy}`
  useEffect(() => {
    return useStore.subscribe((state, prev) => {
      if (state.busySessionIds === prev.busySessionIds) return
      const report = window.electronAPI?.reportSessionBusy
      if (!report) return
      for (const id of state.busySessionIds) if (!prev.busySessionIds.has(id)) report(id, true)
      for (const id of prev.busySessionIds) if (!state.busySessionIds.has(id)) report(id, false)
    })
  }, [])

  // Hold Cmd+Q to quit
  const quitIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const cancelQuit = () => {
      if (quitIntervalRef.current) {
        clearInterval(quitIntervalRef.current)
        quitIntervalRef.current = null
      }
      setQuitProgress(0)
    }
    const cleanup = window.electronAPI?.onQuitConfirm((show) => {
      if (show && !quitIntervalRef.current) {
        let progress = 0
        setQuitProgress(1)
        quitIntervalRef.current = setInterval(() => {
          progress += 4
          if (progress >= 100) {
            cancelQuit()
            window.electronAPI.forceQuit()
          } else {
            setQuitProgress(progress)
          }
        }, 50) // 50ms * 25 steps = 1.25s hold
        // Cancel on key up
        const onKeyUp = (e: KeyboardEvent) => {
          if (e.key === 'q' || e.key === 'Meta') {
            cancelQuit()
            window.removeEventListener('keyup', onKeyUp)
          }
        }
        window.addEventListener('keyup', onKeyUp)
      }
    })
    return () => { cleanup?.(); cancelQuit() }
  }, [])

  // Check for updates on mount
  useEffect(() => {
    fetch('https://api.github.com/repos/ronreiter/remoterm/releases/latest')
      .then((r) => r.json())
      .then((d) => {
        if (!d.tag_name) return
        const latest = d.tag_name.replace(/^v/, '')
        const current = __APP_VERSION__
        if (latest !== current) {
          const dmg = d.assets?.find((a: { name: string }) => a.name.endsWith('.dmg'))
          const dmgUrl = dmg?.browser_download_url || d.html_url
          const autoUpdate = useStore.getState().settings?.autoUpdate !== false
          if (autoUpdate && dmg?.browser_download_url) {
            // Auto-download and open the DMG
            window.electronAPI.openExternal(dmg.browser_download_url)
          } else {
            setUpdateInfo({ version: latest, notes: d.body || '', dmgUrl })
          }
        }
      })
      .catch(() => {})
  }, [])

  // Apply theme CSS variables
  useEffect(() => {
    const themeId = (settings?.theme || 'dark1') as ThemeId
    const theme = getTheme(themeId)
    const root = document.documentElement
    root.style.setProperty('--terminal-bg', theme.ui.bg)
    root.style.setProperty('--terminal-surface', theme.ui.surface)
    root.style.setProperty('--terminal-text', theme.ui.text)
    root.style.setProperty('--terminal-subtext', theme.ui.subtext)
    root.style.setProperty('--terminal-accent', theme.ui.accent)
    root.style.setProperty('--terminal-green', theme.ui.green)
    root.style.setProperty('--terminal-red', theme.ui.red)
    root.style.setProperty('--terminal-border', theme.ui.border)
  }, [settings?.theme])

  // Focus session when notification is clicked
  useEffect(() => {
    const cleanup = window.electronAPI?.onFocusSession((sessionId) => {
      useStore.getState().openTab(sessionId)
    })
    return () => { cleanup?.() }
  }, [])

  // Safety: if we have open tabs but no active session, pick the first
  useEffect(() => {
    if (!activeSessionId && openTabs.length > 0) {
      setActiveSession(openTabs[0])
    }
  }, [activeSessionId, openTabs, setActiveSession])

  // Focus terminal and clear activity when active tab changes
  useEffect(() => {
    if (activeSessionId) {
      clearTabActivity(activeSessionId)
      window.electronAPI?.setActiveSessionMain(activeSessionId)
      requestAnimationFrame(() => {
        terminalRefs.current.get(activeSessionId)?.focus()
      })
    }
  }, [activeSessionId, clearTabActivity])

  // Fetch git branch for active session — initial + every 10s
  useEffect(() => {
    setGitBranch(null)
    const dir = activeSession?.workDir
    if (!dir) return
    const fetchBranch = () =>
      window.electronAPI?.getGitBranch(dir).then((branch) => setGitBranch(branch))
    fetchBranch()
    const interval = setInterval(fetchBranch, 10000)
    return () => clearInterval(interval)
  }, [activeSession?.workDir])

  // Cmd+Left / Cmd+Right to switch tabs, Cmd+K for quick switcher, Cmd+/- for font size
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return

      if (e.key === 'k') {
        e.preventDefault()
        setShowSwitcher((v) => !v)
        return
      }

      if (e.key === 't') {
        e.preventDefault()
        // Sidebar owns the new-session UI state (worktree/auto-mode toggles +
        // folder picker). Dispatch an event for it to handle.
        window.dispatchEvent(new Event('remoterm:new-session'))
        return
      }

      if (e.key === 'w') {
        e.preventDefault()
        const active = useStore.getState().activeSessionId
        if (active) useStore.getState().closeTab(active)
        return
      }

      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setFontSize(useStore.getState().fontSize + 1)
        return
      }
      if (e.key === '-') {
        e.preventDefault()
        setFontSize(useStore.getState().fontSize - 1)
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        setFontSize(14)
        return
      }

      const tabs = useStore.getState().openTabs
      const active = useStore.getState().activeSessionId
      if (tabs.length < 2 || !active) return

      const idx = tabs.indexOf(active)
      if (idx === -1) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const prev = idx > 0 ? tabs[idx - 1] : tabs[tabs.length - 1]
        setActiveSession(prev)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const next = idx < tabs.length - 1 ? tabs[idx + 1] : tabs[0]
        setActiveSession(next)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActiveSession, setFontSize])

  const setTerminalRef = useCallback((tabId: string, handle: TerminalHandle | null) => {
    if (handle) {
      terminalRefs.current.set(tabId, handle)
    } else {
      terminalRefs.current.delete(tabId)
    }
  }, [])

  if (!hydrated || !settingsLoaded) {
    return (
      <div className="flex h-screen bg-terminal-bg items-center justify-center">
        <div className="w-5 h-5 border-2 border-terminal-accent/30 border-t-terminal-accent rounded-full animate-spin" />
      </div>
    )
  }

  if (!settings) {
    return <Onboarding />
  }

  return (
    <div className="flex h-screen bg-terminal-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar in the titlebar area */}
        <TabBar />

        {updateInfo && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setUpdateInfo(null)}>
            <div
              className="w-[480px] max-h-[80vh] bg-terminal-bg border border-terminal-border rounded-xl p-6 flex flex-col gap-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-terminal-text">Remoterm v{updateInfo.version} Available</h2>
                <button onClick={() => setUpdateInfo(null)} className="text-terminal-subtext hover:text-terminal-text text-lg leading-none">
                  ×
                </button>
              </div>
              {updateInfo.notes && (
                <div className="overflow-y-auto max-h-[40vh] text-sm text-terminal-subtext whitespace-pre-wrap leading-relaxed border border-terminal-border rounded-lg p-4 bg-terminal-surface">
                  {updateInfo.notes}
                </div>
              )}
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setUpdateInfo(null)}
                  className="px-4 py-2 text-sm text-terminal-subtext hover:text-terminal-text transition-colors"
                >
                  Later
                </button>
                <button
                  onClick={() => {
                    window.electronAPI.openExternal(updateInfo.dmgUrl)
                    setUpdateInfo(null)
                  }}
                  className="px-4 py-2 text-sm font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90 transition-opacity"
                >
                  Download &amp; Install
                </button>
              </div>
            </div>
          </div>
        )}

        {openTabs.length > 0 ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* CWD header with git branch */}
            {activeSession?.workDir && (
              <div className="flex-shrink-0 px-4 py-1.5 bg-terminal-surface border-b border-terminal-border flex items-center gap-3">
                <span className="text-xs text-terminal-subtext font-mono">
                  {(activeSession.displayDir || activeSession.workDir).replace(/^\/Users\/[^/]+/, '~')}
                </span>
                {gitBranch && (
                  <span className="text-xs text-terminal-accent font-mono">
                    {gitBranch}
                  </span>
                )}
              </div>
            )}

            {/* Terminals — one per tab, show/hide via CSS to keep PTYs alive */}
            <div className="flex-1 overflow-hidden flex min-h-0">
              <div className="flex-1 relative min-w-0">
                {openTabs.map((tabId) => (
                  <div
                    key={tabId}
                    className="absolute inset-0"
                    style={{ visibility: tabId === activeSessionId ? 'visible' : 'hidden' }}
                  >
                    <Terminal
                      key={`${tabId}:${restartCounters[tabId] ?? 0}`}
                      ref={(handle) => setTerminalRef(tabId, handle)}
                      sessionId={tabId}
                    />
                  </div>
                ))}
              </div>
              {editorFilePath && (
                <div className="w-[45%] min-w-[320px] flex-shrink-0">
                  <CodeEditor />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-terminal-subtext text-lg mb-2">No session selected</p>
              <p className="text-terminal-subtext/60 text-sm">
                Select a session from the sidebar or create a new one
              </p>
            </div>
          </div>
        )}
      </div>
      {showSwitcher && <QuickSwitcher onClose={() => setShowSwitcher(false)} />}
      {quitProgress > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 bg-terminal-surface border border-terminal-border rounded-lg shadow-2xl overflow-hidden">
          <span className="text-sm text-terminal-text relative z-10">Hold <kbd className="font-mono font-bold text-terminal-accent">Cmd+Q</kbd> to quit...</span>
          <div
            className="absolute inset-0 bg-terminal-accent/20 transition-none"
            style={{ width: `${quitProgress}%` }}
          />
        </div>
      )}
    </div>
  )
}
