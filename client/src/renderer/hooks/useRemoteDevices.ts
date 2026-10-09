import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteDevice } from '../services/api'

export const REMOTE_POLL_MS = 15_000

export interface RemoteDevicesState {
  /** Whether the user is signed in (the Remote group is hidden otherwise). */
  signedIn: boolean
  devices: RemoteDevice[]
  /** The last refresh failed (devices shown are the previous successful result). */
  error: boolean
  refresh: () => void
}

/**
 * Signed-in state + the user's other devices and their running sessions.
 * Polled every 15 s, but only while the window is visible (and immediately on becoming visible).
 * All network access happens in the main process behind `remoteList`.
 */
export function useRemoteDevices(): RemoteDevicesState {
  const [signedIn, setSignedIn] = useState(false)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [error, setError] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    const api = window.electronAPI
    alive.current = true
    api?.remoteGetStatus?.().then((s) => alive.current && setSignedIn(!!s?.signedIn)).catch(() => {})
    const off = api?.onRemoteStatus?.((s) => setSignedIn(!!s?.signedIn))
    return () => {
      alive.current = false
      off?.()
    }
  }, [])

  const refresh = useCallback(() => {
    const list = window.electronAPI?.remoteList
    if (!list) return
    list()
      .then((r) => {
        if (!alive.current) return
        if (r.ok) {
          setDevices(r.devices)
          setError(false)
        } else if (r.error === 'signed_out') {
          setDevices([])
          setSignedIn(false)
        } else {
          setError(true)
        }
      })
      .catch(() => alive.current && setError(true))
  }, [])

  useEffect(() => {
    if (!signedIn) {
      setDevices([])
      setError(false)
      return
    }
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer) return
      refresh()
      timer = setInterval(refresh, REMOTE_POLL_MS)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [signedIn, refresh])

  return { signedIn, devices, error, refresh }
}
