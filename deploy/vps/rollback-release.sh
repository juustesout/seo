#!/usr/bin/env bash
# Runs on the VPS. Manually switches "current" to a previous release and
# restarts the services. With no argument it picks the newest release that is
# not currently active.
set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/seo-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
SERVICES="${SERVICES:-seo-api seo-worker}"

CURRENT_LINK="$DEPLOY_ROOT/current"
TARGET="${1:-}"

log() { printf '[rollback] %s\n' "$*"; }
die() { printf '[rollback] ERROR: %s\n' "$*" >&2; exit 1; }

if [ -z "$TARGET" ]; then
  CURRENT="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  TARGET="$(ls -1dt "$DEPLOY_ROOT"/releases/*/ 2>/dev/null | sed 's:/*$::' | grep -v -F -x "$CURRENT" | head -1 || true)"
fi
[ -n "$TARGET" ] && [ -d "$TARGET" ] || die "no rollback target found"

log "switching current -> $TARGET"
ln -sfn "$TARGET" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl restart $SERVICES 2>/dev/null; then
    sudo -n systemctl restart $SERVICES
  fi
fi

for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "health check OK; now running $TARGET"
    exit 0
  fi
  sleep 2
done

die "health check failed after rollback to $TARGET"
