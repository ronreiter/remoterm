import type { Context, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppEnv, Env } from '../env';
import { now, randomToken, sha256Hex } from './crypto';
import { verifyAccessToken } from './jwt';

export const REFRESH_TTL = 90 * 86400;
export const COOKIE_NAME = 'rt';

export type ClientKind = 'app' | 'cli' | 'web';

export async function upsertUser(env: Env, gh: { id: number; login: string }): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE github_id = ?')
    .bind(gh.id)
    .first<{ id: string }>();
  if (existing) {
    await env.DB.prepare('UPDATE users SET login = ? WHERE id = ?').bind(gh.login, existing.id).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, github_id, login, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, gh.id, gh.login, now())
    .run();
  return id;
}

export async function issueRefresh(env: Env, userId: string, kind: ClientKind): Promise<string> {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare(
    'INSERT INTO refresh_tokens (hash, user_id, client_kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, kind, t, t + REFRESH_TTL)
    .run();
  return token;
}

export function setRefreshCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    domain: c.env.COOKIE_DOMAIN,
    path: '/',
    maxAge: REFRESH_TTL,
  });
}

/** Bearer api-audience JWT; rejects tokens issued at/before users.revoked_before. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return c.json({ error: 'unauthorized' }, 401);
  try {
    const claims = await verifyAccessToken(c.env, m[1], 'api');
    const user = await c.env.DB.prepare('SELECT revoked_before FROM users WHERE id = ?')
      .bind(claims.sub)
      .first<{ revoked_before: number | null }>();
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (user.revoked_before != null && claims.iat <= user.revoked_before) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('userId', claims.sub);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};
