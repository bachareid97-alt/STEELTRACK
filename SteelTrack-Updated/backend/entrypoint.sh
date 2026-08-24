#!/usr/bin/env sh
set -e
# Entrypoint: run migrations then start uvicorn
cd /app
# Wait for DB if using Postgres
if echo "$DATABASE_URL" | grep -qE "^postgres(ql)?:\/\/"; then
  echo "Waiting for Postgres to be available..."
  # crude wait loop (docker-compose ensures db starts first but wait a little)
  until (python - <<PY
import os, sys
from sqlalchemy import create_engine
try:
    create_engine(os.environ['DATABASE_URL']).connect()
    print('db ok')
    sys.exit(0)
except Exception as e:
    print('db not ready', e)
    sys.exit(1)
PY
  ); do
    sleep 2
  done
fi

# Run alembic migrations if alembic folder exists
if [ -d "alembic" ]; then
  echo "Running alembic upgrade head"
  alembic upgrade head || true
fi

# Start the app
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
