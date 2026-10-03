const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 then base64url (PKCE S256 transform). */
export async function sha256B64url(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return b64url(new Uint8Array(d));
}

/** 12-char lowercase base32 (60 bits of randomness). */
export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => B32[b & 31]).join('');
}

/** Human-typable code, XXXX-XXXX, no ambiguous chars. */
export function newUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const c = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export const now = () => Math.floor(Date.now() / 1000);
