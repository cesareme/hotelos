/**
 * Documentos y digitalización con IA (Tanda T9 · L0, 2026-09-19): contrato wire
 * entre el API (`apps/api/src/modules/documents/*`, `goods-receipts.*`, la ruta
 * `…/supplier-bills/:billId/match` de payables) y el admin-web (Finanzas ›
 * Proveedores y gastos › Documentos / Archivo; Operaciones › Compras e inventario ›
 * Digitalizar / Recepciones).
 *
 * Qué es. Un `IncomingDocument` es un papel o fichero que entra en un centro
 * (factura, albarán, ticket, carta, notificación administrativa, contrato…),
 * recibe un número de registro, se clasifica y extrae (IA por ai-core o reglas de
 * texto cuando no hay proveedor), pasa por las comprobaciones del servidor
 * (`DocumentChecks`) y acaba en una acción de dominio propuesta
 * (`DocumentProposal`): factura de proveedor en borrador, gasto, recepción de
 * mercancía, tarea con plazo o archivo. El flujo centro → oficina y sus estados
 * están en docs/design/DOCUMENTOS-DIGITALIZACION.md §6.1.
 *
 * Convenciones (diseño §4-§9):
 *   · Dinero como `MoneyString` de payables-types ("1060.00", dos decimales, punto):
 *     nunca float. Cantidades (Decimal(12,3)), precios unitarios (Decimal(12,4)),
 *     tolerancias y costes de IA (Decimal(10,4)) viajan también como cadena
 *     decimal (`DecimalString`); el front solo formatea.
 *   · Días como `IsoDay` ("YYYY-MM-DD"); instantes (`…At`) como ISO-8601.
 *   · Los catálogos `as const` de este fichero son la única fuente de los valores
 *     de los enums Prisma homónimos (schema) y de los esquemas zod `.strict()`
 *     del API (`apps/api/src/schemas/documents.schemas.ts`).
 *   · Los bytes nunca viajan en los DTO de lectura: `DocumentFileDto` no lleva
 *     `storageKey` ni `inline`; la descarga es binaria (`GET …/documents/:id/file`).
 *   · Todo 4xx/5xx tipado lleva `details.code` ∈ `DOCUMENT_ERROR_CODES` y un
 *     mensaje en español (`services/finance-contracts.ts` en el front).
 *   · Sin dependencias de runtime.
 */
import type { ExpenseRequest, IsoDay, MoneyString, SupplierBillMatchStatus, SupplierBillRequest, SupplierBillSource } from "./payables-types.js";

/** Cadena decimal sin límite fijo de decimales ("12.500", "0.0123"); nunca float. */
export type DecimalString = string;

// ---------------------------------------------------------------------------
// Catálogos (= enums Prisma y esquemas zod)
// ---------------------------------------------------------------------------

/** Tipo de documento (enum Prisma `IncomingDocumentKind`). `unknown` = sin clasificar; el capturador elige. */
export const INCOMING_DOCUMENT_KINDS = ["invoice", "delivery_note", "receipt", "letter", "administrative_notice", "contract", "e_invoice_status", "other", "unknown"] as const;
export type IncomingDocumentKind = (typeof INCOMING_DOCUMENT_KINDS)[number];

/** Estado del flujo centro → oficina (enum Prisma `IncomingDocumentStatus`, diseño §6.1). */
export const INCOMING_DOCUMENT_STATUSES = ["captured", "sent_to_office", "in_review", "approved", "posted", "archived", "returned_to_centre", "rejected"] as const;
export type IncomingDocumentStatus = (typeof INCOMING_DOCUMENT_STATUSES)[number];

/** Canal de entrada (enum Prisma `IncomingDocumentSource`, diseño §4.1). */
export const INCOMING_DOCUMENT_SOURCES = ["upload", "mobile", "email", "scanner", "e_invoice", "api"] as const;
export type IncomingDocumentSource = (typeof INCOMING_DOCUMENT_SOURCES)[number];

/** Dónde está el papel (enum Prisma `DocumentPhysicalStatus`, diseño §6.4); `not_applicable` para e-mail / e-factura / API. */
export const DOCUMENT_PHYSICAL_STATUSES = ["at_centre", "in_transit", "at_office", "filed", "not_applicable"] as const;
export type DocumentPhysicalStatus = (typeof DOCUMENT_PHYSICAL_STATUSES)[number];

/** Adaptador del almacén (enum Prisma `DocumentStorageKind`, diseño §4.2). */
export const DOCUMENT_STORAGE_KINDS = ["inline", "disk", "s3"] as const;
export type DocumentStorageKind = (typeof DOCUMENT_STORAGE_KINDS)[number];

/** Papel de cada fichero del documento (`DocumentFile.role`). */
export const DOCUMENT_FILE_ROLES = ["original", "page_image", "label", "dispatch_sheet", "derived"] as const;
export type DocumentFileRole = (typeof DOCUMENT_FILE_ROLES)[number];

/** `IncomingDocument.extractionStatus`: la extracción corre en segundo plano, independiente del estado. */
export const DOCUMENT_EXTRACTION_STATUSES = ["pending", "done", "failed", "skipped"] as const;
export type DocumentExtractionStatus = (typeof DOCUMENT_EXTRACTION_STATUSES)[number];

/** Origen de una ejecución de extracción (`DocumentExtraction.source`). */
export const DOCUMENT_EXTRACTION_SOURCES = ["ai", "text_rules", "e_invoice", "manual"] as const;
export type DocumentExtractionSource = (typeof DOCUMENT_EXTRACTION_SOURCES)[number];

/** Estado de una ejecución de extracción (`DocumentExtraction.status`). */
export const DOCUMENT_EXTRACTION_RUN_STATUSES = ["done", "failed", "skipped"] as const;
export type DocumentExtractionRunStatus = (typeof DOCUMENT_EXTRACTION_RUN_STATUSES)[number];

/** Quién decidió el tipo (`IncomingDocument.classificationSource`). */
export const DOCUMENT_CLASSIFICATION_SOURCES = ["ai", "rules", "manual"] as const;
export type DocumentClassificationSource = (typeof DOCUMENT_CLASSIFICATION_SOURCES)[number];

/** Acción de dominio que la revisión ejecuta al aprobar (diseño §5.1 «Proponer», §7). */
export const DOCUMENT_PROPOSED_ACTIONS = ["create_supplier_bill", "create_expense", "create_goods_receipt", "create_task", "archive"] as const;
export type DocumentProposedAction = (typeof DOCUMENT_PROPOSED_ACTIONS)[number];

/** Motivo de rechazo: `illegible | missing_pages | other` devuelven al centro; `duplicate | not_ours | other` cierran (§6.1). */
export const DOCUMENT_REJECT_REASONS = ["illegible", "missing_pages", "duplicate", "not_ours", "other"] as const;
export type DocumentRejectReason = (typeof DOCUMENT_REJECT_REASONS)[number];

/** Tipo de tarea con plazo creada desde correspondencia y notificaciones (§7.3). */
export const DOCUMENT_ACTION_KINDS = ["respond", "pay", "file", "forward", "verify"] as const;
export type DocumentActionKind = (typeof DOCUMENT_ACTION_KINDS)[number];

/** Ciclo propio de la tarea (enum Prisma `DocumentActionStatus`). */
export const DOCUMENT_ACTION_STATUSES = ["open", "done", "cancelled"] as const;
export type DocumentActionStatus = (typeof DOCUMENT_ACTION_STATUSES)[number];

/** Estado de una recepción de mercancía (enum Prisma `GoodsReceiptStatus`, §7.2). */
export const GOODS_RECEIPT_STATUSES = ["received", "matched", "billed", "disputed"] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

/** Estado de un cotejo línea de factura ↔ línea de albarán (`BillLineMatch.status`). */
export const BILL_LINE_MATCH_STATUSES = ["auto", "confirmed", "rejected"] as const;
export type BillLineMatchStatus = (typeof BILL_LINE_MATCH_STATUSES)[number];

/** Resultado de cada comprobación del servidor (§5.1 «Validar»). */
export const CHECK_STATUSES = ["ok", "warn", "fail"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Comprobaciones que el servidor ejecuta siempre, con o sin IA (`IncomingDocument.checksJson`). */
export const DOCUMENT_CHECK_KEYS = ["nif", "supplier", "totals", "vat", "duplicate", "retention", "match"] as const;
export type DocumentCheckKey = (typeof DOCUMENT_CHECK_KEYS)[number];

/** Lista blanca de MIME admitidos en la subida (validados además por magic bytes, §4.2). */
export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/tiff", "application/xml", "text/xml"] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

/** Límites de la subida (§9): ficheros por petición y longitud del nombre. */
export const DOCUMENT_UPLOAD_MAX_FILES = 20;
export const DOCUMENT_FILE_NAME_MAX_LENGTH = 200;

// `SUPPLIER_BILL_SOURCES` / `SUPPLIER_BILL_MATCH_STATUSES` (valores de `SupplierBill.source` /
// `matchStatus`, §7.1) viven en payables-types.ts junto al resto del contrato de la factura.

// ---------------------------------------------------------------------------
// Documento: registro, detalle, ficheros, páginas, extracción
// ---------------------------------------------------------------------------

/** Fila de bandeja, cola o archivo (`IncomingDocument` sin JSON pesados; §8). */
export type IncomingDocumentRecord = {
  id: string;
  organizationId: string;
  legalEntityId: string | null;
  /** Centro receptor (el centro de trabajo del documento; nunca la oficina salvo `Property.kind = office`). */
  propertyId: string;
  /** `DOC-<Property.code>-<AAAA>-<nnnnnn>` (§6.4). */
  registryNumber: string;
  kind: IncomingDocumentKind;
  /** 0..1 de la clasificación (Decimal(5,4) en BD); null cuando la eligió una persona o no hay clasificación. */
  kindConfidence: number | null;
  classificationSource: DocumentClassificationSource | null;
  status: IncomingDocumentStatus;
  physicalStatus: DocumentPhysicalStatus;
  source: IncomingDocumentSource;
  /** MIME del fichero original. */
  originalFormat: string | null;
  title: string | null;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  supplierId: string | null;
  supplierTaxId: string | null;
  /** Nombre resuelto del proveedor (`Supplier.name` si hay `supplierId`; si no, el extraído). */
  supplierName: string | null;
  /** Nº de factura / albarán / expediente extraído. */
  documentNumber: string | null;
  documentDate: IsoDay | null;
  totalAmount: MoneyString | null;
  currency: "EUR" | string;
  extractionStatus: DocumentExtractionStatus;
  proposedAction: DocumentProposedAction | null;
  /** Plazo de la tarea asociada o el derivado del tipo (§3.5); la cola lo pinta en rojo a 2 días. */
  dueAt: string | null;
  /** Calculado en lectura: `sentAt` + SLA de la oficina (`DocumentSettings.officeSlaBusinessDays`) vencido sin decisión (§6.3). */
  slaBreached: boolean;
  capturedBy: string | null;
  capturedAt: string;
  sentAt: string | null;
  assignedTo: string | null;
  reviewStartedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectReason: DocumentRejectReason | null;
  rejectNote: string | null;
  supplierBillId: string | null;
  expenseId: string | null;
  goodsReceiptId: string | null;
  /** `AiHumanReviewItem` informativo de la cola genérica (relatedEntityType incoming_document). */
  reviewItemId: string | null;
  dispatchBatchId: string | null;
  /** Documento que lo absorbió en un `merge` (§6.1). */
  mergedIntoId: string | null;
  postedAt: string | null;
  archivedAt: string | null;
  retentionUntil: IsoDay | null;
  extendedRetention: boolean;
  legalHold: boolean;
  /** Retención vencida: invisible salvo `documents.admin` (§7.5). */
  blockedAt: string | null;
  /** Purgado: el fichero ya no existe en el almacén (§7.5). */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Fichero del documento (original, imágenes de página, etiqueta, hoja de remesa). Sin bytes ni clave del almacén. */
export type DocumentFileDto = {
  id: string;
  documentId: string;
  role: DocumentFileRole;
  pageNo: number | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKind: DocumentStorageKind;
  encrypted: boolean;
  uploadedBy: string | null;
  createdAt: string;
};

/** Página del documento (`DocumentPage`, §4.3). El texto va aparte del `searchText` del documento. */
export type DocumentPageDto = {
  id: string;
  pageNo: number;
  /** Clasificación por página (IA) o null. */
  kind: IncomingDocumentKind | null;
  /** true = continuación de la página anterior (mismo documento lógico). */
  isContinuation: boolean;
  textExtracted: string | null;
  /** `DocumentFileDto.id` de la imagen rasterizada (role page_image) o null. */
  imageFileId: string | null;
  width: number | null;
  height: number | null;
};

/** Una ejecución de extracción (`DocumentExtraction`, §5.1). Nunca sobrescribe la edición humana (`reviewedFields`). */
export type DocumentExtractionDto = {
  id: string;
  documentId: string;
  runNo: number;
  source: DocumentExtractionSource;
  /** Proveedor de ai-core ("anthropic", "none") o null para reglas / e-factura / manual. */
  provider: string | null;
  modelVersion: string | null;
  /** Versión del esquema JSON por tipo (`documents/schemas/*.json`). */
  schemaVersion: string;
  /** Campos extraídos (`fieldsJson`): claves del esquema del tipo; importes como cadena decimal. */
  fields: Record<string, unknown>;
  /** Confianza 0..1 por campo (`confidenceJson`); ausente = manual. */
  confidence: Record<string, number>;
  /** Avisos del extractor (cobertura limitada de `text_rules`, IVA no soportado…). */
  warnings: string[];
  tokensInput: number | null;
  tokensOutput: number | null;
  /** Coste de la llamada (Decimal(10,4) en BD, serializado como cadena decimal); null sin proveedor. */
  costEur: MoneyString | null;
  durationMs: number | null;
  status: DocumentExtractionRunStatus;
  error: string | null;
  createdAt: string;
};

/** Una comprobación del servidor con su mensaje en español y detalles opcionales (id del duplicado, importes…). */
export type DocumentCheck = {
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

/** `IncomingDocument.checksJson` (§5.1 «Validar»): las siete siempre presentes. */
export type DocumentChecks = Record<DocumentCheckKey, DocumentCheck>;

/** Propuesta de alta de proveedor cuando el NIF no existe; `fromSage` = coincide con un tercero del libro importado de Sage. */
export type DocumentSupplierProposal = {
  fromSage: boolean;
  name: string;
  taxId: string | null;
};

/** `IncomingDocument.proposedAction` + `proposedActionJson` (§5.1 «Proponer»): el cuerpo de la acción viene completo y revisable. */
export type DocumentProposal = {
  action: DocumentProposedAction;
  supplierBill?: SupplierBillRequest;
  expense?: ExpenseRequest;
  goodsReceipt?: GoodsReceiptRequest;
  task?: DocumentActionRequest;
  supplierProposal?: DocumentSupplierProposal;
};

/** Tarea con plazo (`DocumentAction`, §7.3): la única entidad de tarea del módulo. */
export type DocumentActionDto = {
  id: string;
  organizationId: string;
  propertyId: string;
  documentId: string;
  kind: DocumentActionKind;
  title: string;
  description: string | null;
  assignedTo: string | null;
  dueAt: string | null;
  status: DocumentActionStatus;
  outcomeNote: string | null;
  completedBy: string | null;
  completedAt: string | null;
  createdBy: string | null;
  createdAt: string;
};

/** `GET /properties/:propertyId/documents/:id` (§9). */
export type IncomingDocumentDetail = IncomingDocumentRecord & {
  files: DocumentFileDto[];
  pages: DocumentPageDto[];
  /** Última ejecución (`runNo` mayor) o null si aún está `pending`. */
  extraction: DocumentExtractionDto | null;
  checks: DocumentChecks | null;
  proposal: DocumentProposal | null;
  /** Campos corregidos por la persona revisora (`reviewedFieldsJson`) o null. */
  reviewedFields: Record<string, unknown> | null;
  actions: DocumentActionDto[];
  /** Cotejos de las líneas de la factura enlazada (vacío si no hay factura o albarán). */
  matches: BillLineMatchDto[];
  reviewItemId: string | null;
  /** Cuando `rejectReason = duplicate`: el documento original (§6.1). */
  duplicateOfId: string | null;
};

// ---------------------------------------------------------------------------
// Peticiones del flujo (§9)
// ---------------------------------------------------------------------------

/** Un fichero de la subida: JSON base64 como el resto de la API (`bodyLimit` por ruta). */
export type DocumentUploadFile = {
  /** ≤ DOCUMENT_FILE_NAME_MAX_LENGTH caracteres. */
  fileName: string;
  mimeType: DocumentMimeType | string;
  base64: string;
};

/** `POST /properties/:propertyId/documents` → 201 `IncomingDocumentRecord[]` (uno por fichero). */
export type DocumentUploadRequest = {
  /** 1..DOCUMENT_UPLOAD_MAX_FILES ficheros. */
  files: DocumentUploadFile[];
  kindHint?: IncomingDocumentKind;
  note?: string;
  /** Copia legítima (factura reenviada): salta el 409 DOCUMENT_DUPLICATE_FILE por sha256 (§4.2). */
  allowDuplicate?: boolean;
  /** Canal declarado por el cliente (`upload` por defecto, `mobile` desde la PWA); `email` / `e_invoice` / `scanner` los fija el servidor. */
  source?: IncomingDocumentSource;
  /** Separar el fichero en un documento por página (lotes del MFP, §4.3). */
  splitPages?: boolean;
};

/** `POST …/documents/:id/files` (reverso, anexo) y `POST …/documents/:id/recapture` (fichero nuevo, mismo registro). */
export type DocumentAddFileRequest = DocumentUploadFile & {
  role?: DocumentFileRole;
  note?: string;
};

/** `POST …/documents/:id/classify` · `…/extract`: `force` exige proveedor (503 AI_PROVIDER_UNAVAILABLE si no lo hay). */
export type DocumentExtractRequest = {
  force?: boolean;
};

/** Respuesta de classify / extract: sin proveedor, `configured:false` y `extraction.source = text_rules` o null. */
export type DocumentExtractResponse = {
  configured: boolean;
  extraction: DocumentExtractionDto | null;
  document: IncomingDocumentRecord;
};

/** `POST …/documents/:id/split`: rangos de páginas 1-based e inclusivos; cada trozo nace `captured` con registro propio. */
export type DocumentSplitRequest = {
  ranges: Array<[number, number]>;
};

/** `POST …/documents/:id/merge`: los absorbidos pasan a `archived` con `mergedIntoId`. */
export type DocumentMergeRequest = {
  withIds: string[];
};

/** `POST …/documents/:id/assign` (§6.1): null = desasignar. */
export type DocumentAssignRequest = {
  assignedTo?: string | null;
};

/** `POST …/documents/:id/review`: guarda campos revisados y el tipo corregido; no ejecuta nada. */
export type DocumentReviewRequest = {
  reviewedFields: Record<string, unknown>;
  kind?: IncomingDocumentKind;
  note?: string;
};

/** Aprobación con un `check` en `fail`: solo con motivo explícito (auditado). */
export type DocumentApproveOverride = {
  reason: string;
};

/**
 * `POST …/documents/:id/approve` (§6.1, §7): `action` + el cuerpo revisado de esa
 * acción (`supplierBill` para create_supplier_bill, `expense` para create_expense,
 * `goodsReceipt` para create_goods_receipt, `task` para create_task; `archive` no
 * lleva cuerpo). Cuerpo de otra acción → 400 DOCUMENT_ACTION_INVALID_FOR_KIND.
 */
export type DocumentApproveRequest = {
  action: DocumentProposedAction;
  supplierBill?: SupplierBillRequest;
  expense?: ExpenseRequest;
  goodsReceipt?: GoodsReceiptRequest;
  task?: DocumentActionRequest;
  override?: DocumentApproveOverride;
};

/** `POST …/documents/:id/approve` → 200: el documento y la entidad creada. */
export type DocumentApproveResponse = {
  document: IncomingDocumentRecord;
  supplierBillId?: string;
  expenseId?: string;
  goodsReceiptId?: string;
  actionId?: string;
};

/** `POST …/documents/:id/reject`: `returnToCentre` exige `illegible | missing_pages | other`; `duplicate` admite `duplicateOfId`. */
export type DocumentRejectRequest = {
  reason: DocumentRejectReason;
  note?: string;
  returnToCentre?: boolean;
  duplicateOfId?: string;
};

/** `POST …/documents/:id/archive` (cartas, contratos, otros; §3.2 retención por tipo). */
export type DocumentArchiveRequest = {
  retentionUntil?: IsoDay;
  extendedRetention?: boolean;
  legalHold?: boolean;
};

/** `POST …/documents/:id/block` · `…/unblock` · `…/purge` (`documents.admin`, §7.5). */
export type DocumentAdminActionRequest = {
  reason: string;
};

/** `POST …/documents/:id/actions` (§7.3) y cuerpo de `create_task`. */
export type DocumentActionRequest = {
  kind: DocumentActionKind;
  title: string;
  description?: string;
  assignedTo?: string | null;
  /** ISO-8601; por defecto el plazo del tipo (§3.5) o ninguno. */
  dueAt?: string | null;
};

/** `PATCH …/documents/:id/actions/:actionId`. */
export type DocumentActionPatchRequest = {
  status: DocumentActionStatus;
  outcomeNote?: string;
};

// ---------------------------------------------------------------------------
// Listas, cola, archivo, KPIs, ajustes (§9)
// ---------------------------------------------------------------------------

/** Query de `GET /properties/:propertyId/documents` y `GET /organizations/:organizationId/documents/queue` (paginación de lib/pagination.ts). */
export type DocumentQueueFilters = {
  status?: IncomingDocumentStatus | IncomingDocumentStatus[];
  kind?: IncomingDocumentKind;
  physicalStatus?: DocumentPhysicalStatus;
  /** Solo en la cola de la oficina: un centro de la sociedad. */
  propertyId?: string;
  assignedTo?: string;
  /** Solo documentos con SLA incumplido. */
  slaBreachedOnly?: boolean;
  from?: IsoDay;
  to?: IsoDay;
  /** Texto: nº de registro, proveedor, NIF, nº de documento. */
  q?: string;
  cursor?: string;
  limit?: number;
};

/** Query de `GET /organizations/:organizationId/documents/archive` (§7.4). */
export type DocumentArchiveFilters = {
  /** Texto extraído (`searchText`). */
  q?: string;
  kind?: IncomingDocumentKind;
  supplierId?: string;
  propertyId?: string;
  from?: IsoDay;
  to?: IsoDay;
  amountMin?: MoneyString;
  amountMax?: MoneyString;
  registryNumber?: string;
  /** Solo `documents.admin`: incluir bloqueados por retención vencida. */
  includeBlocked?: boolean;
  cursor?: string;
  limit?: number;
};

/** Página de lista (contrato `lib/pagination.ts`: `nextCursor` null en la última). */
export type DocumentListPage<T = IncomingDocumentRecord> = {
  items: T[];
  nextCursor: string | null;
};

/** Métrica que no se pudo calcular (proveedor de IA sin configurar, sin datos del periodo…). */
export type DocumentKpiDegraded = {
  metric: string;
  reason: string;
};

/** `GET /organizations/:organizationId/documents/kpis?from&to&propertyId` (§9). */
export type DocumentKpis = {
  from: IsoDay;
  to: IsoDay;
  propertyId: string | null;
  /** SLA de la oficina en vigor (`DocumentSettings.officeSlaBusinessDays`, 2 por defecto): el front lo usa para «Vence en N días» (RV-14). */
  officeSlaBusinessDays: number;
  pendingByProperty: Array<{
    propertyId: string;
    propertyCode: string | null;
    propertyName: string;
    pending: number;
    slaBreached: number;
  }>;
  /** Media de horas entre `capturedAt` y `sentAt`; null sin envíos en el periodo. */
  avgHoursCentreToOffice: number | null;
  /** % de documentos aprobados sin corregir ningún campo extraído; null sin aprobaciones. */
  touchlessPct: number | null;
  billsWithoutReceipt: number;
  receiptsWithoutBill: number;
  slaBreached: number;
  actionsDueThisWeek: number;
  /** Suma de `DocumentExtraction.costEur` del periodo. */
  aiCostEur: MoneyString;
  degraded: DocumentKpiDegraded[];
};

/** `GET/PATCH /organizations/:organizationId/documents/settings` (`DocumentSettings`, una fila por organización; §8). */
export type DocumentSettingsDto = {
  organizationId: string;
  /** SLA de la oficina desde `sentAt` (2 por defecto, §6.3). */
  officeSlaBusinessDays: number;
  autoSendToOffice: boolean;
  /** Tipos que la IA puede clasificar/extraer en esta organización (`aiAllowedKindsJson`). */
  aiAllowedKinds: IncomingDocumentKind[];
  /** Tolerancias del cotejo (§7.2): % de precio ("2.00"), cantidad ("0.000"), importe absoluto. */
  priceTolerancePct: DecimalString;
  quantityTolerance: DecimalString;
  amountToleranceAbs: MoneyString;
  /** 409 SUPPLIER_BILL_MATCH_REQUIRED al aprobar facturas con `matchStatus = variance` (o `none` con albaranes pendientes). */
  requireMatchForApproval: boolean;
  retentionYearsDefault: number;
  letterRetentionYears: number;
  updatedAt: string | null;
};

export type DocumentSettingsPatchRequest = Partial<Omit<DocumentSettingsDto, "organizationId" | "updatedAt">>;

/** Hoja de remesa del centro (`DocumentDispatchBatch`, §6.4). */
export type DocumentDispatchBatchDto = {
  id: string;
  propertyId: string;
  batchNumber: string;
  closedBy: string;
  closedAt: string;
  receivedBy: string | null;
  receivedAt: string | null;
  documentCount: number;
  /** `DocumentFileDto.id` del PDF de la hoja (role dispatch_sheet) o null. */
  sheetFileId: string | null;
  /** Números de registro incluidos (solo en el detalle). */
  registryNumbers?: string[];
};

/** `POST /properties/:propertyId/documents/dispatch-batches`: cierra la valija → `in_transit`. */
export type DocumentDispatchBatchRequest = {
  documentIds: string[];
};

/** `POST …/dispatch-batches/:batchId/receive`: la oficina marca lo que llegó → `at_office`. */
export type DocumentDispatchReceiveRequest = {
  receivedIds: string[];
};

// ---------------------------------------------------------------------------
// Recepciones de mercancía y cotejo (§7.2)
// ---------------------------------------------------------------------------

/** Línea de albarán; cantidades y precios como cadena decimal (Decimal(12,3) / Decimal(12,4)). */
export type GoodsReceiptLineRequest = {
  description: string;
  quantityReceived: number | string;
  unit?: string | null;
  unitPrice?: number | string | null;
  base?: number | string | null;
  /** 21 | 10 | 4 | 7 | 3 | 2 | 0 */
  taxRate?: number | string | null;
  inventoryItemId?: string | null;
  purchaseOrderLineId?: string | null;
  quantityOrdered?: number | string | null;
};

/** `POST /properties/:propertyId/goods-receipts` y cuerpo de `create_goods_receipt`. */
export type GoodsReceiptRequest = {
  supplierId?: string | null;
  /** Cuando no hay `supplierId`: proveedor nuevo o desconocido. */
  supplierName?: string;
  supplierTaxId?: string | null;
  /** Único por (organización, proveedor) → 409 GOODS_RECEIPT_DUPLICATE. */
  deliveryNoteNumber: string;
  deliveryDate: IsoDay;
  purchaseOrderId?: string | null;
  receivedBy?: string | null;
  /** Con `inventoryItemId` en la línea, crea el `StockMovement receipt` en la misma transacción. */
  stockLocationId?: string | null;
  note?: string;
  lines: GoodsReceiptLineRequest[];
};

export type GoodsReceiptLineDto = {
  id: string;
  lineNo: number;
  description: string;
  inventoryItemId: string | null;
  purchaseOrderLineId: string | null;
  quantityOrdered: DecimalString | null;
  quantityReceived: DecimalString;
  unit: string | null;
  unitPrice: DecimalString | null;
  base: MoneyString | null;
  taxRate: string | null;
  stockMovementId: string | null;
};

export type GoodsReceiptRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  supplierId: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  deliveryNoteNumber: string;
  deliveryDate: IsoDay;
  purchaseOrderId: string | null;
  status: GoodsReceiptStatus;
  /** Id de usuario (recepción desde un documento) o nombre tecleado en el alta manual. */
  receivedBy: string | null;
  /** Nombre completo cuando `receivedBy` es un usuario de la organización (RV-16); null si no resuelve. */
  receivedByName: string | null;
  incomingDocumentId: string | null;
  /** Nº de registro del documento origen (si lo hay). */
  registryNumber: string | null;
  note: string | null;
  lineCount: number;
  /** Suma de las bases de las líneas con importe. */
  baseTotal: MoneyString;
  createdAt: string;
  updatedAt: string;
};

export type GoodsReceiptDetail = GoodsReceiptRecord & {
  lines: GoodsReceiptLineDto[];
  matches: BillLineMatchDto[];
  /** Facturas de proveedor con alguna línea cotejada contra este albarán. */
  supplierBillIds: string[];
};

/** `POST …/goods-receipts/:id/dispute` → `disputed`. */
export type GoodsReceiptDisputeRequest = {
  reason: string;
};

/** Query de `GET /properties/:propertyId/goods-receipts`. */
export type GoodsReceiptFilters = {
  status?: GoodsReceiptStatus;
  supplierId?: string;
  from?: IsoDay;
  to?: IsoDay;
  q?: string;
  cursor?: string;
  limit?: number;
};

/** Cotejo a 2 vías (`BillLineMatch`, §7.2); variaciones como cadena decimal con signo. */
export type BillLineMatchDto = {
  id: string;
  supplierBillLineId: string;
  goodsReceiptLineId: string;
  purchaseOrderLineId: string | null;
  matchedQuantity: DecimalString | null;
  matchedBase: MoneyString | null;
  quantityVariance: DecimalString | null;
  priceVariance: DecimalString | null;
  status: BillLineMatchStatus;
  matchedBy: string | null;
  createdAt: string;
};

/** `POST /properties/:propertyId/payables/supplier-bills/:billId/match`: albaranes concretos o `auto` (mismo proveedor y centro). */
export type SupplierBillMatchRequest = {
  goodsReceiptIds?: string[];
  auto?: boolean;
};

export type SupplierBillMatchResponse = {
  supplierBillId: string;
  matchStatus: SupplierBillMatchStatus;
  matches: BillLineMatchDto[];
};

// ---------------------------------------------------------------------------
// Errores (§9)
// ---------------------------------------------------------------------------

/**
 * Todo `details.code` de las rutas de documentos y recepciones: 400 (VALIDATION_ERROR,
 * DOCUMENT_MIME_NOT_ALLOWED, DOCUMENT_CONTENT_MISMATCH, DOCUMENT_ACTION_INVALID_FOR_KIND,
 * DOCUMENT_CHECKS_FAILED; en recepciones INVENTORY_ITEM_INVALID, STOCK_LOCATION_INVALID,
 * STOCK_QUANTITY_TOO_SMALL), 404 opacos (DOCUMENT_NOT_FOUND, PROPERTY_NOT_FOUND,
 * ENTITY_SCOPE_REQUIRED) y 404 explícito DOCUMENT_PAGE_IMAGE_UNAVAILABLE (página sin imagen:
 * el original no está rasterizado), 409 (DOCUMENT_DUPLICATE_FILE, DOCUMENT_STATUS_TRANSITION,
 * DOCUMENT_BLOCKED, DOCUMENT_LEGAL_HOLD, GOODS_RECEIPT_DUPLICATE,
 * SUPPLIER_BILL_MATCH_REQUIRED), 413 (DOCUMENT_TOO_LARGE) y 503 (AI_PROVIDER_UNAVAILABLE,
 * solo con `force`). Los 409 del dominio payables (SUPPLIER_BILL_DUPLICATE…) se reenvían
 * con su `PayablesErrorCode`.
 */
export const DOCUMENT_ERROR_CODES = [
  "VALIDATION_ERROR",
  "DOCUMENT_MIME_NOT_ALLOWED",
  "DOCUMENT_CONTENT_MISMATCH",
  "DOCUMENT_ACTION_INVALID_FOR_KIND",
  "DOCUMENT_NOT_FOUND",
  "PROPERTY_NOT_FOUND",
  "ENTITY_SCOPE_REQUIRED",
  "DOCUMENT_DUPLICATE_FILE",
  "DOCUMENT_STATUS_TRANSITION",
  "DOCUMENT_BLOCKED",
  "DOCUMENT_LEGAL_HOLD",
  "GOODS_RECEIPT_DUPLICATE",
  "SUPPLIER_BILL_MATCH_REQUIRED",
  "DOCUMENT_TOO_LARGE",
  "AI_PROVIDER_UNAVAILABLE",
  "DOCUMENT_CHECKS_FAILED",
  "DOCUMENT_PAGE_IMAGE_UNAVAILABLE",
  "INVENTORY_ITEM_INVALID",
  "STOCK_LOCATION_INVALID",
  "STOCK_QUANTITY_TOO_SMALL"
] as const;
export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];
