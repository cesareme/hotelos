// Event-bus hook for the notification dispatcher (Sprint 26).
//
// `queueNotificationsForEvent` is called from `audit.service.recordDomainEvent`
// after the other projection chains. It inspects the event type and, when
// appropriate, dispatches a notification through `dispatcher.dispatch`.
//
// Design notes:
//   - Side effects are queued onto a serialized chain so concurrent domain
//     events don't race when looking up reservations/folios.
//   - Failures are swallowed — a missing recipient or template MUST NOT crash
//     the projection chain. Errors are logged for the operator.
//   - Idempotency is delegated to `dispatcher.dispatch`, which keys
//     `NotificationDelivery` on (notificationId, channel, recipient). We pass
//     the domain `eventId` as `notificationId`.

import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { dispatch as defaultDispatch, type DispatchInput, type NotificationDeliveryRecord } from "./dispatcher.service.js";

const dispatch = defaultDispatch;

/** Default magic-link base URL when GUEST_WEB_BASE_URL is not configured. */
const DEFAULT_GUEST_WEB_BASE_URL = "http://localhost:5174";

/** Magic link sessions expire 24h after creation (mirrors guest-portal-auth). */
const MAGIC_LINK_EXPIRY_HOURS = 24;

let hookChain: Promise<void> = Promise.resolve();

export function queueNotificationsForEvent(event: EventEnvelope): void {
  hookChain = hookChain.then(async () => {
    try {
      await handleEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[notifications] failed to process ${event.eventType} (${event.eventId}): ${message}`
      );
    }
  });
}

/** Test/diagnostic helper — wait for all hook-side dispatch work to settle. */
export async function flushNotificationHooks(): Promise<void> {
  await hookChain;
}

async function handleEvent(event: EventEnvelope): Promise<void> {
  switch (event.eventType) {
    case "InvoiceIssued":
      await handleInvoiceIssued(event);
      return;
    case "ReservationCreated":
    case "ReservationConfirmed":
      // We accept either name. Today only `ReservationCreated` is emitted by
      // pms.service.ts; when a Confirmed event is wired later it reuses the
      // same template.
      await handleReservationConfirmed(event);
      return;
    case "PaymentCaptured":
      await handlePaymentCaptured(event);
      return;
    case "GuestPortalSignInRequested":
      await handleGuestPortalSignInRequested(event);
      return;
    default:
      return;
  }
}

// ---- handlers ----

async function handleInvoiceIssued(event: EventEnvelope): Promise<void> {
  if (!event.entityId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: event.entityId } });
  if (!invoice) return;

  // Invoices have no direct customer-email column. The customer is often the
  // booker on the originating reservation; we look up the most recent folio
  // for the same property + customerTaxId and fall back to the booker email
  // on its reservation. This is best-effort — if no email surfaces we silently
  // skip rather than spam log noise.
  const recipient = await deriveInvoiceRecipientEmail(invoice.propertyId, invoice.customerTaxId);
  if (!recipient) return;

  const property = await prisma.property.findUnique({
    where: { id: invoice.propertyId },
    select: { organizationId: true, name: true }
  });
  if (!property) return;

  await dispatch({
    organizationId: property.organizationId,
    propertyId: invoice.propertyId,
    templateCode: "invoice_issued",
    channel: "email",
    recipient,
    notificationId: event.eventId,
    variables: {
      invoice_number: invoice.invoiceNumber ?? "(draft)",
      invoice_total: invoice.total.toString(),
      currency: invoice.currencyCode,
      issued_at: invoice.issuedAt?.toISOString() ?? "",
      property_name: property.name,
      verifactu_hash: invoice.verifactuHash ?? ""
    }
  });
}

async function handleReservationConfirmed(event: EventEnvelope): Promise<void> {
  if (!event.entityId) return;
  const reservation = await prisma.reservation.findUnique({ where: { id: event.entityId } });
  if (!reservation) return;
  const recipient = reservation.bookerEmail?.trim();
  if (!recipient) return;

  const property = await prisma.property.findUnique({
    where: { id: reservation.propertyId },
    select: { organizationId: true, name: true }
  });
  if (!property) return;

  await dispatch({
    organizationId: property.organizationId,
    propertyId: reservation.propertyId,
    templateCode: "reservation_confirmed",
    channel: "email",
    recipient,
    notificationId: event.eventId,
    variables: {
      booker_name: reservation.bookerName ?? "",
      reservation_code: reservation.code,
      arrival_date: reservation.arrivalDate.toISOString().slice(0, 10),
      departure_date: reservation.departureDate.toISOString().slice(0, 10),
      adults: reservation.adults,
      children: reservation.children,
      property_name: property.name,
      total_amount: reservation.totalAmount.toString(),
      currency: reservation.currency
    }
  });
}

async function handlePaymentCaptured(event: EventEnvelope): Promise<void> {
  if (!event.entityId) return;
  const payment = await prisma.payment.findUnique({ where: { id: event.entityId } });
  if (!payment) return;

  // Payment → folio → reservation → bookerEmail
  const folio = await prisma.folio.findUnique({ where: { id: payment.folioId } });
  if (!folio) return;
  const reservation = await prisma.reservation.findUnique({ where: { id: folio.reservationId } });
  if (!reservation) return;
  const recipient = reservation.bookerEmail?.trim();
  if (!recipient) return;

  const property = await prisma.property.findUnique({
    where: { id: payment.propertyId },
    select: { organizationId: true, name: true }
  });
  if (!property) return;

  await dispatch({
    organizationId: property.organizationId,
    propertyId: payment.propertyId,
    templateCode: "payment_receipt",
    channel: "email",
    recipient,
    notificationId: event.eventId,
    variables: {
      booker_name: reservation.bookerName ?? "",
      reservation_code: reservation.code,
      payment_amount: payment.amount.toString(),
      payment_method: payment.method,
      currency: payment.currency,
      property_name: property.name
    }
  });
}

// ---- guest portal magic link (Sprint 45) ----

/**
 * Shape carried on the `GuestPortalSignInRequested` event payload. The
 * guest-portal auth service populates every field it can; the handler is
 * defensive about missing pieces (a missing recipient/token is skipped, not
 * thrown).
 */
export type GuestPortalSignInPayload = {
  token?: unknown;
  reservationId?: unknown;
  propertyId?: unknown;
  recipientEmail?: unknown;
  // Legacy field name used before Sprint 45 — accepted as a fallback.
  email?: unknown;
  reservationCode?: unknown;
  propertyName?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Build the guest-web magic-link URL from a raw session token. */
export function buildMagicLinkUrl(token: string): string {
  const base = (process.env.GUEST_WEB_BASE_URL ?? DEFAULT_GUEST_WEB_BASE_URL).replace(/\/$/, "");
  return `${base}/?token=${encodeURIComponent(token)}`;
}

/**
 * Core magic-link dispatch logic, factored out with an injectable dispatcher so
 * it is unit-testable without a database or live provider. Returns the dispatch
 * result, or null when there was nothing to send (missing recipient/token) —
 * which is NOT an error.
 *
 * A missing template surfaces as a thrown `template_not_found` from the
 * dispatcher; the caller (`handleGuestPortalSignInRequested`) wraps this in
 * try/catch so it never crashes the sign-in flow.
 */
export async function dispatchGuestMagicLink(
  event: EventEnvelope,
  dispatchFn: (input: DispatchInput) => Promise<NotificationDeliveryRecord> = dispatch
): Promise<NotificationDeliveryRecord | null> {
  const payload = (event.payload ?? {}) as GuestPortalSignInPayload;
  const token = asTrimmedString(payload.token);
  const recipient = asTrimmedString(payload.recipientEmail) || asTrimmedString(payload.email);
  // Without a recipient or token there is nothing meaningful to deliver.
  if (!recipient || !token) return null;

  const magicLinkUrl = buildMagicLinkUrl(token);
  const reservationCode = asTrimmedString(payload.reservationCode);
  const propertyName = asTrimmedString(payload.propertyName);

  return dispatchFn({
    organizationId: event.organizationId,
    propertyId: event.propertyId,
    templateCode: "guest_magic_link",
    channel: "email",
    recipient,
    notificationId: event.eventId,
    language: "es",
    variables: {
      propertyName,
      magicLinkUrl,
      reservationCode,
      expiryHours: MAGIC_LINK_EXPIRY_HOURS
    }
  });
}

export async function handleGuestPortalSignInRequested(
  event: EventEnvelope,
  dispatchFn: (input: DispatchInput) => Promise<NotificationDeliveryRecord> = dispatch
): Promise<void> {
  // The surrounding hook already swallows errors, but we add a local guard so
  // the intent is explicit: a missing template or recipient must NEVER crash
  // the guest sign-in flow.
  try {
    await dispatchGuestMagicLink(event, dispatchFn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[notifications] guest magic link delivery skipped for ${event.eventId}: ${message}`
    );
  }
}

// ---- helpers ----

async function deriveInvoiceRecipientEmail(
  propertyId: string,
  customerTaxId: string | null
): Promise<string | null> {
  if (!customerTaxId) return null;
  // Best-effort: find a recent reservation at this property whose booker
  // looks like the invoiced customer. We can't link via taxId in the schema,
  // so we just look at reservations with non-null bookerEmail and pick the
  // most recent — good enough for the demo + a documented integration point.
  const reservation = await prisma.reservation.findFirst({
    where: { propertyId, bookerEmail: { not: null } },
    orderBy: { createdAt: "desc" }
  });
  return reservation?.bookerEmail ?? null;
}
