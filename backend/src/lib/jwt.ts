import { SignJWT, jwtVerify, importJWK, calculateJwkThumbprint, type JWK } from 'jose';
import type { Env } from '../env';
import { randomToken } from './crypto';

export const ACCESS_TTL_SECONDS = 600;

export interface AccessClaims {
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

function privateJwk(env: Env): JWK {
  return JSON.parse(env.JWT_PRIVATE_KEY) as JWK;
}

function publicJwk(env: Env): JWK {
  const { kty, crv, x } = privateJwk(env);
  return { kty, crv, x };
}

async function kid(env: Env): Promise<string> {
  return calculateJwkThumbprint(publicJwk(env));
}

export async function getJwks(env: Env): Promise<{ keys: (JWK & { kid: string })[] }> {
  return { keys: [{ ...publicJwk(env), alg: 'EdDSA', use: 'sig', kid: await kid(env) }] };
}

export async function signAccessToken(env: Env, p: { sub: string; aud: string }): Promise<string> {
  const key = await importJWK(privateJwk(env), 'EdDSA');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: await kid(env) })
    .setSubject(p.sub)
    .setAudience(p.aud)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .setJti(randomToken(12))
    .sign(key);
}

export async function verifyAccessToken(env: Env, token: string, aud: string): Promise<AccessClaims> {
  const key = await importJWK(publicJwk(env), 'EdDSA');
  const { payload } = await jwtVerify(token, key, { audience: aud, algorithms: ['EdDSA'] });
  return payload as unknown as AccessClaims;
}
