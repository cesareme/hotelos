# Auditoría de Código · Backend (`apps/api`) — Ronda 2

**Fecha:** 2026-06-21 · **Alcance:** `apps/api` (Fastify 5 + Prisma 6) + `packages/database`
**Método:** revisión estática (Grep/Read). Sin ejecución de la app.
**Base:** verifica la remediación de `docs/audits/general-2026-06/AUDIT-code-backend.md` (score previo 58/100) y busca hallazgos nuevos.

---

## Resumen ejecutivo

La ronda de remediación del 2026-06-21 **es real**: los 9 fixes de backend (1–9) están presentes y bien
implementados en el código actual, no son cosméticos. Lo más importante (IDOR cross-tenant en escritura, oversell
transaccional con advisory lock, rate-limit global, default-deny de permisos, gate de schedulers, guard de drift en
deploy y tests de integración reales con `app.inject` + Postgres en CI) está cerrado o mitigado correctamente. Eso
sube el eje de seguridad y correctness de forma tangible.

Quedan, sin embargo, **residuos conscientes** y **hallazgos nuevos** que el equipo no debe perder de vista:

1. **RBAC fail-open sigue activo por defecto.** El fix 5 (RBAC_STRICT) es opt-in y está **OFF a propósito**, así que
   el agujero original (cualquier GET sin manifiesto pasa sin gate) sigue vivo en la configuración por defecto. Hay
   ~352 rutas GET y solo 286 entradas GET en el manifiesto → del orden de 60+ GETs aún sin mapear.
2. **NUEVO crítico:** `verifyUnlock` (mobile-keys) **no verifica la firma** del intento de apertura — devuelve `ok:true`
   para cualquier llave activa y no caducada conocido solo el `serialNumber` (que viaja en el QR). Es bypass de
   cerradura.
3. **H8 de ronda 1 NO remediado:** el fallback al super-usuario demo sigue colgando únicamente de `NODE_ENV` en
   `auth-context.ts`. El fix 2 cambió el set de permisos del preHandler, pero no la cadena de autenticación.
4. La race del código de reserva (`RES-####` derivado de `count()`) **sigue presente** y solo está parcialmente
   cubierta por el advisory lock (lock por roomType, count por property).

**Veredicto:** la remediación es sólida y de buena fe; el backend mejora de "no apto multi-tenant prod" a "apto para
piloto con vigilancia". Para producción multi-tenant faltan: activar RBAC_STRICT con manifiesto completo, arreglar
`verifyUnlock`, y desacoplar el fallback demo de `NODE_ENV`.

---

## Estado de la remediación (fixes 1–9)

| # | Fix | Confirmado | Evidencia |
|---|---|:---:|---|
| 1 | IDOR escritura cross-tenant | ✅ REAL | `pms.service.ts:349-373` valida `property/roomType/ratePlan` vs `context.organizationId` antes de crear; test `api-integration.test.mts:52` (404). |
| 2 | Default-deny permisos | ✅ REAL | `server.ts:898` usa `request.userContext?.permissions ?? []` (no demoStore). |
| 3 | Rate limit global + anti-spoof | ✅ REAL | `server.ts:845` `global:true`, `max:200`; `keyGenerator` solo confía `x-forwarded-for` con `TRUST_PROXY==="1"` (`:852`). |
| 4 | Oversell en escritura | ✅ REAL | `pms.service.ts:384` `pg_advisory_xact_lock` + recount `:388-411` dentro de `$transaction`. |
| 5 | RBAC fail-closed opt-in | ✅ REAL (OFF) | `route-permissions.ts:1082` `RBAC_STRICT==="true"` → 403; default fail-open con `console.warn` `:1077`. Intencional. |
| 6 | Scheduler leader gate | ✅ REAL | `lib/scheduler-leader.ts:23` `RUN_SCHEDULERS!=="false"`; aplicado en `server.ts:6795` a los 5 schedulers. |
| 7 | Deploy drift guard (DROP) | ✅ REAL | `deploy/scripts/deploy.sh:44` `grep -qiE 'DROP[[:space:]]+(TABLE\|COLUMN)'` → aborta. |
| 8 | Tests integración `app.inject` + CI | ✅ REAL | `tests/integration/api-integration.test.mts` (health/default-deny/IDOR); job `integration-tests` con Postgres `ci.yml:105`. |
| 9 | CI migrado a pnpm | ✅ REAL | `.github/workflows/ci.yml` usa `pnpm/action-setup@v4` + `pnpm install --frozen-lockfile` en todos los jobs. |

**9 / 9 fixes de backend confirmados como reales.** (Fix 5 cumplido pero deshabilitado por diseño.)

Nota sobre tests (fix 8): la suite de integración existe y es real, pero es **mínima** (3 casos). No cubre todavía
oversell concurrente, post de cargo en folio ni un 403 de RBAC — los casos que más valor de regresión tendrían.

---

## 10 hallazgos priorizados

### 1. [CRÍTICO · NUEVO] `verifyUnlock` no valida la firma — bypass de cerradura
`apps/api/src/modules/mobile-keys/wallet-pass.service.ts:263-287`
La función descarta la firma con `void input.signature;` (`:285`) y retorna `{ ok: true }` para cualquier llave
`status="active"` no caducada, identificada **solo por `serialNumber`** — que viaja en claro dentro del `qrPayload`
(`:188`). Cualquiera que lea el QR (o adivine el serial) abre la puerta. El propio comentario admite "we only have a
hash of secret, so we trust the phone signed". Además solo se almacena `secretHash`, por lo que recomputar la firma es
imposible por diseño.
**Fix:** challenge-response real: emitir un nonce, que el teléfono firme `HMAC(secret, nonce‖timestamp)` y verificar.
Requiere persistir el secreto cifrado (vía PII envelope) o derivar uno por puerta. Hasta entonces, no exponer `ok:true`.

### 2. [CRÍTICO · RESIDUAL] RBAC fail-open sigue siendo el comportamiento por defecto
`apps/api/src/security/route-permissions.ts:1070-1086`
El fix 5 es correcto pero `RBAC_STRICT` está **OFF por defecto**, así que el agujero de ronda 1 persiste en producción
salvo que se active explícitamente. Cobertura: ~352 `app.get(` en `server.ts` vs **286** entradas `method:"GET"` en el
manifiesto → del orden de **60+ GETs sin gate**, cada uno público de facto. El `console.warn` ayuda a detectarlos pero
no protege.
**Fix:** completar el manifiesto para los GET de PII/finanzas/allotment, añadir test que falle el build si un GET
registrado no tiene entrada, y poner `RBAC_STRICT=true` por defecto en el contrato de entorno de prod.

### 3. [ALTO · RESIDUAL/H8] Fallback a super-usuario demo cuelga solo de `NODE_ENV`
`apps/api/src/lib/auth-context.ts:67-70`
El fix 2 endureció el *set de permisos* del preHandler, pero la **cadena de autenticación** no cambió: si la petición
no trae token válido y `NODE_ENV !== "production"`, se asigna `demoStore.userContext` (super-user con 82 permisos,
`demo-store.ts:2253`). Un deploy con `NODE_ENV` mal seteado (o ausente) abre la API entera con permisos de demo. Toda
la auth pende de una sola cadena de entorno.
**Fix:** exigir flag positivo y explícito `HOTELOS_ALLOW_DEMO_AUTH=true` (default = sin fallback) en vez de inferir por
`NODE_ENV`; loggear al arranque si el fallback está activo.

### 4. [ALTO · RESIDUAL/H7] Race en el código de reserva `RES-####`
`apps/api/src/modules/pms/pms.service.ts:465-466`
Sigue siendo `count()`-then-create con `code String @unique` (schema `:287`). El advisory lock del fix 4 **no cubre
este caso**: el lock se llava por `(propertyId, roomTypeId)` (`:384`) y solo cuando hay `roomTypeId`, pero el contador
es por `propertyId` global — dos reservas de **distinto roomType** en la misma propiedad calculan el mismo `count+1` y
la segunda revienta con P2002. Los borrados lógicos también desalinean el contador.
**Fix:** secuencia por propiedad (tabla contador con `UPDATE ... RETURNING`) o capturar P2002 y reintentar; no derivar
de `count()`.

### 5. [ALTO · RESIDUAL/H9] CORS permite cualquier IP `192.168.*` con `credentials:true`
`apps/api/src/server.ts:828`
El regex `/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/` con `credentials:true` (`:834`) habilita
peticiones con credenciales desde **cualquier** dispositivo de la LAN en cualquier puerto. En red de hotel/coworking
compartida es vector de CSRF/credential-bearing. No tocado en la remediación.
**Fix:** restringir el allowlist de dev a `localhost`/`127.0.0.1`; el comodín LAN solo tras flag de dev. En prod, lista
explícita.

### 6. [ALTO · RESIDUAL/H6] Validación Zod marginal en mutaciones
`apps/api/src/server.ts` (29 `parse(` ) · 408 handlers `POST/PUT/PATCH` · 337 `request.body` · 132 `as never`
La proporción no mejoró: la inmensa mayoría de bodies entran sin validar tipos/longitudes y se castean con `as never`
hacia los servicios. Riesgo de datos corruptos, `null`s inesperados y 500 en vez de 400. Los schemas existen en
`src/schemas/` pero no están cableados a nivel de ruta.
**Fix:** adoptar `@fastify/type-provider-zod` de forma incremental empezando por finanzas/folios/reservas; cada ruta
nueva declara `schema.body`.

### 7. [MEDIO · NUEVO] Night audit sin atomicidad transaccional entre pasos
`apps/api/src/modules/night-audit/night-audit.service.ts:132-138`
`run()` ejecuta 7 pasos secuenciales (validar folios, snapshot, **post de cargos de habitación**, no-shows, snapshot
revenue, reconciliación, avance de business date), **cada uno con sus propias escrituras y fuera de un `$transaction`
común**. Un fallo a mitad (p.ej. tras postear cargos pero antes de avanzar la fecha) deja efectos parciales; el `catch`
marca el run como fallido pero no revierte los cargos ya posteados. Hay guard de estado (`:90-93`) que evita doble
ejecución, lo que limita el daño, pero no garantiza all-or-nothing.
**Fix:** envolver los pasos con efecto contable en un único `prisma.$transaction`, o hacer cada paso idempotente y
re-ejecutable desde el último completado.

### 8. [MEDIO · NUEVO] Secreto de webhook almacenado en claro
`apps/api/src/modules/webhooks/webhooks.service.ts:99` · `schema.prisma:1742` (`secretRef String?`)
El secreto HMAC del webhook se guarda tal cual en `secretRef` (texto plano) y se usa para firmar la entrega
(`:176-177`). No está en `PII_FIELDS` (`crypto-fields.ts:119`, que sí cifra tokens OAuth/IMAP y refs PSP), así que no
pasa por el envelope AES-256-GCM. Una fuga de la BD expone todos los secretos de firma → un atacante puede falsificar
webhooks salientes válidos.
**Fix:** cifrar `secretRef` con el envelope existente (añadir `WebhookSubscription` a `PII_FIELDS`) o guardar solo un
hash y derivar la firma de un secreto en el vault.

### 9. [BAJO · MEJORA] Money en `number` (float) en el cálculo de balances de folio
`apps/api/src/modules/folio/folio-balance.service.ts:36-43,125-132`
Los importes `Prisma.Decimal` se convierten a `number` (`dec()`) y se acumulan con sumas en coma flotante, mitigado con
`round2()` (`Math.round(x*100)/100`). Funciona para volúmenes de piloto, pero la acumulación de floats antes del redondeo
puede arrastrar 1 céntimo en folios con muchas líneas. El esquema sí usa `@db.Decimal(12,2)` (correcto en almacenamiento).
**Fix:** operar con `Prisma.Decimal`/entero de céntimos en el agregado y redondear una sola vez al final.

### 10. [BAJO · RESIDUAL/H5] `server.ts` sigue monolítico
`apps/api/src/server.ts` (6 908 LOC, ~352 GET + ~408 mutaciones inline)
Pese a `modules/`, el grueso de rutas sigue inline en una sola función; solo 3 grupos extraídos como plugins
(`webhooks`, `assistant`, `tourist-tax`). Acoplamiento alto, code review costoso, typecheck lento. No empeoró pero
tampoco avanzó.
**Fix:** continuar extracción a plugins Fastify por bounded context; meta < 500 LOC en `server.ts` (bootstrap + hooks +
`register`).

---

## Observaciones positivas (no penalizadas)

- **Remediación de buena fe y verificable:** los 9 fixes existen con comentarios trazables (`audit 2026-06 · #N`) y
  evidencia en código, no son placeholders.
- **Oversell**: la combinación advisory lock + recount dentro de `$transaction` es la solución correcta para
  serializar reservas del mismo roomType bajo READ COMMITTED.
- **IDOR**: la validación de pertenencia de `property/roomType/ratePlan` al tenant antes de crear es robusta y está
  cubierta por test de integración.
- **Guest portal**: tokens guardados como `tokenHash`, lookup por hash, expiración perezosa y sign-out que no filtra
  existencia (`guest-portal-auth.service.ts:203-240`). Bien hecho.
- **Raw SQL**: los 6 usos de `$queryRawUnsafe`/`$executeRawUnsafe` revisados (mobile-keys, assistant.tools,
  pii-backfill) están **parametrizados con `$1..$n`** — no hay interpolación de input de usuario, sin SQLi.
- **Error handler**: `statusCodeForError` mapea errores tipados; 5xx devuelven mensaje genérico sin stack
  (`server.ts:784-814`).

---

## Score: **72 / 100** (antes 58)

| Eje | Peso | Nota | Comentario |
|---|---:|---:|---|
| Arquitectura / acoplamiento | 20 | 11/20 | `server.ts` aún monolítico; sin avance en extracción a plugins |
| Seguridad | 30 | 19/30 | IDOR/rate-limit/default-deny cerrados; lastran RBAC opt-in, `verifyUnlock`, fallback NODE_ENV, CORS LAN, secreto webhook |
| Correctness (tx, races) | 20 | 14/20 | Oversell resuelto; race de código y night-audit no transaccional pendientes |
| Prisma / datos | 15 | 12/15 | Buen baseline; secreto en claro y money en float menores |
| Tests | 15 | 9/15 | Integración real existe (gran avance) pero suite mínima (3 casos) |
| **Total** | **100** | **72** | Apto piloto vigilado; falta para multi-tenant prod |

**Prioridad ronda 3:** H1 (`verifyUnlock`) → H2 (activar RBAC_STRICT + completar manifiesto) → H3 (desacoplar fallback
demo de `NODE_ENV`) → H4 (race código reserva). Cerrar esos cuatro acerca el score a 85+.
