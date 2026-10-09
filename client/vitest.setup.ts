import { chmodSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

// node-pty ships spawn-helper in prebuilds/; npm installs with --ignore-scripts
// (or some archive extractors) drop the exec bit, which makes pty.spawn fail with
// "posix_spawnp failed". Restore it before tests run.
export default function setup(): void {
  const root = join(__dirname, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(root)) return
  for (const d of readdirSync(root)) {
    const f = join(root, d, 'spawn-helper')
    if (existsSync(f)) chmodSync(f, 0o755)
  }
}
