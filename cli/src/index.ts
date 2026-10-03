import { parseArgs, UsageError, USAGE } from './args'
import { attachCommand } from './attach'
import { CliError } from './api'
import { login, logout, ls, openBrowserDefault, sshConfig, type Ctx } from './commands'
import { loadConfig } from './config'
import { connectCommand } from './connect'

declare const __VERSION__: string | undefined

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`remoterm: ${e.message}\n\n${USAGE}`)
      return 2
    }
    throw e
  }
  const ctx: Ctx = {
    config: loadConfig(),
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    fetch,
    openBrowser: openBrowserDefault
  }
  try {
    switch (args.command) {
      case 'help':
        ctx.out(USAGE)
        return 0
      case 'version':
        ctx.out((typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0') + '\n')
        return 0
      case 'login':
        await login(ctx)
        return 0
      case 'logout':
        logout(ctx)
        return 0
      case 'ls':
        await ls(ctx)
        return 0
      case 'ssh-config':
        sshConfig(ctx)
        return 0
      case 'connect':
        return await connectCommand(ctx, args.positional[0], process.stdin, process.stdout)
      case 'attach':
        return await attachCommand(ctx, args.positional[0], args.view, process.stdin, process.stdout)
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`remoterm: ${e.message}\n`)
      return e.exitCode
    }
    if (e instanceof UsageError) {
      process.stderr.write(`remoterm: ${e.message}\n`)
      return 2
    }
    process.stderr.write(`remoterm: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

main(process.argv.slice(2)).then((code) => {
  // Flush stdout before exiting so ProxyCommand output is never truncated.
  if (process.stdout.writableLength === 0) process.exit(code)
  else process.stdout.write('', () => process.exit(code))
})
