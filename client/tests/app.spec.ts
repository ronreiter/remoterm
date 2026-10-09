import { test, expect, Page } from '@playwright/test'

// Mock electronAPI — simulates PTY lifecycle with echo-back behavior
const ELECTRON_API_MOCK = `
  window.__ptyOutputCallbacks = [];
  window.__ptyExitCallbacks = [];
  window.__ptyInstances = new Map();

  window.__savedSessions = null;

  window.__remote = {
    status: { signedIn: false, enabled: false, busy: false, deviceName: 'my-mac', preventSleep: false, tunnel: { state: 'stopped' } },
    statusCbs: [], viewerCbs: [], viewers: {}, calls: []
  };
  // Test hooks: merge a partial status / viewer map and notify the renderer, like main-process IPC events.
  window.__pushRemote = (patch) => {
    window.__remote.status = { ...window.__remote.status, ...patch };
    for (const cb of window.__remote.statusCbs) cb(window.__remote.status);
  };
  window.__pushViewers = (counts) => {
    window.__remote.viewers = counts;
    for (const cb of window.__remote.viewerCbs) cb(counts);
  };

  window.electronAPI = {
    loadSessions: async () => window.__savedSessions,
    saveSessions: async (data) => { window.__savedSessions = JSON.parse(data); },
    loadSettings: async () => window.__savedSettings || { codingTool: 'claude', loadZshrc: true, notifications: false, autoUpdate: false },
    saveSettings: async (data) => { window.__savedSettings = JSON.parse(data); },
    openPath: async () => {},
    onClaudeSessionDetected: () => () => {},
    onToolSessionDetected: () => () => {},
    getGitBranch: async () => null,
    createGitWorktree: async () => ({ ok: false, error: 'mock' }),
    readFile: async () => ({ ok: false, error: 'mock' }),
    writeFile: async () => ({ ok: true }),
    getToolSessionSummary: async () => '',
    showNotification: () => {},
    onFocusSession: () => () => {},
    sendFileDrop: () => {},
    setActiveSessionMain: () => {},
    getPathForFile: () => '',
    forceQuit: () => {},
    onQuitConfirm: () => () => {},

    // ---- remote access (host agent) ----
    remoteGetStatus: async () => window.__remote.status,
    onRemoteStatus: (cb) => {
      window.__remote.statusCbs.push(cb);
      return () => { window.__remote.statusCbs = window.__remote.statusCbs.filter(c => c !== cb); };
    },
    remoteSignIn: async () => { window.__remote.calls.push(['signIn']); return { ok: true }; },
    remoteSignOut: async () => {
      window.__remote.calls.push(['signOut']);
      window.__pushRemote({ signedIn: false, login: undefined, enabled: false, tunnel: { state: 'stopped' } });
    },
    remoteSetEnabled: async (on) => {
      window.__remote.calls.push(['setEnabled', on]);
      window.__pushRemote({ enabled: on, tunnel: { state: on ? 'connecting' : 'stopped' }, hostname: on ? 'abc123.t.remoterm.io' : undefined });
    },
    remoteSetDeviceName: async (name) => {
      window.__remote.calls.push(['setDeviceName', name]);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) return { ok: false, error: 'Use letters, digits, dots, dashes and underscores (max 40)' };
      window.__pushRemote({ deviceName: name });
      return { ok: true };
    },
    remoteSetPreventSleep: async (on) => { window.__remote.calls.push(['setPreventSleep', on]); window.__pushRemote({ preventSleep: on }); },
    remoteReset: async () => { window.__remote.calls.push(['reset']); window.__pushRemote({ enabled: false, deviceId: undefined, tunnel: { state: 'stopped' } }); },
    remoteGetViewers: async () => window.__remote.viewers,
    onRemoteViewers: (cb) => {
      window.__remote.viewerCbs.push(cb);
      return () => { window.__remote.viewerCbs = window.__remote.viewerCbs.filter(c => c !== cb); };
    },
    reportSessionBusy: (id, busy) => { window.__remote.calls.push(['busy', id, busy]); },

    listClaudeSessions: async () => [
      {
        sessionId: 'claude-session-1',
        cwd: '/Users/testuser/projects/my-app',
        updatedAt: new Date().toISOString(),
        size: 2048,
        summary: 'Help me fix the login bug'
      },
      {
        sessionId: 'claude-session-2',
        cwd: '/Users/testuser/projects/api-server',
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        size: 8192,
        summary: 'Refactor database layer'
      }
    ],

    pickFolder: async () => '/Users/testuser/projects/test-folder',

    openExternal: async (url) => {},

    spawnLocalPty: async (sessionId, command, workDir) => {
      window.__ptyInstances.set(sessionId, { command, workDir, alive: true });
      // Simulate PTY outputting a prompt after a short delay
      setTimeout(() => {
        for (const cb of window.__ptyOutputCallbacks) {
          cb(sessionId, '\\x1b[32m$ \\x1b[0m');
        }
      }, 50);
      return { ok: true, reattached: false };
    },

    sendLocalPtyInput: (sessionId, data) => {
      const pty = window.__ptyInstances.get(sessionId);
      if (!pty || !pty.alive) return;
      // Echo input back as output
      for (const cb of window.__ptyOutputCallbacks) {
        cb(sessionId, data);
      }
    },

    resizeLocalPty: (sessionId, cols, rows) => {},

    killLocalPty: async (sessionId) => {
      const pty = window.__ptyInstances.get(sessionId);
      if (pty) {
        pty.alive = false;
        for (const cb of window.__ptyExitCallbacks) {
          cb(sessionId, 0);
        }
        window.__ptyInstances.delete(sessionId);
      }
    },

    onLocalPtyOutput: (cb) => {
      window.__ptyOutputCallbacks.push(cb);
      return () => {
        window.__ptyOutputCallbacks = window.__ptyOutputCallbacks.filter(c => c !== cb);
      };
    },

    onLocalPtyExit: (cb) => {
      window.__ptyExitCallbacks.push(cb);
      return () => {
        window.__ptyExitCallbacks = window.__ptyExitCallbacks.filter(c => c !== cb);
      };
    }
  };
`

async function setupPage(page: Page) {
  await page.addInitScript(ELECTRON_API_MOCK)
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForSelector('text=Remoterm')
}

const SIDEBAR_SESSION = '[class*="rounded-lg"][class*="cursor-pointer"][class*="gap-3"]'

// ─── Empty state ───

test.describe('Empty state', () => {
  test('shows sidebar with title, new session button, and tabs', async ({ page }) => {
    await setupPage(page)
    await expect(page.locator('text=Remoterm')).toBeVisible()
    await expect(page.getByRole('button', { name: '+ New Session' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sessions' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible()
  })

  test('shows empty sessions message', async ({ page }) => {
    await setupPage(page)
    await expect(page.locator('text=No sessions yet')).toBeVisible()
  })

  test('shows no session selected message in main area', async ({ page }) => {
    await setupPage(page)
    await expect(page.locator('text=No session selected')).toBeVisible()
    await expect(page.locator('text=Select a session from the sidebar')).toBeVisible()
  })
})

// ─── Session creation ───

test.describe('Session creation', () => {
  test('creates a session when clicking New Session', async ({ page }) => {
    await setupPage(page)
    await page.getByRole('button', { name: '+ New Session' }).click()

    // Session should appear in sidebar (name is the short path)
    const sessionItem = page.locator(SIDEBAR_SESSION).first()
    await expect(sessionItem).toBeVisible()
    await expect(sessionItem.locator('.text-sm')).toContainText('~/projects/test-folder')

    // No session selected message should be gone
    await expect(page.locator('text=No session selected')).not.toBeVisible()
  })

  test('creates multiple sessions', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    await expect(page.locator(SIDEBAR_SESSION)).toHaveCount(2)
  })

  test('new session gets a terminal that receives PTY output', async ({ page }) => {
    await setupPage(page)
    await page.getByRole('button', { name: '+ New Session' }).click()

    // Wait for PTY mock to send the prompt
    await page.waitForTimeout(200)

    // The xterm element should exist
    await expect(page.locator('.xterm')).toBeVisible()
  })
})

// ─── Session list sorting ───

test.describe('Session sorting (open on top, closed on bottom)', () => {
  test('open sessions appear above closed sessions', async ({ page }) => {
    await setupPage(page)

    // Create two sessions
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    await expect(page.locator(SIDEBAR_SESSION)).toHaveCount(2)

    // Kill the first session's PTY to make it "closed"
    const firstSessionId = await page.evaluate(() => {
      const raw = localStorage.getItem('remoterm:local-sessions')
      if (raw) {
        const data = JSON.parse(raw)
        return data.sessions[0]?.id
      }
      return null
    })

    if (firstSessionId) {
      await page.evaluate((sid) => {
        window.electronAPI.killLocalPty(sid)
      }, firstSessionId)
      await page.waitForTimeout(200)

      // There should be a divider between open and closed
      await expect(page.locator('.border-t.border-terminal-border.my-1')).toBeVisible()
    }
  })
})

// ─── Tab management ───

test.describe('Tab management', () => {
  test('clicking a session opens a tab', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const tabs = page.locator('.titlebar-drag [draggable="true"]')
    await expect(tabs).toHaveCount(1)
  })

  test('can close a tab with the x button', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const tab = page.locator('.titlebar-drag [draggable="true"]').first()
    await tab.hover()

    const closeBtn = tab.locator('button')
    await closeBtn.click()

    await expect(page.locator('.titlebar-drag [draggable="true"]')).toHaveCount(0)
    await expect(page.locator('text=No session selected')).toBeVisible()
  })

  test('switching between tabs changes active terminal', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const tabs = page.locator('.titlebar-drag [draggable="true"]')
    await expect(tabs).toHaveCount(2)

    // Click the first tab
    await tabs.first().click()
    await page.waitForTimeout(50)

    // First tab should be active (has accent color class)
    await expect(tabs.first()).toHaveClass(/text-terminal-accent/)
  })
})

// ─── Session rename ───

test.describe('Session rename', () => {
  test('double-clicking a session shows rename input', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const sessionItem = page.locator(SIDEBAR_SESSION).first()
    await sessionItem.dblclick()

    const input = page.locator('input[class*="border-terminal-accent"]:not([placeholder])')
    await expect(input).toBeVisible()
  })

  test('can rename a session', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const sessionItem = page.locator(SIDEBAR_SESSION).first()
    await sessionItem.dblclick()

    const input = page.locator('input[class*="border-terminal-accent"]:not([placeholder])')
    await input.fill('My Renamed Session')
    await input.press('Enter')

    // Name should be updated in the sidebar session item
    await expect(sessionItem.locator('.text-sm')).toContainText('My Renamed Session')
  })

  test('pressing Escape cancels rename', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const sessionItem = page.locator(SIDEBAR_SESSION).first()
    await sessionItem.dblclick()

    const input = page.locator('input[class*="border-terminal-accent"]:not([placeholder])')
    await input.fill('Should Not Save')
    await input.press('Escape')

    // Rename input should be gone, original name remains
    await expect(input).not.toBeVisible()
    await expect(sessionItem.locator('.text-sm')).not.toContainText('Should Not Save')
  })
})

// ─── Session deletion ───

test.describe('Session deletion', () => {
  test('hovering a session shows delete button', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const sessionItem = page.locator(SIDEBAR_SESSION).first()
    await sessionItem.hover()

    const deleteBtn = sessionItem.locator('button[title="Remove session"]')
    await expect(deleteBtn).toBeVisible()
  })

  test('clicking delete removes the session', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const sessionItem = page.locator(SIDEBAR_SESSION).first()
    await sessionItem.hover()

    const deleteBtn = sessionItem.locator('button[title="Remove session"]')
    await deleteBtn.click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()

    await expect(page.locator('text=No sessions yet')).toBeVisible()
    await expect(page.locator('text=No session selected')).toBeVisible()
  })
})

// ─── History tab ───

test.describe('History tab', () => {
  test('switching to History tab shows Claude sessions', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: 'History' }).click()

    await expect(page.locator('text=~/projects/my-app')).toBeVisible()
    await expect(page.locator('text=~/projects/api-server')).toBeVisible()
    await expect(page.locator('text=Help me fix the login bug')).toBeVisible()
    await expect(page.locator('text=Refactor database layer')).toBeVisible()
  })

  test('clicking a history item creates a session and switches to Sessions tab', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(100)

    await page.locator('text=Help me fix the login bug').click()
    await page.waitForTimeout(100)

    // Should switch back to Sessions tab with the new session
    await expect(page.getByRole('button', { name: 'Sessions' })).toHaveClass(/text-terminal-accent/)

    await expect(page.locator(SIDEBAR_SESSION)).toHaveCount(1)
  })
})

// ─── Terminal search (Cmd/Ctrl+F) ───

test.describe('Terminal search', () => {
  async function createSessionAndWait(page: Page) {
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(300)
    // Click on the terminal area to focus it so keydown events fire on the right element
    await page.locator('.xterm').click()
    await page.waitForTimeout(100)
  }

  test('Ctrl+F opens search bar', async ({ page }) => {
    await setupPage(page)
    await createSessionAndWait(page)

    await page.keyboard.press('Control+f')
    await expect(page.locator('input[placeholder="Search..."]')).toBeVisible()
  })

  test('Escape closes search bar', async ({ page }) => {
    await setupPage(page)
    await createSessionAndWait(page)

    await page.keyboard.press('Control+f')
    await expect(page.locator('input[placeholder="Search..."]')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('input[placeholder="Search..."]')).not.toBeVisible()
  })

  test('can type in search bar', async ({ page }) => {
    await setupPage(page)
    await createSessionAndWait(page)

    await page.keyboard.press('Control+f')
    const searchInput = page.locator('input[placeholder="Search..."]')
    await expect(searchInput).toBeVisible()

    await searchInput.fill('test query')
    await expect(searchInput).toHaveValue('test query')
  })

  test('search bar has navigation and close buttons', async ({ page }) => {
    await setupPage(page)
    await createSessionAndWait(page)

    await page.keyboard.press('Control+f')

    await expect(page.locator('button[title*="Previous"]')).toBeVisible()
    await expect(page.locator('button[title*="Next"]')).toBeVisible()
    await expect(page.locator('button[title*="Close"]')).toBeVisible()
  })

  test('close button closes search', async ({ page }) => {
    await setupPage(page)
    await createSessionAndWait(page)

    await page.keyboard.press('Control+f')
    await expect(page.locator('input[placeholder="Search..."]')).toBeVisible()

    await page.locator('button[title*="Close"]').click()
    await expect(page.locator('input[placeholder="Search..."]')).not.toBeVisible()
  })
})

// ─── CWD header ───

test.describe('Working directory header', () => {
  test('shows working directory when session has one', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    await expect(page.locator('.font-mono').filter({ hasText: '~/projects/test-folder' })).toBeVisible()
  })
})

// ─── Persistence ───

test.describe('Persistence', () => {
  test('sessions are saved via electronAPI', async ({ page }) => {
    await setupPage(page)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(100)

    const saved = await page.evaluate(() => (window as any).__savedSessions)

    expect(saved).toBeTruthy()
    expect(saved.sessions).toHaveLength(1)
    expect(saved.sessions[0].status).toBe('open')
    expect(saved.openTabs).toHaveLength(1)
  })

  test('sessions persist across page reloads', async ({ page }) => {
    // Inject the electronAPI mock for all navigations (__savedSessions survives in addInitScript context)
    await page.addInitScript(ELECTRON_API_MOCK)
    await page.goto('/')
    await page.waitForSelector('text=Remoterm')
    await page.waitForTimeout(200)

    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(200)

    // Verify session was saved
    const saved = await page.evaluate(() => (window as any).__savedSessions)
    expect(saved).toBeTruthy()
    expect(saved.sessions).toHaveLength(1)

    // Reload — addInitScript re-runs but __savedSessions resets. Simulate persistence
    // by pre-seeding the mock with saved data
    const sessionsJson = JSON.stringify(saved)
    await page.addInitScript((data) => {
      window.__savedSessions = JSON.parse(data)
    }, sessionsJson)

    await page.reload()
    await page.waitForSelector('text=Remoterm')
    await page.waitForTimeout(200)

    // Session should still be in the sidebar
    const sessionItems = page.locator(SIDEBAR_SESSION)
    await expect(sessionItems).toHaveCount(1)
  })
})

// ─── Remote access (Settings) ───

async function openRemoteSettings(page: Page, initial?: Record<string, unknown>) {
  await setupPage(page)
  if (initial) await page.evaluate((p) => (window as any).__pushRemote(p), initial)
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('remote-access')).toBeVisible()
}

const remoteCalls = (page: Page) => page.evaluate(() => (window as any).__remote.calls)

test.describe('Settings › Remote access', () => {
  test('signed out: offers GitHub sign-in and disables the toggle', async ({ page }) => {
    await openRemoteSettings(page)
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
    await expect(page.getByLabel('Allow remote access to this Mac')).toBeDisabled()
    await expect(page.getByTestId('remote-status')).toContainText('Off')

    await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
    expect(await remoteCalls(page)).toContainEqual(['signIn'])
  })

  test('signed in: shows the login and can sign out', async ({ page }) => {
    await openRemoteSettings(page, { signedIn: true, login: 'octocat' })
    await expect(page.getByTestId('remote-login')).toHaveText('@octocat')
    await expect(page.getByLabel('Allow remote access to this Mac')).toBeEnabled()
    await page.getByRole('button', { name: 'Sign out' }).click()
    expect(await remoteCalls(page)).toContainEqual(['signOut'])
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
  })

  test('enabling shows connecting then connected and the hostname', async ({ page }) => {
    await openRemoteSettings(page, { signedIn: true, login: 'octocat' })
    await page.getByLabel('Allow remote access to this Mac').check()
    expect(await remoteCalls(page)).toContainEqual(['setEnabled', true])
    await expect(page.getByTestId('remote-status')).toContainText('Connecting')
    await expect(page.getByTestId('remote-status-light')).toHaveClass(/bg-orange-400/)
    await expect(page.getByText('abc123.t.remoterm.io')).toBeVisible()

    await page.evaluate(() => (window as any).__pushRemote({ tunnel: { state: 'connected' } }))
    await expect(page.getByTestId('remote-status')).toContainText('Connected')
    await expect(page.getByTestId('remote-status-light')).toHaveClass(/bg-terminal-green/)

    await page.getByLabel('Allow remote access to this Mac').uncheck()
    expect(await remoteCalls(page)).toContainEqual(['setEnabled', false])
    await expect(page.getByTestId('remote-status')).toContainText('Off')
  })

  test('tunnel errors show the last stderr line in red', async ({ page }) => {
    await openRemoteSettings(page, {
      signedIn: true,
      login: 'octocat',
      enabled: true,
      tunnel: { state: 'error', message: 'cloudflared not installed' }
    })
    await expect(page.getByTestId('remote-status')).toContainText('cloudflared not installed')
    await expect(page.getByTestId('remote-status-light')).toHaveClass(/bg-terminal-red/)
  })

  test('shows backend/registration errors', async ({ page }) => {
    await openRemoteSettings(page, { signedIn: true, login: 'octocat', error: 'You already have 5 devices registered.' })
    await expect(page.getByTestId('remote-error')).toContainText('5 devices')
  })

  test('device name: edit commits on blur, invalid names are rejected, locked while enabled', async ({ page }) => {
    await openRemoteSettings(page, { signedIn: true, login: 'octocat' })
    const name = page.getByLabel('Device name')
    await expect(name).toHaveValue('my-mac')
    await name.fill('work-mac')
    await name.press('Enter')
    expect(await remoteCalls(page)).toContainEqual(['setDeviceName', 'work-mac'])

    await name.fill('bad name!')
    await name.press('Enter')
    await expect(page.getByText('Use letters, digits')).toBeVisible()
    await expect(name).toHaveValue('work-mac')

    await page.evaluate(() => (window as any).__pushRemote({ enabled: true, tunnel: { state: 'connecting' } }))
    await expect(name).toBeDisabled()
  })

  test('prevent-sleep checkbox is sent to the main process', async ({ page }) => {
    await openRemoteSettings(page, { signedIn: true, login: 'octocat' })
    await page.getByLabel('Prevent sleep while remote access is on').check()
    expect(await remoteCalls(page)).toContainEqual(['setPreventSleep', true])
  })

  test('reset remote access asks for confirmation', async ({ page }) => {
    await openRemoteSettings(page, { signedIn: true, login: 'octocat', enabled: true, deviceId: 'abc123', tunnel: { state: 'connected' } })
    await page.getByRole('button', { name: 'Reset remote access' }).click()
    expect(await remoteCalls(page)).not.toContainEqual(['reset'])
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    expect(await remoteCalls(page)).toContainEqual(['reset'])
    await expect(page.getByTestId('remote-status')).toContainText('Off')
  })
})

// ─── Remote viewer indicator ───

test.describe('Remote viewers indicator', () => {
  test('shows a dot on the tab and sidebar item while remote clients are attached', async ({ page }) => {
    await setupPage(page)
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(150)
    await expect(page.getByTestId('remote-viewer-dot')).toHaveCount(0)

    const id = await page.evaluate(() => [...(window as any).__ptyInstances.keys()][0])
    await page.evaluate((sid) => (window as any).__pushViewers({ [sid]: 2 }), id)
    await expect(page.getByTestId('remote-viewer-dot')).toHaveCount(2) // tab + sidebar
    await expect(page.getByTestId('remote-viewer-dot').first()).toHaveAttribute('title', '2 remote viewers')

    await page.evaluate((sid) => (window as any).__pushViewers({ [sid]: 1 }), id)
    await expect(page.getByTestId('remote-viewer-dot').first()).toHaveAttribute('title', '1 remote viewer')
    await page.evaluate(() => (window as any).__pushViewers({}))
    await expect(page.getByTestId('remote-viewer-dot')).toHaveCount(0)
  })

  test('reports busy transitions to the main process', async ({ page }) => {
    await setupPage(page)
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(150)
    const id = await page.evaluate(() => [...(window as any).__ptyInstances.keys()][0])
    // Drive the store the way terminal output detection does.
    await page.evaluate(async (sid) => {
      const m = await import('/store/index.ts')
      m.useStore.getState().markSessionBusy(sid)
    }, id)
    expect(await remoteCalls(page)).toContainEqual(['busy', id, true])
    await page.evaluate(async (sid) => {
      const m = await import('/store/index.ts')
      m.useStore.getState().markSessionIdle(sid)
    }, id)
    expect(await remoteCalls(page)).toContainEqual(['busy', id, false])
  })
})
