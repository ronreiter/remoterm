import { describe, it, expect } from 'vitest'
import { lastSeenLabel, remoteStatusLabel } from './remoteFormat'

describe('lastSeenLabel', () => {
  const now = 1_000_000 * 1000
  it('formats epoch seconds', () => {
    expect(lastSeenLabel(null, now)).toBe('never seen')
    expect(lastSeenLabel(1_000_000 - 5, now)).toBe('just now')
    expect(lastSeenLabel(1_000_000 - 300, now)).toBe('5 min ago')
    expect(lastSeenLabel(1_000_000 - 7200, now)).toBe('2 h ago')
    expect(lastSeenLabel(1_000_000 - 3 * 86400, now)).toBe('3 d ago')
  })
})

describe('remoteStatusLabel', () => {
  it('describes each remote tab state', () => {
    expect(remoteStatusLabel('connecting')).toBe('Connecting…')
    expect(remoteStatusLabel('offline')).toMatch(/Offline/)
    expect(remoteStatusLabel('auth', 4401)).toBe('Sign-in needed')
    expect(remoteStatusLabel('ended', 4404)).toBe('Session ended (4404)')
    expect(remoteStatusLabel('ended', undefined, 3)).toBe('Session ended (exit code 3)')
    expect(remoteStatusLabel('live')).toBe('Connected')
  })
})
