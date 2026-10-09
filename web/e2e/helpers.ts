import type { Page, Route } from '@playwright/test'

export const API = 'https://api.remoterm.io'

export interface MockDevice {
  id: string
  name: string
  online: boolean
  last_seen: number | null
}

export interface ApiMock {
  calls: { method: string; path: string; authorization?: string }[]
}

/** Intercepts every request to the API origin and answers like the Worker would (incl. CORS). */
export async function mockApi(
  page: Page,
  opts: { signedIn?: boolean; devices?: MockDevice[] } = {}
): Promise<ApiMock> {
  const signedIn = opts.signedIn ?? true
  const devices = opts.devices ?? [
    { id: 'd1', name: 'Work MacBook', online: true, last_seen: Math.floor(Date.now() / 1000) },
    { id: 'd2', name: 'Old Mac mini', online: false, last_seen: Math.floor(Date.now() / 1000) - 7200 }
  ]
  const mock: ApiMock = { calls: [] }

  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const origin = req.headers()['origin']
    const cors: Record<string, string> = origin
      ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
      : {}
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) })

    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...cors, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' }
      })
    }
    mock.calls.push({ method: req.method(), path: url.pathname, authorization: req.headers()['authorization'] })

    if (url.pathname === '/auth/github') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>GitHub login</h1>' })
    }
    if (url.pathname === '/auth/refresh') {
      return signedIn ? json(200, { access_token: 'api-jwt', expires_in: 600 }) : json(401, { error: 'unauthorized' })
    }
    if (url.pathname === '/auth/logout') return json(200, { ok: true })
    if (req.headers()['authorization'] !== 'Bearer api-jwt') return json(401, { error: 'unauthorized' })
    if (url.pathname === '/me') return json(200, { id: 'u1', login: 'octocat' })
    if (url.pathname === '/devices') {
      return json(200, devices.map((d) => ({ ...d, hostname: `${d.id}.remoterm.io`, port: 7000, created_at: 1 })))
    }
    const m = /^\/devices\/([^/]+)\/attach-token$/.exec(url.pathname)
    if (m && req.method() === 'POST') return json(200, { token: `attach-${m[1]}`, hostname: `${m[1]}.remoterm.io`, expires_in: 600 })
    return json(404, { error: 'not_found' })
  })
  return mock
}

/** Visible text of the xterm buffer (DEV builds expose the terminal on window). */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const t = (window as unknown as { __terminal?: import('@xterm/xterm').Terminal }).__terminal
    if (!t) return ''
    const b = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  })
}
