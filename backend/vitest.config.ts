import path from 'node:path';
import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';
import { generateKeyPairSync } from 'node:crypto';

// Throwaway Ed25519 key for tests only.
const { privateKey } = generateKeyPairSync('ed25519');
const testJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              CF_ACCOUNT_ID: 'acct123',
              CF_ZONE_ID: 'zone123',
              GITHUB_CLIENT_SECRET: 'gh-secret',
              CF_API_TOKEN: 'cf-token',
              JWT_PRIVATE_KEY: testJwk,
            },
          },
        },
      },
    },
  };
});
