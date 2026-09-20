// Documentos · Tanda T9 · lote T9-06a — pipeline clasificar → extraer →
// validar → proponer (apps/api/src/modules/documents/pipeline.service.ts;
// diseño §5.1-§5.2).
//
// Entrada: runDocumentPipeline(documentId, { trigger: capture | manual | email,
// force?, correlationId, userId?, stage? }) → { configured, extraction, … }.
// Lo llama server.ts tras cada captura (onCaptured, en segundo plano), las
// rutas POST …/documents/:id/classify | extract (pipeline.routes.ts) y el
// buzón de correo (T9-07).
//
// Pasos (con o sin proveedor de IA):
//   1. carga el documento, su fichero original (inline o almacén,
//      getDocumentStorage) y el texto: capa de texto del PDF (pdf-text.ts),
//      XML (Facturae / UBL → parseEInvoice) o nada para imágenes sin OCR; si el
//      documento es un trozo de un `split` lógico (sourcePagesJson: páginas
//      físicas del original), solo cuentan ESAS páginas: texto, filas
//      DocumentPage y pageCount se recortan al rango y el PDF completo no viaja
//      al modelo (aviso pdf_split_text_only: sin librería PDF no se recortan los
//      bytes);
//   2. clasifica con el puerto de IA (documents-ai.port.ts): ai-core vía
//      runAiTool cuando hay proveedor, reglas por palabras si no; NUNCA pisa
//      un tipo fijado por una persona (classificationSource = manual);
//   3. extrae con el puerto (esquema por tipo; text_rules / e_invoice sin
//      proveedor) y normaliza los campos a ExtractedDocumentFields
//      (validation.ts); intercambia emisor/destinatario si el «proveedor»
//      leído es la propia sociedad;
//   4. valida (validateDocument, T9-06b) con lo que el servidor sabe:
//      Supplier por NIF, tercero de Sage (sage-lookup.ts), facturas de la
//      organización del mismo NIF, recibidas de Sage (exactas + fuzzy),
//      gemelo por sha256, albaranes recibidos del proveedor y centro y
//      DocumentSettings;
//   5. propone (buildProposal, T9-06b) y anota la autonomía del centro para
//      proposeIncomingDocumentAction (PropertyAiToolSetting → nivel;
//      wouldAutoArchive / wouldCreateDraft; T9-08 la aplica);
//   6. persiste DocumentExtraction (runNo incremental, fuente, proveedor,
//      modelo, esquema, campos con confianza y página, avisos, tokens, coste,
//      duración, estado) y actualiza IncomingDocument (tipo, NIF, proveedor,
//      número, fecha, total, checksJson, proposedAction(+Json), searchText
//      sin números de tarjeta, extractionStatus, páginas) sin tocar NUNCA
//      reviewedFieldsJson; encola UNA revisión en la cola de la oficina
//      (reviewType incoming_document, también sin proveedor) y audita
//      DOCUMENT_CLASSIFIED / DOCUMENT_EXTRACTED sin texto ni bytes;
//   7. con DocumentSettings.autoSendToOffice (§6.1 «automático si
//      autoSendToOffice»), una captura o un correo recién extraídos pasan a
//      sent_to_office (UPDATE condicional desde captured, DOCUMENT_SENT de
//      sistema y aviso a los revisores del centro); nunca hace fallar la
//      extracción.
// Errores: nunca se tragan; la ejecución queda `failed` con el error en la
// fila y extractionStatus = failed, y el error se relanza. `force` exige
// proveedor: sin él (o si el proveedor falla) → 503 AI_PROVIDER_UNAVAILABLE.
//
// Tests: cd apps/api && node --import tsx --test src/modules/documents/__tests__/pipeline-fallback.test.mts
//        node --env-file=.env --test tests/integration/documents-pipeline.test.mts (Postgres, tenant aislado)

import { redactPii } from "@hotelos/ai-core";
import { prisma } from "@hotelos/database";
import type { DocumentExtraction, DocumentFile, IncomingDocument, Prisma } from "@prisma/client";
import type { DocumentChecks, DocumentExtractionDto, DocumentProposal, IncomingDocumentKind } from "@hotelos/shared";
import { HttpError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { enqueueReview as enqueueReviewDefault } from "../ai-operations/human-review.service.js";
import { getPropertyAiSettings as getPropertyAiSettingsDefault } from "../ai-operations/property-ai.service.js";
import { normalizeNif } from "../payables/validators.js";
import { DOCUMENT_AUDIT_ACTIONS, DOCUMENT_AUDIT_ENTITY } from "./documents-audit.js";
import { toDocumentExtractionDto } from "./documents-dto.js";
import { getDocumentStorage } from "./documents.config.js";
import { buildSearchText } from "./documents.service.js";
import { notifyOfficeDocumentSent } from "./office-notifications.js";
import { getDocumentsAiPort, type ClassifyDocumentOutput, type DocumentExtractedFields, type DocumentImagePage, type DocumentsAiContext, type DocumentsAiPort, type ExtractDocumentOutput } from "./documents-ai.port.js";
import { PdfTextError, extractPdfText } from "./pdf-text.js";
import { buildProposal, type BuiltProposal } from "./proposal.js";
import { findSageReceivedByNifAndNumber, findSageReceivedFuzzy, findSageSupplierByNif, type SageDb, type SageReceived, type SageSupplier } from "./sage-lookup.js";
import { decodeInline } from "./storage/inline-storage.js";
import type { DocumentStorage } from "./storage/storage.js";
import { documentNumberOf, validateDocument, type ExistingBillLike, type ExtractedDocumentFields, type ExtractedLine, type SupplierLike } from "./validation.js";
import type { GoodsReceiptLike } from "./matching.js";

type Db = typeof prisma;

export type PipelineTrigger = "capture" | "manual" | "email";
export type PipelineStage = "classify" | "full";

export type RunDocumentPipelineOptions = {
  trigger: PipelineTrigger;
  /** Exige proveedor de IA: sin él, o si falla, 503 AI_PROVIDER_UNAVAILABLE. */
  force?: boolean;
  correlationId: string;
  /** Persona que dispara la ejecución (rutas); ausente en captura / correo. */
  userId?: string;
  /** `classify` solo clasifica (sin extracción ni propuesta); por defecto `full`. */
  stage?: PipelineStage;
};

export type PipelineClassification = { kind: IncomingDocumentKind; confidence: number | null; source: "ai" | "rules" | "manual"; note?: string };

export type DocumentPipelineAutonomy = {
  level: string;
  enabled: boolean;
  wouldAutoArchive: boolean;
  wouldCreateDraft: boolean;
};

export type DocumentPipelineResult = {
  documentId: string;
  configured: boolean;
  provider: string;
  classification: PipelineClassification;
  /** Ejecución de esta llamada (null cuando stage = classify sin ejecución previa). */
  extraction: DocumentExtractionDto | null;
  checks: DocumentChecks | null;
  proposal: DocumentProposal | null;
  autonomy: DocumentPipelineAutonomy | null;
};

export type DocumentPipelineDeps = {
  db?: Db;
  storage?: () => DocumentStorage;
  ai?: () => DocumentsAiPort;
  enqueueReview?: typeof enqueueReviewDefault;
  getPropertyAiSettings?: typeof getPropertyAiSettingsDefault;
  findSageSupplierByNif?: typeof findSageSupplierByNif;
  findSageReceivedByNifAndNumber?: typeof findSageReceivedByNifAndNumber;
  findSageReceivedFuzzy?: typeof findSageReceivedFuzzy;
  audit?: typeof recordAuditEvent;
  now?: () => Date;
};

export const DOCUMENT_PIPELINE_AUDIT_ACTIONS = Object.freeze({
  classified: "DOCUMENT_CLASSIFIED",
  extracted: "DOCUMENT_EXTRACTED",
  proposed: "DOCUMENT_ACTION_PROPOSED"
} as const);

export const PROPOSE_TOOL_NAME = "proposeIncomingDocumentAction";
export const REVIEW_TYPE_INCOMING_DOCUMENT = "incoming_document";
export const AI_PROVIDER_UNAVAILABLE = "AI_PROVIDER_UNAVAILABLE";
/** Texto de páginas que entra en searchText (además de los campos); el resto queda en DocumentPage.textExtracted. */
export const SEARCH_TEXT_PAGES_MAX = 6_000;
/** Texto que se pasa a las comprobaciones (referencias de albarán citadas). */
export const VALIDATION_TEXT_MAX = 50_000;
export const MAX_PAGE_ROWS_WRITTEN = 200;

let overrides: Partial<DocumentPipelineDeps> | null = null;

function deps(): Required<Omit<DocumentPipelineDeps, "db">> & { db: Db } {
  const base = {
    db: prisma,
    storage: getDocumentStorage,
    ai: getDocumentsAiPort,
    enqueueReview: enqueueReviewDefault,
    getPropertyAiSettings: getPropertyAiSettingsDefault,
    findSageSupplierByNif,
    findSageReceivedByNifAndNumber,
    findSageReceivedFuzzy,
    audit: recordAuditEvent,
    now: () => new Date()
  };
  return overrides ? { ...base, ...overrides } : base;
}

/** Sustituye dependencias (tests sin Postgres ni almacén); sin argumento restaura las reales. */
export function resetDocumentPipelineForTests(next?: Partial<DocumentPipelineDeps>): void {
  overrides = next ?? null;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueOf<T = unknown>(fields: DocumentExtractedFields, key: string): T | null {
  const entry = fields[key];
  if (!entry || entry.value === null || entry.value === undefined) return null;
  return entry.value as T;
}

function textValue(fields: DocumentExtractedFields, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = valueOf(fields, key);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numberValue(fields: DocumentExtractedFields, ...keys: string[]): number | string | null {
  for (const key of keys) {
    const value = valueOf(fields, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
  }
  return null;
}

function isoDayOf(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayString(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function linesOf(fields: DocumentExtractedFields): ExtractedLine[] | null {
  const raw = valueOf<unknown>(fields, "lines");
  if (!Array.isArray(raw)) return null;
  const out: ExtractedLine[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const line: ExtractedLine = {
      description: typeof item.description === "string" ? item.description : null,
      quantity: (item.quantity as ExtractedLine["quantity"]) ?? null,
      unit: typeof item.unit === "string" ? item.unit : null,
      unitPrice: (item.unitPrice as ExtractedLine["unitPrice"]) ?? null,
      base: (item.base as ExtractedLine["base"]) ?? null,
      taxRate: (item.taxRate as ExtractedLine["taxRate"]) ?? null,
      quota: (item.quota as ExtractedLine["quota"]) ?? null,
      deliveryNoteRef: typeof item.deliveryNoteRef === "string" ? item.deliveryNoteRef : null
    };
    out.push(line);
  }
  return out.length > 0 ? out : null;
}

/** Tipo único de IVA del desglose (documentos a un solo tipo). */
function singleRateOf(fields: DocumentExtractedFields): number | null {
  const breakdown = valueOf<unknown>(fields, "taxBreakdown");
  if (Array.isArray(breakdown) && breakdown.length === 1 && isRecord(breakdown[0]) && typeof breakdown[0].rate === "number") return breakdown[0].rate;
  const direct = numberValue(fields, "taxRate");
  return typeof direct === "number" ? direct : direct !== null ? Number(direct) : null;
}

function noticeKindOf(text: string | null): "aeat_requirement" | "traffic_fine" | "administrative_notice" {
  const value = (text ?? "").toLowerCase();
  if (/agencia tributaria|aeat|requerimiento/.test(value)) return "aeat_requirement";
  if (/\bdgt\b|direcci[oó]n general de tr[aá]fico|multa|denuncia/.test(value)) return "traffic_fine";
  return "administrative_notice";
}

/**
 * Campos del esquema del tipo ({ value, confidence, page }) → ExtractedDocumentFields
 * de validation.ts. Exportado para el test unitario y para proposeIncomingDocumentAction.
 */
export function normalizeExtractedFields(kind: IncomingDocumentKind, fields: DocumentExtractedFields, text: string | null): ExtractedDocumentFields {
  const lower = (text ?? "").toLowerCase();
  const fiscal = kind === "invoice" || kind === "receipt";
  const common: ExtractedDocumentFields = {
    text: text ? text.slice(0, VALIDATION_TEXT_MAX) : null,
    ...(fiscal && /recargo de equivalencia/.test(lower) ? { vatRegime: "recargo_equivalencia" as const } : {}),
    ...(fiscal && /inversi[oó]n del sujeto pasivo/.test(lower) ? { reverseCharge: true } : {}),
    ...(fiscal && /intracomunitari/.test(lower) ? { intraCommunity: true } : {})
  };
  switch (kind) {
    case "invoice":
      return {
        ...common,
        supplierName: textValue(fields, "supplierName"),
        supplierTaxId: textValue(fields, "supplierTaxId"),
        customerTaxId: textValue(fields, "customerTaxId"),
        invoiceNumber: textValue(fields, "invoiceNumber"),
        documentNumber: textValue(fields, "invoiceNumber"),
        issueDate: textValue(fields, "issueDate"),
        dueDate: textValue(fields, "dueDate"),
        deliveryNoteRefs: (valueOf<string[]>(fields, "deliveryNoteRefs") ?? null) as string[] | null,
        total: numberValue(fields, "total"),
        baseTotal: numberValue(fields, "base"),
        taxTotal: numberValue(fields, "tax"),
        taxRate: singleRateOf(fields),
        retentionRate: numberValue(fields, "retentionRate"),
        retentionAmount: numberValue(fields, "retention"),
        currency: textValue(fields, "currency"),
        lines: linesOf(fields)
      };
    case "delivery_note":
      return {
        ...common,
        supplierName: textValue(fields, "supplierName"),
        supplierTaxId: textValue(fields, "supplierTaxId"),
        deliveryNoteNumber: textValue(fields, "deliveryNoteNumber"),
        documentNumber: textValue(fields, "deliveryNoteNumber"),
        deliveryDate: textValue(fields, "deliveryDate"),
        issueDate: textValue(fields, "deliveryDate"),
        lines: linesOf(fields)
      };
    case "receipt":
      return {
        ...common,
        supplierName: textValue(fields, "merchantName", "supplierName"),
        supplierTaxId: textValue(fields, "merchantTaxId", "supplierTaxId"),
        documentNumber: textValue(fields, "receiptNumber"),
        issueDate: textValue(fields, "date", "issueDate"),
        total: numberValue(fields, "total"),
        baseTotal: numberValue(fields, "base"),
        taxTotal: numberValue(fields, "tax"),
        taxRate: singleRateOf(fields),
        currency: "EUR"
      };
    case "administrative_notice":
      return {
        ...common,
        senderName: textValue(fields, "issuer", "sender"),
        supplierTaxId: textValue(fields, "issuerTaxId", "senderTaxId"),
        subject: textValue(fields, "subject"),
        documentNumber: textValue(fields, "reference"),
        issueDate: textValue(fields, "noticeDate", "date", "notificationDate"),
        dueDate: textValue(fields, "deadlineDate"),
        total: numberValue(fields, "amount"),
        noticeKind: noticeKindOf(text),
        requiresResponse: true
      };
    default:
      return {
        ...common,
        senderName: textValue(fields, "sender", "issuer"),
        supplierTaxId: textValue(fields, "senderTaxId", "issuerTaxId"),
        subject: textValue(fields, "subject"),
        documentNumber: textValue(fields, "reference"),
        issueDate: textValue(fields, "date", "noticeDate"),
        dueDate: textValue(fields, "deadlineDate"),
        total: numberValue(fields, "amount"),
        requiresResponse: textValue(fields, "deadlineDate") !== null
      };
  }
}

/** Si el «proveedor» leído es la propia sociedad (NIF de la entidad legal), el emisor real es el otro NIF. */
export function swapOwnTaxId(fields: ExtractedDocumentFields, ownTaxIds: ReadonlyArray<string | null | undefined>): ExtractedDocumentFields {
  const own = new Set(ownTaxIds.map((value) => normalizeNif(value)).filter((value): value is string => Boolean(value)));
  const supplier = normalizeNif(fields.supplierTaxId);
  if (!supplier || !own.has(supplier)) return fields;
  const customer = normalizeNif(fields.customerTaxId);
  if (customer && !own.has(customer)) return { ...fields, supplierTaxId: customer, customerTaxId: supplier };
  return { ...fields, supplierTaxId: null, customerTaxId: supplier };
}

/**
 * reviewedFieldsJson (edición humana) prevalece sobre la extracción, clave a clave.
 * El número corregido por el revisor (invoiceNumber / deliveryNoteNumber, los
 * campos que edita el panel) manda también sobre documentNumber, el campo derivado
 * que leen documentNumberOf, la propuesta y la factura (RV-07): reviewedFieldsJson
 * acumula todas las revisiones y no conserva su orden, así que el número del tipo
 * es la fuente de verdad y `documentNumber` revisado solo cuenta sin él.
 */
export function applyReviewedFields(fields: ExtractedDocumentFields, reviewed: unknown): ExtractedDocumentFields {
  if (!isRecord(reviewed)) return fields;
  const merged: ExtractedDocumentFields = { ...fields };
  for (const [key, value] of Object.entries(reviewed)) {
    if (key === "text") continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  const reviewedNumber = ["invoiceNumber", "deliveryNoteNumber"].map((key) => reviewed[key]).find((value) => typeof value === "string" && value.trim().length > 0);
  if (typeof reviewedNumber === "string") merged.documentNumber = reviewedNumber.trim();
  return merged;
}

/** `sourcePagesJson` → páginas físicas (enteros ≥ 1, en orden lógico) o null (todas). */
export function parseSourcePages(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const pages = value.filter((page): page is number => typeof page === "number" && Number.isInteger(page) && page >= 1);
  return pages.length > 0 ? pages : null;
}

function confidenceMap(fields: DocumentExtractedFields): Record<string, number> {
  return Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, Number(entry.confidence.toFixed(4))]));
}

/** Registro, título (nombre del fichero), nota de captura, campos y texto de páginas para el archivo, sin números de tarjeta (redactPii card → [TARJETA_n]). */
export function buildPipelineSearchText(row: Pick<IncomingDocument, "registryNumber"> & Partial<Pick<IncomingDocument, "title" | "captureNote">>, fields: ExtractedDocumentFields, pagesText: string[]): string {
  const parts: Array<string | null | undefined> = [
    row.registryNumber,
    row.title,
    row.captureNote,
    fields.supplierName,
    fields.senderName,
    fields.supplierTaxId,
    fields.documentNumber ?? fields.invoiceNumber ?? fields.deliveryNoteNumber,
    fields.subject,
    fields.total === null || fields.total === undefined ? null : String(fields.total),
    pagesText.join(" ").slice(0, SEARCH_TEXT_PAGES_MAX)
  ];
  return redactPii(buildSearchText(parts), { kinds: ["card"] }).text;
}

// ---------------------------------------------------------------------------
// Carga del documento
// ---------------------------------------------------------------------------

type LoadedDocument = {
  row: IncomingDocument;
  original: DocumentFile | null;
  latest: DocumentExtraction | null;
  property: { id: string; code: string | null; kind: string; organizationId: string; legalEntityId: string | null } | null;
};

async function loadDocument(db: Db, documentId: string): Promise<LoadedDocument> {
  const row = await db.incomingDocument.findUnique({ where: { id: documentId } });
  if (!row) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
  const [files, latest, property] = await Promise.all([
    db.documentFile.findMany({ where: { documentId, role: "original" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }),
    db.documentExtraction.findFirst({ where: { documentId }, orderBy: { runNo: "desc" } }),
    db.property.findUnique({ where: { id: row.propertyId }, select: { id: true, code: true, kind: true, organizationId: true, legalEntityId: true } })
  ]);
  return { row, original: files[0] ?? null, latest, property };
}

async function bytesOf(storage: () => DocumentStorage, file: DocumentFile): Promise<Buffer> {
  if (file.storageKind === "inline") {
    if (!file.inline) throw typed(500, "DOCUMENT_STORAGE_IO", "El fichero original no está disponible (inline vacío).", { fileId: file.id });
    return decodeInline(file.inline);
  }
  if (!file.storageKey) throw typed(500, "DOCUMENT_STORAGE_IO", "El fichero original no tiene clave de almacén.", { fileId: file.id });
  const got = await storage().get(file.storageKey);
  if (!got) throw typed(500, "DOCUMENT_STORAGE_IO", "El fichero original no está en el almacén.", { fileId: file.id });
  return got.bytes;
}

type DocumentContent = {
  mimeType: string;
  text: string | null;
  pagesText: string[];
  pageCount: number;
  xml: string | null;
  pages: DocumentImagePage[] | null;
  pdf: Buffer | null;
  warnings: string[];
};

/** Texto y forma del original según su MIME: PDF (capa de texto), XML (e-factura) o imagen (sin texto). */
export function contentOf(mimeType: string, bytes: Buffer, declaredPageCount: number): DocumentContent {
  const mime = mimeType.toLowerCase();
  const warnings: string[] = [];
  if (mime === "application/pdf") {
    try {
      const result = extractPdfText(bytes);
      if (!result.hasTextLayer) warnings.push("pdf_without_text_layer");
      if (result.truncated) warnings.push("pdf_text_truncated");
      const pagesText = result.pages.map((page) => page.text.trim());
      const text = pagesText.filter((page) => page.length > 0).join("\n\n");
      return { mimeType: mime, text: text.length > 0 ? text : null, pagesText, pageCount: result.pageCount || declaredPageCount || 1, xml: null, pages: null, pdf: bytes, warnings };
    } catch (error) {
      warnings.push(error instanceof PdfTextError ? `pdf_text:${error.code}` : "pdf_text:error");
      return { mimeType: mime, text: null, pagesText: [], pageCount: declaredPageCount || 1, xml: null, pages: null, pdf: bytes, warnings };
    }
  }
  if (mime === "application/xml" || mime === "text/xml") {
    const xml = bytes.toString("utf8");
    return { mimeType: mime, text: xml, pagesText: [], pageCount: 1, xml, pages: null, pdf: null, warnings };
  }
  return { mimeType: mime, text: null, pagesText: [], pageCount: declaredPageCount || 1, xml: null, pages: [{ mediaType: mime, base64: bytes.toString("base64") }], pdf: null, warnings };
}

/**
 * Trozo de un `split` lógico (RV-01): del PDF físico completo solo cuentan las
 * páginas de `sourcePages` (en su orden), renumeradas 1..n. El PDF entero no se
 * envía al modelo (extraería las facturas de los otros trozos): sin librería
 * PDF se trabaja con la capa de texto y se avisa (`pdf_split_text_only`).
 */
export function selectSourcePages(content: DocumentContent, sourcePages: number[] | null): DocumentContent {
  if (!sourcePages || content.mimeType !== "application/pdf") return content;
  const pagesText = sourcePages.map((page) => content.pagesText[page - 1] ?? "");
  const text = pagesText.filter((page) => page.length > 0).join("\n\n");
  const warnings = content.pdf ? [...content.warnings, "pdf_split_text_only"] : [...content.warnings];
  return { ...content, text: text.length > 0 ? text : null, pagesText, pageCount: sourcePages.length, pdf: null, warnings };
}

// ---------------------------------------------------------------------------
// Validar y proponer (compartido con proposeIncomingDocumentAction)
// ---------------------------------------------------------------------------

type SettingsRow = Awaited<ReturnType<Db["documentSettings"]["findUnique"]>>;

function aiAllowedKindsOf(settings: SettingsRow): IncomingDocumentKind[] {
  const raw = settings?.aiAllowedKindsJson;
  return Array.isArray(raw) ? raw.filter((value): value is IncomingDocumentKind => typeof value === "string") : [];
}

export type ValidationLookups = {
  supplier: SupplierLike | null;
  sageSupplier: SageSupplier | null;
  existingBills: ExistingBillLike[];
  sageReceived: SageReceived[];
  sha256Duplicate: { id: string; registryNumber: string | null } | null;
  receipts: GoodsReceiptLike[];
};

async function lookups(d: ReturnType<typeof deps>, row: IncomingDocument, kind: IncomingDocumentKind, fields: ExtractedDocumentFields): Promise<ValidationLookups> {
  const db = d.db;
  const nif = normalizeNif(fields.supplierTaxId);
  const number = documentNumberOf(fields);
  const supplierRow = nif ? await db.supplier.findFirst({ where: { organizationId: row.organizationId, taxId: nif }, orderBy: { createdAt: "asc" } }) : null;
  const supplier: SupplierLike | null = supplierRow
    ? { id: supplierRow.id, name: supplierRow.name, taxId: supplierRow.taxId, retentionRate: supplierRow.retentionRate === null ? null : supplierRow.retentionRate.toString(), defaultExpenseAccountCode: supplierRow.defaultExpenseAccountCode }
    : null;
  const sageDb = db as unknown as SageDb;
  const fiscal = kind === "invoice" || kind === "receipt" || kind === "delivery_note";
  const [sageSupplier, billRows, sageExact, sageFuzzy, sha256Twin, receiptRows] = await Promise.all([
    nif ? d.findSageSupplierByNif(sageDb, row.organizationId, nif) : Promise.resolve(null),
    nif || supplier
      ? db.supplierBill.findMany({
          where: {
            organizationId: row.organizationId,
            OR: [...(nif ? [{ supplierTaxId: nif }] : []), ...(supplier ? [{ supplierId: supplier.id }] : [])],
            NOT: { incomingDocumentId: row.id }
          },
          select: { id: true, invoiceNumber: true, total: true, issueDate: true, supplierTaxId: true, supplierId: true, status: true },
          orderBy: { createdAt: "desc" },
          take: 100
        })
      : Promise.resolve([]),
    fiscal && nif && number ? d.findSageReceivedByNifAndNumber(sageDb, row.organizationId, nif, number) : Promise.resolve([]),
    fiscal && nif && (fields.total !== null && fields.total !== undefined) ? d.findSageReceivedFuzzy(sageDb, row.organizationId, nif, fields.total, fields.issueDate ?? null) : Promise.resolve([]),
    db.incomingDocument.findFirst({ where: { organizationId: row.organizationId, sha256: row.sha256, id: { not: row.id }, deletedAt: null, mergedIntoId: null }, orderBy: { capturedAt: "asc" }, select: { id: true, registryNumber: true } }),
    fiscal && (nif || supplier)
      ? db.goodsReceipt.findMany({
          where: {
            organizationId: row.organizationId,
            propertyId: row.propertyId,
            status: { in: ["received", "matched"] },
            OR: [...(nif ? [{ supplierTaxId: nif }] : []), ...(supplier ? [{ supplierId: supplier.id }] : [])]
          },
          include: { lines: { orderBy: { lineNo: "asc" } } },
          orderBy: { deliveryDate: "desc" },
          take: 50
        })
      : Promise.resolve([])
  ]);
  const seen = new Set<string>();
  const sageReceived: SageReceived[] = [];
  for (const entry of [...sageExact, ...sageFuzzy]) {
    if (seen.has(entry.sourceId)) continue;
    seen.add(entry.sourceId);
    sageReceived.push(entry);
  }
  return {
    supplier,
    sageSupplier,
    existingBills: billRows.map((bill) => ({ id: bill.id, invoiceNumber: bill.invoiceNumber, total: bill.total.toString(), issueDate: dayString(bill.issueDate), supplierTaxId: bill.supplierTaxId, supplierId: bill.supplierId, status: bill.status })),
    sageReceived,
    sha256Duplicate: sha256Twin,
    receipts: receiptRows.map((receipt) => ({
      id: receipt.id,
      propertyId: receipt.propertyId,
      supplierId: receipt.supplierId,
      supplierTaxId: receipt.supplierTaxId,
      deliveryNoteNumber: receipt.deliveryNoteNumber,
      deliveryDate: dayString(receipt.deliveryDate),
      status: receipt.status,
      lines: receipt.lines.map((line) => ({ id: line.id, lineNo: line.lineNo, description: line.description, quantityReceived: line.quantityReceived.toString(), unitPrice: line.unitPrice?.toString() ?? null, base: line.base?.toString() ?? null }))
    }))
  };
}

async function autonomyOf(d: ReturnType<typeof deps>, propertyId: string, checks: DocumentChecks, action: string): Promise<DocumentPipelineAutonomy> {
  const setting = await d.db.propertyAiToolSetting.findUnique({ where: { propertyId_toolName: { propertyId, toolName: PROPOSE_TOOL_NAME } } });
  const level = setting?.automationLevel ?? (await d.getPropertyAiSettings(propertyId)).defaultAutomationLevel;
  const enabled = setting?.enabled ?? true;
  const allOk = Object.values(checks).every((check) => check.status === "ok");
  const autonomous = enabled && level === "autonomous" && allOk;
  return { level, enabled, wouldAutoArchive: autonomous && action === "archive", wouldCreateDraft: autonomous && action === "create_supplier_bill" };
}

type ValidatedProposal = { checks: DocumentChecks; proposal: BuiltProposal; autonomy: DocumentPipelineAutonomy; lookups: ValidationLookups };

async function validateAndPropose(d: ReturnType<typeof deps>, loaded: LoadedDocument, kind: IncomingDocumentKind, fields: ExtractedDocumentFields, settings: SettingsRow): Promise<ValidatedProposal> {
  const row = loaded.row;
  const found = await lookups(d, row, kind, fields);
  const settingsLike = settings
    ? { priceTolerancePct: settings.priceTolerancePct.toString(), quantityTolerance: settings.quantityTolerance.toString(), amountToleranceAbs: settings.amountToleranceAbs.toString(), requireMatchForApproval: settings.requireMatchForApproval }
    : null;
  const checks = validateDocument({
    kind,
    fields,
    propertyId: row.propertyId,
    supplier: found.supplier,
    sageSupplier: found.sageSupplier,
    existingBills: found.existingBills,
    sageReceived: found.sageReceived,
    sha256Duplicate: found.sha256Duplicate,
    receipts: found.receipts,
    settings: settingsLike
  });
  const proposal = buildProposal({
    kind,
    fields,
    propertyId: row.propertyId,
    propertyKind: loaded.property?.kind ?? null,
    supplier: found.supplier,
    sageSupplier: found.sageSupplier,
    checks,
    settings: settingsLike,
    capturedAt: row.capturedAt,
    incomingDocumentId: row.id,
    source: row.source,
    registryNumber: row.registryNumber
  });
  const autonomy = await autonomyOf(d, row.propertyId, checks, proposal.action);
  return { checks, proposal, autonomy, lookups: found };
}

function proposalJson(proposal: BuiltProposal, autonomy: DocumentPipelineAutonomy): Prisma.InputJsonValue {
  const { action: _action, ...body } = proposal;
  return JSON.parse(JSON.stringify({ ...body, autonomy })) as Prisma.InputJsonValue;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function checkStatuses(checks: DocumentChecks): Record<string, string> {
  return Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, check.status]));
}

async function ownTaxIdsOf(db: Db, loaded: LoadedDocument): Promise<string[]> {
  const ids = new Set<string>();
  const legalEntityIds = [loaded.row.legalEntityId, loaded.property?.legalEntityId].filter((value): value is string => Boolean(value));
  const entities = await db.legalEntity.findMany({ where: { organizationId: loaded.row.organizationId, ...(legalEntityIds.length > 0 ? {} : { isDefault: true }) }, select: { id: true, taxId: true } });
  for (const entity of entities) {
    if (legalEntityIds.length === 0 || legalEntityIds.includes(entity.id)) {
      const nif = normalizeNif(entity.taxId);
      if (nif) ids.add(nif);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// runDocumentPipeline
// ---------------------------------------------------------------------------

/** Envío automático a la oficina (autoSendToOffice): nunca lanza; DOCUMENT_SENT de sistema + aviso a los revisores del centro. */
async function autoSendToOffice(d: ReturnType<typeof deps>, row: IncomingDocument, actor: { organizationId: string; propertyId: string; correlationId: string; actorUserId?: string }, trigger: PipelineTrigger): Promise<boolean> {
  const sentAt = d.now();
  try {
    const result = await d.db.incomingDocument.updateMany({ where: { id: row.id, status: "captured", blockedAt: null, deletedAt: null }, data: { status: "sent_to_office", sentAt } });
    if (result.count !== 1) return false;
    d.audit({
      ...actor,
      actorType: "system",
      action: DOCUMENT_AUDIT_ACTIONS.sent,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: row.id,
      beforeJson: { status: "captured" },
      afterJson: { registryNumber: row.registryNumber, status: "sent_to_office", kind: row.kind, sha256: row.sha256, sizeBytes: row.sizeBytes, sentAt: sentAt.toISOString(), automatic: true, trigger }
    });
  } catch (error) {
    console.warn("[documents.pipeline] el envío automático a la oficina falló (el documento sigue captured)", { documentId: row.id, correlationId: actor.correlationId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  try {
    await notifyOfficeDocumentSent(d.db, { row: { id: row.id, organizationId: row.organizationId, propertyId: row.propertyId, registryNumber: row.registryNumber, kind: row.kind }, at: sentAt, excludeUserId: row.capturedBy });
  } catch (error) {
    console.warn("[documents.pipeline] no se pudo avisar a la oficina del envío automático", { documentId: row.id, correlationId: actor.correlationId, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

function classificationOf(result: ClassifyDocumentOutput): PipelineClassification {
  return { kind: result.kind, confidence: result.confidence, source: result.source, ...(result.note ? { note: result.note } : {}) };
}

function providerUnavailable(reason: string): HttpError {
  return typed(503, AI_PROVIDER_UNAVAILABLE, "El proveedor de IA no está disponible para esta extracción.", { reason });
}

export async function runDocumentPipeline(documentId: string, options: RunDocumentPipelineOptions): Promise<DocumentPipelineResult> {
  const d = deps();
  const db = d.db;
  const startedAt = d.now();
  const stage: PipelineStage = options.stage ?? "full";
  const loaded = await loadDocument(db, documentId);
  const row = loaded.row;
  const ai = d.ai();
  const description = ai.describe();
  const configured = description.configured;
  if (options.force && !configured) throw providerUnavailable("not_configured");
  const ctx: DocumentsAiContext = { organizationId: row.organizationId, propertyId: row.propertyId, correlationId: options.correlationId, ...(options.userId ? { userId: options.userId } : {}) };
  const runNo = (loaded.latest?.runNo ?? 0) + 1;
  const actor = { organizationId: row.organizationId, propertyId: row.propertyId, correlationId: options.correlationId, ...(options.userId ? { actorUserId: options.userId } : {}) };

  const humanFixed = row.classificationSource === "manual";
  let content: DocumentContent | null = null;
  let classification: PipelineClassification = humanFixed ? { kind: row.kind, confidence: row.kindConfidence === null ? null : Number(row.kindConfidence), source: "manual" } : { kind: row.kind, confidence: null, source: "rules" };
  let extractionResult: ExtractDocumentOutput | null = null;
  let extractionSource: ExtractDocumentOutput["source"] = configured ? "ai" : "text_rules";

  try {
    if (row.deletedAt) throw typed(409, "DOCUMENT_BLOCKED", "El documento fue purgado: no hay fichero que analizar.");
    if (!loaded.original) throw typed(500, "DOCUMENT_STORAGE_IO", "El documento no tiene fichero original.");
    const bytes = await bytesOf(d.storage, loaded.original);
    content = selectSourcePages(contentOf(loaded.original.mimeType, bytes, row.pageCount), parseSourcePages(row.sourcePagesJson));
    const fileName = loaded.original.fileName;

    // 2. Clasificar (nunca pisa una decisión humana).
    if (!humanFixed) {
      const hint = row.kind !== "unknown" ? row.kind : undefined;
      const result = await ai.classify({ text: content.text, fileName, mimeType: content.mimeType, ...(hint ? { kindHint: hint } : {}) }, ctx);
      if (options.force && configured && content.text && !content.xml && result.source !== "ai") throw providerUnavailable(result.note ?? "classification_failed");
      classification = classificationOf(result);
      if (classification.kind === "unknown" && hint) classification = { ...classification, kind: hint };
    }
    const kind = classification.kind;

    if (stage === "classify") {
      if (!humanFixed) {
        await db.incomingDocument.update({
          where: { id: row.id },
          data: { kind, kindConfidence: classification.confidence === null ? null : classification.confidence.toFixed(4), classificationSource: classification.source }
        });
        d.audit({ ...actor, actorType: classification.source === "ai" ? "ai" : "system", action: DOCUMENT_PIPELINE_AUDIT_ACTIONS.classified, entityType: DOCUMENT_AUDIT_ENTITY, entityId: row.id, beforeJson: { kind: row.kind }, afterJson: { kind, confidence: classification.confidence, source: classification.source, trigger: options.trigger } });
      }
      const fresh = loaded.latest ? await db.documentExtraction.findUnique({ where: { id: loaded.latest.id } }) : null;
      return { documentId: row.id, configured, provider: description.provider, classification, extraction: fresh ? toDocumentExtractionDto(fresh) : null, checks: null, proposal: null, autonomy: null };
    }

    // 3. Extraer.
    const settings = await db.documentSettings.findUnique({ where: { organizationId: row.organizationId } });
    const aiAllowedKinds = aiAllowedKindsOf(settings);
    extractionResult = await ai.extract(
      {
        kind,
        text: content.text,
        ...(content.pages ? { pages: content.pages } : {}),
        ...(configured && content.pdf ? { pdfBase64: content.pdf.toString("base64") } : {}),
        pageCount: content.pageCount,
        ...(content.xml ? { xml: content.xml } : {}),
        fileName,
        sha256: row.sha256,
        aiAllowedKinds
      },
      ctx
    );
    extractionSource = extractionResult.source;
    if (options.force && configured && !content.xml && extractionResult.source !== "ai") throw providerUnavailable(extractionResult.warnings[0] ?? "extraction_failed");
    const warnings = [...content.warnings, ...extractionResult.warnings];

    // 4-5. Validar y proponer (campos normalizados; la propia sociedad nunca es el proveedor).
    const ownTaxIds = await ownTaxIdsOf(db, loaded);
    const fields = swapOwnTaxId(normalizeExtractedFields(kind, extractionResult.fields, content.text), ownTaxIds);
    const validated = await validateAndPropose(d, loaded, kind, fields, settings);
    const durationMs = Math.max(0, d.now().getTime() - startedAt.getTime());
    const nif = normalizeNif(fields.supplierTaxId);
    const documentNumber = documentNumberOf(fields);
    const documentDate = isoDayOf(fields.issueDate ?? fields.deliveryDate ?? null);
    const total = fields.total === null || fields.total === undefined ? null : Number(fields.total);
    const searchText = buildPipelineSearchText(row, fields, content.pagesText);

    // 6. Persistir (una transacción): ejecución + documento + páginas. reviewedFieldsJson NUNCA se toca.
    const created = await db.$transaction(async (tx) => {
      const extraction = await tx.documentExtraction.create({
        data: {
          documentId: row.id,
          runNo,
          source: extractionResult!.source,
          provider: extractionResult!.provider,
          modelVersion: extractionResult!.model,
          schemaVersion: extractionResult!.schemaVersion,
          fieldsJson: toJson(extractionResult!.fields),
          confidenceJson: toJson(confidenceMap(extractionResult!.fields)),
          warningsJson: toJson(warnings),
          tokensInput: extractionResult!.telemetry?.tokensInput ?? null,
          tokensOutput: extractionResult!.telemetry?.tokensOutput ?? null,
          costEur: extractionResult!.telemetry?.costEur ?? null,
          durationMs,
          status: "done"
        }
      });
      await tx.incomingDocument.update({
        where: { id: row.id },
        data: {
          ...(humanFixed ? {} : { kind, kindConfidence: classification.confidence === null ? null : classification.confidence.toFixed(4), classificationSource: classification.source }),
          supplierTaxId: nif ?? row.supplierTaxId,
          supplierId: validated.lookups.supplier?.id ?? row.supplierId,
          documentNumber: documentNumber ?? row.documentNumber,
          documentDate: documentDate ?? row.documentDate,
          totalAmount: total !== null && Number.isFinite(total) ? total.toFixed(2) : row.totalAmount,
          checksJson: toJson(validated.checks),
          proposedAction: validated.proposal.action,
          proposedActionJson: proposalJson(validated.proposal, validated.autonomy),
          searchText,
          extractionStatus: "done",
          ...(row.pageCount === 0 && content!.pageCount > 0 ? { pageCount: content!.pageCount } : {})
        }
      });
      const pages = content!.pagesText.slice(0, MAX_PAGE_ROWS_WRITTEN);
      for (let index = 0; index < pages.length; index += 1) {
        const textExtracted = pages[index]!.length > 0 ? redactPii(pages[index]!, { kinds: ["card"] }).text : null;
        await tx.documentPage.upsert({
          where: { documentId_pageNo: { documentId: row.id, pageNo: index + 1 } },
          create: { documentId: row.id, pageNo: index + 1, textExtracted },
          update: { textExtracted }
        });
      }
      return extraction;
    });

    // Cola de la oficina: una sola revisión por documento (también sin proveedor).
    if (!row.reviewItemId) {
      const item = await d.enqueueReview({
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        reviewType: REVIEW_TYPE_INCOMING_DOCUMENT,
        relatedEntityType: REVIEW_TYPE_INCOMING_DOCUMENT,
        relatedEntityId: row.id,
        payloadJson: {
          registryNumber: row.registryNumber,
          kind,
          supplierTaxId: nif,
          supplierName: fields.supplierName ?? fields.senderName ?? null,
          documentNumber,
          total: total !== null && Number.isFinite(total) ? total : null,
          checks: checkStatuses(validated.checks),
          proposedAction: validated.proposal.action,
          extractionSource: extractionResult.source,
          configured
        },
        correlationId: options.correlationId,
        ...(options.userId ? { actorUserId: options.userId } : {})
      });
      await db.incomingDocument.updateMany({ where: { id: row.id, reviewItemId: null }, data: { reviewItemId: item.id } });
    }

    if (!humanFixed) {
      d.audit({ ...actor, actorType: classification.source === "ai" ? "ai" : "system", action: DOCUMENT_PIPELINE_AUDIT_ACTIONS.classified, entityType: DOCUMENT_AUDIT_ENTITY, entityId: row.id, beforeJson: { kind: row.kind }, afterJson: { kind, confidence: classification.confidence, source: classification.source, trigger: options.trigger } });
    }

    // 7. §6.1 fila captured → send-to-office «automático si autoSendToOffice» (RV-06): solo capturas y correos
    //    recién extraídos que sigan en captured (UPDATE condicional: no pisa a quien ya lo envió a mano).
    if ((options.trigger === "capture" || options.trigger === "email") && row.status === "captured" && settings?.autoSendToOffice === true) {
      await autoSendToOffice(d, row, actor, options.trigger);
    }
    d.audit({
      ...actor,
      actorType: extractionResult.source === "ai" ? "ai" : "system",
      action: DOCUMENT_PIPELINE_AUDIT_ACTIONS.extracted,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: row.id,
      afterJson: {
        runNo,
        status: "done",
        source: extractionResult.source,
        provider: extractionResult.provider,
        model: extractionResult.model,
        kind,
        fields: Object.keys(extractionResult.fields).length,
        warnings: warnings.length,
        costEur: extractionResult.telemetry?.costEur ?? null,
        checks: checkStatuses(validated.checks),
        proposedAction: validated.proposal.action,
        autonomy: validated.autonomy,
        trigger: options.trigger
      }
    });

    return {
      documentId: row.id,
      configured,
      provider: description.provider,
      classification,
      extraction: toDocumentExtractionDto(created),
      checks: validated.checks,
      proposal: { ...validated.proposal },
      autonomy: validated.autonomy
    };
  } catch (error) {
    // Nunca se traga: la ejecución queda failed con el error y extractionStatus = failed; el error se relanza.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const durationMs = Math.max(0, d.now().getTime() - startedAt.getTime());
    try {
      await db.documentExtraction.create({
        data: { documentId: row.id, runNo, source: extractionSource, provider: extractionResult?.provider ?? (configured ? description.provider : null), status: "failed", error: message, durationMs, warningsJson: toJson(content?.warnings ?? []) }
      });
      await db.incomingDocument.update({ where: { id: row.id }, data: { extractionStatus: "failed" } });
    } catch (persistError) {
      console.error("[documents.pipeline] no se pudo registrar el fallo de la extracción", { documentId: row.id, runNo, correlationId: options.correlationId, error: persistError instanceof Error ? persistError.message : String(persistError) });
    }
    d.audit({ ...actor, actorType: "system", action: DOCUMENT_PIPELINE_AUDIT_ACTIONS.extracted, entityType: DOCUMENT_AUDIT_ENTITY, entityId: row.id, afterJson: { runNo, status: "failed", error: message, trigger: options.trigger } });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// proposeIncomingDocumentAction (herramienta del registro, effect write)
// ---------------------------------------------------------------------------

export type ProposeDocumentActionInput = {
  documentId: string;
  organizationId: string;
  propertyId: string;
  correlationId: string;
  userId?: string;
  /** true (execute tras confirmación) escribe proposedAction / proposedActionJson y audita; false (preview) solo calcula. */
  persist: boolean;
};

export type ProposeDocumentActionResult = { documentId: string; registryNumber: string; kind: IncomingDocumentKind; runNo: number | null; checks: DocumentChecks; proposal: BuiltProposal; autonomy: DocumentPipelineAutonomy };

/** Recalcula comprobaciones y propuesta sobre la última extracción (con los campos revisados por encima) de un documento del centro. */
export async function proposeDocumentAction(input: ProposeDocumentActionInput): Promise<ProposeDocumentActionResult> {
  const d = deps();
  const db = d.db;
  const loaded = await loadDocument(db, input.documentId);
  const row = loaded.row;
  if (row.organizationId !== input.organizationId || row.propertyId !== input.propertyId) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
  const latest = loaded.latest && loaded.latest.status === "done" ? loaded.latest : null;
  const rawFields = (latest && isRecord(latest.fieldsJson) ? latest.fieldsJson : {}) as DocumentExtractedFields;
  const pages = await db.documentPage.findMany({ where: { documentId: row.id }, orderBy: { pageNo: "asc" }, select: { textExtracted: true }, take: MAX_PAGE_ROWS_WRITTEN });
  const text = pages.map((page) => page.textExtracted ?? "").join("\n\n") || null;
  const ownTaxIds = await ownTaxIdsOf(db, loaded);
  const fields = applyReviewedFields(swapOwnTaxId(normalizeExtractedFields(row.kind, rawFields, text), ownTaxIds), row.reviewedFieldsJson);
  const settings = await db.documentSettings.findUnique({ where: { organizationId: row.organizationId } });
  const validated = await validateAndPropose(d, loaded, row.kind, fields, settings);
  if (input.persist) {
    await db.incomingDocument.update({
      where: { id: row.id },
      data: { checksJson: toJson(validated.checks), proposedAction: validated.proposal.action, proposedActionJson: proposalJson(validated.proposal, validated.autonomy) }
    });
    d.audit({
      organizationId: row.organizationId,
      propertyId: row.propertyId,
      ...(input.userId ? { actorUserId: input.userId } : {}),
      actorType: "ai",
      action: DOCUMENT_PIPELINE_AUDIT_ACTIONS.proposed,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: row.id,
      beforeJson: { proposedAction: row.proposedAction },
      afterJson: { proposedAction: validated.proposal.action, checks: checkStatuses(validated.checks), autonomy: validated.autonomy, runNo: latest?.runNo ?? null },
      correlationId: input.correlationId
    });
  }
  return { documentId: row.id, registryNumber: row.registryNumber, kind: row.kind, runNo: latest?.runNo ?? null, checks: validated.checks, proposal: validated.proposal, autonomy: validated.autonomy };
}
