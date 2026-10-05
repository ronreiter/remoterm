import React, { useState } from 'react'
import { useStore } from '../store'
import { CODING_TOOLS, type CodingTool, type RemotermSettings } from '../services/api'

export default function Onboarding() {
  const setSettings = useStore((s) => s.setSettings)
  const [selected, setSelected] = useState<CodingTool>('claude')
  const [loadZshrc, setLoadZshrc] = useState(true)

  const handleSubmit = () => {
    const settings: RemotermSettings = { codingTool: selected, loadZshrc }
    setSettings(settings)
  }

  return (
    <div className="flex h-screen bg-terminal-bg items-center justify-center">
      <div className="w-[520px] flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-terminal-text mb-2">Welcome to Remoterm</h1>
          <p className="text-terminal-subtext text-sm">Choose your AI coding tool to get started</p>
        </div>

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

        <button
          onClick={handleSubmit}
          className="w-full py-3 text-sm font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90 transition-opacity"
        >
          Get Started
        </button>
      </div>
    </div>
  )
}
