#!/usr/bin/env bash
# ehotelOS · inventario de SOLO LECTURA de un VPS existente (Tanda 4).
#
# Imprime lo necesario para decidir cómo adoptar un servidor ya desplegado a
# mano (p. ej. el demo 76.13.55.180 / demo.ehotelos.com) sin cambiar nada:
# usuario, unidades systemd, clon y commit, Node/pnpm, .env (solo NOMBRES de
# variables y si tienen valor, nunca los valores), Postgres (tablas,
# _prisma_migrations, tamaño, backups), Caddy, puertos, SSH y estado HTTP.
#
# Uso (en el VPS, como el usuario de despliegue; sudo solo si está disponible
# sin contraseña — los bloques que lo necesiten se marcan como omitidos):
#   bash deploy/scripts/vps-inventory.sh [--app-dir /opt/anfitorio] [--domain demo.ehotelos.com]
#        [--env-file /etc/anfitorio/api.env] [--web-root /srv/anfitorio/admin-web]
#
# No ejecuta nada que escriba: ni git pull, ni pnpm install, ni psql más allá
# de SELECT. Salida 0 siempre que el script llegue al final.
#
# Pensado para Ubuntu 24.04 (usa timeout, pgrep -a, stat -c, free, ss y
# systemctl). En macOS o sin esas herramientas las filas afectadas imprimen
# «n/d» en vez de fallar; el resto del inventario sigue siendo válido.

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/anfitorio}"
DOMAIN="${DOMAIN:-demo.ehotelos.com}"
ENV_FILE="${ENV_FILE:-/etc/anfitorio/api.env}"
WEB_ROOT="${WEB_ROOT:-/srv/anfitorio/admin-web}"
APP_USER="${APP_USER:-anfitorio}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --app-dir) APP_DIR="$2"; shift 2 ;;
        --domain) DOMAIN="$2"; shift 2 ;;
        --env-file) ENV_FILE="$2"; shift 2 ;;
        --web-root) WEB_ROOT="$2"; shift 2 ;;
        --user) APP_USER="$2"; shift 2 ;;
        -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Opción desconocida: $1" >&2; exit 2 ;;
    esac
done

section() { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
kv()      { printf '  %-34s %s\n' "$1" "$2"; }
have()    { command -v "$1" >/dev/null 2>&1; }
SUDO=""
if [[ $EUID -ne 0 ]] && have sudo && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi
maybe_root() { if [[ $EUID -eq 0 ]]; then "$@"; elif [[ -n "$SUDO" ]]; then $SUDO "$@"; else echo "(omitido: requiere root/sudo)"; return 1; fi; }

printf '\033[1;34mehotelOS · inventario solo lectura · %s · %s\033[0m\n' "$(hostname -f 2>/dev/null || hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

section "Sistema y usuario"
kv "OS" "$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr)"
kv "whoami / id" "$(whoami) · $(id 2>/dev/null | cut -c1-120)"
kv "usuario $APP_USER" "$(id "$APP_USER" 2>/dev/null || echo 'NO EXISTE')"
kv "sudo -l (resumen)" "$( (sudo -n -l 2>/dev/null | tail -n +2 | tr '\n' ' ' | cut -c1-160) || echo 'sin sudo sin contraseña')"
kv "uptime / carga" "$(uptime 2>/dev/null | sed 's/^ *//')"
kv "memoria" "$(free -h 2>/dev/null | awk '/Mem:/ {print $3" usados de "$2}' || echo n/d)"
kv "disco /" "$(df -h / 2>/dev/null | awk 'NR==2 {print $3" usados de "$2" ("$5")"}')"
kv "swap" "$(swapon --show --noheadings 2>/dev/null | awk '{print $1" "$3}' | tr '\n' ' ' || echo ninguno)"
# deploy.sh needs `sudo -n systemctl restart …` (restart step) and a writable backup dir (backup step);
# install-from-scratch.sh creates both, a hand-made server usually has neither.
kv "/etc/sudoers.d/anfitorio-deploy" "$( (maybe_root test -e /etc/sudoers.d/anfitorio-deploy >/dev/null 2>&1 && echo existe) || echo 'no existe o no legible (deploy.sh necesita sudo -n systemctl restart/reload)')"
kv "/var/backups/anfitorio" "$(stat -c '%U:%G %a' /var/backups/anfitorio 2>/dev/null || echo 'no existe (deploy.sh hace mkdir -p sin sudo: créalo como root con owner del usuario de deploy)')"

section "Servicios systemd (anfitorio-*, hotelos-*, caddy, postgresql, redis)"
if have systemctl; then
    systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | grep -E 'anfitorio|hotelos|caddy|postgres|redis|nginx' | sed 's/^/  /' || echo "  (ninguno)"
    for unit in anfitorio-api anfitorio-worker hotelos-api hotelos-worker; do
        if systemctl cat "$unit" >/dev/null 2>&1; then
            printf '\n  --- systemctl cat %s ---\n' "$unit"
            systemctl cat "$unit" 2>/dev/null | grep -E '^(User|Group|WorkingDirectory|EnvironmentFile|Environment|ExecStart|Restart)=' | sed 's/^/    /'
            kv "  estado" "$(systemctl is-active "$unit" 2>/dev/null) / $(systemctl is-enabled "$unit" 2>/dev/null)"
            printf '  --- journalctl -u %s -n 15 ---\n' "$unit"
            (journalctl -u "$unit" -n 15 --no-pager 2>/dev/null || maybe_root journalctl -u "$unit" -n 15 --no-pager) | sed 's/^/    /'
        fi
    done
else
    echo "  systemctl no disponible"
fi
printf '\n  procesos node/tsx/pnpm/vite:\n'
pgrep -af 'node|tsx|pnpm|vite' 2>/dev/null | grep -v pgrep | cut -c1-160 | sed 's/^/    /' || echo "    (ninguno)"
printf '  sesiones tmux:\n'
(tmux ls 2>/dev/null || echo "(ninguna / tmux no instalado)") | sed 's/^/    /'

section "Clon del repositorio"
CLONE=""
for cand in "$APP_DIR/hotelos" "$APP_DIR" "/opt/hotelos/hotelos" "/opt/hotelos" "/home/$APP_USER/hotelos/hotelos" "/home/$APP_USER/hotelos" "/home/$APP_USER/projects/hotelos/hotelos" "/home/cesareme/projects/hotelos/hotelos"; do
    if [[ -f "$cand/pnpm-workspace.yaml" ]]; then CLONE="$cand"; break; fi
done
if [[ -n "$CLONE" ]]; then
    kv "raíz pnpm" "$CLONE"
    kv "git toplevel" "$(git -C "$CLONE" rev-parse --show-toplevel 2>/dev/null || echo n/d)"
    kv "anidado (hotelos/hotelos)" "$([[ "$(git -C "$CLONE" rev-parse --show-toplevel 2>/dev/null)" != "$CLONE" ]] && echo sí || echo no)"
    kv "HEAD" "$(git -C "$CLONE" log -1 --format='%h %ci %s' 2>/dev/null | cut -c1-120)"
    kv "rama" "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    kv "remote" "$(git -C "$CLONE" remote get-url origin 2>/dev/null)"
    kv "ficheros modificados" "$(git -C "$CLONE" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    kv "node_modules/.pnpm (paquetes)" "$(ls "$CLONE/node_modules/.pnpm" 2>/dev/null | wc -l | tr -d ' ')"
    kv "cliente Prisma generado" "$([[ -d "$CLONE/node_modules/.pnpm/node_modules/.prisma/client" || -d "$CLONE/packages/database/node_modules/.prisma/client" || -n "$(find "$CLONE/node_modules/.pnpm" -maxdepth 4 -type d -name '.prisma' 2>/dev/null | head -1)" ]] && echo sí || echo NO)"
    kv "hotelos/.env presente" "$([[ -f "$CLONE/.env" ]] && echo 'SÍ (ojo: los cargadores solo rellenan claves ausentes, pero lo que falte en api.env saldrá de aquí)' || echo no)"
    kv "admin-web/dist" "$([[ -d "$CLONE/apps/admin-web/dist" ]] && stat -c '%y' "$CLONE/apps/admin-web/dist/index.html" 2>/dev/null || echo 'no construido')"
    kv "migraciones locales" "$(ls "$CLONE/packages/database/prisma/migrations" 2>/dev/null | grep -c '^[0-9]' | tr -d ' ') dirs"
    kv "schema.prisma del clon" "$(grep -cE '^model ' "$CLONE/packages/database/prisma/schema.prisma" 2>/dev/null | tr -d ' ') modelos · $(grep -cE '^enum ' "$CLONE/packages/database/prisma/schema.prisma" 2>/dev/null | tr -d ' ') enums (= tablas/enums que la BD debe tener tras migrar ESTE clon; la baseline crea 251/11)"
else
    kv "raíz pnpm" "NO ENCONTRADA (busca con: sudo find / -name pnpm-workspace.yaml -not -path '*/node_modules/*')"
fi

section "Runtime"
kv "node" "$(node -v 2>/dev/null || echo 'NO INSTALADO') ($(command -v node 2>/dev/null))"
kv "corepack" "$(corepack -v 2>/dev/null || echo n/d)"
kv "pnpm (corepack)" "$(COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout 20 corepack pnpm -v 2>/dev/null || echo 'n/d')  (esperado 9.15.0)"
kv "pnpm global" "$(pnpm -v 2>/dev/null || echo 'no en PATH (los scripts raíz db:* lo exigen; deploy.sh llama a --filter directamente)')"
kv "node ≥ 22.9 (--env-file-if-exists)" "$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.stdout.write((a>22||(a===22&&b>=9))?"sí":"NO: db:* y las CLI de apps/api no arrancan con este Node")' 2>/dev/null || echo n/d)"
kv "npm" "$(npm -v 2>/dev/null || echo n/d)"
kv "tsx en apps/api" "$([[ -n "$CLONE" && -d "$CLONE/apps/api/node_modules/tsx" ]] && echo sí || echo no)"

section "Entorno ($ENV_FILE) · solo nombres, nunca valores"
ENVF=""
for cand in "$ENV_FILE" "/etc/anfitorio/api.env" "${CLONE:+$CLONE/.env}" "${CLONE:+$CLONE/apps/api/.env}"; do
    [[ -n "$cand" && -r "$cand" ]] && { ENVF="$cand"; break; }
done
if [[ -n "$ENVF" ]]; then
    kv "fichero" "$ENVF ($(stat -c '%U:%G %a' "$ENVF" 2>/dev/null))"
    for key in NODE_ENV PORT HOST TRUST_PROXY RUN_SCHEDULERS RBAC_STRICT HOTELOS_ALLOW_DEMO_AUTH HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE DATABASE_URL REDIS_URL JWT_SECRET ENCRYPTION_KEY HOTELOS_FIELD_KEY APP_BASE_URL APP_PUBLIC_API_URL VITE_API_URL CORS_ALLOWED_ORIGINS PILOT_PUBLIC_ORIGIN EMAIL_PROVIDER EMAIL_PROVIDER_KEY EMAIL_FROM VERIFACTU_MODE SES_HOSPEDAJES_MODE BOOTSTRAP_TOKEN SENTRY_DSN SMOKE_EMAIL SMOKE_PASSWORD; do
        line="$(grep -E "^[[:space:]]*$key=" "$ENVF" 2>/dev/null | tail -1)"
        if [[ -z "$line" ]]; then
            kv "$key" "ausente"
        else
            value="${line#*=}"; value="${value%%#*}"; value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']$//")"
            case "$key" in
                NODE_ENV|PORT|HOST|TRUST_PROXY|RUN_SCHEDULERS|RBAC_STRICT|HOTELOS_ALLOW_DEMO_AUTH|HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE|APP_BASE_URL|APP_PUBLIC_API_URL|VITE_API_URL|CORS_ALLOWED_ORIGINS|PILOT_PUBLIC_ORIGIN|EMAIL_PROVIDER|EMAIL_FROM|VERIFACTU_MODE|SES_HOSPEDAJES_MODE|SMOKE_EMAIL)
                    kv "$key" "${value:-(vacío)}" ;;
                JWT_SECRET)
                    if [[ -z "$value" ]]; then kv "$key" "VACÍO"; elif [[ "$value" == change-me* ]]; then kv "$key" "PLACEHOLDER change-me"; else kv "$key" "definido (${#value} chars$([[ ${#value} -lt 32 ]] && echo ', <32: débil'))"; fi ;;
                ENCRYPTION_KEY|HOTELOS_FIELD_KEY)
                    if [[ -z "$value" ]]; then kv "$key" "vacío"; elif [[ "$value" == change-me* ]]; then kv "$key" "PLACEHOLDER change-me"; else
                        bytes="$(printf '%s' "$value" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
                        kv "$key" "definido (${#value} chars, base64→${bytes:-?} bytes$([[ "${bytes:-0}" != "32" ]] && echo ', NO son 32 bytes'))"; fi ;;
                *)
                    kv "$key" "$([[ -n "$value" ]] && echo "definido (${#value} chars)" || echo vacío)" ;;
            esac
        fi
    done
    kv "variables totales" "$(grep -cE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$ENVF")"
else
    kv "fichero" "ninguno legible ($ENV_FILE, /etc/anfitorio/api.env, <clon>/.env)"
fi

section "PostgreSQL"
if have psql; then
    kv "psql cliente" "$(psql --version 2>/dev/null)"
    DBURL=""
    [[ -n "$ENVF" ]] && DBURL="$(grep -E '^[[:space:]]*DATABASE_URL=' "$ENVF" | tail -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//")"
    if [[ -n "$DBURL" ]]; then
        kv "DATABASE_URL host/db" "$(printf '%s' "$DBURL" | sed -E 's#^[a-z]+://[^@]*@##')"
        q() { psql "$DBURL" -XtA -v ON_ERROR_STOP=1 -c "$1" 2>&1 | head -5; }
        kv "version()" "$(q 'select version()' | cut -c1-80)"
        # The baseline creates 251 application tables and 11 enums; every later
        # migration adds tables/enums (276/32 on 2026-09-17, b32601a), so the reference is
        # the `model`/`enum` count of the schema.prisma you are about to deploy
        # (printed above for the clone). A migrated database also carries
        # _prisma_migrations, so compare without it.
        kv "tablas en public" "$(q "select count(*) from pg_tables where schemaname='public' and tablename<>'_prisma_migrations'") sin _prisma_migrations (baseline = 251; tras migrar debe coincidir con los \`model\` del schema.prisma desplegado)"
        kv "enums" "$(q "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype='e' and n.nspname='public'")"
        kv "_prisma_migrations" "$(q "select coalesce(to_regclass('_prisma_migrations')::text,'NO EXISTE')")"
        if [[ "$(q "select to_regclass('_prisma_migrations') is not null")" == "t" ]]; then
            q "select migration_name||' · finished='||coalesce(finished_at::text,'NULL')||' · rolled_back='||coalesce(rolled_back_at::text,'NULL') from _prisma_migrations order by started_at" | sed 's/^/    /'
        fi
        kv "tamaño BD" "$(q "select pg_size_pretty(pg_database_size(current_database()))")"
        kv "organizaciones / propiedades" "$(q 'select count(*) from organizations' 2>/dev/null) / $(q 'select count(*) from properties' 2>/dev/null)"
        kv "usuarios / reservas / facturas" "$(q 'select count(*) from users' 2>/dev/null) / $(q 'select count(*) from reservations' 2>/dev/null) / $(q 'select count(*) from invoices' 2>/dev/null)"
    else
        kv "DATABASE_URL" "no disponible: no se consulta la BD"
    fi
else
    kv "psql" "no instalado"
fi
kv "postgresql (systemd)" "$(systemctl is-active postgresql 2>/dev/null || echo n/d)"
kv "backups cron (usuario)" "$(crontab -l 2>/dev/null | grep -Ei 'pg_dump|backup' | head -2 | tr '\n' ';' || echo ninguno)"
kv "backups /etc/cron.d" "$(grep -lEi 'pg_dump|backup' /etc/cron.d/* 2>/dev/null | tr '\n' ' ' || echo ninguno)"
kv "/var/backups/anfitorio (últimos)" "$(ls -1 /var/backups/anfitorio 2>/dev/null | tail -3 | tr '\n' ' ' || echo 'no existe')"

section "Caddy y front"
kv "caddy" "$(caddy version 2>/dev/null | head -1 || echo 'no instalado')"
kv "caddy (systemd)" "$(systemctl is-active caddy 2>/dev/null || echo n/d)"
if [[ -r /etc/caddy/Caddyfile ]]; then
    kv "/etc/caddy/Caddyfile" "$(wc -l </etc/caddy/Caddyfile | tr -d ' ') líneas"
    grep -nE 'handle_path|handle |reverse_proxy|root \*|try_files|file_server|strip_prefix|^[a-z0-9.-]+ \{' /etc/caddy/Caddyfile | sed 's/^/    /'
else
    kv "/etc/caddy/Caddyfile" "no legible/no existe"
fi
DIST=""
for cand in "$WEB_ROOT" "${CLONE:+$CLONE/apps/admin-web/dist}" /var/www/anfitorio /var/www/html; do
    [[ -n "$cand" && -f "$cand/index.html" ]] && { DIST="$cand"; break; }
done
if [[ -n "$DIST" ]]; then
    kv "dist servido" "$DIST ($(stat -c '%y' "$DIST/index.html" 2>/dev/null | cut -c1-19))"
    kv "URL horneada (https://$DOMAIN/api)" "$(grep -rlF "https://$DOMAIN/api" "$DIST/assets" 2>/dev/null | wc -l | tr -d ' ') ficheros"
    kv "URL horneada localhost:3000" "$(grep -rlF 'http://localhost:3000' "$DIST/assets" 2>/dev/null | wc -l | tr -d ' ') ficheros (esperado 0)"
else
    kv "dist servido" "no encontrado"
fi

section "Red y seguridad"
kv "puertos en escucha" "$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | awk 'NR>1 {print $4}' | sort -u | tr '\n' ' ')"
kv "3000 solo en loopback" "$( (ss -ltn 2>/dev/null | grep -q '127.0.0.1:3000' && echo sí) || (ss -ltn 2>/dev/null | grep -q ':3000' && echo 'NO (expuesto)') || echo 'no escucha')"
kv "ufw" "$(maybe_root ufw status 2>/dev/null | head -1)"
kv "fail2ban" "$(systemctl is-active fail2ban 2>/dev/null || echo n/d)"
kv "sshd PasswordAuthentication" "$(maybe_root sshd -T 2>/dev/null | grep -i '^passwordauthentication' | awk '{print $2}')"
kv "sshd PermitRootLogin" "$(maybe_root sshd -T 2>/dev/null | grep -i '^permitrootlogin' | awk '{print $2}')"

section "HTTP público (https://$DOMAIN)"
if have curl; then
    kv "/health" "$(curl -sS -m 10 "https://$DOMAIN/health" 2>&1 | head -c 200)"
    kv "/api/health" "HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" 2>/dev/null)"
    kv "/api/properties sin token" "HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/properties" 2>/dev/null) (esperado 401)"
    kv "/ (index)" "HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/" 2>/dev/null) · $(curl -sSI -m 10 "https://$DOMAIN/" 2>/dev/null | grep -i '^cache-control' | tr -d '\r')"
    kv "/accept-invite (SPA)" "HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/accept-invite" 2>/dev/null)"
fi

printf '\n\033[1;32mInventario terminado. Nada se ha modificado.\033[0m\n'
printf 'Siguiente paso sugerido: deploy/README-INSTALL.md · sección "Adopción de un VPS existente".\n'
