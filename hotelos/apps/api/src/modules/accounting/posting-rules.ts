// Canonical posting rules (PGC de Pymes · hotel sub-accounts) — PURE.
//
// Every rule takes TYPED document data (never a domain-event payload, never a
// regex over a description) and returns the lines of ONE asiento ready for
// accounting.service.postJournalEntry: positive amounts on debit or credit,
// Decimal to the cent, balanced by construction and re-checked. The rules are
// the literal transcription of docs/runbooks/finanzas-contabilidad.md §2:
//
//   Factura emitida      D 4300 total / H 705.x base por departamento / H 477.tipo cuota [/ H 4759 tasa]
//   Rectificativa        mismo asiento con importes signados → sentido contrario, nunca líneas negativas
//   Anulación            inverso total (accounting.service.reverseJournalEntry)
//   Cobro                D 570|5721|572|5722 / H 4300; devolución: inverso
//   TPV al contado       D 570|5721 / H 705.2 (F&B) | 705.3 / H 477.tipo — key pos_ticket/<ticket>, one
//                        asiento whichever writer (TPV sync port, InvoiceIssued projection, replay) posts it
//   Factura recibida     D 6xx por línea / D 472.tipo / H 400|410 [/ H 4751 retención]; pago D 400 / H 572
//   Gasto (ticket)       D 6xx / D 472.tipo (si deducible) / H 570|5721|572
//   Nómina               D 640 / D 642 / H 476 / H 4751 / H 465; pago D 465 / H 572
//   Comisión de canal    D 629.1 / H 410; liquidación D 410 / H 572
//   Amortización         D 681|680 / H 28xx por elemento
//   Liquidación de IVA   D 477.x / H 472.x / H 4750 (a ingresar) | D 4700 (a compensar)
//   Liquidación datáfono D 572 neto / D 626 comisión / H 5721 bruto
//   Arqueo               faltante D 659 / H 570 · sobrante D 570 / H 759
//   Regularización       6xx → 129 ← 7xx; cierre / apertura
//
// The materialisation of documents (loading invoices, payments, tickets from
// Prisma and choosing dates in the property time zone) lives in projection.ts.

import { Prisma } from "@prisma/client";
import { ZERO, ledgerBadRequest, money, type Decimal, type JournalLineInput, type MoneyLike } from "./accounting.service.js";
import { CUSTOMER_ACCOUNT_CODE } from "../../../../../packages/shared/src/accounting-types.js";

const D = Prisma.Decimal;

export type RuleLine = JournalLineInput & { debit: string; credit: string };

export type RuleEntry = {
  sourceType: string;
  sourceId: string;
  entryDate: string;
  description: string;
  reference: string | null;
  entryKind?: "normal" | "regularization" | "closing" | "opening" | "reversal";
  lines: RuleLine[];
  /** Non-blocking notes (e.g. a line without tax category posted to the generic 705). */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Account maps
// ---------------------------------------------------------------------------

/**
 * Customer receivable: the shared `4300` «Clientes (euros)» of
 * packages/shared/src/accounting-types.ts (fix:ledger 2026-09-16, t6#4). The
 * invoicing / payments / folio writers import the same value, so issuance,
 * capture, refund, cancellation, projection and replay all hit ONE account.
 */
export const CUSTOMER_ACCOUNT: string = CUSTOMER_ACCOUNT_CODE;
export const SUPPLIER_ACCOUNT = "400";
export const CREDITOR_ACCOUNT = "410";
export const TOURIST_TAX_ACCOUNT = "4759";
export const WITHHOLDING_ACCOUNT = "4751";
export const VAT_PAYABLE_ACCOUNT = "4750";
export const VAT_RECEIVABLE_ACCOUNT = "4700";
export const SOCIAL_SECURITY_ACCOUNT = "476";
export const WAGES_PAYABLE_ACCOUNT = "465";
export const RESULT_ACCOUNT = "129";
export const CASH_ACCOUNT = "570";
export const BANK_ACCOUNT = "572";
export const CARD_TERMINAL_ACCOUNT = "5721";
export const PAYMENT_GATEWAY_ACCOUNT = "5722";
export const BANK_FEES_ACCOUNT = "626";
export const CHANNEL_COMMISSION_ACCOUNT = "629.1";
export const CASH_SHORTAGE_ACCOUNT = "659";
export const CASH_SURPLUS_ACCOUNT = "759";
export const SALARIES_ACCOUNT = "640";
export const EMPLOYER_SS_ACCOUNT = "642";
export const DEPRECIATION_TANGIBLE_ACCOUNT = "681";
export const DEPRECIATION_INTANGIBLE_ACCOUNT = "680";

/** Revenue sub-account per fiscal category of the line (tourist tax is a liability, not revenue). */
export const REVENUE_ACCOUNT_BY_CATEGORY: Record<string, string> = {
  accommodation: "705.1",
  food_beverage: "705.2",
  general_services: "705.3",
  transport: "705.3",
  not_subject: "705.3",
  events: "705.4",
  tourist_tax: TOURIST_TAX_ACCOUNT
};
/** Fallback when a line carries no category: the generic PGC account, reported as a warning. */
export const REVENUE_ACCOUNT_FALLBACK = "705";

/** Treasury account per canonical payment method (Payment.methodCode). */
export const PAYMENT_METHOD_ACCOUNT: Record<string, string> = {
  cash: CASH_ACCOUNT,
  card_terminal: CARD_TERMINAL_ACCOUNT,
  card_online: PAYMENT_GATEWAY_ACCOUNT,
  bank_transfer: BANK_ACCOUNT,
  payment_link: PAYMENT_GATEWAY_ACCOUNT,
  other: BANK_ACCOUNT
};

/** Legacy `Payment.method` free text (cash · card · bank_transfer · payment_link · ota_virtual_card). */
export const LEGACY_PAYMENT_METHOD_ACCOUNT: Record<string, string> = {
  cash: CASH_ACCOUNT,
  card: CARD_TERMINAL_ACCOUNT,
  card_terminal: CARD_TERMINAL_ACCOUNT,
  card_online: PAYMENT_GATEWAY_ACCOUNT,
  bank_transfer: BANK_ACCOUNT,
  transfer: BANK_ACCOUNT,
  payment_link: PAYMENT_GATEWAY_ACCOUNT,
  ota_virtual_card: CARD_TERMINAL_ACCOUNT
};

export const EXPENSE_PAID_WITH_ACCOUNT: Record<string, string> = {
  cash: CASH_ACCOUNT,
  card: CARD_TERMINAL_ACCOUNT,
  bank: BANK_ACCOUNT
};

/** 477.21 / 477.10 / 477.04 / 477.07 / 477.03 / 477.02 (IGIC / IPSI share the rate-coded sub-accounts). */
export function vatOutputAccount(ratePercent: number): string {
  return `477.${String(Math.round(ratePercent)).padStart(2, "0")}`;
}

export function vatInputAccount(ratePercent: number): string {
  return `472.${String(Math.round(ratePercent)).padStart(2, "0")}`;
}

export function rateCode(ratePercent: number): string {
  return String(Math.round(ratePercent));
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

type Side = "debit" | "credit";

/** Positive amount on `side`; a negative amount lands on the opposite side (never a negative line). */
export function signedLine(accountCode: string, side: Side, amount: Decimal, extra: Partial<Omit<RuleLine, "accountCode" | "debit" | "credit">> = {}): RuleLine | null {
  if (amount.isZero()) return null;
  const abs = amount.abs().toFixed(2);
  const effective: Side = amount.isNegative() ? (side === "debit" ? "credit" : "debit") : side;
  return {
    accountCode,
    debit: effective === "debit" ? abs : "0.00",
    credit: effective === "credit" ? abs : "0.00",
    description: extra.description ?? null,
    taxRateCode: extra.taxRateCode ?? null,
    taxBase: extra.taxBase ?? null,
    costCenterId: extra.costCenterId ?? null
  };
}

function pushLine(lines: RuleLine[], line: RuleLine | null): void {
  if (line) lines.push(line);
}

/** Σ debit == Σ credit to the cent, else throws (defensive: every rule balances by construction). */
export function assertBalanced(lines: readonly RuleLine[]): void {
  let debit: Decimal = ZERO;
  let credit: Decimal = ZERO;
  for (const line of lines) {
    debit = debit.plus(line.debit);
    credit = credit.plus(line.credit);
  }
  if (!debit.equals(credit)) {
    throw ledgerBadRequest("JOURNAL_UNBALANCED", `Regla contable descuadrada: debe ${debit.toFixed(2)} ≠ haber ${credit.toFixed(2)}.`, { totalDebit: debit.toFixed(2), totalCredit: credit.toFixed(2) });
  }
}

/** Gross → base at HALF_UP: base = round(gross / (1 + t)); quota = gross − base. Same arithmetic as the invoice breakdown. */
export function splitGross(gross: Decimal, ratePercent: number): { base: Decimal; quota: Decimal } {
  if (ratePercent <= 0) return { base: gross, quota: ZERO };
  const base = gross.div(new D(1).plus(new D(ratePercent).div(100))).toDecimalPlaces(2, D.ROUND_HALF_UP);
  return { base, quota: gross.minus(base) };
}

// ---------------------------------------------------------------------------
// Invoices (issued · rectificativa por diferencias · simplificada) and their inverse
// ---------------------------------------------------------------------------

export type TaxDocumentLine = {
  description?: string | null;
  /** Gross amount (tax included), signed on rectificativas. */
  total: MoneyLike;
  ratePercent: number;
  /** S1 sujeta · N1 no sujeta (rate 0, no quota). */
  calificacion?: "S1" | "N1" | null;
  figure?: "IVA" | "IGIC" | "IPSI" | null;
  /** accommodation · food_beverage · general_services · transport · tourist_tax · not_subject · events. */
  category?: string | null;
  /** Explicit override of the revenue account (e.g. 700 for shop sales). */
  revenueAccountCode?: string | null;
  costCenterId?: string | null;
};

export type TaxBreakdownInput = {
  figure?: string | null;
  calificacion?: string | null;
  ratePercent: number;
  base: MoneyLike;
  quota: MoneyLike;
};

/**
 * A sale settled in the act (TPV al contado with factura simplificada): the
 * receivable never exists, the treasury account takes the total and the
 * asiento is keyed `pos_ticket/<posOrderId ?? invoiceId>` — the SAME key the
 * TPV writes synchronously (simplified-invoice.service), so the asynchronous
 * InvoiceIssued projection and the replay find that entry instead of posting
 * a second one against 4300 (hallazgo t6#1).
 */
export type CashSettlement = {
  paidWith: "cash" | "card_terminal";
  posOrderId: string | null;
};

export type InvoiceDocumentInput = {
  organizationId: string;
  propertyId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  /** Fecha de expedición in the property time zone. */
  entryDate: string;
  customerName?: string | null;
  customerTaxId?: string | null;
  lines: TaxDocumentLine[];
  /** Persisted VeriFactu breakdown (authoritative base/quota per group) when the invoice was issued with one. */
  breakdown?: TaxBreakdownInput[] | null;
  total: MoneyLike;
  taxTotal: MoneyLike;
  kind: "issued" | "rectification" | "simplified";
  rectifyingForId?: string | null;
  rectifyingForNumber?: string | null;
  customerAccountCode?: string | null;
  /** Set on a simplified invoice paid in the act: D 570|5721 instead of D 4300, key pos_ticket. */
  settledInAct?: CashSettlement | null;
};

/** Treasury account of a sale settled in the act (cash → 570, datáfono → 5721). */
export function cashSaleTreasuryAccount(paidWith: CashSettlement["paidWith"]): string {
  return paidWith === "cash" ? CASH_ACCOUNT : CARD_TERMINAL_ACCOUNT;
}

/** Idempotency key of the asiento of a sale settled in the act: the ticket id when the sale came from the TPV, else the invoice id. */
export function cashSaleSourceId(doc: Pick<InvoiceDocumentInput, "invoiceId" | "settledInAct">): string {
  return doc.settledInAct?.posOrderId ?? doc.invoiceId;
}

/**
 * Source keys under which the issuance asiento of a document can live: the
 * cash-sale key(s) when settled in the act, else invoice / rectification.
 * Used by the projection and the replay to find an existing entry whatever
 * writer produced it (sync TPV port, projection, replay).
 */
export function issuanceSourceKeys(doc: Pick<InvoiceDocumentInput, "invoiceId" | "kind" | "settledInAct">): Array<{ sourceType: string; sourceId: string }> {
  if (doc.settledInAct) {
    const keys = [{ sourceType: "pos_ticket", sourceId: cashSaleSourceId(doc) }];
    if (doc.settledInAct.posOrderId) keys.push({ sourceType: "pos_ticket", sourceId: doc.invoiceId });
    return keys;
  }
  return doc.kind === "rectification"
    ? [{ sourceType: "invoice_rectification", sourceId: doc.invoiceId }, { sourceType: "invoice", sourceId: doc.invoiceId }]
    : [{ sourceType: "invoice", sourceId: doc.invoiceId }, { sourceType: "invoice_rectification", sourceId: doc.invoiceId }];
}

type Group = { key: string; figure: string; calificacion: "S1" | "N1"; ratePercent: number; gross: Decimal; lineIndexes: number[] };

function groupKeyOf(figure: string, calificacion: string, ratePercent: number): string {
  return `${figure}|${calificacion}|${ratePercent}`;
}

/**
 * Lines of the invoice asiento. Bases and quotas are computed per tax group
 * exactly like the invoice breakdown (HALF_UP per group, not per line); the
 * group base is then split by department account (per-line base, cent
 * difference on the largest line) so Σ department bases == group base and
 * Σ bases + Σ quotas == invoice total to the cent (else INVOICE_TOTALS_MISMATCH).
 */
export function buildInvoiceEntry(doc: InvoiceDocumentInput): RuleEntry {
  const warnings: string[] = [];
  const total = money(doc.total, "total de la factura");
  const taxTotal = money(doc.taxTotal, "cuota de la factura");
  const settled = doc.settledInAct ?? null;
  if (settled && doc.kind !== "simplified") {
    throw ledgerBadRequest("INVOICE_CASH_SALE_NOT_SIMPLIFIED", `La factura ${doc.invoiceNumber ?? doc.invoiceId} figura cobrada en el acto pero no es simplificada: una venta al contado exige factura simplificada (serie SIM).`, { invoiceId: doc.invoiceId });
  }
  // Settled in the act: the treasury account takes the receivable's place (canonical rule «TPV al contado»).
  const customerAccount = settled ? cashSaleTreasuryAccount(settled.paidWith) : doc.customerAccountCode ?? CUSTOMER_ACCOUNT;
  const number = doc.invoiceNumber ?? doc.invoiceId;

  const groups = new Map<string, Group>();
  doc.lines.forEach((line, index) => {
    const figure = line.figure ?? "IVA";
    const calificacion: "S1" | "N1" = line.calificacion === "N1" ? "N1" : "S1";
    const ratePercent = calificacion === "N1" ? 0 : line.ratePercent;
    if (!Number.isFinite(ratePercent) || ratePercent < 0) throw ledgerBadRequest("INVOICE_LINE_RATE_INVALID", `La línea ${index + 1} de la factura ${number} tiene un tipo impositivo inválido.`);
    if (calificacion === "S1" && ratePercent === 0) warnings.push(`Línea ${index + 1} («${line.description ?? ""}») sin tipo impositivo configurado: contabilizada al 0 %.`);
    const key = groupKeyOf(figure, calificacion, ratePercent);
    const group = groups.get(key) ?? { key, figure, calificacion, ratePercent, gross: ZERO, lineIndexes: [] };
    group.gross = group.gross.plus(money(line.total, `línea ${index + 1}`));
    group.lineIndexes.push(index);
    groups.set(key, group);
  });

  const breakdownByKey = new Map<string, { base: Decimal; quota: Decimal }>();
  for (const group of doc.breakdown ?? []) {
    const calificacion = group.calificacion === "N1" ? "N1" : "S1";
    breakdownByKey.set(groupKeyOf(group.figure ?? "IVA", calificacion, calificacion === "N1" ? 0 : group.ratePercent), { base: money(group.base), quota: money(group.quota) });
  }

  const lines: RuleLine[] = [];
  const revenueByAccount = new Map<string, { amount: Decimal; rate: string; description: string; costCenterId: string | null }>();
  let sumBases: Decimal = ZERO;
  let sumQuotas: Decimal = ZERO;

  for (const group of groups.values()) {
    const persisted = breakdownByKey.get(group.key);
    const split = persisted ?? splitGross(group.gross, group.ratePercent);
    if (persisted && !persisted.base.plus(persisted.quota).equals(group.gross)) {
      throw ledgerBadRequest("INVOICE_TOTALS_MISMATCH", `El desglose persistido de la factura ${number} (${group.figure} ${group.ratePercent} %) no coincide con sus líneas.`, {
        invoiceId: doc.invoiceId,
        gross: group.gross.toFixed(2),
        base: persisted.base.toFixed(2),
        quota: persisted.quota.toFixed(2)
      });
    }
    // Per-line base, cent difference on the largest line of the group.
    const perLine = group.lineIndexes.map((index) => {
      const line = doc.lines[index]!;
      const lineGross = money(line.total);
      return { index, line, gross: lineGross, base: splitGross(lineGross, group.ratePercent).base };
    });
    const diff = split.base.minus(perLine.reduce((acc, item) => acc.plus(item.base), ZERO));
    if (!diff.isZero()) {
      const largest = perLine.reduce((best, item) => (item.gross.abs().greaterThan(best.gross.abs()) ? item : best), perLine[0]!);
      largest.base = largest.base.plus(diff);
    }
    for (const item of perLine) {
      const category = item.line.category ?? null;
      let account = item.line.revenueAccountCode ?? (category ? REVENUE_ACCOUNT_BY_CATEGORY[category] : undefined);
      if (!account) {
        account = REVENUE_ACCOUNT_FALLBACK;
        warnings.push(`Línea ${item.index + 1} («${item.line.description ?? ""}») sin categoría fiscal: contabilizada en ${REVENUE_ACCOUNT_FALLBACK}.`);
      }
      const bucketKey = `${account}|${group.ratePercent}|${item.line.costCenterId ?? ""}`;
      const bucket = revenueByAccount.get(bucketKey) ?? {
        amount: ZERO,
        rate: rateCode(group.ratePercent),
        description: account === TOURIST_TAX_ACCOUNT ? `Tasa turística repercutida (${number})` : `${item.line.description ?? "Prestación de servicios"} · ${group.calificacion === "N1" ? "no sujeta" : `${group.figure} ${group.ratePercent} %`}`,
        costCenterId: item.line.costCenterId ?? null
      };
      bucket.amount = bucket.amount.plus(item.base);
      revenueByAccount.set(bucketKey, bucket);
    }
    sumBases = sumBases.plus(split.base);
    if (!split.quota.isZero()) {
      sumQuotas = sumQuotas.plus(split.quota);
      pushLine(lines, signedLine(vatOutputAccount(group.ratePercent), "credit", split.quota, {
        description: `${group.figure} repercutido ${group.ratePercent} % (${number})`,
        taxRateCode: rateCode(group.ratePercent),
        taxBase: split.base.toFixed(2)
      }));
    }
  }

  if (!sumBases.plus(sumQuotas).equals(total) || !sumQuotas.equals(taxTotal)) {
    throw ledgerBadRequest("INVOICE_TOTALS_MISMATCH", `La factura ${number} no cuadra: líneas ${sumBases.plus(sumQuotas).toFixed(2)} (cuota ${sumQuotas.toFixed(2)}) frente a total ${total.toFixed(2)} (cuota ${taxTotal.toFixed(2)}).`, {
      invoiceId: doc.invoiceId,
      linesTotal: sumBases.plus(sumQuotas).toFixed(2),
      linesTax: sumQuotas.toFixed(2),
      total: total.toFixed(2),
      taxTotal: taxTotal.toFixed(2)
    });
  }

  for (const [key, bucket] of revenueByAccount) {
    const account = key.split("|")[0]!;
    pushLine(lines, signedLine(account, "credit", bucket.amount, { description: bucket.description, taxRateCode: bucket.rate, costCenterId: bucket.costCenterId }));
  }
  const customerLabel = doc.customerName ? ` · ${doc.customerName}` : "";
  const kindLabel = settled ? "Venta al contado" : doc.kind === "rectification" ? "Factura rectificativa" : doc.kind === "simplified" ? "Factura simplificada" : "Factura";
  const settledLabel = settled ? ` (${settled.paidWith === "cash" ? "efectivo" : "datáfono"})` : "";
  pushLine(lines, signedLine(customerAccount, "debit", total, { description: settled ? `Cobro al contado · ${number}${settledLabel}` : `${kindLabel} ${number}${customerLabel}` }));
  // Debits first for the classic layout.
  lines.sort((a, b) => (a.debit === "0.00" ? 1 : 0) - (b.debit === "0.00" ? 1 : 0));
  assertBalanced(lines);

  const rectified = doc.kind === "rectification" && (doc.rectifyingForNumber || doc.rectifyingForId) ? ` (rectifica ${doc.rectifyingForNumber ?? doc.rectifyingForId})` : "";
  return {
    sourceType: settled ? "pos_ticket" : doc.kind === "rectification" ? "invoice_rectification" : "invoice",
    sourceId: settled ? cashSaleSourceId(doc) : doc.invoiceId,
    entryDate: doc.entryDate,
    description: `${kindLabel} ${number}${settledLabel}${customerLabel}${rectified}`,
    reference: doc.invoiceNumber ?? null,
    lines,
    warnings
  };
}

/** Inverse of buildInvoiceEntry (sides swapped) for an invoice whose issuance entry was never posted. */
export function buildInvoiceReversalEntry(doc: InvoiceDocumentInput, options: { sourceType: string; sourceId: string; entryDate: string; reason: string }): RuleEntry {
  const issued = buildInvoiceEntry(doc);
  const lines = issued.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit, description: line.description ? `Anulación: ${line.description}` : null }));
  assertBalanced(lines);
  return {
    sourceType: options.sourceType,
    sourceId: options.sourceId,
    entryDate: options.entryDate,
    description: `Anulación de la factura ${doc.invoiceNumber ?? doc.invoiceId}: ${options.reason}`,
    reference: doc.invoiceNumber ?? null,
    entryKind: "reversal",
    lines,
    warnings: issued.warnings
  };
}

// ---------------------------------------------------------------------------
// Payments and refunds
// ---------------------------------------------------------------------------

export type PaymentInput = {
  organizationId: string;
  propertyId: string;
  paymentId: string;
  entryDate: string;
  amount: MoneyLike;
  methodCode?: string | null;
  /** Legacy Payment.method when methodCode is null. */
  method?: string | null;
  /** Invoice number / folio label shown in the concept. */
  reference?: string | null;
  customerAccountCode?: string | null;
  description?: string | null;
};

export function treasuryAccountFor(methodCode: string | null | undefined, method: string | null | undefined): { accountCode: string; warning: string | null } {
  if (methodCode && PAYMENT_METHOD_ACCOUNT[methodCode]) return { accountCode: PAYMENT_METHOD_ACCOUNT[methodCode]!, warning: null };
  const legacy = method ? LEGACY_PAYMENT_METHOD_ACCOUNT[method.toLowerCase()] : undefined;
  if (legacy) return { accountCode: legacy, warning: null };
  return { accountCode: BANK_ACCOUNT, warning: `Método de cobro desconocido «${methodCode ?? method ?? ""}»: contabilizado en ${BANK_ACCOUNT}.` };
}

export function buildPaymentEntry(input: PaymentInput): RuleEntry {
  const amount = money(input.amount, "importe del cobro");
  if (amount.isZero()) throw ledgerBadRequest("PAYMENT_AMOUNT_ZERO", "Un cobro de 0 € no genera asiento.");
  const treasury = treasuryAccountFor(input.methodCode, input.method);
  const method = input.methodCode ?? input.method ?? "other";
  const ref = input.reference ? ` ${input.reference}` : "";
  const description = input.description ?? `Cobro ${method}${ref}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(treasury.accountCode, "debit", amount, { description }));
  pushLine(lines, signedLine(input.customerAccountCode ?? CUSTOMER_ACCOUNT, "credit", amount, { description: `Cobro de cliente${ref}` }));
  assertBalanced(lines);
  return { sourceType: "payment", sourceId: input.paymentId, entryDate: input.entryDate, description, reference: input.reference ?? null, lines, warnings: treasury.warning ? [treasury.warning] : [] };
}

export type RefundInput = PaymentInput & { refundId: string };

export function buildRefundEntry(input: RefundInput): RuleEntry {
  const amount = money(input.amount, "importe de la devolución");
  if (amount.isZero()) throw ledgerBadRequest("REFUND_AMOUNT_ZERO", "Una devolución de 0 € no genera asiento.");
  const treasury = treasuryAccountFor(input.methodCode, input.method);
  const method = input.methodCode ?? input.method ?? "other";
  const ref = input.reference ? ` ${input.reference}` : "";
  const description = input.description ?? `Devolución ${method}${ref}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(input.customerAccountCode ?? CUSTOMER_ACCOUNT, "debit", amount, { description: `Devolución a cliente${ref}` }));
  pushLine(lines, signedLine(treasury.accountCode, "credit", amount, { description }));
  assertBalanced(lines);
  return { sourceType: "payment_refund", sourceId: input.refundId, entryDate: input.entryDate, description, reference: input.reference ?? null, lines, warnings: treasury.warning ? [treasury.warning] : [] };
}

// ---------------------------------------------------------------------------
// POS cash sale (factura simplificada)
// ---------------------------------------------------------------------------

export type PosSaleInput = {
  organizationId: string;
  propertyId: string;
  orderId: string;
  entryDate: string;
  total: MoneyLike;
  /** Persisted PosOrder.taxTotal; null → computed from ratePercent. */
  taxTotal?: MoneyLike | null;
  ratePercent: number;
  figure?: "IVA" | "IGIC" | "IPSI" | null;
  settlement: "cash" | "card";
  /** restaurant · bar · cafe · minibar · breakfast · room_service → 705.2; anything else → 705.3. */
  outletType?: string | null;
  description?: string | null;
  invoiceNumber?: string | null;
};

const FNB_OUTLETS = new Set(["restaurant", "bar", "cafe", "cafeteria", "roomservice", "room_service", "minibar", "breakfast"]);

export function posRevenueAccount(outletType: string | null | undefined): string {
  return FNB_OUTLETS.has((outletType ?? "").trim().toLowerCase()) ? "705.2" : "705.3";
}

export function buildPosSaleEntry(input: PosSaleInput): RuleEntry {
  const total = money(input.total, "total del ticket");
  if (total.isZero()) throw ledgerBadRequest("POS_TOTAL_ZERO", "Un ticket de 0 € no genera asiento.");
  const warnings: string[] = [];
  let base: Decimal;
  let quota: Decimal;
  if (input.taxTotal !== null && input.taxTotal !== undefined) {
    quota = money(input.taxTotal, "cuota del ticket");
    base = total.minus(quota);
  } else {
    ({ base, quota } = splitGross(total, input.ratePercent));
    warnings.push(`Ticket ${input.orderId}: cuota calculada al ${input.ratePercent} % (el ticket no la tenía guardada).`);
  }
  const treasury = input.settlement === "cash" ? CASH_ACCOUNT : CARD_TERMINAL_ACCOUNT;
  const revenue = posRevenueAccount(input.outletType);
  const number = input.invoiceNumber ?? input.orderId;
  const description = input.description ?? `Venta TPV ${number}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(treasury, "debit", total, { description: `${description} · ${input.settlement === "cash" ? "efectivo" : "tarjeta"}` }));
  pushLine(lines, signedLine(revenue, "credit", base, { description, taxRateCode: rateCode(input.ratePercent) }));
  pushLine(lines, signedLine(vatOutputAccount(input.ratePercent), "credit", quota, { description: `${input.figure ?? "IVA"} repercutido ${input.ratePercent} % (${number})`, taxRateCode: rateCode(input.ratePercent), taxBase: base.toFixed(2) }));
  assertBalanced(lines);
  return { sourceType: "pos_ticket", sourceId: input.orderId, entryDate: input.entryDate, description, reference: input.invoiceNumber ?? null, lines, warnings };
}

// ---------------------------------------------------------------------------
// Supplier bills and expenses
// ---------------------------------------------------------------------------

export type SupplierBillLineInput = {
  description?: string | null;
  expenseAccountCode: string;
  base: MoneyLike;
  taxRate: number;
  quota: MoneyLike;
  retention?: MoneyLike | null;
  costCenterId?: string | null;
};

export type SupplierBillInput = {
  organizationId: string;
  propertyId?: string | null;
  billId: string;
  entryDate: string;
  supplierName: string;
  supplierTaxId?: string | null;
  invoiceNumber?: string | null;
  lines: SupplierBillLineInput[];
  /** Amount payable = Σ base + Σ quota − Σ retention (checked). */
  total: MoneyLike;
  /** 400 Proveedores (default) or 410 Acreedores. */
  payableAccountCode?: string | null;
  /** false → the quota is not deductible and goes to the expense account. */
  vatDeductible?: boolean;
  figure?: "IVA" | "IGIC" | "IPSI" | null;
};

export function buildSupplierBillEntry(input: SupplierBillInput): RuleEntry {
  if (input.lines.length === 0) throw ledgerBadRequest("SUPPLIER_BILL_NO_LINES", "La factura recibida no tiene líneas.");
  const deductible = input.vatDeductible !== false;
  const number = input.invoiceNumber ?? input.billId;
  const label = `${input.supplierName}${input.invoiceNumber ? ` ${input.invoiceNumber}` : ""}`;
  const expenses = new Map<string, { amount: Decimal; rate: string; description: string; costCenterId: string | null }>();
  const quotas = new Map<number, { quota: Decimal; base: Decimal }>();
  let retention: Decimal = ZERO;
  let sumBase: Decimal = ZERO;
  let sumQuota: Decimal = ZERO;
  input.lines.forEach((line, index) => {
    const base = money(line.base, `base de la línea ${index + 1}`);
    const quota = money(line.quota, `cuota de la línea ${index + 1}`);
    const ret = line.retention === null || line.retention === undefined ? ZERO : money(line.retention, `retención de la línea ${index + 1}`);
    const key = `${line.expenseAccountCode}|${line.taxRate}|${line.costCenterId ?? ""}`;
    const bucket = expenses.get(key) ?? { amount: ZERO, rate: rateCode(line.taxRate), description: `${line.description ?? "Gasto"} · ${label}`, costCenterId: line.costCenterId ?? null };
    bucket.amount = bucket.amount.plus(base).plus(deductible ? ZERO : quota);
    expenses.set(key, bucket);
    if (deductible && !quota.isZero()) {
      const q = quotas.get(line.taxRate) ?? { quota: ZERO, base: ZERO };
      q.quota = q.quota.plus(quota);
      q.base = q.base.plus(base);
      quotas.set(line.taxRate, q);
    }
    retention = retention.plus(ret);
    sumBase = sumBase.plus(base);
    sumQuota = sumQuota.plus(quota);
  });
  const total = money(input.total, "total de la factura recibida");
  const expected = sumBase.plus(sumQuota).minus(retention);
  if (!expected.equals(total)) {
    throw ledgerBadRequest("SUPPLIER_BILL_TOTALS_MISMATCH", `La factura recibida ${number} no cuadra: base ${sumBase.toFixed(2)} + cuota ${sumQuota.toFixed(2)} − retención ${retention.toFixed(2)} = ${expected.toFixed(2)} ≠ total ${total.toFixed(2)}.`, {
      billId: input.billId,
      base: sumBase.toFixed(2),
      quota: sumQuota.toFixed(2),
      retention: retention.toFixed(2),
      total: total.toFixed(2)
    });
  }
  const lines: RuleLine[] = [];
  for (const [key, bucket] of expenses) {
    pushLine(lines, signedLine(key.split("|")[0]!, "debit", bucket.amount, { description: bucket.description, taxRateCode: bucket.rate, costCenterId: bucket.costCenterId }));
  }
  for (const [rate, q] of quotas) {
    pushLine(lines, signedLine(vatInputAccount(rate), "debit", q.quota, { description: `${input.figure ?? "IVA"} soportado ${rate} % (${label})`, taxRateCode: rateCode(rate), taxBase: q.base.toFixed(2) }));
  }
  pushLine(lines, signedLine(WITHHOLDING_ACCOUNT, "credit", retention, { description: `Retención IRPF practicada (${label})` }));
  pushLine(lines, signedLine(input.payableAccountCode ?? SUPPLIER_ACCOUNT, "credit", total, { description: `Factura recibida ${label}` }));
  assertBalanced(lines);
  return { sourceType: "supplier_bill", sourceId: input.billId, entryDate: input.entryDate, description: `Factura recibida ${label}`, reference: input.invoiceNumber ?? null, lines, warnings: [] };
}

export type SupplierBillPaymentInput = {
  organizationId: string;
  propertyId?: string | null;
  billId: string;
  /** Defaults to the bill id (one payment per bill); partial payments pass their own id. */
  paymentId?: string | null;
  entryDate: string;
  amount: MoneyLike;
  payableAccountCode?: string | null;
  paidWith: "bank" | "cash" | "card";
  supplierName: string;
  invoiceNumber?: string | null;
};

export function buildSupplierBillPaymentEntry(input: SupplierBillPaymentInput): RuleEntry {
  const amount = money(input.amount, "importe del pago");
  if (amount.isZero()) throw ledgerBadRequest("PAYMENT_AMOUNT_ZERO", "Un pago de 0 € no genera asiento.");
  const label = `${input.supplierName}${input.invoiceNumber ? ` ${input.invoiceNumber}` : ""}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(input.payableAccountCode ?? SUPPLIER_ACCOUNT, "debit", amount, { description: `Pago a proveedor ${label}` }));
  pushLine(lines, signedLine(EXPENSE_PAID_WITH_ACCOUNT[input.paidWith] ?? BANK_ACCOUNT, "credit", amount, { description: `Pago ${label}` }));
  assertBalanced(lines);
  return { sourceType: "supplier_bill_payment", sourceId: input.paymentId ?? input.billId, entryDate: input.entryDate, description: `Pago a proveedor ${label}`, reference: input.invoiceNumber ?? null, lines, warnings: [] };
}

export type ExpenseInput = {
  organizationId: string;
  propertyId?: string | null;
  expenseId: string;
  entryDate: string;
  accountCode: string;
  base: MoneyLike;
  taxRate: number;
  quota: MoneyLike;
  total: MoneyLike;
  paidWith: "cash" | "card" | "bank";
  vatDeductible: boolean;
  supplierName: string;
  concept: string;
  costCenterId?: string | null;
};

export function buildExpenseEntry(input: ExpenseInput): RuleEntry {
  const base = money(input.base, "base del gasto");
  const quota = money(input.quota, "cuota del gasto");
  const total = money(input.total, "total del gasto");
  if (!base.plus(quota).equals(total)) {
    throw ledgerBadRequest("EXPENSE_TOTALS_MISMATCH", `El gasto ${input.expenseId} no cuadra: base ${base.toFixed(2)} + cuota ${quota.toFixed(2)} ≠ total ${total.toFixed(2)}.`);
  }
  const label = `${input.concept} · ${input.supplierName}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(input.accountCode, "debit", input.vatDeductible ? base : total, { description: label, taxRateCode: rateCode(input.taxRate), costCenterId: input.costCenterId ?? null }));
  if (input.vatDeductible) {
    pushLine(lines, signedLine(vatInputAccount(input.taxRate), "debit", quota, { description: `IVA soportado ${input.taxRate} % (${input.supplierName})`, taxRateCode: rateCode(input.taxRate), taxBase: base.toFixed(2) }));
  }
  pushLine(lines, signedLine(EXPENSE_PAID_WITH_ACCOUNT[input.paidWith] ?? BANK_ACCOUNT, "credit", total, { description: `Pago ${label}` }));
  assertBalanced(lines);
  return { sourceType: "expense", sourceId: input.expenseId, entryDate: input.entryDate, description: `Gasto ${label}`, reference: null, lines, warnings: input.vatDeductible ? [] : [`Gasto ${input.expenseId}: cuota no deducible sumada al gasto.`] };
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export type PayrollSlipInput = {
  organizationId: string;
  propertyId?: string | null;
  slipId: string;
  periodCode: string;
  entryDate: string;
  employeeName?: string | null;
  grossSalary: MoneyLike;
  ssEmployer: MoneyLike;
  irpfRetention: MoneyLike;
  ssEmployee: MoneyLike;
  netSalary: MoneyLike;
  /** 640 or a department sub-account (640.1…). */
  salariesAccountCode?: string | null;
  employerSsAccountCode?: string | null;
  costCenterId?: string | null;
};

export function buildPayrollSlipEntry(input: PayrollSlipInput): RuleEntry {
  const gross = money(input.grossSalary, "salario bruto");
  const ssEmployer = money(input.ssEmployer, "SS empresa");
  const irpf = money(input.irpfRetention, "retención IRPF");
  const ssEmployee = money(input.ssEmployee, "SS trabajador");
  const net = money(input.netSalary, "líquido");
  const expected = gross.minus(irpf).minus(ssEmployee);
  if (!expected.equals(net)) {
    throw ledgerBadRequest("PAYROLL_SLIP_MISMATCH", `La nómina ${input.slipId} no cuadra: bruto ${gross.toFixed(2)} − IRPF ${irpf.toFixed(2)} − SS trabajador ${ssEmployee.toFixed(2)} = ${expected.toFixed(2)} ≠ líquido ${net.toFixed(2)}.`);
  }
  const who = input.employeeName ? ` · ${input.employeeName}` : "";
  const label = `Nómina ${input.periodCode}${who}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(input.salariesAccountCode ?? SALARIES_ACCOUNT, "debit", gross, { description: `${label} · sueldos y salarios`, costCenterId: input.costCenterId ?? null }));
  pushLine(lines, signedLine(input.employerSsAccountCode ?? EMPLOYER_SS_ACCOUNT, "debit", ssEmployer, { description: `${label} · Seguridad Social empresa`, costCenterId: input.costCenterId ?? null }));
  pushLine(lines, signedLine(WITHHOLDING_ACCOUNT, "credit", irpf, { description: `${label} · retención IRPF` }));
  pushLine(lines, signedLine(SOCIAL_SECURITY_ACCOUNT, "credit", ssEmployee.plus(ssEmployer), { description: `${label} · Seguridad Social acreedora` }));
  pushLine(lines, signedLine(WAGES_PAYABLE_ACCOUNT, "credit", net, { description: `${label} · líquido a pagar` }));
  if (lines.length < 2) throw ledgerBadRequest("PAYROLL_SLIP_EMPTY", `La nómina ${input.slipId} no tiene importes.`);
  assertBalanced(lines);
  return { sourceType: "payroll_slip", sourceId: input.slipId, entryDate: input.entryDate, description: label, reference: input.periodCode, lines, warnings: [] };
}

export type PayrollPaymentInput = {
  organizationId: string;
  propertyId?: string | null;
  periodId: string;
  periodCode: string;
  entryDate: string;
  amount: MoneyLike;
};

export function buildPayrollPaymentEntry(input: PayrollPaymentInput): RuleEntry {
  const amount = money(input.amount, "importe de las nóminas");
  if (amount.isZero()) throw ledgerBadRequest("PAYMENT_AMOUNT_ZERO", "Un pago de nóminas de 0 € no genera asiento.");
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(WAGES_PAYABLE_ACCOUNT, "debit", amount, { description: `Pago de nóminas ${input.periodCode}` }));
  pushLine(lines, signedLine(BANK_ACCOUNT, "credit", amount, { description: `Transferencia de nóminas ${input.periodCode}` }));
  assertBalanced(lines);
  return { sourceType: "payroll_payment", sourceId: input.periodId, entryDate: input.entryDate, description: `Pago de nóminas ${input.periodCode}`, reference: input.periodCode, lines, warnings: [] };
}

// ---------------------------------------------------------------------------
// Channel commissions
// ---------------------------------------------------------------------------

export type CommissionAccrualInput = {
  organizationId: string;
  propertyId: string;
  accrualId: string;
  entryDate: string;
  channelCode?: string | null;
  amount: MoneyLike;
  baseAmount?: MoneyLike | null;
  ratePct?: MoneyLike | null;
  reference?: string | null;
  creditorAccountCode?: string | null;
};

export function buildCommissionAccrualEntry(input: CommissionAccrualInput): RuleEntry {
  const amount = money(input.amount, "importe de la comisión");
  if (amount.isZero()) throw ledgerBadRequest("COMMISSION_AMOUNT_ZERO", "Una comisión de 0 € no genera asiento.");
  const channel = input.channelCode ?? "canal";
  const detail = input.baseAmount !== null && input.baseAmount !== undefined && input.ratePct !== null && input.ratePct !== undefined ? ` ${new D(input.ratePct).toString()} % sobre ${money(input.baseAmount).toFixed(2)}` : "";
  const description = `Comisión ${channel}${detail}${input.reference ? ` · ${input.reference}` : ""}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(CHANNEL_COMMISSION_ACCOUNT, "debit", amount, { description }));
  pushLine(lines, signedLine(input.creditorAccountCode ?? CREDITOR_ACCOUNT, "credit", amount, { description: `Acreedor ${channel}` }));
  assertBalanced(lines);
  return { sourceType: "commission", sourceId: input.accrualId, entryDate: input.entryDate, description, reference: input.reference ?? null, lines, warnings: [] };
}

export type CommissionSettlementInput = {
  organizationId: string;
  propertyId: string;
  settlementId: string;
  entryDate: string;
  channelCode?: string | null;
  amount: MoneyLike;
  creditorAccountCode?: string | null;
  paidWith?: "bank" | "cash";
};

export function buildCommissionSettlementEntry(input: CommissionSettlementInput): RuleEntry {
  const amount = money(input.amount, "importe de la liquidación");
  if (amount.isZero()) throw ledgerBadRequest("PAYMENT_AMOUNT_ZERO", "Una liquidación de 0 € no genera asiento.");
  const description = `Liquidación de comisiones ${input.channelCode ?? "canal"}`;
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(input.creditorAccountCode ?? CREDITOR_ACCOUNT, "debit", amount, { description }));
  pushLine(lines, signedLine(input.paidWith === "cash" ? CASH_ACCOUNT : BANK_ACCOUNT, "credit", amount, { description }));
  assertBalanced(lines);
  return { sourceType: "commission_settlement", sourceId: input.settlementId, entryDate: input.entryDate, description, reference: null, lines, warnings: [] };
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export type DepreciationLineInput = {
  fixedAssetId: string;
  name: string;
  amount: MoneyLike;
  /** 681 material · 680 intangible. */
  expenseAccountCode: string;
  /** 28xx of the element. */
  depreciationAccountCode: string;
  costCenterId?: string | null;
};

export type DepreciationRunInput = {
  organizationId: string;
  propertyId?: string | null;
  runId: string;
  period: string;
  entryDate: string;
  lines: DepreciationLineInput[];
};

export function buildDepreciationEntry(input: DepreciationRunInput): RuleEntry {
  const expenses = new Map<string, Decimal>();
  const lines: RuleLine[] = [];
  let total: Decimal = ZERO;
  for (const line of input.lines) {
    const amount = money(line.amount, `amortización de ${line.name}`);
    if (amount.isZero()) continue;
    expenses.set(line.expenseAccountCode, (expenses.get(line.expenseAccountCode) ?? ZERO).plus(amount));
    pushLine(lines, signedLine(line.depreciationAccountCode, "credit", amount, { description: `Amortización ${input.period} · ${line.name}`, costCenterId: line.costCenterId ?? null }));
    total = total.plus(amount);
  }
  if (total.isZero()) throw ledgerBadRequest("DEPRECIATION_EMPTY", `La corrida de amortización ${input.period} no tiene importes.`);
  const debits: RuleLine[] = [];
  for (const [account, amount] of expenses) pushLine(debits, signedLine(account, "debit", amount, { description: `Dotación a la amortización ${input.period}` }));
  const all = [...debits, ...lines];
  assertBalanced(all);
  return { sourceType: "depreciation", sourceId: input.runId, entryDate: input.entryDate, description: `Amortización del inmovilizado ${input.period}`, reference: input.period, lines: all, warnings: [] };
}

// ---------------------------------------------------------------------------
// VAT settlement (Modelo 303 result)
// ---------------------------------------------------------------------------

export type VatSettlementInput = {
  organizationId: string;
  period: string;
  entryDate: string;
  /** Balances of 477.x (devengado) and 472.x (soportado deducible) per rate for the period. */
  output: Array<{ ratePercent: number; amount: MoneyLike; accountCode?: string | null }>;
  input: Array<{ ratePercent: number; amount: MoneyLike; accountCode?: string | null }>;
  /** Previous-period credit carried (casilla 67) to compensate, if any. */
  compensation?: MoneyLike | null;
};

export function buildVatSettlementEntry(input: VatSettlementInput): RuleEntry {
  const lines: RuleLine[] = [];
  let devengado: Decimal = ZERO;
  let soportado: Decimal = ZERO;
  for (const item of input.output) {
    const amount = money(item.amount, `IVA repercutido ${item.ratePercent} %`);
    devengado = devengado.plus(amount);
    pushLine(lines, signedLine(item.accountCode ?? vatOutputAccount(item.ratePercent), "debit", amount, { description: `Liquidación ${input.period} · IVA repercutido ${item.ratePercent} %`, taxRateCode: rateCode(item.ratePercent) }));
  }
  for (const item of input.input) {
    const amount = money(item.amount, `IVA soportado ${item.ratePercent} %`);
    soportado = soportado.plus(amount);
    pushLine(lines, signedLine(item.accountCode ?? vatInputAccount(item.ratePercent), "credit", amount, { description: `Liquidación ${input.period} · IVA soportado ${item.ratePercent} %`, taxRateCode: rateCode(item.ratePercent) }));
  }
  const compensation = input.compensation === null || input.compensation === undefined ? ZERO : money(input.compensation, "compensación de periodos anteriores");
  if (!compensation.isZero()) {
    soportado = soportado.plus(compensation);
    pushLine(lines, signedLine(VAT_RECEIVABLE_ACCOUNT, "credit", compensation, { description: `Liquidación ${input.period} · compensación de periodos anteriores` }));
  }
  const result = devengado.minus(soportado);
  if (result.isPositive()) pushLine(lines, signedLine(VAT_PAYABLE_ACCOUNT, "credit", result, { description: `Liquidación ${input.period} · a ingresar` }));
  else if (result.isNegative()) pushLine(lines, signedLine(VAT_RECEIVABLE_ACCOUNT, "debit", result.abs(), { description: `Liquidación ${input.period} · a compensar / devolver` }));
  if (lines.length < 2) throw ledgerBadRequest("VAT_SETTLEMENT_EMPTY", `La liquidación ${input.period} no tiene cuotas.`);
  assertBalanced(lines);
  return { sourceType: "vat_settlement", sourceId: `${input.organizationId}:${input.period}`, entryDate: input.entryDate, description: `Liquidación de IVA ${input.period}`, reference: input.period, lines, warnings: [] };
}

// ---------------------------------------------------------------------------
// Card settlement, cash closure difference
// ---------------------------------------------------------------------------

export type CardSettlementInput = {
  organizationId: string;
  propertyId: string;
  settlementId: string;
  entryDate: string;
  gross: MoneyLike;
  fee: MoneyLike;
  reference?: string | null;
};

export function buildCardSettlementEntry(input: CardSettlementInput): RuleEntry {
  const gross = money(input.gross, "importe bruto del datáfono");
  const fee = money(input.fee, "comisión del datáfono");
  const net = gross.minus(fee);
  if (gross.isZero()) throw ledgerBadRequest("PAYMENT_AMOUNT_ZERO", "Una liquidación de datáfono de 0 € no genera asiento.");
  const lines: RuleLine[] = [];
  pushLine(lines, signedLine(BANK_ACCOUNT, "debit", net, { description: `Liquidación datáfono${input.reference ? ` ${input.reference}` : ""} · neto` }));
  pushLine(lines, signedLine(BANK_FEES_ACCOUNT, "debit", fee, { description: `Comisión datáfono${input.reference ? ` ${input.reference}` : ""}` }));
  pushLine(lines, signedLine(CARD_TERMINAL_ACCOUNT, "credit", gross, { description: `Liquidación datáfono${input.reference ? ` ${input.reference}` : ""} · bruto` }));
  assertBalanced(lines);
  return { sourceType: "card_settlement", sourceId: input.settlementId, entryDate: input.entryDate, description: `Liquidación de datáfono${input.reference ? ` ${input.reference}` : ""}`, reference: input.reference ?? null, lines, warnings: [] };
}

export type CashClosureInput = {
  organizationId: string;
  propertyId: string;
  closureId: string;
  entryDate: string;
  /** counted − expected: negative = faltante, positive = sobrante. */
  difference: MoneyLike;
  outletLabel?: string | null;
};

export function buildCashClosureDifferenceEntry(input: CashClosureInput): RuleEntry {
  const difference = money(input.difference, "diferencia de arqueo");
  if (difference.isZero()) throw ledgerBadRequest("CASH_CLOSURE_NO_DIFFERENCE", "El arqueo cuadra: no hay asiento de diferencia.");
  const label = `Arqueo ${input.entryDate}${input.outletLabel ? ` · ${input.outletLabel}` : ""}`;
  const lines: RuleLine[] = [];
  if (difference.isNegative()) {
    pushLine(lines, signedLine(CASH_SHORTAGE_ACCOUNT, "debit", difference.abs(), { description: `${label} · faltante` }));
    pushLine(lines, signedLine(CASH_ACCOUNT, "credit", difference.abs(), { description: `${label} · faltante` }));
  } else {
    pushLine(lines, signedLine(CASH_ACCOUNT, "debit", difference, { description: `${label} · sobrante` }));
    pushLine(lines, signedLine(CASH_SURPLUS_ACCOUNT, "credit", difference, { description: `${label} · sobrante` }));
  }
  assertBalanced(lines);
  return { sourceType: "cash_closure", sourceId: input.closureId, entryDate: input.entryDate, description: label, reference: null, lines, warnings: [] };
}

// ---------------------------------------------------------------------------
// Year-end: regularización, cierre, apertura
// ---------------------------------------------------------------------------

export type YearBalance = {
  accountCode: string;
  accountName?: string | null;
  /** asset · liability · equity · income · expense (Account.kind). */
  kind: string;
  debit: MoneyLike;
  credit: MoneyLike;
};

export type YearEndInput = {
  organizationId: string;
  propertyId?: string | null;
  fiscalYearId: string;
  yearCode: string;
  /** Last day of the ejercicio (regularización and cierre) / first day of the next (apertura). */
  entryDate: string;
  balances: YearBalance[];
  resultAccountCode?: string | null;
};

function isPnl(balance: YearBalance): boolean {
  const first = balance.accountCode.charAt(0);
  return balance.kind === "income" || balance.kind === "expense" || balance.kind === "revenue" || first === "6" || first === "7";
}

/** 6xx/7xx → 129: revenues (credit balances) are debited, expenses credited; 129 takes the net result. */
export function buildRegularizationEntry(input: YearEndInput): RuleEntry & { netResult: Decimal } {
  const lines: RuleLine[] = [];
  let netResult: Decimal = ZERO;
  for (const balance of input.balances) {
    if (!isPnl(balance)) continue;
    const net = money(balance.credit).minus(money(balance.debit)); // credit-natural: + profit contribution
    if (net.isZero()) continue;
    netResult = netResult.plus(net);
    pushLine(lines, signedLine(balance.accountCode, "debit", net, { description: `Regularización ${input.yearCode} · ${balance.accountCode} ${balance.accountName ?? ""}`.trim() }));
  }
  pushLine(lines, signedLine(input.resultAccountCode ?? RESULT_ACCOUNT, "credit", netResult, { description: `Regularización ${input.yearCode} · resultado del ejercicio` }));
  if (lines.length > 0) assertBalanced(lines);
  return {
    sourceType: "regularization",
    sourceId: `year-close:${input.fiscalYearId}:regularization`,
    entryDate: input.entryDate,
    description: `Asiento de regularización ${input.yearCode}`,
    reference: input.yearCode,
    entryKind: "regularization",
    lines,
    warnings: [],
    netResult
  };
}

/** Closes every balance-sheet account (after regularización 129 carries the result) with its inverse. */
export function buildClosingEntry(input: YearEndInput & { netResult: MoneyLike }): RuleEntry {
  const lines: RuleLine[] = [];
  const resultAccount = input.resultAccountCode ?? RESULT_ACCOUNT;
  let resultCredit = money(input.netResult);
  for (const balance of input.balances) {
    if (isPnl(balance)) continue;
    const net = money(balance.debit).minus(money(balance.credit)); // debit-natural
    if (balance.accountCode === resultAccount) {
      resultCredit = resultCredit.minus(net);
      continue;
    }
    if (net.isZero()) continue;
    pushLine(lines, signedLine(balance.accountCode, "credit", net, { description: `Cierre ${input.yearCode} · ${balance.accountCode} ${balance.accountName ?? ""}`.trim() }));
  }
  pushLine(lines, signedLine(resultAccount, "debit", resultCredit, { description: `Cierre ${input.yearCode} · resultado del ejercicio` }));
  if (lines.length > 0) assertBalanced(lines);
  return {
    sourceType: "closing",
    sourceId: `year-close:${input.fiscalYearId}:closing`,
    entryDate: input.entryDate,
    description: `Asiento de cierre ${input.yearCode}`,
    reference: input.yearCode,
    entryKind: "closing",
    lines,
    warnings: []
  };
}

/** Opening of the next year: the closing lines with their sides swapped. */
export function buildOpeningEntry(closing: RuleEntry, input: { fiscalYearId: string; nextYearCode: string; entryDate: string }): RuleEntry {
  const lines = closing.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit, description: (line.description ?? "").replace(/^Cierre \S+/, `Apertura ${input.nextYearCode}`) }));
  if (lines.length > 0) assertBalanced(lines);
  return {
    sourceType: "opening",
    sourceId: `year-close:${input.fiscalYearId}:opening`,
    entryDate: input.entryDate,
    description: `Asiento de apertura ${input.nextYearCode}`,
    reference: input.nextYearCode,
    entryKind: "opening",
    lines,
    warnings: []
  };
}
