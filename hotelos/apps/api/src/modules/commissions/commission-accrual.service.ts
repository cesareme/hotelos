// Channel (OTA) commissions: accrual, journal, settlement and reversal.
//
// Lote tesoreria-banca. Rule (PGC Pymes): D 629.1 Comisiones de canales /
// H 410 Acreedores por prestaciones de servicios, accrued at check-out
// (`GuestCheckedOut`, the event the PMS really emits) or at invoice issue
// (`InvoiceIssued` for a reservation with an OTA channel), whichever comes
// first for the same (property, reservation, channel) — the unique key of
// `CommissionAccrual`. Settlement to the channel: D 410 / H 572. Reversal:
// inverse entry through the ledger bridge, status `reversed`; a re-accrual
// updates the same row (the unique key stays) with a new entry.
//
// The base follows the rule's `appliesTo`:
//   · total          → Reservation.totalAmount (or the invoice total);
//   · gross_revenue  → Σ folio charges of the reservation, taxes excluded
//                      (tax / city_tax / tourist_tax lines), VAT included;
//   · net_revenue    → gross without VAT: the invoice base when an issued
//                      invoice exists, else the folio lines without their VAT
//                      (rate from the line's taxCode; 10 % accommodation
//                      art. 91.Uno.2.2º LIVA for room lines without one,
//                      21 % otherwise — reported in `warnings`).
// The rule's `ledgerAccountCode` is honoured when it exists in the chart;
// the legacy default "6230" (seed) maps to the canonical 629.1.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import type { EventEnvelope } from "@hotelos/shared";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { ledger, type Db } from "../treasury/ledger-bridge.js";
import { dayUtc, dec, isoDay, money, moneyNumber, percentOf, round2, sum, type Dec } from "../treasury/money.js";
import { resolveRule, type CommissionRuleRecord } from "./commission-rules.service.js";

export const COMMISSION_EXPENSE_CODE = "629.1";
export const COMMISSION_PAYABLE_CODE = "410";
const LEGACY_EXPENSE_CODE = "6230";
const LEGACY_PAYABLE_CODE = "4109";
const BANK_CODE = "572";

const DIRECT_CHANNEL_CODES = new Set(["direct", "walk_in", "walkin", "phone", "email", "web", "website", ""]);
const NON_REVENUE_LINE_TYPES = new Set(["tax", "city_tax", "tourist_tax", "payment", "deposit", "refund"]);

export function isOtaChannel(channel: string | null | undefined): channel is string {
  if (!channel) return false;
  return !DIRECT_CHANNEL_CODES.has(channel.trim().toLowerCase());
}

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
  reversalJournalEntryId: string | null;
  settledAt: string | null;
  settlementJournalEntryId: string | null;
  status: string;
};

type AccrualRow = {
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
  reversalJournalEntryId: string | null;
  settledAt: Date | null;
  settlementJournalEntryId: string | null;
  status: string;
};

function toRecord(row: AccrualRow): CommissionAccrualRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    reservationId: row.reservationId,
    invoiceId: row.invoiceId,
    channelId: row.channelId,
    channelCode: row.channelCode,
    baseAmount: money(row.baseAmount),
    ratePct: row.ratePct.toString(),
    commissionAmount: money(row.commissionAmount),
    currencyCode: row.currencyCode,
    accruedAt: row.accruedAt.toISOString(),
    journalEntryId: row.journalEntryId,
    reversalJournalEntryId: row.reversalJournalEntryId,
    settledAt: row.settledAt?.toISOString() ?? null,
    settlementJournalEntryId: row.settlementJournalEntryId,
    status: row.status
  };
}

/** 15 % of 100.00 → 15.00 (HALF_UP to the cent). */
export function computeCommission(base: Dec | string | number, ratePct: Dec | string | number): Dec {
  return percentOf(round2(dec(base)), dec(ratePct));
}

async function organizationOfProperty(propertyId: string, db: Db = prisma): Promise<string> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("La propiedad no existe.");
  return property.organizationId;
}

/** Expense / payable codes for the organization: the rule's code when it exists, else the canonical subaccounts. */
export async function resolveCommissionAccounts(organizationId: string, ruleLedgerAccountCode: string | null | undefined, db: Db = prisma): Promise<{ expenseCode: string; payableCode: string }> {
  const wanted = [COMMISSION_EXPENSE_CODE, COMMISSION_PAYABLE_CODE, LEGACY_EXPENSE_CODE, LEGACY_PAYABLE_CODE];
  const custom = ruleLedgerAccountCode?.trim();
  if (custom && !wanted.includes(custom)) wanted.push(custom);
  const rows = await db.account.findMany({ where: { organizationId, code: { in: wanted } }, select: { code: true, isPostable: true } });
  const postable = new Set(rows.filter((r) => r.isPostable).map((r) => r.code));
  let expenseCode = COMMISSION_EXPENSE_CODE;
  if (custom && custom !== LEGACY_EXPENSE_CODE && postable.has(custom)) expenseCode = custom;
  else if (!postable.has(COMMISSION_EXPENSE_CODE) && postable.has(LEGACY_EXPENSE_CODE)) expenseCode = LEGACY_EXPENSE_CODE;
  const payableCode = postable.has(COMMISSION_PAYABLE_CODE) ? COMMISSION_PAYABLE_CODE : LEGACY_PAYABLE_CODE;
  return { expenseCode, payableCode };
}

// ---- Base computation ---------------------------------------------------------

function vatRateFromTaxCode(taxCode: string | null, taxCategory: string | null): Dec | null {
  const hint = `${taxCode ?? ""} ${taxCategory ?? ""}`.toUpperCase();
  const m = /(?:IVA|IGIC|IPSI)[_\s-]?(\d{1,2})/.exec(hint);
  if (m) return dec(m[1]);
  if (/EXENT|EXEMPT|_0\b/.test(hint)) return dec(0);
  return null;
}

export type CommissionBase = { base: Dec; source: string; warnings: string[] };

/** Base of a reservation for `appliesTo` (see the module header). */
export async function computeReservationCommissionBase(reservationId: string, appliesTo: string, db: Db = prisma): Promise<CommissionBase> {
  const warnings: string[] = [];
  const reservation = await db.reservation.findUnique({ where: { id: reservationId }, select: { totalAmount: true } });
  if (!reservation) throw new NotFoundError("La reserva no existe.");
  if (appliesTo === "total") return { base: round2(dec(reservation.totalAmount)), source: "reservation.totalAmount", warnings };

  const folios = await db.folio.findMany({ where: { reservationId, deletedAt: null }, select: { id: true } });
  const lines = folios.length
    ? await db.folioLine.findMany({ where: { folioId: { in: folios.map((f) => f.id) }, deletedAt: null }, select: { type: true, total: true, taxCode: true, taxCategory: true } })
    : [];
  const revenueLines = lines.filter((l) => !NON_REVENUE_LINE_TYPES.has(l.type));
  if (revenueLines.length === 0) {
    warnings.push("La reserva no tiene cargos en el folio: se usa el total de la reserva como base.");
    return { base: round2(dec(reservation.totalAmount)), source: "reservation.totalAmount", warnings };
  }
  const gross = round2(sum(revenueLines.map((l) => dec(l.total))));
  if (appliesTo === "gross_revenue") return { base: gross, source: "folio.charges", warnings };

  // net_revenue: prefer the issued invoice base of the reservation.
  const invoices = await db.invoice.findMany({
    where: { reservationId, status: { in: ["issued", "rectified"] }, deletedAt: null, rectifyingForId: null },
    select: { total: true, taxTotal: true, baseTotal: true }
  });
  if (invoices.length > 0) {
    const base = round2(sum(invoices.map((inv) => (inv.baseTotal !== null ? dec(inv.baseTotal) : dec(inv.total).minus(dec(inv.taxTotal))))));
    return { base, source: "invoice.baseTotal", warnings };
  }
  let net = dec(0);
  let assumed = 0;
  for (const line of revenueLines) {
    let rate = vatRateFromTaxCode(line.taxCode, line.taxCategory);
    if (rate === null) {
      rate = line.type === "room" || line.type === "accommodation" || line.type === "lodging" ? dec(10) : dec(21);
      assumed++;
    }
    net = net.plus(round2(dec(line.total).div(dec(1).plus(rate.div(100)))));
  }
  if (assumed > 0) warnings.push(`${assumed} línea(s) sin tipo de IVA explícito: base neta estimada al 10 % (alojamiento) / 21 % (resto).`);
  return { base: round2(net), source: "folio.charges.net", warnings };
}

// ---- Accrual -------------------------------------------------------------------

export type AccrueCommissionInput = {
  propertyId: string;
  reservationId?: string | null;
  invoiceId?: string | null;
  channelId?: string | null;
  channelCode?: string | null;
  /** Explicit base (skips `appliesTo`); otherwise computed from the reservation / invoice. */
  baseAmount?: Dec | string | number | null;
  currencyCode?: string;
  /** Accounting date of the accrual (check-out / invoice date). */
  accruedAt?: Date | string;
  createdBy?: string | null;
  reference?: string | null;
};

export type AccrueCommissionResult = {
  accrual: CommissionAccrualRecord | null;
  journalEntryId: string | null;
  created: boolean;
  skippedReason: string | null;
  base: CommissionBase | null;
  rule: CommissionRuleRecord | null;
};

async function findExisting(input: { propertyId: string; reservationId?: string | null; invoiceId?: string | null; channelId?: string | null; channelCode?: string | null }, db: Db) {
  if (input.reservationId && input.channelCode) {
    const byKey = await db.commissionAccrual.findUnique({
      where: { propertyId_reservationId_channelCode: { propertyId: input.propertyId, reservationId: input.reservationId, channelCode: input.channelCode } }
    });
    if (byKey) return byKey;
  }
  const attribution = [
    input.channelId ? { channelId: input.channelId } : null,
    input.channelCode ? { channelCode: input.channelCode } : null
  ].filter((x): x is { channelId: string } | { channelCode: string } => x !== null);
  if (attribution.length === 0) return null;
  if (input.reservationId) {
    const byReservation = await db.commissionAccrual.findFirst({ where: { propertyId: input.propertyId, reservationId: input.reservationId, OR: attribution } });
    if (byReservation) return byReservation;
  }
  if (input.invoiceId) {
    return db.commissionAccrual.findFirst({ where: { propertyId: input.propertyId, invoiceId: input.invoiceId, OR: attribution } });
  }
  return null;
}

/**
 * Accrue the commission of a reservation/invoice for its channel: idempotent
 * on the unique key; a reversed accrual is re-accrued in place. Returns
 * `accrual: null` with `skippedReason` when no rule applies (direct channel).
 */
export async function accrueCommission(input: AccrueCommissionInput): Promise<AccrueCommissionResult> {
  const channelCode = input.channelCode?.trim().toLowerCase() || null;
  if (!input.channelId && !isOtaChannel(channelCode)) {
    return { accrual: null, journalEntryId: null, created: false, skippedReason: "canal directo: sin comisión", base: null, rule: null };
  }
  const accruedAt = dayUtc(input.accruedAt ?? new Date());
  const rule = await resolveRule({ propertyId: input.propertyId, channelId: input.channelId ?? null, channelCode, asOf: accruedAt });
  if (!rule) {
    return { accrual: null, journalEntryId: null, created: false, skippedReason: `sin regla de comisión para el canal ${channelCode ?? input.channelId}`, base: null, rule: null };
  }

  let base: CommissionBase;
  if (input.baseAmount !== null && input.baseAmount !== undefined) {
    base = { base: round2(dec(input.baseAmount)), source: "explicit", warnings: [] };
  } else if (input.reservationId) {
    base = await computeReservationCommissionBase(input.reservationId, rule.appliesTo);
  } else if (input.invoiceId) {
    const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId }, select: { total: true, taxTotal: true, baseTotal: true } });
    if (!invoice) throw new NotFoundError("La factura no existe.");
    base =
      rule.appliesTo === "net_revenue"
        ? { base: round2(invoice.baseTotal !== null ? dec(invoice.baseTotal) : dec(invoice.total).minus(dec(invoice.taxTotal))), source: "invoice.baseTotal", warnings: [] }
        : { base: round2(dec(invoice.total)), source: "invoice.total", warnings: [] };
  } else {
    return { accrual: null, journalEntryId: null, created: false, skippedReason: "sin reserva ni factura", base: null, rule };
  }
  if (base.base.lte(0)) {
    return { accrual: null, journalEntryId: null, created: false, skippedReason: "base cero o negativa", base, rule };
  }

  const commission = computeCommission(base.base, rule.ratePct);
  const organizationId = await organizationOfProperty(input.propertyId);
  const { expenseCode, payableCode } = await resolveCommissionAccounts(organizationId, rule.ledgerAccountCode);
  const channelLabel = channelCode ?? input.channelId ?? "canal";

  return prisma.$transaction(async (tx) => {
    const existing = await findExisting({ ...input, channelCode }, tx as unknown as Db);
    if (existing && existing.status !== "reversed") {
      return { accrual: toRecord(existing), journalEntryId: existing.journalEntryId, created: false, skippedReason: "ya devengada", base, rule };
    }
    const row = existing
      ? await tx.commissionAccrual.update({
          where: { id: existing.id },
          data: {
            invoiceId: input.invoiceId ?? existing.invoiceId,
            channelId: input.channelId ?? existing.channelId,
            baseAmount: base.base,
            ratePct: dec(rule.ratePct),
            commissionAmount: commission,
            currencyCode: input.currencyCode ?? existing.currencyCode,
            accruedAt: accruedAt,
            status: "accrued",
            settledAt: null,
            settlementJournalEntryId: null
          }
        })
      : await tx.commissionAccrual.create({
          data: {
            propertyId: input.propertyId,
            reservationId: input.reservationId ?? null,
            invoiceId: input.invoiceId ?? null,
            channelId: input.channelId ?? null,
            channelCode,
            baseAmount: base.base,
            ratePct: dec(rule.ratePct),
            commissionAmount: commission,
            currencyCode: input.currencyCode ?? "EUR",
            accruedAt: accruedAt,
            status: "accrued"
          }
        });
    // A re-accrual after a reversal needs a fresh idempotency key.
    const sourceId = existing?.reversalJournalEntryId ? `${row.id}#re:${existing.reversalJournalEntryId}` : row.id;
    const description = `Comisión ${channelLabel} ${dec(rule.ratePct).toFixed(2)} % sobre ${money(base.base)} €`;
    const entry = await ledger().postJournalEntry({
      organizationId,
      propertyId: input.propertyId,
      entryDate: accruedAt,
      sourceType: "commission",
      sourceId,
      description,
      reference: input.reference ?? row.reservationId ?? row.invoiceId ?? null,
      createdBy: input.createdBy ?? null,
      lines: [
        { accountCode: expenseCode, debit: commission, description },
        { accountCode: payableCode, credit: commission, description: `${description} · acreedor ${channelLabel}` }
      ],
      db: tx as unknown as Db
    });
    const updated = await tx.commissionAccrual.update({ where: { id: row.id }, data: { journalEntryId: entry.id } });
    return { accrual: toRecord(updated), journalEntryId: entry.id, created: true, skippedReason: null, base, rule };
  });
}

// ---- Event hook -----------------------------------------------------------------

/**
 * Projection handler (replaces accounting/posting-rules/commission.ts in the
 * HANDLERS list): GuestCheckedOut → accrue for the reservation; InvoiceIssued
 * → accrue for the invoice's reservation (or the invoice itself). Never
 * throws for irrelevant events; errors propagate to the dispatcher log.
 */
export async function accrueCommissionFromEvent(event: EventEnvelope): Promise<AccrueCommissionResult | null> {
  if (!event.organizationId || !event.propertyId) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.eventType === "GuestCheckedOut" || event.eventType === "ReservationCheckedOut") {
    const reservationId = event.entityId ?? (typeof payload.reservationId === "string" ? payload.reservationId : null);
    if (!reservationId) return null;
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { channel: true, propertyId: true, departureDate: true } });
    if (!reservation || !isOtaChannel(reservation.channel)) return null;
    return accrueCommission({
      propertyId: reservation.propertyId,
      reservationId,
      channelCode: reservation.channel,
      accruedAt: reservation.departureDate ?? event.createdAt,
      createdBy: event.actorUserId ?? null,
      reference: reservationId
    });
  }
  if (event.eventType === "InvoiceIssued") {
    const invoiceId = event.entityId;
    if (!invoiceId) return null;
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { propertyId: true, reservationId: true, folioId: true, issuedAt: true, invoiceNumber: true, simplified: true } });
    if (!invoice || invoice.simplified) return null;
    let reservationId = invoice.reservationId;
    if (!reservationId && invoice.folioId) {
      const folio = await prisma.folio.findUnique({ where: { id: invoice.folioId }, select: { reservationId: true } });
      reservationId = folio?.reservationId ?? null;
    }
    const explicitChannel = typeof payload.channelCode === "string" ? payload.channelCode : null;
    let channelCode = explicitChannel;
    if (!channelCode && reservationId) {
      const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { channel: true } });
      channelCode = reservation?.channel ?? null;
    }
    if (!isOtaChannel(channelCode)) return null;
    return accrueCommission({
      propertyId: invoice.propertyId,
      reservationId,
      invoiceId,
      channelCode,
      accruedAt: invoice.issuedAt ?? event.createdAt,
      createdBy: event.actorUserId ?? null,
      reference: invoice.invoiceNumber ?? invoiceId
    });
  }
  return null;
}

// ---- Settlement / reversal --------------------------------------------------------

export type SettleCommissionInput = {
  accrualId: string;
  paidAt?: Date | string;
  /** 572 by default; a bank account's ledger code when settled from a bank line. */
  bankLedgerCode?: string | null;
  reference?: string | null;
  createdBy?: string | null;
  db?: Db;
};

/** Liquidación al canal: D 410 / H 572. Idempotent (an accrual settles once). */
export async function settleCommissionAccrual(input: SettleCommissionInput): Promise<CommissionAccrualRecord> {
  const db = input.db ?? prisma;
  const accrual = await db.commissionAccrual.findUnique({ where: { id: input.accrualId } });
  if (!accrual) throw new NotFoundError("El devengo de comisión no existe.");
  if (accrual.status === "settled" && accrual.settlementJournalEntryId) return toRecord(accrual);
  if (accrual.status !== "accrued" || !accrual.journalEntryId) {
    throw new ConflictError("Solo se liquida una comisión devengada y contabilizada.", { code: "COMMISSION_NOT_ACCRUED", status: accrual.status });
  }
  const organizationId = await organizationOfProperty(accrual.propertyId, db);
  const { payableCode } = await resolveCommissionAccounts(organizationId, null, db);
  const paidAt = dayUtc(input.paidAt ?? new Date());
  const amount = round2(dec(accrual.commissionAmount));
  const description = `Liquidación comisión ${accrual.channelCode ?? accrual.channelId ?? "canal"} · ${money(amount)} €`;
  const entry = await ledger().postJournalEntry({
    organizationId,
    propertyId: accrual.propertyId,
    entryDate: paidAt,
    sourceType: "commission",
    sourceId: `${accrual.id}:settlement`,
    description,
    reference: input.reference ?? accrual.reservationId ?? null,
    createdBy: input.createdBy ?? null,
    lines: [
      { accountCode: payableCode, debit: amount, description },
      { accountCode: input.bankLedgerCode?.trim() || BANK_CODE, credit: amount, description }
    ],
    db
  });
  const updated = await db.commissionAccrual.update({
    where: { id: accrual.id },
    data: { status: "settled", settledAt: paidAt, settlementJournalEntryId: entry.id }
  });
  return toRecord(updated);
}

export type ReverseCommissionInput = { accrualId: string; reason?: string | null; entryDate?: Date | string; createdBy?: string | null; db?: Db };

/** Reverso del devengo (asiento inverso marcado); una comisión liquidada no se revierte. */
export async function reverseCommissionAccrual(input: ReverseCommissionInput): Promise<CommissionAccrualRecord> {
  const db = input.db ?? prisma;
  const accrual = await db.commissionAccrual.findUnique({ where: { id: input.accrualId } });
  if (!accrual) throw new NotFoundError("El devengo de comisión no existe.");
  if (accrual.status === "reversed") return toRecord(accrual);
  if (accrual.status === "settled") {
    throw new ConflictError("La comisión ya está liquidada: no se puede revertir el devengo.", { code: "COMMISSION_SETTLED" });
  }
  const organizationId = await organizationOfProperty(accrual.propertyId, db);
  let reversalJournalEntryId: string | null = null;
  if (accrual.journalEntryId) {
    const reversal = await ledger().reverseJournalEntry({
      organizationId,
      journalEntryId: accrual.journalEntryId,
      entryDate: input.entryDate ?? new Date(),
      description: `Reverso comisión ${accrual.channelCode ?? accrual.channelId ?? "canal"}${input.reason ? ` — ${input.reason}` : ""}`,
      createdBy: input.createdBy ?? null,
      db
    });
    reversalJournalEntryId = reversal.id;
  }
  const updated = await db.commissionAccrual.update({ where: { id: accrual.id }, data: { status: "reversed", reversalJournalEntryId } });
  return toRecord(updated);
}

// ---- Read models -------------------------------------------------------------------

export type ListAccrualsInput = { propertyId: string; from?: string | Date; to?: string | Date; status?: string; channelId?: string; limit?: number };

export async function listAccruals(input: ListAccrualsInput): Promise<CommissionAccrualRecord[]> {
  const where: Prisma.CommissionAccrualWhereInput = { propertyId: input.propertyId };
  if (input.status) where.status = input.status;
  if (input.channelId) where.channelId = input.channelId;
  if (input.from || input.to) {
    where.accruedAt = { ...(input.from ? { gte: new Date(input.from) } : {}), ...(input.to ? { lte: new Date(input.to) } : {}) };
  }
  const rows = await prisma.commissionAccrual.findMany({ where, orderBy: { accruedAt: "desc" }, take: Math.min(Math.max(input.limit ?? 200, 1), 1000) });
  return rows.map(toRecord);
}

export async function getAccrual(id: string): Promise<CommissionAccrualRecord> {
  const row = await prisma.commissionAccrual.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("El devengo de comisión no existe.");
  return toRecord(row);
}

export type CommissionSummary = {
  propertyId: string;
  from: string | null;
  to: string | null;
  total: { commissionAmount: number; baseAmount: number; count: number };
  /** accrued and not settled: what the property still owes to channels. */
  outstanding: { commissionAmount: number; count: number };
  byChannel: Array<{ channelKey: string; commissionAmount: number; baseAmount: number; count: number }>;
  byStatus: Array<{ status: string; commissionAmount: number; count: number }>;
};

export async function summary(propertyId: string, from?: string | Date, to?: string | Date): Promise<CommissionSummary> {
  const where: Prisma.CommissionAccrualWhereInput = { propertyId };
  if (from || to) where.accruedAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
  const rows = await prisma.commissionAccrual.findMany({ where, take: 5000 });
  let totalCommission = dec(0);
  let totalBase = dec(0);
  let outstanding = dec(0);
  let outstandingCount = 0;
  const byChannelMap = new Map<string, { commissionAmount: Dec; baseAmount: Dec; count: number }>();
  const byStatusMap = new Map<string, { commissionAmount: Dec; count: number }>();
  for (const row of rows) {
    const c = dec(row.commissionAmount);
    const b = dec(row.baseAmount);
    if (row.status !== "reversed") {
      totalCommission = totalCommission.plus(c);
      totalBase = totalBase.plus(b);
    }
    if (row.status === "accrued") {
      outstanding = outstanding.plus(c);
      outstandingCount++;
    }
    const channelKey = row.channelCode ?? row.channelId ?? "(sin canal)";
    const channelAgg = byChannelMap.get(channelKey) ?? { commissionAmount: dec(0), baseAmount: dec(0), count: 0 };
    if (row.status !== "reversed") {
      channelAgg.commissionAmount = channelAgg.commissionAmount.plus(c);
      channelAgg.baseAmount = channelAgg.baseAmount.plus(b);
      channelAgg.count += 1;
    }
    byChannelMap.set(channelKey, channelAgg);
    const statusAgg = byStatusMap.get(row.status) ?? { commissionAmount: dec(0), count: 0 };
    statusAgg.commissionAmount = statusAgg.commissionAmount.plus(c);
    statusAgg.count += 1;
    byStatusMap.set(row.status, statusAgg);
  }
  return {
    propertyId,
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    total: { commissionAmount: moneyNumber(totalCommission), baseAmount: moneyNumber(totalBase), count: rows.filter((r) => r.status !== "reversed").length },
    outstanding: { commissionAmount: moneyNumber(outstanding), count: outstandingCount },
    byChannel: Array.from(byChannelMap.entries())
      .map(([channelKey, v]) => ({ channelKey, commissionAmount: moneyNumber(v.commissionAmount), baseAmount: moneyNumber(v.baseAmount), count: v.count }))
      .sort((a, b) => b.commissionAmount - a.commissionAmount),
    byStatus: Array.from(byStatusMap.entries()).map(([status, v]) => ({ status, commissionAmount: moneyNumber(v.commissionAmount), count: v.count }))
  };
}

// ---- Legacy entry points (posting-rules/commission.ts still imports them) -------------

export type AccrueForInvoiceInput = { propertyId: string; invoiceId: string; reservationId?: string | null; channelId?: string | null; channelCode?: string | null; baseAmount: number | string; currencyCode?: string; asOf?: Date | string };

/** @deprecated use accrueCommission — kept so the legacy posting rule compiles; it now posts through the ledger too. */
export async function accrueCommissionForInvoice(input: AccrueForInvoiceInput): Promise<CommissionAccrualRecord | null> {
  const result = await accrueCommission({ propertyId: input.propertyId, invoiceId: input.invoiceId, reservationId: input.reservationId ?? null, channelId: input.channelId ?? null, channelCode: input.channelCode ?? null, baseAmount: input.baseAmount, currencyCode: input.currencyCode, accruedAt: input.asOf });
  return result.accrual;
}

export type AccrueForReservationInput = { propertyId: string; reservationId: string; channelId?: string | null; channelCode?: string | null; totalAmount: number | string; currencyCode?: string; asOf?: Date | string };

/** @deprecated use accrueCommission. */
export async function accrueCommissionForReservation(input: AccrueForReservationInput): Promise<CommissionAccrualRecord | null> {
  const result = await accrueCommission({ propertyId: input.propertyId, reservationId: input.reservationId, channelId: input.channelId ?? null, channelCode: input.channelCode ?? null, baseAmount: input.totalAmount, currencyCode: input.currencyCode, accruedAt: input.asOf });
  return result.accrual;
}

/** @deprecated the accrual already carries its entry; kept for the legacy posting rule. */
export async function linkJournalEntry(accrualId: string, journalEntryId: string): Promise<void> {
  await prisma.commissionAccrual.updateMany({ where: { id: accrualId, journalEntryId: null }, data: { journalEntryId } });
}

export function accrualDay(record: CommissionAccrualRecord): string {
  return isoDay(new Date(record.accruedAt));
}
