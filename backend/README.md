# remoterm-api

Cloudflare Worker + D1 for `api.remoterm.io`: GitHub OAuth (app / CLI / web), EdDSA access JWTs + JWKS, and per-device Cloudflare Tunnel + DNS provisioning.

## Develop

```
npm install
npm test            # vitest + @cloudflare/vitest-pool-workers (Miniflare D1, fetchMock for GitHub/Cloudflare)
npm run typecheck
```

## One-time setup (owner)

1. `wrangler d1 create remoterm` and put the id in `wrangler.jsonc` (`database_id`).
2. Set `CF_ACCOUNT_ID` and `CF_ZONE_ID` (remoterm.io zone) in `wrangler.jsonc` vars.
3. `wrangler d1 migrations apply remoterm --remote`
4. Secrets (`wrangler secret put <NAME>`):
   - `GITHUB_CLIENT_SECRET` - GitHub OAuth app secret (callback `https://api.remoterm.io/auth/github/callback`)
   - `CF_API_TOKEN` - scoped token: Account > Cloudflare Tunnel: Edit; Zone (remoterm.io) > DNS: Edit
   - `JWT_PRIVATE_KEY` - run `npm run gen-jwt-key`, paste the private JWK line
5. Uncomment the `routes` entry in `wrangler.jsonc` for `api.remoterm.io`, then `wrangler deploy`.

Vars: `TUNNEL_DOMAIN` (`remoterm.io`), `DNS_SUFFIX` (empty; DNS record name is `<deviceId>` or `<deviceId>.<DNS_SUFFIX>`; keep hosts one label deep so the free Universal SSL cert `*.remoterm.io` covers them), `GITHUB_CLIENT_ID`, `API_ORIGIN`, `WEB_ORIGIN`, `COOKIE_DOMAIN`.

## Endpoints

Auth: `GET /auth/github?client=app&challenge=<S256>|web`, `GET /auth/github/callback`, `POST /auth/token {code, verifier}`, `POST /auth/refresh` (body `refresh_token` or `rt` cookie), `POST /auth/logout` (clears the `rt` cookie, deletes that refresh token), `POST /auth/device`, `POST /auth/device/token`, `GET|POST /link`, `POST /auth/revoke-all`, `GET /me`, `GET /.well-known/jwks.json`.

CORS: `/me`, `/auth/refresh`, `/auth/logout`, `/devices`, `/devices/*` reply to `Origin == WEB_ORIGIN` with `Access-Control-Allow-Origin: <WEB_ORIGIN>` + `Allow-Credentials: true` (other origins get no CORS headers).

Devices (Bearer api JWT): `POST /devices`, `GET /devices`, `PUT /devices/:id/port`, `GET /devices/:id/tunnel-token`, `POST /devices/:id/attach-token`, `POST /devices/:id/heartbeat`, `GET /devices/:id/agent-config`, `DELETE /devices/:id`.
