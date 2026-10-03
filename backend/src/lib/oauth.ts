import type { Env } from '../env';
import { now, randomToken, sha256Hex } from './crypto';
import { authorizeUrl } from './github';

const STATE_TTL = 600;

/** Create single-use OAuth state and return the GitHub authorize URL. */
export async function startGithub(
  env: Env,
  kind: 'app' | 'web' | 'link',
  opts: { challenge?: string; extra?: string } = {},
): Promise<string> {
  const state = randomToken(24);
  await env.DB.prepare(
    'INSERT INTO oauth_states (state_hash, client_kind, pkce_challenge, extra, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(await sha256Hex(state), kind, opts.challenge ?? null, opts.extra ?? null, now() + STATE_TTL)
    .run();
  return authorizeUrl(env, state);
}
