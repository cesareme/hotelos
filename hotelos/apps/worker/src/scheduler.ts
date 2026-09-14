import PgBoss from "pg-boss";
import { runFailedRetries, runScheduledNotifications, runStuckSendingSweep } from "./jobs/notification-dispatcher.job.js";
import { runWebhookDeliveries } from "./jobs/webhook-delivery.job.js";

// Postgres-backed job runtime. pg-boss reuses the same Postgres instance as
// the application data and stores its queue tables under a separate schema.
//
// Fiscal submissions are NOT executed here (Tanda 3): VeriFactu altas,
// anulaciones, retries and reconciliation run exclusively in the API
// (apps/api/src/modules/invoicing/verifactu-submission.service.ts,
// `runDueVerifactuRetries` on the scheduler leader under a Postgres advisory
// lock). The former pg-boss `verifactu.retry` job duplicated that sweep with
// different semantics (unsigned XML, no attempt cap, no rectificativa block)
// and could double-send to AEAT from docker-compose.production.yml; it was
// removed together with the never-consumed `tbai.retry` / `igic.retry` queues.
export type JobQueueName =
  | "modelo303.aggregate"
  | "notifications.scheduled"
  | "notifications.retry"
  | "notifications.sending-sweep"
  | "webhooks.deliver";

const JOB_QUEUES: JobQueueName[] = [
  "modelo303.aggregate",
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

export async function startScheduler(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set; cannot start scheduler.");

  const boss = new PgBoss({
    connectionString,
    schema: "pg_boss",
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

  await boss.work("modelo303.aggregate", { batchSize: 1, pollingIntervalSeconds: 60 }, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as { propertyId?: string; year: number; quarter: number };
      console.log(`[modelo303] aggregation triggered for ${data.propertyId ?? "all"} ${data.year}Q${data.quarter}`);
    }
  });

  // Notification dispatcher (Sprint 30): wake up every minute, claim any
  // queued NotificationDelivery rows whose scheduledFor has elapsed, and fire
  // the channel provider. A second queue does failure-sweep duty.
  await boss.work("notifications.scheduled", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    try {
      const summary = await runScheduledNotifications();
      if (summary.considered > 0) {
        console.log(
          `[notifications.scheduled] considered=${summary.considered} sent=${summary.sent} ` +
            `failed=${summary.failed} rescheduled=${summary.rescheduled} skipped=${summary.skipped}`
        );
      }
    } catch (error) {
      console.error("[notifications.scheduled]", error);
      throw error;
    }
  });

  await boss.work("notifications.retry", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    try {
      const result = await runFailedRetries();
      if (result.requeued > 0) {
        console.log(`[notifications.retry] requeued=${result.requeued}`);
      }
    } catch (error) {
      console.error("[notifications.retry]", error);
      throw error;
    }
  });

  // Stuck-"sending" janitor: rescue rows wedged mid-send by a crashed worker.
  await boss.work("notifications.sending-sweep", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    try {
      const result = await runStuckSendingSweep();
      if (result.requeued > 0) {
        console.log(`[notifications.sending-sweep] requeued=${result.requeued}`);
      }
    } catch (error) {
      console.error("[notifications.sending-sweep]", error);
      throw error;
    }
  });

  // Webhook delivery worker (P0-1): consume WebhookDelivery rows pending/retrying.
  await boss.work("webhooks.deliver", { batchSize: 1, pollingIntervalSeconds: 20 }, async () => {
    try {
      const summary = await runWebhookDeliveries();
      if (summary.considered > 0) {
        console.log(
          `[webhooks.deliver] considered=${summary.considered} delivered=${summary.delivered} ` +
            `failed=${summary.failed} giveUp=${summary.giveUp}`
        );
      }
    } catch (error) {
      console.error("[webhooks.deliver]", error);
      throw error;
    }
  });

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
