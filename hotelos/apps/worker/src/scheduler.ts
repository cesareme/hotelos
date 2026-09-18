import PgBoss from "pg-boss";
import { pruneJobRuns, withJobRun } from "./jobs/job-runs.js";
import { runFailedRetries, runScheduledNotifications, runStuckSendingSweep } from "./jobs/notification-dispatcher.job.js";
import { runWebhookDeliveries } from "./jobs/webhook-delivery.job.js";

// Postgres-backed job runtime. pg-boss reuses the same Postgres instance as
// the application data and stores its queue tables under a separate schema
// (`pgboss`, the pg-boss default, created by boss.start() on first boot).
// L2-07: the previous name `pg_boss` was rejected by Postgres on every boot
// (SQLSTATE 42939, «The prefix "pg_" is reserved for system schemas»), so the
// worker had never actually started anywhere with that setting.
//
// Fiscal submissions are NOT executed here (Tanda 3): VeriFactu altas,
// anulaciones, retries and reconciliation run exclusively in the API
// (apps/api/src/modules/invoicing/verifactu-submission.service.ts,
// `runDueVerifactuRetries` on the scheduler leader under a Postgres advisory
// lock). The former pg-boss `verifactu.retry` job duplicated that sweep with
// different semantics (unsigned XML, no attempt cap, no rectificativa block)
// and could double-send to AEAT from docker-compose.production.yml; it was
// removed together with the never-consumed `tbai.retry` / `igic.retry` queues.
//
// Líder (Tanda L2 · L2-07 · worker honesto): el worker no necesita una
// elección de líder propia.
//   - Los crons viven en la tabla `pgboss.schedule`, con PRIMARY KEY (name)
//     (pg-boss/src/plans.js): por muchas réplicas del worker que arranquen,
//     cada cola tiene UNA sola entrada y boss.schedule() se limita a
//     upsertarla. La publicación de los crons se serializa con un lock de
//     intervalo sobre `pgboss.version.cron_on` (trySetCronTime): cada minuto
//     una única instancia publica el job de cada cron vencido.
//   - boss.work() reclama los jobs con `FOR UPDATE SKIP LOCKED`: cada tick lo
//     ejecuta una única instancia y, con batchSize 1, dentro de una instancia
//     no hay ticks solapados de la misma cola.
//   - Los schedulers in-process del API (SES Hospedajes, VeriFactu, pace,
//     allotment release, group cut-off, mailbox, PMS sombra y drain del channel
//     manager) corren SOLO en la instancia del API con RUN_SCHEDULERS=true
//     (apps/api/src/lib/scheduler-leader.ts). El worker arranca siempre con
//     RUN_SCHEDULERS=false (deploy/docker-compose.production.yml y
//     deploy/systemd/anfitorio-worker.service lo fuerzan), no importa apps/api
//     y, por tanto, no puede ejecutarlos ni duplicarlos.
export type JobQueueName =
  | "notifications.scheduled"
  | "notifications.retry"
  | "notifications.sending-sweep"
  | "webhooks.deliver";

/**
 * Catálogo real del worker (L2-07): cada cola tiene más abajo un boss.work y un
 * boss.schedule, y cada ejecución escribe un WorkerJobRun (jobs/job-runs.ts).
 * La antigua cola `modelo303.aggregate` (solo un console.log) se retiró.
 */
export const JOB_QUEUES: readonly JobQueueName[] = [
  "notifications.scheduled",
  "notifications.retry",
  "notifications.sending-sweep",
  "webhooks.deliver"
];

// QC-06: queues whose setup (queue creation + cron) MUST succeed for the
// worker to be worth running — without them webhooks never leave the box. A
// failure on one of these aborts startup (index.ts logs and exits 1); a
// failure on any other queue only warns.
const CRITICAL_SCHEDULE_QUEUES: ReadonlySet<string> = new Set<JobQueueName>(["webhooks.deliver"]);

// Setup steps that failed during the last startScheduler() run, as
// "<step>:<queue>" (e.g. "schedule:webhooks.deliver"). Exposed for tests/health.
let lastFailedSchedules: readonly string[] = [];
export function getFailedSchedules(): readonly string[] {
  return lastFailedSchedules;
}

// Retención de worker_job_runs (corrector L2 · DP-06): un run por tick aunque
// no haya trabajo (≈3.300 filas/día con los cuatro crons) crecía sin límite.
// Tras cada tick, como mucho una vez por hora y por cola, se borran los runs
// `completed` de más de WORKER_JOB_RUN_RETENTION_DAYS (7) días y los `failed`
// de más de 4× esa retención; siempre por jobName (tabla compartida con las
// remesas SEPA). Un fallo de la retención se registra y no afecta al tick.
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const lastPruneAt = new Map<string, number>();

export function jobRunRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.WORKER_JOB_RUN_RETENTION_DAYS ?? "7");
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 7;
}

async function pruneJobRunsIfDue(queue: JobQueueName, now = Date.now()): Promise<void> {
  if ((lastPruneAt.get(queue) ?? 0) + PRUNE_INTERVAL_MS > now) return;
  lastPruneAt.set(queue, now);
  const days = jobRunRetentionDays();
  try {
    const removed = await pruneJobRuns({
      jobName: queue,
      completedBefore: new Date(now - days * DAY_MS),
      failedBefore: new Date(now - 4 * days * DAY_MS)
    });
    if (removed > 0) console.log(`[${queue}] retención: ${removed} ejecuciones de más de ${days} días borradas`);
  } catch (error) {
    console.error(`[${queue}] la retención de worker_job_runs falló`, error);
  }
}

/**
 * Un tick = un job de pg-boss = un WorkerJobRun. El resumen del barrido queda
 * en resultJson; un error deja el run en `failed` con lastError y se relanza
 * para que pg-boss marque el job como fallido. Los barridos son globales
 * (todas las organizaciones): el run se escribe con organizationId = null.
 */
function tick<T>(queue: JobQueueName, run: () => Promise<T>): (jobs: PgBoss.Job<object>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      try {
        await withJobRun({ jobName: queue, queueName: queue, payload: job.data ?? {}, correlationId: job.id }, run);
      } catch (error) {
        console.error(`[${queue}]`, error);
        throw error;
      }
      await pruneJobRunsIfDue(queue);
    }
  };
}

export async function startScheduler(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set; cannot start scheduler.");

  const boss = new PgBoss({
    connectionString,
    // "pgboss" (default): Postgres reserves every "pg_*" schema name (42939).
    schema: "pgboss",
    monitorStateIntervalSeconds: 30,
    archiveCompletedAfterSeconds: 60 * 60 * 24
  });
  boss.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pg-boss] error:", message);
  });
  // QC-06: pg-boss throws on an invalid cron, a missing queue or a DB error.
  // Those used to be swallowed (`.catch(() => {})`) and the worker still
  // announced "queues active" while nothing ran. Every setup step is tracked:
  // logged with its name, accumulated, and evaluated at the end.
  const failedSchedules: string[] = [];
  const track = async (name: string, promise: Promise<unknown>): Promise<void> => {
    try {
      await promise;
    } catch (err) {
      console.error(`[scheduler] ${name} failed`, err);
      failedSchedules.push(name);
    }
  };

  await boss.start();
  for (const q of JOB_QUEUES) {
    // createQueue is idempotent (ON CONFLICT DO NOTHING): a rejection here is
    // a real error, not "queue already exists".
    await track(`createQueue:${q}`, boss.createQueue(q));
  }

  // Notification dispatcher (Sprint 30): wake up every minute, claim any
  // queued NotificationDelivery rows whose scheduledFor has elapsed, and fire
  // the channel provider. A second queue does failure-sweep duty.
  await boss.work(
    "notifications.scheduled",
    { batchSize: 1, pollingIntervalSeconds: 60 },
    tick("notifications.scheduled", async () => {
      const summary = await runScheduledNotifications();
      if (summary.considered > 0) {
        console.log(
          `[notifications.scheduled] considered=${summary.considered} sent=${summary.sent} ` +
            `failed=${summary.failed} rescheduled=${summary.rescheduled} skipped=${summary.skipped}`
        );
      }
      return summary;
    })
  );

  await boss.work(
    "notifications.retry",
    { batchSize: 1, pollingIntervalSeconds: 60 },
    tick("notifications.retry", async () => {
      const result = await runFailedRetries();
      if (result.requeued > 0) {
        console.log(`[notifications.retry] requeued=${result.requeued}`);
      }
      return result;
    })
  );

  // Stuck-"sending" janitor: rescue rows wedged mid-send by a crashed worker.
  await boss.work(
    "notifications.sending-sweep",
    { batchSize: 1, pollingIntervalSeconds: 60 },
    tick("notifications.sending-sweep", async () => {
      const result = await runStuckSendingSweep();
      if (result.requeued > 0) {
        console.log(`[notifications.sending-sweep] requeued=${result.requeued}`);
      }
      return result;
    })
  );

  // Webhook delivery worker (P0-1): consume WebhookDelivery rows pending/retrying.
  await boss.work(
    "webhooks.deliver",
    { batchSize: 1, pollingIntervalSeconds: 20 },
    tick("webhooks.deliver", async () => {
      const summary = await runWebhookDeliveries();
      if (summary.considered > 0) {
        console.log(
          `[webhooks.deliver] considered=${summary.considered} delivered=${summary.delivered} ` +
            `failed=${summary.failed} giveUp=${summary.giveUp}`
        );
      }
      return summary;
    })
  );

  // boss.schedule is an upsert (ON CONFLICT (name) DO UPDATE), so re-running
  // it on every boot is safe; a rejection means cron/queue/DB trouble.
  await track("schedule:webhooks.deliver", boss.schedule("webhooks.deliver", "*/1 * * * *", {}, { tz: "Europe/Madrid" }));
  // Notification cron — every minute. Failure sweep runs every 5 minutes.
  // Stuck-"sending" janitor runs every 10 minutes.
  await track(
    "schedule:notifications.scheduled",
    boss.schedule("notifications.scheduled", "*/1 * * * *", {}, { tz: "Europe/Madrid" })
  );
  await track("schedule:notifications.retry", boss.schedule("notifications.retry", "*/5 * * * *", {}, { tz: "Europe/Madrid" }));
  await track(
    "schedule:notifications.sending-sweep",
    boss.schedule("notifications.sending-sweep", "*/10 * * * *", {}, { tz: "Europe/Madrid" })
  );
  // A schedule left behind by older deployments would keep publishing jobs
  // nobody consumes; drop it explicitly (idempotent, non-critical).
  await track("unschedule:verifactu.retry", boss.unschedule("verifactu.retry"));
  await track("unschedule:modelo303.aggregate", boss.unschedule("modelo303.aggregate"));

  lastFailedSchedules = [...failedSchedules];
  if (failedSchedules.length > 0) {
    // "<step>:<queue>" → queue name (queue names carry dots, never colons).
    const queueOf = (name: string): string => name.slice(name.indexOf(":") + 1);
    const critical = failedSchedules.filter((name) => CRITICAL_SCHEDULE_QUEUES.has(queueOf(name)));
    if (critical.length > 0) {
      // Fail fast (index.ts logs and exits 1). Best-effort stop first so the
      // workers registered above do not keep polling from a half-started
      // process if the caller does not exit.
      await boss.stop({ graceful: false, wait: false }).catch((err: unknown) => {
        console.error("[scheduler] boss.stop after critical setup failure failed", err);
      });
      throw new Error(`[scheduler] critical queue setup failed: ${critical.join(", ")} (all failures: ${failedSchedules.join(", ")})`);
    }
    console.warn("[scheduler] queue setup failed for non-critical queues (worker continues):", failedSchedules.join(", "));
  }
  console.log("[scheduler] pg-boss queues active:", JOB_QUEUES.join(", "));
  return boss;
}
