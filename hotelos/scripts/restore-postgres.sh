#!/usr/bin/env bash
# PILOT-D5 · Restore desde S3 de un backup hecho por backup-postgres.sh.
#
# Por defecto restaura a una base de datos NUEVA llamada hotelos_restore_test
# (no toca la base de producción). Esto permite tests de restore sin riesgo.
# Para promocionar el restore a producción usa --target=DATABASE_URL_DEST
# (PELIGROSO: requiere confirmación interactiva).
#
# Uso:
#   ./restore-postgres.sh --list                        # listar backups en S3
#   ./restore-postgres.sh --latest                       # restaurar el más reciente a hotelos_restore_test
#   ./restore-postgres.sh --key=postgres/daily/hotelos_20260528_030000.dump.enc
#   ./restore-postgres.sh --latest --target="$DATABASE_URL_PRODUCCION"  # RIESGO
#
# Variables de entorno (mismo .env.backup que el script de backup):
#   DATABASE_URL          (URL del Postgres del piloto · sirve para deducir host/user/pass)
#   BACKUP_S3_*           (mismo set que en backup)
#   BACKUP_ENCRYPTION_KEY (la misma clave AES-256 usada al cifrar)
#   RESTORE_TARGET_DB     (default: hotelos_restore_test)

set -euo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/opt/hotelos/.env.backup}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

: "${DATABASE_URL:?DATABASE_URL no configurado}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET no configurado}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT no configurado}"
: "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY no configurado}"
: "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY no configurado}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY no configurado}"

AWS="${AWS_BIN:-aws}"
PG_RESTORE="${PG_RESTORE_BIN:-pg_restore}"
PSQL="${PSQL_BIN:-psql}"

MODE="usage"
KEY=""
TARGET_URL=""

# ───────────────────────────────────────────────── parse args
for arg in "$@"; do
  case "$arg" in
    --list) MODE="list" ;;
    --latest) MODE="restore"; KEY="latest" ;;
    --key=*) MODE="restore"; KEY="${arg#--key=}" ;;
    --target=*) TARGET_URL="${arg#--target=}" ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

s3_ls() {
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    "$AWS" s3 ls "s3://${BACKUP_S3_BUCKET}/$1" \
      --endpoint-url "$BACKUP_S3_ENDPOINT" \
      --region "${BACKUP_S3_REGION:-eu-central-003}"
}

s3_cp() {
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    "$AWS" s3 cp "s3://${BACKUP_S3_BUCKET}/$1" "$2" \
      --endpoint-url "$BACKUP_S3_ENDPOINT" \
      --region "${BACKUP_S3_REGION:-eu-central-003}" \
      --no-progress
}

if [ "$MODE" = "usage" ]; then
  sed -n '2,16p' "$0" | sed 's/^# //; s/^#//'
  exit 0
fi

if [ "$MODE" = "list" ]; then
  echo "── Daily ──"
  s3_ls "postgres/daily/" || true
  echo
  echo "── Weekly ──"
  s3_ls "postgres/weekly/" || true
  echo
  echo "── Monthly ──"
  s3_ls "postgres/monthly/" || true
  exit 0
fi

# ───────────────────────────────────────────────── resolver KEY=latest
if [ "$KEY" = "latest" ]; then
  echo "Buscando backup más reciente entre daily/weekly/monthly..."
  for cat in daily weekly monthly; do
    LATEST=$(s3_ls "postgres/${cat}/" 2>/dev/null | awk '{print $4}' | grep -E '^hotelos_.*\.dump\.enc$' | sort -r | head -1 || true)
    if [ -n "$LATEST" ]; then
      KEY="postgres/${cat}/${LATEST}"
      break
    fi
  done
  if [ "$KEY" = "latest" ]; then
    echo "ERROR: no se encontraron backups." >&2
    exit 1
  fi
fi
echo "Restore desde: $KEY"

# ───────────────────────────────────────────────── descarga + descifrar
TMP_ENC="/tmp/restore_$(date -u +%s).dump.enc"
TMP_DUMP="${TMP_ENC%.enc}"
cleanup() { rm -f "$TMP_ENC" "$TMP_DUMP"; }
trap cleanup EXIT

echo "[1/4] descargando desde S3..."
s3_cp "$KEY" "$TMP_ENC"

echo "[2/4] descifrando..."
openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$BACKUP_ENCRYPTION_KEY" \
  -in "$TMP_ENC" -out "$TMP_DUMP"

# ───────────────────────────────────────────────── target DB
if [ -z "$TARGET_URL" ]; then
  RESTORE_DB="${RESTORE_TARGET_DB:-hotelos_restore_test}"
  # Reusa host/user/pass del DATABASE_URL pero cambia el nombre de la base.
  TARGET_URL="$(echo "$DATABASE_URL" | sed -E "s|(.*://[^/]+/)[^?]+|\1${RESTORE_DB}|")"
  echo "[3/4] target: $TARGET_URL (base de prueba)"

  # Conexión a postgres para crear la BD si no existe
  ADMIN_URL="$(echo "$DATABASE_URL" | sed -E "s|(.*://[^/]+/)[^?]+|\1postgres|")"
  echo "    asegurando que ${RESTORE_DB} existe (drop + create)"
  "$PSQL" "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"${RESTORE_DB}\";" >/dev/null
  "$PSQL" "$ADMIN_URL" -c "CREATE DATABASE \"${RESTORE_DB}\";" >/dev/null
else
  echo
  echo "⚠️  ⚠️  ⚠️  ATENCIÓN: se va a restaurar SOBRE EL TARGET:"
  echo "        $TARGET_URL"
  echo "⚠️  Esto SOBRESCRIBE la base. Si es producción, vas a perder datos."
  echo
  read -r -p "Escribe exactamente 'CONFIRMO RESTAURAR' para continuar: " CONFIRM
  if [ "$CONFIRM" != "CONFIRMO RESTAURAR" ]; then
    echo "Cancelado."
    exit 1
  fi
fi

# ───────────────────────────────────────────────── pg_restore
echo "[4/4] pg_restore..."
"$PG_RESTORE" --no-owner --no-acl --clean --if-exists --dbname="$TARGET_URL" "$TMP_DUMP"

# ───────────────────────────────────────────────── verificaciones post-restore
echo
echo "── Verificaciones ──"
echo "Tablas críticas (filas):"
for T in users organizations properties reservations invoices guest_register_records audit_events; do
  CNT=$("$PSQL" "$TARGET_URL" -tAc "SELECT COUNT(*) FROM \"$T\"" 2>/dev/null || echo "ERR")
  printf "  %-30s %s\n" "$T" "$CNT"
done

echo
echo "✅ Restore completado en $TARGET_URL"
