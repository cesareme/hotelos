import PgBoss from "pg-boss";
import { prisma } from "@hotelos/database";
import {
  buildVerifactuRegistroAlta,
  isValidSpanishTaxId,
  normalizeTaxId,
  SPANISH_TAX_ID_PLACEHOLDER,
  submitVerifactuRegistro,
  type VerifactuInvoiceType
} from "@hotelos/compliance";
import { runFailedRetries, runScheduledNotifications, runStuckSendingSweep } from "./jobs/notification-dispatcher.job.js";
import { runWebhookDeliveries } from "./jobs/webhook-delivery.job.js";

// Postgres-backed job runtime. pg-boss reuses the same Postgres instance as
// the application data and stores its queue tables under a separate schema.
export type JobQueueName =
  | "verifactu.retry"
  | "tbai.retry"
  | "igic.retry"
  | "modelo303.aggregate"
  | "notifications.scheduled"
  | "notifications.retry"
  | "notifications.sending-sweep"
  | "webhooks.deliver";

const JOB_QUEUES: JobQueueName[] = [
  "verifactu.retry",
  "tbai.retry",
  "igic.retry",
  "modelo303.aggregate",
  "notifications.scheduled",
  "notifications.retry",
  "notifications.sending-sweep",
  "webhooks.deliver"
];

// QC-06: queues whose setup (queue creation + cron) MUST succeed for the
// worker to be worth running — without them VeriFactu never retries and
// webhooks never leave the box. A failure on one of these aborts startup
// (index.ts logs and exits 1); a failure on any other queue only warns.
const CRITICAL_SCHEDULE_QUEUES: ReadonlySet<string> = new Set<JobQueueName>(["verifactu.retry", "webhooks.deliver"]);

// Setup steps that failed during the last startScheduler() run, as
// "<step>:<queue>" (e.g. "schedule:verifactu.retry"). Exposed for tests/health.
let lastFailedSchedules: readonly string[] = [];
export function getFailedSchedules(): readonly string[] {
  return lastFailedSchedules;
}

// Software producer block of the registro — MUST match the API's
// (apps/api/src/modules/invoicing/verifactu-submission.service.ts) so a retry
// from here rebuilds the same XML the API sent. VERIFACTU_SOFTWARE_NIF is the
// NIF of the software PRODUCER, not the invoice issuer; the all-zero
// placeholder is only tolerated in development.
const SOFTWARE = {
  nif: process.env.VERIFACTU_SOFTWARE_NIF ?? "B00000000",
  name: "Anfitorio",
  id: "ANFITORIO-VRF-01",
  version: process.env.APP_VERSION ?? "0.1.0",
  installNumber: process.env.VERIFACTU_INSTALL_NUMBER ?? "DEV-001"
};

type InvoiceIssuerFields = {
  propertyId: string;
  issuerTaxId: string | null;
  issuerLegalName: string | null;
  issuerTaxIdPlaceholder: boolean;
  qrPayload: string | null;
};

// Worker-side mirror of the API's issuerForInvoice (apps/api/src/modules/
// invoicing/issuer-identity.service.ts — the worker cannot import app code):
//   1. the snapshot taken at issuance (Invoice.issuerTaxId / issuerLegalName);
//   2. for invoices issued before the snapshot columns, the `nif=` hashed into
//      their AEAT QR;
//   3. the live Organization.taxId (normalised, checksum-valid) — never a regex
//      over the property name.
// Without any of those: sandbox → flagged placeholder; production → null, the
// caller parks the submission as failed with the reason (no infinite retry).
async function resolveInvoiceIssuer(
  invoice: InvoiceIssuerFields
): Promise<{ taxId: string; legalName: string; placeholder: boolean; source: "snapshot" | "qr_payload" | "resolver" } | null> {
  const property = await prisma.property.findUnique({
    where: { id: invoice.propertyId },
    select: { name: true, legalName: true, organizationId: true }
  });
  if (!property) return null;
  const organization = await prisma.organization.findUnique({
    where: { id: property.organizationId },
    select: { taxId: true, legalName: true, name: true }
  });
  const legalName = invoice.issuerLegalName ?? property.legalName ?? organization?.legalName ?? organization?.name ?? property.name;
  if (invoice.issuerTaxId) {
    return { taxId: invoice.issuerTaxId, legalName, placeholder: invoice.issuerTaxIdPlaceholder, source: "snapshot" };
  }
  const legacyTaxId = taxIdFromQrPayload(invoice.qrPayload);
  if (legacyTaxId) {
    return { taxId: legacyTaxId, legalName, placeholder: legacyTaxId === SPANISH_TAX_ID_PLACEHOLDER, source: "qr_payload" };
  }
  const liveTaxId = normalizeTaxId(organization?.taxId);
  if (liveTaxId && isValidSpanishTaxId(liveTaxId)) {
    return { taxId: liveTaxId, legalName, placeholder: false, source: "resolver" };
  }
  if (process.env.VERIFACTU_MODE === "production") return null;
  return { taxId: SPANISH_TAX_ID_PLACEHOLDER, legalName, placeholder: true, source: "resolver" };
}

function taxIdFromQrPayload(qrPayload: string | null | undefined): string | null {
  if (!qrPayload) return null;
  try {
    return normalizeTaxId(new URL(qrPayload).searchParams.get("nif"));
  } catch {
    const match = /[?&]nif=([^&#]+)/i.exec(qrPayload);
    return match ? normalizeTaxId(decodeURIComponent(match[1]!)) : null;
  }
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
  // announced "queues active" while VeriFactu never retried. Every setup step
  // is tracked: logged with its name, accumulated, and evaluated at the end.
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

  await boss.work("verifactu.retry", { batchSize: 5, pollingIntervalSeconds: 30 }, async (jobs) => {
    for (const job of jobs) {
      try {
        await processVerifactuRetry((job.data as { invoiceId?: string })?.invoiceId);
      } catch (error) {
        console.error("[verifactu.retry]", error);
        throw error;
      }
    }
  });

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

  // Re-enqueue any submissions stuck in retrying with nextRetryAt elapsed.
  // boss.schedule is an upsert (ON CONFLICT (name) DO UPDATE), so re-running
  // it on every boot is safe; a rejection means cron/queue/DB trouble.
  await track(
    "schedule:verifactu.retry",
    boss.schedule("verifactu.retry", "*/2 * * * *", { invoiceId: undefined }, { tz: "Europe/Madrid" })
  );
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

async function processVerifactuRetry(targetInvoiceId?: string): Promise<void> {
  const pending = await prisma.verifactuSubmission.findMany({
    where: {
      ...(targetInvoiceId ? { invoiceId: targetInvoiceId } : { status: { in: ["retrying", "network_error", "submitting"] } }),
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }]
    },
    take: 25,
    orderBy: { createdAt: "asc" }
  });
  if (pending.length === 0) return;

  for (const submission of pending) {
    const invoice = await prisma.invoice.findUnique({ where: { id: submission.invoiceId } });
    if (!invoice || invoice.status !== "issued" || !invoice.invoiceNumber || !invoice.verifactuHash) continue;
    const issuer = await resolveInvoiceIssuer(invoice);
    if (!issuer) {
      // Fiscal production mode without a valid issuer NIF: park the row as
      // failed with the reason instead of retrying forever (FISC-03 / FISC-06).
      const reason = "La propiedad no tiene NIF emisor válido configurado; complétalo en Configuración › Perfil del establecimiento.";
      console.error(`[verifactu.retry] invoice=${invoice.invoiceNumber} submission=${submission.id}: ${reason}`);
      await prisma.verifactuSubmission.update({
        where: { id: submission.id },
        data: { status: "failed", errorCode: "ISSUER_TAX_ID_MISSING", errorMessage: reason, nextRetryAt: null }
      });
      continue;
    }
    const emitterTaxId = issuer.taxId;
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });

    const breakdowns = lines.map((line) => {
      const ratePercent = Number(line.taxRate.toString());
      const total = Number(line.total.toString());
      const taxableBase = ratePercent > 0 ? total / (1 + ratePercent / 100) : total;
      const taxAmount = total - taxableBase;
      return {
        taxCode: line.taxCode,
        ratePercent,
        taxableBase: Math.round(taxableBase * 100) / 100,
        taxAmount: Math.round(taxAmount * 100) / 100
      };
    });

    let previousInvoiceNumber: string | null = null;
    let previousIssuedAt: string | null = null;
    if (invoice.previousInvoiceHash) {
      const previous = await prisma.invoice.findFirst({
        where: { propertyId: invoice.propertyId, verifactuHash: invoice.previousInvoiceHash },
        select: { invoiceNumber: true, issuedAt: true }
      });
      previousInvoiceNumber = previous?.invoiceNumber ?? null;
      previousIssuedAt = previous?.issuedAt?.toISOString() ?? null;
    }

    const xml = buildVerifactuRegistroAlta({
      emitterTaxId,
      emitterName: issuer.legalName,
      invoiceNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt?.toISOString() ?? new Date().toISOString(),
      invoiceType: (invoice.invoiceType as VerifactuInvoiceType) ?? "F1",
      description: `Servicios hoteleros ${invoice.invoiceNumber}`,
      invoiceTotal: Number(invoice.total),
      vatTotal: Number(invoice.taxTotal),
      breakdowns,
      previousHash: invoice.previousInvoiceHash,
      previousInvoiceNumber,
      previousIssuedAt,
      currentHash: invoice.verifactuHash,
      software: SOFTWARE
    });

    const result = await submitVerifactuRegistro({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      emitterTaxId,
      xmlPayload: xml
    });

    const finalStatus =
      result.status === "accepted" ? "accepted" :
      result.status === "accepted_with_errors" ? "accepted_with_errors" :
      result.status === "rejected" ? "rejected" :
      "retrying";

    await prisma.verifactuSubmission.update({
      where: { id: submission.id },
      data: {
        status: finalStatus,
        endpoint: result.endpoint,
        csvCode: result.csvCode ?? submission.csvCode,
        acceptedHash: result.acceptedHash ?? submission.acceptedHash,
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
        responseAck: result.rawResponse ?? submission.responseAck,
        acknowledgedAt: finalStatus === "accepted" ? new Date() : submission.acknowledgedAt,
        nextRetryAt: finalStatus === "retrying" ? new Date(Date.now() + 5 * 60 * 1000) : null,
        attempts: { increment: 1 }
      }
    });

    console.log(`[verifactu.retry] invoice=${invoice.invoiceNumber} → ${finalStatus}`);
  }
}
