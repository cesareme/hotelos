import PgBoss from "pg-boss";
import { prisma } from "@hotelos/database";
import { buildVerifactuRegistroAlta, submitVerifactuRegistro, type VerifactuInvoiceType } from "@hotelos/compliance";
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

const SOFTWARE = {
  nif: process.env.VERIFACTU_SOFTWARE_NIF ?? "B00000000",
  name: "HotelOS",
  id: "HOTELOS-VRF-01",
  version: "0.1.0",
  installNumber: process.env.VERIFACTU_INSTALL_NUMBER ?? "DEV-001"
};

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
  await boss.start();
  for (const q of JOB_QUEUES) {
    await boss.createQueue(q).catch(() => {});
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
  await boss.schedule("verifactu.retry", "*/2 * * * *", { invoiceId: undefined }, { tz: "Europe/Madrid" }).catch(() => {});
  await boss.schedule("webhooks.deliver", "*/1 * * * *", {}, { tz: "Europe/Madrid" }).catch(() => {});
  // Notification cron — every minute. Failure sweep runs every 5 minutes.
  // Stuck-"sending" janitor runs every 10 minutes.
  await boss.schedule("notifications.scheduled", "*/1 * * * *", {}, { tz: "Europe/Madrid" }).catch(() => {});
  await boss.schedule("notifications.retry", "*/5 * * * *", {}, { tz: "Europe/Madrid" }).catch(() => {});
  await boss.schedule("notifications.sending-sweep", "*/10 * * * *", {}, { tz: "Europe/Madrid" }).catch(() => {});
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
    const property = await prisma.property.findUnique({ where: { id: invoice.propertyId } });
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    const emitterTaxId = property?.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? "B00000000";

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
      emitterName: property?.legalName ?? property?.name ?? "HotelOS Demo",
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
