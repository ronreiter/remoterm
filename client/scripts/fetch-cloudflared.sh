#!/usr/bin/env bash
# Downloads the pinned cloudflared macOS release (arm64 + amd64) into
# client/resources/bin/ (gitignored). electron-builder ships the matching
# binary via extraResources (see electron-builder.yml).
#
#   bash scripts/fetch-cloudflared.sh              # both architectures
#   CLOUDFLARED_VERSION=2025.8.1 bash scripts/fetch-cloudflared.sh
#   ARCHS="arm64" bash scripts/fetch-cloudflared.sh
#
# Files are named cloudflared-darwin-arm64 / cloudflared-darwin-x64 (x64 is the
# Node/Electron name for amd64). Existing files are kept unless FORCE=1.
set -euo pipefail

VERSION="${CLOUDFLARED_VERSION:-2025.8.1}"
ARCHS="${ARCHS:-arm64 amd64}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/resources/bin"
BASE="https://github.com/cloudflare/cloudflared/releases/download/${VERSION}"

mkdir -p "$DEST"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for arch in $ARCHS; do
  case "$arch" in
    arm64) out="cloudflared-darwin-arm64" ;;
    amd64|x64) arch=amd64; out="cloudflared-darwin-x64" ;;
    *) echo "unknown arch: $arch" >&2; exit 1 ;;
  esac
  if [[ -x "$DEST/$out" && "${FORCE:-0}" != "1" ]]; then
    echo "$out already present ($("$DEST/$out" --version 2>/dev/null | head -1 || echo unknown)); set FORCE=1 to re-download"
    continue
  fi
  url="${BASE}/cloudflared-darwin-${arch}.tgz"
  echo "Downloading $url"
  curl -fsSL --retry 3 -o "$tmp/cf-${arch}.tgz" "$url"
  tar -xzf "$tmp/cf-${arch}.tgz" -C "$tmp"
  mv "$tmp/cloudflared" "$DEST/$out"
  chmod 755 "$DEST/$out"
  echo "  -> $DEST/$out"
done

echo "cloudflared ${VERSION} ready in $DEST"
