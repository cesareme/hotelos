# CLAUDE.md · Auto-context for Claude Code

Este archivo se carga automáticamente cuando arrancas `claude` desde la
raíz del repo. Sirve como "manual del proyecto" para que cualquier nueva
sesión de Claude tenga contexto completo sin que el usuario lo explique.

---

## Identidad del usuario

César (cesareme en GitHub · yakutatsa@gmail.com). Empresa: HotelOS.
Trabaja en español. Prefiere tono directo, profesional sin emojis
excesivos. Mac Pro como ÚNICA máquina (casa y viaje — el MacBook Neo se
retiró). VPS Hostinger como entorno dev remoto: el código, la BD y los
secretos viven en el VPS, así que viajar con el Pro no añade riesgo de
perder trabajo.

## Producto

HotelOS · monorepo PMS+ERP nativo español con IA. Compite con Mews,
Cloudbeds, Stayntouch — pero con compliance ES profundo de fábrica
(VeriFactu, SES Hospedajes, TBAI multi-foral, IGIC, ESRS) y agentes IA
integrados.

NOTA estructura: el código real vive bajo `/hotelos/` (subdirectorio
extra heredado del primer commit · pendiente de aplanar). Si escribes
paths para CI o referencias, recuerda el prefijo.

## Marca y despliegue (decisión 2026-06-21)

- **Nombre de marca elegido: `Anfitorio`** (raíz clásica de *anfitrión* /
  Amphitryon = el anfitrión; neutro, no nacionalista español). Dominios
  `anfitorio.com` (✅ libre, RDAP) + `anfitorio.es` (probable libre). El
  rebrand *HotelOS → Anfitorio* en código/UI está **HECHO** (Fase 0): 81 strings
  de admin-web + index.html + nombres demo. Fuente única en
  `apps/admin-web/src/config/brand.ts`. Preservados a propósito los identificadores
  `HotelOSTokens`/`HotelOSFlowTokens` y el header `X-HotelOS-Idempotency`. El
  paquete sigue siendo `@hotelos` (no visible).
- **Demo en producción · PENDIENTE de DNS**: el plan es servir
  `https://demo.anfitorio.es` desde el VPS con **Caddy** (HTTPS Let's Encrypt)
  sirviendo el build de admin-web + reverse-proxy de la API en el mismo origen
  (VITE_API_URL al mismo dominio → sin problema de `localhost`/CORS). Pasos:
  registrar dominios en Hostinger → registro DNS `A demo → 72.61.194.216` →
  montar Caddy + build + abrir 80/443 + probar. Hoy la app corre en modo dev
  (vite :5173 + API :3000) y solo es accesible por túnel SSH.
- **VPS** (72.61.194.216): acceso por **clave SSH** ya autorizado para `root`
  y `cesareme` (alias `hotelos-dev`). App en tmux sesión `dev`. Credenciales
  demo: `reception@example.com` / `hotelos-demo`.

## Métricas (a 2026-05-31)

- 389 archivos / ~108k LOC / 202 pantallas en admin-web (React 19 + Vite)
- 202 archivos / ~72k LOC / 772 endpoints en api (Fastify + Prisma)
- 250 modelos Prisma
- 64 componentes Cocoa Edition v3.0 (estética macOS nativo)
- 27 workflows multi-agente orquestados durante el desarrollo
- 239 tareas cerradas

## Áreas funcionales

### Front-end (apps/admin-web)

- `src/screens/` — 202 pantallas organizadas por dominio (operations,
  reservations, billing, compliance, revenue, channelManager, ai,
  admin, …)
- `src/components/cocoa/` + cocoa-extras + cocoa-global + cocoa-guidance
  + cocoa-director + cocoa-rate-grid + cocoa-sidebar-v2 + cocoa-icons +
  cocoa-illustrations + cocoa-empty-state — 64 componentes del design
  system
- `src/components/v2/` — componentes legacy en transición
- `src/content/` — copy i18n-ready (mayoría es-ES hoy)
- `src/utils/toArray.ts` — helper defensive para coaccionar respuestas
  API a array tipado. Usa SIEMPRE este helper para `data` de
  `useApiData`.
- `src/navigation/Sidebar.tsx` — fuente de verdad del menú lateral

### Back-end (apps/api)

- `src/server.ts` — único entrypoint, 772 endpoints (en migración
  progresiva a módulos en `src/modules/`)
- `src/modules/` — bounded contexts ya extraídos (admin-console,
  rate-manager, audit, …)
- `src/security/route-permissions.ts` — matriz de permisos RBAC
- Schedulers integrados: SES (5min), pace (daily), allotment release
  (daily), group cutoff (daily), mailbox poll (5min), VeriFactu queue

### Compliance ES (packages/compliance/src)

- `spain/` — SES Hospedajes, parte de viajeros, VeriFactu
- `id-scan-policy.ts`, `guest-register.ts`, `invoice-policy.ts`,
  `retention-policy.ts`, `risk-matrix.ts`
- TBAI foral (Bizkaia/Gipuzkoa/Álava/Navarra) + IGIC + ESRS

### OTAs e integraciones (packages/integrations/src)

- `channel-manager.ts` — **deprecado (rate grid v2, 2026-09-14)**: agregador
  v1 con 5 adapters mock (`booking_com_mock`, `expedia_mock`,
  `google_hotels_mock`, `direct_booking_engine`, `manual_channel`); se
  conserva solo para los tableros demo. La conectividad real (Booking OTA
  XML, Expedia EQC, Channex; outbox `ChannelDelivery` y drenaje) vive en
  `apps/api/src/modules/channel-manager` (Deuda 13,
  `docs/channel-manager-connectivity.md`).
- `messaging.ts` — WhatsApp Business + Email + SMS
- `bank-reconciliation.ts` — CSB-43 + SEPA Norma 19
- `einvoice.ts` + `ses-hospedajes.ts`

## Sistema de calidad (NO toques sin razón)

Pre-commit hook activo en `.husky/pre-commit`:

1. `node scripts/check-discoverability.mjs` (corre 3 sub-checks):
   - `check-sidebar-coverage.mjs` — orphan screens
   - `check-route-validity.mjs` — broken sidebar links
   - `check-placeholder-budget.mjs` — cap 80 placeholders
2. `node scripts/typecheck-all.mjs` (alias `pnpm typecheck:all`) — typecheck de TODOS
   los workspaces (Tanda 4; fallos conocidos listados en KNOWN_FAILURES del script
   con motivo, nunca en silencio)

Gates fuera del hook (CI raíz `/.github/workflows/ci.yml`, `working-directory: hotelos`):
`pnpm test` (contratos, sin BD) · `pnpm test:unit` (unitarios de apps/api, 500+) ·
`pnpm test:integration` (app.inject sobre Postgres) · `pnpm validate:env` ·
`node scripts/env-census.mjs` (alias `pnpm env:census`; `pnpm env:census:write` =
`--write`, regenera `.env.example` y el contrato) · `pnpm db:migrations:check` ·
fresh-install en BD temporal.

Estado verificado (cierre Tanda 4, 2026-09-14):
- 190 screens alcanzables · 0 broken links · placeholders bajo budget
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web: sin
  `@types/react`, ~266 errores preexistentes; añadirla exige regenerar el lockfile)
- contratos 281/281 · unitarios api 504/504 · integración 31/31 · env 135/135

Estado verificado (cierre Rate Grid v2, 2026-09-15, integrador final):
- 190 screens alcanzables · 0 broken links · placeholders 71/80
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · `.husky/pre-commit` OK
- contratos 293/293 · unitarios api 815 (814 pass · 1 skipped) · integración 80/80 · env 128/128
- migraciones 3/3 aplicadas en local (`migrate status` al día, drift 0); (histórico,
  14/09) los API :3000/:3400 siguen sirviendo el código anterior hasta que el
  integrador humano los reinicie — hoy (15/09/2026) sirven el working tree completo
  tras dos reinicios, y las correcciones de pantalla de los lotes finales se
  verificaron en navegador en el recorrido final (informe de cierre §6.5)

Estado verificado (cierre documental final Rate Grid v2, 2026-09-15, tras el
reinicio de :3000/:3400 y los lotes de corrección finales):
- :3000/:3400 reiniciados dos veces el 2026-09-15 (tras el cierre y tras los
  lotes finales): sirven el working tree completo; integración 80/80 tras el
  primer reinicio (no repetida tras los lotes finales: pendiente antes del commit)
- 190 screens alcanzables · 0 broken links · placeholders 71/80
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web)
- contratos 293/293 · unitarios api 840 (839 pass · 1 skipped) · env 128/128
- recorrido en navegador como Carmen y sonda del API tras el reinicio: 19
  hallazgos (BUX-01..14, ALF-1..5): 16 corregidos (BUX-07 y ALF-4 parciales),
  1 nota de comportamiento (ALF-5), 1 atribuido al driver (BUX-05), 1 abierto
  (ALF-1); las correcciones de pantalla se verificaron en navegador el
  15/09/2026 (recorrido final, `docs/audits/RATE-GRID-V2-CIERRE-2026-09-15.md`
  §6.5); solo BUX-05 sigue pendiente por exigir teclado físico

Estado verificado (cierre Tanda 6 · Finanzas backend, 2026-09-16, integrador
final; working tree sin commit, :3000/:5173 sin reiniciar):
- 200 screens alcanzables · 167/167 URLs · 0 broken links · placeholders 16/20
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · `.husky/pre-commit` OK
- contratos 410/410 · unitarios api 1.220 (1.219 pass · 1 skipped) · integración
  194 (189 pass · 5 skipped preexistentes · 0 fail) · env 136/136 · validate-env OK
- migraciones 5/5 aplicadas (`migrate status` al día, drift 0, migrations↔schema
  264 tablas / 24 enums) · fresh-install OK (264 tablas, 79 permisos, 4 s) ·
  `install --frozen-lockfile --offline` al día (deuda 12(a) cerrada por el
  lockfile regenerado con `install --offline` al declarar `qrcode-terminal`)
- `rbac:sync -- --dry-run`: catálogo 221 · +0 · 8 roles por completar (no aplicado)

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

## Servicios en local Mac Pro

- Postgres 16 brew · puerto 5432 · DB hotelos / user hotelos / pass
  hotelos
- Redis 7 · puerto 6379
- API · puerto 3000 (NO 4000)
- admin-web Vite dev server · puerto 5173

## Servicios en VPS Hostinger (dev box)

- Ubuntu 24.04 LTS fresh
- Acceso SSH key-only (sin password) como user `cesareme`
- Bootstrap: `deploy/scripts/bootstrap-dev-vps.sh`
- Repo clonado en `/home/cesareme/projects/hotelos/hotelos`

## Comandos frecuentes

```bash
# IMPORTANTE: el proyecto usa pnpm (pnpm-lock.yaml v9 + workspace:*).
# NUNCA npm install (rompe con EUNSUPPORTEDPROTOCOL 'workspace:').

# Levantar dev
cd /home/cesareme/projects/hotelos/hotelos
pnpm install
pnpm db:generate            # prisma generate (atajo root)
pnpm db:migrate:deploy      # aplica migraciones versionadas (BD nueva: crea las 251 tablas)
pnpm db:adopt-baseline -- --apply   # SOLO BD anterior al squash 2026-09-14 (creada con db push):
                            # registra la baseline como aplicada; dry-run sin --apply
pnpm db:drift:check         # exit 0 = BD == schema.prisma (tras deploy/adopción)
# Cambio de schema: pnpm --filter @hotelos/database db:migrate -- --name <cambio> y commit
# de packages/database/prisma/migrations/<carpeta>. NUNCA db push en BD compartidas
# (db:push solo para prototipar en local). pnpm db:install:check prueba la instalación
# desde cero en una BD temporal; pnpm db:migrations:check compara migraciones↔schema sin BD.
tmux new -s dev
# pane 1: pnpm dev:api       (API en :3000)
# pane 2: pnpm dev:web       (admin-web en :5173)

# Seed demo data (ORDEN: base primero, luego avanzados)
cd packages/database && node --env-file=../../.env --import tsx prisma/seed.ts && cd ../..
pnpm db:seed:commercial     # añade room types, rooms, tarifas sobre prop_123

# Contrato de entorno (Tanda 4): validar un .env y regenerar .env.example tras añadir variables
node scripts/validate-env.mjs .env --role app
node scripts/env-census.mjs --write

# Verificación completa antes de commit
bash .husky/pre-commit
pnpm test && pnpm test:unit && pnpm test:integration   # contratos + unitarios api + app.inject (BD)
# En esta shell del Mac solo existe «corepack pnpm»; los scripts raíz encadenan «pnpm» a pelo,
# así que usa el equivalente: corepack pnpm --filter @hotelos/api test (unitarios), etc.

# Discoverability check standalone
node scripts/check-discoverability.mjs
```

## Seeds

Doce seeds, tres ámbitos. Todos los parametrizables pasan por el guard
`packages/database/prisma/lib/demo-guard.ts` (`assertDemoTarget`): la allowlist
demo es `org_123` / `prop_123` / `prop_canary`; cualquier otro objetivo exige
`SEED_ALLOW_REAL=1` **y** `SEED_CONFIRM=<id exacto[,id]>` o el seed corta con
exit 2 tras imprimir los `deleteMany` previstos, sin tocar la BD. El contract
test `tests/demo-seed-contract.test.mjs` exige `assertDemoTarget(` en cada uno.

Orden para un dataset demo desde cero (todos desde `packages/database`, con
`node --env-file=../../.env --import tsx prisma/<seed>.ts` o el script pnpm):

1. `prisma/seed.ts` — base: org_123 (NIF válido B12345674), prop_123 /
   prop_canary, usr_123 + Local Super Admin, impuestos IVA/IGIC, edificio,
   rt_double + room_108/room_432, guest_maria, RES-18392 (llega **hoy+1**,
   sale hoy+3: fechas relativas), folio/pago, HK, work order, activo, IA.
   Idempotente: upserts por id fijo y `DEMO_SEED_READY` una sola vez
   (encadenado al tip del trail si ya hay eventos).
2. `db:seed:commercial` — prop_123 (`SEED_PROPERTY_ID`): 4 tipos DBL/SUP/JRS/STE,
   hasta 48 rooms, BAR hoy−45→+120, reservas RVNX-*, forecasts, comp-set
   (solo borra los 3 competidores que crea), budgets, segmentos, reglas,
   recomendaciones. Nunca re-tipa una habitación con reservas.
   `SEED_SCOPE=rates` + `SEED_BAR_PRICES='{"DBL":105}'` (+ `SEED_RATE_DAYS_BACK`
   / `SEED_RATE_DAYS_AHEAD`) solo reescribe la parrilla BAR del plan existente.
3. `db:seed:snapshots` — org_123 (`SEED_ORG_ID`), 430 días de
   `revenue_daily_snapshots` con `dataSource='demo'`; solo borra filas demo,
   respeta cierres `night_audit` y días ya cerrados; no crea habitaciones salvo
   propiedad demo con 0 rooms y `SEED_CREATE_ROOMS=1` (si no, «sin inventario»).
4. `db:seed:compliance` 5. `db:seed:operations` (`opseed_*`) 6. `db:seed:cancellation`
   7. `db:seed:allotments` (`SEED-*`) 8. `db:seed:fnb` — todos sobre `SEED_PROPERTY_ID`
   (default prop_123), idempotentes por prefijo/upsert.
9. `pnpm --filter @hotelos/api rbac:sync` tras cualquier cambio de PERMISSIONS.

Opcional y SOLO demo: `packages/database/seeds/demo-pre-demo-enrichment.mjs`
(25 reservas PREENR-* por propiedad) itera únicamente la allowlist (+ ids
confirmados con `SEED_ALLOW_REAL`/`SEED_CONFIRM`; `SEED_PROPERTY_ID` limita a
una). Se ejecuta SOLO con `corepack pnpm --filter @hotelos/database db:seed:enrich`
(tsx obligatorio y cwd `packages/database`: `@hotelos/database` solo resuelve
por los paths del tsconfig; `node` a pelo desde la raíz falla con
ERR_MODULE_NOT_FOUND). `apps/api/src/seeds/chain-8-hotels.ts` /
`chain-reservations.ts` son el dataset piloto Iberia (`org_chain_iberia`):
no mezclar con el demo.

Refresco del demo (Tanda 4): `pnpm --filter @hotelos/api demo:refresh`
(`src/scripts/refresh-demo-dataset.ts`, dry-run por defecto, `--apply`,
`--scope audit-orgs|faranda|org123|all`, `--exclude-after <ISO>`, `--json`)
borra las orgs AUDIT completas, los residuos AUDIT de Faranda/org_123 (las
reservas con factura VeriFactu o SES se conservan: check-out / cancelación
por servicio), desplaza las reservas del walkthrough vencidas a [hoy+1,
hoy+30], libera la 501 y resiembra BAR/snapshots solo si faltan. Tablas
PROTEGIDAS (assert en código): `audit_events`, `event_stream`, facturas con
`verifactu_hash`, `verifactu_submissions`, `ses_hospedajes_submissions`,
series FAC/REC. `demo:fix-identity` (`--apply --confirm <orgId>`) corrige la
razón social / NIF de Faranda y el NIF de org_123 vía Prisma. Backup antes
de `--apply` y reinicio del API después (espejos in-memory). Plan e
inventario: `docs/audits/DEMO-DATASET-2026-09-14.md`.

**Residuos esperados tras una limpieza:** `audit_events` y `event_stream` son
cadenas hash GLOBALES (un solo génesis, enlaces que cruzan organizaciones):
nunca se borra trail, así que ids de organización, propiedad o usuario
huérfanos en esas dos tablas son normales y no un bug. Las facturas
FAC-2026-000001…, REC-2026-… de Faranda y prop_123/prop_canary son documentos
de prueba en sandbox (stub VeriFactu) con emisor histórico «AUDIT-T1 SL»:
snapshots inmutables, no se corrigen ni se borran.

Piloto real · segunda propiedad de Faranda (Los Tilos, 2026-09-14;
**provisionada e importada** ese día: propertyId `cmu1mifcp0000fyo1wzvq7txo`,
409 snapshots + 48 forecasts `pms_import:opera_hf_2026-09-14`, 1460 rate_days
BAR de referencia, readiness `ready` con SES/VeriFactu desactivados):
`corepack pnpm --filter @hotelos/api pilot:provision-property -- --spec
src/scripts/specs/faranda-los-tilos.json` (dry-run por defecto, `--apply
--confirm <orgId>`, `--help`; nunca crea ni toca `organizations`/usuarios;
idempotente: converge por claves naturales, habitaciones por `number`) crea una
propiedad con todos sus satélites dentro de una org existente; **reiniciar
el API** después (espejos in-memory) y solo entonces `corepack pnpm --filter
@hotelos/api import:pms-history-forecast -- --file <csv> --property <id>
--rooms 92 --source opera_hf_2026-09-14 --publish-bar BAR` (dry-run por
defecto, `--apply --confirm <propertyId>`, `--revert` por source, `--force`
solo para pisar otro origen, `--help`) carga el History & Forecast del PMS:
historia → `revenue_daily_snapshots` top-level con `dataSource
pms_import:<source>`, forecast → `revenue_forecasts` con `modelVersion
pms_import:<source>` (`expectedRoomsSold` = `totalOcc` del PMS **con** house
use, igual que el snapshot; el ADR del PMS va explícito); el scheduler
nocturno, `backfill:snapshots` y `generateForecasts` no pisan `pms_import:*`
ni escriben en propiedades sin reservas. Avisos: backup antes de cada
`--apply` y ejecutar los CLI con los API parados (cadena de auditoría
in-memory, deuda 12(c)); el CSV real vive fuera del repo en
`/Users/cfernandez/anfitorio-demo/pilots/<hotel>/` (`/pilots/` en el
`.gitignore` de la raíz, anclado para no ignorar `docs/pilots/`); nunca
`backfill:snapshots --force` sobre un hotel importado; la propiedad nace sin
reservas (recepción vacía a propósito), sin SES/VeriFactu y con reparto de
habitaciones ESTIMADO. Ficha, mapeo y procedimiento:
`docs/pilots/FARANDA-LOS-TILOS-2026-09-14.md`; runbook:
`docs/runbooks/pms-history-forecast-import.md`.

## Convenciones

- **Comentarios y código**: inglés. **Strings UI y commits**: español
  está bien también.
- **Commits**: conventional commits — `chore:`, `feat:`, `fix:`,
  `refactor:`, `docs:`, `chore(deploy):`, etc.
- **Pre-commit NUNCA se salta** con `--no-verify`.
- **Pre-commit hook**: si typecheck o discoverability fallan, **se
  arregla el problema, no se desactiva el check**.
- **Workflows multi-agente** para tareas grandes (>5 archivos, >2
  módulos). Para ediciones puntuales, edits inline directos.
- **Antes de cambios grandes**: lee con Read/Grep/find, sintetiza el
  plan, luego ejecuta.
- **Antes de declarar algo "hecho"**: verifica con typecheck +
  pre-commit hook + comprobación manual.
- **Catch honesto (QC-06)**: un `catch` en jobs/schedulers o en el
  money-path (folio, cobros, facturación, night audit) loguea con
  correlación (entidad + correlationId) y devuelve contadores
  (`failed[]`), nunca traga en silencio; solo se tolera un error tipado
  concreto (p.ej. «ya decidida»), el resto se relanza. Los fallbacks de
  KPI (`.catch(() => 0 | [] | null)`) pasan por `safe()` de
  `apps/api/src/lib/degraded.ts` y marcan `degraded[]` en el payload
  para que la UI muestre «—» en vez de un cero verde.

## Deuda técnica conocida

1. Estructura del repo con subdir extra `/hotelos/` — aplanar con
   `git mv` + force push. Bajo riesgo (solo cesareme tiene acceso).
2. 75 placeholders en sidebar — roadmap trimestral en
   `check-placeholder-budget.mjs`.
3. `CocoaSidebarV2` construido pero desactivado
   (`USE_SIDEBAR_V2=false` en `BackOfficeLayout.tsx`). Catálogo V2 no
   tiene feature parity con `backOfficeNavigationGroups` aún.
4. ~24% de screens son parciales (CRM campaigns, Loyalty avanzado,
   ESG/ESRS reporting completo, AI Operations Agents/Audit/Costs,
   Marketplace público).
5. Endpoints TODO: Compliance Exports Hub, Modules Manager.
6. E2E tests son TODO (Playwright no montado). Sí hay tests de integración
   reales con `app.inject` (`pnpm test:integration`, audit #8) además de los
   contract tests readFileSync.
7. **OTAs (audit #11) — CERRADA por Rate Grid v2 (deuda 13):** adaptadores
   Booking OTA XML, Expedia EQC y Channex «contract-ready» contra el simulador
   local (validación estructural, no certificación); sin credenciales reales
   de Booking (altas pausadas) ni Expedia (contrato/PCI); vía a producción
   Channex (`CHANNEL_MAX_MODE=real` + cuenta staging). Estado real en
   `docs/channel-manager-connectivity.md`.
   `packages/integrations/src/channel-manager.ts` queda deprecado (solo
   tableros demo).
8. **Seguridad multi-tenant (audit 2026-06 · auditoría 360 2026-09-13):** IDOR
   de escritura y rate limit cerrados. El RBAC fail-open de GET está CERRADO
   por defecto en producción (AUTH-03): las 62 GET sin manifiesto quedaron
   mapeadas, el modo estricto se resuelve como `RBAC_STRICT` explícito o, si
   no está definido, `NODE_ENV=production` (`isRbacStrictMode()` en
   `route-permissions.ts`, memoizado), y el contract test
   `tests/api-route-permissions-contract.test.mjs` exige igualdad exacta
   rutas registradas ↔ manifiesto (sin huérfanas, sin duplicados, claves en
   `PERMISSIONS`). En dev/demo sigue fail-open con warning salvo
   `RBAC_STRICT=true`. AUTH-04: el API no arranca con `NODE_ENV=production` +
   `HOTELOS_ALLOW_DEMO_AUTH=true` (`assertDemoAuthPolicy`), salvo el override
   peligroso `HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true` (solo demo pública
   sin datos reales). PENDIENTE antes de retirar el modo demo en cualquier
   instancia con clientes: el catálogo BD de permisos (83 claves) no cubre 79
   claves del manifiesto y las orgs creadas por la consola tenant-admin nacen
   sin `role_permissions` — sin la unión demo un usuario real recibe 403 en lo
   gateado. Schedulers: en multi-réplica usar `RUN_SCHEDULERS=false` salvo en
   una instancia (evita envíos duplicados a AEAT).

9. **Tanda 2 (auditoría 360, 2026-09-14):** recepción y dinero fiables —
   contrato de paginación en `apps/api/src/lib/pagination.ts` (array plano;
   `?cursor`/`?envelope=1` → `{items,nextCursor,total}`; cabeceras
   `X-Total-Count`/`X-Next-Cursor`), PATCH de reserva `.strict()`, moves y
   check-in transaccionales, saldo de check-out sobre todos los folios,
   `markInvoicePaid` idempotente por `pspReference` (lookup hash), NIF emisor
   único validado (`issuer-identity.service.ts`), arqueo POS
   (`/pos/cash-summary`), rate limit efectivo (`RATE_LIMIT_MAX`, 600/min por
   usuario+IP), revenue con `actuals.ts`. Esquema aplicado con `db push` (sin
   migración → cubierto por la baseline `20260914000000_baseline_squash` de
   Tanda 4, ver deuda 11). Backfills:
   `backfill:snapshots`, `backfill:payment-hash --apply`,
   `backfillInvoiceIssuerSnapshots/FolioLinks({dryRun:false})`. Pendiente
   Tanda 3: IVA sin configurar (`ES_UNKNOWN_0`), NIF del productor en el XML
   VeriFactu. Detalle: addendum Tanda 2 en
   `docs/audits/AUDITORIA-360-2026-09-13.md`.

10. **Tanda 3 (auditoría 360, 2026-09-14):** cumplimiento sin atrezzo — impuestos
    por región según normativa (`docs/compliance/IMPUESTOS-INDIRECTOS-ES-2026.md`;
    catálogo `packages/compliance/src/spain/indirect-tax.ts`, resolutor
    `apps/api/src/modules/accounting/tax-rate.service.ts`, nunca `UNKNOWN`;
    API `/backoffice/properties/:id/taxes`), totales por grupo persistidos en
    `Invoice.taxBreakdownJson` (única fuente para XML/PDF/UI), series por año
    (`allocateInvoiceNumber`), cadena VeriFactu bajo advisory lock con
    anulaciones (`RegistroAnulacion`) y rectificativas I/S,
    `resolveVerifactuSoftware()` (el API aborta fuera de sandbox si no está
    declarado; ver `docs/compliance/verifactu-declaracion-responsable.md`),
    SES/registro de viajeros Prisma-first con establecimiento real
    (`resolveSesEstablishment`, 409 `SES_ESTABLISHMENT_INCOMPLETE`), invitaciones
    reales (`user_invitations`, `/auth/accept-invite`, `mustChangePassword` solo
    por flag explícito), rutas staff de upsells, front sin `fetch` crudo
    (contract test) y scaffolds retirados/cableados. El fallback demo sin token
    NO alcanza rutas de riesgo alto/crítico (401). Backfills:
    `backfill:taxes --apply`, `backfill:guest-register --apply`. Deuda: Faranda
    con NIF/razón social contaminados (corrección manual), fixtures AUDIT-T3,
    anulaciones legadas bifurcadas en sandbox, TS6059 en compliance/worker.

11. **Migraciones (Tanda 4, DATA-01):** la cadena histórica (6 carpetas de
    2026-05/06, 248 tablas, 0 FK) se archivó en
    `packages/database/prisma/migrations-archive/` y se sustituyó por UNA
    baseline `20260914000000_baseline_squash` generada de `schema.prisma`
    (251 tablas, 11 enums, 384 índices, 10 FK). BD nueva → `db:migrate:deploy`;
    BD existente (demo Mac, VPS, dumps previos) → `db:adopt-baseline -- --apply`
    (idempotente, solo escribe `_prisma_migrations`) y después `migrate deploy`.
    Deuda: los VPS (72.61.194.216 dev, 76.13.55.180 demo) siguen sin adoptar (el
    demo tiene esquema anterior a Tandas 2-3: `db push` ANTES de adoptar), los
    consumidores de `db push` en deploy/ y CI los repunta el lote deploy-install,
    y Prisma 7 exigirá `prisma.config.ts` (aviso `package.json#prisma`). Guía:
    `packages/database/MIGRATIONS_README.md`.
12. **Tanda 4 (auditoría 360, 2026-09-14):** instalabilidad y datos — baseline
    única + adopción (11), contrato de entorno en `apps/api/src/lib/env.ts`
    (`assertEnv` al arrancar; `env-census --write` regenera `.env.example`,
    `deploy/.env.production.example` y `scripts/env-contract.json`; el test de
    contrato rompe si una variable leída no está documentada), typecheck de los
    16 workspaces como gate, CORS por allow-list, `Role.templateKey` +
    `POST /backoffice/properties/:id/roles`, `demo:refresh` (dry-run por defecto;
    borra residuos AUDIT respetando facturas con hash y partes SES, huérfanos de
    housekeeping/mensajes, grupos AUDIT solo si todas sus reservas son borrables)
    y `demo:fix-identity`, guard `assertDemoTarget` en seeds, runtime oficial
    `node --import tsx` (instalación SIN `--prod`: tsx y prisma son devDependencies
    a propósito), `deploy/README-INSTALL.md` + `deploy.sh`/`install-from-scratch.sh`/
    `smoke.sh`, CI en la raíz git. Cierre tras verificación: códigos de reserva por
    `MAX+1` bajo advisory lock (`lib/reservation-code.ts`; `count+1` colisionaba tras
    cualquier borrado), rooming-list atómico por fila con numeración continua y 409
    tipado si nada se importa, check-in abre el folio primario si falta
    (`ensurePrimaryFolio`) y check-out tolera reservas sin folio (`folio: null`)
    sin convertir un check-out confirmado en 4xx, errores Prisma saneados en el
    handler global (`describePrismaError`: P2002 → 409 `UNIQUE_VIOLATION` sin texto
    de invocación ni rutas), cadena de auditoría hidratada ANTES del bootstrap de
    tenants y dentro de `buildApiServer` (cada arranque y cada suite de integración
    creaba una fila génesis nueva). **Deuda que deja:** (a) `pnpm-lock.yaml` en HEAD
    no cubre `@fontsource-variable/inter`, `zod` y `@playwright/test` de admin-web →
    `pnpm install --frozen-lockfile` (CI y despliegue) falla hasta que la sesión
    dueña del lockfile lo regenere y comitee; (b) guest-web fuera del gate hasta ese
    mismo lockfile (`@types/react`); (c) la cadena de auditoría sigue siendo un tip
    en memoria por instancia: dos instancias sobre la misma BD (:3000 y :3400 en el
    Mac) la bifurcan — evidencia de la re-verificación: 9 bifurcaciones en
    `audit_events` y 6 en `event_stream` por los dos procesos del Mac; `GET
    /audit-events/integrity` verifica la cadena en memoria (sentinel excluido desde
    el cierre) — en producción una sola instancia escribe; el sellado dentro
    de la transacción es trabajo futuro; (d) 20 reservas AUDIT (18 de T0-T3 +
    AUDIT-T4-REG-001 y RES-00034) y 12 huéspedes «Audit…» con reserva se
    conservan en Faranda por diseño (factura con hash / parte SES; RES-00028 tiene
    salida registrada en 2027-07) y siguen abiertos folios de AUDIT-T4-REG-001 y
    RES-00034; (e) el drawer de check-out del front
    no lee `warnings` ni tolera `folio: null` explícitamente (hoy solo usa
    `reservation`); (f) scripts raíz encadenan `pnpm` a pelo (falla en shells sin
    shim; el instalador hace `corepack enable`); (g) VPS demo sin adoptar
    (checklist en `deploy/README-INSTALL.md §9`), `EMAIL_PROVIDER` y
    `VERIFACTU_SOFTWARE_*` por configurar; la plantilla `manager` (85 claves)
    quedó resuelta en Tanda 5 (L1a rbac + L1b api-side: 99 claves, §10 del árbol
    de navegación; catálogo 215 claves, 10 plantillas por organización, ver
    `docs/runbooks/rbac-sync.md` §1 y §7); (h) cadena VeriFactu de Faranda no lineal por número
    (FAC-2026-000014 enlaza al `cancellation_hash` de FAC-2026-000009, no al
    `verifactu_hash` de la anterior por numeración): válida como grafo, residuo de
    sandbox.
13. **Rate Grid v2 (2026-09-14/15):** parrilla de tarifas + outbox de canales.
    Módulos: `apps/api/src/modules/rate-manager` (grid, bulk-update en UNA
    transacción con journal y rematerialización de derivados, push, sync-status,
    journal/revert, rederive), `modules/channel-manager` (canales, credenciales
    cifradas write-only, product mappings, outbox `ChannelDelivery`, drenaje con
    toma atómica `FOR UPDATE SKIP LOCKED`, simulador stub/sandbox de Booking OTA
    XML / Expedia EQC / Channex JSON — validación estructural local, no
    certificación del proveedor —, webhook con HMAC sobre bytes originales) y
    `modules/revenue/recommendations.routes.ts` (RMS por día × tipo; `apply`
    devuelve parches, nunca escribe `rate_days`; acepta ventana o `cells[]`).
    Convención por módulo: `*.routes.ts` + `route-permissions.partial.ts` +
    `env.partial.ts` — los contract tests (`api-route-permissions-contract`,
    `revenue-channel-manager-contract`) ya los leen, así que una ruta nueva va
    con su entrada de permisos en el partial y una variable nueva en el partial
    de entorno. Contrato: `packages/shared/src/rate-manager-types.ts` (contrato
    acordado del cierre 2026-09-15 en el runbook §6). Reglas: ops antes que
    cells, `ratePlanId "*"` para restricciones/disponibilidad, 409
    `ALL_CELLS_CONFLICT` cuando todo conflige, 400 para precio por canal, 400
    `NO_CELLS` / `TOO_MANY_CELLS` / `INACTIVE_RATE_PLANS` / `UNKNOWN_IDS` /
    `DERIVATION_CHAIN` / `DERIVATION_YIELDS_ZERO`; UNA transacción por propiedad
    (`pg_advisory_xact_lock` + `lock_timeout` 30 s → 409 `RATE_GRID_BUSY`);
    concurrencia optimista con `cells[].expected { price, lastModifiedAt }`
    (conflicto «la celda cambió desde que se cargó»); el revert exige el `after`
    del asiento → 409 `JOURNAL_STALE` con `details.cells` (`{ force: true }` lo
    fuerza), restaura `source` y NO toca canales (el editor ofrece «Enviar a
    canales»); journal con un item por (celda, campo); outbox: la entrega más
    reciente por celda lleva el payload actual (supersede incondicional,
    reencolado de una confirmada adelantada, retiro `superseded` en cada
    drenaje) y los `Date` del SQL crudo del drenaje van en UTC explícito
    (`AT TIME ZONE 'UTC'`); `DELETE /channel-manager/channels/:id` = archivado
    lógico. Verificación adversarial 2026-09-15 (6 dimensiones, 94 hallazgos
    tratados: corregidos, traspasados o justificados):
    `docs/audits/RATE-GRID-V2-CIERRE-2026-09-15.md`.
    Tests: `tests/integration/rate-grid-v2.test.mts` y `channel-outbox.test.mts`
    (`corepack pnpm test:integration`; ambos ficheros de integración cargan
    `hotelos/.env` con `process.loadEnvFile` antes de nada, sin pisar variables ya
    definidas, para descifrar las credenciales sembradas: sin `.env` usan valores
    por defecto de CI y los casos de publish encolan 0; 80/80 el 2026-09-15 tras
    el reinicio de :3000/:3400) y el contrato documental
    `tests/rate-grid-docs-contract.test.mjs` (tabla de permisos del runbook ↔
    partials, límites ↔ constantes, contrato compartido ↔ runbook). Runbook:
    `docs/runbooks/rate-grid-v2.md`. **Deuda:** overrides de precio por celda y
    canal no soportados (`RateDay` sin canal; el precio por canal es base ×
    `defaultMarkupPercent`; la fila de canal en el editor solo admite
    restricciones), `pull-reservations` solo alimenta `ExternalReservation` (no
    crea reservas PMS), Booking en pausa de onboarding y Expedia EQC sin
    cuenta/PCI (adaptadores listos contra el simulador; la vía a producción es
    Channex: faltan cuenta staging + API key, ids de propiedad/productos de
    Channex, extranet ids de Booking/Expedia de Rías Altas y Los Tilos, y
    `CHANNEL_MAX_MODE=real` SOLO en producción), token bucket del limitador por
    proceso, filas `sending` de un worker caído se retoman a los 10 min salvo
    que exista una entrega posterior de la misma celda (entonces se retiran
    como `superseded`); **patrón TimeZone de sesión** en `$queryRaw`/
    `$executeRaw` sin revisar fuera del drenaje (`server.ts`, `lib/tenancy.ts`,
    `lib/reservation-code.ts`, `modules/pms/pms.service.ts`,
    `modules/folio/folio.service.ts`, `modules/invoicing/invoice.service.ts`,
    `modules/invoicing/verifactu-submission.service.ts`,
    `modules/mobile-keys/wallet-pass.service.ts`,
    `modules/assistant/assistant.tools.ts`, `jobs/pii-backfill.ts`,
    `scripts/refresh-demo-dataset.ts`) — o fijar `TimeZone=UTC` en
    `DATABASE_URL` (`?options=-c%20TimeZone%3DUTC`) y documentarlo en el
    contrato de env; **agrupado de escrituras del `bulk-update`** (upsert por
    celda dentro de la transacción; solo acotado a 366 días / 5.000 parches);
    **programación de publicaciones (`scheduleAt`) no implementada** (el editor
    retiró el control decorativo); **asimetría de permisos**
    `deliveries/enqueue` (`channel_manager.sync`) vs `rate-grid/push`
    (`distribution.sync`); contrato del cierre ya en el working tree
    (`CellSyncStatus` `stale`, `pushStatus` `draft|queued|pushed|partial|failed|
    superseded` recalculado desde las entregas, reversión con `reason`
    «Reversión: <motivo>[ — <texto>]» y `revertsJournalId` en `changesJson`,
    `RateGridErrorCode` con todos los `details.code` 4xx, encolado acotado desde los
    parches, `currentPrice`/`suggestedPrice` en `recommendations/apply` llamado
    tras el `bulk-update`, `CHANNEL_DELIVERY_RETENTION_DAYS` con purga horaria de
    `superseded`, `@@unique([propertyId, clientRequestId])` aplicado en local —
    el VPS debe deduplicar antes de `migrate deploy` —, etiqueta 413 `Payload
    Too Large`; `scheduleAt` sigue sin existir) — ver runbook §6. Puesta en
    vigor el 2026-09-15: :3000/:3400 reiniciados con este código,
    `test:integration` 80/80 después, recorrido en navegador como Carmen y
    sonda del API (19 hallazgos BUX/ALF corregidos el mismo día en los lotes
    `fix:admin-web` / `fix:api-channel-manager` / `fix:api-rate-manager` /
    `fix:docs`, API reiniciados otra vez después; abiertos ALF-1 y el `nan` de
    `typeNameEs`; las correcciones de pantalla se verificaron en navegador el
    15/09/2026 en un recorrido final tras el segundo reinicio —Carmen, Los
    Tilos 2027-08-15..31, datos restaurados, sin regresiones; runbook §2.2 e
    informe §6.5— salvo BUX-05 (teclado físico), las ramas «Fijar otro
    precio»/«Aceptar con ajuste» del popover, los recuentos de `bulk-update` +
    `publish` y la línea «Efectivo» con un canal activo, que siguen marcadas
    con su motivo; el contrato documental impide marcadores de navegador sin
    motivo).

14. **Tanda 6 · Finanzas (PGC Pymes + USALI + ERP, 2026-09-15/16):** diez
    módulos en `apps/api/src/modules/`: `accounting` (motor único
    `postJournalEntry`/`reverseJournalEntry` con numeración por ejercicio bajo
    `pg_advisory_xact_lock`, fecha contable, idempotencia por
    `(org, sourceType, sourceId)`, reversos marcados — nunca `deleteMany` —,
    plan «PGC Pymes hotelero» de 239 cuentas provisionable, libros de IVA,
    modelos 303/390/347/111/115/180, liquidación del IVA, replay histórico),
    `invoicing` (snapshot que congela el folio, PDF real con QR VeriFactu y
    escritor PDF propio, email con adjunto o `{ status: "simulated" }`,
    simplificada `SIM` ≤ 400 €), `payments` (Stripe/Redsys por env, 409
    `PSP_NOT_CONFIGURED` en vez de `captured` ficticio, idempotencia por
    `clientRequestId`, token de retorno HMAC), `pos` (factura simplificada +
    asiento por comanda, `CashClosure` persistido), `night-audit` (cargo de
    alojamiento desde la tarifa, idempotente por fecha de negocio),
    `payables` (proveedores NIF/IBAN validados, facturas recibidas por líneas,
    gastos), `fixed-assets` (tablas art. 12 LIS, corridas mes a mes),
    `treasury` (posición desde el libro y extractos, CSB43 persistido, SEPA
    19/34, comisiones que devengan solas, nóminas que revierten antes de
    recalcular) y `financial-statements` (USALI 11.ª con mapeo por
    organización, balance/PyG/ECPN/memoria Pymes, exportación a gestoría CSV
    universal / «compatible Contaplus» / A3 no implementado). Convención por
    módulo: `*.routes.ts` + `route-permissions.partial.ts` (registrados en
    `server.ts` tras `registerChannelManagerRoutes`; el contract test lee
    cualquier `*route-permissions.partial.ts`) + contrato en
    `packages/shared/src/*-types.ts` (`MoneyString`, nunca float).
    **Decisiones:** cuenta de clientes ÚNICA `4300` (`CUSTOMER_ACCOUNT_CODE`;
    `430` cabecera; CLI `accounting:relabel-customer-account` dry-run por
    defecto); venta TPV al contado = UN asiento `pos_ticket/<ticket>`; regla
    única de lectura de los estados (`status ≠ draft` y fuera de parejas de
    anulación marcadas; el diario y la gestoría conservan ambas mitades); 409
    `FISCAL_YEAR_CLOSED` para todo escritor dentro de un ejercicio cerrado;
    clave `accounting.reports.read` (informes con importes: manager, accountant,
    compliance, owner) frente a `accounting.read` (solo calendario, Recepción)
    remapeada en `security/route-permissions.ts`; corridas de amortización sin
    huecos (409 `PREVIOUS_PERIOD_MISSING`); cotejo del 303 con `posted+reversed`;
    todos los bodies del dinero `.strict()`; `presentacion.modo = manual` en
    los modelos (sin fichero BOE); PDF/XLSX con escritores propios (no hay
    librerías en `node_modules` y la regla impide añadirlas). Revisión
    adversarial: 15 hallazgos (6 alta · 7 media · 2 baja), todos corregidos y
    pinados (runbook §12). **Faranda (BD local):** plan 239 cuentas; replay
    2026 → 61 asientos / 150 líneas / Σ 2.595,00 = 2.595,00; 303 2026-Q3 desde
    los documentos (27 = 71 = 74,94; cotejo con el diario −4,55 por la
    rectificativa por sustitución REC-2026-000003 contada íntegra en libros).
    **Deuda:** (a) Faranda pendiente de `accounting:relabel-customer-account`
    (61 líneas en `430`), `rbac:sync` (8 roles sin `accounting.reports.read`)
    y night audit de Rías Altas/Los Tilos (nunca ejecutado) — escriben en el
    piloto: solo con autorización de César, backup y API parados; (b) PSP,
    banco, gestoría/formato, certificados VeriFactu, periodicidad de IVA y
    convenio de nóminas de Faranda solo los puede aportar César (runbook §15);
    (c) los servicios de lectura siguen exigiendo `accounting.read` internamente
    (el borde exige `accounting.reports.read`; sin efecto en las plantillas, sí
    en un rol custom con solo la clave nueva); (d) `SepaRemittance` sin modelo
    (remesas en `worker_job_runs`), dispatcher de notificaciones sin adjuntos
    (`providers/types.ts`), `Payment.method`/`JournalEntry.sourceType` siguen
    `String`, `JournalLine` sin `@@index([accountId])`, `openingAccumulatedDepreciation`
    inexistente (elementos heredados de ejercicios cerrados), parejas de
    anulación a caballo de dos periodos excluidas de ambos en los estados por
    periodo, reverso huérfano `cmu37gqkt0015fym4g9fcl0y4` en org_123 (residuo
    de test, no cuenta), duplicado residual de F2 entre DOS instancias del API
    cerrando la misma comanda a la vez; (e) los API :3000/:5173 NO se han
    reiniciado: sirven el código anterior hasta que el integrador humano lo
    haga (después: `test:integration` de nuevo y recorrido en navegador); (f)
    el front no consume ninguna ruta nueva (siguiente workflow: lista en
    `docs/audits/TANDA-6-FINANZAS-BACKEND-2026-09-15.md` §5). Runbook
    completo: `docs/runbooks/finanzas-contabilidad.md` (§11 integración, §12
    correcciones, §13 rutas y permisos, §14 comandos, §15 límites, §16
    puertas); rutas en `docs/api-contracts.md` «Finanzas · módulos».

## Docs prioritarios

Antes de tomar decisiones de producto, lee:

- `docs/audits/DEMO-READINESS-REPORT-2026-05-31.md` — estado del demo
- `docs/audits/MOCK-SCREENS-FIX-PLAN.md` — mocks pendientes
- `docs/cocoa-design/EXECUTIVE-SUMMARY.md` — visión Cocoa
- `docs/cocoa-design/CHEAT-SHEET.md` — paths + tokens del DS
- `docs/rate-manager/DESIGN-PROPOSAL.md` — Rate Manager v2 spec de producto/UX (su sección «Endpoints backend» está obsoleta: las rutas reales son las del runbook §1.2)
- `docs/runbooks/rate-grid-v2.md` — Rate Grid v2 operativo: contrato, outbox/drenaje, modos de canal, alta de canal y mapeo, política de la UI, Channex como vía a producción, límites, contrato del cierre (§6)
- `docs/channel-manager-connectivity.md` + `docs/booking-adapter.md` — estado honesto de la conectividad OTA (Booking OTA XML, Expedia EQC, Channex): simulador estructural, credenciales, procedimiento de certificación Channex
- `docs/audits/RATE-GRID-V2-CIERRE-2026-09-15.md` — cierre de la verificación adversarial de Rate Grid v2: qué se construyó, cómo se verificó, límites y lo que solo César puede aportar
- `docs/audits/TANDA-6-FINANZAS-BACKEND-2026-09-15.md` — cierre de la Tanda 6 · Finanzas backend: qué era mock y qué es real, cifras de Faranda tras el replay, los 15 hallazgos de la revisión y su estado, lo que el front debe consumir y lo que solo César puede aportar
- `docs/runbooks/finanzas-contabilidad.md` — contrato de datos PGC/USALI, reglas canónicas con ejemplos de asiento, rutas y permisos por módulo, comandos (plan, replay, cierre, amortización, IVA, exportaciones) y límites
- `docs/director-dashboard/DESIGN-PROPOSAL.md`
- `deploy/README-HOSTINGER.md` — playbook deploy producción
- `deploy/README-REMOTE-DEV.md` — workflow remoto desde el Mac Pro (cliente único)
- `deploy/CLAUDE-RESUME-CONTEXT.md` — versión larga de este archivo
- `docs/pilots/FARANDA-LOS-TILOS-2026-09-14.md` + `docs/runbooks/pms-history-forecast-import.md` — piloto Faranda Los Tilos (2.ª propiedad real, provisionada e importada el 2026-09-14) y carga del History & Forecast del PMS: ficha, mapeo, salidas reales, readiness y hallazgos pendientes

## Primera tarea en cada sesión nueva

Si el usuario llega con una sesión "fresca":

1. Léete `docs/audits/DEMO-READINESS-REPORT-2026-05-31.md`.
2. Comprueba estado de servicios y guardrails.
3. Resume estado en 5 bullets.
4. Pregunta qué quiere hacer hoy.

Si el usuario llega con una tarea concreta, ve directo a ella sin
preguntar — ya tienes contexto suficiente.
