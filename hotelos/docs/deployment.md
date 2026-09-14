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
| Worker | pg-boss (`webhooks.deliver`), `RUN_SCHEDULERS=false`; los schedulers viven en el API |
| CI | `.github/workflows/ci.yml` en la **raíz git** (typecheck:all, contract tests, integración con `migrate deploy`, fresh-install + smoke, build web, imágenes pnpm) |
| Deploy por SSH | `.github/workflows/deploy.yml` (raíz git) → `deploy.sh --role production-native --pull --yes` |

## Orden de instalación y datos

1. `corepack pnpm install --frozen-lockfile` → `pnpm db:generate` → `pnpm db:adopt-baseline -- --apply` → `pnpm db:migrate:deploy` → `pnpm db:drift:check`.
2. Demo/staging: `cd packages/database && node --import tsx prisma/seed.ts` (equivale a `pnpm --filter @hotelos/database db:seed` con `DATABASE_URL` exportada) y después los seeds `db:seed:commercial`, `db:seed:snapshots`, `db:seed:compliance`, `db:seed:operations`, `db:seed:cancellation`, `db:seed:allotments`, `db:seed:fnb`. Nunca en un tenant real.
3. Arrancar API (`RUN_SCHEDULERS=true`) y worker (`RUN_SCHEDULERS=false`).
4. Smoke: `deploy/scripts/smoke.sh` (HTTP real) y `pnpm smoke:demo` (contrato estático del preview).

## Worker Jobs

El worker (`apps/worker`, pg-boss) registra cada intento en `worker_job_runs`.
Responsabilidades documentadas (algunas siguen en el API como schedulers in-process):

- `ses_hospedajes.submit`: submit queued guest register records, write accepted/rejected/failed events, and retry transport failures.
- `invoice.compliance.check`: verify issued invoices have VERI*FACTU hash and QR placeholders, then create B2B e-invoice envelopes when enabled.
- `messaging.send`: send or queue WhatsApp, email, SMS, webchat, or app messages through provider adapters.
- `ota.channel_sync`: sync availability and reservations with OTA/channel manager adapters.
- `bank.reconciliation.match`: suggest payment, folio, invoice, and supplier bill matches without posting journals.
- `retention.delete_expired`: delete only records whose retention date has elapsed and which are not under legal hold.
- `reports.daily_briefing`: generate owner daily briefing text from live dashboard metrics.
- `webhooks.deliver`: cola pg-boss real del worker (entrega de webhooks salientes).

## Release Gate (observabilidad)

- AI Gateway has no direct DB imports.
- `/health` returns service name, timestamp, dependency state, and telemetry targets for API, AI Gateway, and worker.
- `x-correlation-id` is accepted at the edge and echoed so API, AI Gateway, worker events, audit records, and provider calls can be joined.
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
