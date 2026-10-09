#!/usr/bin/env bash
# Creates the `remoterm` D1 database if it does not exist and writes its id into
# backend/wrangler.jsonc. Runs `wrangler d1 create` outside backend/ so wrangler
# cannot append a duplicate binding to the config.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$ROOT/backend/wrangler.jsonc"
WRANGLER="$ROOT/backend/node_modules/.bin/wrangler"
NAME=remoterm

lookup() {
  (cd "$ROOT/backend" && "$WRANGLER" d1 list --json) |
    python3 -c "import sys,json;print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='$NAME'),''))"
}

ID="$(lookup)"
if [ -z "$ID" ]; then
  TMP="$(mktemp -d)"
  (cd "$TMP" && "$WRANGLER" d1 create "$NAME")
  rm -rf "$TMP"
  ID="$(lookup)"
fi
[ -n "$ID" ] || { echo "could not find or create D1 database '$NAME'" >&2; exit 1; }

python3 - "$CONFIG" "$ID" <<'EOF'
import re, sys
path, db_id = sys.argv[1], sys.argv[2]
s = open(path).read()
n = re.sub(r'("database_id":\s*")[^"]*(")', rf'\g<1>{db_id}\2', s, count=1)
if n != s:
    open(path, "w").write(n)
EOF
echo "D1 '$NAME' = $ID"
