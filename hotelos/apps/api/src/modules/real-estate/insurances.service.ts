// Activo inmobiliario · pólizas de seguro (Tanda ACT · L5, diseño §4
// `RealEstateInsurance`): RC, multirriesgo, pérdida de beneficios, decenal,
// todo riesgo construcción u otra, con vigencia validFrom / validUntil,
// renovación automática (autoRenew) y preaviso (noticeDays, 60 por defecto).
//
// El estado se DERIVA en cada lectura (`deriveInsuranceStatus`): `cancelada`
// si se canceló; `vencida` cuando validUntil ya pasó (aunque autoRenew esté
// activo: la renovación se registra ampliando validUntil); `vigente` en otro
// caso. `vencida` nunca se persiste (400 si el cuerpo lo envía). El aviso de
// vencimiento («vence pronto», noticeDays antes) lo emite el motor de alertas
// (INSURANCE_EXPIRING media ≤ 30 días · baja ≤ 90 · alta vencida) y
// `insuranceExpiresSoon` lo expone para el front. El registro y la
// contabilización de la prima (625) siguen en payables.

import { prisma } from "@hotelos/database";
import type { Prisma, RealEstateInsurance } from "@prisma/client";
import type { IsoDay, RealEstateInsuranceKind, RealEstateInsuranceRecord, RealEstateInsuranceStatus, RealEstatePolicyholder } from "@hotelos/shared";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { RealEstateInsuranceCreateSchema, RealEstateInsurancePatchSchema } from "../../schemas/real-estate.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { dayOf } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { definedFields, isoDayOrNull, moneyOrNull, requireRealEstateAsset, type RealEstateCommandInput } from "./real-estate.service.js";
import { daysBetween, toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

/** Días de preaviso por defecto (diseño §4: 60). */
export const DEFAULT_INSURANCE_NOTICE_DAYS = 60;

// ---------------------------------------------------------------------------
// Derivados puros
// ---------------------------------------------------------------------------

/** cancelada (persistida) · vencida (validUntil < hoy) · vigente. */
export function deriveInsuranceStatus(insurance: { status: string; validUntil: IsoDay }, today: IsoDay): RealEstateInsuranceStatus {
  if (insurance.status === "cancelada") return "cancelada";
  if (daysBetween(today, insurance.validUntil) < 0) return "vencida";
  return "vigente";
}

/** True cuando la póliza está vigente y vence dentro de `noticeDays` días (inclusive). */
export function insuranceExpiresSoon(insurance: { status: string; validUntil: IsoDay; noticeDays: number | null | undefined }, today: IsoDay): boolean {
  if (deriveInsuranceStatus(insurance, today) !== "vigente") return false;
  return daysBetween(today, insurance.validUntil) <= Math.max(0, insurance.noticeDays ?? DEFAULT_INSURANCE_NOTICE_DAYS);
}

export function toRealEstateInsuranceRecord(row: RealEstateInsurance, today: IsoDay): RealEstateInsuranceRecord {
  const validUntil = dayOf(row.validUntil) as IsoDay;
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    assetId: row.assetId,
    kind: row.kind as RealEstateInsuranceKind,
    insurerName: row.insurerName,
    policyNumber: row.policyNumber,
    brokerName: row.brokerName ?? null,
    policyholder: row.policyholder as RealEstatePolicyholder,
    insuredSum: moneyOrNull(row.insuredSum),
    deductible: moneyOrNull(row.deductible),
    premiumAnnual: moneyOrNull(row.premiumAnnual),
    validFrom: dayOf(row.validFrom) as IsoDay,
    validUntil,
    autoRenew: row.autoRenew,
    noticeDays: row.noticeDays,
    mandatoryBasis: row.mandatoryBasis ?? null,
    documentId: row.documentId ?? null,
    status: deriveInsuranceStatus({ status: row.status, validUntil }, today),
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

const AUDIT_FIELDS = ["kind", "insurerName", "policyNumber", "policyholder", "insuredSum", "deductible", "premiumAnnual", "validFrom", "validUntil", "autoRenew", "noticeDays", "mandatoryBasis", "documentId", "status"] as const satisfies ReadonlyArray<keyof RealEstateInsuranceRecord>;

/** Proyección auditable: sin corredor ni notas libres. */
function auditProjection(record: RealEstateInsuranceRecord, keys: ReadonlyArray<keyof RealEstateInsuranceRecord> = AUDIT_FIELDS): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key !== "brokerName" && key !== "notes").map((key) => [key, record[key] ?? null]));
}

async function requireInsurance(db: Db, assetId: string, insuranceId: string): Promise<RealEstateInsurance> {
  const row = await db.realEstateInsurance.findFirst({ where: { id: insuranceId, assetId } });
  if (!row) throw new NotFoundError("Póliza no encontrada.");
  return row;
}

// ---------------------------------------------------------------------------
// GET · POST …/insurances
// ---------------------------------------------------------------------------

export async function listRealEstateInsurances(propertyId: string, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateInsuranceRecord[]> {
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const rows = await prisma.realEstateInsurance.findMany({ where: { assetId: asset.id }, orderBy: [{ validUntil: "asc" }, { createdAt: "asc" }] });
  return rows.map((row) => toRealEstateInsuranceRecord(row, today));
}

export async function createRealEstateInsurance(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateInsuranceRecord> {
  const data = parseOr400(RealEstateInsuranceCreateSchema, input.body ?? {}, "Póliza");
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  const row = await prisma.realEstateInsurance.create({
    data: { ...data, organizationId: asset.organizationId, propertyId: input.propertyId, assetId: asset.id, status: "vigente" }
  });
  const record = toRealEstateInsuranceRecord(row, toIsoDay(new Date()));
  recordAuditEvent({
    organizationId: asset.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_INSURANCE_CREATED",
    entityType: "real_estate_insurance",
    entityId: row.id,
    afterJson: { assetId: asset.id, ...auditProjection(record) },
    correlationId: input.correlationId
  });
  return record;
}

// ---------------------------------------------------------------------------
// PATCH …/insurances/:insuranceId — campos y/o estado (vigente · cancelada)
// ---------------------------------------------------------------------------

export async function updateRealEstateInsurance(input: RealEstateCommandInput & { insuranceId: string; body: unknown }): Promise<RealEstateInsuranceRecord> {
  // ACT-REV-17: `vencida` ya no está en el esquema del PATCH (REAL_ESTATE_INSURANCE_PATCH_STATUSES): zod responde 400
  // «status debe ser uno de: vigente, cancelada» antes de llegar aquí; renovar = ampliar validUntil.
  const data = parseOr400(RealEstateInsurancePatchSchema, input.body ?? {}, "Póliza");
  const fields = definedFields(data);
  const today = toIsoDay(new Date());

  const outcome = await prisma.$transaction(async (tx) => {
    const asset = await requireRealEstateAsset(tx, input.propertyId);
    const before = await requireInsurance(tx, asset.id, input.insuranceId);
    const validFrom = fields.validFrom ?? before.validFrom;
    const validUntil = fields.validUntil ?? before.validUntil;
    if (validUntil.getTime() < validFrom.getTime()) {
      const error = new BadRequestError("Póliza no válida: validUntil no puede ser anterior a validFrom.");
      error.details = { code: "VALIDATION_ERROR", issues: [{ path: "validUntil", message: "validUntil no puede ser anterior a validFrom." }] };
      throw error;
    }
    const after = await tx.realEstateInsurance.update({ where: { id: before.id }, data: fields });
    return { asset, before, after };
  });

  const beforeRecord = toRealEstateInsuranceRecord(outcome.before, today);
  const afterRecord = toRealEstateInsuranceRecord(outcome.after, today);
  const changed = new Set(Object.keys(fields) as Array<keyof RealEstateInsuranceRecord>);
  if (beforeRecord.status !== afterRecord.status) changed.add("status");
  const keys = AUDIT_FIELDS.filter((key) => changed.has(key));
  recordAuditEvent({
    organizationId: outcome.asset.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: outcome.before.status !== "cancelada" && outcome.after.status === "cancelada" ? "REAL_ESTATE_INSURANCE_CANCELLED" : "REAL_ESTATE_INSURANCE_UPDATED",
    entityType: "real_estate_insurance",
    entityId: outcome.after.id,
    beforeJson: auditProjection(beforeRecord, keys),
    afterJson: auditProjection(afterRecord, keys),
    correlationId: input.correlationId
  });
  return afterRecord;
}
