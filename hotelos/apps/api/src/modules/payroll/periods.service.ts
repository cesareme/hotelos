import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { ledger, type Db } from "../treasury/ledger-bridge.js";
import { dayUtc, dec, isoDay, money, moneyNumber, round2, sum, type Dec } from "../treasury/money.js";
import { PAYROLL_WRITE_KEYS, assertSeparationOfDuties, requireAnyPermission, sodAuditFields } from "../treasury/permissions.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireWithholdingWorkCenter, workCenterRequiredError } from "../accounting/posting-rules/withholding-tax.js";

// Tanda 8a (RBAC · L2, design §4.7 «Nómina», decision D10): RRHH prepares
// (createPeriod / calculatePeriod with payroll.manage; calculatedByUserId is
// stamped), general management approves the monthly register
// (approvePeriod with payroll.approve; approver ≠ calculator → 409
// RBAC_SOD_CONFLICT calculator_ne_approver; status `approved`), dirección
// financiera pays (payPeriod from the route with payables.pay; an unapproved
// period → 409 PAYROLL_NOT_APPROVED; payer ≠ approver → 409). Recalculating
// resets the approval. INTERNAL USE WITHOUT CONTEXT: only the bank
// reconciliation (modules/banking/reconciliation.service.ts, a bank movement
// matched to the payroll payment) calls payPeriod without a context; that
// path records the payment of money that already left the bank, so it is
// not gated here but it is audited as a system event with `approved: false`
// when the period was never approved — moving it behind the approval is the
// integrator's call (the caller module is outside this lot).

// ---- Payroll periods (lote tesoreria-banca) ----
//
// Calculation model (unchanged in spirit, now Decimal end to end):
//   gross           = EmploymentContract.grossSalary (monthly) prorated by the
//                     calendar days the contract is active in the month;
//   irpfRetention   = gross × (contract.irpfRatePct ?? defaultIrpfRate(fullGross)) / 100
//   ssEmployee      = gross × 6.35 %  (4.7 contingencias comunes + 1.55 desempleo + 0.1 FP)
//   ssEmployer      = gross × 30.5 %  (23.6 + 5.5 + 0.6 FP + 0.2 FOGASA + 0.6 AT/EP medio)
//   netSalary       = gross − irpfRetention − ssEmployee
// The SS percentages are the general-regime approximation the gestoría
// re-computes (bases mínimas/máximas, MEI, tipo AT/EP del CNAE): every export
// is flagged `validateWithAdvisor`. `payCount` (12/14) is stored, not applied.
//
// Accounting (PGC Pymes, one entry per slip, sourceType payroll_slip, accounting
// date = period end):
//   D 640 Sueldos y salarios (gross) · D 642 SS a cargo de la empresa (ssEmployer)
//   H 4751 HP acreedora retenciones (IRPF) · H 476 SS acreedora (ssEmployee + ssEmployer)
//   H 465 Remuneraciones pendientes de pago (net)
// Payment: D 465 / H 572 (sourceType payroll_payment, one per period).
//
// Recalculation NEVER duplicates expense: the entries of the previous run are
// reversed (inverse entries marked reversalOfId) inside the same transaction
// that wipes the slips and posts the new ones; `journalEntryIds` /
// `reversalJournalEntryIds` keep the whole history on the period. IRPF rows
// feed Modelo 111 through WithholdingTaxRecord (rowCode "01").
//
// Work centre (Tanda 6b · L4, design §5.2 R4 and §4 #7/#12): every slip has
// ONE centre — `resolvePayrollWorkCenter`: the period's property, else the
// contract's, else the employee profile's — used for BOTH the asiento
// (640/642 are group-6 lines: WORK_CENTER_REQUIRED in the ledger otherwise)
// and the WithholdingTaxRecord, so the head office's payroll (Property.kind
// office) enters the Modelo 111 like any hotel's. No centre at all → 409
// WORK_CENTER_REQUIRED + audit event PAYROLL_WORK_CENTER_REQUIRED, the whole
// calculation rolls back (nothing is dropped in silence). The employer of the
// export is the sociedad (export.service.ts).

export const SS_EMPLOYEE_PCT = "6.35";
export const SS_EMPLOYER_PCT = "30.5";
const SALARIES_CODE = "640";
const SS_EMPLOYER_CODE = "642";
const IRPF_PAYABLE_CODE = "4751";
const SS_PAYABLE_CODE = "476";
const NET_PAYABLE_CODE = "465";
const BANK_CODE = "572";

export type PayrollPeriodRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  startDate: string;
  endDate: string;
  status: "open" | "calculated" | "exported" | "approved" | "closed";
  totalGross: number;
  totalNet: number;
  totalIrpf: number;
  totalSs: number;
  exportedAt?: string;
  createdAt: string;
  journalEntryIds: string[];
  reversalJournalEntryIds: string[];
  postedAt: string | null;
  reversedAt: string | null;
  paymentJournalEntryId: string | null;
  paidAt: string | null;
  // Tanda 8a (SoD): who calculated, who approved.
  calculatedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
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
  journalEntryId: string | null;
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

function isPeriodStatus(s: string): s is PayrollPeriodRecord["status"] {
  return s === "open" || s === "calculated" || s === "exported" || s === "approved" || s === "closed";
}

function isSlipStatus(s: string): s is PayrollSlipRecord["status"] {
  return s === "draft" || s === "issued" || s === "paid";
}

function isLineType(s: string): s is PayrollLineRecord["lineType"] {
  return s === "earning" || s === "deduction" || s === "employer_cost";
}

type PeriodRow = NonNullable<Awaited<ReturnType<typeof prisma.payrollPeriod.findUnique>>>;

function mapPeriod(row: PeriodRow): PayrollPeriodRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    periodCode: row.periodCode,
    startDate: isoDay(row.startDate),
    endDate: isoDay(row.endDate),
    status: isPeriodStatus(row.status) ? row.status : "open",
    totalGross: moneyNumber(row.totalGross),
    totalNet: moneyNumber(row.totalNet),
    totalIrpf: moneyNumber(row.totalIrpf),
    totalSs: moneyNumber(row.totalSs),
    exportedAt: row.exportedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    journalEntryIds: row.journalEntryIds,
    reversalJournalEntryIds: row.reversalJournalEntryIds,
    postedAt: row.postedAt?.toISOString() ?? null,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    paymentJournalEntryId: row.paymentJournalEntryId,
    paidAt: row.paidAt?.toISOString() ?? null,
    calculatedByUserId: row.calculatedByUserId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null
  };
}

// "YYYY-MM" → first/last day of the month in UTC.
export function deriveMonthRange(periodCode: string): { startDate: Date; endDate: Date } {
  if (!/^\d{4}-\d{2}$/.test(periodCode)) throw new BadRequestError("periodCode debe tener el formato YYYY-MM.");
  const [yearStr, monthStr] = periodCode.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (month < 1 || month > 12) throw new BadRequestError("El mes de periodCode debe estar entre 01 y 12.");
  return { startDate: new Date(Date.UTC(year, month - 1, 1)), endDate: new Date(Date.UTC(year, month, 0)) };
}

/** Calendar days (inclusive) the contract is active inside the period; 0 when it does not intersect. */
export function contractActiveDays(contract: { startDate: Date; endDate: Date | null }, period: { startDate: Date; endDate: Date }): number {
  const periodStartMs = period.startDate.getTime();
  const periodEndMs = period.endDate.getTime();
  const cStartMs = contract.startDate.getTime();
  const cEndMs = contract.endDate ? contract.endDate.getTime() : Number.POSITIVE_INFINITY;
  if (cStartMs > periodEndMs) return 0;
  if (cEndMs < periodStartMs) return 0;
  const startMs = Math.max(periodStartMs, cStartMs);
  const endMs = Math.min(periodEndMs, cEndMs);
  if (endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function daysInPeriodMonth(period: { startDate: Date; endDate: Date }): number {
  return period.endDate.getUTCDate();
}

/**
 * Work centre of a slip (pure): the period's property (a per-centre payroll
 * run), else the contract's, else the employee profile's home property; null
 * when none — the caller turns that into 409 WORK_CENTER_REQUIRED.
 */
export function resolvePayrollWorkCenter(input: { periodPropertyId?: string | null; contractPropertyId?: string | null; profilePropertyId?: string | null }): string | null {
  return input.periodPropertyId || input.contractPropertyId || input.profilePropertyId || null;
}

/** Naive annual bracket table on the monthly gross ×12 (only when the contract has no rate). */
export function defaultIrpfRate(monthlyGross: number | Dec): number {
  const annual = dec(monthlyGross).mul(12);
  if (annual.lte(12_000)) return 0;
  if (annual.lte(20_000)) return 8;
  if (annual.lte(35_000)) return 15;
  if (annual.lte(60_000)) return 22;
  return 30;
}

export type SlipComputation = {
  effectiveGross: Dec;
  irpfRate: Dec;
  irpfRetention: Dec;
  ssEmployee: Dec;
  ssEmployer: Dec;
  netSalary: Dec;
  daysWorked: number;
  daysInMonth: number;
};

/** Pure slip arithmetic (Decimal, HALF_UP per concept). Identity: gross + ssEmployer = irpf + ss(both) + net. */
export function computeSlip(input: { fullGross: Dec | number | string; daysWorked: number; daysInMonth: number; irpfRatePct: Dec | number | string | null }): SlipComputation {
  const fullGross = round2(dec(input.fullGross));
  const daysWorked = Math.max(0, Math.min(input.daysInMonth, input.daysWorked));
  const effectiveGross = daysWorked === input.daysInMonth ? fullGross : round2(fullGross.mul(daysWorked).div(input.daysInMonth));
  const irpfRate = input.irpfRatePct === null || input.irpfRatePct === undefined ? dec(defaultIrpfRate(fullGross)) : dec(input.irpfRatePct);
  const irpfRetention = round2(effectiveGross.mul(irpfRate).div(100));
  const ssEmployee = round2(effectiveGross.mul(dec(SS_EMPLOYEE_PCT)).div(100));
  const ssEmployer = round2(effectiveGross.mul(dec(SS_EMPLOYER_PCT)).div(100));
  const netSalary = round2(effectiveGross.minus(irpfRetention).minus(ssEmployee));
  return { effectiveGross, irpfRate, irpfRetention, ssEmployee, ssEmployer, netSalary, daysWorked, daysInMonth: input.daysInMonth };
}

export async function listPeriods(organizationId: string): Promise<PayrollPeriodRecord[]> {
  const rows = await prisma.payrollPeriod.findMany({ where: { organizationId }, orderBy: { startDate: "desc" }, take: 500 });
  return rows.map(mapPeriod);
}

export async function getPeriod(periodId: string): Promise<PayrollPeriodRecord> {
  const row = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!row) throw new NotFoundError("El periodo de nómina no existe.");
  return mapPeriod(row);
}

export async function createPeriod(input: { context: UserContext; organizationId: string; propertyId?: string; periodCode: string; correlationId: string }): Promise<PayrollPeriodRecord> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const { startDate, endDate } = deriveMonthRange(input.periodCode);
  if (input.propertyId) {
    // A per-centre period must name a centre of the organisation (hotel, office or other); opaque 404 otherwise.
    const centre = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
    if (!centre || centre.organizationId !== input.organizationId) throw new NotFoundError("La propiedad no existe.");
  }
  const existing = await prisma.payrollPeriod.findFirst({ where: { organizationId: input.organizationId, periodCode: input.periodCode, propertyId: input.propertyId ?? null } });
  if (existing) throw new ConflictError(`El periodo ${input.periodCode} ya existe.`, { code: "PAYROLL_PERIOD_EXISTS", periodId: existing.id });
  const created = await prisma.payrollPeriod.create({
    data: { organizationId: input.organizationId, propertyId: input.propertyId ?? null, periodCode: input.periodCode, startDate, endDate, status: "open", totalGross: 0, totalNet: 0, totalIrpf: 0, totalSs: 0 }
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

/** Reverses the slip entries of the previous run (idempotent: already-reversed ids are skipped). */
async function reversePreviousRun(tx: Db, period: PeriodRow, createdBy: string | null, reason: string): Promise<string[]> {
  const reversalIds: string[] = [];
  for (const journalEntryId of period.journalEntryIds) {
    const entry = await tx.journalEntry.findUnique({ where: { id: journalEntryId }, select: { id: true, reversedById: true, status: true } });
    if (!entry) continue;
    if (entry.reversedById) {
      reversalIds.push(entry.reversedById);
      continue;
    }
    if (entry.status !== "posted") continue;
    const reversal = await ledger().reverseJournalEntry({
      organizationId: period.organizationId,
      journalEntryId,
      entryDate: period.endDate,
      description: `Reverso nómina ${period.periodCode} — ${reason}`,
      reference: period.periodCode,
      createdBy,
      db: tx
    });
    reversalIds.push(reversal.id);
  }
  return reversalIds;
}

export async function calculatePeriod(input: { context: UserContext; periodId: string; correlationId: string }): Promise<{ period: PayrollPeriodRecord; slipIds: string[]; journalEntryIds: string[]; reversedJournalEntryIds: string[] }> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
  if (period.status === "closed") throw new ConflictError(`El periodo ${period.periodCode} está cerrado y no se puede recalcular.`, { code: "PAYROLL_PERIOD_CLOSED" });
  if (period.paidAt) throw new ConflictError(`El periodo ${period.periodCode} ya está pagado: revierte el pago antes de recalcular.`, { code: "PAYROLL_PERIOD_PAID" });

  const contracts = await prisma.employmentContract.findMany({
    where: { organizationId: period.organizationId, active: true, ...(period.propertyId ? { OR: [{ propertyId: period.propertyId }, { propertyId: null }] } : {}) },
    orderBy: { createdAt: "asc" }
  });
  const profileIds = Array.from(new Set(contracts.map((c) => c.staffProfileId)));
  const profiles = profileIds.length ? await prisma.staffProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, propertyId: true, userId: true } }) : [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const daysInMonth = daysInPeriodMonth(period);

  const result = await prisma.$transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // 1) Reverse the entries of the previous run and wipe its slips.
    const previousSlips = await tx.payrollSlip.findMany({ where: { periodId: period.id }, select: { id: true } });
    const reversedIds = await reversePreviousRun(tx, period, input.context.userId, "recálculo");
    if (previousSlips.length > 0) {
      const ids = previousSlips.map((s) => s.id);
      await tx.withholdingTaxRecord.deleteMany({ where: { sourceType: "payroll_slip", sourceId: { in: ids } } });
      await tx.payrollLine.deleteMany({ where: { slipId: { in: ids } } });
      await tx.payrollSlip.deleteMany({ where: { id: { in: ids } } });
    }

    // 2) New slips, one per active contract that intersects the month.
    let totalGross = dec(0);
    let totalNet = dec(0);
    let totalIrpf = dec(0);
    let totalSs = dec(0);
    const slipIds: string[] = [];
    const journalEntryIds: string[] = [];
    const seenProfiles = new Set<string>();
    const verifiedWorkCenters = new Set<string>();

    for (const contract of contracts) {
      if (seenProfiles.has(contract.staffProfileId)) continue; // unique (periodId, staffProfileId)
      const daysWorked = contractActiveDays({ startDate: contract.startDate, endDate: contract.endDate ?? null }, { startDate: period.startDate, endDate: period.endDate });
      if (daysWorked <= 0) continue;
      const calc = computeSlip({ fullGross: dec(contract.grossSalary), daysWorked, daysInMonth, irpfRatePct: contract.irpfRatePct === null ? null : dec(contract.irpfRatePct) });
      if (calc.effectiveGross.lte(0)) continue;
      seenProfiles.add(contract.staffProfileId);

      // Work centre of the slip (R4): period > contract > employee profile; never silent.
      const workCenterId = resolvePayrollWorkCenter({ periodPropertyId: period.propertyId, contractPropertyId: contract.propertyId, profilePropertyId: profileById.get(contract.staffProfileId)?.propertyId });
      if (!workCenterId) {
        recordAuditEvent({
          organizationId: period.organizationId,
          actorUserId: input.context.userId,
          actorType: "user",
          action: "PAYROLL_WORK_CENTER_REQUIRED",
          entityType: "employment_contract",
          entityId: contract.id,
          afterJson: { code: "WORK_CENTER_REQUIRED", periodId: period.id, periodCode: period.periodCode, staffProfileId: contract.staffProfileId, irpfRetention: money(calc.irpfRetention) },
          correlationId: input.correlationId
        });
        throw workCenterRequiredError({ periodId: period.id, periodCode: period.periodCode, contractId: contract.id, staffProfileId: contract.staffProfileId, source: "payroll_slip" });
      }
      if (!verifiedWorkCenters.has(workCenterId)) {
        await requireWithholdingWorkCenter(period.organizationId, workCenterId, tx);
        verifiedWorkCenters.add(workCenterId);
      }
      const proratedNote = daysWorked !== daysInMonth ? ` (prorrateo ${daysWorked}/${daysInMonth} días)` : "";
      const slip = await tx.payrollSlip.create({
        data: {
          periodId: period.id,
          staffProfileId: contract.staffProfileId,
          contractId: contract.id,
          grossSalary: calc.effectiveGross,
          irpfRetention: calc.irpfRetention,
          ssEmployee: calc.ssEmployee,
          ssEmployer: calc.ssEmployer,
          netSalary: calc.netSalary,
          daysWorked,
          status: "draft"
        }
      });
      await tx.payrollLine.createMany({
        data: [
          { slipId: slip.id, lineType: "earning", code: "base_salary", description: `Salario base bruto mensual${proratedNote}`, amount: calc.effectiveGross },
          { slipId: slip.id, lineType: "deduction", code: "irpf", description: `Retención IRPF ${calc.irpfRate.toString()} %`, amount: calc.irpfRetention },
          { slipId: slip.id, lineType: "deduction", code: "ss_employee", description: `Seguridad Social trabajador ${SS_EMPLOYEE_PCT} %`, amount: calc.ssEmployee },
          { slipId: slip.id, lineType: "employer_cost", code: "ss_employer", description: `Seguridad Social empresa ${SS_EMPLOYER_PCT} %`, amount: calc.ssEmployer }
        ]
      });

      // 3) Entry of the slip (D 640 / D 642 / H 4751 / H 476 / H 465).
      const description = `Nómina ${period.periodCode} · empleado ${profileById.get(contract.staffProfileId)?.userId ?? contract.staffProfileId}`;
      const ssTotal = round2(calc.ssEmployee.plus(calc.ssEmployer));
      const lines = [
        { accountCode: SALARIES_CODE, debit: calc.effectiveGross, description: `${description} — Sueldos y salarios`, costCenterId: contract.costCenterId ?? null },
        { accountCode: SS_EMPLOYER_CODE, debit: calc.ssEmployer, description: `${description} — SS empresa`, costCenterId: contract.costCenterId ?? null },
        { accountCode: IRPF_PAYABLE_CODE, credit: calc.irpfRetention, description: `${description} — Retención IRPF` },
        { accountCode: SS_PAYABLE_CODE, credit: ssTotal, description: `${description} — SS acreedora` },
        { accountCode: NET_PAYABLE_CODE, credit: calc.netSalary, description: `${description} — Líquido a pagar` }
      ];
      const entry = await ledger().postJournalEntry({
        organizationId: period.organizationId,
        propertyId: workCenterId,
        entryDate: period.endDate,
        sourceType: "payroll_slip",
        sourceId: slip.id,
        description,
        reference: period.periodCode,
        createdBy: input.context.userId,
        lines,
        db: tx
      });
      journalEntryIds.push(entry.id);

      // 4) Modelo 111 (rendimientos del trabajo, fila 01) — always on the slip's centre (the office included).
      if (calc.irpfRetention.gt(0)) {
        await tx.withholdingTaxRecord.create({
          data: {
            organizationId: period.organizationId,
            propertyId: workCenterId,
            sourceType: "payroll_slip",
            sourceId: slip.id,
            recipientNif: null,
            recipientName: null,
            grossAmount: calc.effectiveGross,
            retentionRate: calc.irpfRate,
            retentionAmount: calc.irpfRetention,
            rowCode: "01",
            paymentDate: period.endDate
          }
        });
      }

      slipIds.push(slip.id);
      totalGross = totalGross.plus(calc.effectiveGross);
      totalNet = totalNet.plus(calc.netSalary);
      totalIrpf = totalIrpf.plus(calc.irpfRetention);
      totalSs = totalSs.plus(ssTotal);
    }

    const now = new Date();
    const updated = await tx.payrollPeriod.update({
      where: { id: period.id },
      data: {
        status: "calculated",
        totalGross: round2(totalGross),
        totalNet: round2(totalNet),
        totalIrpf: round2(totalIrpf),
        totalSs: round2(totalSs),
        exportedAt: null,
        journalEntryIds,
        reversalJournalEntryIds: Array.from(new Set([...period.reversalJournalEntryIds, ...reversedIds])),
        postedAt: journalEntryIds.length > 0 ? now : null,
        reversedAt: reversedIds.length > 0 ? now : period.reversedAt,
        // Tanda 8a (SoD): the calculator is stamped; a recalculation invalidates a previous approval.
        calculatedByUserId: input.context.userId,
        approvedByUserId: null,
        approvedAt: null
      }
    });
    return { updated, slipIds, journalEntryIds, reversedIds };
  });

  const record = mapPeriod(result.updated);
  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_PERIOD_CALCULATED",
    entityType: "payroll_period",
    entityId: period.id,
    afterJson: { ...record, slipCount: result.slipIds.length, reversedJournalEntryIds: result.reversedIds },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? "",
    entityType: "payroll_period",
    entityId: period.id,
    eventType: "PayrollSlipsCalculated",
    payload: { periodCode: period.periodCode, slipIds: result.slipIds, journalEntryIds: result.journalEntryIds, totalGross: record.totalGross, totalNet: record.totalNet, totalIrpf: record.totalIrpf, totalSs: record.totalSs } as Record<string, unknown>,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return { period: record, slipIds: result.slipIds, journalEntryIds: result.journalEntryIds, reversedJournalEntryIds: result.reversedIds };
}

// ---------------------------------------------------------------------------
// Tanda 8a · approval of the monthly register (payroll.approve)
// ---------------------------------------------------------------------------

/**
 * POST /payroll/periods/:id/approve — general management approves the
 * calculated register: `payroll.approve`, on a calculated / exported period
 * that is not paid, by someone other than the calculator (409
 * RBAC_SOD_CONFLICT calculator_ne_approver; a period calculated before the
 * migration has no calculator: «autor desconocido», annotated). Writes
 * approvedByUserId / approvedAt and status `approved`; audit
 * PAYROLL_PERIOD_APPROVED.
 */
export async function approvePeriod(input: { context: UserContext; periodId: string; note?: string; correlationId: string }): Promise<PayrollPeriodRecord> {
  requirePermissions(input.context, ["payroll.approve"]);
  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
  if (period.paidAt) throw new ConflictError(`El periodo ${period.periodCode} ya está pagado.`, { code: "PAYROLL_PERIOD_PAID" });
  if (period.status === "closed") throw new ConflictError(`El periodo ${period.periodCode} está cerrado.`, { code: "PAYROLL_PERIOD_CLOSED" });
  if (period.status === "open" || period.journalEntryIds.length === 0) {
    throw new ConflictError(`El periodo ${period.periodCode} no está calculado ni contabilizado.`, { code: "PAYROLL_PERIOD_NOT_CALCULATED" });
  }
  if (period.approvedByUserId) {
    throw new ConflictError(`El periodo ${period.periodCode} ya está aprobado.`, { code: "PAYROLL_PERIOD_ALREADY_APPROVED", approvedByUserId: period.approvedByUserId, approvedAt: period.approvedAt?.toISOString() ?? null });
  }
  const sod = assertSeparationOfDuties(input.context, period.calculatedByUserId ?? null, "calculator_ne_approver", { periodId: period.id, periodCode: period.periodCode });
  const approvedAt = new Date();
  const updated = await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: "approved", approvedByUserId: input.context.userId, approvedAt } });
  const record = mapPeriod(updated);
  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_PERIOD_APPROVED",
    entityType: "payroll_period",
    entityId: period.id,
    beforeJson: { status: period.status, calculatedByUserId: period.calculatedByUserId ?? null, approvedByUserId: null },
    afterJson: { status: record.status, approvedByUserId: input.context.userId, approvedAt: approvedAt.toISOString(), totalNet: record.totalNet, note: input.note ?? null, ...sodAuditFields(sod) },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return record;
}

export type PayPeriodInput = {
  context?: UserContext;
  periodId: string;
  paidAt?: Date | string;
  /** Ledger code of the paying bank account (572 by default). */
  bankLedgerCode?: string | null;
  reference?: string | null;
  correlationId?: string;
  db?: Db;
};

export type PayrollPaymentGate = ReturnType<typeof assertSeparationOfDuties> & {
  /** Set when a platform / break-glass session paid a register nobody approved (audited exception, engine mode 3). */
  approvalBypassed: "platform_admin" | "break_glass" | null;
};

/**
 * Tanda 8a · the pay gate, separated for the unit tests: `payables.pay` on
 * the actor, an approved period (409 PAYROLL_NOT_APPROVED) and payer ≠
 * approver (409 RBAC_SOD_CONFLICT approver_ne_payer). A platform admin or a
 * break-glass session may pay an unapproved register — the same audited
 * exception the L1 engine grants (assertApprovedOrAuthorized mode 3) and the
 * brief keeps for the demo super-user — flagged `approvalBypassed` so the
 * trail shows it. Pure except the key check.
 */
export function assertPayrollPaymentAuthorized(
  context: UserContext,
  period: { id: string; periodCode: string; approvedByUserId: string | null }
): PayrollPaymentGate {
  requirePermissions(context, ["payables.pay"]);
  if (!period.approvedByUserId) {
    const privileged = context.isPlatformAdmin === true ? "platform_admin" : typeof context.breakGlassSessionId === "string" && context.breakGlassSessionId.length > 0 ? "break_glass" : null;
    if (!privileged) {
      throw new ConflictError(`El registro de nómina ${period.periodCode} no está aprobado.`, { code: "PAYROLL_NOT_APPROVED", periodId: period.id });
    }
    return { rule: "approver_ne_payer", authorUserId: null, authorUnknown: true, privileged, approvalBypassed: privileged };
  }
  return { ...assertSeparationOfDuties(context, period.approvedByUserId, "approver_ne_payer", { periodId: period.id, periodCode: period.periodCode }), approvalBypassed: null };
}

/** Pago de la nómina del periodo: D 465 / H 572 por el total líquido. Idempotente. */
export async function payPeriod(input: PayPeriodInput): Promise<PayrollPeriodRecord> {
  const db = input.db ?? prisma;
  const period = await db.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
  // Tanda 8a: with a context (the route) the pay gate applies BEFORE the
  // idempotent short-circuit (a user without payables.pay never reads a
  // period through this path); without one (bank reconciliation, see the
  // module header) the payment is recorded and audited as a system event.
  const paySod = input.context ? assertPayrollPaymentAuthorized(input.context, { id: period.id, periodCode: period.periodCode, approvedByUserId: period.approvedByUserId ?? null }) : null;
  if (period.paymentJournalEntryId && period.paidAt) return mapPeriod(period);
  if (period.status === "open" || period.journalEntryIds.length === 0) {
    throw new ConflictError(`El periodo ${period.periodCode} no está calculado ni contabilizado.`, { code: "PAYROLL_PERIOD_NOT_CALCULATED" });
  }
  const net = round2(dec(period.totalNet));
  if (net.lte(0)) throw new ConflictError("El periodo no tiene líquido a pagar.", { code: "PAYROLL_NOTHING_TO_PAY" });
  const paidAt = dayUtc(input.paidAt ?? new Date());
  const description = `Pago nóminas ${period.periodCode} · ${money(net)} €`;
  const entry = await ledger().postJournalEntry({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? null,
    entryDate: paidAt,
    sourceType: "payroll_payment",
    sourceId: period.id,
    description,
    reference: input.reference ?? period.periodCode,
    createdBy: input.context?.userId ?? null,
    lines: [
      { accountCode: NET_PAYABLE_CODE, debit: net, description },
      { accountCode: input.bankLedgerCode?.trim() || BANK_CODE, credit: net, description }
    ],
    db
  });
  await db.payrollSlip.updateMany({ where: { periodId: period.id }, data: { status: "paid" } });
  const updated = await db.payrollPeriod.update({ where: { id: period.id }, data: { paymentJournalEntryId: entry.id, paidAt } });
  if (input.context) {
    recordAuditEvent({
      organizationId: period.organizationId,
      propertyId: period.propertyId ?? undefined,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "PAYROLL_PERIOD_PAID",
      entityType: "payroll_period",
      entityId: period.id,
      afterJson: { paidAt: paidAt.toISOString(), journalEntryId: entry.id, totalNet: money(net), paidByUserId: input.context.userId, approvedByUserId: period.approvedByUserId ?? null, approvalBypassed: paySod?.approvalBypassed ?? null, ...(paySod ? sodAuditFields(paySod) : {}) },
      correlationId: input.correlationId
    });
  } else {
    // Internal path (bank reconciliation): never silent — the trail shows the
    // payment was recorded from a bank movement and whether the register had
    // been approved (Tanda 8a; QC-06).
    recordAuditEvent({
      organizationId: period.organizationId,
      propertyId: period.propertyId ?? undefined,
      actorType: "system",
      action: "PAYROLL_PERIOD_PAID",
      entityType: "payroll_period",
      entityId: period.id,
      afterJson: { paidAt: paidAt.toISOString(), journalEntryId: entry.id, totalNet: money(net), source: "bank_reconciliation", approved: Boolean(period.approvedByUserId), approvedByUserId: period.approvedByUserId ?? null },
      correlationId: input.correlationId
    });
  }
  return mapPeriod(updated);
}

export async function listSlipsForPeriod(periodId: string): Promise<PayrollSlipRecord[]> {
  const slips = await prisma.payrollSlip.findMany({ where: { periodId }, orderBy: { createdAt: "asc" } });
  const slipIds = slips.map((s) => s.id);
  const lines = slipIds.length ? await prisma.payrollLine.findMany({ where: { slipId: { in: slipIds } } }) : [];
  const entries = slipIds.length
    ? await prisma.journalEntry.findMany({ where: { sourceType: "payroll_slip", sourceId: { in: slipIds }, status: { in: ["posted", "reversed"] } }, select: { id: true, sourceId: true } })
    : [];
  const entryBySlip = new Map(entries.map((e) => [e.sourceId ?? "", e.id]));
  const linesBySlip = new Map<string, PayrollLineRecord[]>();
  for (const line of lines) {
    const list = linesBySlip.get(line.slipId) ?? [];
    list.push({ id: line.id, slipId: line.slipId, lineType: isLineType(line.lineType) ? line.lineType : "earning", code: line.code, description: line.description ?? undefined, amount: moneyNumber(line.amount) });
    linesBySlip.set(line.slipId, list);
  }
  return slips.map((row) => ({
    id: row.id,
    periodId: row.periodId,
    staffProfileId: row.staffProfileId,
    contractId: row.contractId ?? undefined,
    grossSalary: moneyNumber(row.grossSalary),
    irpfRetention: moneyNumber(row.irpfRetention),
    ssEmployee: moneyNumber(row.ssEmployee),
    ssEmployer: moneyNumber(row.ssEmployer),
    netSalary: moneyNumber(row.netSalary),
    daysWorked: row.daysWorked,
    documentObjectKey: row.documentObjectKey ?? undefined,
    status: isSlipStatus(row.status) ? row.status : "draft",
    createdAt: row.createdAt.toISOString(),
    journalEntryId: entryBySlip.get(row.id) ?? null,
    lines: linesBySlip.get(row.id) ?? []
  }));
}

/** Sum of the period's slips (cross-check of the stored totals). */
export function sumSlips(slips: Array<{ grossSalary: Prisma.Decimal | number; netSalary: Prisma.Decimal | number }>): { gross: Dec; net: Dec } {
  return { gross: round2(sum(slips.map((s) => dec(s.grossSalary)))), net: round2(sum(slips.map((s) => dec(s.netSalary)))) };
}
