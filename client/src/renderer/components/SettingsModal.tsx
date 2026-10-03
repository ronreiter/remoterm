import React, { useState, useEffect } from 'react'
import { useStore } from '../store'
import { CODING_TOOLS, type CodingTool, type RemotermSettings } from '../services/api'
import { THEMES, type ThemeId } from '../services/themes'
import RemoteAccessSection from './RemoteAccessSection'

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const [selected, setSelected] = useState<CodingTool>(settings?.codingTool || 'claude')
  const [loadZshrc, setLoadZshrc] = useState(settings?.loadZshrc ?? true)
  const [notifications, setNotifications] = useState(settings?.notifications ?? true)
  const [autoUpdate, setAutoUpdate] = useState(settings?.autoUpdate ?? true)
  const [scrollback, setScrollback] = useState(settings?.scrollback ?? 0)
  const [theme, setTheme] = useState<ThemeId>((settings?.theme as ThemeId) || 'dark1')

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleSave = () => {
    const newSettings: RemotermSettings = { codingTool: selected, loadZshrc, notifications, autoUpdate, scrollback, theme }
    setSettings(newSettings)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[520px] max-h-[90vh] overflow-y-auto bg-terminal-bg border border-terminal-border rounded-xl p-6 flex flex-col gap-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-terminal-text">Settings</h2>
          <button onClick={onClose} className="text-terminal-subtext hover:text-terminal-text text-lg leading-none">
            ×
          </button>
        </div>

        <div>
          <p className="text-sm text-terminal-subtext mb-3">AI Coding Tool</p>
          <div className="grid grid-cols-2 gap-3">
            {CODING_TOOLS.map((tool) => (
              <button
                key={tool.id}
                onClick={() => setSelected(tool.id)}
                className={`flex flex-col items-start gap-1 px-4 py-3 rounded-lg border transition-colors text-left ${
                  selected === tool.id
                    ? 'border-terminal-accent bg-terminal-accent/10 text-terminal-accent'
                    : 'border-terminal-border bg-terminal-surface text-terminal-text hover:border-terminal-accent/50'
                }`}
              >
                <span className="text-sm font-semibold">{tool.name}</span>
                <span className="text-xs text-terminal-subtext">{tool.description}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm text-terminal-subtext mb-3">Theme</p>
          <div className="grid grid-cols-3 gap-3">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`flex flex-col items-center gap-2 px-4 py-3 rounded-lg border transition-colors ${
                  theme === t.id
                    ? 'border-terminal-accent bg-terminal-accent/10 text-terminal-accent'
                    : 'border-terminal-border bg-terminal-surface text-terminal-text hover:border-terminal-accent/50'
                }`}
              >
                <div className="flex gap-1">
                  <div className="w-4 h-4 rounded-full border border-black/20" style={{ background: t.ui.bg }} />
                  <div className="w-4 h-4 rounded-full border border-black/20" style={{ background: t.ui.surface }} />
                  <div className="w-4 h-4 rounded-full border border-black/20" style={{ background: t.ui.accent }} />
                </div>
                <span className="text-xs font-semibold">{t.name}</span>
                <span className="text-[10px] text-terminal-subtext">{t.description}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border cursor-pointer">
          <input
            type="checkbox"
            checked={loadZshrc}
            onChange={(e) => setLoadZshrc(e.target.checked)}
            className="w-4 h-4 rounded accent-terminal-accent"
          />
          <div className="flex flex-col">
            <span className="text-sm text-terminal-text">Load .zshrc on startup</span>
            <span className="text-xs text-terminal-subtext">Source your shell config before launching the tool</span>
          </div>
        </label>

        <label className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border cursor-pointer">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) => setNotifications(e.target.checked)}
            className="w-4 h-4 rounded accent-terminal-accent"
          />
          <div className="flex flex-col">
            <span className="text-sm text-terminal-text">Notifications</span>
            <span className="text-xs text-terminal-subtext">Notify when a background tab finishes a task</span>
          </div>
        </label>

        <label className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border cursor-pointer">
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={(e) => setAutoUpdate(e.target.checked)}
            className="w-4 h-4 rounded accent-terminal-accent"
          />
          <div className="flex flex-col">
            <span className="text-sm text-terminal-text">Auto-update</span>
            <span className="text-xs text-terminal-subtext">Automatically download new versions on startup</span>
          </div>
        </label>

        <label className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border cursor-pointer">
          <div className="flex flex-col flex-1">
            <span className="text-sm text-terminal-text">Scrollback</span>
            <span className="text-xs text-terminal-subtext">Lines of history kept per terminal. Full-screen tools don't use it; None saves the most memory.</span>
          </div>
          <select
            value={scrollback}
            onChange={(e) => setScrollback(Number(e.target.value))}
            className="bg-terminal-bg text-terminal-text text-sm px-2 py-1 rounded border border-terminal-border focus:border-terminal-accent outline-none"
          >
            <option value={0}>None</option>
            <option value={1000}>1,000</option>
            <option value={5000}>5,000</option>
            <option value={10000}>10,000</option>
            <option value={25000}>25,000</option>
            <option value={50000}>50,000</option>
          </select>
        </label>

        <RemoteAccessSection />

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-terminal-subtext hover:text-terminal-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
