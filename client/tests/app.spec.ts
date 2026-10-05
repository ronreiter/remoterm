import { test, expect, Page } from '@playwright/test'

// Mock electronAPI — simulates PTY lifecycle with echo-back behavior
const ELECTRON_API_MOCK = `
  window.__ptyOutputCallbacks = [];
  window.__ptyExitCallbacks = [];
  window.__ptyInstances = new Map();

  window.__savedSessions = null;

  window.__remote = {
    status: { signedIn: false, enabled: false, busy: false, deviceName: 'my-mac', preventSleep: false, tunnel: { state: 'stopped' } },
    statusCbs: [], viewerCbs: [], viewers: {}, calls: [],
    // remote client (tabs on other devices)
    list: { ok: true, devices: [] }, listCalls: 0, outCbs: [], tabStatusCbs: []
  };
  // Test hooks for the remote client: the device list, and output / status events from the main process.
  window.__setRemoteList = (list) => { window.__remote.list = list; };
  window.__pushTabOutput = (e) => { for (const cb of window.__remote.outCbs) cb(e); };
  window.__pushTabStatus = (e) => { for (const cb of window.__remote.tabStatusCbs) cb(e); };
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
      window.__pushRemote({ enabled: on, tunnel: { state: on ? 'connecting' : 'stopped' }, hostname: on ? 'abc123.remoterm.io' : undefined });
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
    remoteList: async () => { window.__remote.listCalls++; return window.__remote.list; },
    remoteAttach: async (req) => { window.__remote.calls.push(['attach', req]); },
    remoteTabInput: (id, data) => { window.__remote.calls.push(['tabInput', id, data]); },
    remoteTabResize: (id, cols, rows) => { window.__remote.calls.push(['tabResize', id, cols, rows]); },
    remoteDetach: (id) => { window.__remote.calls.push(['detach', id]); },
    onRemoteTabOutput: (cb) => {
      window.__remote.outCbs.push(cb);
      return () => { window.__remote.outCbs = window.__remote.outCbs.filter(c => c !== cb); };
    },
    onRemoteTabStatus: (cb) => {
      window.__remote.tabStatusCbs.push(cb);
      return () => { window.__remote.tabStatusCbs = window.__remote.tabStatusCbs.filter(c => c !== cb); };
    },

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
    await expect(page.getByText('abc123.remoterm.io')).toBeVisible()

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

// ─── Remote sidebar group and remote tabs ───

const NOW_S = () => Math.floor(Date.now() / 1000)
const DEVICES = (nowS: number) => ({
  ok: true,
  devices: [
    {
      id: 'dev1',
      name: 'studio',
      online: true,
      lastSeen: nowS,
      sessions: [
        { id: 'rs1', name: 'api work', tool: 'claude', cwd: '/Users/ron/api', folder: null, color: null, running: true, busy: false, cols: 100, rows: 30 },
        { id: 'rs2', name: 'web', tool: 'claude', cwd: '/Users/ron/web', folder: null, color: null, running: true, busy: true, cols: 100, rows: 30 }
      ]
    },
    { id: 'dev2', name: 'laptop', online: false, lastSeen: nowS - 7200, sessions: [] }
  ]
})

async function setupRemote(page: Page, opts: { signedIn?: boolean } = { signedIn: true }) {
  await page.addInitScript(ELECTRON_API_MOCK)
  await page.addInitScript(
    ([signedIn, list]) => {
      ;(window as any).__remote.status = { ...(window as any).__remote.status, signedIn, login: signedIn ? 'octocat' : undefined }
      ;(window as any).__setRemoteList(list)
    },
    [opts.signedIn !== false, DEVICES(NOW_S())] as const
  )
  await page.goto('/')
  await page.waitForSelector('text=Remoterm')
}

const rcalls = (page: Page) => page.evaluate(() => (window as any).__remote.calls as any[])
const attachCalls = async (page: Page) => (await rcalls(page)).filter((c) => c[0] === 'attach')

async function openRemoteSession(page: Page, device = 'dev1', session = 'rs1') {
  await page.getByTestId(`remote-session-${device}-${session}`).click()
  await expect(page.getByTestId('remote-badge').first()).toBeVisible()
}

test.describe('Remote sidebar group', () => {
  test('is hidden while signed out', async ({ page }) => {
    await setupRemote(page, { signedIn: false })
    await page.waitForTimeout(150)
    await expect(page.getByTestId('remote-group')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__remote.listCalls)).toBe(0)
  })

  test('appears after signing in and lists devices with their running sessions', async ({ page }) => {
    await setupRemote(page, { signedIn: false })
    await expect(page.getByTestId('remote-group')).toHaveCount(0)
    await page.evaluate(() => (window as any).__pushRemote({ signedIn: true, login: 'octocat' }))
    await expect(page.getByTestId('remote-group')).toBeVisible()
    await expect(page.getByTestId('remote-device-state-dev1')).toHaveText('online')
    await expect(page.getByTestId('remote-session-dev1-rs1')).toContainText('api work')
    await expect(page.getByTestId('remote-session-dev1-rs2')).toContainText('web')
    // offline device: greyed with last seen, no sessions
    await expect(page.getByTestId('remote-device-state-dev2')).toHaveText('last seen 2 h ago')
    await expect(page.getByTestId('remote-device-dev2')).toHaveClass(/opacity-60/)
    await expect(page.locator('[data-testid^="remote-session-dev2"]')).toHaveCount(0)
  })

  test('polls every 15 seconds while visible', async ({ page }) => {
    await page.clock.install()
    await setupRemote(page)
    await expect(page.getByTestId('remote-session-dev1-rs1')).toBeVisible()
    const before = await page.evaluate(() => (window as any).__remote.listCalls)
    expect(before).toBeGreaterThanOrEqual(1)
    await page.evaluate(
      (d) => (window as any).__setRemoteList({ ok: true, devices: [{ ...d.devices[0], name: 'studio-2', sessions: [] }] }),
      DEVICES(NOW_S())
    )
    await page.clock.runFor(14_000)
    expect(await page.evaluate(() => (window as any).__remote.listCalls)).toBe(before)
    await page.clock.runFor(2_000)
    await expect(page.getByText('studio-2')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__remote.listCalls)).toBe(before + 1)
  })

  test('a failed refresh keeps the last known devices and flags it', async ({ page }) => {
    await page.clock.install()
    await setupRemote(page)
    await expect(page.getByTestId('remote-session-dev1-rs1')).toBeVisible()
    await page.evaluate(() => (window as any).__setRemoteList({ ok: false, error: 'network' }))
    await page.clock.runFor(15_500)
    await expect(page.getByTestId('remote-list-error')).toBeVisible()
    await expect(page.getByTestId('remote-session-dev1-rs1')).toBeVisible()
  })

  test('signing out hides the group', async ({ page }) => {
    await setupRemote(page)
    await expect(page.getByTestId('remote-group')).toBeVisible()
    await page.evaluate(() => (window as any).__pushRemote({ signedIn: false }))
    await expect(page.getByTestId('remote-group')).toHaveCount(0)
  })
})

test.describe('Remote tabs', () => {
  test('clicking a session opens a remote tab with a "remote · device" badge and attaches in control mode', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    await expect(page.getByTestId('remote-badge')).toHaveText('remote · studio')
    await expect(page.getByTestId('remote-tab-header')).toContainText('remote · studio')
    await expect(page.locator('.xterm')).toBeVisible()

    const attach = (await attachCalls(page))[0]
    expect(attach[1]).toMatchObject({ deviceId: 'dev1', sessionId: 'rs1', mode: 'control' })
    await expect(page.getByTestId('remote-mode-control')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('remote-mode-view')).toHaveAttribute('aria-pressed', 'false')

    // never a local PTY, never listed as a local session
    expect(await page.evaluate(() => (window as any).__ptyInstances.size)).toBe(0)
    await expect(page.locator(SIDEBAR_SESSION)).toHaveCount(0)
    await expect(page.locator('text=No session selected')).not.toBeVisible()
  })

  test('opening the same session again focuses the existing tab', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    await page.getByTestId('remote-session-dev1-rs2').click()
    await expect(page.getByTestId('remote-badge')).toHaveCount(2)
    await page.getByTestId('remote-session-dev1-rs1').click()
    await expect(page.getByTestId('remote-badge')).toHaveCount(2)
  })

  test('status moves from connecting to connected; snapshots and output render without busy reports', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    await expect(page.getByTestId('remote-tab-status')).toHaveText('Connecting…')
    const tabId = (await attachCalls(page))[0][1].tabId
    await page.evaluate((id) => {
      ;(window as any).__pushTabStatus({ tabId: id, status: 'live' })
      ;(window as any).__pushTabOutput({ tabId: id, kind: 'snapshot', data: 'hello remote', cols: 100, rows: 30 })
      ;(window as any).__pushTabOutput({ tabId: id, kind: 'data', data: new TextEncoder().encode('x'.repeat(5000)) })
    }, tabId)
    await expect(page.getByTestId('remote-tab-status')).toHaveText('Connected')
    await expect(page.getByTestId('remote-connecting')).toHaveCount(0)
    await page.waitForTimeout(300)
    expect((await rcalls(page)).filter((c) => c[0] === 'busy')).toHaveLength(0)
    // a second snapshot (e.g. after another client resized) is a full reset, not an append
    await page.evaluate(
      (id) => (window as any).__pushTabOutput({ tabId: id, kind: 'snapshot', data: 'second', cols: 80, rows: 24 }),
      tabId
    )
    await expect(page.locator('.xterm-rows')).toContainText('second')
    await expect(page.locator('.xterm-rows')).not.toContainText('hello remote')
  })

  test('control mode forwards typing; View mode re-attaches read-only and drops input', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    const tabId = (await attachCalls(page))[0][1].tabId
    await page.evaluate((id) => (window as any).__pushTabStatus({ tabId: id, status: 'live' }), tabId)
    await page.evaluate((id) => (window as any).__pushTabOutput({ tabId: id, kind: 'snapshot', data: '$ ', cols: 100, rows: 30 }), tabId)

    await page.locator('.xterm-helper-textarea').first().focus()
    await page.keyboard.type('ls')
    await expect
      .poll(async () => (await rcalls(page)).filter((c) => c[0] === 'tabInput').map((c) => c[2]).join(''))
      .toBe('ls')

    await page.getByTestId('remote-mode-view').click()
    await expect(page.getByTestId('remote-mode-view')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await attachCalls(page)).length).toBe(2)
    expect((await attachCalls(page))[1][1]).toMatchObject({ tabId, mode: 'view' })

    const inputsBefore = (await rcalls(page)).filter((c) => c[0] === 'tabInput').length
    await page.keyboard.type('pwd')
    await page.waitForTimeout(100)
    expect((await rcalls(page)).filter((c) => c[0] === 'tabInput')).toHaveLength(inputsBefore)

    await page.getByTestId('remote-mode-control').click()
    await expect.poll(async () => (await attachCalls(page)).length).toBe(3)
    expect((await attachCalls(page))[2][1]).toMatchObject({ mode: 'control' })
  })

  test('ended (4404) shows the session-ended state and the tab can be closed', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    const tabId = (await attachCalls(page))[0][1].tabId
    await page.evaluate((id) => (window as any).__pushTabStatus({ tabId: id, status: 'ended', code: 4404 }), tabId)
    await expect(page.getByTestId('remote-overlay')).toContainText('Session ended (4404)')
    await expect(page.getByTestId('remote-mode-view')).toBeDisabled()
    await page.getByRole('button', { name: 'Close tab' }).click()
    await expect(page.getByTestId('remote-badge')).toHaveCount(0)
    expect((await rcalls(page)).filter((c) => c[0] === 'detach').map((c) => c[1])).toContain(tabId)
    const saved = await page.evaluate(() => (window as any).__savedSessions)
    expect(saved.sessions).toHaveLength(0)
  })

  test('sign-in needed (4401) and offline states', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    const tabId = (await attachCalls(page))[0][1].tabId
    await page.evaluate((id) => (window as any).__pushTabStatus({ tabId: id, status: 'offline' }), tabId)
    await expect(page.getByTestId('remote-tab-status')).toContainText('Offline')
    await expect(page.getByTestId('remote-connecting')).toContainText('studio is offline')
    await page.evaluate((id) => (window as any).__pushTabStatus({ tabId: id, status: 'auth', code: 4401 }), tabId)
    await expect(page.getByTestId('remote-tab-status')).toHaveText('Sign-in needed')
    await page.getByRole('button', { name: 'Sign in' }).click()
    expect(await remoteCalls(page)).toContainEqual(['signIn'])
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(async () => (await attachCalls(page)).length).toBe(2)
  })

  test('closing the tab detaches without touching local PTYs', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    const tabId = (await attachCalls(page))[0][1].tabId
    await page.keyboard.press('Meta+w')
    await expect(page.getByTestId('remote-badge')).toHaveCount(0)
    await expect.poll(async () => (await rcalls(page)).filter((c) => c[0] === 'detach').map((c) => c[1])).toContain(tabId)
  })

  test('a local session and a remote tab coexist; the local one still spawns its own PTY', async ({ page }) => {
    await setupRemote(page)
    await page.getByRole('button', { name: '+ New Session' }).click()
    await page.waitForTimeout(150)
    await openRemoteSession(page)
    expect(await page.evaluate(() => (window as any).__ptyInstances.size)).toBe(1)
    await expect(page.locator(SIDEBAR_SESSION)).toHaveCount(1)
    await expect(page.getByTestId('remote-badge')).toHaveCount(1)
  })
})

test.describe('Remote tab persistence (reattach if still running)', () => {
  async function reloadWithSaved(page: Page) {
    const saved = await page.evaluate(() => (window as any).__savedSessions)
    await page.addInitScript((data) => {
      window.__savedSessions = JSON.parse(data)
    }, JSON.stringify(saved))
    await page.reload()
    await page.waitForSelector('text=Remoterm')
    return saved
  }

  test('open remote tabs are saved as reattach entries and reattach after a restart', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    const saved = await reloadWithSaved(page)
    expect(saved.sessions[0]).toMatchObject({
      kind: 'remote',
      status: 'open',
      remote: { deviceId: 'dev1', sessionId: 'rs1', deviceName: 'studio' }
    })
    expect(saved.openTabs).toEqual([saved.sessions[0].id])

    await expect(page.getByTestId('remote-badge')).toHaveText('remote · studio')
    await expect.poll(async () => (await attachCalls(page)).length).toBe(1)
    expect((await attachCalls(page))[0][1]).toMatchObject({
      tabId: saved.sessions[0].id,
      deviceId: 'dev1',
      sessionId: 'rs1',
      mode: 'control'
    })
    expect(await page.evaluate(() => (window as any).__ptyInstances.size)).toBe(0)
  })

  test('if the session is gone on restart (4404) the tab is dropped quietly', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    const saved = await reloadWithSaved(page)
    await expect(page.getByTestId('remote-badge')).toBeVisible()
    await page.evaluate((id) => (window as any).__pushTabStatus({ tabId: id, status: 'ended', code: 4404 }), saved.sessions[0].id)
    await expect(page.getByTestId('remote-badge')).toHaveCount(0)
    await expect(page.getByTestId('remote-overlay')).toHaveCount(0)
    await expect(page.locator('text=No session selected')).toBeVisible()
    const after = await page.evaluate(() => (window as any).__savedSessions)
    expect(after.sessions).toHaveLength(0)
    expect(after.openTabs).toHaveLength(0)
  })

  test('closed remote tabs are not restored', async ({ page }) => {
    await setupRemote(page)
    await openRemoteSession(page)
    await page.keyboard.press('Meta+w')
    await expect(page.getByTestId('remote-badge')).toHaveCount(0)
    await reloadWithSaved(page)
    await expect(page.getByTestId('remote-badge')).toHaveCount(0)
  })
})
