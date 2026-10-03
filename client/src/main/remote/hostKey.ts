import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { utils } from 'ssh2'

export const HOST_KEY_FILE = 'ssh_host_ed25519'

/** Loads the agent's SSH host key, generating an Ed25519 key (mode 0600) on first use. */
export function loadOrCreateHostKey(dataDir: string): string {
  const file = join(dataDir, HOST_KEY_FILE)
  if (existsSync(file)) {
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best effort */
    }
    return readFileSync(file, 'utf-8')
  }
  mkdirSync(dataDir, { recursive: true })
  const { private: priv } = utils.generateKeyPairSync('ed25519')
  writeFileSync(file, priv, { mode: 0o600 })
  chmodSync(file, 0o600)
  return priv
}
