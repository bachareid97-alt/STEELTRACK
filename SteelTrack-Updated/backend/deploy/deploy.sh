#!/usr/bin/env bash
set -euo pipefail

# SteelTrack one-command deploy script
# Usage: curl -fsSL https://raw.githubusercontent.com/bachareid97-alt/STEELTRACK/backend-fastapi-mvp/SteelTrack-Updated/backend/deploy/deploy.sh | sudo bash

REPO_URL="https://github.com/bachareid97-alt/STEELTRACK.git"
BRANCH="backend-fastapi-mvp"
DEST_DIR="/opt/steeltrack"
BACKEND_DIR="$DEST_DIR/SteelTrack-Updated/backend"
COMPOSE_FILE="$BACKEND_DIR/docker-compose.prod.yml"
ENV_FILE="$BACKEND_DIR/.env"

echo "--- SteelTrack deploy script ---"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root via sudo. Please run: curl ... | sudo bash"
  exit 1
fi

# Install Docker if missing (Debian/Ubuntu)
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Installing Docker CE..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg lsb-release
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  echo "Docker installed."
fi

# Ensure docker can be run by current user later (we run as root now)

# Create deploy directory and clone or update
if [ -d "$DEST_DIR" ]; then
  echo "Destination $DEST_DIR exists. Updating repository..."
  cd "$DEST_DIR"
  if [ -d ".git" ]; then
    git fetch --all
    git checkout "$BRANCH" || git checkout -b "$BRANCH" "origin/$BRANCH" || git pull origin "$BRANCH" || true
    git reset --hard "origin/$BRANCH" || true
  else
    rm -rf "$DEST_DIR"/*
    git clone --branch "$BRANCH" "$REPO_URL" "$DEST_DIR"
  fi
else
  echo "Cloning repository into $DEST_DIR"
  mkdir -p "$DEST_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$DEST_DIR"
fi

if [ ! -d "$BACKEND_DIR" ]; then
  echo "Expected backend directory not found: $BACKEND_DIR"
  exit 1
fi

cd "$BACKEND_DIR"

# Generate secrets
if [ -f "$ENV_FILE" ]; then
  echo ".env already exists at $ENV_FILE — leaving it in place (edit manually if needed)."
else
  echo "Creating .env with generated secrets. You will be prompted for ADMIN_PASS."
  read -p "Admin username [admin]: " ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}
  read -s -p "Admin password (type and press enter): " ADMIN_PASS
  echo
  if [ -z "$ADMIN_PASS" ]; then
    echo "Empty admin password not allowed."; exit 1
  fi

  POSTGRES_PASSWORD=$(openssl rand -hex 16)
  JWT_SECRET=$(openssl rand -hex 32)

  cat > "$ENV_FILE" <<EOF
# Generated .env — DO NOT COMMIT
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
JWT_SECRET=$JWT_SECRET
DATABASE_URL=postgresql://postgres:$POSTGRES_PASSWORD@db:5432/steeltrack
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=steeltrack
# Optional S3/MinIO config (leave blank for local uploads/backups)
S3_ENDPOINT=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
MINIO_USE_PATH_STYLE=false
EOF
  echo ".env created at $ENV_FILE"
fi

# Make entrypoint executable
chmod +x ./entrypoint.sh || true

# Start the stack
echo "Starting Docker Compose stack (this may take a few minutes on first run)..."
/usr/local/bin/docker compose -f "$COMPOSE_FILE" up -d --build || docker compose -f "$COMPOSE_FILE" up -d --build

sleep 5

# Wait for app to become ready (simple loop checking HTTP 200)
APP_URL="http://127.0.0.1:8000/"
echo "Waiting for app to respond at $APP_URL"
for i in {1..30}; do
  if curl -fsS "$APP_URL" >/dev/null 2>&1; then
    echo "App is responding."
    break
  fi
  echo -n "."
  sleep 2
done

# Print access details
echo
echo "--- Deployment complete ---"
echo "Admin username: ${ADMIN_USER}"
echo "Admin password: (the value you entered)"
echo "App URL: http://<SERVER_IP>/  (replace <SERVER_IP> with your server's address)"

echo "To view logs:"
echo "  sudo docker compose -f $COMPOSE_FILE logs -f app"

echo "To create HTTPS certs: run certbot on the host (or request certificate and place into backend/nginx/certs) — see README for details."

echo "Backups are available via backend/backup_db.sh — customize .env for S3 if using cloud storage."

exit 0
