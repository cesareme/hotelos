// Activo inmobiliario · obras (Tanda ACT · L4, diseño §4 `CapexProject`
// ampliado, §5 «Obras» y §5.1 máquina CAPEX_WORK):
//
//   proposed → approved (motor existente: asset.capex.approve en
//   modules/assets/assets.service.ts updateCapexProject, intocable) → licencia de
//   obras (`licenceRequired` → `licenceDocumentId` obligatorio antes de
//   in_progress: 409 LICENCE_REQUIRED) → in_progress → completed → «Capitalizar»
//   (409 CAPEX_NOT_COMPLETED · CAPEX_ALREADY_CAPITALIZED · CAPEX_NOT_LINKED sin
//   `realEstateAssetId`) → fila del registro de inmovilizado con
//   `createFixedAsset` (modules/fixed-assets: solo registro + auditoría, NO
//   asienta: los 21x ya vienen de Sage o de facturas `investmentGood`) y
//   `capitalizedFixedAssetId` / `capitalizedAt` en el proyecto.
//
// Las transiciones in_progress / completed las hace este lote con
// prisma.capexProject.update (las 12 columnas de ACT-L0b son opcionales y
// lib/demo-store.ts no las conoce; assets.service.ts sigue leyendo Prisma
// primero, así que su espejo no se desalinea). La ejecución (diario 21x/23x
// del centro o Σ actualCost) la calcula capex-execution.service.ts y se
// cachea en `executedAmountLedger` al leer.
//
// Tenencia: GET cuelga de /properties/:propertyId/* (guardia global); PATCH y
// POST por id pasan por assertEntityAccess({ entity: "capexProject" }) en
// works.routes.ts y el servicio exige además que la fila sea del centro
// resuelto (404 opaco). Auditoría: CAPEX_WORK_UPDATED · CAPEX_CAPITALIZED.

import { prisma } from "@hotelos/database";
import type { CapexItem, CapexProject, Prisma } from "@prisma/client";
import type { CapexProjectStatus, CapexWorkKind, CapexWorkRecord, IsoDay, RealEstateAlert } from "@hotelos/shared";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { CapexWorkPatchSchema } from "../../schemas/real-estate.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { createFixedAsset, type FixedAssetDto } from "../fixed-assets/fixed-assets.service.js";
import { dayOf, money } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { buildRealEstateAlerts, type AlertCapexInput } from "./alerts.pure.js";
import {
  capitalizationAccountFor,
  capitalizationCost,
  computeLedgerExecution,
  executionOf,
  executionWindow,
  parseExecutionPrefixes,
  serializeExecutionPrefixes,
  type CapexExecution,
  type LedgerExecution
} from "./capex-execution.service.js";
import { realEstateError } from "./errors.js";
import { definedFields, isoDayOrNull, moneyOrNull } from "./real-estate.service.js";
import { assertTransition } from "./state-machines.js";
import { toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type CapexWorkCommandInput = { context: UserContext; capexProjectId: string; propertyId: string; correlationId: string };

/** Estados que admite `PATCH …/work` (`approved` lo pone el motor existente; `cancelled` no es una obra). */
export const CAPEX_WORK_PATCH_STATUSES = ["in_progress", "completed"] as const;
export type CapexWorkPatchStatus = (typeof CAPEX_WORK_PATCH_STATUSES)[number];

/** `PATCH /capex-projects/:id/work`: los datos de obra de real-estate.schemas.ts + `status` (in_progress | completed). */
export const CapexWorkStatusPatchSchema = CapexWorkPatchSchema.innerType()
  .extend({
    status: z.enum(CAPEX_WORK_PATCH_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${CAPEX_WORK_PATCH_STATUSES.join(", ")}.` }) }).optional()
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "El cuerpo de la petición no incluye ningún campo que modificar." });
export type CapexWorkStatusPatchInput = z.output<typeof CapexWorkStatusPatchSchema>;

/** `POST /capex-projects/:id/capitalize`: cuerpo opcional con la fecha de fin de obra (puesta en funcionamiento del inmovilizado). */
export const CapexCapitalizeSchema = z
  .object({
    acquisitionDate: z
      .string({ invalid_type_error: "acquisitionDate debe ser un día (AAAA-MM-DD)." })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "acquisitionDate debe ser un día (AAAA-MM-DD)." })
      .optional()
  })
  .strict();

/**
 * Fecha de alta del inmovilizado (diseño §6: «startDate = fin de obra»; ACT-REV-12):
 * la del cuerpo si llega; si no, `targetEndDate` cuando ya ha pasado (fin de obra
 * previsto y cumplido); en el resto, hoy. Nunca posterior a hoy. Puro.
 */
export function capitalizationDateFor(project: Pick<CapexProject, "targetEndDate">, requested: IsoDay | undefined, today: IsoDay): IsoDay {
  if (requested) return requested > today ? today : requested;
  const target = isoDayOrNull(project.targetEndDate);
  return target && target <= today ? target : today;
}

export type RealEstateWorksResponse = { projects: CapexWorkRecord[]; alerts: RealEstateAlert[] };
export type CapexCapitalizationResult = { project: CapexWorkRecord; fixedAsset: FixedAssetDto };

// ---------------------------------------------------------------------------
// Mapeadores y proyecciones (puros; exportados para el test unitario)
// ---------------------------------------------------------------------------

export function toCapexWorkRecord(row: CapexProject, execution: CapexExecution): CapexWorkRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    description: row.description ?? null,
    budget: money(row.budget),
    status: row.status as CapexProjectStatus,
    startDate: isoDayOrNull(row.startDate),
    targetEndDate: isoDayOrNull(row.targetEndDate),
    ownerApprovedBy: row.ownerApprovedBy ?? null,
    createdByUserId: row.createdByUserId ?? null,
    realEstateAssetId: row.realEstateAssetId ?? null,
    workKind: (row.workKind ?? null) as CapexWorkKind | null,
    licenceRequired: row.licenceRequired,
    licenceDocumentId: row.licenceDocumentId ?? null,
    licenceGrantedAt: isoDayOrNull(row.licenceGrantedAt),
    icioAmount: moneyOrNull(row.icioAmount),
    projectDocumentId: row.projectDocumentId ?? null,
    completionDocumentId: row.completionDocumentId ?? null,
    executionAccountPrefixes: row.executionAccountPrefixes ?? null,
    executedAmountLedger: execution.executedAmountLedger,
    executedAmountItems: execution.executedAmountItems,
    executedAmount: execution.executedAmount,
    executionSource: execution.executionSource,
    capitalizedFixedAssetId: row.capitalizedFixedAssetId ?? null,
    capitalizedAt: isoDayOrNull(row.capitalizedAt)
  };
}

export function capexAlertInput(row: CapexProject): AlertCapexInput {
  return { id: row.id, propertyId: row.propertyId, name: row.name, status: row.status, licenceRequired: row.licenceRequired, licenceDocumentId: row.licenceDocumentId ?? null };
}

const AUDIT_FIELDS = ["status", "budget", "startDate", "targetEndDate", "realEstateAssetId", "workKind", "licenceRequired", "licenceDocumentId", "licenceGrantedAt", "icioAmount", "projectDocumentId", "completionDocumentId", "executionAccountPrefixes", "executedAmountLedger", "executedAmountItems", "executedAmount", "executionSource", "capitalizedFixedAssetId", "capitalizedAt"] as const satisfies ReadonlyArray<keyof CapexWorkRecord>;

/** Proyección auditable de la obra (sin descripción libre). */
export function auditProjection(record: CapexWorkRecord): Record<string, unknown> {
  return Object.fromEntries(AUDIT_FIELDS.map((key) => [key, record[key] ?? null]));
}

// ---------------------------------------------------------------------------
// Lectura con ejecución (y caché de executedAmountLedger)
// ---------------------------------------------------------------------------

async function organizationOfProperty(db: Db, propertyId: string): Promise<string> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

/** Ejecución del proyecto: lee el diario del centro y cachea `executedAmountLedger` en la fila si cambió. */
export async function loadExecution(db: Db, project: CapexProject, items: ReadonlyArray<Pick<CapexItem, "actualCost">>, organizationId: string, today: IsoDay): Promise<{ execution: CapexExecution; ledger: LedgerExecution; row: CapexProject }> {
  const { from, to } = executionWindow(project, today);
  const ledger = await computeLedgerExecution(db, { organizationId, propertyId: project.propertyId, from, to, prefixes: parseExecutionPrefixes(project.executionAccountPrefixes) });
  const execution = executionOf(project, items, ledger);
  const cached = project.executedAmountLedger === null ? null : money(project.executedAmountLedger);
  let row = project;
  if (cached !== execution.executedAmountLedger) {
    row = await db.capexProject.update({ where: { id: project.id }, data: { executedAmountLedger: execution.executedAmountLedger } });
  }
  return { execution, ledger, row };
}

/** `GET /properties/:propertyId/real-estate/works`: proyectos del centro con ejecución y alertas de licencia. */
export async function listRealEstateWorks(propertyId: string, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateWorksResponse> {
  const organizationId = await organizationOfProperty(prisma, propertyId);
  const rows = await prisma.capexProject.findMany({ where: { propertyId }, orderBy: [{ status: "asc" }, { name: "asc" }] });
  if (rows.length === 0) return { projects: [], alerts: [] };
  const items = await prisma.capexItem.findMany({ where: { capexProjectId: { in: rows.map((row) => row.id) } }, select: { capexProjectId: true, actualCost: true } });
  const itemsByProject = new Map<string, Array<{ actualCost: CapexItem["actualCost"] }>>();
  for (const item of items) {
    const list = itemsByProject.get(item.capexProjectId) ?? [];
    list.push({ actualCost: item.actualCost });
    itemsByProject.set(item.capexProjectId, list);
  }
  const projects: CapexWorkRecord[] = [];
  for (const row of rows) {
    const { execution, row: fresh } = await loadExecution(prisma, row, itemsByProject.get(row.id) ?? [], organizationId, today);
    projects.push(toCapexWorkRecord(fresh, execution));
  }
  const alerts = buildRealEstateAlerts({ today, capexProjects: rows.map(capexAlertInput) });
  return { projects, alerts };
}

// ---------------------------------------------------------------------------
// Búsquedas con tenencia
// ---------------------------------------------------------------------------

/** Proyecto del centro resuelto por assertEntityAccess (404 opaco si la fila no cuelga de él). */
async function requireCapexProject(db: Db, propertyId: string, capexProjectId: string): Promise<CapexProject> {
  const row = await db.capexProject.findFirst({ where: { id: capexProjectId, propertyId } });
  if (!row) throw new NotFoundError("Proyecto CAPEX no encontrado.");
  return row;
}

/** `realEstateAssetId` del cuerpo: debe ser la ficha del MISMO centro del proyecto (404 tipado ASSET_NOT_FOUND, opaco). */
async function requireAssetOfProperty(db: Db, propertyId: string, assetId: string): Promise<{ id: string; organizationId: string }> {
  const asset = await db.realEstateAsset.findFirst({ where: { id: assetId, propertyId }, select: { id: true, organizationId: true } });
  if (!asset) throw realEstateError(404, "ASSET_NOT_FOUND", "Activo inmobiliario no encontrado.");
  return asset;
}

/** Documento (licencia, proyecto, certificado final) del centro y no retirado; 404 opaco. */
async function requireDocumentOfProperty(db: Db, propertyId: string, documentId: string, what: string): Promise<void> {
  const document = await db.realEstateDocument.findFirst({ where: { id: documentId, propertyId, deletedAt: null }, select: { id: true } });
  if (!document) throw new NotFoundError(`${what} no encontrado.`);
}

// ---------------------------------------------------------------------------
// PATCH /capex-projects/:id/work — datos de obra y/o status (in_progress · completed)
// ---------------------------------------------------------------------------

export async function updateCapexWork(input: CapexWorkCommandInput & { body: unknown }): Promise<CapexWorkRecord> {
  const data = parseOr400(CapexWorkStatusPatchSchema, input.body ?? {}, "Obra");
  const { status, executionAccountPrefixes, ...rest } = data;
  const fields = definedFields(rest);
  const today = toIsoDay(new Date());

  const result = await prisma.$transaction(async (tx) => {
    const before = await requireCapexProject(tx, input.propertyId, input.capexProjectId);
    const organizationId = await organizationOfProperty(tx, before.propertyId);

    if (fields.realEstateAssetId) await requireAssetOfProperty(tx, before.propertyId, fields.realEstateAssetId);
    if (fields.licenceDocumentId) await requireDocumentOfProperty(tx, before.propertyId, fields.licenceDocumentId, "Documento de la licencia de obras");
    if (fields.projectDocumentId) await requireDocumentOfProperty(tx, before.propertyId, fields.projectDocumentId, "Documento del proyecto");
    if (fields.completionDocumentId) await requireDocumentOfProperty(tx, before.propertyId, fields.completionDocumentId, "Certificado final de obra");

    const patch: Prisma.CapexProjectUncheckedUpdateInput = { ...fields };
    if (executionAccountPrefixes !== undefined) patch.executionAccountPrefixes = serializeExecutionPrefixes(executionAccountPrefixes);

    // Estado tras aplicar los campos (la licencia puede llegar en la misma petición que el paso a in_progress).
    const merged = { ...before, ...fields } as CapexProject;
    if (status !== undefined) {
      assertTransition("CAPEX_WORK", before.status, status);
      if (status === "in_progress" && merged.licenceRequired && !merged.licenceDocumentId) {
        throw realEstateError(409, "LICENCE_REQUIRED", "La obra exige licencia: registra el documento de la licencia de obras (licenceDocumentId) antes de iniciarla.", { capexProjectId: before.id, from: before.status, to: status });
      }
      patch.status = status;
    }

    const after = await tx.capexProject.update({ where: { id: before.id }, data: patch });
    const items = await tx.capexItem.findMany({ where: { capexProjectId: before.id }, select: { actualCost: true } });
    const { execution, row } = await loadExecution(tx, after, items, organizationId, today);
    return { organizationId, before, after: row, execution, items };
  });

  const beforeRecord = toCapexWorkRecord(result.before, executionOf(result.before, result.items));
  const afterRecord = toCapexWorkRecord(result.after, result.execution);
  recordAuditEvent({
    organizationId: result.organizationId,
    propertyId: result.after.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CAPEX_WORK_UPDATED",
    entityType: "capex_project",
    entityId: result.after.id,
    beforeJson: auditProjection(beforeRecord),
    afterJson: { ...auditProjection(afterRecord), changed: [...Object.keys(fields), ...(executionAccountPrefixes !== undefined ? ["executionAccountPrefixes"] : []), ...(status !== undefined ? ["status"] : [])] },
    correlationId: input.correlationId
  });
  return afterRecord;
}

// ---------------------------------------------------------------------------
// POST /capex-projects/:id/capitalize — obra terminada → registro de inmovilizado
// ---------------------------------------------------------------------------

export async function capitalizeCapexProject(input: CapexWorkCommandInput & { body?: unknown }): Promise<CapexCapitalizationResult> {
  const today = toIsoDay(new Date());
  const options = parseOr400(CapexCapitalizeSchema, input.body && typeof input.body === "object" ? input.body : {}, "Capitalización");
  const project = await requireCapexProject(prisma, input.propertyId, input.capexProjectId);
  if (project.status !== "completed") {
    throw realEstateError(409, "CAPEX_NOT_COMPLETED", "Solo se capitaliza una obra terminada (status completed).", { capexProjectId: project.id, status: project.status });
  }
  if (project.capitalizedFixedAssetId) {
    throw realEstateError(409, "CAPEX_ALREADY_CAPITALIZED", "La obra ya está capitalizada.", { capexProjectId: project.id, capitalizedFixedAssetId: project.capitalizedFixedAssetId, capitalizedAt: dayOf(project.capitalizedAt) });
  }
  if (!project.realEstateAssetId) {
    throw realEstateError(409, "CAPEX_NOT_LINKED", "La obra no está enlazada a la ficha del activo inmobiliario (realEstateAssetId): enlázala antes de capitalizar.", { capexProjectId: project.id });
  }
  const organizationId = await organizationOfProperty(prisma, project.propertyId);
  const items = await prisma.capexItem.findMany({ where: { capexProjectId: project.id }, select: { actualCost: true } });
  const { execution, row } = await loadExecution(prisma, project, items, organizationId, today);
  const cost = capitalizationCost(execution, row.icioAmount);
  if (cost.lte(0)) {
    const error = new BadRequestError("La obra no tiene coste que capitalizar: ni ejecución en el diario, ni partidas con coste real, ni ICIO.");
    error.details = { code: "VALIDATION_ERROR", executedAmount: execution.executedAmount, executionSource: execution.executionSource, icioAmount: moneyOrNull(row.icioAmount) };
    throw error;
  }
  const accountCode = capitalizationAccountFor(row.workKind);

  // Solo registro + auditoría (verificado: createFixedAsset no asienta); puesta en funcionamiento = fin de obra
  // (`acquisitionDate` del cuerpo, si no `targetEndDate` ya pasado, si no hoy; ACT-REV-12).
  const acquisitionDate = capitalizationDateFor(row, options.acquisitionDate as IsoDay | undefined, today);
  const fixedAsset = await createFixedAsset({
    context: input.context,
    propertyId: row.propertyId,
    correlationId: input.correlationId,
    body: { name: row.name, accountCode, acquisitionDate, acquisitionCost: cost.toFixed(2), assetId: null }
  });

  const after = await prisma.capexProject.update({ where: { id: row.id }, data: { capitalizedFixedAssetId: fixedAsset.id, capitalizedAt: new Date(`${today}T00:00:00.000Z`) } });
  const record = toCapexWorkRecord(after, execution);
  recordAuditEvent({
    organizationId,
    propertyId: after.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CAPEX_CAPITALIZED",
    entityType: "capex_project",
    entityId: after.id,
    beforeJson: auditProjection(toCapexWorkRecord(row, execution)),
    afterJson: { ...auditProjection(record), fixedAssetId: fixedAsset.id, accountCode, acquisitionDate, acquisitionCost: cost.toFixed(2), icioAmount: moneyOrNull(row.icioAmount) },
    correlationId: input.correlationId
  });
  return { project: record, fixedAsset };
}
