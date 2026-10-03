import { useCallback, useEffect, useState } from 'react'
import { getTheme } from '@remoterm/themes'
import { AuthError } from './lib/tokens'
import type { Me } from './lib/api'
import { api, tokens } from './services'
import { useRouter } from './router'
import { SignIn } from './pages/SignIn'
import { Devices } from './pages/Devices'
import { Sessions } from './pages/Sessions'
import { TerminalPage } from './pages/TerminalPage'

type Auth = { state: 'loading' } | { state: 'signedout' } | { state: 'signedin'; me: Me }

function applyTheme() {
  const ui = getTheme('dark1').ui
  const s = document.documentElement.style
  s.setProperty('--terminal-bg', ui.bg)
  s.setProperty('--terminal-surface', ui.surface)
  s.setProperty('--terminal-text', ui.text)
  s.setProperty('--terminal-subtext', ui.subtext)
  s.setProperty('--terminal-accent', ui.accent)
  s.setProperty('--terminal-green', ui.green)
  s.setProperty('--terminal-red', ui.red)
  s.setProperty('--terminal-border', ui.border)
}

export function App() {
  const { route, navigate } = useRouter()
  const [auth, setAuth] = useState<Auth>({ state: 'loading' })

  useEffect(applyTheme, [])

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then((me) => !cancelled && setAuth({ state: 'signedin', me }))
      .catch((e) => {
        if (cancelled) return
        // Network errors are not a sign-out; show sign-in only for real auth failures.
        setAuth({ state: 'signedout' })
        if (!(e instanceof AuthError)) console.warn('auth check failed', e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onAuthLost = useCallback(() => setAuth({ state: 'signedout' }), [])

  const signOut = useCallback(async () => {
    await tokens.logout()
    setAuth({ state: 'signedout' })
    navigate({ name: 'signin' }, { replace: true })
  }, [navigate])

  if (auth.state === 'loading') {
    return <div className="p-6 text-terminal-subtext">Loading...</div>
  }
  if (auth.state === 'signedout') return <SignIn />

  const me = auth.me
  if (route.name === 'terminal') {
    return <TerminalPage deviceId={route.deviceId} sessionId={route.sessionId} onAuthLost={onAuthLost} />
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pb-10">
      <header className="flex items-center justify-between py-5">
        <button className="text-lg font-semibold" onClick={() => navigate({ name: 'devices' })}>
          Remoterm
        </button>
        <div className="flex items-center gap-3 text-sm text-terminal-subtext">
          <span data-testid="login">{me.login}</span>
          <button className="rounded border border-terminal-border px-2 py-1 hover:text-terminal-text" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      {route.name === 'sessions' ? (
        <Sessions deviceId={route.deviceId} onAuthLost={onAuthLost} />
      ) : route.name === 'devices' || route.name === 'signin' ? (
        <Devices onAuthLost={onAuthLost} />
      ) : (
        <p className="text-terminal-subtext">Page not found.</p>
      )}
    </div>
  )
}
