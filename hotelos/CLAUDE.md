# CLAUDE.md · Auto-context for Claude Code

Este archivo se carga automáticamente cuando arrancas `claude` desde la
raíz del repo. Sirve como "manual del proyecto" para que cualquier nueva
sesión de Claude tenga contexto completo sin que el usuario lo explique.

---

## Identidad del usuario

César (cesareme en GitHub · yakutatsa@gmail.com). Empresa: ehotelOS.
Trabaja en español. Prefiere tono directo, profesional sin emojis
excesivos. Mac Pro como ÚNICA máquina (casa y viaje — el MacBook Neo se
retiró). VPS Hostinger como entorno dev remoto: el código, la BD y los
secretos viven en el VPS, así que viajar con el Pro no añade riesgo de
perder trabajo.

## Producto

ehotelOS · monorepo PMS+ERP nativo español con IA. Compite con Mews,
Cloudbeds, Stayntouch — pero con compliance ES profundo de fábrica
(VeriFactu, SES Hospedajes, TBAI multi-foral, IGIC, ESRS) y agentes IA
integrados.

NOTA estructura: el código real vive bajo `/hotelos/` (subdirectorio
extra heredado del primer commit · pendiente de aplanar). Si escribes
paths para CI o referencias, recuerda el prefijo.

## Marca y despliegue (rebrand 2026-09)

- **Nombre de marca: `ehotelOS`** (grafía exacta e+hotel+OS, también a
  principio de frase; nunca con la e ni la h en mayúscula). Dominio
  `ehotelos.com`; demo `demo.ehotelos.com`. Historial de nombres: `hotelos`
  → `anfitorio` (2026-06) → ehotelOS (2026-09); las dos grafías anteriores
  solo sobreviven en identificadores técnicos. Buzones y hosts (D2, los crea
  César): `soporte@ehotelos.com`, `https://ayuda.ehotelos.com`,
  `huesped.ehotelos.com` (portal del huésped) y `admin@ehotelos.com` (contacto
  ACME de Caddy). Fuente única en `apps/admin-web/src/config/brand.ts`
  (copias mínimas en guest-web, mobile y api; `tests/brand-contract.test.mjs`
  las fija y barre el inventario visible). Preservados a propósito los
  identificadores `HotelOSTokens`/`HotelOSFlowTokens`, los headers
  `X-HotelOS-Idempotency`, `X-Anfitorio-Webhook-Secret` y
  `X-Anfitorio-Signature` (protocolo, D7), el paquete `@hotelos` (no
  visible), las unidades `anfitorio-api`/`anfitorio-worker`, las rutas
  `/opt|/etc|/srv|/var/backups/anfitorio` y el usuario/BD/rol `anfitorio`.
  El SIF VeriFactu NO sigue a la marca: en producción `/etc/anfitorio/api.env`
  lleva `VERIFACTU_SYSTEM_NAME=Anfitorio` y `VERIFACTU_SYSTEM_VERSION=0.1.0`
  (añadir si faltan: nombre y versión de la declaración responsable vigente,
  los de los registros ya remitidos; los valores por defecto nuevos del código
  son `ehotelOS` / `1.0.0`) hasta la nueva declaración responsable (D4;
  `deploy/README-INSTALL.md` §9 paso 4 y
  `docs/compliance/verifactu-declaracion-responsable.md` §4.7).
- **Demo pública `https://demo.ehotelos.com`** (VPS demo **76.13.55.180**;
  no confundir con el VPS de desarrollo): Caddy (HTTPS Let's Encrypt) sirve
  el build de admin-web y hace reverse-proxy de la API en el mismo origen
  (VITE_API_URL al mismo dominio → sin problema de `localhost`/CORS). Corte
  de dominio (D5), en este orden: 1) registro DNS `A demo.ehotelos.com →
  76.13.55.180` y `dig +short demo.ehotelos.com` ANTES de recargar Caddy (si
  el nombre no resuelve, ACME falla para ese host; los bloques del Caddyfile
  van separados para que el dominio anterior siga sirviendo); 2) el buzón
  `admin@ehotelos.com` debe existir (avisos ACME); 3) `deploy.sh` NO
  regenera `/etc/caddy/Caddyfile` en el rol `production-native`: `sudo cp
  deploy/caddy/Caddyfile.native /etc/caddy/Caddyfile` (conserva el bloque de
  transición 301 del dominio anterior; `install-from-scratch.sh` solo lo
  elimina en instalaciones nuevas), `sudo caddy validate --config
  /etc/caddy/Caddyfile` y `sudo systemctl reload caddy` (verbo ya permitido
  en `/etc/sudoers.d/anfitorio-deploy`); 4) `/etc/anfitorio/api.env`:
  `APP_BASE_URL=https://demo.ehotelos.com`, `API_PUBLIC_URL` y
  `CORS_ALLOWED_ORIGINS` con el origen nuevo (y el antiguo durante la
  transición), reinicio de las unidades y rebuild del front con
  `VITE_API_URL=https://demo.ehotelos.com/api`; 5) en GitHub cambiar el
  VALOR de `vars.PUBLIC_DOMAIN` a `demo.ehotelos.com` (el nombre no cambia);
  6) el dominio anterior queda como redirect 301 hasta que caduque la
  transición. Infraestructura intacta: unidades, rutas, usuario/BD/rol
  `anfitorio` y sudoers `anfitorio-deploy`. Checklist completo:
  `deploy/README-INSTALL.md` §9.
- **VPS dev** (72.61.194.216): acceso por **clave SSH** ya autorizado para `root`
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
  (daily), group cutoff (daily), mailbox poll (5min), VeriFactu queue,
  PMS sombra (15min), reputación (24h · `REPUTATION_SYNC_*`, lease + advisory lock)
- Apagado ordenado: SIGTERM/SIGINT → lib/shutdown.ts (schedulers → app.close →
  flushAuditQueues → prisma.$disconnect; `SHUTDOWN_TIMEOUT_MS` 10 s; segunda señal sale ya)

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
`pnpm test:ai-core` (unitarios de packages/ai-core, Node strip-types, sin BD ni red) ·
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

Estado verificado (cierre Tanda 6 · Finanzas front / Cocoa 22 ola 6 + 8-B,
2026-09-16, integrador final; working tree sin commit, :3000/:5173 sin reiniciar):
- 217 screens alcanzables · 183/183 URLs · 0 broken links · placeholders 16/20
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · `.husky/pre-commit` OK
- contratos 410/410 · unitarios api 1.233 (1.232 pass · 1 skipped) · unitarios
  front 692/692 · `build-nav-tree --check` al día (66 ítems · 94 pestañas · 205
  redirecciones) · `cocoa-22-api.mjs --check` al día · `--typecheck-examples`
  11 plantillas · 0 errores
- inventario Cocoa 22 regenerado: 217 pantallas · 86.883 líneas · 3.833 puntos
  (4.600 en `31bccc9`); `NOT_MIGRATED` 125 = `ALLOWLIST_CEILING`; techos
  `GLOBAL_CEILING` 589 · 419 · 91 · 409 · 402 · 3.223; §6 del plan al día
- integración NO repetida (escribe en org_123/prop_123 y los API sirven el
  código anterior): pendiente tras el reinicio, como la verificación visual §5

Estado verificado (cierre Tanda 6b · Estructura societaria backend, 2026-09-16,
integrador final; working tree sin commit, :3000/:5173 sin reiniciar):
- 216 screens alcanzables · 183/183 URLs · 0 broken links · placeholders 16/20
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · `.husky/pre-commit` OK
- contratos 431/431 · unitarios api 1.456 (1.455 pass · 1 skipped) · integración
  294 (289 pass · 5 skipped preexistentes · 0 fail; 7 suites de la tanda con 99 casos) · env 137/137 · validate-env OK
- migraciones 8/8 aplicadas (`migrate status` al día, drift 0, migrations↔schema
  266 tablas / 30 enums) · fresh-install OK (266 tablas, 79 permisos, 4 funciones /
  4 triggers declarados, 4 s) · `install --frozen-lockfile --offline` al día
- `rbac:sync -- --dry-run`: catálogo 223 · +0 · 6 roles por completar + Local Super
  Admin +2 (no aplicado: escribe `role_permissions` de Faranda)
- Faranda solo lectura: 25 facturas · 61 asientos / 150 líneas / Σ 2.595,00 · 33 envíos
  (idéntico antes y después de todas las suites)

Estado verificado (cierre Tanda 6b · Estructura societaria front L6/L7/L9 + tres
lotes de corrección de la QA con navegador, 2026-09-16, integrador final; working
tree sin commit; :3000 sirve el backend de la tanda, :5173 sin reiniciar):
- 224 screens alcanzables · 188/188 URLs · 0 broken links · placeholders 16/20 ·
  `build-nav-tree --check` al día (67 ítems · 98 pestañas · 205 redirecciones;
  Configuración 11 ≤ 12 con «Estructura societaria»)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · `.husky/pre-commit` OK
- contratos 445/445 · unitarios front 939/939 · unitarios api 1.512 (1.511 pass · 1
  skipped) · integración 337 (2.ª pasada 332 pass · 0 fail · 5 skipped preexistentes;
  la 1.ª pasada falló una vez `structure-l6-l7-contract` «rollup totalUndistributed»
  por carrera de lectura de org_123 con suites hermanas: sola 14/14) · env 137/137 ·
  validate-env OK · migraciones 8/8 (drift 0, 266 tablas / 30 enums) · fresh-install OK
  · `install --frozen-lockfile --offline` al día · `cocoa-22-api --check` y
  `--typecheck-examples` al día
- inventario Cocoa 22 regenerado: 224 pantallas · 88.428 líneas · 1.912 puntos (sin
  cambio: las 8 pantallas nuevas nacen a 0); `NOT_MIGRATED` 68 = techo; techos
  `GLOBAL_CEILING` 307 · 203 · 40 · 158 · 70 · 1.832; §6 del plan al día
- `rbac:sync -- --dry-run`: 223 claves · +0 · 0 roles por completar (en local el
  arranque del API con el backend 6b completó las plantillas; en el VPS lo hará el
  reinicio tras el deploy)
- QA con navegador: 12 hallazgos confirmados (2 media · 10 baja) → 12 corregidos
  (`docs/audits/TANDA-6B-ESTRUCTURA-FRONT-2026-09-16.md` §4); la verificación
  visual de las correcciones con sesión queda pendiente
- Faranda solo lectura: idéntica antes y después de las dos pasadas (25 facturas ·
  61 asientos / 150 líneas / Σ 2.595,00 · 33 envíos · 2 centros · 4 series · 1
  instalación); org_123 en el dataset de referencia; 2 organizaciones (0 residuales)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda CIERRE-1 · restos de FIX-1, T9, CHK y del manual, 2026-09-20, rama
`tanda-cierre` sobre a069906, informe `docs/audits/TANDA-CIERRE-1-2026-09-20.md`):
- seguridad: `GET /accounting/ledger-imports/third-parties` con R11 (`assertFinanceReadScope`,
  404 `ENTITY_SCOPE_REQUIRED`); `POST /webhooks/subscriptions` exige `propertyId` de la
  organización (400) y `DELETE` borra `webhook_deliveries` (`deliveriesDeleted`, también en
  `GET /developer/api-reference`); `/dashboards/procurement` por organización del contexto
  (T9 17e); remesa SEPA de proveedores con `assertSupplierBillPaymentAuthorized` por factura,
  fail-closed 409, `billIds` + `sod` persistidos y auditoría `SEPA_REMITTANCE_GENERATED` en
  toda remesa (T9 17d + REV-01); REV-02 cerrado en la 2.ª pasada del corrector: `kind: norma34`
  en `POST /treasury/sepa/remittances` → 403 `SUPPLIER_PAYMENT_ROUTE_REQUIRED` antes de parsear y
  sin fila (la genérica persiste adeudos Norma 19; las transferencias solo por `supplier-payments`)
- corrector · 2.ª pasada (revisión funcional en runtime FUN-01…07 + REVF): 404 del directorio de
  terceros con mensaje propio y pestaña «Terceros» con estado propio para perfiles de centro
  (`ledgerThirdPartiesErrorMessage`, sin «elige un centro»); `billIds` + `sod` en el DTO de
  `GET /treasury/sepa/remittances[/:id]`; zod `.strict()` en `POST /webhooks/subscriptions`
  (`propertyId: ""` → 400); `topSuppliers` sin «Unknown supplier»; `openapi.yaml` 761/1.031
  operaciones (+14 a mano: third-parties, SEPA, webhooks, `/rbac/users`);
  `api-integration.test.mts` con tenant aislado `org_l2_it<run>` (ya no escribe en la
  organización piloto); runbooks con las 3 rutas de `users.read`
- tests: `pms-shadow-*` con «hoy» en la zona del hotel (`tests/integration/helpers/local-day.mts`);
  e2e «solo teclado» autónoma (`provisionArrival`) y ejecutada con `E2E_CHROMIUM_EXECUTABLE`
  (`playwright.config.ts`; 1 passed) — sin teardown sobre `prop_uxday` (reset con
  `db:seed:ux-day -- --reset`); `payroll_hr` + `users.read` aditiva sin bump (top-up en el
  arranque del API o `rbac:sync` real; sellar la v4 con `--upgrade-templates` sigue pendiente)
- docs: manual sin los defectos corregidos por FIX-1 y en concordancia con F9/F10
  («Falta 1 comprobación», alta de fichas, «Tomar» asigna); `auditoria-eventos.md` §6 (T9, CHK,
  FIX-1, SEPA); `openapi.yaml` al día (−2 rutas T9, +2 CHK, `dryRun`); `api-contracts.md:236`;
  `[:<recepción>]` en `schema.prisma:150`; runbook Sage §3.2 (re-enmascarado por id, tokens de
  7 cifras); `RBAC-DEPARTAMENTOS.md` M21 RRHH `V⁴`
- PII (fuera del repo): plan `remask-pii-vat.plan.json` (39 filas de
  `vat_book_entries.counterparty_name`) con dry-run listo; el apply y la reclasificación de
  libros de IVA (`POST /fiscal/vat-books/reclassify`, 53.291 filas Sage sin régimen) son
  decisiones de César (informe §7)
- puertas: `--quick` 12/12 en todas las olas; completa 14/14 en el run 2 del orquestador
  (`gates-full.json`: integración 994 · 986 pass · 0 fail · 8 skip; el run 1 fue 13/14 por
  `structure-l4.test.mts:424`, corregido en `:96` con `payables.pay`); revisión 0 high ·
  2 medium · 6 low; BD viva: 0 escrituras de negocio en la organización piloto por los lotes
  (la suite preexistente `api-integration.test.mts` creaba y borraba un rol y 3 reservas en la
  primera propiedad de la BD al correr la completa contra la BD viva — 21 `RESERVATION_CREATED`
  y 7 `ROLE_CREATED_FROM_TEMPLATE` en `audit_events` el 2026-09-20, 0 filas residuales —,
  corregido con tenant aislado en la 2.ª pasada del corrector); sin migraciones ni
  dependencias; `pnpm-lock.yaml` modificado antes de la tanda y fuera del commit (HEAD `a069906`
  no instala con `--frozen-lockfile`: el lock de HEAD no refleja `packages/ai-core`,
  `@playwright/test`, `@fontsource-variable/inter`, `zod` del admin-web ni `qrcode-terminal`;
  decisión de César: commit `chore(deps)` propio con el lock regenerado)

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

# Estructura societaria (Tanda 6b): sociedad implícita, códigos de centro e instalaciones VeriFactu
# (dry-run por defecto; idempotente; una transacción + evento LEGAL_STRUCTURE_BACKFILLED por organización)
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --dry-run)
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --apply --confirm <orgId|all>)

# Migración Faranda → CELUISMA (L8; dry-run por defecto; --apply exige --confirm <orgId> y --fiscal-address; runbook §17.13)
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --apply --confirm cmrhw9jy30002fyvb6tsdiugt --fiscal-address gijon|madrid|florida
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --print-rollback   # solo lectura

# Verificación completa antes de commit
bash .husky/pre-commit
pnpm test && pnpm test:unit && pnpm test:integration   # contratos + unitarios api + app.inject (BD)
# En esta shell del Mac solo existe «corepack pnpm»; los scripts raíz encadenan «pnpm» a pelo,
# así que usa el equivalente: corepack pnpm --filter @hotelos/api test (unitarios), etc.

# Discoverability check standalone
node scripts/check-discoverability.mjs
```

## Seeds

Catorce seeds, tres ámbitos. Todos los parametrizables pasan por el guard
`packages/database/prisma/lib/demo-guard.ts` (`assertDemoTarget`): la allowlist
demo es `org_123` / `prop_123` / `prop_canary` (+ `org_uxday` / `prop_uxday` de UX-1 y
`org_chk` / `prop_chk` de la Tanda CHK); cualquier otro objetivo exige
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

Reputación ficticia (Tanda T8): `corepack pnpm --filter @hotelos/api
demo:seed-reputation -- --dry-run` (`src/scripts/seed-reputation-demo.ts`;
`--apply --property prop_123 --reviews 90 --days 180 --seed 42` escribe fuentes
demo, reseñas deterministas `demo:<seed>:<n>` y encuestas «(demo)», todo marcado
`isDemo`, idempotente; `--purge --apply` borra SOLO filas `isDemo`; allowlist demo
org_123 / prop_123 / prop_canary, fuera de ella `--allow-real --confirm
<organizationId|propertyId>`; NO activa `reputation_quality` en ninguna
propiedad; runbook `docs/runbooks/reputacion-reviews.md` §7).

Documentos ficticios (Tanda T9): `corepack pnpm --filter @hotelos/api
demo:seed-documents -- --dry-run` (`src/scripts/seed-documents-demo.ts` + dataset puro
`seed-documents-demo.dataset.ts`; `--apply --property prop_123 --seed 42` crea los
usuarios `documentos.centro@example.com` / `documentos.oficina@example.com` (contraseña
`hotelos-demo`), 3 proveedores «… Demo S…» con NIF calculado, 22 documentos con título
`demo-documentos-*` (12 facturas —9 PDF, 3 PNG, 1 XML Facturae—, 6 albaranes, 4 de
correspondencia) que pasan por los servicios reales hasta su estado final, 2 valijas y 3
facturas contabilizadas con cotejo; idempotente por título; `--purge --apply` borra SOLO lo
suyo (nunca `audit_events` ni las claves añadidas a los roles); allowlist demo, fuera de ella
`--allow-real --confirm <id>`; runbook `docs/runbooks/documentos-digitalizacion.md` §9).

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

Tanda CHK: `db:seed:checkin` (`prisma/seed-checkin.ts`, `--reset` / `--dry-run`) siembra el
tenant aislado `org_chk` / `prop_chk` («Hotel CHK (prueba)») con tres usuarios `*@chk.test`
(contraseña `chk-demo` o `SEED_CHK_PASSWORD`; en producción aborta salvo
`SEED_CHK_ALLOW_PRODUCTION=1`) y diez reservas `CHK-*` relativas a hoy; contrato
`tests/seed-checkin-contract.test.mjs`; walkthrough en `docs/runbooks/checkin-automatizado.md` §11.

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
    (remesas en `worker_job_runs`, desde L2-04 con `organizationId` /
    `propertyId` por columna), dispatcher de notificaciones sin adjuntos
    (`providers/types.ts`), `Payment.method`/`JournalEntry.sourceType` siguen
    `String`, `JournalLine` sin `@@index([accountId])`, `openingAccumulatedDepreciation`
    inexistente (elementos heredados de ejercicios cerrados), parejas de
    anulación a caballo de dos periodos excluidas de ambos en los estados por
    periodo, reverso huérfano `cmu37gqkt0015fym4g9fcl0y4` en org_123 (residuo
    de test, no cuenta), duplicado residual de F2 entre DOS instancias del API
    cerrando la misma comanda a la vez; (e) los API :3000/:5173 NO se han
    reiniciado: sirven el código anterior hasta que el integrador humano lo
    haga (después: `test:integration` de nuevo y recorrido en navegador; los
    textos del preflight del cierre del día y «RES-00081 · Huésped» en
    Tesorería solo se ven tras el reinicio); (f) `GET /invoices/:id` no expone
    `InvoiceLine.id`: la rectificativa «Ajuste de líneas por diferencias (I)»
    queda bloqueada en la UI con aviso hasta añadir `id: l.id` en
    `invoice.service.ts` `hydrateInvoiceRecords`. Runbook
    completo: `docs/runbooks/finanzas-contabilidad.md` (§11 integración, §12
    correcciones, §13 rutas y permisos, §14 comandos, §15 límites, §16
    puertas); rutas en `docs/api-contracts.md` «Finanzas · módulos».
    **Front (2026-09-16, Cocoa 22 · lotes 6-A/6-B/6-C/6-D/6-E/6-F/8-B + 11
    correcciones de QA; cierre `docs/audits/TANDA-6-FINANZAS-FRONT-2026-09-16.md`):**
    36 URL consumen el backend: Finanzas (8 ítems · 18 pestañas: Facturación y
    cobros, Tesorería, Conciliación bancaria, Contabilidad [nuevo: diario,
    mayor, plan, ajustes, cierre de ejercicio, gestoría], Estados contables
    [+ PyG, cuentas anuales, USALI], Proveedores y gastos [nuevo: facturas
    recibidas, gastos, proveedores, inmovilizado], Comisiones, Nóminas),
    Cumplimiento › Modelos AEAT (303/390/347/111/115/180 sobre un cuerpo
    común `fiscal/FiscalModelReport.tsx`, libros de IVA, liquidación),
    Operaciones › TPV › Cierre de caja y Hoy › Cierre del día. 19 ficheros
    nuevos en `screens/` (17 pantallas o cuerpos + 2 contenedores), 26
    pantallas/contenedores migrados y 2 muertos retirados; 10 clientes tipados
    `services/{accounting,assets,cashClosure,commissions,financialStatements,
    fiscal,payables,payroll,treasury}Api.ts` + `finance-contracts.ts`
    (`FINANCE_ERROR_MESSAGES` por `details.code`); cobros y devoluciones solo
    por `components/billing/{PaymentDialog,RefundDialog}.tsx`
    (`clientRequestId`, 202 → PSP, 409 `PSP_NOT_CONFIGURED` mostrado);
    primitivas nuevas `CocoaFileInput`, `CocoaKpi caption`, `CocoaTable
    fit/nowrap/showFrom`; permisos de escritura gateados con
    `canDo(useNavGate(), clave)` sobre las concesiones reales (nunca
    `getUser()?.permissions`). Deuda Cocoa 22: 4.600 → 3.833 puntos;
    Finanzas 618 → 36. **Sin navegador en la construcción**: la verificación
    visual §5 de las 36 URL y la integración tras el reinicio quedan
    pendientes (informe §6-§7); `test:integration` no repetido.

15. **Tanda 6b · Estructura societaria backend (2026-09-16):** modelo Grupo
    (`Organization`) → **una** Sociedad (`LegalEntity`: NIF único, razón social,
    domicilio fiscal, régimen SII / gran empresa, `pgcVariant`, política de cadena
    VeriFactu) → Centro de trabajo (`Property.kind` hotel · office · other, `code`,
    `tradeName`, columnas censales) + `VerifactuInstallation` (número inmutable por
    trigger). Diseño `docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md`; runbook
    `docs/runbooks/finanzas-contabilidad.md` §17; cierre
    `docs/audits/TANDA-6B-ESTRUCTURA-BACKEND-2026-09-16.md`. Tres migraciones
    (`20260916100000/101000/102000`, aditivas, 4 triggers: emisor e instalación
    inmutables, centro pinado a su sociedad R10.1/R10.5, sociedad pinada a su
    organización) y backfill idempotente (`backfill-legal-structure.ts`, ejecutado
    en local: `FAR`/B99999997 con RA + LT e instalación `DEV-001`; `HD`/B12345674
    con AMC + ATS). Módulo nuevo `apps/api/src/modules/structure` (9 rutas,
    `organization.structure.manage`; PATCH de NIF / razón social / SII / gran
    empresa / PGC / ejercicio = alto riesgo con `confirmHighRisk`). **Reglas:**
    emisor SIEMPRE la sociedad + bloque establecimiento (`resolveIssuerIdentity`;
    `Property.legalName` y `Organization.taxId/legalName` deprecados y sin lectores
    — contrato C8 con lista vacía); series únicas por sociedad (prefijo R3
    condicional `FAC-2026-` / `FAC-RA-2026-`, 409 `SERIES_PREFIX_CLASH`, dos
    advisory locks en la numeración: 409 `INVOICE_NUMBER_DUPLICATE` /
    `WORK_CENTER_CODE_REQUIRED` / `SERIES_CLOSED`); cadena VeriFactu por
    instalación (`NumeroInstalacion` de `verifactu_installations`, env solo
    sandbox, `INSTALLATION_NOT_DECLARED` en modos reales); sociedad en SII → sin
    huella ni envío con motivo (`VERIFACTU_EXCLUDED_BY_SII`); centro obligatorio en
    líneas 6/7 (400 `WORK_CENTER_REQUIRED`, exentos liquidación / cierre / apertura /
    reverso / `societyLevel`); retenciones y nóminas sin centro → 409 en vez de
    descarte; ejercicios solo de sociedad; declarante = sociedad con badge y
    régimen único (303 mensual forzado, 347/390 «no se presenta», propuesta RIVA
    71.3 en `GET /fiscal/regime`); USALI y PyG por centro con «Oficina central»,
    «Sociedad (sin centro)» y reparto SOLO informativo (base única −GOP USALI);
    permisos `accounting.entity.read` (toda la sociedad, 404 opaco
    `ENTITY_SCOPE_REQUIRED`; guardias en `lib/finance-scope.ts`) y
    `organization.structure.manage`; `listOperationalProperties` único filtro
    `kind = hotel`; `STRUCTURE_ENABLED` como interruptor. Revisión adversarial: 17
    hallazgos (3 alta · 7 media · 7 baja), 17 corregidos y pinados (runbook §17.6).
    Hotel individual: sin cambio visible salvo el bloque establecimiento del PDF.
    **Deuda:** (a) DDL aplazado — `prefix` / `legal_entity_id` `SET NOT NULL` (tras
    el backfill del VPS), índices únicos de prefijo y número por sociedad (L8: org_123
    sucio: `FAC-2026-` en prop_123 y prop_canary, `FAC-2026-000001` × 2),
    `bank_accounts.property_id DROP NOT NULL` (≈ 50 referencias en banking),
    `TbaiSubmission.installationId`, `GestoriaExport.propertyId`, FK de
    `JournalEntry.propertyId`; (b) `rbac:sync` pendiente (escribe `role_permissions`
    de Faranda: 6 roles + Local Super Admin); (c) la activación de VeriFactu en un
    centro no abre todavía su `verifactu_installations` (backfill / consola / SQL);
    (d) front L6 (Configuración › Estructura societaria: 5 pestañas en
    `screens/structure/**`, contenedor `EstructuraSocietariaTabs`, asistente «Añadir
    centro» con `dryRun`, perfil sin NIF, consola) y L7 (ámbito único
    `services/financeScope.ts` + `FinanceScopeSelector` en 26 pantallas de Finanzas y
    Cumplimiento, `localStorage["hotelos-finance-scope"]`, `?ambito=`, matriz
    `FINANCE_SCOPE_POLICIES`) CONSTRUIDOS y cerrados el 2026-09-16
    (`docs/audits/TANDA-6B-ESTRUCTURA-FRONT-2026-09-16.md`; runbook §17.12); quedan:
    verificación visual con sesión de las 12 correcciones de la QA, banner de shell
    «Finanzas de toda la sociedad» (`divergesFromActive` sin montar), patrón latente de
    qa#11 en `BankReconciliation` / `BankingSpain` / `Commissions`, `scope=entity` en
    `/banking/*` y compras (hoy «centro por defecto»), columnas censales en `GET
    /organizations/me/structure` (la ficha las arranca vacías), ruta de archivado de
    centro, tipos compartidos aditivos (`PayrollExportResult.employer`,
    `TreasuryPosition.scope`, `InvoiceIssuer.establishment`), `--cocoa-accent-fill`
    en `CocoaSidebar` / avatar del shell; (e) L8 (Faranda → CELUISMA): CLI
    `apps/api/src/scripts/migrate-faranda-celuisma.ts` (`structure:migrate-faranda-celuisma`,
    dry-run por defecto, 11 pasos, idempotente y reversible, runbook §17.13) y specs
    `specs/faranda-{oficina-central,pathos-gijon,marsol-candas,alisas-santander,florida-norte,las-lomas}.json`
    construidos y probados en seco (873 escrituras · 0 colisiones); el `--apply` sigue
    bloqueado por los datos que solo César puede aportar (informe backend §8; sin
    `--fiscal-address` el apply termina con salida 2); el NIF real A33615980 solo entra
    en la demo local y nunca se remite a la AEAT; (f) la probe org_123 de C9
    (`structure-l5.test.mts`) y la suite `structure-l6-l7-contract` (rollup USALI)
    solo son fiables con la BD en reposo (las suites hermanas escriben org_123 en
    paralelo): la primera se salta con diagnóstico, la segunda puede fallar una vez y
    pasa sola.
16. **Tanda L6a · tipos sin consumidor:** `AiIntent`/`AiIntentName` en
    `packages/shared/src/types.ts:23-37, 354-363` sin consumidor desde la retirada
    del gateway (Tanda L6a); decisión pendiente: retirarlos o conservarlos para el
    asistente unificado de L6b (informe L6a §5.7).
17. **Tanda T9 · Documentos y digitalización (2026-09-19):** (a) búsqueda del
    archivo con `ILIKE` sin índice: el GIN `pg_trgm` sobre
    `incoming_documents.search_text` va en una migración propia (`previewFeatures =
    ["postgresqlExtensions"]`, `extensions = [pg_trgm]`); (b) subida solo como JSON
    base64 (`bodyLimit` 40 MiB): multipart (`@fastify/multipart`) pendiente; (c)
    adaptador S3 (SigV4 propio, sin SDK) sin cuenta real: verificado solo con los
    vectores oficiales de firma y el sandbox local; (d) pago fuera de la separación de
    funciones detectado en la revisión: la remesa `POST /treasury/sepa/supplier-payments`
    (`payables.pay`) no pasa por `assertSupplierBillPaymentAuthorized` (creador ≠
    aprobador ≠ pagador), así que quien aprueba un documento y queda como registrador de
    la factura podría ordenar su pago por tesorería — cerrado en CIERRE-1 (2026-09-20):
    `treasury/sepa-remittance.service.ts:459-479` pasa cada factura por
    `assertSupplierBillPaymentAuthorized` (fail-closed: 409 `RBAC_SOD_CONFLICT`
    `creator_ne_payer` / `approver_ne_payer` rechaza toda la remesa; controller y
    plataforma como en el pago) y, desde el corrector CIERRE-1 (REV-01), devuelve
    `billIds` + `sod`, los persiste en el `payloadJson` de la remesa y audita
    `SEPA_REMITTANCE_GENERATED` en toda remesa (`:345-364`; nunca XML ni IBAN); tests
    `tests/integration/rbac-sod.test.mts` bloque «Tanda CIERRE-1 · remesa SEPA de
    proveedores» (4), runbooks `finanzas-contabilidad.md` §13 y `auditoria-eventos.md`
    §6.3. QUEDA ABIERTO (REV-02, preexistente): `POST /treasury/sepa/remittances` con
    `kind: norma34` bajo `banking.reconcile` sortea esa puerta (decisión: `payables.pay`
    en el manifiesto para norma34 o rechazar norma34 en la genérica; informe CIERRE-1 §3);
    (e) fuga de proveedores en
    `GET /dashboards/procurement`: `dashboards/procurement.service.ts` lee
    `prisma.supplier.findMany({ where: { active: true } })` sin `organizationId` (recon
    T9 §2.4) — cerrado en CIERRE-1 (2026-09-20): `buildProcurementDashboard` recibe
    `organizationId` del contexto (`server.ts:7695-7696`) o lo resuelve por la propiedad y
    lee `supplier.findMany({ active: true, organizationId })` (sin organización no hay
    consulta; `deps.db` inyectable), test
    `apps/api/src/modules/dashboards/__tests__/procurement-org-scope.test.mts` (2); el
    KPI `supplierCount` sigue contando proveedores activos referenciados por pedidos del
    centro; además `emailApi.ts` sigue con dos propósitos de buzón y `openapi.yaml`
    conservaba las dos rutas retiradas (mergeLines §14.6; retiradas en CIERRE-1 · C3b,
    que añadió las 2 rutas de CHK y `dryRun`); `POST …/email/ingest` con
    `attachments` y `PayablesErrorCode` con `SUPPLIER_BILL_MATCH_REQUIRED` + los 400 de
    recepciones en `DOCUMENT_ERROR_CODES` los cerró el corrector T9 (informe §4).
18. **Tanda CHK · Check-in automatizado (2026-09-19):** (a) índice único
    `guest_register_records(reservation_id, guest_id)` NO creado (el diseño §6 lo pedía;
    0 duplicados hoy en local y el dedupe sigue en código en `compliance.service.ts`):
    queda fuera de `20260920150000_checkin_automatizado` por decisión del brief y sin
    dueño — crearlo exige el pre-check `SELECT … HAVING count(*) > 1` sobre la BD real y
    una migración aditiva propia; (b) almacén de firmas provisional
    (`modules/checkin/signature-storage.ts`: `dataUriSignatureStorage`, el `objectKey` es
    la propia `data:` URI en `signatures.object_key` / `pdf_object_key`; la clave lógica
    `org/<org>/prop/<prop>/checkin/<sesión>/…` se valida pero no se persiste) hasta que
    T9 aporte `documents/storage/*` implementando `SignatureStorage { put, get }`; el PDF
    del parte lleva el hash de la firma en vez del PNG incrustado (`pdf-writer.ts` sin
    imágenes) y el job de retención del registro aún no purga `signatures.retention_until`;
    desde el corrector (SEC-2) `objectKey`/`pdfObjectKey` van cifrados por `PII_FIELDS.Signature`;
    (c) menores: `MobileKey` y `RoomFeatureAssignment` no creados, `preassign` sin efecto,
    códigos `OTP_METHOD_NOT_ALLOWED`/`SES_QUEUE_FAILED` fuera de `CHECKIN_ERROR_CODES`
    (runbook `docs/runbooks/checkin-automatizado.md` §13). Cerrados por el corrector
    (2026-09-20): CORS `x-guest-token`/`x-kiosk-token`, `room_blocks` como filtro duro en
    `validateRoomUnderLock`, `at_reception` sin PSP solo con `allowPayAtReception`
    (migración `20260920160000_checkin_pago_en_recepcion`), recepción cierra sesiones que el
    huésped no cerró (`PATCH …/check-in/guests/:guestId`, `POST …/check-in/resolve-handoff`,
    `dryRun` en `/complete`).

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
- `docs/audits/TANDA-6-FINANZAS-FRONT-2026-09-16.md` — cierre de la Tanda 6 · Finanzas front (Cocoa 22): las 36 URL nuevas y migradas, qué puede hacer ya un contable paso a paso, los 11 hallazgos de QA y su estado, puertas y pendientes (reinicio, verificación visual, `InvoiceLine.id`)
- `docs/audits/TANDA-6B-ESTRUCTURA-BACKEND-2026-09-16.md` — cierre de la Tanda 6b · Estructura societaria backend: qué cambia para Faranda/Celuisma y qué no para un hotel individual, los 17 hallazgos y su estado, lo que necesita el front (L6/L7) y la lista exacta de datos que César debe aportar para la migración (L8)
- `docs/audits/TANDA-6B-ESTRUCTURA-FRONT-2026-09-16.md` — cierre de la Tanda 6b · Estructura societaria front: qué ve ya Carmen pantalla a pantalla (Configuración › Estructura societaria y el ámbito único de Finanzas), cómo se dan de alta la oficina y los 5 hoteles con el CLI de L8 (pasos y comandos), los 12 hallazgos de la QA y su estado, puertas y pendientes
- `docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md` — diseño de la estructura societaria (Grupo → Sociedad → Centro): normativa, comparativa de ERP, modelo, reglas R1-R11, API, migración de Faranda, lotes L1-L10 y decisiones que solo César puede tomar
- `docs/runbooks/finanzas-contabilidad.md` — contrato de datos PGC/USALI, reglas canónicas con ejemplos de asiento, rutas y permisos por módulo, comandos (plan, replay, cierre, amortización, IVA, exportaciones), límites y §17 estructura societaria (modelo, migraciones, backfill, reglas, rutas, comandos, aplazados, puertas)
- `docs/director-dashboard/DESIGN-PROPOSAL.md`
- `deploy/README-HOSTINGER.md` — playbook deploy producción
- `deploy/README-REMOTE-DEV.md` — workflow remoto desde el Mac Pro (cliente único)
- `deploy/CLAUDE-RESUME-CONTEXT.md` — versión larga de este archivo
- `docs/pilots/FARANDA-LOS-TILOS-2026-09-14.md` + `docs/runbooks/pms-history-forecast-import.md` — piloto Faranda Los Tilos (2.ª propiedad real, provisionada e importada el 2026-09-14) y carga del History & Forecast del PMS: ficha, mapeo, salidas reales, readiness y hallazgos pendientes
- `docs/audits/TANDA-8-REPUTACION-2026-09-19.md` — cierre de la Tanda T8 · Reputación y reseñas: bot diario honesto por fuente, índice 0-100, bandeja con borrador HITL, encuestas y casos, seed ficticio; mergeLines y decisiones del propietario
- `docs/runbooks/reputacion-reviews.md` — operación del módulo de reputación: tick, estados de fuente, importación CSV, borrador y respuesta, seed/purga, puertas y degradaciones sin el parche T8-L0 (`docs/design/olas/T8-SCHEMA-PATCH.md`)
- `docs/runbooks/auditoria-eventos.md` — ids de auditoría (16 hex desde la fusión T8), cadena hash, rotura del 2026-09-19 y vigilancia por /health checks.audit
- `docs/manual/README.md` — manual de uso por perfil (dirección, administración, RRHH, pisos y mantenimiento, comercial y revenue, sistemas, recepción), plan de formación, fichas y FAQ; capturas regenerables con `docs/manual/tools/capturas.mjs`; contrato `tests/manual-contract.test.mjs`
- `docs/design/CHECKIN-AUTOMATIZADO-IA.md` — diseño del check-in automatizado y el recepcionista IA (flujo pre-llegada → identidad → firma → pago → asignación explicable → llave; bot y copiloto con matriz de riesgo; modelo, API y privacidad) + apéndice «Estado tras la implementación (2026-09-19)» con los deltas
- `docs/runbooks/checkin-automatizado.md` — operación del módulo: variables y qué pasa sin cada una, 9 tablas y máquinas de estados, rutas y permisos por etapa, motor de asignación y pesos, identidad/MRZ/PII/purga, firma y PDF, pagos, jobs del líder, kiosco y adaptadores, bot y confirmaciones, seed `org_chk`, puertas, límites y lo que solo César puede aportar, métricas §1.8
- `docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md` — cierre de la Tanda CHK: qué construyó cada lote (qué, cómo, tests, verificación), migraciones y datos del carril, puertas línea base → final con las 3 rojas atribuidas a T9, 20 hallazgos confirmados + 12 low y su corrección, pendientes con dueño, decisiones D1-D14 para César con la opción por defecto aplicada, ficheros a fusionar y mensaje de commit
- `docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md` — cierre de la Tanda T9 · Documentos y digitalización: qué construyó cada lote y cómo se verificó, puertas por ola (12/14 final, rojos externos), los 18 hallazgos confirmados y 2 refutados con su corrección, qué es real sin clave / cuenta / escáner, pendientes, decisiones de César con el defecto aplicado y mensaje de commit
- `docs/audits/TANDA-CIERRE-1-2026-09-20.md` — cierre de la Tanda CIERRE-1 (run 1 + run 2): restos de FIX-1, T9, CHK y del manual (R11 en terceros importados, webhooks por organización y con borrado de entregas, tablero de compras por organización, remesa SEPA con separación de funciones + `billIds`/`sod` auditados, PII de `vat_book_entries` con plan listo, manual sin defectos ya corregidos y en concordancia con F9/F10, auditoría §6, openapi y referencia pública al día, `pms-shadow-*` sin flake horario, e2e autónoma y ejecutada, `payroll_hr` + `users.read`), puertas por ola y completa final (13/14, única roja `structure-l4` con fix de 1 token), revisión 0 high · 2 medium · 6 low (REV-01 corregido, REV-02 norma34 pendiente de decisión), datos escritos en la BD viva (incluida la suite `api-integration` que escribe y borra en la primera propiedad), delta frente a los dosieres, pendientes con dueño, decisiones, instrucciones para César (apply de remask-vat §7.1 y reclasificación de libros de IVA §7.2 con comando y recuento) y mensaje de commit
- `docs/runbooks/documentos-digitalizacion.md` — operación del módulo de documentos (Tanda T9): almacén (inline / disk cifrado / S3, backup), buzón por centro, flujo centro → oficina paso a paso, IA con y sin proveedor, tabla exacta de rutas y claves (§6.1), códigos de error, retención / purga / GDPR, seed de demo, puertas y lo que solo César puede aportar
- `docs/design/DOCUMENTOS-DIGITALIZACION.md` — diseño de la digitalización por centro: marco legal (Orden EHA/962/2007, RD 1619/2012, e-factura B2B RD 238/2026), captura, pipeline IA con fallback, flujo y RBAC, contabilización y archivo, modelo de datos, API (§9), front (§10), lotes; con las correcciones «[actualizado 2026-09-19]» de la implementación
- `docs/design/olas/T9-MERGE-LINES.md` — mergeLines de la Tanda T9 (anclas de texto por fichero compartido, orden de la migración tras fix1, post-fusión: tools/sync, rbac:sync, env:census:write, drift heredado)

## Primera tarea en cada sesión nueva

Si el usuario llega con una sesión "fresca":

1. Léete `docs/audits/DEMO-READINESS-REPORT-2026-05-31.md`.
2. Comprueba estado de servicios y guardrails.
3. Resume estado en 5 bullets.
4. Pregunta qué quiere hacer hoy.

Si el usuario llega con una tarea concreta, ve directo a ella sin
preguntar — ya tienes contexto suficiente.
