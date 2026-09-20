// Documents · proposed domain action of a reviewed document (Tanda T9 · lote
// T9-06b, design §5.1 «Proponer», §7.1-§7.3, §3.5). Pure: from the normalised
// fields, the checks (validation.ts) and what the caller resolved (Supplier,
// Sage third party, settings) it builds the COMPLETE body the approval will
// send to the domain service, so the reviewer only corrects:
//   invoice                → create_supplier_bill (SupplierBillRequest: supplierId or
//                            supplierName + supplierTaxId, invoiceNumber exactly as
//                            printed — the Sage shadow rule compares it verbatim —,
//                            receptionDate = capture day, source digitized | e_invoice,
//                            lines with the supplier's default account or 629
//                            flagged `needsAccount`, quantity / unitPrice /
//                            deliveryNoteRef for the matching, expectedTotal only
//                            when the printed total squares with the lines);
//   invoice without NIF,
//   receipt                → create_expense (ExpenseRequest with vatDeductible false
//                            without a valid NIF; paidWith null: the reviewer sets it,
//                            it is never read off the paper);
//   delivery_note          → create_goods_receipt (GoodsReceiptRequest with lines,
//                            deliveryNoteNumber and deliveryDate);
//   administrative_notice,
//   e_invoice_status,
//   letter with a deadline → create_task (DocumentActionRequest with dueAt from
//                            retention-rules.ts dueAtFor: +10 natural days, +10
//                            business days for AEAT requirements, +20 natural days
//                            for traffic fines, +4 business days for e-invoice status;
//                            kind respond | pay | verify);
//   contract, other, letter
//   without deadline,
//   unknown                → archive.
// The target centre is ALWAYS the document's centre (`propertyId`), also when it
// is the office (`propertyKind = office`): the approval calls the payables /
// goods-receipt service with it (§7.1). The result adds `needsAccount`,
// `needsManual` (vat check) and `notes` for the reviewer; extra keys are
// harmless in `proposedActionJson`.

import type {
  DocumentActionKind,
  DocumentActionRequest,
  DocumentChecks,
  DocumentProposal,
  DocumentProposedAction,
  DocumentSupplierProposal,
  ExpensePaidWith,
  ExpenseRequest,
  GoodsReceiptLineRequest,
  GoodsReceiptRequest,
  IncomingDocumentKind,
  IncomingDocumentSource,
  PayableAccountCode,
  SupplierBillLineRequest,
  SupplierBillRequest,
  SupplierBillSource
} from "@hotelos/shared";
import { dec, money, round2, sum, ZERO, type Decimal } from "../payables/money.js";
import { normalizeNif } from "../payables/validators.js";
import { taxRateCodeOf } from "../payables/vat-book.js";
import { optDec } from "./matching.js";
import { dueAtFor, type DeadlineKind } from "./retention-rules.js";
import {
  FALLBACK_EXPENSE_ACCOUNT,
  documentNumberOf,
  extractedRetentionRate,
  resolveLines,
  type DocumentSettingsLike,
  type ExtractedDocumentFields,
  type ResolvedLine,
  type SageSupplierLike,
  type SupplierLike
} from "./validation.js";

export type BuildProposalInput = {
  kind: IncomingDocumentKind;
  fields: ExtractedDocumentFields;
  /** Centre that captured the document (the target of the action, also when it is the office). */
  propertyId: string;
  propertyKind?: "hotel" | "office" | "other" | string | null;
  supplier?: SupplierLike | null;
  sageSupplier?: SageSupplierLike | null;
  checks: DocumentChecks;
  settings?: DocumentSettingsLike | null;
  /** Capture instant (ISO or Date): reception date of the bill and reference of the deadlines. */
  capturedAt: string | Date;
  /** `IncomingDocument.id` (null before the row exists). */
  incomingDocumentId?: string | null;
  /** Capture channel: `e_invoice` → SupplierBill.source e_invoice; anything else → digitized. */
  source?: IncomingDocumentSource | null;
  registryNumber?: string | null;
};

/** Expense body before the reviewer picks the payment method (the API's zod requires it at approval). */
export type ExpenseDraft = Omit<ExpenseRequest, "paidWith"> & { paidWith: ExpensePaidWith | null };

export type BuiltProposal = DocumentProposal & {
  /** Centre the approval must use (§7.1). */
  targetPropertyId: string;
  /** Some line uses the fallback account 629: the reviewer should confirm the account. */
  needsAccount: boolean;
  /** The vat check asks for manual registration (recargo, ISP, intracomunitaria, unsupported rate). */
  needsManual: boolean;
  notes: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isIsoDay(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function capturedDate(capturedAt: string | Date): Date {
  const date = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function checkDetails(checks: DocumentChecks, key: keyof DocumentChecks): Record<string, unknown> {
  return (checks[key]?.details ?? {}) as Record<string, unknown>;
}

function validNifOf(checks: DocumentChecks): string | null {
  if (checks.nif?.status !== "ok") return null;
  const value = checkDetails(checks, "nif").value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 400 / 410 from the Sage sub-account of the third party. Sage codes are the
 * 3-digit PGC account plus a zero-padded counter ("4000012", "4100007"), so
 * only the root decides; 4100 / 4109 are never inferred (a "4100…" code is a
 * 410 counter, not the PGC sub-account 4100).
 */
export function payableAccountFromSage(sage: SageSupplierLike | null | undefined): PayableAccountCode | undefined {
  const account = sage?.sourceAccount ?? sage?.accounts?.[0] ?? null;
  if (!account) return undefined;
  if (account.startsWith("400")) return "400";
  if (account.startsWith("410")) return "410";
  return undefined;
}

function supplierProposalOf(input: BuildProposalInput, nif: string | null): DocumentSupplierProposal | undefined {
  if (input.supplier) return undefined;
  const sage = input.sageSupplier;
  const name = (sage ? textOf(sage.name) : null) ?? textOf(input.fields.supplierName);
  if (!name && !nif) return undefined;
  return { fromSage: Boolean(sage), name: name ?? "", taxId: nif ?? (sage ? normalizeNif(sage.taxId) : null) };
}

function dominantRate(lines: ReadonlyArray<ResolvedLine>): Decimal | null {
  const byRate = new Map<string, Decimal>();
  for (const line of lines) {
    if (line.taxRate === null) continue;
    const key = line.taxRate.toString();
    byRate.set(key, (byRate.get(key) ?? ZERO).plus(line.base ?? ZERO));
  }
  let best: { rate: string; base: Decimal } | null = null;
  for (const [rate, base] of byRate) if (best === null || base.gt(best.base)) best = { rate, base };
  return best === null ? null : dec(best.rate);
}

function toNumberString(value: Decimal | null, places: number): string | undefined {
  return value === null ? undefined : value.toDecimalPlaces(places).toFixed(places);
}

// ---------------------------------------------------------------------------
// Builders per action
// ---------------------------------------------------------------------------

function buildSupplierBill(input: BuildProposalInput, lines: ReadonlyArray<ResolvedLine>, nif: string | null, notes: string[]): { body: SupplierBillRequest; needsAccount: boolean } {
  const { fields, supplier } = input;
  const captured = capturedDate(input.capturedAt);
  const defaultAccount = textOf(supplier?.defaultExpenseAccountCode);
  let needsAccount = false;

  const billLines: SupplierBillLineRequest[] = lines.map((line) => {
    const account = line.expenseAccountCode ?? defaultAccount ?? FALLBACK_EXPENSE_ACCOUNT;
    if (!line.expenseAccountCode && !defaultAccount) needsAccount = true;
    const rate = line.taxRate ?? ZERO;
    return {
      description: line.description,
      expenseAccountCode: account,
      base: money(line.base ?? ZERO),
      taxRate: taxRateCodeOf(rate) ?? rate.toDecimalPlaces(2).toString(),
      ...(line.quota !== null ? { quota: money(line.quota) } : {}),
      ...(line.quantity !== null ? { quantity: toNumberString(line.quantity, 3) } : {}),
      ...(line.unitPrice !== null ? { unitPrice: toNumberString(line.unitPrice, 4) } : {}),
      ...(line.deliveryNoteRef ? { deliveryNoteRef: line.deliveryNoteRef } : {})
    };
  });

  if (billLines.length === 0) {
    // No line detail: one line with the printed breakdown (or the total) so the reviewer has something to correct.
    const baseTotal = optDec(fields.baseTotal);
    const taxTotal = optDec(fields.taxTotal);
    const total = optDec(fields.total);
    let rate = optDec(fields.taxRate);
    if (rate === null && baseTotal !== null && taxTotal !== null && !baseTotal.isZero()) rate = taxTotal.times(100).div(baseTotal).toDecimalPlaces(0);
    const base = baseTotal ?? (total !== null && rate !== null ? round2(total.div(dec(1).plus(rate.div(100)))) : total);
    needsAccount = needsAccount || !defaultAccount;
    billLines.push({
      description: `Factura ${documentNumberOf(fields) ?? "sin número"}`,
      expenseAccountCode: defaultAccount ?? FALLBACK_EXPENSE_ACCOUNT,
      base: money(base ?? ZERO),
      taxRate: rate === null ? "0" : (taxRateCodeOf(rate) ?? rate.toDecimalPlaces(2).toString())
    });
    notes.push("Sin líneas extraídas: se propone una línea única con el desglose impreso.");
  }

  const withoutRate = lines.filter((l) => l.taxRate === null).map((l) => l.lineNo);
  if (withoutRate.length > 0) notes.push(`Línea${withoutRate.length > 1 ? "s" : ""} ${withoutRate.join(", ")} sin tipo de IVA extraído: se propone 0 %; corregir en la revisión.`);
  const totalsDetails = checkDetails(input.checks, "totals");
  const printedTotal = optDec(fields.total);
  const expectedTotal = totalsDetails.printedMatchesExactly === true || (input.checks.totals?.status === "ok" && totalsDetails.difference === undefined) ? printedTotal : null;
  const retentionRate = optDec(supplier?.retentionRate) ?? extractedRetentionRate(fields, lines);
  const issueDate = isIsoDay(fields.issueDate) ? fields.issueDate : dayOf(captured);
  if (!isIsoDay(fields.issueDate)) notes.push("Sin fecha de factura extraída: se propone la fecha de captura.");
  const number = documentNumberOf(fields);
  if (!number) notes.push("Sin número de factura extraído.");

  const body: SupplierBillRequest = {
    ...(supplier ? { supplierId: supplier.id } : { supplierId: null, supplierName: (input.sageSupplier ? textOf(input.sageSupplier.name) : null) ?? textOf(fields.supplierName) ?? "Proveedor sin identificar", supplierTaxId: nif }),
    invoiceNumber: number ?? "",
    issueDate,
    dueDate: isIsoDay(fields.dueDate) ? fields.dueDate : null,
    retentionRate: retentionRate === null ? null : retentionRate.toDecimalPlaces(2).toString(),
    ...(supplier ? {} : { payableAccountCode: payableAccountFromSage(input.sageSupplier) }),
    ...(expectedTotal !== null ? { expectedTotal: money(expectedTotal) } : {}),
    receptionDate: dayOf(captured),
    incomingDocumentId: input.incomingDocumentId ?? null,
    source: (input.source === "e_invoice" ? "e_invoice" : "digitized") satisfies SupplierBillSource,
    lines: billLines
  };
  if (body.payableAccountCode === undefined) delete body.payableAccountCode;
  return { body, needsAccount };
}

function buildExpense(input: BuildProposalInput, lines: ReadonlyArray<ResolvedLine>, nif: string | null, notes: string[]): { body: ExpenseRequest; needsAccount: boolean } {
  const { fields, supplier } = input;
  const captured = capturedDate(input.capturedAt);
  const defaultAccount = textOf(supplier?.defaultExpenseAccountCode);
  const account = lines.find((l) => l.expenseAccountCode)?.expenseAccountCode ?? defaultAccount ?? FALLBACK_EXPENSE_ACCOUNT;
  const needsAccount = account === FALLBACK_EXPENSE_ACCOUNT && !defaultAccount;

  const baseFromLines = lines.length > 0 && lines.every((l) => l.base !== null) ? sum(lines.map((l) => l.base!)) : null;
  const total = optDec(fields.total);
  let rate = dominantRate(lines) ?? optDec(fields.taxRate);
  const baseTotal = optDec(fields.baseTotal);
  const taxTotal = optDec(fields.taxTotal);
  if (rate === null && baseTotal !== null && taxTotal !== null && !baseTotal.isZero()) rate = taxTotal.times(100).div(baseTotal).toDecimalPlaces(0);
  const base = baseFromLines ?? baseTotal ?? (total !== null && rate !== null ? round2(total.div(dec(1).plus(rate.div(100)))) : (total ?? ZERO));
  const rateCode = rate === null ? "0" : (taxRateCodeOf(rate) ?? rate.toDecimalPlaces(2).toString());
  if (rate === null) notes.push("Sin tipo de IVA extraído: se propone 0 %; corregir en la revisión.");
  const distinctRates = new Set(lines.map((l) => l.taxRate?.toString()).filter((r): r is string => typeof r === "string"));
  if (distinctRates.size > 1) notes.push("El ticket tiene varios tipos de IVA: el gasto admite uno solo (se propone el de mayor base).");
  const concept = textOf(lines[0]?.description) ?? textOf(fields.subject) ?? `Ticket ${documentNumberOf(fields) ?? dayOf(captured)}`;
  const supplierName = textOf(supplier?.name) ?? textOf(fields.supplierName) ?? (input.sageSupplier ? textOf(input.sageSupplier.name) : null) ?? "Proveedor sin identificar";

  const draft: ExpenseDraft = {
    date: isIsoDay(fields.issueDate) ? fields.issueDate : dayOf(captured),
    supplierName,
    supplierNif: nif,
    concept,
    accountCode: account,
    base: money(base),
    taxRate: rateCode,
    ...(total !== null && rateCode !== "0" && distinctRates.size <= 1 ? { total: money(total) } : {}),
    // The payment method is never read off the paper: the reviewer sets it (§7.1).
    paidWith: null,
    vatDeductible: nif !== null
  };
  if (draft.total !== undefined && !round2(base.plus(base.times(dec(rateCode)).div(100))).equals(round2(total!))) {
    delete draft.total;
    notes.push("El total impreso no cuadra con base × tipo: se deja que lo calcule el servicio.");
  }
  if (nif === null) notes.push("Ticket sin NIF válido: IVA no deducible (la cuota va a gasto).");
  return { body: draft as unknown as ExpenseRequest, needsAccount };
}

function buildGoodsReceipt(input: BuildProposalInput, lines: ReadonlyArray<ResolvedLine>, nif: string | null, notes: string[]): GoodsReceiptRequest {
  const { fields, supplier } = input;
  const captured = capturedDate(input.capturedAt);
  const number = textOf(fields.deliveryNoteNumber) ?? documentNumberOf(fields);
  if (!number) notes.push("Sin número de albarán extraído: obligatorio antes de aprobar.");
  const deliveryDate = isIsoDay(fields.deliveryDate) ? fields.deliveryDate : isIsoDay(fields.issueDate) ? fields.issueDate : dayOf(captured);
  const receiptLines: GoodsReceiptLineRequest[] = lines.map((line) => ({
    description: line.description,
    quantityReceived: line.quantity === null ? "1.000" : line.quantity.toDecimalPlaces(3).toFixed(3),
    ...(line.unitPrice !== null ? { unitPrice: line.unitPrice.toDecimalPlaces(4).toFixed(4) } : {}),
    ...(line.base !== null ? { base: money(line.base) } : {}),
    ...(line.taxRate !== null ? { taxRate: taxRateCodeOf(line.taxRate) ?? line.taxRate.toDecimalPlaces(2).toString() } : {})
  }));
  if (receiptLines.length === 0) {
    const total = optDec(fields.baseTotal) ?? optDec(fields.total);
    receiptLines.push({ description: `Mercancía según albarán ${number ?? "sin número"}`, quantityReceived: "1.000", ...(total !== null ? { base: money(total) } : {}) });
    notes.push("Sin líneas extraídas: se propone una línea única.");
  }
  return {
    ...(supplier ? { supplierId: supplier.id } : { supplierId: null, supplierName: (input.sageSupplier ? textOf(input.sageSupplier.name) : null) ?? textOf(fields.supplierName) ?? "Proveedor sin identificar", supplierTaxId: nif }),
    deliveryNoteNumber: number ?? "",
    deliveryDate,
    receivedBy: null,
    lines: receiptLines
  };
}

/** Deadline kind of §3.5 for a document (null = no legal deadline). */
export function deadlineKindOf(kind: IncomingDocumentKind, fields: ExtractedDocumentFields): DeadlineKind | null {
  switch (kind) {
    case "administrative_notice":
      if (fields.noticeKind === "traffic_fine") return "traffic_fine";
      if (fields.noticeKind === "aeat_requirement") return "aeat_requirement";
      return "administrative_notice";
    case "e_invoice_status":
      return "e_invoice";
    default:
      return null;
  }
}

function taskKindOf(kind: IncomingDocumentKind, fields: ExtractedDocumentFields): DocumentActionKind {
  if (kind === "administrative_notice") return fields.noticeKind === "traffic_fine" ? "pay" : "respond";
  if (kind === "e_invoice_status") return "verify";
  return "respond";
}

function buildTask(input: BuildProposalInput, notes: string[]): DocumentActionRequest {
  const { kind, fields } = input;
  const captured = capturedDate(input.capturedAt);
  // The paper notification usually is the notice of availability: the deadline counts from it (issue date if printed, else the capture).
  const notedAt = isIsoDay(fields.issueDate) ? new Date(`${fields.issueDate}T00:00:00.000Z`) : captured;
  const rule = deadlineKindOf(kind, fields);
  let dueAt: string | null = null;
  if (isIsoDay(fields.dueDate)) {
    dueAt = `${fields.dueDate}T00:00:00.000Z`;
  } else if (rule) {
    const computed = dueAtFor(rule, notedAt);
    dueAt = computed ? computed.toISOString() : null;
  }
  if (rule && !isIsoDay(fields.dueDate)) notes.push("Plazo por defecto de la norma (§3.5): el revisor lo corrige con la fecha del escrito.");
  const sender = textOf(fields.senderName) ?? textOf(fields.supplierName);
  const subject = textOf(fields.subject);
  const label = kind === "administrative_notice" ? (fields.noticeKind === "traffic_fine" ? "Sanción de tráfico" : fields.noticeKind === "aeat_requirement" ? "Requerimiento AEAT" : "Notificación administrativa") : kind === "e_invoice_status" ? "Comunicar estado de factura electrónica" : "Carta";
  const title = [label, subject ?? sender].filter(Boolean).join(" · ");
  return {
    kind: taskKindOf(kind, fields),
    title,
    ...(sender || subject ? { description: [sender ? `Remitente: ${sender}` : null, subject ? `Asunto: ${subject}` : null].filter(Boolean).join("\n") } : {}),
    assignedTo: null,
    dueAt
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Which action fits the document (§5.1): the kind decides, a missing NIF demotes an invoice to an expense, a letter without deadline is archived. */
export function proposedActionFor(kind: IncomingDocumentKind, fields: ExtractedDocumentFields, checks: DocumentChecks): DocumentProposedAction {
  switch (kind) {
    case "invoice":
      return validNifOf(checks) ? "create_supplier_bill" : "create_expense";
    case "receipt":
      return "create_expense";
    case "delivery_note":
      return "create_goods_receipt";
    case "administrative_notice":
    case "e_invoice_status":
      return "create_task";
    case "letter":
      return fields.requiresResponse === true || isIsoDay(fields.dueDate) ? "create_task" : "archive";
    default:
      return "archive";
  }
}

/** Builds the proposal (complete body of the action) for one document. Pure. */
export function buildProposal(input: BuildProposalInput): BuiltProposal {
  const notes: string[] = [];
  const lines = resolveLines(input.fields);
  const nif = validNifOf(input.checks);
  const action = proposedActionFor(input.kind, input.fields, input.checks);
  const vatDetails = checkDetails(input.checks, "vat");
  const needsManual = vatDetails.needsManual === true;
  if (needsManual) notes.push(`IVA fuera del flujo automático (${String(vatDetails.reason ?? "motivo sin detallar")}): la factura se registra a mano.`);
  if (input.kind === "invoice" && action === "create_expense") notes.push("Factura sin NIF válido del proveedor: se propone gasto con IVA no deducible (§7.1).");
  if (input.propertyKind === "office") notes.push("Documento capturado en la oficina central: la acción se ejecuta en ese centro.");

  const base: BuiltProposal = { action, targetPropertyId: input.propertyId, needsAccount: false, needsManual, notes };
  const supplierProposal = supplierProposalOf(input, nif);

  switch (action) {
    case "create_supplier_bill": {
      const built = buildSupplierBill(input, lines, nif, notes);
      return { ...base, supplierBill: built.body, needsAccount: built.needsAccount, ...(supplierProposal ? { supplierProposal } : {}) };
    }
    case "create_expense": {
      const built = buildExpense(input, lines, nif, notes);
      return { ...base, expense: built.body, needsAccount: built.needsAccount, ...(supplierProposal ? { supplierProposal } : {}) };
    }
    case "create_goods_receipt":
      return { ...base, goodsReceipt: buildGoodsReceipt(input, lines, nif, notes), ...(supplierProposal ? { supplierProposal } : {}) };
    case "create_task":
      return { ...base, task: buildTask(input, notes) };
    default:
      return base;
  }
}
