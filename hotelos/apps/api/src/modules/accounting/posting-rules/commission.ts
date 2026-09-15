import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { findJournalEntryBySource, localDateInTz, postJournalEntry, type PostedJournalEntry } from "../accounting.service.js";
import { buildCommissionAccrualEntry } from "../posting-rules.js";
import {
  accrueCommissionForInvoice,
  accrueCommissionForReservation,
  linkJournalEntry,
  type CommissionAccrualRecord
} from "../../commissions/commission-accrual.service.js";

// Channel commission posting rule (canonical rule «Comisión de canal» §2).
//
// Listens to two domain events:
//   * `InvoiceIssued`         — a B2B invoice for a booking that came through
//                               an OTA: accrue + post the commission expense.
//   * `ReservationCheckedOut` — properties that bill on check-out without a
//                               separate invoice.
// Channel attribution (priority): explicit channelId/channelCode in the
// payload → payload.reservationId → Reservation.channel. Direct bookings
// ("direct", "walk_in", null…) carry no commission.
//
// Journal (engine, fecha contable = accrual date in the property time zone):
//   D 629.1 Comisiones de canales de venta / H 410 Acreedores por prestaciones de servicios
// Idempotent: accrual keyed by (invoiceId|reservationId, channel); journal
// keyed by (sourceType "commission", sourceId accrualId).

const DIRECT_CHANNEL_CODES = new Set(["direct", "walk_in", "walkin", "phone", "email", ""]);

function isOtaChannel(channel: string | null | undefined): channel is string {
  if (!channel) return false;
  return !DIRECT_CHANNEL_CODES.has(channel.toLowerCase());
}

function numberOrZero(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

type Attribution = {
  channelId: string | null;
  channelCode: string | null;
  reservationId: string | null;
  baseAmount: number;
};

async function attributionForInvoice(event: EventEnvelope): Promise<Attribution | null> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const invoiceId = event.entityId;
  if (!invoiceId) return null;

  let channelId = (payload.channelId as string | undefined) ?? null;
  let channelCode = (payload.channelCode as string | undefined) ?? null;
  let reservationId = (payload.reservationId as string | undefined) ?? null;

  if (!reservationId) {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { reservationId: true } });
    reservationId = invoice?.reservationId ?? null;
  }
  if (!channelId && !channelCode && reservationId) {
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { channel: true } });
    if (reservation?.channel && isOtaChannel(reservation.channel)) channelCode = reservation.channel;
  }
  if (!channelId && !channelCode) return null;
  if (!isOtaChannel(channelCode ?? null) && !channelId) return null;

  let baseAmount = numberOrZero(payload.baseAmount ?? payload.netAmount ?? payload.total);
  if (baseAmount <= 0) {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { total: true } });
    baseAmount = invoice ? numberOrZero(invoice.total) : 0;
  }
  if (baseAmount <= 0) return null;
  return { channelId, channelCode, reservationId, baseAmount };
}

async function attributionForReservation(event: EventEnvelope): Promise<Attribution | null> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const reservationId = event.entityId ?? (payload.reservationId as string | undefined) ?? null;
  if (!reservationId) return null;

  let channelId = (payload.channelId as string | undefined) ?? null;
  let channelCode = (payload.channelCode as string | undefined) ?? null;
  if (!channelId && !channelCode) {
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { channel: true } });
    if (reservation?.channel && isOtaChannel(reservation.channel)) channelCode = reservation.channel;
  }
  if (!channelId && !channelCode) return null;
  if (!isOtaChannel(channelCode ?? null) && !channelId) return null;

  let baseAmount = numberOrZero(payload.totalAmount ?? payload.total ?? payload.baseAmount);
  if (baseAmount <= 0) {
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { totalAmount: true } });
    baseAmount = reservation ? numberOrZero(reservation.totalAmount) : 0;
  }
  if (baseAmount <= 0) return null;
  return { channelId, channelCode, reservationId, baseAmount };
}

/**
 * Asiento of a commission accrual (idempotent). Exported for the commissions
 * lot (accrual on check-out / invoice according to the rule).
 */
export async function postCommissionAccrual(input: { organizationId: string; accrual: CommissionAccrualRecord; actorUserId?: string | null; correlationId?: string }): Promise<PostedJournalEntry> {
  const accrual = input.accrual;
  const existing = await findJournalEntryBySource(prisma, input.organizationId, "commission", accrual.id);
  if (existing) {
    if (!accrual.journalEntryId) await linkJournalEntry(accrual.id, existing.id);
  }
  const property = await prisma.property.findUnique({ where: { id: accrual.propertyId }, select: { timezone: true } });
  const reservation = accrual.reservationId ? await prisma.reservation.findUnique({ where: { id: accrual.reservationId }, select: { code: true } }) : null;
  const entry = buildCommissionAccrualEntry({
    organizationId: input.organizationId,
    propertyId: accrual.propertyId,
    accrualId: accrual.id,
    entryDate: localDateInTz(new Date(accrual.accruedAt), property?.timezone ?? "Europe/Madrid"),
    channelCode: accrual.channelCode ?? accrual.channelId,
    amount: accrual.commissionAmount,
    baseAmount: accrual.baseAmount,
    ratePct: accrual.ratePct,
    reference: reservation?.code ?? accrual.invoiceId ?? null
  });
  const posted = await postJournalEntry({
    organizationId: input.organizationId,
    propertyId: accrual.propertyId,
    entryDate: entry.entryDate,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    description: entry.description,
    reference: entry.reference,
    lines: entry.lines,
    createdBy: input.actorUserId ?? null,
    currencyCode: accrual.currencyCode ?? "EUR",
    correlationId: input.correlationId
  });
  if (posted.created || !accrual.journalEntryId) await linkJournalEntry(accrual.id, posted.id);
  return posted;
}

/**
 * Side-effect entry point invoked by the projection dispatcher. Returns
 * silently for irrelevant events.
 */
export async function recordCommissionFromEvent(event: EventEnvelope): Promise<void> {
  if (!event.organizationId || !event.propertyId) return;

  let accrual: CommissionAccrualRecord | null = null;
  if (event.eventType === "InvoiceIssued") {
    const attribution = await attributionForInvoice(event);
    if (!attribution || !event.entityId) return;
    accrual = await accrueCommissionForInvoice({
      propertyId: event.propertyId,
      invoiceId: event.entityId,
      reservationId: attribution.reservationId,
      channelId: attribution.channelId,
      channelCode: attribution.channelCode,
      baseAmount: attribution.baseAmount,
      asOf: event.createdAt
    });
  } else if (event.eventType === "ReservationCheckedOut") {
    const attribution = await attributionForReservation(event);
    if (!attribution) return;
    accrual = await accrueCommissionForReservation({
      propertyId: event.propertyId,
      reservationId: attribution.reservationId!,
      channelId: attribution.channelId,
      channelCode: attribution.channelCode,
      totalAmount: attribution.baseAmount,
      asOf: event.createdAt
    });
  } else {
    return;
  }

  if (!accrual) return;
  // The accrual service (commissions lot) already posts its asiento through the engine; only fill the gap.
  if (accrual.journalEntryId) return;
  await postCommissionAccrual({ organizationId: event.organizationId, accrual, actorUserId: event.actorUserId ?? null, correlationId: event.correlationId });
}
