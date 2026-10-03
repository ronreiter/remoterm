import { SELF, env, fetchMock } from 'cloudflare:test';
import { signAccessToken } from '../src/lib/jwt';
import { now } from '../src/lib/crypto';

export const ORIGIN = 'https://api.remoterm.io';

export function api(path: string, init: RequestInit = {}) {
  return SELF.fetch(ORIGIN + path, { redirect: 'manual', ...init });
}

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } };
}

/** Stub the two GitHub calls made by the OAuth callback. */
export function mockGithub(user = { id: 4242, login: 'octocat' }) {
  const gh = fetchMock.get('https://github.com');
  gh.intercept({ path: '/login/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'gho_test' });
  fetchMock
    .get('https://api.github.com')
    .intercept({ path: '/user', headers: { authorization: 'Bearer gho_test' } })
    .reply(200, user);
}

export async function resetDb() {
  for (const t of ['devices', 'refresh_tokens', 'auth_codes', 'device_codes', 'oauth_states', 'users']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
}

export async function createUser(id = 'user1', login = 'octocat', githubId = 4242) {
  await env.DB.prepare('INSERT INTO users (id, github_id, login, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, githubId, login, now())
    .run();
  return id;
}

export async function authHeader(userId: string, aud = 'api') {
  return { authorization: `Bearer ${await signAccessToken(env, { sub: userId, aud })}` };
}

/** Pull `state` out of a redirect to github.com/login/oauth/authorize. */
export function stateFrom(res: Response): string {
  const loc = new URL(res.headers.get('location')!);
  return loc.searchParams.get('state')!;
}
