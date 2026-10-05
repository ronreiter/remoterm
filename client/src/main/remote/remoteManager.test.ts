import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteManager, type RemoteConfig, type RemoteStatus } from './remoteManager'
import { DeviceApiError } from './device'
import { AccountError } from './account'
import type { CloudflaredStatus } from './cloudflared'

function build(over: { signedIn?: boolean; config?: Partial<RemoteConfig> | null; ports?: number[]; deviceOverrides?: Record<string, unknown>; serverStartFails?: (port: number) => boolean } = {}) {
  const log: string[] = []
  const statuses: RemoteStatus[] = []
  let saved: RemoteConfig | null = over.config === null ? null : ({ enabled: false, deviceName: 'my-mac', preventSleep: false, ...over.config } as RemoteConfig)
  const ports = [...(over.ports ?? [4100, 4200, 4300])]
  let cfStatus: CloudflaredStatus = { state: 'stopped' }
  let cfNotify: (() => void) | null = null
  const hub = { closeRemoteClients: vi.fn((code: number) => log.push(`hub.close:${code}`)) }
  const device = {
    register: vi.fn(async (name: string, port: number) => {
      log.push(`register:${name}:${port}`)
      return { deviceId: 'dev1', hostname: 'dev1.remoterm.io', tunnelToken: 'TT-new' }
    }),
    updatePort: vi.fn(async (id: string, port: number) => void log.push(`updatePort:${id}:${port}`)),
    getTunnelToken: vi.fn(async (id: string) => {
      log.push(`getTunnelToken:${id}`)
      return 'TT-existing'
    }),
    heartbeat: vi.fn(async (id: string) => void log.push(`heartbeat:${id}`)),
    remove: vi.fn(async (id: string) => void log.push(`remove:${id}`)),
    ...over.deviceOverrides
  }
  const account = { state: { signedIn: over.signedIn ?? true, login: 'octocat', userId: 'u1' }, signOut: vi.fn(() => void (account.state = { signedIn: false } as never)) }
  const m = new RemoteManager({
    account: account as never,
    device: device as never,
    hub: hub as never,
    store: { load: () => saved, save: (c) => void (saved = c) },
    pickPort: async (pref) => (ports.length ? ports.shift()! : pref!),
    createServer: (port) => ({
      port,
      start: async () => {
        if (over.serverStartFails?.(port)) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' })
        log.push(`server.start:${port}`)
        return port
      },
      stop: async () => void log.push(`server.stop:${port}`)
    }),
    createAuth: (getId) => ({ start: () => log.push(`auth.start:${getId()}`), stop: () => log.push('auth.stop') }) as never,
    createCloudflared: (onStatus) => {
      cfNotify = () => onStatus(cfStatus)
      return {
        get status() {
          return cfStatus
        },
        start: (t: string) => {
          log.push(`cf.start:${t}`)
          cfStatus = { state: 'connecting' }
          cfNotify!()
        },
        stop: () => {
          log.push('cf.stop')
          cfStatus = { state: 'stopped' }
          cfNotify!()
        }
      }
    },
    power: { start: () => (log.push('power.start'), 7), stop: (id: number) => void log.push(`power.stop:${id}`) },
    defaultDeviceName: () => 'default-mac',
    onStatus: (s) => statuses.push(s),
    heartbeatMs: 60_000
  })
  return { m, log, statuses, device, hub, account, saved: () => saved, setCf: (s: CloudflaredStatus) => ((cfStatus = s), cfNotify!()) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('RemoteManager.enable', () => {
  it('registers a new device on a free port, starts server then cloudflared, persists', async () => {
    const t = build({ config: null })
    await t.m.enable()
    expect(t.log).toEqual(['server.start:4100', 'register:default-mac:4100', 'auth.start:dev1', 'cf.start:TT-new'])
    expect(t.saved()).toMatchObject({ enabled: true, deviceId: 'dev1', hostname: 'dev1.remoterm.io', port: 4100, deviceName: 'default-mac' })
    const s = t.m.getStatus()
    expect(s).toMatchObject({ enabled: true, signedIn: true, login: 'octocat', deviceId: 'dev1', port: 4100, busy: false })
    expect(s.tunnel).toEqual({ state: 'connecting' })
    t.setCf({ state: 'connected' })
    expect(t.statuses.at(-1)!.tunnel).toEqual({ state: 'connected' })
  })

  it('reuses an existing device and re-fetches the tunnel token; PUTs the port only if it changed', async () => {
    const t = build({ config: { deviceId: 'dev1', hostname: 'h', port: 4100, deviceName: 'my-mac' }, ports: [] })
    await t.m.enable()
    expect(t.log).toEqual(['server.start:4100', 'getTunnelToken:dev1', 'auth.start:dev1', 'cf.start:TT-existing'])
    expect(t.device.updatePort).not.toHaveBeenCalled()
    expect(t.device.register).not.toHaveBeenCalled()
  })

  it('PUTs the new port when the stored one is taken', async () => {
    const t = build({ config: { deviceId: 'dev1', hostname: 'h', port: 4100, deviceName: 'my-mac' }, ports: [4999] })
    await t.m.enable()
    expect(t.log).toContain('updatePort:dev1:4999')
    expect(t.saved()!.port).toBe(4999)
  })

  it('retries on another port if the chosen one is grabbed before bind', async () => {
    const t = build({ config: null, ports: [4100, 4200], serverStartFails: (p) => p === 4100 })
    await t.m.enable()
    expect(t.log).toContain('server.start:4200')
    expect(t.log).toContain('register:default-mac:4200')
  })

  it('re-registers once when the tunnel was deleted remotely', async () => {
    const t = build({
      config: { deviceId: 'old', hostname: 'h', port: 4100, deviceName: 'my-mac' },
      ports: [],
      deviceOverrides: { getTunnelToken: vi.fn(async () => { throw new DeviceApiError(404, 'tunnel_not_found') }) }
    })
    await t.m.enable()
    expect(t.device.register).toHaveBeenCalledWith('my-mac', 4100)
    expect(t.saved()!.deviceId).toBe('dev1')
    expect(t.log).toContain('cf.start:TT-new')
  })

  it('refuses when signed out', async () => {
    const t = build({ signedIn: false, config: null })
    await t.m.enable()
    expect(t.m.getStatus()).toMatchObject({ enabled: false, error: 'Sign in first' })
    expect(t.log).toEqual([])
  })

  it('cleans up and reports the error when registration fails', async () => {
    const t = build({
      config: null,
      deviceOverrides: { register: vi.fn(async () => { throw new DeviceApiError(409, 'device_limit') }) }
    })
    await t.m.enable()
    expect(t.log).toEqual(['server.start:4100', 'auth.stop', 'server.stop:4100'])
    expect(t.m.getStatus()).toMatchObject({ enabled: false, busy: false })
    expect(t.m.getStatus().error).toMatch(/5 devices/i)
    expect(t.saved()!.enabled).toBe(false)
  })

  it('prevent-sleep blocker is held while enabled', async () => {
    const t = build({ config: { preventSleep: true } })
    await t.m.enable()
    expect(t.log).toContain('power.start')
    await t.m.disable()
    expect(t.log).toContain('power.stop:7')
  })

  it('toggling prevent-sleep while enabled starts/stops the blocker', async () => {
    const t = build({ config: null })
    await t.m.enable()
    t.m.setPreventSleep(true)
    expect(t.log.filter((l) => l === 'power.start')).toHaveLength(1)
    t.m.setPreventSleep(false)
    expect(t.log).toContain('power.stop:7')
    expect(t.saved()!.preventSleep).toBe(false)
  })
})

describe('heartbeat', () => {
  it('beats every 60 s while enabled and stops after disable', async () => {
    const t = build({ config: null })
    await t.m.enable()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.log.filter((l) => l === 'heartbeat:dev1')).toHaveLength(2)
    await t.m.disable()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(t.log.filter((l) => l === 'heartbeat:dev1')).toHaveLength(2)
  })

  it('stops local access when the session was revoked', async () => {
    const t = build({
      config: null,
      deviceOverrides: { heartbeat: vi.fn(async () => { throw new AccountError('signed_out', 'x') }) }
    })
    await t.m.enable()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.log).toContain('cf.stop')
    expect(t.m.getStatus()).toMatchObject({ enabled: false })
    expect(t.m.getStatus().error).toMatch(/sign/i)
  })
})

describe('disable / reset / sign out', () => {
  it('deletes the device, stops everything and closes remote clients', async () => {
    const t = build({ config: null })
    await t.m.enable()
    t.log.length = 0
    await t.m.disable()
    expect(t.log).toEqual(['auth.stop', 'cf.stop', 'hub.close:4401', 'server.stop:4100', 'remove:dev1'])
    expect(t.saved()).toMatchObject({ enabled: false, deviceId: undefined, hostname: undefined })
    expect(t.m.getStatus()).toMatchObject({ enabled: false, tunnel: { state: 'stopped' } })
  })

  it('keeps the device id if the backend delete fails, so it can be retried', async () => {
    const t = build({ config: null, deviceOverrides: { remove: vi.fn(async () => { throw new Error('offline') }) } })
    await t.m.enable()
    await t.m.disable()
    expect(t.saved()).toMatchObject({ enabled: false, deviceId: 'dev1' })
    expect(t.m.getStatus().error).toMatch(/offline/)
  })

  it('reset forgets the device even if the delete fails', async () => {
    const t = build({ config: null, deviceOverrides: { remove: vi.fn(async () => { throw new Error('offline') }) } })
    await t.m.enable()
    await t.m.resetRemoteAccess()
    expect(t.saved()!.deviceId).toBeUndefined()
    expect(t.m.getStatus().enabled).toBe(false)
  })

  it('sign out disables remote access first, then signs out', async () => {
    const t = build({ config: null })
    await t.m.enable()
    await t.m.signOut()
    expect(t.log.indexOf('remove:dev1')).toBeGreaterThan(-1)
    expect(t.account.signOut).toHaveBeenCalled()
  })
})

describe('resume and settings', () => {
  it('shutdown() stops serving but keeps the registration enabled for the next launch', async () => {
    const t = build({ config: null })
    await t.m.enable()
    await t.m.shutdown()
    expect(t.log).toContain('cf.stop')
    expect(t.log).not.toContain('remove:dev1')
    expect(t.saved()).toMatchObject({ enabled: true, deviceId: 'dev1' })
  })

  it('resume() re-enables when previously enabled and signed in', async () => {
    const t = build({ config: { enabled: true, deviceId: 'dev1', hostname: 'h', port: 4100 }, ports: [] })
    await t.m.resume()
    expect(t.m.getStatus().enabled).toBe(true)
  })

  it('onSignedIn() turns remote access on right after an interactive sign-in', async () => {
    const t = build({ config: null })
    await t.m.onSignedIn()
    expect(t.device.register).toHaveBeenCalledOnce()
    expect(t.m.getStatus().enabled).toBe(true)
    expect(t.saved()).toMatchObject({ enabled: true, deviceId: 'dev1' })
  })

  it('onSignedIn() does nothing when signed out or already running', async () => {
    const out = build({ config: null, signedIn: false })
    await out.m.onSignedIn()
    expect(out.device.register).not.toHaveBeenCalled()
    const on = build({ config: null })
    await on.m.enable()
    await on.m.onSignedIn()
    expect(on.device.register).toHaveBeenCalledOnce()
  })

  it('resume() does nothing when not enabled or signed out', async () => {
    const a = build({ config: { enabled: false } })
    await a.m.resume()
    expect(a.log).toEqual([])
    const b = build({ config: { enabled: true }, signedIn: false })
    await b.m.resume()
    expect(b.log).toEqual([])
  })

  it('device name is validated and persisted', () => {
    const t = build({ config: null })
    expect(t.m.setDeviceName('  my laptop!  ')).toMatchObject({ ok: false })
    expect(t.m.setDeviceName('work-mac.2')).toEqual({ ok: true })
    expect(t.saved()!.deviceName).toBe('work-mac.2')
    expect(t.m.getStatus().deviceName).toBe('work-mac.2')
  })

  it('device name cannot change while enabled', async () => {
    const t = build({ config: null })
    await t.m.enable()
    expect(t.m.setDeviceName('other')).toMatchObject({ ok: false })
  })
})
