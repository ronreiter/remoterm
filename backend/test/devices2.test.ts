import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decodeJwt } from 'jose';
import { api, json, resetDb, createUser, authHeader, cfStub, seedDevice, ACCT, ZONE } from './helpers';
import { now } from '../src/lib/crypto';

beforeEach(async () => {
  await resetDb();
  await createUser('user1', 'octocat', 1);
  await createUser('user2', 'other', 2);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const as = async (user: string) => ({ headers: await authHeader(user) });
const req = async (method: string, path: string, user = 'user1', body?: unknown) =>
  api(path, {
    method,
    headers: { ...(await authHeader(user)), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('GET /devices', () => {
  it('lists only own devices with online from tunnel status and last_seen', async () => {
    await seedDevice('user1', 'listaaaaaaaa', 'mac', { tunnel_id: 'tl-a' });
    await seedDevice('user1', 'listbbbbbbbb', 'pc', { tunnel_id: 'tl-b' });
    await seedDevice('user2', 'listcccccccc', 'theirs', { tunnel_id: 'tl-c' });
    await env.DB.prepare('UPDATE devices SET last_seen = 1234 WHERE id = ?').bind('listaaaaaaaa').run();
    const cf = cfStub();
    cf.on('GET', `${ACCT}/tl-a`, 200, { status: 'healthy', connections: [{}] });
    cf.on('GET', `${ACCT}/tl-b`, 200, { status: 'inactive', connections: [] });

    const res = await req('GET', '/devices');
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list.map((d) => d.name).sort()).toEqual(['mac', 'pc']);
    const mac = list.find((d) => d.name === 'mac');
    expect(mac).toMatchObject({
      id: 'listaaaaaaaa',
      hostname: 'listaaaaaaaa.remoterm.io',
      online: true,
      last_seen: 1234,
      port: 7000,
    });
    expect(list.find((d) => d.name === 'pc').online).toBe(false);
  });

  it('caches tunnel status for 15 seconds', async () => {
    await seedDevice('user1', 'cacheaaaaaaa', 'mac', { tunnel_id: 'tc-a' });
    const cf = cfStub();
    cf.on('GET', `${ACCT}/tc-a`, 200, { status: 'healthy', connections: [{}] }); // only once
    await req('GET', '/devices');
    const second = (await (await req('GET', '/devices')).json()) as any[];
    expect(second[0].online).toBe(true);
    expect(cf.calls).toHaveLength(1);
  });

  it('reports offline (not an error) when the status lookup fails', async () => {
    await seedDevice('user1', 'failaaaaaaaa', 'mac', { tunnel_id: 'tf-a' });
    cfStub().on('GET', `${ACCT}/tf-a`, 500, null);
    const res = await req('GET', '/devices');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[])[0].online).toBe(false);
  });
});

describe('PUT /devices/:id/port', () => {
  it('re-PUTs the ingress config with the new port and stores it', async () => {
    await seedDevice('user1', 'portaaaaaaaa', 'mac', { tunnel_id: 'tp-a' });
    const cf = cfStub();
    cf.on('PUT', `${ACCT}/tp-a/configurations`, 200, {});
    const res = await req('PUT', '/devices/portaaaaaaaa/port', 'user1', { port: 9000 });
    expect(res.status).toBe(200);
    expect(cf.calls[0].body).toEqual({
      config: {
        ingress: [
          { hostname: 'portaaaaaaaa.remoterm.io', service: 'http://localhost:9000' },
          { service: 'http_status:404' },
        ],
      },
    });
    const row = await env.DB.prepare('SELECT port FROM devices WHERE id = ?').bind('portaaaaaaaa').first<{ port: number }>();
    expect(row!.port).toBe(9000);
  });

  it('keeps the old port when Cloudflare fails', async () => {
    await seedDevice('user1', 'portbbbbbbbb', 'mac', { tunnel_id: 'tp-b' });
    cfStub().on('PUT', `${ACCT}/tp-b/configurations`, 500, null);
    expect((await req('PUT', '/devices/portbbbbbbbb/port', 'user1', { port: 9000 })).status).toBe(502);
    const row = await env.DB.prepare('SELECT port FROM devices WHERE id = ?').bind('portbbbbbbbb').first<{ port: number }>();
    expect(row!.port).toBe(7000);
  });

  it('rejects invalid ports with 400', async () => {
    await seedDevice('user1', 'portcccccccc', 'mac');
    expect((await req('PUT', '/devices/portcccccccc/port', 'user1', { port: 0 })).status).toBe(400);
  });
});

describe('GET /devices/:id/tunnel-token', () => {
  it('re-fetches the token from Cloudflare', async () => {
    await seedDevice('user1', 'tokaaaaaaaaa', 'mac', { tunnel_id: 'tt-a' });
    cfStub().on('GET', `${ACCT}/tt-a/token`, 200, 'TOKEN-XYZ');
    const res = await req('GET', '/devices/tokaaaaaaaaa/tunnel-token');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tunnelToken: 'TOKEN-XYZ' });
  });

  it('returns 404 tunnel_not_found when the tunnel was deleted remotely', async () => {
    await seedDevice('user1', 'tokbbbbbbbbb', 'mac', { tunnel_id: 'tt-b' });
    cfStub().on('GET', `${ACCT}/tt-b/token`, 404, null);
    const res = await req('GET', '/devices/tokbbbbbbbbb/tunnel-token');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'tunnel_not_found' });
  });
});

describe('POST /devices/:id/attach-token', () => {
  it('issues a JWT with aud=deviceId for the owner', async () => {
    await seedDevice('user1', 'attaaaaaaaaa', 'mac');
    const res = await req('POST', '/devices/attaaaaaaaaa/attach-token');
    expect(res.status).toBe(200);
    const out = (await res.json()) as { token: string; hostname: string; expires_in: number };
    const c = decodeJwt(out.token);
    expect(c.aud).toBe('attaaaaaaaaa');
    expect(c.sub).toBe('user1');
    expect(c.exp! - c.iat!).toBe(600);
    expect(out.hostname).toBe('attaaaaaaaaa.remoterm.io');
  });

  it("is 404 for someone else's device", async () => {
    await seedDevice('user2', 'attbbbbbbbbb', 'mac');
    expect((await req('POST', '/devices/attbbbbbbbbb/attach-token')).status).toBe(404);
  });
});

describe('POST /devices/:id/heartbeat', () => {
  it('updates last_seen', async () => {
    await seedDevice('user1', 'hbaaaaaaaaaa', 'mac');
    expect((await req('POST', '/devices/hbaaaaaaaaaa/heartbeat')).status).toBe(200);
    const row = await env.DB.prepare('SELECT last_seen FROM devices WHERE id = ?').bind('hbaaaaaaaaaa').first<{ last_seen: number }>();
    expect(Math.abs(row!.last_seen - now())).toBeLessThanOrEqual(1);
  });
});

describe('DELETE /devices/:id', () => {
  it('deletes DNS, cleans connections, deletes tunnel, then the row - in order', async () => {
    await seedDevice('user1', 'delaaaaaaaaa', 'mac', { tunnel_id: 'td-a', dns_record_id: 'dns-a' });
    const cf = cfStub();
    cf.on('DELETE', `${ZONE}/dns-a`, 200, {});
    cf.on('DELETE', `${ACCT}/td-a/connections`, 200, {});
    cf.on('DELETE', `${ACCT}/td-a`, 200, {});
    const res = await req('DELETE', '/devices/delaaaaaaaaa');
    expect(res.status).toBe(200);
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE ${ZONE}/dns-a`,
      `DELETE ${ACCT}/td-a/connections`,
      `DELETE ${ACCT}/td-a`,
    ]);
    expect(await env.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind('delaaaaaaaaa').first()).toBeNull();
  });

  it('treats Cloudflare 404s as already deleted', async () => {
    await seedDevice('user1', 'delbbbbbbbbb', 'mac', { tunnel_id: 'td-b', dns_record_id: 'dns-b' });
    const cf = cfStub();
    cf.on('DELETE', `${ZONE}/dns-b`, 404, null);
    cf.on('DELETE', `${ACCT}/td-b/connections`, 404, null);
    cf.on('DELETE', `${ACCT}/td-b`, 404, null);
    expect((await req('DELETE', '/devices/delbbbbbbbbb')).status).toBe(200);
    expect(await env.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind('delbbbbbbbbb').first()).toBeNull();
  });

  it('keeps the row and returns 502 on other Cloudflare failures', async () => {
    await seedDevice('user1', 'delcccccccccc', 'mac', { tunnel_id: 'td-c', dns_record_id: 'dns-c' });
    const cf = cfStub();
    cf.on('DELETE', `${ZONE}/dns-c`, 200, {});
    cf.on('DELETE', `${ACCT}/td-c/connections`, 500, null);
    expect((await req('DELETE', '/devices/delcccccccccc')).status).toBe(502);
    expect(await env.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind('delcccccccccc').first()).not.toBeNull();
  });

  it("cannot delete someone else's device", async () => {
    await seedDevice('user2', 'deldddddddd0', 'mac');
    expect((await req('DELETE', '/devices/deldddddddd0')).status).toBe(404);
  });
});

describe('GET /devices/:id/agent-config', () => {
  it('returns owner, revokedBefore and jwks for the owner', async () => {
    await seedDevice('user1', 'cfgaaaaaaaaa', 'mac');
    await env.DB.prepare('UPDATE users SET revoked_before = ? WHERE id = ?').bind(now() - 100, 'user1').run();
    const res = await req('GET', '/devices/cfgaaaaaaaaa/agent-config');
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.ownerUserId).toBe('user1');
    expect(out.ownerLogin).toBe('octocat');
    expect(out.revokedBefore).toBe(now() - 100);
    expect(out.jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(out.jwks.keys[0].d).toBeUndefined();
  });

  it('revokedBefore is null when never revoked', async () => {
    await seedDevice('user1', 'cfgbbbbbbbbb', 'mac');
    const out = (await (await req('GET', '/devices/cfgbbbbbbbbb/agent-config')).json()) as any;
    expect(out.revokedBefore).toBeNull();
  });

  it('is 404 for a non-owner and 401 without auth', async () => {
    await seedDevice('user1', 'cfgcccccccccc', 'mac');
    expect((await req('GET', '/devices/cfgcccccccccc/agent-config', 'user2')).status).toBe(404);
    expect((await api('/devices/cfgcccccccccc/agent-config')).status).toBe(401);
  });
});
