#!/usr/bin/env bash
# Fresh-install check (Tanda 4 · DATA-01): proves that the versioned migration
# chain installs a WORKING Anfitorio schema on an empty PostgreSQL database.
#
# It only ever touches a TEMPORARY database (default: hotelos_install_test) that
# it creates on the same server as DATABASE_URL and drops on exit; the source
# database named in DATABASE_URL is never written to.
#
# Steps: dropdb/createdb → prisma migrate deploy → drift check (migrations ==
# schema.prisma, exit 0) → base seed (prisma/seed.ts) → rbac:sync --dry-run →
# no functions/triggers/views in public beyond the ones the migration chain
# itself declares (CREATE FUNCTION / CREATE TRIGGER statements; Tanda 6b added
# the immutability triggers of invoices and verifactu_installations) → sanity
# counts → adopt-baseline dry-run reports "adopted".
#
# Usage (from the monorepo root; DATABASE_URL in the environment or .env):
#   pnpm db:install:check              # or: bash scripts/check-fresh-install.sh
#   bash scripts/check-fresh-install.sh --keep   # leave the test DB for inspection
#   bash scripts/check-fresh-install.sh --json   # machine-readable summary line
#   INSTALL_TEST_DB=other_name bash scripts/check-fresh-install.sh
#
# Exit codes: 0 ok · 1 a step failed · 2 unknown flag / missing prerequisite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PKG="$ROOT/packages/database"
API_PKG="$ROOT/apps/api"
TEST_DB="${INSTALL_TEST_DB:-hotelos_install_test}"
PNPM="corepack pnpm"
KEEP=0
JSON=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --json) JSON=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Flag desconocido: $arg (conocidos: --keep, --json, --help)" >&2; exit 2 ;;
  esac
done

log() { echo "[fresh-install] $*"; }
fail() { echo "[fresh-install] ERROR: $*" >&2; exit 1; }

for tool in node corepack psql createdb dropdb; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[fresh-install] falta la herramienta '$tool' en PATH" >&2; exit 2; }
done

if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
: "${DATABASE_URL:?DATABASE_URL no configurado (exporta la variable o crea .env en la raíz del monorepo)}"

# Same server/credentials as DATABASE_URL, different database name.
TEST_URL="$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; process.stdout.write(u.toString());' "$DATABASE_URL" "$TEST_DB")"
SOURCE_DB="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname.slice(1));' "$DATABASE_URL")"
[ "$SOURCE_DB" != "$TEST_DB" ] || fail "DATABASE_URL apunta a '$TEST_DB': la BD de prueba no puede ser la BD origen."

# Seeds and rbac-sync read these; harmless placeholders when the host has no .env (CI).
export JWT_SECRET="${JWT_SECRET:-fresh-install-check-jwt-secret-32-chars-min}"
export NODE_ENV="${NODE_ENV:-development}"

cleanup() {
  local code=$?
  if [ "$KEEP" = "1" ]; then
    log "--keep: conservo la BD $TEST_DB ($TEST_URL)"
  else
    dropdb --if-exists --maintenance-db="$DATABASE_URL" "$TEST_DB" >/dev/null 2>&1 || log "aviso: no pude borrar $TEST_DB (bórrala a mano: dropdb $TEST_DB)"
  fi
  exit "$code"
}
trap cleanup EXIT

started=$(date +%s)
LOCAL_MIGRATIONS=$(find "$DB_PKG/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*_*' | wc -l | tr -d ' ')
EXPECTED_TABLES=$(cat "$DB_PKG"/prisma/migrations/*/migration.sql | grep -c '^CREATE TABLE ' || true)
[ "$LOCAL_MIGRATIONS" -ge 1 ] || fail "no hay carpetas de migración en packages/database/prisma/migrations"

log "1/8 recreo la BD temporal $TEST_DB en el servidor de DATABASE_URL"
dropdb --if-exists --maintenance-db="$DATABASE_URL" "$TEST_DB"
createdb --maintenance-db="$DATABASE_URL" "$TEST_DB"

log "2/8 prisma migrate deploy ($LOCAL_MIGRATIONS migración/es local/es)"
(cd "$DB_PKG" && DATABASE_URL="$TEST_URL" $PNPM db:migrate:deploy) || fail "migrate deploy falló"

log "3/8 drift check: migraciones aplicadas == schema.prisma"
(cd "$DB_PKG" && DATABASE_URL="$TEST_URL" $PNPM db:drift:check) || fail "la BD migrada no coincide con schema.prisma (hay drift: falta una migración)"

log "4/8 seed base (prisma/seed.ts)"
(cd "$DB_PKG" && DATABASE_URL="$TEST_URL" node --env-file-if-exists=../../.env --import tsx prisma/seed.ts >/dev/null) || fail "el seed base falló sobre la BD limpia"

log "5/8 rbac:sync --dry-run"
(cd "$API_PKG" && DATABASE_URL="$TEST_URL" $PNPM rbac:sync -- --dry-run >/dev/null) || fail "rbac:sync --dry-run falló"

log "6/8 sin funciones, triggers ni vistas en public salvo las que declaran las migraciones"
# Functions and triggers are allowed ONLY when a migration creates them (Prisma
# cannot declare them; Tanda 6b ships two immutability triggers). Views never.
EXPECTED_FUNCTIONS=$(cat "$DB_PKG"/prisma/migrations/*/migration.sql | grep -c -E '^CREATE (OR REPLACE )?FUNCTION ' || true)
EXPECTED_TRIGGERS=$(cat "$DB_PKG"/prisma/migrations/*/migration.sql | grep -c -E '^CREATE TRIGGER ' || true)
DB_FUNCTIONS=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'")
DB_TRIGGERS=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal")
DB_VIEWS=$(psql "$TEST_URL" -Atc "SELECT (SELECT count(*) FROM pg_views WHERE schemaname = 'public') + (SELECT count(*) FROM pg_matviews WHERE schemaname = 'public')")
[ "$DB_FUNCTIONS" = "$EXPECTED_FUNCTIONS" ] || fail "hay $DB_FUNCTIONS función/es en public y las migraciones declaran $EXPECTED_FUNCTIONS"
[ "$DB_TRIGGERS" = "$EXPECTED_TRIGGERS" ] || fail "hay $DB_TRIGGERS trigger/s en public y las migraciones declaran $EXPECTED_TRIGGERS"
[ "$DB_VIEWS" = "0" ] || fail "hay $DB_VIEWS vista/s en public que ninguna migración crea"

log "7/8 recuentos de sanidad"
TABLES=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'")
HISTORY_ROWS=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
ORGS=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM organizations")
PERMISSIONS=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM permissions")
[ "$TABLES" = "$EXPECTED_TABLES" ] || fail "tablas en BD ($TABLES) != CREATE TABLE en migraciones ($EXPECTED_TABLES)"
[ "$HISTORY_ROWS" = "$LOCAL_MIGRATIONS" ] || fail "_prisma_migrations tiene $HISTORY_ROWS filas aplicadas, esperaba $LOCAL_MIGRATIONS"
[ "$ORGS" -ge 1 ] || fail "el seed base no creó ninguna organización"
[ "$PERMISSIONS" -ge 1 ] || fail "el seed base no creó permisos"

log "8/8 adopt-baseline en dry-run debe informar 'adopted'"
ADOPT_STATE=$(cd "$DB_PKG" && DATABASE_URL="$TEST_URL" node scripts/adopt-baseline.mjs --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).state ?? "?"))')
[ "$ADOPT_STATE" = "adopted" ] || fail "adopt-baseline informa estado '$ADOPT_STATE' sobre una BD recién migrada (esperaba 'adopted')"

elapsed=$(( $(date +%s) - started ))
log "OK: $LOCAL_MIGRATIONS migración/es → $TABLES tablas, $ORGS organización/es, $PERMISSIONS permisos, sin drift, sin objetos fuera de las migraciones ($DB_FUNCTIONS funciones, $DB_TRIGGERS triggers declarados) (${elapsed}s)"
if [ "$JSON" = "1" ]; then
  printf '{"ok":true,"testDb":"%s","migrations":%s,"tables":%s,"organizations":%s,"permissions":%s,"foreignObjects":%s,"durationSeconds":%s}\n' \
    "$TEST_DB" "$LOCAL_MIGRATIONS" "$TABLES" "$ORGS" "$PERMISSIONS" "$FOREIGN_OBJECTS" "$elapsed"
fi
