import { defineConfig } from 'tsup'

// One self-contained file: ws and @remoterm/protocol are bundled in.
export default defineConfig({
  entry: { remoterm: 'src/index.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node20',
  platform: 'node',
  clean: true,
  minify: false,
  noExternal: ['ws', '@remoterm/protocol'],
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' }
})
