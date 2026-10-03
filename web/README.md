# remoterm-web

Browser client for Remoterm remote sessions (`app.remoterm.io`): sign in with GitHub, pick a device, pick a running session, attach with xterm.js.

```
npm install
npm run dev           # Vite dev server
npm test              # vitest (token manager, routing, key bar, close codes)
npm run test:e2e      # Playwright; mocked API + mock agent WS server (PW_PORT / AGENT_PORT override ports)
npm run build         # tsc + vite build -> dist/
```

## Auth model

- Sign-in is a full-page redirect to `${VITE_API_ORIGIN}/auth/github?client=web`; the Worker sets an HttpOnly `rt` cookie on `.remoterm.io` and redirects back.
- The SPA exchanges the cookie at `POST /auth/refresh` (credentials: include) for an access JWT (aud=api) kept **in memory only**.
- Per device it requests `POST /devices/:id/attach-token` (aud=deviceId), uses it as Bearer for `https://<id>.<tunnel domain>/api/sessions`, and as the first WS frame for `/ws/attach/:sessionId?mode=control|view`. `AttachClient` fetches a fresh attach token on every reconnect. Tokens are never put in URLs or storage.

## Config (Vite env, build time)

`VITE_API_ORIGIN` (default `https://api.remoterm.io`), `VITE_TUNNEL_DOMAIN` (default `t.remoterm.io`). Tunnel domains starting with `localhost`/`127.` use plain http/ws (used by the e2e tests).

## Deploy (owner)

`wrangler.jsonc` defines the `remoterm-web` Workers static-assets project with SPA fallback. After adding the remoterm.io zone, uncomment the `app.remoterm.io` route and run `npm run build && npx wrangler deploy`.

## Requirements on other components

- Backend: `WEB_ORIGIN` must equal the deployed origin (CORS + OAuth redirect).
- Host agent: the browser calls `https://<id>.t.remoterm.io/api/sessions` cross-origin from `app.remoterm.io`, so the agent must answer an unauthenticated `OPTIONS` preflight and add `Access-Control-Allow-Origin: https://app.remoterm.io` (+ `Access-Control-Allow-Headers: authorization`) to `/api/*` responses.
