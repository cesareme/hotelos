// Entrega de webhooks salientes (P0-1 de la auditoría de 2026; cola pg-boss
// `webhooks.deliver`, un WorkerJobRun por tick — scheduler.ts).
//
// La auditoría encontró `WebhookSubscription` + `WebhookDelivery` modelados en
// Prisma y la superficie HTTP de suscripciones publicada, pero nada entregaba
// los eventos a las URLs de los suscriptores: un socio integrado con ehotelOS
// no recibía ningún evento en tiempo real. La superficie canónica es
// /webhooks/subscriptions (apps/api/src/security/route-permissions.ts); la
// familia duplicada /developer/webhooks/* se retiró en la Tanda L2 (L2-02).
//
// Este job cierra el bucle:
//   1. Lee filas `WebhookDelivery` con status="pending" o status="retrying".
//   2. Hace POST del payload a `WebhookSubscription.targetUrl` con firma
//      HMAC-SHA256 del cuerpo, usando el secreto de `secretRef`.
//   3. Registra la respuesta y reencola con backoff exponencial si falla
//      (hasta 6 intentos: 30s, 2m, 10m, 30m, 2h, 6h).
//
// ¿Por qué una fila `WebhookDelivery` por intento en vez de reintentar en vivo?
// Porque cada intento es auditable: un socio puede preguntar «¿os llegó el
// evento X?» y se responde con estado HTTP, marca de tiempo y cuerpo.
//
// Productor: `enqueueWebhookDeliveries` (aquí) o `dispatchEvent` en
// apps/api/src/modules/webhooks/webhooks.service.ts crean una fila por
// suscripción activa cuyo `eventTypes` contiene el tipo de evento; este job
// las recoge en el siguiente tick. Cablear `dispatchEvent` desde
// recordDomainEvent es de la Tanda L8 (hoy los eventos de dominio no lo llaman).

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { prisma } from "@hotelos/database";

// Max in-flight attempts before we give up. After this, status=permanent_failure.
const MAX_ATTEMPTS = 6;

// Exponential backoff in seconds: 30s → 2m → 10m → 30m → 2h → 6h.
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200, 21600];

// HMAC scheme: GitHub-compatible "sha256=<hex>" so partners can reuse libraries.
const SIG_HEADER = "X-HotelOS-Signature";
const EVENT_HEADER = "X-HotelOS-Event";
const DELIVERY_HEADER = "X-HotelOS-Delivery";
const SECRET_PREFIX = "whsec_";

const REQUEST_TIMEOUT_MS = 12_000;

type DeliveryRow = {
  id: string;
  webhookSubscriptionId: string;
  eventType: string;
  payloadJson: unknown;
  status: string;
  responseStatus: number | null;
  errorMessage: string | null;
  attemptedAt: Date;
};

function signBody(body: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${sig}`;
}

/**
 * Verify a signature header against a body + secret. Constant-time compare.
 * Exported for partner-side libraries and our own integration tests.
 */
export function verifyWebhookSignature(body: string, header: string, secret: string): boolean {
  const expected = signBody(body, secret);
  // Lengths must match for timingSafeEqual; protect against early returns.
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function backoffSecondsFor(attempt: number): number {
  const idx = Math.min(attempt, BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[idx];
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadPendingDeliveries(limit = 25): Promise<DeliveryRow[]> {
  const now = new Date();
  // Pick rows where status is pending or retrying AND attemptedAt is in the past.
  // attemptedAt acts as "next-scheduled" once requeued (we overwrite it on each retry).
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ["pending", "retrying"] },
      attemptedAt: { lte: now }
    },
    orderBy: { attemptedAt: "asc" },
    take: limit
  });
  return rows as unknown as DeliveryRow[];
}

async function loadSubscription(id: string) {
  return prisma.webhookSubscription.findUnique({ where: { id } });
}

/**
 * Worker tick: attempt all due deliveries.
 * Returns a summary that the scheduler can log.
 */
export async function runWebhookDeliveries(): Promise<{
  considered: number;
  delivered: number;
  failed: number;
  giveUp: number;
}> {
  const pending = await loadPendingDeliveries();
  let delivered = 0;
  let failed = 0;
  let giveUp = 0;

  for (const row of pending) {
    const sub = await loadSubscription(row.webhookSubscriptionId);
    if (!sub || !sub.active) {
      // Subscription was deleted or paused — mark this delivery as cancelled.
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: { status: "cancelled", errorMessage: "subscription inactive or removed" }
      });
      continue;
    }

    const body = JSON.stringify({
      eventId: row.id,
      eventType: row.eventType,
      deliveredAt: new Date().toISOString(),
      data: row.payloadJson ?? {}
    });

    const secret = sub.secretRef && sub.secretRef.startsWith(SECRET_PREFIX) ? sub.secretRef : `${SECRET_PREFIX}dev`;
    const signature = signBody(body, secret);

    // Count attempts as the (number of times the status moved through "retrying" + 1).
    // We can't read it cleanly from a single column, so we just clamp to MAX_ATTEMPTS.
    // The errorMessage holds "attempt=N" as our counter.
    const attempt = Number((row.errorMessage?.match(/attempt=(\d+)/) ?? [])[1] ?? 0) + 1;

    let httpStatus: number | null = null;
    let errorText: string | null = null;
    try {
      const res = await fetchWithTimeout(sub.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIG_HEADER]: signature,
          [EVENT_HEADER]: row.eventType,
          [DELIVERY_HEADER]: row.id
        },
        body
      });
      httpStatus = res.status;
      if (!res.ok) {
        errorText = `HTTP ${res.status} ${res.statusText}`.slice(0, 240);
      }
    } catch (e) {
      errorText = e instanceof Error ? e.message.slice(0, 240) : "unknown error";
    }

    const success = errorText == null;
    if (success) {
      delivered += 1;
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          responseStatus: httpStatus,
          errorMessage: null,
          attemptedAt: new Date()
        }
      });
      continue;
    }

    failed += 1;
    if (attempt >= MAX_ATTEMPTS) {
      giveUp += 1;
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "permanent_failure",
          responseStatus: httpStatus,
          errorMessage: `attempt=${attempt} ${errorText ?? "?"}`,
          attemptedAt: new Date()
        }
      });
    } else {
      const nextDelay = backoffSecondsFor(attempt);
      const nextAt = new Date(Date.now() + nextDelay * 1000);
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "retrying",
          responseStatus: httpStatus,
          errorMessage: `attempt=${attempt} ${errorText ?? "?"}`,
          attemptedAt: nextAt
        }
      });
    }
  }

  return { considered: pending.length, delivered, failed, giveUp };
}

/**
 * Enqueue a domain event for delivery to every matching subscriber.
 * Idempotent: callers can fire this freely after each domain event.
 *
 * @param input.eventType        e.g. "reservation.created", "folio.charge.posted"
 * @param input.propertyId       used to filter property-scoped subscriptions
 * @param input.payload          arbitrary JSON shipped in the `data` field
 */
export async function enqueueWebhookDeliveries(input: {
  eventType: string;
  propertyId?: string;
  payload: Record<string, unknown>;
}): Promise<{ enqueued: number }> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      active: true,
      eventTypes: { has: input.eventType },
      ...(input.propertyId ? { OR: [{ propertyId: input.propertyId }, { propertyId: null }] } : {})
    }
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

/**
 * Helper to generate a fresh signing secret for new subscriptions.
 * Format: `whsec_` + 32-byte URL-safe base64 (43 chars). Compatible with
 * Stripe/GitHub conventions so partner libraries Just Work.
 */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url");
}
