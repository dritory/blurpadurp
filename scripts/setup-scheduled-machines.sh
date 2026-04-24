#!/usr/bin/env bash
# One-time setup for the scheduled-pipeline Fly Machines.
#
# Run this AFTER the app is deployed and the primary `app` machine is
# healthy. It creates one machine per scheduled stage with a stable
# name. Subsequent code deploys keep these in sync via
# .github/workflows/fly-deploy.yml which calls `fly machine update
# --image` — the machines don't get re-fired, their schedules don't
# drift, and multiple issues per week aren't generated.
#
# Idempotency: if a named machine already exists, the `fly machine run`
# below will fail with a name conflict. Destroy the old one first or
# just live with the error (the other four will still create). Running
# this a second time is safe after you've manually destroyed the
# existing named machines.
#
# Usage:
#   scripts/setup-scheduled-machines.sh [app-name]
# Defaults to FLY_APP env or "blurpadurp".

set -euo pipefail

APP="${1:-${FLY_APP:-blurpadurp}}"
REGION="${FLY_REGION:-ams}"

echo "Bootstrapping scheduled machines on app=$APP region=$REGION"

create_machine() {
  local name="$1"
  local schedule="$2"
  shift 2
  echo "--- creating $name ($schedule)"
  flyctl machine run . \
    --schedule "$schedule" \
    --region "$REGION" \
    --name "$name" \
    -a "$APP" \
    -- "$@"
}

create_machine ingest    hourly bun run cli ingest
create_machine dispatch  hourly bun run cli dispatch
create_machine score     daily  bun run cli score
create_machine weekly    weekly /bin/sh -c 'bun run cli score && bun run cli compose'
create_machine retention daily  bun run cli retention

echo ""
echo "Done. Verify each machine picked up its command + schedule:"
echo "  fly machine list -a $APP"
echo "  fly machine status <id> -a $APP   # 'Command' field should not be empty"
