// Activo inmobiliario · inspecciones obligatorias (Tanda ACT · L5, diseño
// docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §4 `RealEstateInspection`, §4.1
// catálogo por defecto, §5 «Inspección» y §5.1 máquina INSPECTION).
//
// Ciclo: POST nace `programada` (scheduledAt = nextDueAt de la anterior cuando
// la crea la sucesora) → «Registrar acta» (PATCH con performedAt + result;
// real_estate.manage) → `realizada` (favorable) o `con_defectos` (condicionada
// o negativa; defectsJson [{ severity, text, dueAt, fixedAt }]) → «Subsanar»
// (PATCH con todos los defectos fixedAt o correctedAt) → `cerrada`. En los dos
// caminos (acta favorable y subsanación completa) nace la siguiente
// `programada` con scheduledAt = nextDueAt. `nextDueAt` = performedAt +
// periodicityMonths salvo que el cuerpo lo fije (editable). El plazo
// (`dueState`) es derivado y nunca se persiste (vigencias.ts). Si la
// inspección lleva `complianceRequirementCode` y el código existe en el
// catálogo, el acta y el cierre sincronizan el ComplianceItem del centro
// (issueDate / expiryDate / status; patrón compliance-center.service.ts
// `createComplianceDocument` → upsert del ítem). Sin scheduler ni SafetyCheck
// en esta tanda (modules/maintenance y compliance intactos).
//
// La planificación del PATCH (`planInspectionPatch`) es pura y va exportada
// para el test unitario (__tests__/inspections.test.mts); el servicio solo
// carga la fila, aplica el plan en una transacción y audita.

import { prisma } from "@hotelos/database";
import { Prisma, type RealEstateInspection } from "@prisma/client";
import type {
  IsoDay,
  RealEstateInspectionDefect,
  RealEstateInspectionKind,
  RealEstateInspectionRecord,
  RealEstateInspectionResult,
  RealEstateInspectionStatus
} from "@hotelos/shared";
import { REAL_ESTATE_DEFECT_SEVERITIES } from "@hotelos/shared";
import { NotFoundError } from "../../lib/http-error.js";
import {
  RealEstateInspectionCreateSchema,
  RealEstateInspectionListQuerySchema,
  RealEstateInspectionPatchSchema,
  type RealEstateInspectionDefectInput,
  type RealEstateInspectionListQueryInput
} from "../../schemas/real-estate.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { dayOf, utcDay } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { realEstateError } from "./errors.js";
import { definedFields, isoDayOrNull, requireRealEstateAsset, type RealEstateCommandInput } from "./real-estate.service.js";
import { assertTransition, nextStates } from "./state-machines.js";
import { addMonths, inspectionDueState, isIsoDay, toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

// ---------------------------------------------------------------------------
// Catálogo por defecto (diseño §4.1): base legal y periodicidad en meses
// ---------------------------------------------------------------------------

export type RealEstateInspectionDefault = { legalBasis: string | null; periodicityMonths: number | null };

/** kind → base legal → meses. `otra` no tiene defecto (lo fija el cuerpo). */
export const REAL_ESTATE_INSPECTION_DEFAULTS: Record<RealEstateInspectionKind, RealEstateInspectionDefault> = {
  oca_ascensor: { legalBasis: "RD 355/2024 art. 11.4.a", periodicityMonths: 24 },
  oca_bt: { legalBasis: "REBT ITC-BT-05 4.1.b", periodicityMonths: 60 },
  oca_pci: { legalBasis: "RD 513/2017 art. 22", periodicityMonths: 120 },
  rite: { legalBasis: "RITE IT 4.3", periodicityMonths: 48 },
  gas: { legalBasis: "RD 919/2006 ITC-ICG 07", periodicityMonths: 60 },
  equipos_presion: { legalBasis: "RD 809/2021 art. 9", periodicityMonths: 36 },
  legionella: { legalBasis: "RD 487/2022 Anexos IV-V", periodicityMonths: 3 },
  piscina: { legalBasis: "RD 742/2013 Anexo III", periodicityMonths: 1 },
  iee_ite: { legalBasis: "Decreto 61/2021 / ITE Madrid", periodicityMonths: 120 },
  cee: { legalBasis: "RD 390/2021 art. 13", periodicityMonths: 120 },
  simulacro: { legalBasis: "RD 393/2007", periodicityMonths: 12 },
  otra: { legalBasis: null, periodicityMonths: null }
};

/** Rellena legalBasis / periodicityMonths desde el catálogo cuando el cuerpo no los trae (null explícito se respeta). */
export function applyInspectionDefaults<T extends { kind: RealEstateInspectionKind; legalBasis?: string | null; periodicityMonths?: number | null }>(body: T): T & RealEstateInspectionDefault {
  const defaults = REAL_ESTATE_INSPECTION_DEFAULTS[body.kind] ?? REAL_ESTATE_INSPECTION_DEFAULTS.otra;
  return {
    ...body,
    legalBasis: body.legalBasis === undefined ? defaults.legalBasis : body.legalBasis,
    periodicityMonths: body.periodicityMonths === undefined ? defaults.periodicityMonths : body.periodicityMonths
  };
}

/** nextDueAt = performedAt + periodicidad (null sin periodicidad). */
export function computeNextDueAt(performedAt: IsoDay | null | undefined, periodicityMonths: number | null | undefined): IsoDay | null {
  if (!performedAt || !periodicityMonths || periodicityMonths <= 0) return null;
  return addMonths(performedAt, periodicityMonths);
}

// ---------------------------------------------------------------------------
// Defectos (defectsJson)
// ---------------------------------------------------------------------------

const DEFECT_SEVERITIES = new Set<string>(REAL_ESTATE_DEFECT_SEVERITIES);

/** Lee `defectsJson` de la fila tolerando basura (una entrada sin forma se descarta). */
export function parseDefects(value: unknown): RealEstateInspectionDefect[] | null {
  if (!Array.isArray(value)) return null;
  const out: RealEstateInspectionDefect[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.text !== "string" || !DEFECT_SEVERITIES.has(String(raw.severity))) continue;
    out.push({
      severity: raw.severity as RealEstateInspectionDefect["severity"],
      text: raw.text,
      dueAt: isIsoDay(raw.dueAt) ? raw.dueAt : null,
      fixedAt: isIsoDay(raw.fixedAt) ? raw.fixedAt : null
    });
  }
  return out;
}

/** Defectos del cuerpo (zod: Date UTC-medianoche) → forma persistida (IsoDay). */
export function defectsFromInput(defects: RealEstateInspectionDefectInput[] | null | undefined): RealEstateInspectionDefect[] | null | undefined {
  if (defects === undefined) return undefined;
  if (defects === null) return null;
  return defects.map((defect) => ({ severity: defect.severity, text: defect.text, dueAt: isoDayOrNull(defect.dueAt), fixedAt: isoDayOrNull(defect.fixedAt) }));
}

/** True cuando todos los defectos tienen fixedAt (una lista vacía cuenta como subsanada: el cierre exige entonces correctedAt). */
export function allDefectsFixed(defects: ReadonlyArray<RealEstateInspectionDefect> | null | undefined): boolean {
  return (defects ?? []).every((defect) => Boolean(defect.fixedAt));
}

/** Plazo de subsanación derivado: el primer `dueAt` de los defectos sin subsanar (null si no hay). */
export function earliestOpenDefectDue(defects: ReadonlyArray<RealEstateInspectionDefect> | null | undefined): IsoDay | null {
  let earliest: IsoDay | null = null;
  for (const defect of defects ?? []) {
    if (defect.fixedAt || !defect.dueAt) continue;
    if (earliest === null || defect.dueAt < earliest) earliest = defect.dueAt;
  }
  return earliest;
}

/** Fecha de subsanación derivada: el último `fixedAt` (null si alguno falta o no hay defectos). */
export function latestDefectFixedAt(defects: ReadonlyArray<RealEstateInspectionDefect> | null | undefined): IsoDay | null {
  if (!defects || defects.length === 0 || !allDefectsFixed(defects)) return null;
  return defects.reduce<IsoDay | null>((latest, defect) => (latest === null || (defect.fixedAt as IsoDay) > latest ? (defect.fixedAt as IsoDay) : latest), null);
}

// ---------------------------------------------------------------------------
// Planificación pura del PATCH (acta · defectos · subsanación · estado)
// ---------------------------------------------------------------------------

const DEFECT_RESULTS: ReadonlySet<string> = new Set(["condicionada", "negativa"]);

export type InspectionSnapshot = {
  status: string;
  performedAt: IsoDay | null;
  result: string | null;
  defects: RealEstateInspectionDefect[] | null;
  correctionDueAt: IsoDay | null;
  correctedAt: IsoDay | null;
  nextDueAt: IsoDay | null;
  scheduledAt: IsoDay | null;
  periodicityMonths: number | null;
};

export type InspectionPatch = Partial<{
  performedAt: IsoDay | null;
  result: RealEstateInspectionResult | null;
  defects: RealEstateInspectionDefect[] | null;
  correctionDueAt: IsoDay | null;
  correctedAt: IsoDay | null;
  nextDueAt: IsoDay | null;
  scheduledAt: IsoDay | null;
  periodicityMonths: number | null;
  status: RealEstateInspectionStatus;
}>;

export type InspectionPlan = {
  /** Valores resultantes (fusión + derivados). */
  next: InspectionSnapshot;
  /** Transición aplicada (null si el estado no cambia). */
  transition: { from: string; to: RealEstateInspectionStatus } | null;
  /** True cuando toca crear la siguiente `programada` (acta favorable o subsanación completa) con scheduledAt = next.nextDueAt. */
  successor: boolean;
};

function invalid(message: string, current: InspectionSnapshot, to: string, extra: Record<string, unknown> = {}): never {
  throw realEstateError(409, "INSPECTION_INVALID_TRANSITION", message, { machine: "INSPECTION", from: current.status, to, allowed: nextStates("INSPECTION", current.status), ...extra });
}

/**
 * Fusiona la fila con el PATCH y decide la transición (§5.1):
 *   · `cerrada` es final: cualquier cambio → 409.
 *   · acta = performedAt + result (los dos): desde `programada`, favorable →
 *     `realizada`, condicionada | negativa → `con_defectos`; `pendiente` deja
 *     la inspección `programada` con la fecha anotada.
 *   · subsanación: desde `con_defectos`, todos los defectos con fixedAt (o
 *     correctedAt cuando no hay lista) → `cerrada`; correctedAt se deriva del
 *     último fixedAt si no viene.
 *   · `status` explícito: se valida contra la máquina INSPECTION y contra los
 *     requisitos anteriores (409 INSPECTION_INVALID_TRANSITION).
 *   · nextDueAt = performedAt + periodicityMonths cuando el acta (o la
 *     periodicidad) cambia y el cuerpo no lo fija.
 */
export function planInspectionPatch(current: InspectionSnapshot, patch: InspectionPatch, today: IsoDay): InspectionPlan {
  if (current.status === "cerrada") invalid("La inspección está cerrada y no admite cambios.", current, patch.status ?? "cerrada");

  const { status: explicit, ...fields } = patch;
  const merged: InspectionSnapshot = { ...current, ...definedFields(fields) };

  // Coherencia del resultado con el estado en curso (una acta registrada no cambia de rama).
  if (fields.result !== undefined && current.status === "realizada" && merged.result !== "favorable") {
    invalid("Una inspección realizada (favorable) no puede pasar a un resultado con defectos: registra una inspección nueva.", current, "con_defectos");
  }
  if (fields.result !== undefined && current.status === "con_defectos" && !DEFECT_RESULTS.has(merged.result ?? "")) {
    invalid("Una inspección con defectos solo admite resultado condicionada o negativa.", current, "realizada");
  }

  // nextDueAt por periodicidad cuando cambia el acta o la periodicidad y el cuerpo no lo fija.
  if (fields.nextDueAt === undefined && (fields.performedAt !== undefined || fields.periodicityMonths !== undefined) && merged.performedAt) {
    merged.nextDueAt = computeNextDueAt(merged.performedAt, merged.periodicityMonths) ?? merged.nextDueAt;
  }

  // Plazo de subsanación derivado de los defectos cuando el cuerpo no lo fija.
  if (fields.defects !== undefined && fields.correctionDueAt === undefined) {
    merged.correctionDueAt = earliestOpenDefectDue(merged.defects) ?? merged.correctionDueAt;
  }

  const actaComplete = Boolean(merged.performedAt && merged.result && merged.result !== "pendiente");
  const actaTouched = fields.performedAt !== undefined || fields.result !== undefined;
  const defectsTouched = fields.defects !== undefined || fields.correctedAt !== undefined;
  const fixed = allDefectsFixed(merged.defects) && ((merged.defects?.length ?? 0) > 0 || Boolean(merged.correctedAt));

  let inferred: RealEstateInspectionStatus | null = null;
  if (current.status === "programada" && actaTouched && actaComplete) inferred = merged.result === "favorable" ? "realizada" : "con_defectos";
  else if (current.status === "con_defectos" && defectsTouched && fixed) inferred = "cerrada";

  const target = explicit ?? inferred ?? (current.status as RealEstateInspectionStatus);
  if (explicit && inferred && explicit !== inferred && explicit !== current.status) {
    invalid(`El estado ${explicit} no coincide con el acta registrada (${merged.result}).`, current, explicit);
  }

  let transition: InspectionPlan["transition"] = null;
  let successor = false;
  if (target !== current.status) {
    assertTransition("INSPECTION", current.status, target);
    if (target === "realizada" || target === "con_defectos") {
      if (!actaComplete) invalid("Registrar el acta exige performedAt y result (favorable, condicionada o negativa).", current, target);
      if (target === "realizada" && merged.result !== "favorable") invalid("Solo un acta favorable deja la inspección realizada.", current, target);
      if (target === "con_defectos" && !DEFECT_RESULTS.has(merged.result ?? "")) invalid("Una inspección con defectos exige resultado condicionada o negativa.", current, target);
    }
    if (target === "cerrada" && current.status === "con_defectos") {
      if (!fixed) invalid("No se puede cerrar: quedan defectos sin fixedAt (o falta correctedAt cuando no hay lista de defectos).", current, target, { openDefects: (merged.defects ?? []).filter((defect) => !defect.fixedAt).length });
      if (!merged.correctedAt) merged.correctedAt = latestDefectFixedAt(merged.defects) ?? today;
    }
    transition = { from: current.status, to: target };
    successor = target === "realizada" || (target === "cerrada" && current.status === "con_defectos");
  }

  merged.status = target;
  return { next: merged, transition, successor };
}

// ---------------------------------------------------------------------------
// Mapeador fila → DTO
// ---------------------------------------------------------------------------

/** Fecha de referencia del plazo: scheduledAt (o nextDueAt) mientras está programada; nextDueAt después. Misma regla que alerts.pure.ts. */
export function inspectionDueDate(row: { status: string; scheduledAt: IsoDay | null; nextDueAt: IsoDay | null }): IsoDay | null {
  return row.status === "programada" ? (row.scheduledAt ?? row.nextDueAt) : row.nextDueAt;
}

export function toRealEstateInspectionRecord(row: RealEstateInspection, today: IsoDay): RealEstateInspectionRecord {
  const scheduledAt = isoDayOrNull(row.scheduledAt);
  const nextDueAt = isoDayOrNull(row.nextDueAt);
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    assetId: row.assetId,
    kind: row.kind as RealEstateInspectionKind,
    legalBasis: row.legalBasis ?? null,
    periodicityMonths: row.periodicityMonths ?? null,
    installationRef: row.installationRef ?? null,
    technicalAssetId: row.technicalAssetId ?? null,
    providerName: row.providerName ?? null,
    supplierId: row.supplierId ?? null,
    scheduledAt,
    performedAt: isoDayOrNull(row.performedAt),
    result: (row.result ?? null) as RealEstateInspectionResult | null,
    defectsJson: parseDefects(row.defectsJson),
    correctionDueAt: isoDayOrNull(row.correctionDueAt),
    correctedAt: isoDayOrNull(row.correctedAt),
    nextDueAt,
    documentId: row.documentId ?? null,
    complianceRequirementCode: row.complianceRequirementCode ?? null,
    status: row.status as RealEstateInspectionStatus,
    dueState: inspectionDueState({ nextDueAt: inspectionDueDate({ status: row.status, scheduledAt, nextDueAt }) }, today).state,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function snapshotOf(row: RealEstateInspection): InspectionSnapshot {
  return {
    status: row.status,
    performedAt: isoDayOrNull(row.performedAt),
    result: row.result ?? null,
    defects: parseDefects(row.defectsJson),
    correctionDueAt: isoDayOrNull(row.correctionDueAt),
    correctedAt: isoDayOrNull(row.correctedAt),
    nextDueAt: isoDayOrNull(row.nextDueAt),
    scheduledAt: isoDayOrNull(row.scheduledAt),
    periodicityMonths: row.periodicityMonths ?? null
  };
}

const dayOrNull = (value: IsoDay | null): Date | null => (value ? utcDay(value) : null);
const jsonDefects = (defects: RealEstateInspectionDefect[] | null): Prisma.InputJsonValue | typeof Prisma.JsonNull => (defects === null ? Prisma.JsonNull : (defects as unknown as Prisma.InputJsonValue));

const AUDIT_FIELDS = ["kind", "legalBasis", "periodicityMonths", "installationRef", "technicalAssetId", "supplierId", "scheduledAt", "performedAt", "result", "defectsJson", "correctionDueAt", "correctedAt", "nextDueAt", "documentId", "complianceRequirementCode", "status"] as const satisfies ReadonlyArray<keyof RealEstateInspectionRecord>;

/** Proyección auditable: sin proveedor (nombre libre) ni notas. */
function auditProjection(record: RealEstateInspectionRecord, keys: ReadonlyArray<keyof RealEstateInspectionRecord> = AUDIT_FIELDS): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key !== "providerName" && key !== "notes").map((key) => [key, record[key] ?? null]));
}

async function requireInspection(db: Db, assetId: string, inspectionId: string): Promise<RealEstateInspection> {
  const row = await db.realEstateInspection.findFirst({ where: { id: inspectionId, assetId } });
  if (!row) throw new NotFoundError("Inspección no encontrada.");
  return row;
}

// ---------------------------------------------------------------------------
// Sincronización opcional con el centro de cumplimiento (ComplianceItem)
// ---------------------------------------------------------------------------

type ComplianceSync = { code: string; propertyId: string; issueDate: IsoDay | null; expiryDate: IsoDay | null; status: "COMPLIANT" | "NON_COMPLIANT" | null };

/**
 * Upsert del ComplianceItem del centro por `requirementCode` cuando el código
 * existe en el catálogo (sin FK: un código desconocido se guarda en la
 * inspección y no sincroniza nada). Devuelve true si escribió.
 */
export async function syncComplianceItem(db: Db, sync: ComplianceSync): Promise<boolean> {
  const requirement = await db.complianceRequirement.findUnique({ where: { code: sync.code }, select: { code: true, defaultApplies: true } });
  if (!requirement) return false;
  const where = { propertyId_requirementCode: { propertyId: sync.propertyId, requirementCode: requirement.code } };
  const existing = await db.complianceItem.findUnique({ where, select: { applies: true, status: true } });
  const update: Prisma.ComplianceItemUpdateInput = {};
  if (sync.issueDate) update.issueDate = utcDay(sync.issueDate);
  if (sync.expiryDate !== null) update.expiryDate = utcDay(sync.expiryDate);
  if (sync.status) update.status = sync.status;
  await db.complianceItem.upsert({
    where,
    create: {
      propertyId: sync.propertyId,
      requirementCode: requirement.code,
      applies: existing?.applies ?? requirement.defaultApplies,
      status: sync.status ?? "UNDER_REVIEW",
      issueDate: sync.issueDate ? utcDay(sync.issueDate) : null,
      expiryDate: sync.expiryDate ? utcDay(sync.expiryDate) : null
    },
    update
  });
  return true;
}

function complianceStatusFor(status: string): ComplianceSync["status"] {
  if (status === "realizada" || status === "cerrada") return "COMPLIANT";
  if (status === "con_defectos") return "NON_COMPLIANT";
  return null;
}

// ---------------------------------------------------------------------------
// GET · POST …/inspections
// ---------------------------------------------------------------------------

export async function listRealEstateInspections(propertyId: string, query: unknown = {}, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateInspectionRecord[]> {
  const filter: RealEstateInspectionListQueryInput = parseOr400(RealEstateInspectionListQuerySchema, query ?? {}, "Filtro");
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const rows = await prisma.realEstateInspection.findMany({
    where: { assetId: asset.id, ...(filter.status ? { status: filter.status } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
    orderBy: [{ nextDueAt: "asc" }, { scheduledAt: "asc" }, { createdAt: "asc" }]
  });
  return rows.map((row) => toRealEstateInspectionRecord(row, today));
}

export async function createRealEstateInspection(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateInspectionRecord> {
  const data = applyInspectionDefaults(parseOr400(RealEstateInspectionCreateSchema, input.body ?? {}, "Inspección"));
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  const row = await prisma.realEstateInspection.create({
    data: { ...data, organizationId: asset.organizationId, propertyId: input.propertyId, assetId: asset.id, status: "programada" }
  });
  const record = toRealEstateInspectionRecord(row, toIsoDay(new Date()));
  recordAuditEvent({
    organizationId: asset.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_INSPECTION_CREATED",
    entityType: "real_estate_inspection",
    entityId: row.id,
    afterJson: { assetId: asset.id, ...auditProjection(record) },
    correlationId: input.correlationId
  });
  return record;
}

// ---------------------------------------------------------------------------
// PATCH …/inspections/:inspectionId — campos, acta, defectos, subsanación, estado
// ---------------------------------------------------------------------------

export async function updateRealEstateInspection(input: RealEstateCommandInput & { inspectionId: string; body: unknown }): Promise<RealEstateInspectionRecord> {
  const data = parseOr400(RealEstateInspectionPatchSchema, input.body ?? {}, "Inspección");
  const today = toIsoDay(new Date());
  const { performedAt, result, defectsJson, correctionDueAt, correctedAt, nextDueAt, scheduledAt, periodicityMonths, status, ...plain } = data;
  const plainFields = definedFields(plain);
  const patch: InspectionPatch = definedFields({
    performedAt: performedAt === undefined ? undefined : isoDayOrNull(performedAt),
    result: result === undefined ? undefined : (result ?? null),
    defects: defectsFromInput(defectsJson),
    correctionDueAt: correctionDueAt === undefined ? undefined : isoDayOrNull(correctionDueAt),
    correctedAt: correctedAt === undefined ? undefined : isoDayOrNull(correctedAt),
    nextDueAt: nextDueAt === undefined ? undefined : isoDayOrNull(nextDueAt),
    scheduledAt: scheduledAt === undefined ? undefined : isoDayOrNull(scheduledAt),
    periodicityMonths: periodicityMonths === undefined ? undefined : (periodicityMonths ?? null),
    status
  });

  const outcome = await prisma.$transaction(async (tx) => {
    const asset = await requireRealEstateAsset(tx, input.propertyId);
    const before = await requireInspection(tx, asset.id, input.inspectionId);
    const plan = planInspectionPatch(snapshotOf(before), patch, today);
    const { next } = plan;

    const after = await tx.realEstateInspection.update({
      where: { id: before.id },
      data: {
        ...plainFields,
        performedAt: dayOrNull(next.performedAt),
        result: next.result,
        defectsJson: jsonDefects(next.defects),
        correctionDueAt: dayOrNull(next.correctionDueAt),
        correctedAt: dayOrNull(next.correctedAt),
        nextDueAt: dayOrNull(next.nextDueAt),
        scheduledAt: dayOrNull(next.scheduledAt),
        periodicityMonths: next.periodicityMonths,
        status: next.status
      }
    });

    // Siguiente programada (acta favorable o subsanación completa) con scheduledAt = nextDueAt; idempotente por (kind, instalación, fecha).
    let successor: RealEstateInspection | null = null;
    if (plan.successor && next.nextDueAt) {
      const scheduled = utcDay(next.nextDueAt);
      const existing = await tx.realEstateInspection.findFirst({ where: { assetId: asset.id, kind: after.kind, installationRef: after.installationRef, status: "programada", scheduledAt: scheduled }, select: { id: true } });
      if (!existing) {
        successor = await tx.realEstateInspection.create({
          data: {
            organizationId: after.organizationId,
            propertyId: after.propertyId,
            assetId: after.assetId,
            kind: after.kind,
            legalBasis: after.legalBasis,
            periodicityMonths: after.periodicityMonths,
            installationRef: after.installationRef,
            technicalAssetId: after.technicalAssetId,
            providerName: after.providerName,
            supplierId: after.supplierId,
            scheduledAt: scheduled,
            nextDueAt: scheduled,
            complianceRequirementCode: after.complianceRequirementCode,
            status: "programada"
          }
        });
      }
    }

    // Centro de cumplimiento: en cada transición, o cuando cambia el plazo de una inspección ya realizada.
    let complianceSynced = false;
    const dueChanged = next.nextDueAt !== isoDayOrNull(before.nextDueAt) || next.performedAt !== isoDayOrNull(before.performedAt);
    if (after.complianceRequirementCode && (plan.transition || (dueChanged && after.status !== "programada"))) {
      complianceSynced = await syncComplianceItem(tx, {
        code: after.complianceRequirementCode,
        propertyId: after.propertyId,
        issueDate: next.performedAt,
        expiryDate: next.nextDueAt,
        status: plan.transition ? complianceStatusFor(next.status) : null
      });
    }

    return { asset, before, after, successor, transition: plan.transition, complianceSynced };
  });

  const beforeRecord = toRealEstateInspectionRecord(outcome.before, today);
  const afterRecord = toRealEstateInspectionRecord(outcome.after, today);
  // Claves auditadas: las enviadas (los defectos viajan como `defectsJson`) más las derivadas que hayan cambiado.
  const changedKeys = new Set<string>([...Object.keys(plainFields), ...Object.keys(patch).filter((key) => key !== "defects")]);
  if (patch.defects !== undefined) changedKeys.add("defectsJson");
  for (const key of ["status", "nextDueAt", "correctionDueAt", "correctedAt"] as const) if (beforeRecord[key] !== afterRecord[key]) changedKeys.add(key);
  const keys = AUDIT_FIELDS.filter((key) => changedKeys.has(key));
  const base = { organizationId: outcome.asset.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user" as const, entityType: "real_estate_inspection", entityId: outcome.after.id, correlationId: input.correlationId };
  const action = outcome.transition?.to === "cerrada" ? "REAL_ESTATE_INSPECTION_CLOSED" : outcome.transition ? "REAL_ESTATE_INSPECTION_ACTA_RECORDED" : "REAL_ESTATE_INSPECTION_UPDATED";
  recordAuditEvent({
    ...base,
    action,
    beforeJson: auditProjection(beforeRecord, keys),
    afterJson: { ...auditProjection(afterRecord, keys), ...(outcome.transition ? { transition: outcome.transition } : {}), complianceSynced: outcome.complianceSynced, successorId: outcome.successor?.id ?? null }
  });
  if (outcome.successor) {
    recordAuditEvent({ ...base, entityId: outcome.successor.id, action: "REAL_ESTATE_INSPECTION_CREATED", afterJson: { assetId: outcome.asset.id, successorOf: outcome.after.id, ...auditProjection(toRealEstateInspectionRecord(outcome.successor, today)) } });
  }
  return afterRecord;
}
