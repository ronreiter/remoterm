import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface Credentials {
  refresh_token: string
  /** API origin the token belongs to. */
  api: string
  login?: string
}

export function readCredentials(path: string): Credentials | null {
  try {
    if (!existsSync(path)) return null
    const c = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Credentials>
    if (typeof c.refresh_token !== 'string' || !c.refresh_token) return null
    return { refresh_token: c.refresh_token, api: c.api ?? '', login: c.login }
  } catch {
    return null
  }
}

export function writeCredentials(path: string, c: Credentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600) // writeFileSync only applies the mode when creating the file
}

/** Returns true if there was something to remove. */
export function deleteCredentials(path: string): boolean {
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}
