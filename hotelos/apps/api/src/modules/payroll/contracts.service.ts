import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { bumpRbacVersion } from "../../lib/rbac-scope.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { PAYROLL_WRITE_KEYS, requireAnyPermission } from "../treasury/permissions.js";

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
// Sharp edge: `payCount` (12 vs 14 in Spain — the famous "pagas extras") is
// stored but NOT factored into the monthly slip yet. Sprint 24 will add the
// extra-payment proration. For now we just compute the simple monthly gross.

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
};

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
    updatedAt: row.updatedAt.toISOString()
  };
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
}): Promise<EmploymentContractRecord> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);

  if (!Number.isFinite(input.grossSalary) || input.grossSalary < 0) {
    throw new Error("grossSalary must be a non-negative number.");
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw new Error("endDate must be on or after startDate.");
  }

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
      payCount: input.payCount ?? 14,
      irpfRatePct: input.irpfRatePct ?? null,
      socialSecurityCategory: input.socialSecurityCategory ?? null,
      costCenterId: input.costCenterId ?? null,
      active: true
    }
  });

  const record = mapContract(created);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "EMPLOYMENT_CONTRACT_CREATED",
    entityType: "employment_contract",
    entityId: record.id,
    afterJson: record,
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
      irpfRatePct: record.irpfRatePct ?? null
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return record;
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
}): Promise<EmploymentContractRecord> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);

  const existing = await prisma.employmentContract.findUnique({ where: { id: input.contractId } });
  if (!existing) throw new Error("Employment contract was not found.");
  if (!existing.active) return mapContract(existing);

  const before = mapContract(existing);
  const updated = await prisma.employmentContract.update({
    where: { id: existing.id },
    data: { active: false }
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
