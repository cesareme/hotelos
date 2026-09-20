// Documentos · servicio de captura, bandeja, detalle, descarga, envío a la
// oficina, recaptura y cola de la oficina (Tanda T9 · lote T9-05a; diseño
// §4.2, §4.3, §6.1 filas alta / send-to-office / recapture, §6.3, §6.4, §9).
//
// Reglas que este fichero hace cumplir:
//   · tenencia: toda fila se recomprueba contra el centro / la organización de
//     la petición (404 opaco DOCUMENT_NOT_FOUND / PROPERTY_NOT_FOUND);
//   · subida: tamaño (413 DOCUMENT_TOO_LARGE, calculado ANTES de decodificar),
//     lista blanca MIME + magic bytes (400, magic-bytes.ts), sha256 en servidor,
//     dedupe por (organización, sha256) → 409 DOCUMENT_DUPLICATE_FILE salvo
//     allowDuplicate; clave del almacén construida en servidor (storage.ts);
//   · orden de escritura: storage.put ANTES de la transacción de BD (si put
//     falla no se crea la fila); si la transacción falla se borra la clave
//     (best-effort) y se relanza;
//   · transiciones de estado con applyDocumentStatus (409
//     DOCUMENT_STATUS_TRANSITION { from, action }); T9-08 reutiliza la función;
//   · lectura: bloqueados invisibles salvo documents.admin (§7.5), purgados
//     nunca; slaBreached y dueAt calculados en lectura (§6.3, §3.5);
//   · permisos: el manifiesto (route-permissions.partial.ts) exige la clave en
//     las escrituras; las lecturas compartidas «capture | review (| archive)» no
//     caben en el manifiesto (assertPermissions es de conjunción), así que van
//     como `authenticated`: las rutas exigen SESIÓN REAL (requireRealSession →
//     401 al fallback demo sin token, RV-02) y ESTE servicio exige la disyunción
//     con PermissionDeniedError (mismo 403 que el gate);
//   · auditoría sin datos personales (SEC-02): la nota de captura y, en el
//     correo, el nombre del adjunto nunca van al afterJson (solo ids del mensaje
//     y del adjunto); remitente y asunto viven en emailMetaJson / searchText,
//     que la purga y la supresión sí pseudonimizan;
//   · avisos (§6.3, RV-10): al enviar a la oficina, aviso in-app a quien puede
//     revisar en el centro (documents.review), agrupado por hora
//     (office-notifications.ts); el envío nunca falla por el aviso.
//
// Dependencias inyectables (createDocumentsService) para tests sin BD: el
// almacén, el reloj y el asignador de registro. El resto de la lógica de
// captura (páginas, dedupe, claves, SLA, cursor) es pura y está exportada.

import { prisma } from "@hotelos/database";
import type { BillLineMatch, DocumentAction, DocumentExtraction, DocumentFile, DocumentPage, IncomingDocument, Prisma } from "@prisma/client";
import {
  PermissionDeniedError,
  type DocumentFileDto,
  type IncomingDocumentDetail,
  type IncomingDocumentKind,
  type IncomingDocumentRecord,
  type IncomingDocumentSource,
  type IncomingDocumentStatus,
  type PermissionKey
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { assertFinanceReadScope, hasEntityReadScope, propertyWithinScope } from "../../lib/finance-scope.js";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { buildPage, decodeCursor, parsePageQuery, type Page, type PageQuery } from "../../lib/pagination.js";
import { requirePermissions } from "../auth/auth.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  base64DecodedSize,
  decodeBase64,
  DocumentAddFileRequestSchema,
  DocumentListQuerySchema,
  DocumentQueueQuerySchema,
  DocumentRecaptureRequestSchema,
  DocumentUploadRequestSchema,
  type DocumentListQueryInput,
  type DocumentUploadFileInput
} from "../../schemas/documents.schemas.js";
import { auditDocumentEvent, DOCUMENT_AUDIT_ACTIONS, documentAuditSummary } from "./documents-audit.js";
import { toDocumentFileDto, toIncomingDocumentDetail, toIncomingDocumentRecord, type IncomingDocumentRow, type RecordExtras } from "./documents-dto.js";
import { getDocumentsConfig, getDocumentStorage } from "./documents.config.js";
import { parseEInvoice } from "./einvoice-parser.js";
import { assertContentMatches, extensionForMime, type SniffedMime } from "./magic-bytes.js";
import { notifyOfficeDocumentSent } from "./office-notifications.js";
import { countPdfPages } from "./pdf-text.js";
import { allocateRegistryNumber, registryYearOf, type AllocatedRegistryNumber, type AllocateRegistryNumberInput, type RegistryTx } from "./registry-number.js";
import { addBusinessDays, dueAtFor, startOfUtcDay, type DeadlineKind } from "./retention-rules.js";
import { decodeInline, sha256Hex } from "./storage/inline-storage.js";
import { buildStorageKey, type DocumentStorage } from "./storage/storage.js";

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;

export const DOCUMENT_NOT_FOUND = "Documento no encontrado.";
export const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
export const DEFAULT_OFFICE_SLA_BUSINESS_DAYS = 2;
/** Filas DocumentPage por documento como máximo (un PDF de 1.000 páginas no crea 1.000 filas de golpe). */
export const MAX_PAGE_ROWS = 500;
/** Estados que la cola de la oficina lista por defecto (pendientes de decisión). */
export const OFFICE_QUEUE_DEFAULT_STATUSES: readonly IncomingDocumentStatus[] = Object.freeze(["sent_to_office", "in_review"]);
const DAY_MS = 86_400_000;
const DOCUMENT_PERMISSIONS = {
  capture: "documents.capture",
  review: "documents.review",
  archiveRead: "documents.archive.read",
  admin: "documents.admin"
} as const satisfies Record<string, PermissionKey>;

// ---------------------------------------------------------------------------
// Errores y permisos
// ---------------------------------------------------------------------------

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

function notFoundDocument(): HttpError {
  return typed(404, "DOCUMENT_NOT_FOUND", DOCUMENT_NOT_FOUND);
}

function notFoundProperty(): HttpError {
  return typed(404, "PROPERTY_NOT_FOUND", PROPERTY_NOT_FOUND);
}

type PermissionContext = Pick<UserContext, "permissions" | "isPlatformAdmin">;

/** Disyunción de claves («capture | review»): el manifiesto solo sabe de conjunciones. */
export function requireAnyPermission(context: PermissionContext, keys: readonly PermissionKey[]): void {
  if (context.isPlatformAdmin === true) return;
  if (keys.some((key) => context.permissions.includes(key))) return;
  throw new PermissionDeniedError([...keys]);
}

export function isDocumentsAdmin(context: PermissionContext): boolean {
  return context.isPlatformAdmin === true || context.permissions.includes(DOCUMENT_PERMISSIONS.admin);
}

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los unit tests)
// ---------------------------------------------------------------------------

/** §6.1 fila alta: el papel existe salvo que el documento llegue por correo, e-factura o API. */
export function physicalStatusFor(source: IncomingDocumentSource): "at_centre" | "not_applicable" {
  return source === "email" || source === "e_invoice" || source === "api" ? "not_applicable" : "at_centre";
}

/** §4.1 «Factura electrónica»: un XML Facturae / UBL reconocido entra como `e_invoice` (RV-08); el resto conserva el canal del envío. */
export function isEInvoiceXml(mime: SniffedMime, bytes: Uint8Array): boolean {
  if (mime !== "application/xml") return false;
  try {
    return parseEInvoice(bytes).format !== "unknown";
  } catch {
    return false;
  }
}

/** Canal efectivo de un fichero: el del servidor / cliente salvo e-factura reconocida. */
export function sourceForFile(requested: IncomingDocumentSource, mime: SniffedMime, bytes: Uint8Array): IncomingDocumentSource {
  return isEInvoiceXml(mime, bytes) ? "e_invoice" : requested;
}

/** Páginas: PDF por countPdfPages (mínimo 1), imágenes y XML una. */
export function pageCountFor(mime: SniffedMime, bytes: Uint8Array): number {
  if (mime !== "application/pdf") return 1;
  try {
    return Math.max(1, countPdfPages(bytes));
  } catch {
    return 1;
  }
}

/** Nº de filas DocumentPage a crear (acotado). */
export function pageRowsFor(pageCount: number): number[] {
  const n = Math.max(1, Math.min(MAX_PAGE_ROWS, pageCount));
  return Array.from({ length: n }, (_, index) => index + 1);
}

export type DuplicateDecision = { kind: "none" } | { kind: "allowed"; existingId: string } | { kind: "conflict"; existingId: string };

/** 409 salvo allowDuplicate (copia legítima); `existing` es la fila de la organización con el mismo sha256. */
export function decideDuplicate(existing: { id: string } | null | undefined, allowDuplicate: boolean | undefined): DuplicateDecision {
  if (!existing) return { kind: "none" };
  return allowDuplicate ? { kind: "allowed", existingId: existing.id } : { kind: "conflict", existingId: existing.id };
}

/** Texto de búsqueda inicial (el pipeline añade campos y texto de páginas). */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .slice(0, 8000);
}

/** Tipo del documento → regla de plazo de retention-rules (§3.5). */
export function deadlineKindOf(kind: IncomingDocumentKind): DeadlineKind | null {
  switch (kind) {
    case "administrative_notice":
      return "administrative_notice";
    case "e_invoice_status":
      return "e_invoice";
    default:
      return null;
  }
}

/** Plazo de lectura: la tarea abierta más próxima o el derivado del tipo. */
export function dueAtOf(row: Pick<IncomingDocumentRow, "kind" | "documentDate" | "capturedAt">, openActionDueAts: Array<Date | null>): Date | null {
  const fromActions = openActionDueAts.filter((value): value is Date => value instanceof Date).sort((a, b) => a.getTime() - b.getTime());
  if (fromActions.length > 0) return fromActions[0]!;
  const deadlineKind = deadlineKindOf(row.kind);
  if (!deadlineKind) return null;
  return dueAtFor(deadlineKind, row.documentDate ?? row.capturedAt);
}

/** Medianoche UTC del día en que vence el SLA (`sentAt` + N días laborables, §6.3). */
export function slaDueAt(sentAt: Date, slaBusinessDays: number): Date {
  return addBusinessDays(startOfUtcDay(sentAt), Math.max(0, Math.trunc(slaBusinessDays)));
}

/** Vencido: el día de vencimiento ha pasado entero sin decisión (solo sent_to_office / in_review). */
export function isSlaBreached(row: Pick<IncomingDocumentRow, "status" | "sentAt">, slaBusinessDays: number, now: Date): boolean {
  if (!row.sentAt) return false;
  if (row.status !== "sent_to_office" && row.status !== "in_review") return false;
  return now.getTime() >= slaDueAt(row.sentAt, slaBusinessDays).getTime() + DAY_MS;
}

/**
 * Cota superior EXCLUSIVA de `sentAt` para las filas vencidas: `sentAt < cota`
 * ⇔ isSlaBreached (para los estados pendientes). Permite filtrar `slaBreachedOnly`
 * en SQL sin post-filtrar la página.
 */
export function slaSentAtBound(now: Date, slaBusinessDays: number): Date {
  let day = startOfUtcDay(now);
  for (let i = 0; i < 400; i++) {
    if (slaDueAt(day, slaBusinessDays).getTime() + DAY_MS <= now.getTime()) return new Date(day.getTime() + DAY_MS);
    day = new Date(day.getTime() - DAY_MS);
  }
  return new Date(0);
}

export type CursorDirection = "asc" | "desc";

/** Filtro de continuación por (capturedAt, id) para un cursor de lib/pagination.ts. */
export function cursorFilter(cursor: string | null, direction: CursorDirection): Prisma.IncomingDocumentWhereInput | null {
  const key = decodeCursor(cursor);
  if (!key) return null;
  const at = new Date(key.k);
  if (Number.isNaN(at.getTime())) throw typed(400, "VALIDATION_ERROR", "El cursor de paginación no es válido.");
  return direction === "desc"
    ? { OR: [{ capturedAt: { lt: at } }, { capturedAt: at, id: { lt: key.id } }] }
    : { OR: [{ capturedAt: { gt: at } }, { capturedAt: at, id: { gt: key.id } }] };
}

/** Día ISO → intervalo UTC [from 00:00, to 24:00). */
export function capturedAtRange(from: string | undefined, to: string | undefined): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS) } : {})
  };
}

type ListFilters = Omit<DocumentListQueryInput, "cursor" | "limit" | "envelope">;

/** Filtros comunes de bandeja y cola (sin tenencia ni cursor). */
export function buildListWhere(filters: ListFilters, options: { includeBlocked: boolean; slaBound: Date | null }): Prisma.IncomingDocumentWhereInput {
  const where: Prisma.IncomingDocumentWhereInput = { deletedAt: null };
  if (!options.includeBlocked) where.blockedAt = null;
  if (filters.status) where.status = { in: [...filters.status] };
  if (filters.kind) where.kind = filters.kind;
  if (filters.physicalStatus) where.physicalStatus = filters.physicalStatus;
  if (filters.assignedTo) where.assignedTo = filters.assignedTo;
  const range = capturedAtRange(filters.from, filters.to);
  if (range) where.capturedAt = range;
  if (filters.q) {
    const q = filters.q;
    where.OR = [
      { registryNumber: { contains: q, mode: "insensitive" } },
      { searchText: { contains: q, mode: "insensitive" } },
      { documentNumber: { contains: q, mode: "insensitive" } },
      { supplierTaxId: { contains: q, mode: "insensitive" } }
    ];
  }
  if (filters.slaBreachedOnly && options.slaBound) {
    where.sentAt = { lt: options.slaBound };
    where.status = { in: [...(filters.status ?? OFFICE_QUEUE_DEFAULT_STATUSES)].filter((status) => status === "sent_to_office" || status === "in_review") };
  }
  return where;
}

// ---------------------------------------------------------------------------
// Transición de estado (T9-08 la reutiliza)
// ---------------------------------------------------------------------------

export type ApplyDocumentStatusInput = {
  from: IncomingDocumentStatus;
  action: string;
  to: IncomingDocumentStatus;
  /** Columnas que cambian con la transición (sentAt, decidedBy…). */
  data?: Prisma.IncomingDocumentUpdateManyMutationInput;
};

/**
 * Transición condicional: UPDATE … WHERE id AND status = from. Cero filas →
 * 409 DOCUMENT_STATUS_TRANSITION { from: <estado actual>, action, to } (o 404
 * opaco si la fila no existe). Devuelve la fila actualizada.
 */
export async function applyDocumentStatus(tx: Tx, id: string, input: ApplyDocumentStatusInput): Promise<IncomingDocument> {
  const result = await tx.incomingDocument.updateMany({ where: { id, status: input.from }, data: { status: input.to, ...(input.data ?? {}) } });
  if (result.count !== 1) {
    const current = await tx.incomingDocument.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw notFoundDocument();
    throw typed(409, "DOCUMENT_STATUS_TRANSITION", `La acción «${input.action}» no es válida en el estado «${current.status}» (se esperaba «${input.from}»).`, {
      from: current.status,
      action: input.action,
      to: input.to
    });
  }
  return tx.incomingDocument.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DocumentsServiceDeps = {
  storage: () => DocumentStorage;
  maxBytes: () => number;
  now?: () => Date;
  allocate?: (tx: RegistryTx, input: AllocateRegistryNumberInput) => Promise<AllocatedRegistryNumber>;
  db?: Db;
};

type ActorInput = { context: UserContext; correlationId: string; ipAddress?: string };

export type CaptureIncomingDocumentsInput = ActorInput & {
  propertyId: string;
  body: unknown;
  /** Canal fijado por el servidor (buzón: `email`; e-factura; `api`): prevalece sobre body.source. */
  source?: IncomingDocumentSource;
  emailMeta?: Record<string, unknown>;
  /** Ingesta sin sesión (poller de correo): salta requirePermissions; la tenencia se comprueba igual. */
  skipPermissionCheck?: boolean;
};

export type DocumentByIdInput = ActorInput & { propertyId: string; documentId: string };
export type AddDocumentFileInput = DocumentByIdInput & { body: unknown };
export type RecaptureDocumentInput = DocumentByIdInput & { body: unknown };
export type ListIncomingDocumentsInput = { context: UserContext; propertyId: string; query: Record<string, unknown> };
export type ListOfficeQueueInput = { context: UserContext; organizationId: string; query: Record<string, unknown> };
export type ListResult = { page: Page<IncomingDocumentRecord>; pageQuery: PageQuery };

export type DocumentBytes = { bytes: Buffer; mimeType: string; fileName: string; sha256: string; sizeBytes: number; fileId: string };

/** Un fichero validado y listo para el almacén (sin fila todavía). */
export type PreparedFile = {
  fileName: string;
  mime: SniffedMime;
  ext: string;
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  base64: string;
};

type PropertyRow = { id: string; code: string | null; organizationId: string; legalEntityId: string | null; kind: string };

/** SEC-02: del correo solo van a la auditoría los identificadores (mensaje, adjunto, conexión), nunca remitente ni asunto. */
export function emailAuditRefs(emailMeta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!emailMeta) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["messageId", "attachmentId", "connectionId"] as const) {
    if (typeof emailMeta[key] === "string") out[key] = emailMeta[key];
  }
  return Object.keys(out).length > 0 ? { email: out } : {};
}

export function createDocumentsService(deps: DocumentsServiceDeps) {
  const db: Db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const allocate = deps.allocate ?? allocateRegistryNumber;

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Decodifica y valida un fichero: 413 (antes de decodificar), 400 MIME / magic, sha256, páginas. */
  function prepareFile(file: DocumentUploadFileInput): PreparedFile {
    const maxBytes = deps.maxBytes();
    const estimated = base64DecodedSize(file.base64);
    if (estimated > maxBytes) {
      throw typed(413, "DOCUMENT_TOO_LARGE", `El fichero «${file.fileName}» supera el tamaño máximo admitido (${maxBytes} bytes).`, {
        fileName: file.fileName,
        sizeBytes: estimated,
        maxBytes
      });
    }
    const bytes = decodeBase64(file.base64);
    const mime = assertContentMatches(file.mimeType, bytes);
    const ext = extensionForMime(mime);
    if (!ext) throw typed(400, "DOCUMENT_MIME_NOT_ALLOWED", `Tipo de fichero no admitido: ${file.mimeType}.`);
    return {
      fileName: file.fileName,
      mime,
      ext,
      bytes,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.length,
      pageCount: pageCountFor(mime, bytes),
      base64: file.base64
    };
  }

  async function requireProperty(context: UserContext, propertyId: string): Promise<PropertyRow> {
    const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, code: true, organizationId: true, legalEntityId: true, kind: true } });
    if (!property) throw notFoundProperty();
    if (property.organizationId !== context.organizationId && context.isPlatformAdmin !== true) throw notFoundProperty();
    return property;
  }

  /** Fila del centro (404 opaco si no existe, es de otro centro o está purgada). */
  async function requireDocument(propertyId: string, documentId: string): Promise<IncomingDocument> {
    const row = await db.incomingDocument.findFirst({ where: { id: documentId, propertyId, deletedAt: null } });
    if (!row) throw notFoundDocument();
    return row;
  }

  function assertVisible(row: IncomingDocument, context: UserContext): void {
    if (row.blockedAt && !isDocumentsAdmin(context)) throw notFoundDocument();
  }

  function assertNotBlocked(row: IncomingDocument, context: UserContext): void {
    if (row.blockedAt && !isDocumentsAdmin(context)) {
      throw typed(409, "DOCUMENT_BLOCKED", "El documento está bloqueado por retención vencida.", { blockedAt: row.blockedAt.toISOString() });
    }
  }

  async function findDuplicate(organizationId: string, sha256: string, exceptId?: string): Promise<{ id: string; registryNumber: string } | null> {
    return db.incomingDocument.findFirst({
      where: { organizationId, sha256, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, registryNumber: true },
      orderBy: { capturedAt: "asc" }
    });
  }

  function assertNoDuplicate(existing: { id: string; registryNumber: string } | null, allowDuplicate: boolean | undefined, fileName: string): void {
    const decision = decideDuplicate(existing, allowDuplicate);
    if (decision.kind === "conflict") {
      throw typed(409, "DOCUMENT_DUPLICATE_FILE", `El fichero «${fileName}» ya existe en la organización (registro ${existing?.registryNumber ?? decision.existingId}).`, {
        existingId: decision.existingId,
        registryNumber: existing?.registryNumber ?? null,
        fileName
      });
    }
  }

  async function officeSla(organizationId: string): Promise<number> {
    const settings = await db.documentSettings.findUnique({ where: { organizationId }, select: { officeSlaBusinessDays: true } });
    return settings?.officeSlaBusinessDays ?? DEFAULT_OFFICE_SLA_BUSINESS_DAYS;
  }

  /** dueAt, slaBreached y supplierName de un lote de filas (una consulta por tabla, no por fila). */
  async function extrasFor(rows: IncomingDocument[], sla: number): Promise<Map<string, RecordExtras>> {
    const out = new Map<string, RecordExtras>();
    if (rows.length === 0) return out;
    const at = now();
    const ids = rows.map((row) => row.id);
    const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter((id): id is string => !!id))];
    const [actions, suppliers] = await Promise.all([
      db.documentAction.findMany({ where: { documentId: { in: ids }, status: "open" }, select: { documentId: true, dueAt: true } }),
      supplierIds.length > 0 ? db.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : Promise.resolve([] as Array<{ id: string; name: string }>)
    ]);
    const dueByDoc = new Map<string, Array<Date | null>>();
    for (const action of actions) {
      const list = dueByDoc.get(action.documentId) ?? [];
      list.push(action.dueAt);
      dueByDoc.set(action.documentId, list);
    }
    const supplierNames = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
    for (const row of rows) {
      out.set(row.id, {
        supplierName: row.supplierId ? (supplierNames.get(row.supplierId) ?? null) : null,
        dueAt: dueAtOf(row, dueByDoc.get(row.id) ?? []),
        slaBreached: isSlaBreached(row, sla, at)
      });
    }
    return out;
  }

  async function toRecord(row: IncomingDocument): Promise<IncomingDocumentRecord> {
    const sla = await officeSla(row.organizationId);
    const extras = (await extrasFor([row], sla)).get(row.id)!;
    return toIncomingDocumentRecord(row, extras);
  }

  function isEncryptingStore(storage: DocumentStorage): boolean {
    return "encrypts" in storage && (storage as { encrypts?: boolean }).encrypts === true;
  }

  /** storage.put + borrado best-effort si la escritura de BD que sigue falla. */
  async function withStoredFile<T>(storage: DocumentStorage, key: string, prepared: PreparedFile, write: () => Promise<T>): Promise<T> {
    const put = await storage.put({ key, bytes: prepared.bytes, mimeType: prepared.mime });
    if (put.sha256 !== prepared.sha256) {
      await storage.delete(key).catch(() => undefined);
      throw new HttpError(500, "El almacén devolvió un hash distinto del calculado.", false);
    }
    try {
      return await write();
    } catch (error) {
      await storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  function fileCreateData(storage: DocumentStorage, prepared: PreparedFile, key: string, role: string, uploadedBy: string | null): Prisma.DocumentFileCreateWithoutDocumentInput {
    return {
      role,
      fileName: prepared.fileName,
      mimeType: prepared.mime,
      sizeBytes: prepared.sizeBytes,
      sha256: prepared.sha256,
      storageKind: storage.kind,
      storageKey: key,
      inline: storage.kind === "inline" ? prepared.base64 : null,
      encrypted: isEncryptingStore(storage),
      uploadedBy
    };
  }

  // ── captura ─────────────────────────────────────────────────────────────

  async function captureIncomingDocuments(input: CaptureIncomingDocumentsInput): Promise<IncomingDocumentRecord[]> {
    if (!input.skipPermissionCheck) requirePermissions(input.context, [DOCUMENT_PERMISSIONS.capture]);
    const body = parseOr400(DocumentUploadRequestSchema, input.body ?? {}, "Captura de documentos");
    const property = await requireProperty(input.context, input.propertyId);
    const storage = deps.storage();
    const source: IncomingDocumentSource = input.source ?? body.source ?? "upload";

    // 1. Validar TODOS los ficheros antes de escribir nada (413 / 400 / 409 sin filas a medias).
    const prepared = body.files.map(prepareFile);
    const seen = new Map<string, string>();
    for (const file of prepared) {
      const existing = await findDuplicate(property.organizationId, file.sha256);
      assertNoDuplicate(existing, body.allowDuplicate, file.fileName);
      const twin = seen.get(file.sha256);
      if (twin && !body.allowDuplicate) {
        throw typed(409, "DOCUMENT_DUPLICATE_FILE", `El fichero «${file.fileName}» está repetido en el envío («${twin}»).`, { existingId: null, fileName: file.fileName, duplicateOf: twin });
      }
      seen.set(file.sha256, file.fileName);
    }

    // 2. Un documento por fichero, en orden (números de registro consecutivos).
    const records: IncomingDocumentRecord[] = [];
    for (const file of prepared) {
      const documentId = createId("doc");
      const key = buildStorageKey({ organizationId: property.organizationId, propertyId: property.id, documentId, sha256: file.sha256, ext: file.ext });
      const capturedAt = now();
      const fileSource = sourceForFile(source, file.mime, file.bytes);
      const row = await withStoredFile(storage, key, file, () =>
        db.$transaction(async (tx) => {
          const registry = await allocate(tx, { propertyId: property.id, propertyCode: property.code, year: registryYearOf(capturedAt) });
          return tx.incomingDocument.create({
            data: {
              id: documentId,
              organizationId: property.organizationId,
              legalEntityId: property.legalEntityId,
              propertyId: property.id,
              registryNumber: registry.registryNumber,
              registryYear: registry.registryYear,
              registrySeq: registry.registrySeq,
              kind: body.kindHint ?? "unknown",
              classificationSource: body.kindHint ? "manual" : null,
              status: "captured",
              physicalStatus: physicalStatusFor(fileSource),
              source: fileSource,
              originalFormat: file.mime,
              title: file.fileName,
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
              pageCount: file.pageCount,
              extractionStatus: "pending",
              captureNote: body.note ?? null,
              searchText: buildSearchText([registry.registryNumber, file.fileName, body.note]),
              emailMetaJson: input.emailMeta ? (input.emailMeta as Prisma.InputJsonObject) : undefined,
              capturedBy: input.context.userId,
              capturedAt,
              files: { create: [fileCreateData(storage, file, key, "original", input.context.userId)] },
              pages: { createMany: { data: pageRowsFor(file.pageCount).map((pageNo) => ({ pageNo })) } }
            }
          });
        })
      );
      auditDocumentEvent({
        action: DOCUMENT_AUDIT_ACTIONS.captured,
        context: input.context,
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        documentId: row.id,
        correlationId: input.correlationId,
        ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
        // SEC-02: nunca la nota ni, en el correo, el nombre del adjunto (pueden llevar datos de terceros); solo ids del mensaje.
        afterJson: { ...documentAuditSummary(row), ...(fileSource === "email" ? {} : { fileName: file.fileName }), mimeType: file.mime, source: fileSource, allowDuplicate: body.allowDuplicate === true, ...emailAuditRefs(input.emailMeta) }
      });
      records.push(toIncomingDocumentRecord(row, { supplierName: null, dueAt: dueAtOf(row, []), slaBreached: false }));
    }
    return records;
  }

  async function addDocumentFile(input: AddDocumentFileInput): Promise<DocumentFileDto> {
    requirePermissions(input.context, [DOCUMENT_PERMISSIONS.capture]);
    const body = parseOr400(DocumentAddFileRequestSchema, input.body ?? {}, "Fichero adicional");
    await requireProperty(input.context, input.propertyId);
    const doc = await requireDocument(input.propertyId, input.documentId);
    assertNotBlocked(doc, input.context);
    const storage = deps.storage();
    const file = prepareFile(body);
    const key = buildStorageKey({ organizationId: doc.organizationId, propertyId: doc.propertyId, documentId: doc.id, sha256: file.sha256, ext: file.ext });
    const twin = await db.documentFile.findUnique({ where: { storageKey: key }, select: { id: true } });
    if (twin) {
      throw typed(409, "DOCUMENT_DUPLICATE_FILE", `El fichero «${file.fileName}» ya forma parte de este documento.`, { existingId: doc.id, fileId: twin.id, fileName: file.fileName });
    }
    const role = body.role ?? "derived";
    const created = await withStoredFile(storage, key, file, () =>
      db.documentFile.create({ data: { ...fileCreateData(storage, file, key, role, input.context.userId), document: { connect: { id: doc.id } } } })
    );
    auditDocumentEvent({
      action: DOCUMENT_AUDIT_ACTIONS.fileAdded,
      context: input.context,
      organizationId: doc.organizationId,
      propertyId: doc.propertyId,
      documentId: doc.id,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      afterJson: { registryNumber: doc.registryNumber, fileId: created.id, role, fileName: file.fileName, mimeType: file.mime, sha256: file.sha256, sizeBytes: file.sizeBytes, withNote: Boolean(body.note) }
    });
    return toDocumentFileDto(created);
  }

  // ── lectura ─────────────────────────────────────────────────────────────

  async function getIncomingDocument(input: { context: UserContext; propertyId: string; documentId: string }): Promise<IncomingDocumentDetail> {
    requireAnyPermission(input.context, [DOCUMENT_PERMISSIONS.capture, DOCUMENT_PERMISSIONS.review]);
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.documentId);
    assertVisible(row, input.context);
    const [files, pages, extraction, actions, matches, sla] = await Promise.all([
      db.documentFile.findMany({ where: { documentId: row.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) as Promise<DocumentFile[]>,
      db.documentPage.findMany({ where: { documentId: row.id }, orderBy: { pageNo: "asc" } }) as Promise<DocumentPage[]>,
      db.documentExtraction.findFirst({ where: { documentId: row.id }, orderBy: { runNo: "desc" } }) as Promise<DocumentExtraction | null>,
      db.documentAction.findMany({ where: { documentId: row.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) as Promise<DocumentAction[]>,
      row.supplierBillId
        ? (db.billLineMatch.findMany({ where: { supplierBillLine: { supplierBillId: row.supplierBillId } }, orderBy: { createdAt: "asc" } }) as Promise<BillLineMatch[]>)
        : Promise.resolve([] as BillLineMatch[]),
      officeSla(row.organizationId)
    ]);
    const supplier = row.supplierId ? await db.supplier.findUnique({ where: { id: row.supplierId }, select: { name: true } }) : null;
    const extras: RecordExtras = {
      supplierName: supplier?.name ?? null,
      dueAt: dueAtOf(row, actions.filter((action) => action.status === "open").map((action) => action.dueAt)),
      slaBreached: isSlaBreached(row, sla, now())
    };
    return toIncomingDocumentDetail(row, extras, { files, pages, extraction, actions, matches });
  }

  async function listPage(where: Prisma.IncomingDocumentWhereInput, direction: CursorDirection, pageQuery: PageQuery, sla: number): Promise<Page<IncomingDocumentRecord>> {
    const continuation = cursorFilter(pageQuery.cursor, direction);
    const [rows, total] = await Promise.all([
      db.incomingDocument.findMany({
        where: continuation ? { AND: [where, continuation] } : where,
        orderBy: [{ capturedAt: direction }, { id: direction }],
        take: pageQuery.limit + 1
      }),
      db.incomingDocument.count({ where })
    ]);
    const extras = await extrasFor(rows, sla);
    const records = rows.map((row) => toIncomingDocumentRecord(row, extras.get(row.id)!));
    const keyOf = new Map(rows.map((row) => [row.id, row.capturedAt.toISOString()]));
    return buildPage(records, pageQuery.limit, total, (record) => keyOf.get(record.id) ?? record.capturedAt);
  }

  async function listIncomingDocuments(input: ListIncomingDocumentsInput): Promise<ListResult> {
    requireAnyPermission(input.context, [DOCUMENT_PERMISSIONS.capture, DOCUMENT_PERMISSIONS.review]);
    const property = await requireProperty(input.context, input.propertyId);
    const filters = parseOr400(DocumentListQuerySchema, input.query ?? {}, "Filtro");
    const pageQuery = parsePageQuery(input.query);
    const sla = await officeSla(property.organizationId);
    const where = { ...buildListWhere(filters, { includeBlocked: isDocumentsAdmin(input.context), slaBound: filters.slaBreachedOnly ? slaSentAtBound(now(), sla) : null }), propertyId: property.id };
    return { page: await listPage(where, "desc", pageQuery, sla), pageQuery };
  }

  /**
   * Cola de la oficina (§9, R11): toda la sociedad con accounting.entity.read u
   * organización explícita; un centro concreto si está en el ámbito; «todos los
   * centros» sin ese ámbito solo cuando las asignaciones cubren TODOS los
   * centros de la organización; si no, 404 opaco ENTITY_SCOPE_REQUIRED.
   */
  async function listOfficeQueue(input: ListOfficeQueueInput): Promise<ListResult> {
    requirePermissions(input.context, [DOCUMENT_PERMISSIONS.review]);
    const filters = parseOr400(DocumentQueueQuerySchema, input.query ?? {}, "Filtro");
    const pageQuery = parsePageQuery(input.query);
    const organizationId = input.organizationId;
    let propertyIds: string[] | null = null;
    if (filters.propertyId) {
      const property = await db.property.findUnique({ where: { id: filters.propertyId }, select: { id: true, organizationId: true } });
      if (!property || property.organizationId !== organizationId) throw notFoundProperty();
      assertFinanceReadScope(input.context, property.id);
      propertyIds = [property.id];
    } else if (!hasEntityReadScope(input.context)) {
      const all = await db.property.findMany({ where: { organizationId }, select: { id: true } });
      const covered = all.every((property) => propertyWithinScope(input.context, property.id));
      if (!covered) assertFinanceReadScope(input.context, null); // lanza ENTITY_SCOPE_REQUIRED
      propertyIds = all.map((property) => property.id);
    }
    const sla = await officeSla(organizationId);
    const effective = { ...filters, status: filters.status ?? [...OFFICE_QUEUE_DEFAULT_STATUSES] };
    const where: Prisma.IncomingDocumentWhereInput = {
      ...buildListWhere(effective, { includeBlocked: isDocumentsAdmin(input.context), slaBound: filters.slaBreachedOnly ? slaSentAtBound(now(), sla) : null }),
      organizationId,
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {})
    };
    return { page: await listPage(where, "asc", pageQuery, sla), pageQuery };
  }

  // ── descarga ────────────────────────────────────────────────────────────

  async function bytesOfFile(storage: DocumentStorage, file: DocumentFile): Promise<Buffer> {
    if (file.storageKind === "inline") {
      if (!file.inline) throw notFoundDocument();
      return decodeInline(file.inline);
    }
    if (!file.storageKey) throw notFoundDocument();
    const got = await storage.get(file.storageKey);
    if (!got) throw notFoundDocument();
    return got.bytes;
  }

  async function readFile(input: DocumentByIdInput, pick: (files: DocumentFile[], doc: IncomingDocument) => DocumentFile | undefined, auditExtra: Record<string, unknown>, missing: () => HttpError = notFoundDocument): Promise<DocumentBytes> {
    requireAnyPermission(input.context, [DOCUMENT_PERMISSIONS.capture, DOCUMENT_PERMISSIONS.review, DOCUMENT_PERMISSIONS.archiveRead]);
    await requireProperty(input.context, input.propertyId);
    const doc = await requireDocument(input.propertyId, input.documentId);
    // §7.5: un bloqueado es invisible salvo documents.admin, también en la descarga (RV-12: mismo 404 opaco que el detalle).
    assertVisible(doc, input.context);
    const files = await db.documentFile.findMany({ where: { documentId: doc.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const file = pick(files, doc);
    if (!file) throw missing();
    const bytes = await bytesOfFile(deps.storage(), file);
    if (sha256Hex(bytes) !== file.sha256) {
      throw new HttpError(500, "La integridad del fichero no se ha podido verificar.", false, { code: "DOCUMENT_STORAGE_IO", fileId: file.id });
    }
    auditDocumentEvent({
      action: DOCUMENT_AUDIT_ACTIONS.downloaded,
      context: input.context,
      organizationId: doc.organizationId,
      propertyId: doc.propertyId,
      documentId: doc.id,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      afterJson: { registryNumber: doc.registryNumber, fileId: file.id, role: file.role, sha256: file.sha256, sizeBytes: file.sizeBytes, ...auditExtra }
    });
    return { bytes, mimeType: file.mimeType, fileName: file.fileName, sha256: file.sha256, sizeBytes: file.sizeBytes, fileId: file.id };
  }

  /** Original vigente (el más reciente con role original). */
  function getDocumentFileBytes(input: DocumentByIdInput): Promise<DocumentBytes> {
    return readFile(input, (files) => files.find((file) => file.role === "original") ?? files[0], {});
  }

  /**
   * Imagen de la página `pageNo`: la rasterizada (DocumentPage.imageFileId) o, en una
   * captura JPEG / PNG / TIFF, el propio original como página 1 (RV-17). Sin imagen
   * (PDF sin rasterizar) → 404 DOCUMENT_PAGE_IMAGE_UNAVAILABLE, distinto del 404
   * opaco de «no existe» (que sigue siendo el de requireDocument / assertVisible).
   */
  async function getDocumentPageImageBytes(input: DocumentByIdInput & { pageNo: number }): Promise<DocumentBytes> {
    const page = await db.documentPage.findFirst({ where: { documentId: input.documentId, pageNo: input.pageNo }, select: { imageFileId: true } });
    const imageFileId = page?.imageFileId ?? null;
    return readFile(
      input,
      (files) => {
        if (imageFileId) return files.find((file) => file.id === imageFileId);
        if (input.pageNo !== 1) return undefined;
        const original = files.find((file) => file.role === "original");
        return original && original.mimeType.toLowerCase().startsWith("image/") ? original : undefined;
      },
      { pageNo: input.pageNo },
      () => typed(404, "DOCUMENT_PAGE_IMAGE_UNAVAILABLE", `No hay imagen de la página ${input.pageNo}: el original no está rasterizado (usa GET …/file).`, { pageNo: input.pageNo })
    );
  }

  // ── transiciones del centro ─────────────────────────────────────────────

  async function sendToOffice(input: DocumentByIdInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [DOCUMENT_PERMISSIONS.capture]);
    await requireProperty(input.context, input.propertyId);
    const doc = await requireDocument(input.propertyId, input.documentId);
    assertNotBlocked(doc, input.context);
    // RV-03: un documento sin páginas (origen repartido entero por un split) no viaja a la oficina.
    if (doc.pageCount === 0) {
      throw typed(409, "DOCUMENT_STATUS_TRANSITION", "El documento no tiene páginas (se repartió entero al dividirlo): no se envía a la oficina.", { from: doc.status, action: "send-to-office", to: "sent_to_office", reason: "no_pages" });
    }
    const sentAt = now();
    const updated = await db.$transaction((tx) => applyDocumentStatus(tx, doc.id, { from: "captured", action: "send-to-office", to: "sent_to_office", data: { sentAt } }));
    auditDocumentEvent({
      action: DOCUMENT_AUDIT_ACTIONS.sent,
      context: input.context,
      organizationId: updated.organizationId,
      propertyId: updated.propertyId,
      documentId: updated.id,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      beforeJson: { status: doc.status },
      afterJson: { ...documentAuditSummary(updated), sentAt: sentAt.toISOString() }
    });
    // §6.3 (RV-10): aviso in-app a los revisores del centro, agrupado por hora; nunca deshace el envío.
    try {
      await notifyOfficeDocumentSent(db, { row: updated, at: sentAt, excludeUserId: input.context.userId });
    } catch (error) {
      console.warn("[documents] no se pudo avisar a la oficina del envío", { documentId: updated.id, correlationId: input.correlationId, error: error instanceof Error ? error.message : String(error) });
    }
    return toRecord(updated);
  }

  async function recaptureDocument(input: RecaptureDocumentInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [DOCUMENT_PERMISSIONS.capture]);
    const body = parseOr400(DocumentRecaptureRequestSchema, input.body ?? {}, "Recaptura");
    await requireProperty(input.context, input.propertyId);
    const doc = await requireDocument(input.propertyId, input.documentId);
    assertNotBlocked(doc, input.context);
    if (doc.status !== "returned_to_centre") {
      throw typed(409, "DOCUMENT_STATUS_TRANSITION", `La acción «recapture» no es válida en el estado «${doc.status}» (se esperaba «returned_to_centre»).`, {
        from: doc.status,
        action: "recapture",
        to: "captured"
      });
    }
    const storage = deps.storage();
    const file = prepareFile(body);
    assertNoDuplicate(await findDuplicate(doc.organizationId, file.sha256, doc.id), false, file.fileName);
    const key = buildStorageKey({ organizationId: doc.organizationId, propertyId: doc.propertyId, documentId: doc.id, sha256: file.sha256, ext: file.ext });
    if (await db.documentFile.findUnique({ where: { storageKey: key }, select: { id: true } })) {
      throw typed(409, "DOCUMENT_DUPLICATE_FILE", `El fichero «${file.fileName}» es el mismo que ya tiene el documento.`, { existingId: doc.id, fileName: file.fileName });
    }
    const capturedAt = now();
    const updated = await withStoredFile(storage, key, file, () =>
      db.$transaction(async (tx) => {
        // El original anterior queda como derivado (historial); entra un original nuevo.
        await tx.documentFile.updateMany({ where: { documentId: doc.id, role: "original" }, data: { role: "derived" } });
        await tx.documentFile.create({ data: { ...fileCreateData(storage, file, key, "original", input.context.userId), document: { connect: { id: doc.id } } } });
        await tx.documentPage.deleteMany({ where: { documentId: doc.id } });
        await tx.documentPage.createMany({ data: pageRowsFor(file.pageCount).map((pageNo) => ({ documentId: doc.id, pageNo })) });
        return applyDocumentStatus(tx, doc.id, {
          from: "returned_to_centre",
          action: "recapture",
          to: "captured",
          data: {
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            pageCount: file.pageCount,
            originalFormat: file.mime,
            title: file.fileName,
            extractionStatus: "pending",
            captureNote: body.note ?? doc.captureNote,
            searchText: buildSearchText([doc.registryNumber, file.fileName, body.note ?? doc.captureNote]),
            capturedBy: input.context.userId,
            capturedAt,
            sentAt: null,
            rejectReason: null,
            rejectNote: null
          }
        });
      })
    );
    auditDocumentEvent({
      action: DOCUMENT_AUDIT_ACTIONS.recaptured,
      context: input.context,
      organizationId: updated.organizationId,
      propertyId: updated.propertyId,
      documentId: updated.id,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      beforeJson: { ...documentAuditSummary(doc), rejectReason: doc.rejectReason, rejectNote: doc.rejectNote },
      afterJson: { ...documentAuditSummary(updated), fileName: file.fileName, mimeType: file.mime, withNote: Boolean(body.note) }
    });
    return toRecord(updated);
  }

  /** El pipeline en segundo plano falló antes de escribir su propia fila: la extracción queda `failed`. */
  async function markExtractionFailed(documentId: string): Promise<void> {
    await db.incomingDocument.updateMany({ where: { id: documentId, extractionStatus: "pending" }, data: { extractionStatus: "failed" } });
  }

  return {
    captureIncomingDocuments,
    addDocumentFile,
    getIncomingDocument,
    listIncomingDocuments,
    listOfficeQueue,
    getDocumentFileBytes,
    getDocumentPageImageBytes,
    sendToOffice,
    recaptureDocument,
    markExtractionFailed,
    prepareFile
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;

// ---------------------------------------------------------------------------
// Instancia por defecto (almacén y límites del contrato de entorno, T9-05b)
// ---------------------------------------------------------------------------

let defaultService: DocumentsService | null = null;

export function getDocumentsService(): DocumentsService {
  if (!defaultService) {
    defaultService = createDocumentsService({ storage: getDocumentStorage, maxBytes: () => getDocumentsConfig().maxBytes });
  }
  return defaultService;
}

export const captureIncomingDocuments = (input: CaptureIncomingDocumentsInput): Promise<IncomingDocumentRecord[]> => getDocumentsService().captureIncomingDocuments(input);
export const addDocumentFile = (input: AddDocumentFileInput): Promise<DocumentFileDto> => getDocumentsService().addDocumentFile(input);
export const getIncomingDocument = (input: { context: UserContext; propertyId: string; documentId: string }): Promise<IncomingDocumentDetail> => getDocumentsService().getIncomingDocument(input);
export const listIncomingDocuments = (input: ListIncomingDocumentsInput): Promise<ListResult> => getDocumentsService().listIncomingDocuments(input);
export const listOfficeQueue = (input: ListOfficeQueueInput): Promise<ListResult> => getDocumentsService().listOfficeQueue(input);
export const getDocumentFileBytes = (input: DocumentByIdInput): Promise<DocumentBytes> => getDocumentsService().getDocumentFileBytes(input);
export const getDocumentPageImageBytes = (input: DocumentByIdInput & { pageNo: number }): Promise<DocumentBytes> => getDocumentsService().getDocumentPageImageBytes(input);
export const sendToOffice = (input: DocumentByIdInput): Promise<IncomingDocumentRecord> => getDocumentsService().sendToOffice(input);
export const recaptureDocument = (input: RecaptureDocumentInput): Promise<IncomingDocumentRecord> => getDocumentsService().recaptureDocument(input);
export const markExtractionFailed = (documentId: string): Promise<void> => getDocumentsService().markExtractionFailed(documentId);

