import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decodeJwt } from 'jose';
import { api, json, mockGithub, resetDb, createUser, authHeader, stateFrom } from './helpers';
import { sha256B64url, sha256Hex, now } from '../src/lib/crypto';

const VERIFIER = 'v'.repeat(48);

beforeEach(async () => {
  await resetDb();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function appLogin(verifier = VERIFIER) {
  const challenge = await sha256B64url(verifier);
  const start = await api(`/auth/github?client=app&challenge=${challenge}`);
  mockGithub();
  const cb = await api(`/auth/github/callback?code=ghcode&state=${stateFrom(start)}`);
  return { start, cb };
}

describe('GET /auth/github', () => {
  it('app without PKCE challenge is 400', async () => {
    const res = await api('/auth/github?client=app');
    expect(res.status).toBe(400);
  });

  it('unknown client is 400', async () => {
    expect((await api('/auth/github?client=nope')).status).toBe(400);
  });

  it('redirects to GitHub with client_id, redirect_uri and state', async () => {
    const res = await api('/auth/github?client=web');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('Ov23li5NNLNc4w9aloMy');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://api.remoterm.io/auth/github/callback');
    expect(loc.searchParams.get('state')).toBeTruthy();
  });
});

describe('app flow with PKCE', () => {
  it('callback redirects to remoterm://auth?code=; code + verifier yields refresh token usable for /me', async () => {
    const { cb } = await appLogin();
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get('location')!);
    expect(loc.protocol).toBe('remoterm:');
    expect(loc.host).toBe('auth');
    const code = loc.searchParams.get('code')!;

    const tok = await api('/auth/token', json({ code, verifier: VERIFIER }));
    expect(tok.status).toBe(200);
    const { refresh_token } = (await tok.json()) as { refresh_token: string };
    expect(refresh_token).toBeTruthy();

    // stored hashed, as an app token, 90 day expiry
    const row = await env.DB.prepare('SELECT * FROM refresh_tokens WHERE hash = ?')
      .bind(await sha256Hex(refresh_token))
      .first<{ client_kind: string; expires_at: number }>();
    expect(row!.client_kind).toBe('app');
    expect(row!.expires_at - now()).toBeGreaterThan(89 * 86400);

    const ref = await api('/auth/refresh', json({ refresh_token }));
    expect(ref.status).toBe(200);
    const { access_token, expires_in } = (await ref.json()) as { access_token: string; expires_in: number };
    expect(expires_in).toBe(600);
    const claims = decodeJwt(access_token);
    expect(claims.aud).toBe('api');
    expect(claims.exp! - claims.iat!).toBe(600);

    const me = await api('/me', { headers: { authorization: `Bearer ${access_token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ login: 'octocat' });
  });

  it('wrong verifier is rejected and burns the code', async () => {
    const { cb } = await appLogin();
    const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
    expect((await api('/auth/token', json({ code, verifier: 'x'.repeat(48) }))).status).toBe(400);
    expect((await api('/auth/token', json({ code, verifier: VERIFIER }))).status).toBe(400);
  });

  it('code is single use', async () => {
    const { cb } = await appLogin();
    const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
    expect((await api('/auth/token', json({ code, verifier: VERIFIER }))).status).toBe(200);
    expect((await api('/auth/token', json({ code, verifier: VERIFIER }))).status).toBe(400);
  });

  it('code expires after 60 seconds', async () => {
    const { cb } = await appLogin();
    const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
    const row = await env.DB.prepare('SELECT expires_at FROM auth_codes').first<{ expires_at: number }>();
    expect(row!.expires_at - now()).toBeLessThanOrEqual(60);
    await env.DB.prepare('UPDATE auth_codes SET expires_at = ?').bind(now() - 1).run();
    expect((await api('/auth/token', json({ code, verifier: VERIFIER }))).status).toBe(400);
  });
});

describe('callback validation', () => {
  it('unknown state is 400', async () => {
    expect((await api('/auth/github/callback?code=x&state=bogus')).status).toBe(400);
  });

  it('state is single use', async () => {
    const start = await api('/auth/github?client=web');
    const state = stateFrom(start);
    mockGithub();
    expect((await api(`/auth/github/callback?code=c&state=${state}`)).status).toBe(302);
    expect((await api(`/auth/github/callback?code=c&state=${state}`)).status).toBe(400);
  });

  it('GitHub token exchange error is 400', async () => {
    const start = await api('/auth/github?client=web');
    fetchMock
      .get('https://github.com')
      .intercept({ path: '/login/oauth/access_token', method: 'POST' })
      .reply(200, { error: 'bad_verification_code' });
    const res = await api(`/auth/github/callback?code=c&state=${stateFrom(start)}`);
    expect(res.status).toBe(400);
  });

  it('upserts the user on repeated login (same github id, updated login)', async () => {
    await appLogin();
    const start = await api('/auth/github?client=web');
    mockGithub({ id: 4242, login: 'renamed' });
    await api(`/auth/github/callback?code=c&state=${stateFrom(start)}`);
    const { results } = await env.DB.prepare('SELECT login FROM users').all();
    expect(results).toEqual([{ login: 'renamed' }]);
  });
});

describe('web flow', () => {
  it('sets HttpOnly Secure SameSite=Lax cookie on .remoterm.io and redirects to the web app', async () => {
    const start = await api('/auth/github?client=web');
    mockGithub();
    const cb = await api(`/auth/github/callback?code=c&state=${stateFrom(start)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('https://app.remoterm.io/');
    const cookie = cb.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^rt=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Domain=\.remoterm\.io/i);
    expect(cookie).toMatch(/Path=\//);

    const rt = cookie.split(';')[0];
    const ref = await api('/auth/refresh', { method: 'POST', headers: { cookie: rt } });
    expect(ref.status).toBe(200);
    expect(decodeJwt(((await ref.json()) as { access_token: string }).access_token).aud).toBe('api');
  });
});

describe('POST /auth/refresh', () => {
  it('unknown token is 401', async () => {
    expect((await api('/auth/refresh', json({ refresh_token: 'nope' }))).status).toBe(401);
  });

  it('missing token is 401', async () => {
    expect((await api('/auth/refresh', { method: 'POST' })).status).toBe(401);
  });

  it('expired token is 401', async () => {
    await appLogin();
    const { cb } = await appLogin();
    const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
    const { refresh_token } = (await (await api('/auth/token', json({ code, verifier: VERIFIER }))).json()) as {
      refresh_token: string;
    };
    await env.DB.prepare('UPDATE refresh_tokens SET expires_at = ?').bind(now() - 1).run();
    expect((await api('/auth/refresh', json({ refresh_token }))).status).toBe(401);
  });

  it('slides expiry forward', async () => {
    const { cb } = await appLogin();
    const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
    const { refresh_token } = (await (await api('/auth/token', json({ code, verifier: VERIFIER }))).json()) as {
      refresh_token: string;
    };
    const hash = await sha256Hex(refresh_token);
    await env.DB.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE hash = ?').bind(now() + 100, hash).run();
    await api('/auth/refresh', json({ refresh_token }));
    const row = await env.DB.prepare('SELECT expires_at FROM refresh_tokens WHERE hash = ?')
      .bind(hash)
      .first<{ expires_at: number }>();
    expect(row!.expires_at - now()).toBeGreaterThan(89 * 86400);
  });
});

describe('authentication guard', () => {
  it('/me without token is 401', async () => {
    expect((await api('/me')).status).toBe(401);
  });

  it('/me rejects a token with a different audience', async () => {
    await createUser();
    const res = await api('/me', { headers: await authHeader('user1', 'abcdefghijkl') });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/revoke-all', () => {
  it('deletes all refresh tokens, sets revoked_before, invalidates outstanding JWTs', async () => {
    await createUser();
    const headers = await authHeader('user1');
    await env.DB.prepare(
      "INSERT INTO refresh_tokens (hash, user_id, client_kind, created_at, expires_at) VALUES ('h1','user1','app',1,?),('h2','user1','cli',1,?)",
    )
      .bind(now() + 1000, now() + 1000)
      .run();
    expect((await api('/me', { headers })).status).toBe(200);

    const res = await api('/auth/revoke-all', { method: 'POST', headers });
    expect(res.status).toBe(200);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').first<{ n: number }>();
    expect(count!.n).toBe(0);
    const u = await env.DB.prepare('SELECT revoked_before FROM users WHERE id = ?')
      .bind('user1')
      .first<{ revoked_before: number }>();
    expect(Math.abs(u!.revoked_before - now())).toBeLessThanOrEqual(1);
    expect((await api('/me', { headers })).status).toBe(401);
  });
});
