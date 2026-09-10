#!/usr/bin/env bash
# Renders the systemd unit templates with the real deploy root and service user
# and installs them. Run on the VPS with sudo available.
set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/seo-api}"
SERVICE_USER="${SERVICE_USER:-root}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for unit in seo-api seo-worker; do
  sed -e "s|@DEPLOY_ROOT@|$DEPLOY_ROOT|g" \
      -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
      "$SCRIPT_DIR/$unit.service" \
    | sudo tee "/etc/systemd/system/$unit.service" >/dev/null
  echo "[systemd] installed $unit.service"
done

sudo systemctl daemon-reload
echo "[systemd] daemon reloaded; enable with: sudo systemctl enable --now seo-api seo-worker"
