import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { newUserCode, now, randomToken, sha256Hex } from '../lib/crypto';
import { startGithub } from '../lib/oauth';
import { issueRefresh, REFRESH_TTL } from '../lib/session';

const DEVICE_TTL = 600;
const POLL_INTERVAL = 5;

/** Attach a user to a pending device code. Returns false if unknown/expired/already used. */
export async function approveDeviceCode(env: Env, userCode: string, userId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    'UPDATE device_codes SET user_id = ? WHERE user_code = ? AND expires_at > ? AND user_id IS NULL',
  )
    .bind(userId, userCode, now())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Remoterm</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">` +
  `<h1>Remoterm</h1>${body}</body>`;

const linkForm = (code: string, error = '') =>
  page(
    `${error ? `<p style="color:#b00">${esc(error)}</p>` : ''}` +
      `<p>Enter the code shown in your terminal.</p>` +
      `<form method="post" action="/link"><input name="user_code" value="${esc(code)}" placeholder="ABCD-EFGH" ` +
      `autofocus autocomplete="off" style="font-size:1.5rem;width:100%"><p>` +
      `<button type="submit" style="font-size:1.1rem">Continue with GitHub</button></p></form>`,
  );

const df = new Hono<AppEnv>();

df.post('/auth/device', async (c) => {
  const deviceCode = randomToken(32);
  const userCode = newUserCode();
  await c.env.DB.prepare('INSERT INTO device_codes (device_code_hash, user_code, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(deviceCode), userCode, now() + DEVICE_TTL)
    .run();
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${c.env.API_ORIGIN}/link`,
    expires_in: DEVICE_TTL,
    interval: POLL_INTERVAL,
  });
});

df.post('/auth/device/token', async (c) => {
  const body = await c.req.json<{ device_code?: string }>().catch(() => ({}) as { device_code?: string });
  if (!body.device_code) return c.json({ error: 'invalid_request' }, 400);
  const hash = await sha256Hex(body.device_code);
  const row = await c.env.DB.prepare('SELECT user_id, expires_at FROM device_codes WHERE device_code_hash = ?')
    .bind(hash)
    .first<{ user_id: string | null; expires_at: number }>();
  if (!row) return c.json({ error: 'invalid_grant' }, 400);
  if (row.expires_at < now()) {
    await c.env.DB.prepare('DELETE FROM device_codes WHERE device_code_hash = ?').bind(hash).run();
    return c.json({ error: 'expired_token' }, 400);
  }
  if (!row.user_id) return c.json({ error: 'authorization_pending' }, 400);
  const del = await c.env.DB.prepare('DELETE FROM device_codes WHERE device_code_hash = ?').bind(hash).run();
  if (!del.meta.changes) return c.json({ error: 'invalid_grant' }, 400);
  return c.json({ refresh_token: await issueRefresh(c.env, row.user_id, 'cli'), expires_in: REFRESH_TTL });
});

df.get('/link', (c) => c.html(linkForm(c.req.query('code') ?? '')));

df.post('/link', async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const code = String(form.user_code ?? '').trim().toUpperCase();
  const row = await c.env.DB.prepare(
    'SELECT 1 AS ok FROM device_codes WHERE user_code = ? AND expires_at > ? AND user_id IS NULL',
  )
    .bind(code, now())
    .first();
  if (!row) return c.html(linkForm(code, 'Unknown or expired code.'), 404);
  return c.redirect(await startGithub(c.env, 'link', { extra: code }), 302);
});

export default df;
