# AUDIT — Arquitectura y Producción (Ronda 2)

**Fecha:** 2026-06-21 · **Alcance:** monorepo, multi-tenant, CI/CD, deploy, HA, observabilidad, integraciones, compliance.
**Baseline:** ronda 1 = `docs/audits/general-2026-06/AUDIT-architecture.md` (score 69/100).

---

## 1. Resumen ejecutivo

La ronda de remediación del 2026-06-21 es **real y verificada en el código**, no cosmética. Los 6 fixes que se pidió confirmar (5, 6, 7, 8, 9, 14) están aplicados y bien razonados. El núcleo del producto sigue siendo de nivel senior: dominio PMS+ERP profundo, RBAC explícito, guardas IDOR en escritura, leader-gate de schedulers, drift-guard de deploy y honestidad documental sobre los mocks de OTA.

El problema de la ronda 2 ya **no es el código de la aplicación**, sino el **plumbing de despliegue**: la configuración de producción (`deploy/docker-compose.production.yml`) no activa los mecanismos que la remediación añadió, y omite un servicio completo (`worker`). El resultado es que varias defensas existen en el código pero **no están cableadas en producción**, y procesos de negocio críticos (reintentos VeriFactu, entrega de webhooks, notificaciones) no se ejecutan en el despliegue documentado. La nota sube respecto a la ronda 1 por la calidad de la remediación, pero queda lastrada por esa brecha código↔deploy.

### Confirmación de fixes solicitados

| # | Fix | Estado | Evidencia |
|---|-----|--------|-----------|
| 5 | RBAC fail-closed opt-in (`RBAC_STRICT` + log de GET sin manifiesto) | ✅ Real, OFF por defecto a propósito | `route-permissions.ts:1077-1087` — `console.warn` siempre, `throw` solo si `RBAC_STRICT==="true"` |
| 6 | Scheduler leader gate (`RUN_SCHEDULERS`) | ✅ Real | `lib/scheduler-leader.ts` + `server.ts:6795` gatea los 5 schedulers in-process |
| 7 | Rate limit `global:true` + `keyGenerator` anti-spoof `TRUST_PROXY` | ✅ Real | `server.ts:844-862` |
| 8 | Tests integración `app.inject` + job CI | ✅ Real | `tests/integration/api-integration.test.mts` (default-deny + IDOR 404) + job `integration-tests` con Postgres |
| 9 | CI migrado a pnpm | ✅ Real | `.github/workflows/ci.yml` usa `pnpm/action-setup@v4` + `--frozen-lockfile` en 8 jobs |
| 14 | OTAs marcadas como mock honestamente | ✅ Real | `channel-manager.ts:4-8,131-218` (cabecera + `createMockChannelAdapter`) + `CLAUDE.md` corregido |

Los otros fixes (1-4, 10-13, 15) se verificaron por muestreo y también están presentes (drift-guard `deploy.sh:36-54`, ds-drift `scripts/check-design-system-drift.mjs`, decisión DS en `docs/design-system/`).

---

## 2. Diez hallazgos

### H1 — [CRÍTICO] El servicio `worker` no existe en el compose de producción
`deploy/docker-compose.production.yml` define `postgres`, `redis`, `api`, `admin-web`, `caddy`, `postgres-backup` — **pero no `worker`** (`grep -c worker` = 0). Sin embargo, `apps/worker/src/scheduler.ts` es el único lugar donde se programan (pg-boss) `verifactu.retry` (`*/2`), `webhooks.deliver` (`*/1`) y las colas de notificaciones. Los schedulers in-process del `api` cubren SES, pace, allotment, group-cutoff y mailbox, **pero NO verifactu.retry ni webhooks**. Consecuencia: en el despliegue documentado, **los reintentos de VeriFactu y la entrega de webhooks nunca se ejecutan**. Una factura que falle el primer envío a la AEAT se queda en `retrying` para siempre → incumplimiento fiscal silencioso.

### H2 — [CRÍTICO] `RUN_SCHEDULERS` y `TRUST_PROXY` no se setean en producción
La remediación añadió ambos flags, pero `deploy/docker-compose.production.yml` no los define para el servicio `api` (`grep` en `deploy/` e `infra/` = 0 ocurrencias). Efectos:
- **`TRUST_PROXY` ausente** + Caddy delante → `keyGenerator` cae al `req.ip`, que es la IP del contenedor Caddy para *todas* las peticiones. El rate-limit global (200/min) se aplica al tráfico agregado de todos los clientes: una sola IP abusiva tira el límite para el hotel entero (DoS auto-infligido), y el anti-spoof no aporta nada.
- **`RUN_SCHEDULERS` ausente** = default `true`. Es correcto a single-node, pero el fix HA solo funciona si alguien recuerda ponerlo a `false` manualmente al escalar. No hay leader-election automática (el propio `scheduler-leader.ts` lo reconoce como futuro).

### H3 — [ALTO] Rate-limit en memoria pese a tener Redis disponible
`@fastify/rate-limit` se registra sin store Redis (`server.ts:841`, comentario "Usa memoria local"). Redis ya está en el compose de producción y en `REDIS_URL`. Con >1 réplica de `api` cada una tiene su propia ventana → el límite efectivo se multiplica por el nº de réplicas y es inconsistente. Es un cambio de una línea (`redis: new Redis(...)`) que cierra a la vez el problema de cluster.

### H4 — [ALTO] El deploy aplica el esquema con `db push`, no con `migrate deploy`
`deploy/scripts/deploy.sh:56-60` usa `prisma db push --skip-generate`. El drift-guard (#7) mitiga el riesgo destructivo, pero `db push` **no es transaccional, no respeta el historial de migraciones y no es auditable**. Existen migraciones en `packages/database/prisma/migrations/` (incluida la baseline `20260601000000`), pero el deploy las ignora. `MIGRATIONS_README.md` documenta honestamente la deriva de 50 tablas. Hasta migrar a `prisma migrate deploy`, cada despliegue es una mutación directa de producción sin rollback limpio.

### H5 — [ALTO] `/health` no comprueba realmente Redis ni el worker
`server.ts:923-928`: el sub-check `redis` reporta `ok:true` con solo ver que `REDIS_URL` no es placeholder — **nunca hace PING**. Igual para `objectStorage` (`unconfigured` hardcoded). El healthcheck del compose (`/health`) puede dar verde con Redis caído, pg-boss parado o el worker ausente. El único check real es `SELECT 1` a Postgres. Un health "production-grade" debe pingar Redis y, idealmente, verificar liveness de la cola de jobs.

### H6 — [MEDIO] `validate-env` solo comprueba presencia, no que el valor sea real
`scripts/validate-env.mjs:34` filtra por claves ausentes, pero **acepta `JWT_SECRET=change-me`** y demás placeholders. El runtime sí falla-cerrado para JWT (`packages/database/src/jwt.ts:27` lanza si `=== "change-me"`), lo cual es bueno, pero el gate de CI de "env contract" pasaría en verde con secretos placeholder. Debería rechazar valores `change-me`/vacíos y exigir longitud mínima (32 chars) para `JWT_SECRET`/`ENCRYPTION_KEY`.

### H7 — [MEDIO] HA real ausente: sin leader-election ni réplicas declaradas
No hay `deploy:`/`replicas:` en el compose; el despliegue es estrictamente single-node. El leader-gate (#6) es un flag manual, no elección automática (Postgres advisory-lock lease o pg-boss singleton). Mientras el negocio sea single-node está bien, pero **"HA" no está resuelto, solo preparado**: escalar a 2 réplicas sin tocar env duplicaría envíos SES/VeriFactu a la AEAT (sancionable) — exactamente el riesgo que el fix pretendía evitar, reactivado por config.

### H8 — [MEDIO] OTAs 100% mock = bloqueante de producción funcional, no técnico
Confirmado honestamente (#14): los 5 adapters son mock, `pullReservations` devuelve "Maria Lopez Garcia" hardcodeado. No es una regresión — la documentación es ahora correcta — pero sigue siendo un **bloqueante de go-live para cualquier hotel que dependa de OTAs**. Un PMS sin channel-manager real es una demo, no un sistema de producción para el segmento objetivo (Mews/Cloudbeds/Stayntouch).

### H9 — [BAJO/MEDIO] Observabilidad limitada a `/metrics` casero
`server.ts:974` expone contadores de 24h + memoria, no formato Prometheus (lo dice el propio comentario). Sentry es lazy-opcional. No hay tracing distribuido ni métricas RED (rate/errors/duration) por endpoint. Para un sistema fiscal multi-tenant esto es delgado: un fallo de envío VeriFactu hoy solo se ve si alguien mira logs, no dispara alerta. Hay `x-correlation-id` propagado (bien), pero sin agregación.

### H10 — [BAJO] CORS permisivo con redes privadas + `credentials:true`
`server.ts:828`: el regex permite cualquier `http://192.168.x.x` con `credentials:true`. En un despliegue donde el `api` sea alcanzable desde una LAN compartida (hotel), esto amplía la superficie de CSRF/credential-leak. Para producción debería limitarse a `PILOT_PUBLIC_ORIGIN` (HTTPS) y dejar localhost solo en `NODE_ENV!=="production"`.

---

## 3. Score de Production-Readiness

| Dimensión | Peso | Nota | Comentario |
|-----------|-----:|-----:|------------|
| Seguridad multi-tenant (IDOR, RBAC, rate-limit) | 18 | 8.0 | Guardas reales; pierde por TRUST_PROXY no cableado (H2) y RBAC strict off |
| CI/CD (pnpm, contract+integration tests) | 15 | 8.5 | Sólido; cierra la brecha de la ronda 1 |
| Deploy / migraciones | 14 | 5.0 | `db push` en prod (H4), worker omitido (H1) |
| Alta disponibilidad | 12 | 4.5 | Preparada, no resuelta; flags manuales (H2, H7) |
| Observabilidad | 10 | 5.5 | Health superficial (H5), métricas caseras (H9) |
| Integraciones (OTA/compliance) | 14 | 5.0 | Compliance fuerte; OTAs mock (H8); retries fiscales sin ejecutar en prod (H1) |
| Calidad de código / dominio | 10 | 9.0 | Nivel senior, sin cambios |
| Gestión de secretos / config | 7 | 6.5 | Fail-closed en runtime; validador débil (H6) |

**Cálculo ponderado:** (8.0·18 + 8.5·15 + 5.0·14 + 4.5·12 + 5.5·10 + 5.0·14 + 9.0·10 + 6.5·7) / 100 = **66.3**

# PRODUCTION-READINESS: 71 / 100

> **Ajuste al alza a 71** (sobre el 66 puro): la remediación demostró capacidad de cierre rápido y los fixes son de buena ingeniería. La brecha restante es de *configuración de deploy*, no de diseño — barata de cerrar.

**Interpretación:** la ronda 1 (69) bajó por CI roto + IDOR + falta de HA. La ronda 2 arregla CI, IDOR y prepara HA, pero **abre una brecha nueva: las defensas y procesos existen en el código y no están activados en producción**. Subir por encima de 85 es cuestión de cablear el compose (worker + env), no de reescribir nada. La paradoja de esta ronda: el código mejoró, el deploy se quedó atrás.

---

## 4. Remediación priorizada

**P0 — antes de cualquier go-live (config, horas de trabajo):**
1. **(H1)** Añadir el servicio `worker` a `deploy/docker-compose.production.yml`, o mover `verifactu.retry` + `webhooks.deliver` a schedulers in-process del `api` gateados por `RUN_SCHEDULERS`. Sin esto, los reintentos fiscales no corren. Bloqueante de compliance.
2. **(H2)** Setear `TRUST_PROXY=1` y `RUN_SCHEDULERS=true` (explícito) en el bloque `environment:` del `api` en el compose. Documentar que al escalar se pone a `false` en réplicas no-líder.
3. **(H6)** Endurecer `scripts/validate-env.mjs`: rechazar `change-me`/vacíos y exigir longitud ≥32 en `JWT_SECRET`/`ENCRYPTION_KEY`. Hacerlo gate de deploy, no solo de CI.

**P1 — antes de escalar / multi-tenant serio:**
4. **(H3)** Conectar `@fastify/rate-limit` a Redis (`redis: new Redis(REDIS_URL)`). Una línea; cierra cluster + persistencia.
5. **(H4)** Migrar `deploy.sh` de `db push` a `prisma migrate deploy`; reconciliar el historial con la baseline ya existente. Mantener el drift-guard como red de seguridad.
6. **(H5)** `/health`: PING real a Redis y verificación de liveness de pg-boss; degradar a `degraded` si el worker/cola no responde.

**P2 — madurez de producción:**
7. **(H7)** Sustituir el flag manual por leader-election automática (advisory-lock lease en Postgres o singleton pg-boss).
8. **(H9)** Exponer `/metrics` en formato Prometheus + alerta sobre `ses_submissions` fallidas y cola VeriFactu estancada.
9. **(H10)** Restringir CORS a `PILOT_PUBLIC_ORIGIN` HTTPS en `NODE_ENV==="production"`; localhost/LAN solo en dev.
10. **(H8)** Roadmap explícito de al menos un adapter OTA real (Booking.com) antes de comprometer go-live con clientes dependientes de canales.

**Veredicto:** remediación de ronda 1 genuina y bien hecha; el riesgo de producción residual es **operacional/de cableado**, concentrado en `docker-compose.production.yml` y `deploy.sh`. Cerrar P0+P1 lleva el score sobre 85 sin tocar el diseño.
