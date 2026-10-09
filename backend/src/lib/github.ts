import type { Env } from '../env';

export function authorizeUrl(env: Env, state: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${env.API_ORIGIN}/auth/github/callback`);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', 'read:user');
  return u.toString();
}

export interface GithubUser {
  id: number;
  login: string;
}

/** Exchange an OAuth code for the GitHub user. Throws on any failure. */
export async function githubUserFromCode(env: Env, code: string): Promise<GithubUser> {
  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.API_ORIGIN}/auth/github/callback`,
    }),
  });
  const tok = (await tokRes.json()) as { access_token?: string; error?: string };
  if (!tokRes.ok || !tok.access_token) throw new Error(tok.error ?? 'github_token_exchange_failed');

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'remoterm-api',
    },
  });
  if (!userRes.ok) throw new Error('github_user_failed');
  const u = (await userRes.json()) as GithubUser;
  return { id: u.id, login: u.login };
}
