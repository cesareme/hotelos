// Incidencias del mes para la gestoría (Tanda RRHH · RRHH-6; diseño
// docs/design/RRHH-PLANTILLA-NOMINA.md §7.1 «exportación de incidencias»).
//
// `GET /payroll/incidences?period=YYYY-MM[&propertyId][&format=csv]` reúne, para
// el mes pedido, lo que la gestoría necesita para confeccionar la nómina en
// modo externo (PayrollPeriod.mode = external):
//   · altas           — Employee.hiredAt dentro del mes (código = modalidad del
//                       contrato vigente, o `sin_contrato`);
//   · bajas           — Employee.terminatedAt dentro del mes (código = causa);
//   · cambios         — contrato que empieza en el mes para una persona contratada
//                       antes (código = modalidad) y contrato que termina en el mes
//                       sin baja del expediente (código = `fin_<causa>`);
//   · ausencias       — AbsenceRequest APROBADAS que solapan el mes, por tipo y
//                       días dentro del mes (IT, vacaciones, permisos…);
//   · horas extra     — vocabulario previsto (PAYROLL_INCIDENCE_KINDS) sin origen
//                       todavía: WorkdayRecord queda fuera de la tanda, así que no
//                       se genera ninguna fila `overtime` (nunca un 0 inventado).
// La persona se identifica por número de empleado y nombre: NUNCA NIF, NAF,
// correo, teléfono ni IBAN (ni en el JSON ni en el CSV). Las ausencias de
// fichas sin expediente (StaffProfile.employeeId null) no caben en la fila y se
// cuentan en `warnings`.
//
// Permiso: workforce.payroll_export (payroll_hr). Ámbito: con `propertyId` el
// centro debe estar en el ámbito del actor (404 opaco PROPERTY_NOT_FOUND); sin
// él, toda la sociedad (accounting.entity.read o ámbito de organización; si no,
// 404 ENTITY_SCOPE_REQUIRED, misma regla que el informe de coste).
//
// CSV: `;`, UTF-8 con BOM, decimales con coma, valores saneados (sin `;`, comillas
// ni saltos); nombre `incidencias-<periodo>[-<centro>].csv`; el navegador lo
// descarga con `downloadText` (patrón de la exportación de nóminas).

import { prisma } from "@hotelos/database";
import type { HrAuditAction, PayrollIncidenceKind, PayrollIncidenceRow, PayrollIncidencesDto, PermissionKey } from "@hotelos/shared";
import { assertFinanceReadScope, propertyWithinScope } from "../../lib/finance-scope.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requireAnyPermission } from "../treasury/permissions.js";

export const PAYROLL_INCIDENCES_KEYS: PermissionKey[] = ["workforce.payroll_export"];
export const PAYROLL_INCIDENCES_CSV_HEADER = "centro;numero_empleado;empleado;tipo;codigo;desde;hasta;dias;horas;detalle";
export const PAYROLL_INCIDENCES_AUDIT_ACTION = "PAYROLL_INCIDENCES_EXPORTED" satisfies HrAuditAction;

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const MS_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Dependencias (inyectables en los tests unitarios; por defecto Prisma)
// ---------------------------------------------------------------------------

export type IncidencePropertyRow = { id: string; code: string | null; name: string; organizationId: string };
export type IncidenceEmployeeRow = {
  id: string;
  organizationId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  primaryPropertyId: string | null;
  status: string;
  hiredAt: Date;
  terminatedAt: Date | null;
  terminationReason: string | null;
};
export type IncidenceProfileRow = { id: string; employeeId: string | null; propertyId: string; employeeCode: string | null };
export type IncidenceContractRow = {
  id: string;
  staffProfileId: string;
  propertyId: string | null;
  contractType: string;
  startDate: Date;
  endDate: Date | null;
  endReason: string | null;
  active: boolean;
  weeklyHours: unknown;
  partTimePct: unknown;
  fixedDiscontinuous: boolean;
};
export type IncidenceAbsenceRow = { id: string; propertyId: string; staffProfileId: string; absenceType: string; startDate: Date; endDate: Date; status: string };

export type IncidenceDeps = {
  db: {
    property: { findMany(args: { where: { organizationId: string; id?: string }; select: { id: true; code: true; name: true; organizationId: true } }): Promise<IncidencePropertyRow[]> };
    employee: { findMany(args: { where: { organizationId: string }; select: Record<string, true> }): Promise<IncidenceEmployeeRow[]> };
    staffProfile: { findMany(args: { where: { propertyId: { in: string[] } }; select: { id: true; employeeId: true; propertyId: true; employeeCode: true } }): Promise<IncidenceProfileRow[]> };
    employmentContract: { findMany(args: { where: { staffProfileId: { in: string[] } }; select: Record<string, true> }): Promise<IncidenceContractRow[]> };
    absenceRequest: { findMany(args: { where: { propertyId: { in: string[] }; status: string; startDate: { lte: Date }; endDate: { gte: Date } }; select: Record<string, true> }): Promise<IncidenceAbsenceRow[]> };
  };
  audit: typeof recordAuditEvent;
  now: () => Date;
};

export const defaultIncidenceDeps: IncidenceDeps = {
  db: prisma as unknown as IncidenceDeps["db"],
  audit: recordAuditEvent,
  now: () => new Date()
};

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

export function parseIncidencePeriod(value: unknown): { periodCode: string; start: Date; end: Date } {
  if (typeof value !== "string" || !PERIOD.test(value)) {
    const error = new BadRequestError("period debe tener el formato YYYY-MM.");
    error.details = { code: "VALIDATION_ERROR", field: "period" };
    throw error;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return { periodCode: value, start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 0)) };
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const dayUtc = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const within = (date: Date | null | undefined, start: Date, end: Date): boolean => date instanceof Date && date.getTime() >= start.getTime() && date.getTime() <= end.getTime();

/** Días naturales (inclusive) del solape entre [from, to] y el mes; 0 si no solapan. */
export function overlapDays(from: Date, to: Date, start: Date, end: Date): number {
  const a = Math.max(dayUtc(from).getTime(), start.getTime());
  const b = Math.min(dayUtc(to).getTime(), end.getTime());
  if (b < a) return 0;
  return Math.round((b - a) / MS_DAY) + 1;
}

function decimalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function sanitizeCsv(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const clean = String(value).replace(/[\r\n]+/g, " ").trim();
  return /[";]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

const KIND_ORDER: Record<PayrollIncidenceKind, number> = { hire: 0, termination: 1, contract_change: 2, absence: 3, overtime: 4 };

/** CSV `;` con BOM y decimales con coma; misma fila que `PayrollIncidenceRow` (sin ningún dato personal cifrado). */
export function renderIncidencesCsv(rows: readonly PayrollIncidenceRow[]): string {
  const lines = rows.map((row) =>
    [
      row.propertyCode ?? row.propertyId,
      row.employeeNumber,
      row.employeeName,
      row.kind,
      row.code,
      row.from,
      row.to ?? "",
      row.days === null ? "" : String(row.days),
      row.hours === null ? "" : row.hours.replace(".", ","),
      row.detail ?? ""
    ]
      .map(sanitizeCsv)
      .join(";")
  );
  return `﻿${[PAYROLL_INCIDENCES_CSV_HEADER, ...lines].join("\n")}\n`;
}

export function incidencesFilename(periodCode: string, propertyCode: string | null): string {
  const centre = propertyCode ? `-${propertyCode.toLowerCase().replace(/[^a-z0-9]+/g, "")}` : "";
  return `incidencias-${periodCode}${centre}.csv`;
}

/** Filas del mes a partir de las tablas ya cargadas (pura: sin base de datos). */
export function buildIncidenceRows(input: {
  start: Date;
  end: Date;
  properties: readonly IncidencePropertyRow[];
  employees: readonly IncidenceEmployeeRow[];
  profiles: readonly IncidenceProfileRow[];
  contracts: readonly IncidenceContractRow[];
  absences: readonly IncidenceAbsenceRow[];
}): { rows: PayrollIncidenceRow[]; warnings: string[] } {
  const { start, end } = input;
  const propertyById = new Map(input.properties.map((p) => [p.id, p]));
  const employeeById = new Map(input.employees.map((e) => [e.id, e]));
  const profileById = new Map(input.profiles.map((p) => [p.id, p]));
  const contractsByEmployee = new Map<string, IncidenceContractRow[]>();
  for (const contract of input.contracts) {
    const employeeId = profileById.get(contract.staffProfileId)?.employeeId;
    if (!employeeId) continue;
    const list = contractsByEmployee.get(employeeId) ?? [];
    list.push(contract);
    contractsByEmployee.set(employeeId, list);
  }
  const rows: PayrollIncidenceRow[] = [];
  const warnings: string[] = [];

  const base = (employee: IncidenceEmployeeRow, propertyId: string | null): Pick<PayrollIncidenceRow, "propertyId" | "propertyCode" | "employeeId" | "employeeNumber" | "employeeName"> => {
    const property = propertyId ? propertyById.get(propertyId) : undefined;
    return {
      propertyId: propertyId ?? employee.primaryPropertyId ?? "",
      propertyCode: property?.code ?? null,
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      employeeName: `${employee.firstName} ${employee.lastName}`.trim()
    };
  };

  for (const employee of input.employees) {
    const contracts = (contractsByEmployee.get(employee.id) ?? []).slice().sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    const contractAt = (date: Date): IncidenceContractRow | undefined =>
      contracts.find((c) => c.startDate.getTime() <= date.getTime() && (c.endDate === null || c.endDate.getTime() >= date.getTime())) ?? contracts.find((c) => c.active);
    const jornada = (contract: IncidenceContractRow | undefined): string | null => {
      if (!contract) return null;
      const parts: string[] = [];
      const hours = decimalText(contract.weeklyHours);
      const pct = decimalText(contract.partTimePct);
      if (hours) parts.push(`${hours.replace(".", ",")} h/sem`);
      if (pct && pct !== "100.00") parts.push(`${pct.replace(".", ",")} % jornada`);
      if (contract.fixedDiscontinuous) parts.push("fijo discontinuo");
      return parts.length > 0 ? parts.join(" · ") : null;
    };

    if (within(employee.hiredAt, start, end)) {
      const contract = contractAt(employee.hiredAt);
      rows.push({ ...base(employee, contract?.propertyId ?? employee.primaryPropertyId), kind: "hire", code: contract?.contractType ?? "sin_contrato", from: isoDay(employee.hiredAt), to: contract?.endDate ? isoDay(contract.endDate) : null, days: null, hours: decimalText(contract?.weeklyHours), detail: jornada(contract) });
    }
    const terminatedInMonth = within(employee.terminatedAt, start, end);
    if (terminatedInMonth && employee.terminatedAt) {
      const contract = contractAt(employee.terminatedAt);
      rows.push({ ...base(employee, contract?.propertyId ?? employee.primaryPropertyId), kind: "termination", code: employee.terminationReason ?? "other", from: isoDay(employee.terminatedAt), to: null, days: null, hours: null, detail: contract ? `contrato ${contract.contractType}` : null });
    }
    for (const contract of contracts) {
      const startsInMonth = within(contract.startDate, start, end) && contract.startDate.getTime() > employee.hiredAt.getTime();
      if (startsInMonth) {
        rows.push({ ...base(employee, contract.propertyId), kind: "contract_change", code: contract.contractType, from: isoDay(contract.startDate), to: contract.endDate ? isoDay(contract.endDate) : null, days: null, hours: decimalText(contract.weeklyHours), detail: jornada(contract) });
      }
      if (contract.endDate && within(contract.endDate, start, end) && !terminatedInMonth) {
        rows.push({ ...base(employee, contract.propertyId), kind: "contract_change", code: `fin_${contract.endReason ?? "end_of_term"}`, from: isoDay(contract.endDate), to: null, days: null, hours: null, detail: `fin del contrato ${contract.contractType}` });
      }
    }
  }

  let unlinked = 0;
  for (const absence of input.absences) {
    if (absence.status !== "approved") continue;
    const days = overlapDays(absence.startDate, absence.endDate, start, end);
    if (days === 0) continue;
    const profile = profileById.get(absence.staffProfileId);
    const employee = profile?.employeeId ? employeeById.get(profile.employeeId) : undefined;
    if (!employee) {
      unlinked += 1;
      continue;
    }
    const from = new Date(Math.max(dayUtc(absence.startDate).getTime(), start.getTime()));
    const to = new Date(Math.min(dayUtc(absence.endDate).getTime(), end.getTime()));
    rows.push({ ...base(employee, absence.propertyId), kind: "absence", code: absence.absenceType, from: isoDay(from), to: isoDay(to), days, hours: null, detail: null });
  }
  if (unlinked > 0) warnings.push(`${unlinked} ausencia(s) aprobada(s) de fichas sin expediente no se han podido atribuir a una persona.`);

  rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.employeeNumber.localeCompare(b.employeeNumber, "es") || a.from.localeCompare(b.from));
  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type PayrollIncidencesResult = PayrollIncidencesDto & { propertyCode: string | null; warnings: string[] };

export async function buildPayrollIncidences(
  input: { context: UserContext; periodCode: string; propertyId?: string | null; correlationId?: string },
  deps: IncidenceDeps = defaultIncidenceDeps
): Promise<PayrollIncidencesResult> {
  requireAnyPermission(input.context, PAYROLL_INCIDENCES_KEYS);
  const { periodCode, start, end } = parseIncidencePeriod(input.periodCode);
  const organizationId = input.context.organizationId;
  const propertyId = input.propertyId ?? null;

  // Ámbito: centro dentro del ámbito o toda la sociedad (404 opaco en ambos casos si no).
  assertFinanceReadScope(input.context, propertyId);
  const organizationProperties = await deps.db.property.findMany({ where: { organizationId, ...(propertyId ? { id: propertyId } : {}) }, select: { id: true, code: true, name: true, organizationId: true } });
  const properties = organizationProperties.filter((property) => propertyWithinScope(input.context, property.id));
  if (propertyId && properties.length === 0) {
    const error = new NotFoundError("No se encuentra el centro.");
    error.details = { code: "PROPERTY_NOT_FOUND" };
    throw error;
  }
  const propertyIds = properties.map((property) => property.id);

  const employeesAll = await deps.db.employee.findMany({
    where: { organizationId },
    select: { id: true, organizationId: true, employeeNumber: true, firstName: true, lastName: true, primaryPropertyId: true, status: true, hiredAt: true, terminatedAt: true, terminationReason: true }
  });
  // Con centro: expedientes del centro (o sin centro cuya ficha cuelga de él); sin centro: todos los de la sociedad en ámbito.
  const profiles = propertyIds.length > 0 ? await deps.db.staffProfile.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true, employeeId: true, propertyId: true, employeeCode: true } }) : [];
  const employeeIdsByProfile = new Set(profiles.map((profile) => profile.employeeId).filter((id): id is string => typeof id === "string"));
  const employees = employeesAll.filter((employee) => {
    if (propertyId) return employee.primaryPropertyId === propertyId || employeeIdsByProfile.has(employee.id);
    return employee.primaryPropertyId === null || propertyIds.includes(employee.primaryPropertyId) || employeeIdsByProfile.has(employee.id);
  });
  const contracts =
    profiles.length > 0
      ? await deps.db.employmentContract.findMany({
          where: { staffProfileId: { in: profiles.map((profile) => profile.id) } },
          select: { id: true, staffProfileId: true, propertyId: true, contractType: true, startDate: true, endDate: true, endReason: true, active: true, weeklyHours: true, partTimePct: true, fixedDiscontinuous: true }
        })
      : [];
  const absences =
    propertyIds.length > 0
      ? await deps.db.absenceRequest.findMany({
          where: { propertyId: { in: propertyIds }, status: "approved", startDate: { lte: end }, endDate: { gte: start } },
          select: { id: true, propertyId: true, staffProfileId: true, absenceType: true, startDate: true, endDate: true, status: true }
        })
      : [];

  const { rows, warnings } = buildIncidenceRows({ start, end, properties, employees, profiles, contracts, absences });
  const generatedAt = deps.now().toISOString();
  deps.audit({
    organizationId,
    propertyId: propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: PAYROLL_INCIDENCES_AUDIT_ACTION,
    entityType: "payroll_incidences",
    entityId: `${periodCode}:${propertyId ?? "entity"}`,
    // Solo recuentos: nunca nombres, números de empleado ni datos personales.
    afterJson: { periodCode, propertyId, properties: propertyIds.length, rows: rows.length, byKind: Object.fromEntries((Object.keys(KIND_ORDER) as PayrollIncidenceKind[]).map((kind) => [kind, rows.filter((row) => row.kind === kind).length])), warnings: warnings.length },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return { periodCode, propertyId, propertyCode: propertyId ? (properties[0]?.code ?? null) : null, rows, generatedAt, warnings };
}
