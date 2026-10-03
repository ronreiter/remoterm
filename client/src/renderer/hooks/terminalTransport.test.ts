import { describe, it, expect, vi } from 'vitest'
import {
  createLocalTransport,
  createRemoteTransport,
  type LocalApi,
  type RemoteApi,
  type TransportHandlers
} from './terminalTransport'
import type { RemoteTabOutputEvent, RemoteTabStatusEvent } from '../services/api'

const handlers = (): TransportHandlers & { calls: any[] } => {
  const calls: any[] = []
  return {
    calls,
    onReady: () => calls.push(['ready']),
    onData: (d) => calls.push(['data', d]),
    onSnapshot: (s) => calls.push(['snapshot', s]),
    onExit: (c) => calls.push(['exit', c]),
    onStatus: (s) => calls.push(['status', s]),
    onError: (m) => calls.push(['error', m])
  }
}

function localApi() {
  const out: ((sid: string, d: string) => void)[] = []
  const exit: ((sid: string, c: number) => void)[] = []
  const calls: any[] = []
  const api: LocalApi = {
    onLocalPtyOutput: (cb) => (out.push(cb), () => out.splice(out.indexOf(cb), 1)),
    onLocalPtyExit: (cb) => (exit.push(cb), () => exit.splice(exit.indexOf(cb), 1)),
    sendLocalPtyInput: (...a) => calls.push(['input', ...a]),
    resizeLocalPty: (...a) => calls.push(['resize', ...a]),
    killLocalPty: async (...a) => void calls.push(['kill', ...a])
  }
  return { api, out, exit, calls }
}

function remoteApi() {
  const out: ((e: RemoteTabOutputEvent) => void)[] = []
  const st: ((e: RemoteTabStatusEvent) => void)[] = []
  const calls: any[] = []
  const api: RemoteApi = {
    remoteAttach: async (r) => void calls.push(['attach', r]),
    remoteTabInput: (...a) => calls.push(['input', ...a]),
    remoteTabResize: (...a) => calls.push(['resize', ...a]),
    remoteDetach: (...a) => calls.push(['detach', ...a]),
    onRemoteTabOutput: (cb) => (out.push(cb), () => out.splice(out.indexOf(cb), 1)),
    onRemoteTabStatus: (cb) => (st.push(cb), () => st.splice(st.indexOf(cb), 1))
  }
  return { api, out, st, calls }
}

describe('local transport', () => {
  it('spawns, reports readiness on first output for its own session only, and forwards exit', async () => {
    const l = localApi()
    const h = handlers()
    const spawn = vi.fn(async () => ({ ok: true }))
    const t = createLocalTransport('s1', l.api, spawn)
    expect(t.kind).toBe('local')
    t.connect(h, { cols: 90, rows: 30 })
    await Promise.resolve()
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(l.calls).toContainEqual(['resize', 's1', 90, 30])

    l.out[0]('other', 'nope')
    l.out[0]('s1', 'a')
    l.out[0]('s1', 'b')
    expect(h.calls).toEqual([['ready'], ['data', 'a'], ['data', 'b']])
    l.exit[0]('s1', 2)
    expect(h.calls.at(-1)).toEqual(['exit', 2])
  })

  it('reattached PTYs are ready immediately; spawn failures surface as errors', async () => {
    const l = localApi()
    const h = handlers()
    createLocalTransport('s1', l.api, async () => ({ ok: true, reattached: true })).connect(h, { cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.calls).toEqual([['ready']])

    const h2 = handlers()
    createLocalTransport('s2', l.api, async () => ({ ok: false, error: 'nope' })).connect(h2, { cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 0))
    expect(h2.calls).toEqual([['error', 'nope']])
  })

  it('writes, resizes, disposes listeners and kills only on end()', () => {
    const l = localApi()
    const t = createLocalTransport('s1', l.api, async () => ({ ok: true }))
    t.connect(handlers(), { cols: 80, rows: 24 })
    t.write('x')
    t.resize(100, 40)
    t.dispose()
    expect(l.out).toHaveLength(0)
    expect(l.calls).not.toContainEqual(['kill', 's1'])
    t.end()
    expect(l.calls).toEqual(expect.arrayContaining([['input', 's1', 'x'], ['resize', 's1', 100, 40], ['kill', 's1']]))
  })
})

describe('remote transport', () => {
  it('attaches with the current mode and never touches the local PTY API', () => {
    const r = remoteApi()
    const t = createRemoteTransport('tab1', { deviceId: 'd1', sessionId: 'x' }, () => 'control', r.api)
    expect(t.kind).toBe('remote')
    t.connect(handlers(), { cols: 80, rows: 24 })
    expect(r.calls).toEqual([['attach', { tabId: 'tab1', deviceId: 'd1', sessionId: 'x', mode: 'control' }]])
  })

  it('routes snapshots and output for its tab only; readiness fires once', () => {
    const r = remoteApi()
    const h = handlers()
    createRemoteTransport('tab1', { deviceId: 'd1', sessionId: 'x' }, () => 'control', r.api).connect(h, { cols: 80, rows: 24 })
    r.out[0]({ tabId: 'tab2', kind: 'data', data: new Uint8Array([1]) })
    r.out[0]({ tabId: 'tab1', kind: 'snapshot', data: 'S', cols: 100, rows: 30 })
    r.out[0]({ tabId: 'tab1', kind: 'data', data: new Uint8Array([65]) })
    r.out[0]({ tabId: 'tab1', kind: 'snapshot', data: 'S2', cols: 90, rows: 20 })
    expect(h.calls).toEqual([
      ['ready'],
      ['snapshot', { data: 'S', cols: 100, rows: 30 }],
      ['data', new Uint8Array([65])],
      ['snapshot', { data: 'S2', cols: 90, rows: 20 }]
    ])
  })

  it('forwards status events for its tab', () => {
    const r = remoteApi()
    const h = handlers()
    createRemoteTransport('tab1', { deviceId: 'd1', sessionId: 'x' }, () => 'control', r.api).connect(h, { cols: 80, rows: 24 })
    r.st[0]({ tabId: 'tab2', status: 'live' })
    r.st[0]({ tabId: 'tab1', status: 'ended', code: 4404 })
    expect(h.calls).toEqual([['status', { tabId: 'tab1', status: 'ended', code: 4404 }]])
  })

  it('drops input and resize in view mode, sends them in control mode; reconnect uses the new mode', () => {
    const r = remoteApi()
    let mode: 'control' | 'view' = 'view'
    const t = createRemoteTransport('tab1', { deviceId: 'd1', sessionId: 'x' }, () => mode, r.api)
    t.connect(handlers(), { cols: 80, rows: 24 })
    t.write('a')
    t.resize(10, 10)
    expect(r.calls.filter((c) => c[0] !== 'attach')).toEqual([])
    mode = 'control'
    t.reconnect()
    t.write('b')
    t.resize(120, 40)
    expect(r.calls).toEqual([
      ['attach', { tabId: 'tab1', deviceId: 'd1', sessionId: 'x', mode: 'view' }],
      ['attach', { tabId: 'tab1', deviceId: 'd1', sessionId: 'x', mode: 'control' }],
      ['input', 'tab1', 'b'],
      ['resize', 'tab1', 120, 40]
    ])
  })

  it('dispose stops listening; end detaches the remote session', () => {
    const r = remoteApi()
    const t = createRemoteTransport('tab1', { deviceId: 'd1', sessionId: 'x' }, () => 'control', r.api)
    t.connect(handlers(), { cols: 80, rows: 24 })
    t.dispose()
    expect(r.out).toHaveLength(0)
    expect(r.st).toHaveLength(0)
    expect(r.calls.some((c) => c[0] === 'detach')).toBe(false)
    t.end()
    expect(r.calls.at(-1)).toEqual(['detach', 'tab1'])
  })
})
