#!/bin/sh
set -e
OUT_DIR="./data/backups"
mkdir -p "$OUT_DIR"
TIMESTAMP=$(date +%Y%m%d%H%M%S)

# Detect Postgres URL (postgres:// or postgresql://)
if echo "$DATABASE_URL" | grep -qE "^postgres(ql)?:\/\/"; then
  : "Dumping Postgres database using pg_dump"
  DB_HOST=$(echo "$DATABASE_URL" | sed -E 's#.*@([^:/]+).*#\1#')
  DB_NAME=$(echo "$DATABASE_URL" | sed -E 's#.*\/([^/?]+).*#\1#')
  DB_USER=$(echo "$DATABASE_URL" | sed -E 's#.*//([^:]+):.*#\1#')
  DB_PASS=${POSTGRES_PASSWORD:-postgres}
  export PGPASSWORD="$DB_PASS"
  pg_dump -h "$DB_HOST" -U "$DB_USER" -F c -b -v -f "$OUT_DIR/steeltrack_$TIMESTAMP.dump" "$DB_NAME"
else
  cp ./data/steeltrack.db "$OUT_DIR/steeltrack_$TIMESTAMP.db"
fi

echo "Backup saved to $OUT_DIR"
