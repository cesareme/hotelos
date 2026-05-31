#!/usr/bin/env bash
# PILOT-D5 · Backup automático del Postgres del piloto.
#
# - Hace pg_dump comprimido del DATABASE_URL (custom format, paralelizable)
# - Sube el dump a un bucket S3-compatible (Backblaze B2 EU recomendado, GDPR-ok)
# - Aplica rotación: 7 daily, 4 weekly, 12 monthly
# - Reporta resultado a syslog y opcionalmente a un webhook (Slack/Discord)
#
# Uso (cron):
#   0 3 * * *  /opt/hotelos/scripts/backup-postgres.sh >> /var/log/hotelos-backup.log 2>&1
#
# Variables de entorno requeridas (en /opt/hotelos/.env.backup):
#   DATABASE_URL          postgresql://user:pass@host:5432/db
#   BACKUP_S3_BUCKET      nombre del bucket
#   BACKUP_S3_REGION      ej: eu-central-003 (Backblaze) o eu-west-1 (AWS)
#   BACKUP_S3_ENDPOINT    URL del endpoint S3-compatible (ej: https://s3.eu-central-003.backblazeb2.com)
#   BACKUP_S3_ACCESS_KEY  KeyID
#   BACKUP_S3_SECRET_KEY  applicationKey
#   BACKUP_ENCRYPTION_KEY clave AES-256 para cifrar el dump antes de subir (32 bytes hex)
#   BACKUP_RETENTION_DAILY    (default 7)
#   BACKUP_RETENTION_WEEKLY   (default 4)
#   BACKUP_RETENTION_MONTHLY  (default 12)
#   BACKUP_NOTIFY_WEBHOOK     (opcional) URL Slack/Discord para reportar éxito/fallo

set -euo pipefail

# ───────────────────────────────────────────────── cargar config
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
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY no configurado (genera con openssl rand -hex 32)}"

RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${BACKUP_RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${BACKUP_RETENTION_MONTHLY:-12}"

# ───────────────────────────────────────────────── timestamps y nombres
TS="$(date -u +%Y%m%d_%H%M%S)"
DOW="$(date -u +%u)"     # 1=lunes ... 7=domingo
DOM="$(date -u +%d)"     # día del mes 01..31

# Categoría según calendario: el 1 del mes → monthly; domingo → weekly; resto → daily
if [ "$DOM" = "01" ]; then
  CATEGORY="monthly"
elif [ "$DOW" = "7" ]; then
  CATEGORY="weekly"
else
  CATEGORY="daily"
fi

DUMP_FILE="/tmp/hotelos_${CATEGORY}_${TS}.dump"
ENCRYPTED_FILE="${DUMP_FILE}.enc"
REMOTE_KEY="postgres/${CATEGORY}/hotelos_${TS}.dump.enc"

# ───────────────────────────────────────────────── herramientas
PG_DUMP="${PG_DUMP_BIN:-pg_dump}"
AWS="${AWS_BIN:-aws}"

# ───────────────────────────────────────────────── helper de notificación
notify() {
  local level="$1"  # success | failure
  local message="$2"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$level] $message"
  if [ -n "${BACKUP_NOTIFY_WEBHOOK:-}" ]; then
    local emoji=":white_check_mark:"
    [ "$level" = "failure" ] && emoji=":rotating_light:"
    curl -fsS -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"$emoji HotelOS backup [$CATEGORY]: $message\"}" \
      "$BACKUP_NOTIFY_WEBHOOK" >/dev/null || true
  fi
}

cleanup() {
  rm -f "$DUMP_FILE" "$ENCRYPTED_FILE"
}
trap cleanup EXIT

# ───────────────────────────────────────────────── 1) pg_dump
echo "[1/4] pg_dump → $DUMP_FILE"
if ! "$PG_DUMP" "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$DUMP_FILE"; then
  notify failure "pg_dump falló"
  exit 1
fi
DUMP_SIZE_BYTES=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
echo "    dump size: $DUMP_SIZE_BYTES bytes"

# ───────────────────────────────────────────────── 2) cifrar con AES-256-CBC
echo "[2/4] cifrando dump (AES-256)"
openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:$BACKUP_ENCRYPTION_KEY" \
  -in "$DUMP_FILE" -out "$ENCRYPTED_FILE"

# ───────────────────────────────────────────────── 3) subir a S3
echo "[3/4] subiendo a s3://${BACKUP_S3_BUCKET}/${REMOTE_KEY}"
AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
"$AWS" s3 cp "$ENCRYPTED_FILE" "s3://${BACKUP_S3_BUCKET}/${REMOTE_KEY}" \
  --endpoint-url "$BACKUP_S3_ENDPOINT" \
  --region "${BACKUP_S3_REGION:-eu-central-003}" \
  --no-progress

# ───────────────────────────────────────────────── 4) rotación
echo "[4/4] rotación: daily=${RETENTION_DAILY}, weekly=${RETENTION_WEEKLY}, monthly=${RETENTION_MONTHLY}"
prune_category() {
  local cat="$1"
  local keep="$2"
  # Lista todos los objetos del prefijo, ordena por fecha desc, elimina los excedentes.
  local list
  list=$(AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    "$AWS" s3 ls "s3://${BACKUP_S3_BUCKET}/postgres/${cat}/" \
    --endpoint-url "$BACKUP_S3_ENDPOINT" \
    --region "${BACKUP_S3_REGION:-eu-central-003}" \
    | awk '{print $4}' \
    | grep -E '^hotelos_.*\.dump\.enc$' \
    | sort -r)
  if [ -z "$list" ]; then return 0; fi
  local total
  total=$(echo "$list" | wc -l | tr -d ' ')
  if [ "$total" -le "$keep" ]; then
    echo "    [$cat] $total ≤ keep=$keep · nada a eliminar"
    return 0
  fi
  local to_delete
  to_delete=$(echo "$list" | tail -n +$((keep + 1)))
  echo "$to_delete" | while read -r f; do
    [ -z "$f" ] && continue
    echo "    [$cat] eliminando $f"
    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
      "$AWS" s3 rm "s3://${BACKUP_S3_BUCKET}/postgres/${cat}/${f}" \
      --endpoint-url "$BACKUP_S3_ENDPOINT" \
      --region "${BACKUP_S3_REGION:-eu-central-003}" \
      >/dev/null
  done
}
prune_category daily "$RETENTION_DAILY"
prune_category weekly "$RETENTION_WEEKLY"
prune_category monthly "$RETENTION_MONTHLY"

notify success "OK · $CATEGORY · ${DUMP_SIZE_BYTES}B → s3://${BACKUP_S3_BUCKET}/${REMOTE_KEY}"
