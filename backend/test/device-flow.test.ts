import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api, json, mockGithub, resetDb, stateFrom } from './helpers';
import { now, sha256Hex } from '../src/lib/crypto';

beforeEach(async () => {
  await resetDb();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function startDevice() {
  const res = await api('/auth/device', { method: 'POST' });
  return (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
}

const form = (user_code: string): RequestInit => ({
  method: 'POST',
  body: new URLSearchParams({ user_code }).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

describe('CLI device-code flow', () => {
  it('POST /auth/device returns codes, uri, 10 minute expiry; stores only the hash', async () => {
    const d = await startDevice();
    expect(d.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(d.verification_uri).toBe('https://api.remoterm.io/link');
    expect(d.expires_in).toBe(600);
    expect(d.interval).toBeGreaterThan(0);
    const row = await env.DB.prepare('SELECT * FROM device_codes').first<{
      device_code_hash: string;
      expires_at: number;
    }>();
    expect(row!.device_code_hash).toBe(await sha256Hex(d.device_code));
    expect(row!.expires_at - now()).toBeLessThanOrEqual(600);
  });

  it('polling before approval is authorization_pending', async () => {
    const d = await startDevice();
    const res = await api('/auth/device/token', json({ device_code: d.device_code }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'authorization_pending' });
  });

  it('unknown device code is invalid_grant', async () => {
    const res = await api('/auth/device/token', json({ device_code: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('GET /link renders the designed code form', async () => {
    const res = await api('/link?code=ABCD-EFGH');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/link"');
    expect(html).toContain('value="ABCD-EFGH"');
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('remoterm login'); // anti-phishing hint
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/); // fully self-contained
  });

  it('GET /link escapes the code it echoes back', async () => {
    const html = await (await api('/link?code=%22%3E%3Cscript%3Ex%3C%2Fscript%3E')).text();
    expect(html).not.toContain('"><script>x</script>');
  });

  it('POST /link with an unknown code is 404', async () => {
    expect((await api('/link', form('ZZZZ-ZZZZ'))).status).toBe(404);
  });

  it('full flow: link -> GitHub -> approved poll returns a cli refresh token exactly once', async () => {
    const d = await startDevice();
    const link = await api('/link', form(d.user_code.toLowerCase()));
    expect(link.status).toBe(302);
    expect(link.headers.get('location')).toContain('https://github.com/login/oauth/authorize');

    mockGithub();
    const cb = await api(`/auth/github/callback?code=gh&state=${stateFrom(link)}`);
    expect(cb.status).toBe(200);
    const done = await cb.text();
    expect(done).toContain('signed in as');
    expect(done).toContain('@octocat');
    expect(done).toContain('Return to your terminal');

    const poll = await api('/auth/device/token', json({ device_code: d.device_code }));
    expect(poll.status).toBe(200);
    const { refresh_token } = (await poll.json()) as { refresh_token: string };
    const row = await env.DB.prepare('SELECT client_kind FROM refresh_tokens WHERE hash = ?')
      .bind(await sha256Hex(refresh_token))
      .first<{ client_kind: string }>();
    expect(row!.client_kind).toBe('cli');

    const again = await api('/auth/device/token', json({ device_code: d.device_code }));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('expired device code returns expired_token', async () => {
    const d = await startDevice();
    await env.DB.prepare('UPDATE device_codes SET expires_at = ?').bind(now() - 1).run();
    const res = await api('/auth/device/token', json({ device_code: d.device_code }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'expired_token' });
    expect((await api('/link', form(d.user_code))).status).toBe(404);
  });
});
