import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

// ---- Sprint 23 / Track 5 — Payroll bridge a gestoría ----
//
// Calculation model (intentionally simple — Sprint 24 will refine):
//   gross           = EmploymentContract.grossSalary (monthly).
//   irpfRetention   = gross * (contract.irpfRatePct ?? defaultIrpfRate(gross)) / 100
//   ssEmployee      = gross * 6.35 %  (4.7 contingencias + 1.55 desempleo + 0.1 FP)
//   ssEmployer      = gross * 30.5 %  (23.6 + 5.5 + 0.6 FP + 0.2 FOGASA + 0.6 prof.)
//   netSalary       = gross - irpfRetention - ssEmployee
//
// `defaultIrpfRate` is a naive bracket table on *annualised* gross (gross * 12),
// because IRPF brackets in Spain are annual:
//   0 – 12 000 €   → 0 %
//   12 000 – 20 000 → 8 %
//   20 000 – 35 000 → 15 %
//   35 000 – 60 000 → 22 %
//   > 60 000        → 30 %
// These are deliberately rough — the gestoría re-computes with the proper
// tramos AEAT (and personal allowances) on their side. We use them only when
// the contract leaves `irpfRatePct` null so the slip is never zero.
//
// Sharp edges (documented for the next sprint):
//   • Sprint 24 added daily prorating for contracts that start or end inside
//     the period (`contractActiveDays`). `daysWorked` is the real count of
//     active calendar days in [periodStart, periodEnd] and the gross is
//     scaled by daysWorked/daysInMonth.
//   • IRPF rate is still computed on the *full* monthly gross (annualised)
//     to keep the AEAT bracket lookup stable across part-month entries.
//   • `payCount` (12 vs 14) is stored but not applied here.
//   • Idempotency: re-calculating a period in status "calculated" wipes the
//     existing slips first; that's a hard reset, not a diff.

const SS_EMPLOYEE_PCT = 6.35;
const SS_EMPLOYER_PCT = 30.5;

export type PayrollPeriodRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  startDate: string;
  endDate: string;
  status: "open" | "calculated" | "exported" | "closed";
  totalGross: number;
  totalNet: number;
  totalIrpf: number;
  totalSs: number;
  exportedAt?: string;
  createdAt: string;
};

export type PayrollSlipRecord = {
  id: string;
  periodId: string;
  staffProfileId: string;
  contractId?: string;
  grossSalary: number;
  irpfRetention: number;
  ssEmployee: number;
  ssEmployer: number;
  netSalary: number;
  daysWorked: number;
  documentObjectKey?: string;
  status: "draft" | "issued" | "paid";
  createdAt: string;
  lines: PayrollLineRecord[];
};

export type PayrollLineRecord = {
  id: string;
  slipId: string;
  lineType: "earning" | "deduction" | "employer_cost";
  code: string;
  description?: string;
  amount: number;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function decimalToNumber(d: unknown): number {
  if (d === null || d === undefined) return 0;
  if (typeof d === "number") return d;
  return Number(d);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isPeriodStatus(s: string): s is PayrollPeriodRecord["status"] {
  return s === "open" || s === "calculated" || s === "exported" || s === "closed";
}

function isSlipStatus(s: string): s is PayrollSlipRecord["status"] {
  return s === "draft" || s === "issued" || s === "paid";
}

function isLineType(s: string): s is PayrollLineRecord["lineType"] {
  return s === "earning" || s === "deduction" || s === "employer_cost";
}

function mapPeriod(
  row: NonNullable<Awaited<ReturnType<typeof prisma.payrollPeriod.findUnique>>>
): PayrollPeriodRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    periodCode: row.periodCode,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    status: isPeriodStatus(row.status) ? row.status : "open",
    totalGross: decimalToNumber(row.totalGross),
    totalNet: decimalToNumber(row.totalNet),
    totalIrpf: decimalToNumber(row.totalIrpf),
    totalSs: decimalToNumber(row.totalSs),
    exportedAt: row.exportedAt?.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

// "YYYY-MM" → first/last day of the month in UTC.
export function deriveMonthRange(periodCode: string): { startDate: Date; endDate: Date } {
  if (!/^\d{4}-\d{2}$/.test(periodCode)) {
    throw new Error("periodCode must be in YYYY-MM format.");
  }
  const [yearStr, monthStr] = periodCode.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (month < 1 || month > 12) throw new Error("periodCode month must be 01–12.");
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  // Last day of month = day 0 of next month.
  const endDate = new Date(Date.UTC(year, month, 0));
  return { startDate, endDate };
}

// Days the contract was active inside [periodStart, periodEnd] (UTC, inclusive
// on both ends). Returns 0 when the contract didn't intersect the period at
// all, otherwise the count of calendar days (1..daysInMonth).
//
// Rules:
//   • contract.startDate after periodEnd                 -> 0
//   • contract.endDate (if set) before periodStart       -> 0
//   • otherwise: clamp start/end to the period bounds and
//     count inclusive days = (clampedEnd − clampedStart)/day + 1
//
// Used to prorate `grossSalary` when a contract is signed mid-month or ends
// mid-month. We treat both endpoints as worked days — the gestoría applies
// the same convention.
export function contractActiveDays(
  contract: { startDate: Date; endDate: Date | null },
  period: { startDate: Date; endDate: Date }
): number {
  const periodStartMs = period.startDate.getTime();
  const periodEndMs = period.endDate.getTime();
  const cStartMs = contract.startDate.getTime();
  const cEndMs = contract.endDate ? contract.endDate.getTime() : Number.POSITIVE_INFINITY;

  if (cStartMs > periodEndMs) return 0;
  if (cEndMs < periodStartMs) return 0;

  const startMs = Math.max(periodStartMs, cStartMs);
  const endMs = Math.min(periodEndMs, cEndMs);
  if (endMs < startMs) return 0;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  // +1 because both endpoints count as worked days.
  return Math.floor((endMs - startMs) / MS_PER_DAY) + 1;
}

// Days in the month corresponding to a [startDate, endDate] period built by
// `deriveMonthRange`. Equivalent to `endDate.getUTCDate()`.
function daysInPeriodMonth(period: { startDate: Date; endDate: Date }): number {
  return period.endDate.getUTCDate();
}

// Naive bracket table — input is the monthly gross. Annualise (x12) before
// applying tramos so the brackets line up with the AEAT thresholds.
export function defaultIrpfRate(monthlyGross: number): number {
  const annual = monthlyGross * 12;
  if (annual <= 12_000) return 0;
  if (annual <= 20_000) return 8;
  if (annual <= 35_000) return 15;
  if (annual <= 60_000) return 22;
  return 30;
}

export async function listPeriods(organizationId: string): Promise<PayrollPeriodRecord[]> {
  const rows = await prisma.payrollPeriod.findMany({
    where: { organizationId },
    orderBy: { startDate: "desc" }
  });
  return rows.map(mapPeriod);
}

export async function createPeriod(input: {
  context: UserContext;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  correlationId: string;
}): Promise<PayrollPeriodRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);

  const { startDate, endDate } = deriveMonthRange(input.periodCode);

  const created = await prisma.payrollPeriod.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      periodCode: input.periodCode,
      startDate,
      endDate,
      status: "open",
      totalGross: 0,
      totalNet: 0,
      totalIrpf: 0,
      totalSs: 0
    }
  });

  const record = mapPeriod(created);

  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_PERIOD_OPENED",
    entityType: "payroll_period",
    entityId: record.id,
    afterJson: record,
    correlationId: input.correlationId
  });

  return record;
}

export async function calculatePeriod(input: {
  context: UserContext;
  periodId: string;
  correlationId: string;
}): Promise<{ period: PayrollPeriodRecord; slipIds: string[] }> {
  requirePermissions(input.context, ["accounting.journal.post"]);

  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new Error("Payroll period was not found.");
  if (period.status === "closed") {
    throw new Error(`Payroll period ${period.periodCode} is closed and cannot be recalculated.`);
  }

  // Idempotency — if we've already calculated, wipe the slips (and their
  // PayrollLine children) before recomputing.
  if (period.status === "calculated" || period.status === "exported") {
    const existing = await prisma.payrollSlip.findMany({
      where: { periodId: period.id },
      select: { id: true }
    });
    if (existing.length > 0) {
      const slipIds = existing.map((s) => s.id);
      await prisma.payrollLine.deleteMany({ where: { slipId: { in: slipIds } } });
      await prisma.payrollSlip.deleteMany({ where: { id: { in: slipIds } } });
    }
  }

  // Active contracts in scope. If period is property-scoped we constrain to
  // that property *or* org-wide contracts that don't pin a property; if the
  // period is org-wide we just take every active contract under the org.
  const contracts = await prisma.employmentContract.findMany({
    where: {
      organizationId: period.organizationId,
      active: true,
      ...(period.propertyId
        ? { OR: [{ propertyId: period.propertyId }, { propertyId: null }] }
        : {})
    }
  });

  let totalGross = 0;
  let totalNet = 0;
  let totalIrpf = 0;
  let totalSs = 0;
  const slipIds: string[] = [];

  const daysInMonth = daysInPeriodMonth(period);

  for (const contract of contracts) {
    const fullGross = round2(decimalToNumber(contract.grossSalary));

    // Sprint 24 — prorate for mid-month start / mid-month end.
    const daysWorkedThisPeriod = Math.min(
      daysInMonth,
      contractActiveDays(
        { startDate: contract.startDate, endDate: contract.endDate ?? null },
        { startDate: period.startDate, endDate: period.endDate }
      )
    );

    // Contract didn't intersect the period at all — skip silently. Common
    // case: a contract deactivated `active=true` because the property re-uses
    // it later, but with `endDate` before this month started.
    if (daysWorkedThisPeriod <= 0) continue;

    const effectiveGross = round2((fullGross * daysWorkedThisPeriod) / daysInMonth);

    // IRPF rate is annualised in `defaultIrpfRate`, so we pass the *full*
    // monthly gross (not the prorated one) — otherwise a mid-month start
    // would artificially drop into a lower bracket and refund itself later.
    const irpfRate =
      contract.irpfRatePct !== null && contract.irpfRatePct !== undefined
        ? decimalToNumber(contract.irpfRatePct)
        : defaultIrpfRate(fullGross);

    const irpfRetention = round2((effectiveGross * irpfRate) / 100);
    const ssEmployee = round2((effectiveGross * SS_EMPLOYEE_PCT) / 100);
    const ssEmployer = round2((effectiveGross * SS_EMPLOYER_PCT) / 100);
    const netSalary = round2(effectiveGross - irpfRetention - ssEmployee);

    const proratedNote = daysWorkedThisPeriod !== daysInMonth
      ? ` (prorrateo ${daysWorkedThisPeriod}/${daysInMonth} días)`
      : "";

    const slip = await prisma.payrollSlip.create({
      data: {
        periodId: period.id,
        staffProfileId: contract.staffProfileId,
        contractId: contract.id,
        grossSalary: effectiveGross,
        irpfRetention,
        ssEmployee,
        ssEmployer,
        netSalary,
        daysWorked: daysWorkedThisPeriod,
        status: "draft"
      }
    });

    await prisma.payrollLine.createMany({
      data: [
        {
          slipId: slip.id,
          lineType: "earning",
          code: "base_salary",
          description: `Salario base bruto mensual${proratedNote}`,
          amount: effectiveGross
        },
        {
          slipId: slip.id,
          lineType: "deduction",
          code: "irpf",
          description: `Retención IRPF ${irpfRate}%`,
          amount: irpfRetention
        },
        {
          slipId: slip.id,
          lineType: "deduction",
          code: "ss_employee",
          description: `Seguridad Social trabajador ${SS_EMPLOYEE_PCT}%`,
          amount: ssEmployee
        },
        {
          slipId: slip.id,
          lineType: "employer_cost",
          code: "ss_employer",
          description: `Seguridad Social empresa ${SS_EMPLOYER_PCT}%`,
          amount: ssEmployer
        }
      ]
    });

    slipIds.push(slip.id);
    totalGross = round2(totalGross + effectiveGross);
    totalNet = round2(totalNet + netSalary);
    totalIrpf = round2(totalIrpf + irpfRetention);
    totalSs = round2(totalSs + ssEmployee + ssEmployer);
  }

  const updated = await prisma.payrollPeriod.update({
    where: { id: period.id },
    data: {
      status: "calculated",
      totalGross,
      totalNet,
      totalIrpf,
      totalSs
    }
  });

  const record = mapPeriod(updated);

  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_PERIOD_CALCULATED",
    entityType: "payroll_period",
    entityId: period.id,
    afterJson: { ...record, slipCount: slipIds.length },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? "",
    entityType: "payroll_period",
    entityId: period.id,
    eventType: "PayrollSlipsCalculated",
    payload: {
      periodCode: period.periodCode,
      slipIds,
      totalGross,
      totalNet,
      totalIrpf,
      totalSs
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return { period: record, slipIds };
}

export async function listSlipsForPeriod(periodId: string): Promise<PayrollSlipRecord[]> {
  // The schema doesn't declare a Prisma relation between PayrollLine and
  // PayrollSlip, so we hop via slipId rather than `where: { slip: { ... } }`.
  const slips = await prisma.payrollSlip.findMany({
    where: { periodId },
    orderBy: { createdAt: "asc" }
  });
  const slipIds = slips.map((s) => s.id);
  const lines = slipIds.length
    ? await prisma.payrollLine.findMany({ where: { slipId: { in: slipIds } } })
    : [];

  const linesBySlip = new Map<string, PayrollLineRecord[]>();
  for (const line of lines) {
    const list = linesBySlip.get(line.slipId) ?? [];
    list.push({
      id: line.id,
      slipId: line.slipId,
      lineType: isLineType(line.lineType) ? line.lineType : "earning",
      code: line.code,
      description: line.description ?? undefined,
      amount: decimalToNumber(line.amount)
    });
    linesBySlip.set(line.slipId, list);
  }

  return slips.map((row) => ({
    id: row.id,
    periodId: row.periodId,
    staffProfileId: row.staffProfileId,
    contractId: row.contractId ?? undefined,
    grossSalary: decimalToNumber(row.grossSalary),
    irpfRetention: decimalToNumber(row.irpfRetention),
    ssEmployee: decimalToNumber(row.ssEmployee),
    ssEmployer: decimalToNumber(row.ssEmployer),
    netSalary: decimalToNumber(row.netSalary),
    daysWorked: row.daysWorked,
    documentObjectKey: row.documentObjectKey ?? undefined,
    status: isSlipStatus(row.status) ? row.status : "draft",
    createdAt: row.createdAt.toISOString(),
    lines: linesBySlip.get(row.id) ?? []
  }));
}
