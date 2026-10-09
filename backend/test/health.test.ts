import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('GET /healthz', async () => {
    const res = await SELF.fetch('https://api.remoterm.io/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('migrations created all tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ['users', 'devices', 'refresh_tokens', 'auth_codes', 'device_codes', 'oauth_states']) {
      expect(names).toContain(t);
    }
  });
});
