#!/usr/bin/env bash
# Runs on the VPS. Extracts a pre-built artifact into a new release directory,
# atomically switches the "current" symlink, restarts the services and verifies
# the API health endpoint. Rolls back to the previous release on failure.
set -euo pipefail

RELEASE_ID="${1:?usage: deploy-release.sh <release-id>}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/seo-api}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
SERVICES="${SERVICES:-seo-api seo-worker}"

RELEASES_DIR="$DEPLOY_ROOT/releases"
INCOMING="$DEPLOY_ROOT/incoming/$RELEASE_ID.tar.gz"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_LINK="$DEPLOY_ROOT/current"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$INCOMING" ] || die "missing artifact: $INCOMING"
[ -e "$RELEASE_DIR" ] && die "release already exists: $RELEASE_DIR"

PREVIOUS_TARGET=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
fi

mkdir -p "$RELEASE_DIR"
tar -xzf "$INCOMING" -C "$RELEASE_DIR"
[ -f "$RELEASE_DIR/dist/index.js" ] || die "artifact is missing dist/index.js"
[ -f "$RELEASE_DIR/dist/worker.js" ] || die "artifact is missing dist/worker.js"

switch_current() {
  ln -sfn "$1" "$CURRENT_LINK.tmp"
  mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
}

restart_services() {
  if command -v systemctl >/dev/null 2>&1; then
    if ! systemctl restart $SERVICES 2>/dev/null; then
      sudo -n systemctl restart $SERVICES
    fi
  fi
}

wait_for_health() {
  local i
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

switch_current "$RELEASE_DIR"
log "activated $RELEASE_ID"
restart_services

if ! wait_for_health; then
  log "health check failed: $HEALTH_URL"
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    log "rolling back to $PREVIOUS_TARGET"
    switch_current "$PREVIOUS_TARGET"
    restart_services
    wait_for_health || log "rollback health check also failed"
  fi
  die "deployment failed; previous release restored"
fi

log "health check OK"

if [ "${PRUNE_RELEASES:-true}" = "true" ] && [ "$KEEP_RELEASES" -gt 0 ]; then
  mapfile -t OLD_RELEASES < <(
    ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/*$::' | tail -n +"$((KEEP_RELEASES + 1))"
  )
  for dir in "${OLD_RELEASES[@]:-}"; do
    [ -z "$dir" ] && continue
    resolved="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
    [ "$dir" = "$resolved" ] && continue
    [ "$dir" = "$PREVIOUS_TARGET" ] && continue
    log "pruning old release $dir"
    rm -rf -- "$dir"
  done
fi

log "release $RELEASE_ID is live"
