import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { isPostingAllowed } from "../fiscal-period.service.js";
import {
  accrueCommissionForInvoice,
  accrueCommissionForReservation,
  linkJournalEntry,
  type CommissionAccrualRecord
} from "../../commissions/commission-accrual.service.js";

// Commission posting rule.
//
// Listens to two domain events:
//   * `InvoiceIssued`         — when a B2B invoice is issued for a booking
//                               that came in via an OTA, accrue + post the
//                               commission expense.
//   * `ReservationCheckedOut` — fallback path for properties that bill on
//                               check-out without a separate invoice.
//
// Channel attribution is detected (in priority order) from:
//   1. Explicit `channelId` / `channelCode` keys in `event.payload`.
//   2. `event.payload.reservationId` → lookup `Reservation.channel` (a string
//      code such as "booking", "expedia", "direct").
//   3. (InvoiceIssued only) — no reliable invoice→folio FK exists in the
//      current schema, so we skip when neither (1) nor (2) yields a channel.
//
// Direct-channel bookings ("direct", "walk_in", null) are ignored — they
// generate no commission liability.
//
// Journal:   DR 6230 Comisiones OTA     /  CR 4109 Acreedores varios OTA
// Source:    sourceType="commission", sourceId=<accrualId>
// Idempotency:
//   - Accrual side : keyed by (invoiceId|reservationId, channelId|channelCode)
//   - Journal side : keyed by (sourceType, sourceId) → unique per accrualId.

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

  // Best-effort enrichment via reservation when only a reservationId is given.
  if (!channelId && !channelCode && reservationId) {
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (reservation?.channel && isOtaChannel(reservation.channel)) {
      channelCode = reservation.channel;
    }
  }

  if (!channelId && !channelCode) return null;
  if (!isOtaChannel(channelCode ?? null) && !channelId) return null;

  // Prefer an explicit baseAmount; fall back to total / netAmount on the
  // event; fall back to the persisted invoice total.
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
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (reservation?.channel && isOtaChannel(reservation.channel)) {
      channelCode = reservation.channel;
    }
  }

  if (!channelId && !channelCode) return null;
  if (!isOtaChannel(channelCode ?? null) && !channelId) return null;

  let baseAmount = numberOrZero(payload.totalAmount ?? payload.total ?? payload.baseAmount);
  if (baseAmount <= 0) {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { totalAmount: true }
    });
    baseAmount = reservation ? numberOrZero(reservation.totalAmount) : 0;
  }
  if (baseAmount <= 0) return null;

  return { channelId, channelCode, reservationId, baseAmount };
}

// Resolve organization-scoped account code → id, caching as withholding does.
const accountIdCache = new Map<string, string>();
async function resolveAccountId(organizationId: string, code: string): Promise<string | null> {
  const key = `${organizationId}::${code}`;
  const cached = accountIdCache.get(key);
  if (cached) return cached;
  const row = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId, code } },
    select: { id: true }
  });
  if (!row) return null;
  accountIdCache.set(key, row.id);
  return row.id;
}

async function postJournalForAccrual(
  event: EventEnvelope,
  accrual: CommissionAccrualRecord
): Promise<void> {
  // Idempotency at journal layer: keyed by (sourceType, sourceId).
  const existing = await prisma.journalEntry.findFirst({
    where: {
      organizationId: event.organizationId,
      sourceType: "commission",
      sourceId: accrual.id
    },
    select: { id: true }
  });
  if (existing) {
    if (!accrual.journalEntryId) await linkJournalEntry(accrual.id, existing.id);
    return;
  }

  const postingDate = new Date(event.createdAt);
  const check = await isPostingAllowed(event.organizationId, event.propertyId || undefined, postingDate);
  if (!check.allowed) {
    // Mirror the projection.ts behaviour: surface a clear error.
    throw new Error(`Commission posting blocked: fiscal period ${check.closedPeriodCode} is closed.`);
  }

  const debitAccountCode = "6230"; // Comisiones OTA (gasto)
  const creditAccountCode = "4109"; // Acreedores varios OTA
  const [debitAccountId, creditAccountId] = await Promise.all([
    resolveAccountId(event.organizationId, debitAccountCode),
    resolveAccountId(event.organizationId, creditAccountCode)
  ]);
  if (!debitAccountId || !creditAccountId) {
    const missing = [
      !debitAccountId ? debitAccountCode : null,
      !creditAccountId ? creditAccountCode : null
    ].filter(Boolean).join(", ");
    throw new Error(`Missing accounts in chart for organization ${event.organizationId}: ${missing}`);
  }

  const amount = Number(accrual.commissionAmount);
  const description = `Comisión OTA ${accrual.channelCode ?? accrual.channelId ?? ""} ${accrual.ratePct}% sobre €${Number(accrual.baseAmount).toFixed(2)}`;

  await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: event.organizationId,
        propertyId: event.propertyId,
        sourceType: "commission",
        sourceId: accrual.id,
        status: "posted",
        postedAt: new Date(),
        createdBy: event.actorUserId ?? null
      }
    });
    await tx.journalLine.createMany({
      data: [
        {
          journalEntryId: entry.id,
          accountId: debitAccountId,
          debit: amount.toFixed(2),
          credit: "0.00",
          currency: accrual.currencyCode ?? "EUR",
          description
        },
        {
          journalEntryId: entry.id,
          accountId: creditAccountId,
          debit: "0.00",
          credit: amount.toFixed(2),
          currency: accrual.currencyCode ?? "EUR",
          description
        }
      ]
    });
    await tx.commissionAccrual.update({ where: { id: accrual.id }, data: { journalEntryId: entry.id } });
  });
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
  await postJournalForAccrual(event, accrual);
}
