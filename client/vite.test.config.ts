import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  // @remoterm/themes is a linked package outside the project root.
  server: { fs: { allow: [resolve(__dirname, '..')] } },
  css: {
    postcss: resolve(__dirname, 'postcss.config.js')
  }
})
