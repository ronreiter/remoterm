import { describe, it, expect } from 'vitest'
import net from 'net'
import { DeviceClient, DeviceApiError, pickFreePort } from './device'

function mk(responses: Record<string, { status?: number; json?: unknown }>) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = []
  const client = new DeviceClient({
    apiBase: 'https://api.test/',
    getAccessToken: async () => 'AT',
    fetch: (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url)
      const method = init.method ?? 'GET'
      calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body as string) : undefined, auth: new Headers(init.headers).get('authorization') })
      const r = responses[`${method} ${u.pathname}`]
      return new Response(JSON.stringify(r?.json ?? {}), { status: r?.status ?? (r ? 200 : 404) })
    }) as unknown as typeof fetch
  })
  return { client, calls }
}

describe('DeviceClient', () => {
  it('registers a device', async () => {
    const { client, calls } = mk({ 'POST /devices': { status: 201, json: { deviceId: 'abc', hostname: 'abc.remoterm.io', tunnelToken: 'TT' } } })
    expect(await client.register('my-mac', 5555)).toEqual({ deviceId: 'abc', hostname: 'abc.remoterm.io', tunnelToken: 'TT' })
    expect(calls).toEqual([{ method: 'POST', path: '/devices', body: { name: 'my-mac', port: 5555 }, auth: 'Bearer AT' }])
  })

  it('updates port, fetches tunnel token, heartbeats and deletes', async () => {
    const { client, calls } = mk({
      'PUT /devices/abc/port': { json: { ok: true } },
      'GET /devices/abc/tunnel-token': { json: { tunnelToken: 'T2' } },
      'POST /devices/abc/heartbeat': { json: { ok: true } },
      'DELETE /devices/abc': { json: { ok: true } }
    })
    await client.updatePort('abc', 7000)
    expect(await client.getTunnelToken('abc')).toBe('T2')
    await client.heartbeat('abc')
    await client.remove('abc')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /devices/abc/port',
      'GET /devices/abc/tunnel-token',
      'POST /devices/abc/heartbeat',
      'DELETE /devices/abc'
    ])
    expect(calls[0].body).toEqual({ port: 7000 })
  })

  it('throws typed errors with status and backend error code', async () => {
    const { client } = mk({
      'POST /devices': { status: 409, json: { error: 'device_limit', max: 5 } },
      'GET /devices/x/tunnel-token': { status: 404, json: { error: 'tunnel_not_found' } }
    })
    await expect(client.register('n', 1)).rejects.toMatchObject({ status: 409, code: 'device_limit' })
    await expect(client.getTunnelToken('x')).rejects.toBeInstanceOf(DeviceApiError)
    await expect(client.getTunnelToken('x')).rejects.toMatchObject({ status: 404, code: 'tunnel_not_found' })
  })

  it('treats deleting an already-gone device (404) as success', async () => {
    const { client } = mk({ 'DELETE /devices/gone': { status: 404, json: { error: 'not_found' } } })
    await expect(client.remove('gone')).resolves.toBeUndefined()
  })
})

describe('pickFreePort', () => {
  it('prefers the stored port when free and otherwise picks another', async () => {
    const free = await pickFreePort(undefined)
    expect(free).toBeGreaterThan(1024)
    expect(await pickFreePort(free)).toBe(free)
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(free, '127.0.0.1', () => r()))
    const other = await pickFreePort(free)
    expect(other).not.toBe(free)
    srv.close()
  })
})
