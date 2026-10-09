import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import { useTerminal } from '../hooks/useTerminal'
import { useStore } from '../store'
import { remoteStatusLabel } from '../services/remoteFormat'
import '@xterm/xterm/css/xterm.css'

export interface TerminalHandle {
  focus: () => void
}

interface Props {
  sessionId: string
}

const TerminalComponent = forwardRef<TerminalHandle, Props>(({ sessionId }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const initializedRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showScrollDown, setShowScrollDown] = useState(false)
  const isBusy = useStore((s) => s.busySessionIds.has(sessionId))
  const loaded = useStore((s) => s.loadedSessionIds.has(sessionId))
  const { initTerminal, terminalRef, searchAddonRef } = useTerminal(sessionId)
  const remote = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.remote)
  const rt = useStore((s) => s.remoteTabs[sessionId])
  const closeTab = useStore((s) => s.closeTab)
  const restartSession = useStore((s) => s.restartSession)

  useImperativeHandle(ref, () => ({
    focus: () => {
      terminalRef.current?.scrollToBottom()
      terminalRef.current?.focus()
    }
  }))

  useEffect(() => {
    if (containerRef.current && !initializedRef.current) {
      initializedRef.current = true
      // initTerminal calls markSessionLoaded itself when the first PTY output arrives
      const cleanup = initTerminal(containerRef.current)
      cleanupRef.current = cleanup || null

      // Track scroll position
      const term = terminalRef.current
      if (term) {
        const onScroll = term.onScroll(() => {
          const buf = term.buffer.active
          setShowScrollDown(buf.baseY > 0 && buf.viewportY < buf.baseY - 5)
        })
        const prevCleanup = cleanupRef.current
        cleanupRef.current = () => {
          onScroll.dispose()
          prevCleanup?.()
        }
      }
    }

    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
      initializedRef.current = false
    }
  }, [sessionId, initTerminal])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    searchAddonRef.current?.clearDecorations()
    terminalRef.current?.focus()
  }, [searchAddonRef, terminalRef])

  const findNext = useCallback(() => {
    if (searchQuery) searchAddonRef.current?.findNext(searchQuery)
  }, [searchQuery, searchAddonRef])

  const findPrevious = useCallback(() => {
    if (searchQuery) searchAddonRef.current?.findPrevious(searchQuery)
  }, [searchQuery, searchAddonRef])

  // Cmd/Ctrl+F to open search — listen on window since xterm captures keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        // Only handle if this terminal's container is visible
        const el = containerRef.current?.closest('.absolute.inset-0') as HTMLElement | null
        if (el && el.style.visibility !== 'hidden') {
          e.preventDefault()
          if (searchOpen) {
            searchInputRef.current?.focus()
            searchInputRef.current?.select()
          } else {
            openSearch()
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [searchOpen, openSearch])

  // Search as you type
  useEffect(() => {
    if (searchOpen && searchQuery) {
      searchAddonRef.current?.findNext(searchQuery)
    } else if (!searchQuery) {
      searchAddonRef.current?.clearDecorations()
    }
  }, [searchQuery, searchOpen, searchAddonRef])

  return (
    <div className="w-full h-full relative" style={{ padding: '4px' }}>
      {isBusy && loaded && (
        <div className="absolute top-0 left-0 right-0 h-[2px] z-10 overflow-hidden">
          <div className="h-full bg-terminal-accent animate-progress" />
        </div>
      )}
      {!loaded && !remote && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-terminal-bg">
          <div className="flex flex-col items-center gap-3">
            <div className="w-5 h-5 border-2 border-terminal-accent/30 border-t-terminal-accent rounded-full animate-spin" />
            <span className="text-xs text-terminal-subtext">Starting session...</span>
          </div>
        </div>
      )}
      {remote && (rt?.status === 'ended' || rt?.status === 'auth') && (
        <div data-testid="remote-overlay" className="absolute inset-0 flex items-center justify-center z-10 bg-terminal-bg/80">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="text-sm text-terminal-text">{remoteStatusLabel(rt.status, rt.code, rt.exitCode)}</span>
            <span className="text-xs text-terminal-subtext">
              {rt.status === 'auth' ? 'Sign in again to reconnect to ' : 'The session is no longer running on '}
              {remote.deviceName}.
            </span>
            <div className="flex gap-2">
              {rt.status === 'auth' && (
                <button
                  onClick={() => window.electronAPI.remoteSignIn()}
                  className="px-3 py-1.5 text-xs font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90"
                >
                  Sign in
                </button>
              )}
              {rt.status === 'auth' && (
                <button
                  onClick={() => restartSession(sessionId)}
                  className="px-3 py-1.5 text-xs text-terminal-subtext border border-terminal-border rounded-lg hover:text-terminal-text"
                >
                  Retry
                </button>
              )}
              {rt.status === 'ended' && (
                <button
                  onClick={() => closeTab(sessionId)}
                  className="px-3 py-1.5 text-xs font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90"
                >
                  Close tab
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {remote && (rt?.status === 'connecting' || rt?.status === 'offline' || !rt) && (
        <div
          data-testid="remote-connecting"
          className={`absolute z-10 flex items-center justify-center ${
            loaded ? 'top-1 left-1/2 -translate-x-1/2 px-3 py-1 rounded-lg bg-terminal-surface border border-terminal-border shadow-lg' : 'inset-0 bg-terminal-bg'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-terminal-accent/30 border-t-terminal-accent rounded-full animate-spin" />
            <span className="text-xs text-terminal-subtext">
              {rt?.status === 'offline' ? `${remote.deviceName} is offline — reconnecting…` : `Connecting to ${remote.deviceName}…`}
            </span>
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="absolute top-1 right-4 z-20 flex items-center gap-1 bg-terminal-surface border border-terminal-border rounded-lg px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.shiftKey ? findPrevious() : findNext()
              }
              if (e.key === 'Escape') {
                closeSearch()
              }
            }}
            placeholder="Search..."
            className="bg-terminal-bg text-terminal-text text-xs px-2 py-1 rounded outline-none border border-terminal-border focus:border-terminal-accent w-48"
          />
          <button
            onClick={findPrevious}
            className="text-terminal-subtext hover:text-terminal-text text-xs px-1"
            title="Previous (Shift+Enter)"
          >
            &#x25B2;
          </button>
          <button
            onClick={findNext}
            className="text-terminal-subtext hover:text-terminal-text text-xs px-1"
            title="Next (Enter)"
          >
            &#x25BC;
          </button>
          <button
            onClick={closeSearch}
            className="text-terminal-subtext hover:text-terminal-red text-xs px-1"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      )}
      {showScrollDown && (
        <button
          onClick={() => {
            terminalRef.current?.scrollToBottom()
            setShowScrollDown(false)
          }}
          className="absolute bottom-4 right-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-terminal-surface border border-terminal-border text-terminal-subtext hover:text-terminal-text hover:bg-terminal-border transition-colors shadow-lg"
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
})

TerminalComponent.displayName = 'Terminal'
export default TerminalComponent
