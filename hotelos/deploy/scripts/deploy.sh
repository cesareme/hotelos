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

step "3/7 · Ensure DB + Redis are up (no-op if already running)"
$COMPOSE up -d postgres redis

step "4/7 · Schema-drift guard — block destructive changes (audit 2026-06 · #7)"
# `db push` is the schema apply (the migration history is not yet the source of
# truth). Without --accept-data-loss it aborts on destructive ops, but we add an
# EXPLICIT pre-flight: compute the DB→schema diff and BLOCK the deploy if any
# change would DROP a table/column, so prod data is never dropped silently.
# Override a reviewed, known-safe destructive change with ALLOW_DESTRUCTIVE_MIGRATION=1.
# audit 2026-06 R2 · #4: fail CLOSED. Capturamos el exit code; si `migrate diff`
# falla (prisma error, DB inalcanzable), abortamos en vez de asumir "safe" — antes
# el `|| true` desactivaba el guardian en silencio y aplicaba el db push igual.
set +e
DRIFT_SQL=$($COMPOSE run --rm -T api sh -c \
  'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel packages/database/prisma/schema.prisma --script' 2>/dev/null)
DRIFT_RC=$?
set -e
if [[ $DRIFT_RC -ne 0 ]]; then
    fail "Schema-drift check no pudo ejecutarse (prisma migrate diff salió $DRIFT_RC). Abortado por seguridad: revisa la conexión a la BD / el esquema y reintenta."
fi
if printf '%s' "$DRIFT_SQL" | grep -qiE 'DROP[[:space:]]+(TABLE|COLUMN)'; then
    echo "Destructive schema changes detected:"
    printf '%s\n' "$DRIFT_SQL" | grep -iE 'DROP[[:space:]]+(TABLE|COLUMN)' || true
    if [[ "${ALLOW_DESTRUCTIVE_MIGRATION:-}" == "1" ]]; then
        echo "ALLOW_DESTRUCTIVE_MIGRATION=1 — proceeding despite destructive changes."
    else
        fail "Deploy blocked: back up the DB and review the drops, then re-run with ALLOW_DESTRUCTIVE_MIGRATION=1."
    fi
else
    echo "Schema changes are additive or none — safe to apply."
fi

step "5/7 · Apply Prisma schema (db push, skip generate — already in image)"
$COMPOSE run --rm api node -e "
  const { execSync } = require('child_process');
  execSync('npx prisma db push --skip-generate --schema packages/database/prisma/schema.prisma', { stdio: 'inherit' });
"

step "6/7 · Roll API + admin-web (Compose handles graceful restart)"
$COMPOSE up -d --no-deps api admin-web caddy

step "7/7 · Smoke-test /health"
sleep 8
HEALTH=$($COMPOSE exec -T api wget -qO- http://localhost:3000/health || true)
echo "Health response: $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || fail "API health check failed."

printf '\n\033[1;32m✅ Deploy complete.\033[0m\n'
echo "Tail logs with:  $COMPOSE logs -f api"
