import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { money } from "../treasury/money.js";
import { PAYROLL_EXPORT_KEYS, requireAnyPermission } from "../treasury/permissions.js";

// ---- Payroll export to the gestoría (lote tesoreria-banca) ----
//
// Formats:
//   · csv   — CSV universal (;, UTF-8 BOM, decimal comma) with one row per
//             slip: periodo;empleado;nif;dias;bruto;irpf_pct;irpf;ss_trabajador;ss_empresa;neto
//   · a3    — «compatible A3 Nóminas» pipe-delimited text (the official A3
//             fixed-width layout is NOT implemented: validateWithAdvisor).
//   · sage  — «compatible Sage / Holded» CSV with header (idem).
//
// Building an export is a READ (GET keeps returning the text without touching
// state). Marking the period as exported (`exportedAt`, status `exported`) is
// a mutation and lives behind the POST route (`exportPeriod` with
// `markExported: true`). Employee NIF is not stored on StaffProfile /
// EmploymentContract: the column carries the employee code and the export says
// so instead of inventing one.

export type PayrollExportFormat = "a3" | "sage" | "csv";

export type PayrollExportResult = {
  periodId: string;
  periodCode: string;
  format: PayrollExportFormat;
  filename: string;
  contentType: string;
  text: string;
  slipCount: number;
  exportedAt: string | null;
  /** Always true: neither layout is the official one of the gestoría's software. */
  validateWithAdvisor: boolean;
  warnings: string[];
};

function sanitizePipe(value: string): string {
  return value.replace(/[|\r\n]+/g, " ").trim();
}

function sanitizeCsv(value: string, sep = ","): string {
  if (new RegExp(`["${sep}\\r\\n]`).test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function commaDecimal(value: unknown): string {
  return money(value as string).replace(".", ",");
}

type SlipRow = NonNullable<Awaited<ReturnType<typeof prisma.payrollSlip.findFirst>>>;
type EmployeeInfo = { code: string; name: string; nif: string };

async function gatherSlips(periodId: string): Promise<{ slips: SlipRow[]; employees: Map<string, EmployeeInfo> }> {
  const slips = await prisma.payrollSlip.findMany({ where: { periodId }, orderBy: { createdAt: "asc" } });
  const profileIds = Array.from(new Set(slips.map((s) => s.staffProfileId)));
  const profiles = profileIds.length ? await prisma.staffProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, employeeCode: true, userId: true } }) : [];
  const userIds = Array.from(new Set(profiles.map((p) => p.userId)));
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const employees = new Map<string, EmployeeInfo>();
  for (const profile of profiles) {
    employees.set(profile.id, {
      code: profile.employeeCode ?? profile.id,
      name: userById.get(profile.userId)?.fullName ?? profile.employeeCode ?? profile.id,
      nif: "" // not stored: the gestoría completes it (see module header)
    });
  }
  return { slips, employees };
}

async function employerNif(organizationId: string): Promise<string> {
  const row = await prisma.organization.findUnique({ where: { id: organizationId }, select: { taxId: true } });
  return row?.taxId ?? "";
}

/** Read-only: builds the export text of a period (no state change). */
export async function buildPayrollExport(periodId: string, format: PayrollExportFormat): Promise<PayrollExportResult> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
  if (period.status === "open") throw new ConflictError(`El periodo ${period.periodCode} todavía no está calculado.`, { code: "PAYROLL_PERIOD_NOT_CALCULATED" });
  const [{ slips, employees }, nif] = await Promise.all([gatherSlips(period.id), employerNif(period.organizationId)]);
  const warnings: string[] = ["Formato compatible, no el diseño de registro oficial: validar con la gestoría."];
  if (!nif) warnings.push("La organización no tiene NIF configurado: columna nif_empresa vacía.");
  warnings.push("El NIF del empleado no se almacena en HotelOS: la columna lleva el código de empleado.");

  const employee = (slip: SlipRow): EmployeeInfo => employees.get(slip.staffProfileId) ?? { code: slip.staffProfileId, name: slip.staffProfileId, nif: "" };

  let text: string;
  let filename: string;
  let contentType: string;
  if (format === "a3") {
    const lines = slips.map((slip) => {
      const e = employee(slip);
      return [sanitizePipe(nif), sanitizePipe(e.nif || e.code), sanitizePipe(e.name), period.periodCode, money(slip.grossSalary), money(slip.irpfRetention), money(slip.ssEmployee), money(slip.ssEmployer), money(slip.netSalary)].join("|");
    });
    text = lines.length ? `${lines.join("\n")}\n` : "";
    filename = `nominas-${period.periodCode}-a3.txt`;
    contentType = "text/plain";
  } else if (format === "sage") {
    const header = "Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net";
    const rows = slips.map((slip) => {
      const e = employee(slip);
      return [sanitizeCsv(e.code), sanitizeCsv(period.periodCode), money(slip.grossSalary), money(slip.irpfRetention), money(slip.ssEmployee), money(slip.ssEmployer), money(slip.netSalary)].join(",");
    });
    text = `${[header, ...rows].join("\n")}${rows.length ? "\n" : ""}`;
    filename = `nominas-${period.periodCode}-sage.csv`;
    contentType = "text/csv";
  } else {
    const header = "periodo;empleado;codigo_empleado;nif_empleado;dias;bruto;irpf_pct;irpf;ss_trabajador;ss_empresa;neto";
    const lineRows = slips.length ? await prisma.payrollLine.findMany({ where: { slipId: { in: slips.map((s) => s.id) }, code: "irpf" }, select: { slipId: true, description: true } }) : [];
    const irpfPctBySlip = new Map(lineRows.map((l) => [l.slipId, /([\d.,]+)\s*%/.exec(l.description ?? "")?.[1] ?? ""]));
    const rows = slips.map((slip) => {
      const e = employee(slip);
      return [period.periodCode, sanitizeCsv(e.name, ";"), sanitizeCsv(e.code, ";"), e.nif, String(slip.daysWorked), commaDecimal(slip.grossSalary), (irpfPctBySlip.get(slip.id) ?? "").replace(".", ","), commaDecimal(slip.irpfRetention), commaDecimal(slip.ssEmployee), commaDecimal(slip.ssEmployer), commaDecimal(slip.netSalary)].join(";");
    });
    text = `﻿${[header, ...rows].join("\n")}\n`;
    filename = `nominas-${period.periodCode}.csv`;
    contentType = "text/csv";
  }
  return { periodId: period.id, periodCode: period.periodCode, format, filename, contentType, text, slipCount: slips.length, exportedAt: period.exportedAt?.toISOString() ?? null, validateWithAdvisor: true, warnings };
}

export function normalisePayrollExportFormat(value: unknown): PayrollExportFormat {
  return value === "sage" ? "sage" : value === "csv" ? "csv" : "a3";
}

/** POST: builds the export and marks the period exported (audited). */
export async function exportPeriod(input: { context: UserContext; periodId: string; format: PayrollExportFormat; correlationId: string; markExported?: boolean }): Promise<PayrollExportResult> {
  requireAnyPermission(input.context, PAYROLL_EXPORT_KEYS);
  const result = await buildPayrollExport(input.periodId, input.format);
  if (input.markExported === false) return result;
  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
  const exportedAt = new Date();
  await prisma.payrollPeriod.update({
    where: { id: period.id },
    data: { exportedAt, ...(period.status === "calculated" ? { status: "exported" } : {}) }
  });
  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_PERIOD_EXPORTED",
    entityType: "payroll_period",
    entityId: period.id,
    afterJson: { format: input.format, slipCount: result.slipCount, exportedAt: exportedAt.toISOString() },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? "",
    entityType: "payroll_period",
    entityId: period.id,
    eventType: "PayrollPeriodExported",
    payload: { periodCode: period.periodCode, format: input.format, slipCount: result.slipCount } as Record<string, unknown>,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return { ...result, exportedAt: exportedAt.toISOString() };
}

/** Legacy GET entry points: now READ-ONLY (the GET route in server.ts no longer mutates). */
export async function exportPeriodA3Format(input: { context: UserContext; periodId: string; correlationId: string }): Promise<PayrollExportResult> {
  return buildPayrollExport(input.periodId, "a3");
}

export async function exportPeriodSageFormat(input: { context: UserContext; periodId: string; correlationId: string }): Promise<PayrollExportResult> {
  return buildPayrollExport(input.periodId, "sage");
}
