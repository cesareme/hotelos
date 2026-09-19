# Deployment

> **OBSOLETO (Tanda 4 · 2026-09-14).** Este documento describía un despliegue
> genérico (imágenes en `infra/docker`, BullMQ/Temporal, `npm run`) que nunca se
> correspondió con el código. La guía vigente y única es
> **[`deploy/README-INSTALL.md`](../deploy/README-INSTALL.md)**.

## Resumen vigente

| Tema | Dónde |
|---|---|
| Instalación desde cero (Ubuntu 24.04, nativa) | `deploy/scripts/install-from-scratch.sh --demo|--real` |
| Actualización idempotente | `deploy/scripts/deploy.sh` (`--pull`, `--with-backfills`, `--skip-X`, `--only-X`, `--dry-run`) |
| Smoke post-deploy | `deploy/scripts/smoke.sh` |
| Adopción de un VPS existente | `deploy/scripts/vps-inventory.sh` + `install-from-scratch.sh --adopt` |
| Runtime | tsx (`node --import tsx src/server.ts`); `pnpm install --frozen-lockfile` sin `--prod` |
| Esquema | `pnpm db:adopt-baseline -- --apply` → `pnpm db:migrate:deploy` → `pnpm db:drift:check` (nunca `db push`) |
| Worker | pg-boss, 5 colas (`notifications.scheduled`, `notifications.retry`, `notifications.sending-sweep`, `webhooks.deliver`, `reputation.maintenance`), un run por ejecución en `worker_job_runs` con retención por cola (`WORKER_JOB_RUN_RETENTION_DAYS`, 7 días; fallidos 4×), `RUN_SCHEDULERS=false`; los schedulers viven en el API |
| CI | `.github/workflows/ci.yml` en la **raíz git** (typecheck:all, contract tests, integración con `migrate deploy`, fresh-install + smoke, build web, imágenes pnpm) |
| Deploy por SSH | `.github/workflows/deploy.yml` (raíz git) → `deploy.sh --role production-native --pull --yes` |

## Orden de instalación y datos

1. `corepack pnpm install --frozen-lockfile` → `pnpm db:generate` → `pnpm db:adopt-baseline -- --apply` → `pnpm db:migrate:deploy` → `pnpm db:drift:check`.
2. Demo/staging: `cd packages/database && node --import tsx prisma/seed.ts` (equivale a `pnpm --filter @hotelos/database db:seed` con `DATABASE_URL` exportada) y después los seeds `db:seed:commercial`, `db:seed:snapshots`, `db:seed:compliance`, `db:seed:operations`, `db:seed:cancellation`, `db:seed:allotments`, `db:seed:fnb`. Nunca en un tenant real.
3. Arrancar API (`RUN_SCHEDULERS=true`) y worker (`RUN_SCHEDULERS=false`).
4. Smoke: `deploy/scripts/smoke.sh` (HTTP real) y `pnpm smoke:demo` (contrato estático del preview).

## Worker (pg-boss)

El worker (`apps/worker`, `node --import tsx src/index.ts`) ejecuta exactamente **cinco colas pg-boss**
(esquema `pgboss` de la misma base de datos; `boss.start()` lo crea en el primer arranque). Cada cola la
lanza un cron y cada tick lo consume una sola instancia:

| Cola | Cron (Europe/Madrid) | Qué hace |
|---|---|---|
| `notifications.scheduled` | `*/1 * * * *` | Reclama `NotificationDelivery` en `queued` con `scheduledFor` vencido y llama al proveedor del canal (hoy stubs: ver aviso más abajo). |
| `notifications.retry` | `*/5 * * * *` | Devuelve a `queued` las entregas `failed` con intentos restantes (backoff exponencial). |
| `notifications.sending-sweep` | `*/10 * * * *` | Rescata entregas atascadas en `sending` más de 15 minutos. |
| `webhooks.deliver` | `*/1 * * * *` | Entrega `WebhookDelivery` pendientes/reintentables con firma HMAC-SHA256 (cola crítica: si su setup falla, el worker sale con código 1). |
| `reputation.maintenance` | `15 4 * * *` | Reputación (Tanda T8): retira el texto de las reseñas que superan la retención de su fuente (Google 30 días; resto `retentionDays` o 730), marca fuera de plazo las abiertas con `slaTargetAt` vencido y recorta el historial de ejecuciones por fuente a 20. Nunca borra filas. |

**Un run por ejecución.** Cada tick escribe **una fila** en `worker_job_runs` (modelo `WorkerJobRun`,
`apps/worker/src/jobs/job-runs.ts`): `status=running` con `attempts=1`, `started_at` y `payload_json` al
empezar; `completed` con `result_json` (el resumen del barrido) o `failed` con `last_error`, y `finished_at`,
al terminar. Un error deja el run en `failed` y se relanza para que pg-boss marque el job. Los cuatro barridos
son globales (recorren todas las organizaciones), así que `organization_id` y `property_id` quedan a NULL. La
tabla la comparte `treasury.sepa_remittance` (remesas SEPA del API): toda lectura de runs filtra por `job_name`.

- **Líder.** pg-boss guarda los crons en `pgboss.schedule` con clave primaria `name` y serializa su publicación
  con un lock de intervalo (`pgboss.version.cron_on`): con varias réplicas del worker cada cola tiene un único
  cron y cada tick lo ejecuta una sola instancia (`FOR UPDATE SKIP LOCKED`). Los schedulers in-process del API
  (SES Hospedajes, VeriFactu, pace, allotment release, group cut-off, mailbox, PMS sombra, drain del channel
  manager) corren solo en la instancia del API con `RUN_SCHEDULERS=true`; el worker arranca siempre con
  `RUN_SCHEDULERS=false` (compose y systemd lo fuerzan), no importa `apps/api` y no los ejecuta.
- **Proveedores.** `apps/worker/src/providers/*` son stubs que marcan «enviado» sin enviar. Si `EMAIL_PROVIDER`,
  `TWILIO_ACCOUNT_SID` o `WHATSAPP_PHONE_ID` están definidos, el worker lo avisa una vez al arrancar
  (`console.warn`). Unificarlos con los proveedores del API es de la Tanda L8.
- **Salud.** Al arrancar imprime el JSON de `getWorkerHealth()`: dependencias, `failedSchedules` (pasos de
  setup de pg-boss fallidos) y `lastRuns` (últimos 10 runs por cola leídos de `worker_job_runs`).
- **Retirado en Tanda L2 (L2-07).** El catálogo de 85 nombres de job sin implementación (respondían
  «completed» sin hacer nada), `handleJob` y sus siete handlers tipados sin productor, y la cola
  `modelo303.aggregate` (solo un `console.log`).
- **Tests.** `corepack pnpm --filter @hotelos/worker test` (`node --test` sobre `src/**/__tests__/*.test.ts`,
  sin base de datos: catálogo, runs y despachador de notificaciones).
- **Comprobación en local.** `SELECT job_name, status, count(*) FROM worker_job_runs GROUP BY 1, 2;` y
  `SELECT name, cron FROM pgboss.schedule;` (5 filas). Hasta la Tanda L2 el esquema se llamaba `pg_boss` y
  Postgres lo rechazaba (SQLSTATE 42939, prefijo `pg_` reservado): el worker nunca había llegado a arrancar.

## Apagado ordenado del API (SIGTERM/SIGINT)

- **Coordinador único.** `apps/api/src/lib/shutdown.ts` (`createShutdownController`), instalado en
  `server.ts` justo después de `app.listen` para `SIGTERM` y `SIGINT` (`process.on`, un manejador por
  señal). Los schedulers in-process (`channel.drain`, `pms-shadow.job`, `reputation.sync.job`) se
  registran en él en vez de con `process.once`.
- **Orden.** Los pasos se ejecutan en orden inverso al registro: primero se detienen los schedulers,
  después `app.close()` (Fastify deja de aceptar conexiones y termina las peticiones en curso), después
  `audit.flush` (`flushAuditQueues()`: vacía las colas de persistencia de `audit_events`/`event_stream`, que son
  fire-and-forget, para no perder los eventos sellados por las últimas peticiones) y por último
  `prisma.$disconnect()`; al acabar el proceso sale con código 0. Un paso que falla se registra
  (`[shutdown] paso fallido`) y no bloquea a los demás.
- **Plazo.** `SHUTDOWN_TIMEOUT_MS` (por defecto 10 000 ms): si los pasos no han terminado, warn
  `[shutdown] plazo agotado` y salida con código 1. Una segunda señal durante el apagado sale con código 1 de
  inmediato.
- **Antes.** Cada scheduler registraba su propio `process.once(signal, …)` que solo paraba su temporizador;
  con un manejador presente Node retira la salida por defecto y el API ignoraba `SIGTERM` (el 2026-09-19
  hubo que matarlo con `SIGKILL`).
- **Supervisor.** Conceder al menos 15 s antes de `SIGKILL`: en systemd `TimeoutStopSec` ≥ 15 s
  (`deploy/systemd/anfitorio-api.service` ya lleva `TimeoutStopSec=30` y `KillSignal=SIGTERM`) y en compose
  `stop_grace_period` ≥ 15 s en el servicio `api` (`deploy/docker-compose.production.yml`: `20s`). El worker
  no cambia (pg-boss ya gestiona su parada).
- **Comprobación en local.** Arrancar una instancia propia (`PORT=3911 RUN_SCHEDULERS=false
  TENANT_BOOTSTRAP_SKIP=true node --import tsx src/server.ts` desde `apps/api`), `kill -TERM <pid>` y
  verificar en el log `[shutdown] completado` y código de salida 0 en menos de 10 s.

## Release Gate (observabilidad)

- AI core (`packages/ai-core`) has no direct DB imports and reads no environment variables.
- `/health` returns service name, timestamp, dependency state, and telemetry targets for API and worker.
- `x-correlation-id` is accepted at the edge and echoed so API and worker events, audit records, and provider calls can be joined.
- ID scan storage regression test passes; issued invoice immutability test passes.
- Database restore has been tested; crash reporting and metrics are visible.

## Móvil (sin cambios)

La configuración EAS está en `apps/mobile/eas.json`.

```sh
eas build --platform ios --profile production
eas build --platform android --profile production
eas submit --platform ios --profile production
eas submit --platform android --profile production
```

## Puerta de salida a producción

- `pnpm validate:env <env>` verde para el rol correspondiente.
- `pnpm test`, `pnpm typecheck:all`, `pnpm test:integration` verdes.
- `pnpm db:install:check` (instalación desde cero en BD temporal) verde.
- `deploy/scripts/smoke.sh` verde contra el entorno desplegado.
- Ensayo de restauración de backup realizado (`scripts/test-backup-restore-cycle.sh`).
