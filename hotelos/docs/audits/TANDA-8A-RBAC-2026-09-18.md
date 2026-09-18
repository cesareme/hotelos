# Tanda 8a · Control de acceso por departamento y nivel (RBAC) · Integración y corte de la demo local — 18 de septiembre de 2026

**Para:** César. **Encargo (17/09/2026):** «limitar el acceso a los distintos módulos dependiendo del usuario: los
recepcionistas solo pueden ver lo que atañe a sus funciones, igual los administrativos, el director del hotel, el director
de operaciones, el director general». **Método:** diseño verificado (`docs/design/RBAC-DEPARTAMENTOS.md`, §1-§9 más el
anexo §10 con las correcciones del recon y las decisiones de planificación) → L0 (catálogo 250 claves, 24 plantillas
versión 2, schema y migración `20260918100000_rbac_departamentos`) → L1 ∥ L2 (contexto y ámbito por petición, motor de
aprobaciones, PIN de supervisor, break glass; servicios con separación de funciones) → L3 (CLI de backfill y sync) →
L4 (front: usuarios y roles, bandeja, menú = router = API) → L5 (usuarios de demo) → L6 (runbooks) → corrector ronda 1
(SEC-8A-01…04, FSOD-01…12, FX-01…12) → **integración final (este documento, 18/09 12:22-13:05 CEST):** corte completo en
la BD local del Mac (reseed de las 22 plantillas, migración de asignaciones con la decisión D1, seed de 30 usuarios
ficticios, upgrade de plantillas a la versión 2 con 380 revocaciones), matriz real 200/403/404 por usuario y módulo
frente a la diseñada, smoke de 30 plantillas, separación de funciones provocada (reembolso > T2, CAPEX > T4 con doble
aprobación), PIN de supervisor y break glass auditado, invariantes fiscales y contables verificadas por huella, tres
defectos corregidos con test, inventario Cocoa regenerado y puertas completas. Todo sobre la demo local (Postgres local;
API :3000 con el código nuevo desde las 12:10, **sin reiniciar**: lo hace el orquestador, §11).

**Resultado en una línea:** cada persona de Faranda entra con su plantilla y su ámbito reales (recepción de Los Tilos
ve recepción de Los Tilos y recibe 403 en finanzas y 404 en Rías Altas; Carmen conserva la lectura de todo y las
aprobaciones como propiedad + dirección general), la API, el menú y el router aplican la misma decisión (2.140 sondas de
la matriz: 1.915 exactamente como el diseño, 220 por módulo no activado, 0 desviaciones; smoke: 2.456 GET de menú con 0
403 imprevistos, 84 escrituras ajenas → 403, 28 propiedades ajenas → 404), un reembolso de 480 € necesitó a la
directora del hotel para aprobarlo y a dirección financiera para ejecutarlo (jefatura de recepción 403, solicitante 409),
un CAPEX de 70.000 € exigió dirección general y propiedad, la sesión de emergencia duró lo que se cerró y quedó revisada,
y las **invariantes de Faranda están intactas** (25 facturas · 33 envíos VeriFactu · 4.949 asientos y 21.058 líneas
previos con la misma huella md5 · 34 lotes Sage · 1 lote de nóminas · 7 importaciones de reservas · 2 de OPERA; el caso
provocado añadió solo los asientos 2393 y 2394).

---

## 1. Alcance y qué cambia

| Antes (recon §3) | Ahora (verificado hoy) |
|---|---|
| 223 claves, 10 plantillas planas, Owner/admin con las 222 claves | 250 claves (27 nuevas), 24 plantillas × 7 niveles, versión 2 con revocaciones (`owner` 65, `admin` 70, `manager` 205 sin cobrar/emitir/asentar) |
| Permisos por la primera asignación; «sin asignaciones = todo» | Permisos por la propiedad de la petición (`:propertyId` > entidad > `x-property-id` > organización); ámbito explícito (propiedad, grupo, sociedad, organización) en `user_role_assignments` |
| Carmen = Owner ×8 filas | Carmen = `owner` + `general_manager` de organización (D1): 119 claves, 8 propiedades, `orgScope: true` |
| 3 usuarios reales, ninguno de pisos/mantenimiento/finanzas | 30 usuarios ficticios `@faranda.test` (28 personas + 2 cuentas de emergencia) con ámbito real |
| Aprobaciones selladas sin cuatro ojos; claves maker/checker muertas | Motor `approval_requests` con umbrales T1-T4 por sociedad (45 filas), solicitante ≠ decisor ≠ ejecutor, segunda aprobación > T4, PIN de supervisor de 60 s, break glass de 4 h |
| `RBAC_STRICT` ausente y unión demo activa en local | `RBAC_STRICT=true` en `.env` y unión demo apagada (`HOTELOS_DEMO_PERMISSION_UNION` sin definir) |
| Menú por token sin router | `accessDecision` compartida por menú, router (`ForbiddenScreen`) y API |

## 2. Lotes y ficheros (working tree, sin commit)

| Lote | Estado | Qué dejó | Lo que cerró el integrador |
|---|---|---|---|
| L0 catálogo, plantillas, schema | parcial → cerrado | 27 claves, 24 plantillas v2, `ROLE_TEMPLATE_REVOCATIONS`, migración con 7 tablas y 2 `CHECK` | tests de security (`admin` sin claves financieras) y reseed («Propiedad») ya re-pinados por el corrector; cifras §6.5 anotadas (owner −162 / admin −154 = C17) |
| L1 contexto, ámbito, aprobaciones | parcial → cerrado | `rbac-scope.ts`, 24 rutas `/rbac/*` y `/approvals*`, break glass, PIN | tests de integración y unitarios ajenos re-pinados por el corrector; plantilla de notificación `break_glass_opened` sigue pendiente (§4.4) |
| L2 servicios con SoD | parcial → cerrado | reembolso, anulación, proveedores, cierre del día, nómina, tarifas, TPV | `supervisorAuthorizationId`/`discountReasonCode` en las rutas (FSOD-06), `payables.pay` en remesas (FSOD-01) por el corrector |
| L3 CLI y backfill | parcial → cerrado | `rbac:migrate-assignments`, `rbac:sync --upgrade-templates`, `reseed-property-roles` con 22 plantillas | **INT-01**: los tres CLI perdían eventos de auditoría al desconectar (§4.1) |
| L4 front | parcial → cerrado | Usuarios y roles, bandeja, PIN, `RouteAccessGate`, 6 tokens nuevos | fila `ApprovalsInbox` en `pilots/screens-inventory.csv` y fallback retirado (INT-04) |
| L5 datos de demo | parcial → cerrado | `seed-rbac-demo.ts`, `check-role-smoke.mjs` | seed aplicado; **INT-02**: el smoke moría en el limitador de `/auth/login` (§4.2) |
| L6 docs | hecho | runbooks `rbac-sync.md` y `accesos-por-departamento.md`, `api-contracts.md` | §7/§8 de `rbac-sync.md` con la ejecución real y la disciplina de la cadena de auditoría (INT-05) |
| Corrector ronda 1 | hecho | 30 hallazgos cerrados, puertas en verde | dos contratos que quedaron detrás del último `server.ts` (CORS con `x-property-id`, INT-03) |

Ficheros del integrador (todos en `hotelos/`, además de los datos): `apps/api/src/lib/audit-chain-cli.ts` (nuevo) +
`apps/api/src/lib/__tests__/audit-chain-cli.test.mts` (nuevo, 5 tests), `apps/api/src/scripts/{rbac-migrate-assignments.ts,
reseed-property-roles.ts, rbac-sync.ts}`, `apps/api/src/scripts/__tests__/rbac-migrate-assignments.test.mts` (+3 tests),
`tests/rbac-cli-audit-contract.test.mjs` (nuevo, 5 tests), `scripts/check-role-smoke.mjs`,
`tests/rbac-demo-seed-contract.test.mjs` (+1), `tests/cors-contract.test.mjs`, `tests/rbac-engine-contract.test.mjs`,
`tests/rbac-nav-contract.test.mjs` (fallback retirado), `docs/runbooks/rbac-sync.md`, `docs/design/cocoa-22-inventory.json`
(regenerado), `../pilots/screens-inventory.csv` (fuera del repo, +1 fila) y este informe.

## 3. Puertas (18/09/2026 12:45-13:03 CEST, working tree completo tras las correcciones de §4)

| # | Puerta | Resultado |
|---|---|---|
| 1 | `corepack pnpm run typecheck:all` | 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web, declarado) · exit 0 |
| 2 | `corepack pnpm --filter @hotelos/api test` | 2.235 tests · 2.234 pass · 1 skipped (preexistente) · 0 fail · 677 suites (+8 tests del integrador) |
| 3 | front (`admin-web/**/__tests__`) | 1.219/1.219 · 353 suites · 0 fail |
| 4 | `node --test tests/*.test.mjs` | **529/529** · 112 suites (+6: `rbac-cli-audit-contract` ×5, `rbac-demo-seed-contract` +1; `cors-contract` y `rbac-engine-contract` re-pinados) |
| 5 | `node scripts/check-discoverability.mjs` | 226 pantallas · 0 huérfanas · 0 enlaces rotos · placeholders 16/20 · exit 0 |
| 6 | `node scripts/build-nav-tree.mjs --check` | al día: 68 ítems · 101 pestañas · 205 legacy |
| 7 | Cocoa 22 | inventario regenerado (226 pantallas · 193 puntos de deuda · bo-* 0 · colores literales 0 · style={} 679) · contrato 18/18 |
| 8 | `db:migrate:status` · `db:drift:check` | 13 migraciones (última `20260918100000_rbac_departamentos`) · «Database schema is up to date!» · «No difference detected» |
| 9 | integración | no repetida por el integrador: la pasada 2 del corrector (479 pass · 0 fail · 7 skipped) es la vigente; las suites escriben en `org_123`/`org_rbac_*` y el API :3000 estaba sirviendo la demo con el mismo código |
| 10 | `corepack pnpm --filter @hotelos/admin-web build` | ✓ built in 2,38 s · 0 avisos |
| 11 | `rbac:sync --dry-run` (tras el corte) | catálogo 250 (249 org + 1 plataforma) · +0 · 0 stale · 46 roles con plantilla · **0 roles behind version 2** · plataforma +0 |
| 12 | `check-role-smoke.mjs` (30 usuarios, API en proceso, `RBAC_STRICT=true`, unión demo off) | `ok: true · failing: 0` · 2.456 GET de menú: 1.702 ok · 61 con 403 previsto por plantilla (huecos `sister`/`write`) · 52 módulo no activado · 509 404 neutros por id · 132 4xx de parámetros · **0 fallos · 0 5xx** · 84/84 escrituras ajenas → 403 · 28/28 propiedades ajenas → 404 |
| 13 | matriz HTTP contra :3000 (§6) | 2.140 sondas · 1.915 = diseño · 220 módulo no activado · 5 404 neutros · **0 desviaciones** |
| 14 | casos provocados (§7) | 31/31 pasos con el código esperado |

Logs en el scratchpad de la sesión: `t8a-gate1-typecheck.log`, `t8a-gate2-api-test.log`, `t8a-gate3-front-tests.log`,
`t8a-gate4b-root-tests.log`, `t8a-gate10-web-build.log`, `t8a-smoke2.json`, `t8a-matrix.json`, `t8a-sod.json`.

## 4. Hallazgos y correcciones del integrador

### 4.1 INT-01 (alto) · los CLI de RBAC perdían eventos de auditoría y no hidrataban la cadena

El primer `rbac:migrate-assignments --apply --confirm --general-manager` sobre Faranda creó las 3 asignaciones pero
solo persistió **1 de los 3** `ROLE_ASSIGNED` («Engine is not yet connected» en `audit.service.ts:76`):
`recordAuditEvent` encola la escritura (`queueAuditPersist`, fire-and-forget) y el CLI llamaba a `prisma.$disconnect()`
en su `finally` sin esperar `flushAuditQueues()`. Además ninguno de los tres CLI (`rbac-migrate-assignments`,
`reseed-property-roles`, `rbac-sync`) hidrataba la punta de la cadena hash (`hydrateAuditChainFromPostgres`) antes de
escribir, al contrario que `import-sage200.ts` y `backfill-legal-structure.ts`. Corrección: `apps/api/src/lib/audit-chain-cli.ts`
(`withAuditChain(chain, writes, run)`: hidrata solo cuando hay escrituras, vacía la cola siempre, no enmascara el error
original) y los tres runners exportados envuelven su ejecución (`executeMigration` / `executeReseed` / `executeRbacSync`).
Tests: `audit-chain-cli.test.mts` (5), `rbac-migrate-assignments.test.mts` (espía de cadena: `hydrate` con 0 eventos
→ `flush` con 2; dry-run sin hidratar; fallo con flush), contrato `tests/rbac-cli-audit-contract.test.mjs` (5).
Reparación de la BD: se borraron las 2 filas sin auditar del primer intento (`cmu6ta25q…`, `cmu6ta25r…`) y se repitió
el CLI corregido → 3 asignaciones con sus 3 `ROLE_ASSIGNED` (`aud_c4a5cd75` + correlación `rbac_backfill_mu6tn77p60e3a6`).
Los 24 `ROLE_CREATED_FROM_TEMPLATE` del reseed sí habían persistido (la cola vació antes del disconnect por suerte).

### 4.2 INT-02 (medio) · el smoke por plantilla moría en el limitador de `/auth/login`

`server.ts:1805` limita `/auth/login` a **10 por minuto y por IP** (no configurable, PILOT-D1); el smoke hace 2 inicios
por usuario y a partir del 5.º recibía 429 «Demasiadas peticiones» y contaba 23 usuarios como fallo de sesión.
Corrección en `scripts/check-role-smoke.mjs`: `withRateLimitRetry` (espera la ventana de 61 s y reintenta hasta 6 veces)
en `login` y `changePassword`; duración documentada en la cabecera (≈ 6 min para 30 usuarios); pin nuevo en
`tests/rbac-demo-seed-contract.test.mjs`. Segunda pasada: 30/30 usuarios, 0 fallos.

### 4.3 INT-03 (bajo) · dos contratos detrás del último `server.ts`

`server.ts` (12:09:58, working tree) añade `x-property-id` a `allowedHeaders` del CORS: imprescindible, porque
`services/api-client.ts` la envía en toda ruta sin `:propertyId` y el preflight del navegador (:5173 → :3000) rechazaría
la petición. `tests/cors-contract.test.mjs` pinaba la lista antigua y `tests/rbac-engine-contract.test.mjs` tomaba la
**primera** aparición literal de `"x-property-id"` (ahora la del CORS, antes del guard de contraseña). Ambos re-pinados
(la constante `PROPERTY_HEADER` del hook de ámbito es la que ordena guard < cabecera < gate).

### 4.4 INT-04 / INT-05 (bajo) · inventario y runbook

- `pilots/screens-inventory.csv` no tenía fila para `ApprovalsInbox` y `tests/rbac-nav-contract.test.mjs` la suplía con
  `TREE_ROUTES_FALLBACK`: fila añadida (`/hoy/pendientes`, `GET /approvals`, `POST /approvals/:id/approve|reject`, 12
  tokens) y fallback retirado (21/21).
- `docs/runbooks/rbac-sync.md` §8 decía `reason = "migración Tanda 8a"` y «se reporta `skip`»; el script escribe
  `backfill 2026-09-18` y «ya existe (<id>)». Corregido, y §7/§8 llevan ahora el bloque «Ejecutado el 2026-09-18» con
  las cifras reales y la advertencia sobre la cadena de auditoría.

### 4.5 Observaciones (no bloquean; decisiones en §12)

- **Fallback de la demo sin token.** Con `HOTELOS_ALLOW_DEMO_AUTH=true` (solo demo local; producción no arranca con ella)
  una petición **sin** token a rutas low/medium se sirve como `reception@example.com` (plataforma, org_123): hoy
  `GET /rbac/roles`, `GET /rbac/access-log` (388 eventos de org_123) y `GET /approvals` responden 200 sin autenticación.
  Nunca alcanza a Faranda ni a rutas high/critical (401), pero conviene tenerlo presente en cualquier demo en red.
- **`GET /accounting/journal` para usuarios de propiedad** (dirección de hotel, administración) responde 404 «Ámbito no
  disponible: indica el centro de trabajo asignado (propertyId)» si no llega `?propertyId=` aunque la cabecera
  `x-property-id` sí llegue: el front lo envía en la query, así que no afecta a la pantalla; anotado como asimetría
  cabecera/query de `finance-scope`.
- **Notificación de break glass**: `POST /rbac/break-glass` respondió `notification: { attempted: 4, delivered: 0, note:
  "sin plantilla de notificación «break_glass_opened»: solo auditoría" }` (abierto de L1: falta la plantilla en
  `modules/notifications/system-templates.ts`).
- **Cadena de auditoría con dos escritores.** Los CLI hidratan ahora la punta desde Postgres, pero el API :3000 sigue con
  su punta en memoria anterior al corte: su siguiente evento enlazará con una punta antigua (deuda 12(c) conocida, igual
  que `test:integration`). Reiniciar el API (§11) la rehidrata.
- **Residuo de tests de integración**: `user_role_assignments` tiene 56 filas vivas de 14 organizaciones `org_rbac_*`
  que ya no existen en `organizations` (las suites las crean y no las limpian); no afectan a Faranda ni a org_123.
- **`/rbac/roles` es de `roles.manage`**: dirección general y Carmen reciben 403 ahí por diseño (§4.5: M21 «V C X» para
  DG, «E» solo en Administración de sistema); la pantalla de usuarios usa `GET /backoffice/roles` (22 plantillas) y
  `GET /rbac/users`.

## 5. Corte en la BD local (12:22-12:33 CEST; copia previa `../backups/hotelos-pre-rbac8a-20260918-122207.dump`, 11,6 MB)

| Paso | Comando (desde `apps/api` salvo indicación) | Resultado |
|---|---|---|
| 0 | `pg_dump -Fc` | copia de 11.652.588 bytes |
| 1 | `reseed-property-roles --org <faranda> --apply --confirm` · ídem `org_123` | `create ×12 · top-up ×10 (+0) · 747 role_permissions` por organización; 12 + 12 `ROLE_CREATED_FROM_TEMPLATE`; segundo dry-run `0 a crear · 22 con plantilla` |
| 2 | `rbac:migrate-assignments --org <faranda> --apply --confirm --general-manager cmrhw9jyb0005fyvb4ykaumyc` (D1) · `org_123` sin flag | Faranda: Carmen `owner`/organización (consolidada ×8) + Carmen `general_manager`/organización + `recepcion.tilos` `receptionist`/LT; org_123: Local Super Admin/organización. 3 + 1 `ROLE_ASSIGNED` (tras INT-01); segundo dry-run «ya existen 3». `user_property_roles` intacta (dual-read) |
| 3 | `SEED_ALLOW_REAL=1 SEED_CONFIRM=<faranda> node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts` (desde `packages/database`) | 2 roles (Administración de sistema 70, Emergencia 249) · 319 grants · 2 grupos (galicia LT+RA, asturias-cantabria PG+MC+AS) · 45 umbrales (T1 50 · T2 300 · T3 3.000 · T4 15.000 · doble > 60.000 EUR) · 30 usuarios · 28 asignaciones · 16 espejos · 58 eventos · `rbac_version` +1; segundo dry-run: todo existente |
| 4 | `rbac:sync -- --dry-run --upgrade-templates` → `rbac:sync -- --upgrade-templates` | 20 roles v0→v2 · **380 claves revocadas** (owner −162 ×2 · manager −16 ×2 · accountant −6 ×2 · compliance −4 ×2 · sales −1 ×2 · fnb −1 ×2) · 20 `ROLE_TEMPLATE_UPGRADED` · segundo dry-run `0 behind · +0 · 0 stale` |

Estado final de Faranda: 24 roles, todos `template_version = 2` y `managed = true`, con exactamente el tamaño de su
plantilla (Owner 65 · Dirección 205 · Recepción 75 · Pisos 12 · Mantenimiento 25 · Contabilidad 57 · Cumplimiento 58 ·
Revenue 53 · Comercial 51 · Punto de venta 22 · Dirección general 119 · Dirección de operaciones 110 · Jefatura de
recepción 101 · Gobernanta 34 · Encargado de mantenimiento 47 · Jefatura de A&B 48 · Auditoría nocturna 51 ·
Administración de hotel 51 · Dirección financiera 80 · RRHH y nóminas 11 · Gestión del activo 27 · Auditoría interna 68 ·
Administración de sistema 70 · Emergencia 249); 31 asignaciones vivas (17 property · 3 property_group · 5 legal_entity ·
6 organization); 32 usuarios; `user_property_roles` 26 (10 previas + 16 espejos); `permissions` 250; 0 `role_permissions`
huérfanas; org_123: 23 roles (22 v2 + Local Super Admin plataforma 250). `GET /users/me` tras el corte: Carmen
`templateKeys [general_manager, owner]` en las 8 propiedades, 119 claves, `orgScope true`; `recepcion.tilos`
`[receptionist]`, 75 claves, solo LT. Sin `--prune`: `capex.approve` sigue referenciada por `module-manifest.ts:377` (C9).

## 6. Matriz real por usuario (API :3000, 12:41-12:44 CEST)

Método (`scratchpad/t8a-matrix.mts`): para cada uno de los 24 módulos de §4.3 con ruta GET, 1-2 rutas del manifiesto
que exigen solo claves de lectura de ese módulo (M2, M14 y M18b no tienen GET propio sin id de entidad y van por el smoke),
más 4 sondas RBAC (`/rbac/roles`, `/rbac/assignments`, `/approvals`, `/rbac/thresholds`); cada uno de los 30 usuarios
las lanza contra su propiedad de trabajo (y los de propiedad/grupo contra una ajena) con `x-property-id`. **Esperado** =
200 si `ROLE_PERMISSION_MAP` de su plantilla tiene las claves y la propiedad está en su ámbito, 403 si le falta una clave,
404 si la propiedad es ajena. Leyenda: ᵐ = 403 por módulo de producto no activado en Faranda (`no está activado`: analítica,
inventario, energía, eventos, IA, coste laboral); ⁿ = 404 neutro (`/accounting/journal` sin `?propertyId`, §4.5).
**Resultado: 2.140 sondas · 1.915 exactamente como el diseño · 220ᵐ · 5ⁿ · 0 desviaciones.**

| Usuario (plantilla · ámbito) | M1 | M3 | M4 | M5 | M6 | M7 | M8 | M9 | M10 | M11 | M12 | M13 | M15 | M16 | M17 | M18 | M19 | M20 | M21 | M22 | M22b | M23 | M24 | RBAC | Propiedad ajena |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `direccion` (general_manager+owner · RA) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | — (todo el ámbito) |
| `recepcion.tilos` (receptionist · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403ᵐ | 403 | 403 | 404 ×35 |
| `recepcion.pathos` (receptionist · PG) | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403ᵐ | 403 | 403 | 404 ×35 |
| `recepcion.rias` (receptionist · RA) | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403ᵐ | 403 | 403 | 404 ×35 |
| `auditoria.noche.tilos` (night_auditor · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403ᵐ | 403 | 403 | 404 ×35 |
| `jefatura.recepcion.tilos` (front_office_manager · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 200 | 200 | 403 | 403ᵐ | 403 | 403 | 404 ×35 |
| `jefatura.recepcion.rias` (front_office_manager · RA) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 200 | 200 | 403 | 403ᵐ | 403 | 403 | 404 ×35 |
| `pisos.tilos` (housekeeper · LT) | 200 | 403 | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `gobernanta.tilos` (housekeeping_manager · LT) | 200 | 403 | 200 | 200 | 200 | 403 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 403ᵐ | 200 | 403 | 200 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `mantenimiento.rias` (maintenance · RA) | 200 | 403 | 200 | 200 | 200 | 403 | 403ᵐ | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `encargado.mantenimiento.rias` (maintenance_manager · RA) | 200 | 403 | 200 | 200 | 200 | 403 | 403ᵐ | 200 | 403 | 403 | 200 | 200 | 403 | 403 | 403 | 403ᵐ | 200 | 403 | 200 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `tpv.pathos` (fnb · PG) | 200 | 403 | 200 | 403 | 403 | 200 | 403ᵐ | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `jefatura.ab.pathos` (fnb_manager · PG) | 200 | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 403ᵐ | 200 | 403 | 200 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `comercial.galicia` (sales · LT) | 200 | 403 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `administracion.tilos` (admin_clerk · LT) | 200 | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 200 | 404ⁿ | 200 | 200 | 200 | 200 | 403 | 403 | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `administracion.central` (admin_clerk · OC) | 200 | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 200 | 404ⁿ | 200 | 200 | 200 | 200 | 403 | 403 | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 404 ×35 |
| `direccion.tilos` (manager · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 404ⁿ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | 404 ×35 |
| `direccion.rias` (manager · RA) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 404ⁿ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | 404 ×35 |
| `direccion.pathos` (manager · PG) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 404ⁿ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | 404 ×35 |
| `operaciones.galicia` (operations_director · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | 404 ×35 |
| `operaciones.norte` (operations_director · PG) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | 404 ×35 |
| `revenue` (revenue · LT) | 200 | 403 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 403ᵐ | 403ᵐ | 200 | 403 | 403 | 200 | 403 | 403ᵐ | 403 | 403 | — (todo el ámbito) |
| `contabilidad` (accountant · LT) | 200 | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403ᵐ | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 403 | 403 | — (todo el ámbito) |
| `direccion.financiera` (controller · LT) | 200 | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 403 | 403 | — (todo el ámbito) |
| `rrhh` (payroll_hr · LT) | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 403ᵐ | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 | — (todo el ámbito) |
| `cumplimiento` (compliance · LT) | 200 | 200 | 200 | 403 | 200 | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 200 | 403 | 403 | 403ᵐ | 200 | 200 | 403 | 200 | 200 | 403ᵐ | 403 | 403 | — (todo el ámbito) |
| `activos` (asset_manager · LT) | 403 | 403 | 200 | 403 | 200 | 403 | 403 | 403 | 200 | 403 | 403 | 200 | 200 | 403 | 403 | 403ᵐ | 403 | 200 | 403 | 200 | 403 | 403 | 403 | 403 | — (todo el ámbito) |
| `direccion.general` (general_manager · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | — (todo el ámbito) |
| `auditoria.interna` (auditor · LT) | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 403ᵐ | 200 | 200 | 200 | 200 | 200 | 403ᵐ | 200 | 403 | — (todo el ámbito) |
| `sistemas` (admin · LT) | 403 | 403 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403ᵐ | 200 | 403 | 200 | 200 | 200 | 403 | 200 | 200 | — (todo el ámbito) |

Lecturas: `recepcion.tilos` (y cada recepción) 200 en M1/M3/M4/M5/M6/M7/M15/M16/M19/M22 y 403 en M8-M13, M20, M21, M22b,
M24 y `/rbac/*`, con **404 en las 35 sondas de Rías Altas**; Carmen 200 en todo lo activado (su único 403 RBAC es
`/rbac/roles`, de `roles.manage`, §4.5); dirección general, auditoría interna, revenue, contabilidad, dirección
financiera, RRHH, cumplimiento y activos ven las 8 propiedades (`orgScope true`) con su plantilla; dirección de
operaciones Galicia 200 en LT y 404 en PG, la de Asturias-Cantabria 200 en PG y 404 en LT; comercial Galicia igual que
operaciones Galicia en lectura comercial y 403 en cobros/finanzas.

Smoke (`scripts/check-role-smoke.mjs`, API en proceso con la misma BD): 30 usuarios · 2.456 GET del menú de cada token
(la misma regla `readRoutesFor` de `rbac-nav-contract`) · 0 × 403 imprevisto · 61 403 previstos (`night_auditor` 4,
`manager` 4×3, `operations_director` 3×2, `accountant` 4, `controller` 2, `compliance` 29, `general_manager` 3,
`auditor` 1: huecos `sister`/`write` del contrato, p. ej. cumplimiento sin `pos.read`/`inventory.read`) · 84/84
escrituras contrarias por `SOD_STATIC_PAIRS` → 403 · 28/28 `GET /properties/<ajena>/reservations` → 404 «Propiedad no
encontrada». Menú = router = API: cada usuario abre las entradas de su token sin un solo 403 imprevisto, y
`apps/admin-web/src/routes/__tests__/route-access.test.mts` (puerta 3) fija que `resolveLocation(...).kind === "screen"`
⇔ `canSee` para toda URL × token.

## 7. Casos provocados por HTTP (12:49-12:50 CEST; `scratchpad/t8a-sod.mts`, 31/31)

### 7.1 Separación de funciones · reembolso > T2 (480 € en Rías Altas, folio de RES-00149)

| Paso | Quién | Petición | Respuesta |
|---|---|---|---|
| A1 | `recepcion.rias` | `POST /folios/:id/payments` 480 € efectivo (`payment.capture`) | 201 · pago `cmu6u6q7000itfy7zkebh78ie` (asiento 2393) |
| A2 | `recepcion.rias` | `POST /payments/:id/refund-requests` 480 € (`payments.refund_request`) | 201 · solicitud `cmu6u6q7r00ixfy7zkdoeocmn`, tramo **T3** |
| A3 | `jefatura.recepcion.rias` (T2) | `POST /approvals/:id/approve` | **403 `RBAC_LEVEL_EXCEEDED`** «El importe supera el tramo que puedes aprobar.» |
| A4 | `recepcion.rias` (solicitante) | `POST /approvals/:id/approve` | **409 `APPROVAL_SELF_DECISION`** «Nadie aprueba lo que ha solicitado.» |
| A5 | `direccion.rias` (T3) | `POST /approvals/:id/approve` | 200 · aprobada |
| A6 | `recepcion.rias` | `POST /payments/:id/refund` | 403 (requiere `payment.refund`) |
| A7 | `direccion.rias` (manager v2) | `POST /payments/:id/refund` | 403 (requiere `payment.refund`: la versión 2 lo retiró) |
| A8 | `direccion.financiera` | `POST /payments/:id/refund` 480 € efectivo | **200** · `APPROVAL_CONSUMED` · devolución `cmu6u6q8o00j0fy7zlk0nc6bv` (asiento 2394) |

Tres personas distintas (solicita ≠ aprueba ≠ ejecuta), como exige §4.7. En BD: `approval_requests` `status approved`,
`requested_by ≠ decided_by ≠ consumed_by`, caducidad a 7 días; auditoría `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`,
`APPROVAL_CONSUMED`, `PAYMENT_CAPTURED`, `PAYMENT_REFUNDED`.

### 7.2 Doble aprobación > T4 · CAPEX de 70.000 € (`POST /approvals`, sin ejecución)

| Paso | Quién | Respuesta |
|---|---|---|
| B1 | `encargado.mantenimiento.rias` (`capex.create`) | 201 · solicitud `cmu6u6q9900j4fy7zdwhoj5j7`, `ABOVE_T4`, `requiresSecondApproval: true` |
| B2 | `direccion.financiera` (T4 máx.) | 403 `RBAC_LEVEL_EXCEEDED` |
| B3 | `direccion.general` | 200 · primera aprobación (sigue pendiente de la segunda) |
| B4 | `direccion.general` otra vez | 409 `APPROVAL_SELF_DECISION` «La segunda aprobación debe darla otra persona.» |
| B5 | Carmen (`owner`, rango propiedad) | 200 · `second_approver_user_id = cmrhw9jyb0005fyvb4ykaumyc` → `approved` |

### 7.3 PIN de supervisor

`jefatura.recepcion.rias` fija su PIN (`POST /rbac/pin` con su contraseña → 200, `SUPERVISOR_PIN_SET`);
`recepcion.rias` pide una autorización para `payments.refund_approve` sobre el pago de 7.1 por 60 €: PIN erróneo →
**403 `SUPERVISOR_PIN_INVALID`**; PIN correcto → 201 (`cmu6u6qd400j5fy7z40a60sn0`, caduca a los 60 s, `used_at` NULL:
un solo uso, ligada a la entidad y al importe; `SUPERVISOR_AUTHORIZED`).

### 7.4 Break glass

| Paso | Quién | Respuesta |
|---|---|---|
| D1 | `direccion.general` (2FA activada por el seed) sin reto MFA | 403 `BREAK_GLASS_REAUTH_REQUIRED` |
| D1b | `direccion.rias` (sin `security.break_glass`) | 403 |
| D2 | Carmen (`general_manager`, sin 2FA) `{ reason, ticket "T8A-1", password, confirmHighRisk: true }` | 201 · sesión `cmu6u6qfm00j8fy7z9sblbile` · cuenta `emergencia-1@faranda.test` · `closesAt = openedAt + 4 h` · notificación 0/4 (§4.5) |
| D3 | sesión de emergencia | `GET /users/me` 200 (`breakGlassSessionId`, 249 claves) · `GET /rbac/access-log` 200 · `GET /properties/LT/reservations` 200 · `POST /rbac/assignments` **403 `RBAC_BREAK_GLASS_FORBIDDEN`** · `POST /rbac/break-glass` anidado 403 |
| D4 | Carmen | `GET /rbac/break-glass` 200 · `POST …/close` 200 → el token de emergencia responde **401** · `jefatura.recepcion.rias` `POST …/review` 403 `RBAC_SCOPE_EXCEEDED` |
| D5 | `auditoria.interna` | `POST …/review` 200 → `reviewed_by_user_id` sellado |
| D6 | `recepcion.rias` | `GET /rbac/break-glass` 403 (requiere `audit.read`) |

`break_glass_sessions`: ventana `04:00:00`, `closed_at` y `reviewed_at` sellados; la asignación temporal
`break_glass`/organización de la cuenta quedó `valid_to = closesAt` y `revoked_at` con `reason break_glass_closed:manual`;
auditoría `BREAK_GLASS_OPENED`, `BREAK_GLASS_SESSION`, `BREAK_GLASS_CLOSED`, `BREAK_GLASS_REVIEWED`. La caducidad
automática a las 4 h la aplica `loadUserContext` al llegar `closesAt` (y el barrido `closeExpiredBreakGlassSessions`);
aquí se ejercitó el cierre manual.

## 8. Invariantes (huellas md5 sobre las filas previas al corte; consultas en §10)

| Conjunto (Faranda) | Antes (12:22) | Después (12:52) |
|---|---|---|
| `journal_entries` previos | 4.949 · `dcd554b52a5f5b01cbdf27bac15aa5ee` | 4.949 · **misma huella** (total 4.951: +2393 pago, +2394 devolución del caso 7.1) |
| `journal_lines` previas | 21.058 · `05e2d3d6508325e88e1f04e53e48be8f` | 21.058 · **misma huella** (total 21.062: +4 líneas de esos dos asientos) |
| `invoices` | 25 · `cddc31f693346fd798893be906a2333d` | 25 · misma huella |
| `verifactu_submissions` | 33 · `3d4b0550f8685b82b7f6eeedf8ab24ba` | 33 · misma huella |
| lotes: `ledger_imports` · `payroll_cost_imports` · `reservation_imports` · `pms_shadow_revenue_imports` · `rate_change_journals` (total) | 34 · 1 · 7 · 2 · 93 | 34 · 1 · 7 · 2 · 93 |
| `permissions` | 250 | 250 (0 huérfanas en `role_permissions`) |

Otras escrituras del día en Faranda, todas intencionadas: 2 pagos (480 € capturado y devuelto), 2 `approval_requests`,
1 `supervisor_authorizations`, 1 `break_glass_sessions`, 2 grupos, 45 umbrales, 30 usuarios, 28 + 3 + 1 asignaciones
(+1 temporal de emergencia, revocada), 16 espejos; auditoría desde las 12:22: 864 `ACCESS_DENIED` (441 `out_of_scope`,
423 `missing_permission`: las sondas de ámbito y de permiso del smoke y de la matriz, deduplicadas por usuario, ruta y
minuto), 78 `AUTH_LOGIN`, 56 `PASSWORD_CHANGED` (rotación y restauración del smoke), 31 `ROLE_ASSIGNED`, 30
`USER_CREATED`, 12 `ROLE_CREATED_FROM_TEMPLATE`, 10 `ROLE_TEMPLATE_UPGRADED`.

## 9. Usuarios de demo y cómo usarlos

Todos `@faranda.test`, ficticios, sembrados por `packages/database/prisma/seed-rbac-demo.ts` (`corepack pnpm run
db:seed:rbac-demo -- --dry-run` para verlos). **Contraseña única del seed**: la constante `DEMO_PASSWORD` documentada en
ese fichero (sobreescribible con `RBAC_DEMO_PASSWORD`); el smoke y la matriz ya hicieron la rotación obligatoria y la
restauraron, así que hoy los 28 entran directamente con ella (`mustChangePassword = false`; volver a sembrar lo repone a
`true`). Las contraseñas de Carmen y de `recepcion.tilos` no están en el repo: fichero `t8a-credenciales.txt` del
scratchpad de la sesión (y memoria del proyecto).

| Usuario | Plantilla · nivel | Ámbito | Aterriza en | Aprueba hasta |
|---|---|---|---|---|
| `recepcion.pathos`, `recepcion.rias` (+ `recepcion.tilos`) | Recepción · N1 | PG · RA · LT | `/hoy` | ejecuta ≤ T1 con motivo; solicita el resto |
| `auditoria.noche.tilos` | Auditoría nocturna · N1 | LT | `/hoy` | corre el cierre del día |
| `jefatura.recepcion.tilos`, `jefatura.recepcion.rias` | Jefatura de recepción · N2 | LT · RA | `/hoy` | T2 (300 €); PIN de supervisor |
| `pisos.tilos` · `gobernanta.tilos` | Pisos · N1 · Gobernanta · N2 | LT | `/hoy/operaciones` (móvil: `/operaciones/pisos/mi-turno`) | — · T2 |
| `mantenimiento.rias` · `encargado.mantenimiento.rias` | Mantenimiento · N1 · Encargado · N2 | RA | `/hoy/operaciones` (móvil: `/operaciones/mantenimiento/mis-averias`) | — · T2; propone CAPEX |
| `tpv.pathos` · `jefatura.ab.pathos` | Punto de venta · N1 · Jefatura de A&B · N2 | PG | `/hoy/operaciones` | — · T2 |
| `comercial.galicia` | Comercial · N1 | grupo Galicia (LT+RA) | `/hoy/direccion` | — |
| `administracion.tilos` · `administracion.central` | Administración de hotel · N1 | LT · OC | `/finanzas/facturacion` | ejecuta reembolsos aprobados, registra facturas |
| `direccion.tilos`, `direccion.rias`, `direccion.pathos` | Dirección de hotel · N3 | LT · RA · PG | `/hoy/direccion` | T3 (3.000 €); cierra/reabre el día; anula factura |
| `operaciones.galicia` · `operaciones.norte` | Dirección de operaciones · N4 | Galicia · Asturias-Cantabria | `/hoy/direccion` | T4 (15.000 €); tarifas fuera de banda |
| `revenue` | Revenue corporativo · N4 | organización | `/hoy/direccion` | tarifas |
| `contabilidad` · `direccion.financiera` | Contabilidad · N7 · Dirección financiera · N5 | sociedad CELUISMA | `/hoy/direccion` | — · T4, paga, cierra periodos |
| `rrhh` · `cumplimiento` · `activos` | RRHH y nóminas · Cumplimiento · Gestión del activo · N7 | sociedad | `/finanzas/nominas` · `/hoy/direccion` (token finanzas) · `/cumplimiento/centro` (desviación L4 de §10.2) | — |
| `direccion.general` | Dirección general · N5 | organización | `/hoy/direccion` | > T4 (primera de las dos); abre break glass (exige 2FA) |
| `auditoria.interna` | Auditoría interna · N7 (solo lectura) | organización | `/configuracion/sistema` | — ; revisa break glass |
| `sistemas` | Administración de sistema · N7 | organización | `/configuracion/usuarios` | — ; usuarios, roles, módulos |
| `direccion@farandariasaltas.es` (Carmen) | Propiedad · N6 + Dirección general · N5 | organización | `/hoy/direccion` (el token `direccion` manda sobre `propiedad`; `/hoy/propietario` si la plantilla primaria es `owner`) | > T4 (segunda aprobación) |
| `emergencia-1`, `emergencia-2` | Emergencia (break glass) | organización, 4 h | — | solo por `POST /rbac/break-glass` |

Cómo verlo en el front (:5173 → :3000): entrar con `recepcion.tilos` y teclear `/finanzas/nominas` («Sin acceso · Ir a
mi página de inicio»), cambiar a Rías Altas en el selector (no aparece: solo LT); entrar con `direccion.rias`, abrir
Pendientes de aprobación (`/hoy/pendientes`) y ver la solicitud de 480 € aprobada y consumida; con `jefatura.recepcion.rias`
fijar el PIN desde el menú de usuario › «Mi PIN de supervisor»; con Carmen, Configuración › Usuarios y roles muestra
las pestañas «Este hotel» y «Sociedad» con la plantilla real, nivel y ámbito de cada persona.

## 10. SQL de verificación (solo lectura; `DATABASE_URL` de `.env`)

```sql
-- roles y versión
SELECT r.name, r.template_key, r.level, r.template_version, r.managed, count(rp.*) AS grants
FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
WHERE r.organization_id = 'cmrhw9jy30002fyvb6tsdiugt' GROUP BY 1,2,3,4,5 ORDER BY 1;          -- 24 filas, todas v2
SELECT count(*) FROM roles WHERE template_version = 2;                                        -- 46
SELECT count(*) FROM permissions;                                                             -- 250
SELECT count(*) FROM role_permissions rp LEFT JOIN permissions p ON p.id = rp.permission_id WHERE p.id IS NULL;  -- 0
-- asignaciones
SELECT scope_type, count(*) FROM user_role_assignments
WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND revoked_at IS NULL GROUP BY 1;       -- property 17 · property_group 3 · legal_entity 5 · organization 6
SELECT count(*) FROM user_property_roles;                                                     -- 26
-- auditoría del corte
SELECT action, count(*) FROM audit_events
WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND created_at > '2026-09-18 10:22:00'
  AND action IN ('ROLE_ASSIGNED','ROLE_CREATED_FROM_TEMPLATE','ROLE_TEMPLATE_UPGRADED','USER_CREATED',
                 'APPROVAL_REQUESTED','APPROVAL_DECIDED','APPROVAL_CONSUMED','SUPERVISOR_AUTHORIZED',
                 'BREAK_GLASS_OPENED','BREAK_GLASS_CLOSED','BREAK_GLASS_REVIEWED','ACCESS_DENIED') GROUP BY 1 ORDER BY 1;
-- invariantes (huellas de §8)
SELECT count(*), md5(string_agg(id || ':' || coalesce(entry_number::text,'') || ':' || coalesce(entry_date::text,'') || ':' || coalesce(posted_at::text,''), ',' ORDER BY id))
FROM journal_entries WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND posted_at <= '2026-09-18 10:22:00';   -- 4949 · dcd554b5…
SELECT count(*), md5(string_agg(i.id || ':' || i.status::text || ':' || coalesce(i.invoice_number,'') || ':' || coalesce(i.total::text,''), ',' ORDER BY i.id))
FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = 'cmrhw9jy30002fyvb6tsdiugt';     -- 25 · cddc31f6…
SELECT count(*) FROM verifactu_submissions vs JOIN invoices i ON i.id = vs.invoice_id JOIN properties p ON p.id = i.property_id
WHERE p.organization_id = 'cmrhw9jy30002fyvb6tsdiugt';                                                              -- 33
-- casos provocados
SELECT id, kind, status, amount, requested_by_user_id, decided_by_user_id, second_approver_user_id, consumed_by_user_id
FROM approval_requests WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' ORDER BY created_at;                     -- 2 filas
SELECT id, opened_at, closes_at, closed_at, reviewed_at, closes_at - opened_at AS ventana FROM break_glass_sessions;   -- 1 fila, 04:00:00
```

## 11. Pendientes tras la integración

### 11.1 Solo el orquestador: reiniciar el API :3000

El código servido ya es el nuevo (arrancó a las 12:10:17 con `RBAC_STRICT=true`, `HOTELOS_ALLOW_DEMO_AUTH=true` y sin
`HOTELOS_DEMO_PERMISSION_UNION`; ningún fuente del API cambió después salvo los tres CLI de §4.1, que no se cargan en el
servidor). Reiniciar sirve para (a) rehidratar la punta de la cadena de auditoría tras las escrituras de los CLI y del
seed (deuda 12(c)) y (b) refrescar los espejos en memoria del demoStore; los roles, permisos y asignaciones ya se leen de
Postgres por petición (`rbac_version` 3 invalidó las sesiones vivas).

### 11.2 Commit

Working tree sin commit (regla de la tanda). Ficheros del integrador en §2; el resto es de los lotes y del corrector.
`pnpm-lock.yaml` no se tocó (ya figuraba modificado antes de la tanda).

### 11.3 Trabajo posterior identificado (no bloquea)

- Plantilla de notificación `break_glass_opened` (email a dirección general, administración de sistema y auditoría interna).
- `GET /accounting/journal` (y las rutas de `finance-scope` con `?propertyId`) deberían aceptar también la cabecera
  `x-property-id` para usuarios de propiedad.
- Limpiar las 56 asignaciones de las 14 organizaciones `org_rbac_*` que dejan las suites de integración (o que las suites
  borren su organización al terminar).
- `deploy/README-INSTALL.md` §8 sigue diciendo 212 claves (250 hoy); `docs/design/RBAC-DEPARTAMENTOS.md` §6.5/§4.10
  conservan las estimaciones (owner −164 / admin −155, 23 plantillas): §10.1 C17 fija las cifras buenas y este informe
  las repite; no se reescribió el diseño.
- Migración de borrado de `user_property_roles` (L6 del diseño): bloqueada hasta que `packages/database/prisma/seed.ts`
  escriba en `user_role_assignments` (C8).
- El limitador de `/auth/login` (10/min) es fijo: si el smoke se usa en CI conviene un `RATE_LIMIT_LOGIN_MAX` de desarrollo.

## 12. Decisiones abiertas para César (diseño §8.2 con lo que la demo permite ver hoy)

| # | Decisión | Aplicado en la demo | Qué necesita de ti |
|---|---|---|---|
| D1 | Carmen: propiedad, dirección general o ambas | **Ambas** (`owner` + `general_manager`, organización): lee todo, aprueba > T4 como segunda firma, abre break glass | Confirmar; si solo Propiedad, retirar `general_manager` desde Usuarios y roles (queda con 65 claves de lectura y aprobaciones y sin operativa) |
| D2 | **Umbrales T1-T4 por sociedad** | CELUISMA: T1 50 € · T2 300 € · T3 3.000 € · T4 15.000 € · segunda firma de propiedad en facturas de proveedor > 60.000 € · banda de tarifa ± 15 % · descuento 10 % (recepción) / 25 % (jefatura); 45 filas en `role_thresholds`, editables con `PUT /rbac/thresholds` (dirección financiera + confirmación de alto riesgo) | Las cifras reales de CELUISMA por sociedad y moneda; si en un hotel pequeño la jefatura debe aprobar más, se ajusta por rol (`roleLimits`) sin tocar código |
| D2b | **Quién aprueba qué** | Ajustes de folio y reembolsos: ≤ T2 jefatura de recepción, ≤ T3 dirección de hotel, ≤ T4 dirección financiera, > T4 dirección general + propiedad; anulación de factura: dirección de hotel (emisor ≠ aprobador); facturas de proveedor: dirección de hotel ≤ T3, dirección financiera ≤ T4, DG + propiedad por encima; pedidos: jefaturas ≤ T2, dirección de hotel ≤ T3, operaciones ≤ T4; nómina mensual: DG; CAPEX: DG + propiedad; tarifas fuera de banda: operaciones/DG | Confirmar la tabla (§4.7 del diseño) o marcar cambios: cada celda es una fila de umbrales o una clave de plantilla, no código |
| D3 | Subdirección | Sin plantilla; `manager` con umbral T2 por rol | ¿Hay subdirectores en los hoteles? |
| D4 | Quién corre y revisa el cierre del día | Auditoría nocturna corre; administración de hotel o contabilidad revisa | ¿Hay turno de noche en cada hotel o cierra recepción de tarde? |
| D5 | Grupos de propiedades | Galicia = LT + RA; Asturias-Cantabria = PG + MC + AS; FN y LL sin grupo | Reparto real de los 7 hoteles (y si Florida Norte / Las Lomas cuelgan de otra dirección) |
| D6 | Plantilla «Administración de sistema» | Conservada (`sistemas`, 70 claves, sin finanzas ni operativa) | ¿Quién administra el sistema en CELUISMA? |
| D7 | Gestión del activo y auditoría interna como personas | Sembradas como personas ficticias (`activos`, `auditoria.interna`) | ¿Existen esos puestos o los asume dirección financiera? |
| D8 | 2FA obligatoria N2+ y PIN de supervisor | Flag `mfaEnabled` en 19 usuarios (se exige en break glass; el login lo pedirá cuando se active el reto) | Confirmar |
| D9 | Retención de `audit_events` | 6 años (cadena hash, sin purga) | Confirmar |
| D10 | Nóminas: DG aprueba el registro mensual, dirección de hotel las variaciones | Así | Confirmar |
| — | **Lista de personas reales por hotel** | 30 usuarios ficticios de demo | Nombre, correo y puesto de cada persona en cada hotel (recepción, jefatura, pisos, mantenimiento, A&B, administración, dirección) y de la central (contabilidad, dirección financiera, RRHH, cumplimiento, revenue, operaciones): con eso se invita desde Usuarios y roles (§3 del runbook `accesos-por-departamento.md`) y se desactivan los ficticios |

## 13. Comandos reproducibles (desde `hotelos/`; F = `cmrhw9jy30002fyvb6tsdiugt`)

```bash
export $(grep ^DATABASE_URL= .env | xargs)
pg_dump -Fc "$DATABASE_URL" > ../backups/hotelos-pre-rbac8a-$(date +%Y%m%d-%H%M%S).dump
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/reseed-property-roles.ts --org $F)                       # dry-run
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/reseed-property-roles.ts --org $F --apply --confirm $F)
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/rbac-migrate-assignments.ts --org $F --dry-run --general-manager cmrhw9jyb0005fyvb4ykaumyc)
(cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/rbac-migrate-assignments.ts --org $F --apply --confirm $F --general-manager cmrhw9jyb0005fyvb4ykaumyc)
(cd packages/database && node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts --dry-run)
(cd packages/database && SEED_ALLOW_REAL=1 SEED_CONFIRM=$F node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts)
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run --upgrade-templates
corepack pnpm --filter @hotelos/api rbac:sync -- --upgrade-templates
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run                                                                            # 0 behind
node scripts/check-role-smoke.mjs --json > /tmp/smoke.json                                                                            # ≈ 6 min (limitador de login)
node --test tests/rbac-cli-audit-contract.test.mjs tests/rbac-demo-seed-contract.test.mjs tests/rbac-nav-contract.test.mjs
```

## 14. Documentos relacionados

`docs/design/RBAC-DEPARTAMENTOS.md` (diseño, §10 anexo) · `docs/runbooks/rbac-sync.md` (§2 versión 2, §7 reseed, §8
migración y bloque «Ejecutado el 2026-09-18») · `docs/runbooks/accesos-por-departamento.md` (matriz, alta de personas,
umbrales, SoD, PIN, break glass, D1-D10) · `docs/api-contracts.md` (rutas `/rbac/*`, `/approvals*`, cabecera
`x-property-id`) · `packages/database/prisma/seed-rbac-demo.ts` · `scripts/check-role-smoke.mjs` ·
`tests/{rbac-sod-contract, rbac-engine-contract, rbac-nav-contract, rbac-demo-seed-contract, rbac-cli-audit-contract}.test.mjs`.
