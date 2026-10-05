import { expect, test } from '@playwright/test'
import { AGENT_PORT } from '../playwright.config'
import { MockAgent } from './mockAgent'
import { API, mockApi, terminalText } from './helpers'

test.describe.configure({ mode: 'serial' })

const agent = new MockAgent(AGENT_PORT)
test.beforeAll(() => agent.start())
test.afterAll(() => agent.stop())
test.beforeEach(() => agent.reset())

test('signed-out users see sign-in that goes to GitHub OAuth for the web client', async ({ page }) => {
  await mockApi(page, { signedIn: false })
  await page.goto('/')
  const link = page.getByTestId('signin-link')
  await expect(link).toHaveAttribute('href', `${API}/auth/github?client=web`)
  await link.click()
  await page.waitForURL(`${API}/auth/github?client=web`)
  await expect(page.getByText('GitHub login')).toBeVisible()
})

test('device list shows online and offline devices with last seen', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByTestId('login')).toHaveText('octocat')
  await expect(page.getByTestId('device-d1')).toContainText('Work MacBook')
  await expect(page.getByTestId('device-d1').getByTestId('device-status')).toHaveText('online')
  await expect(page.getByTestId('device-d2').getByTestId('device-status')).toContainText('offline - last seen 2 h ago')
  await expect(page.getByTestId('device-d2').locator('a')).toHaveCount(0)
})

test('session list comes from the device agent with an attach token', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByTestId('device-d1').locator('a').click()
  await expect(page).toHaveURL(/\/d\/d1$/)
  await expect(page.getByTestId('session-s1')).toContainText('zsh - project')
  await expect(page.getByTestId('session-s2')).toContainText('build')
  await expect(page.getByTestId('session-dead')).toHaveCount(0) // not running
  expect(agent.sessionRequests.at(-1)?.authorization).toBe('Bearer attach-d1')
  await page.getByTestId('session-s1').locator('a').click()
  await expect(page).toHaveURL(/\/d\/d1\/s\/s1$/)
})

test('deep link attaches, renders the snapshot, and typing sends bytes', async ({ page }) => {
  await mockApi(page)
  await page.goto('/d/d1/s/s1')
  await expect.poll(() => terminalText(page)).toContain('hello from mock')
  await expect(page.getByTestId('conn-status')).toHaveText('open')
  await expect(page.getByTestId('term-title')).toHaveText('zsh - project') // name, not the session id

  const conn = agent.connections.at(-1)!
  expect(conn.mode).toBe('control')
  expect(conn.authToken).toBe('attach-d1')
  expect(conn.url).not.toContain('attach-') // tokens never in the URL

  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect.poll(() => agent.inputs.join('')).toContain('ls\r')

  agent.output('file.txt\r\n')
  await expect.poll(() => terminalText(page)).toContain('file.txt')
})

test('view-only mode reconnects with mode=view and blocks input', async ({ page }) => {
  await mockApi(page)
  await page.goto('/d/d1/s/s1')
  await expect(page.getByTestId('conn-status')).toHaveText('open')
  await page.getByTestId('view-toggle').click()
  await expect.poll(() => agent.connections.some((c) => c.mode === 'view')).toBe(true)
  await expect(page.getByTestId('view-toggle')).toHaveText('View only')
  await expect(page.getByTestId('conn-status')).toHaveText('open')

  await page.locator('.xterm-helper-textarea').focus({ timeout: 2000 }).catch(() => {})
  await page.keyboard.type('secret')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  expect(agent.inputs.join('')).not.toContain('secret')
  expect(agent.droppedViewInputs).toEqual([]) // the client never even sends it
})

test('4404 shows the session ended message', async ({ page }) => {
  await mockApi(page)
  await page.goto('/d/d1/s/dead')
  await expect(page.getByTestId('banner')).toContainText(/ended|not running/i)
  await expect(page.getByTestId('conn-status')).toHaveText('ended')
})

test('offline device shows an explicit message and never opens a socket', async ({ page }) => {
  await mockApi(page)
  await page.goto('/d/d2/s/s1')
  await expect(page.getByTestId('banner')).toContainText('offline')
  expect(agent.connections).toHaveLength(0)
})

test('sign out calls the logout endpoint and returns to sign-in', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('signin-link')).toBeVisible()
  expect(api.calls.some((c) => c.path === '/auth/logout' && c.method === 'POST')).toBe(true)
})

test.describe('touch device', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 780 } })

  test('defaults to view only, then control shows the key bar and sends keys', async ({ page }) => {
    await mockApi(page)
    await page.goto('/d/d1/s/s1')
    await expect(page.getByTestId('conn-status')).toHaveText('open')
    expect(agent.connections.at(-1)!.mode).toBe('view')
    await expect(page.getByTestId('key-bar')).toHaveCount(0)

    await page.getByTestId('view-toggle').tap()
    await expect.poll(() => agent.connections.some((c) => c.mode === 'control')).toBe(true)
    await expect(page.getByTestId('conn-status')).toHaveText('open')
    await expect(page.getByTestId('key-bar')).toBeVisible()

    await page.getByRole('button', { name: 'Escape', exact: true }).tap()
    await page.getByRole('button', { name: 'Up', exact: true }).tap()
    await page.getByRole('button', { name: 'Control C', exact: true }).tap()
    await page.getByRole('button', { name: 'Tab', exact: true }).tap()
    await expect.poll(() => agent.inputs.join('')).toBe('\x1b\x1b[A\x03\t')
  })
})
