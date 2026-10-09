import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { AttachClient } from '@remoterm/protocol'
import { getTheme } from '@remoterm/themes'
import { agentWsUrl } from '../config'
import { describeClose } from '../lib/closeCodes'
import { applyCtrl, keyBarBytes, type BarKey } from '../lib/keybar'
import { isTouchDevice } from '../lib/touch'
import { AuthError } from '../lib/tokens'
import { api, tokens } from '../services'
import { Link } from '../router'
import { KeyBar } from '../components/KeyBar'

type Status =
  | { kind: 'checking' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'reconnecting' }
  | { kind: 'offline' }
  | { kind: 'ended'; message: string }
  | { kind: 'reauth'; message: string }
  | { kind: 'replaced'; message: string }
  | { kind: 'closed'; message: string }

function loadRenderer(term: Terminal) {
  try {
    const gl = new WebglAddon()
    gl.onContextLoss(() => gl.dispose())
    term.loadAddon(gl)
    return
  } catch {
    /* no WebGL: fall back to canvas */
  }
  try {
    term.loadAddon(new CanvasAddon())
  } catch {
    /* DOM renderer */
  }
}

export function TerminalPage({
  deviceId,
  sessionId,
  onAuthLost
}: {
  deviceId: string
  sessionId: string
  onAuthLost: () => void
}) {
  const touch = useRef(isTouchDevice()).current
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const clientRef = useRef<AttachClient | null>(null)
  const [viewOnly, setViewOnly] = useState(touch)
  const [ctrl, setCtrl] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'checking' })
  const [epoch, setEpoch] = useState(0)
  const [title, setTitle] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState<string | null>(null)

  // Deep links carry only ids; look up the session's display name.
  useEffect(() => {
    let alive = true
    api
      .sessions(deviceId)
      .then((list) => alive && setSessionName(list.find((x) => x.id === sessionId)?.name ?? null))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [deviceId, sessionId])
  const viewOnlyRef = useRef(viewOnly)
  const ctrlRef = useRef(ctrl)
  viewOnlyRef.current = viewOnly
  ctrlRef.current = ctrl
  const reauthRetries = useRef(0)

  // Create the terminal once.
  useEffect(() => {
    const host = hostRef.current!
    const theme = getTheme('dark1')
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      theme: theme.terminal
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    loadRenderer(term)
    termRef.current = term
    fitRef.current = fit
    if (import.meta.env.DEV) (window as unknown as { __terminal: Terminal }).__terminal = term

    const sub = term.onData((d) => {
      if (viewOnlyRef.current) return
      let out = d
      if (ctrlRef.current) {
        out = applyCtrl(d)
        setCtrl(false)
      }
      clientRef.current?.write(out)
    })

    const doFit = () => {
      if (viewOnlyRef.current) return // view clients never resize the remote PTY
      try {
        fit.fit()
        clientRef.current?.resize(term.cols, term.rows)
      } catch {
        /* host not laid out yet */
      }
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(host)
    return () => {
      ro.disconnect()
      sub.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = viewOnly
  }, [viewOnly])

  // Connect (and reconnect when mode or epoch changes).
  useEffect(() => {
    const term = termRef.current!
    let disposed = false
    let ended = false
    let client: AttachClient | null = null

    ;(async () => {
      setStatus({ kind: 'checking' })
      try {
        const devices = await api.devices()
        const d = devices.find((x) => x.id === deviceId)
        if (disposed) return
        if (!d || !d.online) {
          setStatus({ kind: 'offline' })
          return
        }
      } catch (e) {
        if (e instanceof AuthError) return onAuthLost()
        /* API unreachable: still try to reach the agent directly */
      }
      if (disposed) return
      setStatus({ kind: 'connecting' })

      client = new AttachClient({
        url: agentWsUrl(deviceId, sessionId, viewOnly ? 'view' : 'control'),
        getToken: async () => {
          try {
            return await tokens.getAttachToken(deviceId)
          } catch (e) {
            if (e instanceof AuthError) onAuthLost()
            throw e
          }
        }
      })
      clientRef.current = client

      client.on('state', (s) => {
        if (disposed || ended) return
        if (s === 'connecting') setStatus({ kind: 'connecting' })
        else if (s === 'reconnecting') setStatus({ kind: 'reconnecting' })
        else if (s === 'open') setStatus({ kind: 'open' })
      })
      client.on('snapshot', (s) => {
        reauthRetries.current = 0
        term.reset()
        term.resize(s.cols, s.rows)
        term.write(s.data)
        if (!viewOnly) {
          try {
            fitRef.current?.fit()
            client?.resize(term.cols, term.rows)
            client?.focus()
          } catch {
            /* ignore */
          }
          term.focus()
        }
      })
      client.on('data', (b) => term.write(b))
      client.on('meta', (m) => m.title && setTitle(m.title))
      client.on('exit', (code) => {
        ended = true
        setStatus({ kind: 'ended', message: `Session ended (exit code ${code}).` })
      })
      client.on('close', (code) => {
        if (disposed || ended) return
        const info = describeClose(code)
        if (info.kind === 'reauth') {
          void tokens
            .getAccessToken(true)
            .then(() => {
              if (disposed) return
              if (reauthRetries.current++ < 1) setEpoch((e) => e + 1)
              else setStatus({ kind: 'reauth', message: info.message })
            })
            .catch(() => {
              if (!disposed) onAuthLost()
            })
        } else if (info.kind === 'ended') setStatus({ kind: 'ended', message: info.message })
        else if (info.kind === 'replaced') setStatus({ kind: 'replaced', message: info.message })
        else if (info.kind === 'reconnect') setEpoch((e) => e + 1)
        else setStatus({ kind: 'closed', message: info.message })
      })
      client.connect().catch(() => {
        /* surfaced through the 'close' event */
      })
    })()

    return () => {
      disposed = true
      client?.close()
      if (clientRef.current === client) clientRef.current = null
    }
  }, [deviceId, sessionId, viewOnly, epoch, onAuthLost])

  const onBarKey = useCallback((key: BarKey) => {
    const appCursor = termRef.current?.modes.applicationCursorKeysMode ?? false
    clientRef.current?.write(keyBarBytes(key, appCursor))
  }, [])

  const reconnect = () => setEpoch((e) => e + 1)
  const banner = bannerFor(status)
  const finished = status.kind === 'ended' || status.kind === 'offline'

  return (
    <div className="term-screen flex flex-col bg-terminal-bg">
      <div className="flex items-center gap-3 border-b border-terminal-border px-3 py-2 text-sm">
        <Link to={{ name: 'sessions', deviceId }} className="text-terminal-subtext hover:text-terminal-text" aria-label="Back to sessions">
          &larr;
        </Link>
        <span className="min-w-0 flex-1 truncate" data-testid="term-title">
          {title ?? sessionName ?? 'Session'}
        </span>
        <span className="text-xs text-terminal-subtext" data-testid="conn-status">
          {status.kind}
        </span>
        <button
          data-testid="view-toggle"
          aria-pressed={viewOnly}
          onClick={() => setViewOnly((v) => !v)}
          className={`rounded border px-2 py-1 text-xs ${viewOnly ? 'border-terminal-accent text-terminal-accent' : 'border-terminal-border text-terminal-subtext'}`}
        >
          {viewOnly ? 'View only' : 'Control'}
        </button>
      </div>

      {banner && (
        <div className="flex items-center justify-between gap-3 bg-terminal-surface px-3 py-2 text-sm" role="status" data-testid="banner">
          <span>{banner}</span>
          {status.kind === 'reauth' && (
            <button className="rounded border border-terminal-border px-2 py-1" onClick={onAuthLost}>
              Sign in
            </button>
          )}
          {(status.kind === 'replaced' || status.kind === 'closed') && (
            <button className="rounded border border-terminal-border px-2 py-1" onClick={reconnect}>
              Reconnect
            </button>
          )}
          {finished && (
            <Link to={{ name: 'sessions', deviceId }} className="rounded border border-terminal-border px-2 py-1">
              Back
            </Link>
          )}
        </div>
      )}

      <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" data-testid="terminal" />

      {touch && !viewOnly && <KeyBar ctrl={ctrl} onToggleCtrl={() => setCtrl((c) => !c)} onKey={onBarKey} />}
    </div>
  )
}

function bannerFor(s: Status): string | null {
  switch (s.kind) {
    case 'checking':
    case 'connecting':
      return 'Connecting...'
    case 'reconnecting':
      return 'Connection lost. Reconnecting...'
    case 'offline':
      return 'This device is offline. Make sure Remoterm is running with remote access enabled.'
    case 'ended':
    case 'reauth':
    case 'replaced':
    case 'closed':
      return s.message
    default:
      return null
  }
}
