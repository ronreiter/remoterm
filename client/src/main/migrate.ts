import { join, dirname } from 'path'
import { existsSync, mkdirSync, copyFileSync } from 'fs'

export const sessionsDirName = (isDev: boolean): string => (isDev ? 'remoterm-data-dev' : 'remoterm-data')
export const settingsFileName = (isDev: boolean): string => (isDev ? '.remoterm-dev.settings' : '.remoterm.settings')

// One-time copy of Moltty-era data into Remoterm locations. Copy-only: never
// deletes legacy files and never overwrites anything Remoterm already wrote.
export function migrateLegacyData(opts: { appData: string; userData: string; home: string; isDev: boolean }): string[] {
  const { appData, userData, home, isDev } = opts
  const pairs: [string, string][] = [
    [
      join(appData, 'Moltty', isDev ? 'moltty-data-dev' : 'moltty-data', 'sessions.json'),
      join(userData, sessionsDirName(isDev), 'sessions.json')
    ],
    [
      join(home, isDev ? '.moltty-dev.settings' : '.moltty.settings'),
      join(home, settingsFileName(isDev))
    ]
  ]
  const log: string[] = []
  for (const [from, to] of pairs) {
    if (!existsSync(from) || existsSync(to)) continue
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      log.push(`copied ${from} → ${to}`)
    } catch (e) {
      console.error(`MIGRATION_FAILED: ${from} → ${to}:`, e)
    }
  }
  return log
}
