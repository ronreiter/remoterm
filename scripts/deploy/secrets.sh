#!/usr/bin/env bash
# Sets the remoterm-api Worker secrets. Existing secrets are left alone unless
# FORCE=1 (CF_API_TOKEN is always refreshed from its file).
#   CF_TOKEN_FILE  scoped Cloudflare token (Connectors Write + DNS Write on remoterm.io)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/backend"
WRANGLER=./node_modules/.bin/wrangler
CF_TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.config/remoterm-deploy/cf-worker-api-token}"
FORCE="${FORCE:-0}"

existing="$("$WRANGLER" secret list 2>/dev/null || true)"
has() { [ "$FORCE" != 1 ] && grep -q "\"$1\"" <<<"$existing"; }

[ -r "$CF_TOKEN_FILE" ] || { echo "missing $CF_TOKEN_FILE (scoped Cloudflare API token)" >&2; exit 1; }
"$WRANGLER" secret put CF_API_TOKEN < "$CF_TOKEN_FILE"

if has JWT_PRIVATE_KEY; then
  echo "JWT_PRIVATE_KEY already set (FORCE=1 rotates it and signs everyone out)"
else
  npm run -s gen-jwt-key | sed -n 2p | "$WRANGLER" secret put JWT_PRIVATE_KEY
fi

if has GITHUB_CLIENT_SECRET; then
  echo "GITHUB_CLIENT_SECRET already set"
else
  [ -t 0 ] || { echo "GITHUB_CLIENT_SECRET needs an interactive terminal" >&2; exit 1; }
  echo "Generate one at https://github.com/settings/applications/3902655"
  read -r -s -p "Paste the GitHub client secret: " GH_SECRET; echo
  printf '%s' "$GH_SECRET" | "$WRANGLER" secret put GITHUB_CLIENT_SECRET
  unset GH_SECRET
fi
