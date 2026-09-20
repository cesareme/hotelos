import { prisma } from "@hotelos/database";
import { HR_END_REASONS } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { bumpRbacVersion } from "../../lib/rbac-scope.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { payCountFromRules, resolveAgreementForProperty } from "../hr/agreements.service.js";
import { checkStaffingHeadroom } from "../hr/staffing.service.js";
import { hrBadRequest, hrNotFound } from "../hr/hr-errors.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { PAYROLL_WRITE_KEYS, requireAnyPermission } from "../treasury/permissions.js";

// Tanda RRHH (RRHH-2, design §4 «EmploymentContract»): the contract carries the
// collective agreement (`agreementId`, prevails over Property.agreementId), the
// weekly hours, the part-time percentage (100 = full time), the fixed-discontinuous
// flag, the contribution group (1-11) and, once ended, the end reason. `payCount`
// defaults to 12 + `extra_pay_count` of the applicable agreement (contract > work
// centre); without an agreement the historical 14 stays. The agreement resolver is
// injectable (`ContractDeps`) for the unit tests.

// Tanda 8a (RBAC · L2, design §6.6 «baja inmediata»): deactivating a contract
// (payroll.manage) is the HR hook that ends the person's access — every live
// role assignment of the linked user (StaffProfile.userId) gets
// `validTo = now` through the rbac deps of L1 (assignments.service), one
// ROLE_REVOKED audit event per assignment with reason "baja", and the
// organisation's rbacVersion is bumped so live sessions re-read their scope.
// The caller-rank rule of revokeAssignment does not apply: the baja is an HR
// event, not a role decision, and it is fully audited.

// ---- Sprint 23 / Track 5 — Payroll bridge a gestoría ----
//
// EmploymentContract is the source of truth for what an employee earns each
// month. The PayrollPeriod calculation reads every `active` contract that
// belongs to the org (and property, if scoped) and emits one PayrollSlip per
// contract. We deliberately keep the shape close to the Prisma row — the only
// transformation is Decimal → number so the HTTP/JSON boundary is clean.
//
// Sharp edge: `payCount` (12 + extra pays of the agreement in Spain — the famous
// "pagas extras") is stored but NOT factored into the monthly slip yet. Sprint 24
// will add the extra-payment proration. For now we just compute the simple monthly gross.

export type EmploymentContractRecord = {
  id: string;
  staffProfileId: string;
  propertyId?: string;
  organizationId: string;
  contractType: string;
  startDate: string;
  endDate?: string;
  grossSalary: number;
  payFrequency: string;
  payCount: number;
  irpfRatePct?: number;
  socialSecurityCategory?: string;
  costCenterId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  // Tanda RRHH (RRHH-2).
  agreementId?: string;
  weeklyHours?: number;
  partTimePct?: number;
  fixedDiscontinuous: boolean;
  contributionGroup?: number;
  endReason?: string;
  /**
   * Avisos del alta (nunca bloquean; corrector RRHH · RF-05 / RF-07): position control
   * HR_STAFFING_EXCEEDED (D §6.3: el departamento supera la maxFte del plan aprobado) y
   * segundo contrato activo sobre la misma ficha (el headcount cuenta personas, no contratos).
   */
  warnings?: string[];
};

export type ContractDeps = {
  resolveAgreement: typeof resolveAgreementForProperty;
  /** Position control (staffing.service): activos + alta prevista frente al plan aprobado del centro. */
  checkHeadroom: typeof checkStaffingHeadroom;
};

export const defaultContractDeps: ContractDeps = { resolveAgreement: resolveAgreementForProperty, checkHeadroom: checkStaffingHeadroom };
export const CONTRACT_ALREADY_ACTIVE_WARNING = "La ficha ya tiene otro contrato activo: la plantilla cuenta a la persona una vez, pero el FTE suma los dos contratos.";

export const CONTRACT_WEEKLY_HOURS_MAX = 60;
export const CONTRIBUTION_GROUP_MIN = 1;
export const CONTRIBUTION_GROUP_MAX = 11;

function isoDate(d: Date | null | undefined): string | undefined {
  if (!d) return undefined;
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Date(`${iso}T00:00:00.000Z`);
  }
  return new Date(iso);
}

function decimalToNumber(d: unknown): number {
  if (d === null || d === undefined) return 0;
  if (typeof d === "number") return d;
  return Number(d);
}

function mapContract(
  row: NonNullable<Awaited<ReturnType<typeof prisma.employmentContract.findUnique>>>
): EmploymentContractRecord {
  return {
    id: row.id,
    staffProfileId: row.staffProfileId,
    propertyId: row.propertyId ?? undefined,
    organizationId: row.organizationId,
    contractType: row.contractType,
    startDate: isoDate(row.startDate) ?? "",
    endDate: isoDate(row.endDate),
    grossSalary: decimalToNumber(row.grossSalary),
    payFrequency: row.payFrequency,
    payCount: row.payCount,
    irpfRatePct: row.irpfRatePct === null || row.irpfRatePct === undefined ? undefined : decimalToNumber(row.irpfRatePct),
    socialSecurityCategory: row.socialSecurityCategory ?? undefined,
    costCenterId: row.costCenterId ?? undefined,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    agreementId: row.agreementId ?? undefined,
    weeklyHours: row.weeklyHours === null || row.weeklyHours === undefined ? undefined : decimalToNumber(row.weeklyHours),
    partTimePct: row.partTimePct === null || row.partTimePct === undefined ? undefined : decimalToNumber(row.partTimePct),
    fixedDiscontinuous: row.fixedDiscontinuous,
    contributionGroup: row.contributionGroup ?? undefined,
    endReason: row.endReason ?? undefined
  };
}

function optionalNumber(value: number | undefined, field: string, check: (n: number) => boolean, message: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !check(value)) throw hrBadRequest("VALIDATION_ERROR", { field, message });
  return value;
}

export async function listContracts(
  organizationId: string,
  propertyId?: string
): Promise<EmploymentContractRecord[]> {
  const rows = await prisma.employmentContract.findMany({
    where: {
      organizationId,
      ...(propertyId ? { propertyId } : {})
    },
    orderBy: [{ active: "desc" }, { startDate: "desc" }]
  });
  return rows.map(mapContract);
}

export async function createContract(input: {
  context: UserContext;
  staffProfileId: string;
  propertyId?: string;
  contractType: string;
  startDate: string;
  endDate?: string;
  grossSalary: number;
  payFrequency?: string;
  payCount?: number;
  irpfRatePct?: number;
  socialSecurityCategory?: string;
  costCenterId?: string;
  correlationId: string;
  // Tanda RRHH (RRHH-2).
  agreementId?: string;
  weeklyHours?: number;
  partTimePct?: number;
  fixedDiscontinuous?: boolean;
  contributionGroup?: number;
}, deps: ContractDeps = defaultContractDeps): Promise<EmploymentContractRecord> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);

  if (!Number.isFinite(input.grossSalary) || input.grossSalary < 0) {
    throw new Error("grossSalary must be a non-negative number.");
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw new Error("endDate must be on or after startDate.");
  }
  const weeklyHours = optionalNumber(input.weeklyHours, "weeklyHours", (n) => n > 0 && n <= CONTRACT_WEEKLY_HOURS_MAX, `weeklyHours debe estar entre 0 y ${CONTRACT_WEEKLY_HOURS_MAX} horas.`);
  const partTimePct = optionalNumber(input.partTimePct, "partTimePct", (n) => n > 0 && n <= 100, "partTimePct debe estar entre 0 y 100.");
  const contributionGroup = optionalNumber(input.contributionGroup, "contributionGroup", (n) => Number.isInteger(n) && n >= CONTRIBUTION_GROUP_MIN && n <= CONTRIBUTION_GROUP_MAX, `contributionGroup debe ser un entero entre ${CONTRIBUTION_GROUP_MIN} y ${CONTRIBUTION_GROUP_MAX}.`);
  const fixedDiscontinuous = input.fixedDiscontinuous ?? input.contractType === "fijo_discontinuo";

  // Convenio: el del contrato (de la organización, si no 404 opaco) o el del centro de la ficha.
  const profile = await prisma.staffProfile.findUnique({ where: { id: input.staffProfileId }, select: { propertyId: true, usaliDepartment: true } });
  const propertyId = input.propertyId ?? profile?.propertyId ?? null;
  const resolved = await deps.resolveAgreement({ organizationId: input.context.organizationId, propertyId, contractAgreementId: input.agreementId ?? null, asOf: input.startDate });
  if (input.agreementId && resolved.source !== "contract") throw hrNotFound("HR_AGREEMENT_NOT_FOUND");
  const payCount = input.payCount ?? payCountFromRules(resolved.rules);

  const created = await prisma.employmentContract.create({
    data: {
      staffProfileId: input.staffProfileId,
      propertyId: input.propertyId ?? null,
      organizationId: input.context.organizationId,
      contractType: input.contractType,
      startDate: dateOnly(input.startDate),
      endDate: input.endDate ? dateOnly(input.endDate) : null,
      grossSalary: input.grossSalary,
      payFrequency: input.payFrequency ?? "monthly",
      payCount,
      irpfRatePct: input.irpfRatePct ?? null,
      socialSecurityCategory: input.socialSecurityCategory ?? null,
      costCenterId: input.costCenterId ?? null,
      active: true,
      agreementId: input.agreementId ?? null,
      weeklyHours,
      partTimePct,
      fixedDiscontinuous,
      contributionGroup
    }
  });

  const record = mapContract(created);

  // Avisos (RF-05 / RF-07): position control contra el plan aprobado del centro y segundo contrato activo de la ficha.
  const warnings: string[] = [];
  const headroomPropertyId = profile?.propertyId ?? propertyId;
  if (headroomPropertyId && profile?.usaliDepartment) {
    try {
      const headroom = await deps.checkHeadroom({ propertyId: headroomPropertyId, usaliDepartment: profile.usaliDepartment, date: input.startDate, extraFte: 0 });
      warnings.push(...headroom.warnings);
    } catch {
      // Un departamento no USALI o un plan ilegible no bloquea el alta: el aviso simplemente no se emite.
    }
  }
  const otherActive = await prisma.employmentContract.count({ where: { staffProfileId: input.staffProfileId, active: true, id: { not: created.id } } });
  if (otherActive > 0) warnings.push(CONTRACT_ALREADY_ACTIVE_WARNING);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "EMPLOYMENT_CONTRACT_CREATED",
    entityType: "employment_contract",
    entityId: record.id,
    afterJson: { ...record, warnings },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId ?? "",
    entityType: "employment_contract",
    entityId: record.id,
    eventType: "EmploymentContractCreated",
    payload: {
      staffProfileId: record.staffProfileId,
      contractType: record.contractType,
      grossSalary: record.grossSalary,
      irpfRatePct: record.irpfRatePct ?? null,
      agreementId: record.agreementId ?? null,
      payCount: record.payCount,
      fixedDiscontinuous: record.fixedDiscontinuous
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return { ...record, warnings };
}

/**
 * Ends every live role assignment of `userId` (validTo = now, reason "baja"),
 * one ROLE_REVOKED event each; returns the ids revoked. Idempotent: rows
 * already ended or revoked are untouched. Exported for the unit tests.
 */
export async function revokeAssignmentsOnLeave(
  input: { context: UserContext; organizationId: string; userId: string; contractId: string; correlationId: string },
  deps: RbacDeps = defaultRbacDeps
): Promise<string[]> {
  const now = deps.now();
  const live = (await deps.db.userRoleAssignment.findMany({
    where: { userId: input.userId, organizationId: input.organizationId, revokedAt: null, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { id: true, roleId: true, scopeType: true, propertyId: true }
  })) as Array<{ id: string; roleId: string; scopeType: string; propertyId: string | null }>;
  if (live.length === 0) return [];
  await deps.db.userRoleAssignment.updateMany({ where: { id: { in: live.map((row) => row.id) } }, data: { validTo: now, reason: "baja" } });
  for (const row of live) {
    deps.audit({
      organizationId: input.organizationId,
      propertyId: row.propertyId ?? undefined,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "ROLE_REVOKED",
      entityType: "user_role_assignment",
      entityId: row.id,
      beforeJson: { userId: input.userId, roleId: row.roleId, scopeType: row.scopeType, validTo: null },
      afterJson: { reason: "baja", validTo: now.toISOString(), contractId: input.contractId },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }
  await bumpRbacVersion(input.organizationId, deps.db);
  return live.map((row) => row.id);
}

export async function deactivateContract(input: {
  context: UserContext;
  contractId: string;
  correlationId: string;
  rbac?: RbacDeps;
  /** Tanda RRHH (RRHH-2): fecha de fin (YYYY-MM-DD) y causa (HR_END_REASONS) de la baja; opcionales. */
  endDate?: string;
  endReason?: string;
}): Promise<EmploymentContractRecord> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);

  const existing = await prisma.employmentContract.findUnique({ where: { id: input.contractId } });
  if (!existing) throw new Error("Employment contract was not found.");
  if (!existing.active) return mapContract(existing);
  if (input.endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) throw new BadRequestError("endDate debe ser una fecha YYYY-MM-DD.");
  if (input.endReason !== undefined && !(HR_END_REASONS as readonly string[]).includes(input.endReason)) throw new BadRequestError(`endReason debe ser uno de: ${HR_END_REASONS.join(", ")}.`);

  const before = mapContract(existing);
  const updated = await prisma.employmentContract.update({
    where: { id: existing.id },
    data: {
      active: false,
      ...(input.endDate !== undefined ? { endDate: dateOnly(input.endDate) } : {}),
      ...(input.endReason !== undefined ? { endReason: input.endReason } : {})
    }
  });
  const after = mapContract(updated);

  // Tanda 8a: the baja ends the person's access (see the module header).
  const profile = await prisma.staffProfile.findUnique({ where: { id: existing.staffProfileId }, select: { userId: true } });
  const revokedAssignmentIds = profile?.userId
    ? await revokeAssignmentsOnLeave({ context: input.context, organizationId: existing.organizationId, userId: profile.userId, contractId: existing.id, correlationId: input.correlationId }, input.rbac ?? defaultRbacDeps)
    : [];

  recordAuditEvent({
    organizationId: existing.organizationId,
    propertyId: existing.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "EMPLOYMENT_CONTRACT_DEACTIVATED",
    entityType: "employment_contract",
    entityId: existing.id,
    beforeJson: before,
    afterJson: { ...after, linkedUserId: profile?.userId ?? null, revokedAssignmentIds },
    correlationId: input.correlationId
  });

  return after;
}
