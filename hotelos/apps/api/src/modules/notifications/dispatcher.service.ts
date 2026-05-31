// Notification dispatcher (Sprint 26).
//
// Responsibilities:
//   1. Resolve the correct active `NotificationTemplate` for the request
//      (property→org fallback, language preference).
//   2. Render subject + body with the supplied variables (template-renderer).
//   3. Persist a `NotificationDelivery` row (status="queued" → "sent" or
//      "failed" depending on the provider stub).
//   4. Surface read APIs for the admin UI (list deliveries, retry, stats).
//
// The dispatcher never throws when the provider returns "failed"; it records
// the failure on the delivery row so the operator can retry from the UI.
// It *does* throw when configuration is wrong (template_not_found, unknown
// channel) — those are caller bugs, not provider transient errors.

import { prisma, type Prisma } from "@hotelos/database";
import { renderTemplate } from "./template-renderer.service.js";
import { resolveTemplate } from "./templates.service.js";
import { resolveProvider } from "./providers/index.js";

export type DeliveryStatus = "pending" | "queued" | "sent" | "failed" | "bounced";

export type NotificationDeliveryRecord = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  notificationId: string | null;
  templateCode: string | null;
  channel: string;
  recipient: string;
  status: DeliveryStatus;
  providerMessageId: string | null;
  subject: string | null;
  bodyRendered: string | null;
  payloadJson: unknown;
  attempts: number;
  errorMessage: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  notificationId: string | null;
  templateCode: string | null;
  channel: string;
  recipient: string;
  status: string;
  providerMessageId: string | null;
  subject: string | null;
  bodyRendered: string | null;
  payloadJson: Prisma.JsonValue | null;
  attempts: number;
  errorMessage: string | null;
  scheduledFor: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: Row): NotificationDeliveryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    notificationId: row.notificationId,
    templateCode: row.templateCode,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status as DeliveryStatus,
    providerMessageId: row.providerMessageId,
    subject: row.subject,
    bodyRendered: row.bodyRendered,
    payloadJson: row.payloadJson,
    attempts: row.attempts,
    errorMessage: row.errorMessage,
    scheduledFor: row.scheduledFor ? row.scheduledFor.toISOString() : null,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export type DispatchInput = {
  organizationId: string;
  propertyId?: string;
  templateCode: string;
  channel: string;
  recipient: string;
  variables: Record<string, unknown>;
  scheduledFor?: string | Date;
  /** Domain event id (or other natural source id) — used for idempotency. */
  notificationId?: string;
  /** Override the language preference; defaults to "es". */
  language?: string;
};

/**
 * Dispatch a single notification: resolve template → render → persist queued
 * delivery → attempt provider send → update delivery status.
 *
 * Idempotency: if a `notificationId` is supplied and a delivery already
 * exists for that (notificationId, channel, recipient) tuple, this is a
 * no-op and returns the existing delivery untouched. Useful when a domain
 * event is replayed.
 */
export async function dispatch(input: DispatchInput): Promise<NotificationDeliveryRecord> {
  if (input.notificationId) {
    const existing = await prisma.notificationDelivery.findFirst({
      where: {
        organizationId: input.organizationId,
        notificationId: input.notificationId,
        channel: input.channel,
        recipient: input.recipient
      }
    });
    if (existing) return toRecord(existing as Row);
  }

  const template = await resolveTemplate({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    code: input.templateCode,
    channel: input.channel,
    language: input.language
  });
  if (!template) {
    throw new Error("template_not_found");
  }

  const { subject, body } = renderTemplate({
    template: { body: template.body, subject: template.subject },
    variables: input.variables
  });

  const scheduledFor = input.scheduledFor
    ? input.scheduledFor instanceof Date
      ? input.scheduledFor
      : new Date(input.scheduledFor)
    : null;

  const queued = await prisma.notificationDelivery.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      notificationId: input.notificationId ?? null,
      templateCode: input.templateCode,
      channel: input.channel,
      recipient: input.recipient,
      status: "queued",
      subject: subject || null,
      bodyRendered: body,
      payloadJson: { variables: input.variables } as Prisma.InputJsonValue,
      attempts: 0,
      scheduledFor
    }
  });

  // If the caller scheduled for the future, don't send now — a worker would
  // pick it up. We don't have a worker yet, so we leave the row "queued" and
  // return; the UI can still display it.
  if (scheduledFor && scheduledFor.getTime() > Date.now()) {
    return toRecord(queued as Row);
  }

  return attemptSend(queued.id, { subject, body, recipient: input.recipient, channel: input.channel });
}

/**
 * Send (or re-send) a delivery row by id. Used by `retryDelivery` and by the
 * initial dispatch attempt.
 */
async function attemptSend(
  deliveryId: string,
  payload: { subject: string; body: string; recipient: string; channel: string }
): Promise<NotificationDeliveryRecord> {
  const provider = resolveProvider(payload.channel);

  let result;
  try {
    result = await provider.send({
      recipient: payload.recipient,
      subject: payload.subject || undefined,
      body: payload.body
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { status: "failed" as const, error: message };
  }

  const now = new Date();
  if (result.status === "sent") {
    const updated = await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "sent",
        providerMessageId: result.providerMessageId ?? null,
        sentAt: now,
        // Honesty: a simulated (no-provider) send is recorded as such so it is
        // never mistaken for a real delivery, even though status is "sent".
        errorMessage: result.simulated ? "SIMULADO: proveedor no configurado; no se envió de verdad." : null,
        attempts: { increment: 1 }
      }
    });
    return toRecord(updated as Row);
  }

  const updated = await prisma.notificationDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "failed",
      failedAt: now,
      errorMessage: result.error ?? "Unknown provider error.",
      attempts: { increment: 1 }
    }
  });
  return toRecord(updated as Row);
}

/**
 * Retry a failed delivery. Re-uses the already-rendered subject/body so we
 * don't need to re-resolve the template (which may have changed in the
 * meantime — we want to retry the exact message that originally failed).
 */
export async function retryDelivery(deliveryId: string): Promise<NotificationDeliveryRecord> {
  const row = await prisma.notificationDelivery.findUnique({ where: { id: deliveryId } });
  if (!row) throw new Error("delivery_not_found");
  if (row.status === "sent") {
    return toRecord(row as Row);
  }
  return attemptSend(row.id, {
    subject: row.subject ?? "",
    body: row.bodyRendered ?? "",
    recipient: row.recipient,
    channel: row.channel
  });
}

export type ListDeliveriesInput = {
  organizationId?: string;
  propertyId?: string;
  status?: string;
  channel?: string;
  days?: number;
  limit?: number;
};

export async function listDeliveries(input: ListDeliveriesInput): Promise<NotificationDeliveryRecord[]> {
  const where: Prisma.NotificationDeliveryWhereInput = {};
  if (input.organizationId) where.organizationId = input.organizationId;
  if (input.propertyId) where.propertyId = input.propertyId;
  if (input.status) where.status = input.status;
  if (input.channel) where.channel = input.channel;
  if (input.days && input.days > 0) {
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    where.createdAt = { gte: since };
  }

  const rows = await prisma.notificationDelivery.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(input.limit ?? 200, 1000))
  });
  return rows.map((row) => toRecord(row as Row));
}

export type TemplateStat = {
  templateCode: string;
  channel: string;
  sent: number;
  failed: number;
  queued: number;
  total: number;
  lastSentAt: string | null;
  lastFailedAt: string | null;
};

/**
 * Per-template send/failure counts. Drives the Stats tab in the UI.
 */
export async function templateStats(input: {
  organizationId?: string;
  propertyId?: string;
  days?: number;
}): Promise<TemplateStat[]> {
  const where: Prisma.NotificationDeliveryWhereInput = {};
  if (input.organizationId) where.organizationId = input.organizationId;
  if (input.propertyId) where.propertyId = input.propertyId;
  if (input.days && input.days > 0) {
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    where.createdAt = { gte: since };
  }

  const rows = await prisma.notificationDelivery.findMany({
    where,
    select: { templateCode: true, channel: true, status: true, sentAt: true, failedAt: true }
  });

  const map = new Map<string, TemplateStat>();
  for (const row of rows) {
    const code = row.templateCode ?? "(manual)";
    const key = `${code}__${row.channel}`;
    let stat = map.get(key);
    if (!stat) {
      stat = {
        templateCode: code,
        channel: row.channel,
        sent: 0,
        failed: 0,
        queued: 0,
        total: 0,
        lastSentAt: null,
        lastFailedAt: null
      };
      map.set(key, stat);
    }
    stat.total += 1;
    if (row.status === "sent") {
      stat.sent += 1;
      if (row.sentAt && (!stat.lastSentAt || row.sentAt.toISOString() > stat.lastSentAt)) {
        stat.lastSentAt = row.sentAt.toISOString();
      }
    } else if (row.status === "failed" || row.status === "bounced") {
      stat.failed += 1;
      if (row.failedAt && (!stat.lastFailedAt || row.failedAt.toISOString() > stat.lastFailedAt)) {
        stat.lastFailedAt = row.failedAt.toISOString();
      }
    } else {
      stat.queued += 1;
    }
  }

  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}
