import React from 'react'
import { useStore } from '../store'
import { remoteStatusLabel } from '../services/remoteFormat'

const DOT: Record<string, string> = {
  live: 'bg-terminal-green',
  connecting: 'bg-orange-400',
  offline: 'bg-orange-400',
  auth: 'bg-terminal-red',
  ended: 'bg-terminal-subtext/50'
}

/** Header over an active remote tab: where it runs, connection state, and the View/Control toggle. */
export default function RemoteTabHeader({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const rt = useStore((s) => s.remoteTabs[sessionId])
  const setRemoteMode = useStore((s) => s.setRemoteMode)
  if (!session?.remote) return null
  const status = rt?.status ?? 'connecting'
  const mode = rt?.mode ?? 'control'
  const finished = status === 'ended' || status === 'auth'

  const seg = (m: 'view' | 'control', label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      data-testid={`remote-mode-${m}`}
      disabled={finished}
      onClick={() => setRemoteMode(sessionId, m)}
      className={`px-2.5 py-0.5 text-xs rounded-md transition-colors disabled:opacity-40 ${
        mode === m ? 'bg-terminal-surface text-terminal-accent shadow-sm' : 'text-terminal-subtext hover:text-terminal-text'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div
      data-testid="remote-tab-header"
      className="flex-shrink-0 px-4 py-1.5 bg-terminal-surface border-b border-terminal-border flex items-center gap-3"
    >
      <span className="text-xs font-mono text-terminal-accent">remote · {session.remote.deviceName}</span>
      <span className="flex items-center gap-1.5 text-xs text-terminal-subtext">
        <span className={`w-2 h-2 rounded-full ${DOT[status] ?? 'bg-terminal-subtext/50'}`} />
        <span data-testid="remote-tab-status">{remoteStatusLabel(status, rt?.code, rt?.exitCode)}</span>
      </span>
      <div className="ml-auto flex bg-terminal-bg rounded-lg p-0.5" role="group" aria-label="Attach mode">
        {seg('view', 'View')}
        {seg('control', 'Control')}
      </div>
    </div>
  )
}
