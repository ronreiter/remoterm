import { describe, expect, it } from 'vitest'
import { buildPath, parseRoute } from '../src/lib/routes'

describe('parseRoute', () => {
  it('parses the known routes', () => {
    expect(parseRoute('/')).toEqual({ name: 'devices' })
    expect(parseRoute('/signin')).toEqual({ name: 'signin' })
    expect(parseRoute('/d/dev1')).toEqual({ name: 'sessions', deviceId: 'dev1' })
    expect(parseRoute('/d/dev1/s/sess9')).toEqual({ name: 'terminal', deviceId: 'dev1', sessionId: 'sess9' })
  })

  it('tolerates trailing slashes and decodes ids', () => {
    expect(parseRoute('/d/dev1/')).toEqual({ name: 'sessions', deviceId: 'dev1' })
    expect(parseRoute('/d/a%20b/s/c%2Fd')).toEqual({ name: 'terminal', deviceId: 'a b', sessionId: 'c/d' })
  })

  it('returns notfound for anything else', () => {
    expect(parseRoute('/nope')).toEqual({ name: 'notfound' })
    expect(parseRoute('/d')).toEqual({ name: 'notfound' })
    expect(parseRoute('/d/x/s')).toEqual({ name: 'notfound' })
    expect(parseRoute('/d/x/y/z')).toEqual({ name: 'notfound' })
    expect(parseRoute('/d/%E0%A4%A')).toEqual({ name: 'notfound' })
  })
})

describe('buildPath', () => {
  it('round-trips', () => {
    const routes = [
      { name: 'devices' },
      { name: 'signin' },
      { name: 'sessions', deviceId: 'a b' },
      { name: 'terminal', deviceId: 'd', sessionId: 'x/y' }
    ] as const
    for (const r of routes) expect(parseRoute(buildPath(r))).toEqual(r)
    expect(buildPath({ name: 'terminal', deviceId: 'd', sessionId: 's' })).toBe('/d/d/s/s')
  })
})
