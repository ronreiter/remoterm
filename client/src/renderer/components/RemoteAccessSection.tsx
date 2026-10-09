import React, { useEffect, useState } from 'react'
import type { RemoteStatus } from '../services/api'
import ConfirmDialog from './ConfirmDialog'

function statusLight(s: RemoteStatus): { color: string; label: string } {
  if (!s.enabled) return { color: 'bg-terminal-subtext', label: 'Off' }
  switch (s.tunnel.state) {
    case 'connected':
      return { color: 'bg-terminal-green', label: 'Connected' }
    case 'connecting':
      return { color: 'bg-orange-400', label: 'Connecting…' }
    case 'error':
      return { color: 'bg-terminal-red', label: `Error: ${s.tunnel.message}` }
    default:
      return { color: 'bg-terminal-subtext', label: 'Starting…' }
  }
}

/** Settings › Remote access (spec section 10). Actions apply immediately; they are not part of Save. */
export default function RemoteAccessSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const api = window.electronAPI

  useEffect(() => {
    let alive = true
    api?.remoteGetStatus?.().then((s) => {
      if (!alive || !s) return
      setStatus(s)
      setName(s.deviceName)
    })
    const off = api?.onRemoteStatus?.((s) => {
      setStatus(s)
      setName((cur) => (cur === '' ? s.deviceName : cur))
    })
    return () => {
      alive = false
      off?.()
    }
  }, [api])

  if (!api?.remoteGetStatus) return null
  if (!status) {
    return (
      <section aria-label="Remote access" className="flex flex-col gap-3">
        <p className="text-sm text-terminal-subtext">Remote access</p>
      </section>
    )
  }

  const light = statusLight(status)
  const disabledAll = status.busy

  const commitName = async () => {
    if (name === status.deviceName) return
    const r = await api.remoteSetDeviceName(name)
    if (r.ok) setNameError(null)
    else {
      setNameError(r.error ?? 'Invalid name')
      setName(status.deviceName)
    }
  }

  return (
    <section aria-label="Remote access" className="flex flex-col gap-3" data-testid="remote-access">
      <p className="text-sm text-terminal-subtext">Remote access</p>

      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border">
        {status.signedIn ? (
          <>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-sm text-terminal-text">
                Signed in as <span className="font-semibold" data-testid="remote-login">@{status.login ?? '…'}</span>
              </span>
              <span className="text-xs text-terminal-subtext">Only you can attach to this Mac's running sessions</span>
            </div>
            <button
              onClick={() => api.remoteSignOut()}
              disabled={disabledAll}
              className="text-xs text-terminal-subtext hover:text-terminal-text transition-colors disabled:opacity-50"
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-sm text-terminal-text">Attach to this Mac's sessions from anywhere</span>
              <span className="text-xs text-terminal-subtext">Sign in with GitHub to enable remote access</span>
            </div>
            <button
              onClick={async () => {
                setSignInError(null)
                const r = await api.remoteSignIn()
                if (!r.ok) setSignInError(r.error ?? 'Could not open the browser')
              }}
              className="px-3 py-1.5 text-sm font-semibold bg-terminal-accent text-terminal-bg rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
            >
              Sign in with GitHub
            </button>
          </>
        )}
      </div>
      {signInError && <p className="text-xs text-terminal-red">{signInError}</p>}

      <label className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border cursor-pointer">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={!status.signedIn || disabledAll}
          onChange={(e) => api.remoteSetEnabled(e.target.checked)}
          className="w-4 h-4 rounded accent-terminal-accent"
        />
        <div className="flex flex-col flex-1">
          <span className="text-sm text-terminal-text">Allow remote access to this Mac</span>
          <span className="text-xs text-terminal-subtext">
            {status.enabled && status.hostname ? status.hostname : 'Keeps a secure connection open while Remoterm is running'}
          </span>
        </div>
        <span className="flex items-center gap-2 text-xs text-terminal-subtext min-w-0" data-testid="remote-status">
          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${light.color}`} data-testid="remote-status-light" />
          <span className="truncate max-w-[180px]" title={light.label}>{light.label}</span>
        </span>
      </label>

      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border">
        <div className="flex flex-col flex-1">
          <span className="text-sm text-terminal-text">Device name</span>
          <span className="text-xs text-terminal-subtext">
            {status.enabled ? 'Turn off remote access to rename' : 'How this Mac appears on your other devices'}
          </span>
        </div>
        <input
          aria-label="Device name"
          value={name}
          disabled={status.enabled || disabledAll}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-44 bg-terminal-bg text-terminal-text text-sm px-2 py-1 rounded border border-terminal-border focus:border-terminal-accent outline-none disabled:opacity-60"
        />
      </div>
      {nameError && <p className="text-xs text-terminal-red">{nameError}</p>}

      <label className="flex items-center gap-3 px-4 py-3 rounded-lg bg-terminal-surface border border-terminal-border cursor-pointer">
        <input
          type="checkbox"
          checked={status.preventSleep}
          onChange={(e) => api.remoteSetPreventSleep(e.target.checked)}
          className="w-4 h-4 rounded accent-terminal-accent"
        />
        <div className="flex flex-col">
          <span className="text-sm text-terminal-text">Prevent sleep while remote access is on</span>
          <span className="text-xs text-terminal-subtext">Sessions only run while this Mac is awake</span>
        </div>
      </label>

      {status.error && (
        <p className="text-xs text-terminal-red" role="alert" data-testid="remote-error">
          {status.error}
        </p>
      )}

      {(status.deviceId || status.enabled) && (
        <div className="flex justify-end">
          <button
            onClick={() => setConfirmReset(true)}
            disabled={disabledAll}
            className="text-xs text-terminal-subtext hover:text-terminal-red transition-colors disabled:opacity-50"
          >
            Reset remote access
          </button>
        </div>
      )}

      {confirmReset && (
        <ConfirmDialog
          title="Reset remote access?"
          message="This turns remote access off and removes this Mac from your account. You can enable it again afterwards."
          confirmLabel="Reset"
          destructive
          onConfirm={() => {
            setConfirmReset(false)
            api.remoteReset()
          }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </section>
  )
}
