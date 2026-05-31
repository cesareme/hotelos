// Real webhook subscription service (P0-1).
//
// Replaces the legacy `/developer/webhooks/*` endpoints that wrote to the
// generic advanced-modules pipe (demoStore). This service uses Prisma directly
// against `WebhookSubscription` / `WebhookDelivery`, with HMAC-SHA256 signing
// and delivery handled by the worker (`apps/worker/src/jobs/webhook-delivery.job.ts`).

import { prisma } from "@hotelos/database";
import { createHmac, randomBytes } from "node:crypto";
import { requirePermissions } from "../auth/auth.service.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

// Event types we currently support. Extend as more domain events come online.
// Kept here (not in shared) so the API is the single source of truth for what
// partners may subscribe to.
export const WEBHOOK_EVENT_TYPES = [
  "reservation.created",
  "reservation.updated",
  "reservation.checked_in",
  "reservation.checked_out",
  "reservation.cancelled",
  "guest.created",
  "guest.updated",
  "guest.identity.verified",
  "folio.created",
  "folio.charge.posted",
  "folio.payment.posted",
  "folio.closed",
  "invoice.issued",
  "room.assigned",
  "room.status.changed",
  "stay.started",
  "stay.ended"
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const SECRET_PREFIX = "whsec_";

function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url");
}

export async function listSubscriptions(input: {
  context: UserContext;
  propertyId?: string;
}) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const where = input.propertyId
    ? { OR: [{ propertyId: input.propertyId }, { propertyId: null }] }
    : {};
  const rows = await prisma.webhookSubscription.findMany({
    where,
    orderBy: { createdAt: "desc" }
  });
  // Don't return the raw secret; partners get it ONCE on creation.
  return rows.map((r) => ({
    id: r.id,
    developerAppId: r.developerAppId,
    propertyId: r.propertyId,
    eventTypes: r.eventTypes,
    targetUrl: r.targetUrl,
    active: r.active,
    createdAt: r.createdAt,
    // secretMasked: only show last 4 chars; the full one was given on create.
    secretMasked: r.secretRef ? `whsec_…${r.secretRef.slice(-4)}` : null
  }));
}

export async function createSubscription(input: {
  context: UserContext;
  payload: {
    developerAppId?: string;
    propertyId?: string | null;
    eventTypes: string[];
    targetUrl: string;
  };
}) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const p = input.payload;
  if (!p.targetUrl || !/^https?:\/\//.test(p.targetUrl)) {
    throw new BadRequestError("targetUrl must be a valid http(s) URL.");
  }
  if (!Array.isArray(p.eventTypes) || p.eventTypes.length === 0) {
    throw new BadRequestError("eventTypes must be a non-empty array.");
  }
  const invalid = p.eventTypes.filter((t) => !WEBHOOK_EVENT_TYPES.includes(t as WebhookEventType));
  if (invalid.length > 0) {
    throw new BadRequestError(`Unknown event types: ${invalid.join(", ")}`);
  }
  const secret = generateSecret();
  const row = await prisma.webhookSubscription.create({
    data: {
      developerAppId: p.developerAppId ?? `app_${input.context.organizationId}`,
      propertyId: p.propertyId ?? null,
      eventTypes: p.eventTypes,
      targetUrl: p.targetUrl,
      secretRef: secret,
      active: true
    }
  });
  // Return the raw secret ONCE — caller must store it. Future GET requests
  // will only return a masked version.
  return { ...row, secret };
}

export async function updateSubscription(input: {
  context: UserContext;
  id: string;
  payload: Partial<{
    eventTypes: string[];
    targetUrl: string;
    active: boolean;
  }>;
}) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const existing = await prisma.webhookSubscription.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Webhook subscription not found.");
  const data: Record<string, unknown> = {};
  if (input.payload.eventTypes) {
    const invalid = input.payload.eventTypes.filter((t) => !WEBHOOK_EVENT_TYPES.includes(t as WebhookEventType));
    if (invalid.length > 0) throw new BadRequestError(`Unknown event types: ${invalid.join(", ")}`);
    data.eventTypes = input.payload.eventTypes;
  }
  if (input.payload.targetUrl !== undefined) {
    if (!/^https?:\/\//.test(input.payload.targetUrl)) throw new BadRequestError("targetUrl must be http(s).");
    data.targetUrl = input.payload.targetUrl;
  }
  if (typeof input.payload.active === "boolean") data.active = input.payload.active;
  const row = await prisma.webhookSubscription.update({ where: { id: input.id }, data });
  return row;
}

export async function deleteSubscription(input: { context: UserContext; id: string }) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  await prisma.webhookSubscription.delete({ where: { id: input.id } });
  return { ok: true, id: input.id };
}

export async function listDeliveries(input: {
  context: UserContext;
  subscriptionId: string;
  limit?: number;
}) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  return prisma.webhookDelivery.findMany({
    where: { webhookSubscriptionId: input.subscriptionId },
    orderBy: { attemptedAt: "desc" },
    take: Math.min(200, Math.max(1, input.limit ?? 50))
  });
}

/**
 * Send a synthetic test payload to a subscription's targetUrl. Useful for the
 * "Test" button in the dashboard. This is a *blocking* call (not via worker),
 * so the user sees the result in the UI immediately.
 */
export async function testSubscription(input: {
  context: UserContext;
  id: string;
}): Promise<{
  delivered: boolean;
  responseStatus: number | null;
  errorMessage: string | null;
}> {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: input.id } });
  if (!sub) throw new NotFoundError("Webhook subscription not found.");
  const body = JSON.stringify({
    eventId: `test_${Date.now()}`,
    eventType: "test.ping",
    deliveredAt: new Date().toISOString(),
    data: { hello: "from HotelOS" }
  });
  const secret = sub.secretRef ?? `${SECRET_PREFIX}dev`;
  const signature = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(sub.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HotelOS-Signature": signature,
        "X-HotelOS-Event": "test.ping",
        "X-HotelOS-Delivery": `test_${Date.now()}`
      },
      body,
      signal: controller.signal
    });
    // Persist the test delivery so it shows up in the deliveries list.
    await prisma.webhookDelivery.create({
      data: {
        webhookSubscriptionId: sub.id,
        eventType: "test.ping",
        payloadJson: JSON.parse(body),
        status: res.ok ? "delivered" : "permanent_failure",
        responseStatus: res.status,
        errorMessage: res.ok ? null : `HTTP ${res.status} ${res.statusText}`.slice(0, 240),
        attemptedAt: new Date()
      }
    });
    return { delivered: res.ok, responseStatus: res.status, errorMessage: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.webhookDelivery.create({
      data: {
        webhookSubscriptionId: sub.id,
        eventType: "test.ping",
        payloadJson: JSON.parse(body),
        status: "permanent_failure",
        responseStatus: null,
        errorMessage: msg.slice(0, 240),
        attemptedAt: new Date()
      }
    });
    return { delivered: false, responseStatus: null, errorMessage: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatch a domain event to every matching subscriber. Mirrors the
 * `enqueueWebhookDeliveries` helper in the worker; this version lives in the
 * API so that domain services can fire-and-forget without importing worker code.
 *
 * The worker still consumes the resulting `WebhookDelivery` rows on its next
 * tick (every 20s) and POSTs them to the partner URLs.
 */
export async function dispatchEvent(input: {
  eventType: WebhookEventType;
  propertyId?: string;
  payload: Record<string, unknown>;
}): Promise<{ enqueued: number }> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      active: true,
      eventTypes: { has: input.eventType },
      ...(input.propertyId ? { OR: [{ propertyId: input.propertyId }, { propertyId: null }] } : {})
    },
    select: { id: true }
  });
  if (subscriptions.length === 0) return { enqueued: 0 };
  await prisma.webhookDelivery.createMany({
    data: subscriptions.map((sub) => ({
      webhookSubscriptionId: sub.id,
      eventType: input.eventType,
      payloadJson: input.payload as unknown as object,
      status: "pending",
      attemptedAt: new Date()
    }))
  });
  return { enqueued: subscriptions.length };
}
