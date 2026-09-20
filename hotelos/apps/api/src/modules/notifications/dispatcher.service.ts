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

/** `errorMessage` written on a `sent` row when no provider is configured: the send never left the box (Tanda L8). */
export const SIMULATED_ERROR_MESSAGE = "SIMULADO: proveedor no configurado; no se envió de verdad.";

/**
 * true for a delivery recorded as `sent` without a real provider (errorMessage
 * «SIMULADO…»). Such a row is never a delivery: stats count it apart and the
 * admin screen mirrors this rule in screens/notifications/delivery-outcome.ts.
 */
export function isSimulatedDelivery(row: { status: string; errorMessage: string | null }): boolean {
  return row.status === "sent" && /^SIMULADO/i.test(row.errorMessage ?? "");
}

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
  /**
   * Corrector Tanda CHK (SEC-1): secrets that must NEVER be persisted in
   * `notification_deliveries` (payloadJson.variables / bodyRendered / subject),
   * e.g. the guest-portal magic-link token or an OTP code. The message is
   * rendered with the real values for the provider only; the stored copy has
   * `variables[key]` replaced by REDACTED_MARK and every `values` occurrence
   * scrubbed from subject/body. A redacted delivery cannot be retried from the
   * stored body (retryDelivery refuses with `delivery_redacted`).
   */
  redact?: { variables?: readonly string[]; values?: readonly string[] };
};

export const REDACTED_MARK = "[redacted]";
/** payloadJson flag set on deliveries whose stored copy was redacted. */
export const REDACTED_FLAG = "redacted";

/** Stored copy of a rendered message with the secret values scrubbed (pure). */
export function redactRendered(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (typeof value !== "string" || value.length < 4) continue;
    out = out.split(value).join(REDACTED_MARK);
    out = out.split(encodeURIComponent(value)).join(REDACTED_MARK);
  }
  return out;
}

/** Stored copy of the template variables: secret keys replaced, secret values scrubbed from any string (pure). */
export function redactVariables(variables: Record<string, unknown>, redact: DispatchInput["redact"]): Record<string, unknown> {
  if (!redact) return variables;
  const keys = new Set(redact.variables ?? []);
  const values = (redact.values ?? []).filter((value): value is string => typeof value === "string");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (keys.has(key)) out[key] = REDACTED_MARK;
    else out[key] = typeof value === "string" ? redactRendered(value, values) : value;
  }
  return out;
}

/**
 * Secret strings to scrub from the stored subject/body: the explicit `values`
 * (e.g. the bare token, so the stored URL keeps `…?token=[redacted]&property=…`)
 * or, when the caller gave none, the whole values of the secret `variables`.
 */
function secretValuesOf(variables: Record<string, unknown>, redact: DispatchInput["redact"]): string[] {
  if (!redact) return [];
  const explicit = (redact.values ?? []).filter((value): value is string => typeof value === "string" && value.length >= 4);
  if (explicit.length > 0) return explicit;
  return (redact.variables ?? []).map((key) => variables[key]).filter((value): value is string => typeof value === "string" && value.length >= 4);
}

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

  // SEC-1: the provider gets the real message; the row keeps a scrubbed copy.
  const secrets = secretValuesOf(input.variables, input.redact);
  const redacted = secrets.length > 0;
  const storedSubject = redacted ? redactRendered(subject, secrets) : subject;
  const storedBody = redacted ? redactRendered(body, secrets) : body;
  const storedVariables = redactVariables(input.variables, input.redact);

  const queued = await prisma.notificationDelivery.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      notificationId: input.notificationId ?? null,
      templateCode: input.templateCode,
      channel: input.channel,
      recipient: input.recipient,
      status: "queued",
      subject: storedSubject || null,
      bodyRendered: storedBody,
      payloadJson: { variables: storedVariables, ...(redacted ? { [REDACTED_FLAG]: true } : {}) } as Prisma.InputJsonValue,
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

/** true when the stored copy of the delivery was redacted (secrets scrubbed): it cannot be re-sent from the row. */
export function isRedactedDelivery(payloadJson: unknown): boolean {
  return Boolean(payloadJson && typeof payloadJson === "object" && !Array.isArray(payloadJson) && (payloadJson as Record<string, unknown>)[REDACTED_FLAG] === true);
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
        errorMessage: result.simulated ? SIMULATED_ERROR_MESSAGE : null,
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
  // SEC-1: the stored body of a redacted delivery has the secret scrubbed; re-sending it would deliver
  // «[redacted]». The caller re-issues the message (e.g. resend the invitation) instead.
  if (isRedactedDelivery(row.payloadJson)) throw new Error("delivery_redacted");
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
  /** Real sends only (a provider accepted the message). */
  sent: number;
  /** `sent` rows recorded without a provider (errorMessage «SIMULADO»): never counted as `sent` (Tanda L8). */
  simulated: number;
  failed: number;
  queued: number;
  total: number;
  /** Last REAL send; simulated rows do not move it. */
  lastSentAt: string | null;
  lastFailedAt: string | null;
};

/**
 * Per-template send/failure counts. Drives the Stats tab in the UI.
 * `total` = sent + simulated + failed + queued.
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
    select: { templateCode: true, channel: true, status: true, errorMessage: true, sentAt: true, failedAt: true }
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
        simulated: 0,
        failed: 0,
        queued: 0,
        total: 0,
        lastSentAt: null,
        lastFailedAt: null
      };
      map.set(key, stat);
    }
    stat.total += 1;
    if (isSimulatedDelivery(row)) {
      stat.simulated += 1;
    } else if (row.status === "sent") {
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
