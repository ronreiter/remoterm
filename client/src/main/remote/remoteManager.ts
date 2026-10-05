import { CloseCode } from '@remoterm/protocol'
import type { AccountState } from './account'
import { AccountError } from './account'
import type { CloudflaredStatus } from './cloudflared'
import { DeviceApiError, type Registration } from './device'

export interface RemoteConfig {
  enabled: boolean
  deviceId?: string
  hostname?: string
  port?: number
  deviceName: string
  preventSleep: boolean
}

export interface RemoteStatus {
  signedIn: boolean
  login?: string
  enabled: boolean
  /** True while enabling/disabling. */
  busy: boolean
  deviceName: string
  deviceId?: string
  hostname?: string
  port?: number
  tunnel: CloudflaredStatus
  preventSleep: boolean
  error?: string
}

export interface ConfigStore {
  load(): RemoteConfig | null
  save(c: RemoteConfig): void
}

interface DeviceLike {
  register(name: string, port: number): Promise<Registration>
  updatePort(id: string, port: number): Promise<void>
  getTunnelToken(id: string): Promise<string>
  heartbeat(id: string): Promise<void>
  remove(id: string): Promise<void>
}

interface ServerLike {
  port: number
  start(): Promise<number>
  stop(): Promise<void>
}

interface AuthLike {
  start(): void
  stop(): void
}

interface CloudflaredLike {
  status: CloudflaredStatus
  start(token: string): void
  stop(): void
}

export interface RemoteManagerDeps {
  account: { state: AccountState; signOut(): void }
  device: DeviceLike
  hub: { closeRemoteClients(code: number, reason: string): void }
  store: ConfigStore
  pickPort(preferred: number | undefined): Promise<number>
  createServer(port: number, auth: AuthLike): ServerLike
  /** The device id is resolved lazily: it is only known after registration. */
  createAuth(getDeviceId: () => string): AuthLike
  createCloudflared(onStatus: (s: CloudflaredStatus) => void): CloudflaredLike
  power: { start(): number; stop(id: number): void }
  defaultDeviceName(): string
  onStatus(s: RemoteStatus): void
  heartbeatMs?: number
}

export const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** The tunnel provider is an implementation detail: raw connector output goes to logs only. */
function userFacingTunnel(s: CloudflaredStatus): CloudflaredStatus {
  if (s.state !== 'error') return s
  if (/not installed/i.test(s.message)) return { state: 'error', message: 'Remote access component is missing. Reinstall Remoterm.' }
  return { state: 'error', message: 'Connection lost. Retrying…' }
}

function describeError(e: unknown): string {
  if (e instanceof DeviceApiError) {
    switch (e.code) {
      case 'device_limit':
        return 'You already have 5 devices registered. Remove one before adding this Mac.'
      case 'name_taken':
        return 'A device with this name already exists. Choose another device name.'
      case 'provisioning_failed':
      case 'cloudflare_error': // older API versions
        return 'Could not set up remote access. Try again in a moment.'
      default:
        return e.message
    }
  }
  if (e instanceof AccountError && e.code === 'signed_out') return 'Signed out. Sign in again.'
  return e instanceof Error ? e.message : String(e)
}

/** Orchestrates sign-in state, device registration, the agent server and cloudflared. */
export class RemoteManager {
  private cfg: RemoteConfig
  private busy = false
  private error: string | undefined
  private running: { server: ServerLike; auth: AuthLike; heartbeat: ReturnType<typeof setInterval> } | null = null
  private blocker: number | null = null
  private cloudflared: CloudflaredLike
  private tunnel: CloudflaredStatus = { state: 'stopped' }
  private op: Promise<unknown> = Promise.resolve()

  constructor(private d: RemoteManagerDeps) {
    const saved = d.store.load()
    this.cfg = { enabled: false, deviceName: d.defaultDeviceName(), preventSleep: false, ...saved }
    this.cloudflared = d.createCloudflared((s) => {
      if (s.state === 'error') console.error('REMOTE_TUNNEL_ERROR:', s.message)
      this.tunnel = s
      this.emit()
    })
  }

  getStatus(): RemoteStatus {
    return {
      signedIn: this.d.account.state.signedIn,
      login: this.d.account.state.login,
      enabled: this.cfg.enabled,
      busy: this.busy,
      deviceName: this.cfg.deviceName,
      deviceId: this.cfg.deviceId,
      hostname: this.cfg.hostname,
      port: this.cfg.port,
      tunnel: userFacingTunnel(this.tunnel),
      preventSleep: this.cfg.preventSleep,
      error: this.error
    }
  }

  /** Call when the account state changed (sign in/out). */
  notifyAccountChanged(): void {
    this.emit()
  }

  private emit(): void {
    this.d.onStatus(this.getStatus())
  }

  private save(): void {
    this.d.store.save({ ...this.cfg })
  }

  /** Operations are serialized so toggling quickly cannot interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.op.then(fn, fn)
    this.op = p.catch(() => undefined)
    return p
  }

  /** On app start: bring remote access back up if it was on. */
  async resume(): Promise<void> {
    if (this.cfg.enabled && this.d.account.state.signedIn) await this.enable()
  }

  /** After an interactive sign-in: the user signed in to go remote, so turn it on. */
  async onSignedIn(): Promise<void> {
    if (!this.d.account.state.signedIn || this.running) return
    await this.enable()
  }

  enable(): Promise<void> {
    return this.serial(() => this.doEnable())
  }

  disable(): Promise<void> {
    return this.serial(() => this.doDisable(false))
  }

  resetRemoteAccess(): Promise<void> {
    return this.serial(() => this.doDisable(true))
  }

  /** App quit: stop serving but keep the registration and `enabled` so the next launch resumes. */
  async shutdown(): Promise<void> {
    await this.serial(() => this.stopLocal())
  }

  async signOut(): Promise<void> {
    await this.serial(() => this.doDisable(false))
    this.d.account.signOut()
    this.emit()
  }

  setDeviceName(name: string): { ok: true } | { ok: false; error: string } {
    if (this.cfg.enabled) return { ok: false, error: 'Turn off remote access to rename this device' }
    if (!DEVICE_NAME_RE.test(name)) return { ok: false, error: 'Use letters, digits, dots, dashes and underscores (max 40)' }
    this.cfg.deviceName = name
    this.save()
    this.emit()
    return { ok: true }
  }

  setPreventSleep(on: boolean): void {
    this.cfg.preventSleep = on
    this.save()
    this.applyBlocker()
    this.emit()
  }

  private applyBlocker(): void {
    const want = this.cfg.enabled && this.cfg.preventSleep && this.running !== null
    if (want && this.blocker === null) this.blocker = this.d.power.start()
    if (!want && this.blocker !== null) {
      this.d.power.stop(this.blocker)
      this.blocker = null
    }
  }

  private async startServer(preferred: number | undefined, auth: AuthLike): Promise<ServerLike> {
    let pref = preferred
    for (let attempt = 0; ; attempt++) {
      const port = await this.d.pickPort(pref)
      const server = this.d.createServer(port, auth)
      try {
        await server.start()
        return server
      } catch (e) {
        // Lost a race for the port: pick another.
        if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' && attempt < 3) {
          pref = undefined
          continue
        }
        throw e
      }
    }
  }

  private async doEnable(): Promise<void> {
    if (this.running) return
    console.log('REMOTE_ENABLE: start')
    this.error = undefined
    if (!this.d.account.state.signedIn) {
      this.error = 'Sign in first'
      console.warn('REMOTE_ENABLE: not signed in')
      this.emit()
      return
    }
    this.busy = true
    this.emit()
    let server: ServerLike | null = null
    let auth: AuthLike | null = null
    try {
      // The server is bound first so the port we register is known to be free.
      auth = this.d.createAuth(() => this.cfg.deviceId ?? '')
      server = await this.startServer(this.cfg.port, auth)
      const port = server.port
      let token: string
      let reg: Registration | null = null

      if (this.cfg.deviceId) {
        try {
          if (port !== this.cfg.port) await this.d.device.updatePort(this.cfg.deviceId, port)
          token = await this.d.device.getTunnelToken(this.cfg.deviceId)
        } catch (e) {
          // Tunnel/device deleted remotely: register again, once.
          if (e instanceof DeviceApiError && e.status === 404) {
            reg = await this.d.device.register(this.cfg.deviceName, port)
            token = reg.tunnelToken
          } else throw e
        }
      } else {
        reg = await this.d.device.register(this.cfg.deviceName, port)
        token = reg.tunnelToken
      }
      if (reg) {
        this.cfg.deviceId = reg.deviceId
        this.cfg.hostname = reg.hostname
      }
      this.cfg.port = server.port
      this.cfg.enabled = true
      this.save()

      const heartbeat = setInterval(() => void this.beat(), this.d.heartbeatMs ?? 60_000)
      ;(heartbeat as { unref?: () => void }).unref?.()
      auth.start()
      this.running = { server, auth, heartbeat }
      this.cloudflared.start(token)
      this.applyBlocker()
    } catch (e) {
      auth?.stop()
      await server?.stop().catch(() => undefined)
      this.cfg.enabled = false
      this.save()
      this.error = describeError(e)
      console.error('REMOTE_ENABLE_FAILED:', e)
    } finally {
      this.busy = false
      this.emit()
    }
  }

  private async beat(): Promise<void> {
    const id = this.cfg.deviceId
    if (!id || !this.running) return
    try {
      await this.d.device.heartbeat(id)
    } catch (e) {
      if (e instanceof AccountError && e.code === 'signed_out') {
        await this.serial(async () => {
          await this.stopLocal()
          this.cfg.enabled = false
          this.save()
          this.error = 'Signed out. Sign in again to turn remote access back on.'
          this.emit()
        })
      } else if (e instanceof DeviceApiError && e.status === 404) {
        // Device removed server-side: register once more.
        await this.serial(async () => {
          await this.stopLocal()
          this.cfg.deviceId = undefined
          this.cfg.hostname = undefined
          this.cfg.enabled = false
          this.save()
          await this.doEnable()
        })
      }
      // other errors (offline): try again next tick
    }
  }

  private async stopLocal(): Promise<void> {
    const r = this.running
    this.running = null
    if (r) {
      clearInterval(r.heartbeat)
      r.auth.stop()
    }
    this.cloudflared.stop()
    this.d.hub.closeRemoteClients(CloseCode.Unauthorized, 'remote access disabled')
    await r?.server.stop().catch(() => undefined)
    this.applyBlocker()
  }

  private async doDisable(forget: boolean): Promise<void> {
    this.error = undefined
    this.busy = true
    this.emit()
    try {
      await this.stopLocal()
      this.cfg.enabled = false
      const id = this.cfg.deviceId
      if (id) {
        try {
          await this.d.device.remove(id)
          this.cfg.deviceId = undefined
          this.cfg.hostname = undefined
        } catch (e) {
          this.error = `Could not remove this Mac from your account: ${describeError(e)}`
          if (forget) {
            this.cfg.deviceId = undefined
            this.cfg.hostname = undefined
          }
        }
      }
      this.save()
    } finally {
      this.busy = false
      this.emit()
    }
  }
}
