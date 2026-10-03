import { applyD1Migrations, env } from 'cloudflare:test';

// TEST_MIGRATIONS is injected by vitest.config.ts
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
