# Revisión Adversarial · AUDIT-code-backend.md

**Fecha:** 2026-06-21 · **Revisor:** staff engineer (verificación contra código real en `apps/api`)
**Método:** lectura directa de los ficheros y líneas citadas por el primario; rastreo de callers; verificación de constraints en `schema.prisma`.

---

## Veredicto rápido

Auditoría primaria **sólida y honesta**. Los 4 hallazgos de bloqueo (H1–H4) son **reales y bien diagnosticados**, con paths y números verificables. Penalizo dos cosas: (a) over-credita el aislamiento multi-tenant y **se le escapó un fail-open de *escritura* cross-tenant** tan grave como H1; (b) H10 trató los 6 raw-unsafe como un bloque "a revisar" sin detectar que uno construye SQL dinámico.

**Calidad de la auditoría primaria: 82 / 100.**

---

## Hallazgos CONFIRMADOS

- **H1 — RBAC fail-open en GET (CRÍTICO).** Verificado en `route-permissions.ts:1064-1068`: `if (!route) { if GET return; }`. El comentario `:994-997` admite el agujero textualmente. **Agravante que el primario no remarcó:** el contract test `tests/api-route-permissions-contract.test.mjs:53` hace `assert.match(manifest, /input\.method\.toUpperCase\(\) === "GET"/)` — es decir, **el test fija el comportamiento vulnerable como contrato**. Endurecerlo (fix propuesto) además romperá ese assert. Severidad y fix correctos.

- **H2 — Oversell en escritura (CRÍTICO).** Confirmado. `createReservation` (`pms.service.ts:344-446`) hace `tx.reservation.create` sin contar inventario. La función de disponibilidad real se llama **`quoteAvailability`** (no `countAvailability` como dice el primario — error de nombre menor) y su único caller es `server.ts:3496` (`POST /properties/:propertyId/availability/quote`). Jamás se invoca en la escritura. El fix (recalcular dentro de `$transaction` + lock pesimista, porque `count()+create()` no es serializable bajo READ COMMITTED) es técnicamente correcto.

- **H3 — Rate limiting (CRÍTICO/ALTO).** Confirmado: `server.ts:842` `global: false`; solo 5 rutas declaran `config.rateLimit` (login/MFA/guest-portal/bootstrap). `keyGenerator:846` confía en `x-forwarded-for[0]` sin allowlist de proxy → spoofeable. Fix sensato. *Matiz:* la severidad CRÍTICO es defendible pero para un piloto single-node es más bien ALTO; el riesgo real es DoS/brute-force, no exfiltración directa.

- **H4 — Tests no son de integración (ALTO).** Confirmado y **peor de lo descrito**: los 37 `.test.mjs` usan `readFileSync` + regex sobre el fuente. `pms-lifecycle.test.mjs` **reimplementa `canAssignRoom` dentro del propio test** y valida esa copia, no el código de producción. 0 ficheros usan `app.inject()`/`fetch`/`supertest`. La red de seguridad real es prácticamente nula. (Nota: hay **39** ficheros `.test.mjs` en el repo, no 37; viven en `/tests` raíz y `packages/compliance`, no en `apps/api/tests`.)

- **H5 — `server.ts` monolítico (ALTO).** Confirmado exacto: `wc -l` = **6889**, **772** rutas inline, ~200 imports. Solo 3 grupos extraídos a plugins. Correcto.

- **H6 — Validación Zod marginal (ALTO).** Confirmado: **30** `parse()` reales vs **408** handlers POST/PUT/PATCH. El path de reserva sí valida (`server.ts:3518` con `CreateReservationSchema` + `.passthrough()`), la mayoría no. Correcto.

- **H7 — Race en código de reserva (ALTO).** Confirmado: `pms.service.ts:396-397` `count()`→`RES-${count+1}`. `@@unique([propertyId, code])` existe en `schema.prisma` (línea ~2030 del bloque Reservation). **No hay ningún `catch`/retry/P2002** en todo `pms.service.ts` (verificado por grep). El segundo `create` concurrente revienta con 500. Diagnóstico y fix correctos.

- **H8 — Fallback demo por `NODE_ENV` (MEDIO).** Confirmado en `auth-context.ts:67-71`. Fix (flag positivo `HOTELOS_ALLOW_DEMO_AUTH`) es la mejora correcta. **El primario subestimó esto:** ver Nuevo-1 abajo, hay un *segundo* fallback aún más peligroso.

- **H9 — CORS comodín LAN (MEDIO).** Confirmado `server.ts:827`: regex `192\.168\.\d+\.\d+` + `credentials:true`. Real. Correcto.

- **H10 — N+1 + raw-unsafe (BAJO).** Parcialmente confirmado, **mal cerrado** (ver Refutados).

**Positivos confirmados:** JWT HS256 + `timingSafeEqual` + rechazo `change-me` (`jwt.ts:27,66`); `scrypt` + comparación constante (`password.ts`); error handler no filtra stack (`server.ts:806-811`). Todo verificado y correcto.

---

## Hallazgos REFUTADOS o EXAGERADOS

- **Positivo "Multi-tenant" — EXAGERADO / parcialmente FALSO.** El primario afirma "las queries de PMS filtran por `organizationId` (derivado del JWT)". Eso es cierto en **lecturas** (`quoteAvailability`, listados con `where: organizationId`), pero **FALSO en la escritura de reservas**. `createReservation` opera sobre `propertyId` crudo sin verificar pertenencia al org (ver Nuevo-1). Acreditar aislamiento multi-tenant sin auditar el path de escritura es el fallo más serio del informe.

- **H10 — raw-unsafe "a revisar" — bajo-investigado.** El primario dice "verificar que ninguno interpola input de usuario" y lo deja abierto. Verificado yo: **5 de 6 usan placeholders parametrizados** (`$1,$2…`) → seguros (`wallet-pass.service.ts:196,272,297`, `assistant.tools.ts:253`). El **sexto NO**: `jobs/pii-backfill.ts:79` construye `SELECT ${cols} FROM "${tableName}" ${where} ... LIMIT ${limit}` por interpolación de string (ver Nuevo-2). El hallazgo debió cerrarse con conclusión, no dejarse como TODO. Severidad BAJO global es razonable porque el N+1 está acotado, pero mezclar "raw-unsafe sin analizar" en un BAJO enmascaró un patrón de SQL dinámico.

- **Conteo "37 tests".** Hay 39 `.test.mjs`. Trivial, pero el informe usa cifras exactas en otros sitios, así que conviene corregir.

---

## Hallazgos NUEVOS (omitidos por el primario)

- **NUEVO-1 [CRÍTICO] — Escritura cross-tenant en reservas (IDOR).** `POST /properties/:propertyId/reservations` (`server.ts:3513-3556`) toma `propertyId` del path y lo pasa tal cual a `createReservation`, que **nunca valida que ese `propertyId`/`roomTypeId` pertenezca a `request.userContext.organizationId`**. Un usuario autenticado del org A puede crear reservas (y abrir folios) en la propiedad de otro tenant simplemente cambiando el path param. Combinado con H1 (cualquier `GET` nuevo es público), el aislamiento multi-tenant **no se sostiene en producción**. Esto es de la misma gravedad que H1–H2 y debería ser H0. **Fix:** en `createReservation`, cargar la propiedad y `assert property.organizationId === context.organizationId` antes del `create`; idem para `roomTypeId`/`ratePlanId`. Auditar el mismo patrón en el resto de rutas `/(properties|reservations)/:id/*` que aceptan id por path.

- **NUEVO-2 [MEDIO] — RBAC preHandler vuelve a caer al super-usuario demo incluso en prod.** `server.ts:885`: `userPermissions: request.userContext?.permissions ?? demoStore.userContext.permissions`. Aunque `auth-context.ts` bloquea el fallback de *identidad* en prod, este `??` evalúa permisos contra el **super-usuario demo** (`demo-store.ts:2247+`: reservas, pagos, compliance, GDPR…) si `userContext` llegara null por cualquier ruta. Defensa en profundidad rota: el default debería ser `[]` (deny), no el set más permisivo del sistema. El primario tocó el fallback de auth (H8) pero no este segundo punto en el chequeo de permisos.

- **NUEVO-3 [BAJO] — `pii-backfill.ts:79` construye SQL dinámico.** `LIMIT ${limit}` y `${tableName}`/`${cols}` se interpolan (no parametrizados). Hoy `limit` y las columnas vienen de constantes internas y `cursorId` se escapa, así que la explotabilidad es baja, pero es un job que se ejecuta con privilegios y bypasea la extensión de cifrado. Migrar a `Prisma.sql`/`$queryRaw` con identificadores validados.

---

## Score del informe primario

| Eje | Nota | Comentario |
|---|---:|---|
| Exactitud de hallazgos | 30/35 | H1–H9 verificables y correctos; nombre `countAvailability` erróneo; H10 sin cerrar |
| Severidades | 17/20 | Coherentes; H3 quizá sobre-clasificado para single-node |
| Calidad de fixes | 19/20 | Técnicamente sólidos (lock pesimista, fail-closed, type-provider) |
| Cobertura (gaps) | 16/25 | **Se le escapó IDOR de escritura cross-tenant** y el 2º fallback de permisos; over-credita multi-tenant |
| **Total** | **82/100** | Auditoría de buena fe, técnicamente competente, pero con un punto ciego material en el path de escritura |

**Conclusión:** comparto el veredicto del primario ("no apto multi-tenant prod"), pero por una razón **más fuerte** de la que dio: además de RBAC-read fail-open, el path de **escritura** carece de validación de tenant. La remediación debe ampliarse a NUEVO-1 antes que cualquier otra cosa.
