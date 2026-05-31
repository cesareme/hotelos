import { prisma, type Prisma } from "@hotelos/database";
import { resolveRule } from "./commission-rules.service.js";

// CommissionAccrual service.
//
// Builds `CommissionAccrual` rows that capture, per invoice or per
// checked-out reservation, how much commission the property *will owe* to an
// OTA. Accrual is decoupled from the journal posting: the journal entry is
// produced separately by `posting-rules/commission.ts` once the accrual has
// been recorded.
//
// Idempotency keys differ per source:
//   - `accrueCommissionForInvoice`     → (invoiceId, channelId|channelCode)
//   - `accrueCommissionForReservation` → (reservationId, channelId|channelCode)
//
// Status state machine:
//   accrued -> invoiced -> paid
//           \-> reversed
// (only `accrued` is written by this service; later states are owned by AP /
// payment flows.)

export type CommissionAccrualRecord = {
  id: string;
  propertyId: string;
  reservationId: string | null;
  invoiceId: string | null;
  channelId: string | null;
  channelCode: string | null;
  baseAmount: string;
  ratePct: string;
  commissionAmount: string;
  currencyCode: string;
  accruedAt: string;
  journalEntryId: string | null;
  status: string;
};

function toRecord(row: {
  id: string;
  propertyId: string;
  reservationId: string | null;
  invoiceId: string | null;
  channelId: string | null;
  channelCode: string | null;
  baseAmount: Prisma.Decimal;
  ratePct: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  currencyCode: string;
  accruedAt: Date;
  journalEntryId: string | null;
  status: string;
}): CommissionAccrualRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    reservationId: row.reservationId,
    invoiceId: row.invoiceId,
    channelId: row.channelId,
    channelCode: row.channelCode,
    baseAmount: row.baseAmount.toString(),
    ratePct: row.ratePct.toString(),
    commissionAmount: row.commissionAmount.toString(),
    currencyCode: row.currencyCode,
    accruedAt: row.accruedAt.toISOString(),
    journalEntryId: row.journalEntryId,
    status: row.status
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type AccrueForInvoiceInput = {
  propertyId: string;
  invoiceId: string;
  reservationId?: string | null;
  channelId?: string | null;
  channelCode?: string | null;
  baseAmount: number | string;
  currencyCode?: string;
  asOf?: Date | string;
};

/**
 * Accrue commission for an invoice. Idempotent on
 * (invoiceId, channelId|channelCode): re-running for the same key returns the
 * existing accrual instead of creating a duplicate.
 *
 * Returns null when no commission rule applies (most often: direct
 * channel, where no OTA fee is owed).
 */
export async function accrueCommissionForInvoice(input: AccrueForInvoiceInput): Promise<CommissionAccrualRecord | null> {
  if (!input.channelId && !input.channelCode) return null;
  const base = Number(input.baseAmount);
  if (!Number.isFinite(base) || base <= 0) return null;

  const rule = await resolveRule({
    propertyId: input.propertyId,
    channelId: input.channelId ?? null,
    channelCode: input.channelCode ?? null,
    asOf: input.asOf
  });
  if (!rule) return null;

  // Idempotency: look up by (invoiceId, attribution).
  const existing = await prisma.commissionAccrual.findFirst({
    where: {
      invoiceId: input.invoiceId,
      OR: [
        input.channelId ? { channelId: input.channelId } : { id: "__never__" },
        input.channelCode ? { channelCode: input.channelCode } : { id: "__never__" }
      ]
    }
  });
  if (existing) return toRecord(existing);

  const ratePct = Number(rule.ratePct);
  const commissionAmount = round2(base * (ratePct / 100));

  const created = await prisma.commissionAccrual.create({
    data: {
      propertyId: input.propertyId,
      reservationId: input.reservationId ?? null,
      invoiceId: input.invoiceId,
      channelId: input.channelId ?? null,
      channelCode: input.channelCode ?? null,
      baseAmount: base.toFixed(2),
      ratePct: ratePct.toFixed(2),
      commissionAmount: commissionAmount.toFixed(2),
      currencyCode: input.currencyCode ?? "EUR",
      status: "accrued"
    }
  });
  return toRecord(created);
}

export type AccrueForReservationInput = {
  propertyId: string;
  reservationId: string;
  channelId?: string | null;
  channelCode?: string | null;
  totalAmount: number | string;
  currencyCode?: string;
  asOf?: Date | string;
};

/**
 * Accrue commission at reservation check-out. Idempotent on
 * (reservationId, channelId|channelCode).
 */
export async function accrueCommissionForReservation(
  input: AccrueForReservationInput
): Promise<CommissionAccrualRecord | null> {
  if (!input.channelId && !input.channelCode) return null;
  const base = Number(input.totalAmount);
  if (!Number.isFinite(base) || base <= 0) return null;

  const rule = await resolveRule({
    propertyId: input.propertyId,
    channelId: input.channelId ?? null,
    channelCode: input.channelCode ?? null,
    asOf: input.asOf
  });
  if (!rule) return null;

  const existing = await prisma.commissionAccrual.findFirst({
    where: {
      reservationId: input.reservationId,
      invoiceId: null,
      OR: [
        input.channelId ? { channelId: input.channelId } : { id: "__never__" },
        input.channelCode ? { channelCode: input.channelCode } : { id: "__never__" }
      ]
    }
  });
  if (existing) return toRecord(existing);

  const ratePct = Number(rule.ratePct);
  const commissionAmount = round2(base * (ratePct / 100));

  const created = await prisma.commissionAccrual.create({
    data: {
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      invoiceId: null,
      channelId: input.channelId ?? null,
      channelCode: input.channelCode ?? null,
      baseAmount: base.toFixed(2),
      ratePct: ratePct.toFixed(2),
      commissionAmount: commissionAmount.toFixed(2),
      currencyCode: input.currencyCode ?? "EUR",
      status: "accrued"
    }
  });
  return toRecord(created);
}

export type ListAccrualsInput = {
  propertyId: string;
  from?: string | Date;
  to?: string | Date;
  status?: string;
  channelId?: string;
};

export async function listAccruals(input: ListAccrualsInput): Promise<CommissionAccrualRecord[]> {
  const where: Prisma.CommissionAccrualWhereInput = {
    propertyId: input.propertyId
  };
  if (input.status) where.status = input.status;
  if (input.channelId) where.channelId = input.channelId;
  if (input.from || input.to) {
    where.accruedAt = {
      ...(input.from ? { gte: new Date(input.from) } : {}),
      ...(input.to ? { lte: new Date(input.to) } : {})
    };
  }
  const rows = await prisma.commissionAccrual.findMany({
    where,
    orderBy: { accruedAt: "desc" },
    take: 200
  });
  return rows.map(toRecord);
}

export type CommissionSummary = {
  propertyId: string;
  from: string | null;
  to: string | null;
  total: { commissionAmount: number; baseAmount: number; count: number };
  byChannel: Array<{ channelKey: string; commissionAmount: number; baseAmount: number; count: number }>;
  byStatus: Array<{ status: string; commissionAmount: number; count: number }>;
};

export async function summary(
  propertyId: string,
  from?: string | Date,
  to?: string | Date
): Promise<CommissionSummary> {
  const where: Prisma.CommissionAccrualWhereInput = { propertyId };
  if (from || to) {
    where.accruedAt = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {})
    };
  }
  const rows = await prisma.commissionAccrual.findMany({ where });

  const total = { commissionAmount: 0, baseAmount: 0, count: rows.length };
  const byChannelMap = new Map<string, { commissionAmount: number; baseAmount: number; count: number }>();
  const byStatusMap = new Map<string, { commissionAmount: number; count: number }>();

  for (const row of rows) {
    const c = Number(row.commissionAmount);
    const b = Number(row.baseAmount);
    total.commissionAmount = round2(total.commissionAmount + c);
    total.baseAmount = round2(total.baseAmount + b);

    const channelKey = row.channelId ?? row.channelCode ?? "(unknown)";
    const channelAgg = byChannelMap.get(channelKey) ?? { commissionAmount: 0, baseAmount: 0, count: 0 };
    channelAgg.commissionAmount = round2(channelAgg.commissionAmount + c);
    channelAgg.baseAmount = round2(channelAgg.baseAmount + b);
    channelAgg.count += 1;
    byChannelMap.set(channelKey, channelAgg);

    const statusAgg = byStatusMap.get(row.status) ?? { commissionAmount: 0, count: 0 };
    statusAgg.commissionAmount = round2(statusAgg.commissionAmount + c);
    statusAgg.count += 1;
    byStatusMap.set(row.status, statusAgg);
  }

  return {
    propertyId,
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    total,
    byChannel: Array.from(byChannelMap.entries())
      .map(([channelKey, v]) => ({ channelKey, ...v }))
      .sort((a, b) => b.commissionAmount - a.commissionAmount),
    byStatus: Array.from(byStatusMap.entries()).map(([status, v]) => ({ status, ...v }))
  };
}

/**
 * Internal helper: link a journal entry to an existing accrual.
 */
export async function linkJournalEntry(accrualId: string, journalEntryId: string): Promise<void> {
  await prisma.commissionAccrual.update({
    where: { id: accrualId },
    data: { journalEntryId }
  });
}
