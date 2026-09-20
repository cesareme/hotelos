// Documentos · mapeo fila Prisma → DTO compartido (Tanda T9 · lote T9-05a).
//
// Contrato: packages/shared/src/documents-types.ts (IncomingDocumentRecord,
// IncomingDocumentDetail, DocumentFileDto, DocumentPageDto,
// DocumentExtractionDto, DocumentActionDto, BillLineMatchDto). Reglas:
//   · los bytes y la clave del almacén NUNCA salen (DocumentFileDto sin
//     storageKey ni inline);
//   · dinero como MoneyString (money() de payables/money.ts), cantidades como
//     cadena decimal con la escala de la columna, días como IsoDay, instantes
//     como ISO-8601;
//   · `dueAt` y `slaBreached` se calculan en lectura (§6.3) y llegan ya
//     resueltos en `extras`, igual que `supplierName`.

import type { BillLineMatch, DocumentAction, DocumentExtraction, DocumentFile, DocumentPage, IncomingDocument } from "@prisma/client";
import type {
  BillLineMatchDto,
  DocumentActionDto,
  DocumentChecks,
  DocumentExtractionDto,
  DocumentFileDto,
  DocumentPageDto,
  DocumentProposal,
  IncomingDocumentDetail,
  IncomingDocumentRecord
} from "@hotelos/shared";
import { dayOf, money } from "../payables/money.js";

export type IncomingDocumentRow = IncomingDocument;

/** Campos de lectura que no viven en la fila (§6.3 SLA, §3.5 plazo, nombre del proveedor). */
export type RecordExtras = {
  supplierName: string | null;
  dueAt: Date | null;
  slaBreached: boolean;
};

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

function decimalString(value: { toFixed(scale: number): string } | null | undefined, scale: number): string | null {
  return value == null ? null : value.toFixed(scale);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function toIncomingDocumentRecord(row: IncomingDocumentRow, extras: RecordExtras): IncomingDocumentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    legalEntityId: row.legalEntityId,
    propertyId: row.propertyId,
    registryNumber: row.registryNumber,
    kind: row.kind,
    kindConfidence: row.kindConfidence == null ? null : Number(row.kindConfidence),
    classificationSource: (row.classificationSource as IncomingDocumentRecord["classificationSource"]) ?? null,
    status: row.status,
    physicalStatus: row.physicalStatus,
    source: row.source,
    originalFormat: row.originalFormat,
    title: row.title,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    supplierId: row.supplierId,
    supplierTaxId: row.supplierTaxId,
    supplierName: extras.supplierName,
    documentNumber: row.documentNumber,
    documentDate: dayOf(row.documentDate),
    totalAmount: row.totalAmount == null ? null : money(row.totalAmount),
    currency: row.currency,
    extractionStatus: row.extractionStatus as IncomingDocumentRecord["extractionStatus"],
    proposedAction: (row.proposedAction as IncomingDocumentRecord["proposedAction"]) ?? null,
    dueAt: iso(extras.dueAt),
    slaBreached: extras.slaBreached,
    capturedBy: row.capturedBy,
    capturedAt: row.capturedAt.toISOString(),
    sentAt: iso(row.sentAt),
    assignedTo: row.assignedTo,
    reviewStartedAt: iso(row.reviewStartedAt),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    rejectReason: (row.rejectReason as IncomingDocumentRecord["rejectReason"]) ?? null,
    rejectNote: row.rejectNote,
    supplierBillId: row.supplierBillId,
    expenseId: row.expenseId,
    goodsReceiptId: row.goodsReceiptId,
    reviewItemId: row.reviewItemId,
    dispatchBatchId: row.dispatchBatchId,
    mergedIntoId: row.mergedIntoId,
    postedAt: iso(row.postedAt),
    archivedAt: iso(row.archivedAt),
    retentionUntil: dayOf(row.retentionUntil),
    extendedRetention: row.extendedRetention,
    legalHold: row.legalHold,
    blockedAt: iso(row.blockedAt),
    deletedAt: iso(row.deletedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toDocumentFileDto(row: DocumentFile): DocumentFileDto {
  return {
    id: row.id,
    documentId: row.documentId,
    role: row.role as DocumentFileDto["role"],
    pageNo: row.pageNo,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storageKind: row.storageKind,
    encrypted: row.encrypted,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString()
  };
}

export function toDocumentPageDto(row: DocumentPage): DocumentPageDto {
  return {
    id: row.id,
    pageNo: row.pageNo,
    kind: (row.kind as DocumentPageDto["kind"]) ?? null,
    isContinuation: row.isContinuation,
    textExtracted: row.textExtracted,
    imageFileId: row.imageFileId,
    width: row.width,
    height: row.height
  };
}

export function toDocumentExtractionDto(row: DocumentExtraction): DocumentExtractionDto {
  const confidence = asRecord(row.confidenceJson) ?? {};
  return {
    id: row.id,
    documentId: row.documentId,
    runNo: row.runNo,
    source: row.source as DocumentExtractionDto["source"],
    provider: row.provider,
    modelVersion: row.modelVersion,
    schemaVersion: String(row.schemaVersion),
    fields: asRecord(row.fieldsJson) ?? {},
    confidence: Object.fromEntries(Object.entries(confidence).filter(([, v]) => typeof v === "number")) as Record<string, number>,
    warnings: Array.isArray(row.warningsJson) ? row.warningsJson.filter((w): w is string => typeof w === "string") : [],
    tokensInput: row.tokensInput,
    tokensOutput: row.tokensOutput,
    costEur: row.costEur == null ? null : decimalString(row.costEur, 4),
    durationMs: row.durationMs,
    status: row.status as DocumentExtractionDto["status"],
    error: row.error,
    createdAt: row.createdAt.toISOString()
  };
}

export function toDocumentActionDto(row: DocumentAction): DocumentActionDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    documentId: row.documentId,
    kind: row.kind as DocumentActionDto["kind"],
    title: row.title,
    description: row.description,
    assignedTo: row.assignedTo,
    dueAt: iso(row.dueAt),
    status: row.status,
    outcomeNote: row.outcomeNote,
    completedBy: row.completedBy,
    completedAt: iso(row.completedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString()
  };
}

export function toBillLineMatchDto(row: BillLineMatch): BillLineMatchDto {
  return {
    id: row.id,
    supplierBillLineId: row.supplierBillLineId,
    goodsReceiptLineId: row.goodsReceiptLineId,
    purchaseOrderLineId: row.purchaseOrderLineId,
    matchedQuantity: decimalString(row.matchedQuantity, 3),
    matchedBase: row.matchedBase == null ? null : money(row.matchedBase),
    quantityVariance: decimalString(row.quantityVariance, 3),
    priceVariance: decimalString(row.priceVariance, 4),
    status: row.status as BillLineMatchDto["status"],
    matchedBy: row.matchedBy,
    createdAt: row.createdAt.toISOString()
  };
}

/** `checksJson` → DocumentChecks o null cuando aún no hay comprobaciones (`[]` / `{}` por defecto). */
export function checksOf(value: unknown): DocumentChecks | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).length === 0) return null;
  return record as unknown as DocumentChecks;
}

/** `proposedAction` + `proposedActionJson` → DocumentProposal o null sin propuesta. */
export function proposalOf(row: Pick<IncomingDocumentRow, "proposedAction" | "proposedActionJson">): DocumentProposal | null {
  if (!row.proposedAction) return null;
  const body = asRecord(row.proposedActionJson) ?? {};
  return { ...(body as Omit<DocumentProposal, "action">), action: row.proposedAction as DocumentProposal["action"] };
}

export type DetailParts = {
  files: DocumentFile[];
  pages: DocumentPage[];
  extraction: DocumentExtraction | null;
  actions: DocumentAction[];
  matches: BillLineMatch[];
};

export function toIncomingDocumentDetail(row: IncomingDocumentRow, extras: RecordExtras, parts: DetailParts): IncomingDocumentDetail {
  return {
    ...toIncomingDocumentRecord(row, extras),
    files: parts.files.map(toDocumentFileDto),
    pages: parts.pages.map(toDocumentPageDto),
    extraction: parts.extraction ? toDocumentExtractionDto(parts.extraction) : null,
    checks: checksOf(row.checksJson),
    proposal: proposalOf(row),
    reviewedFields: asRecord(row.reviewedFieldsJson),
    actions: parts.actions.map(toDocumentActionDto),
    matches: parts.matches.map(toBillLineMatchDto),
    reviewItemId: row.reviewItemId,
    // Lote T9-08 (reject duplicate) enlaza el original; hasta entonces no hay columna: null.
    duplicateOfId: null
  };
}
