#!/usr/bin/env bash
# ehotelOS · orquestador de despliegue idempotente (Tanda 4 · instalabilidad).
#
# Ejecuta, en orden, los pasos que actualizan una instalación existente sin
# perder datos. Cada paso es re-ejecutable; un fallo aborta el resto.
#
#   pull       git fetch + reset a origin/<rama> (solo con --pull)
#   env        validate-env del fichero de entorno y carga en el proceso
#   install    corepack pnpm install --frozen-lockfile --prod=false (tsx y prisma son
#              devDependencies pero el runtime oficial es `node --import tsx`; el
#              --prod=false es obligatorio porque el paso env exporta NODE_ENV=production
#              y pnpm 9 omitiría/borraría las devDependencies sin él)
#   generate   pnpm --filter @hotelos/database db:generate
#   backup     pg_dump custom-format en BACKUP_DIR (antes de tocar el esquema)
#   adopt      pnpm --filter @hotelos/database db:adopt-baseline -- --apply (idempotente; BD con db push)
#   migrate    pnpm --filter @hotelos/database db:migrate:deploy + db:drift:check (exit 0 obligatorio)
#   rbac       pnpm --filter @hotelos/api rbac:sync -- --dry-run (informe; el boot sincroniza)
#   backfills  solo con --with-backfills: payment-hash, taxes, guest-register --apply
#              (+ snapshots si BACKFILL_FROM/BACKFILL_TO están definidos)
#   web        build de admin-web con VITE_API_URL=${APP_BASE_URL}/api → WEB_ROOT
#   restart    systemctl restart anfitorio-api [anfitorio-worker] | compose up -d
#   smoke      deploy/scripts/smoke.sh contra APP_BASE_URL
#
# Uso (desde cualquier directorio; el script localiza la raíz pnpm hotelos/):
#   bash deploy/scripts/deploy.sh [--role production-native|compose] [--env-file RUTA]
#        [--pull] [--branch main] [--with-backfills] [--skip-PASO ...] [--only-PASO ...]
#        [--web-root DIR] [--backup-dir DIR] [--dry-run] [--yes]
#
#   --role production-native  (por defecto) API/worker bajo systemd, Caddy nativo,
#                             entorno en /etc/anfitorio/api.env
#   --role compose            deploy/docker-compose.production.yml; los pasos de BD
#                             corren dentro del contenedor api; entorno en
#                             deploy/.env.production
#   --env-file RUTA           fichero de entorno (defaults: /etc/anfitorio/api.env ·
#                             deploy/.env.production)
#   --skip-PASO / --only-PASO p. ej. --skip-backup, --only-web --only-restart
#   --dry-run                 imprime los comandos sin ejecutarlos (si APP_BASE_URL no
#                             está definida usa el marcador <APP_BASE_URL> para mostrar
#                             el plan completo; fuera de --dry-run es un error fatal;
#                             sin fichero de entorno añade --skip-backup: el paso backup
#                             exige DATABASE_URL incluso en --dry-run)
#   --yes                     no pedir confirmación antes de tocar la BD
#
# Variables opcionales: WEB_ROOT (/srv/anfitorio/admin-web), BACKUP_DIR
# (/var/backups/anfitorio), BACKUP_KEEP_DAYS (14), SMOKE_EMAIL/SMOKE_PASSWORD
# (si faltan, el smoke se limita a health + 401), SMOKE_PROPERTY_ID (prop_123),
# BACKFILL_FROM/BACKFILL_TO (YYYY-MM-DD, activan backfill:snapshots).
#
# Salida: 0 OK · 1 un paso falló · 2 argumentos/entorno inválidos.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

PNPM="corepack pnpm"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

ROLE="production-native"
ENV_FILE=""
PULL=0
BRANCH="${DEPLOY_BRANCH:-main}"
WITH_BACKFILLS=0
DRY_RUN=0
ASSUME_YES=0
WEB_ROOT="${WEB_ROOT:-/srv/anfitorio/admin-web}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/anfitorio}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
ALL_STEPS=(pull env install generate backup adopt migrate rbac backfills web restart smoke)
SKIP_LIST=" "   # space-separated step names (bash 3.2 compatible: no associative arrays)
ONLY_LIST=" "

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
step()    { printf '\n'; c_blue "▶ $*"; }
ok()      { c_green "  ✓ $*"; }
# Step results: a ✓ must only ever mean "this happened". Under --dry-run the
# run/run_sh helpers return 0 without executing, so every step result goes
# through ok_or_plan, which prints the plan line instead of a fake success.
ok_or_plan() { if [[ $DRY_RUN -eq 1 ]]; then printf '  · plan: %s\n' "$*"; else ok "$*"; fi; }
warn()    { c_yellow "  ⚠ $*"; }
die()     { c_red "  ✗ $1"; exit "${2:-1}"; }
# Help = the comment header above, up to its last line (never the `set` line).
usage()   { sed -n '2,49p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

is_step() { local s; for s in "${ALL_STEPS[@]}"; do [[ "$s" == "$1" ]] && return 0; done; return 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --role) ROLE="$2"; shift 2 ;;
        --env-file) ENV_FILE="$2"; shift 2 ;;
        --pull) PULL=1; shift ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --with-backfills) WITH_BACKFILLS=1; shift ;;
        --web-root) WEB_ROOT="$2"; shift 2 ;;
        --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --skip-*) s="${1#--skip-}"; is_step "$s" || die "Paso desconocido en $1 (pasos: ${ALL_STEPS[*]})" 2; SKIP_LIST="$SKIP_LIST$s "; shift ;;
        --only-*) s="${1#--only-}"; is_step "$s" || die "Paso desconocido en $1 (pasos: ${ALL_STEPS[*]})" 2; ONLY_LIST="$ONLY_LIST$s "; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "Opción desconocida: $1" 2 ;;
    esac
done

case "$ROLE" in
    production-native|compose) ;;
    *) die "--role debe ser production-native o compose (recibido: $ROLE)" 2 ;;
esac
if [[ -z "$ENV_FILE" ]]; then
    [[ "$ROLE" == "compose" ]] && ENV_FILE="$ROOT/deploy/.env.production" || ENV_FILE="/etc/anfitorio/api.env"
fi
[[ "$ONLY_LIST" == *" pull "* ]] && PULL=1   # --only-pull implica --pull
[[ $PULL -eq 1 ]] || SKIP_LIST="${SKIP_LIST}pull "
[[ $WITH_BACKFILLS -eq 1 ]] || SKIP_LIST="${SKIP_LIST}backfills "

COMPOSE="docker compose -f $ROOT/deploy/docker-compose.production.yml --env-file $ENV_FILE"

# ---------- helpers ----------
run() {
    # Print then execute (or only print in --dry-run).
    printf '  $ %s\n' "$*"
    [[ $DRY_RUN -eq 1 ]] && return 0
    "$@"
}
run_sh() {
    printf '  $ %s\n' "$1"
    [[ $DRY_RUN -eq 1 ]] && return 0
    bash -c "$1"
}
# mask_url URL — hides the password of a postgresql://user:pass@host/db URL when printing.
mask_url() { printf '%s' "$1" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'; }
# in_app CMD… — run a pnpm/node command in the workspace: locally (native) or
# inside a throw-away api container (compose), whose image carries the whole
# repo, pnpm and the Prisma CLI.
in_app() {
    if [[ "$ROLE" == "compose" ]]; then
        run $COMPOSE run --rm -T --no-deps --entrypoint "" api sh -lc "cd /app && $*"
    else
        run_sh "$*"
    fi
}
as_root() {
    if [[ $EUID -eq 0 ]]; then run "$@"
    elif command -v sudo >/dev/null 2>&1; then run sudo -n "$@"
    else die "Se necesita root o sudo sin contraseña para: $*"
    fi
}
should_run() {
    local s="$1"
    if [[ "$ONLY_LIST" != " " ]]; then [[ "$ONLY_LIST" == *" $s "* ]] || return 1; fi
    [[ "$SKIP_LIST" != *" $s "* ]]
}
skipped() { printf '\n'; c_yellow "▷ $1 · omitido"; }
confirm() {
    [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]] && return 0
    local answer
    read -r -p "  ¿Continuar? [s/N] " answer
    [[ "$answer" == "s" || "$answer" == "S" || "$answer" == "y" || "$answer" == "Y" ]] || die "Cancelado por el operador."
}
load_env_file() {
    # Export KEY=VALUE lines (quotes stripped) without evaluating the file.
    local file="$1" line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"
        [[ -z "$line" || "$line" == \#* ]] && continue
        [[ "$line" == *=* ]] || continue
        key="${line%%=*}"; value="${line#*=}"
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
        if [[ ( "$value" == \"*\" && "$value" == *\" ) || ( "$value" == \'*\' && "$value" == *\' ) ]]; then
            value="${value:1:${#value}-2}"
        fi
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        export "$key=$value"
    done <"$file"
}

# Concurrency guard: two deploys at once would race on the schema and the dist.
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/anfitorio-deploy.lock}"
if command -v flock >/dev/null 2>&1 && [[ $DRY_RUN -eq 0 ]]; then
    exec 9>"$LOCK_FILE"
    flock -n 9 || die "Otro deploy está en curso (lock $LOCK_FILE)." 2
fi

c_blue "═══════════════════════════════════════════════════════════"
c_blue " ehotelOS · deploy · rol $ROLE · $(date -u +%Y-%m-%dT%H:%M:%SZ)"
c_blue " raíz $ROOT · env $ENV_FILE$([[ $DRY_RUN -eq 1 ]] && echo ' · DRY-RUN')"
c_blue "═══════════════════════════════════════════════════════════"

# ---------- pull ----------
if should_run pull; then
    step "pull · git fetch + reset --hard origin/$BRANCH"
    if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]]; then
        die "Hay cambios locales sin commit en $ROOT; el reset los destruiría. Revisa 'git status' o ejecuta sin --pull."
    fi
    run git -C "$ROOT" fetch origin "$BRANCH"
    run git -C "$ROOT" checkout -q "$BRANCH"
    run git -C "$ROOT" reset --hard "origin/$BRANCH"
    ok_or_plan "HEAD $(git -C "$ROOT" log -1 --oneline)$([[ $DRY_RUN -eq 1 ]] && echo ' (actual; el reset no se ha ejecutado)')"
else skipped pull; fi

# ---------- env ----------
if should_run env; then
    step "env · validar y cargar $ENV_FILE"
    [[ -f "$ENV_FILE" ]] || die "No existe $ENV_FILE. Créalo desde .env.example (nativo) o deploy/.env.production.example (compose)." 2
    # validate-env roles (scripts/validate-env.mjs, Tanda 4): app | production-compose | production-native.
    validate_role="production-native"
    [[ "$ROLE" == "compose" ]] && validate_role="production-compose"
    if grep -q -- '--role' scripts/validate-env.mjs; then
        run node scripts/validate-env.mjs "$ENV_FILE" --role "$validate_role"
    else
        # Older validate-env without --role: production policy by flag.
        run node scripts/validate-env.mjs "$ENV_FILE" --production
    fi
    load_env_file "$ENV_FILE"
    if [[ "$ROLE" == "compose" ]]; then
        : "${DOMAIN:?DOMAIN no definido en $ENV_FILE}"
        APP_BASE_URL="${APP_BASE_URL:-https://$DOMAIN}"
        DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER:-hotelos}:${POSTGRES_PASSWORD:-}@localhost:5432/${POSTGRES_DB:-hotelos}}"
    fi
    : "${APP_BASE_URL:?APP_BASE_URL no definido en $ENV_FILE (origen público, p. ej. https://demo.ehotelos.com)}"
    : "${DATABASE_URL:?DATABASE_URL no definido en $ENV_FILE}"
    APP_BASE_URL="${APP_BASE_URL%/}"
    export APP_BASE_URL DATABASE_URL
    export VITE_API_URL="$APP_BASE_URL/api"
    [[ "$APP_BASE_URL" == https://* ]] || warn "APP_BASE_URL no es https ($APP_BASE_URL): válido solo para pruebas."
    ok "APP_BASE_URL=$APP_BASE_URL · VITE_API_URL=$VITE_API_URL"
else
    skipped env
    # Later steps still need the variables even when validation is skipped.
    [[ -f "$ENV_FILE" ]] && load_env_file "$ENV_FILE"
    if [[ "$ROLE" == "compose" && -n "${DOMAIN:-}" ]]; then APP_BASE_URL="${APP_BASE_URL:-https://$DOMAIN}"; fi
    APP_BASE_URL="${APP_BASE_URL:-}"; APP_BASE_URL="${APP_BASE_URL%/}"
    export APP_BASE_URL
    [[ -n "$APP_BASE_URL" ]] && export VITE_API_URL="$APP_BASE_URL/api"
fi
# --dry-run must print the whole plan (web/restart/smoke included) even when no
# env file provides APP_BASE_URL (e.g. --skip-env --skip-backup --env-file /dev/null
# on a dev machine; the backup step needs DATABASE_URL even in --dry-run). A
# placeholder keeps the later `${APP_BASE_URL:?}` guards, which stay fatal outside
# dry-run, from aborting the preview.
if [[ $DRY_RUN -eq 1 && -z "${APP_BASE_URL:-}" ]]; then
    warn "APP_BASE_URL no definida: en --dry-run se usa el marcador <APP_BASE_URL> (fuera de --dry-run sería fatal)."
    APP_BASE_URL="<APP_BASE_URL>"
    export APP_BASE_URL VITE_API_URL="$APP_BASE_URL/api"
fi

# ---------- install ----------
if should_run install; then
    if [[ "$ROLE" == "compose" ]]; then
        step "install · construir imágenes (pnpm --frozen-lockfile dentro del Dockerfile)"
        VITE_API_URL="${VITE_API_URL:-}" run $COMPOSE build --pull api worker
    else
        step "install · corepack pnpm install --frozen-lockfile --prod=false (tsx es devDependency y es el runtime)"
        # The env step exported NODE_ENV=production from api.env: without --prod=false
        # pnpm 9 skips the devDependencies on a clean install and PRUNES them from an
        # existing node_modules (tsx, prisma and vite disappear; `node --import tsx`
        # and `prisma generate` stop working). Verified with pnpm 9.15.0 (2026-09-17).
        run $PNPM install --frozen-lockfile --prod=false
    fi
else skipped install; fi

# ---------- generate ----------
if should_run generate; then
    if [[ "$ROLE" == "compose" ]]; then
        skipped "generate (la imagen ya trae el cliente Prisma)"
    else
        step "generate · cliente Prisma"
        run $PNPM --filter @hotelos/database db:generate
    fi
else skipped generate; fi

# ---------- backup ----------
if should_run backup; then
    step "backup · pg_dump antes de tocar el esquema → $BACKUP_DIR"
    stamp="$(date -u +%Y%m%d_%H%M%S)"
    dump="$BACKUP_DIR/anfitorio-$stamp.pgcustom"
    run mkdir -p "$BACKUP_DIR"
    if [[ "$ROLE" == "compose" ]]; then
        run $COMPOSE up -d postgres
        run_sh "$COMPOSE exec -T postgres pg_dump -U '${POSTGRES_USER:-hotelos}' -d '${POSTGRES_DB:-hotelos}' -Fc > '$dump'"
    else
        command -v pg_dump >/dev/null 2>&1 || die "pg_dump no está instalado (apt install postgresql-client)."
        # Not through run(): it would echo the Postgres password (DATABASE_URL) to the terminal and the journal.
        printf '  $ pg_dump --dbname=%s -Fc -f %s\n' "$(mask_url "$DATABASE_URL")" "$dump"
        [[ $DRY_RUN -eq 1 ]] || pg_dump --dbname="$DATABASE_URL" -Fc -f "$dump"
    fi
    [[ $DRY_RUN -eq 1 ]] || ok "$(du -h "$dump" | cut -f1) · $dump"
    run_sh "find '$BACKUP_DIR' -name 'anfitorio-*.pgcustom' -mtime +$BACKUP_KEEP_DAYS -delete"
else skipped backup; fi

# ---------- adopt ----------
if should_run adopt; then
    step "adopt · marcar la baseline como aplicada si la BD nació con db push (idempotente)"
    # Straight to the package script: the root `db:*` aliases chain a bare `pnpm`
    # and need a pnpm shim in PATH (corepack enable), which a hand-made VPS may lack.
    in_app "$PNPM --filter @hotelos/database db:adopt-baseline"
    echo "  Aplicar el plan anterior (no escribe nada si ya está adoptada o la BD está vacía)."
    confirm
    in_app "$PNPM --filter @hotelos/database db:adopt-baseline -- --apply"
else skipped adopt; fi

# ---------- migrate ----------
if should_run migrate; then
    step "migrate · prisma migrate deploy + comprobación de drift"
    in_app "$PNPM --filter @hotelos/database db:migrate:deploy"
    if in_app "$PNPM --filter @hotelos/database db:drift:check"; then
        ok_or_plan "BD == schema.prisma (sin drift)"
    else
        die "Drift entre la BD y schema.prisma tras migrate deploy: falta una migración (prisma migrate dev --create-only) o alguien hizo db push. No se continúa."
    fi
else skipped migrate; fi

# ---------- rbac ----------
if should_run rbac; then
    step "rbac · informe del catálogo de permisos (sin escribir; el arranque del API sincroniza)"
    in_app "$PNPM --filter @hotelos/api rbac:sync -- --dry-run"
else skipped rbac; fi

# ---------- backfills ----------
if should_run backfills; then
    step "backfills · escritura explícita (--with-backfills) tras el backup"
    confirm
    in_app "$PNPM --filter @hotelos/api backfill:payment-hash -- --apply"
    in_app "$PNPM --filter @hotelos/api backfill:taxes -- --apply"
    in_app "$PNPM --filter @hotelos/api backfill:guest-register -- --apply"
    if [[ -n "${BACKFILL_FROM:-}" && -n "${BACKFILL_TO:-}" ]]; then
        in_app "$PNPM --filter @hotelos/api backfill:snapshots -- --from $BACKFILL_FROM --to $BACKFILL_TO"
    else
        warn "backfill:snapshots omitido: define BACKFILL_FROM y BACKFILL_TO (YYYY-MM-DD) para regenerar cierres."
    fi
else skipped backfills; fi

# ---------- web ----------
if should_run web; then
    : "${APP_BASE_URL:?APP_BASE_URL desconocido: no se puede derivar VITE_API_URL}"
    if [[ "$ROLE" == "compose" ]]; then
        step "web · imagen admin-web con VITE_API_URL=$VITE_API_URL"
        VITE_API_URL="$VITE_API_URL" run $COMPOSE build admin-web
    else
        step "web · build admin-web con VITE_API_URL=$VITE_API_URL → $WEB_ROOT"
        run_sh "VITE_API_URL='$VITE_API_URL' $PNPM --filter @hotelos/admin-web build"
        dist="$ROOT/apps/admin-web/dist"
        if [[ $DRY_RUN -eq 0 ]]; then
            grep -rlF "$VITE_API_URL" "$dist/assets" --include='*.js' >/dev/null || die "El bundle no contiene $VITE_API_URL: build sin VITE_API_URL."
        fi
        if [[ "$WEB_ROOT" != "$dist" ]]; then
            run mkdir -p "$WEB_ROOT"
            if command -v rsync >/dev/null 2>&1; then
                run rsync -a --delete "$dist/" "$WEB_ROOT/"
            else
                run_sh "rm -rf '$WEB_ROOT.new' && cp -a '$dist' '$WEB_ROOT.new' && rm -rf '$WEB_ROOT.old' && mv '$WEB_ROOT' '$WEB_ROOT.old' 2>/dev/null; mv '$WEB_ROOT.new' '$WEB_ROOT' && rm -rf '$WEB_ROOT.old'"
            fi
        fi
        ok_or_plan "dist publicado en $WEB_ROOT"
    fi
else skipped web; fi

# ---------- restart ----------
if should_run restart; then
    if [[ "$ROLE" == "compose" ]]; then
        step "restart · compose up -d (api, worker, admin-web, caddy)"
        run $COMPOSE up -d --no-deps api worker admin-web caddy
    else
        step "restart · systemd"
        units=(anfitorio-api)
        if systemctl list-unit-files anfitorio-worker.service >/dev/null 2>&1 && systemctl list-unit-files anfitorio-worker.service | grep -q anfitorio-worker; then
            units+=(anfitorio-worker)
        else
            warn "anfitorio-worker.service no instalado: solo se reinicia el API."
        fi
        as_root systemctl restart "${units[@]}"
        if [[ $DRY_RUN -eq 0 ]]; then
            port="${PORT:-3000}"
            for _ in $(seq 1 30); do
                if curl -fsS -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then break; fi
                sleep 2
            done
            curl -fsS -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1 || die "El API no responde en 127.0.0.1:$port/health tras el reinicio (journalctl -u anfitorio-api -n 100)."
        fi
        ok_or_plan "servicios reiniciados: ${units[*]}"
    fi
else skipped restart; fi

# ---------- smoke ----------
if should_run smoke; then
    step "smoke · deploy/scripts/smoke.sh"
    : "${APP_BASE_URL:?APP_BASE_URL desconocido para el smoke}"
    smoke_args=(--base-url "$APP_BASE_URL/api" --web-url "$APP_BASE_URL" --expect-api-url "$APP_BASE_URL/api")
    [[ "$ROLE" == "production-native" ]] && smoke_args+=(--web-dist "$WEB_ROOT")
    if [[ -z "${SMOKE_EMAIL:-}" || -z "${SMOKE_PASSWORD:-}" ]]; then
        warn "SMOKE_EMAIL/SMOKE_PASSWORD no definidos en $ENV_FILE: smoke sin login (solo health + 401 + front)."
        smoke_args+=(--skip-login)
    fi
    run bash "$SCRIPT_DIR/smoke.sh" "${smoke_args[@]}"
else skipped smoke; fi

printf '\n'
if [[ $DRY_RUN -eq 1 ]]; then
    c_yellow "· Plan de deploy ($ROLE) mostrado · DRY-RUN: no se ha ejecutado nada"
else
    c_green "✅ Deploy completado ($ROLE) · $(date -u +%H:%M:%SZ)"
fi
if [[ "$ROLE" == "production-native" ]]; then
    echo "   logs: journalctl -u anfitorio-api -f   ·   journalctl -u anfitorio-worker -f"
else
    echo "   logs: $COMPOSE logs -f api"
fi
