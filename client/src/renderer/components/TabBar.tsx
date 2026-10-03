import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useStore, COLOR_HEX } from '../store'
import RemoteViewerDot from './RemoteViewerDot'
import iconUrl from '../../../resources/icon.png?url'

export default function TabBar() {
  const openTabs = useStore((s) => s.openTabs)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const activeTabIds = useStore((s) => s.activeTabIds)
  const openTab = useStore((s) => s.openTab)
  const closeTab = useStore((s) => s.closeTab)
  const reorderTabs = useStore((s) => s.reorderTabs)
  const dragIndex = useRef<number | null>(null)
  const dragOverIndex = useRef<number | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const tabElRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [showAbout, setShowAbout] = useState(false)

  // Auto-scroll active tab into view
  useEffect(() => {
    if (activeSessionId) {
      const el = tabElRefs.current.get(activeSessionId)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [activeSessionId])

  const setTabElRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) tabElRefs.current.set(tabId, el)
    else tabElRefs.current.delete(tabId)
  }, [])

  const handleDragStart = (index: number) => {
    dragIndex.current = index
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    dragOverIndex.current = index
  }

  const handleDrop = () => {
    if (dragIndex.current !== null && dragOverIndex.current !== null && dragIndex.current !== dragOverIndex.current) {
      reorderTabs(dragIndex.current, dragOverIndex.current)
    }
    dragIndex.current = null
    dragOverIndex.current = null
  }

  return (
    <>
      <div className="titlebar-drag flex-shrink-0 h-12 flex items-end bg-terminal-surface border-b border-terminal-border overflow-hidden">
        <div
          ref={tabsRef}
          className="flex-1 flex items-end overflow-x-auto min-w-0 scrollbar-hide"
          onWheel={(e) => {
            if (tabsRef.current) {
              tabsRef.current.scrollLeft += e.deltaY || e.deltaX
            }
          }}
        >
          {openTabs.map((tabId, index) => {
            const session = sessions.find((s) => s.id === tabId)
            if (!session) return null
            const isActive = tabId === activeSessionId
            const hasActivity = activeTabIds.has(tabId)
            return (
              <div
                key={tabId}
                ref={(el) => setTabElRef(tabId, el)}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={handleDrop}
                onClick={() => openTab(tabId)}
                className={`titlebar-no-drag group flex-shrink-0 flex items-center gap-2 pl-3 pr-4 py-2 cursor-pointer border-r border-terminal-border text-sm font-medium whitespace-nowrap transition-colors max-w-[360px] ${
                  isActive
                    ? 'bg-terminal-bg text-terminal-accent'
                    : 'text-terminal-subtext hover:text-terminal-text hover:bg-terminal-bg/50'
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tabId)
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:text-terminal-red transition-opacity text-[10px] leading-none w-3 text-center"
                >
                  ×
                </button>
                {session.colorLabel && (
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: COLOR_HEX[session.colorLabel] }}
                    title={session.colorLabel}
                  />
                )}
                <span className="truncate" title={session.name}>{session.name}</span>
                <RemoteViewerDot sessionId={tabId} />
                {hasActivity && !isActive && (
                  <span className="w-2 h-2 rounded-full bg-terminal-accent flex-shrink-0" />
                )}
              </div>
            )
          })}
        </div>

        {/* Right-side buttons */}
        <div className="titlebar-no-drag flex items-center gap-1 px-3 pb-1.5 flex-shrink-0">
          <button
            onClick={() => window.electronAPI.openExternal('https://github.com/ronreiter/moltty')}
            className="p-1.5 rounded-md text-terminal-subtext hover:text-terminal-text hover:bg-terminal-bg/50 transition-colors"
            title="Star on GitHub"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
          </button>
          <button
            onClick={() => setShowAbout(true)}
            className="p-1.5 rounded-md text-terminal-subtext hover:text-terminal-text hover:bg-terminal-bg/50 transition-colors"
            title="About Moltty"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* About modal */}
      {showAbout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAbout(false)}>
          <div
            className="w-[360px] bg-terminal-bg border border-terminal-border rounded-xl p-6 flex flex-col items-center gap-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={iconUrl} alt="Moltty" className="w-16 h-16 rounded-xl" />
            <h2 className="text-xl font-bold text-terminal-text">Moltty</h2>
            <p className="text-sm text-terminal-subtext text-center">
              A terminal client for AI coding tools.
            </p>
            <p className="text-xs text-terminal-subtext">Version {__APP_VERSION__}</p>
            <button
              onClick={() => {
                window.electronAPI.openExternal('https://github.com/ronreiter/moltty')
                setShowAbout(false)
              }}
              className="px-4 py-2 text-sm font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90 transition-opacity"
            >
              Star on GitHub
            </button>
            <button
              onClick={() => setShowAbout(false)}
              className="text-sm text-terminal-subtext hover:text-terminal-text transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
