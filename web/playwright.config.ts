import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.PW_PORT || 5290)
export const AGENT_PORT = Number(process.env.AGENT_PORT || 18771)

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  workers: 1, // all specs share one mock agent on a fixed port
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 1000, height: 700 }
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: {
      // *.localhost resolves to loopback in Chromium; the app uses plain http/ws for localhost domains.
      VITE_TUNNEL_DOMAIN: `localhost:${AGENT_PORT}`,
      VITE_API_ORIGIN: 'https://api.remoterm.io'
    }
  }
})
