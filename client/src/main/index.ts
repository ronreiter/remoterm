import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Notification, safeStorage, powerSaveBlocker } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'fs'
import { IPC } from '../shared/ipc-channels'
import { PtyHub, type HubClient, type HubHandle } from './remote/ptyHub'
import { createRemoteService } from './remote/service'

app.setName('Moltty')

let mainWindow: BrowserWindow | null = null

// Local PTY sessions
const localPtySessions = new Map<string, ReturnType<typeof import('node-pty').spawn>>()

// PTY hub: every PTY is mirrored and fanned out to its clients. The local renderer
// is a hub client over the existing IPC channels; remote viewers attach through the
// agent server (see ./remote).
const hub = new PtyHub()
const localHandles = new Map<string, HubHandle>()


function createWindow(): void {
  const iconPath = join(__dirname, '../../resources/icon.png')
  const icon = nativeImage.createFromPath(iconPath)

  if (process.platform === 'darwin') {
    app.dock.setIcon(icon)
  }

  mainWindow = new BrowserWindow({
    title: 'Moltty',
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Don't throttle timers when the window is in the background.
      // Without this, per-session busy timers (2s) get held until refocus and
      // fire in a burst — every tab announces "finished a task" simultaneously.
      backgroundThrottling: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Log renderer crashes / errors so they show up in the dev terminal output
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('RENDER_PROCESS_GONE:', details)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`DID_FAIL_LOAD code=${code} url=${url} desc=${desc}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(`RENDERER_${level === 3 ? 'ERROR' : 'WARN'}: ${message}`)
  })

  // Prevent Electron from navigating when files are dropped
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // Clicking a terminal hyperlink (OSC 8) opens the URL twice: once via our own
  // link handler (→ window.electronAPI.openExternal) and once via a native
  // window-open that Chromium fires for the underlying link element. That native
  // path bypasses all JS-side dedup. We already route every link through
  // openExternal, so deny all renderer-initiated window opens to kill the dupe.
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  // Block Cmd/Ctrl+R (page reload). Reloading the renderer kills React state,
  // scroll positions, and all in-flight UI work; PTYs in main survive but the
  // user-visible app state is lost. Cmd+R should pass through to the active
  // tool inside the terminal instead.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if ((input.meta || input.control) && (key === 'r' || input.code === 'F5')) {
      event.preventDefault()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const isDev = !!process.env.ELECTRON_RENDERER_URL

// IPC handlers — session persistence
function getDataDir(): string {
  const dir = join(app.getPath('userData'), isDev ? 'moltty-data-dev' : 'moltty-data')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getSessionsPath(): string {
  return join(getDataDir(), 'sessions.json')
}

ipcMain.handle(IPC.LOAD_SESSIONS, () => {
  try {
    const raw = readFileSync(getSessionsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
})

ipcMain.handle(IPC.SAVE_SESSIONS, (_event, data: string) => {
  try {
    writeFileSync(getSessionsPath(), data, 'utf-8')
  } catch {
    // write failed
  }
})

// Settings persistence
function getSettingsPath(): string {
  return join(homedir(), isDev ? '.moltty-dev.settings' : '.moltty.settings')
}

ipcMain.handle(IPC.LOAD_SETTINGS, () => {
  try {
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
})

ipcMain.handle(IPC.SAVE_SETTINGS, (_event, data: string) => {
  try {
    writeFileSync(getSettingsPath(), data, 'utf-8')
  } catch {
    // write failed
  }
})

ipcMain.handle(IPC.LIST_CLAUDE_SESSIONS, () => {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const results: { sessionId: string; cwd: string; updatedAt: string; size: number; summary: string }[] = []

  try {
    const dirs = readdirSync(projectsDir)
    for (const dir of dirs) {
      const dirPath = join(projectsDir, dir)
      try {
        if (!statSync(dirPath).isDirectory()) continue
        const files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'))
        for (const file of files) {
          const filePath = join(dirPath, file)
          try {
            const fd = require('fs').openSync(filePath, 'r')
            const headBuf = Buffer.alloc(Math.min(64 * 1024, statSync(filePath).size))
            require('fs').readSync(fd, headBuf, 0, headBuf.length, 0)
            require('fs').closeSync(fd)
            const raw = headBuf.toString('utf-8')

            const st = statSync(filePath)
            const lines = raw.split('\n')

            let cwd = ''
            let sessionId = ''
            let summary = ''
            for (const line of lines) {
              if (!line) continue
              try {
                const obj = JSON.parse(line)
                if (!cwd && obj.cwd) cwd = obj.cwd
                if (!sessionId && obj.sessionId) sessionId = obj.sessionId
                if (!summary && obj.type === 'user' && obj.message) {
                  const content = obj.message.content
                  let text = ''
                  if (Array.isArray(content)) {
                    const tc = content.find((c: { type: string }) => c.type === 'text')
                    if (tc) text = tc.text
                  } else if (typeof content === 'string') {
                    text = content
                  }
                  text = text.trim().split('\n')[0].slice(0, 120)
                  if (text && !text.toLowerCase().includes('interrupted')) {
                    summary = text
                  }
                }
                if (cwd && sessionId && summary) break
              } catch {
                // skip unparseable lines
              }
            }

            results.push({
              sessionId: sessionId || file.replace('.jsonl', ''),
              cwd: cwd || dir,
              updatedAt: st.mtime.toISOString(),
              size: st.size,
              summary
            })
          } catch {
            // skip unparseable files
          }
        }
      } catch {
        // skip unreadable dirs
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return results
})

// Look up a session summary by tool + session id (used to auto-name a live
// session from a meaningful source, since Claude's terminal title is just
// the static string "Claude Code").
ipcMain.handle(IPC.GET_TOOL_SESSION_SUMMARY, (_event, tool: string, toolSessionId: string) => {
  if (tool !== 'claude' || !toolSessionId) return ''
  const projectsDir = join(homedir(), '.claude', 'projects')
  try {
    const dirs = readdirSync(projectsDir)
    for (const dir of dirs) {
      const filePath = join(projectsDir, dir, `${toolSessionId}.jsonl`)
      try {
        if (!statSync(filePath).isFile()) continue
      } catch {
        continue
      }
      try {
        const fd = require('fs').openSync(filePath, 'r')
        const headBuf = Buffer.alloc(Math.min(64 * 1024, statSync(filePath).size))
        require('fs').readSync(fd, headBuf, 0, headBuf.length, 0)
        require('fs').closeSync(fd)
        const raw = headBuf.toString('utf-8')
        for (const line of raw.split('\n')) {
          if (!line) continue
          try {
            const obj = JSON.parse(line)
            if (obj.type === 'user' && obj.message) {
              const content = obj.message.content
              let text = ''
              if (Array.isArray(content)) {
                const tc = content.find((c: { type: string }) => c.type === 'text')
                if (tc) text = tc.text
              } else if (typeof content === 'string') {
                text = content
              }
              text = text.trim().split('\n')[0].slice(0, 80)
              if (text && !text.toLowerCase().includes('interrupted')) return text
            }
          } catch {
            // skip unparseable lines
          }
        }
        return ''
      } catch {
        return ''
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist
  }
  return ''
})

ipcMain.handle(IPC.OPEN_EXTERNAL, (_event, url: string) => {
  shell.openExternal(url)
})

ipcMain.handle(IPC.OPEN_PATH, (_event, filePath: string) => {
  let resolved = filePath
  if (resolved.startsWith('~/')) {
    resolved = join(homedir(), resolved.slice(2))
  }
  shell.openPath(resolved)
})

function resolveUserPath(filePath: string): string {
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2))
  return filePath
}

ipcMain.handle(IPC.READ_FILE, (_event, filePath: string) => {
  try {
    const resolved = resolveUserPath(filePath)
    const stat = statSync(resolved)
    if (stat.isDirectory()) return { ok: false, isDirectory: true }
    if (stat.size > 5 * 1024 * 1024) return { ok: false, error: 'File too large (>5MB)' }
    const content = readFileSync(resolved, 'utf-8')
    return { ok: true, content }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle(IPC.WRITE_FILE, (_event, filePath: string, content: string) => {
  try {
    const resolved = resolveUserPath(filePath)
    writeFileSync(resolved, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle(IPC.PICK_FOLDER, async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose working directory'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// --- Local PTY handlers ---
ipcMain.handle(IPC.LOCAL_PTY_SPAWN, (_event, sessionId: string, command: string, workDir: string, loadZshrc: boolean) => {
  const existing = localPtySessions.get(sessionId)
  if (existing) {
    console.log(`LOCAL_PTY_REATTACH: sessionId=${sessionId}`)
    return { ok: true, reattached: true }
  }

  let resolvedDir = workDir || homedir()
  if (resolvedDir === '~' || resolvedDir.startsWith('~/')) {
    resolvedDir = resolvedDir.replace('~', homedir())
  }
  try {
    mkdirSync(resolvedDir, { recursive: true })
  } catch {
    resolvedDir = homedir()
  }

  const parts = command.split(/\s+/)

  try {
    const pty = require('node-pty')
    const cleanEnv = { ...process.env }
    delete cleanEnv.CLAUDECODE
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT
    delete cleanEnv.CLAUDE_SESSION_ID

    console.log(`LOCAL_PTY_SPAWN: sessionId=${sessionId} command=${command} cwd=${resolvedDir}`)

    const shellArgs = loadZshrc !== false
      ? ['-l', '-i', '-c', command]
      : ['-l', '-c', command]
    const ptyProcess = pty.spawn('/bin/zsh', shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedDir,
      env: {
        ...cleanEnv,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'Moltty',
        FORCE_HYPERLINK: '1',
        HOME: homedir()
      }
    })

    localPtySessions.set(sessionId, ptyProcess)

    // Detect tool session ID after spawn (for tools that support --resume)
    // Note: Claude session IDs are now handled in the renderer via --session-id flag
    const isResuming = parts.includes('--resume')
    if (parts[0] === 'gemini' && !isResuming) {
      // Gemini CLI: detect session ID from ~/.gemini/sessions/
      const geminiSessionsDir = join(homedir(), '.gemini', 'sessions')
      const beforeFiles = new Set<string>()
      try {
        readdirSync(geminiSessionsDir).forEach(f => beforeFiles.add(f))
      } catch {}

      let pollCount = 0
      const pollInterval = setInterval(() => {
        pollCount++
        if (pollCount > 30 || !localPtySessions.has(sessionId)) {
          clearInterval(pollInterval)
          return
        }
        try {
          const files = readdirSync(geminiSessionsDir)
          const newFile = files.find(f => !beforeFiles.has(f))
          if (newFile) {
            clearInterval(pollInterval)
            const toolSessionId = newFile.replace(/\.[^.]+$/, '')
            console.log(`TOOL_SESSION_DETECTED: molttySession=${sessionId} toolSession=${toolSessionId}`)
            mainWindow?.webContents.send(IPC.TOOL_SESSION_DETECTED, sessionId, toolSessionId)
          }
        } catch {}
      }, 500)
    }

    // The local renderer is a hub client; output/exit reach it exactly as before.
    const localClient: HubClient = {
      kind: 'local',
      send: (data) => {
        if (localPtySessions.get(sessionId) === ptyProcess) {
          mainWindow?.webContents.send(IPC.LOCAL_PTY_OUTPUT, sessionId, data)
        }
      },
      exit: (exitCode) => {
        if (localPtySessions.get(sessionId) === ptyProcess) {
          console.log(`LOCAL_PTY_EXIT: sessionId=${sessionId} exitCode=${exitCode}`)
          localPtySessions.delete(sessionId)
          localHandles.delete(sessionId)
          mainWindow?.webContents.send(IPC.LOCAL_PTY_EXIT, sessionId, exitCode)
        }
      },
      close: () => {}
    }
    hub.create(sessionId, ptyProcess)
    const handle = hub.attach(sessionId, localClient, 'control')
    if (handle) localHandles.set(sessionId, handle)

    return { ok: true, reattached: false }
  } catch (err) {
    console.error(`Failed to spawn local PTY for ${sessionId}:`, err)
    return { ok: false, error: String(err) }
  }
})

ipcMain.on(IPC.LOCAL_PTY_INPUT, (_event, sessionId: string, data: string) => {
  localHandles.get(sessionId)?.write(data)
})

// Track active session for file drops
let activeSessionIdForDrop: string | null = null
ipcMain.on(IPC.SET_ACTIVE_SESSION, (_event, sessionId: string) => {
  activeSessionIdForDrop = sessionId
})

// Read git branch from .git/HEAD (no subprocess, supports worktrees)
ipcMain.handle(IPC.GET_GIT_BRANCH, (_event, workDir: string) => {
  let dir = workDir
  if (dir.startsWith('~/')) dir = join(homedir(), dir.slice(2))
  let current = dir
  for (let i = 0; i < 20; i++) {
    const gitPath = join(current, '.git')
    try {
      const stat = statSync(gitPath)
      let headPath: string
      if (stat.isDirectory()) {
        headPath = join(gitPath, 'HEAD')
      } else {
        // Worktree: .git is a file with "gitdir: /path/to/.git/worktrees/name"
        const gitdir = readFileSync(gitPath, 'utf-8').trim().replace('gitdir: ', '')
        headPath = join(gitdir, 'HEAD')
      }
      const head = readFileSync(headPath, 'utf-8').trim()
      if (head.startsWith('ref: refs/heads/')) return head.slice(16)
      return head.slice(0, 8)
    } catch {
      const parent = join(current, '..')
      if (parent === current) break
      current = parent
    }
  }
  return null
})

// Create git worktree in temp directory, branching from current branch
ipcMain.handle(IPC.CREATE_GIT_WORKTREE, (_event, workDir: string) => {
  let dir = workDir
  if (dir.startsWith('~/')) dir = join(homedir(), dir.slice(2))
  try {
    const { execSync } = require('child_process')
    // Get current branch name
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, stdio: 'pipe' }).toString().trim()
    const suffix = Date.now().toString(36)
    const branchName = `${currentBranch}-wt-${suffix}`
    const worktreePath = join(require('os').tmpdir(), `moltty-worktree-${branchName}`)
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, { cwd: dir, stdio: 'pipe' })
    return { ok: true, path: worktreePath, branch: branchName }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// Force quit from renderer after hold
ipcMain.on(IPC.FORCE_QUIT, () => {
  quitConfirmed = true
  app.quit()
})

// Native notifications
ipcMain.on(IPC.SHOW_NOTIFICATION, (_event, title: string, body: string, sessionId?: string) => {
  console.log(`NOTIFICATION: supported=${Notification.isSupported()} title=${title} body=${body} sessionId=${sessionId}`)
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
        if (sessionId) {
          mainWindow.webContents.send('focus-session', sessionId)
        }
      }
    })
    notification.show()
  }
})

// File drop — renderer sends escaped paths, we forward to active PTY
ipcMain.on(IPC.FILE_DROP, (_event, text: string) => {
  if (activeSessionIdForDrop) {
    localHandles.get(activeSessionIdForDrop)?.write(text)
  }
})

ipcMain.on(IPC.LOCAL_PTY_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
  try {
    localHandles.get(sessionId)?.resize(cols, rows)
  } catch {
    // resize may fail if process is exiting
  }
})

ipcMain.handle(IPC.LOCAL_PTY_KILL, (_event, sessionId: string) => {
  const pty = localPtySessions.get(sessionId)
  if (pty) {
    localPtySessions.delete(sessionId)
    localHandles.delete(sessionId)
    // Drop the hub entry first so remote clients are told the session ended.
    hub.remove(sessionId)
    try {
      pty.kill()
    } catch {
      // already dead
    }
  }
})

// Hold Cmd+Q to quit — prevent accidental close
let quitConfirmed = false

app.on('before-quit', (event) => {
  if (quitConfirmed) return
  event.preventDefault()
  // Tell renderer to start the hold-to-quit countdown
  mainWindow?.webContents.send('quit-confirm', true)
})

// Remote access (host agent): sign-in, device registration, attach server, cloudflared.
const remote = createRemoteService({
  ipcMain,
  app,
  safeStorage,
  powerSaveBlocker,
  shell,
  getMainWindow: () => mainWindow,
  hub,
  dataDir: getDataDir(),
  readSessionsFile: () => {
    try {
      return JSON.parse(readFileSync(getSessionsPath(), 'utf-8'))
    } catch {
      return null
    }
  },
  readSettingsFile: () => {
    try {
      return JSON.parse(readFileSync(getSettingsPath(), 'utf-8'))
    } catch {
      return null
    }
  }
})

app.whenReady().then(() => {
  createWindow()
  remote.start().catch((e) => console.error('REMOTE_START_FAILED:', e))
})

app.on('will-quit', () => {
  void remote.shutdown()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitConfirmed = true
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
