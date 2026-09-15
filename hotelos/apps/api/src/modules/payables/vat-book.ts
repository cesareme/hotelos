// Payables · input VAT helpers (libro de recibidas / bienes de inversión).
//
// One VatBookEntry per document AND tax rate, unique by
// (organizationId, book, sourceType, sourceId, rate). The row is written in
// the SAME transaction as the journal entry (runbook §1.4) and is the single
// source of the Modelo 303 (boxes 28-31), 390 and 347 for supplier bills and
// expenses. The liquidation period is computed from VatSettings at write
// time; without a row the organisation is quarterly / general / IVA.

import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/http-error.js";
import { dec, money, type Decimal } from "./money.js";

export type Tx = Prisma.TransactionClient;

/** Rates that have a 472.xx sub-account in the «PGC Pymes hotelero» template (IVA 21/10/4, IGIC 7/3, IPSI 4/2) plus 0 (exenta / no sujeta). */
export const SUPPORTED_INPUT_VAT_RATES: readonly string[] = Object.freeze(["21", "10", "4", "7", "3", "2", "0"]);

/** Canonical rate code ("21", "10", "4", "7", "3", "2", "0") or null when unsupported. */
export function taxRateCodeOf(rate: Decimal | string | number): string | null {
  const value = dec(rate);
  if (value.isNegative() || !value.isInteger()) return null;
  const code = value.toFixed(0);
  return SUPPORTED_INPUT_VAT_RATES.includes(code) ? code : null;
}

/** 472 sub-account of a supported rate ("21" → "472.21"); rate 0 has no quota line. */
export function inputVatAccountFor(rateCode: string): string | null {
  if (rateCode === "0") return null;
  return `472.${rateCode.padStart(2, "0")}`;
}

export function assertSupportedRate(rate: Decimal | string | number, what = "tipo de IVA"): string {
  const code = taxRateCodeOf(rate);
  if (code === null) {
    throw new HttpError(400, `${what} no admitido: ${dec(rate).toString()} %. Tipos válidos: ${SUPPORTED_INPUT_VAT_RATES.join(", ")}.`, true, {
      code: "UNSUPPORTED_TAX_RATE",
      rate: dec(rate).toString(),
      supported: SUPPORTED_INPUT_VAT_RATES
    });
  }
  return code;
}

export type VatPeriodicity = "quarterly" | "monthly";

/** "2026-Q3" (quarterly) or "2026-09" (monthly) for a UTC-midnight date. */
export function vatPeriodFor(date: Date, periodicity: VatPeriodicity): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (periodicity === "monthly") return `${year}-${String(month).padStart(2, "0")}`;
  return `${year}-Q${Math.ceil(month / 3)}`;
}

export type VatContext = { periodicity: VatPeriodicity; taxFigure: string };

/**
 * Reads the organisation's VatSettings (read-only: the lote IVA/AEAT owns
 * `ensureVatSettings`, which creates the row at first use). Missing row →
 * quarterly / IVA, the contract default.
 */
export async function readVatContext(tx: Tx, organizationId: string): Promise<VatContext> {
  const row = await tx.vatSettings.findUnique({ where: { organizationId }, select: { periodicity: true, taxFigure: true } });
  return { periodicity: row?.periodicity ?? "quarterly", taxFigure: row?.taxFigure ?? "IVA" };
}

export type InputVatRow = {
  rateCode: string;
  base: Decimal;
  quota: Decimal;
  retention: Decimal;
  investmentGood: boolean;
};

/**
 * Groups document lines by (book, rate): base and quota summed from the
 * already-rounded line amounts (never recomputed from the total), retention
 * summed per group so Σ retention of the rows = document retention.
 */
export function groupInputVatRows(lines: ReadonlyArray<{ rateCode: string; base: Decimal; quota: Decimal; retention: Decimal; investmentGood?: boolean }>): InputVatRow[] {
  const groups = new Map<string, InputVatRow>();
  for (const line of lines) {
    const investmentGood = line.investmentGood === true;
    const key = `${investmentGood ? "inv" : "cur"}|${line.rateCode}`;
    const current = groups.get(key) ?? { rateCode: line.rateCode, base: dec(0), quota: dec(0), retention: dec(0), investmentGood };
    current.base = current.base.plus(line.base);
    current.quota = current.quota.plus(line.quota);
    current.retention = current.retention.plus(line.retention);
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((a, b) => Number(a.investmentGood) - Number(b.investmentGood) || Number(b.rateCode) - Number(a.rateCode));
}

export type WriteInputVatRowsInput = {
  organizationId: string;
  propertyId: string | null;
  date: Date;
  series?: string | null;
  number?: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  sourceType: "supplier_bill" | "expense";
  sourceId: string;
  deductible: boolean;
  rows: InputVatRow[];
};

/** Writes the recibidas / bienes_inversion rows of a document (idempotent through the unique key: existing rows are replaced). */
export async function writeInputVatRows(tx: Tx, input: WriteInputVatRowsInput): Promise<number> {
  const vat = await readVatContext(tx, input.organizationId);
  const period = vatPeriodFor(input.date, vat.periodicity);
  await tx.vatBookEntry.deleteMany({
    where: { organizationId: input.organizationId, sourceType: input.sourceType, sourceId: input.sourceId }
  });
  if (input.rows.length === 0) return 0;
  await tx.vatBookEntry.createMany({
    data: input.rows.map((row) => ({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      book: row.investmentGood ? "bienes_inversion" : "recibidas",
      date: input.date,
      series: input.series ?? null,
      number: input.number ?? null,
      counterpartyNif: input.counterpartyNif,
      counterpartyName: input.counterpartyName,
      base: row.base,
      rate: dec(row.rateCode),
      quota: row.quota,
      total: row.base.plus(row.quota),
      retention: row.retention,
      taxFigure: vat.taxFigure,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      period,
      deductible: input.deductible
    }))
  });
  return input.rows.length;
}

/** Removes the book rows of a document that is being cancelled / reversed (the book keeps only live documents; see the lote report). */
export async function deleteInputVatRows(tx: Tx, organizationId: string, sourceType: "supplier_bill" | "expense", sourceId: string): Promise<number> {
  const result = await tx.vatBookEntry.deleteMany({ where: { organizationId, sourceType, sourceId } });
  return result.count;
}

export type VatBookRowDto = {
  id: string;
  book: string;
  date: string;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  base: string;
  rate: string;
  quota: string;
  total: string;
  retention: string;
  period: string;
  deductible: boolean;
};

export async function listVatRowsOf(tx: Tx, organizationId: string, sourceType: "supplier_bill" | "expense", sourceId: string): Promise<VatBookRowDto[]> {
  const rows = await tx.vatBookEntry.findMany({ where: { organizationId, sourceType, sourceId }, orderBy: [{ book: "asc" }, { rate: "desc" }] });
  return rows.map((r) => ({
    id: r.id,
    book: r.book,
    date: r.date.toISOString().slice(0, 10),
    series: r.series ?? null,
    number: r.number ?? null,
    counterpartyNif: r.counterpartyNif ?? null,
    counterpartyName: r.counterpartyName ?? null,
    base: money(r.base),
    rate: dec(r.rate).toFixed(0),
    quota: money(r.quota),
    total: money(r.total),
    retention: money(r.retention),
    period: r.period,
    deductible: r.deductible
  }));
}
