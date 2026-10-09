import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'

export default function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions)
  const openTabs = useStore((s) => s.openTabs)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const openTab = useStore((s) => s.openTab)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const allSessions = sessions.filter((s) => s.status === 'open' || openTabs.includes(s.id))
  const filtered = query
    ? allSessions.filter((s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.workDir?.toLowerCase().includes(query.toLowerCase()) ||
        s.remote?.deviceName.toLowerCase().includes(query.toLowerCase())
      )
    : allSessions

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const select = (id: string) => {
    openTab(id)
    setActiveSession(id)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      select(filtered[selectedIndex].id)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40" onClick={onClose}>
      <div
        className="w-[480px] bg-terminal-bg border border-terminal-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Switch to session..."
          className="w-full px-4 py-3 bg-terminal-bg text-terminal-text text-sm outline-none border-b border-terminal-border placeholder-terminal-subtext"
        />
        <div className="max-h-[300px] overflow-y-auto">
          {filtered.map((s, i) => (
            <div
              key={s.id}
              onClick={() => select(s.id)}
              className={`flex flex-col gap-0.5 px-4 py-2.5 cursor-pointer transition-colors ${
                i === selectedIndex ? 'bg-terminal-surface text-terminal-accent' : 'text-terminal-text hover:bg-terminal-surface'
              }`}
            >
              <span className="text-sm font-medium truncate">{s.name}</span>
              {s.remote && (
                <span className="text-[11px] text-terminal-subtext truncate">remote · {s.remote.deviceName}</span>
              )}
              {s.workDir && (
                <span className="text-[11px] text-terminal-subtext truncate">
                  {s.workDir.replace(/^\/Users\/[^/]+/, '~')}
                </span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="text-terminal-subtext text-xs text-center py-6">No matching sessions</p>
          )}
        </div>
      </div>
    </div>
  )
}
