// KPIs y alertas del panel RRHH · Tanda RRHH · RRHH-3 (diseño §5 «KPIs» recortado, §9 :290).
//
//   getHrKpis({ context, propertyId?, periodCode?, today? })   workforce.labor_cost.view | workforce.read | payroll.read | hr.employee.read
//     · plantilla activa = contratos activos en la fecha de referencia del mes (hoy si cae dentro; si no,
//       el último día del periodo) de las fichas de los centros del ámbito: headcount = PERSONAS distintas
//       (expediente, si no usuario de la ficha; D §13 «headcount (personas) y FTE»; corrector RF-07),
//       FTE = Σ contratos × partTimePct, fijos discontinuos, vencimientos a 30 días;
//     · FTE disponible = FTE activo − ausencias aprobadas de la fecha de referencia (peso del contrato);
//     · máximo aprobado = Σ maxFte de los planes aprobados que cubren la fecha (null sin plan);
//     · FTE necesario del mes = Σ requiredLaborHours de labor_forecasts del mes / (jornada anual / 12)
//       por centro (null sin previsión → degraded);
//     · coste del mes, % s/ ventas, salesSource y coste por empleado del informe de coste
//       (`buildPayrollCostReport`, mismo cálculo que /payroll/cost-report) SOLO si el actor tiene
//       payroll.read / payroll.manage (`monthLaborCostSource: "import"`); sin lote contabilizado, la
//       nómina CALCULADA del mes (recibos de los periodos calculados / aprobados / exportados del ámbito:
//       bruto + SS empresa; `monthLaborCostSource: "payroll"`, sin ventas; D §10 «importado o calculado»,
//       corrector RF-09); sin ninguna de las dos → null + degraded HR_LABOR_COST_MISSING;
//     · alertsCount = alertas calculadas de los centros (listHrAlerts).
//   listHrAlerts({ context, propertyId, today? })   mismas claves de lectura
//     · motor puro `evaluateLaborAlerts` sobre las filas de previsión de los próximos 14 días
//       (necesario vs planificado vs disponible vs aprobado): overstaffed · understaffed · over_approved ·
//       forecast_degraded;
//     · contract_expiring: contratos activos que vencen en ≤ 30 días (employeeId de la ficha; el front
//       resuelve el nombre por el listado: aquí nunca viaja un nombre);
//     · headcount_threshold: ≥ 50 personas con contrato activo (RD 901/2020: plan de igualdad, registro retributivo).
// Cifras no disponibles → null + `degraded[]` (nunca un 0 verde); fallos de consulta → `safe()` de lib/degraded.

import { prisma } from "@hotelos/database";
import { HR_HEADCOUNT_THRESHOLD, type HrAlertDto, type HrDegradedEntry, type HrKpisDto, type HrLaborCostKpiSource, type HrSalesSource, type HrUsaliDepartment } from "@hotelos/shared";
import { createDegradedCollector } from "../../lib/degraded.js";
import type { UserContext } from "../../lib/demo-store.js";
import { propertyWithinScope } from "../../lib/finance-scope.js";
import { buildPayrollCostReport } from "../payroll/cost-report.service.js";
import { addDays, dayUtc, isoDate } from "../revenue/actuals.js";
import { dec, round2 } from "../treasury/money.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { evaluateLaborAlerts, monthlyFte, type AlertRow } from "./labor-forecast.engine.js";
import { loadLaborForecastRows, resolveAnnualHours } from "./labor-forecast.service.js";
import { findApprovedStaffingPlan } from "./staffing.service.js";
import { hrForecastBadRequest, requireHrProperty, type HrPropertyRow } from "./standards.service.js";

export const HR_KPIS_READ_KEYS = ["workforce.labor_cost.view", "workforce.read", "payroll.read", "hr.employee.read"] as const;
export const HR_ALERT_HORIZON_DAYS = 14;
export const CONTRACT_EXPIRY_HORIZON_DAYS = 30;
const PERIOD = /^\d{4}-\d{2}$/;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}
const text2 = (n: number | null): string | null => (n === null ? null : n.toFixed(2));

export function parsePeriodCode(value: unknown, today: Date): string {
  if (value === undefined || value === null || value === "") return isoDate(today).slice(0, 7);
  if (typeof value !== "string" || !PERIOD.test(value)) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "period" }, "period debe tener el formato YYYY-MM.");
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "period" }, "period debe tener el formato YYYY-MM.");
  return value;
}

/** Fecha de referencia del mes: hoy si cae dentro del periodo; si no, el último (periodo pasado) o el primer día (futuro). */
export function referenceDateOf(periodCode: string, today: Date): string {
  const first = dayUtc(`${periodCode}-01`);
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const t = dayUtc(today);
  if (t.getTime() < first.getTime()) return isoDate(first);
  if (t.getTime() > last.getTime()) return isoDate(last);
  return isoDate(t);
}

async function scopedProperties(context: UserContext, propertyId: string | null | undefined): Promise<HrPropertyRow[]> {
  if (propertyId) return [await requireHrProperty(context, propertyId)];
  const rows = await prisma.property.findMany({ where: { organizationId: context.organizationId, kind: { not: "other" } }, select: { id: true, organizationId: true, legalEntityId: true, starRating: true, agreementId: true, name: true } });
  return rows.filter((row) => propertyWithinScope(context, row.id));
}

type ContractRow = { id: string; staffProfileId: string; partTimePct: unknown; fixedDiscontinuous: boolean; endDate: Date | null; startDate: Date };
type ProfileRow = { id: string; propertyId: string; usaliDepartment: string | null; employeeId: string | null; userId?: string | null };

/** Clave de PERSONA de una ficha: el expediente enlazado, si no el usuario, si no la propia ficha (RF-07). */
export function personKeyOf(profile: Pick<ProfileRow, "id" | "employeeId" | "userId">): string {
  return profile.employeeId ? `emp:${profile.employeeId}` : profile.userId ? `usr:${profile.userId}` : `sp:${profile.id}`;
}

/** Personas distintas con al menos un contrato activo (headcount; nunca cuenta dos contratos de la misma persona). */
export function distinctPersons(profiles: readonly Pick<ProfileRow, "id" | "employeeId" | "userId">[], contracts: readonly Pick<ContractRow, "staffProfileId">[]): number {
  const byProfile = new Map(profiles.map((profile) => [profile.id, personKeyOf(profile)]));
  const persons = new Set<string>();
  for (const contract of contracts) persons.add(byProfile.get(contract.staffProfileId) ?? `sp:${contract.staffProfileId}`);
  return persons.size;
}

function weightOf(contract: Pick<ContractRow, "partTimePct">): number {
  const pct = toNumber(contract.partTimePct);
  return pct === null ? 1 : Math.max(0, Math.min(1, pct / 100));
}

async function loadWorkforce(propertyIds: string[], refDate: string): Promise<{ profiles: ProfileRow[]; contracts: ContractRow[]; absences: Array<{ staffProfileId: string }> }> {
  const day = dayUtc(refDate);
  const profiles = propertyIds.length ? await prisma.staffProfile.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true, propertyId: true, usaliDepartment: true, employeeId: true, userId: true } }) : [];
  if (profiles.length === 0) return { profiles, contracts: [], absences: [] };
  const ids = profiles.map((p) => p.id);
  const [contracts, absences] = await Promise.all([
    prisma.employmentContract.findMany({ where: { staffProfileId: { in: ids }, active: true, startDate: { lte: day }, OR: [{ endDate: null }, { endDate: { gte: day } }] }, select: { id: true, staffProfileId: true, partTimePct: true, fixedDiscontinuous: true, endDate: true, startDate: true } }),
    prisma.absenceRequest.findMany({ where: { propertyId: { in: propertyIds }, status: "approved", startDate: { lte: day }, endDate: { gte: day } }, select: { staffProfileId: true } })
  ]);
  return { profiles, contracts, absences };
}

export type WorkforceSummary = {
  activeHeadcount: number;
  activeFte: number;
  fixedDiscontinuousHeadcount: number;
  /** null sin fichas (no calculable), nunca 0 por defecto. */
  availableFte: number | null;
  contractsEndingIn30Days: number;
};

/** Resumen puro de plantilla: personas con contrato activo (headcount), contratos ponderados (FTE) − ausencias aprobadas del día; vencimientos a 30 días. */
export function summariseWorkforce(workforce: { profiles: readonly Pick<ProfileRow, "id" | "employeeId" | "userId">[]; contracts: readonly Pick<ContractRow, "staffProfileId" | "partTimePct" | "fixedDiscontinuous" | "endDate">[]; absences: readonly { staffProfileId: string }[] }, today: Date): WorkforceSummary {
  const contractWeight = new Map(workforce.contracts.map((c) => [c.staffProfileId, weightOf(c)]));
  const activeHeadcount = distinctPersons(workforce.profiles, workforce.contracts);
  const activeFte = workforce.contracts.reduce((acc, c) => acc + weightOf(c), 0);
  const fixedDiscontinuousHeadcount = workforce.contracts.filter((c) => c.fixedDiscontinuous).length;
  const absentFte = workforce.absences.reduce((acc, a) => acc + (contractWeight.get(a.staffProfileId) ?? 0), 0);
  const availableFte = workforce.profiles.length > 0 ? Math.max(0, activeFte - absentFte) : null;
  const t = dayUtc(today);
  const horizon = addDays(t, CONTRACT_EXPIRY_HORIZON_DAYS);
  const contractsEndingIn30Days = workforce.contracts.filter((c) => c.endDate && c.endDate.getTime() >= t.getTime() && c.endDate.getTime() <= horizon.getTime()).length;
  return { activeHeadcount, activeFte: Math.round(activeFte * 100) / 100, fixedDiscontinuousHeadcount, availableFte: availableFte === null ? null : Math.round(availableFte * 100) / 100, contractsEndingIn30Days };
}

export async function getHrKpis(input: { context: UserContext; propertyId?: string | null; periodCode?: string | null; today?: Date }): Promise<HrKpisDto> {
  requireAnyPermission(input.context, [...HR_KPIS_READ_KEYS]);
  const today = dayUtc(input.today);
  const periodCode = parsePeriodCode(input.periodCode ?? undefined, today);
  const refDate = referenceDateOf(periodCode, today);
  const properties = await scopedProperties(input.context, input.propertyId);
  const propertyIds = properties.map((p) => p.id);
  const collector = createDegradedCollector("hr.kpis", { propertyId: input.propertyId ?? null, periodCode });
  const degraded: HrDegradedEntry[] = [];

  // Plantilla activa y disponible.
  const workforce = await collector.safe("workforce", loadWorkforce(propertyIds, refDate), { profiles: [], contracts: [], absences: [] });
  const summary = summariseWorkforce(workforce, today);
  const { activeHeadcount, activeFte, fixedDiscontinuousHeadcount, availableFte, contractsEndingIn30Days } = summary;
  if (availableFte === null) degraded.push({ code: "HR_WORKFORCE_MISSING", message: "Sin fichas de personal en el ámbito: FTE disponible no calculable.", propertyId: input.propertyId ?? null, periodCode });

  // Máximo aprobado.
  let approvedMaxFte: number | null = null;
  for (const property of properties) {
    const plan = await collector.safe(`staffing_plan:${property.id}`, findApprovedStaffingPlan(property.id, refDate), null);
    if (plan) approvedMaxFte = (approvedMaxFte ?? 0) + (toNumber(plan.totalMaxFte) ?? 0);
  }
  if (approvedMaxFte === null) degraded.push({ code: "HR_STAFFING_PLAN_MISSING", message: "Sin plan de plantilla aprobado que cubra el periodo.", propertyId: input.propertyId ?? null, periodCode });

  // FTE necesario del mes desde la previsión persistida.
  const first = `${periodCode}-01`;
  const lastDay = new Date(Date.UTC(Number(periodCode.slice(0, 4)), Number(periodCode.slice(5, 7)), 0));
  let requiredFte: number | null = null;
  for (const property of properties) {
    const rows = await collector.safe(`forecast:${property.id}`, prisma.laborForecast.findMany({ where: { propertyId: property.id, forecastDate: { gte: dayUtc(first), lte: lastDay } }, select: { requiredLaborHours: true } }), []);
    const hours = rows.reduce((acc, r) => acc + (toNumber(r.requiredLaborHours) ?? 0), 0);
    if (rows.length === 0 || rows.every((r) => toNumber(r.requiredLaborHours) === null)) continue;
    const annual = await collector.safe(`annual_hours:${property.id}`, resolveAnnualHours(property, first), { annualHours: 1792, source: "default" as const, agreementId: null });
    requiredFte = (requiredFte ?? 0) + monthlyFte(hours, annual.annualHours);
  }
  if (requiredFte === null) degraded.push({ code: "HR_FORECAST_MISSING", message: "Sin previsión de plantilla generada para el mes.", propertyId: input.propertyId ?? null, periodCode });

  // Coste del mes (informe de coste de personal importado, si no la nómina calculada) solo con clave de nómina.
  let monthLaborCost: string | null = null;
  let monthLaborCostSource: HrLaborCostKpiSource | null = null;
  let laborCostPctOfSales: string | null = null;
  let salesSource: HrSalesSource | null = null;
  let costPerEmployee: string | null = null;
  const held = new Set(input.context.permissions ?? []);
  if (held.has("payroll.read") || held.has("payroll.manage")) {
    const report = await collector.safe("cost_report", buildPayrollCostReport({ context: input.context, from: periodCode, to: periodCode, propertyId: input.propertyId ?? null }), null);
    if (report && report.totals.lines > 0) {
      monthLaborCost = report.totals.totalCost;
      monthLaborCostSource = "import";
      salesSource = report.totals.salesSource;
      laborCostPctOfSales = salesSource === "ledger" ? report.totals.laborPctLedger : salesSource === "reference" ? report.totals.laborPctReference : null;
      costPerEmployee = report.totals.costPerEmployee;
    } else {
      const calculated = await collector.safe("payroll_calculated", loadCalculatedPayrollCost(input.context.organizationId, propertyIds, input.propertyId ?? null, periodCode), null);
      if (calculated) {
        monthLaborCost = calculated.totalCost;
        monthLaborCostSource = "payroll";
        costPerEmployee = calculated.costPerEmployee;
      } else {
        degraded.push({ code: "HR_LABOR_COST_MISSING", message: "Sin lote de coste de personal contabilizado ni nómina calculada en el mes.", propertyId: input.propertyId ?? null, periodCode });
      }
    }
  } else {
    degraded.push({ code: "HR_PAYROLL_SCOPE_MISSING", message: "El coste del mes exige payroll.read: no se muestra.", propertyId: input.propertyId ?? null, periodCode });
  }

  // Alertas de los centros del ámbito.
  let alertsCount = 0;
  for (const property of properties) {
    const alerts = await collector.safe(`alerts:${property.id}`, collectAlerts(property, workforce, today), []);
    alertsCount += alerts.length;
  }
  for (const label of collector.degraded) degraded.push({ code: "HR_KPI_QUERY_FAILED", message: `Consulta ${label} no disponible.`, propertyId: input.propertyId ?? null, periodCode });

  return {
    propertyId: input.propertyId ?? null,
    legalEntityId: properties[0]?.legalEntityId ?? null,
    periodCode,
    activeHeadcount,
    activeFte: activeFte.toFixed(2),
    fixedDiscontinuousHeadcount,
    availableFte: text2(availableFte),
    approvedMaxFte: text2(approvedMaxFte),
    requiredFte: text2(requiredFte),
    monthLaborCost,
    monthLaborCostSource,
    laborCostPctOfSales,
    salesSource,
    costPerEmployee,
    contractsEndingIn30Days,
    alertsCount,
    degraded
  };
}

/**
 * Coste de la nómina CALCULADA del mes (RF-09): recibos de los periodos del mes en estado calculated /
 * approved / exported / closed (con asientos) del centro pedido —o de los centros del ámbito y de la
 * sociedad cuando no hay centro—: Σ (bruto + SS empresa) y coste por recibo. null sin recibos.
 */
export async function loadCalculatedPayrollCost(organizationId: string, scopedPropertyIds: readonly string[], propertyId: string | null, periodCode: string): Promise<{ totalCost: string; costPerEmployee: string | null; slips: number; periodIds: string[] } | null> {
  const periods = await prisma.payrollPeriod.findMany({
    where: {
      organizationId,
      periodCode,
      status: { in: ["calculated", "approved", "exported", "closed"] },
      journalEntryIds: { isEmpty: false },
      ...(propertyId ? { propertyId } : { OR: [{ propertyId: null }, { propertyId: { in: [...scopedPropertyIds] } }] })
    },
    select: { id: true }
  });
  if (periods.length === 0) return null;
  const periodIds = periods.map((row) => row.id);
  const slips = await prisma.payrollSlip.findMany({ where: { periodId: { in: periodIds } }, select: { grossSalary: true, ssEmployer: true } });
  if (slips.length === 0) return null;
  const total = round2(slips.reduce((acc, slip) => acc.plus(dec(slip.grossSalary)).plus(dec(slip.ssEmployer)), dec(0)));
  return { totalCost: total.toFixed(2), costPerEmployee: round2(total.div(slips.length)).toFixed(2), slips: slips.length, periodIds };
}

/** Alertas de un centro: motor puro sobre la previsión de 14 días + vencimientos + umbral de plantilla. */
async function collectAlerts(property: HrPropertyRow, workforce: { profiles: ProfileRow[]; contracts: ContractRow[] }, today: Date): Promise<HrAlertDto[]> {
  const from = isoDate(today);
  const to = isoDate(addDays(today, HR_ALERT_HORIZON_DAYS - 1));
  const { rows } = await loadLaborForecastRows({ propertyId: property.id, from, to, today });
  const alertRows: AlertRow[] = rows
    .filter((r) => r.usaliDepartment !== "all")
    .map((r) => ({
      propertyId: r.propertyId,
      date: r.date,
      usaliDepartment: r.usaliDepartment as HrUsaliDepartment,
      requiredHours: toNumber(r.requiredHours),
      requiredFte: toNumber(r.requiredFte),
      plannedHours: toNumber(r.plannedHours),
      availableFte: toNumber(r.availableFte),
      activeFte: toNumber(r.activeFte),
      approvedFte: toNumber(r.approvedFte),
      degraded: r.degraded
    }));
  const alerts = evaluateLaborAlerts(alertRows);
  const profileOf = new Map(workforce.profiles.map((p) => [p.id, p]));
  const horizon = addDays(today, CONTRACT_EXPIRY_HORIZON_DAYS);
  const personsInProperty = new Set<string>();
  for (const c of workforce.contracts) {
    const profile = profileOf.get(c.staffProfileId);
    if (!profile || profile.propertyId !== property.id) continue;
    personsInProperty.add(personKeyOf(profile));
    if (c.endDate && c.endDate.getTime() >= today.getTime() && c.endDate.getTime() <= horizon.getTime()) {
      const endKey = isoDate(dayUtc(c.endDate));
      const daysLeft = Math.round((dayUtc(c.endDate).getTime() - today.getTime()) / 86_400_000);
      alerts.push({ kind: "contract_expiring", severity: daysLeft <= 7 ? "critical" : "warning", propertyId: property.id, usaliDepartment: (profile.usaliDepartment as HrUsaliDepartment | null) ?? null, date: endKey, message: `Contrato que vence el ${endKey} (${daysLeft} días).`, value: String(daysLeft), threshold: String(CONTRACT_EXPIRY_HORIZON_DAYS), employeeId: profile.employeeId });
    }
  }
  const activeInProperty = personsInProperty.size;
  if (activeInProperty >= HR_HEADCOUNT_THRESHOLD) {
    alerts.push({ kind: "headcount_threshold", severity: "info", propertyId: property.id, usaliDepartment: null, date: null, message: `Plantilla de ${activeInProperty} personas con contrato activo: aplican plan de igualdad, auditoría retributiva y canal de denuncias (≥ ${HR_HEADCOUNT_THRESHOLD}).`, value: String(activeInProperty), threshold: String(HR_HEADCOUNT_THRESHOLD), employeeId: null });
  }
  return alerts;
}

export async function listHrAlerts(input: { context: UserContext; propertyId: string; today?: Date }): Promise<{ propertyId: string; from: string; to: string; alerts: HrAlertDto[]; degraded: HrDegradedEntry[] }> {
  requireAnyPermission(input.context, [...HR_KPIS_READ_KEYS]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const today = dayUtc(input.today);
  const workforce = await loadWorkforce([property.id], isoDate(today));
  const alerts = await collectAlerts(property, workforce, today);
  const from = isoDate(today);
  const to = isoDate(addDays(today, HR_ALERT_HORIZON_DAYS - 1));
  const { rows, degraded } = await loadLaborForecastRows({ propertyId: property.id, from, to, today });
  if (rows.length === 0) degraded.push({ code: "HR_FORECAST_MISSING", message: `Sin previsión generada para los próximos ${HR_ALERT_HORIZON_DAYS} días.`, propertyId: property.id });
  const order: Record<HrAlertDto["severity"], number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity] || (a.date ?? "").localeCompare(b.date ?? "") || a.kind.localeCompare(b.kind));
  return { propertyId: property.id, from, to, alerts, degraded };
}
