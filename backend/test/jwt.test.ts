import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { decodeProtectedHeader, decodeJwt, SignJWT, importJWK } from 'jose';
import { newDeviceId, newUserCode, randomToken, sha256Hex } from '../src/lib/crypto';
import { signAccessToken, verifyAccessToken, getJwks } from '../src/lib/jwt';

describe('crypto helpers', () => {
  it('device id is 12 lowercase base32 chars and random', () => {
    const a = newDeviceId();
    expect(a).toMatch(/^[a-z2-7]{12}$/);
    expect(newDeviceId()).not.toBe(a);
  });
  it('user code looks like XXXX-XXXX', () => {
    expect(newUserCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
  it('randomToken is 256 bit base64url; sha256Hex is stable', async () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('access JWT', () => {
  it('signs EdDSA with kid, aud, 10 minute ttl, jti', async () => {
    const t = await signAccessToken(env, { sub: 'u1', aud: 'api' });
    const h = decodeProtectedHeader(t);
    expect(h.alg).toBe('EdDSA');
    expect(h.kid).toBeTruthy();
    const c = decodeJwt(t);
    expect(c.sub).toBe('u1');
    expect(c.aud).toBe('api');
    expect(c.exp! - c.iat!).toBe(600);
    expect(c.jti).toBeTruthy();
  });

  it('verifies and returns claims', async () => {
    const t = await signAccessToken(env, { sub: 'u1', aud: 'dev123' });
    const c = await verifyAccessToken(env, t, 'dev123');
    expect(c.sub).toBe('u1');
    expect(c.aud).toBe('dev123');
  });

  it('rejects wrong audience', async () => {
    const t = await signAccessToken(env, { sub: 'u1', aud: 'api' });
    await expect(verifyAccessToken(env, t, 'dev123')).rejects.toThrow();
  });

  it('rejects tampered signature', async () => {
    const t = await signAccessToken(env, { sub: 'u1', aud: 'api' });
    const parts = t.split('.');
    const bad = parts[0] + '.' + parts[1] + '.' + (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await expect(verifyAccessToken(env, bad, 'api')).rejects.toThrow();
  });

  it('rejects expired token', async () => {
    const jwk = JSON.parse(env.JWT_PRIVATE_KEY);
    const key = await importJWK(jwk, 'EdDSA');
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('u1')
      .setAudience('api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 400)
      .sign(key);
    await expect(verifyAccessToken(env, t, 'api')).rejects.toThrow();
  });

  it('JWKS endpoint exposes public key with kid and no private part', async () => {
    const res = await SELF.fetch('https://api.remoterm.io/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, string>[] };
    expect(body.keys).toHaveLength(1);
    const k = body.keys[0];
    expect(k).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(k.kid).toBeTruthy();
    expect(k.d).toBeUndefined();
    const t = await signAccessToken(env, { sub: 'u1', aud: 'api' });
    expect(decodeProtectedHeader(t).kid).toBe(k.kid);
    expect((await getJwks(env)).keys[0].x).toBe(k.x);
  });
});
