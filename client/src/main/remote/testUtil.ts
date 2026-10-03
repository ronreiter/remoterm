// Test-only helpers: a locally generated Ed25519 key acting as the backend's JWKS signer.
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint, type JWK, type KeyLike } from 'jose'
import type { AgentConfig } from './auth'

export interface TestKeys {
  jwks: { keys: (JWK & { kid: string })[] }
  kid: string
  sign(p: { sub: string; aud: string; iat?: number; exp?: number }): Promise<string>
}

export async function makeKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  const pub = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(pub)
  return {
    kid,
    jwks: { keys: [{ ...pub, alg: 'EdDSA', use: 'sig', kid }] },
    sign: (p) => signWith(privateKey, kid, p)
  }
}

export async function signWith(
  key: KeyLike,
  kid: string,
  p: { sub: string; aud: string; iat?: number; exp?: number }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setSubject(p.sub)
    .setAudience(p.aud)
    .setIssuedAt(p.iat ?? now)
    .setExpirationTime(p.exp ?? now + 600)
    .setJti(Math.random().toString(36).slice(2))
    .sign(key)
}

/** A token signed by a different key but claiming the right kid. */
export async function badSignatureToken(kid: string, p: { sub: string; aud: string }): Promise<string> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  return signWith(privateKey, kid, p)
}

export function staticConfig(keys: TestKeys, owner: string, revokedBefore: number | null = null): AgentConfig {
  return { ownerUserId: owner, ownerLogin: 'octocat', revokedBefore, jwks: keys.jwks }
}
