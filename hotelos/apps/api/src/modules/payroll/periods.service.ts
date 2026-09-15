import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { ledger, type Db } from "../treasury/ledger-bridge.js";
import { dayUtc, dec, isoDay, money, moneyNumber, round2, sum, type Dec } from "../treasury/money.js";
import { PAYROLL_WRITE_KEYS, requireAnyPermission } from "../treasury/permissions.js";

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
  status: "open" | "calculated" | "exported" | "closed";
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
  return s === "open" || s === "calculated" || s === "exported" || s === "closed";
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
    paidAt: row.paidAt?.toISOString() ?? null
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

    for (const contract of contracts) {
      if (seenProfiles.has(contract.staffProfileId)) continue; // unique (periodId, staffProfileId)
      const daysWorked = contractActiveDays({ startDate: contract.startDate, endDate: contract.endDate ?? null }, { startDate: period.startDate, endDate: period.endDate });
      if (daysWorked <= 0) continue;
      const calc = computeSlip({ fullGross: dec(contract.grossSalary), daysWorked, daysInMonth, irpfRatePct: contract.irpfRatePct === null ? null : dec(contract.irpfRatePct) });
      if (calc.effectiveGross.lte(0)) continue;
      seenProfiles.add(contract.staffProfileId);
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
        propertyId: period.propertyId ?? contract.propertyId ?? null,
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

      // 4) Modelo 111 (rendimientos del trabajo, fila 01).
      const withholdingPropertyId = period.propertyId ?? contract.propertyId ?? profileById.get(contract.staffProfileId)?.propertyId ?? null;
      if (withholdingPropertyId && calc.irpfRetention.gt(0)) {
        await tx.withholdingTaxRecord.create({
          data: {
            organizationId: period.organizationId,
            propertyId: withholdingPropertyId,
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
        reversedAt: reversedIds.length > 0 ? now : period.reversedAt
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

/** Pago de la nómina del periodo: D 465 / H 572 por el total líquido. Idempotente. */
export async function payPeriod(input: PayPeriodInput): Promise<PayrollPeriodRecord> {
  if (input.context) requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const db = input.db ?? prisma;
  const period = await db.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
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
      afterJson: { paidAt: paidAt.toISOString(), journalEntryId: entry.id, totalNet: money(net) },
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
