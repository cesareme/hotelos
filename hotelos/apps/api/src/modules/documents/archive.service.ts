// Documentos · archivo y búsqueda (Tanda T9 · lote T9-13; diseño §7.4 y §9
// `GET /organizations/:organizationId/documents/archive`).
//
//   · consulta por organización (ámbito R11: un centro del ámbito, o toda la
//     sociedad con accounting.entity.read / orgScope, o «todos los centros»
//     cuando las asignaciones los cubren; si no, 404 opaco ENTITY_SCOPE_REQUIRED
//     — assertFinanceReadScopeMany de lib/finance-scope.ts);
//   · solo documentos ya decididos: posted | archived | rejected, nunca purgados
//     (deletedAt null); los bloqueados por retención vencida (§7.5) solo con
//     documents.admin, `includeBlocked=1` y un `reason`, y cada lectura de un
//     bloqueado queda auditada (DOCUMENT_BLOCKED_READ);
//   · filtros: q (ILIKE sobre searchText, registryNumber, documentNumber,
//     supplierTaxId y título), kind, supplierId, propertyId, from/to (fecha del
//     documento, o de captura cuando no la hay), amountMin/max (totalAmount),
//     registryNumber exacto; cursor (capturedAt desc, id) de lib/pagination.ts;
//   · cada fila es un IncomingDocumentRecord (hash sha256, formato original,
//     retención: retentionUntil / extendedRetention / legalHold / blockedAt).
//     La búsqueda es ILIKE sin índice (el GIN pg_trgm llega en una migración
//     propia, §7.4).
//
// `db` y `now` inyectables (tests sin Postgres sobre las funciones puras).

import { prisma } from "@hotelos/database";
import type { IncomingDocument, Prisma } from "@prisma/client";
import { INCOMING_DOCUMENT_KINDS, PermissionDeniedError, type IncomingDocumentRecord, type IncomingDocumentStatus, type PermissionKey } from "@hotelos/shared";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { assertFinanceReadScopeMany, hasEntityReadScope, propertyWithinScope } from "../../lib/finance-scope.js";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { buildPage, parsePageQuery, type Page, type PageQuery } from "../../lib/pagination.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { boolQuerySchema, DOCUMENT_QUERY_TEXT_MAX_LENGTH, isoDaySchema } from "../../schemas/documents.schemas.js";
import { DOCUMENT_AUDIT_ENTITY } from "./documents-audit.js";
import { toIncomingDocumentRecord, type RecordExtras } from "./documents-dto.js";
import { capturedAtRange, cursorFilter, DEFAULT_OFFICE_SLA_BUSINESS_DAYS, dueAtOf, isDocumentsAdmin, isSlaBreached } from "./documents.service.js";

type Db = typeof prisma;

export const DOCUMENT_ARCHIVE_AUDIT_ACTIONS = Object.freeze({ blockedRead: "DOCUMENT_BLOCKED_READ" } as const);
const ARCHIVE_READ_PERMISSION: PermissionKey = "documents.archive.read";
const ADMIN_PERMISSION: PermissionKey = "documents.admin";

/** Estados consultables en el archivo (§7.4: decididos; rejected conserva su retención de +1 año). */
export const ARCHIVE_STATUSES: readonly IncomingDocumentStatus[] = Object.freeze(["posted", "archived", "rejected"]);

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const moneyQuerySchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}([.,]\d{1,2})?$/, { message: "importe con como máximo dos decimales (p. ej. 1250.00)." })
  .transform((value) => value.replace(",", "."));

const pagePassthrough = {
  cursor: z.string().max(4096).optional(),
  limit: z.string().max(6).optional(),
  envelope: z.string().max(5).optional()
};

export const DocumentArchiveQuerySchema = z
  .object({
    q: z.string().trim().max(DOCUMENT_QUERY_TEXT_MAX_LENGTH, { message: `q no puede superar ${DOCUMENT_QUERY_TEXT_MAX_LENGTH} caracteres.` }).optional(),
    kind: z.enum(INCOMING_DOCUMENT_KINDS, { errorMap: () => ({ message: `kind debe ser uno de: ${INCOMING_DOCUMENT_KINDS.join(", ")}.` }) }).optional(),
    supplierId: z.string().trim().min(1).max(64).optional(),
    propertyId: z.string().trim().min(1).max(64).optional(),
    from: isoDaySchema.optional(),
    to: isoDaySchema.optional(),
    amountMin: moneyQuerySchema.optional(),
    amountMax: moneyQuerySchema.optional(),
    registryNumber: z.string().trim().min(1).max(64).optional(),
    includeBlocked: boolQuerySchema.optional(),
    /** Obligatorio con includeBlocked (§7.5: la lectura de un bloqueado lleva motivo auditado). */
    reason: z.string().trim().min(3, { message: "reason debe tener al menos 3 caracteres." }).max(2000).optional(),
    ...pagePassthrough
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: "to debe ser igual o posterior a from.", path: ["to"] })
  .refine((query) => !query.amountMin || !query.amountMax || Number(query.amountMin) <= Number(query.amountMax), { message: "amountMax debe ser igual o superior a amountMin.", path: ["amountMax"] });

export type DocumentArchiveQueryInput = z.output<typeof DocumentArchiveQuerySchema>;
type ArchiveFilters = Omit<DocumentArchiveQueryInput, "cursor" | "limit" | "envelope" | "includeBlocked" | "reason" | "propertyId">;

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los tests)
// ---------------------------------------------------------------------------

/** Filtro del archivo sin tenencia ni cursor. */
export function buildArchiveWhere(filters: ArchiveFilters, options: { includeBlocked: boolean }): Prisma.IncomingDocumentWhereInput {
  const and: Prisma.IncomingDocumentWhereInput[] = [{ deletedAt: null, status: { in: [...ARCHIVE_STATUSES] } }];
  if (!options.includeBlocked) and.push({ blockedAt: null });
  if (filters.kind) and.push({ kind: filters.kind });
  if (filters.supplierId) and.push({ supplierId: filters.supplierId });
  if (filters.registryNumber) and.push({ registryNumber: { equals: filters.registryNumber, mode: "insensitive" } });
  const range = capturedAtRange(filters.from, filters.to);
  if (range) {
    // Fecha del documento; sin ella, la de captura (documentDate es @db.Date: el mismo intervalo UTC vale).
    and.push({ OR: [{ documentDate: range }, { documentDate: null, capturedAt: range }] });
  }
  if (filters.amountMin !== undefined || filters.amountMax !== undefined) {
    and.push({ totalAmount: { ...(filters.amountMin !== undefined ? { gte: filters.amountMin } : {}), ...(filters.amountMax !== undefined ? { lte: filters.amountMax } : {}) } });
  }
  if (filters.q) {
    const q = filters.q;
    and.push({
      OR: [
        { searchText: { contains: q, mode: "insensitive" } },
        { registryNumber: { contains: q, mode: "insensitive" } },
        { documentNumber: { contains: q, mode: "insensitive" } },
        { supplierTaxId: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } }
      ]
    });
  }
  return { AND: and };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DocumentArchiveServiceDeps = { db?: Db; now?: () => Date };
export type SearchArchiveInput = { context: UserContext; organizationId: string; query: Record<string, unknown>; correlationId?: string; ipAddress?: string };
export type SearchArchiveResult = { page: Page<IncomingDocumentRecord>; pageQuery: PageQuery };

export function createDocumentArchiveService(deps: DocumentArchiveServiceDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());

  async function officeSla(organizationId: string): Promise<number> {
    const settings = await db.documentSettings.findUnique({ where: { organizationId }, select: { officeSlaBusinessDays: true } });
    return settings?.officeSlaBusinessDays ?? DEFAULT_OFFICE_SLA_BUSINESS_DAYS;
  }

  /** Centros consultables (R11): null = toda la sociedad. */
  async function scopedPropertyIds(context: UserContext, organizationId: string, propertyId: string | undefined): Promise<string[] | null> {
    if (propertyId) {
      const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true } });
      if (!property || property.organizationId !== organizationId) throw new HttpError(404, "Propiedad no encontrada.", true, { code: "PROPERTY_NOT_FOUND" });
      assertFinanceReadScopeMany(context, [property.id]);
      return [property.id];
    }
    if (hasEntityReadScope(context)) return null;
    const all = await db.property.findMany({ where: { organizationId }, select: { id: true } });
    const ids = all.map((property) => property.id);
    if (!ids.every((id) => propertyWithinScope(context, id))) assertFinanceReadScopeMany(context, null); // lanza ENTITY_SCOPE_REQUIRED
    return ids;
  }

  async function extrasFor(rows: IncomingDocument[], sla: number): Promise<Map<string, RecordExtras>> {
    const out = new Map<string, RecordExtras>();
    if (rows.length === 0) return out;
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
    const nameById = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
    const at = now();
    for (const row of rows) {
      out.set(row.id, {
        supplierName: row.supplierId ? (nameById.get(row.supplierId) ?? null) : null,
        dueAt: dueAtOf(row, dueByDoc.get(row.id) ?? []),
        slaBreached: isSlaBreached(row, sla, at)
      });
    }
    return out;
  }

  async function searchArchive(input: SearchArchiveInput): Promise<SearchArchiveResult> {
    requirePermissions(input.context, [ARCHIVE_READ_PERMISSION]);
    const filters = parseOr400(DocumentArchiveQuerySchema, input.query ?? {}, "Filtro");
    const pageQuery = parsePageQuery(input.query);
    const includeBlocked = filters.includeBlocked === true;
    if (includeBlocked) {
      if (!isDocumentsAdmin(input.context)) throw new PermissionDeniedError([ADMIN_PERMISSION]);
      if (!filters.reason) {
        throw new HttpError(400, "Filtro no válido: reason: indica el motivo para consultar documentos bloqueados.", true, { code: "VALIDATION_ERROR", issues: [{ path: "reason", message: "obligatorio con includeBlocked." }] });
      }
    }
    const propertyIds = await scopedPropertyIds(input.context, input.organizationId, filters.propertyId);
    const sla = await officeSla(input.organizationId);
    const where: Prisma.IncomingDocumentWhereInput = {
      ...buildArchiveWhere(filters, { includeBlocked }),
      organizationId: input.organizationId,
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {})
    };
    const continuation = cursorFilter(pageQuery.cursor, "desc");
    const [rows, total] = await Promise.all([
      db.incomingDocument.findMany({ where: continuation ? { AND: [where, continuation] } : where, orderBy: [{ capturedAt: "desc" }, { id: "desc" }], take: pageQuery.limit + 1 }),
      db.incomingDocument.count({ where })
    ]);
    const extras = await extrasFor(rows, sla);
    const records = rows.map((row) => toIncomingDocumentRecord(row, extras.get(row.id)!));
    const keyOf = new Map(rows.map((row) => [row.id, row.capturedAt.toISOString()]));
    const page = buildPage(records, pageQuery.limit, total, (record) => keyOf.get(record.id) ?? record.capturedAt);
    if (includeBlocked) {
      const correlationId = input.correlationId ?? createId("corr");
      for (const record of page.items) {
        if (!record.blockedAt) continue;
        recordAuditEvent({
          organizationId: record.organizationId,
          propertyId: record.propertyId,
          actorUserId: input.context.userId,
          actorType: "user",
          action: DOCUMENT_ARCHIVE_AUDIT_ACTIONS.blockedRead,
          entityType: DOCUMENT_AUDIT_ENTITY,
          entityId: record.id,
          afterJson: { registryNumber: record.registryNumber, blockedAt: record.blockedAt, reason: filters.reason },
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
          correlationId
        });
      }
    }
    return { page, pageQuery };
  }

  return { searchArchive };
}

export type DocumentArchiveService = ReturnType<typeof createDocumentArchiveService>;

let defaultService: DocumentArchiveService | null = null;
export function getDocumentArchiveService(): DocumentArchiveService {
  if (!defaultService) defaultService = createDocumentArchiveService();
  return defaultService;
}

export const searchDocumentArchive = (input: SearchArchiveInput): Promise<SearchArchiveResult> => getDocumentArchiveService().searchArchive(input);
