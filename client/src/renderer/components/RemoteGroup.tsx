import React, { useState } from 'react'
import { useStore } from '../store'
import { useRemoteDevices } from '../hooks/useRemoteDevices'
import { lastSeenLabel } from '../services/remoteFormat'
import type { RemoteDevice, RemoteSessionInfo } from '../services/api'

function shortCwd(cwd: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(cwd)
  return m ? `~${m[1] ?? ''}` : cwd
}

function sessionLabel(s: RemoteSessionInfo): string {
  return s.name && s.name !== s.id ? s.name : shortCwd(s.cwd) || s.id
}

/** Sidebar "Remote" group: the user's other Macs and the sessions running on them. Hidden when signed out. */
export default function RemoteGroup() {
  const { signedIn, devices, error } = useRemoteDevices()
  const [collapsed, setCollapsed] = useState(false)
  const openRemoteTab = useStore((s) => s.openRemoteTab)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)

  if (!signedIn) return null

  const open = (d: RemoteDevice, s: RemoteSessionInfo) =>
    openRemoteTab({ deviceId: d.id, sessionId: s.id, deviceName: d.name, name: sessionLabel(s) })
  const isOpen = (d: RemoteDevice, s: RemoteSessionInfo) =>
    sessions.find((x) => x.id === activeSessionId)?.remote?.deviceId === d.id &&
    sessions.find((x) => x.id === activeSessionId)?.remote?.sessionId === s.id

  return (
    <div data-testid="remote-group" className="flex-shrink-0 max-h-[40%] overflow-y-auto border-t border-terminal-border px-2 py-1.5">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-terminal-subtext hover:text-terminal-text"
        aria-expanded={!collapsed}
      >
        <span className="w-3 text-center">{collapsed ? '▸' : '▾'}</span>
        Remote
        {error && (
          <span data-testid="remote-list-error" className="ml-auto normal-case font-normal text-terminal-red" title="Could not refresh devices">
            offline
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="space-y-0.5">
          {devices.length === 0 && (
            <p data-testid="remote-empty" className="px-2 py-1 text-[11px] text-terminal-subtext/60">
              No other devices. Turn on remote access on another Mac.
            </p>
          )}
          {devices.map((d) => (
            <div key={d.id} data-testid={`remote-device-${d.id}`} className={d.online && !d.error ? '' : 'opacity-60'}>
              <div className="flex items-center gap-2 px-2 py-1">
                <span
                  data-testid={`remote-device-dot-${d.id}`}
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${d.online ? 'bg-terminal-green' : 'bg-terminal-subtext/40'}`}
                />
                <span className="text-xs font-medium text-terminal-text truncate">{d.name}</span>
                <span data-testid={`remote-device-state-${d.id}`} className="ml-auto text-[10px] text-terminal-subtext whitespace-nowrap">
                  {!d.online ? `last seen ${lastSeenLabel(d.lastSeen)}` : d.error ? 'unreachable' : 'online'}
                </span>
              </div>
              {d.online && !d.error && d.sessions.length === 0 && (
                <p className="pl-6 pr-2 pb-1 text-[11px] text-terminal-subtext/60">No running sessions</p>
              )}
              {d.online &&
                d.sessions.map((s) => (
                  <div
                    key={s.id}
                    data-testid={`remote-session-${d.id}-${s.id}`}
                    onClick={() => open(d, s)}
                    className={`ml-4 flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                      isOpen(d, s) ? 'bg-terminal-bg text-terminal-accent' : 'text-terminal-text hover:bg-terminal-bg'
                    }`}
                  >
                    <span className="text-xs truncate">{sessionLabel(s)}</span>
                    {s.busy && <span title="Busy" className="ml-auto w-1.5 h-1.5 rounded-full bg-terminal-accent animate-pulse flex-shrink-0" />}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
