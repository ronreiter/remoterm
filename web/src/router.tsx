import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type MouseEvent } from 'react'
import { buildPath, parseRoute, type Route } from './lib/routes'

interface Nav {
  route: Route
  navigate: (r: Route, opts?: { replace?: boolean }) => void
}

const Ctx = createContext<Nav>({ route: { name: 'devices' }, navigate: () => {} })

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => {
    const path = buildPath(r)
    if (opts?.replace) window.history.replaceState(null, '', path)
    else window.history.pushState(null, '', path)
    setRoute(r)
  }, [])

  return <Ctx.Provider value={{ route, navigate }}>{children}</Ctx.Provider>
}

export const useRouter = () => useContext(Ctx)

export function Link({ to, className, children, ...rest }: { to: Route; className?: string; children: ReactNode } & Record<string, unknown>) {
  const { navigate } = useRouter()
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a href={buildPath(to)} onClick={onClick} className={className} {...rest}>
      {children}
    </a>
  )
}
