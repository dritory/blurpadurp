#!/usr/bin/env bash
# Run the full weekly pipeline: ingest → score → compose → dispatch.
#
# For local operator use (manual kick) and for host cron if you're not
# deploying on Fly Machines (the docs/deploy.md recipe splits these
# four stages into scheduled machines with their own cadences — that's
# preferred in production).
#
# Exits non-zero on the first failing stage. Compose silently succeeds
# when nothing clears the gate; dispatch silently succeeds when nothing
# is pending. Both are fine — silence is a feature.
#
# Logging: everything goes to stdout/stderr. If invoked from cron,
# redirect to a file. Example crontab entry (Sunday 16:00 UTC):
#
#   0 16 * * 0 cd /home/endre/code/blurpadurp && scripts/weekly-brief.sh >> logs/weekly.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

STAGES=("ingest" "score" "compose" "dispatch")

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

echo "[$(ts)] weekly-brief: starting"
for stage in "${STAGES[@]}"; do
  echo "[$(ts)] --- $stage ---"
  bun run cli "$stage"
done
echo "[$(ts)] weekly-brief: done"
