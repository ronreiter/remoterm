export type Command = 'login' | 'logout' | 'ls' | 'attach' | 'connect' | 'ssh-config' | 'help' | 'version'

export interface ParsedArgs {
  command: Command
  positional: string[]
  view: boolean
}

export class UsageError extends Error {}

export const USAGE = `remoterm - attach to your Remoterm terminal sessions

Usage:
  remoterm login                         Sign in with GitHub (device code)
  remoterm logout                        Forget stored credentials
  remoterm ls                            List your devices and their running sessions
  remoterm attach <device>/<session> [--view]
                                         Attach in this terminal (~. at a line start detaches)
  remoterm connect <host>                SSH ProxyCommand (host: <device>.remoterm)
  remoterm ssh-config                    Print the ~/.ssh/config block for ssh access

Environment:
  REMOTERM_API              API origin (default https://api.remoterm.io)
  REMOTERM_TUNNEL_DOMAIN    Tunnel domain (default t.remoterm.io)
`

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  let view = false
  let command: string | undefined
  for (const a of argv) {
    if (a === '--view') view = true
    else if (a === '-h' || a === '--help') return { command: 'help', positional: [], view: false }
    else if (a === '-v' || a === '--version') return { command: 'version', positional: [], view: false }
    else if (a.startsWith('--') || (a.startsWith('-') && a.length > 1)) throw new UsageError(`unknown option: ${a}`)
    else if (command === undefined) command = a
    else positional.push(a)
  }
  if (command === undefined || command === 'help') return { command: 'help', positional: [], view: false }
  const need = (n: number, usage: string): void => {
    if (positional.length !== n) throw new UsageError(`usage: remoterm ${usage}`)
  }
  switch (command) {
    case 'login':
    case 'logout':
    case 'ls':
    case 'ssh-config':
      need(0, command)
      break
    case 'attach':
      need(1, 'attach <device>/<session> [--view]')
      break
    case 'connect':
      need(1, 'connect <host>')
      break
    default:
      throw new UsageError(`unknown command: ${command}`)
  }
  if (view && command !== 'attach') throw new UsageError('--view only applies to attach')
  return { command: command as Command, positional, view }
}

/** `<device>/<session>`; the session may itself contain slashes. */
export function parseTarget(t: string): { device: string; session: string } {
  const i = t.indexOf('/')
  if (i <= 0 || i === t.length - 1) throw new UsageError('target must look like <device>/<session>')
  return { device: t.slice(0, i), session: t.slice(i + 1) }
}
