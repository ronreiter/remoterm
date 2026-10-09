import { beforeEach, describe, expect, it } from 'vitest';
import { api, authHeader, createUser, resetDb } from './helpers';

const WEB = 'https://app.remoterm.io';
const PATHS = ['/me', '/auth/refresh', '/auth/logout', '/devices', '/devices/abc/attach-token'];

beforeEach(resetDb);

describe('CORS for the web origin', () => {
  for (const p of PATHS) {
    it(`preflight ${p}`, async () => {
      const res = await api(p, {
        method: 'OPTIONS',
        headers: {
          origin: WEB,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });
  }

  it('adds CORS headers to real and error responses', async () => {
    const bad = await api('/devices', { headers: { origin: WEB } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(bad.headers.get('access-control-allow-credentials')).toBe('true');

    const uid = await createUser();
    const ok = await api('/me', { headers: { origin: WEB, ...(await authHeader(uid)) } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(WEB);
  });

  it('never allows other origins or wildcard', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const res = await api('/devices', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
    const res = await api('/healthz', { headers: { origin: WEB } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});
