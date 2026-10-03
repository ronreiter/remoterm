import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, resetDb } from './helpers';
import { issueRefresh } from '../src/lib/session';

beforeEach(resetDb);

describe('POST /auth/logout', () => {
  it('deletes the refresh token and clears the cookie', async () => {
    const uid = await createUser();
    const rt = await issueRefresh(env, uid, 'web');
    const res = await api('/auth/logout', {
      method: 'POST',
      headers: { cookie: `rt=${rt}`, origin: 'https://app.remoterm.io' },
    });
    expect(res.status).toBe(200);
    const sc = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(sc).toContain('rt=');
    expect(sc).toMatch(/max-age=0|expires=thu, 01 jan 1970/);
    expect(sc).toContain('domain=.remoterm.io');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.remoterm.io');

    const again = await api('/auth/refresh', { method: 'POST', headers: { cookie: `rt=${rt}` } });
    expect(again.status).toBe(401);
    const { results } = await env.DB.prepare('SELECT hash FROM refresh_tokens').all();
    expect(results).toHaveLength(0);
  });

  it('is a no-op success without a cookie or with an unknown token', async () => {
    expect((await api('/auth/logout', { method: 'POST' })).status).toBe(200);
    const res = await api('/auth/logout', { method: 'POST', headers: { cookie: 'rt=nope' } });
    expect(res.status).toBe(200);
  });
});
