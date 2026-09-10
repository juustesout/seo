#!/usr/bin/env bash
# Builds the self-contained API/worker runtime artifact.
# Runs on the CI runner only: the VPS never compiles TypeScript.
set -euo pipefail

OUT_DIR="${1:-artifact}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f "packages/contracts/dist/index.js" ]; then
  echo "contracts are not built; run: pnpm --filter @seo/contracts build" >&2
  exit 1
fi

STAGING="$(mktemp -d)"
STATE_FILE="node_modules/.pnpm-workspace-state-v1.json"
STATE_BACKUP=""
if [ -f "$STATE_FILE" ]; then
  STATE_BACKUP="$(mktemp)"
  cp "$STATE_FILE" "$STATE_BACKUP"
fi

# pnpm deploy emits a workspace-aware, production-only tree (dist +
# node_modules incl. @seo/contracts). --legacy is required on pnpm v10+.
pnpm --filter @seo/api deploy --prod --legacy "$STAGING"

# pnpm deploy rewrites the workspace install state to production-only; restore
# it so local/CI script runs keep dev dependencies.
if [ -n "$STATE_BACKUP" ]; then
  cp "$STATE_BACKUP" "$STATE_FILE"
fi

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/api-artifact.tar.gz"

# Ship only runtime files: no .env/secrets, no TypeScript source, no tests.
tar \
  --exclude='./src' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='./tsconfig.json' \
  --exclude='*.test.js' \
  --exclude='*.test.js.map' \
  --exclude='*.test.d.ts' \
  --exclude='*.test.ts' \
  -czf "$TARBALL" -C "$STAGING" .

echo "artifact: $TARBALL"
du -h "$TARBALL"
sha256sum "$TARBALL"
