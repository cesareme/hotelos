# Auditoría de Código · Backend (`apps/api`)

**Fecha:** 2026-06-21 · **Alcance:** `apps/api` (Fastify 5 + Prisma 6) + `packages/database`
**Tamaño:** ~71.8k LOC src · 772 endpoints en `server.ts` + 427 en `modules/` · 250 modelos Prisma · 37 tests
**Auditor:** revisión estática (Grep/Read). Sin ejecución de la app.

---

## Resumen ejecutivo

El backend es funcionalmente ambicioso y, en varios puntos, está **bien pensado**: cifrado de PII por envelope (AES-256-GCM) vía extensión Prisma, JWT HS256 con `timingSafeEqual` y rechazo de `JWT_SECRET=change-me`, passwords con `scrypt`, aislamiento multi-tenant por `organizationId` derivado del contexto (no del cliente) en los módulos revisados, y migración progresiva del monolito `server.ts` a `modules/` con servicios que aplican `requirePermissions` (296 checks).

Sin embargo hay **defectos estructurales que bloquean producción**:

1. **RBAC con fail-open en lecturas**: `assertRoutePermission` deja pasar **cualquier GET sin entrada en el manifiesto** (server-side confirmado en código). Es un agujero de autorización por diseño, parcheado caso a caso.
2. **Oversell real**: el camino de *escritura* de reservas no valida disponibilidad dentro de la transacción. El "OVERSELL FIX" solo arregló la *lectura* de disponibilidad.
3. **Rate limiting casi inexistente**: 5 de 772 rutas limitadas; el resto sin protección anti-abuso.
4. **Tests no son de integración**: 0/37 ejercitan la API real (son contract checks sobre el código fuente).

`server.ts` (6 889 LOC, 772 endpoints) sigue siendo un monolito de acoplamiento alto pese a `modules/`: importa ~200 servicios y registra casi todas las rutas inline. La deuda de `db push` (50 tablas sin migración) está **documentada y mitigada** con un baseline aditivo, lo cual es un punto positivo de madurez.

**Veredicto:** sólido para piloto controlado, **no apto para multi-tenant en producción** hasta cerrar RBAC de lecturas, oversell y rate limiting.

---

## 10 hallazgos priorizados

### 1. [CRÍTICO] RBAC fail-open: todo GET sin manifiesto queda sin autorización
`apps/api/src/security/route-permissions.ts:1064-1068`
```ts
const route = findRoutePermission(input.method, input.path);
if (!route) {
  if (input.method.toUpperCase() === "GET") { return; }   // ← permite el acceso
  throw new Error(`No route permission manifest entry ...`);
}
```
El propio código (comentario en `:994-997`) admite que esto deja "financial submissions, PII profiles, allotment inventory y guest-portal session data efectivamente sin gate". Se mitiga añadiendo entradas a mano (773 entradas), pero **cualquier GET nuevo nace público**. Con 546 handlers que leen `request.params`, la superficie es enorme.
**Fix:** invertir a *fail-closed*: si no hay entrada en el manifiesto → `throw ForbiddenError` (también para GET). Añadir un test que falle el build si algún endpoint registrado carece de entrada (ya existe `api-route-permissions-contract.test.mjs`; endurecerlo para cubrir GETs).

### 2. [CRÍTICO] Oversell: la creación de reserva no comprueba disponibilidad
`apps/api/src/modules/pms/pms.service.ts:344-446`
La transacción `createReservation` valida fechas, crea huésped, genera código y hace `tx.reservation.create(...)` **sin contar inventario disponible**. La lógica de disponibilidad (`countAvailability`, `:1054-1115`, con el comentario "OVERSELL FIX") es un **path de lectura separado** que nunca se invoca en la escritura. Resultado: dos reservas concurrentes (o una sobre inventario lleno) se confirman igual.
**Fix:** dentro de `$transaction`, recalcular `available = totalRooms − overlappingActive` para `roomTypeId`+fechas y `throw new ConflictError("No availability")` si `< roomsCount`. Para concurrencia real usar bloqueo pesimista (`SELECT ... FOR UPDATE` sobre una fila de inventario por roomType/fecha) o un constraint/contador atómico, ya que `count()`+`create()` no es serializable bajo `READ COMMITTED`.

### 3. [CRÍTICO] Rate limiting ausente en el 99% de endpoints
`apps/api/src/server.ts:841-844` (`global: false`) y solo `:1012,:1041,:1055,:1089,:1102`
El limiter se registra global-off y **únicamente 5 rutas** (login/MFA/guest-portal) declaran `config.rateLimit`. Los otros ~767 endpoints —incluidos exports de PII, reporting pesado y mutaciones financieras— no tienen límite. Además el `keyGenerator` confía en `x-forwarded-for` sin allowlist de proxy (`:845-847`), spoofeable si el LB no lo sanea.
**Fix:** poner `global: true` con un límite por defecto razonable (p.ej. 120/min) y subir/bajar por ruta; documentar que `x-forwarded-for` solo es fiable tras el reverse-proxy propio (validar `trustProxy` en Fastify).

### 4. [ALTO] Tests no ejercitan la API: cobertura de comportamiento ≈ 0
`tests/*.test.mjs` (37 ficheros, 4 356 LOC)
**0 ficheros** hacen `fetch`/`inject`/`http`/`supertest`. Son *contract checks* que leen código fuente con `readFileSync`/regex y afirman que ciertas cadenas existen. No hay garantía de que un endpoint responda, que una transacción haga commit, ni que el oversell se bloquee. La métrica "37 tests" sobreestima la red de seguridad real.
**Fix:** añadir suite de integración con `app.inject()` (Fastify lo trae sin servidor) cubriendo al menos: login, crear reserva (incl. oversell), post de cargo en folio, y un GET protegido sin permiso (debe dar 403). Bloquear merge si baja la cobertura de estos paths.

### 5. [ALTO] `server.ts` monolítico: 6 889 LOC / 772 rutas / ~200 imports
`apps/api/src/server.ts:1-820` (imports) · rutas inline hasta `:6776`
Pese a `modules/`, el grueso de rutas se define inline en una sola función. Acoplamiento alto: un cambio en cualquier dominio toca el mismo fichero gigante, dificulta code review, multiplica el riesgo de merge y ralentiza el typecheck. Solo 3 grupos están extraídos como plugins (`webhooksRoutes`, `assistantRoutes`, `touristTaxRoutes`, `:1280-1282`).
**Fix:** continuar la extracción a plugins Fastify por bounded context (`app.register(pmsRoutes)`, etc.), moviendo handlers a `modules/<x>/<x>.routes.ts`. Meta incremental: < 500 LOC en `server.ts` (solo bootstrap, hooks y `register`).

### 6. [ALTO] Validación Zod marginal: ~44 `parse()` para 408 mutaciones
`apps/api/src/lib/validate.ts` (helper) · uso: 29 en `server.ts` + 15 en `modules/`
Hay 408 handlers `POST/PUT/PATCH` y 337 lecturas de `request.body`, pero solo ~44 llamadas a `parse(schema, ...)`. El propio `validate.ts` reconoce que no se cableó `@fastify/type-provider-zod` "porque tocaría 695 handlers". La mayoría de bodies entran sin validar tipos/longitudes → riesgo de datos corruptos, `null`s no esperados y errores 500 en vez de 400.
**Fix:** adoptar el type-provider Zod a nivel de ruta de forma incremental (empezando por finanzas/folios/reservas, que ya tienen schemas en `src/schemas/`). Cada ruta nueva debe declarar `schema.body`.

### 7. [ALTO] Generación de código de reserva con race condition
`apps/api/src/modules/pms/pms.service.ts:396-397`
```ts
const count = await tx.reservation.count({ where: { propertyId: input.propertyId } });
const code = `RES-${String(count + 1).padStart(5, "0")}`;
```
Con `@@unique([propertyId, code])` (schema `:2841`), dos reservas concurrentes calculan el mismo `count+1` y la segunda **revienta con P2002**. El patrón count-then-create no es atómico. Además, borrados lógicos (`deletedAt`) desalinean el contador.
**Fix:** usar una secuencia por propiedad (tabla contador con `update ... returning`, o `Prisma` autoincrement dedicado), o capturar P2002 y reintentar. No derivar de `count()`.

### 8. [MEDIO] Fallback a super-usuario demo depende de un único `NODE_ENV`
`apps/api/src/lib/auth-context.ts:62-72` y `server.ts:885`
En `preHandler`, si `userContext` es null se usa `demoStore.userContext.permissions` (un usuario con permisos amplios: reservas, pagos, compliance, GDPR — `demo-store.ts:2247-2271`). El bloqueo de producción es correcto (`if NODE_ENV==="production" && !isPublic throw 401`), **pero toda la autenticación cuelga de una sola cadena de entorno**. Un deploy con `NODE_ENV` mal seteado abre la API entera con permisos de demo.
**Fix:** exigir un flag explícito y positivo (`HOTELOS_ALLOW_DEMO_AUTH=true`) en vez de inferir por `NODE_ENV`; default seguro = sin fallback. Loggear en arranque si el fallback está activo.

### 9. [MEDIO] CORS regex permite cualquier IP de LAN y depende de `PILOT_PUBLIC_ORIGIN`
`apps/api/src/server.ts:824-836`
`/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/` con `credentials: true` permite **cualquier** origen `192.168.x.x` en cualquier puerto. En una red compartida (hotel, coworking) eso habilita CSRF/credential-bearing requests desde cualquier dispositivo de la LAN. El único origen público sale de `PILOT_PUBLIC_ORIGIN`; si no se setea, no hay frontend permitido pero la LAN sigue abierta.
**Fix:** restringir el allowlist de dev a `localhost`/`127.0.0.1`; eliminar el comodín de `192.168.*` o ponerlo tras flag de dev. En prod, lista explícita de orígenes.

### 10. [BAJO] N+1 acotado + `executeRawUnsafe` (6 usos) a revisar
`apps/api/src/modules/invoicing/invoice.service.ts:188`, `pms.service.ts:1058-1115`, `night-audit-preflight.service.ts` (varios `slice(0,5).map(async ...)`)
Los `.map(async)` con query por iteración son pocos (7) y la mayoría están acotados por `slice(0,5)` o por nº de roomTypes, así que el impacto es bajo hoy; `countAvailability` hace 3 queries por roomType y escalará mal con catálogos grandes. Aparte, hay **6 usos de `$queryRawUnsafe`/`$executeRawUnsafe`**: hay que verificar que ninguno interpola input de usuario.
**Fix:** agrupar las queries por-roomType de `countAvailability` en agregaciones únicas (`groupBy`); auditar los 6 raw-unsafe y migrar a `$queryRaw` con template tags si tocan datos externos.

---

## Observaciones positivas (no penalizadas)

- **PII encryption** robusta: `packages/database/src/client.ts` cifra/descifra de forma transparente vía `$extends` (compatible Prisma 6), con `*LookupHash` determinista para búsquedas por campo cifrado (`crypto-fields.ts`). Cubre `Guest`, `GuestRegisterRecord`, `EmailConnection` (tokens OAuth/IMAP), PSP refs.
- **Auth crypto** correcta: JWT HS256 con `timingSafeEqual` y validación de `exp`/claims (`jwt.ts`); passwords `scrypt` con salt y comparación constante (`password.ts`); rechazo explícito de `passwordHash` vacío y de `JWT_SECRET=change-me`.
- **Multi-tenant**: las queries de PMS filtran por `input.context.organizationId` (derivado del JWT), no por parámetro del cliente.
- **Migraciones**: la deriva de `db push` (50 tablas) está **reconocida y resuelta** con un baseline aditivo y un `MIGRATIONS_README.md` honesto. Buen ejemplo de gestión de deuda.
- **Manejo de errores** central no filtra stack traces: 5xx devuelven "Internal Server Error" genérico, con Sentry y `correlationId` (`server.ts:806-814`).

---

## Score: **58 / 100**

| Eje | Peso | Nota | Comentario |
|---|---:|---:|---|
| Arquitectura / acoplamiento | 20 | 10/20 | `modules/` en marcha, pero `server.ts` monolítico de 772 rutas |
| Seguridad | 30 | 15/30 | PII+JWT+scrypt buenos; RBAC fail-open, rate-limit y CORS lastran |
| Correctness (tx, races) | 20 | 9/20 | Oversell en escritura, race en código de reserva |
| Prisma / datos | 15 | 11/15 | Buenos índices y baseline; pocas FK a nivel DB, N+1 menores |
| Tests | 15 | 5/15 | Contract checks útiles pero 0 integración real |
| **Total** | **100** | **58** | Apto piloto; no apto multi-tenant prod sin H1–H4 |

**Prioridad de remediación:** H1 (RBAC fail-open) → H2 (oversell) → H3 (rate limit) → H4 (tests integración). Cerrar esos cuatro sube el score por encima de 80.
