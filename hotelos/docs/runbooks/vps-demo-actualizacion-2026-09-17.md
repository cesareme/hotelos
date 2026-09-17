# Runbook · Actualización del VPS demo `demo.ehotelos.com` (76.13.55.180) · 2026-09-17

**Quién:** César, por SSH como usuario `anfitorio` (el Mac no tiene la clave autorizada
en ese VPS; ver §14). **Qué:** llevar la demo pública del build del 11-jul-2026 al
`origin/main` actual (`b32601a`, 17-sep 11:47, Tanda 7b; mínimo
`cc4981007b886756d43ed0488c23f766aed80071`) conservando su base de datos, con la baseline
adoptada, las 10 migraciones posteriores aplicadas,
las CLI de datos ejecutadas en el orden validado, el modo demo sin token retirado, las
unidades systemd y el Caddyfile versionados, el front horneado con
`VITE_API_URL=https://demo.ehotelos.com/api` y el `smoke.sh` en verde.

**Rebrand ehotelOS (2026-09, D5/D16).** Este runbook se escribió antes del cambio de marca; el
dominio y los nombres de los datos demo están sustituidos en el texto: `demo.ehotelos.com` (mismo
VPS 76.13.55.180; el dominio anterior de la demo responde 301 desde el bloque de transición de
`deploy/caddy/Caddyfile.native`) y los nombres neutros de D3 («Grupo Hotelero Demo», «Grupo
Hotelero Demo SL», «Hotel Demo Madrid Centro», «Hotel Demo Tenerife Sur»), que en una BD que aún
lleve los antiguos los pone `scripts/sql/rebrand-ehotelos-demo.sql` (lote 7) antes de comparar
las salidas «esperadas». No cambian rutas (`/opt|/etc|/srv|/var/backups/anfitorio`), unidades
`anfitorio-api`/`anfitorio-worker`, usuario y BD `anfitorio`, `HOTELOS_*` ni la contraseña demo.
El SIF VeriFactu NO sigue a la marca: `api.env` lleva el pin de la tabla de claves de §4 hasta la
nueva declaración responsable (D4).

**Fuente:** reconocimiento de `deploy/`, del contrato de entorno y del VPS por HTTP
(17-sep-2026) y **ensayo local completo** del mismo día sobre una BD de ensayo
(`anfitorio_vps_rehearsal`, copia del dump `backups/hotelos-pre-tanda4-20260914-185325.dump`,
esquema = baseline sin `_prisma_migrations`) con un clon limpio de `origin/main`: todos los
pasos de §6, §7, §10 y §11 dieron exit 0 y las salidas «esperadas» de este documento son
las reales de ese ensayo. Tras el ensayo, César publicó `b32601a` (Tanda 7b, 11:47), que
añade la migración `20260917100000_opera_modo_sombra` (5 tablas, 0 enums): la revisión
crítica del mismo día repitió, con un clon de `b32601a`, adopt → migrate → drift (vía B,
§6.5) y las cifras de este documento (11 migraciones encontradas, 10 aplicadas, 276 tablas,
32 enums, `validate-env` 126 variables) son las de esa repetición. Guía general: `deploy/README-INSTALL.md` (§4 adopción, §5
deploy, §6 smoke, §7 backup, §8 demo vs real, §9 checklist).

Reglas que este runbook no rompe:

- **Nunca** se sube al VPS público ningún dump del Mac (contienen el CIF real
  A33615980 de CELUISMA y costes de personal agregados). La BD pública se conserva y,
  si Faranda no existe, se siembra una Faranda **ficticia** (§8).
- **Nunca** `prisma db push` en la BD del VPS (`deploy/README-INSTALL.md` §11).
- **Nunca** `rbac:sync -- --prune`, `structure:migrate-faranda-celuisma`,
  `payroll:import-cost` ni `import:pms-history-forecast` en el VPS (datos reales).
- Las CLI de datos (§7) se ejecutan **con el API parado**: la cadena de auditoría
  mantiene su tip en memoria por instancia y dos escritores la bifurcan.

Convenciones: `[root]` = necesita `sudo` (si `anfitorio` no tiene sudo, ese comando se
ejecuta en otra terminal como `root`); `[Mac]` = se ejecuta en el Mac, no en el VPS.
Todo lo demás se ejecuta en el VPS como `anfitorio`, en el orden en que aparece.

---

## 0 · Qué va a pasar y cuánto tarda

| Fase | Qué cambia | Tiempo estimado | Demo pública |
| --- | --- | --- | --- |
| §1-§2 prerrequisitos + inventario | nada (solo lectura) | 10 min | arriba |
| §3 copia de seguridad (BD + config + dist) y copia al Mac | nada | 5-10 min | arriba |
| §4 `/etc/anfitorio/api.env` | fichero nuevo; el API viejo sigue con su `.env` | 10 min | arriba |
| §5 código | **API parado**, `git reset --hard origin/main`, `pnpm install`, `db:generate`, `validate-env` | 10-15 min (descarga de ~800 paquetes) | **caída** desde 5.0 |
| §6 esquema | `_prisma_migrations` + 10 migraciones aditivas (276 tablas / 32 enums) | 2 min (vía A) · 20-30 min (vía B) | caída |
| §7 CLI de datos | permisos, dataset demo, identidad, sociedades, plan de cuentas, backfills | 5-10 min | caída |
| §8 datos | solo lectura (la Faranda ficticia se crea en §11.5, con el API arriba) | 2 min | caída |
| §9 servicios | unidades systemd, Caddyfile, sudoers, `restart` | 5 min | **vuelve** en 9.6 |
| §10 front | build de admin-web + `rsync` a `/srv/anfitorio/admin-web` | 3-5 min | arriba (front viejo → nuevo) |
| §11 smoke + comprobaciones + Faranda ficticia | `smoke.sh`, navegador, `POST /admin/tenants` | 15 min | arriba |

Total ≈ **75-100 min** de reloj; el API público está caído entre 5.0 y 9.6 (≈ 25-45
min; Caddy responde 502 en `/api/*` y sigue sirviendo el front viejo). El ensayo local
tardó 16 min sin descargas. Reserva 2 h. Si algo falla, §12 (rollback) devuelve la
máquina al estado del backup de §3 en ≈ 10 min.

Lo que va a cambiar de comportamiento para quien use la demo:

- `GET https://demo.ehotelos.com/api/properties` sin token pasa de **200 a 401**: el modo
  demo sin token (`HOTELOS_ALLOW_DEMO_AUTH=true`, activo hoy) se retira; el front hace
  login con `reception@example.com` / `hotelos-demo` (ya funciona hoy).
- `/api/admin/tenants` pasa de **500 a 200** (verificado en el ensayo con el build nuevo).
- Aparecen Configuración › Estructura societaria, Recepción › Reservas › Importar,
  Finanzas (contabilidad PGC, nóminas › coste de personal), Rate Grid v2, etc.
- El JWT y la PII cifrada se conservan si se reutilizan `JWT_SECRET` y `ENCRYPTION_KEY`
  (§4); si la clave actual no es válida, se genera una nueva y se documenta.

---

## 1 · Prerrequisitos y cómo comprobarlos

### 1.1 Variables de esta sesión (pegar al principio de CADA sesión ssh)

```bash
export VPS_USER=anfitorio
export APP_DIR=/opt/anfitorio            # AJUSTAR tras §2: «raíz pnpm» del inventario SIN el /hotelos final
export APP="$APP_DIR/hotelos"            # raíz pnpm (donde está pnpm-workspace.yaml)
export ENVF=/etc/anfitorio/api.env
export WEB_ROOT=/srv/anfitorio/admin-web # AJUSTAR tras §2: «dist servido» del inventario
export BK=/var/backups/anfitorio
export STAMP=20260917
export DOMAIN=demo.ehotelos.com
mkdir -p ~/pre-$STAMP && chmod 700 ~/pre-$STAMP
```

### 1.2 Acceso, sudo y herramientas

```bash
whoami; id                                    # anfitorio
sudo -n true && echo "sudo sin contraseña OK" || echo "sudo pide contraseña o no existe: los [root] van en otra terminal como root"
node -v                                       # v22.x con x ≥ 9 (los db:* y las CLI usan node --env-file-if-exists, v22.9+); v24 también vale
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=9))?0:1)' && echo "node OK" || echo "node DEMASIADO VIEJO: instalar Node 22 LTS (NodeSource) antes de seguir"
corepack -v; COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm -v   # 9.15.0 (packageManager del repo; corepack lo descarga si falta)
command -v git curl pg_dump pg_restore psql rsync caddy openssl   # todos deben existir; si falta alguno: sudo apt-get install -y git curl postgresql-client rsync
df -h / | tail -1                             # ≥ 3 GB libres (pnpm store ≈ 1,2 GB + build)
free -h | awk '/Mem:/ {print $2" total, "$7" disponible"}'   # ≥ 2 GB disponibles para el build de Vite (si no, swap)
[[ -n "$(swapon --show --noheadings 2>/dev/null)" ]] && swapon --show || echo "sin swap (recomendado 4 GB: fallocate -l 4G /swapfile …)"   # swapon --show devuelve 0 aunque no haya swap
systemctl is-active anfitorio-api postgresql caddy           # active active active
```

Si `sudo -n true` falla pero `sudo` pide contraseña y la conoces, vale igual (los
comandos `[root]` la pedirán). Si `anfitorio` no tiene sudo, abre una segunda sesión
como `root` para los `[root]`.

### 1.3 Desde el Mac: acceso ssh/scp

```bash
# [Mac] comprobar que entras (hoy por contraseña; la clave del Mac no está autorizada)
ssh anfitorio@76.13.55.180 'hostname; whoami'
```

---

## 2 · Inventario de solo lectura (`vps-inventory.sh`) y qué anotar

El clon del VPS es de julio y **no tiene** `deploy/scripts/` (Tanda 4, 14-sep). El
script se toma de `origin/main` sin tocar el clon:

```bash
curl -fsSL https://raw.githubusercontent.com/cesareme/hotelos/main/hotelos/deploy/scripts/vps-inventory.sh -o ~/vps-inventory.sh
# alternativa sin salir del clon: git -C "$APP" fetch -q origin main && git -C "$APP" show origin/main:hotelos/deploy/scripts/vps-inventory.sh > ~/vps-inventory.sh
bash ~/vps-inventory.sh --app-dir "$APP_DIR" --domain "$DOMAIN" --env-file "$ENVF" --web-root "$WEB_ROOT" --user "$VPS_USER" 2>&1 | tee ~/pre-$STAMP/inventario.txt
```

Si imprime `raíz pnpm  NO ENCONTRADA`, localiza el clon y repite con `--app-dir`:

```bash
sudo find / -name pnpm-workspace.yaml -not -path '*/node_modules/*' 2>/dev/null
```

> Mientras `origin/main` no lleve los arreglos de `deploy/` de §15 (hoy `b32601a` **no** los
> lleva: siguen sin commitear en el Mac), el `vps-inventory.sh` descargado no imprime las filas
> `/etc/sudoers.d/anfitorio-deploy`, `/var/backups/anfitorio` (owner), `schema.prisma del clon`
> ni `node ≥ 22.9`, y en «tablas en public» dirá «esperado 251». Suple el punto 9 a mano:
> `sudo ls -l /etc/sudoers.d/anfitorio-deploy; ls -ld /var/backups/anfitorio` («No such file» en
> ambos = esperado; §9.3 los crea). Alternativa: copia el script parcheado desde el Mac
> (`scp ~/anfitorio-demo/hotelos/deploy/scripts/vps-inventory.sh anfitorio@76.13.55.180:~/`).

**Anotar (y pegar en §13):**

1. `raíz pnpm` (→ `APP`), `anidado (hotelos/hotelos)` (sí/no), `HEAD` (commit viejo, →
   `OLD_COMMIT` para el rollback), `rama`, `ficheros modificados` (si > 0, §5.2).
2. `systemctl cat anfitorio-api`: `User`, `WorkingDirectory`, `EnvironmentFile`,
   `ExecStart` (¿`node --import tsx`, `pnpm dev`, `dist/`?) y si existe `anfitorio-worker`.
3. `node`, `pnpm (corepack)`, `node ≥ 22.9`.
4. Entorno: `fichero` (ruta real del `.env` de hoy → `OLDENV` en §3), `NODE_ENV`,
   `HOTELOS_ALLOW_DEMO_AUTH` (hoy activo por HTTP), `JWT_SECRET` (chars), `ENCRYPTION_KEY`
   (base64→bytes: solo 32 sirve), `APP_BASE_URL`, `PILOT_PUBLIC_ORIGIN`, `variables totales`.
5. PostgreSQL: `tablas en public` (baseline = 251; julio ≈ 250), `enums` (11),
   `_prisma_migrations` (`NO EXISTE` o sus filas: si hay filas `2026-05…` o alguna con
   `finished=NULL`, adopt las borra como stale; si faltan tablas, vía B de §6),
   `tamaño BD`, `organizaciones / propiedades` (1/2 = sin Faranda; 2/3 = con Faranda),
   `usuarios / reservas / facturas`.
6. Caddy: líneas `handle_path /api/*`, `root *`, `reverse_proxy`; `dist servido` (→
   `WEB_ROOT`) y las dos filas de «URL horneada».
7. Red: `3000 solo en loopback` (sí), puertos, `sshd PasswordAuthentication`.
8. HTTP: `/api/properties sin token` (hoy 200 → tras §9 debe ser 401).
9. `/etc/sudoers.d/anfitorio-deploy` y `/var/backups/anfitorio` (hoy «no existe»: §9.4 los crea).

Ajusta ahora `APP_DIR`/`APP`/`WEB_ROOT` de §1.1 si difieren, y define:

```bash
export OLD_COMMIT=$(git -C "$APP" rev-parse HEAD); echo "$OLD_COMMIT" | tee ~/pre-$STAMP/OLD_COMMIT.txt
export OLDENV=$(ls "$ENVF" "$APP/.env" "$APP/apps/api/.env" 2>/dev/null | head -1); echo "OLDENV=$OLDENV"   # el fichero «fichero» del inventario
```

---

## 3 · Copia de seguridad completa

### 3.1 Base de datos → `/var/backups/anfitorio` (y comprobación del dump)

```bash
sudo mkdir -p "$BK" && sudo chown "$VPS_USER:$VPS_USER" "$BK" && sudo chmod 750 "$BK"    # [root]
DBURL=$(grep -E '^[[:space:]]*DATABASE_URL=' "$OLDENV" | tail -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//")
printf '%s\n' "$DBURL" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'      # comprobar host/BD sin mostrar la contraseña
pg_dump --dbname="$DBURL" -Fc -f "$BK/anfitorio-pre-actualizacion-$STAMP.pgcustom"
ls -la "$BK"
pg_restore -l "$BK/anfitorio-pre-actualizacion-$STAMP.pgcustom" | grep -c 'TABLE DATA'     # nº de tablas con datos (≈ 250)
pg_restore -l "$BK/anfitorio-pre-actualizacion-$STAMP.pgcustom" | grep -c '_prisma_migrations' # 0 si la BD nació con db push
```

Esperado: `pg_dump` sin salida (exit 0) y un fichero de ~1 MB (el ensayo: 951.665 B con
251 tablas y 12.652 filas). Si `pg_dump` falla por versión («server version mismatch»),
instala `postgresql-client-16`.

### 3.2 Configuración y dist actuales → `~/pre-20260917/` y tarball en `/var/backups/anfitorio`

```bash
systemctl cat anfitorio-api    > ~/pre-$STAMP/anfitorio-api.service.pre 2>/dev/null
systemctl cat anfitorio-worker > ~/pre-$STAMP/anfitorio-worker.service.pre 2>/dev/null || true
sudo cp /etc/caddy/Caddyfile ~/pre-$STAMP/Caddyfile.pre && sudo chown "$VPS_USER" ~/pre-$STAMP/Caddyfile.pre   # [root]
cp "$OLDENV" ~/pre-$STAMP/env.pre && chmod 600 ~/pre-$STAMP/env.pre
git -C "$APP" status --porcelain > ~/pre-$STAMP/git-status.pre; git -C "$APP" diff > ~/pre-$STAMP/git-diff.pre
sudo tar czf "$BK/admin-web-dist-pre-$STAMP.tgz" -C "$(dirname "$WEB_ROOT")" "$(basename "$WEB_ROOT")"   # [root] dist servido
tar czf "$BK/anfitorio-config-pre-$STAMP.tgz" -C "$HOME" "pre-$STAMP"
ls -la "$BK"
```

### 3.3 Copia al Mac (desde el Mac)

```bash
# [Mac]
export STAMP=20260917; mkdir -p ~/anfitorio-demo/backups/vps-$STAMP
scp "anfitorio@76.13.55.180:/var/backups/anfitorio/anfitorio-pre-actualizacion-$STAMP.pgcustom" \
    "anfitorio@76.13.55.180:/var/backups/anfitorio/anfitorio-config-pre-$STAMP.tgz" \
    "anfitorio@76.13.55.180:/var/backups/anfitorio/admin-web-dist-pre-$STAMP.tgz" ~/anfitorio-demo/backups/vps-$STAMP/
ls -la ~/anfitorio-demo/backups/vps-$STAMP/
pg_restore -l ~/anfitorio-demo/backups/vps-$STAMP/anfitorio-pre-actualizacion-$STAMP.pgcustom | head -20   # el dump se lee en el Mac
```

`backups/` está en el `.gitignore` de la raíz: no entra en git. **No sigas sin esta copia
en el Mac.**

---

## 4 · Entorno: `/etc/anfitorio/api.env`

### 4.1 Qué cambia respecto al `.env` de julio

El `.env` del VPS (36 claves del `.env.example` de julio) se convierte en
`/etc/anfitorio/api.env` (rol `production-native`, `deploy/README-INSTALL.md` §2). El
generador de 4.2 hace esto, sin imprimir valores:

| Grupo | Claves | Qué se hace |
| --- | --- | --- |
| **Se reutilizan** | `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (si ≥ 32 chars y no `change-me`), `ENCRYPTION_KEY` (**solo** si base64 decodifica a 32 bytes) | copiadas tal cual. Cambiar `JWT_SECRET` cierra todas las sesiones; cambiar `ENCRYPTION_KEY` deja ilegible la PII cifrada con la anterior (el ensayo, con clave nueva, arrancó y pasó el smoke con 2 avisos `[crypto-fields] Guest.email could not be decrypted`: no rompe nada, el campo se devuelve `null`). El placeholder de julio `change-me-32-bytes` NO es válido (13 bytes): se genera una nueva. |
| **Nuevas obligatorias (production-native)** | `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`, `TRUST_PROXY=1`, `RUN_SCHEDULERS=true`, `RBAC_STRICT=true`, `APP_BASE_URL=https://demo.ehotelos.com`, `API_PUBLIC_URL=https://demo.ehotelos.com/api`, `VITE_API_URL=https://demo.ehotelos.com/api`, `CORS_ALLOWED_ORIGINS=https://demo.ehotelos.com` | valores fijos. Sin `APP_BASE_URL` y sin `ENCRYPTION_KEY` válida el API **no arranca** en producción (`apps/api/src/lib/env.ts`, `assertEnv`). |
| **Nuevas de política** | `HOTELOS_ALLOW_DEMO_AUTH=false`, `AUTH_EXPOSE_RESET_TOKEN=false`, `ADMIN_EXPOSE_TEMP_PASSWORD=false`, `STRUCTURE_ENABLED=true`, `VERIFACTU_MODE=sandbox`, `SES_HOSPEDAJES_MODE=sandbox`, `TBAI_MODE=sandbox`, `IGIC_MODE=sandbox` | `HOTELOS_ALLOW_DEMO_AUTH=true` con `NODE_ENV=production` **impide arrancar** salvo `HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true` (y entonces `smoke.sh` falla en el 401 por diseño). Recomendación: fuera (§14). |
| **SIF VeriFactu (pin hasta la nueva declaración responsable, D4)** | `VERIFACTU_SYSTEM_NAME=Anfitorio`, `VERIFACTU_SYSTEM_VERSION=0.1.0` (añadir si faltan) | nombre y versión que constan en la declaración responsable vigente, los mismos que llevan `software_json`/`xml_payload` de los registros ya remitidos; sin ellos, los valores por defecto nuevos del código (`ehotelOS` / `1.0.0`, `software.ts` y `env.ts`) entrarían en `NombreSistemaInformatico`/`Version` sin declaración firmada. Se retiran juntos tras la firma, con la cola drenada (`deploy/README-INSTALL.md` §9 paso 4; `docs/compliance/verifactu-declaracion-responsable.md` §4.7.5). |
| **Smoke** | `SMOKE_EMAIL=reception@example.com`, `SMOKE_PASSWORD=hotelos-demo`, `SMOKE_PROPERTY_ID=prop_123` | las lee `deploy.sh`; `validate-env` avisa «no está en el contrato» (3 avisos, no error). |
| **Se conservan si tenían valor real** | `SENTRY_DSN`, `VITE_SENTRY_DSN`, `AI_PROVIDER`, `AI_PROVIDER_API_KEY`, `OCR_PROVIDER_API_KEY`, `SPEECH_PROVIDER_API_KEY`, `EMAIL_PROVIDER`, `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, `SES_HOSPEDAJES_CLIENT_ID/SECRET`, `VERIFACTU_CERT_PATH/PASSPHRASE`, `VERIFACTU_SOFTWARE_NIF`, `VERIFACTU_INSTALL_NUMBER` | los `change-me` se descartan (validate-env los ignora igualmente). |
| **Retiradas (no se copian)** | `OBJECT_STORAGE_BUCKET/REGION/ACCESS_KEY/SECRET_KEY`, `PAYMENT_PROVIDER_SECRET`, `APP_PUBLIC_API_URL` (→ `API_PUBLIC_URL`/`VITE_API_URL`), `PILOT_PUBLIC_ORIGIN` (→ `CORS_ALLOWED_ORIGINS`), `WHATSAPP_PROVIDER_TOKEN` (→ `WHATSAPP_TOKEN`), `BOOTSTRAP_TOKEN` (demo: vacío) | ningún código las lee ya (aviso «retirada en la Tanda 4»). |

Sin `EMAIL_PROVIDER/EMAIL_PROVIDER_KEY/EMAIL_FROM` las invitaciones quedan en modo
`disabled`: el enlace de invitación se devuelve en la respuesta del API y se entrega a
mano (así se crea Carmen en §11.5).

### 4.2 Generar el fichero (no imprime secretos)

```bash
cat > ~/make-api-env.sh <<'EOF'
#!/usr/bin/env bash
# Genera /etc/anfitorio/api.env (rol production-native) a partir del .env actual del VPS. No imprime valores.
set -euo pipefail
OLD="$1"; NEW="$2"; OWNER="${3:-anfitorio}"
# get KEY → valor de la última línea KEY= del .env viejo (vacío si no existe; nunca falla, set -e sigue activo)
get() { { grep -E "^[[:space:]]*$1=" "$OLD" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"; }
is_placeholder() { case "$1" in ""|change-me*|changeme*|todo|placeholder|your-key-here) return 0;; *) return 1;; esac; }
DB=$(get DATABASE_URL); JWT=$(get JWT_SECRET); ENC=$(get ENCRYPTION_KEY); REDIS=$(get REDIS_URL)
[[ -n "$DB" ]] || { echo "DATABASE_URL ausente en $OLD"; exit 1; }
case "$DB$JWT$ENC$REDIS" in *"'"*) echo "algún valor contiene una comilla simple: edita el fichero a mano"; exit 1;; esac
if [[ ${#JWT} -lt 32 ]] || is_placeholder "$JWT"; then echo "JWT_SECRET ausente/débil (${#JWT} chars): se GENERA uno nuevo (cierra las sesiones)"; JWT=$(openssl rand -base64 48 | tr -d '\n'); else echo "JWT_SECRET reutilizado (${#JWT} chars)"; fi
bytes=$( { printf '%s' "$ENC" | base64 -d 2>/dev/null || true; } | wc -c | tr -d ' ')   # base64 -d devuelve 1 con un placeholder: no debe abortar
if [[ "${bytes:-0}" != "32" ]]; then echo "ENCRYPTION_KEY ausente/inválida (base64 -> ${bytes:-0} bytes, no 32): se GENERA una nueva (la PII cifrada con la anterior, si la hubo, queda ilegible)"; ENC=$(openssl rand -base64 32 | tr -d '\n'); else echo "ENCRYPTION_KEY reutilizada (32 bytes)"; fi
umask 077
{
  printf '# %s · generado el %s desde %s · rol production-native (deploy/README-INSTALL.md §2)\n' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OLD"
  printf '%s\n' "NODE_ENV=production" "HOST=127.0.0.1" "PORT=3000" "TRUST_PROXY=1" "RUN_SCHEDULERS=true" "RBAC_STRICT=true" "STRUCTURE_ENABLED=true"
  printf "DATABASE_URL='%s'\n" "$DB"
  [[ -n "$REDIS" ]] && printf "REDIS_URL='%s'\n" "$REDIS"
  printf "JWT_SECRET='%s'\nENCRYPTION_KEY='%s'\n" "$JWT" "$ENC"
  printf '%s\n' "APP_BASE_URL=https://demo.ehotelos.com" "API_PUBLIC_URL=https://demo.ehotelos.com/api" "VITE_API_URL=https://demo.ehotelos.com/api" "CORS_ALLOWED_ORIGINS=https://demo.ehotelos.com"
  printf '%s\n' "HOTELOS_ALLOW_DEMO_AUTH=false" "AUTH_EXPOSE_RESET_TOKEN=false" "ADMIN_EXPOSE_TEMP_PASSWORD=false"
  printf '%s\n' "VERIFACTU_MODE=sandbox" "SES_HOSPEDAJES_MODE=sandbox" "TBAI_MODE=sandbox" "IGIC_MODE=sandbox"
  printf '%s\n' "VERIFACTU_SYSTEM_NAME=Anfitorio" "VERIFACTU_SYSTEM_VERSION=0.1.0"   # pin del SIF hasta la nueva declaración responsable (D4)
  printf '%s\n' "SMOKE_EMAIL=reception@example.com" "SMOKE_PASSWORD=hotelos-demo" "SMOKE_PROPERTY_ID=prop_123"
  for k in SENTRY_DSN VITE_SENTRY_DSN AI_PROVIDER AI_PROVIDER_API_KEY OCR_PROVIDER_API_KEY SPEECH_PROVIDER_API_KEY EMAIL_PROVIDER EMAIL_PROVIDER_KEY EMAIL_FROM SES_HOSPEDAJES_CLIENT_ID SES_HOSPEDAJES_CLIENT_SECRET VERIFACTU_CERT_PATH VERIFACTU_CERT_PASSPHRASE VERIFACTU_SOFTWARE_NIF VERIFACTU_INSTALL_NUMBER; do
    v=$(get "$k"); is_placeholder "$v" && continue; case "$v" in *"'"*) echo "  OMITIDA $k: contiene una comilla simple, añádela a mano" >&2; continue;; esac; printf "%s='%s'\n" "$k" "$v"; echo "  conservada: $k" >&2
  done
} > "$NEW.tmp"
chown "root:$OWNER" "$NEW.tmp"; chmod 640 "$NEW.tmp"; mv "$NEW.tmp" "$NEW"
echo "escrito $NEW ($(grep -cE '^[A-Z_]+=' "$NEW") claves, root:$OWNER 640)"
EOF
sudo mkdir -p /etc/anfitorio                                       # [root]
sudo bash ~/make-api-env.sh "$OLDENV" "$ENVF" "$VPS_USER"          # [root]
sudo ls -la "$ENVF"; grep -E '^[A-Z_]+=' "$ENVF" | cut -d= -f1 | tr '\n' ' '   # solo nombres (anfitorio puede leerlo por el grupo)
```

Esperado: `JWT_SECRET reutilizado (N chars)`, `ENCRYPTION_KEY reutilizada (32 bytes)` (o
`se GENERA` con su motivo: anótalo para §13), líneas `conservada: <clave>` por cada
opcional con valor real, y `escrito /etc/anfitorio/api.env (24-30 claves, root:anfitorio
640)`. Probado en el Mac con un `.env` falso de julio (26 claves, `validate-env` OK) y
con uno mínimo (24 claves). Si quieres mantener el modo demo sin token (no
recomendado), añade a mano `HOTELOS_ALLOW_DEMO_AUTH=true` y
`HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true` y asume que el smoke fallará en la
comprobación 2.

La validación (`validate-env`) se hace en §5.6, porque `scripts/validate-env.mjs` llega
con el código nuevo.

---

## 5 · Código: parar el API, `git reset` a `origin/main`, `install`, `generate`, `validate-env`

### 5.0 Parar el API (empieza la ventana de caída)

```bash
sudo systemctl stop anfitorio-api; sudo systemctl stop anfitorio-worker 2>/dev/null || true     # [root]
systemctl is-active anfitorio-api                                            # inactive
curl -s -o /dev/null -w '%{http_code}\n' https://demo.ehotelos.com/api/health  # 502 (Caddy sin backend): esperado
```

Si el API viejo no corre bajo `anfitorio-api` (inventario §2.2: tmux, `pnpm dev`, otro
nombre de unidad), párale como corresponda (`tmux kill-session`, `systemctl stop <unidad>`)
y comprueba `pgrep -af 'node|tsx' ` vacío.

### 5.1 Commit objetivo

`origin/main` es hoy `b32601a` (17-sep-2026 11:47, «feat(pms): Tanda 7b · OPERA Cloud en
modo sombra»); el mínimo aceptable es `cc4981007b886756d43ed0488c23f766aed80071`. Si antes
de ejecutar esto César commitea el `pnpm-lock.yaml` local y los arreglos de `deploy/` de
este runbook (§14 y §15), el objetivo es ese commit posterior; el procedimiento no cambia.
Las cifras esperadas de §6 (11 migraciones encontradas, 10 aplicadas, 276 tablas) son las
de `b32601a`: un commit posterior con más migraciones las sube (compáralas con
`ls packages/database/prisma/migrations | grep -c '^[0-9]'` y con `grep -cE '^model ' packages/database/prisma/schema.prisma`).

### 5.2 Estado del clon y reset

```bash
cd "$APP"
git status --porcelain --untracked-files=no | tee ~/pre-$STAMP/git-status-tracked.txt   # vacío = limpio
# si NO está vacío: los cambios ya están guardados en ~/pre-$STAMP/git-diff.pre (§3.2); el reset los descarta a propósito
git fetch origin main
git checkout -q main 2>/dev/null || git checkout -q -B main origin/main
git reset --hard origin/main
git log -1 --format='%H %ci %s' | tee ~/pre-$STAMP/NEW_COMMIT.txt
grep -c -- '--prod=false' deploy/scripts/deploy.sh    # ≥ 1 (5 en el working tree del Mac) = origin/main ya lleva los arreglos de deploy/ de este runbook; 0 = b32601a tal cual (el procedimiento manual de abajo no depende de ello)
```

### 5.3 `hotelos/.env` fuera del clon

En un servidor con systemd la configuración vive solo en `api.env`; los cargadores del API,
del worker y los CLI (`node --env-file-if-exists=../../.env`) leerían ese `.env` para
cualquier clave ausente (`deploy/README-INSTALL.md` §2).

```bash
[[ -f "$APP/.env" ]] && mv "$APP/.env" ~/pre-$STAMP/hotelos.env && chmod 600 ~/pre-$STAMP/hotelos.env && echo "movido a ~/pre-$STAMP/hotelos.env"
[[ -f "$APP/apps/api/.env" ]] && mv "$APP/apps/api/.env" ~/pre-$STAMP/apps-api.env && chmod 600 ~/pre-$STAMP/apps-api.env
ls -la "$APP/.env" "$APP/apps/api/.env" 2>&1 | grep -c 'No such' # 2
```

### 5.4 Dependencias (`--prod=false` obligatorio; `NODE_ENV` sin exportar)

**Por qué:** con `NODE_ENV=production` exportado, pnpm 9.15.0 instala solo `dependencies`
(734 paquetes, sin `tsx`, `prisma`, `vite` ni `tsc`) y sobre un `node_modules` existente
las **borra**; con `--prod=false` instala los 806 (ensayo 2026-09-17). El runtime es
`node --import tsx` y `prisma` es devDependency: sin ellos nada arranca. El `rm -rf`
previo evita el prompt interactivo «The modules directories will be removed and
reinstalled from scratch. Proceed?» que pnpm lanza cuando el `node_modules` viejo se
instaló con otro modo/lockfile.

```bash
cd "$APP"
rm -rf node_modules apps/*/node_modules packages/*/node_modules
env -u NODE_ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --prod=false 2>&1 | tail -15
```

Esperado (lockfile al día): `Packages: +806 … Done in Ns` (la primera vez descarga
del registro: 2-10 min). Aviso ignorable: peer dep `expo-font` en `apps/mobile`.

**Si falla con `ERR_PNPM_OUTDATED_LOCKFILE` («pnpm-lock.yaml is not up to date with
apps/admin-web/package.json»)**: el lockfile de `origin/main` no cubre
`@fontsource-variable/inter`, `zod`, `@playwright/test` (admin-web) y `qrcode-terminal`
(api). Es la situación de `b32601a` hoy (CI en rojo por lo mismo). Dos salidas (§14,
decisión 1):

```bash
# (A) recomendada: César commitea y pushea el pnpm-lock.yaml regenerado del Mac (+52 líneas, verificado con --frozen-lockfile) y repites 5.2 + 5.4.
# (B) rodeo en el VPS: instalar sin congelar y NO dejar el lockfile reescrito en el árbol (deploy.sh --pull se negaría a continuar)
env -u NODE_ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --no-frozen-lockfile --prod=false 2>&1 | tail -15
git checkout -- pnpm-lock.yaml && git status --porcelain --untracked-files=no   # vacío
```

Comprobación en ambos casos:

```bash
ls -d apps/api/node_modules/tsx packages/database/node_modules/prisma apps/admin-web/node_modules/vite && echo "tsx/prisma/vite OK"
ls node_modules/.pnpm | wc -l      # ≈ 800-815 (813 en el clon del ensayo con b32601a; pnpm anunció 806 paquetes)
```

### 5.5 Cliente Prisma

```bash
corepack pnpm --filter @hotelos/database db:generate 2>&1 | grep -E 'Generated|Error'
```

Esperado: `✔ Generated Prisma Client (v6.19.3) to ./node_modules/.pnpm/…` (aviso
`package.json#prisma` deprecado: ignorable).

### 5.6 Validar `api.env`

```bash
node scripts/validate-env.mjs "$ENVF" --role production-native; echo "exit=$?"
```

Esperado: `Contrato de entorno OK: /etc/anfitorio/api.env (rol production-native) · 126
variables comprobadas · N aviso(s).` y `exit=0` (126 con `b32601a`; era 122 con `cc49810`). Avisos normales: `EMAIL_*` ausentes,
`SENTRY_DSN vacío`, `APPLE_WALLET_TEAM_ID … HOTELOSDEV`, `SMOKE_EMAIL/PASSWORD/PROPERTY_ID
no está en el contrato`. Cualquier línea `ERROR` (p. ej. `ENCRYPTION_KEY` no base64 de 32
bytes, `APP_BASE_URL` sin https, `HOTELOS_ALLOW_DEMO_AUTH=true` sin override) → corrige
`api.env` (`sudo nano "$ENVF"`) y repite. No sigas con exit ≠ 0: el API no arrancaría.

---

## 6 · Esquema: `adopt-baseline` → `migrate deploy` → `drift check`

### 6.0 Exportar `api.env` en la shell (gana sobre cualquier `.env`; a partir de aquí NO ejecutes `pnpm install` sin `--prod=false`)

```bash
set -a; . "$ENVF"; set +a
echo "$NODE_ENV $DATABASE_URL" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'     # production postgresql://…***@…
cd "$APP"
```

### 6.1 Plan de adopción (no escribe)

```bash
corepack pnpm --filter @hotelos/database db:adopt-baseline 2>&1 | tee ~/pre-$STAMP/adopt-plan.txt
```

Reconocer el caso por la línea `estado:`:

**Caso A · `estado: needs-adoption`** (BD nacida con `db push`, esquema = baseline; el
caso del ensayo). Salida esperada:

```
adopt-baseline · localhost:5432/<bd> · DRY-RUN (sin escribir; usa --apply)
  baseline local: 20260914000000_baseline_squash (251 tablas, checksum 0514c92b6404…)
  BD: 251 tablas, 2866 columnas, 11 enums, _prisma_migrations ausente
  estado: needs-adoption
  - Crear la tabla "_prisma_migrations".
  - Insertar 20260914000000_baseline_squash como aplicada (checksum 0514c92b6404…).
  migraciones posteriores a la baseline que aplicará `migrate deploy`: 20260914213000_rate_grid_v2, 20260915100000_rate_grid_v2_journal_unique, 20260915120000_modules_spanish_names, 20260915140000_finanzas_contabilidad_pgc, 20260916100000_estructura_societaria, 20260916101000_estructura_societaria_harden, 20260916102000_estructura_societaria_property_immutable, 20260916120000_coste_personal_importado, 20260916130000_reservas_importacion, 20260917100000_opera_modo_sombra
  siguiente paso: pnpm --filter @hotelos/database db:migrate:deploy && pnpm db:drift:check
```

Puede añadir `- Borrar fila 2026…_initial [id]` (filas de las migraciones antiguas de
mayo, o una fila fallida `baseline_missing_tables`): también es caso A, las borra con
`--apply`. → sigue en 6.2.

**Caso C · `estado: adopted`** («La baseline ya está registrada como aplicada; nada que
hacer.»): alguien ya adoptó. → 6.2 es un no-op; sigue igual.

**Caso B · exit 1 con `La BD no contiene todo lo que crea la baseline (faltan N tabla(s):
user_invitations…; M columna(s): …)`** (`estado: schema-mismatch`): el esquema del VPS es
**anterior** a la baseline (el front es ≤ `dd2124c` de julio, 250 modelos: como mínimo le
falta `user_invitations` y probablemente columnas de las Tandas 2-3). No escribe nada.
**No se hace `db push`.** La salida es solo esa línea de error (sin línea `estado:`); un
`db:migrate:deploy` directo sobre esa BD daría `Error: P3005` (BD no vacía sin historial:
reproducido en local el 17-sep). → salta a 6.5 (vía B), que repite 6.1-6.4 sobre la BD nueva, y
sigue en §7.

`sh: pnpm: command not found` → estás usando el alias raíz; usa exactamente el comando
de arriba (`--filter @hotelos/database`).

### 6.2 Aplicar la adopción (caso A/C)

```bash
corepack pnpm --filter @hotelos/database db:adopt-baseline -- --apply 2>&1 | tee ~/pre-$STAMP/adopt-apply.txt
psql "$DATABASE_URL" -XtA -c "select migration_name, applied_steps_count, finished_at is not null from _prisma_migrations order by started_at"
```

Esperado: misma salida con `· APLICADO`, y la consulta devuelve
`20260914000000_baseline_squash|0|t` (1 fila). Idempotente: repetirlo da `estado: adopted`.

### 6.3 Migraciones posteriores

```bash
corepack pnpm --filter @hotelos/database db:migrate:deploy 2>&1 | tee ~/pre-$STAMP/migrate-deploy.txt | grep -vE '^\s*$|Update available|major update|pris.ly|npm i|└|┌|│|─'
```

Esperado:

```
11 migrations found in prisma/migrations
Applying migration `20260914213000_rate_grid_v2`
… (10 líneas Applying, hasta 20260917100000_opera_modo_sombra)
All migrations have been successfully applied.
```

(2 s en el ensayo). Si `20260915100000_rate_grid_v2_journal_unique` fallara con
`duplicate key … rate_change_journals_propertyId_client_request_id_key`: la migración ya
desengancha duplicados por `(propertyId, client_request_id)`; un fallo aquí significa
otro estado. Guarda la salida, marca la fila fallida con
`corepack pnpm --filter @hotelos/database exec prisma migrate resolve --rolled-back 20260915100000_rate_grid_v2_journal_unique`,
manda la salida en §13 y no sigas.

### 6.4 Drift = 0 y recuento

```bash
corepack pnpm --filter @hotelos/database db:drift:check > ~/pre-$STAMP/drift-check.txt 2>&1; echo "exit=$?"; tail -2 ~/pre-$STAMP/drift-check.txt   # el exit se lee ANTES del tail: tras un pipeline $? sería el de tail
psql "$DATABASE_URL" -XtA \
  -c "select count(*) as tablas from pg_tables where schemaname='public' and tablename<>'_prisma_migrations'" \
  -c "select count(*) as enums from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype='e' and n.nspname='public'" \
  -c "select count(*) as migraciones_ok from _prisma_migrations where finished_at is not null and rolled_back_at is null" \
  -c "select id, name, legal_name, tax_id from organizations order by created_at"
```

Esperado: `No difference detected.` · `exit=0` · `276` · `32` · `11` · la lista de
organizaciones (org_123 «Grupo Hotelero Demo» B12345678 y, si existe, Faranda
`cmrhw9jy30002fyvb6tsdiugt`). Drift ≠ 0 → **para**, pega la salida en §13 (no se toca
nada más; el backup de §3 sigue siendo válido).

### 6.5 Vía B (solo caso B: esquema anterior a la baseline) — ensayada en local el 17-sep con un dump simulado

Estrategia (`deploy/README-INSTALL.md` §4.5, corregida el 17-sep): BD **nueva** con **solo
la baseline** (el SQL de `20260914000000_baseline_squash` por `psql`), volcado de **solo
datos** del dump de §3 y, a partir de ahí, **el mismo camino que la vía A** (adopt →
`migrate deploy` → drift), de modo que las 10 migraciones posteriores se ejecutan sobre los
datos ya restaurados **con sus sentencias `UPDATE`** (nombres de módulos en español, PGC,
`rate_change_journals`, prefijos de series). **No** hagas `migrate deploy` sobre la BD
vacía antes de volcar los datos: esas 4 migraciones con `UPDATE` correrían sobre tablas
vacías y sus cambios de datos se perderían. La BD vieja no se toca (es el rollback).
Requiere `sudo -u postgres` (Postgres local en el VPS; `--disable-triggers` exige
superusuario).

Ensayo local (17-sep, clon `b32601a`): dump de la BD `pre-tanda4` sin `user_invitations` ni
`properties.ine_municipality_code` (adopt sobre esa BD → `faltan 1 tabla(s):
user_invitations; 1 columna(s): properties.ine_municipality_code`, exit 1; `migrate
deploy` directo → `Error: P3005`) → esta vía: `pg_restore` 0 errores, adopt
`needs-adoption`, 11 migraciones encontradas / 10 aplicadas, drift 0, 276 tablas, 32
enums, recuentos idénticos en 15 tablas (7 orgs, 90 reservas, 1482 `role_permissions`),
`modules.pms_core` = «Núcleo PMS».

```bash
# B.1 BD nueva vacía, mismo rol que la actual
NEWDB=anfitorio_v2
DBUSER=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:/@]+).*#\1#')
NEWURL=$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$NEWDB\1#")
sudo -u postgres createdb -O "$DBUSER" "$NEWDB"                                          # [root]
# B.2 SOLO la baseline (251 tablas, 11 enums), como el rol de la aplicación (dueño de las tablas)
psql "$NEWURL" -Xq -v ON_ERROR_STOP=1 -f packages/database/prisma/migrations/20260914000000_baseline_squash/migration.sql; echo "exit=$?"   # 0 (un NOTICE «schema public already exists» es normal)
psql "$NEWURL" -XtA -c "select count(*) from pg_tables where schemaname='public'"      # 251
# B.3 solo datos del dump (sin _prisma_migrations; triggers/FK desactivados: exige superusuario)
DUMP="$BK/anfitorio-pre-actualizacion-$STAMP.pgcustom"
pg_restore -l "$DUMP" | grep -v '_prisma_migrations' > /tmp/restore.list
sudo cp "$DUMP" /tmp/anf-pre.pgcustom && sudo chmod 644 /tmp/anf-pre.pgcustom /tmp/restore.list   # [root]
sudo -u postgres pg_restore --data-only --disable-triggers --no-owner --no-privileges -L /tmp/restore.list -d "$NEWDB" /tmp/anf-pre.pgcustom > ~/pre-$STAMP/restore-v2.log 2>&1; echo "exit=$?"   # [root]
sudo rm -f /tmp/anf-pre.pgcustom
grep -ciE 'error' ~/pre-$STAMP/restore-v2.log       # 0 ideal; cada ERROR es una tabla NO cargada (columna inexistente, valor de enum, unique)
grep -iE 'error' ~/pre-$STAMP/restore-v2.log | head -20
# B.4 adopt → migrate deploy (10, con sus UPDATE) → drift 0, todo contra la BD nueva
DATABASE_URL="$NEWURL" corepack pnpm --filter @hotelos/database db:adopt-baseline 2>&1 | tee ~/pre-$STAMP/adopt-plan-v2.txt | grep -E 'estado:|BD:|faltan'   # estado: needs-adoption · BD: 251 tablas … _prisma_migrations ausente
DATABASE_URL="$NEWURL" corepack pnpm --filter @hotelos/database db:adopt-baseline -- --apply 2>&1 | tee ~/pre-$STAMP/adopt-apply-v2.txt | grep -E 'APLICADO|estado:'
DATABASE_URL="$NEWURL" corepack pnpm --filter @hotelos/database db:migrate:deploy 2>&1 | tee ~/pre-$STAMP/migrate-deploy-v2.txt | grep -E 'migrations found|Applying|successfully|Error'   # 11 found · 10 Applying · successfully
DATABASE_URL="$NEWURL" corepack pnpm --filter @hotelos/database db:drift:check > ~/pre-$STAMP/drift-check-v2.txt 2>&1; echo "exit=$?"; tail -1 ~/pre-$STAMP/drift-check-v2.txt   # exit=0 · No difference detected.
psql "$NEWURL" -XtA -c "select count(*) from pg_tables where schemaname='public' and tablename<>'_prisma_migrations'" -c "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null" -c "select name from modules where code='pms_core'"   # 276 · 11 · Núcleo PMS
# B.5 recuentos vieja vs nueva
for t in organizations properties users roles role_permissions permissions rooms room_types reservations guests folios invoices audit_events event_stream sessions; do printf '%-18s vieja=%-7s nueva=%s\n' "$t" "$(psql "$DATABASE_URL" -XtA -c "select count(*) from $t" 2>/dev/null)" "$(psql "$NEWURL" -XtA -c "select count(*) from $t" 2>/dev/null)"; done | tee ~/pre-$STAMP/recuentos-v2.txt
```

Si los recuentos coinciden (salvo tablas que no existían en la vieja) y el log no tiene
errores relevantes, apunta el API a la BD nueva y sigue en §7 con ella (el `sed` cambia
solo el nombre de la BD al final de la URL; no toca usuario ni contraseña, que podrían
contener `&` o `#`):

```bash
sudo sed -i -E "s#^(DATABASE_URL=.*/)[^/?']+#\1$NEWDB#" "$ENVF"    # [root]
set -a; . "$ENVF"; set +a; echo "$DATABASE_URL" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'   # …/anfitorio_v2
```

Si hay errores: `sudo -u postgres dropdb anfitorio_v2`, pega el log en §13 y para. La
BD vieja sigue intacta; el API viejo se puede rearrancar (§12 sin restaurar el dump).

---

## 7 · CLI posteriores a las tandas (dry-run → apply), con el API parado

Orden **validado en el ensayo** (ronda 2, todo exit 0 e idempotente). El orden del
informe `docs/audits/DEMO-DATASET-2026-09-14.md` §5 y del runbook de finanzas §17.9
(backfill de estructura antes de `demo:refresh`) **rompe** la demo: `refresh-demo-dataset`
no conoce `legal_entities` (borra las orgs AUDIT, deja 5 sociedades huérfanas y sale con
exit 1 «Filas residuales de orgs AUDIT: legal_entities=5») y `fix-demo-legal-identity`
no corrige `legal_entities` (la sociedad de Faranda quedaría «AUDIT-T1 SL» con NIF nulo).
Los tres documentos quedan anotados con este orden.

Todos desde `$APP` con `api.env` exportado (6.0). Guarda cada salida con `| tee`.

```bash
# (si es una sesión ssh nueva: repite §1.1 y luego: set -a; . "$ENVF"; set +a)
cd "$APP"; export FARANDA=cmrhw9jy30002fyvb6tsdiugt
psql "$DATABASE_URL" -XtA -c "select count(*) from organizations where id='$FARANDA'"     # 1 = Faranda existe · 0 = no existe (afecta a 7.3 y 7.5)
psql "$DATABASE_URL" -XtA -c "select count(*) from organizations where name like 'AUDIT%'"  # nº de orgs AUDIT que borrará demo:refresh (0 en el VPS es normal)
```

### 7.1 `rbac:sync --dry-run` (informe; el arranque del API aplica lo mismo)

```bash
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run 2>&1 | tee ~/pre-$STAMP/cli-rbac-dry.txt | grep -E 'catalog:|permissions:|stale keys|template roles:|platform roles:'
```

Esperado (ensayo): `catalog: 223 keys (222 org + 1 platform)` · `permissions: +N created ·
0 descriptions updated · 4 stale` (`pms.reservation.cancel/check_in/check_out/update`,
conservadas: solo `--prune` las borraría y **no se ejecuta**) · `Local Super Admin (org_123)
← full catalog: +N`. En el VPS (catálogo de julio) `+N` será mayor que los 11 del ensayo.
No escribe.

### 7.2 `demo:refresh` (residuos AUDIT, reservas vencidas, BAR/snapshots)

```bash
corepack pnpm --filter @hotelos/api demo:refresh -- --scope all 2>&1 | tee ~/pre-$STAMP/cli-refresh-dry.txt | grep -E 'DRY-RUN|Fase A|KEEP|Nada escrito|ERROR'
corepack pnpm --filter @hotelos/api demo:refresh -- --scope all --apply 2>&1 | tee ~/pre-$STAMP/cli-refresh-apply.txt | tail -8
```

Esperado (ensayo): dry-run `[demo:refresh] DRY-RUN (no writes) · scope all …`, `Fase A ·
orgs AUDIT: 5` (VPS: probablemente 0), `Nada escrito.`; apply exit 0 con `Aplicado: …`,
`fechas 15 · habitaciones 1 · folios 2 · reseeds rates:prop_123, snapshots:org_123` y
`Reinicia el API: los espejos in-memory de tenants solo se recargan al arrancar.` Un
`Residuo orgs AUDIT (tras borrar): audit_events=… · event_stream=…` es normal (cadenas
hash protegidas). Si Faranda no existe, la fase B queda vacía. En el VPS las 100
reservas de mayo-junio ya salidas se conservan; las `confirmed` vencidas se mueven a
[hoy+1, hoy+30].

### 7.3 `demo:fix-identity` (razón social/NIF ficticios de Faranda y NIF de org_123)

```bash
corepack pnpm --filter @hotelos/api demo:fix-identity -- --dry-run 2>&1 | tee ~/pre-$STAMP/cli-identity-dry.txt | grep -vE '^\s*$|not found'
corepack pnpm --filter @hotelos/api demo:fix-identity -- --apply --confirm "$FARANDA" --confirm org_123 > ~/pre-$STAMP/cli-identity-apply.txt 2>&1; echo "exit=$?"; grep -vE '^\s*$|not found' ~/pre-$STAMP/cli-identity-apply.txt
```

Esperado con Faranda (ensayo): `Faranda (cmrhw9jy30002fyvb6tsdiugt): 5 cambios previstos`
(`legalName "AUDIT-T1 SL" → "Faranda Hotels & Resorts"`, `taxId "B99999999" →
"B99999997"`, property `legalName`, `address "Paseo Marítimo, 1"`, `fiscalTerritory null →
"common"`) y `org_123 (demo): 1 cambios previstos` (`taxId "B12345678" → "B12345674"`);
apply `APPLIED`, exit 0. **Sin Faranda**: `ERROR organización no encontrada` en la línea
de Faranda y **exit 1**, pero org_123 sí se aplica (esperado; compruébalo:
`psql "$DATABASE_URL" -XtA -c "select tax_id from organizations where id='org_123'"` →
`B12345674`).

### 7.4 `backfill-legal-structure` (sociedad implícita, códigos de centro, instalaciones VeriFactu)

```bash
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --dry-run) 2>&1 | tee ~/pre-$STAMP/cli-legal-dry.txt | grep -vE 'not found'
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --apply --confirm all) 2>&1 | tee ~/pre-$STAMP/cli-legal-apply.txt | grep -E 'APPLY|aplicado|sociedad:|verificación|ERROR'
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --dry-run) 2>&1 | grep -E 'convergida|escrituras previstas'
```

Esperado (ensayo): dry-run `Grupo Hotelero Demo (org_123): 25 escrituras previstas` ·
`sociedad: CREAR HD «Grupo Hotelero Demo SL» NIF B12345674` · centros `AMC` (prop_123) y `ATS`
(prop_canary) · `instalación VeriFactu CREAR «DEV-001»` (+ `«DEV-001-ATS»`) y, con
Faranda, `81 escrituras previstas` · `CREAR FAR «Faranda Hotels & Resorts» NIF
B99999997` · centro `RA`. Avisos normales: `INSTALLATION_NUMBER_SANDBOX_DEFAULT` (sin
`VERIFACTU_INSTALL_NUMBER`: relleno DEV-001, válido en sandbox),
`INSTALLATION_NUMBER_SUFFIXED`, `INVOICE_NUMBER_DUPLICATE FAC-2026-000001` (índice único
aplazado), `SII_FLAG_ON_PROPERTY`. Apply: `verificación: OK {"ok":true,…,"propertiesWithoutEntity":0,…}`
por organización (188 ms). Tercera pasada: `convergida (0 escrituras)` en todas.
`TAX_ID_INVALID` (NIF que no pasa el checksum → «NIF pendiente») aparece si 7.3 no se
aplicó: la sociedad nace sin NIF y se pone después en Configuración › Estructura
societaria › Datos fiscales.

### 7.5 `accounting:provision-chart` (plan PGC Pymes hotelero, 239 cuentas)

```bash
ORGS="--org org_123"; [[ "$(psql "$DATABASE_URL" -XtA -c "select count(*) from organizations where id='$FARANDA'")" == "1" ]] && ORGS="$ORGS --org $FARANDA"
CONF="--confirm org_123"; [[ "$ORGS" == *"$FARANDA"* ]] && CONF="$CONF --confirm $FARANDA"
corepack pnpm --filter @hotelos/api accounting:provision-chart -- $ORGS --dry-run 2>&1 | tee ~/pre-$STAMP/cli-chart-dry.txt | grep -E 'Plantilla|^- |crear'
corepack pnpm --filter @hotelos/api accounting:provision-chart -- $ORGS --apply $CONF 2>&1 | tee ~/pre-$STAMP/cli-chart-apply.txt | grep -E 'aplicado|Error'
corepack pnpm --filter @hotelos/api accounting:provision-chart -- $ORGS --dry-run 2>&1 | grep -E 'crear 0|accounting_settings: keep'
```

Esperado (ensayo): `Plantilla pgc_pymes_hotelero_v1 · 239 cuentas · modo dry-run` ·
`org_123: 78 cuentas existentes · crear 171 · enlazar padre 78 · rellenar USALI 27 ·
accounting_settings: create` (32 «nombres distintos de la plantilla (NO se cambian)») ·
Faranda `0 cuentas existentes · crear 239`; apply `aplicado: creadas 171 · … · total
249` y `creadas 239 · … · total 239`; tercera pasada `crear 0 · … · accounting_settings:
keep`. Sin reinicio necesario (no hay espejo en memoria).

### 7.6 Backfills de `deploy.sh --with-backfills` (payment-hash, taxes, guest-register)

```bash
corepack pnpm --filter @hotelos/api backfill:payment-hash 2>&1 | grep -E 'DRY-RUN|scanned|would'
corepack pnpm --filter @hotelos/api backfill:payment-hash -- --apply 2>&1 | grep -E 'APPLIED|hashed|refus|Error'
corepack pnpm --filter @hotelos/api backfill:taxes 2>&1 | tee ~/pre-$STAMP/cli-taxes-dry.txt | grep -E 'DRY-RUN|properties:|unresolved|provisioning|immutable'
corepack pnpm --filter @hotelos/api backfill:taxes -- --apply 2>&1 | grep -E 'APPLIED|Error'
corepack pnpm --filter @hotelos/api backfill:guest-register 2>&1 | tee ~/pre-$STAMP/cli-grr-dry.txt | grep -E 'DRY-RUN|scanned'
corepack pnpm --filter @hotelos/api backfill:guest-register -- --apply 2>&1 | grep -E 'APPLIED|scanned|Error'
```

Esperado (ensayo): payment-hash `scanned 0 payments … would hash 0` / `APPLIED … hashed 0`
(se acepta el `--apply` porque `ENCRYPTION_KEY` está definida; sin clave se niega);
taxes `properties: 3 · normalized 0 · unresolved 0`, `provisioning: +0 rates` (VPS:
puede provisionar tipos si faltan), `immutable invoices with ES_UNKNOWN … (NOT touched)`
es informativo; guest-register `scanned 8 partes · would update 7 status/errors · would
mark 0 duplicates` / `APPLIED`. Avisos `[crypto-fields] … could not be decrypted` solo si
la `ENCRYPTION_KEY` cambió (§4). `backfill:snapshots` **no** se ejecuta (necesita
`--from/--to` y puede pisar cierres; demo sin necesidad). `backfill:pii` tampoco (sin
dry-run).

---

## 8 · Datos: qué queda y Faranda ficticia si no existe

### 8.1 Qué queda en la BD pública tras §6-§7

- `org_123` «Grupo Hotelero Demo» / sociedad HD «Grupo Hotelero Demo SL» B12345674 (ficticio
  con checksum válido), `prop_123` «Hotel Demo Madrid Centro» (47 habitaciones, 4 tipos,
  33 módulos; código de centro `AMC`), `prop_canary` «Hotel Demo Tenerife Sur» (`ATS`),
  `usr_123` `reception@example.com` / `hotelos-demo` (Local Super Admin de plataforma:
  tras el arranque recibe el catálogo completo, 223 claves), sus reservas de mayo-junio
  (salidas), 1 huésped, facturas de prueba en sandbox, plan de cuentas de 249 cuentas.
- Si Faranda (`cmrhw9jy30002fyvb6tsdiugt`) existía: «Faranda Hotels & Resorts»
  B99999997 (ficticio), sociedad FAR, Rías Altas (`RA`), plan de 239 cuentas, usuario
  `direccion@farandariasaltas.es` con la contraseña que tuviera.
- **Nada** de CELUISMA, A33615980, nóminas ni History & Forecast: esos datos solo están en
  el Mac y **no se restauran nunca** en el VPS. Comprobación tras §7:
  `psql "$DATABASE_URL" -XtA -c "select count(*) from legal_entities where tax_id='A33615980'"` → `0`.

### 8.2 Faranda ficticia (solo si 7.0 dio `0`): preparar el alta ahora, ejecutarla en §11.5

Ningún seed crea Faranda; la vía es `POST /admin/tenants` con el API nuevo arriba (permiso
`admin.tenants.manage` de `reception@example.com`). Crea organización + sociedad
implícita + centro + rol Owner + usuario propietario y devuelve el enlace de invitación
(sin `EMAIL_*`: `delivery.status = "disabled"` y el enlace viene en la respuesta). El id
será un cuid **nuevo** (≠ `cmrhw9jy30002fyvb6tsdiugt`): `demo:refresh --scope faranda`,
`demo:fix-identity`, `structure:migrate-faranda-celuisma` y los specs
`src/scripts/specs/faranda-*.json` no lo reconocerán (a propósito). Identidad ficticia
(la misma que usa el ensayo salvo el email, reservado RFC 2606; César puede cambiarla, §14):

```bash
cat > ~/pre-$STAMP/faranda-ficticia.json <<'EOF'
{
  "organizationName": "Faranda Hotels & Resorts",
  "organizationCountry": "ES",
  "plan": "pro",
  "property": {
    "name": "Hotel Faranda Rías Altas by Ascend Collection",
    "type": "hotel", "kind": "hotel", "code": "RA",
    "municipality": "Perillo (Oleiros)", "province": "A Coruña",
    "postalCode": "15172", "ineMunicipalityCode": "15058",
    "taxRegion": "ES_PENINSULA_BALEARES", "fiscalTerritory": "common"
  },
  "ownerUser": { "email": "carmen@faranda.example", "fullName": "Carmen (Dirección)" },
  "legalEntity": { "legalName": "Faranda Hotels & Resorts", "taxId": "B99999997", "code": "FAR", "legalForm": "sl" },
  "modulesEnabled": ["pms_core", "distribution_hub", "revenue_profit_engine", "outlet_pos", "guest_experience", "compliance_hub",
    "spain_guest_register_compliance", "compliance_billing", "erp_accounting", "housekeeping", "maintenance", "workforce_labor",
    "guest_data_crm_loyalty", "groups_events_sales", "ai_front_desk"]
}
EOF
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("JSON OK")' ~/pre-$STAMP/faranda-ficticia.json
```

El hotel nace **sin habitaciones ni tarifas** (recepción vacía): se rellena desde la
UI (Configuración › Propiedad / Habitaciones) o, si César lo decide, con
`pilot:provision-property --spec` sobre una copia de `src/scripts/specs/faranda-los-tilos.json`
con el `organizationId` nuevo (datos censales públicos de Los Tilos, 92 habitaciones
estimadas, NIF ficticio; nunca `import:pms-history-forecast`).

---

## 9 · Servicios: unidades systemd, Caddyfile, sudoers, `daemon-reload`, `restart`

### 9.1 Unidades renderizadas para ESTE clon (diff contra las actuales)

```bash
cd "$APP"
render_unit() { sed -e "s#/opt/anfitorio/hotelos#$APP#g" -e "s#^User=anfitorio#User=$VPS_USER#" -e "s#^Group=anfitorio#Group=$VPS_USER#" -e "s#/etc/anfitorio/api.env#$ENVF#g" -e "s#/usr/bin/node#$(command -v node)#g" "$1"; }
render_unit deploy/systemd/anfitorio-api.service    > ~/pre-$STAMP/anfitorio-api.service.new
render_unit deploy/systemd/anfitorio-worker.service > ~/pre-$STAMP/anfitorio-worker.service.new
grep -E '^(User|WorkingDirectory|EnvironmentFile|ExecStart|Environment=NODE_ENV)' ~/pre-$STAMP/anfitorio-api.service.new
diff ~/pre-$STAMP/anfitorio-api.service.pre ~/pre-$STAMP/anfitorio-api.service.new; true     # revisar: cambia ExecStart/EnvironmentFile/hardening
sudo cp ~/pre-$STAMP/anfitorio-api.service.new /etc/systemd/system/anfitorio-api.service      # [root]
```

Esperado en el `.new`: `User=anfitorio`, `WorkingDirectory=<APP>/apps/api`,
`EnvironmentFile=/etc/anfitorio/api.env`, `ExecStart=<node> --import tsx src/server.ts`,
`Environment=NODE_ENV=production`. **Worker:** opcional y hoy **no recomendado** en la
demo (procesa jobs pg-boss de webhooks que la demo no usa, y es una segunda instancia que
escribe en la cadena de auditoría: deuda 12(c) de `CLAUDE.md`). Si César lo quiere
(§14): `sudo cp ~/pre-$STAMP/anfitorio-worker.service.new /etc/systemd/system/` y en 9.5
añade `anfitorio-worker`; `deploy.sh` solo lo reinicia si la unidad existe.

### 9.2 Caddyfile (diff contra el actual antes de sobrescribir)

```bash
sed -e "s#/srv/anfitorio/admin-web#$WEB_ROOT#g" deploy/caddy/Caddyfile.native > ~/pre-$STAMP/Caddyfile.new
grep -E '^\s*email ' ~/pre-$STAMP/Caddyfile.pre ~/pre-$STAMP/Caddyfile.new   # si el email ACME actual es otro, consérvalo: sed -i "s#admin@hotelos.es#<email actual>#" ~/pre-$STAMP/Caddyfile.new
diff ~/pre-$STAMP/Caddyfile.pre ~/pre-$STAMP/Caddyfile.new; true
```

Lo que aporta el versionado: `handle /health` directo al API, `handle_path /api/*` con
`header_up Host`, cabeceras de seguridad (HSTS, nosniff), `index.html` con
`Cache-Control: no-store` (el deploy se ve al recargar), `/assets/*` inmutable 1 año,
bloqueo de `/.env` `/.git/*`, log JSON en `/var/log/caddy/anfitorio.access.log`. Si el
actual tiene algo que no está aquí (otro dominio, un `redir`), fúndelo a mano en el
`.new` antes de copiar.

```bash
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy                   # [root]
sudo cp ~/pre-$STAMP/Caddyfile.new /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile   # [root] → "Valid configuration"
```

### 9.3 sudoers y directorio de backups (lo que `deploy.sh` necesita y una instalación a mano no tiene)

```bash
printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl restart anfitorio-api, /usr/bin/systemctl restart anfitorio-api anfitorio-worker, /usr/bin/systemctl restart anfitorio-worker, /usr/bin/systemctl reload caddy, /usr/bin/systemctl status anfitorio-api, /usr/bin/systemctl status anfitorio-worker\n' "$VPS_USER" | sudo tee /etc/sudoers.d/anfitorio-deploy >/dev/null   # [root]
sudo chmod 0440 /etc/sudoers.d/anfitorio-deploy && sudo visudo -c -f /etc/sudoers.d/anfitorio-deploy    # [root] → parsed OK
ls -ld "$BK"                                                                           # drwxr-x--- anfitorio anfitorio (creado en §3.1)
sudo -n systemctl status anfitorio-api --no-pager >/dev/null 2>&1; echo "sudo -n systemctl status: exit $? (0 = OK)"
```

### 9.4 `daemon-reload`, `enable`

```bash
sudo systemctl daemon-reload && sudo systemctl enable anfitorio-api      # [root]
```

### 9.5 Arrancar el API (una sola instancia) y leer el arranque

```bash
sudo systemctl restart anfitorio-api                                      # [root]
for i in $(seq 1 30); do curl -fsS -m 3 http://127.0.0.1:3000/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:3000/health | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(j.status, "db="+j.checks.database.ok, "schedulers="+j.checks.schedulers.message, "version="+j.version)'
sudo journalctl -u anfitorio-api -n 60 --no-pager | grep -E 'rbac|tenants|env\]|cors|listening|Error|error|assert'   # [root] (o sin sudo si el journal es legible)
```

Esperado: `healthy db=true schedulers=leader (RUN_SCHEDULERS) version=dev` y en el
journal (ensayo): `[audit] hydrated chain tips …`, `[rbac] permission catalog synced:
created=N updated=0 stale=4`, `[rbac] platform roles topped up: 1 of 1 … Local Super Admin
(org_123) ← full catalog: +N`, `[tenants] mirrors hydrated: properties=P organizations=O
modules=M`, `[env] N aviso(s) de configuración (production)`, `[cors] política cargada
allowed=["https://demo.ehotelos.com"]`, `Server listening at http://127.0.0.1:3000`,
`[schedulers] this instance is the scheduler leader`. El aviso `[verifactu] bloque
SistemaInformatico incompleto (solo aviso en sandbox)` es normal.

**Si no arranca** (`systemctl status anfitorio-api` → failed): el journal dice por qué:
`assertEnv` con la lista de errores (→ corregir `api.env`, 5.6), `Cannot find module
'tsx'` (→ 5.4 con `--prod=false`), `PrismaClient … not generated` (→ 5.5), `P1001`
(Postgres/`DATABASE_URL`). Corrige y `sudo systemctl restart anfitorio-api`. Si no sale
en 10 min, §12.

### 9.6 Caddy (fin de la ventana de caída del API)

```bash
sudo systemctl reload caddy && systemctl is-active caddy                  # [root]
curl -sS -o /dev/null -w '%{http_code}\n' https://demo.ehotelos.com/api/health         # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://demo.ehotelos.com/api/properties     # 401 (antes 200: modo demo retirado)
curl -sS https://demo.ehotelos.com/health | head -c 120; echo                            # JSON del API (ruta nueva)
```

---

## 10 · Front: build con `VITE_API_URL` y `rsync` a `/srv/anfitorio/admin-web`

```bash
cd "$APP"
sudo cp -a "$WEB_ROOT" "$WEB_ROOT.pre-$STAMP" 2>/dev/null || true                   # [root] copia del dist actual (además del tgz de §3.2)
VITE_API_URL='https://demo.ehotelos.com/api' corepack pnpm --filter @hotelos/admin-web build 2>&1 | tail -6
grep -rlF 'https://demo.ehotelos.com/api' apps/admin-web/dist/assets --include='*.js' | wc -l   # ≥ 1
grep -rlF 'http://localhost:3000'       apps/admin-web/dist/assets --include='*.js' | wc -l   # 0
sudo mkdir -p "$WEB_ROOT" && sudo chown -R "$VPS_USER:$VPS_USER" "$WEB_ROOT"          # [root] (deploy.sh hará el rsync como anfitorio)
rsync -a --delete apps/admin-web/dist/ "$WEB_ROOT/"
ls -la "$WEB_ROOT"; du -sh "$WEB_ROOT"
curl -sSI https://demo.ehotelos.com/ | grep -iE '^(HTTP|cache-control|last-modified)'
```

Esperado: `✓ built in N s` (2,5 s en el Mac; 30-120 s en el VPS), `1` y `0`, un
`WEB_ROOT` de ≈ 3,7 MB con `assets/ icon.svg index.html manifest.webmanifest sw.js`,
`HTTP/2 200` y `cache-control: no-store, must-revalidate`. Si el build muere por memoria
(`JavaScript heap out of memory`): `NODE_OPTIONS=--max-old-space-size=3072` delante del
comando, o añade swap.

---

## 11 · Smoke y comprobaciones manuales

### 11.1 `smoke.sh` (10 comprobaciones)

```bash
cd "$APP"
bash deploy/scripts/smoke.sh --base-url https://demo.ehotelos.com/api --web-url https://demo.ehotelos.com \
  --web-dist "$WEB_ROOT" --expect-api-url https://demo.ehotelos.com/api \
  --email reception@example.com --password hotelos-demo --property prop_123 2>&1 | tee ~/pre-$STAMP/smoke.txt
```

Esperado (el ensayo dio 7 de 7 sin Caddy; en el VPS son 10: `smoke.sh` cuenta `index.html` y
las dos rutas profundas como comprobaciones propias):

```
▶ Smoke ehotelOS · API https://demo.ehotelos.com/api · web https://demo.ehotelos.com
  ✓ GET /health                                200 ok=true db=ok (healthy · schedulers: leader (RUN_SCHEDULERS))
  ✓ GET /properties sin token                  401 (modo demo desactivado)
  ✓ POST /auth/login                           200 token recibido (reception@example.com)
  ✓ GET /properties (token)                    200 · N propiedades
  ✓ GET /properties/prop_123/dashboard         200
  ✓ GET /backoffice/properties/prop_123/readiness 200
  ✓ GET https://demo.ehotelos.com/ (index.html)  200 id="root" · cache-control: no-store, must-revalidate
  ✓ GET /accept-invite (SPA fallback)          200
  ✓ GET /reset-password (SPA fallback)         200
  ✓ VITE_API_URL horneada                      https://demo.ehotelos.com/api presente en /srv/anfitorio/admin-web/assets
✅ Smoke OK · 10 comprobaciones
```

### 11.2 `/admin/tenants` (hoy 500) y estructura de org_123 por API

```bash
TOKEN=$(curl -fsS -X POST https://demo.ehotelos.com/api/auth/login -H 'content-type: application/json' -d '{"email":"reception@example.com","password":"hotelos-demo"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
curl -sS -o /dev/null -w 'admin/tenants sin token: %{http_code}\n' https://demo.ehotelos.com/api/admin/tenants                     # 401
curl -fsS https://demo.ehotelos.com/api/admin/tenants -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).map(t=>`${t.organizationId} ${t.name} · props=${t.counts.properties} users=${t.counts.users}`).join("\n")'
curl -fsS https://demo.ehotelos.com/api/organizations/me/structure -H "Authorization: Bearer $TOKEN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); `${j.legalEntity.code} «${j.legalEntity.legalName}» ${j.legalEntity.taxId} · mode=${j.mode} · centros=${j.legalEntity.properties.map(p=>p.code+":"+p.name+"/"+(p.installation?p.installation.numeroInstalacion:"-")).join(", ")} · warnings=${j.warnings.length}`'
```

Esperado (ensayo): `401`; `org_123 Grupo Hotelero Demo · props=2 users=1` (+ Faranda si
existe); `HD «Grupo Hotelero Demo SL» B12345674 · mode=multi_center · centros=AMC:Hotel Demo
Madrid Centro/DEV-001, ATS:Hotel Demo Tenerife Sur/DEV-001-ATS · warnings=0`.

### 11.3 Navegador como `reception@example.com` / `hotelos-demo` (recarga con Cmd+Shift+R la primera vez)

| URL | Qué ver |
| --- | --- |
| `https://demo.ehotelos.com/` | pantalla de **login** (ya no entra sin sesión); tras login, el shell nuevo (Cocoa 22, sidebar por dominios) |
| `https://demo.ehotelos.com/configuracion/estructura-societaria` | Configuración › **Estructura societaria**: pestañas Datos fiscales (sociedad HD «Grupo Hotelero Demo SL», NIF B12345674 válido), Centros (AMC Hotel Demo Madrid Centro, ATS Hotel Demo Tenerife Sur), Series y VeriFactu (FAC-2026-, instalaciones DEV-001 / DEV-001-ATS), IVA y ejercicio, Reparto |
| `https://demo.ehotelos.com/recepcion/reservas/importar` | Recepción › Reservas › **Importar**: asistente CSV/XLSX con plantilla descargable, previsualización y «Importar»; también desde el botón «Importar reservas» de la lista y ⌘K |
| `https://demo.ehotelos.com/finanzas/nominas` | Finanzas › Nóminas: pestaña **Coste de personal** (lote de coste de personal importado, vacía; botón de importación); «Contratos y periodos» sin datos |
| `https://demo.ehotelos.com/recepcion/reservas` | lista de reservas de prop_123 (mayo-junio, salidas) sin errores 500 |
| `https://demo.ehotelos.com/accept-invite` | sirve la SPA (no 404 de Caddy) |

Consola del navegador sin `401`/`500` en `/api/*` (salvo lo que la propia pantalla
marque como «sin datos»).

### 11.4 Login de Carmen (Faranda existente) — si 7.0 dio `1`

`direccion@farandariasaltas.es` con su contraseña de julio. Debe ver **solo** Rías Altas,
`Estructura societaria` con FAR «Faranda Hotels & Resorts» B99999997 y `mode=single_hotel`.
Si la contraseña se desconoce: `reception` → Administración › Tenants › Faranda ›
usuario › «Reenviar invitación» (o `POST /admin/tenants/<orgId>/users/<userId>/reissue-invite`)
y abre el enlace.

### 11.5 Faranda ficticia — solo si 7.0 dio `0`

```bash
curl -fsS -X POST https://demo.ehotelos.com/api/admin/tenants -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary "@$HOME/pre-$STAMP/faranda-ficticia.json" | tee ~/pre-$STAMP/faranda-ficticia.response.json | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); `org=${j.organizationId} legalEntity=${j.legalEntityId} property=${j.propertyId} owner=${j.ownerUserId} perms=${j.ownerPermissionsGranted} delivery=${j.invitation.delivery.status}\ninviteLink=${j.inviteLink}`'
```

Esperado (probado el 17-sep contra una copia de la BD de ensayo con este mismo JSON):
`HTTP 200`, ids nuevos (cuid), `perms=222` (plantilla Owner completa), 10 roles plantilla,
`taxProvisioning {"ok":true,"taxRegion":"ES_PENINSULA_BALEARES",…}`, `delivery=disabled`
(sin EMAIL_*) e `inviteLink=https://demo.ehotelos.com/accept-invite?token=…`; en BD: 1
`legal_entities` (FAR, B99999997, `is_default`), 1 `properties` (RA, hotel, Perillo
(Oleiros) 15172), 15 `property_modules`. Comprobar el enlace sin abrirlo:
`curl -sS -o /dev/null -w '%{http_code}\n' "https://demo.ehotelos.com/api/auth/invitations/<token del inviteLink>"`
→ `200`. Errores: `409` «Ya existe un usuario con el email» → cambia el email del JSON;
`400 TAX_ID_INVALID` / `409 TAX_ID_IN_USE` → el NIF ficticio ya lo usa otra sociedad
(Faranda sí existía: vuelve a 11.4).

1. Abre `inviteLink` en el navegador → Carmen fija su contraseña → entra: ve solo
   «Hotel Faranda Rías Altas by Ascend Collection» (sin habitaciones), Configuración ›
   Estructura societaria con FAR «Faranda Hotels & Resorts» B99999997.
2. Plan de cuentas de la nueva org (**API parado**, cadena de auditoría):

```bash
# (sesión nueva: §1.1 y set -a; . "$ENVF"; set +a — las CLI leen DATABASE_URL del entorno)
cd "$APP"; NEWORG=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).organizationId' ~/pre-$STAMP/faranda-ficticia.response.json); echo "$NEWORG"
sudo systemctl stop anfitorio-api                                                                     # [root]
corepack pnpm --filter @hotelos/api accounting:provision-chart -- --org "$NEWORG" --dry-run 2>&1 | grep -E '^- |crear'
corepack pnpm --filter @hotelos/api accounting:provision-chart -- --org "$NEWORG" --apply --confirm "$NEWORG" 2>&1 | grep -E 'aplicado|Error'   # aplicado: creadas 239 · enlazadas 232 · … · total 239
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --dry-run --org "$NEWORG") 2>&1 | grep -E 'convergida|escrituras'   # convergida (0 escrituras): createTenant ya creó la sociedad
sudo systemctl start anfitorio-api && sleep 5 && curl -fsS -o /dev/null -w '%{http_code}\n' https://demo.ehotelos.com/api/health   # [root] 200
```

### 11.6 Estado final para §13

```bash
psql "$DATABASE_URL" -XtA -c "select (select count(*) from organizations), (select count(*) from properties), (select count(*) from users), (select count(*) from legal_entities), (select count(*) from verifactu_installations), (select count(*) from accounts), (select count(*) from reservations), (select count(*) from invoices), pg_size_pretty(pg_database_size(current_database()))"
git -C "$APP" log -1 --format='%H'; systemctl is-active anfitorio-api caddy; ls -la "$BK"
```

---

## 12 · Rollback (volver al estado del backup de §3)

Orden: parar el API nuevo → restaurar la BD → código viejo → dist/unidad/Caddyfile viejos
→ arrancar. Tarda ≈ 10 min. `OLD_COMMIT` y `OLDENV` son los de §2. El bloque de BD (terminar
conexiones → `rename` → `createdb` → `pg_restore` del dump) se probó en local el 17-sep sobre la
BD de la vía B: 250 tablas, `_prisma_migrations` NO EXISTE, < 1 min.

```bash
set -a; . "$ENVF"; set +a; cd "$APP"
sudo systemctl stop anfitorio-api; sudo systemctl stop anfitorio-worker 2>/dev/null || true       # [root]
# 1) BD: recrear la BD con el dump de §3 (mismo nombre; requiere que nadie esté conectado)
DBNAME=$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#'); DBUSER=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:/@]+).*#\1#'); echo "$DBNAME $DBUSER"
sudo -u postgres psql -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DBNAME' and pid<>pg_backend_pid()"   # [root]
sudo -u postgres psql -c "alter database \"$DBNAME\" rename to \"${DBNAME}_fallido_$STAMP\""    # [root] (se conserva para analizar; borrar después con dropdb)
sudo -u postgres createdb -O "$DBUSER" "$DBNAME"                                                  # [root]
pg_restore --no-owner --no-privileges -d "$DATABASE_URL" "$BK/anfitorio-pre-actualizacion-$STAMP.pgcustom" 2>&1 | tail -3   # sin errores
psql "$DATABASE_URL" -XtA -c "select count(*) from pg_tables where schemaname='public'" -c "select coalesce(to_regclass('_prisma_migrations')::text,'NO EXISTE')"   # ≈ 251 · NO EXISTE
#    (vía B de §6.5: en vez de restaurar, basta con volver a poner la DATABASE_URL antigua en api.env / en el .env viejo)
# 2) código viejo y sus dependencias
git reset --hard "$OLD_COMMIT" && git log -1 --oneline
rm -rf node_modules apps/*/node_modules packages/*/node_modules
env -u NODE_ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --no-frozen-lockfile --prod=false 2>&1 | tail -3 && git checkout -- pnpm-lock.yaml 2>/dev/null; true
corepack pnpm --filter @hotelos/database db:generate 2>&1 | grep Generated
cp ~/pre-$STAMP/hotelos.env "$APP/.env" 2>/dev/null; true                                         # el .env de julio vuelve al clon (la unidad vieja lo usa)
# 3) dist, unidad y Caddyfile viejos
sudo rm -rf "$WEB_ROOT" && sudo tar xzf "$BK/admin-web-dist-pre-$STAMP.tgz" -C "$(dirname "$WEB_ROOT")"   # [root]
sed -n '/^\[Unit\]/,$p' ~/pre-$STAMP/anfitorio-api.service.pre | sudo tee /etc/systemd/system/anfitorio-api.service >/dev/null   # [root] (systemctl cat antepone "# /etc/systemd/system/…"; si el .pre tiene MÁS de un encabezado "# /etc/…" hay drop-ins: pega solo el primer bloque)
sudo cp ~/pre-$STAMP/Caddyfile.pre /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile     # [root]
sudo systemctl daemon-reload && sudo systemctl restart anfitorio-api && sudo systemctl reload caddy              # [root]
sleep 5; curl -sS https://demo.ehotelos.com/api/health | head -c 200; echo
curl -sS -o /dev/null -w '%{http_code}\n' https://demo.ehotelos.com/api/properties      # 200 = el modo demo de julio ha vuelto
```

`/etc/anfitorio/api.env`, `/etc/sudoers.d/anfitorio-deploy` y `/var/backups/anfitorio`
pueden quedarse: la unidad vieja no los usa.

---

## 13 · Qué me tienes que pegar de vuelta (salidas)

Pégame estos ficheros/salidas (textos, sin editar; **no** pegues `api.env` ni `.env`):

1. `~/pre-20260917/inventario.txt` completo (§2; el script nunca imprime valores).
2. `~/pre-20260917/OLD_COMMIT.txt` y `NEW_COMMIT.txt`; `ls -la /var/backups/anfitorio` y
   el `ls` del Mac de §3.3.
3. Salida del generador de §4.2 (líneas `JWT_SECRET reutilizado/GENERADO`,
   `ENCRYPTION_KEY reutilizada/GENERADA`, `escrito … (N claves)`) y de `validate-env`
   (§5.6, con `exit=`).
4. Las 15 últimas líneas del `pnpm install` (§5.4) y qué salida usaste (A o B);
   `ls node_modules/.pnpm | wc -l`.
5. `adopt-plan.txt`, `adopt-apply.txt`, `migrate-deploy.txt`, la salida de
   `db:drift:check` con `exit=` y la consulta de recuento de 6.4 (276 · 32 · 11 ·
   organizaciones). En vía B: `restore-v2.log` (primeras 40 líneas + `grep -ci error`),
   `adopt-plan-v2.txt`, `migrate-deploy-v2.txt`, `drift-check-v2.txt` y `recuentos-v2.txt`.
6. Los `cli-*.txt` de §7 (o las líneas filtradas) con el `exit=` de cada `--apply`.
7. Salida de 9.5 (`/health` y el `journalctl` filtrado) y de 9.6 (200 / 401).
8. Salida del build y los dos `wc -l` de §10, `du -sh "$WEB_ROOT"`, cabeceras de `curl -sSI`.
9. `smoke.txt` completo, las tres líneas de 11.2, la consulta de 11.6.
10. Si hubo Faranda ficticia: `faranda-ficticia.response.json` **sin** `inviteLink` (o con
    el token cortado) y las líneas `creadas 239 · total 239`.
11. Si algo falló: el bloque completo del error y `sudo journalctl -u anfitorio-api -n 200 --no-pager`.

Con eso verifico cada paso contra el ensayo y te digo si el VPS queda como referencia
para activar `deploy.yml` (secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`) o qué falta.

---

## 14 · Decisiones que solo César puede tomar

1. **Lockfile.** `origin/main` (`b32601a`; igual en `cc49810`) tiene un `pnpm-lock.yaml` del 31-may que no cubre
   `@fontsource-variable/inter`, `zod`, `@playwright/test` (admin-web) ni
   `qrcode-terminal` (api): `pnpm install --frozen-lockfile` falla en el VPS, en CI (los 4
   últimos commits de main en rojo, `b32601a` incluido; «Deploy VPS» skipped) y en `deploy.sh`. El
   `hotelos/pnpm-lock.yaml` **local sin commitear** (+52 líneas) lo resuelve y está
   verificado con `--frozen-lockfile --offline` contra `cc49810` y, el 17-sep por la tarde,
   contra `b32601a` (Tanda 7b no añadió dependencias). **Recomendación:** commitear y pushear
   ese lockfile (junto con los arreglos de `deploy/` y `docs/` de §15) **antes** de §5, y
   usar la salida (A). Si no: salida (B) (`--no-frozen-lockfile` + `git checkout --
   pnpm-lock.yaml`), y cada `deploy.sh --pull` futuro necesitará lo mismo hasta que se
   commitee. Yo no toco el lockfile (regla de sesión).
2. **Modo demo sin token.** Hoy la demo pública responde sin autenticación
   (`HOTELOS_ALLOW_DEMO_AUTH=true`). **Recomendación:** fuera (`api.env` de §4 lo pone a
   `false`): el front ya hace login con `reception@example.com` / `hotelos-demo`, el
   smoke exige el 401 y el API en producción se niega a arrancar con el flag salvo
   `HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true`. Si César quiere mantenerlo, añade las
   dos claves a `api.env` y acepta que `smoke.sh` falle en la comprobación 2 por diseño.
3. **Faranda ficticia vs nada.** Si el inventario da 1 organización, la demo queda solo con
   org_123 (Hotel Demo Madrid Centro / Tenerife Sur). §8.2/§11.5 crean una Faranda ficticia
   (nombre comercial real de la cadena prospecto, NIF ficticio B99999997, email
   `carmen@faranda.example`, hotel sin habitaciones). Alternativas: no crearla, cambiar la
   identidad (otro nombre/email), o además provisionar Los Tilos desde el spec (datos
   censales públicos, sin H&F). **Recomendación:** crearla (Carmen puede enseñar Estructura
   societaria e Importar reservas sobre su propio hotel) y cargar habitaciones/tarifas
   desde la UI o con el importador de reservas de la Tanda 7.
4. **Autorizar la clave SSH del Mac** para que yo pueda verificar y operar directamente
   (hoy solo puedo leer lo que César pegue). Desde el Mac, con la contraseña de
   `anfitorio`:

   ```bash
   # [Mac]
   ssh-copy-id -i ~/.ssh/id_ed25519.pub anfitorio@76.13.55.180
   ssh anfitorio@76.13.55.180 'hostname && whoami'      # sin contraseña
   ```

   Después conviene desactivar `PasswordAuthentication` en `sshd_config` (el inventario
   lo muestra). Con la clave autorizada, el siguiente deploy puede ser
   `bash deploy/scripts/deploy.sh --pull --yes` (o `deploy.yml` con los secrets).
5. **Worker.** Instalar `anfitorio-worker.service` hoy (README §4.6) o no (recomendación de
   §9.1: no, hasta que la demo use webhooks; una segunda instancia bifurca la cadena de
   auditoría, deuda 12(c)).
6. **ENCRYPTION_KEY.** Si el inventario dice que la actual no son 32 bytes (o es el
   placeholder de julio), el generador crea una nueva: aceptar que la PII cifrada con la
   anterior (si la hubo; con `NODE_ENV=dev` en julio probablemente ninguna) queda
   ilegible, o parar y buscar la clave original.

---

## 15 · Arreglos aplicados al repo con este runbook (solo `deploy/` y `docs/`) y pendientes fuera

Aplicados en el working tree del Mac (sin commit; entran con el commit de la decisión 1):

| Fichero | Cambio | Motivo (verificado en el ensayo) |
| --- | --- | --- |
| `deploy/scripts/deploy.sh` | `corepack pnpm install --frozen-lockfile --prod=false` (paso `install`, cabecera); el paso `backup` imprime la URL de Postgres **sin contraseña** (`mask_url`, antes `run()` la escribía en la terminal/journal); los pasos `adopt`/`migrate` llaman a `corepack pnpm --filter @hotelos/database db:*` en vez de los alias raíz (que encadenan `pnpm` a pelo y exigen `corepack enable`); `--only-pull` implica `--pull` (antes no ejecutaba nada); cabecera y comentario de `--dry-run` piden `--skip-backup` cuando no hay fichero de entorno; `usage()` cubre la cabecera nueva. Probado: `--dry-run`, `--only-pull --dry-run` y una ejecución real sobre la BD de ensayo sin shim `pnpm` (`adopted`, `No pending migrations`, `No difference detected`, ✅). | El paso `env` exporta `NODE_ENV=production` y pnpm 9.15.0 omitía/borraba las devDependencies (734 vs 806 paquetes): el primer `deploy.sh` real habría dejado el VPS sin `tsx`/`prisma`/`vite`. |
| `deploy/scripts/install-from-scratch.sh` | `--prod=false` en el paso 6/15 (con comentario: `as_app` exporta `ENV_FILE` en re-ejecuciones); el plan de `--adopt` menciona `--prod=false`, el lockfile, el sudoers y `/var/backups/anfitorio`; el aviso sobre `hotelos/.env` ya no dice que el worker lo prioriza. | Mismo prune en re-ejecuciones; el loader del worker (`apps/worker/src/index.ts`) solo rellena claves ausentes desde Tanda 1. |
| `deploy/scripts/vps-inventory.sh` | Filas nuevas: `/etc/sudoers.d/anfitorio-deploy`, `/var/backups/anfitorio` (owner/permisos), `schema.prisma del clon` (modelos/enums esperados), `node ≥ 22.9 (--env-file-if-exists)`; `pnpm global` explica para qué hace falta; el recuento de tablas ya no dice «esperado 251» (hoy 276/32 con `b32601a`). Probado en local contra el clon y la BD de ensayo. | `deploy.sh` muere en `backup` (mkdir sin sudo) y `restart` (`sudo -n`) si faltan; Node < 22.9 no ejecuta `node --env-file-if-exists`. |
| `deploy/systemd/anfitorio-api.service` | Comentario de cabecera: los dos cargadores (`API` y `worker`) solo rellenan claves ausentes. | Texto desfasado. |
| `deploy/README-INSTALL.md` §4.5 y `deploy/scripts/install-from-scratch.sh` (plan `--adopt`, paso 4) | La vía «esquema anterior a la baseline» pasa a: BD vacía + **solo la baseline por `psql`** + `pg_restore --data-only --disable-triggers` + adopt → `migrate deploy` → drift sobre la BD nueva (antes decían `migrate deploy` sobre la BD vacía y después los datos). | Revisión crítica 17-sep: con `migrate deploy` antes de los datos, los `UPDATE` de 4 migraciones (`modules_spanish_names`, `finanzas_contabilidad_pgc`, `rate_grid_v2_journal_unique`, `estructura_societaria_harden`) corren sobre tablas vacías y se pierden. Ensayado en local (§6.5). |
| `deploy/scripts/deploy.sh` (cabecera) | Las líneas `adopt`/`migrate` de la ayuda citan `pnpm --filter @hotelos/database db:*`, como hace el código. | Coherencia ayuda ↔ pasos. |
| `deploy/README-INSTALL.md` | §1 Node ≥ 22.9 y shim `pnpm` opcional; «Decisiones fijadas» explica `--prod=false`; §2 corrige la frase del worker; §3 lista `--repo`, `--env-file`, `--yes`; §4 paso 0 (prerrequisitos del usuario de deploy: sudoers, backups, API parado para las CLI), paso 4 con `--prod=false` y la salida al `ERR_PNPM_OUTDATED_LOCKFILE`, paso 6 con `Documentation=` y sudoers; §5 refleja `--only-pull`, `--prod=false` y la URL enmascarada; §9 remite a este runbook, corrige el orden de las CLI y añade lo observado por HTTP; §11 añade el caso `NODE_ENV=production` sin `--prod=false`. | Coherencia docs ↔ scripts. |
| `docs/runbooks/finanzas-contabilidad.md` §17.9 | Nota: en el VPS demo `demo:refresh` y `demo:fix-identity` van antes del backfill de estructura. | Ronda 1 del ensayo (orden antiguo) dejó 5 `legal_entities` huérfanas y la sociedad de Faranda «AUDIT-T1 SL» con NIF nulo. |
| `docs/audits/DEMO-DATASET-2026-09-14.md` §5 | Misma nota fechada 2026-09-17. | Ídem. |

Pendiente fuera de `deploy/` y `docs/` (no tocado por este runbook; para César o la sesión dueña):

- `packages/database/MIGRATIONS_README.md`: dice «251 models, 11 enums» (hoy 276/32) y
  promete un guard `ALLOW_DESTRUCTIVE_MIGRATION` en `deploy.sh` que no existe.
- `scripts/env-contract.json` / `apps/api/src/lib/env.ts`: `SMOKE_EMAIL`, `SMOKE_PASSWORD`,
  `SMOKE_PROPERTY_ID` no están en el contrato (3 avisos por cada `validate-env`).
- `apps/api/src/scripts/refresh-demo-dataset.ts` y `fix-demo-legal-identity.ts`: no cubren
  `legal_entities` / `verifactu_installations` / `accounts` / `accounting_settings`
  (alternativa de código al orden de §7).
- `.github/workflows/ci.yml` y `deploy.yml` (raíz git): vuelven a verde con el lockfile
  commiteado; `deploy.yml` solo tras dos smokes verdes (README §9.11).
- `CLAUDE.md` deuda 12(f)/(g): el shim `pnpm` ya no lo necesita `deploy.sh`; el VPS demo
  deja de estar «sin adoptar» cuando este runbook se ejecute.
- `deploy/README-HOSTINGER.md` (obsoleto): URL raw sin el segmento `hotelos/`, rutas
  `/opt/hotelos`; se conserva como histórico.
