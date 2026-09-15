// Invoice snapshot, PGC journal lines and VAT-book rows of an issued invoice
// (finanzas · lote facturación-cobros, 2026-09-15). Pure: no I/O, Decimal
// arithmetic, rounding to the cent per line and squaring of the totals.
//
// Canonical rules implemented here (docs/runbooks/finanzas-contabilidad.md §2):
//   Factura emitida   D 4300 (total) / H 705.x (base por departamento) / H 477.tipo (cuota) [/ H 4759 tasa turística]
//   Rectificativa     the same lines built from the rectificativa's own (negative
//                     or delta) breakdown: a negative amount flips the side, so
//                     every line stays positive in debit OR credit.
//   TPV al contado    D 570 | 5721 / H 705.x / H 477.tipo (buildCashSaleJournalLines).

import { createHash } from "node:crypto";
import { Prisma as PrismaRuntime } from "@prisma/client";
import type { TaxBreakdownGroup } from "@hotelos/compliance";
import type { InvoiceSnapshotLine, InvoiceSnapshotTaxGroup, InvoiceSnapshotV1 } from "../../../../../packages/shared/src/payments-types.js";
import type { LedgerLineInput } from "./ledger.port.js";

const D = PrismaRuntime.Decimal;
type Dec = InstanceType<typeof PrismaRuntime.Decimal>;

/** Customer receivable sub-account of the canonical rules (430 → 4300 «Clientes (euros)»). */
export const CUSTOMER_ACCOUNT_CODE = "4300";
/** Generic services revenue when a legacy line carries no fiscal category. */
export const GENERIC_REVENUE_ACCOUNT_CODE = "705";
export const TOURIST_TAX_ACCOUNT_CODE = "4759";

/**
 * PGC revenue account of an invoice line by its fiscal category (Tanda 3
 * catalogue): accommodation → 705.1, food_beverage → 705.2, everything else
 * → 705.3 (otros servicios), tourist tax → 4759 (recaudada pendiente de
 * ingreso, a liability, canonical rule «[/ H 4759 tasa turística]»). Lines
 * created before the category existed post to the generic 705. Pure.
 */
export function revenueAccountForLine(line: { taxCategory?: string | null; description?: string | null }): string {
  switch (line.taxCategory) {
    case "accommodation":
      return "705.1";
    case "food_beverage":
      return "705.2";
    case "tourist_tax":
      return TOURIST_TAX_ACCOUNT_CODE;
    case "general_services":
    case "transport":
    case "not_subject":
      return "705.3";
    default:
      return GENERIC_REVENUE_ACCOUNT_CODE;
  }
}

/** "21" · "10" · "4" · "7" · "3" · "2" · "0" (Modelo 303 rate code). Pure. */
export function taxRateCodeFor(ratePercent: number): string {
  if (!Number.isFinite(ratePercent) || ratePercent <= 0) return "0";
  return Number.isInteger(ratePercent) ? String(ratePercent) : String(ratePercent);
}

/**
 * Output-VAT sub-account of a breakdown group: 477.21 / 477.10 / 477.04
 * (IGIC 477.07 / 477.03, IPSI 477.02…). Null for N1 / 0 % (no quota line).
 * Non-integer rates (IPSI 0,5 %) fall back to the 3-digit 477. Pure.
 */
export function vatAccountForGroup(group: { calificacion: string; ratePercent: number }): string | null {
  if (group.calificacion === "N1" || group.ratePercent <= 0) return null;
  if (!Number.isInteger(group.ratePercent)) return "477";
  return `477.${String(group.ratePercent).padStart(2, "0")}`;
}

function money(value: Dec): number {
  return Number(value.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2));
}

function baseOf(total: Dec, ratePercent: number, calificacion: string): Dec {
  if (calificacion === "N1" || ratePercent <= 0) return total.toDecimalPlaces(2, D.ROUND_HALF_UP);
  return total.div(new D(1).plus(new D(ratePercent).div(100))).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

export type SnapshotLineInput = {
  folioLineId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  taxCode: string;
  taxRate: number;
  taxCategory?: string | null;
  taxCalificacion?: string | null;
  taxFigure?: string | null;
};

/**
 * Freeze an invoice: lines with their informational base / quota and revenue
 * account, the header totals and the group breakdown (the canonical desglose:
 * computeInvoiceTotals rounds per group, never per line). Pure.
 */
export function buildInvoiceSnapshot(input: {
  issuedAt: Date;
  currencyCode: string;
  lines: SnapshotLineInput[];
  totals: { total: number; taxTotal: number };
  breakdown: TaxBreakdownGroup[];
  folioLineIds?: string[];
  issuer: { taxId: string; legalName: string };
  customer: { type: string; taxId: string | null; name: string | null };
}): InvoiceSnapshotV1 {
  const lines: InvoiceSnapshotLine[] = input.lines.map((line) => {
    const total = new D(line.total);
    const calificacion = line.taxCalificacion ?? "S1";
    const base = baseOf(total, line.taxRate, calificacion);
    return {
      folioLineId: line.folioLineId ?? null,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: money(total),
      taxCode: line.taxCode,
      taxRate: line.taxRate,
      taxCategory: line.taxCategory ?? null,
      taxCalificacion: line.taxCalificacion ?? null,
      taxFigure: line.taxFigure ?? null,
      base: money(base),
      quota: money(total.minus(base)),
      revenueAccountCode: revenueAccountForLine(line)
    };
  });
  const taxBreakdown: InvoiceSnapshotTaxGroup[] = input.breakdown.map((group) => ({
    figure: group.figure,
    impuesto: group.impuesto,
    calificacion: group.calificacion,
    ratePercent: group.ratePercent,
    base: group.base,
    quota: group.quota
  }));
  const baseTotal = money(new D(input.totals.total).minus(new D(input.totals.taxTotal)));
  return {
    version: 1,
    status: "issued",
    issuedAt: input.issuedAt.toISOString(),
    currencyCode: input.currencyCode,
    lines,
    totals: { total: money(new D(input.totals.total)), taxTotal: money(new D(input.totals.taxTotal)), baseTotal },
    taxBreakdown,
    folioLineIds: input.folioLineIds ?? lines.map((line) => line.folioLineId).filter((id): id is string => !!id),
    issuer: input.issuer,
    customer: input.customer
  };
}

/** Invoice.snapshotJson → InvoiceSnapshotV1, or null when the row has no issued snapshot. Never throws. */
export function parseInvoiceSnapshot(value: unknown): InvoiceSnapshotV1 | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<InvoiceSnapshotV1>;
  if (v.version !== 1 || v.status !== "issued" || !Array.isArray(v.lines) || !v.totals || !Array.isArray(v.taxBreakdown)) return null;
  return v as InvoiceSnapshotV1;
}

/** Group key of a line as computeInvoiceTotals builds it (impuesto, calificación, rate). */
function groupKeyOf(group: { impuesto: string; calificacion: string; ratePercent: number }): string {
  return `${group.impuesto}::${group.calificacion}::${group.ratePercent}`;
}

const IMPUESTO_BY_FIGURE: Record<string, string> = { IVA: "01", IPSI: "02", IGIC: "03" };

function lineGroupKey(line: InvoiceSnapshotLine): string {
  const calificacion = line.taxCalificacion ?? "S1";
  const rate = calificacion === "N1" ? 0 : line.taxRate;
  const impuesto = IMPUESTO_BY_FIGURE[line.taxFigure ?? "IVA"] ?? "01";
  return `${impuesto}::${calificacion}::${rate}`;
}

type SignedLine = { accountCode: string; amount: Dec; side: "debit" | "credit"; description: string; taxRateCode?: string | null; taxBase?: string | null };

/** A signed amount on its intended side; negative amounts flip the side so lines stay positive. */
function ledgerLine(line: SignedLine): LedgerLineInput | null {
  const amount = line.amount.toDecimalPlaces(2, D.ROUND_HALF_UP);
  if (amount.isZero()) return null;
  const side: "debit" | "credit" = amount.isNegative() ? (line.side === "debit" ? "credit" : "debit") : line.side;
  const abs = amount.abs().toFixed(2);
  return {
    accountCode: line.accountCode,
    debit: side === "debit" ? abs : "0.00",
    credit: side === "credit" ? abs : "0.00",
    description: line.description,
    taxRateCode: line.taxRateCode ?? null,
    taxBase: line.taxBase ?? null
  };
}

/**
 * Revenue base per PGC account inside one breakdown group, squared to the
 * group base: each account's share is rounded to the cent and the residual
 * cent (if any) goes to the account with the largest gross. Pure.
 */
export function splitGroupBaseByAccount(group: { base: number; ratePercent: number; calificacion: string }, lines: ReadonlyArray<Pick<InvoiceSnapshotLine, "total" | "revenueAccountCode">>): Map<string, Dec> {
  const grossByAccount = new Map<string, Dec>();
  for (const line of lines) {
    grossByAccount.set(line.revenueAccountCode, (grossByAccount.get(line.revenueAccountCode) ?? new D(0)).plus(new D(line.total)));
  }
  const baseByAccount = new Map<string, Dec>();
  let assigned = new D(0);
  let largest: { code: string; gross: Dec } | null = null;
  for (const [code, gross] of grossByAccount) {
    const base = baseOf(gross, group.ratePercent, group.calificacion);
    baseByAccount.set(code, base);
    assigned = assigned.plus(base);
    if (!largest || gross.abs().greaterThan(largest.gross.abs())) largest = { code, gross };
  }
  const residual = new D(group.base).minus(assigned);
  if (!residual.isZero() && largest) baseByAccount.set(largest.code, baseByAccount.get(largest.code)!.plus(residual));
  return baseByAccount;
}

/**
 * Journal lines of an issued invoice or rectificativa (canonical rule
 * «Factura emitida»): D 4300 total / H 705.x base per department / H 477.tipo
 * quota (with taxRateCode + taxBase) / H 4759 tourist tax. Balanced by
 * construction: total = Σ group gross = Σ (base + quota). Pure.
 */
export function buildInvoiceJournalLines(snapshot: Pick<InvoiceSnapshotV1, "lines" | "taxBreakdown" | "totals">, label: string): LedgerLineInput[] {
  const out: LedgerLineInput[] = [];
  const receivable = ledgerLine({ accountCode: CUSTOMER_ACCOUNT_CODE, amount: new D(snapshot.totals.total), side: "debit", description: `Clientes · ${label}` });
  if (receivable) out.push(receivable);
  const linesByGroup = new Map<string, InvoiceSnapshotLine[]>();
  for (const line of snapshot.lines) {
    const key = lineGroupKey(line);
    const list = linesByGroup.get(key) ?? [];
    list.push(line);
    linesByGroup.set(key, list);
  }
  for (const group of snapshot.taxBreakdown) {
    const lines = linesByGroup.get(groupKeyOf(group)) ?? [];
    const rateCode = taxRateCodeFor(group.ratePercent);
    const split = lines.length > 0 ? splitGroupBaseByAccount(group, lines) : new Map([[GENERIC_REVENUE_ACCOUNT_CODE, new D(group.base)]]);
    for (const [accountCode, base] of split) {
      const revenue = ledgerLine({
        accountCode,
        amount: base,
        side: "credit",
        description: `${accountCode === TOURIST_TAX_ACCOUNT_CODE ? "Tasa turística" : "Ingresos"} ${group.ratePercent > 0 ? `${group.ratePercent} %` : group.calificacion === "N1" ? "no sujeto" : "0 %"} · ${label}`,
        taxRateCode: rateCode
      });
      if (revenue) out.push(revenue);
    }
    const vatAccount = vatAccountForGroup(group);
    if (vatAccount) {
      const quota = ledgerLine({
        accountCode: vatAccount,
        amount: new D(group.quota),
        side: "credit",
        description: `${group.figure} repercutido ${group.ratePercent} % · ${label}`,
        taxRateCode: rateCode,
        taxBase: new D(group.base).toFixed(2)
      });
      if (quota) out.push(quota);
    }
  }
  return out;
}

/**
 * Journal lines of a cash sale with simplified invoice (TPV al contado):
 * D 570 | 5721 (total) / H 705.x / H 477.tipo — the receivable is settled in
 * the act, so 4300 never appears. Pure.
 */
export function buildCashSaleJournalLines(snapshot: Pick<InvoiceSnapshotV1, "lines" | "taxBreakdown" | "totals">, paidWithAccountCode: string, label: string): LedgerLineInput[] {
  const lines = buildInvoiceJournalLines(snapshot, label);
  return lines.map((line) => (line.accountCode === CUSTOMER_ACCOUNT_CODE ? { ...line, accountCode: paidWithAccountCode, description: `Cobro al contado · ${label}` } : line));
}

export type VatBookRowInput = {
  rate: number;
  base: number;
  quota: number;
  total: number;
  taxFigure: string;
};

/**
 * Rows of the libro de facturas emitidas for a snapshot: one per rate
 * (VatBookEntry is unique per rate, so N1 and an exempt S1 0 % merge into one
 * 0 % row). Signs follow the document (negative on a credit rectificativa). Pure.
 */
export function buildVatBookRows(breakdown: ReadonlyArray<Pick<InvoiceSnapshotTaxGroup, "figure" | "ratePercent" | "base" | "quota">>): VatBookRowInput[] {
  const byRate = new Map<string, { rate: number; base: Dec; quota: Dec; taxFigure: string }>();
  for (const group of breakdown) {
    const key = `${group.figure}::${group.ratePercent}`;
    const acc = byRate.get(key) ?? { rate: group.ratePercent, base: new D(0), quota: new D(0), taxFigure: group.figure };
    acc.base = acc.base.plus(new D(group.base));
    acc.quota = acc.quota.plus(new D(group.quota));
    byRate.set(key, acc);
  }
  return Array.from(byRate.values())
    .sort((a, b) => b.rate - a.rate)
    .map((row) => ({ rate: row.rate, base: money(row.base), quota: money(row.quota), total: money(row.base.plus(row.quota)), taxFigure: row.taxFigure }));
}

/**
 * Fingerprint of the folio lines an invoice draft was built from. Issuance
 * recomputes it over the live folio: any added / removed / edited / deleted
 * line changes it and the draft must be regenerated (409). Pure.
 */
export function folioLinesFingerprint(lines: ReadonlyArray<{ id: string; description: string; quantity: number | string; unitPrice: number | string; total: number | string; taxCategory?: string | null; type?: string }>): string {
  const canonical = [...lines]
    .map((line) => ({
      id: line.id,
      type: line.type ?? "",
      description: line.description,
      quantity: new D(line.quantity).toFixed(2),
      unitPrice: new D(line.unitPrice).toFixed(2),
      total: new D(line.total).toFixed(2),
      taxCategory: line.taxCategory ?? null
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Folio line types that mirror a fiscal document (credit / debit of a rectificativa) and are never invoiced. */
export const FISCAL_REFLECTION_LINE_TYPES: readonly string[] = Object.freeze(["invoice_adjustment"]);

/**
 * Art. 4 RD 1619/2012: a simplified invoice (F2) may omit the customer up to
 * 400 € (VAT included); restaurant / bar sales (art. 4.2.e) up to 3.000 €.
 * Accommodation is not in the art. 4.2 list, so a hotel folio keeps 400 €. Pure.
 */
export function simplifiedInvoiceLimit(lines: ReadonlyArray<{ taxCategory?: string | null }>): number {
  return lines.length > 0 && lines.every((line) => line.taxCategory === "food_beverage") ? 3000 : 400;
}

/** Whether the recipient must be identified on the document. Pure. */
export function customerRequiredFor(input: { invoiceType: string; total: number; lines: ReadonlyArray<{ taxCategory?: string | null }> }): { required: boolean; limit: number | null } {
  if (input.invoiceType !== "F2") return { required: true, limit: null };
  const limit = simplifiedInvoiceLimit(input.lines);
  return { required: Math.abs(input.total) > limit, limit };
}
