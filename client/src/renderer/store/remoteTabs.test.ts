import { describe, it, expect, beforeEach, vi } from 'vitest'

const calls: any[] = []
let saved: any = null
let disk: any = null
;(globalThis as any).window = {
  electronAPI: {
    loadSessions: async () => disk,
    loadSettings: async () => ({ codingTool: 'claude', loadZshrc: true }),
    saveSessions: async (d: string) => void (saved = JSON.parse(d)),
    saveSettings: async () => {},
    killLocalPty: vi.fn(async (id: string) => void calls.push(['kill', id]))
  }
}

const { useStore, isRemoteSession } = await import('./index')

const target = { deviceId: 'd1', sessionId: 's1', deviceName: 'studio', name: 'api work' }
const reset = () =>
  useStore.setState({
    sessions: [],
    openTabs: [],
    activeSessionId: null,
    remoteTabs: {},
    restoredRemoteIds: new Set(),
    hydrated: false
  })

beforeEach(() => {
  calls.length = 0
  saved = null
  disk = null
  reset()
})

describe('remote tabs in the store', () => {
  it('opens a remote tab as an active session of kind remote', () => {
    const id = useStore.getState().openRemoteTab(target)
    const s = useStore.getState()
    expect(s.activeSessionId).toBe(id)
    expect(s.openTabs).toEqual([id])
    expect(s.sessions[0]).toMatchObject({ id, name: 'api work', kind: 'remote', status: 'open', remote: { deviceId: 'd1', sessionId: 's1', deviceName: 'studio' } })
    expect(isRemoteSession(s.sessions[0])).toBe(true)
  })

  it('re-opening the same remote session focuses the existing tab', () => {
    const id = useStore.getState().openRemoteTab(target)
    const other = useStore.getState().openRemoteTab({ ...target, sessionId: 's2' })
    expect(other).not.toBe(id)
    expect(useStore.getState().openRemoteTab(target)).toBe(id)
    expect(useStore.getState().sessions).toHaveLength(2)
    expect(useStore.getState().activeSessionId).toBe(id)
  })

  it('closing a remote tab forgets it and never touches the local PTY API', () => {
    const id = useStore.getState().openRemoteTab(target)
    useStore.getState().setRemoteMode(id, 'view')
    useStore.getState().closeTab(id)
    const s = useStore.getState()
    expect(s.sessions).toEqual([])
    expect(s.openTabs).toEqual([])
    expect(s.remoteTabs[id]).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('mode defaults to control and can be toggled', () => {
    const id = useStore.getState().openRemoteTab(target)
    useStore.getState().applyRemoteStatus(id, { status: 'connecting' })
    expect(useStore.getState().remoteTabs[id].mode).toBe('control')
    useStore.getState().setRemoteMode(id, 'view')
    expect(useStore.getState().remoteTabs[id].mode).toBe('view')
  })

  it('tracks status, close code and exit code', () => {
    const id = useStore.getState().openRemoteTab(target)
    useStore.getState().applyRemoteStatus(id, { status: 'live' })
    expect(useStore.getState().remoteTabs[id]).toMatchObject({ status: 'live', everLive: true })
    useStore.getState().applyRemoteStatus(id, { status: 'ended', code: 4404 })
    expect(useStore.getState().remoteTabs[id]).toMatchObject({ status: 'ended', code: 4404, everLive: true })
    useStore.getState().applyRemoteStatus(id, { status: 'ended', exitCode: 3 })
    expect(useStore.getState().remoteTabs[id]).toMatchObject({ exitCode: 3 })
  })

  it('a freshly opened tab whose session is gone stays visible as ended', () => {
    const id = useStore.getState().openRemoteTab(target)
    useStore.getState().applyRemoteStatus(id, { status: 'ended', code: 4404 })
    expect(useStore.getState().sessions).toHaveLength(1)
    expect(useStore.getState().remoteTabs[id].status).toBe('ended')
  })
})

describe('persistence as reattach entries', () => {
  const local = { id: 'L', name: 'local', status: 'open', createdAt: '' }
  const remote = (id: string) => ({
    id,
    name: 'r',
    status: 'open',
    kind: 'remote',
    remote: { deviceId: 'd1', sessionId: id, deviceName: 'studio' },
    createdAt: ''
  })

  it('restores open remote tabs, drops closed ones, and marks restored ones', async () => {
    disk = {
      sessions: [local, remote('R1'), remote('R2')],
      openTabs: ['L', 'R1'],
      activeSessionId: 'R1',
      folders: []
    }
    await useStore.getState().hydrate()
    const s = useStore.getState()
    expect(s.sessions.map((x) => x.id).sort()).toEqual(['L', 'R1'])
    expect(s.openTabs).toEqual(['L', 'R1'])
    expect(s.activeSessionId).toBe('R1')
    expect(s.restoredRemoteIds.has('R1')).toBe(true)
    expect(s.sessions.find((x) => x.id === 'R1')).toMatchObject({ kind: 'remote', status: 'open' })
  })

  it('drops a restored remote tab quietly when the session is gone (4404 before live)', async () => {
    disk = { sessions: [local, remote('R1')], openTabs: ['L', 'R1'], activeSessionId: 'R1', folders: [] }
    await useStore.getState().hydrate()
    useStore.getState().applyRemoteStatus('R1', { status: 'ended', code: 4404 })
    const s = useStore.getState()
    expect(s.sessions.map((x) => x.id)).toEqual(['L'])
    expect(s.openTabs).toEqual(['L'])
    expect(s.activeSessionId).toBe('L')
    expect(saved.sessions.map((x: any) => x.id)).toEqual(['L'])
  })

  it('keeps a restored tab that attached live and later ended, and tolerates offline / sign-in needed', async () => {
    disk = { sessions: [remote('R1'), remote('R2')], openTabs: ['R1', 'R2'], activeSessionId: 'R1', folders: [] }
    await useStore.getState().hydrate()
    useStore.getState().applyRemoteStatus('R1', { status: 'live' })
    useStore.getState().applyRemoteStatus('R1', { status: 'ended', code: 4404 })
    useStore.getState().applyRemoteStatus('R2', { status: 'offline' })
    useStore.getState().applyRemoteStatus('R2', { status: 'auth', code: 4401 })
    expect(useStore.getState().sessions.map((x) => x.id).sort()).toEqual(['R1', 'R2'])
  })

  it('saves remote tabs with their target so they can be reattached', async () => {
    disk = { sessions: [], openTabs: [], activeSessionId: null, folders: [] }
    await useStore.getState().hydrate()
    useStore.getState().openRemoteTab(target)
    const r = saved.sessions[0]
    expect(r).toMatchObject({ kind: 'remote', remote: { deviceId: 'd1', sessionId: 's1', deviceName: 'studio' } })
    expect(saved.openTabs).toEqual([r.id])
  })
})
