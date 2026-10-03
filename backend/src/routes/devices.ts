import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { cf, CfError } from '../lib/cf';
import { newDeviceId, now } from '../lib/crypto';
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
  const dnsName = `${deviceId}.${c.env.DNS_SUFFIX}`;
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

export default devices;
