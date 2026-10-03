import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyData } from './migrate'

let root: string, appData: string, userData: string, home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remoterm-migrate-'))
  appData = join(root, 'Application Support')
  userData = join(appData, 'Remoterm')
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
})

function writeLegacy(isDev = false) {
  const dir = join(appData, 'Moltty', isDev ? 'moltty-data-dev' : 'moltty-data')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sessions.json'), '{"sessions":[1]}')
  writeFileSync(join(home, isDev ? '.moltty-dev.settings' : '.moltty.settings'), '{"codingTool":"claude"}')
}

describe('migrateLegacyData', () => {
  it('copies legacy sessions and settings when new ones are absent', () => {
    writeLegacy()
    const log = migrateLegacyData({ appData, userData, home, isDev: false })
    expect(readFileSync(join(userData, 'remoterm-data', 'sessions.json'), 'utf-8')).toBe('{"sessions":[1]}')
    expect(readFileSync(join(home, '.remoterm.settings'), 'utf-8')).toBe('{"codingTool":"claude"}')
    expect(log).toHaveLength(2)
  })

  it('keeps the legacy files in place', () => {
    writeLegacy()
    migrateLegacyData({ appData, userData, home, isDev: false })
    expect(existsSync(join(appData, 'Moltty', 'moltty-data', 'sessions.json'))).toBe(true)
    expect(existsSync(join(home, '.moltty.settings'))).toBe(true)
  })

  it('never overwrites existing Remoterm data', () => {
    writeLegacy()
    mkdirSync(join(userData, 'remoterm-data'), { recursive: true })
    writeFileSync(join(userData, 'remoterm-data', 'sessions.json'), 'NEW')
    writeFileSync(join(home, '.remoterm.settings'), 'NEW')
    const log = migrateLegacyData({ appData, userData, home, isDev: false })
    expect(readFileSync(join(userData, 'remoterm-data', 'sessions.json'), 'utf-8')).toBe('NEW')
    expect(readFileSync(join(home, '.remoterm.settings'), 'utf-8')).toBe('NEW')
    expect(log).toEqual([])
  })

  it('does nothing without legacy data', () => {
    expect(migrateLegacyData({ appData, userData, home, isDev: false })).toEqual([])
    expect(existsSync(join(home, '.remoterm.settings'))).toBe(false)
  })

  it('uses -dev paths in dev mode', () => {
    writeLegacy(true)
    migrateLegacyData({ appData, userData, home, isDev: true })
    expect(existsSync(join(userData, 'remoterm-data-dev', 'sessions.json'))).toBe(true)
    expect(existsSync(join(home, '.remoterm-dev.settings'))).toBe(true)
  })
})
