import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

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
  requirePermissions(input.context, ["accounting.journal.post"]);

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

export async function deactivateContract(input: {
  context: UserContext;
  contractId: string;
  correlationId: string;
}): Promise<EmploymentContractRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);

  const existing = await prisma.employmentContract.findUnique({ where: { id: input.contractId } });
  if (!existing) throw new Error("Employment contract was not found.");
  if (!existing.active) return mapContract(existing);

  const before = mapContract(existing);
  const updated = await prisma.employmentContract.update({
    where: { id: existing.id },
    data: { active: false }
  });
  const after = mapContract(updated);

  recordAuditEvent({
    organizationId: existing.organizationId,
    propertyId: existing.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "EMPLOYMENT_CONTRACT_DEACTIVATED",
    entityType: "employment_contract",
    entityId: existing.id,
    beforeJson: before,
    afterJson: after,
    correlationId: input.correlationId
  });

  return after;
}
