// Panel de revisión de un documento digitalizado (Tanda T9 · lote T9-12,
// diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §10 «Bandeja y revisión»):
// el `inspector` del CocoaSplitView de Finanzas › Proveedores y gastos ›
// Documentos (IncomingDocumentsScreen). Pinta, de arriba abajo: los cuatro
// pasos del pipeline (Clasificado → Extraído → Validado → Propuesta) como
// insignias con `aria-current="step"`; el aviso «IA no configurada» cuando la
// extracción no vino de un proveedor (extractor de texto o manual: nunca campos
// inventados); los campos extraídos con su CocoaBadge de confianza
// (confidenceTone, umbrales de §10) y clic → página de origen (`onFocusPage`);
// las comprobaciones del servidor (CocoaCallout por warn/fail: NIF, proveedor
// desconocido → «Dar de alta desde Sage» si `supplierProposal.fromSage`,
// totales, IVA, duplicado con enlace, cotejo); el formulario de la acción
// propuesta (SupplierBillForm en modo review pre-rellenado con
// billFormFromRequest(proposal.supplierBill), o gasto / recepción / tarea /
// archivo) y el pie CocoaActionBar «Aprobar y crear factura» · «Crear gasto» ·
// «Crear recepción» · «Crear tarea» · «Archivar» / «Devolver al centro»
// (CocoaDialog destructivo con motivo) / «Rechazar».
//
// Presentacional: no toca la red. La pantalla le pasa el detalle, el directorio
// de proveedores, el plan de cuentas (useChartAccounts) y los callbacks; se
// monta con `key={document.id}` para que los borradores arranquen de cero al
// cambiar de documento, dentro del <CocoaPage> de la pantalla (sin cabecera
// propia) y sin estilos inline (Cocoa 22).
//
// Este fichero es el único del lote que carga bajo `node --test` (Cocoa +
// SupplierBillForm + lib/format), así que aloja también los helpers puros de la
// bandeja de la oficina (segmentos, filtro «solo vencidos», agrupación por
// centro, filas de campos extraídos, borradores de gasto / recepción / tarea):
// screens/documents/__tests__/documents-office-contract.test.mts los prueba.
// Mover a documents-helpers.ts al cerrar la tanda (como los de T9-10).

import { useMemo, useState } from "react";
import type {
  DocumentActionKind,
  DocumentActionRequest,
  DocumentApproveRequest,
  DocumentCheck,
  DocumentCheckKey,
  DocumentChecks,
  DocumentExtractionDto,
  DocumentProposedAction,
  DocumentRejectReason,
  DocumentRejectRequest,
  DocumentSupplierProposal,
  ExpensePaidWith,
  ExpenseRequest,
  GoodsReceiptLineRequest,
  GoodsReceiptRequest,
  IncomingDocumentDetail,
  IncomingDocumentKind,
  IncomingDocumentRecord,
  IncomingDocumentStatus,
  SupplierDto
} from "@hotelos/shared";
import { DOCUMENT_ACTION_KINDS, DOCUMENT_CHECK_KEYS, DOCUMENT_PROPOSED_ACTIONS, EXPENSE_PAID_WITH } from "@hotelos/shared";
import { CocoaActionBar, CocoaBadge, CocoaButton, CocoaCallout, CocoaDatePicker, CocoaDialog, CocoaField, CocoaFormRow, CocoaFormSection, CocoaInput, CocoaSelect, CocoaSwitch } from "../../components/cocoa";
import type { CocoaSelectOption } from "../../components/cocoa/CocoaSelect";
import { ACTIONS } from "../../content/actions";
import { date, isoDate, money, plural, toNumber, type DateInput } from "../../lib/format";
import type { InventoryItem, StockLocation } from "../../services/fnbInventoryApi";
import { PAID_WITH_LABELS, TAX_RATE_OPTIONS, accountOptions, decimalInput, isExpenseAccount, todayIso } from "../payables/payables-helpers";
import type { ChartState } from "../payables/payables-shared";
import { SupplierBillForm, billFormFromRequest, billFormToRequest, emptyBillForm, validateBillForm, type BillForm, type BillFormErrors } from "../payables/SupplierBillForm";
import { CHECK_LABELS, DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, PROPOSED_ACTION_LABELS, REJECT_REASON_LABELS, checkTone, confidenceTone, formatRegistry, groupByProperty, type PropertyGroup, type PropertyRow } from "./documents-helpers";

// ---------------------------------------------------------------------------
// Copy fijo (anclado por el test de contrato)
// ---------------------------------------------------------------------------

/** Sin proveedor de IA (§10): los campos vienen del extractor de texto o los teclea la persona; nunca se inventan. */
export const AI_NOT_CONFIGURED_COPY = "IA no configurada (AI_PROVIDER=none): campos por extractor de texto o manual";
/** Separación de funciones tras crear la factura (§7.1): quien aprueba el documento queda como registrador. */
export const SOD_NOTICE = "Quedas como registrador: otra persona aprobará y pagará.";
export const NO_REVIEW_PERMISSION = "Necesitas el permiso de revisión de documentos";
/** SLA de la oficina por defecto (DocumentSettings.officeSlaBusinessDays, §6.3): respaldo cuando los KPIs (que traen `officeSlaBusinessDays`, RV-14) aún no han cargado o el usuario no tiene ámbito de sociedad. */
export const OFFICE_SLA_BUSINESS_DAYS = 2;

// ---------------------------------------------------------------------------
// Bandeja de la oficina: segmentos, vencidos y agrupación por centro (puros)
// ---------------------------------------------------------------------------

export type QueueSegment = "pending" | "in_review" | "approved" | "returned" | "archive";

export type QueueSegmentSpec = { value: QueueSegment; label: string; statuses: IncomingDocumentStatus[] };

/** Los cinco segmentos del CocoaSegmentedControl de la bandeja y los estados de §6.1 que agrupan. */
export const QUEUE_SEGMENTS: readonly QueueSegmentSpec[] = Object.freeze([
  { value: "pending", label: "Pendientes", statuses: ["sent_to_office"] },
  { value: "in_review", label: "En revisión", statuses: ["in_review"] },
  { value: "approved", label: "Aprobados", statuses: ["approved", "posted"] },
  { value: "returned", label: "Devueltos", statuses: ["returned_to_centre", "rejected"] },
  { value: "archive", label: "Archivo", statuses: ["archived"] }
]);

export function segmentStatuses(segment: string): IncomingDocumentStatus[] {
  return QUEUE_SEGMENTS.find((spec) => spec.value === segment)?.statuses ?? QUEUE_SEGMENTS[0].statuses;
}

export function isQueueSegment(value: string): value is QueueSegment {
  return QUEUE_SEGMENTS.some((spec) => spec.value === value);
}

export type OverdueLike = Pick<IncomingDocumentRecord, "slaBreached" | "dueAt">;

/** Vencido: SLA de la oficina incumplido (lo calcula el servidor) o plazo de la tarea (`dueAt`) anterior a `now`. */
export function isOverdue(row: OverdueLike, now: DateInput = new Date()): boolean {
  if (row.slaBreached) return true;
  if (!row.dueAt) return false;
  const due = new Date(row.dueAt).getTime();
  const at = now instanceof Date ? now.getTime() : new Date(now ?? Date.now()).getTime();
  return Number.isFinite(due) && Number.isFinite(at) && due < at;
}

/** Filtro «solo vencidos» de la cola de la oficina; `now` para las pruebas. */
export function filterOverdue<T extends OverdueLike>(rows: readonly T[], now: DateInput = new Date()): T[] {
  return rows.filter((row) => isOverdue(row, now));
}

export type CentreLike = { id: string; code: string | null; name: string };

export type CentreRow<T> = T & PropertyRow;

/** Filas de la cola (`propertyId`) agrupadas por centro con el código y el nombre de la estructura (`Property.code`); un centro desconocido agrupa por id. */
export function groupQueueByCentre<T extends { propertyId: string }>(rows: readonly T[], centres: readonly CentreLike[]): PropertyGroup<CentreRow<T>>[] {
  const byId = new Map(centres.map((centre) => [centre.id, centre] as const));
  const decorated = rows.map((row) => {
    const centre = byId.get(row.propertyId);
    return { ...row, propertyCode: centre?.code ?? null, propertyName: centre?.name ?? null } as CentreRow<T>;
  });
  return groupByProperty(decorated);
}

/** «AMC · Hotel Demo» · «Hotel Demo» · el id cuando la estructura no conoce el centro. */
export function centreGroupTitle(group: Pick<PropertyGroup<PropertyRow>, "propertyId" | "propertyCode" | "propertyName">): string {
  if (group.propertyCode && group.propertyName) return `${group.propertyCode} · ${group.propertyName}`;
  return group.propertyName ?? group.propertyCode ?? group.propertyId;
}

// ---------------------------------------------------------------------------
// Pasos del pipeline
// ---------------------------------------------------------------------------

export type ReviewStepKey = "classified" | "extracted" | "validated" | "proposed";
export type ReviewStepState = "done" | "current" | "pending" | "failed";

export const REVIEW_STEPS: ReadonlyArray<{ key: ReviewStepKey; label: string }> = Object.freeze([
  { key: "classified", label: "Clasificado" },
  { key: "extracted", label: "Extraído" },
  { key: "validated", label: "Validado" },
  { key: "proposed", label: "Propuesta" }
]);

type StepInput = Pick<IncomingDocumentRecord, "kind" | "classificationSource" | "extractionStatus" | "proposedAction"> & { checks: DocumentChecks | null; extraction: DocumentExtractionDto | null };

/** Estado de cada paso a partir del detalle: el primero no terminado es `current`; una extracción fallida marca `failed`. */
export function reviewStepStates(doc: StepInput): Record<ReviewStepKey, ReviewStepState> {
  const classified = doc.kind !== "unknown" || doc.classificationSource !== null;
  const extracted = doc.extractionStatus === "done" || doc.extractionStatus === "skipped" || doc.extraction !== null;
  const failed = doc.extractionStatus === "failed";
  const validated = doc.checks !== null;
  const proposed = doc.proposedAction !== null;
  const states: Record<ReviewStepKey, ReviewStepState> = { classified: "pending", extracted: "pending", validated: "pending", proposed: "pending" };
  let currentSet = false;
  const mark = (key: ReviewStepKey, done: boolean, isFailed = false) => {
    if (isFailed) {
      states[key] = "failed";
      currentSet = true;
      return;
    }
    if (done) states[key] = "done";
    else if (!currentSet) {
      states[key] = "current";
      currentSet = true;
    }
  };
  mark("classified", classified);
  mark("extracted", extracted && !failed, failed);
  mark("validated", validated);
  mark("proposed", proposed);
  return states;
}

const STEP_TONES: Record<ReviewStepState, "success" | "accent" | "neutral" | "danger"> = { done: "success", current: "accent", pending: "neutral", failed: "danger" };

/** La extracción vino de un proveedor de IA (ai-core); `text_rules`, `manual`, `e_invoice` o ninguna → sin IA. */
export function aiConfiguredFrom(extraction: DocumentExtractionDto | null): boolean {
  return extraction?.source === "ai";
}

// ---------------------------------------------------------------------------
// Campos extraídos con confianza
// ---------------------------------------------------------------------------

/** Etiquetas de los campos de los esquemas por tipo (extraction-schemas.ts); una clave desconocida se pinta tal cual. */
export const EXTRACTED_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  supplierName: "Proveedor",
  supplierTaxId: "NIF del proveedor",
  invoiceNumber: "Nº de factura",
  documentNumber: "Nº de documento",
  issueDate: "Fecha de emisión",
  dueDate: "Vencimiento",
  base: "Base imponible",
  baseTotal: "Base imponible",
  tax: "Cuota de IVA",
  taxTotal: "Cuota de IVA",
  taxRate: "Tipo de IVA",
  retention: "Retención IRPF",
  retentionRate: "Tipo de retención",
  total: "Total",
  currency: "Moneda",
  deliveryNoteNumber: "Nº de albarán",
  deliveryNoteRefs: "Albaranes citados",
  deliveryDate: "Fecha de entrega",
  purchaseOrderNumber: "Nº de pedido",
  sender: "Remitente",
  senderName: "Remitente",
  senderTaxId: "NIF del remitente",
  subject: "Asunto",
  deadlineDate: "Plazo",
  noticeKind: "Tipo de notificación",
  requiresResponse: "Requiere respuesta",
  concept: "Concepto",
  paymentMethod: "Forma de pago",
  customerName: "Destinatario",
  customerTaxId: "NIF del destinatario"
});

export type UnwrappedField = { value: unknown; confidence: number | null; page: number | null };

/** Un campo del esquema puede venir plano o como `{ value, confidence, page }` (fieldSchema de extraction-schemas.ts). */
export function unwrapField(raw: unknown): UnwrappedField {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as Record<string, unknown>)) {
    const box = raw as { value?: unknown; confidence?: unknown; page?: unknown };
    return { value: box.value ?? null, confidence: toNumber(box.confidence as number | string | null | undefined), page: toNumber(box.page as number | string | null | undefined) };
  }
  return { value: raw, confidence: null, page: null };
}

/** Texto de un valor extraído: cadenas y números tal cual, booleanos «Sí/No», listas «a · b», objetos «n elementos». */
export function fieldDisplay(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) return value.map(String).join(" · ");
    return plural(value.length, "elemento", "elementos");
  }
  return "";
}

export type ExtractedFieldRow = {
  key: string;
  label: string;
  /** Valor pintado (el revisado si existe; si no, el extraído). */
  value: string;
  /** Confianza 0..1 del extractor; null cuando el revisor lo escribió (badge «Manual»). */
  confidence: number | null;
  page: number | null;
  reviewed: boolean;
};

const HIDDEN_FIELD_KEYS = new Set(["lines", "taxBreakdown"]);

/** Filas de campos escalares de la última extracción (líneas y desgloses viven en el formulario); las claves revisadas pisan el valor y pasan a «Manual». */
export function extractedFieldRows(extraction: DocumentExtractionDto | null, reviewedFields: Record<string, unknown> | null): ExtractedFieldRow[] {
  const rows: ExtractedFieldRow[] = [];
  const seen = new Set<string>();
  const reviewed = reviewedFields ?? {};
  for (const [key, raw] of Object.entries(extraction?.fields ?? {})) {
    if (HIDDEN_FIELD_KEYS.has(key)) continue;
    const box = unwrapField(raw);
    if (box.value !== null && typeof box.value === "object" && !Array.isArray(box.value)) continue;
    seen.add(key);
    const isReviewed = Object.hasOwn(reviewed, key);
    const confidence = isReviewed ? null : box.confidence ?? toNumber(extraction?.confidence?.[key] as number | undefined);
    rows.push({ key, label: EXTRACTED_FIELD_LABELS[key] ?? key, value: fieldDisplay(isReviewed ? reviewed[key] : box.value), confidence, page: box.page, reviewed: isReviewed });
  }
  for (const [key, value] of Object.entries(reviewed)) {
    if (seen.has(key) || HIDDEN_FIELD_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) continue;
    rows.push({ key, label: EXTRACTED_FIELD_LABELS[key] ?? key, value: fieldDisplay(value), confidence: null, page: null, reviewed: true });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Comprobaciones y acciones
// ---------------------------------------------------------------------------

export function failedChecks(checks: DocumentChecks | null): DocumentCheckKey[] {
  if (!checks) return [];
  return DOCUMENT_CHECK_KEYS.filter((key) => checks[key]?.status === "fail");
}

export function warnedChecks(checks: DocumentChecks | null): DocumentCheckKey[] {
  if (!checks) return [];
  return DOCUMENT_CHECK_KEYS.filter((key) => checks[key]?.status === "warn");
}

/** Etiqueta del botón primario por acción (§10 «pie CocoaActionBar»). */
export const APPROVE_LABELS: Readonly<Record<DocumentProposedAction, string>> = Object.freeze({
  create_supplier_bill: "Aprobar y crear factura",
  create_expense: "Crear gasto",
  create_goods_receipt: "Crear recepción",
  create_task: "Crear tarea",
  archive: "Archivar"
});

/** Acciones que tienen sentido para un tipo (§7): la propuesta del servidor va primero si es una de ellas. */
export function actionsForKind(kind: IncomingDocumentKind, proposed: DocumentProposedAction | null): DocumentProposedAction[] {
  const base: DocumentProposedAction[] = (() => {
    switch (kind) {
      case "invoice":
        return ["create_supplier_bill", "create_expense", "archive"];
      case "receipt":
        return ["create_expense", "create_supplier_bill", "archive"];
      case "delivery_note":
        return ["create_goods_receipt", "archive"];
      case "letter":
      case "administrative_notice":
      case "contract":
      case "e_invoice_status":
      case "other":
        return ["create_task", "archive"];
      default:
        return [...DOCUMENT_PROPOSED_ACTIONS];
    }
  })();
  if (proposed && !base.includes(proposed)) return [proposed, ...base];
  if (proposed) return [proposed, ...base.filter((action) => action !== proposed)];
  return base;
}

export const TASK_KIND_LABELS: Readonly<Record<DocumentActionKind, string>> = Object.freeze({
  respond: "Responder",
  pay: "Pagar",
  file: "Archivar",
  forward: "Reenviar",
  verify: "Comprobar"
});

// ---------------------------------------------------------------------------
// Borradores de gasto, recepción y tarea (puros)
// ---------------------------------------------------------------------------

export type ExpenseDraft = {
  date: string;
  supplierName: string;
  supplierNif: string;
  concept: string;
  accountCode: string;
  base: string;
  taxRate: string;
  quota: string;
  /** Obligatorio al aprobar (la propuesta lo deja vacío: el revisor lo fija). */
  paidWith: "" | ExpensePaidWith;
  vatDeductible: boolean;
};

type ExpenseProposal = Omit<ExpenseRequest, "paidWith"> & { paidWith?: ExpensePaidWith | null };

function decimalText(value: number | string | null | undefined): string {
  const parsed = toNumber(value);
  return parsed === null ? "" : String(parsed).replace(".", ",");
}

/** Borrador de gasto desde la propuesta (`proposal.expense`, paidWith null) o vacío con la fecha de captura. */
export function expenseDraftFrom(proposal: ExpenseProposal | null | undefined, fallbackDate: string): ExpenseDraft {
  return {
    date: proposal?.date ?? fallbackDate,
    supplierName: proposal?.supplierName ?? "",
    supplierNif: proposal?.supplierNif ?? "",
    concept: proposal?.concept ?? "",
    accountCode: proposal?.accountCode ?? "",
    base: decimalText(proposal?.base),
    taxRate: proposal?.taxRate !== undefined && proposal?.taxRate !== null ? String(toNumber(proposal.taxRate) ?? "") : "21",
    quota: decimalText(proposal?.quota),
    paidWith: (proposal?.paidWith as ExpensePaidWith | null | undefined) ?? "",
    vatDeductible: proposal?.vatDeductible ?? Boolean(proposal?.supplierNif)
  };
}

export type ExpenseDraftErrors = Partial<Record<keyof ExpenseDraft, string>>;

export function validateExpenseDraft(draft: ExpenseDraft): ExpenseDraftErrors {
  const errors: ExpenseDraftErrors = {};
  if (!draft.date) errors.date = "Indica la fecha del gasto.";
  if (!draft.supplierName.trim()) errors.supplierName = "Nombre del proveedor o establecimiento.";
  if (!draft.concept.trim()) errors.concept = "Concepto obligatorio.";
  if (!draft.accountCode.trim()) errors.accountCode = "Elige la cuenta.";
  else if (!isExpenseAccount(draft.accountCode.trim())) errors.accountCode = "Subcuenta del grupo 6.";
  const base = decimalInput(draft.base);
  if (base === null || Number(base) <= 0) errors.base = "Mayor que cero.";
  if (draft.quota.trim() && decimalInput(draft.quota) === null) errors.quota = "Dos decimales como máximo.";
  if (!draft.paidWith) errors.paidWith = "Indica cómo se pagó (efectivo, tarjeta o banco).";
  return errors;
}

export function expenseDraftToRequest(draft: ExpenseDraft): ExpenseRequest {
  const quota = draft.quota.trim() ? decimalInput(draft.quota) : null;
  return {
    date: draft.date,
    supplierName: draft.supplierName.trim(),
    supplierNif: draft.supplierNif.trim() ? draft.supplierNif.trim().toUpperCase() : null,
    concept: draft.concept.trim(),
    accountCode: draft.accountCode.trim(),
    base: decimalInput(draft.base) ?? "0.00",
    taxRate: draft.taxRate,
    ...(quota ? { quota } : {}),
    paidWith: (draft.paidWith || "cash") as ExpensePaidWith,
    vatDeductible: draft.vatDeductible
  };
}

export type ReceiptLineDraft = { key: string; description: string; quantityReceived: string; unit: string; unitPrice: string; base: string; taxRate: string; inventoryItemId: string };

export type ReceiptDraft = {
  supplierId: string;
  supplierName: string;
  supplierTaxId: string;
  deliveryNoteNumber: string;
  deliveryDate: string;
  stockLocationId: string;
  note: string;
  lines: ReceiptLineDraft[];
};

let receiptLineSeq = 0;
export function newReceiptLine(): ReceiptLineDraft {
  receiptLineSeq += 1;
  return { key: `r${receiptLineSeq}`, description: "", quantityReceived: "1", unit: "", unitPrice: "", base: "", taxRate: "", inventoryItemId: "" };
}

function receiptLineFrom(line: GoodsReceiptLineRequest): ReceiptLineDraft {
  return {
    ...newReceiptLine(),
    description: line.description ?? "",
    quantityReceived: decimalText(line.quantityReceived) || "1",
    unit: line.unit ?? "",
    unitPrice: decimalText(line.unitPrice),
    base: decimalText(line.base),
    taxRate: line.taxRate === null || line.taxRate === undefined ? "" : String(toNumber(line.taxRate) ?? ""),
    inventoryItemId: line.inventoryItemId ?? ""
  };
}

/** Borrador de recepción desde la propuesta (`proposal.goodsReceipt`) o vacío (alta manual) con la fecha dada. */
export function receiptDraftFrom(proposal: GoodsReceiptRequest | null | undefined, fallbackDate: string): ReceiptDraft {
  const lines = (proposal?.lines ?? []).map(receiptLineFrom);
  return {
    supplierId: proposal?.supplierId ?? "",
    supplierName: proposal?.supplierName ?? "",
    supplierTaxId: proposal?.supplierTaxId ?? "",
    deliveryNoteNumber: proposal?.deliveryNoteNumber ?? "",
    deliveryDate: proposal?.deliveryDate ?? fallbackDate,
    stockLocationId: proposal?.stockLocationId ?? "",
    note: proposal?.note ?? "",
    lines: lines.length > 0 ? lines : [newReceiptLine()]
  };
}

export type ReceiptDraftErrors = Partial<Record<Exclude<keyof ReceiptDraft, "lines">, string>> & { lines?: Record<string, Partial<Record<keyof ReceiptLineDraft, string>>> };

const decimalOk = (raw: string, scale: number): boolean => new RegExp(`^\\d+(?:[.,]\\d{1,${scale}})?$`).test(raw.trim());

export function validateReceiptDraft(draft: ReceiptDraft): ReceiptDraftErrors {
  const errors: ReceiptDraftErrors = {};
  if (!draft.supplierId && !draft.supplierName.trim()) errors.supplierName = "Elige un proveedor del directorio o escribe su nombre.";
  if (!draft.deliveryNoteNumber.trim()) errors.deliveryNoteNumber = "El número del albarán es obligatorio.";
  if (!draft.deliveryDate) errors.deliveryDate = "Indica la fecha de entrega.";
  const lines: NonNullable<ReceiptDraftErrors["lines"]> = {};
  for (const line of draft.lines) {
    const e: Partial<Record<keyof ReceiptLineDraft, string>> = {};
    if (!line.description.trim()) e.description = "Obligatoria.";
    if (!decimalOk(line.quantityReceived, 3) || Number(line.quantityReceived.replace(",", ".")) <= 0) e.quantityReceived = "Cantidad mayor que cero (3 decimales).";
    if (line.unitPrice.trim() && !decimalOk(line.unitPrice, 4)) e.unitPrice = "Precio con 4 decimales como máximo.";
    if (line.base.trim() && decimalInput(line.base) === null) e.base = "Dos decimales como máximo.";
    if (Object.keys(e).length > 0) lines[line.key] = e;
  }
  if (Object.keys(lines).length > 0) errors.lines = lines;
  return errors;
}

const wireDecimal = (raw: string): string => raw.trim().replace(",", ".");

export function receiptDraftToRequest(draft: ReceiptDraft): GoodsReceiptRequest {
  return {
    ...(draft.supplierId ? { supplierId: draft.supplierId } : { supplierId: null, supplierName: draft.supplierName.trim(), supplierTaxId: draft.supplierTaxId.trim() ? draft.supplierTaxId.trim().toUpperCase() : null }),
    deliveryNoteNumber: draft.deliveryNoteNumber.trim(),
    deliveryDate: draft.deliveryDate,
    ...(draft.stockLocationId ? { stockLocationId: draft.stockLocationId } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    lines: draft.lines.map((line) => ({
      description: line.description.trim(),
      quantityReceived: wireDecimal(line.quantityReceived),
      ...(line.unit.trim() ? { unit: line.unit.trim() } : {}),
      ...(line.unitPrice.trim() ? { unitPrice: wireDecimal(line.unitPrice) } : {}),
      ...(line.base.trim() ? { base: decimalInput(line.base) ?? undefined } : {}),
      ...(line.taxRate ? { taxRate: line.taxRate } : {}),
      ...(line.inventoryItemId ? { inventoryItemId: line.inventoryItemId } : {})
    }))
  };
}

export type TaskDraft = { kind: DocumentActionKind; title: string; description: string; dueOn: string };

/** Borrador de tarea desde la propuesta (`proposal.task`, dueAt ISO → día) o uno vacío con el título dado. */
export function taskDraftFrom(proposal: DocumentActionRequest | null | undefined, fallbackTitle: string): TaskDraft {
  return {
    kind: proposal?.kind ?? "respond",
    title: proposal?.title ?? fallbackTitle,
    description: proposal?.description ?? "",
    dueOn: proposal?.dueAt ? isoDate(proposal.dueAt) ?? "" : ""
  };
}

export function validateTaskDraft(draft: TaskDraft): Partial<Record<keyof TaskDraft, string>> {
  const errors: Partial<Record<keyof TaskDraft, string>> = {};
  if (!draft.title.trim()) errors.title = "Título obligatorio.";
  return errors;
}

export function taskDraftToRequest(draft: TaskDraft): DocumentActionRequest {
  return {
    kind: draft.kind,
    title: draft.title.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    dueAt: draft.dueOn ? `${draft.dueOn}T00:00:00.000Z` : null
  };
}

const RETURN_REASONS: DocumentRejectReason[] = ["illegible", "missing_pages", "other"];
const FINAL_REJECT_REASONS: DocumentRejectReason[] = ["duplicate", "not_ours", "other"];

/** Motivos que admite «Devolver al centro» (vuelve a captured) frente a «Rechazar» (cierra). */
export function rejectReasonOptions(returnToCentre: boolean): CocoaSelectOption[] {
  return (returnToCentre ? RETURN_REASONS : FINAL_REJECT_REASONS).map((reason) => ({ value: reason, label: REJECT_REASON_LABELS[reason] }));
}

// ---------------------------------------------------------------------------
// Formulario de recepción (lo monta también Operaciones › Compras › Recepciones)
// ---------------------------------------------------------------------------

export interface GoodsReceiptFormProps {
  value: ReceiptDraft;
  onChange: (next: ReceiptDraft) => void;
  errors?: ReceiptDraftErrors;
  suppliers: { rows: SupplierDto[]; loading?: boolean; error?: string | null };
  /** Artículos y ubicaciones opcionales (con artículo, la recepción mueve existencias). */
  inventory?: { items: InventoryItem[]; locations: StockLocation[] };
  disabled?: boolean;
}

export function GoodsReceiptForm({ value, onChange, errors = {}, suppliers, inventory, disabled = false }: GoodsReceiptFormProps) {
  const supplierOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Proveedor nuevo o sin dar de alta" }, ...suppliers.rows.map((s) => ({ value: s.id, label: s.taxId ? `${s.name} · ${s.taxId}` : s.name }))], [suppliers.rows]);
  const itemOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Sin artículo (no mueve existencias)" }, ...(inventory?.items ?? []).map((item) => ({ value: item.id, label: item.sku ? `${item.sku} · ${item.name}` : item.name }))], [inventory?.items]);
  const locationOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Sin ubicación" }, ...(inventory?.locations ?? []).map((location) => ({ value: location.id, label: location.name }))], [inventory?.locations]);
  const set = <K extends keyof ReceiptDraft>(key: K, next: ReceiptDraft[K]) => onChange({ ...value, [key]: next });
  const setLine = (key: string, patch: Partial<ReceiptLineDraft>) => onChange({ ...value, lines: value.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) });
  const lineError = (key: string, field: keyof ReceiptLineDraft) => errors.lines?.[key]?.[field];
  const taxOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Sin IVA en el albarán" }, ...TAX_RATE_OPTIONS], []);

  return (
    <div className="cocoa-stack" data-gap="4">
      <CocoaFormSection title="Albarán" description={suppliers.error ?? undefined} columns={2}>
        <CocoaField label="Proveedor del directorio" fullWidth>
          <CocoaSelect value={value.supplierId} onChange={(id) => set("supplierId", id)} options={supplierOptions} disabled={disabled || suppliers.loading} />
        </CocoaField>
        {!value.supplierId ? (
          <>
            <CocoaField label="Nombre del proveedor" required error={errors.supplierName}>
              <CocoaInput value={value.supplierName} onChange={(v) => set("supplierName", v)} disabled={disabled} error={Boolean(errors.supplierName)} />
            </CocoaField>
            <CocoaField label="NIF" help="Opcional; se normaliza en mayúsculas.">
              <CocoaInput value={value.supplierTaxId} onChange={(v) => set("supplierTaxId", v)} disabled={disabled} />
            </CocoaField>
          </>
        ) : null}
        <CocoaField label="Nº de albarán" required error={errors.deliveryNoteNumber}>
          <CocoaInput value={value.deliveryNoteNumber} onChange={(v) => set("deliveryNoteNumber", v)} disabled={disabled} error={Boolean(errors.deliveryNoteNumber)} />
        </CocoaField>
        <CocoaField label="Fecha de entrega" required error={errors.deliveryDate}>
          <CocoaDatePicker value={value.deliveryDate} onChange={(v) => set("deliveryDate", v)} disabled={disabled} error={Boolean(errors.deliveryDate)} arithmetic />
        </CocoaField>
        {inventory ? (
          <CocoaField label="Ubicación de almacén" help="Solo si alguna línea lleva artículo.">
            <CocoaSelect value={value.stockLocationId} onChange={(v) => set("stockLocationId", v)} options={locationOptions} disabled={disabled} />
          </CocoaField>
        ) : null}
        <CocoaField label="Nota" fullWidth>
          <CocoaInput value={value.note} onChange={(v) => set("note", v)} disabled={disabled} multiline rows={2} />
        </CocoaField>
      </CocoaFormSection>

      <CocoaFormSection
        title={`Líneas (${value.lines.length})`}
        actions={
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => onChange({ ...value, lines: [...value.lines, newReceiptLine()] })} disabled={disabled}>
            Añadir línea
          </CocoaButton>
        }
      >
        <div className="cocoa-stack" data-gap="3">
          {value.lines.map((line, index) => (
            <div key={line.key} className="cocoa-stack" data-gap="2" role="group" aria-label={`Línea ${index + 1}`}>
              <CocoaFormRow columns={3} min={160}>
                <CocoaField label="Descripción" required error={lineError(line.key, "description")} fullWidth>
                  <CocoaInput value={line.description} onChange={(v) => setLine(line.key, { description: v })} disabled={disabled} error={Boolean(lineError(line.key, "description"))} />
                </CocoaField>
                <CocoaField label="Cantidad" required error={lineError(line.key, "quantityReceived")}>
                  <CocoaInput value={line.quantityReceived} onChange={(v) => setLine(line.key, { quantityReceived: v })} inputMode="decimal" disabled={disabled} error={Boolean(lineError(line.key, "quantityReceived"))} />
                </CocoaField>
                <CocoaField label="Unidad">
                  <CocoaInput value={line.unit} onChange={(v) => setLine(line.key, { unit: v })} placeholder="ud, kg, l" disabled={disabled} />
                </CocoaField>
                <CocoaField label="Precio unitario" error={lineError(line.key, "unitPrice")}>
                  <CocoaInput value={line.unitPrice} onChange={(v) => setLine(line.key, { unitPrice: v })} inputMode="decimal" disabled={disabled} error={Boolean(lineError(line.key, "unitPrice"))} />
                </CocoaField>
                <CocoaField label="Base" error={lineError(line.key, "base")}>
                  <CocoaInput value={line.base} onChange={(v) => setLine(line.key, { base: v })} inputMode="decimal" disabled={disabled} error={Boolean(lineError(line.key, "base"))} />
                </CocoaField>
                <CocoaField label="Tipo de IVA">
                  <CocoaSelect value={line.taxRate} onChange={(v) => setLine(line.key, { taxRate: v })} options={taxOptions} disabled={disabled} />
                </CocoaField>
                {inventory ? (
                  <CocoaField label="Artículo de inventario" fullWidth>
                    <CocoaSelect value={line.inventoryItemId} onChange={(v) => setLine(line.key, { inventoryItemId: v })} options={itemOptions} disabled={disabled} />
                  </CocoaField>
                ) : null}
              </CocoaFormRow>
              {value.lines.length > 1 ? (
                <div className="cocoa-row" data-justify="end">
                  <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => onChange({ ...value, lines: value.lines.filter((l) => l.key !== line.key) })} disabled={disabled}>
                    Quitar línea
                  </CocoaButton>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </CocoaFormSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// El panel
// ---------------------------------------------------------------------------

export type ReviewOutcome = {
  action: DocumentProposedAction;
  reviewedFields: Record<string, unknown>;
  body: DocumentApproveRequest;
};

export interface DocumentReviewPaneProps {
  document: IncomingDocumentDetail;
  suppliers: { rows: SupplierDto[]; loading?: boolean; error?: string | null };
  accounts: ChartState;
  inventory?: { items: InventoryItem[]; locations: StockLocation[] };
  canReview: boolean;
  busy: boolean;
  /** Página de origen del campo pulsado (null = ninguna): el visor la resalta. */
  onFocusPage: (page: number | null) => void;
  /** Enlace del duplicado (`checks.duplicate.details.documentId`). */
  onOpenDocument: (documentId: string) => void;
  /** «Dar de alta desde Sage»: crea el proveedor y devuelve la fila (o null si falló); el formulario pasa a usarla. */
  onCreateSupplier: (proposal: DocumentSupplierProposal) => Promise<SupplierDto | null>;
  /** «Empezar revisión» (assign a la persona): sent_to_office → in_review. */
  onStartReview: () => Promise<void>;
  onApprove: (outcome: ReviewOutcome) => Promise<void>;
  onReject: (body: DocumentRejectRequest) => Promise<void>;
}

function proposalSupplierBill(doc: IncomingDocumentDetail): BillForm {
  const request = doc.proposal?.supplierBill;
  if (request) return billFormFromRequest(request);
  const form = emptyBillForm();
  return { ...form, supplierId: doc.supplierId ?? "", supplierName: doc.supplierName ?? "", supplierTaxId: doc.supplierTaxId ?? "", invoiceNumber: doc.documentNumber ?? "", issueDate: doc.documentDate ?? form.issueDate, expectedTotal: doc.totalAmount ? String(toNumber(doc.totalAmount) ?? "").replace(".", ",") : "" };
}

function checkDetailText(key: DocumentCheckKey, check: DocumentCheck): string | null {
  const details = check.details ?? {};
  if (key === "totals" && details.computedTotal) return `Calculado ${money(String(details.computedTotal))}${details.printedTotal ? ` · impreso ${money(String(details.printedTotal))}` : ""}`;
  if (key === "duplicate" && details.registryNumber) return `Registro ${formatRegistry(String(details.registryNumber))}`;
  return null;
}

export function DocumentReviewPane({ document: doc, suppliers, accounts, inventory, canReview, busy, onFocusPage, onOpenDocument, onCreateSupplier, onStartReview, onApprove, onReject }: DocumentReviewPaneProps) {
  const captured = isoDate(doc.capturedAt) ?? todayIso();
  const steps = useMemo(() => reviewStepStates(doc), [doc]);
  const aiConfigured = aiConfiguredFrom(doc.extraction);
  const fieldRows = useMemo(() => extractedFieldRows(doc.extraction, doc.reviewedFields), [doc.extraction, doc.reviewedFields]);
  const actions = useMemo(() => actionsForKind(doc.kind, doc.proposedAction), [doc.kind, doc.proposedAction]);
  const failed = useMemo(() => failedChecks(doc.checks), [doc.checks]);

  const [reviewed, setReviewed] = useState<Record<string, unknown>>({});
  const [action, setAction] = useState<DocumentProposedAction>(actions[0] ?? "archive");
  const [billForm, setBillForm] = useState<BillForm>(() => proposalSupplierBill(doc));
  const [expense, setExpense] = useState<ExpenseDraft>(() => expenseDraftFrom(doc.proposal?.expense as ExpenseProposal | undefined, doc.documentDate ?? captured));
  const [receipt, setReceipt] = useState<ReceiptDraft>(() => receiptDraftFrom(doc.proposal?.goodsReceipt, doc.documentDate ?? captured));
  const [task, setTask] = useState<TaskDraft>(() => taskDraftFrom(doc.proposal?.task, doc.title ?? `${DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind} ${formatRegistry(doc.registryNumber)}`));
  const [overrideReason, setOverrideReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [rejectOpen, setRejectOpen] = useState<null | { returnToCentre: boolean }>(null);
  const [rejectReason, setRejectReason] = useState<DocumentRejectReason>("other");
  const [rejectNote, setRejectNote] = useState("");
  const [creatingSupplier, setCreatingSupplier] = useState(false);

  const editable = canReview && !busy;
  const inReview = doc.status === "in_review";
  const reviewable = doc.status === "sent_to_office" || inReview;
  const needsOverride = failed.length > 0 && action !== "archive";
  const billErrors: BillFormErrors = useMemo(() => (action === "create_supplier_bill" ? validateBillForm(billForm) : {}), [action, billForm]);
  const expenseErrors = useMemo(() => (action === "create_expense" ? validateExpenseDraft(expense) : {}), [action, expense]);
  const receiptErrors = useMemo(() => (action === "create_goods_receipt" ? validateReceiptDraft(receipt) : {}), [action, receipt]);
  const taskErrors = useMemo(() => (action === "create_task" ? validateTaskDraft(task) : {}), [action, task]);
  const formInvalid = Object.keys(billErrors).length > 0 || Object.keys(expenseErrors).length > 0 || Object.keys(receiptErrors).length > 0 || Object.keys(taskErrors).length > 0;
  const overrideMissing = needsOverride && overrideReason.trim().length < 3;

  const reviewedMerged = useMemo(() => ({ ...(doc.reviewedFields ?? {}), ...reviewed }), [doc.reviewedFields, reviewed]);
  const rowsWithEdits = useMemo(() => extractedFieldRows(doc.extraction, reviewedMerged), [doc.extraction, reviewedMerged]);
  const supplierProposal = doc.proposal?.supplierProposal ?? null;
  const expenseAccounts = useMemo(() => accountOptions(accounts.accounts, isExpenseAccount), [accounts.accounts]);
  const paidWithOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Elige cómo se pagó" }, ...EXPENSE_PAID_WITH.map((value) => ({ value, label: PAID_WITH_LABELS[value] }))], []);
  const taskKindOptions = useMemo<CocoaSelectOption[]>(() => DOCUMENT_ACTION_KINDS.map((kind) => ({ value: kind, label: TASK_KIND_LABELS[kind] })), []);
  const actionOptions = useMemo<CocoaSelectOption[]>(() => actions.map((value) => ({ value, label: PROPOSED_ACTION_LABELS[value] })), [actions]);

  function buildBody(): DocumentApproveRequest | null {
    const body: DocumentApproveRequest = { action };
    // incomingDocumentId y source (digitized | e_invoice) los fija el servidor (actions.service.ts).
    if (action === "create_supplier_bill") body.supplierBill = billFormToRequest(billForm);
    if (action === "create_expense") body.expense = expenseDraftToRequest(expense);
    if (action === "create_goods_receipt") body.goodsReceipt = receiptDraftToRequest(receipt);
    if (action === "create_task") body.task = taskDraftToRequest(task);
    if (needsOverride) body.override = { reason: overrideReason.trim() };
    return body;
  }

  async function approve() {
    setTouched(true);
    if (formInvalid || overrideMissing) return;
    const body = buildBody();
    if (!body) return;
    await onApprove({ action, reviewedFields: reviewed, body });
  }

  async function createSupplierFromSage() {
    if (!supplierProposal) return;
    setCreatingSupplier(true);
    try {
      const created = await onCreateSupplier(supplierProposal);
      if (created) {
        setBillForm((form) => ({ ...form, supplierId: created.id, supplierName: created.name, supplierTaxId: created.taxId ?? form.supplierTaxId }));
        setReceipt((draft) => ({ ...draft, supplierId: created.id }));
        setExpense((draft) => ({ ...draft, supplierName: created.name, supplierNif: created.taxId ?? draft.supplierNif }));
      }
    } finally {
      setCreatingSupplier(false);
    }
  }

  function openReject(returnToCentre: boolean) {
    setRejectReason(returnToCentre ? "illegible" : "duplicate");
    setRejectNote("");
    setRejectOpen({ returnToCentre });
  }

  async function confirmReject() {
    if (!rejectOpen) return;
    const duplicateOfId = rejectReason === "duplicate" ? (doc.checks?.duplicate?.details?.documentId as string | undefined) : undefined;
    await onReject({ reason: rejectReason, ...(rejectNote.trim() ? { note: rejectNote.trim() } : {}), ...(rejectOpen.returnToCentre ? { returnToCentre: true } : {}), ...(duplicateOfId ? { duplicateOfId } : {}) });
    setRejectOpen(null);
  }

  const primaryLabel = APPROVE_LABELS[action];
  const primaryDisabled = !editable || !reviewable || (touched && (formInvalid || overrideMissing));
  const primaryTitle = !canReview ? NO_REVIEW_PERMISSION : !reviewable ? `Solo se decide un documento enviado o en revisión (este está «${DOCUMENT_STATUS_LABELS[doc.status] ?? doc.status}»)` : undefined;

  return (
    <div className="cocoa-stack" data-gap="4" aria-label="Revisión del documento">
      <div className="cocoa-stack" data-gap="1">
        <div className="cocoa-row" data-gap="2" data-justify="between">
          <strong className="cocoa-mono">{formatRegistry(doc.registryNumber)}</strong>
          <CocoaBadge tone={doc.status === "in_review" ? "accent" : "neutral"}>{DOCUMENT_STATUS_LABELS[doc.status] ?? doc.status}</CocoaBadge>
        </div>
        <ol className="cocoa-cluster" role="list" aria-label="Pasos del pipeline">
          {REVIEW_STEPS.map((step) => (
            <li key={step.key} aria-current={steps[step.key] === "current" ? "step" : undefined}>
              <CocoaBadge tone={STEP_TONES[steps[step.key]]} variant={steps[step.key] === "pending" ? "outline" : "tinted"} uppercase={false} title={steps[step.key] === "failed" ? "La extracción falló: revisa los campos a mano" : undefined}>
                {step.label}
              </CocoaBadge>
            </li>
          ))}
        </ol>
        <span className="cocoa-note">
          {DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind}
          {doc.kindConfidence !== null ? ` · confianza ${confidenceTone(doc.kindConfidence).label}` : ""}
          {doc.classificationSource === "manual" ? " · tipo corregido a mano" : ""}
        </span>
      </div>

      {!canReview ? <p className="cocoa-note">{NO_REVIEW_PERMISSION} («documents.review») para asignar, corregir campos, aprobar o rechazar: la ficha se puede consultar.</p> : null}

      {!aiConfigured ? (
        <CocoaCallout tone="warning" title={AI_NOT_CONFIGURED_COPY}>
          {doc.extractionStatus === "pending" ? "La extracción sigue en curso: los campos aparecerán al terminar." : doc.extractionStatus === "failed" ? "La extracción falló: escribe los campos a mano en el formulario." : "Los campos vienen del extractor de texto (reglas) o los escribes tú: comprueba cada uno contra el original."}
        </CocoaCallout>
      ) : null}

      {doc.status === "sent_to_office" ? (
        <CocoaCallout
          tone="info"
          title="Documento pendiente de revisión"
          actions={
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void onStartReview()} disabled={!editable} loading={busy} title={canReview ? undefined : NO_REVIEW_PERMISSION}>
              Empezar revisión
            </CocoaButton>
          }
        >
          Al empezar la revisión el documento queda asignado a ti y pasa a «En revisión»; aprobar o rechazar lo hace automáticamente.
        </CocoaCallout>
      ) : null}

      <section className="cocoa-stack" data-gap="2" aria-label="Campos extraídos">
        <strong>Campos extraídos</strong>
        {rowsWithEdits.length === 0 ? <span className="cocoa-note">Sin campos extraídos todavía.</span> : null}
        {rowsWithEdits.map((row) => {
          const badge = confidenceTone(row.confidence);
          return (
            <CocoaField key={row.key} label={row.label} hint={<CocoaBadge tone={badge.tone} variant="tinted" size="small" uppercase={false} title={row.confidence === null ? "Valor escrito por una persona" : `Confianza del extractor: ${badge.label}`}>{badge.label}</CocoaBadge>} help={row.page ? `Página ${row.page}` : undefined}>
              <CocoaInput value={row.value} onChange={(v) => setReviewed((prev) => ({ ...prev, [row.key]: v }))} onFocus={() => onFocusPage(row.page)} disabled={!editable} size="small" />
            </CocoaField>
          );
        })}
        {fieldRows.length > 0 ? <span className="cocoa-note">Pulsa un campo para ver su página; los cambios se guardan como revisados al aprobar.</span> : null}
      </section>

      <section className="cocoa-stack" data-gap="2" aria-label="Comprobaciones">
        <strong>Comprobaciones</strong>
        {!doc.checks ? <span className="cocoa-note">Sin comprobaciones: el servidor las ejecuta al terminar la extracción.</span> : null}
        {doc.checks
          ? DOCUMENT_CHECK_KEYS.map((key) => {
              const check = doc.checks?.[key];
              if (!check) return null;
              if (check.status === "ok") {
                return (
                  <div key={key} className="cocoa-row" data-gap="2">
                    <CocoaBadge tone="success" variant="dot" size="small">
                      {CHECK_LABELS[key]}
                    </CocoaBadge>
                    <span className="cocoa-note">{check.message}</span>
                  </div>
                );
              }
              const duplicateId = key === "duplicate" ? (check.details?.documentId as string | undefined) : undefined;
              const offerSage = key === "supplier" && supplierProposal?.fromSage && !billForm.supplierId;
              const extra = checkDetailText(key, check);
              return (
                <CocoaCallout
                  key={key}
                  tone={checkTone(check.status)}
                  title={`${CHECK_LABELS[key]} · ${check.status === "fail" ? "en rojo" : "aviso"}`}
                  actions={
                    duplicateId ? (
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => onOpenDocument(duplicateId)}>
                        Abrir el original
                      </CocoaButton>
                    ) : offerSage ? (
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void createSupplierFromSage()} disabled={!editable} loading={creatingSupplier} title={canReview ? undefined : NO_REVIEW_PERMISSION}>
                        Dar de alta desde Sage
                      </CocoaButton>
                    ) : undefined
                  }
                >
                  {check.message}
                  {extra ? ` ${extra}.` : ""}
                  {offerSage && supplierProposal ? ` Sage conoce a «${supplierProposal.name}»${supplierProposal.taxId ? ` (${supplierProposal.taxId})` : ""}: al aprobar se da de alta en el directorio si no lo haces antes.` : ""}
                </CocoaCallout>
              );
            })
          : null}
      </section>

      <section className="cocoa-stack" data-gap="3" aria-label="Acción propuesta">
        <CocoaField label="Acción" help={doc.proposedAction ? `Propuesta: ${PROPOSED_ACTION_LABELS[doc.proposedAction]}` : "Sin propuesta del servidor: elige la acción."}>
          <CocoaSelect value={action} onChange={(v) => setAction(v as DocumentProposedAction)} options={actionOptions} disabled={!editable} />
        </CocoaField>

        {action === "create_supplier_bill" ? <SupplierBillForm value={billForm} onChange={setBillForm} errors={touched ? billErrors : undefined} accounts={accounts} suppliers={suppliers} mode="review" disabled={!editable} /> : null}

        {action === "create_expense" ? (
          <CocoaFormSection title="Gasto menor" columns={2}>
            <CocoaField label="Fecha" required error={touched ? expenseErrors.date : undefined}>
              <CocoaDatePicker value={expense.date} onChange={(v) => setExpense({ ...expense, date: v })} disabled={!editable} />
            </CocoaField>
            <CocoaField label="Proveedor" required error={touched ? expenseErrors.supplierName : undefined}>
              <CocoaInput value={expense.supplierName} onChange={(v) => setExpense({ ...expense, supplierName: v })} disabled={!editable} />
            </CocoaField>
            <CocoaField label="NIF" help="Sin NIF el IVA no se deduce.">
              <CocoaInput value={expense.supplierNif} onChange={(v) => setExpense({ ...expense, supplierNif: v })} disabled={!editable} />
            </CocoaField>
            <CocoaField label="Concepto" required error={touched ? expenseErrors.concept : undefined}>
              <CocoaInput value={expense.concept} onChange={(v) => setExpense({ ...expense, concept: v })} disabled={!editable} />
            </CocoaField>
            <CocoaField label="Cuenta de gasto" required error={touched ? expenseErrors.accountCode : undefined}>
              {expenseAccounts.length > 0 ? (
                <CocoaSelect value={expense.accountCode} onChange={(v) => setExpense({ ...expense, accountCode: v })} options={expenseAccounts} placeholder="Elige la subcuenta 6xx" disabled={!editable} />
              ) : (
                <CocoaInput value={expense.accountCode} onChange={(v) => setExpense({ ...expense, accountCode: v })} placeholder="629" disabled={!editable} />
              )}
            </CocoaField>
            <CocoaField label="Base" required error={touched ? expenseErrors.base : undefined}>
              <CocoaInput value={expense.base} onChange={(v) => setExpense({ ...expense, base: v })} inputMode="decimal" disabled={!editable} />
            </CocoaField>
            <CocoaField label="Tipo de IVA">
              <CocoaSelect value={expense.taxRate} onChange={(v) => setExpense({ ...expense, taxRate: v })} options={TAX_RATE_OPTIONS} disabled={!editable} />
            </CocoaField>
            <CocoaField label="Cuota impresa" error={touched ? expenseErrors.quota : undefined} help="Vacía: base × tipo.">
              <CocoaInput value={expense.quota} onChange={(v) => setExpense({ ...expense, quota: v })} inputMode="decimal" disabled={!editable} />
            </CocoaField>
            <CocoaField label="Pagado con" required error={touched ? expenseErrors.paidWith : undefined}>
              <CocoaSelect value={expense.paidWith} onChange={(v) => setExpense({ ...expense, paidWith: v as ExpenseDraft["paidWith"] })} options={paidWithOptions} disabled={!editable} />
            </CocoaField>
            <CocoaField label="IVA deducible" inline>
              <CocoaSwitch checked={expense.vatDeductible} onChange={(v) => setExpense({ ...expense, vatDeductible: v })} disabled={!editable} />
            </CocoaField>
          </CocoaFormSection>
        ) : null}

        {action === "create_goods_receipt" ? <GoodsReceiptForm value={receipt} onChange={setReceipt} errors={touched ? receiptErrors : undefined} suppliers={suppliers} inventory={inventory} disabled={!editable} /> : null}

        {action === "create_task" ? (
          <CocoaFormSection title="Tarea con plazo" columns={2}>
            <CocoaField label="Tipo de tarea" required>
              <CocoaSelect value={task.kind} onChange={(v) => setTask({ ...task, kind: v as DocumentActionKind })} options={taskKindOptions} disabled={!editable} />
            </CocoaField>
            <CocoaField label="Plazo" help="Vacío: sin plazo.">
              <CocoaDatePicker value={task.dueOn} onChange={(v) => setTask({ ...task, dueOn: v })} disabled={!editable} arithmetic />
            </CocoaField>
            <CocoaField label="Título" required error={touched ? taskErrors.title : undefined} fullWidth>
              <CocoaInput value={task.title} onChange={(v) => setTask({ ...task, title: v })} disabled={!editable} />
            </CocoaField>
            <CocoaField label="Descripción" fullWidth>
              <CocoaInput value={task.description} onChange={(v) => setTask({ ...task, description: v })} multiline rows={3} disabled={!editable} />
            </CocoaField>
          </CocoaFormSection>
        ) : null}

        {action === "archive" ? (
          <CocoaCallout tone="info" title="Archivo con retención por tipo">
            El documento pasa al archivo legal con la retención de su tipo (facturas 6 años; cartas y contratos según los ajustes de la organización). La retención ampliada y el bloqueo legal se fijan después desde el Archivo con «documents.admin».
          </CocoaCallout>
        ) : null}

        {needsOverride ? (
          <CocoaField label="Motivo para aprobar con comprobaciones en rojo" required error={touched && overrideMissing ? "Explica por qué se aprueba pese a las comprobaciones en rojo (queda auditado)." : undefined} help={`En rojo: ${failed.map((key) => CHECK_LABELS[key]).join(", ")}.`}>
            <CocoaInput value={overrideReason} onChange={setOverrideReason} disabled={!editable} multiline rows={2} />
          </CocoaField>
        ) : null}
      </section>

      <CocoaActionBar
        sticky={false}
        aria-label="Decisión sobre el documento"
        status={doc.assignedTo ? `Asignado · ${date(doc.reviewStartedAt ?? doc.sentAt, "short")}` : doc.sentAt ? `Enviado ${date(doc.sentAt, "short")}` : undefined}
        primary={{ label: primaryLabel, onClick: () => void approve(), disabled: primaryDisabled, loading: busy, title: primaryTitle }}
        secondary={{ label: "Devolver al centro", onClick: () => openReject(true), disabled: !editable || !reviewable, title: primaryTitle }}
        extra={
          <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => openReject(false)} disabled={!editable || !reviewable} title={primaryTitle}>
            {ACTIONS.reject}
          </CocoaButton>
        }
        wrap
      />

      <CocoaDialog
        open={rejectOpen !== null}
        onClose={() => {
          if (!busy) setRejectOpen(null);
        }}
        title={rejectOpen?.returnToCentre ? "Devolver al centro" : "Rechazar el documento"}
        description={rejectOpen?.returnToCentre ? "El documento vuelve al centro con el mismo número de registro para que lo capturen de nuevo; se avisa a quien lo capturó." : "El documento se cierra como rechazado y pasa al archivo con la retención de un año."}
        tone="destructive"
        confirmLabel={rejectOpen?.returnToCentre ? "Devolver" : ACTIONS.reject}
        onConfirm={() => void confirmReject()}
        busy={busy}
        confirmDisabled={!rejectReason}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required>
            <CocoaSelect value={rejectReason} onChange={(v) => setRejectReason(v as DocumentRejectReason)} options={rejectReasonOptions(Boolean(rejectOpen?.returnToCentre))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Nota para el centro" help="Se guarda con la decisión y se muestra a quien capturó el documento.">
            <CocoaInput value={rejectNote} onChange={setRejectNote} multiline rows={3} disabled={busy} />
          </CocoaField>
        </div>
      </CocoaDialog>
    </div>
  );
}

export default DocumentReviewPane;
