import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

// ---- Sprint 23 / Track 5 — Payroll bridge a gestoría ----
//
// Two export formats are supported for the demo:
//   • A3 Nóminas-style:    pipe-delimited TXT, one line per slip.
//     `nif_empresa|nif_empleado|nombre|periodo|gross|irpf|ss_emp|ss_company|net`
//   • Sage Payroll / Holded-style:  CSV with header.
//     `Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net`
//
// Neither is a 1:1 of the real gestoría feeds — both are pragmatic minimums
// the gestoría can import via "load custom layout". The point is to unblock
// the operational flow; Sprint 24 can replace these with the official A3 fixed-
// width layout once a real client signs the integration.
//
// Sharp edges:
//   • The employer's NIF and the employee's NIF aren't on PayrollSlip /
//     EmploymentContract today. We surface them via StaffProfile / the
//     Organization record if available, otherwise the placeholder "—".
//   • The export sets `exportedAt = now()` and flips status to "exported".
//     Re-exporting is allowed; the timestamp is overwritten.

export type PayrollExportFormat = "a3" | "sage";

export type PayrollExportResult = {
  periodId: string;
  periodCode: string;
  format: PayrollExportFormat;
  filename: string;
  contentType: string;
  text: string;
  slipCount: number;
  exportedAt: string;
};

function decimalToNumber(d: unknown): number {
  if (d === null || d === undefined) return 0;
  if (typeof d === "number") return d;
  return Number(d);
}

function fmtEuro(n: number): string {
  // Two decimals, dot separator (gestoría layouts expect en-US-style decimals,
  // not the Spanish locale comma).
  return n.toFixed(2);
}

function sanitizePipe(value: string): string {
  // Strip the delimiter so a stray pipe in a person's name doesn't break the
  // record. Newlines too — one line per slip is the whole contract.
  return value.replace(/[|\r\n]+/g, " ").trim();
}

function sanitizeCsv(value: string): string {
  // Conservative CSV escape: double-quote if the value contains delimiters or
  // quotes; double internal quotes.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

type SlipRow = NonNullable<Awaited<ReturnType<typeof prisma.payrollSlip.findFirst>>>;
type ProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.staffProfile.findFirst>>>;

async function gatherSlips(periodId: string): Promise<{
  slips: SlipRow[];
  profiles: Map<string, ProfileRow>;
}> {
  const slips = await prisma.payrollSlip.findMany({
    where: { periodId },
    orderBy: { createdAt: "asc" }
  });
  const profileIds = Array.from(new Set(slips.map((s) => s.staffProfileId)));
  const profileRows = profileIds.length
    ? await prisma.staffProfile.findMany({ where: { id: { in: profileIds } } })
    : [];
  const profiles = new Map(profileRows.map((p) => [p.id, p]));
  return { slips, profiles };
}

async function lookupEmployerNif(organizationId: string): Promise<string> {
  // The Organization model has a `taxId` (NIF/CIF) field in many sprints; we
  // try a soft lookup and fall back to "—" so the layout never breaks.
  try {
    const row = (await prisma.organization.findUnique({
      where: { id: organizationId }
    })) as { taxId?: string | null; nif?: string | null } | null;
    if (!row) return "—";
    return row.taxId ?? row.nif ?? "—";
  } catch {
    return "—";
  }
}

export async function exportPeriodA3Format(input: {
  context: UserContext;
  periodId: string;
  correlationId: string;
}): Promise<PayrollExportResult> {
  requirePermissions(input.context, ["accounting.journal.post"]);

  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new Error("Payroll period was not found.");
  if (period.status === "open") {
    throw new Error(`Payroll period ${period.periodCode} has not been calculated yet.`);
  }

  const [{ slips, profiles }, employerNif] = await Promise.all([
    gatherSlips(period.id),
    lookupEmployerNif(period.organizationId)
  ]);

  const lines = slips.map((slip) => {
    const profile = profiles.get(slip.staffProfileId);
    const employeeNif = profile?.employeeCode ?? "—";
    const employeeName = profile?.employeeCode ?? slip.staffProfileId;
    return [
      sanitizePipe(employerNif),
      sanitizePipe(employeeNif),
      sanitizePipe(employeeName),
      period.periodCode,
      fmtEuro(decimalToNumber(slip.grossSalary)),
      fmtEuro(decimalToNumber(slip.irpfRetention)),
      fmtEuro(decimalToNumber(slip.ssEmployee)),
      fmtEuro(decimalToNumber(slip.ssEmployer)),
      fmtEuro(decimalToNumber(slip.netSalary))
    ].join("|");
  });
  const text = lines.length ? lines.join("\n") + "\n" : "";

  const result = await markExported(input, period, "a3", slips.length);
  return {
    ...result,
    text,
    filename: `payroll-${period.periodCode}-a3.txt`,
    contentType: "text/plain"
  };
}

export async function exportPeriodSageFormat(input: {
  context: UserContext;
  periodId: string;
  correlationId: string;
}): Promise<PayrollExportResult> {
  requirePermissions(input.context, ["accounting.journal.post"]);

  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new Error("Payroll period was not found.");
  if (period.status === "open") {
    throw new Error(`Payroll period ${period.periodCode} has not been calculated yet.`);
  }

  const { slips, profiles } = await gatherSlips(period.id);

  const header = "Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net";
  const rows = slips.map((slip) => {
    const profile = profiles.get(slip.staffProfileId);
    const employeeLabel = profile?.employeeCode ?? slip.staffProfileId;
    return [
      sanitizeCsv(employeeLabel),
      sanitizeCsv(period.periodCode),
      fmtEuro(decimalToNumber(slip.grossSalary)),
      fmtEuro(decimalToNumber(slip.irpfRetention)),
      fmtEuro(decimalToNumber(slip.ssEmployee)),
      fmtEuro(decimalToNumber(slip.ssEmployer)),
      fmtEuro(decimalToNumber(slip.netSalary))
    ].join(",");
  });
  const text = [header, ...rows].join("\n") + (rows.length ? "\n" : "");

  const result = await markExported(input, period, "sage", slips.length);
  return {
    ...result,
    text,
    filename: `payroll-${period.periodCode}-sage.csv`,
    contentType: "text/csv"
  };
}

async function markExported(
  input: { context: UserContext; periodId: string; correlationId: string },
  period: NonNullable<Awaited<ReturnType<typeof prisma.payrollPeriod.findUnique>>>,
  format: PayrollExportFormat,
  slipCount: number
): Promise<PayrollExportResult> {
  const exportedAt = new Date();
  const updated = await prisma.payrollPeriod.update({
    where: { id: period.id },
    data: { status: "exported", exportedAt }
  });

  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_PERIOD_EXPORTED",
    entityType: "payroll_period",
    entityId: period.id,
    afterJson: { format, slipCount, exportedAt: exportedAt.toISOString() },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? "",
    entityType: "payroll_period",
    entityId: period.id,
    eventType: "PayrollPeriodExported",
    payload: {
      periodCode: period.periodCode,
      format,
      slipCount
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    periodId: updated.id,
    periodCode: updated.periodCode,
    format,
    filename: "",
    contentType: "text/plain",
    text: "",
    slipCount,
    exportedAt: exportedAt.toISOString()
  };
}
