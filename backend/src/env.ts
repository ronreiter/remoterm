export interface Env {
  DB: D1Database;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  TUNNEL_DOMAIN: string;
  GITHUB_CLIENT_ID: string;
  API_ORIGIN: string;
  WEB_ORIGIN: string;
  COOKIE_DOMAIN: string;
  // secrets
  GITHUB_CLIENT_SECRET: string;
  CF_API_TOKEN: string;
  JWT_PRIVATE_KEY: string;
}

export type AppEnv = { Bindings: Env; Variables: { userId: string } };
