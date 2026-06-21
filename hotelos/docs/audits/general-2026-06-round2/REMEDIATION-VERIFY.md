# Verificación independiente de la remediación · 2026-06-21 (round 2)

Auditoría escéptica de los 15 fixes aplicados sobre `docs/audits/general-2026-06/`.
Para cada fix se leyó el código real (no el changelog). Veredicto: **REAL** (implementado
y correcto), **PARCIAL** (existe pero con hueco), **FALSO** (no está / no funciona).

## Resumen de veredictos

**REAL: 13 · PARCIAL: 2 · FALSO: 0**

Los dos PARCIAL son el #1 (IDOR) y el #15 (ds-drift). Ninguno es falso: todos los
cambios reclamados existen físicamente en el árbol y hacen lo que dicen en su ámbito.
El matiz importante está en el alcance del #1 (ver párrafo final).

## Tabla

| # | Fix | Veredicto | Evidencia (file:line) | Hueco |
|---|-----|-----------|------------------------|-------|
| 1 | IDOR escritura cross-tenant en createReservation | **PARCIAL** | `apps/api/src/modules/pms/pms.service.ts:349-375` valida `property.organizationId === context.organizationId` (404) y que roomType/ratePlan pertenezcan al property. Dentro de `$transaction`. | El guard SOLO está en `createReservation`. Otras escrituras que reciben `propertyId`/IDs de la URL NO validan tenant: `createRoom` (`pms.service.ts:209-237`, crea room bajo cualquier propertyId), `patchReservation` (`:593` `findUnique` sin orgId), `assignRoom` (`:815-816` `findUnique` de reservation+room sin orgId). `assignedRoomId` tampoco se valida dentro de createReservation. IDOR de escritura sigue abierto en esas rutas. |
| 2 | Default-deny en preHandler (`?? []` en vez de demoStore super-user) | **REAL** | `apps/api/src/server.ts:898` usa `request.userContext?.permissions ?? []`. El gate productivo real está en `apps/api/src/lib/auth-context.ts:67-69` (en producción, request no pública sin token → 401). | El `?? []` casi nunca dispara: `registerAuthContext` siempre asigna `userContext` (real o demoStore, `auth-context.ts:70`). En dev no-prod, una request sin token sigue recibiendo el super-user demoStore. El default-deny efectivo depende de `NODE_ENV==='production'`. Aceptable por diseño, pero el `?? []` es cinturón, no el candado. |
| 3 | Rate limit `global:true` + keyGenerator anti-spoof TRUST_PROXY | **REAL** | `apps/api/src/server.ts:842-863`: `global:true`, `max:200/1min`, `keyGenerator` solo confía en `x-forwarded-for` si `TRUST_PROXY==='1'`, si no usa `req.ip`. Rutas auth endurecen con `config.rateLimit` (p.ej. `:1025` max 10, `:1054` max 5). | Memoria local (no Redis) → no compartido entre réplicas; el propio comentario lo reconoce. Suficiente para piloto single-node. |
| 4 | Oversell: advisory lock + recount en la $transaction | **REAL** | `pms.service.ts:384` `pg_advisory_xact_lock(hashtext(propertyId), hashtext(roomTypeId))` dentro de `$transaction` (`:344`); recount de `room.count` (`:388`) y `reservation.count` overlapping (`:396`) con check `overlapping+requested>totalRooms` → ConflictError (`:406`). Lock por (property,roomType), se libera al cerrar la tx. | Solo aplica si `roomTypeId` está presente (`:383`). El path de read-quote (`quoteAvailability`/`checkAvailability` ~`:1100`) no toma lock, pero la escritura sí, que es donde importa. |
| 5 | RBAC fail-closed opt-in (RBAC_STRICT) + log de GETs sin manifiesto | **REAL** | `apps/api/src/security/route-permissions.ts:1067-1090`: GET sin entrada → `console.warn` deduplicado (`loggedUnmappedGets`, `:1075-1081`) y fail-open por defecto; `RBAC_STRICT==='true'` → `ForbiddenError` (`:1082-1084`). POST/PATCH/DELETE sin manifiesto → siempre `throw` (`:1087`). Permisos reales via `assertPermissions` (`packages/shared/src/permissions.ts:390-395`). | OFF por defecto a propósito (declarado). El fail-open de GETs sigue siendo la superficie de lectura no cubierta hasta que se active el flag. |
| 6 | Scheduler leader gate (RUN_SCHEDULERS) | **REAL** | `apps/api/src/lib/scheduler-leader.ts:23-36` (`RUN_SCHEDULERS !== 'false'`). Usado de verdad: `server.ts:6795` `const schedulerLeader = isSchedulerLeader(...)` y los 5 schedulers van tras `if (schedulerLeader && ...)` (p.ej. SES `:6801`, pace `:6818`, allotment `:6835`). | Es un switch manual por réplica, no elección automática de líder (el propio doc lo marca como upgrade futuro). Funciona para evitar duplicados si se configura bien. |
| 7 | Deploy drift guard: bloquea DROP TABLE/COLUMN | **REAL** | `deploy/scripts/deploy.sh:36-54`: `prisma migrate diff --script` y `grep -qiE 'DROP[[:space:]]+(TABLE\|COLUMN)'` → `fail` salvo `ALLOW_DESTRUCTIVE_MIGRATION=1`. Corre antes del `db push` (`:56`). | El diff se captura con `|| true` (`:43`); si el comando de diff fallara silenciosamente, `DRIFT_SQL` quedaría vacío y el grep no detectaría nada (fail-open ante error de la herramienta). Riesgo bajo pero presente. |
| 8 | Tests integración app.inject + job CI integration-tests | **REAL** | `tests/integration/api-integration.test.mts`: usa `buildApiServer()` + `app.inject` real; cubre default-deny (`:41-50`, fuerza `NODE_ENV=production`, espera 401) e IDOR (`:52-69`, POST a property inexistente → 404). Script `package.json:22` `test:integration`. Job CI `.github/workflows/ci.yml:105-136` con servicio Postgres 16. | El test IDOR usa un propertyId inexistente; valida el camino 404 pero no un property de OTRA org existente (no prueba el cross-tenant estricto, solo el not-found). Cobertura buena, no exhaustiva. |
| 9 | CI migrado a pnpm | **REAL** | `.github/workflows/ci.yml`: `pnpm/action-setup@v4` y `pnpm install --frozen-lockfile` en todos los jobs (`:24,29,38,43`, etc.); `cache: 'pnpm'`. Sin rastro de `npm ci`. | — |
| 10 | Tokens de estado + focus ring único + tints dark-safe | **REAL** | `apps/admin-web/src/styles/cocoa-tokens.css:42-66` define `--cocoa-success/warning/danger`, `*-bg/*-border` via `color-mix`, `--cocoa-focus-ring` (`:66`); variantes dark en `:264-271` y `@media prefers-color-scheme` `:332-337`. Consumido: `CocoaButton.tsx:276` (`cocoa-focus-ring`), `CocoaInput.tsx:114` (`var(--cocoa-focus-ring)`). | `CocoaTable.tsx` no referencia el focus-ring (sin elementos focusables propios); trivial. El fix nombra Table pero no lo consume. |
| 11 | Estados carga/error en Room Rack + Night Audit | **REAL** | `RoomRackScreen.tsx:21,144,228-231` (`useApiData` + `<ErrorState onRetry={refresh}>` / `<LoadingBlock>`), comentario `:214-215`. `NightAuditScreen.tsx:18,98,158-161` (mismo patrón, comentario `:155-156` sobre el banner rojo engañoso). | — |
| 12 | Datos demo vaciados del alta de reserva | **REAL** | `ReservationCreateScreen.tsx:58-132` `defaultForm`: `firstName/surname1/surname2/email/documentNumber/...` todos `""`. Comentario `:443-445`. Lo que queda con valor son defaults de configuración (fechas, board `BB`, `channel:direct`, `nationality:ESP`), no identidad de huésped demo. | — |
| 13 | A11y scroll-to-first-error en la reserva | **REAL** | `ReservationCreateScreen.tsx:262-269` `focusInvalidField` (`scrollIntoView` + `.focus({preventScroll})`); cableado en `handleCreate` `:450,457` para roomType/firstName/surname1. IDs existen: `:686,824,830`. | — |
| 14 | OTAs marcadas como mock + CLAUDE.md corregido | **REAL** | `packages/integrations/src/channel-manager.ts:1-16` docblock "HONEST STATUS", todos `createMockChannelAdapter` (`:213-219`), `pullReservations` devuelve "Maria Lopez Garcia" hardcodeada (`:186`), warnings explícitos (`:135`). `CLAUDE.md:91-96` y `:195-197` marcan los 5 adapters como MOCK y "NO hay conexión OTA real". | — |
| 15 | Brief decision Aurora vs Cocoa + script ds-drift | **PARCIAL** | `docs/design-system/DESIGN-SYSTEM-DECISION.md` existe y es sustantivo (problema, datos verificados 156/202 vs 27/202, recomendación). `scripts/check-design-system-drift.mjs:1-30` report-only, soporta `--enforce`. Script `package.json:27` `ds:drift`. | El script NO está cableado a ningún hook husky ni job de CI (grep solo lo encuentra en `package.json`). Es ejecutable a mano pero no aplica drift automáticamente; queda como herramienta inerte hasta que alguien la invoque. El propio script dice "flip on --enforce in the pre-commit hook" — todavía no hecho. |

## ¿Mejoró de verdad la postura de seguridad multi-tenant?

Sí, mejoró de forma real y verificable, pero de forma **incompleta y desigual**. Lo
sólido: el control de rate limit (#3) ahora es default-on y resistente a spoofing del
`x-forwarded-for`; el oversell (#4) está correctamente cerrado con un advisory lock
transaccional más recount dentro de la misma `$transaction`, que es la forma correcta
de serializar reservas concurrentes sin bloquear todo el inventario; el default-deny
productivo (#2) tiene su candado real en `auth-context.ts:67-69` (sin token en
producción → 401), no en el `?? []` del preHandler que es solo defensa en profundidad;
y el RBAC (#5) ahora registra y puede fallar cerrado bajo `RBAC_STRICT`. Todo esto es
genuino y eleva el suelo de seguridad.

El problema de fondo es el **alcance del fix de IDOR (#1)**, que es el corazón del
aislamiento multi-tenant y el único marcado PARCIAL por motivo de seguridad. El guard
de organización está implementado con cuidado —404 en vez de 403 para no filtrar
existencia, validación de que roomType y ratePlan pertenecen al property, todo dentro
de la transacción— pero vive **exclusivamente en `createReservation`**. Las demás
escrituras del mismo módulo PMS que reciben identificadores desde la URL no comprueban
tenant: `createRoom` (`pms.service.ts:209`) inserta una habitación bajo cualquier
`propertyId` sin verificar la org; `patchReservation` (`:593`) y `assignRoom`
(`:815-816`) hacen `findUnique` por ID y operan sin filtrar por `organizationId`.
Es decir: la auditoría original encontró un IDOR de escritura, la remediación lo tapó
en el endpoint que se auditó, pero el patrón vulnerable —confiar en IDs de la ruta sin
revalidar pertenencia— sigue presente en rutas hermanas. Un atacante autenticado en la
org A podría seguir creando habitaciones o reasignando habitaciones a reservas de la
org B si conoce/adivina los IDs. La defensa real contra esto sería un middleware o un
helper de scoping (p.ej. siempre filtrar por `organizationId` en el `where`, o un
`assertPropertyInOrg(context, propertyId)` reutilizable) aplicado a TODO el módulo, no
fix por fix. El test de integración (#8) refuerza esta lectura: prueba el IDOR solo
contra un property inexistente (camino 404), no contra un property real de otro tenant,
así que no detectaría la regresión en las rutas no parcheadas.

Conclusión: la postura mejoró —los siete fixes de seguridad existen y ninguno es falso—
pero el aislamiento multi-tenant **no está cerrado**, solo está cerrado en un endpoint.
Mientras la validación de tenant siga siendo ad-hoc por función en vez de un invariante
estructural del módulo, la clase de bug original sobrevive. Recomendación de prioridad
para la siguiente ronda: extender el guard de organización a `createRoom`,
`patchReservation`, `assignRoom` (y validar `assignedRoomId` dentro de
`createReservation`), y añadir un test de integración que use dos orgs reales.
