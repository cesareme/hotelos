# Revisión Adversarial · Backend (`apps/api`) — Ronda 2

**Fecha:** 2026-06-21 · **Rol:** staff engineer escéptico · **Método:** lectura directa del código citado por el primario.
**Objeto:** `docs/audits/general-2026-06-round2/AUDIT-code-backend.md`.

---

## Veredicto corto

El audit primario es **honesto y mayormente preciso**. Verifiqué los 9 fixes leyendo el código y **los 9 son reales**, no cosméticos. Los hallazgos nuevos (verifyUnlock, night-audit, secreto webhook) son **reales y bien fundamentados**. Encontré solo desviaciones menores de rutas/paths y un sub-hallazgo que el primario subestimó (doble posteo de cargos en re-run de night audit). El score 72/100 es razonable; lo ajusto a **70/100** por el riesgo contable de night-audit, mayor de lo que el primario refleja.

---

## Confirmados (verificados contra el código)

- **Fix 1 — IDOR escritura.** REAL. `pms.service.ts:349-375` valida `property.organizationId === context.organizationId` (404) y `roomType/ratePlan` vs `propertyId`, dentro del `$transaction`. Test `tests/integration/api-integration.test.mts:52` espera 404. Confirmado.
- **Fix 2 — Default-deny.** REAL. `server.ts:898` usa `request.userContext?.permissions ?? []`, nunca demoStore. Comentario `NUEVO-2` presente.
- **Fix 3 — Rate limit + anti-spoof.** REAL. `server.ts:844` `global:true, max:200`; `keyGenerator` solo confía `x-forwarded-for` con `TRUST_PROXY==="1"`, si no usa `req.ip`. Confirmado.
- **Fix 4 — Oversell.** REAL. `pms.service.ts:384` `pg_advisory_xact_lock(hashtext(prop),hashtext(rt))` + recount de rooms/overlapping dentro del `$transaction`. Correcto bajo READ COMMITTED.
- **Fix 5 — RBAC fail-closed opt-in.** REAL y OFF por defecto (`route-permissions.ts:1082`). El `console.warn` + `return` fail-open es el default (`:1075-1085`). Intencional, confirmado.
- **Fix 6 — Scheduler leader gate.** REAL. `scheduler-leader.ts:24` `RUN_SCHEDULERS !== "false"`. Confirmado.
- **Fix 7 — Deploy drift guard.** REAL. `deploy/scripts/deploy.sh` hace `prisma migrate diff` y `grep -qiE 'DROP[[:space:]]+(TABLE|COLUMN)'` → `fail`, con override `ALLOW_DESTRUCTIVE_MIGRATION=1`. Más robusto de lo que sugiere la tabla (usa diff real, no solo grep del script).
- **Fix 8 — Tests integración + CI.** REAL. Test boota `buildApiServer` con `app.inject`; 3 casos (health 200, default-deny 401, IDOR 404). Job `integration-tests` en `ci.yml` con `postgres:16`. Confirmado.
- **Fix 9 — CI pnpm.** REAL. `pnpm/action-setup@v4` + `pnpm install --frozen-lockfile` en todos los jobs.

**Counts del primario verificados exactos:** 352 `app.get(`, 286 `method:"GET"` en manifiesto (→ 66 GET sin mapear), 408 mutaciones, 29 `parse(`, 132 `as never`, 337 `request.body`. No infló nada.

**Hallazgos nuevos/residuales confirmados:**
- **H1 verifyUnlock (CRÍTICO).** REAL. `wallet-pass.service.ts:285` `void input.signature;` y `return {ok:true}` con solo `serialNumber` + status + expiración. Solo se persiste `secretHash` (`:209`), así que recomputar la firma es imposible por diseño — la verificación es inverificable. El `serial` viaja en claro en `qrPayload` (`:188`). Bypass real.
- **H3 fallback demo / NODE_ENV.** REAL. `auth-context.ts:67-70`: si no hay token válido y `NODE_ENV !== "production"`, asigna `demoStore.userContext`. La cadena de auth no cambió con el fix 2. Confirmado; las líneas citadas son exactas.
- **H4 race `RES-####`.** REAL. `pms.service.ts:465-466` `count({where:{propertyId}})` global + `code @unique` (schema `:287`). El advisory lock es por `(prop,roomType)` y solo si hay `roomTypeId` — no protege el contador por propiedad. Análisis correcto.
- **H5 CORS LAN.** REAL. `server.ts:827` regex `192\.168\.\d+\.\d+` + `credentials:true` (`:835`). Confirmado.
- **Finding 7 night-audit no transaccional.** REAL. `run()` ejecuta 7 `steps.push(await step…)` secuenciales, cada uno con escrituras propias (`folioLine.create`, etc.), sin `$transaction` común. El guard `:87-95` solo bloquea `completed`/`in_progress`. Confirmado.
- **Finding 8 secreto webhook en claro.** REAL. `webhooks.service.ts:99` guarda `secretRef: secret` (plano) y firma con él (`:176-177`). `PII_FIELDS` (en `packages/database/src/crypto-fields.ts:119`) no incluye `WebhookSubscription`. Confirmado.
- **Finding 9 money en float.** REAL. `folio-balance.service.ts:36-44` `dec()`→number, acumulación en floats, `round2()` al final. Menor, bien calificado.

---

## Refutados / imprecisiones (todas menores)

- **Path del test de integración.** El primario cita `apps/api/tests/integration/api-integration.test.mts`; el archivo real está en la **raíz del repo**: `tests/integration/api-integration.test.mts` (importa `../../apps/api/src/server.js`). El contenido y la línea `:52` son correctos; el prefijo de ruta no.
- **Path de `crypto-fields`.** El primario cita `crypto-fields.ts:119` sin prefijo claro; el archivo vive en `packages/database/src/crypto-fields.ts`, no en `apps/api`. La línea 119 (`PII_FIELDS`) es correcta.
- Ninguna afirmación material fue refutada. No hay invención de evidencia.

---

## Lo que se le escapó al primario (nuevo)

1. **[ALTO · amplifica Finding 7] Night audit re-postea cargos de habitación en re-run.** `stepPostRoomChargesForInHouse` (`night-audit.service.ts:245-291`) crea `folioLine type:"room"` **sin idempotencia** (no consulta si ya existe el cargo del día). El guard de `run()` solo bloquea `completed`/`in_progress`; un run en estado `failed` **se puede re-ejecutar** (el upsert lo vuelve a `in_progress` y reejecuta todos los pasos). Combinado con la falta de `$transaction`, un fallo tras postear cargos pero antes de avanzar la fecha + re-run → **cargos de habitación duplicados en el folio**. El primario menciona "no revierte cargos" pero no detecta que el re-run los **duplica**. Esto eleva el riesgo contable por encima de un MEDIO.
2. **[INFO] No hay regresiones introducidas por la remediación.** Revisé default-deny, advisory lock e IDOR guard: ninguno rompe rutas legítimas (la validación IDOR usa `findUnique` + comparación de org, sin efectos colaterales; el lock se libera con la tx). El test de default-deny togglea `NODE_ENV` y lo restaura en `finally`, pero al ser proceso compartido podría filtrar estado entre tests si se paraleliza — riesgo bajo, vale anotarlo.
3. **[BAJO] `testSubscription` hace `fetch` saliente a `targetUrl` arbitrario sin validación SSRF** (`webhooks.service.ts:182`), aunque exige permiso `developer.manage_webhooks`. No es nuevo del fix pero queda fuera del audit.

---

## Score

**70 / 100** (primario: 72). Bajo 2 puntos por el doble-posteo de night-audit, que sube el eje *Correctness* de riesgo respecto a lo evaluado. El resto de la rúbrica del primario es defendible. La remediación es de buena fe y verificable; el backend pasa de "no apto multi-tenant prod" a "apto piloto vigilado". Para prod faltan, por orden: H1 verifyUnlock → idempotencia/tx en night-audit → RBAC_STRICT con manifiesto completo → desacoplar demo de NODE_ENV → H4 race de código.
