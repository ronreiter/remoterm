import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api, json, resetDb, createUser, authHeader, cfStub, seedDevice, ACCT, ZONE } from './helpers';

beforeEach(async () => {
  await resetDb();
  await createUser();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function post(body: unknown) {
  return api('/devices', json(body, await authHeader('user1')));
}

const count = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>())!.n;

describe('POST /devices', () => {
  it('requires auth', async () => {
    expect((await api('/devices', json({ name: 'a', port: 7000 }))).status).toBe(401);
  });

  it('provisions tunnel, ingress with 404 catch-all, DNS CNAME, in that exact order', async () => {
    const cf = cfStub();
    cf.on('POST', ACCT, 200, { id: 'tun-1', token: 'TOKEN-1' });
    cf.on('PUT', `${ACCT}/tun-1/configurations`, 200, {});
    cf.on('POST', ZONE, 200, { id: 'dns-1' });

    const res = await post({ name: 'my-mac', port: 7777 });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { deviceId: string; hostname: string; tunnelToken: string };
    expect(out.deviceId).toMatch(/^[a-z2-7]{12}$/);
    expect(out.hostname).toBe(`${out.deviceId}.t.remoterm.io`);
    expect(out.tunnelToken).toBe('TOKEN-1');

    expect(cf.calls).toEqual([
      { method: 'POST', path: ACCT, body: { name: `remoterm-${out.deviceId}`, config_src: 'cloudflare' } },
      {
        method: 'PUT',
        path: `${ACCT}/tun-1/configurations`,
        body: {
          config: {
            ingress: [
              { hostname: out.hostname, service: 'http://localhost:7777' },
              { service: 'http_status:404' },
            ],
          },
        },
      },
      {
        method: 'POST',
        path: ZONE,
        body: { type: 'CNAME', proxied: true, name: `${out.deviceId}.t`, content: 'tun-1.cfargotunnel.com' },
      },
    ]);

    const row = await env.DB.prepare('SELECT * FROM devices').first<Record<string, unknown>>();
    expect(row).toMatchObject({
      id: out.deviceId,
      user_id: 'user1',
      name: 'my-mac',
      tunnel_id: 'tun-1',
      dns_record_id: 'dns-1',
      port: 7777,
    });
  });

  it('rejects the 6th device with 409 device_limit and makes no CF calls', async () => {
    for (let i = 0; i < 5; i++) await seedDevice('user1', `dev${i}`.padEnd(12, 'a'), `m${i}`);
    const res = await post({ name: 'sixth', port: 7000 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'device_limit' });
  });

  it('rejects duplicate name for the same user with 409 name_taken', async () => {
    await seedDevice('user1', 'aaaaaaaaaaaa', 'my-mac');
    const res = await post({ name: 'my-mac', port: 7000 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'name_taken' });
  });

  it.each([
    [{ name: '', port: 7000 }],
    [{ name: 'ok', port: 0 }],
    [{ name: 'ok', port: 70000 }],
    [{ name: 'ok', port: 'x' }],
    [{ name: 'bad/name', port: 7000 }],
    [{ port: 7000 }],
  ])('rejects invalid body %j with 400', async (body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('rolls back the tunnel when ingress config fails', async () => {
    const cf = cfStub();
    cf.on('POST', ACCT, 200, { id: 'tun-1', token: 'T' });
    cf.on('PUT', `${ACCT}/tun-1/configurations`, 500, null);
    cf.on('DELETE', `${ACCT}/tun-1`, 200, {});
    const res = await post({ name: 'my-mac', port: 7777 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'cloudflare_error' });
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${ACCT}`,
      `PUT ${ACCT}/tun-1/configurations`,
      `DELETE ${ACCT}/tun-1`,
    ]);
    expect(await count()).toBe(0);
  });

  it('rolls back the tunnel when DNS creation fails', async () => {
    const cf = cfStub();
    cf.on('POST', ACCT, 200, { id: 'tun-1', token: 'T' });
    cf.on('PUT', `${ACCT}/tun-1/configurations`, 200, {});
    cf.on('POST', ZONE, 400, null, 'record exists');
    cf.on('DELETE', `${ACCT}/tun-1`, 200, {});
    const res = await post({ name: 'my-mac', port: 7777 });
    expect(res.status).toBe(502);
    expect(cf.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `${ACCT}/tun-1` });
    expect(await count()).toBe(0);
  });

  it('fails with 502 and creates nothing when tunnel creation itself fails', async () => {
    const cf = cfStub();
    cf.on('POST', ACCT, 403, null, 'forbidden');
    const res = await post({ name: 'my-mac', port: 7777 });
    expect(res.status).toBe(502);
    expect(cf.calls).toHaveLength(1);
  });

  it('rolls back DNS and tunnel when the DB insert fails', async () => {
    const cf = cfStub();
    cf.on('POST', ACCT, 200, { id: 'tun-1', token: 'T' });
    cf.on('PUT', `${ACCT}/tun-1/configurations`, 200, {});
    cf.on('POST', ZONE, 200, { id: 'dns-1' });
    cf.on('DELETE', `${ZONE}/dns-1`, 200, {});
    cf.on('DELETE', `${ACCT}/tun-1`, 200, {});
    await env.DB.exec("CREATE TRIGGER boom BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      const res = await post({ name: 'my-mac', port: 7777 });
      expect(res.status).toBe(500);
    } finally {
      await env.DB.exec('DROP TRIGGER boom');
    }
    expect(cf.calls.slice(-2).map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE ${ZONE}/dns-1`,
      `DELETE ${ACCT}/tun-1`,
    ]);
  });

  it('still reports the failure if rollback calls also fail', async () => {
    const cf = cfStub();
    cf.on('POST', ACCT, 200, { id: 'tun-1', token: 'T' });
    cf.on('PUT', `${ACCT}/tun-1/configurations`, 500, null);
    cf.on('DELETE', `${ACCT}/tun-1`, 500, null);
    const res = await post({ name: 'my-mac', port: 7777 });
    expect(res.status).toBe(502);
  });
});
