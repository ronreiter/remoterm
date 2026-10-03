import { homedir } from 'os'
import { join } from 'path'

export const DEFAULT_API = 'https://api.remoterm.io'
export const DEFAULT_TUNNEL_DOMAIN = 't.remoterm.io'

export interface Config {
  api: string
  tunnelDomain: string
  credentialsPath: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return {
    api: (env.REMOTERM_API || DEFAULT_API).replace(/\/+$/, ''),
    tunnelDomain: (env.REMOTERM_TUNNEL_DOMAIN || DEFAULT_TUNNEL_DOMAIN).replace(/^\.+|\.+$/g, ''),
    credentialsPath: join(base, 'remoterm', 'credentials')
  }
}
