import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export type CloudflaredStatus =
  | { state: 'stopped' }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; message: string }

export const BACKOFF_INITIAL_MS = 1000
export const BACKOFF_MAX_MS = 60_000
/** After this many consecutive failures the error stays visible while retrying. */
const STICKY_ERROR_AFTER = 3

export interface CloudflaredOptions {
  binaryPath: string
  spawn?: typeof nodeSpawn
  exists?: (p: string) => boolean
  onStatus?: (s: CloudflaredStatus) => void
}

export function cloudflaredPath(o: {
  isPackaged: boolean
  resourcesPath: string
  appRoot: string
  arch: string
}): string {
  // Packaged: electron-builder extraResources copies the right arch to bin/cloudflared.
  if (o.isPackaged) return join(o.resourcesPath, 'bin', 'cloudflared')
  return join(o.appRoot, 'resources', 'bin', `cloudflared-darwin-${o.arch}`)
}

export class CloudflaredSupervisor {
  status: CloudflaredStatus = { state: 'stopped' }
  private child: ChildProcess | null = null
  private token: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private lastLine = ''
  private stderrBuf = ''

  constructor(private o: CloudflaredOptions) {}

  private set(s: CloudflaredStatus): void {
    const a = this.status
    if (a.state === s.state && (a.state !== 'error' || (s.state === 'error' && a.message === s.message))) return
    this.status = s
    this.o.onStatus?.(s)
  }

  start(token: string): void {
    this.stop()
    this.token = token
    this.failures = 0
    this.launch()
  }

  stop(): void {
    this.token = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const c = this.child
    this.child = null
    if (c) {
      c.removeAllListeners('exit')
      c.removeAllListeners('error')
      try {
        c.kill()
      } catch {
        /* already gone */
      }
    }
    this.set({ state: 'stopped' })
  }

  private launch(): void {
    if (!this.token) return
    if (!(this.o.exists ?? existsSync)(this.o.binaryPath)) {
      this.set({ state: 'error', message: 'cloudflared not installed' })
      return
    }
    this.lastLine = ''
    this.stderrBuf = ''
    this.set(this.failures >= STICKY_ERROR_AFTER ? this.status : { state: 'connecting' })
    let child: ChildProcess
    try {
      child = (this.o.spawn ?? nodeSpawn)(this.o.binaryPath, ['tunnel', '--no-autoupdate', 'run', '--token', this.token], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      this.onFailure(e instanceof Error ? e.message : String(e))
      return
    }
    this.child = child
    const onData = (buf: Buffer | string): void => this.onOutput(String(buf))
    child.stderr?.on('data', onData)
    child.stdout?.on('data', onData)
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return
      this.child = null
      if (err.code === 'ENOENT') {
        this.set({ state: 'error', message: 'cloudflared not installed' })
        return
      }
      this.onFailure(err.message)
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.onFailure(this.lastLine || `cloudflared exited with code ${code}`)
    })
  }

  private onOutput(chunk: string): void {
    this.stderrBuf += chunk
    const lines = this.stderrBuf.split(/\r?\n/)
    this.stderrBuf = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      this.lastLine = line
      if (/Registered tunnel connection/i.test(line)) {
        this.failures = 0
        this.set({ state: 'connected' })
      }
    }
  }

  private onFailure(message: string): void {
    if (!this.token) return
    this.set({ state: 'error', message })
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** this.failures)
    this.failures++
    this.timer = setTimeout(() => {
      this.timer = null
      this.launch()
    }, delay)
  }
}
