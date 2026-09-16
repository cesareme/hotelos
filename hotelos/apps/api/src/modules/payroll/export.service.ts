import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { resolveLegalIdentity, type LegalIdentity } from "../../lib/finance-scope.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { money } from "../treasury/money.js";
import { PAYROLL_EXPORT_KEYS, requireAnyPermission } from "../treasury/permissions.js";

// ---- Payroll export to the gestoría (lote tesoreria-banca) ----
//
// Formats:
//   · csv   — CSV universal (;, UTF-8 BOM, decimal comma) with one row per
//             slip: periodo;empleado;codigo_empleado;nif_empleado;dias;bruto;
//             irpf_pct;irpf;ss_trabajador;ss_empresa;neto;nif_empresa;ccc
//   · a3    — «compatible A3 Nóminas» pipe-delimited text (the official A3
//             fixed-width layout is NOT implemented: validateWithAdvisor).
//             First column = employer NIF.
//   · sage  — «compatible Sage / Holded» CSV with header (idem).
//
// Building an export is a READ (GET keeps returning the text without touching
// state). Marking the period as exported (`exportedAt`, status `exported`) is
// a mutation and lives behind the POST route (`exportPeriod` with
// `markExported: true`). Employee NIF is not stored on StaffProfile /
// EmploymentContract: the column carries the employee code and the export says
// so instead of inventing one.
//
// Employer (Tanda 6b · L4, design §5.2 R1/R2 and §4 #12): the NIF and razón
// social are the sociedad's — `resolveLegalIdentity` (lib/finance-scope.ts),
// never `Organization.taxId` — and the código de cuenta de cotización comes
// from the period's work centre (`Property.socialSecurityCcc`, the provincial
// CCC of that hotel / office) or, for an organisation-wide period or a centre
// without one, from `LegalEntity.cccPrincipal` (RD 84/1996 arts. 13.3, 17).
// Anfitorio informs the gestoría; it never files with the TGSS.

export type PayrollExportFormat = "a3" | "sage" | "csv";

/** Employer block of the export (JSON) — also printed in the CSV / A3 text. */
export type PayrollEmployer = {
  legalEntityId: string | null;
  legalName: string;
  /** Normalised NIF of the sociedad or null («NIF pendiente»). */
  taxId: string | null;
  taxIdValid: boolean;
  /** `organization_fallback` = tenant whose implicit legal entity is not backfilled yet. */
  identitySource: LegalIdentity["source"];
  /** Work centre of the period (null = organisation-wide period). */
  workCenterId: string | null;
  /** Código de cuenta de cotización: the centre's provincial CCC, else the entity's principal. */
  ccc: string | null;
  cccSource: "work_center" | "legal_entity" | null;
};

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
  employer: PayrollEmployer;
};

export type PayrollExportSlip = {
  id: string;
  staffProfileId: string;
  grossSalary: Prisma.Decimal | string | number;
  irpfRetention: Prisma.Decimal | string | number;
  ssEmployee: Prisma.Decimal | string | number;
  ssEmployer: Prisma.Decimal | string | number;
  netSalary: Prisma.Decimal | string | number;
  daysWorked: number;
};

export type PayrollExportEmployee = { code: string; name: string; nif: string };

export const PAYROLL_CSV_HEADER = "periodo;empleado;codigo_empleado;nif_empleado;dias;bruto;irpf_pct;irpf;ss_trabajador;ss_empresa;neto;nif_empresa;ccc";
export const PAYROLL_SAGE_HEADER = "Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net";

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

async function gatherSlips(periodId: string): Promise<{ slips: SlipRow[]; employees: Map<string, PayrollExportEmployee> }> {
  const slips = await prisma.payrollSlip.findMany({ where: { periodId }, orderBy: { createdAt: "asc" } });
  const profileIds = Array.from(new Set(slips.map((s) => s.staffProfileId)));
  const profiles = profileIds.length ? await prisma.staffProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, employeeCode: true, userId: true } }) : [];
  const userIds = Array.from(new Set(profiles.map((p) => p.userId)));
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const employees = new Map<string, PayrollExportEmployee>();
  for (const profile of profiles) {
    employees.set(profile.id, {
      code: profile.employeeCode ?? profile.id,
      name: userById.get(profile.userId)?.fullName ?? profile.employeeCode ?? profile.id,
      nif: "" // not stored: the gestoría completes it (see module header)
    });
  }
  return { slips, employees };
}

// ---- Employer -----------------------------------------------------------------

/** Pure: employer block from the legal identity and the centre's CCC (unit-tested). */
export function buildPayrollEmployer(
  identity: Pick<LegalIdentity, "legalEntityId" | "legalName" | "taxId" | "taxIdValid" | "source" | "cccPrincipal">,
  workCenterId: string | null,
  workCenterCcc: string | null
): PayrollEmployer {
  const centreCcc = workCenterCcc?.trim() || null;
  const principal = identity.cccPrincipal?.trim() || null;
  return {
    legalEntityId: identity.legalEntityId,
    legalName: identity.legalName,
    taxId: identity.taxId,
    taxIdValid: identity.taxIdValid,
    identitySource: identity.source,
    workCenterId,
    ccc: centreCcc ?? principal,
    cccSource: centreCcc ? "work_center" : principal ? "legal_entity" : null
  };
}

/** Employer of a payroll period: sociedad identity + CCC of its work centre (or the principal one). */
export async function resolvePayrollEmployer(organizationId: string, workCenterId: string | null): Promise<PayrollEmployer> {
  const identity = await resolveLegalIdentity(organizationId);
  if (!identity) throw new NotFoundError("La organización no existe.");
  const centre = workCenterId ? await prisma.property.findUnique({ where: { id: workCenterId }, select: { organizationId: true, socialSecurityCcc: true } }) : null;
  const centreCcc = centre && centre.organizationId === organizationId ? centre.socialSecurityCcc : null;
  return buildPayrollEmployer(identity, workCenterId, centreCcc ?? null);
}

/** Warnings about the employer block (Spanish, one per gap). Pure. */
export function employerWarnings(employer: PayrollEmployer): string[] {
  const warnings: string[] = [];
  if (!employer.taxId) warnings.push("La sociedad no tiene NIF: columna nif_empresa vacía. Complétalo en Configuración › Estructura societaria › Datos fiscales.");
  else if (!employer.taxIdValid) warnings.push(`El NIF de la sociedad (${employer.taxId}) no supera el dígito de control: revísalo en Configuración › Estructura societaria › Datos fiscales.`);
  if (employer.identitySource === "organization_fallback") warnings.push("La organización aún no tiene sociedad dada de alta (backfill pendiente): la identidad del empleador se toma de la organización.");
  if (!employer.ccc) warnings.push("Sin código de cuenta de cotización (CCC) en el centro ni en la sociedad: la gestoría lo completa.");
  return warnings;
}

// ---- Rendering (pure) -----------------------------------------------------------

/** Pure text rendering of the three layouts (unit-tested without a database). */
export function renderPayrollExport(input: {
  periodCode: string;
  format: PayrollExportFormat;
  slips: readonly PayrollExportSlip[];
  employees: ReadonlyMap<string, PayrollExportEmployee>;
  employer: PayrollEmployer;
  /** slipId → "15" (IRPF % printed in the CSV universal). */
  irpfPctBySlip?: ReadonlyMap<string, string>;
}): { text: string; filename: string; contentType: string } {
  const nif = input.employer.taxId ?? "";
  const ccc = input.employer.ccc ?? "";
  const employee = (slip: PayrollExportSlip): PayrollExportEmployee => input.employees.get(slip.staffProfileId) ?? { code: slip.staffProfileId, name: slip.staffProfileId, nif: "" };

  if (input.format === "a3") {
    const lines = input.slips.map((slip) => {
      const e = employee(slip);
      return [sanitizePipe(nif), sanitizePipe(e.nif || e.code), sanitizePipe(e.name), input.periodCode, money(slip.grossSalary), money(slip.irpfRetention), money(slip.ssEmployee), money(slip.ssEmployer), money(slip.netSalary)].join("|");
    });
    return { text: lines.length ? `${lines.join("\n")}\n` : "", filename: `nominas-${input.periodCode}-a3.txt`, contentType: "text/plain" };
  }
  if (input.format === "sage") {
    const rows = input.slips.map((slip) => {
      const e = employee(slip);
      return [sanitizeCsv(e.code), sanitizeCsv(input.periodCode), money(slip.grossSalary), money(slip.irpfRetention), money(slip.ssEmployee), money(slip.ssEmployer), money(slip.netSalary)].join(",");
    });
    return { text: `${[PAYROLL_SAGE_HEADER, ...rows].join("\n")}${rows.length ? "\n" : ""}`, filename: `nominas-${input.periodCode}-sage.csv`, contentType: "text/csv" };
  }
  const rows = input.slips.map((slip) => {
    const e = employee(slip);
    return [
      input.periodCode,
      sanitizeCsv(e.name, ";"),
      sanitizeCsv(e.code, ";"),
      e.nif,
      String(slip.daysWorked),
      commaDecimal(slip.grossSalary),
      (input.irpfPctBySlip?.get(slip.id) ?? "").replace(".", ","),
      commaDecimal(slip.irpfRetention),
      commaDecimal(slip.ssEmployee),
      commaDecimal(slip.ssEmployer),
      commaDecimal(slip.netSalary),
      sanitizeCsv(nif, ";"),
      sanitizeCsv(ccc, ";")
    ].join(";");
  });
  return { text: `﻿${[PAYROLL_CSV_HEADER, ...rows].join("\n")}\n`, filename: `nominas-${input.periodCode}.csv`, contentType: "text/csv" };
}

// ---- Service -------------------------------------------------------------------

/** Read-only: builds the export text of a period (no state change). */
export async function buildPayrollExport(periodId: string, format: PayrollExportFormat): Promise<PayrollExportResult> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new NotFoundError("El periodo de nómina no existe.");
  if (period.status === "open") throw new ConflictError(`El periodo ${period.periodCode} todavía no está calculado.`, { code: "PAYROLL_PERIOD_NOT_CALCULATED" });
  const [{ slips, employees }, employer] = await Promise.all([gatherSlips(period.id), resolvePayrollEmployer(period.organizationId, period.propertyId ?? null)]);
  const warnings: string[] = ["Formato compatible, no el diseño de registro oficial: validar con la gestoría.", ...employerWarnings(employer)];
  warnings.push("El NIF del empleado no se almacena en HotelOS: la columna lleva el código de empleado.");

  let irpfPctBySlip: Map<string, string> | undefined;
  if (format === "csv" && slips.length) {
    const lineRows = await prisma.payrollLine.findMany({ where: { slipId: { in: slips.map((s) => s.id) }, code: "irpf" }, select: { slipId: true, description: true } });
    irpfPctBySlip = new Map(lineRows.map((l) => [l.slipId, /([\d.,]+)\s*%/.exec(l.description ?? "")?.[1] ?? ""]));
  }
  const rendered = renderPayrollExport({ periodCode: period.periodCode, format, slips, employees, employer, irpfPctBySlip });
  return {
    periodId: period.id,
    periodCode: period.periodCode,
    format,
    filename: rendered.filename,
    contentType: rendered.contentType,
    text: rendered.text,
    slipCount: slips.length,
    exportedAt: period.exportedAt?.toISOString() ?? null,
    validateWithAdvisor: true,
    warnings,
    employer
  };
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
    afterJson: { format: input.format, slipCount: result.slipCount, exportedAt: exportedAt.toISOString(), employer: { legalEntityId: result.employer.legalEntityId, taxId: result.employer.taxId, ccc: result.employer.ccc } },
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
