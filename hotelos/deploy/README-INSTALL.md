# Anfitorio · Instalación, actualización y adopción de un VPS

Guía única de despliegue (Tanda 4 · instalabilidad). Sustituye a
`README-HOSTINGER.md`, `README-REMOTE-DEV.md`, `docs/deploy-pilot.md` y
`docs/deployment.md`, que quedan marcados como obsoletos. Todo lo que hay aquí
está respaldado por scripts versionados en `deploy/`:

| Fichero | Para qué |
|---|---|
| `deploy/scripts/install-from-scratch.sh` | Instalación completa en Ubuntu 24.04 (`--demo`, `--real`) o detección sin escribir (`--adopt`) |
| `deploy/scripts/deploy.sh` | Actualización idempotente de una instalación existente (nativa o compose) |
| `deploy/scripts/smoke.sh` | Prueba HTTP real tras cada deploy: health, 401, login, lecturas, front |
| `deploy/scripts/vps-inventory.sh` | Inventario de solo lectura de un servidor ya desplegado a mano |
| `deploy/systemd/anfitorio-api.service`, `anfitorio-worker.service` | Unidades systemd (usuario `anfitorio`, `EnvironmentFile=/etc/anfitorio/api.env`) |
| `deploy/caddy/Caddyfile.native` | Caddy nativo: SPA desde disco + `/api/*` → `127.0.0.1:3000` |
| `deploy/Dockerfile.api`, `.worker`, `.admin-web` + `docker-compose.production.yml` | Vía Docker (corepack pnpm + tsx); secundaria frente a la nativa |
| `.github/workflows/ci.yml`, `deploy.yml` (en la **raíz git**, no en `hotelos/`) | CI con fresh-install y deploy por SSH |

Decisiones fijadas en esta tanda:

- **Runtime oficial = tsx.** `pnpm --filter @hotelos/api start` es
  `node --import tsx src/server.ts` (worker: `src/index.ts`). No existe un
  `dist/` ejecutable: `tsc` no resuelve los paquetes `@hotelos/*` (se consumen
  desde `packages/*/src` vía `tsconfig` paths). `tsx` (y la CLI `prisma`) están
  en `devDependencies`, no en `dependencies`; por eso **`pnpm install
  --frozen-lockfile` se ejecuta SIN `--prod`**: la decisión es instalar el
  árbol completo (lo que hace el install por defecto) en vez de promover `tsx`
  a dependencia de producción, para que el runtime y `migrate deploy` funcionen
  con el mismo lockfile que CI.
- **Esquema = migraciones versionadas.** `prisma db push` solo para prototipar
  en local. Producción: `pnpm db:adopt-baseline -- --apply` (idempotente; solo
  escribe `_prisma_migrations` en BD nacidas con `db push`) → `pnpm
  db:migrate:deploy` → `pnpm db:drift:check` (exit 0 obligatorio).
- **Gestor de paquetes = corepack pnpm 9.15.0** (`packageManager` del
  `package.json`). Nunca `npm install` (`workspace:*` → EUNSUPPORTEDPROTOCOL).
- **Un solo origen público.** El front se hornea con
  `VITE_API_URL=${APP_BASE_URL}/api`; Caddy sirve la SPA y proxya `/api/*`
  al API (`HOST=127.0.0.1`, `TRUST_PROXY=1`). Sin esa variable el bundle apunta
  a `http://localhost:3000` y el smoke lo detecta.
- **Una sola instancia con `RUN_SCHEDULERS=true`** (el API). El worker corre
  siempre con `RUN_SCHEDULERS=false`; una segunda réplica del API también.

---

## 1. Requisitos

| Componente | Versión | Notas |
|---|---|---|
| Ubuntu | 24.04 LTS | Probado; otras Debian/Ubuntu deberían funcionar con los mismos paquetes |
| Node | 22.x | NodeSource (`install-from-scratch.sh` lo instala) |
| pnpm | 9.15.0 vía corepack | `corepack enable && corepack prepare pnpm@9.15.0 --activate` |
| PostgreSQL | 16 | Local en el VPS (paquete `postgresql` de 24.04) o gestionado |
| Caddy | 2.x | HTTPS automático; opcional con `--no-caddy` si traes tu proxy |
| Redis | 7 | **Opcional** (hoy ningún código lo exige; `/health` lo reporta como configurado/no) |
| RAM | ≥ 4 GB (+4 GB swap) | El build de Vite y `pnpm install` lo necesitan |

Puertos: 22, 80, 443 abiertos; el API escucha solo en `127.0.0.1:3000`.

## 2. Variables de entorno por rol

Fuente: `.env.example` (raíz `hotelos/`). En el VPS nativo la configuración
vive **solo** en `/etc/anfitorio/api.env` (root:anfitorio 640); no crees
`hotelos/.env` en el servidor (el loader del worker lo prioriza sobre systemd).

Rol `production-native` (systemd + Caddy) — mínimas:

| Variable | Valor | Por qué |
|---|---|---|
| `NODE_ENV` | `production` | RBAC estricto por defecto, modo demo prohibido, claves validadas |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Solo Caddy llega al API |
| `TRUST_PROXY` | `1` | El rate limit ve la IP real detrás de Caddy |
| `DATABASE_URL` | `postgresql://anfitorio:<pass>@localhost:5432/anfitorio` | |
| `JWT_SECRET` | `openssl rand -base64 48` | Nunca `change-me` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` (32 bytes) | Cifrado PII; rotarla deja ilegible lo cifrado: backup antes |
| `APP_BASE_URL` | `https://<dominio>` | Enlaces de invitación/reset; de aquí se deriva `VITE_API_URL` |
| `API_PUBLIC_URL` / `VITE_API_URL` | `https://<dominio>/api` | Origen público del API; `VITE_API_URL` se hornea en el build del front (`APP_PUBLIC_API_URL` está retirada) |
| `CORS_ALLOWED_ORIGINS` | `https://<dominio>` | Lista separada por comas (`PILOT_PUBLIC_ORIGIN` es alias antiguo) |
| `RUN_SCHEDULERS` | `true` (solo en el API) | El worker lo fuerza a `false` |
| `RBAC_STRICT` | `true` | Documental: ya es el default en producción |
| `HOTELOS_ALLOW_DEMO_AUTH` | ausente o `false` | Con `true` el API se niega a arrancar en producción |
| `VERIFACTU_MODE` / `SES_HOSPEDAJES_MODE` | `sandbox` hasta tener certificados | Fuera de sandbox el bloque `VERIFACTU_SOFTWARE_*` es obligatorio |
| `SMOKE_EMAIL` / `SMOKE_PASSWORD` / `SMOKE_PROPERTY_ID` | usuario de lectura para `smoke.sh` | Demo: `reception@example.com` / `hotelos-demo` / `prop_123` |
| `BOOTSTRAP_TOKEN` | `openssl rand -hex 32` solo en `--real` | Se autodesactiva al crear la primera organización |

Rol `compose` (`deploy/docker-compose.production.yml`): `deploy/.env.production`
según `deploy/.env.production.example` (`DOMAIN`, `PUBLIC_API_URL`,
`POSTGRES_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`, …). Ojo: el compose solo
reenvía al contenedor las variables de su bloque `environment:`.

Validación: `node scripts/validate-env.mjs /etc/anfitorio/api.env --role production-native`
(si tu revisión de `validate-env.mjs` aún no acepta `--role`, usa `--production`;
`deploy.sh` detecta cuál aplica).

## 3. Instalación desde cero

```bash
ssh root@<vps>
apt-get install -y git
git clone https://github.com/cesareme/hotelos.git /opt/anfitorio
cd /opt/anfitorio/hotelos          # repo anidado: el código vive en hotelos/
sudo bash deploy/scripts/install-from-scratch.sh --demo --domain demo.hotelos.es --yes
```

Modo `--real` (hotel real, sin datos ficticios):

```bash
sudo bash deploy/scripts/install-from-scratch.sh --real --domain pms.hotel-ejemplo.es
```

El script es idempotente y hace, en orden: paquetes apt → Node 22 + corepack
pnpm 9.15.0 → usuario de sistema `anfitorio` → rol/BD Postgres → clone/update
→ `pnpm install --frozen-lockfile` → `/etc/anfitorio/api.env` desde
`.env.example` con secretos `openssl` → `validate-env` → `db:generate` →
`db:adopt-baseline -- --apply` + `db:migrate:deploy` + `db:drift:check` →
datos (`--demo`: seed base + commercial + snapshots + compliance + operations
+ cancellation + allotments + fnb + `rbac:sync`; `--real`: solo `rbac:sync` y
te imprime la llamada `POST /onboarding/bootstrap`) → build de admin-web con
`VITE_API_URL=https://<dominio>/api` publicado en `/srv/anfitorio/admin-web`
→ unidades systemd → Caddy → `smoke.sh`.

Opciones útiles: `--app-dir` (alias `--dir`; mismo nombre que en
`vps-inventory.sh`), `--user`, `--db-name/--db-user`, `--web-root`,
`--branch`, `--no-caddy`, `--no-worker`, `--skip-smoke`, `--acme-email`.

### Primer arranque en modo `--real`

`POST /onboarding/bootstrap` crea organización + propiedad + primer
administrador + rol Owner; exige `bootstrapToken` = `BOOTSTRAP_TOKEN` del env y
solo funciona mientras no exista ninguna organización. Ejemplo:

```bash
curl -fsS -X POST https://pms.hotel-ejemplo.es/api/onboarding/bootstrap \
  -H 'content-type: application/json' -d '{
  "bootstrapToken": "<BOOTSTRAP_TOKEN>",
  "organization": { "name": "Hotel Ejemplo SL", "taxId": "B12345678", "country": "ES" },
  "property": { "name": "Hotel Ejemplo", "province": "Madrid", "postalCode": "28001", "timezone": "Europe/Madrid" },
  "adminUser": { "email": "admin@hotel-ejemplo.es", "password": "<contraseña fuerte>", "fullName": "Administración" }
}'
```

El resto del equipo entra por invitación (`user_invitations`,
`/accept-invite`). Después añade `SMOKE_EMAIL`/`SMOKE_PASSWORD` a
`/etc/anfitorio/api.env` con un usuario de solo lectura.

## 4. Adopción de un VPS existente (desplegado a mano)

1. **Inventario, sin tocar nada**
   `bash deploy/scripts/vps-inventory.sh --app-dir /opt/anfitorio --domain demo.hotelos.es`
   (`/opt/anfitorio` es el default de los scripts; pasa `--app-dir` si el clon
   vive en otra ruta, p. ej. el antiguo `/opt/hotelos`).
   (o `install-from-scratch.sh --adopt`, que además imprime el plan).
   Comprueba: unidad systemd real (`ExecStart` tsx vs dist, `EnvironmentFile`),
   clon y commit, `node -v`/`corepack pnpm -v`, claves del `.env` (solo
   nombres), `_prisma_migrations`, nº de tablas, Caddyfile, dist horneado, puertos.
2. **Backup**: `pg_dump --dbname="$DATABASE_URL" -Fc -f /var/backups/anfitorio/pre-adopcion.pgcustom`.
3. **Entorno en un solo sitio**: crea `/etc/anfitorio/api.env` a partir del
   `.env` actual + las claves del rol `production-native` (sección 2); elimina
   `hotelos/.env` del clon. `node scripts/validate-env.mjs /etc/anfitorio/api.env --role production-native`.
4. **Código**: `git fetch && git reset --hard origin/main`, `corepack pnpm install --frozen-lockfile`, `corepack pnpm --filter @hotelos/database db:generate`.
5. **Esquema**:
   - Si el esquema del servidor es **anterior** a la baseline (faltan tablas o
     columnas de Tandas 2-3, caso del demo público), `db:adopt-baseline` se
     niega. **No se usa `db push` en una BD compartida** (ninguna excepción):
     alinea el esquema restaurando un dump ya alineado con la baseline, o crea
     una BD vacía, aplica la baseline con `corepack pnpm db:migrate:deploy` y
     vuelca los datos con `pg_restore --data-only` revisado (backup previo,
     ensayo en una BD de prueba). Después repite adopt → migrate → drift.
   - `corepack pnpm db:adopt-baseline` (plan) → `corepack pnpm db:adopt-baseline -- --apply`
     → `corepack pnpm db:migrate:deploy` → `corepack pnpm db:drift:check` (exit 0).
6. **Servicios**: copia `deploy/systemd/*.service` (ajusta `WorkingDirectory`
   al clon real) y `deploy/caddy/Caddyfile.native` (dominio y `root`), `systemctl daemon-reload && systemctl enable --now anfitorio-api anfitorio-worker`, `caddy validate && systemctl reload caddy`.
7. **Front**: `VITE_API_URL=https://<dominio>/api corepack pnpm --filter @hotelos/admin-web build && rsync -a --delete apps/admin-web/dist/ /srv/anfitorio/admin-web/`.
8. **Smoke** (sección 6). Desde aquí cada actualización es `deploy.sh`.

## 5. Actualización (deploy)

```bash
cd /opt/anfitorio/hotelos
sudo -u anfitorio bash deploy/scripts/deploy.sh --pull --yes          # nativo
bash deploy/scripts/deploy.sh --role compose --pull --yes             # Docker
```

Pasos (todos idempotentes; `--skip-X` / `--only-X`; `--dry-run` imprime sin
ejecutar): `pull` (solo con `--pull`, aborta si hay cambios locales) → `env`
(validate-env + carga) → `install` → `generate` → `backup` (pg_dump en
`/var/backups/anfitorio`, 14 días) → `adopt` → `migrate` (+ drift check) →
`rbac` (informe `--dry-run`; el arranque del API sincroniza el catálogo) →
`backfills` (**solo** con `--with-backfills`: `backfill:payment-hash`,
`backfill:taxes`, `backfill:guest-register` con `--apply`; `backfill:snapshots`
si defines `BACKFILL_FROM`/`BACKFILL_TO`) → `web` (build + rsync a `WEB_ROOT`;
falla si el bundle no contiene `VITE_API_URL`) → `restart` (`systemctl restart
anfitorio-api anfitorio-worker` y espera a `/health`) → `smoke`.

`rbac:sync -- --prune` (borra claves obsoletas y sus grants) queda fuera del
script a propósito: manual, tras backup.

GitHub Actions: `deploy.yml` (raíz git) hace lo mismo por SSH
(`workflow_dispatch`, o automático tras CI verde si la variable `AUTO_DEPLOY`
es `true`). Secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`; variable `APP_DIR`.

## 6. Smoke

```bash
bash deploy/scripts/smoke.sh --base-url https://demo.hotelos.es/api --web-url https://demo.hotelos.es \
  --web-dist /srv/anfitorio/admin-web --email reception@example.com --password hotelos-demo
```

Comprueba: `/health` (`ok=true`, `checks.database.ok=true`), `/properties` sin
token → **401** (modo demo desactivado), `POST /auth/login` → token,
`/properties` autenticado (lista no vacía), `/properties/:id/dashboard` → 200,
`/backoffice/properties/:id/readiness` → 200, `index.html` 200 con
`id="root"` y `Cache-Control: no-store`, `/accept-invite` y `/reset-password`
sirven la SPA, y `dist/assets/*.js` contiene la URL horneada y no
`http://localhost:3000`. Exit 0/1; `--json` para monitorización. Solo
necesita `curl` y `node`. Úsalo también como cron de vigilancia (UptimeRobot
solo cubre `/health`).

## 7. Backup y restauración

- Automático antes de cada deploy: `deploy.sh` → `/var/backups/anfitorio/anfitorio-<fecha>.pgcustom` (rotación `BACKUP_KEEP_DAYS`, 14).
- Nocturno: cron con `pg_dump --dbname="$DATABASE_URL" -Fc -f ...` o
  `scripts/backup-postgres.sh` (cifrado + S3, requiere `/opt/hotelos/.env.backup`).
- Restaurar en una BD de prueba (nunca directamente sobre producción):
  ```bash
  createdb anfitorio_restore && pg_restore -d anfitorio_restore --no-owner /var/backups/anfitorio/anfitorio-<fecha>.pgcustom
  DATABASE_URL=postgresql://anfitorio:<pass>@localhost:5432/anfitorio_restore corepack pnpm db:drift:check
  ```
  Ensayo completo: `scripts/test-backup-restore-cycle.sh` (mensual). Un
  dump restaurado conserva `_prisma_migrations`; si procede de antes del
  squash, `db:adopt-baseline -- --apply` lo adopta.
- **Dumps anteriores a la baseline** (p. ej.
  `backups/hotelos-pre-tanda4-20260914-185325.dump`, tomado de una BD nacida
  con `db push`): **no contienen `_prisma_migrations`**. Tras un `pg_restore`
  de uno de ellos ejecuta `corepack pnpm db:adopt-baseline -- --apply`
  **antes** de cualquier `db:migrate:deploy`; si no, la baseline intenta
  recrear las 251 tablas ya existentes y falla (`P3009` / «ya existe»),
  dejando la migración marcada como fallida en `_prisma_migrations`.
- Rotar `ENCRYPTION_KEY` invalida la PII cifrada: backup y plan de re-cifrado
  antes.

## 8. Modo demo vs modo real

| | `--demo` | `--real` |
|---|---|---|
| Datos | org_123 / prop_123 (Faranda), reservas, facturas, snapshots, F&B… | Ninguno |
| Usuario inicial | `reception@example.com` / `hotelos-demo` (215 permisos: prune de Tanda 4 más `folio.read`, `pos.read` y `tourist_tax.read` de Tanda 5, credencial pública) | Creado por `POST /onboarding/bootstrap`; resto por invitación |
| `HOTELOS_ALLOW_DEMO_AUTH` | `false` (el smoke exige 401 sin token) | `false` |
| `BOOTSTRAP_TOKEN` | vacío | generado; se autodesactiva tras la primera organización |
| Uso | demo pública, formación, QA | cualquier hotel con datos reales |

Nunca ejecutes los seeds demo en una instalación real: crean un super-admin
con contraseña conocida.

## 9. Checklist para el VPS demo 76.13.55.180 (demo.hotelos.es) cuando haya acceso

Nada del despliegue actual de esa máquina está versionado; lo que se sabe
(usuario `anfitorio`, Caddy nativo, `anfitorio-api` en systemd, build viejo
anterior a Tandas 0-3, esquema anterior) procede de la memoria del proyecto.
Orden estricto — un `git pull` sin migrar tumba el API público:

1. `bash deploy/scripts/vps-inventory.sh --domain demo.hotelos.es` (solo lectura) y guardar la salida.
2. Autorizar la clave SSH del Mac; comprobar `sudo -n systemctl restart anfitorio-api` para el usuario de deploy.
3. `pg_dump` completo a `/var/backups/anfitorio/` **y** copia al Mac. Si más
   adelante se restaura ese dump (anterior a la baseline, sin
   `_prisma_migrations`): `db:adopt-baseline -- --apply` **antes** de
   `db:migrate:deploy` (sección 7).
4. `/etc/anfitorio/api.env` con las claves de la sección 2 (reutilizando los secretos actuales: cambiar `JWT_SECRET` cierra todas las sesiones, cambiar `ENCRYPTION_KEY` rompe la PII).
5. `git fetch && git reset --hard origin/main`, `corepack pnpm install --frozen-lockfile`, `db:generate`.
6. Esquema: `db:adopt-baseline -- --apply` → `db:migrate:deploy` → `db:drift:check` = 0. Si adopt-baseline se niega porque el esquema es anterior a la baseline, alinear según la sección 4.5 (dump alineado o BD nueva + `migrate deploy` + `pg_restore --data-only`); **nunca `db push`** en esa BD.
7. `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run`; backfills con `deploy.sh --with-backfills` solo tras revisar el informe dry-run de cada uno.
8. Build del front con `VITE_API_URL=https://demo.hotelos.es/api` → `/srv/anfitorio/admin-web`.
9. Instalar las unidades y el Caddyfile versionados; `systemctl restart anfitorio-api anfitorio-worker`; `systemctl reload caddy`.
10. `smoke.sh` con `reception@example.com` (y sin `HOTELOS_ALLOW_DEMO_AUTH`: preferible usuario demo real a modo demo sin token; si se mantiene el modo demo, exige `HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true` y el smoke fallará en el 401 por diseño).
11. Activar `deploy.yml` (secrets) solo cuando el paso 10 esté verde dos veces.

## 10. Vía Docker (secundaria)

`deploy/docker-compose.production.yml` con los Dockerfiles de `deploy/`
(corepack pnpm 9.15.0, `--frozen-lockfile`, `db:generate`, `CMD node --import
tsx …`). `bash deploy/scripts/deploy.sh --role compose` ejecuta los pasos de
BD dentro del contenedor `api`. Los antiguos `infra/docker/*` (npm) e
`infra/ci/github-actions.yml` se han eliminado. Pendiente conocido: el
`environment:` del compose no reenvía `APP_BASE_URL`, `EMAIL_*`,
`HOTELOS_FIELD_KEY` ni `VERIFACTU_CERT_*`; amplíalo (o usa `env_file:`) antes
de usar esa vía con invitaciones o VeriFactu fuera de sandbox.

## 11. Qué NO usar

- `npm install` / `npm --workspace` / `npx` sobre este monorepo.
- `prisma db push` en cualquier BD compartida (dev VPS, demo VPS, piloto,
  producción): sin excepciones. Solo en BD locales desechables.
- `pnpm install --prod` (elimina `tsx` y `prisma`; el runtime deja de arrancar).
- `hotelos/.env` en un servidor con systemd.
- `HOTELOS_ALLOW_DEMO_AUTH=true` fuera de una demo pública sin datos reales.
- Los playbooks antiguos (`README-HOSTINGER.md`, `README-REMOTE-DEV.md`,
  `docs/deploy-pilot.md`, `docs/deployment.md`): describen Docker con npm y
  `db push`; se conservan solo como histórico.
