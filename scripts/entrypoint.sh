#!/usr/bin/env bash
# Container entrypoint.
#
# 1. If GCP_SA_KEY is set (Fly secret), write it to /tmp/sa.json and
#    point GOOGLE_APPLICATION_CREDENTIALS at it. The BigQuery SDK only
#    accepts credentials via file, not env-var JSON. Skipped when the
#    secret isn't present — non-BigQuery deploys don't need it.
# 2. Exec the command the container was invoked with (CMD by default,
#    or a scheduled machine's --command override).

set -euo pipefail

if [ -n "${GCP_SA_KEY:-}" ]; then
  umask 077
  printf '%s' "$GCP_SA_KEY" > /tmp/sa.json
  export GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json
fi

exec "$@"
