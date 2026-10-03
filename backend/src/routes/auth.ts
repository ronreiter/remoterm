import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { now, randomToken, sha256B64url, sha256Hex } from '../lib/crypto';
import { githubUserFromCode } from '../lib/github';
import { startGithub } from '../lib/oauth';
import { signAccessToken, ACCESS_TTL_SECONDS } from '../lib/jwt';
import {
  COOKIE_NAME,
  REFRESH_TTL,
  issueRefresh,
  requireAuth,
  setRefreshCookie,
  upsertUser,
} from '../lib/session';
import { approveDeviceCode } from './device-flow';

const CODE_TTL = 60;

const auth = new Hono<AppEnv>();

auth.get('/auth/github', async (c) => {
  const client = c.req.query('client');
  if (client !== 'app' && client !== 'web') return c.json({ error: 'invalid_client' }, 400);
  const challenge = c.req.query('challenge');
  if (client === 'app' && (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))) {
    return c.json({ error: 'invalid_challenge' }, 400);
  }
  return c.redirect(await startGithub(c.env, client, { challenge }), 302);
});

auth.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.json({ error: 'invalid_request' }, 400);

  const stateHash = await sha256Hex(state);
  const row = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *')
    .bind(stateHash)
    .first<{ client_kind: string; pkce_challenge: string | null; extra: string | null; expires_at: number }>();
  if (!row || row.expires_at < now()) return c.json({ error: 'invalid_state' }, 400);

  let user;
  try {
    user = await githubUserFromCode(c.env, code);
  } catch (e) {
    return c.json({ error: 'github_error', message: (e as Error).message }, 400);
  }
  const userId = await upsertUser(c.env, user);

  if (row.client_kind === 'app') {
    const authCode = randomToken(32);
    await c.env.DB.prepare(
      'INSERT INTO auth_codes (code_hash, user_id, pkce_challenge, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await sha256Hex(authCode), userId, row.pkce_challenge, now() + CODE_TTL)
      .run();
    return c.redirect(`remoterm://auth?code=${authCode}`, 302);
  }
  if (row.client_kind === 'link') {
    const ok = await approveDeviceCode(c.env, row.extra ?? '', userId);
    return c.html(
      ok
        ? '<h1>Remoterm</h1><p>Signed in. You can return to your terminal.</p>'
        : '<h1>Remoterm</h1><p>That code expired. Run <code>remoterm login</code> again.</p>',
      ok ? 200 : 400,
    );
  }
  setRefreshCookie(c, await issueRefresh(c.env, userId, 'web'));
  return c.redirect(`${c.env.WEB_ORIGIN}/`, 302);
});

auth.post('/auth/token', async (c) => {
  const body = await c.req.json<{ code?: string; verifier?: string }>().catch(() => ({}) as { code?: string; verifier?: string });
  if (!body.code || !body.verifier) return c.json({ error: 'invalid_request' }, 400);
  // Burn the code regardless of outcome (single use).
  const row = await c.env.DB.prepare('DELETE FROM auth_codes WHERE code_hash = ? RETURNING *')
    .bind(await sha256Hex(body.code))
    .first<{ user_id: string; pkce_challenge: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return c.json({ error: 'invalid_grant' }, 400);
  if ((await sha256B64url(body.verifier)) !== row.pkce_challenge) return c.json({ error: 'invalid_grant' }, 400);
  const refresh = await issueRefresh(c.env, row.user_id, 'app');
  return c.json({ refresh_token: refresh, expires_in: REFRESH_TTL });
});

auth.post('/auth/refresh', async (c) => {
  const body = await c.req.json<{ refresh_token?: string }>().catch(() => ({}) as { refresh_token?: string });
  const fromCookie = !body.refresh_token;
  const token = body.refresh_token ?? getCookie(c, COOKIE_NAME);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare('SELECT user_id, expires_at FROM refresh_tokens WHERE hash = ?')
    .bind(hash)
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return c.json({ error: 'unauthorized' }, 401);
  await c.env.DB.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE hash = ?')
    .bind(now() + REFRESH_TTL, hash)
    .run();
  if (fromCookie) setRefreshCookie(c, token);
  const access = await signAccessToken(c.env, { sub: row.user_id, aud: 'api' });
  return c.json({ access_token: access, expires_in: ACCESS_TTL_SECONDS });
});

auth.post('/auth/revoke-all', requireAuth, async (c) => {
  const userId = c.get('userId');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET revoked_before = ? WHERE id = ?').bind(now(), userId),
    c.env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId),
  ]);
  return c.json({ ok: true });
});

auth.get('/me', requireAuth, async (c) => {
  const u = await c.env.DB.prepare('SELECT id, login FROM users WHERE id = ?')
    .bind(c.get('userId'))
    .first<{ id: string; login: string }>();
  return c.json(u);
});

export default auth;
