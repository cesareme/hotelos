// Documents · server-side checks of an extracted document (Tanda T9 · lote
// T9-06b, design §5.1 «Validar»). Runs ALWAYS, with or without an AI
// extraction, over the normalised fields (`ExtractedDocumentFields`: the
// pipeline maps the AI schema, the text rules or the e-invoice parser into
// it) plus what the caller already looked up: the Supplier by NIF, the Sage
// third party (sage-lookup.ts), the organisation's bills of that NIF, the
// Sage received invoices of that NIF, the sha256 twin and the open goods
// receipts of the same supplier and centre. Pure: no database, no clock.
//
// The seven checks of `DocumentChecks` (always present, each ok | warn | fail,
// Spanish message, machine details):
//   nif        control character (validators.ts checkSpanishNif); fail when
//              invalid, or absent on an invoice; warn when absent on a
//              delivery note; receipts and letters: informative.
//   supplier   ok with a Supplier; warn «proponer alta desde Sage» when only
//              the Sage third party exists; warn «desconocido» otherwise.
//   totals     computeBillTotals over the extracted lines against the printed
//              total ± 0,01 (fail when off, when lines are missing or a line
//              has no amount); quota per line ± 0,01 as in payables.
//   vat        every rate ∈ SUPPORTED_INPUT_VAT_RATES; recargo de
//              equivalencia, ISP and intracomunitaria → fail `needsManual`
//              with the reason (design §12: no automatic SupplierBill).
//   duplicate  sha256 twin → fail; same supplier + exact number in the
//              organisation's bills or in Sage → fail (source and id); fuzzy
//              (two of: number without separators, total ± 0,01, date ± 3
//              days) → warn; delivery notes: same number already received.
//   retention  expected IRPF (Supplier.retentionRate) vs extracted → warn.
//   match      matchBillToReceipts over the received notes of the NIF and
//              centre: full → ok, partial / open notes → warn, variance → fail.

import type { CheckStatus, DocumentCheck, DocumentChecks, IncomingDocumentKind } from "@hotelos/shared";
import { HttpError } from "../../lib/http-error.js";
import { dec, money, pct, round2, sum, utcDay, ZERO, type Decimal } from "../payables/money.js";
import { computeBillTotals } from "../payables/supplier-bills.service.js";
import { checkSpanishNif, normalizeNif } from "../payables/validators.js";
import { SUPPORTED_INPUT_VAT_RATES, taxRateCodeOf } from "../payables/vat-book.js";
import {
  DEFAULT_MATCH_TOLERANCES,
  matchBillToReceipts,
  normalizeReference,
  optDec,
  lineBase,
  type BillLineLike,
  type BillLineMatchDraft,
  type GoodsReceiptLike,
  type MatchTolerances,
  type NumberLike
} from "./matching.js";

// ---------------------------------------------------------------------------
// Input types (what the pipeline hands over)
// ---------------------------------------------------------------------------

/** One line of an invoice / delivery note / receipt as extracted (all figures optional: the extractor never guarantees them). */
export type ExtractedLine = {
  description?: string | null;
  quantity?: NumberLike | null;
  unit?: string | null;
  unitPrice?: NumberLike | null;
  /** Base without VAT; derived from quantity × unitPrice when absent. */
  base?: NumberLike | null;
  /** 21 | 10 | 4 | 7 | 3 | 2 | 0 (others → vat needsManual). */
  taxRate?: NumberLike | null;
  quota?: NumberLike | null;
  /** Delivery-note number quoted on the line. */
  deliveryNoteRef?: string | null;
  /** Account suggested by the extractor / the supplier's history. */
  expenseAccountCode?: string | null;
};

export type ExtractedVatRegime = "general" | "recargo_equivalencia" | "isp" | "intracomunitaria" | "exenta";

export type ExtractedNoticeKind = "administrative_notice" | "aeat_requirement" | "traffic_fine" | "other";

/**
 * Normalised extraction (AI schema, text rules or e-invoice parser mapped by
 * the pipeline). Money as decimal strings or numbers, days as YYYY-MM-DD.
 */
export type ExtractedDocumentFields = {
  supplierName?: string | null;
  supplierTaxId?: string | null;
  /** NIF of the addressee (the hotel), when printed. */
  customerTaxId?: string | null;
  /** Invoice / delivery note / file number exactly as printed. */
  documentNumber?: string | null;
  /** Alias of documentNumber accepted from the invoice extractors. */
  invoiceNumber?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  /** Delivery notes. */
  deliveryNoteNumber?: string | null;
  deliveryDate?: string | null;
  /** Delivery-note numbers quoted anywhere on an invoice. */
  deliveryNoteRefs?: string[] | null;
  total?: NumberLike | null;
  baseTotal?: NumberLike | null;
  taxTotal?: NumberLike | null;
  /** Single-rate documents without line detail. */
  taxRate?: NumberLike | null;
  retentionRate?: NumberLike | null;
  retentionAmount?: NumberLike | null;
  currency?: string | null;
  lines?: ExtractedLine[] | null;
  vatRegime?: ExtractedVatRegime | null;
  /** Recargo de equivalencia printed on the document. */
  surchargeRate?: NumberLike | null;
  /** «Inversión del sujeto pasivo» mention. */
  reverseCharge?: boolean | null;
  /** Intra-community supply (foreign VAT number, «operación intracomunitaria»). */
  intraCommunity?: boolean | null;
  /** Administrative notices: which legal deadline applies (§3.5). */
  noticeKind?: ExtractedNoticeKind | null;
  /** Letters: the sender asks for an answer / a deadline is printed. */
  requiresResponse?: boolean | null;
  subject?: string | null;
  senderName?: string | null;
  /** Free text of the document (search of quoted delivery notes). */
  text?: string | null;
};

export type SupplierLike = {
  id: string;
  name?: string | null;
  taxId?: string | null;
  retentionRate?: NumberLike | null;
  defaultExpenseAccountCode?: string | null;
  isCompany?: boolean | null;
};

/** Sage third party of the NIF (sage-lookup.ts `SageSupplier` or a subset). */
export type SageSupplierLike = {
  name: string;
  taxId: string | null;
  sourceAccount: string | null;
  sourceCode?: string | null;
  accounts?: string[] | null;
  supplierId?: string | null;
};

/** A bill of the organisation for the same NIF (the caller filters by NIF or supplier). */
export type ExistingBillLike = {
  id: string;
  invoiceNumber: string | null;
  total: NumberLike;
  issueDate: string | null;
  supplierTaxId: string | null;
  supplierId?: string | null;
  status?: string | null;
};

/** A received invoice of Sage (sage-lookup.ts `SageReceived` or a subset). */
export type SageReceivedLike = {
  number: string | null;
  total: NumberLike;
  /** YYYY-MM-DD. */
  date: string;
  sourceId?: string | null;
  counterpartyNif?: string | null;
};

export type Sha256DuplicateLike = { id: string; registryNumber?: string | null };

/** Tolerances of `DocumentSettings` (strings as in the DTO); missing → schema defaults. */
export type DocumentSettingsLike = {
  priceTolerancePct?: NumberLike | null;
  quantityTolerance?: NumberLike | null;
  amountToleranceAbs?: NumberLike | null;
  requireMatchForApproval?: boolean | null;
};

export type ValidateDocumentInput = {
  kind: IncomingDocumentKind;
  fields: ExtractedDocumentFields;
  /** Centre of the document; receipts of another centre are ignored when both carry one. */
  propertyId?: string | null;
  supplier?: SupplierLike | null;
  sageSupplier?: SageSupplierLike | null;
  existingBills?: ReadonlyArray<ExistingBillLike> | null;
  sageReceived?: ReadonlyArray<SageReceivedLike> | null;
  sha256Duplicate?: Sha256DuplicateLike | null;
  receipts?: ReadonlyArray<GoodsReceiptLike> | null;
  settings?: DocumentSettingsLike | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Kinds with fiscal effect (a supplier document with amounts). */
export const FISCAL_KINDS: ReadonlySet<IncomingDocumentKind> = new Set<IncomingDocumentKind>(["invoice", "delivery_note", "receipt"]);
/** Totals tolerance between the computed and the printed total. */
export const TOTALS_TOLERANCE = "0.01";
/** Fuzzy duplicate: total window (EUR) and date window (days). */
export const DUPLICATE_AMOUNT_TOLERANCE = "0.01";
export const DUPLICATE_DATE_WINDOW_DAYS = 3;
/** Account used when neither the supplier nor the extractor suggests one (629 «Otros servicios»). */
export const FALLBACK_EXPENSE_ACCOUNT = "629";

export type VatManualReason = "recargo_equivalencia" | "isp" | "intracomunitaria" | "unsupported_rate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check(status: CheckStatus, message: string, details?: Record<string, unknown>): DocumentCheck {
  return details === undefined ? { status, message } : { status, message, details };
}

const ok = (message: string, details?: Record<string, unknown>) => check("ok", message, details);
const warn = (message: string, details?: Record<string, unknown>) => check("warn", message, details);
const fail = (message: string, details?: Record<string, unknown>) => check("fail", message, details);

function text(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Document number exactly as printed (`documentNumber`, else `invoiceNumber`). */
export function documentNumberOf(fields: Pick<ExtractedDocumentFields, "documentNumber" | "invoiceNumber">): string | null {
  return text(fields.documentNumber) ?? text(fields.invoiceNumber);
}

function isoDay(value: string | null | undefined): Date | null {
  const day = text(value);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = utcDay(day);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : parsed;
}

function daysApart(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86_400_000));
}

function fmtPct(value: Decimal): string {
  return value.toDecimalPlaces(2).toString();
}

/** Tolerances from the settings (strings of the DTO) with the schema defaults. */
export function tolerancesOf(settings: DocumentSettingsLike | null | undefined): MatchTolerances {
  return {
    priceTolerancePct: optDec(settings?.priceTolerancePct) ?? DEFAULT_MATCH_TOLERANCES.priceTolerancePct,
    quantityTolerance: optDec(settings?.quantityTolerance) ?? DEFAULT_MATCH_TOLERANCES.quantityTolerance,
    amountToleranceAbs: optDec(settings?.amountToleranceAbs) ?? DEFAULT_MATCH_TOLERANCES.amountToleranceAbs
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A line with its resolved amounts (base derived from quantity × price when needed). */
export type ResolvedLine = {
  lineNo: number;
  description: string;
  base: Decimal | null;
  taxRate: Decimal | null;
  rateCode: string | null;
  quota: Decimal | null;
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  deliveryNoteRef: string | null;
  expenseAccountCode: string | null;
};

/** Normalises the extracted lines (pure; shared with the proposal). A document-level `taxRate` applies to every line without its own. */
export function resolveLines(fields: ExtractedDocumentFields): ResolvedLine[] {
  const lines = fields.lines ?? [];
  const documentRate = optDec(fields.taxRate);
  return lines.map((line, index) => {
    const taxRate = optDec(line.taxRate) ?? documentRate;
    return {
      lineNo: index + 1,
      description: text(line.description) ?? `Línea ${index + 1}`,
      base: lineBase(line),
      taxRate,
      rateCode: taxRate === null ? null : taxRateCodeOf(taxRate),
      quota: optDec(line.quota),
      quantity: optDec(line.quantity),
      unitPrice: optDec(line.unitPrice),
      deliveryNoteRef: text(line.deliveryNoteRef),
      expenseAccountCode: text(line.expenseAccountCode)
    };
  });
}

/** Extracted retention rate: printed rate, else derived from the printed amount over the base. */
export function extractedRetentionRate(fields: ExtractedDocumentFields, lines: ReadonlyArray<ResolvedLine>): Decimal | null {
  const rate = optDec(fields.retentionRate);
  if (rate !== null) return rate;
  const amount = optDec(fields.retentionAmount);
  if (amount === null || amount.isZero()) return null;
  const base = optDec(fields.baseTotal) ?? sum(lines.map((l) => l.base ?? ZERO));
  if (base.isZero()) return null;
  return amount.times(100).div(base).toDecimalPlaces(2);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type NifOutcome = { check: DocumentCheck; value: string | null; valid: boolean; isCompany: boolean | null };

export function checkNif(kind: IncomingDocumentKind, fields: ExtractedDocumentFields): NifOutcome {
  const raw = text(fields.supplierTaxId);
  if (!raw) {
    if (kind === "invoice") return { check: fail("Sin NIF del proveedor: una factura completa lo exige (sin él se registra como gasto sin IVA deducible).", { missing: true }), value: null, valid: false, isCompany: null };
    if (kind === "delivery_note") return { check: warn("Sin NIF del proveedor en el albarán: la recepción quedará sin proveedor identificado.", { missing: true }), value: null, valid: false, isCompany: null };
    if (kind === "receipt") return { check: ok("Ticket sin NIF: se registrará como gasto con IVA no deducible.", { missing: true }), value: null, valid: false, isCompany: null };
    return { check: ok("No aplica: el documento no lleva NIF de proveedor.", { missing: true, applicable: false }), value: null, valid: false, isCompany: null };
  }
  const result = checkSpanishNif(raw);
  if (!result.ok) {
    const details = { value: result.value, reason: result.message };
    if (kind === "invoice") return { check: fail(`NIF del proveedor no válido (${raw}): ${result.message}`, details), value: result.value, valid: false, isCompany: null };
    return { check: warn(`NIF no válido (${raw}): ${result.message} Se ignora para la propuesta.`, details), value: result.value, valid: false, isCompany: null };
  }
  return {
    check: ok(`NIF ${result.value} válido (${result.kind}).`, { value: result.value, kind: result.kind, isCompany: result.isCompany }),
    value: result.value,
    valid: true,
    isCompany: result.isCompany
  };
}

export function checkSupplier(kind: IncomingDocumentKind, fields: ExtractedDocumentFields, nif: NifOutcome, supplier: SupplierLike | null | undefined, sageSupplier: SageSupplierLike | null | undefined): DocumentCheck {
  if (supplier) {
    const supplierNif = normalizeNif(supplier.taxId);
    if (nif.valid && supplierNif && nif.value && supplierNif !== nif.value) {
      return warn(`El proveedor ${supplier.name ?? supplier.id} tiene el NIF ${supplierNif}, distinto del extraído (${nif.value}).`, { supplierId: supplier.id, supplierTaxId: supplierNif, extractedTaxId: nif.value, mismatch: true });
    }
    return ok(`Proveedor conocido: ${supplier.name ?? supplier.id}.`, { supplierId: supplier.id, fromSage: false });
  }
  if (sageSupplier) {
    const account = sageSupplier.sourceAccount ?? sageSupplier.accounts?.[0] ?? null;
    return warn(`Proveedor sin alta en ehotelOS; existe en Sage como ${sageSupplier.name}${account ? ` (cuenta ${account})` : ""}: proponer alta desde Sage.`, {
      fromSage: true,
      name: sageSupplier.name,
      taxId: sageSupplier.taxId,
      sourceAccount: account,
      accounts: sageSupplier.accounts ?? (account ? [account] : []),
      sourceCode: sageSupplier.sourceCode ?? null
    });
  }
  if (!FISCAL_KINDS.has(kind) && !nif.value) return ok("No aplica: sin proveedor que identificar.", { applicable: false });
  if (kind === "receipt" && !nif.value) return ok("Ticket sin proveedor identificado: el gasto lleva el nombre impreso.", { fromSage: false, name: text(fields.supplierName) });
  return warn(`Proveedor desconocido${text(fields.supplierName) ? ` (${text(fields.supplierName)})` : ""}: se propondrá el alta con los datos extraídos.`, { fromSage: false, name: text(fields.supplierName), taxId: nif.value });
}

export type TotalsOutcome = {
  check: DocumentCheck;
  /** Computed total (null when the lines cannot be summed). */
  computedTotal: Decimal | null;
  baseTotal: Decimal | null;
  taxTotal: Decimal | null;
  retentionAmount: Decimal | null;
  /** True when the printed total equals the computed one to the cent (the proposal can send it as expectedTotal). */
  printedMatchesExactly: boolean;
};

type TotalsLine = Parameters<typeof computeBillTotals>[0][number];

function plainTotals(lines: ReadonlyArray<ResolvedLine>, retentionRate: Decimal | null): { baseTotal: Decimal; taxTotal: Decimal; retentionAmount: Decimal; total: Decimal } {
  const baseTotal = sum(lines.map((l) => round2(l.base ?? ZERO)));
  const taxTotal = sum(lines.map((l) => (l.quota !== null ? round2(l.quota) : l.taxRate !== null && l.base !== null ? pct(l.base, l.taxRate) : ZERO)));
  const retentionAmount = retentionRate && !retentionRate.isZero() ? pct(baseTotal, retentionRate) : ZERO;
  return { baseTotal, taxTotal, retentionAmount, total: baseTotal.plus(taxTotal).minus(retentionAmount) };
}

/**
 * Totals (§5.1 «fallback honesto», RV-11): `fail` is reserved for a contradiction
 * (printed total ≠ sum of the lines, a quota off, a line without amount on an
 * invoice); when nothing was extracted (no lines and no total: delivery notes,
 * receipts, images without provider) the outcome is `warn` with `needsManual`
 * (manual form), so approving a receipt or an expense does not demand an
 * override. Only invoices keep `fail` for a printed total without lines.
 */
export function checkTotals(kind: IncomingDocumentKind, fields: ExtractedDocumentFields, lines: ReadonlyArray<ResolvedLine>): TotalsOutcome {
  const none: Omit<TotalsOutcome, "check"> = { computedTotal: null, baseTotal: null, taxTotal: null, retentionAmount: null, printedMatchesExactly: false };
  const printed = optDec(fields.total);
  if (!FISCAL_KINDS.has(kind)) return { ...none, check: ok("No aplica: el documento no lleva importes que cuadrar.", { applicable: false }) };
  const strict = kind === "invoice";
  if (lines.length === 0) {
    if (printed === null) return { ...none, check: warn("Sin líneas ni total extraídos: introdúcelos a mano en el formulario.", { lineCount: 0, printedTotal: null, needsManual: true }) };
    if (!strict) return { ...none, check: warn(`Total impreso ${money(printed)} sin líneas extraídas: revisa el desglose a mano.`, { lineCount: 0, printedTotal: money(printed), needsManual: true }) };
    return { ...none, check: fail(`Total impreso ${money(printed)} sin líneas que lo justifiquen: faltan las líneas.`, { lineCount: 0, printedTotal: money(printed) }) };
  }
  const missing = lines.filter((l) => l.base === null).map((l) => l.lineNo);
  if (missing.length > 0) {
    const message = `Línea${missing.length > 1 ? "s" : ""} ${missing.join(", ")} sin importe (ni base ni cantidad × precio).`;
    return { ...none, check: strict ? fail(message, { lineCount: lines.length, linesWithoutAmount: missing }) : warn(message, { lineCount: lines.length, linesWithoutAmount: missing, needsManual: true }) };
  }
  const retentionRate = extractedRetentionRate(fields, lines);

  let totals: { baseTotal: Decimal; taxTotal: Decimal; retentionAmount: Decimal; total: Decimal };
  const unsupported = lines.filter((l) => l.taxRate !== null && l.rateCode === null);
  const withoutRate = lines.filter((l) => l.taxRate === null);
  if (unsupported.length === 0 && withoutRate.length === 0) {
    const input: TotalsLine[] = lines.map((l) => ({
      description: l.description,
      expenseAccountCode: l.expenseAccountCode ?? FALLBACK_EXPENSE_ACCOUNT,
      base: l.base!,
      taxRate: l.taxRate!,
      ...(l.quota !== null ? { quota: l.quota } : {})
    }));
    try {
      const computed = computeBillTotals(input, retentionRate);
      totals = { baseTotal: computed.baseTotal, taxTotal: computed.taxTotal, retentionAmount: computed.retentionAmount, total: computed.total };
    } catch (error) {
      if (error instanceof HttpError) {
        const details = (error.details ?? {}) as Record<string, unknown>;
        return { ...none, check: fail(error.message, { lineCount: lines.length, code: details.code ?? null, ...details }) };
      }
      throw error;
    }
  } else {
    // Unsupported or missing rates: sum what is printed (the vat check reports the rate); quotas as printed or base × rate.
    totals = plainTotals(lines, retentionRate);
  }
  const base = { computedTotal: totals.total, baseTotal: totals.baseTotal, taxTotal: totals.taxTotal, retentionAmount: totals.retentionAmount };
  const details: Record<string, unknown> = {
    lineCount: lines.length,
    computedTotal: money(totals.total),
    baseTotal: money(totals.baseTotal),
    taxTotal: money(totals.taxTotal),
    retentionAmount: money(totals.retentionAmount),
    printedTotal: printed === null ? null : money(printed),
    ...(withoutRate.length > 0 ? { linesWithoutRate: withoutRate.map((l) => l.lineNo) } : {})
  };
  if (printed === null) {
    return { ...base, printedMatchesExactly: false, check: warn(`Sin total impreso: se toma el calculado ${money(totals.total)}.`, details) };
  }
  const diff = round2(printed).minus(totals.total);
  if (diff.isZero()) return { ...base, printedMatchesExactly: true, check: ok(`Total ${money(printed)} cuadra con las líneas.`, details) };
  if (diff.abs().lte(dec(TOTALS_TOLERANCE))) {
    return { ...base, printedMatchesExactly: false, check: ok(`Total ${money(printed)} cuadra con las líneas salvo ${money(diff.abs())} de redondeo (calculado ${money(totals.total)}).`, { ...details, difference: money(diff) }) };
  }
  return {
    ...base,
    printedMatchesExactly: false,
    check: fail(`El total impreso ${money(printed)} no cuadra con las líneas: base ${money(totals.baseTotal)} + IVA ${money(totals.taxTotal)} − retención ${money(totals.retentionAmount)} = ${money(totals.total)}.`, { ...details, difference: money(diff) })
  };
}

export type VatOutcome = { check: DocumentCheck; needsManual: boolean; reason: VatManualReason | null; rates: string[] };

export function checkVat(kind: IncomingDocumentKind, fields: ExtractedDocumentFields, lines: ReadonlyArray<ResolvedLine>): VatOutcome {
  if (!FISCAL_KINDS.has(kind)) return { check: ok("No aplica: el documento no lleva IVA.", { applicable: false }), needsManual: false, reason: null, rates: [] };
  const rates = [...new Set(lines.map((l) => (l.taxRate === null ? null : fmtPct(l.taxRate))).filter((r): r is string => r !== null))];
  const single = optDec(fields.taxRate);
  if (rates.length === 0 && single !== null) rates.push(fmtPct(single));
  const manual = (reason: VatManualReason, message: string, extra: Record<string, unknown> = {}): VatOutcome => ({
    check: fail(message, { needsManual: true, reason, rates, ...extra }),
    needsManual: true,
    reason,
    rates
  });
  const surcharge = optDec(fields.surchargeRate);
  if (fields.vatRegime === "recargo_equivalencia" || (surcharge !== null && !surcharge.isZero())) {
    return manual("recargo_equivalencia", "Factura con recargo de equivalencia: fuera del contrato de IVA soportado; registro manual.", { surchargeRate: surcharge === null ? null : fmtPct(surcharge) });
  }
  if (fields.vatRegime === "isp" || fields.reverseCharge === true) {
    return manual("isp", "Factura con inversión del sujeto pasivo (ISP): el asiento de autorrepercusión se registra a mano.");
  }
  if (fields.vatRegime === "intracomunitaria" || fields.intraCommunity === true) {
    return manual("intracomunitaria", "Adquisición intracomunitaria: autoliquidación y modelo 349 fuera del flujo automático; registro manual.");
  }
  const unsupported = rates.filter((r) => taxRateCodeOf(r) === null);
  if (unsupported.length > 0) {
    return manual("unsupported_rate", `Tipo de IVA no admitido: ${unsupported.join(", ")} %. Tipos válidos: ${SUPPORTED_INPUT_VAT_RATES.join(", ")}.`, { unsupported });
  }
  if (rates.length === 0) {
    if (kind === "delivery_note") return { check: ok("Albarán sin desglose de IVA (normal: el IVA va en la factura).", { rates }), needsManual: false, reason: null, rates };
    return { check: warn("Sin tipo de IVA extraído: hay que indicarlo en la revisión.", { rates }), needsManual: false, reason: null, rates };
  }
  return { check: ok(`Tipos de IVA admitidos: ${rates.join(", ")} %.`, { rates }), needsManual: false, reason: null, rates };
}

type DuplicateSignals = { number: boolean; total: boolean; date: boolean };

function fuzzySignals(candidate: { number: string | null; total: NumberLike; date: string | null }, number: string | null, total: Decimal | null, date: Date | null): DuplicateSignals {
  const ownNumber = normalizeReference(number);
  const candidateNumber = normalizeReference(candidate.number);
  const candidateTotal = optDec(candidate.total);
  const candidateDate = isoDay(candidate.date);
  return {
    number: ownNumber.length > 0 && ownNumber === candidateNumber,
    total: total !== null && candidateTotal !== null && round2(candidateTotal).minus(round2(total)).abs().lte(dec(DUPLICATE_AMOUNT_TOLERANCE)),
    date: date !== null && candidateDate !== null && daysApart(date, candidateDate) <= DUPLICATE_DATE_WINDOW_DAYS
  };
}

function sameNumber(a: string | null, b: string | null): boolean {
  const x = text(a);
  const y = text(b);
  return x !== null && y !== null && x.toUpperCase() === y.toUpperCase();
}

export function checkDuplicate(input: ValidateDocumentInput, nif: NifOutcome, computedTotal: Decimal | null): DocumentCheck {
  const { kind, fields } = input;
  if (input.sha256Duplicate) {
    return fail(`Mismo fichero ya registrado${input.sha256Duplicate.registryNumber ? ` (${input.sha256Duplicate.registryNumber})` : ""}.`, {
      source: "file",
      documentId: input.sha256Duplicate.id,
      registryNumber: input.sha256Duplicate.registryNumber ?? null
    });
  }
  const number = documentNumberOf(fields);
  const total = optDec(fields.total) ?? computedTotal;
  const date = isoDay(fields.issueDate) ?? isoDay(fields.deliveryDate);

  if (kind === "delivery_note") {
    const noteNumber = text(fields.deliveryNoteNumber) ?? number;
    const twin = (input.receipts ?? []).find((r) => sameNumber(r.deliveryNoteNumber, noteNumber) && sameSupplier(r, input, nif));
    if (twin) return fail(`Albarán ${noteNumber} ya recibido.`, { source: "goods_receipt", goodsReceiptId: twin.id, deliveryNoteNumber: twin.deliveryNoteNumber });
    return ok("Sin albarán previo con el mismo número.", { source: null });
  }
  if (!FISCAL_KINDS.has(kind)) return ok("No aplica.", { applicable: false });

  const bills = (input.existingBills ?? []).filter((b) => b.status !== "cancelled" && sameSupplier({ supplierId: b.supplierId ?? null, supplierTaxId: b.supplierTaxId }, input, nif));
  const exactBill = number ? bills.find((b) => sameNumber(b.invoiceNumber, number)) : undefined;
  if (exactBill) {
    return fail(`Factura ${number} ya registrada para este proveedor.`, { source: "supplier_bill", supplierBillId: exactBill.id, invoiceNumber: exactBill.invoiceNumber, total: money(exactBill.total), issueDate: exactBill.issueDate, kind: "exact" });
  }
  const sage = (input.sageReceived ?? []).filter((r) => !r.counterpartyNif || !nif.value || normalizeNif(r.counterpartyNif) === nif.value);
  const exactSage = number ? sage.find((r) => sameNumber(r.number, number)) : undefined;
  if (exactSage) {
    return fail(`Factura ${number} ya contabilizada en Sage (${exactSage.date}, ${money(exactSage.total)}).`, { source: "sage200", sourceId: exactSage.sourceId ?? null, number: exactSage.number, date: exactSage.date, total: money(exactSage.total), kind: "exact" });
  }
  for (const bill of bills) {
    const signals = fuzzySignals({ number: bill.invoiceNumber, total: bill.total, date: bill.issueDate }, number, total, date);
    if (countSignals(signals) >= 2) {
      return warn(`Posible duplicado de la factura ${bill.invoiceNumber ?? bill.id} (${describeSignals(signals)}).`, { source: "supplier_bill", supplierBillId: bill.id, invoiceNumber: bill.invoiceNumber, total: money(bill.total), issueDate: bill.issueDate, kind: "fuzzy", signals });
    }
  }
  for (const row of sage) {
    const signals = fuzzySignals({ number: row.number, total: row.total, date: row.date }, number, total, date);
    if (countSignals(signals) >= 2) {
      return warn(`Posible duplicado en Sage: ${row.number ?? "sin número"} del ${row.date} por ${money(row.total)} (${describeSignals(signals)}).`, { source: "sage200", sourceId: row.sourceId ?? null, number: row.number, date: row.date, total: money(row.total), kind: "fuzzy", signals });
    }
  }
  return ok("Sin duplicados en las facturas registradas ni en Sage.", { source: null, billsChecked: bills.length, sageChecked: sage.length });
}

function countSignals(signals: DuplicateSignals): number {
  return [signals.number, signals.total, signals.date].filter(Boolean).length;
}

function describeSignals(signals: DuplicateSignals): string {
  const parts: string[] = [];
  if (signals.number) parts.push("mismo número sin separadores");
  if (signals.total) parts.push("mismo importe ± 0,01");
  if (signals.date) parts.push("fecha ± 3 días");
  return parts.join(", ");
}

function sameSupplier(candidate: { supplierId?: string | null; supplierTaxId?: string | null }, input: ValidateDocumentInput, nif: NifOutcome): boolean {
  if (input.supplier && candidate.supplierId && candidate.supplierId === input.supplier.id) return true;
  const candidateNif = normalizeNif(candidate.supplierTaxId);
  if (nif.value && candidateNif) return candidateNif === nif.value;
  // Nothing to compare: the caller already filtered by supplier.
  return !candidateNif && !nif.value;
}

export function checkRetention(kind: IncomingDocumentKind, fields: ExtractedDocumentFields, lines: ReadonlyArray<ResolvedLine>, supplier: SupplierLike | null | undefined): DocumentCheck {
  if (kind !== "invoice") return ok("No aplica.", { applicable: false });
  const expected = optDec(supplier?.retentionRate);
  const extracted = extractedRetentionRate(fields, lines);
  const expectedPositive = expected !== null && !expected.isZero();
  const extractedPositive = extracted !== null && !extracted.isZero();
  const details = { expectedRate: expected === null ? null : fmtPct(expected), extractedRate: extracted === null ? null : fmtPct(extracted) };
  if (expectedPositive && !extractedPositive) return warn(`Se esperaba retención IRPF del ${fmtPct(expected)} % (ficha del proveedor) y la factura no la aplica.`, details);
  if (!expectedPositive && extractedPositive) {
    return supplier
      ? warn(`La factura aplica retención del ${fmtPct(extracted)} % y la ficha del proveedor no la prevé: revisar la ficha.`, details)
      : warn(`La factura aplica retención del ${fmtPct(extracted)} %: confirmar el tipo en el alta del proveedor.`, details);
  }
  if (expectedPositive && extractedPositive && !expected.equals(extracted)) return warn(`Retención del ${fmtPct(extracted)} % en la factura frente al ${fmtPct(expected)} % de la ficha del proveedor.`, details);
  if (expectedPositive) return ok(`Retención IRPF del ${fmtPct(expected)} % como prevé la ficha.`, details);
  return ok("Sin retención IRPF.", details);
}

export type MatchOutcome = { check: DocumentCheck; status: "none" | "partial" | "full" | "variance"; matches: BillLineMatchDraft[]; candidateReceipts: number; unmatchedBillLines: number[] };

export function checkMatch(input: ValidateDocumentInput, nif: NifOutcome, lines: ReadonlyArray<ResolvedLine>): MatchOutcome {
  const empty: Omit<MatchOutcome, "check"> = { status: "none", matches: [], candidateReceipts: 0, unmatchedBillLines: [] };
  if (input.kind !== "invoice") return { ...empty, check: ok("No aplica: solo las facturas se cotejan con albaranes.", { applicable: false, status: "none" }) };
  const candidates = (input.receipts ?? []).filter((r) => {
    if ((r.status ?? "received") !== "received") return false;
    if (input.propertyId && r.propertyId && r.propertyId !== input.propertyId) return false;
    return sameSupplier(r, input, nif);
  });
  if (candidates.length === 0) return { ...empty, check: ok("Sin albaranes pendientes del proveedor en este centro.", { status: "none", candidateReceipts: 0 }) };
  const billLines: BillLineLike[] = lines.map((l) => ({
    lineNo: l.lineNo,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    base: l.base,
    deliveryNoteRef: l.deliveryNoteRef
  }));
  const cited = [...(input.fields.deliveryNoteRefs ?? []), ...quotedReferences(input.fields.text, candidates)];
  const result = matchBillToReceipts(billLines, candidates, tolerancesOf(input.settings), { citedReferences: cited });
  const details = {
    status: result.status,
    candidateReceipts: candidates.length,
    matchedLines: result.matches.length,
    billLines: billLines.length,
    unmatchedBillLines: result.unmatchedBillLines,
    receiptIds: [...new Set(result.matches.map((m) => m.goodsReceiptId))],
    matches: result.matches
  };
  const base = { status: result.status, matches: result.matches, candidateReceipts: candidates.length, unmatchedBillLines: result.unmatchedBillLines };
  switch (result.status) {
    case "full":
      return { ...base, check: ok(`Cotejo completo: ${result.matches.length} línea${result.matches.length === 1 ? "" : "s"} con albarán.`, details) };
    case "partial":
      return { ...base, check: warn(`Cotejo parcial: ${result.matches.length} de ${billLines.length} líneas con albarán; ${result.unmatchedBillLines.length} sin cotejar.`, details) };
    case "variance":
      return { ...base, check: fail(`Cotejo con diferencias fuera de tolerancia en ${result.matches.filter((m) => !m.withinTolerance).length} línea(s).`, details) };
    default:
      return { ...base, check: warn(`El proveedor tiene ${candidates.length} albarán${candidates.length === 1 ? "" : "es"} pendiente${candidates.length === 1 ? "" : "s"} y ninguna línea casa.`, details) };
  }
}

/** Delivery-note numbers of the candidates that appear in the free text of the invoice (normalised, ≥ 4 characters). */
export function quotedReferences(textValue: string | null | undefined, receipts: ReadonlyArray<GoodsReceiptLike>): string[] {
  const haystack = normalizeReference(textValue);
  if (haystack.length === 0) return [];
  const out: string[] = [];
  for (const receipt of receipts) {
    const needle = normalizeReference(receipt.deliveryNoteNumber);
    if (needle.length >= 4 && haystack.includes(needle)) out.push(receipt.deliveryNoteNumber);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The seven checks of design §5.1 for one document. Pure. */
export function validateDocument(input: ValidateDocumentInput): DocumentChecks {
  const lines = resolveLines(input.fields);
  const nif = checkNif(input.kind, input.fields);
  const totals = checkTotals(input.kind, input.fields, lines);
  const vat = checkVat(input.kind, input.fields, lines);
  return {
    nif: nif.check,
    supplier: checkSupplier(input.kind, input.fields, nif, input.supplier, input.sageSupplier),
    totals: totals.check,
    vat: vat.check,
    duplicate: checkDuplicate(input, nif, totals.computedTotal),
    retention: checkRetention(input.kind, input.fields, lines, input.supplier),
    match: checkMatch(input, nif, lines).check
  };
}

/** True when any check failed (the approval needs an explicit override, §9). */
export function hasFailedCheck(checks: DocumentChecks): boolean {
  return Object.values(checks).some((c) => c.status === "fail");
}

/** Keys of the checks in the given status. */
export function checksWithStatus(checks: DocumentChecks, status: CheckStatus): string[] {
  return Object.entries(checks)
    .filter(([, c]) => c.status === status)
    .map(([key]) => key);
}
