import net from 'net'

export class DeviceApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? `${code} (${status})`)
  }
}

export interface DeviceClientOptions {
  apiBase: string
  getAccessToken: () => Promise<string>
  fetch?: typeof fetch
}

export interface Registration {
  deviceId: string
  hostname: string
  tunnelToken: string
}

/** Thin client for the Phase 1 device endpoints (aud=api bearer JWT). */
export class DeviceClient {
  private base: string

  constructor(private o: DeviceClientOptions) {
    this.base = o.apiBase.replace(/\/+$/, '')
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.o.getAccessToken()
    const res = await (this.o.fetch ?? fetch)(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* empty body */
    }
    if (!res.ok) throw new DeviceApiError(res.status, json?.error ?? 'http_error', json?.message)
    return json as T
  }

  register(name: string, port: number): Promise<Registration> {
    return this.call('POST', '/devices', { name, port })
  }

  async updatePort(id: string, port: number): Promise<void> {
    await this.call('PUT', `/devices/${encodeURIComponent(id)}/port`, { port })
  }

  async getTunnelToken(id: string): Promise<string> {
    const r = await this.call<{ tunnelToken: string }>('GET', `/devices/${encodeURIComponent(id)}/tunnel-token`)
    return r.tunnelToken
  }

  async heartbeat(id: string): Promise<void> {
    await this.call('POST', `/devices/${encodeURIComponent(id)}/heartbeat`)
  }

  /** Deletes the device; an already-deleted device (404) counts as success. */
  async remove(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/devices/${encodeURIComponent(id)}`)
    } catch (e) {
      if (e instanceof DeviceApiError && e.status === 404) return
      throw e
    }
  }
}

function listenOn(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** The preferred port if it is free on 127.0.0.1, otherwise any free port. */
export async function pickFreePort(preferred: number | undefined): Promise<number> {
  if (preferred) {
    try {
      return await listenOn(preferred)
    } catch {
      /* in use: fall through */
    }
  }
  return listenOn(0)
}
