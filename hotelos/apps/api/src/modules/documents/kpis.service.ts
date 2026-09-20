// Documentos · KPIs de la oficina (Tanda T9 · lote T9-13; diseño §9
// `GET /organizations/:organizationId/documents/kpis?from&to&propertyId`).
//
//   · permisos: documents.review + ámbito R11 (assertFinanceReadScopeMany de
//     lib/finance-scope.ts: un centro del ámbito, toda la sociedad con
//     accounting.entity.read / orgScope, o «todos los centros» cuando las
//     asignaciones los cubren; si no, 404 opaco ENTITY_SCOPE_REQUIRED);
//   · periodo [from, to] en días ISO (UTC); sin periodo, los últimos 30 días;
//   · agregados (forma `DocumentKpis` de packages/shared/src/documents-types.ts):
//       pendingByProperty   backlog ACTUAL de la oficina por centro (sent_to_office
//                           | in_review, no purgados ni bloqueados) con el SLA
//                           vencido (§6.3, DocumentSettings.officeSlaBusinessDays);
//       avgHoursCentreToOffice  media de horas entre `sentAt` y `decidedAt` de
//                           los documentos decididos en el periodo (null sin
//                           decisiones);
//       touchlessPct        % de documentos aprobados (approved | posted) en el
//                           periodo sin corregir ningún campo extraído
//                           (reviewedFieldsJson null o {}); null sin aprobaciones;
//       billsWithoutReceipt facturas de proveedor del periodo con matchStatus
//                           none y alguna línea de compra (cuenta 60x): sin
//                           albarán cotejado (§7.2);
//       receiptsWithoutBill recepciones del periodo aún `received` (sin factura);
//       slaBreached         pendientes con el SLA vencido (todos los centros del ámbito);
//       actionsDueThisWeek  tareas abiertas (§7.3) que vencen en los próximos 7 días;
//       aiCostEur           Σ DocumentExtraction.costEur del periodo;
//   · cada agregado pasa por `safe()` de lib/degraded.ts (QC-06): si su
//     consulta falla, conserva el valor por defecto y aparece en `degraded[]`
//     con { metric, reason: "query_failed" } — nunca un 0 silencioso.
//
// `db` y `now` inyectables (kpis.test.mts prueba los agregados puros y el
// marcado de degraded sin Postgres).

import { prisma } from "@hotelos/database";
import type { IncomingDocument } from "@prisma/client";
import type { DocumentKpiDegraded, DocumentKpis, PermissionKey } from "@hotelos/shared";
import { z } from "zod";
import { createDegradedCollector, type DegradedCollector } from "../../lib/degraded.js";
import type { UserContext } from "../../lib/demo-store.js";
import { assertFinanceReadScopeMany, hasEntityReadScope, propertyWithinScope } from "../../lib/finance-scope.js";
import { HttpError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { isoDaySchema } from "../../schemas/documents.schemas.js";
import { capturedAtRange, DEFAULT_OFFICE_SLA_BUSINESS_DAYS, isSlaBreached, OFFICE_QUEUE_DEFAULT_STATUSES } from "./documents.service.js";

type Db = typeof prisma;

const REVIEW_PERMISSION: PermissionKey = "documents.review";
const DAY_MS = 86_400_000;
/** Ventana por defecto cuando la query no trae periodo (hoy y los 29 días anteriores). */
export const DEFAULT_KPI_PERIOD_DAYS = 30;
/** «Vencen esta semana»: tareas abiertas con dueAt en [hoy 00:00 UTC, +7 días). */
export const ACTIONS_WEEK_DAYS = 7;
export const KPI_DEGRADED_REASON = "query_failed";
/** Cuentas de compras (PGC grupo 60): una factura con líneas 60x y matchStatus none no tiene albarán cotejado. */
export const PURCHASE_ACCOUNT_PREFIX = "60";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const DocumentKpisQuerySchema = z
  .object({
    from: isoDaySchema.optional(),
    to: isoDaySchema.optional(),
    propertyId: z.string().trim().min(1).max(64).optional()
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: "to debe ser igual o posterior a from.", path: ["to"] });

export type DocumentKpisQueryInput = z.output<typeof DocumentKpisQuerySchema>;
export type KpiPeriod = { from: string; to: string };

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los unit tests)
// ---------------------------------------------------------------------------

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Periodo efectivo: el de la query, completado con hoy / to − 29 días cuando falta un extremo. */
export function resolveKpiPeriod(query: Pick<DocumentKpisQueryInput, "from" | "to">, now: Date): KpiPeriod {
  const to = query.to ?? isoDay(now);
  const from = query.from ?? isoDay(new Date(new Date(`${to}T00:00:00.000Z`).getTime() - (DEFAULT_KPI_PERIOD_DAYS - 1) * DAY_MS));
  return { from, to };
}

/** Media de horas entre `start` y `end` (una decimal); pares incompletos o negativos se ignoran; null sin pares. */
export function averageHours(pairs: ReadonlyArray<{ start: Date | null; end: Date | null }>): number | null {
  let total = 0;
  let count = 0;
  for (const pair of pairs) {
    if (!pair.start || !pair.end) continue;
    const hours = (pair.end.getTime() - pair.start.getTime()) / 3_600_000;
    if (!Number.isFinite(hours) || hours < 0) continue;
    total += hours;
    count += 1;
  }
  if (count === 0) return null;
  return Math.round((total / count) * 10) / 10;
}

/** Aprobado sin tocar la extracción: reviewedFieldsJson ausente o un objeto sin claves. */
export function isTouchless(reviewedFieldsJson: unknown): boolean {
  if (reviewedFieldsJson === null || reviewedFieldsJson === undefined) return true;
  if (typeof reviewedFieldsJson !== "object") return false;
  if (Array.isArray(reviewedFieldsJson)) return reviewedFieldsJson.length === 0;
  return Object.keys(reviewedFieldsJson as Record<string, unknown>).length === 0;
}

/** % (una decimal) de filas touchless; null sin filas. */
export function touchlessPct(rows: ReadonlyArray<{ reviewedFieldsJson: unknown }>): number | null {
  if (rows.length === 0) return null;
  const touchless = rows.filter((row) => isTouchless(row.reviewedFieldsJson)).length;
  return Math.round((touchless / rows.length) * 1000) / 10;
}

export type PropertyRef = { id: string; code: string | null; name: string };
export type PendingRow = Pick<IncomingDocument, "propertyId" | "status" | "sentAt">;

/** Backlog por centro (todos los centros del ámbito, también los que no tienen pendientes), pendientes desc y nombre. */
export function pendingByProperty(properties: readonly PropertyRef[], rows: readonly PendingRow[], slaBusinessDays: number, now: Date): DocumentKpis["pendingByProperty"] {
  const byId = new Map<string, { pending: number; slaBreached: number }>();
  for (const property of properties) byId.set(property.id, { pending: 0, slaBreached: 0 });
  for (const row of rows) {
    const bucket = byId.get(row.propertyId);
    if (!bucket) continue;
    bucket.pending += 1;
    if (isSlaBreached(row, slaBusinessDays, now)) bucket.slaBreached += 1;
  }
  return properties
    .map((property) => ({ propertyId: property.id, propertyCode: property.code, propertyName: property.name, ...byId.get(property.id)! }))
    .sort((a, b) => b.pending - a.pending || a.propertyName.localeCompare(b.propertyName, "es"));
}

/** [hoy 00:00 UTC, +7 días) para «vencen esta semana». */
export function actionsWeekWindow(now: Date): { gte: Date; lt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { gte: start, lt: new Date(start.getTime() + ACTIONS_WEEK_DAYS * DAY_MS) };
}

/** Etiquetas del colector → forma compartida `DocumentKpiDegraded`. */
export function toDegraded(labels: readonly string[], reason: string = KPI_DEGRADED_REASON): DocumentKpiDegraded[] {
  return [...new Set(labels)].map((metric) => ({ metric, reason }));
}

export function moneyString(value: { toFixed(scale: number): string } | null | undefined): string {
  return value == null ? "0.00" : value.toFixed(2);
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DocumentKpisServiceDeps = { db?: Db; now?: () => Date; collector?: (context: Record<string, unknown>) => DegradedCollector };
export type GetDocumentKpisInput = { context: UserContext; organizationId: string; query: Record<string, unknown>; correlationId?: string };

export function createDocumentKpisService(deps: DocumentKpisServiceDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const collectorFor = deps.collector ?? ((context: Record<string, unknown>) => createDegradedCollector("documents.kpis", context));

  /** Centros del ámbito (R11): con propertyId, ese centro; sin él, toda la sociedad o todos los asignados. */
  async function scopedProperties(context: UserContext, organizationId: string, propertyId: string | undefined): Promise<PropertyRef[]> {
    const all = await db.property.findMany({ where: { organizationId }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } });
    if (propertyId) {
      const property = all.find((row) => row.id === propertyId);
      if (!property) throw new HttpError(404, "Propiedad no encontrada.", true, { code: "PROPERTY_NOT_FOUND" });
      assertFinanceReadScopeMany(context, [property.id]);
      return [property];
    }
    if (hasEntityReadScope(context)) return all;
    if (!all.every((property) => propertyWithinScope(context, property.id))) assertFinanceReadScopeMany(context, null); // lanza ENTITY_SCOPE_REQUIRED
    return all;
  }

  async function getDocumentKpis(input: GetDocumentKpisInput): Promise<DocumentKpis> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const filters = parseOr400(DocumentKpisQuerySchema, input.query ?? {}, "Filtro");
    const at = now();
    const period = resolveKpiPeriod(filters, at);
    const properties = await scopedProperties(input.context, input.organizationId, filters.propertyId);
    const propertyIds = properties.map((property) => property.id);
    const range = capturedAtRange(period.from, period.to)!;
    const collector = collectorFor({ organizationId: input.organizationId, propertyId: filters.propertyId ?? null, ...(input.correlationId ? { correlationId: input.correlationId } : {}) });
    const scope = { organizationId: input.organizationId, propertyId: { in: propertyIds } };

    const sla = await collector.safe(
      "officeSla",
      db.documentSettings.findUnique({ where: { organizationId: input.organizationId }, select: { officeSlaBusinessDays: true } }).then((row) => row?.officeSlaBusinessDays ?? DEFAULT_OFFICE_SLA_BUSINESS_DAYS),
      DEFAULT_OFFICE_SLA_BUSINESS_DAYS
    );

    const pendingRows = await collector.safe(
      "pendingByProperty",
      db.incomingDocument.findMany({ where: { ...scope, deletedAt: null, blockedAt: null, status: { in: [...OFFICE_QUEUE_DEFAULT_STATUSES] } }, select: { propertyId: true, status: true, sentAt: true } }) as Promise<PendingRow[] | null>,
      null
    );
    // slaBreached sale de la misma consulta: si falló, también queda degradado.
    if (pendingRows === null) collector.degraded.push("slaBreached");
    const pending = pendingByProperty(properties, pendingRows ?? [], sla, at);

    const decided = await collector.safe(
      "avgHoursCentreToOffice",
      db.incomingDocument.findMany({ where: { ...scope, deletedAt: null, sentAt: { not: null }, decidedAt: range }, select: { sentAt: true, decidedAt: true } }),
      [] as Array<{ sentAt: Date | null; decidedAt: Date | null }>
    );

    const approved = await collector.safe(
      "touchlessPct",
      db.incomingDocument.findMany({ where: { ...scope, deletedAt: null, status: { in: ["approved", "posted"] }, decidedAt: range }, select: { reviewedFieldsJson: true } }),
      [] as Array<{ reviewedFieldsJson: unknown }>
    );

    const billsWithoutReceipt = await collector.safe(
      "billsWithoutReceipt",
      db.supplierBill.count({
        where: {
          propertyId: { in: propertyIds },
          matchStatus: "none",
          status: { not: "cancelled" },
          lines: { some: { expenseAccountCode: { startsWith: PURCHASE_ACCOUNT_PREFIX } } },
          OR: [{ receptionDate: range }, { receptionDate: null, issueDate: range }]
        }
      }),
      0
    );

    const receiptsWithoutBill = await collector.safe("receiptsWithoutBill", db.goodsReceipt.count({ where: { ...scope, status: "received", deliveryDate: range } }), 0);

    const actionsDueThisWeek = await collector.safe("actionsDueThisWeek", db.documentAction.count({ where: { ...scope, status: "open", dueAt: actionsWeekWindow(at) } }), 0);

    const aiCost = await collector.safe(
      "aiCostEur",
      db.documentExtraction.aggregate({ where: { createdAt: range, document: { organizationId: input.organizationId, propertyId: { in: propertyIds } } }, _sum: { costEur: true } }).then((agg) => agg._sum.costEur),
      null
    );

    return {
      from: period.from,
      to: period.to,
      propertyId: filters.propertyId ?? null,
      officeSlaBusinessDays: sla,
      pendingByProperty: pending,
      avgHoursCentreToOffice: averageHours(decided.map((row) => ({ start: row.sentAt, end: row.decidedAt }))),
      touchlessPct: touchlessPct(approved),
      billsWithoutReceipt,
      receiptsWithoutBill,
      slaBreached: pending.reduce((sum, row) => sum + row.slaBreached, 0),
      actionsDueThisWeek,
      aiCostEur: moneyString(aiCost),
      degraded: toDegraded(collector.degraded)
    };
  }

  return { getDocumentKpis };
}

export type DocumentKpisService = ReturnType<typeof createDocumentKpisService>;

let defaultService: DocumentKpisService | null = null;
export function getDocumentKpisService(): DocumentKpisService {
  if (!defaultService) defaultService = createDocumentKpisService();
  return defaultService;
}

export const getDocumentKpis = (input: GetDocumentKpisInput): Promise<DocumentKpis> => getDocumentKpisService().getDocumentKpis(input);
