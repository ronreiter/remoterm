import { test, expect, Page } from '@playwright/test'

// Mock electronAPI — simulates PTY lifecycle with echo-back behavior
const ELECTRON_API_MOCK = `
  window.__ptyOutputCallbacks = [];
  window.__ptyExitCallbacks = [];
  window.__ptyInstances = new Map();

  window.__savedSessions = null;

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
  await page.waitForSelector('text=Moltty')
}

const SIDEBAR_SESSION = '[class*="rounded-lg"][class*="cursor-pointer"][class*="gap-3"]'

// ─── Empty state ───

test.describe('Empty state', () => {
  test('shows sidebar with title, new session button, and tabs', async ({ page }) => {
    await setupPage(page)
    await expect(page.locator('text=Moltty')).toBeVisible()
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
      const raw = localStorage.getItem('moltty:local-sessions')
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
    await page.waitForSelector('text=Moltty')
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
    await page.waitForSelector('text=Moltty')
    await page.waitForTimeout(200)

    // Session should still be in the sidebar
    const sessionItems = page.locator(SIDEBAR_SESSION)
    await expect(sessionItems).toHaveCount(1)
  })
})
