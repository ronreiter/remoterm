import { describe, it, expect, afterEach } from 'vitest'
import * as nodePty from 'node-pty'
import { PtyHub, type HubClient, type PtyLike } from './ptyHub'

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function spawn(cmd = '/bin/cat', args: string[] = []): PtyLike {
  return nodePty.spawn(cmd, args, { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } })
}

class TestClient implements HubClient {
  out = ''
  snaps: { data: string; cols: number; rows: number }[] = []
  exits: number[] = []
  closed: { code: number; reason: string }[] = []
  metas: unknown[] = []
  constructor(public kind: 'local' | 'remote' = 'remote', public buffered = 0) {}
  send(data: string) {
    this.out += data
  }
  snapshot(s: { data: string; cols: number; rows: number }) {
    this.snaps.push(s)
  }
  meta(m: unknown) {
    this.metas.push(m)
  }
  exit(code: number) {
    this.exits.push(code)
  }
  bufferedAmount() {
    return this.buffered
  }
  close(code: number, reason: string) {
    this.closed.push({ code, reason })
  }
}

let hub: PtyHub
let ptys: PtyLike[] = []
afterEach(() => {
  hub?.dispose()
  for (const p of ptys) {
    try {
      p.kill()
    } catch {
      /* gone */
    }
  }
  ptys = []
})

function mk(cmd?: string, args?: string[]) {
  hub = new PtyHub()
  const p = spawn(cmd, args)
  ptys.push(p)
  const s = hub.create('s1', p)
  return { p, s }
}

describe('PtyHub', () => {
  it('delivers live output to local clients immediately', async () => {
    const { s } = mk()
    const local = new TestClient('local')
    const h = hub.attach('s1', local, 'control')!
    h.write('hello\n')
    await until(() => local.out.includes('hello'))
    expect(local.snaps).toHaveLength(0)
    expect(s.cols).toBe(80)
  })

  it('sends a snapshot of prior output to a late remote client, then streams', async () => {
    mk()
    const local = new TestClient('local')
    const lh = hub.attach('s1', local, 'control')!
    lh.write('before-attach\n')
    await until(() => local.out.includes('before-attach'))
    await new Promise((r) => setTimeout(r, 50))

    const remote = new TestClient()
    const rh = hub.attach('s1', remote, 'control')!
    expect(remote.snaps).toHaveLength(1)
    expect(remote.snaps[0].data).toContain('before-attach')
    expect(remote.snaps[0].cols).toBe(80)
    expect(remote.out).toBe('')

    rh.write('after-attach\n')
    await until(() => remote.out.includes('after-attach'))
    expect(remote.out).not.toContain('before-attach')
    expect(local.out).toContain('after-attach')
  })

  it('keeps only 1000 lines of scrollback in the mirror', async () => {
    mk('/bin/bash', ['-c', 'for i in $(seq 1 3000); do echo line-$i; done; sleep 5'])
    await until(() => {
      const r = new TestClient()
      const h = hub.attach('s1', r, 'view')!
      const ok = r.snaps[0].data.includes('line-3000')
      h.detach()
      return ok
    })
    const r = new TestClient()
    hub.attach('s1', r, 'view')
    const d = r.snaps[0].data
    expect(d).toContain('line-3000')
    expect(d).not.toContain('line-1\r')
    expect(d).not.toContain('line-1000\r')
    expect(d.split('\n').length).toBeLessThan(1200)
  })

  it('view clients cannot write or resize', async () => {
    const { p } = mk()
    const view = new TestClient()
    const vh = hub.attach('s1', view, 'view')!
    vh.write('secret\n')
    vh.resize(200, 50)
    await new Promise((r) => setTimeout(r, 150))
    expect(view.out).not.toContain('secret')
    expect(p.cols).toBe(80)
    expect(hub.info('s1')).toMatchObject({ cols: 80, rows: 24 })
  })

  it('resize follows the client that most recently sent input, focus or resize', async () => {
    const { p } = mk()
    const a = new TestClient()
    const b = new TestClient()
    const ha = hub.attach('s1', a, 'control')!
    const hb = hub.attach('s1', b, 'control')!
    ha.resize(100, 30)
    expect([p.cols, p.rows]).toEqual([100, 30])
    hb.resize(90, 20)
    expect([p.cols, p.rows]).toEqual([90, 20])
    ha.focus()
    expect([p.cols, p.rows]).toEqual([100, 30])
    hb.write('x')
    expect([p.cols, p.rows]).toEqual([90, 20])
    expect(hub.info('s1')).toMatchObject({ cols: 90, rows: 20 })
    // the other remote client learns of the new size through a fresh snapshot
    await until(() => a.snaps.at(-1)?.cols === 90)
    expect(a.snaps.at(-1)).toMatchObject({ cols: 90, rows: 20 })
  })

  it('closes a client whose buffer exceeds 1MB with 4408 and detaches it', async () => {
    mk()
    const slow = new TestClient('remote', 2 * 1024 * 1024)
    const fast = new TestClient()
    hub.attach('s1', slow, 'control')
    const fh = hub.attach('s1', fast, 'control')!
    fh.write('ping\n')
    await until(() => fast.out.includes('ping'))
    expect(slow.closed).toEqual([{ code: 4408, reason: 'client too slow' }])
    expect(slow.out).toBe('')
    expect(hub.remoteCount('s1')).toBe(1)
  })

  it('broadcasts exit and removes the session', async () => {
    mk('/bin/bash', ['-c', 'sleep 0.2; exit 3'])
    const r = new TestClient()
    hub.attach('s1', r, 'view')
    await until(() => r.exits.length === 1)
    expect(r.exits[0]).toBe(3)
    expect(hub.has('s1')).toBe(false)
    expect(hub.attach('s1', new TestClient(), 'view')).toBeNull()
  })

  it('reports remote viewer counts and busy meta', async () => {
    mk()
    const counts: [string, number][] = []
    hub.onRemoteCount((id, n) => counts.push([id, n]))
    const local = new TestClient('local')
    hub.attach('s1', local, 'control')
    expect(counts).toEqual([])
    const r1 = new TestClient()
    const h1 = hub.attach('s1', r1, 'view')!
    const r2 = new TestClient()
    hub.attach('s1', r2, 'control')
    h1.detach()
    expect(counts).toEqual([['s1', 1], ['s1', 2], ['s1', 1]])
    hub.setBusy('s1', true)
    expect(r2.metas).toEqual([{ busy: true }])
    expect(hub.info('s1')?.busy).toBe(true)
    hub.closeRemoteClients(4401, 'x')
    expect(r2.closed).toHaveLength(1)
    expect(hub.remoteCount('s1')).toBe(0)
  })
})
