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

export interface CfCall {
  method: string;
  path: string;
  body?: any;
}

const CF_BASE = '/client/v4';

/** Stub of the Cloudflare API: each `on` registers one expected call (asserted by assertNoPendingInterceptors). */
export function cfStub() {
  const calls: CfCall[] = [];
  const on = (method: string, path: string, status: number, result: unknown, errMsg = 'cf failure') => {
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ path: CF_BASE + path, method, headers: { authorization: 'Bearer cf-token' } })
      .reply(
        status,
        ((o: { method: string; path: string; body?: string | null }) => {
          calls.push({ method: o.method, path: o.path.replace(CF_BASE, ''), body: o.body ? JSON.parse(o.body) : undefined });
          return status < 300
            ? { success: true, errors: [], result }
            : { success: false, errors: [{ code: 1000, message: errMsg }], result: null };
        }) as any,
        { headers: { 'content-type': 'application/json' } },
      );
  };
  return { calls, on };
}

export const ACCT = '/accounts/acct123/cfd_tunnel';
export const ZONE = '/zones/zone123/dns_records';

/** Seed a device row directly. */
export async function seedDevice(
  userId: string,
  id: string,
  name: string,
  extra: { tunnel_id?: string; dns_record_id?: string; port?: number } = {},
) {
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, name, tunnel_id, dns_record_id, port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, name, extra.tunnel_id ?? `tun-${id}`, extra.dns_record_id ?? `dns-${id}`, extra.port ?? 7000, now())
    .run();
}
