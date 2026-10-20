#!/usr/bin/env sh
set -eu

SERVICE="${POSTGRES_SERVICE:-postgres}"
DB="${POSTGRES_DB:-opspilot}"
USER="${POSTGRES_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/opspilot-$stamp.sql.gz"

docker compose exec -T "$SERVICE" \
  pg_dump -U "$USER" --clean --if-exists "$DB" | gzip > "$file"

find "$BACKUP_DIR" -name 'opspilot-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "Wrote $file"
