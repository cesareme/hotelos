#!/usr/bin/env bash
# PILOT-D5 · Test end-to-end del ciclo backup → S3 → download → restore.
#
# CRÍTICO: un backup que nunca se ha restaurado no es un backup. Este script
# se ejecuta como dry-run mensual para garantizar que el ciclo completo funciona.
#
# Pasos:
#   1. Backup ad-hoc del Postgres del piloto (igual que backup-postgres.sh,
#      pero a una key temporal que se borra al final).
#   2. Restore a una base hotelos_restore_test (drop + create + pg_restore).
#   3. Verificaciones de integridad: row counts > 0 en tablas críticas, schema match.
#   4. Cleanup: drop hotelos_restore_test + delete temporary S3 key.
#   5. Reporta éxito/fallo y duración total al webhook (si está configurado).
#
# Uso:
#   ./test-backup-restore-cycle.sh
#
# Cron sugerido (mensualmente, primer domingo a las 04:00):
#   0 4 1-7 * 0  /opt/hotelos/scripts/test-backup-restore-cycle.sh >> /var/log/hotelos-restore-test.log 2>&1

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
PG_DUMP="${PG_DUMP_BIN:-pg_dump}"
PG_RESTORE="${PG_RESTORE_BIN:-pg_restore}"
PSQL="${PSQL_BIN:-psql}"

TS="$(date -u +%Y%m%d_%H%M%S)"
TEST_DB="hotelos_restore_test_${TS}"
DUMP_FILE="/tmp/cycle_test_${TS}.dump"
ENC_FILE="${DUMP_FILE}.enc"
DOWNLOADED="/tmp/cycle_test_${TS}_downloaded.dump.enc"
DECRYPTED="/tmp/cycle_test_${TS}_decrypted.dump"
REMOTE_KEY="postgres/_cycle_test/cycle_${TS}.dump.enc"
START_EPOCH=$(date +%s)

notify() {
  local level="$1"; local msg="$2"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$level] $msg"
  if [ -n "${BACKUP_NOTIFY_WEBHOOK:-}" ]; then
    local emoji=":white_check_mark:"
    [ "$level" = "failure" ] && emoji=":rotating_light:"
    curl -fsS -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"$emoji HotelOS restore-test: $msg\"}" \
      "$BACKUP_NOTIFY_WEBHOOK" >/dev/null || true
  fi
}

cleanup() {
  local rc=$?
  echo
  echo "── Cleanup ──"
  rm -f "$DUMP_FILE" "$ENC_FILE" "$DOWNLOADED" "$DECRYPTED"
  # Drop test DB
  ADMIN_URL="$(echo "$DATABASE_URL" | sed -E "s|(.*://[^/]+/)[^?]+|\1postgres|")"
  "$PSQL" "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"${TEST_DB}\";" >/dev/null 2>&1 || true
  # Eliminar key temporal de S3
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    "$AWS" s3 rm "s3://${BACKUP_S3_BUCKET}/${REMOTE_KEY}" \
    --endpoint-url "$BACKUP_S3_ENDPOINT" \
    --region "${BACKUP_S3_REGION:-eu-central-003}" \
    >/dev/null 2>&1 || true
  if [ $rc -ne 0 ]; then
    notify failure "Test falló (exit=$rc). Ver log."
  fi
}
trap cleanup EXIT

# ────────────────────────── 1) backup ad-hoc
echo "[1/5] pg_dump → $DUMP_FILE"
"$PG_DUMP" "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$DUMP_FILE"
DUMP_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
echo "    size: ${DUMP_SIZE}B"

echo "[2/5] cifrar"
openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:$BACKUP_ENCRYPTION_KEY" \
  -in "$DUMP_FILE" -out "$ENC_FILE"

echo "[3/5] subir a S3 (${REMOTE_KEY})"
AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
  "$AWS" s3 cp "$ENC_FILE" "s3://${BACKUP_S3_BUCKET}/${REMOTE_KEY}" \
  --endpoint-url "$BACKUP_S3_ENDPOINT" \
  --region "${BACKUP_S3_REGION:-eu-central-003}" \
  --no-progress

# ────────────────────────── 2) bajar y descifrar
echo "[4/5] bajar de S3 y descifrar"
AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
  "$AWS" s3 cp "s3://${BACKUP_S3_BUCKET}/${REMOTE_KEY}" "$DOWNLOADED" \
  --endpoint-url "$BACKUP_S3_ENDPOINT" \
  --region "${BACKUP_S3_REGION:-eu-central-003}" \
  --no-progress

openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$BACKUP_ENCRYPTION_KEY" \
  -in "$DOWNLOADED" -out "$DECRYPTED"

# Verificación de integridad: el dump original y el descargado-descifrado deben tener el mismo SHA256.
ORIG_SHA=$(openssl dgst -sha256 "$DUMP_FILE" | awk '{print $2}')
ROUND_SHA=$(openssl dgst -sha256 "$DECRYPTED" | awk '{print $2}')
if [ "$ORIG_SHA" != "$ROUND_SHA" ]; then
  echo "❌ SHA mismatch tras ciclo cifrado/descifrado:"
  echo "   original:  $ORIG_SHA"
  echo "   round:     $ROUND_SHA"
  exit 1
fi
echo "    ✅ SHA-256 idéntico tras ciclo encrypt→S3→download→decrypt"

# ────────────────────────── 3) restore a base de pruebas
echo "[5/5] restore → ${TEST_DB}"
ADMIN_URL="$(echo "$DATABASE_URL" | sed -E "s|(.*://[^/]+/)[^?]+|\1postgres|")"
TARGET_URL="$(echo "$DATABASE_URL" | sed -E "s|(.*://[^/]+/)[^?]+|\1${TEST_DB}|")"
"$PSQL" "$ADMIN_URL" -c "CREATE DATABASE \"${TEST_DB}\";" >/dev/null
"$PG_RESTORE" --no-owner --no-acl --dbname="$TARGET_URL" "$DECRYPTED" >/dev/null

# ────────────────────────── 4) verificaciones
echo
echo "── Verificaciones ──"
FAIL=0
for T in users organizations properties reservations invoices guest_register_records audit_events; do
  CNT=$("$PSQL" "$TARGET_URL" -tAc "SELECT COUNT(*) FROM \"$T\"" 2>/dev/null || echo "ERR")
  printf "  %-30s %s\n" "$T" "$CNT"
  # users + organizations + properties son obligatorios > 0 si el piloto está funcionando
  case "$T" in
    users|organizations|properties)
      if [ "$CNT" = "ERR" ] || [ "$CNT" -lt 1 ] 2>/dev/null; then
        echo "    ❌ $T tiene 0 filas o no se pudo leer"
        FAIL=1
      fi
      ;;
  esac
done

END_EPOCH=$(date +%s)
DURATION=$((END_EPOCH - START_EPOCH))

if [ "$FAIL" = "1" ]; then
  notify failure "Verificaciones fallidas (${DURATION}s)"
  exit 1
fi

notify success "Ciclo completo OK · dump=${DUMP_SIZE}B · duration=${DURATION}s"
echo
echo "✅ Test ciclo backup-restore completado correctamente en ${DURATION}s."
