#!/usr/bin/env bash
# Focused smoke checks for the Content Studio Phase H2 schedule date helpers.
# Runs schedule-date-utils-check.ts once per timezone: the calendar-day logic
# must hold across the UTC-midnight boundary and DST transitions. No web test
# runner is introduced; this reuses the api workspace's tsx binary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/apps/api/node_modules/.bin/tsx"
CHECK="$ROOT/scripts/schedule-date-utils-check.ts"

if [ ! -x "$TSX" ]; then
  echo "tsx not found at $TSX — run 'pnpm install' first" >&2
  exit 1
fi

for zone in UTC Etc/GMT+12 Etc/GMT-14 Europe/Amsterdam America/New_York; do
  TZ="$zone" "$TSX" "$CHECK"
done

echo "All schedule date-helper checks passed across timezones."
