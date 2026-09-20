// Documents · READ-ONLY lookups on the Sage 200 data imported by the ledger
// import (Tanda T9 · lote T9-06b, design §5.1 «Validar» / §7.1). Three
// questions the validation asks before proposing a supplier bill:
//   · is this NIF a supplier already known in Sage (`ledger_third_parties`,
//     role supplier: name, 400/410 sub-account per Sage company)?
//   · was this invoice number already booked for that NIF in the Sage libro de
//     recibidas (`vat_book_entries`, book recibidas, sourceType sage200)?
//   · is there a booked invoice of that NIF with the same total ± 0,01 or a
//     date ± 3 days (fuzzy duplicate; the exact rule lives in validation.ts)?
// Only findFirst / findMany with a minimal select, never more than
// SAGE_LOOKUP_LIMIT rows, never a write. `db` is injectable (PrismaClient or
// a transaction client) so the unit tests run against an in-memory fake.
//
// Data shape (verified on the Faranda copy, numbers only): one
// `vat_book_entries` row per document AND rate (`sourceId` identifies the
// document; 1.778 of 7.868 received documents have several rates), so rows are
// aggregated by sourceId before they reach the validation; `number` keeps the
// separators typed in Sage ("F/2026/0042", "A-123"), so the fuzzy comparison
// strips them (normalizeReference); a NIF may appear in several Sage companies
// with a different 400/410 sub-account each (458 NIF), hence `accounts`.

import type { Prisma } from "@prisma/client";
import { normalizeNif } from "../payables/validators.js";
import { dec, money, round2, utcDay, type Decimal } from "../payables/money.js";
import { normalizeReference } from "./matching.js";

/** Prisma delegates the lookups need; a `PrismaClient` or a `Prisma.TransactionClient` both fit. */
export type SageDb = Pick<Prisma.TransactionClient, "ledgerThirdParty" | "vatBookEntry">;

export const SAGE_SYSTEM = "sage200";
export const SAGE_SUPPLIER_ROLE = "supplier";
/** Hard cap of rows any lookup reads. */
export const SAGE_LOOKUP_LIMIT = 20;
/** Fuzzy window: ± days around the extracted date and ± EUR around the extracted total. */
export const SAGE_FUZZY_DAYS = 3;
export const SAGE_FUZZY_AMOUNT = "0.01";

/** Canonical NIF for the lookups: upper-case, no spaces / hyphens / dots, no "ES" prefix (the same rule the import used). */
export function normalizeSageNif(raw: string | null | undefined): string | null {
  return normalizeNif(raw);
}

/** Canonical invoice number for comparisons: upper-case alphanumerics only ("F/2026-0042" → "F20260042"). */
export function normalizeSageNumber(raw: string | null | undefined): string {
  return normalizeReference(raw);
}

export type SageSupplier = {
  id: string;
  /** CodigoProveedor of the row chosen (the one already linked to a Supplier, else the first with an account). */
  sourceCode: string;
  /** Sage sub-account (400…/410…) of the chosen row or null. */
  sourceAccount: string | null;
  taxId: string | null;
  name: string;
  countryCode: string;
  /** `Supplier.id` when the import already created the supplier (null in the Faranda copy). */
  supplierId: string | null;
  /** Distinct sub-accounts of the NIF across Sage companies (the "400/410 por hotel" case), sorted. */
  accounts: string[];
  /** Rows read (≤ SAGE_LOOKUP_LIMIT). */
  rowCount: number;
};

type ThirdPartyRow = {
  id: string;
  sourceCode: string;
  sourceAccount: string | null;
  taxId: string | null;
  name: string;
  countryCode: string;
  supplierId: string | null;
};

/** Supplier of Sage by NIF (role supplier, system sage200) or null. Read-only. */
export async function findSageSupplierByNif(db: SageDb, organizationId: string, nif: string | null | undefined): Promise<SageSupplier | null> {
  const taxId = normalizeSageNif(nif);
  if (!taxId) return null;
  const rows: ThirdPartyRow[] = await db.ledgerThirdParty.findMany({
    where: { organizationId, system: SAGE_SYSTEM, role: SAGE_SUPPLIER_ROLE, taxId },
    select: { id: true, sourceCode: true, sourceAccount: true, taxId: true, name: true, countryCode: true, supplierId: true },
    orderBy: [{ updatedAt: "desc" }, { sourceCode: "asc" }],
    take: SAGE_LOOKUP_LIMIT
  });
  if (rows.length === 0) return null;
  const chosen = rows.find((r) => r.supplierId) ?? rows.find((r) => r.sourceAccount) ?? rows[0]!;
  const accounts = [...new Set(rows.map((r) => r.sourceAccount).filter((a): a is string => typeof a === "string" && a.length > 0))].sort();
  return {
    id: chosen.id,
    sourceCode: chosen.sourceCode,
    sourceAccount: chosen.sourceAccount,
    taxId: chosen.taxId,
    name: chosen.name,
    countryCode: chosen.countryCode,
    supplierId: chosen.supplierId,
    accounts,
    rowCount: rows.length
  };
}

/** One received invoice of Sage (rows of `vat_book_entries` aggregated by sourceId). */
export type SageReceived = {
  sourceId: string;
  number: string | null;
  counterpartyNif: string | null;
  /** YYYY-MM-DD. */
  date: string;
  /** Σ total of the rate rows, 2 decimals. */
  total: string;
  base: string;
  quota: string;
  retention: string;
  /** Distinct rates ("21", "10", "4"…), ascending. */
  rates: string[];
  /** Rows aggregated. */
  rowCount: number;
};

export type SageReceivedRow = {
  sourceId: string;
  number: string | null;
  counterpartyNif: string | null;
  date: Date;
  total: Decimal | string | number;
  base: Decimal | string | number;
  quota: Decimal | string | number;
  retention: Decimal | string | number;
  rate: Decimal | string | number;
};

const RECEIVED_SELECT = { sourceId: true, number: true, counterpartyNif: true, date: true, total: true, base: true, quota: true, retention: true, rate: true } as const;

/** Groups rate rows into documents (pure; exported for the tests). Order: date descending, then sourceId. */
export function aggregateSageReceived(rows: ReadonlyArray<SageReceivedRow>): SageReceived[] {
  const byDoc = new Map<string, { number: string | null; nif: string | null; date: Date; total: Decimal; base: Decimal; quota: Decimal; retention: Decimal; rates: Set<string>; rowCount: number }>();
  for (const row of rows) {
    const rate = dec(row.rate).toFixed(0);
    const current = byDoc.get(row.sourceId);
    if (!current) {
      byDoc.set(row.sourceId, {
        number: row.number,
        nif: row.counterpartyNif,
        date: row.date,
        total: dec(row.total),
        base: dec(row.base),
        quota: dec(row.quota),
        retention: dec(row.retention),
        rates: new Set([rate]),
        rowCount: 1
      });
      continue;
    }
    current.number = current.number ?? row.number;
    current.nif = current.nif ?? row.counterpartyNif;
    if (row.date < current.date) current.date = row.date;
    current.total = current.total.plus(dec(row.total));
    current.base = current.base.plus(dec(row.base));
    current.quota = current.quota.plus(dec(row.quota));
    current.retention = current.retention.plus(dec(row.retention));
    current.rates.add(rate);
    current.rowCount++;
  }
  return [...byDoc.entries()]
    .map(([sourceId, d]) => ({
      sourceId,
      number: d.number,
      counterpartyNif: d.nif,
      date: d.date.toISOString().slice(0, 10),
      total: money(d.total),
      base: money(d.base),
      quota: money(d.quota),
      retention: money(d.retention),
      rates: [...d.rates].sort((a, b) => Number(a) - Number(b)),
      rowCount: d.rowCount
    }))
    .sort((a, b) => (a.date === b.date ? a.sourceId.localeCompare(b.sourceId) : b.date.localeCompare(a.date)));
}

/** Received invoices of Sage with exactly this number (as typed in Sage) for the NIF. Read-only. */
export async function findSageReceivedByNifAndNumber(db: SageDb, organizationId: string, nif: string | null | undefined, number: string | null | undefined): Promise<SageReceived[]> {
  const taxId = normalizeSageNif(nif);
  const value = String(number ?? "").trim();
  if (!taxId || value.length === 0) return [];
  const rows = await db.vatBookEntry.findMany({
    where: { organizationId, book: "recibidas", sourceType: "sage200", counterpartyNif: taxId, number: value },
    select: RECEIVED_SELECT,
    orderBy: [{ date: "desc" }, { sourceId: "asc" }],
    take: SAGE_LOOKUP_LIMIT
  });
  return aggregateSageReceived(rows);
}

function toDay(value: string | Date): Date {
  return value instanceof Date ? new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())) : utcDay(value);
}

function shiftDays(day: Date, days: number): Date {
  const out = new Date(day.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Received invoices of the NIF near the extracted document: date within
 * ± SAGE_FUZZY_DAYS or (single-rate) total within ± SAGE_FUZZY_AMOUNT.
 * The two-of-three duplicate rule (number without separators, total,
 * date) is applied by validation.ts on the aggregated documents. Read-only.
 */
export async function findSageReceivedFuzzy(
  db: SageDb,
  organizationId: string,
  nif: string | null | undefined,
  total: Decimal | string | number | null | undefined,
  date: string | Date | null | undefined
): Promise<SageReceived[]> {
  const taxId = normalizeSageNif(nif);
  if (!taxId) return [];
  const windows: Prisma.VatBookEntryWhereInput[] = [];
  if (date !== null && date !== undefined && String(date).length > 0) {
    const day = toDay(date);
    if (!Number.isNaN(day.getTime())) windows.push({ date: { gte: shiftDays(day, -SAGE_FUZZY_DAYS), lte: shiftDays(day, SAGE_FUZZY_DAYS) } });
  }
  if (total !== null && total !== undefined && String(total).trim().length > 0) {
    const amount = round2(dec(total));
    const delta = dec(SAGE_FUZZY_AMOUNT);
    windows.push({ total: { gte: amount.minus(delta), lte: amount.plus(delta) } });
  }
  if (windows.length === 0) return [];
  const rows = await db.vatBookEntry.findMany({
    where: { organizationId, book: "recibidas", sourceType: "sage200", counterpartyNif: taxId, OR: windows },
    select: RECEIVED_SELECT,
    orderBy: [{ date: "desc" }, { sourceId: "asc" }],
    take: SAGE_LOOKUP_LIMIT
  });
  return aggregateSageReceived(rows);
}
