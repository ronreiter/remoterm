import { useEffect, useState } from 'react'
import type { SessionInfo } from '@remoterm/protocol'
import { DeviceOfflineError } from '../lib/api'
import { AuthError } from '../lib/tokens'
import { api } from '../services'
import { Link } from '../router'

export function Sessions({ deviceId, onAuthLost }: { deviceId: string; onAuthLost: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .sessions(deviceId)
        .then((s) => {
          if (cancelled) return
          setSessions(s)
          setError(null)
        })
        .catch((e) => {
          if (cancelled) return
          if (e instanceof AuthError) onAuthLost()
          else if (e instanceof DeviceOfflineError) setError('This device is offline. Make sure Remoterm is running and remote access is on.')
          else setError('Could not load sessions.')
        })
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [deviceId, onAuthLost])

  const running = sessions?.filter((s) => s.running)

  return (
    <main>
      <Link to={{ name: 'devices' }} className="mb-3 inline-block text-sm text-terminal-subtext hover:text-terminal-text">
        &larr; Devices
      </Link>
      <h1 className="mb-4 text-xl font-semibold">Sessions</h1>
      {error && (
        <p className="mb-3 text-terminal-red" data-testid="sessions-error">
          {error}
        </p>
      )}
      {sessions === null && !error && <p className="text-terminal-subtext">Loading...</p>}
      {running?.length === 0 && <p className="text-terminal-subtext">No running sessions on this device.</p>}
      <ul className="flex flex-col gap-2">
        {running?.map((s) => (
          <li key={s.id} data-testid={`session-${s.id}`}>
            <Link
              to={{ name: 'terminal', deviceId, sessionId: s.id }}
              className="flex items-center justify-between rounded-lg border border-terminal-border bg-terminal-surface px-4 py-3 hover:border-terminal-accent"
            >
              <span className="flex flex-col">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-terminal-subtext">{s.cwd}</span>
              </span>
              <span className="text-xs text-terminal-subtext">
                {s.tool}
                {s.busy ? ' - busy' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
