import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { CloudflaredSupervisor, cloudflaredPath, type CloudflaredStatus } from './cloudflared'

class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  stdout = new EventEmitter()
  killed = false
  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

let children: FakeChild[]
let spawnCalls: { cmd: string; args: string[] }[]
let statuses: CloudflaredStatus[]

function make(over: { exists?: boolean } = {}) {
  const sup = new CloudflaredSupervisor({
    binaryPath: '/x/cloudflared',
    exists: () => over.exists ?? true,
    spawn: ((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
      const c = new FakeChild()
      children.push(c)
      return c
    }) as never,
    onStatus: (s) => statuses.push(s)
  })
  return sup
}

const crash = (c: FakeChild, code = 1) => c.emit('exit', code, null)

beforeEach(() => {
  vi.useFakeTimers()
  children = []
  spawnCalls = []
  statuses = []
})
afterEach(() => vi.useRealTimers())

describe('CloudflaredSupervisor', () => {
  it('spawns `tunnel --no-autoupdate run --token T` and reports connecting', () => {
    const s = make()
    s.start('TOKEN')
    expect(spawnCalls).toEqual([
      { cmd: '/x/cloudflared', args: ['tunnel', '--no-autoupdate', 'run', '--token', 'TOKEN'] }
    ])
    expect(s.status).toEqual({ state: 'connecting' })
  })

  it('becomes connected when a tunnel connection registers', () => {
    const s = make()
    s.start('T')
    children[0].stderr.emit('data', Buffer.from('INF Starting tunnel\nINF Registered tunnel connection connIndex=0\n'))
    expect(s.status).toEqual({ state: 'connected' })
  })

  it('restarts with exponential backoff 1s -> 60s and shows the last stderr line', () => {
    const s = make()
    s.start('T')
    const delays: number[] = []
    for (let i = 0; i < 9; i++) {
      children.at(-1)!.stderr.emit('data', Buffer.from(`ERR failure ${i}\n`))
      const before = children.length
      crash(children.at(-1)!)
      expect(s.status).toEqual({ state: 'error', message: `failure ${i}`.replace(/^/, 'ERR ') })
      // find the delay by stepping time until the supervisor respawns
      let waited = 0
      while (children.length === before) {
        vi.advanceTimersByTime(500)
        waited += 500
        if (waited > 120_000) throw new Error('never restarted')
      }
      delays.push(waited)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
  })

  it('resets the backoff once connected', () => {
    const s = make()
    s.start('T')
    crash(children[0])
    vi.advanceTimersByTime(1000)
    crash(children[1])
    vi.advanceTimersByTime(2000)
    expect(children).toHaveLength(3)
    children[2].stderr.emit('data', Buffer.from('INF Registered tunnel connection\n'))
    crash(children[2])
    vi.advanceTimersByTime(999)
    expect(children).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(4)
  })

  it('keeps reporting error while flapping, until connected', () => {
    const s = make()
    s.start('T')
    for (let i = 0; i < 4; i++) {
      children.at(-1)!.stderr.emit('data', Buffer.from('boom\n'))
      crash(children.at(-1)!)
      vi.advanceTimersByTime(60_000)
    }
    expect(s.status).toMatchObject({ state: 'error', message: 'boom' })
    children.at(-1)!.stderr.emit('data', Buffer.from('Registered tunnel connection\n'))
    expect(s.status).toEqual({ state: 'connected' })
  })

  it('stop() kills the child and does not restart', () => {
    const s = make()
    s.start('T')
    s.stop()
    expect(children[0].killed).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(children).toHaveLength(1)
    expect(s.status).toEqual({ state: 'stopped' })
  })

  it('reports "cloudflared not installed" when the binary is missing and does not loop', () => {
    const s = make({ exists: false })
    s.start('T')
    expect(s.status).toEqual({ state: 'error', message: 'cloudflared not installed' })
    vi.advanceTimersByTime(120_000)
    expect(spawnCalls).toHaveLength(0)
  })

  it('treats a spawn ENOENT error the same way', () => {
    const s = make()
    s.start('T')
    children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    expect(s.status).toEqual({ state: 'error', message: 'cloudflared not installed' })
    vi.advanceTimersByTime(120_000)
    expect(spawnCalls).toHaveLength(1)
  })

  it('uses an exit-code message when the process printed nothing', () => {
    const s = make()
    s.start('T')
    crash(children[0], 2)
    expect(s.status).toEqual({ state: 'error', message: 'cloudflared exited with code 2' })
  })

  it('notifies status listeners only on change', () => {
    const s = make()
    s.start('T')
    children[0].stderr.emit('data', Buffer.from('Registered tunnel connection\n'))
    children[0].stderr.emit('data', Buffer.from('Registered tunnel connection\n'))
    expect(statuses).toEqual([{ state: 'connecting' }, { state: 'connected' }])
  })
})

describe('cloudflaredPath', () => {
  it('resolves packaged and dev locations', () => {
    expect(cloudflaredPath({ isPackaged: true, resourcesPath: '/App/Resources', appRoot: '/dev', arch: 'arm64' })).toBe(
      '/App/Resources/bin/cloudflared'
    )
    expect(cloudflaredPath({ isPackaged: false, resourcesPath: '/App/Resources', appRoot: '/dev/client', arch: 'x64' })).toBe(
      '/dev/client/resources/bin/cloudflared-darwin-x64'
    )
  })
})
