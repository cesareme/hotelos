#!/usr/bin/env bash
# ehotelOS · instalación desde cero en Ubuntu 24.04 (nativa: systemd + Caddy, sin Docker).
#
# Idempotente: cada paso comprueba su estado antes de actuar y puede repetirse.
#
#   sudo bash install-from-scratch.sh --demo  --domain demo.ehotelos.com [opciones]
#   sudo bash install-from-scratch.sh --real  --domain pms.hotel.es    [opciones]
#   sudo bash install-from-scratch.sh --adopt [--app-dir /opt/anfitorio] [--domain ...]
#
# Modos:
#   --demo   instalación de demostración: siembra la org demo (org_123/prop_123,
#            usuario reception@example.com / hotelos-demo) + seeds comercial,
#            snapshots, compliance, operaciones, cancelaciones, cupos, F&B y rbac:sync.
#   --real   instalación para un hotel real: NO siembra nada. Genera BOOTSTRAP_TOKEN
#            y muestra la llamada POST /onboarding/bootstrap que crea la organización,
#            la propiedad y el primer administrador (el resto entra por invitación).
#   --adopt  SOLO LECTURA: detecta lo que hay (node/pnpm/postgres/servicios/.env/
#            _prisma_migrations) y propone los pasos. No escribe nada.
#
# Opciones:
#   --domain HOST        dominio público (obligatorio en --demo/--real; Caddy pide el
#                        certificado Let's Encrypt → el DNS A debe apuntar a esta máquina)
#   --repo URL           repositorio git (default: https://github.com/cesareme/hotelos.git)
#   --branch RAMA        rama a desplegar (default: main)
#   --app-dir RUTA       clon (default: /opt/anfitorio; el código está en <dir>/hotelos)
#                        (alias: --dir; vps-inventory.sh y el README usan --app-dir)
#   --user USUARIO       usuario de sistema que ejecuta API y worker (default: anfitorio)
#   --db-name / --db-user  base de datos y rol de Postgres (default: anfitorio / anfitorio)
#   --web-root RUTA      dónde publica Caddy el build (default: /srv/anfitorio/admin-web)
#   --env-file RUTA      fichero de entorno (default: /etc/anfitorio/api.env)
#   --acme-email EMAIL   contacto Let's Encrypt (default: admin@<domain>)
#   --no-caddy           no instalar ni configurar Caddy (proxy propio)
#   --no-worker          no instalar anfitorio-worker.service
#   --skip-smoke         no ejecutar deploy/scripts/smoke.sh al final
#   --yes                no pedir confirmaciones
#
# Qué hace (--demo / --real), en orden:
#   1 paquetes apt · 2 Node 22 + corepack pnpm 9.15.0 · 3 usuario de sistema ·
#   4 rol y BD Postgres · 5 clone/update del repo · 6 pnpm install --frozen-lockfile ·
#   7 /etc/anfitorio/api.env desde .env.example con secretos openssl · 8 validate-env ·
#   9 db:generate · 10 db:adopt-baseline + db:migrate:deploy + db:drift:check ·
#   11 seeds (--demo) o instrucciones de bootstrap (--real) + rbac:sync ·
#   12 build admin-web con VITE_API_URL=https://<domain>/api → web-root ·
#   13 unidades systemd · 14 Caddyfile nativo · 15 smoke.
#
# Salida: 0 OK · 1 fallo · 2 argumentos/prerrequisitos inválidos.

set -euo pipefail

MODE=""
DOMAIN=""
REPO_URL="${REPO_URL:-https://github.com/cesareme/hotelos.git}"
BRANCH="main"
APP_DIR="/opt/anfitorio"
APP_USER="anfitorio"
DB_NAME="anfitorio"
DB_USER="anfitorio"
WEB_ROOT="/srv/anfitorio/admin-web"
ENV_FILE="/etc/anfitorio/api.env"
ACME_EMAIL=""
WITH_CADDY=1
WITH_WORKER=1
RUN_SMOKE=1
ASSUME_YES=0
PNPM_VERSION="9.15.0"
NODE_MAJOR="22"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export DEBIAN_FRONTEND=noninteractive

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
step()    { printf '\n'; c_blue "▶ $*"; }
ok()      { c_green "  ✓ $*"; }
warn()    { c_yellow "  ⚠ $*"; }
die()     { c_red "  ✗ $1"; exit "${2:-1}"; }
# Help = the comment header above, up to its last line (never the `set` line).
usage()   { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
confirm() {
    [[ $ASSUME_YES -eq 1 ]] && return 0
    local answer
    read -r -p "  ¿Continuar? [s/N] " answer
    [[ "$answer" == "s" || "$answer" == "S" || "$answer" == "y" || "$answer" == "Y" ]] || die "Cancelado por el operador."
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --demo|--real|--adopt) MODE="${1#--}"; shift ;;
        --domain) DOMAIN="$2"; shift 2 ;;
        --repo) REPO_URL="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --app-dir|--dir) APP_DIR="$2"; shift 2 ;;   # same flag name as vps-inventory.sh; --dir kept for old runbooks
        --user) APP_USER="$2"; shift 2 ;;
        --db-name) DB_NAME="$2"; shift 2 ;;
        --db-user) DB_USER="$2"; shift 2 ;;
        --web-root) WEB_ROOT="$2"; shift 2 ;;
        --env-file) ENV_FILE="$2"; shift 2 ;;
        --acme-email) ACME_EMAIL="$2"; shift 2 ;;
        --no-caddy) WITH_CADDY=0; shift ;;
        --no-worker) WITH_WORKER=0; shift ;;
        --skip-smoke) RUN_SMOKE=0; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "Opción desconocida: $1" 2 ;;
    esac
done

[[ -n "$MODE" ]] || { usage >&2; die "Indica --demo, --real o --adopt" 2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- --adopt: detección sin escritura ----------
if [[ "$MODE" == "adopt" ]]; then
    c_blue "═══════════════════════════════════════════════════════════"
    c_blue " ehotelOS · modo --adopt · solo lectura"
    c_blue "═══════════════════════════════════════════════════════════"
    bash "$SCRIPT_DIR/vps-inventory.sh" --app-dir "$APP_DIR" --domain "${DOMAIN:-demo.ehotelos.com}" --env-file "$ENV_FILE" --web-root "$WEB_ROOT" --user "$APP_USER"
    printf '\n'
    c_blue "Propuesta de adopción (nada de esto se ha ejecutado):"
    cat <<PLAN
  1. Copia de seguridad:      pg_dump --dbname="\$DATABASE_URL" -Fc -f /var/backups/anfitorio/pre-adopcion.pgcustom
  2. Entorno en un solo sitio: crea $ENV_FILE (chmod 640 root:$APP_USER) con las variables
     del .env actual + NODE_ENV=production, HOST=127.0.0.1, TRUST_PROXY=1, APP_BASE_URL=https://<dominio>,
     VITE_API_URL=https://<dominio>/api, RUN_SCHEDULERS=true; borra hotelos/.env del clon.
     Valida: node scripts/validate-env.mjs $ENV_FILE --role production-native
  3. Código y dependencias:   git fetch && git reset --hard origin/$BRANCH && corepack pnpm install --frozen-lockfile --prod=false
                              (--prod=false: con NODE_ENV=production exportado pnpm 9 omite/borra las devDependencies, y tsx es el runtime;
                              si el lockfile de origin/main no está al día, ERR_PNPM_OUTDATED_LOCKFILE: commitear pnpm-lock.yaml o
                              instalar con --no-frozen-lockfile --prod=false y luego git checkout -- pnpm-lock.yaml)
                              corepack pnpm --filter @hotelos/database db:generate
  4. Esquema (sin db push):   si _prisma_migrations NO existe o la BD nació con db push:
                                corepack pnpm db:adopt-baseline            (plan)
                                corepack pnpm db:adopt-baseline -- --apply
                              corepack pnpm db:migrate:deploy && corepack pnpm db:drift:check   (exit 0 obligatorio)
                              Si el esquema del VPS es ANTERIOR a la baseline (faltan tablas/columnas), adopt-baseline
                              se niega. NUNCA «db push» en una BD compartida: alinéala restaurando un dump ya
                              alineado con la baseline, o crea una BD vacía + SOLO la baseline por psql
                              (prisma/migrations/20260914000000_baseline_squash/migration.sql) + pg_restore --data-only
                              --disable-triggers revisado; después adopt/migrate/drift sobre esa BD (así las migraciones
                              posteriores ejecutan sus UPDATE de datos; con migrate deploy antes del volcado se perderían).
  5. Front:                   VITE_API_URL=https://<dominio>/api corepack pnpm --filter @hotelos/admin-web build
                              rsync -a --delete apps/admin-web/dist/ $WEB_ROOT/
  6. Servicios:               instala deploy/systemd/anfitorio-api.service (+ worker) y deploy/caddy/Caddyfile.native
                              (sustituye rutas/dominio), systemctl daemon-reload && systemctl enable --now anfitorio-api
                              + /etc/sudoers.d/anfitorio-deploy (sudo -n systemctl restart/reload para $APP_USER) y
                              /var/backups/anfitorio propiedad de $APP_USER (750): deploy.sh los necesita en backup y restart
  7. Verificación:            bash deploy/scripts/smoke.sh --base-url https://<dominio>/api --web-url https://<dominio> \\
                                --web-dist $WEB_ROOT --email <SMOKE_EMAIL> --password <SMOKE_PASSWORD>
  A partir de ahí, cada actualización = bash deploy/scripts/deploy.sh --pull --yes
PLAN
    exit 0
fi

# ---------- prerrequisitos ----------
[[ $EUID -eq 0 ]] || die "Ejecuta como root (sudo): instala paquetes, crea el usuario y las unidades systemd." 2
[[ -n "$DOMAIN" ]] || die "--domain es obligatorio en modo --$MODE (p. ej. --domain demo.ehotelos.com)" 2
[[ -z "$ACME_EMAIL" ]] && ACME_EMAIL="admin@$DOMAIN"
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
        warn "Probado en Ubuntu 24.04; detectado ${PRETTY_NAME:-desconocido}. Los pasos apt pueden diferir."
    fi
else
    warn "No se pudo leer /etc/os-release."
fi
APP_HOME="/home/$APP_USER"
APP_BASE_URL="https://$DOMAIN"
VITE_API_URL="$APP_BASE_URL/api"

c_blue "═══════════════════════════════════════════════════════════"
c_blue " ehotelOS · instalación --$MODE · $DOMAIN"
c_blue " clon $APP_DIR · usuario $APP_USER · BD $DB_NAME · env $ENV_FILE"
c_blue "═══════════════════════════════════════════════════════════"

# Runs a command as the app user with the env file exported (parsed, never eval'd).
ENV_LOADER='load_env_file() {
    local file="$1" line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"
        [[ -z "$line" || "$line" == \#* ]] && continue
        [[ "$line" == *=* ]] || continue
        key="${line%%=*}"; value="${line#*=}"
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
        if [[ ( "$value" == \"*\" && "$value" == *\" ) || ( "$value" == \'"'"'*\'"'"' && "$value" == *\'"'"' ) ]]; then
            value="${value:1:${#value}-2}"
        fi
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        export "$key=$value"
    done <"$file"
}'
eval "$ENV_LOADER"
# as_app DIR CMD... — as the app user, in DIR, with the env file loaded.
as_app() {
    local dir="$1"; shift
    local envf=""
    [[ -r "$ENV_FILE" ]] && envf="$ENV_FILE"
    sudo -u "$APP_USER" -H env -i HOME="$APP_HOME" PATH="/usr/local/bin:/usr/bin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
        bash -c "$ENV_LOADER
            [[ -n \"\$1\" ]] && load_env_file \"\$1\"
            cd \"\$2\" || exit 1
            shift 2
            exec \"\$@\"" _ "$envf" "$dir" "$@"
}

# ---------- 1. paquetes ----------
step "1/15 · Paquetes apt"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    curl git ca-certificates gnupg openssl jq rsync ufw \
    postgresql postgresql-client \
    debian-keyring debian-archive-keyring apt-transport-https >/dev/null
ok "curl git openssl jq rsync postgresql instalados"

# ---------- 2. Node 22 + corepack pnpm ----------
step "2/15 · Node $NODE_MAJOR + corepack pnpm@$PNPM_VERSION"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" != "$NODE_MAJOR" ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
corepack enable
corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null
ok "node $(node -v) · pnpm $(corepack pnpm -v) en $(command -v node)"

# ---------- 3. usuario de sistema ----------
step "3/15 · Usuario de sistema $APP_USER"
if id -u "$APP_USER" >/dev/null 2>&1; then
    ok "ya existe"
else
    useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
    ok "creado ($APP_HOME)"
fi
sudo -u "$APP_USER" -H env HOME="$APP_HOME" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || warn "corepack prepare como $APP_USER falló (se descargará en el primer uso)"

# ---------- 4. Postgres ----------
step "4/15 · PostgreSQL: rol $DB_USER y base $DB_NAME"
systemctl enable --now postgresql >/dev/null
DB_PASSWORD=""
if [[ -r "$ENV_FILE" ]]; then
    existing_url="$(grep -E '^[[:space:]]*DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//")"
    if [[ "$existing_url" =~ ^postgres(ql)?://[^:]+:([^@]+)@ ]]; then DB_PASSWORD="${BASH_REMATCH[2]}"; fi
fi
[[ -z "$DB_PASSWORD" ]] && DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)"
if [[ "$(sudo -u postgres psql -XtAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")" == "1" ]]; then
    sudo -u postgres psql -Xqc "ALTER ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
    ok "rol $DB_USER existente (contraseña alineada con $ENV_FILE)"
else
    sudo -u postgres psql -Xqc "CREATE ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASSWORD' CREATEDB" >/dev/null
    ok "rol $DB_USER creado"
fi
if [[ "$(sudo -u postgres psql -XtAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" == "1" ]]; then
    ok "base $DB_NAME existente"
else
    sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
    ok "base $DB_NAME creada"
fi
DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME"

# ---------- 5. clon ----------
step "5/15 · Repositorio en $APP_DIR ($REPO_URL · $BRANCH)"
mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    if [[ -n "$(sudo -u "$APP_USER" git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]]; then
        die "$APP_DIR tiene cambios locales sin commit; no se hace reset. Revísalos o haz stash."
    fi
    sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$BRANCH"
    sudo -u "$APP_USER" git -C "$APP_DIR" checkout -q "$BRANCH"
    sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH" >/dev/null
    ok "actualizado a $(git -C "$APP_DIR" log -1 --oneline)"
else
    [[ -e "$APP_DIR" ]] && die "$APP_DIR existe pero no es un clon git."
    sudo -u "$APP_USER" -H git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    ok "clonado $(git -C "$APP_DIR" log -1 --oneline)"
fi
if [[ -f "$APP_DIR/hotelos/pnpm-workspace.yaml" ]]; then
    ROOT="$APP_DIR/hotelos"      # repo anidado (estado actual)
elif [[ -f "$APP_DIR/pnpm-workspace.yaml" ]]; then
    ROOT="$APP_DIR"              # repo aplanado (deuda 1 de CLAUDE.md)
else
    die "No encuentro pnpm-workspace.yaml en $APP_DIR ni en $APP_DIR/hotelos."
fi
ok "raíz pnpm: $ROOT"
if [[ -f "$ROOT/.env" ]]; then
    warn "$ROOT/.env existe: los cargadores del API y del worker solo rellenan claves ausentes, pero cualquier clave que falte en $ENV_FILE se tomaría de ahí. Muévelo fuera del clon (la configuración vive en $ENV_FILE)."
fi

# ---------- 6. dependencias ----------
step "6/15 · corepack pnpm install --frozen-lockfile --prod=false (tsx es el runtime)"
# as_app exports $ENV_FILE when it already exists (re-runs): NODE_ENV=production would
# make pnpm 9 skip/prune the devDependencies (tsx, prisma, vite) without --prod=false.
as_app "$ROOT" corepack pnpm install --frozen-lockfile --prod=false
ok "dependencias instaladas"

# ---------- 7. fichero de entorno ----------
step "7/15 · Entorno $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
set_env() {
    # set_env KEY VALUE — single definition of KEY in ENV_FILE: every active
    # `KEY=` line becomes KEY=VALUE (the first one) or is dropped (duplicates);
    # with no active line, the last commented `# KEY=` is uncommented; else append.
    local key="$1" value="$2"
    if grep -qE "^[[:space:]]*#?[[:space:]]*$key=" "$ENV_FILE"; then
        awk -v k="$key" -v v="$value" '
            {
                lines[NR] = $0
                if ($0 ~ "^[[:space:]]*" k "=") { active++; if (active == 1) keep = NR; else drop[NR] = 1 }
                else if ($0 ~ "^[[:space:]]*#[[:space:]]*" k "=") lastc = NR
            }
            END {
                target = active ? keep : lastc
                for (i = 1; i <= NR; i++) {
                    if (i in drop) continue
                    if (i == target) print k "=" v; else print lines[i]
                }
            }
        ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    fi
}
if [[ -f "$ENV_FILE" ]]; then
    ok "ya existe: se conservan los valores; solo se completan claves ausentes"
else
    cp "$ROOT/.env.example" "$ENV_FILE"
    set_env JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
    set_env ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
    if [[ "$MODE" == "real" ]]; then
        set_env BOOTSTRAP_TOKEN "$(openssl rand -hex 32)"
        set_env SMOKE_EMAIL ""
        set_env SMOKE_PASSWORD ""
    else
        set_env BOOTSTRAP_TOKEN ""
        set_env SMOKE_EMAIL "reception@example.com"
        set_env SMOKE_PASSWORD "hotelos-demo"
    fi
    ok "creado desde .env.example con JWT_SECRET/ENCRYPTION_KEY generados (openssl)"
fi
# Keys the native production role always needs (idempotent overwrite of
# infrastructure values; secrets above are generated only once).
set_env NODE_ENV production
set_env PORT 3000
set_env HOST 127.0.0.1
set_env TRUST_PROXY 1
set_env RBAC_STRICT true
set_env RUN_SCHEDULERS true
set_env DATABASE_URL "$DATABASE_URL"
set_env APP_BASE_URL "$APP_BASE_URL"
set_env API_PUBLIC_URL "$VITE_API_URL"
set_env VITE_API_URL "$VITE_API_URL"
set_env CORS_ALLOWED_ORIGINS "$APP_BASE_URL"
set_env HOTELOS_ALLOW_DEMO_AUTH false
set_env AUTH_EXPOSE_RESET_TOKEN false
set_env ADMIN_EXPOSE_TEMP_PASSWORD false
grep -qE '^SMOKE_PROPERTY_ID=' "$ENV_FILE" || set_env SMOKE_PROPERTY_ID prop_123
chown "root:$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
ok "$ENV_FILE (root:$APP_USER 640) · APP_BASE_URL=$APP_BASE_URL · VITE_API_URL=$VITE_API_URL"

# ---------- 8. validate-env ----------
step "8/15 · validate-env"
if grep -q -- '--role' "$ROOT/scripts/validate-env.mjs"; then
    node "$ROOT/scripts/validate-env.mjs" "$ENV_FILE" --role production-native
else
    node "$ROOT/scripts/validate-env.mjs" "$ENV_FILE" --production
fi
ok "entorno válido"

# ---------- 9. prisma generate ----------
step "9/15 · Cliente Prisma"
as_app "$ROOT" corepack pnpm --filter @hotelos/database db:generate >/dev/null
ok "generado"

# ---------- 10. esquema ----------
step "10/15 · Esquema: adopt-baseline (idempotente) + migrate deploy + drift check"
as_app "$ROOT" corepack pnpm db:adopt-baseline
as_app "$ROOT" corepack pnpm db:adopt-baseline -- --apply
as_app "$ROOT" corepack pnpm db:migrate:deploy
if as_app "$ROOT" corepack pnpm db:drift:check; then
    ok "BD == schema.prisma"
else
    die "Drift entre la BD y schema.prisma tras migrate deploy."
fi

# ---------- 11. datos ----------
if [[ "$MODE" == "demo" ]]; then
    step "11/15 · Seeds de demostración (org_123 / prop_123 · reception@example.com / hotelos-demo)"
    warn "Estos datos son públicos y ficticios: NUNCA en una instalación con clientes reales."
    confirm
    DB_PKG="$ROOT/packages/database"
    # Direct node invocations: the db:seed:* scripts use `--env-file=../../.env`,
    # which aborts when that file does not exist (and it must not on a server).
    as_app "$DB_PKG" node --import tsx prisma/seed.ts
    for seed in seed-commercial-demo seed-revenue-snapshots seed-compliance seed-operations seed-cancellation-policies seed-allotments seed-fnb-inventory; do
        if [[ -f "$DB_PKG/prisma/$seed.ts" ]]; then
            as_app "$DB_PKG" node --import tsx "prisma/$seed.ts"
            ok "$seed"
        else
            warn "prisma/$seed.ts no existe en esta revisión; omitido"
        fi
    done
    as_app "$ROOT/apps/api" node --import tsx src/scripts/rbac-sync.ts
    ok "rbac:sync aplicado"
else
    step "11/15 · Instalación real: sin datos de demostración"
    as_app "$ROOT/apps/api" node --import tsx src/scripts/rbac-sync.ts
    ok "catálogo de permisos sincronizado (rbac:sync)"
fi

# ---------- 12. front ----------
step "12/15 · Build de admin-web (VITE_API_URL=$VITE_API_URL) → $WEB_ROOT"
as_app "$ROOT" env VITE_API_URL="$VITE_API_URL" corepack pnpm --filter @hotelos/admin-web build >/dev/null
grep -rlF "$VITE_API_URL" "$ROOT/apps/admin-web/dist/assets" --include='*.js' >/dev/null || die "El bundle no contiene $VITE_API_URL."
mkdir -p "$WEB_ROOT"
rsync -a --delete "$ROOT/apps/admin-web/dist/" "$WEB_ROOT/"
chown -R "$APP_USER:$APP_USER" "$WEB_ROOT" "$(dirname "$WEB_ROOT")"
ok "publicado en $WEB_ROOT"

# ---------- 13. systemd ----------
step "13/15 · Unidades systemd"
render_unit() {
    sed -e "s#/opt/anfitorio/hotelos#$ROOT#g" -e "s#^User=anfitorio#User=$APP_USER#" -e "s#^Group=anfitorio#Group=$APP_USER#" \
        -e "s#/etc/anfitorio/api.env#$ENV_FILE#g" -e "s#/usr/bin/node#$(command -v node)#g" "$1"
}
render_unit "$ROOT/deploy/systemd/anfitorio-api.service" >/etc/systemd/system/anfitorio-api.service
units=(anfitorio-api)
if [[ $WITH_WORKER -eq 1 ]]; then
    render_unit "$ROOT/deploy/systemd/anfitorio-worker.service" >/etc/systemd/system/anfitorio-worker.service
    units+=(anfitorio-worker)
fi
systemctl daemon-reload
systemctl enable "${units[@]}" >/dev/null 2>&1
systemctl restart "${units[@]}"
# deploy.sh (and deploy.yml over SSH) run as $APP_USER and only need these
# exact systemctl verbs; the backup dir must be writable by the same user.
cat >"/etc/sudoers.d/anfitorio-deploy" <<SUDO
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart anfitorio-api, /usr/bin/systemctl restart anfitorio-api anfitorio-worker, /usr/bin/systemctl restart anfitorio-worker, /usr/bin/systemctl reload caddy, /usr/bin/systemctl status anfitorio-api, /usr/bin/systemctl status anfitorio-worker
SUDO
chmod 0440 /etc/sudoers.d/anfitorio-deploy
visudo -c -f /etc/sudoers.d/anfitorio-deploy >/dev/null || die "sudoers inválido en /etc/sudoers.d/anfitorio-deploy"
mkdir -p /var/backups/anfitorio && chown "$APP_USER:$APP_USER" /var/backups/anfitorio && chmod 750 /var/backups/anfitorio
ok "sudoers para systemctl restart (usuario $APP_USER) · /var/backups/anfitorio"
for _ in $(seq 1 30); do
    curl -fsS -m 3 http://127.0.0.1:3000/health >/dev/null 2>&1 && break
    sleep 2
done
curl -fsS -m 3 http://127.0.0.1:3000/health >/dev/null 2>&1 || die "El API no responde en 127.0.0.1:3000/health (journalctl -u anfitorio-api -n 100)."
ok "${units[*]} activos · API en 127.0.0.1:3000"

# ---------- 14. Caddy ----------
if [[ $WITH_CADDY -eq 1 ]]; then
    step "14/15 · Caddy (HTTPS automático) para $DOMAIN"
    if ! command -v caddy >/dev/null 2>&1; then
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    fi
    # El rango `d` elimina el bloque de transición 301 del dominio anterior de la
    # demo (Caddyfile.native): una instalación nueva no debe pedir certificados
    # para ese host. Va PRIMERO: sed evalúa las expresiones en orden sobre cada
    # línea y, si $DOMAIN fuera el dominio anterior, el `s` del dominio nuevo
    # renombraría antes el bloque principal a ese host y el rango lo borraría
    # también (Caddyfile sin sitios). `caddy validate` (abajo) valida el
    # resultado.
    sed -e '/^demo\.hotelos\.es {$/,/^}$/d' -e "s#demo\.ehotelos\.com#$DOMAIN#g" -e "s#admin@ehotelos\.com#$ACME_EMAIL#" -e "s#/srv/anfitorio/admin-web#$WEB_ROOT#g" \
        "$ROOT/deploy/caddy/Caddyfile.native" >/etc/caddy/Caddyfile
    mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy 2>/dev/null || true
    caddy validate --config /etc/caddy/Caddyfile >/dev/null
    systemctl enable caddy >/dev/null 2>&1
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    if ufw status 2>/dev/null | grep -q 'Status: active'; then
        ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
        ok "ufw: 80/443 abiertos"
    fi
    ok "Caddy sirviendo $WEB_ROOT y /api → 127.0.0.1:3000 (certificado al primer acceso; el DNS debe apuntar aquí)"
else
    step "14/15 · Caddy omitido (--no-caddy): configura tu proxy con /api/* → 127.0.0.1:3000 (strip /api) y SPA desde $WEB_ROOT"
fi

# ---------- 15. smoke ----------
if [[ $RUN_SMOKE -eq 1 ]]; then
    step "15/15 · Smoke"
    smoke_args=(--web-dist "$WEB_ROOT" --expect-api-url "$VITE_API_URL")
    if [[ $WITH_CADDY -eq 1 ]]; then
        smoke_args+=(--base-url "$VITE_API_URL" --web-url "$APP_BASE_URL")
    else
        smoke_args+=(--base-url http://127.0.0.1:3000 --skip-web)
    fi
    smoke_email="$(grep -E '^SMOKE_EMAIL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
    smoke_password="$(grep -E '^SMOKE_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
    if [[ -n "$smoke_email" && -n "$smoke_password" ]]; then
        smoke_args+=(--email "$smoke_email" --password "$smoke_password")
    else
        smoke_args+=(--skip-login)
        warn "sin SMOKE_EMAIL/SMOKE_PASSWORD: smoke sin login (añádelos a $ENV_FILE tras crear el primer usuario)"
    fi
    if bash "$ROOT/deploy/scripts/smoke.sh" "${smoke_args[@]}"; then
        ok "smoke OK"
    else
        warn "smoke con fallos: si el certificado aún no está emitido (DNS recién cambiado), espera un minuto y repite: bash $ROOT/deploy/scripts/smoke.sh ${smoke_args[*]}"
    fi
else
    step "15/15 · Smoke omitido (--skip-smoke)"
fi

printf '\n'
c_green "✅ Instalación --$MODE completada · https://$DOMAIN"
cat <<NEXT

  Entorno:        $ENV_FILE
  Código:         $ROOT  (usuario $APP_USER)
  Servicios:      systemctl status ${units[*]} caddy
  Logs:           journalctl -u anfitorio-api -f
  Actualizar:     cd $ROOT && sudo -u $APP_USER bash deploy/scripts/deploy.sh --pull --yes
  Smoke:          bash $ROOT/deploy/scripts/smoke.sh --base-url $VITE_API_URL --web-url $APP_BASE_URL --web-dist $WEB_ROOT
NEXT
if [[ "$MODE" == "real" ]]; then
    bootstrap_token="$(grep -E '^BOOTSTRAP_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
    cat <<REAL

  PRIMER ARRANQUE (hotel real) — crea organización + propiedad + primer administrador.
  El endpoint solo funciona mientras no exista ninguna organización y exige el token de $ENV_FILE:

    curl -fsS -X POST $VITE_API_URL/onboarding/bootstrap -H 'content-type: application/json' -d '{
      "bootstrapToken": "$bootstrap_token",
      "organization": { "name": "Hotel Ejemplo SL", "taxId": "B12345678", "country": "ES" },
      "property": { "name": "Hotel Ejemplo", "province": "Madrid", "postalCode": "28001", "timezone": "Europe/Madrid" },
      "adminUser": { "email": "admin@hotel-ejemplo.es", "password": "<contraseña fuerte>", "fullName": "Administración" }
    }'

  Después: inicia sesión en https://$DOMAIN, invita al resto del equipo (Backoffice → usuarios; llegan por
  /accept-invite) y añade SMOKE_EMAIL/SMOKE_PASSWORD a $ENV_FILE con un usuario de lectura para el smoke.
REAL
else
    cat <<DEMO

  Acceso demo:    https://$DOMAIN  ·  reception@example.com / hotelos-demo
DEMO
fi
