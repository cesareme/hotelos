// Motor de previsión de plantilla · Tanda RRHH · RRHH-3 (diseño §5 :151-171).
//
// Función PURA (sin Prisma, sin fechas «ahora»): recibe los drivers de un día
// (habitaciones ocupadas, llegadas, salidas, pax, cubiertos, inventario), los
// estándares vigentes del centro (LaborStandard) y las reglas del convenio
// (jornada anual) y devuelve las horas y FTE necesarios por departamento USALI.
//
// Fórmulas (D §5, tabla «Cálculo»):
//   · minutes_per_unit  → horas = unidades × minutos × (1 + suplementos %) / 60
//                          (pisos: salidas × t_salida + estancias × t_cliente + llegadas × t_repaso;
//                           estancias = ocupadas − salidas; F&B: cubiertos × minutos de sala)
//   · units_per_shift   → driver fixed: puestos × horas por turno (bar, dirección/administración);
//                          otro driver: unidades / cupo por turno × horas por turno (cocina 1/45)
//   · fte_per_100       → valor × inventario / 100 × horas por turno (mantenimiento)
//   · posts_by_band     → tramo por habitaciones ocupadas → puestos [mañana, tarde, noche] × horas por
//                          puesto (value, 8 h); la noche SIEMPRE ≥ 1 (recepción)
//   FTE del día: trabajo controlable = horas / 8 × coverageFactor (1,4: 7 días, descansos, absentismo);
//   puesto 24/7 (posts_by_band) = horas × 365 / jornada anual del convenio (5 puestos × 8 h × 365 / 1.792
//   = 8,1 FTE, D §5 :171). FTE del mes = Σ horas / (jornada anual / 12) (`monthlyFte`).
//   Un driver ausente (null) NO se sustituye por 0: la línea y el departamento quedan `degraded`
//   con `requiredHours = null` (nunca un FTE inventado: D §1.1, «forecast_degraded»).
//
// Ejemplo verificado (LT agosto 2026, D §5 :171): 55,7 ocupadas · 27,6 llegadas · 27,3 salidas con los
// estándares 4★ → pisos 29,5 h/día → 5,2 FTE (4,7 sin repaso); recepción 2-2-1 → 40 h/día → 8,1 FTE.
// Alertas calculadas (no persistidas): overstaffed · understaffed · over_approved · forecast_degraded.

import type {
  HrAlertDto,
  HrUsaliDepartment,
  LaborForecastSource,
  LaborStandardBand,
  LaborStandardDriver,
  LaborStandardUnit
} from "@hotelos/shared";

export const HOURS_PER_SHIFT_DEFAULT = 8;
/** Jornada anual por defecto cuando el centro no tiene convenio asignado (ES-15-HOST, D §6.1). */
export const ANNUAL_HOURS_DEFAULT = 1792;
export const DAYS_PER_YEAR = 365;
export const OVERSTAFFED_RATIO = 1.15;
export const UNDERSTAFFED_RATIO = 0.85;
export const OVERSTAFFED_CONSECUTIVE_DAYS = 3;

/** Drivers de un día (null = desconocido, nunca 0 por defecto). */
export type EngineDrivers = {
  date: string;
  rooms: number | null;
  arrivals: number | null;
  departures: number | null;
  pax: number | null;
  coversBreakfast: number | null;
  coversRestaurant: number | null;
  roomsInventory: number | null;
  source: LaborForecastSource | null;
  /** Motivos de degradación de los drivers (p. ej. `no_otb_no_forecast`, `covers_unknown`). */
  degraded: string[];
};

/** Estándar vigente (LaborStandard) ya normalizado a números. */
export type EngineStandard = {
  usaliDepartment: HrUsaliDepartment;
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  value: number;
  bands: LaborStandardBand[] | null;
  /** Suplementos en % (12 = +12 %). */
  allowancePct: number;
  coverageFactor: number;
};

export type EngineRules = {
  /** Jornada anual del convenio del centro (h). */
  annualHours: number;
  /** Horas por turno (8 por defecto). */
  hoursPerShift?: number;
};

export type StandardLineResult = {
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  value: number;
  /** Unidades del driver usadas (habitaciones, cubiertos, puestos…); null si el driver falta. */
  units: number | null;
  hours: number | null;
  fte: number | null;
  /** Tramo aplicado (posts_by_band). */
  posts: readonly [number, number, number] | null;
  missingDriver: LaborStandardDriver | null;
};

export type DepartmentRequirement = {
  usaliDepartment: HrUsaliDepartment;
  requiredHours: number | null;
  requiredFte: number | null;
  degraded: boolean;
  degradedReasons: string[];
  lines: StandardLineResult[];
};

export type DayRequirement = {
  date: string;
  source: LaborForecastSource | null;
  departments: DepartmentRequirement[];
  /** Σ horas de los departamentos con cálculo; null si ninguno pudo calcularse. */
  totalHours: number | null;
  totalFte: number | null;
  degraded: boolean;
  degradedReasons: string[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Unidades del driver a partir de los drivers del día (null = desconocido). */
export function driverUnits(drivers: EngineDrivers, driver: LaborStandardDriver): number | null {
  switch (driver) {
    case "occupied_rooms":
      return drivers.rooms;
    case "departures":
      return drivers.departures;
    case "arrivals":
      return drivers.arrivals;
    case "stayovers":
      return drivers.rooms === null || drivers.departures === null ? null : Math.max(0, round2(drivers.rooms - drivers.departures));
    case "pax":
      return drivers.pax;
    case "covers_breakfast":
      return drivers.coversBreakfast;
    case "covers_restaurant":
      return drivers.coversRestaurant;
    case "rooms_inventory":
      return drivers.roomsInventory;
    case "fixed":
      return 1;
    default:
      return null;
  }
}

/** Tramo aplicable por habitaciones ocupadas (primer tramo cuyo tope es null o ≥ ocupadas); la noche ≥ 1. */
export function pickBand(bands: readonly LaborStandardBand[] | null, occupiedRooms: number): readonly [number, number, number] | null {
  if (!bands || bands.length === 0) return null;
  const sorted = [...bands].sort((a, b) => (a.maxOccupiedRooms ?? Number.POSITIVE_INFINITY) - (b.maxOccupiedRooms ?? Number.POSITIVE_INFINITY));
  const band = sorted.find((b) => b.maxOccupiedRooms === null || occupiedRooms <= b.maxOccupiedRooms) ?? sorted[sorted.length - 1]!;
  const [m, t, n] = band.posts;
  return [Math.max(0, m), Math.max(0, t), Math.max(1, n)];
}

/** Horas y FTE de UNA línea de estándar para los drivers del día. */
export function computeStandardLine(drivers: EngineDrivers, standard: EngineStandard, rules: EngineRules): StandardLineResult {
  const hoursPerShift = rules.hoursPerShift ?? HOURS_PER_SHIFT_DEFAULT;
  const annualHours = rules.annualHours > 0 ? rules.annualHours : ANNUAL_HOURS_DEFAULT;
  const allowance = 1 + Math.max(0, standard.allowancePct) / 100;
  const base: StandardLineResult = { driver: standard.driver, unit: standard.unit, value: standard.value, units: null, hours: null, fte: null, posts: null, missingDriver: null };
  const units = driverUnits(drivers, standard.driver);
  if (units === null) return { ...base, missingDriver: standard.driver };
  let hours: number;
  let fte: number;
  let posts: readonly [number, number, number] | null = null;
  switch (standard.unit) {
    case "minutes_per_unit":
      hours = (units * standard.value * allowance) / 60;
      fte = (hours / hoursPerShift) * standard.coverageFactor;
      break;
    case "units_per_shift":
      if (standard.driver === "fixed") {
        hours = standard.value * hoursPerShift * allowance;
      } else {
        hours = standard.value > 0 ? (units / standard.value) * hoursPerShift * allowance : 0;
      }
      fte = (hours / hoursPerShift) * standard.coverageFactor;
      break;
    case "fte_per_100":
      hours = ((standard.value * units) / 100) * hoursPerShift * allowance;
      fte = (hours / hoursPerShift) * standard.coverageFactor;
      break;
    case "posts_by_band": {
      posts = pickBand(standard.bands, units);
      if (!posts) return { ...base, units, missingDriver: null, hours: null, fte: null };
      const hoursPerPost = standard.value > 0 ? standard.value : hoursPerShift;
      hours = (posts[0] + posts[1] + posts[2]) * hoursPerPost * allowance;
      // Puesto 24/7: la cobertura sale de la jornada anual del convenio (D §5 :171), no del factor genérico.
      fte = (hours * DAYS_PER_YEAR) / annualHours;
      break;
    }
    default:
      return { ...base, units, missingDriver: null };
  }
  return { ...base, units, hours: round2(hours), fte: round2(fte), posts };
}

/** Necesidad de un departamento: Σ líneas; cualquier driver ausente deja el departamento sin cifra (degraded). */
export function computeDepartmentRequirement(department: HrUsaliDepartment, drivers: EngineDrivers, standards: readonly EngineStandard[], rules: EngineRules): DepartmentRequirement {
  const lines = standards.filter((s) => s.usaliDepartment === department).map((s) => computeStandardLine(drivers, s, rules));
  const reasons: string[] = [];
  for (const line of lines) {
    if (line.missingDriver) reasons.push(`driver_missing:${line.missingDriver}`);
    else if (line.hours === null) reasons.push(`standard_invalid:${line.driver}/${line.unit}`);
  }
  const complete = lines.length > 0 && lines.every((line) => line.hours !== null && line.fte !== null);
  const requiredHours = complete ? round2(lines.reduce((acc, line) => acc + (line.hours ?? 0), 0)) : null;
  const requiredFte = complete ? round2(lines.reduce((acc, line) => acc + (line.fte ?? 0), 0)) : null;
  if (lines.length === 0) reasons.push("no_standards");
  return { usaliDepartment: department, requiredHours, requiredFte, degraded: !complete, degradedReasons: Array.from(new Set(reasons)), lines };
}

/**
 * Necesidad del día por departamento USALI (solo los departamentos con estándar). Un día sin
 * drivers (sin OTB ni previsión) devuelve todos los departamentos con `requiredHours = null`.
 */
export function computeLaborRequirement(drivers: EngineDrivers, standards: readonly EngineStandard[], rules: EngineRules): DayRequirement {
  const departments = Array.from(new Set(standards.map((s) => s.usaliDepartment)));
  const results = departments.map((department) => computeDepartmentRequirement(department, drivers, standards, rules));
  const computed = results.filter((r) => r.requiredHours !== null);
  const totalHours = computed.length > 0 ? round2(computed.reduce((acc, r) => acc + (r.requiredHours ?? 0), 0)) : null;
  const totalFte = computed.length > 0 ? round2(computed.reduce((acc, r) => acc + (r.requiredFte ?? 0), 0)) : null;
  const reasons = Array.from(new Set([...drivers.degraded, ...results.flatMap((r) => r.degradedReasons)]));
  return {
    date: drivers.date,
    source: drivers.source,
    departments: results,
    totalHours,
    totalFte,
    degraded: results.some((r) => r.degraded) || drivers.degraded.length > 0,
    degradedReasons: reasons
  };
}

/** FTE del mes = Σ horas / (jornada anual / 12) (D §5). */
export function monthlyFte(totalHours: number, annualHours: number): number {
  const annual = annualHours > 0 ? annualHours : ANNUAL_HOURS_DEFAULT;
  return round2(totalHours / (annual / 12));
}

/** Coste estimado del día: FTE × coste mensual medio por empleado del departamento / días del mes. */
export function estimateDailyCost(requiredFte: number | null, monthlyCostPerEmployee: number | null, daysInMonth: number): number | null {
  if (requiredFte === null || monthlyCostPerEmployee === null || daysInMonth <= 0) return null;
  return round2((requiredFte * monthlyCostPerEmployee) / daysInMonth);
}

// ---------------------------------------------------------------------------
// Alertas calculadas (D §5 «Alertas», recortado a las cuatro de HR_ALERT_KINDS del motor)
// ---------------------------------------------------------------------------

export type AlertRow = {
  propertyId: string;
  date: string;
  usaliDepartment: HrUsaliDepartment;
  requiredHours: number | null;
  requiredFte: number | null;
  plannedHours: number | null;
  availableFte: number | null;
  /** Contratos activos ponderados (sin descontar ausencias): base de over_approved. */
  activeFte: number | null;
  approvedFte: number | null;
  degraded: boolean;
};

const fmt = (n: number): string => n.toFixed(2);

/**
 * Evalúa las filas día × departamento (ordenadas por fecha dentro de cada departamento):
 *   · forecast_degraded: una alerta por día con algún departamento sin cifra;
 *   · understaffed: planificado < necesario × 0,85 (warning) o necesario > disponible (critical);
 *   · overstaffed: planificado > necesario × 1,15 tres días seguidos (warning, en el tercer día);
 *   · over_approved: contratos activos > máximo aprobado (una por departamento, warning).
 */
export function evaluateLaborAlerts(rows: readonly AlertRow[]): HrAlertDto[] {
  const alerts: HrAlertDto[] = [];
  const byDept = new Map<string, AlertRow[]>();
  const degradedDates = new Map<string, { propertyId: string; departments: Set<string> }>();
  for (const row of rows) {
    const key = `${row.propertyId}|${row.usaliDepartment}`;
    byDept.set(key, [...(byDept.get(key) ?? []), row]);
    if (row.degraded || row.requiredHours === null) {
      const entry = degradedDates.get(`${row.propertyId}|${row.date}`) ?? { propertyId: row.propertyId, departments: new Set<string>() };
      entry.departments.add(row.usaliDepartment);
      degradedDates.set(`${row.propertyId}|${row.date}`, entry);
    }
  }
  for (const [key, entry] of Array.from(degradedDates.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const date = key.slice(key.indexOf("|") + 1);
    alerts.push({
      kind: "forecast_degraded",
      severity: "warning",
      propertyId: entry.propertyId,
      usaliDepartment: null,
      date,
      message: `Previsión sin drivers (sin OTB ni previsión del PMS) el ${date}: ${entry.departments.size} departamento(s) sin FTE calculado.`,
      value: null,
      threshold: null,
      employeeId: null
    });
  }
  for (const list of byDept.values()) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    let overRun = 0;
    let overApprovedEmitted = false;
    for (const row of sorted) {
      const required = row.requiredHours;
      if (required !== null && row.plannedHours !== null) {
        if (row.plannedHours < required * UNDERSTAFFED_RATIO) {
          alerts.push({ kind: "understaffed", severity: "warning", propertyId: row.propertyId, usaliDepartment: row.usaliDepartment, date: row.date, message: `Planificado por debajo del 85 % de lo necesario (${fmt(row.plannedHours)} h de ${fmt(required)} h).`, value: fmt(row.plannedHours), threshold: fmt(required * UNDERSTAFFED_RATIO), employeeId: null });
        }
        if (row.plannedHours > required * OVERSTAFFED_RATIO) {
          overRun += 1;
          if (overRun === OVERSTAFFED_CONSECUTIVE_DAYS) {
            alerts.push({ kind: "overstaffed", severity: "warning", propertyId: row.propertyId, usaliDepartment: row.usaliDepartment, date: row.date, message: `Planificado por encima del 115 % de lo necesario ${OVERSTAFFED_CONSECUTIVE_DAYS} días seguidos (${fmt(row.plannedHours)} h de ${fmt(required)} h).`, value: fmt(row.plannedHours), threshold: fmt(required * OVERSTAFFED_RATIO), employeeId: null });
          }
        } else {
          overRun = 0;
        }
      } else {
        overRun = 0;
      }
      if (row.requiredFte !== null && row.availableFte !== null && row.requiredFte > row.availableFte) {
        alerts.push({ kind: "understaffed", severity: "critical", propertyId: row.propertyId, usaliDepartment: row.usaliDepartment, date: row.date, message: `Necesario ${fmt(row.requiredFte)} FTE por encima del disponible ${fmt(row.availableFte)} FTE.`, value: fmt(row.requiredFte), threshold: fmt(row.availableFte), employeeId: null });
      }
      if (!overApprovedEmitted && row.activeFte !== null && row.approvedFte !== null && row.activeFte > row.approvedFte) {
        overApprovedEmitted = true;
        alerts.push({ kind: "over_approved", severity: "warning", propertyId: row.propertyId, usaliDepartment: row.usaliDepartment, date: row.date, message: `Contratos activos (${fmt(row.activeFte)} FTE) por encima de la plantilla máxima aprobada (${fmt(row.approvedFte)} FTE).`, value: fmt(row.activeFte), threshold: fmt(row.approvedFte), employeeId: null });
      }
    }
  }
  return alerts;
}
