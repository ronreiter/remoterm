import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.PW_PORT || 5188)

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 1200, height: 800 }
  },
  webServer: {
    command: `npx vite --config vite.test.config.ts --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI
  }
})
