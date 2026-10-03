import { useEffect, useState } from 'react'
import { AuthError } from '../lib/tokens'
import type { Device } from '../lib/api'
import { lastSeenLabel } from '../lib/format'
import { api } from '../services'
import { Link } from '../router'

export function Devices({ onAuthLost }: { onAuthLost: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .devices()
        .then((d) => {
          if (cancelled) return
          setDevices(d)
          setError(null)
        })
        .catch((e) => {
          if (cancelled) return
          if (e instanceof AuthError) onAuthLost()
          else setError('Could not load devices.')
        })
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [onAuthLost])

  return (
    <main>
      <h1 className="mb-4 text-xl font-semibold">Devices</h1>
      {error && <p className="mb-3 text-terminal-red">{error}</p>}
      {devices === null && !error && <p className="text-terminal-subtext">Loading...</p>}
      {devices?.length === 0 && (
        <p className="text-terminal-subtext">
          No devices yet. In the Remoterm app, enable Settings &rsaquo; Remote access to see this computer here.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {devices?.map((d) => {
          const body = (
            <>
              <span className="flex items-center gap-3">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${d.online ? 'bg-terminal-green' : 'bg-terminal-subtext'}`}
                  aria-hidden
                />
                <span className="font-medium">{d.name}</span>
              </span>
              <span className="text-sm text-terminal-subtext" data-testid="device-status">
                {d.online ? 'online' : `offline - last seen ${lastSeenLabel(d.last_seen)}`}
              </span>
            </>
          )
          const cls = 'flex items-center justify-between rounded-lg border border-terminal-border bg-terminal-surface px-4 py-3'
          return (
            <li key={d.id} data-testid={`device-${d.id}`}>
              {d.online ? (
                <Link to={{ name: 'sessions', deviceId: d.id }} className={`${cls} hover:border-terminal-accent`}>
                  {body}
                </Link>
              ) : (
                <div className={`${cls} opacity-60`} aria-disabled>
                  {body}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </main>
  )
}
