import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, parseTarget, UsageError } from '../src/args'
import { parseHost, HostError } from '../src/host'
import { loadConfig } from '../src/config'
import { deleteCredentials, readCredentials, writeCredentials } from '../src/credentials'

describe('parseArgs', () => {
  it('parses commands', () => {
    expect(parseArgs(['login']).command).toBe('login')
    expect(parseArgs(['ls']).command).toBe('ls')
    expect(parseArgs(['ssh-config']).command).toBe('ssh-config')
    expect(parseArgs(['connect', 'mac.remoterm'])).toMatchObject({ command: 'connect', positional: ['mac.remoterm'] })
    expect(parseArgs(['attach', 'mac/api', '--view'])).toMatchObject({ command: 'attach', positional: ['mac/api'], view: true })
    expect(parseArgs(['--view', 'attach', 'mac/api']).view).toBe(true)
    expect(parseArgs([]).command).toBe('help')
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['--version']).command).toBe('version')
  })
  it('rejects bad usage', () => {
    expect(() => parseArgs(['nope'])).toThrow(UsageError)
    expect(() => parseArgs(['attach'])).toThrow(UsageError)
    expect(() => parseArgs(['login', 'extra'])).toThrow(UsageError)
    expect(() => parseArgs(['ls', '--view'])).toThrow(UsageError)
    expect(() => parseArgs(['ls', '--bogus'])).toThrow(/unknown option/)
  })
  it('parses attach targets', () => {
    expect(parseTarget('my-mac/claude-api')).toEqual({ device: 'my-mac', session: 'claude-api' })
    expect(parseTarget('mac/a/b')).toEqual({ device: 'mac', session: 'a/b' })
    for (const bad of ['mac', '/x', 'mac/']) expect(() => parseTarget(bad)).toThrow(UsageError)
  })
})

describe('parseHost', () => {
  it('parses device names and tunnel hostnames', () => {
    expect(parseHost('my-mac.remoterm', 't.remoterm.io')).toEqual({ kind: 'name', name: 'my-mac' })
    expect(parseHost('My-Mac.remoterm', 't.remoterm.io')).toEqual({ kind: 'name', name: 'my-mac' })
    expect(parseHost('ab12cd.t.remoterm.io', 't.remoterm.io')).toEqual({ kind: 'id', id: 'ab12cd' })
    expect(parseHost('ab12cd.t.staging.remoterm.io', 't.staging.remoterm.io')).toEqual({ kind: 'id', id: 'ab12cd' })
  })
  it('rejects other hosts', () => {
    for (const h of ['example.com', '.remoterm', 'a.b.t.remoterm.io', 'x.t.other.io']) {
      expect(() => parseHost(h, 't.remoterm.io')).toThrow(HostError)
    }
  })
})

describe('config', () => {
  it('honors env overrides and XDG_CONFIG_HOME', () => {
    const c = loadConfig({ REMOTERM_API: 'http://localhost:8787/', REMOTERM_TUNNEL_DOMAIN: 't.staging.remoterm.io', XDG_CONFIG_HOME: '/x/cfg' })
    expect(c).toEqual({ api: 'http://localhost:8787', tunnelDomain: 't.staging.remoterm.io', credentialsPath: '/x/cfg/remoterm/credentials' })
    const d = loadConfig({ HOME: '/home/u' })
    expect(d.api).toBe('https://api.remoterm.io')
    expect(d.tunnelDomain).toBe('t.remoterm.io')
    expect(d.credentialsPath).toBe('/home/u/.config/remoterm/credentials')
  })
})

describe('credentials', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'remoterm-cred-')), 'sub', 'credentials')
  it('writes mode 0600 and round-trips', () => {
    const p = tmp()
    writeCredentials(p, { refresh_token: 'rt', api: 'https://a', login: 'octo' })
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readCredentials(p)).toEqual({ refresh_token: 'rt', api: 'https://a', login: 'octo' })
  })
  it('tightens permissions of a pre-existing file on rewrite', () => {
    const p = tmp()
    writeCredentials(p, { refresh_token: 'a', api: '' })
    chmodSync(p, 0o644)
    writeCredentials(p, { refresh_token: 'b', api: '' })
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
  it('returns null for missing/corrupt files and deletes', () => {
    const p = tmp()
    expect(readCredentials(p)).toBeNull()
    writeCredentials(p, { refresh_token: 'a', api: '' })
    writeFileSync(p, 'not json')
    expect(readCredentials(p)).toBeNull()
    expect(deleteCredentials(p)).toBe(true)
    expect(existsSync(p)).toBe(false)
    expect(deleteCredentials(p)).toBe(false)
  })
})
