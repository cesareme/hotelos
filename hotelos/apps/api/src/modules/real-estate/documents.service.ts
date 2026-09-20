// Activo inmobiliario · documentación con fichero, versiones y vigencia
// (Tanda ACT · L3, diseño §5 «Documento con vigencia» y §5.1 «Retirar»).
//
// Escrituras, notas simples, planos, licencias, pólizas, informes de inspección,
// contratos y recibos de tributos del inmueble cuelgan de la ficha del centro
// (`RealEstateDocument.assetId`) y guardan sus bytes en el ALMACÉN DE T9
// (modules/documents/documents.config.ts → inline | disk | s3), nunca en otro:
// misma lista blanca MIME y magic bytes (magic-bytes.ts), mismo hash SHA-256,
// misma clave `org/<org>/prop/<prop>/doc/<red_…>/<sha>.<ext>` (buildStorageKey,
// con el id del RealEstateDocument como segmento `doc`; no se crea DocumentFile
// ni IncomingDocument). Con almacén inline los bytes base64 van en `inline` y
// `storageKey` queda null; con disk / s3 se guarda la clave y `encrypted`.
//
// Ciclo (§5): subir (POST …/documents, con o sin fichero: «Sin fichero» =
// hasFile false) → fechas issueDate / validUntil a mano → si enlaza una
// obligación (`complianceRequirementCode`) sincroniza ComplianceItem.issueDate /
// expiryDate como createComplianceDocument (compliance-center.service.ts:
// upsert por propertyId_requirementCode, status COMPLIANT salvo NON_COMPLIANT /
// UNDER_REVIEW; si el código no está en el catálogo no hay nada que sincronizar)
// → una versión nueva (POST …/:documentId/versions, o POST …/documents con
// `supersedesId`) crea la fila version+1 con `supersedesId`, hereda los
// metadatos que el cuerpo no cambia y deja la anterior «sustituido»
// (`supersededById`); nunca se borra un fichero. «Retirar» (DELETE) es un
// borrado lógico (`deletedAt`), 409 LEGAL_HOLD si `legalHold`; `legalHold` solo
// lo cambia quien tiene real_estate.manage.
//
// Visibilidad (diseño §5.1 «wip … hasta entonces solo lo ve quien lo subió» y
// `confidentiality solo_propiedad`; ACT-REV-11 / ACT-REV-03): `isDocumentVisibleTo`
// se aplica en el listado y en toda búsqueda por id (descarga, metadatos,
// versión, supersedesId), con 404 opaco. Un documento `wip` solo lo ve quien
// lo subió (`uploadedBy`, siempre el actor de la subida) o quien tiene
// real_estate.manage; «Publicar» = PATCH { cdeState: "publicado" } (documents.
// manage). Un documento `solo_propiedad` solo lo ven real_estate.manage o una
// asignación con plantilla `owner`; el resto ni lo lista ni lo descarga.
//
// La vigencia NO se persiste: `deriveDocumentStatus` (vigencias.ts) con los
// días de aviso de CompliancePropertyProfile.expiringSoonDays (30 por defecto)
// y 90 para las categorías `inspecciones` y `seguros` (diseño §4). La descarga
// (GET …/:documentId/file) verifica el hash y deja
// REAL_ESTATE_DOCUMENT_DOWNLOADED en la auditoría, como T9 (nunca bytes ni
// claves de almacén en afterJson).

import { prisma } from "@hotelos/database";
import type { Prisma, RealEstateDocument } from "@prisma/client";
import { hasPermission } from "@hotelos/shared";
import type {
  IsoDay,
  RealEstateCdeState,
  RealEstateConfidentiality,
  RealEstateDocumentCategory,
  RealEstateDocumentKind,
  RealEstateDocumentRecord,
  RealEstateDocumentStatus,
  RealEstateLinkedEntityType
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { base64DecodedSize, decodeBase64 } from "../../schemas/documents.schemas.js";
import {
  RealEstateDocumentCreateSchema,
  RealEstateDocumentListQuerySchema,
  RealEstateDocumentPatchSchema,
  type RealEstateDocumentCreateInput,
  type RealEstateDocumentFileInput,
  type RealEstateDocumentListQueryInput
} from "../../schemas/real-estate.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getDocumentsConfig, getDocumentStorage } from "../documents/documents.config.js";
import { assertContentMatches, extensionForMime, type SniffedMime } from "../documents/magic-bytes.js";
import { decodeInline, sha256Hex } from "../documents/storage/inline-storage.js";
import { buildStorageKey, type DocumentStorage } from "../documents/storage/storage.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { realEstateError } from "./errors.js";
import { definedFields, isoDayOrNull, requireRealEstateAsset, type RealEstateCommandInput } from "./real-estate.service.js";
import { DEFAULT_EXPIRING_SOON_DAYS, DEFAULT_INSPECTION_WARN_DAYS, deriveDocumentStatus, toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const REAL_ESTATE_DOCUMENT_AUDIT_ENTITY = "real_estate_document";

export const REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS = Object.freeze({
  created: "REAL_ESTATE_DOCUMENT_CREATED",
  versionCreated: "REAL_ESTATE_DOCUMENT_VERSION_CREATED",
  superseded: "REAL_ESTATE_DOCUMENT_SUPERSEDED",
  updated: "REAL_ESTATE_DOCUMENT_UPDATED",
  retired: "REAL_ESTATE_DOCUMENT_RETIRED",
  downloaded: "REAL_ESTATE_DOCUMENT_DOWNLOADED"
} as const);

/** Prefijo de los ids de RealEstateDocument (lib/ids.ts createId): segmento `doc/<red_…>` de la clave del almacén. */
export const REAL_ESTATE_DOCUMENT_ID_PREFIX = "red";

/** Categorías con aviso largo (diseño §4: inspecciones y seguros avisan a 90 días). */
export const LONG_WARNING_CATEGORIES: ReadonlySet<RealEstateDocumentCategory> = new Set<RealEstateDocumentCategory>(["inspecciones", "seguros"]);

/** Estados de ComplianceItem que una sincronización documental nunca pisa (compliance-center.service.ts). */
const COMPLIANCE_STATUSES_KEPT: ReadonlySet<string> = new Set(["NON_COMPLIANT", "UNDER_REVIEW"]);

/** Bytes de un documento listos para responder (misma forma que DocumentBytes de T9: sendBinary los acepta). */
export type RealEstateDocumentBytes = { bytes: Buffer; mimeType: string; fileName: string; sha256: string; sizeBytes: number; fileId: string };

/** Un fichero validado y listo para el almacén (sin fila todavía). */
export type PreparedDocumentFile = {
  fileName: string;
  mime: SniffedMime;
  ext: string;
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  base64: string;
};

// ---------------------------------------------------------------------------
// Vigencia derivada y DTO
// ---------------------------------------------------------------------------

/** Días de aviso de un documento: 90 en inspecciones y seguros; si no, los del perfil de cumplimiento del centro (30 por defecto). */
export function expiringSoonDaysFor(category: string, profileDays: number = DEFAULT_EXPIRING_SOON_DAYS): number {
  return LONG_WARNING_CATEGORIES.has(category as RealEstateDocumentCategory) ? DEFAULT_INSPECTION_WARN_DAYS : profileDays;
}

/** True cuando hay bytes que servir: base64 en la fila (inline) o clave en el almacén (disk / s3). */
export function hasDocumentFile(row: Pick<RealEstateDocument, "storageKind" | "storageKey" | "inline" | "sha256">): boolean {
  if (!row.sha256) return false;
  return row.storageKind === "inline" ? row.inline !== null && row.inline !== "" : row.storageKey !== null;
}

export function documentStatusOf(row: Pick<RealEstateDocument, "category" | "validUntil" | "supersededById">, today: IsoDay, profileDays: number = DEFAULT_EXPIRING_SOON_DAYS): RealEstateDocumentStatus {
  return deriveDocumentStatus({ validUntil: isoDayOrNull(row.validUntil), supersededById: row.supersededById }, today, expiringSoonDaysFor(row.category, profileDays));
}

export function toRealEstateDocumentRecord(row: RealEstateDocument, today: IsoDay, profileDays: number = DEFAULT_EXPIRING_SOON_DAYS): RealEstateDocumentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    assetId: row.assetId,
    category: row.category as RealEstateDocumentCategory,
    kind: row.kind as RealEstateDocumentKind,
    title: row.title,
    issuerName: row.issuerName,
    issueDate: isoDayOrNull(row.issueDate),
    validFrom: isoDayOrNull(row.validFrom),
    validUntil: isoDayOrNull(row.validUntil),
    renewalDays: row.renewalDays,
    version: row.version,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    status: documentStatusOf(row, today, profileDays),
    cdeState: row.cdeState as RealEstateCdeState,
    confidentiality: row.confidentiality as RealEstateConfidentiality,
    linkedEntityType: (row.linkedEntityType as RealEstateLinkedEntityType | null) ?? null,
    linkedEntityId: row.linkedEntityId,
    complianceRequirementCode: row.complianceRequirementCode,
    hasFile: hasDocumentFile(row),
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    uploadedBy: row.uploadedBy,
    retentionUntil: isoDayOrNull(row.retentionUntil),
    legalHold: row.legalHold,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Fichero: validación, clave y campos de la fila (patrón documents.service.ts de T9)
// ---------------------------------------------------------------------------

/** Decodifica y valida un fichero: 413 DOCUMENT_TOO_LARGE (antes de decodificar), 400 MIME / magic bytes, sha256. */
export function prepareDocumentFile(file: RealEstateDocumentFileInput, maxBytes: number): PreparedDocumentFile {
  const estimated = base64DecodedSize(file.base64);
  if (estimated > maxBytes) {
    throw new HttpError(413, `El fichero «${file.fileName}» supera el tamaño máximo admitido (${maxBytes} bytes).`, true, {
      code: "DOCUMENT_TOO_LARGE",
      fileName: file.fileName,
      sizeBytes: estimated,
      maxBytes
    });
  }
  const bytes = decodeBase64(file.base64);
  const mime = assertContentMatches(file.mimeType, bytes);
  const ext = extensionForMime(mime);
  if (!ext) throw new HttpError(400, `Tipo de fichero no admitido: ${file.mimeType}.`, true, { code: "DOCUMENT_MIME_NOT_ALLOWED" });
  return { fileName: file.fileName, mime, ext, bytes, sha256: sha256Hex(bytes), sizeBytes: bytes.length, base64: file.base64 };
}

/** Clave del almacén de T9 con el id del RealEstateDocument (`red_…`) como segmento `doc`. */
export function buildRealEstateDocumentStorageKey(input: { organizationId: string; propertyId: string; documentId: string; sha256: string; ext: string }): string {
  if (!input.documentId.startsWith(`${REAL_ESTATE_DOCUMENT_ID_PREFIX}_`)) {
    throw new RangeError(`El id de un documento del activo inmobiliario empieza por ${REAL_ESTATE_DOCUMENT_ID_PREFIX}_: ${input.documentId}`);
  }
  return buildStorageKey({ organizationId: input.organizationId, propertyId: input.propertyId, documentId: input.documentId, sha256: input.sha256, ext: input.ext });
}

function isEncryptingStore(storage: Pick<DocumentStorage, "kind"> & { encrypts?: boolean }): boolean {
  return storage.encrypts === true;
}

/** Columnas del fichero en la fila: inline → base64 en `inline` y storageKey null; disk / s3 → clave y `encrypted`. */
export function storedFileFields(
  storage: Pick<DocumentStorage, "kind"> & { encrypts?: boolean },
  prepared: PreparedDocumentFile,
  key: string,
  uploadedBy: string | null
): Pick<Prisma.RealEstateDocumentUncheckedCreateInput, "fileName" | "mimeType" | "sizeBytes" | "sha256" | "storageKind" | "storageKey" | "inline" | "encrypted" | "uploadedBy"> {
  const inline = storage.kind === "inline";
  return {
    fileName: prepared.fileName,
    mimeType: prepared.mime,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
    storageKind: storage.kind,
    storageKey: inline ? null : key,
    inline: inline ? prepared.base64 : null,
    encrypted: inline ? false : isEncryptingStore(storage),
    uploadedBy
  };
}

/** storage.put ANTES de la transacción + borrado best-effort si la escritura de BD falla (documents.service.ts:withStoredFile). */
export async function withStoredFile<T>(storage: DocumentStorage, key: string, prepared: PreparedDocumentFile, write: () => Promise<T>): Promise<T> {
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

function noFile(): HttpError {
  return realEstateError(404, "DOCUMENT_NO_FILE", "Este documento no tiene fichero.");
}

/** Bytes de la fila: inline → decodifica; disk / s3 → storage.get(storageKey). 404 DOCUMENT_NO_FILE si no hay nada. */
export async function bytesOfDocument(storage: Pick<DocumentStorage, "get">, row: Pick<RealEstateDocument, "storageKind" | "storageKey" | "inline" | "sha256">): Promise<Buffer> {
  if (!hasDocumentFile(row)) throw noFile();
  if (row.storageKind === "inline") return decodeInline(row.inline!);
  const got = await storage.get(row.storageKey!);
  if (!got) throw noFile();
  return got.bytes;
}

// ---------------------------------------------------------------------------
// Guardas puras (legalHold, versiones, fechas)
// ---------------------------------------------------------------------------

/** 409 LEGAL_HOLD: un documento bajo retención legal no se retira. */
export function assertNotOnLegalHold(row: Pick<RealEstateDocument, "id" | "legalHold">): void {
  if (row.legalHold) throw realEstateError(409, "LEGAL_HOLD", "El documento está bajo retención legal y no puede retirarse.", { documentId: row.id });
}

/** `legalHold` en el cuerpo exige real_estate.manage (documents.manage solo sube y edita metadatos). */
export function assertLegalHoldPermission(context: UserContext, body: { legalHold?: boolean | undefined }): void {
  if (body.legalHold !== undefined) requirePermissions(context, ["real_estate.manage"]);
}

/** 409 DOCUMENT_SUPERSEDED: solo la última versión admite una versión nueva. */
export function assertVersionable(row: Pick<RealEstateDocument, "id" | "supersededById" | "version">): void {
  if (row.supersededById) {
    throw realEstateError(409, "DOCUMENT_SUPERSEDED", "Este documento ya tiene una versión posterior; versiona la última.", { documentId: row.id, supersededById: row.supersededById, version: row.version });
  }
}

function validationError(path: string, message: string): HttpError {
  return new HttpError(400, `Documento no válido: ${path}: ${message}`, true, { code: "VALIDATION_ERROR", issues: [{ path, message }] });
}

/** validUntil ≥ validFrom también cuando una de las dos fechas viene heredada (el refine de zod solo ve el cuerpo). */
export function assertValidityOrdered(fields: { validFrom?: Date | null | undefined; validUntil?: Date | null | undefined }): void {
  if (fields.validFrom && fields.validUntil && fields.validUntil.getTime() < fields.validFrom.getTime()) {
    throw validationError("validUntil", "validUntil no puede ser anterior a validFrom.");
  }
}

/** Metadatos del documento (sin `file`, `supersedesId` ni `legalHold`), con los `undefined` fuera. */
export type DocumentMetadata = {
  category?: string;
  kind?: string;
  title?: string;
  issuerName?: string | null;
  issueDate?: Date | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  renewalDays?: number | null;
  cdeState?: string;
  confidentiality?: string;
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
  complianceRequirementCode?: string | null;
  retentionUntil?: Date | null;
};

const METADATA_KEYS = ["category", "kind", "title", "issuerName", "issueDate", "validFrom", "validUntil", "renewalDays", "cdeState", "confidentiality", "linkedEntityType", "linkedEntityId", "complianceRequirementCode", "retentionUntil"] as const;

export function metadataOf(data: Partial<RealEstateDocumentCreateInput>): DocumentMetadata {
  const out: Record<string, unknown> = {};
  for (const key of METADATA_KEYS) if (data[key] !== undefined) out[key] = data[key];
  return out as DocumentMetadata;
}

/**
 * Metadatos de una versión nueva: los de la versión anterior salvo lo que el
 * cuerpo cambie (`null` borra). `legalHold` NO se hereda (la retención es de
 * cada fila) y el fichero siempre es el nuevo.
 */
export function inheritVersionFields(previous: RealEstateDocument, data: Partial<RealEstateDocumentCreateInput>): DocumentMetadata {
  const inherited: DocumentMetadata = {
    category: previous.category,
    kind: previous.kind,
    title: previous.title,
    issuerName: previous.issuerName,
    issueDate: previous.issueDate,
    validFrom: previous.validFrom,
    validUntil: previous.validUntil,
    renewalDays: previous.renewalDays,
    cdeState: previous.cdeState,
    confidentiality: previous.confidentiality,
    linkedEntityType: previous.linkedEntityType,
    linkedEntityId: previous.linkedEntityId,
    complianceRequirementCode: previous.complianceRequirementCode,
    retentionUntil: previous.retentionUntil
  };
  return { ...inherited, ...metadataOf(data) };
}

// ---------------------------------------------------------------------------
// Sincronización con el centro de cumplimiento (compliance-center.service.ts:createComplianceDocument)
// ---------------------------------------------------------------------------

export type ComplianceItemSync = {
  create: { applies: boolean; status: string; issueDate: Date | null; expiryDate: Date | null };
  update: { issueDate?: Date; expiryDate?: Date; status?: string };
};

/** Datos del upsert de ComplianceItem: fechas del documento y COMPLIANT salvo que el control esté NON_COMPLIANT / UNDER_REVIEW. */
export function complianceItemSyncData(
  existing: { status: string; applies: boolean } | null,
  requirement: { defaultApplies: boolean },
  document: { issueDate: Date | null; validUntil: Date | null }
): ComplianceItemSync {
  const update: ComplianceItemSync["update"] = {};
  if (document.issueDate) update.issueDate = document.issueDate;
  if (document.validUntil) update.expiryDate = document.validUntil;
  const keepStatus = existing !== null && COMPLIANCE_STATUSES_KEPT.has(existing.status);
  if (!keepStatus) update.status = "COMPLIANT";
  return {
    create: { applies: existing?.applies ?? requirement.defaultApplies, status: update.status ?? existing?.status ?? "COMPLIANT", issueDate: document.issueDate, expiryDate: document.validUntil },
    update
  };
}

/** Sincroniza el control enlazado; false si el código no está en el catálogo (nada que sincronizar, como createComplianceDocument). */
async function syncComplianceItem(db: Db, propertyId: string, code: string, document: { issueDate: Date | null; validUntil: Date | null }): Promise<boolean> {
  const requirement = await db.complianceRequirement.findUnique({ where: { code }, select: { code: true, defaultApplies: true } });
  if (!requirement) return false;
  const where = { propertyId_requirementCode: { propertyId, requirementCode: requirement.code } };
  const existing = await db.complianceItem.findUnique({ where, select: { status: true, applies: true } });
  const sync = complianceItemSyncData(existing, requirement, document);
  await db.complianceItem.upsert({ where, create: { propertyId, requirementCode: requirement.code, ...sync.create }, update: sync.update });
  return true;
}

// ---------------------------------------------------------------------------
// Búsquedas con tenencia
// ---------------------------------------------------------------------------

/** Quien mira un documento: actor, claves y asignaciones (para la plantilla `owner`). */
export type DocumentViewer = Pick<UserContext, "userId" | "permissions"> & { assignments?: ReadonlyArray<{ templateKey: string | null }> | undefined };

/** `solo_propiedad`: real_estate.manage o una asignación con plantilla `owner` (ACT-REV-03). Puro. */
export function canSeePropertyOnlyDocuments(viewer: DocumentViewer): boolean {
  return hasPermission(viewer.permissions, "real_estate.manage") || (viewer.assignments ?? []).some((assignment) => assignment.templateKey === "owner");
}

/** Regla de visibilidad de un documento (wip → solo quien lo subió o real_estate.manage; solo_propiedad → propiedad). Puro. */
export function isDocumentVisibleTo(row: Pick<RealEstateDocument, "cdeState" | "confidentiality" | "uploadedBy">, viewer: DocumentViewer): boolean {
  const manages = hasPermission(viewer.permissions, "real_estate.manage");
  if (row.cdeState === "wip" && !manages && (!row.uploadedBy || row.uploadedBy !== viewer.userId)) return false;
  if (row.confidentiality === "solo_propiedad" && !canSeePropertyOnlyDocuments(viewer)) return false;
  return true;
}

/** Fila del centro (404 opaco si no existe, es de otro centro, está retirada o `viewer` no puede verla). */
async function requireDocument(db: Db, propertyId: string, documentId: string, viewer?: DocumentViewer): Promise<RealEstateDocument> {
  const row = await db.realEstateDocument.findFirst({ where: { id: documentId, propertyId, deletedAt: null } });
  if (!row || (viewer && !isDocumentVisibleTo(row, viewer))) throw new NotFoundError("Documento no encontrado.");
  return row;
}

async function expiringSoonDaysOf(propertyId: string): Promise<number> {
  const profile = await prisma.compliancePropertyProfile.findUnique({ where: { propertyId }, select: { expiringSoonDays: true } });
  return profile?.expiringSoonDays ?? DEFAULT_EXPIRING_SOON_DAYS;
}

function auditBase(input: RealEstateCommandInput & { ipAddress?: string }, row: Pick<RealEstateDocument, "organizationId" | "propertyId" | "id">) {
  return {
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user" as const,
    entityType: REAL_ESTATE_DOCUMENT_AUDIT_ENTITY,
    entityId: row.id,
    correlationId: input.correlationId,
    ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
    ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {})
  };
}

/** Resumen auditable de una fila: nunca bytes, base64 ni clave del almacén. */
function auditSummary(row: RealEstateDocument): Record<string, unknown> {
  return {
    category: row.category,
    kind: row.kind,
    version: row.version,
    supersedesId: row.supersedesId,
    complianceRequirementCode: row.complianceRequirementCode,
    validUntil: isoDayOrNull(row.validUntil),
    hasFile: hasDocumentFile(row),
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    legalHold: row.legalHold
  };
}

// ---------------------------------------------------------------------------
// Listado (GET …/real-estate/documents?category=&status=&kind=)
// ---------------------------------------------------------------------------

export async function listRealEstateDocuments(propertyId: string, query: unknown, viewer?: DocumentViewer, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateDocumentRecord[]> {
  const filters: RealEstateDocumentListQueryInput = parseOr400(RealEstateDocumentListQuerySchema, query ?? {}, "Filtro");
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const [rows, profileDays] = await Promise.all([
    prisma.realEstateDocument.findMany({
      where: { assetId: asset.id, deletedAt: null, ...(filters.category ? { category: filters.category } : {}), ...(filters.kind ? { kind: filters.kind } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    }),
    expiringSoonDaysOf(propertyId)
  ]);
  const visible = viewer ? rows.filter((row) => isDocumentVisibleTo(row, viewer)) : rows;
  const records = visible.map((row) => toRealEstateDocumentRecord(row, today, profileDays));
  return filters.status ? records.filter((record) => record.status === filters.status) : records;
}

// ---------------------------------------------------------------------------
// Alta (POST …/real-estate/documents) y versiones (POST …/:documentId/versions)
// ---------------------------------------------------------------------------

type InsertInput = RealEstateCommandInput & { data: RealEstateDocumentCreateInput; previous: RealEstateDocument | null; fields: DocumentMetadata };

/** Inserta la fila (y, si versiona, cierra la anterior) con el fichero ya en el almacén; sincroniza el control enlazado. */
async function insertDocument(input: InsertInput): Promise<RealEstateDocument> {
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  assertValidityOrdered(input.fields);
  const documentId = createId(REAL_ESTATE_DOCUMENT_ID_PREFIX);
  const storage = getDocumentStorage();
  const prepared = input.data.file ? prepareDocumentFile(input.data.file, getDocumentsConfig().maxBytes) : null;
  const key = prepared ? buildRealEstateDocumentStorageKey({ organizationId: asset.organizationId, propertyId: asset.propertyId, documentId, sha256: prepared.sha256, ext: prepared.ext }) : null;
  const previous = input.previous;
  const createData: Prisma.RealEstateDocumentUncheckedCreateInput = {
    id: documentId,
    organizationId: asset.organizationId,
    propertyId: asset.propertyId,
    assetId: asset.id,
    category: input.fields.category ?? input.data.category,
    kind: input.fields.kind ?? input.data.kind,
    title: input.fields.title ?? input.data.title,
    ...input.fields,
    version: previous ? previous.version + 1 : 1,
    supersedesId: previous?.id ?? null,
    legalHold: input.data.legalHold ?? false,
    // Siempre el actor de la subida (con o sin fichero): la regla «wip solo lo ve quien lo subió» depende de él.
    uploadedBy: input.context.userId ?? null,
    ...(prepared && key ? storedFileFields(storage, prepared, key, input.context.userId ?? null) : {})
  };

  const write = () =>
    prisma.$transaction(async (tx) => {
      if (previous) {
        // Carrera entre dos versiones simultáneas de la misma fila: solo una cierra la anterior.
        const closed = await tx.realEstateDocument.updateMany({ where: { id: previous.id, supersededById: null, deletedAt: null }, data: { supersededById: documentId } });
        if (closed.count === 0) {
          throw realEstateError(409, "DOCUMENT_SUPERSEDED", "Este documento ya tiene una versión posterior; versiona la última.", { documentId: previous.id, version: previous.version });
        }
      }
      const row = await tx.realEstateDocument.create({ data: createData });
      if (row.complianceRequirementCode) await syncComplianceItem(tx, row.propertyId, row.complianceRequirementCode, { issueDate: row.issueDate, validUntil: row.validUntil });
      return row;
    });

  const row = prepared && key ? await withStoredFile(storage, key, prepared, write) : await write();
  const audit = auditBase(input, row);
  if (previous) {
    recordAuditEvent({ ...audit, action: REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.versionCreated, beforeJson: { supersedesId: previous.id, previousVersion: previous.version }, afterJson: auditSummary(row) });
    recordAuditEvent({ ...audit, entityId: previous.id, action: REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.superseded, beforeJson: { supersededById: null, version: previous.version }, afterJson: { supersededById: row.id, version: previous.version } });
  } else {
    recordAuditEvent({ ...audit, action: REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.created, afterJson: auditSummary(row) });
  }
  return row;
}

/**
 * POST …/real-estate/documents: ficha con `file` opcional («Sin fichero» sin
 * él). Con `supersedesId` es una versión nueva de ese documento (mismo camino
 * que POST …/:documentId/versions, con el cuerpo completo en vez de heredar).
 */
export async function createRealEstateDocument(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateDocumentRecord> {
  const data = parseOr400(RealEstateDocumentCreateSchema, input.body ?? {}, "Documento");
  assertLegalHoldPermission(input.context, data);
  let previous: RealEstateDocument | null = null;
  if (data.supersedesId) {
    previous = await requireDocument(prisma, input.propertyId, data.supersedesId, input.context);
    assertVersionable(previous);
    if (!data.file) throw validationError("file", "una versión nueva necesita fichero.");
  }
  const row = await insertDocument({ ...input, data, previous, fields: metadataOf(data) });
  return toRealEstateDocumentRecord(row, toIsoDay(new Date()), await expiringSoonDaysOf(input.propertyId));
}

/**
 * POST …/real-estate/documents/:documentId/versions: fila version+1 con el
 * fichero nuevo (obligatorio); hereda los metadatos que el cuerpo no cambia y
 * deja la anterior «sustituido» (supersededById). 409 DOCUMENT_SUPERSEDED si
 * `documentId` ya no es la última versión.
 */
export async function createRealEstateDocumentVersion(input: RealEstateCommandInput & { documentId: string; body: unknown }): Promise<RealEstateDocumentRecord> {
  const previous = await requireDocument(prisma, input.propertyId, input.documentId, input.context);
  assertVersionable(previous);
  const raw = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const data = parseOr400(RealEstateDocumentCreateSchema, { category: previous.category, kind: previous.kind, title: previous.title, ...raw }, "Versión del documento");
  if (data.supersedesId !== undefined && data.supersedesId !== previous.id) throw validationError("supersedesId", "no coincide con el documento de la ruta.");
  if (!data.file) throw validationError("file", "una versión nueva necesita fichero.");
  assertLegalHoldPermission(input.context, data);
  const row = await insertDocument({ ...input, data, previous, fields: inheritVersionFields(previous, data) });
  return toRealEstateDocumentRecord(row, toIsoDay(new Date()), await expiringSoonDaysOf(input.propertyId));
}

// ---------------------------------------------------------------------------
// Metadatos (PATCH …/:documentId) · retirar (DELETE …/:documentId)
// ---------------------------------------------------------------------------

const SYNC_TRIGGER_KEYS: ReadonlySet<string> = new Set(["complianceRequirementCode", "issueDate", "validUntil"]);

export async function updateRealEstateDocument(input: RealEstateCommandInput & { documentId: string; body: unknown }): Promise<RealEstateDocumentRecord> {
  const data = parseOr400(RealEstateDocumentPatchSchema, input.body ?? {}, "Documento");
  assertLegalHoldPermission(input.context, data);
  const before = await requireDocument(prisma, input.propertyId, input.documentId, input.context);
  const patch = definedFields(data) as Prisma.RealEstateDocumentUncheckedUpdateInput;
  assertValidityOrdered({ validFrom: data.validFrom === undefined ? before.validFrom : data.validFrom, validUntil: data.validUntil === undefined ? before.validUntil : data.validUntil });
  const changed = Object.keys(patch);
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.realEstateDocument.update({ where: { id: before.id }, data: patch });
    // El control enlazado sigue al documento vigente (nunca a una versión sustituida).
    if (row.complianceRequirementCode && !row.supersededById && changed.some((key) => SYNC_TRIGGER_KEYS.has(key))) {
      await syncComplianceItem(tx, row.propertyId, row.complianceRequirementCode, { issueDate: row.issueDate, validUntil: row.validUntil });
    }
    return row;
  });
  const today = toIsoDay(new Date());
  const profileDays = await expiringSoonDaysOf(input.propertyId);
  const beforeRecord = toRealEstateDocumentRecord(before, today, profileDays);
  const afterRecord = toRealEstateDocumentRecord(after, today, profileDays);
  const keys = changed as Array<keyof RealEstateDocumentRecord>;
  recordAuditEvent({
    ...auditBase(input, before),
    action: REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.updated,
    beforeJson: Object.fromEntries(keys.map((key) => [key, beforeRecord[key] ?? null])),
    afterJson: Object.fromEntries(keys.map((key) => [key, afterRecord[key] ?? null]))
  });
  return afterRecord;
}

/** «Retirar» (§5.1): borrado lógico; el fichero se conserva en el almacén. 409 LEGAL_HOLD bajo retención legal. */
export async function retireRealEstateDocument(input: RealEstateCommandInput & { documentId: string }): Promise<RealEstateDocumentRecord> {
  const before = await requireDocument(prisma, input.propertyId, input.documentId, input.context);
  assertNotOnLegalHold(before);
  const after = await prisma.realEstateDocument.update({ where: { id: before.id }, data: { deletedAt: new Date() } });
  recordAuditEvent({ ...auditBase(input, before), action: REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.retired, beforeJson: { deletedAt: null, ...auditSummary(before) }, afterJson: { deletedAt: after.deletedAt?.toISOString() ?? null } });
  return toRealEstateDocumentRecord(after, toIsoDay(new Date()), await expiringSoonDaysOf(input.propertyId));
}

// ---------------------------------------------------------------------------
// Descarga auditada (GET …/:documentId/file)
// ---------------------------------------------------------------------------

export async function getRealEstateDocumentFile(input: RealEstateCommandInput & { documentId: string; ipAddress?: string }): Promise<RealEstateDocumentBytes> {
  const row = await requireDocument(prisma, input.propertyId, input.documentId, input.context);
  const bytes = await bytesOfDocument(getDocumentStorage(), row);
  if (!row.sha256 || sha256Hex(bytes) !== row.sha256) {
    throw new HttpError(500, "La integridad del fichero no se ha podido verificar.", false, { code: "DOCUMENT_STORAGE_IO", documentId: row.id });
  }
  recordAuditEvent({ ...auditBase(input, row), action: REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.downloaded, afterJson: { ...auditSummary(row), storageKind: row.storageKind } });
  return { bytes, mimeType: row.mimeType ?? "application/octet-stream", fileName: row.fileName ?? `${row.id}.bin`, sha256: row.sha256, sizeBytes: row.sizeBytes ?? bytes.length, fileId: row.id };
}
