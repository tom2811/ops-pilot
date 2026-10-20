#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <backup.sql.gz>" >&2
  exit 1
fi

SERVICE="${POSTGRES_SERVICE:-postgres}"
DB="${POSTGRES_DB:-opspilot}"
USER="${POSTGRES_USER:-postgres}"

gunzip -c "$1" | docker compose exec -T "$SERVICE" \
  psql -v ON_ERROR_STOP=1 -U "$USER" -d "$DB"

echo "Restored $1 into $DB"
