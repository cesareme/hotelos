#!/usr/bin/env bash
# HotelOS · zero-downtime deploy script for the Hostinger VPS.
#
# Run from /opt/hotelos as the `hotelos` user (added to the docker group):
#   bash deploy/scripts/deploy.sh
#
# What it does:
#   1. git pull the latest main
#   2. build the API + admin-web images
#   3. apply Prisma migrations against the live DB
#   4. roll the API container (zero-downtime)
#   5. roll the admin-web container (instant — it's just static files)
#   6. smoke-test /health and bail out if anything looks wrong

set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f deploy/docker-compose.production.yml --env-file deploy/.env.production"

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[[ -f deploy/.env.production ]] || fail "deploy/.env.production missing. Copy from .env.production.example first."

step "1/6 · git pull"
git fetch origin main
git reset --hard origin/main

step "2/6 · Build images (this may take a few minutes the first time)"
$COMPOSE build --pull

step "3/6 · Ensure DB + Redis are up (no-op if already running)"
$COMPOSE up -d postgres redis

step "4/6 · Apply Prisma migrations (db push, skip generate — already in image)"
# We use `prisma db push` rather than `migrate deploy` because the schema is
# the source of truth in this project (no migration history committed yet).
# When the team adopts `prisma migrate`, swap this line.
$COMPOSE run --rm api node -e "
  const { execSync } = require('child_process');
  execSync('npx prisma db push --skip-generate --schema packages/database/prisma/schema.prisma', { stdio: 'inherit' });
"

step "5/6 · Roll API + admin-web (Compose handles graceful restart)"
$COMPOSE up -d --no-deps api admin-web caddy

step "6/6 · Smoke-test /health"
sleep 8
HEALTH=$($COMPOSE exec -T api wget -qO- http://localhost:3000/health || true)
echo "Health response: $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || fail "API health check failed."

printf '\n\033[1;32m✅ Deploy complete.\033[0m\n'
echo "Tail logs with:  $COMPOSE logs -f api"
