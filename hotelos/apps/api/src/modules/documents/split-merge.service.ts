// Documentos · dividir y unir (Tanda T9 · lote T9-08; diseño §6.1 fila
// «captured · in_review: split / merge», §9 POST …/documents/:id/split |
// merge).
//
// Split LÓGICO ({ ranges: [[from, to]] }, 1-based e inclusivos): cada trozo
// nace `captured` con registro propio y hereda los bytes del original (copia
// bajo su propia clave `org/…/doc/<nuevo>/<sha>.<ext>`; sin librería PDF no se
// extraen páginas físicas, así que el fichero del trozo es el original entero
// y `sourcePagesJson` — las páginas FÍSICAS del fichero que forman el trozo —
// es su índice lógico: el pipeline recorta texto, filas DocumentPage y
// pageCount a esas páginas (RV-01). Las DocumentPage del rango pasan al trozo
// renumeradas 1..n. El original conserva registro y estado con las páginas no
// repartidas (renumeradas 1..k y su `sourcePagesJson`); si se reparten TODAS
// queda `archived` con mergedIntoId = primer trozo (absorción, §6.1; RV-03),
// nunca un cascarón `captured` con 0 páginas que pueda enviarse a la oficina.
// Los trozos vuelven a la extracción (extractionStatus pending; las rutas
// lanzan el pipeline).
//
// Merge ({ withIds }): los absorbidos (mismo centro, captured | in_review)
// pasan sus páginas (renumeradas a continuación) y ficheros (original →
// derived, clave intacta) al documento destino y quedan `archived` con
// mergedIntoId y retención por tipo; el destino conserva su estado.
//
// Permisos: documents.capture | documents.review (disyunción en el servicio,
// manifiesto authenticated); tenencia por centro (404 opaco). Auditoría
// DOCUMENT_SPLIT / DOCUMENT_MERGED sin bytes ni claves.

import { prisma } from "@hotelos/database";
import type { DocumentFile, IncomingDocument, Prisma } from "@prisma/client";
import { z } from "zod";
import type { IncomingDocumentRecord } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { CAPTURE_OR_REVIEW } from "./actions.service.js";
import { DOCUMENT_AUDIT_ENTITY, documentAuditSummary } from "./documents-audit.js";
import { toIncomingDocumentRecord, type RecordExtras } from "./documents-dto.js";
import { getDocumentStorage } from "./documents.config.js";
import { buildSearchText, dueAtOf, isSlaBreached, requireAnyPermission, DEFAULT_OFFICE_SLA_BUSINESS_DAYS } from "./documents.service.js";
import { allocateRegistryNumber, registryYearOf, type AllocatedRegistryNumber, type AllocateRegistryNumberInput, type RegistryTx } from "./registry-number.js";
import { parseSourcePages } from "./pipeline.service.js";
import { retentionKindOf, retentionUntilFor } from "./retention-rules.js";
import { decodeInline } from "./storage/inline-storage.js";
import { buildStorageKey, storageKeyExtension, type DocumentStorage } from "./storage/storage.js";
import { assertTransition, assertWorkflowAllowed, transitionDocument } from "./workflow.service.js";

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;

export const SPLIT_MERGE_AUDIT = Object.freeze({ split: "DOCUMENT_SPLIT", merged: "DOCUMENT_MERGED" } as const);
export const MAX_SPLIT_RANGES = 50;
export const MAX_MERGE_DOCUMENTS = 50;

const rangeSchema = z.tuple([z.number().int().min(1), z.number().int().min(1)]);
export const DocumentSplitRequestSchema = z.object({ ranges: z.array(rangeSchema).min(1, { message: "ranges debe incluir al menos un rango." }).max(MAX_SPLIT_RANGES) }).strict();
export const DocumentMergeRequestSchema = z.object({ withIds: z.array(z.string().trim().min(1).max(64)).min(1, { message: "withIds debe incluir al menos un documento." }).max(MAX_MERGE_DOCUMENTS) }).strict();

export type SplitRange = { from: number; to: number };

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

/**
 * Rangos válidos: dentro de 1..pageCount, from ≤ to, sin solapes, ordenados;
 * un único rango que cubra todo el documento no divide nada (400).
 */
export function normalizeSplitRanges(ranges: ReadonlyArray<readonly [number, number]>, pageCount: number): SplitRange[] {
  const sorted = ranges.map(([from, to]) => ({ from, to })).sort((a, b) => a.from - b.from);
  let previousTo = 0;
  for (const range of sorted) {
    if (range.from > range.to) throw typed(400, "VALIDATION_ERROR", `Rango de páginas no válido: ${range.from}-${range.to}.`, { range: [range.from, range.to] });
    if (range.to > pageCount) throw typed(400, "VALIDATION_ERROR", `El documento tiene ${pageCount} páginas: el rango ${range.from}-${range.to} se sale.`, { range: [range.from, range.to], pageCount });
    if (range.from <= previousTo) throw typed(400, "VALIDATION_ERROR", `Los rangos se solapan en la página ${range.from}.`, { range: [range.from, range.to] });
    previousTo = range.to;
  }
  const covered = sorted.reduce((sum, range) => sum + (range.to - range.from + 1), 0);
  if (sorted.length === 1 && covered === pageCount) throw typed(400, "VALIDATION_ERROR", "Un único rango con todas las páginas no divide el documento.", { pageCount });
  return sorted;
}

/**
 * Páginas físicas del fichero original que forman cada trozo y las que quedan en
 * el origen (RV-01): `parentPages` es el índice lógico actual del documento
 * (null = 1..pageCount); un rango [from, to] lógico se traduce a físico.
 */
export function splitSourcePages(parentPages: number[] | null, pageCount: number, ranges: readonly SplitRange[]): { pieces: number[][]; remaining: number[] } {
  const logical = parentPages ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  const moved = new Set<number>();
  const pieces = ranges.map((range) => {
    const pages = logical.slice(range.from - 1, range.to);
    for (const page of pages) moved.add(page);
    return pages;
  });
  return { pieces, remaining: logical.filter((page) => !moved.has(page)) };
}

/** Lista de absorbidos sin repetidos ni el propio destino. */
export function normalizeMergeIds(targetId: string, withIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of withIds) {
    if (id === targetId) throw typed(400, "VALIDATION_ERROR", "Un documento no puede unirse consigo mismo.", { id });
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type SplitMergeDeps = {
  db?: Db;
  storage?: () => DocumentStorage;
  now?: () => Date;
  allocate?: (tx: RegistryTx, input: AllocateRegistryNumberInput) => Promise<AllocatedRegistryNumber>;
};

type ActorInput = { context: UserContext; correlationId: string; ipAddress?: string };
export type SplitDocumentInput = ActorInput & { propertyId: string; id: string; body: unknown };
export type MergeDocumentsInput = ActorInput & { propertyId: string; id: string; body: unknown };
export type SplitDocumentResult = { document: IncomingDocumentRecord; pieces: IncomingDocumentRecord[] };
export type MergeDocumentsResult = { document: IncomingDocumentRecord; absorbed: IncomingDocumentRecord[] };

type PropertyRow = { id: string; code: string | null; organizationId: string; legalEntityId: string | null };

export function createSplitMergeService(deps: SplitMergeDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const storage = deps.storage ?? getDocumentStorage;
  const now = deps.now ?? (() => new Date());
  const allocate = deps.allocate ?? allocateRegistryNumber;

  async function requireProperty(context: UserContext, propertyId: string): Promise<PropertyRow> {
    const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, code: true, organizationId: true, legalEntityId: true } });
    if (!property || (property.organizationId !== context.organizationId && context.isPlatformAdmin !== true)) throw typed(404, "PROPERTY_NOT_FOUND", "Propiedad no encontrada.");
    return property;
  }

  async function requireDocument(propertyId: string, documentId: string): Promise<IncomingDocument> {
    const row = await db.incomingDocument.findFirst({ where: { id: documentId, propertyId, deletedAt: null } });
    if (!row) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
    return row;
  }

  async function toRecords(rows: IncomingDocument[]): Promise<IncomingDocumentRecord[]> {
    if (rows.length === 0) return [];
    const settings = await db.documentSettings.findUnique({ where: { organizationId: rows[0]!.organizationId }, select: { officeSlaBusinessDays: true } });
    const sla = settings?.officeSlaBusinessDays ?? DEFAULT_OFFICE_SLA_BUSINESS_DAYS;
    const at = now();
    const actions = await db.documentAction.findMany({ where: { documentId: { in: rows.map((row) => row.id) }, status: "open" }, select: { documentId: true, dueAt: true } });
    const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter((id): id is string => !!id))];
    const suppliers = supplierIds.length > 0 ? await db.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
    return rows.map((row) => {
      const extras: RecordExtras = {
        supplierName: row.supplierId ? (names.get(row.supplierId) ?? null) : null,
        dueAt: dueAtOf(row, actions.filter((action) => action.documentId === row.id).map((action) => action.dueAt)),
        slaBreached: isSlaBreached(row, sla, at)
      };
      return toIncomingDocumentRecord(row, extras);
    });
  }

  async function bytesOf(store: DocumentStorage, file: DocumentFile): Promise<Buffer> {
    if (file.storageKind === "inline") {
      if (!file.inline) throw typed(500, "DOCUMENT_STORAGE_IO", "El fichero en línea está vacío.");
      return decodeInline(file.inline);
    }
    if (!file.storageKey) throw typed(500, "DOCUMENT_STORAGE_IO", "El fichero no tiene clave de almacén.");
    const got = await store.get(file.storageKey);
    if (!got) throw typed(500, "DOCUMENT_STORAGE_IO", "El fichero original no está en el almacén.", { fileId: file.id });
    return got.bytes;
  }

  function audit(input: ActorInput & { action: string; row: IncomingDocument; beforeJson?: Record<string, unknown>; afterJson: Record<string, unknown> }): void {
    recordAuditEvent({
      organizationId: input.row.organizationId,
      propertyId: input.row.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: input.action,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: input.row.id,
      ...(input.beforeJson ? { beforeJson: input.beforeJson } : {}),
      afterJson: input.afterJson,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      correlationId: input.correlationId
    });
  }

  // ── split ───────────────────────────────────────────────────────────────

  async function splitDocument(input: SplitDocumentInput): Promise<SplitDocumentResult> {
    requireAnyPermission(input.context, CAPTURE_OR_REVIEW);
    const body = parseOr400(DocumentSplitRequestSchema, input.body ?? {}, "División");
    const property = await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    assertWorkflowAllowed(row, "split");
    assertTransition(row.status, "split");
    const pageRows = await db.documentPage.findMany({ where: { documentId: row.id }, orderBy: { pageNo: "asc" }, select: { id: true, pageNo: true } });
    const pageCount = Math.max(row.pageCount, pageRows.length);
    const ranges = normalizeSplitRanges(body.ranges, pageCount);
    const sourcePages = splitSourcePages(parseSourcePages(row.sourcePagesJson), pageCount, ranges);
    const retentionSettings = await db.documentSettings.findUnique({ where: { organizationId: row.organizationId }, select: { retentionYearsDefault: true, letterRetentionYears: true, extendedRetentionYears: true } });
    const retention = retentionSettings ? { retentionYears: retentionSettings.retentionYearsDefault, letterRetentionYears: retentionSettings.letterRetentionYears, extendedRetentionYears: retentionSettings.extendedRetentionYears } : null;
    const original = await db.documentFile.findFirst({ where: { documentId: row.id, role: "original" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!original) throw typed(500, "DOCUMENT_STORAGE_IO", "El documento no tiene fichero original.");
    const store = storage();
    const bytes = await bytesOf(store, original);
    const ext = original.storageKey ? storageKeyExtension(original.storageKey) : "pdf";

    // 1. Copias en el almacén ANTES de la transacción (si una falla no hay filas a medias).
    const pieces: Array<{ id: string; key: string; range: SplitRange; pages: number[] }> = [];
    try {
      for (const [index, range] of ranges.entries()) {
        const id = createId("doc");
        const key = buildStorageKey({ organizationId: row.organizationId, propertyId: row.propertyId, documentId: id, sha256: original.sha256, ext });
        await store.put({ key, bytes, mimeType: original.mimeType });
        pieces.push({ id, key, range, pages: sourcePages.pieces[index]! });
      }
    } catch (error) {
      await Promise.all(pieces.map((piece) => store.delete(piece.key).catch(() => undefined)));
      throw error;
    }

    const at = now();
    let created: IncomingDocument[] = [];
    let updatedOriginal: IncomingDocument;
    try {
      const outcome = await db.$transaction(async (tx) => {
        const rows: IncomingDocument[] = [];
        for (const piece of pieces) {
          const registry = await allocate(tx, { propertyId: property.id, propertyCode: property.code, year: registryYearOf(at) });
          const pageCountOfPiece = piece.range.to - piece.range.from + 1;
          const title = `${row.title ?? row.registryNumber} (págs. ${piece.range.from}-${piece.range.to})`;
          const createdRow = await tx.incomingDocument.create({
            data: {
              id: piece.id,
              organizationId: row.organizationId,
              legalEntityId: row.legalEntityId,
              propertyId: row.propertyId,
              registryNumber: registry.registryNumber,
              registryYear: registry.registryYear,
              registrySeq: registry.registrySeq,
              kind: row.kind,
              classificationSource: row.classificationSource,
              status: "captured",
              physicalStatus: row.physicalStatus,
              source: row.source,
              originalFormat: row.originalFormat,
              title,
              sha256: original.sha256,
              sizeBytes: original.sizeBytes,
              pageCount: pageCountOfPiece,
              sourcePagesJson: piece.pages,
              captureNote: row.captureNote,
              extractionStatus: "pending",
              searchText: buildSearchText([registry.registryNumber, title, `dividido de ${row.registryNumber}`, row.captureNote]),
              capturedBy: input.context.userId,
              capturedAt: at,
              files: {
                create: [
                  {
                    role: "original",
                    fileName: original.fileName,
                    mimeType: original.mimeType,
                    sizeBytes: original.sizeBytes,
                    sha256: original.sha256,
                    storageKind: original.storageKind,
                    storageKey: piece.key,
                    inline: original.inline,
                    encrypted: original.encrypted,
                    uploadedBy: input.context.userId
                  }
                ]
              }
            }
          });
          // Páginas del rango: pasan al trozo renumeradas 1..n (el trozo aún no tiene páginas: sin colisión).
          for (const page of pageRows.filter((p) => p.pageNo >= piece.range.from && p.pageNo <= piece.range.to)) {
            await tx.documentPage.update({ where: { id: page.id }, data: { documentId: piece.id, pageNo: page.pageNo - piece.range.from + 1 } });
          }
          rows.push(createdRow);
        }
        // Páginas que quedan en el origen: renumeradas 1..k con su índice físico (sourcePagesJson).
        const remainingRows = pageRows.filter((page) => !ranges.some((range) => page.pageNo >= range.from && page.pageNo <= range.to));
        for (const [index, page] of remainingRows.entries()) {
          if (page.pageNo !== index + 1) await tx.documentPage.update({ where: { id: page.id }, data: { pageNo: index + 1 } });
        }
        const remaining = sourcePages.remaining.length;
        if (remaining === 0) {
          // RV-03: todas las páginas repartidas → el origen queda absorbido por el primer trozo (archived + mergedIntoId),
          // con su retención por tipo; nunca un cascarón captured / in_review sin páginas.
          const originalRow = await transitionDocumentToArchived(tx, row, rows[0]!.id, at, retention, { sourcePagesJson: [] });
          return { rows, originalRow };
        }
        const originalRow = await tx.incomingDocument.update({ where: { id: row.id }, data: { pageCount: remaining, sourcePagesJson: sourcePages.remaining } });
        return { rows, originalRow };
      });
      created = outcome.rows;
      updatedOriginal = outcome.originalRow;
    } catch (error) {
      await Promise.all(pieces.map((piece) => store.delete(piece.key).catch(() => undefined)));
      throw error;
    }

    audit({
      ...input,
      action: SPLIT_MERGE_AUDIT.split,
      row: updatedOriginal,
      beforeJson: { pageCount, status: row.status },
      afterJson: {
        ...documentAuditSummary(updatedOriginal),
        pieces: created.map((piece, index) => ({ id: piece.id, registryNumber: piece.registryNumber, from: ranges[index]!.from, to: ranges[index]!.to, sourcePages: pieces[index]!.pages })),
        remainingSourcePages: sourcePages.remaining,
        ...(updatedOriginal.mergedIntoId ? { mergedIntoId: updatedOriginal.mergedIntoId } : {})
      }
    });
    const [document, ...pieceRecords] = await toRecords([updatedOriginal, ...created]);
    return { document: document!, pieces: pieceRecords };
  }

  // ── merge ───────────────────────────────────────────────────────────────

  async function mergeDocuments(input: MergeDocumentsInput): Promise<MergeDocumentsResult> {
    requireAnyPermission(input.context, CAPTURE_OR_REVIEW);
    const body = parseOr400(DocumentMergeRequestSchema, input.body ?? {}, "Unión");
    await requireProperty(input.context, input.propertyId);
    const target = await requireDocument(input.propertyId, input.id);
    assertWorkflowAllowed(target, "merge");
    assertTransition(target.status, "merge");
    const ids = normalizeMergeIds(target.id, body.withIds);
    const absorbed = await db.incomingDocument.findMany({ where: { id: { in: ids }, propertyId: input.propertyId, deletedAt: null } });
    if (absorbed.length !== ids.length) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
    for (const doc of absorbed) {
      assertWorkflowAllowed(doc, "merge");
      assertTransition(doc.status, "merge");
    }
    const settings = await db.documentSettings.findUnique({ where: { organizationId: target.organizationId }, select: { retentionYearsDefault: true, letterRetentionYears: true, extendedRetentionYears: true } });
    const retention = settings ? { retentionYears: settings.retentionYearsDefault, letterRetentionYears: settings.letterRetentionYears, extendedRetentionYears: settings.extendedRetentionYears } : null;
    const at = now();
    const ordered = ids.map((id) => absorbed.find((doc) => doc.id === id)!);

    const outcome = await db.$transaction(async (tx) => {
      // RV-01: el desplazamiento es el pageCount lógico del destino (el recuento de filas se usa solo si es 0).
      let offset = target.pageCount > 0 ? target.pageCount : await tx.documentPage.count({ where: { documentId: target.id } });
      const archivedRows: IncomingDocument[] = [];
      for (const doc of ordered) {
        const pages = await tx.documentPage.findMany({ where: { documentId: doc.id }, orderBy: { pageNo: "asc" }, select: { id: true, pageNo: true } });
        for (const page of pages) {
          await tx.documentPage.update({ where: { id: page.id }, data: { documentId: target.id, pageNo: offset + page.pageNo } });
        }
        const span = doc.pageCount > 0 ? doc.pageCount : pages.length;
        offset += span;
        await tx.documentFile.updateMany({ where: { documentId: doc.id, role: "original" }, data: { documentId: target.id, role: "derived" } });
        await tx.documentFile.updateMany({ where: { documentId: doc.id }, data: { documentId: target.id } });
        const archived = await transitionDocumentToArchived(tx, doc, target.id, at, retention);
        archivedRows.push(archived);
      }
      const updatedTarget = await tx.incomingDocument.update({
        where: { id: target.id },
        data: { pageCount: offset, searchText: buildSearchText([target.searchText, ...ordered.map((doc) => doc.registryNumber)]) }
      });
      return { updatedTarget, archivedRows };
    });

    audit({ ...input, action: SPLIT_MERGE_AUDIT.merged, row: outcome.updatedTarget, beforeJson: { pageCount: target.pageCount }, afterJson: { ...documentAuditSummary(outcome.updatedTarget), absorbed: outcome.archivedRows.map((doc) => ({ id: doc.id, registryNumber: doc.registryNumber })) } });
    for (const doc of outcome.archivedRows) {
      audit({ ...input, action: SPLIT_MERGE_AUDIT.merged, row: doc, beforeJson: { status: ordered.find((o) => o.id === doc.id)?.status ?? null }, afterJson: { ...documentAuditSummary(doc), mergedIntoId: target.id } });
    }
    const [document, ...absorbedRecords] = await toRecords([outcome.updatedTarget, ...outcome.archivedRows]);
    return { document: document!, absorbed: absorbedRecords };
  }

  /** Absorbido (merge) u origen repartido entero (split): captured | in_review → archived con mergedIntoId (misma transacción; UPDATE condicional). */
  async function transitionDocumentToArchived(tx: Tx, doc: IncomingDocument, mergedIntoId: string, at: Date, retention: { retentionYears: number; letterRetentionYears: number; extendedRetentionYears: number } | null, extra: Prisma.IncomingDocumentUpdateManyMutationInput = {}): Promise<IncomingDocument> {
    const result = await tx.incomingDocument.updateMany({
      where: { id: doc.id, status: { in: ["captured", "in_review"] } },
      data: { status: "archived", mergedIntoId, archivedAt: at, pageCount: 0, retentionUntil: retentionUntilFor({ kind: retentionKindOf(doc.kind), documentDate: doc.documentDate ?? doc.capturedAt, extendedRetention: doc.extendedRetention, personalData: doc.guestId !== null, settings: retention }), ...extra }
    });
    if (result.count !== 1) {
      const current = await tx.incomingDocument.findUnique({ where: { id: doc.id }, select: { status: true } });
      throw typed(409, "DOCUMENT_STATUS_TRANSITION", `La acción «merge» no es válida en el estado «${current?.status ?? "?"}».`, { from: current?.status ?? null, action: "merge", documentId: doc.id });
    }
    return tx.incomingDocument.findUniqueOrThrow({ where: { id: doc.id } });
  }

  return { splitDocument, mergeDocuments };
}

export type SplitMergeService = ReturnType<typeof createSplitMergeService>;

let defaultService: SplitMergeService | null = null;

export function getSplitMergeService(): SplitMergeService {
  if (!defaultService) defaultService = createSplitMergeService();
  return defaultService;
}

export const splitDocument = (input: SplitDocumentInput): Promise<SplitDocumentResult> => getSplitMergeService().splitDocument(input);
export const mergeDocuments = (input: MergeDocumentsInput): Promise<MergeDocumentsResult> => getSplitMergeService().mergeDocuments(input);
// transitionDocument de workflow.service queda importado para el destino (sin cambio de estado: split / merge conservan el status).
export { transitionDocument };
