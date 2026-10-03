import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // @remoterm/protocol and @remoterm/themes are linked packages outside this project.
  server: { fs: { allow: [resolve(__dirname, '..')] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
