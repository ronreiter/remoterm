import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { cf, CfError } from '../lib/cf';
import { newDeviceId, now } from '../lib/crypto';
import { ACCESS_TTL_SECONDS, getJwks, signAccessToken } from '../lib/jwt';
import { requireAuth } from '../lib/session';

export const MAX_DEVICES = 5;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

const devices = new Hono<AppEnv>();
devices.use('/devices', requireAuth);
devices.use('/devices/*', requireAuth);

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;

devices.post('/devices', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ name?: unknown; port?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const { name, port } = body;
  if (typeof name !== 'string' || !NAME_RE.test(name) || !validPort(port)) {
    return c.json({ error: 'invalid_request', message: 'name (letters, digits, . _ -) and port (1-65535) required' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT name FROM devices WHERE user_id = ?')
    .bind(userId)
    .all<{ name: string }>();
  if (existing.results.length >= MAX_DEVICES) return c.json({ error: 'device_limit', max: MAX_DEVICES }, 409);
  if (existing.results.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: 'name_taken' }, 409);
  }

  const deviceId = newDeviceId();
  const hostname = `${deviceId}.${c.env.TUNNEL_DOMAIN}`;
  // One label under the zone keeps the host inside the free Universal SSL cert (*.remoterm.io).
  const dnsName = c.env.DNS_SUFFIX ? `${deviceId}.${c.env.DNS_SUFFIX}` : deviceId;
  const api = cf(c.env);
  let tunnelId: string | undefined;
  let dnsId: string | undefined;

  const rollback = async () => {
    if (dnsId) await api.deleteDns(dnsId).catch((e) => console.error('rollback deleteDns failed', e));
    if (tunnelId) await api.deleteTunnel(tunnelId).catch((e) => console.error('rollback deleteTunnel failed', e));
  };

  let tunnelToken: string;
  try {
    const t = await api.createTunnel(`remoterm-${deviceId}`);
    tunnelId = t.id;
    tunnelToken = t.token;
    await api.putConfig(tunnelId, hostname, port);
    dnsId = (await api.createDns(dnsName, tunnelId)).id;
  } catch (e) {
    await rollback();
    if (e instanceof CfError) {
      return c.json({ error: 'cloudflare_error', step: e.step, message: e.message }, 502);
    }
    throw e;
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO devices (id, user_id, name, tunnel_id, dns_record_id, port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(deviceId, userId, name, tunnelId, dnsId, port, now())
      .run();
  } catch (e) {
    await rollback();
    if (/UNIQUE/i.test(String(e))) return c.json({ error: 'name_taken' }, 409);
    return c.json({ error: 'internal_error' }, 500);
  }

  return c.json({ deviceId, hostname, tunnelToken }, 201);
});

// ---- per-device endpoints -------------------------------------------------

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  tunnel_id: string;
  dns_record_id: string;
  port: number;
  created_at: number;
  last_seen: number | null;
}

async function ownedDevice(c: Context<AppEnv>, id: string): Promise<DeviceRow | null> {
  return c.env.DB.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?')
    .bind(id, c.get('userId'))
    .first<DeviceRow>();
}

const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

function cfFail(c: Context<AppEnv>, e: unknown) {
  if (e instanceof CfError) {
    if (e.status === 404) return c.json({ error: 'tunnel_not_found', step: e.step }, 404);
    return c.json({ error: 'cloudflare_error', step: e.step, message: e.message }, 502);
  }
  throw e;
}

// Tunnel status cache (per isolate, 15 s) - spec section 7.
const STATUS_TTL_MS = 15_000;
const statusCache = new Map<string, { at: number; online: boolean }>();

async function isOnline(env: Env, tunnelId: string): Promise<boolean> {
  const hit = statusCache.get(tunnelId);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.online;
  let online = false;
  try {
    const t = await cf(env).getTunnel(tunnelId);
    online = t.status === 'healthy' || t.status === 'degraded';
  } catch {
    online = false;
  }
  statusCache.set(tunnelId, { at: Date.now(), online });
  return online;
}

devices.get('/devices', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at')
    .bind(c.get('userId'))
    .all<DeviceRow>();
  const out = await Promise.all(
    results.map(async (d) => ({
      id: d.id,
      name: d.name,
      hostname: `${d.id}.${c.env.TUNNEL_DOMAIN}`,
      port: d.port,
      created_at: d.created_at,
      last_seen: d.last_seen,
      online: await isOnline(c.env, d.tunnel_id),
    })),
  );
  return c.json(out);
});

devices.put('/devices/:id/port', async (c) => {
  const d = await ownedDevice(c, c.req.param('id'));
  if (!d) return notFound(c);
  const { port } = await c.req.json<{ port?: unknown }>().catch(() => ({}) as { port?: unknown });
  if (!validPort(port)) return c.json({ error: 'invalid_request', message: 'port (1-65535) required' }, 400);
  try {
    await cf(c.env).putConfig(d.tunnel_id, `${d.id}.${c.env.TUNNEL_DOMAIN}`, port);
  } catch (e) {
    return cfFail(c, e);
  }
  await c.env.DB.prepare('UPDATE devices SET port = ? WHERE id = ?').bind(port, d.id).run();
  return c.json({ ok: true, port });
});

devices.get('/devices/:id/tunnel-token', async (c) => {
  const d = await ownedDevice(c, c.req.param('id'));
  if (!d) return notFound(c);
  try {
    return c.json({ tunnelToken: await cf(c.env).getToken(d.tunnel_id) });
  } catch (e) {
    return cfFail(c, e);
  }
});

devices.post('/devices/:id/attach-token', async (c) => {
  const d = await ownedDevice(c, c.req.param('id'));
  if (!d) return notFound(c);
  const token = await signAccessToken(c.env, { sub: c.get('userId'), aud: d.id });
  return c.json({ token, hostname: `${d.id}.${c.env.TUNNEL_DOMAIN}`, expires_in: ACCESS_TTL_SECONDS });
});

devices.post('/devices/:id/heartbeat', async (c) => {
  const d = await ownedDevice(c, c.req.param('id'));
  if (!d) return notFound(c);
  await c.env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now(), d.id).run();
  return c.json({ ok: true });
});

devices.get('/devices/:id/agent-config', async (c) => {
  const d = await ownedDevice(c, c.req.param('id'));
  if (!d) return notFound(c);
  const u = await c.env.DB.prepare('SELECT id, login, revoked_before FROM users WHERE id = ?')
    .bind(d.user_id)
    .first<{ id: string; login: string; revoked_before: number | null }>();
  return c.json({
    ownerUserId: u!.id,
    ownerLogin: u!.login,
    revokedBefore: u!.revoked_before,
    jwks: await getJwks(c.env),
  });
});

devices.delete('/devices/:id', async (c) => {
  const d = await ownedDevice(c, c.req.param('id'));
  if (!d) return notFound(c);
  const api = cf(c.env);
  // A 404 means it is already gone; anything else aborts and keeps the row so the user can retry.
  const gone = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof CfError && e.status === 404)) throw e;
    }
  };
  try {
    await gone(api.deleteDns(d.dns_record_id));
    await gone(api.cleanConnections(d.tunnel_id));
    await gone(api.deleteTunnel(d.tunnel_id));
  } catch (e) {
    if (e instanceof CfError) return c.json({ error: 'cloudflare_error', step: e.step, message: e.message }, 502);
    throw e;
  }
  await c.env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(d.id).run();
  statusCache.delete(d.tunnel_id);
  return c.json({ ok: true });
});

export default devices;
