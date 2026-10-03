export type Route =
  | { name: 'devices' }
  | { name: 'signin' }
  | { name: 'sessions'; deviceId: string }
  | { name: 'terminal'; deviceId: string; sessionId: string }
  | { name: 'notfound' }

const NOT_FOUND: Route = { name: 'notfound' }

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean)
  try {
    const p = parts.map(decodeURIComponent)
    if (p.length === 0) return { name: 'devices' }
    if (p.length === 1 && p[0] === 'signin') return { name: 'signin' }
    if (p[0] === 'd' && p.length === 2) return { name: 'sessions', deviceId: p[1] }
    if (p[0] === 'd' && p.length === 4 && p[2] === 's') {
      return { name: 'terminal', deviceId: p[1], sessionId: p[3] }
    }
  } catch {
    /* malformed percent-encoding */
  }
  return NOT_FOUND
}

export function buildPath(r: Route): string {
  const e = encodeURIComponent
  switch (r.name) {
    case 'devices':
      return '/'
    case 'signin':
      return '/signin'
    case 'sessions':
      return `/d/${e(r.deviceId)}`
    case 'terminal':
      return `/d/${e(r.deviceId)}/s/${e(r.sessionId)}`
    default:
      return '/'
  }
}
