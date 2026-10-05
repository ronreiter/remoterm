import { spawn } from 'child_process'
import type { SessionInfo } from '@remoterm/protocol'
import { Api, CliError, fetchSessions, pollDeviceToken, startDeviceLogin, type FetchLike } from './api'
import type { Config } from './config'
import { deleteCredentials, readCredentials, writeCredentials } from './credentials'

export interface Ctx {
  config: Config
  out: (s: string) => void
  err: (s: string) => void
  fetch: FetchLike
  openBrowser: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  /** ANSI styling (set for TTYs without NO_COLOR). */
  color?: boolean
}

function styler(on: boolean | undefined) {
  const w = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s)
  return { bold: w('1'), dim: w('2'), green: w('32'), cyan: w('36') }
}

export function tunnelOrigin(deviceId: string, tunnelDomain: string): string {
  return `https://${deviceId}.${tunnelDomain}`
}

export function openBrowserDefault(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
    p.on('error', () => undefined) // no browser available: the URL is printed anyway
    p.unref()
  } catch {
    /* ignore */
  }
}

/** Builds an authenticated API client from stored credentials. */
export function apiFromCredentials(ctx: Ctx): Api {
  const creds = readCredentials(ctx.config.credentialsPath)
  if (!creds) throw new CliError('not logged in; run `remoterm login`')
  if (creds.api && creds.api !== ctx.config.api) {
    throw new CliError(`stored credentials are for ${creds.api}, but REMOTERM_API is ${ctx.config.api}; run \`remoterm login\``)
  }
  return new Api(ctx.config.api, creds.refresh_token, ctx.fetch)
}

export async function login(ctx: Ctx): Promise<void> {
  const start = await startDeviceLogin(ctx.config.api, ctx.fetch)
  const url = `${start.verification_uri}?code=${encodeURIComponent(start.user_code)}`
  const st = styler(ctx.color)
  ctx.out(
    `\n  ${st.bold('Sign in to Remoterm')}\n\n` +
      `  Your code:  ${st.bold(st.cyan(start.user_code))}\n\n` +
      `  ${st.dim('Opening')} ${url}\n` +
      `  ${st.dim(`If it doesn't open, visit ${start.verification_uri} and enter the code.`)}\n\n` +
      `  ${st.dim('Waiting for approval…')}\n`
  )
  ctx.openBrowser(url)
  const refresh = await pollDeviceToken(ctx.config.api, start, { fetch: ctx.fetch, sleep: ctx.sleep })
  let loginName: string | undefined
  try {
    loginName = (await new Api(ctx.config.api, refresh, ctx.fetch).me()).login
  } catch {
    /* cosmetic only */
  }
  writeCredentials(ctx.config.credentialsPath, { refresh_token: refresh, api: ctx.config.api, login: loginName })
  ctx.out(`\n${st.green('✓')} Signed in${loginName ? ` as ${st.bold(`@${loginName}`)}` : ''}\n`)
}

export function logout(ctx: Ctx): void {
  ctx.out(deleteCredentials(ctx.config.credentialsPath) ? 'Logged out.\n' : 'Not logged in.\n')
}

export interface LsEntry {
  name: string
  online: boolean
  last_seen: number | null
  sessions: SessionInfo[] | null
  error?: string
}

export async function ls(ctx: Ctx): Promise<void> {
  const api = apiFromCredentials(ctx)
  const devices = await api.devices()
  if (devices.length === 0) {
    ctx.out('No devices. Enable remote access in the Remoterm app on a Mac.\n')
    return
  }
  const entries: LsEntry[] = await Promise.all(
    devices.map(async (d): Promise<LsEntry> => {
      const base = { name: d.name, online: d.online, last_seen: d.last_seen }
      if (!d.online) return { ...base, sessions: null }
      try {
        const token = await api.attachToken(d.id)
        return { ...base, sessions: await fetchSessions(tunnelOrigin(d.id, ctx.config.tunnelDomain), token, ctx.fetch) }
      } catch (e) {
        return { ...base, sessions: null, error: e instanceof Error ? e.message : String(e) }
      }
    })
  )
  ctx.out(formatLs(entries))
}

export function formatLs(entries: LsEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    if (!e.online) {
      const seen = e.last_seen ? ` (last seen ${new Date(e.last_seen * 1000).toISOString()})` : ''
      lines.push(`${e.name}  offline${seen}`)
      continue
    }
    if (!e.sessions) {
      lines.push(`${e.name}  online (sessions unavailable: ${e.error ?? 'unknown error'})`)
      continue
    }
    const running = e.sessions.filter((s) => s.running)
    lines.push(`${e.name}  online, ${running.length} running session${running.length === 1 ? '' : 's'}`)
    for (const s of running) lines.push(`  ${e.name}/${s.name}${s.busy ? '  [busy]' : ''}${s.cwd ? `  ${s.cwd}` : ''}`)
  }
  return lines.join('\n') + '\n'
}

export const SSH_CONFIG = `Host *.remoterm
  ProxyCommand remoterm connect %h
`

export function sshConfig(ctx: Ctx): void {
  ctx.out(SSH_CONFIG)
}
