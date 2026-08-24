# SteelTrack Backend (self-host single-server)

This folder contains a FastAPI-based backend MVP for SteelTrack intended for single-server self-hosting with a centralized PostgreSQL database.

What this provides
- Authenticated REST login (/api/login) returning a JWT
- Seeded admin user (ADMIN_USER / ADMIN_PASS env vars)
- Authenticated WebSocket (/ws) that persists 'set'/'remove' messages synchronously to the DB and broadcasts to other clients
- Dockerfile + docker-compose for single-host deployment (app + Postgres)
- A simple backup script (backup_db.sh) that performs pg_dump when using Postgres

Quick start (recommended with Docker)
1. cd SteelTrack-Updated/backend
2. Edit docker-compose.yml to set strong POSTGRES_PASSWORD and change ADMIN_PASS / JWT_SECRET
3. docker compose up --build -d
4. The API will be available at http://<host>:8000

Notes for production
- Change default passwords and JWT_SECRET BEFORE exposing the server to any network.
- Use a firewall to restrict access to the host. Ideally run behind a reverse proxy (nginx) with TLS (Let's Encrypt).
- Consider mounting the ./data and pgdata volumes on reliable storage and setting up automated backups (cron running backup_db.sh or external backup solution).
- For upgrades and schema migrations, add Alembic migrations (alembic is included in requirements) and run migrations during deploy.

Next recommended steps
- Add Alembic migrations for safe schema changes and deploy migration process.
- Add Redis for pub/sub if you need multiple app instances.
- Integrate the frontend HTML to use /api/login and open the WebSocket with the JWT.
- Add monitoring & alerting, and a tested backup/restore procedure.

