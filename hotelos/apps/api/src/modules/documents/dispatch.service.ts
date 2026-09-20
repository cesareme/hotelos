// Documentos · valija y hoja de remesa (Tanda T9 · lote T9-08; diseño §6.4,
// §9 POST /properties/:propertyId/documents/dispatch-batches y
// POST …/dispatch-batches/:batchId/receive).
//
// «Cerrar valija» en el centro (documents.capture): los documentos indicados
// (todos del centro, papel `at_centre`, no bloqueados) pasan a `in_transit`
// dentro de un lote `DocumentDispatchBatch` numerado por centro (secuencia
// bajo pg_advisory_xact_lock, patrón del registro) y se genera la hoja de
// remesa: PDF de la casa (invoicing/pdf/pdf-writer.ts) con el número de lote,
// centro, fecha, la lista de números de registro y el texto legal «Copia
// digital no certificada (Orden EHA/962/2007 art. 7): conservar el original
// 6 años (art. 30 CCom)». La hoja se guarda en el almacén como DocumentFile
// role dispatch_sheet colgado del PRIMER documento del lote (document_files
// exige document_id; decisión T9-08) y `sheetFileId` la referencia.
//
// «Recibir valija» en la oficina (documents.review): marca los números que
// llegaron → `at_office`; los que no llegan siguen `in_transit` (aviso a los
// 7 días: lote del job). La hoja se descarga por GET …/dispatch-batches/
// :batchId/sheet (documents.capture | documents.review), auditada.
//
// Tenencia por centro (404 opaco); auditoría DOCUMENT_DISPATCHED /
// DOCUMENT_DISPATCH_RECEIVED por documento, sin bytes ni claves.

import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import type { DocumentDispatchBatch, IncomingDocument, Prisma } from "@prisma/client";
import { z } from "zod";
import type { DocumentDispatchBatchDto } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { A4, PdfDocument, wrapText } from "../invoicing/pdf/pdf-writer.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { CAPTURE_OR_REVIEW, CAPTURE_PERMISSION, REVIEW_PERMISSION } from "./actions.service.js";
import { DOCUMENT_AUDIT_ENTITY } from "./documents-audit.js";
import { getDocumentStorage } from "./documents.config.js";
import { requireAnyPermission, type DocumentBytes } from "./documents.service.js";
import { decodeInline, encodeInline } from "./storage/inline-storage.js";
import { buildStorageKey, type DocumentStorage } from "./storage/storage.js";

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;

export const DISPATCH_AUDIT = Object.freeze({ dispatched: "DOCUMENT_DISPATCHED", received: "DOCUMENT_DISPATCH_RECEIVED", sheetDownloaded: "DOCUMENT_DISPATCH_SHEET_DOWNLOADED" } as const);
export const DISPATCH_LEGAL_TEXT = "Copia digital no certificada (Orden EHA/962/2007 art. 7): conservar el original 6 años (art. 30 CCom)";
export const MAX_DISPATCH_DOCUMENTS = 200;
/** Filas por página de la hoja (A4, 12 pt de interlínea). */
export const SHEET_ROWS_PER_PAGE = 40;

const idListSchema = z.array(z.string().trim().min(1).max(64)).min(1, { message: "documentIds debe incluir al menos un documento." }).max(MAX_DISPATCH_DOCUMENTS);
export const DocumentDispatchBatchRequestSchema = z.object({ documentIds: idListSchema }).strict();
export const DocumentDispatchReceiveRequestSchema = z.object({ receivedIds: z.array(z.string().trim().min(1).max(64)).min(1, { message: "receivedIds debe incluir al menos un documento." }).max(MAX_DISPATCH_DOCUMENTS) }).strict();

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

// ---------------------------------------------------------------------------
// Hoja de remesa (pura)
// ---------------------------------------------------------------------------

export type DispatchSheetInput = {
  batchNumber: number;
  propertyName: string;
  propertyCode: string | null;
  closedAt: Date;
  closedByName: string;
  documents: Array<{ registryNumber: string; title: string | null; kind: string }>;
};

/** Nombre de fichero de la hoja: `remesa-<centro>-<lote>.pdf`. */
export function dispatchSheetFileName(propertyCode: string | null, batchNumber: number): string {
  const code = (propertyCode ?? "centro").replace(/[^A-Za-z0-9-]/g, "").toLowerCase() || "centro";
  return `remesa-${code}-${String(batchNumber).padStart(4, "0")}.pdf`;
}

/** Nº de páginas que ocupará la lista (mínimo 1). */
export function dispatchSheetPageCount(documentCount: number): number {
  return Math.max(1, Math.ceil(documentCount / SHEET_ROWS_PER_PAGE));
}

/** PDF de la hoja de remesa (pdf-writer de la casa): cabecera, lista de números, pie legal, firmas. Puro. */
export function buildDispatchSheetPdf(input: DispatchSheetInput): Buffer {
  const doc = new PdfDocument({ title: `Hoja de remesa ${input.batchNumber}`, subject: `Valija ${input.propertyCode ?? input.propertyName}`, creationDate: input.closedAt });
  const day = input.closedAt.toISOString().slice(0, 10);
  const pages = dispatchSheetPageCount(input.documents.length);
  const margin = 48;
  const width = A4.width - margin * 2;
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const page = doc.addPage();
    page.text(margin, 60, "Hoja de remesa · valija de documentos", { font: "bold", size: 16 });
    page.text(A4.width - margin, 60, `Lote ${input.batchNumber}`, { font: "bold", size: 14, align: "right" });
    page.text(margin, 82, `Centro: ${input.propertyName}${input.propertyCode ? ` (${input.propertyCode})` : ""}`, { size: 10 });
    page.text(margin, 96, `Fecha de cierre: ${day} · Cerrada por: ${input.closedByName}`, { size: 10 });
    page.text(margin, 110, `Documentos: ${input.documents.length} · Página ${pageIndex + 1} de ${pages}`, { size: 10, gray: 0.35 });
    page.line(margin, 120, A4.width - margin, 120, 0.8);
    page.text(margin, 138, "Nº", { font: "bold", size: 9 });
    page.text(margin + 30, 138, "Número de registro", { font: "bold", size: 9 });
    page.text(margin + 200, 138, "Tipo", { font: "bold", size: 9 });
    page.text(margin + 290, 138, "Título", { font: "bold", size: 9 });
    page.line(margin, 143, A4.width - margin, 143, 0.4, 0.5);
    const slice = input.documents.slice(pageIndex * SHEET_ROWS_PER_PAGE, (pageIndex + 1) * SHEET_ROWS_PER_PAGE);
    slice.forEach((row, index) => {
      const y = 158 + index * 13;
      const n = pageIndex * SHEET_ROWS_PER_PAGE + index + 1;
      page.text(margin, y, String(n), { size: 9 });
      page.text(margin + 30, y, row.registryNumber, { size: 9 });
      page.text(margin + 200, y, row.kind, { size: 9 });
      const title = wrapText(row.title ?? "", width - 290, 9)[0] ?? "";
      page.text(margin + 290, y, title, { size: 9 });
    });
    const footerY = A4.height - 120;
    page.line(margin, footerY - 12, A4.width - margin, footerY - 12, 0.4, 0.5);
    page.paragraph(margin, footerY, DISPATCH_LEGAL_TEXT, width, { size: 9, gray: 0.2 });
    page.text(margin, A4.height - 70, "Entrega (centro): ________________________", { size: 9 });
    page.text(A4.width / 2 + 10, A4.height - 70, "Recepción (oficina): ________________________", { size: 9 });
  }
  return doc.render();
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DispatchServiceDeps = { db?: Db; storage?: () => DocumentStorage; now?: () => Date };

type ActorInput = { context: UserContext; correlationId: string; ipAddress?: string };
export type CloseDispatchBatchInput = ActorInput & { propertyId: string; body: unknown };
export type ReceiveDispatchBatchInput = ActorInput & { propertyId: string; batchId: string; body: unknown };
export type DispatchSheetByIdInput = ActorInput & { propertyId: string; batchId: string };

export type DispatchBatchResult = DocumentDispatchBatchDto & {
  registryNumbers: string[];
  /** GET …/dispatch-batches/:batchId/sheet (PDF). */
  sheetDownloadPath: string;
  sheetFileName: string | null;
  /** Solo al recibir: documentos que siguen en tránsito. */
  pendingIds?: string[];
  receivedIds?: string[];
};

export function dispatchLockKey(propertyId: string): string {
  return `documents.dispatch:${propertyId}`;
}

export function sheetDownloadPathOf(propertyId: string, batchId: string): string {
  return `/properties/${propertyId}/documents/dispatch-batches/${batchId}/sheet`;
}

function toDto(batch: DocumentDispatchBatch, extra: { registryNumbers: string[]; sheetFileName: string | null }): DispatchBatchResult {
  return {
    id: batch.id,
    propertyId: batch.propertyId,
    batchNumber: String(batch.batchNumber),
    closedBy: batch.closedBy,
    closedAt: batch.closedAt.toISOString(),
    receivedBy: batch.receivedBy,
    receivedAt: batch.receivedAt ? batch.receivedAt.toISOString() : null,
    documentCount: batch.documentCount,
    sheetFileId: batch.sheetFileId,
    registryNumbers: extra.registryNumbers,
    sheetDownloadPath: sheetDownloadPathOf(batch.propertyId, batch.id),
    sheetFileName: extra.sheetFileName
  };
}

export function createDispatchService(deps: DispatchServiceDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const storage = deps.storage ?? getDocumentStorage;
  const now = deps.now ?? (() => new Date());

  async function requireProperty(context: UserContext, propertyId: string): Promise<{ id: string; code: string | null; name: string; organizationId: string }> {
    const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, code: true, name: true, organizationId: true } });
    if (!property || (property.organizationId !== context.organizationId && context.isPlatformAdmin !== true)) throw typed(404, "PROPERTY_NOT_FOUND", "Propiedad no encontrada.");
    return property;
  }

  async function requireBatch(propertyId: string, batchId: string): Promise<DocumentDispatchBatch> {
    const batch = await db.documentDispatchBatch.findFirst({ where: { id: batchId, propertyId } });
    if (!batch) throw typed(404, "DOCUMENT_NOT_FOUND", "Valija no encontrada.");
    return batch;
  }

  function audit(input: ActorInput & { action: string; row: Pick<IncomingDocument, "id" | "organizationId" | "propertyId" | "registryNumber">; afterJson: Record<string, unknown> }): void {
    recordAuditEvent({
      organizationId: input.row.organizationId,
      propertyId: input.row.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: input.action,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: input.row.id,
      afterJson: { registryNumber: input.row.registryNumber, ...input.afterJson },
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      correlationId: input.correlationId
    });
  }

  async function closeDispatchBatch(input: CloseDispatchBatchInput): Promise<DispatchBatchResult> {
    requirePermissions(input.context, [CAPTURE_PERMISSION]);
    const body = parseOr400(DocumentDispatchBatchRequestSchema, input.body ?? {}, "Valija");
    const property = await requireProperty(input.context, input.propertyId);
    const ids = [...new Set(body.documentIds)];
    const docs = await db.incomingDocument.findMany({ where: { id: { in: ids }, propertyId: property.id, deletedAt: null } });
    if (docs.length !== ids.length) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
    for (const doc of docs) {
      if (doc.blockedAt) throw typed(409, "DOCUMENT_BLOCKED", `El documento ${doc.registryNumber} está bloqueado por retención vencida.`, { documentId: doc.id });
      if (doc.physicalStatus !== "at_centre") {
        throw typed(409, "DOCUMENT_STATUS_TRANSITION", `El documento ${doc.registryNumber} no está en el centro (papel «${doc.physicalStatus}»).`, { from: doc.physicalStatus, action: "dispatch", documentId: doc.id });
      }
    }
    const ordered = [...docs].sort((a, b) => a.registryNumber.localeCompare(b.registryNumber));
    const store = storage();
    const at = now();
    const closedByName = input.context.fullName || input.context.userId;
    let putKey: string | null = null;
    try {
      const batch = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dispatchLockKey(property.id)}))`;
        const rows = await tx.$queryRaw<Array<{ next: number | bigint }>>`SELECT COALESCE(MAX(batch_number), 0) + 1 AS next FROM document_dispatch_batches WHERE property_id = ${property.id}`;
        const batchNumber = Number(rows[0]?.next ?? 1);
        const created = await tx.documentDispatchBatch.create({
          data: { id: createId("ddb"), propertyId: property.id, batchNumber, closedBy: input.context.userId, closedAt: at, documentCount: ordered.length }
        });
        const moved = await tx.incomingDocument.updateMany({ where: { id: { in: ordered.map((doc) => doc.id) }, physicalStatus: "at_centre", deletedAt: null }, data: { physicalStatus: "in_transit", dispatchBatchId: created.id } });
        if (moved.count !== ordered.length) throw typed(409, "DOCUMENT_STATUS_TRANSITION", "Algún documento cambió de estado físico mientras se cerraba la valija.", { action: "dispatch", expected: ordered.length, moved: moved.count });
        const pdf = buildDispatchSheetPdf({ batchNumber, propertyName: property.name, propertyCode: property.code, closedAt: at, closedByName, documents: ordered.map((doc) => ({ registryNumber: doc.registryNumber, title: doc.title, kind: doc.kind })) });
        const sha256 = createHash("sha256").update(pdf).digest("hex");
        const holder = ordered[0]!;
        const key = buildStorageKey({ organizationId: holder.organizationId, propertyId: holder.propertyId, documentId: holder.id, sha256, ext: "pdf" });
        await store.put({ key, bytes: pdf, mimeType: "application/pdf" });
        putKey = key;
        const file = await tx.documentFile.create({
          data: {
            document: { connect: { id: holder.id } },
            role: "dispatch_sheet",
            fileName: dispatchSheetFileName(property.code, batchNumber),
            mimeType: "application/pdf",
            sizeBytes: pdf.length,
            sha256,
            storageKind: store.kind,
            storageKey: key,
            inline: store.kind === "inline" ? encodeInline(pdf) : null,
            encrypted: "encrypts" in store && (store as { encrypts?: boolean }).encrypts === true,
            uploadedBy: input.context.userId
          }
        });
        return tx.documentDispatchBatch.update({ where: { id: created.id }, data: { sheetFileId: file.id } });
      });
      for (const doc of ordered) {
        audit({ ...input, action: DISPATCH_AUDIT.dispatched, row: doc, afterJson: { batchId: batch.id, batchNumber: batch.batchNumber, physicalStatus: "in_transit" } });
      }
      return toDto(batch, { registryNumbers: ordered.map((doc) => doc.registryNumber), sheetFileName: dispatchSheetFileName(property.code, batch.batchNumber) });
    } catch (error) {
      if (putKey) await store.delete(putKey).catch(() => undefined);
      throw error;
    }
  }

  async function receiveDispatchBatch(input: ReceiveDispatchBatchInput): Promise<DispatchBatchResult> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentDispatchReceiveRequestSchema, input.body ?? {}, "Recepción de valija");
    const property = await requireProperty(input.context, input.propertyId);
    const batch = await requireBatch(property.id, input.batchId);
    const ids = [...new Set(body.receivedIds)];
    const docs = await db.incomingDocument.findMany({ where: { id: { in: ids }, propertyId: property.id, dispatchBatchId: batch.id, deletedAt: null } });
    if (docs.length !== ids.length) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado en esta valija.");
    const at = now();
    const updated = await db.$transaction(async (tx) => {
      await tx.incomingDocument.updateMany({ where: { id: { in: docs.map((doc) => doc.id) }, physicalStatus: "in_transit" }, data: { physicalStatus: "at_office" } });
      return tx.documentDispatchBatch.update({ where: { id: batch.id }, data: { receivedBy: batch.receivedBy ?? input.context.userId, receivedAt: batch.receivedAt ?? at } });
    });
    for (const doc of docs) {
      audit({ ...input, action: DISPATCH_AUDIT.received, row: doc, afterJson: { batchId: batch.id, batchNumber: batch.batchNumber, physicalStatus: "at_office" } });
    }
    const all = await db.incomingDocument.findMany({ where: { dispatchBatchId: batch.id, deletedAt: null }, select: { id: true, registryNumber: true, physicalStatus: true }, orderBy: { registryNumber: "asc" } });
    const sheet = updated.sheetFileId ? await db.documentFile.findUnique({ where: { id: updated.sheetFileId }, select: { fileName: true } }) : null;
    return {
      ...toDto(updated, { registryNumbers: all.map((doc) => doc.registryNumber), sheetFileName: sheet?.fileName ?? null }),
      receivedIds: all.filter((doc) => doc.physicalStatus === "at_office").map((doc) => doc.id),
      pendingIds: all.filter((doc) => doc.physicalStatus === "in_transit").map((doc) => doc.id)
    };
  }

  async function getDispatchSheetBytes(input: DispatchSheetByIdInput): Promise<DocumentBytes> {
    requireAnyPermission(input.context, CAPTURE_OR_REVIEW);
    const property = await requireProperty(input.context, input.propertyId);
    const batch = await requireBatch(property.id, input.batchId);
    if (!batch.sheetFileId) throw typed(404, "DOCUMENT_NOT_FOUND", "La valija no tiene hoja de remesa.");
    const file = await db.documentFile.findUnique({ where: { id: batch.sheetFileId } });
    if (!file || file.role !== "dispatch_sheet") throw typed(404, "DOCUMENT_NOT_FOUND", "Hoja de remesa no encontrada.");
    let bytes: Buffer;
    if (file.storageKind === "inline") {
      if (!file.inline) throw typed(404, "DOCUMENT_NOT_FOUND", "Hoja de remesa no encontrada.");
      bytes = decodeInline(file.inline);
    } else {
      const got = file.storageKey ? await storage().get(file.storageKey) : null;
      if (!got) throw typed(404, "DOCUMENT_NOT_FOUND", "Hoja de remesa no encontrada.");
      bytes = got.bytes;
    }
    const holder = await db.incomingDocument.findUnique({ where: { id: file.documentId }, select: { id: true, organizationId: true, propertyId: true, registryNumber: true } });
    if (holder) audit({ ...input, action: DISPATCH_AUDIT.sheetDownloaded, row: holder, afterJson: { batchId: batch.id, batchNumber: batch.batchNumber, fileId: file.id, sizeBytes: file.sizeBytes } });
    return { bytes, mimeType: file.mimeType, fileName: file.fileName, sha256: file.sha256, sizeBytes: file.sizeBytes, fileId: file.id };
  }

  return { closeDispatchBatch, receiveDispatchBatch, getDispatchSheetBytes };
}

export type DispatchService = ReturnType<typeof createDispatchService>;

let defaultService: DispatchService | null = null;

export function getDispatchService(): DispatchService {
  if (!defaultService) defaultService = createDispatchService();
  return defaultService;
}

export const closeDispatchBatch = (input: CloseDispatchBatchInput): Promise<DispatchBatchResult> => getDispatchService().closeDispatchBatch(input);
export const receiveDispatchBatch = (input: ReceiveDispatchBatchInput): Promise<DispatchBatchResult> => getDispatchService().receiveDispatchBatch(input);
export const getDispatchSheetBytes = (input: DispatchSheetByIdInput): Promise<DocumentBytes> => getDispatchService().getDispatchSheetBytes(input);
export type { Tx as DispatchTx };
