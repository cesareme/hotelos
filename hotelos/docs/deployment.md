# Deployment

## Environments

- development
- staging
- production

Required environment variables are listed in `.env.example`.

## Backend

1. Build Docker images for `api`, `ai-gateway`, and `worker`.
2. Provision PostgreSQL and Redis in an EU region.
3. Configure S3-compatible object storage.
4. Store secrets in the cloud secret manager.
5. Run Prisma migrations.
6. Deploy API.
7. Deploy AI Gateway.
8. Deploy worker.
9. Configure HTTPS.
10. Configure OpenTelemetry, Sentry, Prometheus, and Grafana.
11. Configure scheduled jobs.
12. Configure daily backups and restore tests.

## Worker Jobs

The worker runs background jobs through BullMQ or Temporal in production and records attempts in `worker_job_runs`.

- `ses_hospedajes.submit`: submit queued guest register records, write accepted/rejected/failed events, and retry transport failures.
- `invoice.compliance.check`: verify issued invoices have VERI*FACTU hash and QR placeholders, then create B2B e-invoice envelopes when enabled.
- `messaging.send`: send or queue WhatsApp, email, SMS, webchat, or app messages through provider adapters.
- `ota.channel_sync`: sync availability and reservations with OTA/channel manager adapters.
- `bank.reconciliation.match`: suggest payment, folio, invoice, and supplier bill matches without posting journals.
- `retention.delete_expired`: delete only records whose retention date has elapsed and which are not under legal hold.
- `reports.daily_briefing`: generate owner daily briefing text from live dashboard metrics.

## Mobile

EAS config is in `apps/mobile/eas.json`.

Production builds:

```sh
eas build --platform ios --profile production
eas build --platform android --profile production
```

Submissions:

```sh
eas submit --platform ios --profile production
eas submit --platform android --profile production
```

## Release Gate

Before production:

- AI Gateway has no direct DB imports.
- `/health` returns service name, timestamp, dependency state, and telemetry targets for API, AI Gateway, and worker.
- `x-correlation-id` is accepted at the edge and echoed so API, AI Gateway, worker events, audit records, and provider calls can be joined.
- ID scan storage regression test passes.
- Issued invoice immutability test passes.
- Room blocking prevents assignment.
- SES queue and compliance inbox have audit trails.
- Database restore has been tested.
- Crash reporting and metrics are visible.

## Deploy Readiness Commands

```sh
npm run validate:env -- .env.example
npm run test
npm run typecheck
npm run backup:check
docker compose -f infra/docker/docker-compose.yml up --build
```

The conventional CI workflow is in `.github/workflows/ci.yml`. It validates env shape, runs the no-dependency tests, runs workspace typechecks once dependencies are installed, and builds API, AI Gateway, and worker Docker images.

## Migration Order

1. Deploy PostgreSQL and Redis.
2. Apply Prisma migrations.
3. For demo and staging environments, run `npm --workspace @hotelos/database run db:seed`.
4. Start API.
5. Start worker.
6. Start AI Gateway.
7. Run smoke tests against `/health`, dashboard, PMS list, AI command parsing, and `npm run smoke:demo`.
8. Run backup restore rehearsal before accepting production traffic.
