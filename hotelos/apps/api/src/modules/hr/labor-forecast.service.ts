// Previsión de plantilla · Tanda RRHH · RRHH-3 (diseño §5, §9 :289-290) — ÚNICO escritor de LaborForecast.
//
//   generateLaborForecast({ context, propertyId, from, to, correlationId, today? })   workforce.schedule.manage
//     drivers (drivers.service) × estándares vigentes cada día (standards.service) × jornada anual del
//     convenio del centro (Property.agreementId → AgreementRule annual_hours; sin convenio, 1.792 h con
//     entrada en `degraded[]`) → una fila por día × departamento USALI con `upsert` sobre la clave única
//     (propertyId, forecastDate, usaliDepartment): requiredLaborHours (el dashboard
//     dashboards/workforce.service.ts:223 sigue sumando esa columna por día: las filas por departamento
//     suman el total), requiredStaffCount = requiredFte (columna heredada), requiredFte, estimatedCost
//     (FTE × coste mensual medio por empleado del departamento del último lote `posted` de
//     payroll_cost_lines, si existe; si no null), source, driversJson, reasonJson (líneas de estándar),
//     generatedAt. Las filas del mismo día × centro que ya no proceden (departamento sin estándar) se
//     borran: la previsión es una foto. Ventana ≤ LABOR_FORECAST_MAX_DAYS (92). Auditoría HR_FORECAST_GENERATED.
//   listLaborForecast({ context, propertyId, from, to, today? })   workforce.read | workforce.schedule.manage | workforce.labor_cost.view | payroll.read
//     filas persistidas + tres columnas de comparación (D §5): plannedHours = Σ turnos del día por
//     departamento (StaffProfile.usaliDepartment; null si el centro no tiene cuadrante ese día),
//     availableFte = contratos activos × partTimePct − ausencias aprobadas del día, approvedFte = maxFte
//     del plan aprobado de la temporada (null sin plan). `degraded[]` explica lo que falta.
// Un día sin OTB ni previsión del PMS se persiste con requiredLaborHours/requiredFte null y source null
// (D §1.1: nunca deterministic-v1 sin OTB; nunca un 0 inventado).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { HrDegradedEntry, HrUsaliDepartment, LaborForecastDayDto, LaborForecastDepartment, LaborForecastDriversDto, LaborForecastSource } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { addDays, dayUtc, isoDate } from "../revenue/actuals.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { LABOR_FORECAST_MAX_DAYS, loadLaborDrivers } from "./drivers.service.js";
import { ANNUAL_HOURS_DEFAULT, computeLaborRequirement, estimateDailyCost, type EngineDrivers, type EngineRules } from "./labor-forecast.engine.js";
import { activeFteByDepartment, findApprovedStaffingPlan, type ActiveFteByDepartment } from "./staffing.service.js";
import { activeStandardsAt, hrForecastBadRequest, loadLaborStandards, requireHrProperty, toEngineStandard, type HrPropertyRow } from "./standards.service.js";

export const LABOR_FORECAST_READ_KEYS = ["workforce.read", "workforce.schedule.manage", "workforce.labor_cost.view", "payroll.read"] as const;

const MS_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}
const text2 = (n: number | null): string | null => (n === null ? null : n.toFixed(2));

export function parseForecastWindow(from: unknown, to: unknown, maxDays = LABOR_FORECAST_MAX_DAYS): { from: string; to: string; days: number } {
  if (typeof from !== "string" || !ISO_DATE.test(from) || Number.isNaN(dayUtc(from).getTime())) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "from" }, "from debe ser una fecha YYYY-MM-DD.");
  if (typeof to !== "string" || !ISO_DATE.test(to) || Number.isNaN(dayUtc(to).getTime())) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "to" }, "to debe ser una fecha YYYY-MM-DD.");
  const f = dayUtc(from);
  const t = dayUtc(to);
  if (t.getTime() < f.getTime()) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "to" }, "to debe ser igual o posterior a from.");
  const days = Math.round((t.getTime() - f.getTime()) / MS_DAY) + 1;
  if (days > maxDays) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "to", maxDays }, `La ventana máxima es de ${maxDays} días (pedidos ${days}).`);
  return { from: isoDate(f), to: isoDate(t), days };
}

// ---------------------------------------------------------------------------
// Convenio y coste medio por empleado
// ---------------------------------------------------------------------------

export type AnnualHoursResolution = { annualHours: number; source: "agreement" | "default"; agreementId: string | null };

/** Jornada anual del convenio del centro (regla annual_hours vigente) o el valor por defecto. */
export async function resolveAnnualHours(property: Pick<HrPropertyRow, "agreementId">, at: string): Promise<AnnualHoursResolution> {
  if (!property.agreementId) return { annualHours: ANNUAL_HOURS_DEFAULT, source: "default", agreementId: null };
  const day = dayUtc(at);
  const rules = await prisma.agreementRule.findMany({
    where: { agreementId: property.agreementId, key: "annual_hours", validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }] },
    orderBy: { validFrom: "desc" },
    take: 1,
    select: { valueJson: true }
  });
  const value = rules[0] ? toNumber(rules[0].valueJson) : null;
  if (value === null || value <= 0) return { annualHours: ANNUAL_HOURS_DEFAULT, source: "default", agreementId: property.agreementId };
  return { annualHours: value, source: "agreement", agreementId: property.agreementId };
}

export type CostPerEmployee = { periodCode: string | null; byDepartment: Map<string, number> };

/** Coste mensual medio por empleado y departamento del último mes con lote `posted` (Σ totalCost / Σ headcount). */
export async function loadCostPerEmployeeByDepartment(organizationId: string, propertyId: string): Promise<CostPerEmployee> {
  const latest = await prisma.payrollCostLine.findFirst({ where: { organizationId, propertyId, import: { status: "posted" } }, orderBy: { periodCode: "desc" }, select: { periodCode: true } });
  if (!latest) return { periodCode: null, byDepartment: new Map() };
  const lines = await prisma.payrollCostLine.findMany({ where: { organizationId, propertyId, periodCode: latest.periodCode, import: { status: "posted" } }, select: { usaliDepartment: true, totalCost: true, headcount: true } });
  const acc = new Map<string, { cost: number; headcount: number }>();
  for (const line of lines) {
    const cur = acc.get(line.usaliDepartment) ?? { cost: 0, headcount: 0 };
    cur.cost += toNumber(line.totalCost) ?? 0;
    cur.headcount += toNumber(line.headcount) ?? 0;
    acc.set(line.usaliDepartment, cur);
  }
  const byDepartment = new Map<string, number>();
  for (const [dept, v] of acc) if (v.headcount > 0) byDepartment.set(dept, Math.round((v.cost / v.headcount) * 100) / 100);
  return { periodCode: latest.periodCode, byDepartment };
}

function daysInMonthOf(date: string): number {
  const d = dayUtc(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Generación (escritura)
// ---------------------------------------------------------------------------

export type LaborForecastGenerateResult = {
  propertyId: string;
  from: string;
  to: string;
  generatedAt: string;
  days: number;
  written: number;
  deleted: number;
  degradedDays: number;
  annualHours: number;
  annualHoursSource: "agreement" | "default";
  costPeriodCode: string | null;
  rows: LaborForecastDayDto[];
  degraded: HrDegradedEntry[];
  warnings: string[];
};

function driversDto(d: EngineDrivers): LaborForecastDriversDto {
  return {
    rooms: d.rooms,
    arrivals: d.arrivals,
    departures: d.departures,
    stayovers: d.rooms === null || d.departures === null ? null : Math.max(0, Math.round((d.rooms - d.departures) * 100) / 100),
    pax: d.pax,
    coversBreakfast: d.coversBreakfast,
    coversRestaurant: d.coversRestaurant,
    roomsInventory: d.roomsInventory
  };
}

export type LaborForecastDeps = {
  /** Reloj de `generatedAt` (inyectable en los tests: dos relojes distintos sin dormir; corrector SEC-10). */
  now: () => Date;
};

export const defaultLaborForecastDeps: LaborForecastDeps = { now: () => new Date() };

export async function generateLaborForecast(input: { context: UserContext; propertyId: string; from: string; to: string; correlationId?: string; today?: Date }, deps: LaborForecastDeps = defaultLaborForecastDeps): Promise<LaborForecastGenerateResult> {
  requirePermissions(input.context, ["workforce.schedule.manage"]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const window = parseForecastWindow(input.from, input.to);
  const today = dayUtc(input.today);
  const generatedAt = deps.now();
  const degraded: HrDegradedEntry[] = [];
  const warnings: string[] = [];

  const [standardRows, drivers, annual, cost] = await Promise.all([
    loadLaborStandards(property.id),
    loadLaborDrivers({ propertyId: property.id, from: window.from, to: window.to, today }),
    resolveAnnualHours(property, window.from),
    loadCostPerEmployeeByDepartment(property.organizationId, property.id)
  ]);
  degraded.push(...drivers.degraded);
  if (annual.source === "default") degraded.push({ code: "HR_AGREEMENT_MISSING", message: `Centro sin convenio con jornada anual: se usa ${ANNUAL_HOURS_DEFAULT} h para el FTE de los puestos 24/7.`, propertyId: property.id });
  if (cost.periodCode === null) degraded.push({ code: "HR_LABOR_COST_REFERENCE_MISSING", message: "Sin lote de coste de personal contabilizado en el centro: estimatedCost queda vacío.", propertyId: property.id });
  if (standardRows.length === 0) {
    warnings.push("El centro no tiene estándares de dotación: no se ha generado ninguna fila (restablece los valores del sector).");
    degraded.push({ code: "HR_STANDARDS_MISSING", message: "Sin estándares de dotación en el centro.", propertyId: property.id });
  }

  const rules: EngineRules = { annualHours: annual.annualHours };
  let written = 0;
  let deleted = 0;
  let degradedDays = 0;
  for (const day of drivers.days) {
    const standards = activeStandardsAt(standardRows, day.date).map(toEngineStandard);
    if (standards.length === 0) {
      if (standardRows.length > 0) degraded.push({ code: "HR_STANDARDS_MISSING", message: `Sin estándares vigentes el ${day.date}: día sin previsión.`, propertyId: property.id, date: day.date });
      continue;
    }
    const req = computeLaborRequirement(day, standards, rules);
    if (req.degraded) degradedDays += 1;
    const forecastDate = dayUtc(day.date);
    const keep: string[] = [];
    const daysInMonth = daysInMonthOf(day.date);
    for (const dept of req.departments) {
      keep.push(dept.usaliDepartment);
      const estimated = estimateDailyCost(dept.requiredFte, cost.byDepartment.get(dept.usaliDepartment) ?? null, daysInMonth);
      const data = {
        requiredLaborHours: text2(dept.requiredHours),
        requiredStaffCount: text2(dept.requiredFte),
        requiredFte: text2(dept.requiredFte),
        estimatedCost: text2(estimated),
        source: req.source,
        driversJson: driversDto(day) as unknown as Prisma.InputJsonValue,
        reasonJson: { degraded: dept.degraded, degradedReasons: dept.degradedReasons, driverReasons: day.degraded, annualHours: annual.annualHours, annualHoursSource: annual.source, costPeriodCode: cost.periodCode, lines: dept.lines } as unknown as Prisma.InputJsonValue,
        generatedAt
      };
      await prisma.laborForecast.upsert({
        where: { propertyId_forecastDate_usaliDepartment: { propertyId: property.id, forecastDate, usaliDepartment: dept.usaliDepartment } },
        create: { propertyId: property.id, forecastDate, usaliDepartment: dept.usaliDepartment, ...data },
        update: data
      });
      written += 1;
    }
    const stale = await prisma.laborForecast.deleteMany({ where: { propertyId: property.id, forecastDate, usaliDepartment: { notIn: keep } } });
    deleted += stale.count;
  }

  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_FORECAST_GENERATED",
    entityType: "labor_forecast",
    entityId: property.id,
    afterJson: { from: window.from, to: window.to, days: window.days, written, deleted, degradedDays, annualHours: annual.annualHours, annualHoursSource: annual.source, losSource: drivers.losSource, averageLos: drivers.averageLos },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  const listed = await loadLaborForecastRows({ propertyId: property.id, from: window.from, to: window.to, today });
  return {
    propertyId: property.id,
    from: window.from,
    to: window.to,
    generatedAt: generatedAt.toISOString(),
    days: window.days,
    written,
    deleted,
    degradedDays,
    annualHours: annual.annualHours,
    annualHoursSource: annual.source,
    costPeriodCode: cost.periodCode,
    rows: listed.rows,
    degraded: [...degraded, ...listed.degraded],
    warnings
  };
}

// ---------------------------------------------------------------------------
// Lectura con comparación (necesario vs planificado vs disponible vs máximo aprobado)
// ---------------------------------------------------------------------------

export type LaborForecastRow = LaborForecastDayDto & { activeFte: string | null };

type ForecastRow = { propertyId: string; forecastDate: Date; usaliDepartment: string; requiredLaborHours: unknown; requiredFte: unknown; estimatedCost: unknown; source: string | null; driversJson: unknown; reasonJson: unknown; generatedAt: Date | null };

function driversFromJson(raw: unknown): LaborForecastDriversDto {
  const j = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: string): number | null => toNumber(j[k]);
  return { rooms: n("rooms"), arrivals: n("arrivals"), departures: n("departures"), stayovers: n("stayovers"), pax: n("pax"), coversBreakfast: n("coversBreakfast"), coversRestaurant: n("coversRestaurant"), roomsInventory: n("roomsInventory") };
}

function reasonsFromJson(raw: unknown): { degraded: boolean; reasons: string[] } {
  const j = (raw && typeof raw === "object" ? raw : {}) as { degraded?: unknown; degradedReasons?: unknown; driverReasons?: unknown };
  const reasons = [...(Array.isArray(j.degradedReasons) ? j.degradedReasons : []), ...(Array.isArray(j.driverReasons) ? j.driverReasons : [])].filter((r): r is string => typeof r === "string");
  return { degraded: j.degraded === true || reasons.length > 0, reasons: Array.from(new Set(reasons)) };
}

/** Horas de turno (con la pausa descontada cuando el dato exista; hoy Shift no la lleva). */
function shiftHours(startAt: Date, endAt: Date): number {
  return Math.max(0, (endAt.getTime() - startAt.getTime()) / 3_600_000);
}

/** Lectura interna sin permisos (la usan generate, list y los KPIs/alertas): filas + comparación. */
export async function loadLaborForecastRows(input: { propertyId: string; from: string; to: string; today?: Date }): Promise<{ rows: LaborForecastRow[]; degraded: HrDegradedEntry[] }> {
  const from = dayUtc(input.from);
  const to = dayUtc(input.to);
  const degraded: HrDegradedEntry[] = [];
  const [forecasts, profiles] = await Promise.all([
    prisma.laborForecast.findMany({ where: { propertyId: input.propertyId, forecastDate: { gte: from, lte: to } }, orderBy: [{ forecastDate: "asc" }, { usaliDepartment: "asc" }] }),
    prisma.staffProfile.findMany({ where: { propertyId: input.propertyId }, select: { id: true, usaliDepartment: true } })
  ]);
  if (forecasts.length === 0) return { rows: [], degraded };
  const profileIds = profiles.map((p) => p.id);
  const deptOf = new Map(profiles.map((p) => [p.id, p.usaliDepartment as HrUsaliDepartment | null]));
  const [shifts, contracts, absences] = await Promise.all([
    prisma.shift.findMany({ where: { propertyId: input.propertyId, shiftDate: { gte: from, lte: to }, status: { notIn: ["cancelled", "canceled"] } }, select: { shiftDate: true, startAt: true, endAt: true, staffProfileId: true } }),
    profileIds.length ? prisma.employmentContract.findMany({ where: { staffProfileId: { in: profileIds }, active: true, startDate: { lte: to }, OR: [{ endDate: null }, { endDate: { gte: from } }] }, select: { staffProfileId: true, partTimePct: true, startDate: true, endDate: true } }) : Promise.resolve([]),
    profileIds.length ? prisma.absenceRequest.findMany({ where: { propertyId: input.propertyId, status: "approved", startDate: { lte: to }, endDate: { gte: from } }, select: { staffProfileId: true, startDate: true, endDate: true } }) : Promise.resolve([])
  ]);
  const profilesWithDept = profiles.filter((p) => p.usaliDepartment).length;
  const profilesWithoutDept = profiles.length - profilesWithDept;
  if (profilesWithoutDept > 0) degraded.push({ code: "HR_PROFILE_DEPARTMENT_MISSING", message: `${profilesWithoutDept} ficha(s) de personal sin departamento USALI: sus turnos y contratos no se atribuyen a ningún departamento.`, propertyId: input.propertyId });

  // Horas planificadas por (día, departamento) y días con cuadrante.
  const plannedByKey = new Map<string, number>();
  const daysWithShifts = new Set<string>();
  for (const s of shifts) {
    const key = isoDate(dayUtc(s.shiftDate));
    daysWithShifts.add(key);
    const dept = s.staffProfileId ? deptOf.get(s.staffProfileId) ?? null : null;
    if (!dept) continue;
    plannedByKey.set(`${key}|${dept}`, (plannedByKey.get(`${key}|${dept}`) ?? 0) + shiftHours(s.startAt, s.endAt));
  }
  // Peso FTE por ficha (contrato activo el día) y ausencias aprobadas por día.
  const weightOf = (profileId: string): number | null => {
    const c = contracts.find((row) => row.staffProfileId === profileId);
    if (!c) return null;
    const pct = toNumber(c.partTimePct);
    return pct === null ? 1 : Math.max(0, Math.min(1, pct / 100));
  };
  const activeByDay = new Map<string, Map<string, number>>();
  const availableByDay = new Map<string, Map<string, number>>();
  const dates = Array.from(new Set(forecasts.map((f) => isoDate(dayUtc(f.forecastDate)))));
  for (const date of dates) {
    const day = dayUtc(date);
    const active = new Map<string, number>();
    for (const c of contracts) {
      if (c.startDate.getTime() > day.getTime()) continue;
      if (c.endDate && c.endDate.getTime() < day.getTime()) continue;
      const dept = deptOf.get(c.staffProfileId);
      if (!dept) continue;
      const pct = toNumber(c.partTimePct);
      active.set(dept, (active.get(dept) ?? 0) + (pct === null ? 1 : Math.max(0, Math.min(1, pct / 100))));
    }
    const available = new Map(active);
    for (const a of absences) {
      if (a.startDate.getTime() > day.getTime() || a.endDate.getTime() < day.getTime()) continue;
      const dept = deptOf.get(a.staffProfileId);
      if (!dept) continue;
      const w = weightOf(a.staffProfileId) ?? 1;
      available.set(dept, Math.max(0, (available.get(dept) ?? 0) - w));
    }
    activeByDay.set(date, active);
    availableByDay.set(date, available);
  }
  // Plan aprobado por día (uno por mes: se resuelve por fecha distinta de año/mes).
  const planCache = new Map<string, Map<string, number> | null>();
  const approvedFor = async (date: string): Promise<Map<string, number> | null> => {
    const monthKey = date.slice(0, 7);
    if (planCache.has(monthKey)) return planCache.get(monthKey)!;
    const plan = await findApprovedStaffingPlan(input.propertyId, date);
    const map = plan ? new Map(plan.lines.map((l) => [l.usaliDepartment, toNumber(l.maxFte) ?? 0])) : null;
    planCache.set(monthKey, map);
    return map;
  };

  const rows: LaborForecastRow[] = [];
  for (const f of forecasts as ForecastRow[]) {
    const date = isoDate(dayUtc(f.forecastDate));
    const dept = f.usaliDepartment as LaborForecastDepartment;
    const approved = await approvedFor(date);
    const reasons = reasonsFromJson(f.reasonJson);
    const requiredHours = toNumber(f.requiredLaborHours);
    const requiredFte = toNumber(f.requiredFte);
    const planned = daysWithShifts.has(date) ? plannedByKey.get(`${date}|${dept}`) ?? 0 : null;
    const active = profilesWithDept > 0 && dept !== "all" ? activeByDay.get(date)?.get(dept) ?? 0 : null;
    const available = profilesWithDept > 0 && dept !== "all" ? availableByDay.get(date)?.get(dept) ?? 0 : null;
    const approvedFte = approved && dept !== "all" ? approved.get(dept) ?? null : null;
    rows.push({
      propertyId: f.propertyId,
      date,
      usaliDepartment: dept,
      drivers: driversFromJson(f.driversJson),
      requiredHours: text2(requiredHours),
      requiredFte: text2(requiredFte),
      plannedHours: text2(planned === null ? null : Math.round(planned * 100) / 100),
      availableFte: text2(available === null ? null : Math.round(available * 100) / 100),
      activeFte: text2(active === null ? null : Math.round(active * 100) / 100),
      approvedFte: text2(approvedFte),
      estimatedCost: text2(toNumber(f.estimatedCost)),
      source: (f.source as LaborForecastSource | null) ?? null,
      degraded: reasons.degraded || requiredHours === null,
      degradedReasons: reasons.reasons,
      generatedAt: f.generatedAt ? f.generatedAt.toISOString() : null
    });
  }
  return { rows, degraded };
}

export async function listLaborForecast(input: { context: UserContext; propertyId: string; from: string; to: string; today?: Date }): Promise<{ propertyId: string; from: string; to: string; rows: LaborForecastDayDto[]; degraded: HrDegradedEntry[] }> {
  requireAnyPermission(input.context, [...LABOR_FORECAST_READ_KEYS]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const window = parseForecastWindow(input.from, input.to);
  const { rows, degraded } = await loadLaborForecastRows({ propertyId: property.id, from: window.from, to: window.to, today: input.today });
  const missingDays = window.days - new Set(rows.map((r) => r.date)).size;
  if (missingDays > 0) degraded.push({ code: "HR_FORECAST_MISSING", message: `${missingDays} día(s) de la ventana sin previsión generada.`, propertyId: property.id });
  return { propertyId: property.id, from: window.from, to: window.to, rows: rows.map(({ activeFte: _activeFte, ...row }) => row), degraded };
}

/** Utilidad para las suites: ventana por defecto de 14 días desde hoy. */
export function defaultForecastWindow(today?: Date, days = 14): { from: string; to: string } {
  const t = dayUtc(today);
  return { from: isoDate(t), to: isoDate(addDays(t, days - 1)) };
}

export type { ActiveFteByDepartment };
export { activeFteByDepartment };
