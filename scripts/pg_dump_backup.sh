#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${PG_CONTAINER:-blurpadurp-postgres-1}"
DB="${PG_DB:-blurpadurp}"
USER_NAME="${PG_USER:-blurpadurp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/../backups}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/blurpadurp-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

docker exec "$CONTAINER" pg_dump -U "$USER_NAME" -d "$DB" --clean --if-exists \
  | gzip > "$FILE"

find "$BACKUP_DIR" -maxdepth 1 -name 'blurpadurp-*.sql.gz' -type f -mtime +"$RETAIN_DAYS" -delete

echo "backup: $FILE"
