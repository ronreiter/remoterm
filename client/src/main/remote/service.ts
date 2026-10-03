import { hostname } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { Account, EncryptedFileTokenStore, apiBaseFromEnv, type SafeStorageLike } from './account'
import { AgentAuth, fetchAgentConfig } from './auth'
import { AgentServer } from './agentServer'
import { CloudflaredSupervisor, cloudflaredPath } from './cloudflared'
import { GithubKeys } from './githubKeys'
import { loadOrCreateHostKey } from './hostKey'
import { DeviceClient, pickFreePort } from './device'
import type { PtyHub } from './ptyHub'
import { DEVICE_NAME_RE, RemoteManager, type RemoteConfig } from './remoteManager'
import { toSessionMetas } from './sessionMeta'

export interface RemoteServiceDeps {
  ipcMain: IpcMain
  app: {
    isPackaged: boolean
    getAppPath(): string
    on(event: 'open-url', cb: (e: { preventDefault(): void }, url: string) => void): unknown
    setAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean
  }
  safeStorage: SafeStorageLike
  powerSaveBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void }
  shell: { openExternal(url: string): Promise<void> }
  getMainWindow: () => BrowserWindow | null
  hub: PtyHub
  /** Directory for remote.json / remote-auth.bin (the app's data dir). */
  dataDir: string
  readSessionsFile: () => unknown
  readSettingsFile: () => unknown
}

export const PROTOCOL = 'remoterm'

function defaultDeviceName(): string {
  const n = hostname().replace(/\.local$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40)
  return DEVICE_NAME_RE.test(n) ? n : 'my-mac'
}

/**
 * Wires the account, device registration, agent server and cloudflared into the
 * Electron main process and exposes them over IPC. Must be created before app ready
 * (open-url has to be registered early); safeStorage is only used lazily.
 */
export function createRemoteService(d: RemoteServiceDeps) {
  const apiBase = apiBaseFromEnv()
  mkdirSync(d.dataDir, { recursive: true })
  const configFile = join(d.dataDir, 'remote.json')

  const send = (channel: string, payload: unknown): void => {
    const w = d.getMainWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  const account = new Account({
    apiBase,
    store: new EncryptedFileTokenStore(join(d.dataDir, 'remote-auth.bin'), d.safeStorage),
    openExternal: (url) => d.shell.openExternal(url),
    onChange: () => manager?.notifyAccountChanged()
  })
  const device = new DeviceClient({ apiBase, getAccessToken: () => account.getAccessToken() })

  const manager: RemoteManager = new RemoteManager({
    account,
    device,
    hub: d.hub,
    store: {
      load: () => {
        try {
          return existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf-8')) as RemoteConfig) : null
        } catch {
          return null
        }
      },
      save: (c) => {
        try {
          writeFileSync(configFile, JSON.stringify(c, null, 2), 'utf-8')
        } catch {
          /* ignore */
        }
      }
    },
    pickPort: pickFreePort,
    createAuth: (getDeviceId) =>
      new AgentAuth({
        deviceId: getDeviceId,
        getConfig: () => fetchAgentConfig({ apiBase, deviceId: getDeviceId(), getAccessToken: () => account.getAccessToken() })
      }),
    createServer: (port, auth) =>
      new AgentServer({
        hub: d.hub,
        auth: auth as AgentAuth,
        port,
        ssh: { hostKey: loadOrCreateHostKey(d.dataDir), keys: new GithubKeys() },
        listSessions: () => toSessionMetas(d.readSessionsFile(), d.readSettingsFile())
      }),
    createCloudflared: (onStatus) =>
      new CloudflaredSupervisor({
        binaryPath: cloudflaredPath({
          isPackaged: d.app.isPackaged,
          resourcesPath: process.resourcesPath,
          appRoot: d.app.getAppPath(),
          arch: process.arch
        }),
        onStatus
      }),
    power: {
      start: () => d.powerSaveBlocker.start('prevent-app-suspension'),
      stop: (id) => d.powerSaveBlocker.stop(id)
    },
    defaultDeviceName,
    onStatus: (s) => send(IPC.REMOTE_STATUS_CHANGED, s)
  })

  // remoterm://auth?code=... (macOS delivers custom-scheme URLs via open-url)
  try {
    if (process.defaultApp && process.argv[1]) {
      d.app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [join(process.cwd(), process.argv[1])])
    } else {
      d.app.setAsDefaultProtocolClient(PROTOCOL)
    }
  } catch {
    /* not fatal */
  }
  d.app.on('open-url', (event, url) => {
    event.preventDefault()
    account
      .handleCallbackUrl(url)
      .then((handled) => {
        if (handled) {
          const w = d.getMainWindow()
          w?.show()
          w?.focus()
        }
      })
      .catch((e) => console.error('REMOTE_SIGN_IN_FAILED:', e instanceof Error ? e.message : e))
      .finally(() => manager.notifyAccountChanged())
  })

  d.hub.onRemoteCount(() => send(IPC.REMOTE_VIEWERS_CHANGED, d.hub.remoteCounts()))

  const { ipcMain } = d
  ipcMain.handle(IPC.REMOTE_GET_STATUS, () => manager.getStatus())
  ipcMain.handle(IPC.REMOTE_GET_VIEWERS, () => d.hub.remoteCounts())
  ipcMain.handle(IPC.REMOTE_SIGN_IN, async () => {
    try {
      await account.startSignIn()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.REMOTE_SIGN_OUT, () => manager.signOut())
  ipcMain.handle(IPC.REMOTE_SET_ENABLED, (_e, on: boolean) => (on ? manager.enable() : manager.disable()))
  ipcMain.handle(IPC.REMOTE_SET_DEVICE_NAME, (_e, name: string) => manager.setDeviceName(String(name)))
  ipcMain.handle(IPC.REMOTE_SET_PREVENT_SLEEP, (_e, on: boolean) => manager.setPreventSleep(!!on))
  ipcMain.handle(IPC.REMOTE_RESET, () => manager.resetRemoteAccess())
  ipcMain.on(IPC.SESSION_BUSY_CHANGED, (_e, sessionId: string, busy: boolean) => d.hub.setBusy(sessionId, !!busy))

  return {
    manager,
    account,
    /** Restore sign-in and bring remote access back if it was on. Call after app ready. */
    async start(): Promise<void> {
      await account.init()
      manager.notifyAccountChanged()
      await manager.resume()
    },
    shutdown: () => manager.shutdown()
  }
}
