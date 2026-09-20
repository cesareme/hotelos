// RRHH y nóminas › Previsión de plantilla y Panel RRHH (Tanda RRHH · RRHH-9) —
// helpers PUROS de HrForecastScreen.tsx y HrOverviewScreen.tsx: vocabularios en
// español del contrato wire (packages/shared/src/hr-types.ts), formato de FTE y
// horas, tramos (ventana de días de la previsión y tramos `posts_by_band` de
// los estándares), agrupación de la previsión por día y por departamento, las
// barras de CocoaChart.Bars, el borrador editable de estándares y de plan de
// plantilla y las etiquetas de `degraded[]` que consumen DegradedValue y
// DegradedBanner. Sin React, sin red, sin variables de entorno de Vite:
// screens/hr/__tests__/hr-forecast-helpers.test.mts lo ejecuta bajo node --test.
//
// Los vocabularios se redeclaran aquí a propósito (tipados contra el contrato
// compartido): bajo `node --import tsx` los stubs `.js` de @hotelos/shared
// ganan a las fuentes y un import en tiempo de ejecución del paquete llegaría
// vacío a los tests (mismo motivo que payroll/payroll-cost-helpers.ts).
//
// Regla de la casa: una cifra que el API no pudo calcular llega como `null`
// más una entrada en `degraded[]`; aquí nunca se sustituye por 0 — el que
// pinta decide con DegradedValue («—»).

import type {
  HrAlertDto,
  HrAlertKind,
  HrAlertSeverity,
  HrDegradedEntry,
  HrKpisDto,
  HrUsaliDepartment,
  LaborForecastDayDto,
  LaborForecastSource,
  LaborStandardBand,
  LaborStandardDriver,
  LaborStandardDto,
  LaborStandardSource,
  LaborStandardUnit,
  StaffingPlanDto,
  StaffingPlanStatus,
  StaffingSeason
} from "@hotelos/shared";
import type { CocoaBarsDatum, CocoaSegmentedControlOption, CocoaSelectOption, CocoaTone } from "../../components/cocoa";
import { date, money, number, percent } from "../../lib/format";

// ---------------------------------------------------------------------------
// Vocabularios (espejo de packages/shared/src/hr-types.ts)
// ---------------------------------------------------------------------------

/** Departamentos USALI con personal, en el orden en que los lee el hotelero (HR_USALI_DEPARTMENTS). */
export const HR_FORECAST_DEPARTMENTS: readonly HrUsaliDepartment[] = ["rooms", "fnb", "other_operated", "admin_general", "it", "sales_marketing", "pom"];

export const HR_FORECAST_DEPARTMENT_LABELS_ES: Readonly<Record<HrUsaliDepartment, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operativos",
  admin_general: "Administración y dirección",
  it: "Sistemas",
  sales_marketing: "Comercial y marketing",
  pom: "Mantenimiento"
});

/** Fila agregada heredada de LaborForecast (`usaliDepartment = "all"`). */
export const FORECAST_DEPARTMENT_ALL = "all" as const;
export const FORECAST_DEPARTMENT_ALL_LABEL_ES = "Todos los departamentos";

export function departmentLabel(department: string | null | undefined): string {
  if (!department || department === FORECAST_DEPARTMENT_ALL) return FORECAST_DEPARTMENT_ALL_LABEL_ES;
  return HR_FORECAST_DEPARTMENT_LABELS_ES[department as HrUsaliDepartment] ?? department;
}

/** Origen de los drivers del día (LaborForecast.source). */
export const LABOR_FORECAST_SOURCE_LABELS_ES: Readonly<Record<LaborForecastSource, string>> = Object.freeze({
  otb: "Reservas en cartera",
  pms_forecast: "Previsión del PMS",
  deterministic: "Modelo determinista",
  actual: "Ocupación real",
  manual: "Manual"
});

export function forecastSourceLabel(source: LaborForecastSource | null | undefined): string {
  return source ? (LABOR_FORECAST_SOURCE_LABELS_ES[source] ?? source) : "Sin origen";
}

export const LABOR_STANDARD_DRIVER_LABELS_ES: Readonly<Record<LaborStandardDriver, string>> = Object.freeze({
  occupied_rooms: "Habitaciones ocupadas",
  departures: "Salidas",
  stayovers: "Habitaciones cliente",
  arrivals: "Llegadas",
  pax: "Huéspedes",
  covers_breakfast: "Cubiertos de desayuno",
  covers_restaurant: "Comensales de restaurante y bar",
  rooms_inventory: "Habitaciones del inventario",
  fixed: "Puestos fijos"
});

export const LABOR_STANDARD_UNIT_LABELS_ES: Readonly<Record<LaborStandardUnit, string>> = Object.freeze({
  minutes_per_unit: "minutos por unidad",
  units_per_shift: "unidades por turno",
  fte_per_100: "FTE por 100 habitaciones",
  posts_by_band: "puestos por tramo"
});

/** Sufijo corto del valor en la tabla editable de estándares. */
export const LABOR_STANDARD_VALUE_SUFFIX_ES: Readonly<Record<LaborStandardUnit, string>> = Object.freeze({
  minutes_per_unit: "min",
  units_per_shift: "ud./turno",
  fte_per_100: "FTE/100 hab.",
  posts_by_band: "h/puesto"
});

export const LABOR_STANDARD_SOURCE_LABELS_ES: Readonly<Record<LaborStandardSource, string>> = Object.freeze({
  sector_default: "Valor del sector",
  measured: "Medido en el centro",
  agreement: "Convenio"
});

export const STAFFING_SEASONS: readonly StaffingSeason[] = ["high", "shoulder", "low"];

export const STAFFING_SEASON_LABELS_ES: Readonly<Record<StaffingSeason, string>> = Object.freeze({
  high: "Temporada alta",
  shoulder: "Temporada media",
  low: "Temporada baja"
});

export const STAFFING_PLAN_STATUS_LABELS_ES: Readonly<Record<StaffingPlanStatus, string>> = Object.freeze({
  draft: "Borrador",
  approved: "Aprobado"
});

export function planStatusTone(status: StaffingPlanStatus | string): CocoaTone {
  return status === "approved" ? "success" : "warning";
}

export const HR_ALERT_KIND_LABELS_ES: Readonly<Record<HrAlertKind, string>> = Object.freeze({
  overstaffed: "Exceso de personal",
  understaffed: "Falta de personal",
  over_approved: "Supera la plantilla máxima",
  forecast_degraded: "Previsión incompleta",
  contract_expiring: "Contrato que vence",
  rule_violation: "Regla incumplida",
  headcount_threshold: "Umbral de plantilla"
});

export const HR_ALERT_SEVERITY_LABELS_ES: Readonly<Record<HrAlertSeverity, string>> = Object.freeze({
  info: "Aviso",
  warning: "Atención",
  critical: "Crítica"
});

const ALERT_SEVERITY_ORDER: Readonly<Record<HrAlertSeverity, number>> = Object.freeze({ critical: 0, warning: 1, info: 2 });

export function alertTone(severity: HrAlertSeverity | string): CocoaTone {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

export function alertKindLabel(kind: HrAlertKind | string): string {
  return HR_ALERT_KIND_LABELS_ES[kind as HrAlertKind] ?? kind;
}

/** Alertas ordenadas por gravedad (crítica → aviso) y, dentro, por fecha ascendente (sin fecha al final). */
export function sortAlerts(alerts: readonly HrAlertDto[]): HrAlertDto[] {
  return [...alerts].sort((a, b) => {
    const severity = (ALERT_SEVERITY_ORDER[a.severity] ?? 9) - (ALERT_SEVERITY_ORDER[b.severity] ?? 9);
    if (severity !== 0) return severity;
    if (a.date === b.date) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  });
}

/** Vencimientos a 30 días: solo las alertas de contrato que vence, ordenadas por fecha. */
export function contractExpiringAlerts(alerts: readonly HrAlertDto[]): HrAlertDto[] {
  return sortAlerts(alerts.filter((alert) => alert.kind === "contract_expiring"));
}

/** Nombre de la persona de una alerta de contrato, resuelto por el listado sin PII; «Expediente sin acceso» sin listado o sin coincidencia. */
export function employeeNameFor(employees: ReadonlyArray<{ id: string; fullName: string; employeeNumber: string }> | null | undefined, employeeId: string | null): string {
  if (!employeeId) return "—";
  const match = employees?.find((employee) => employee.id === employeeId);
  return match ? `${match.fullName} · ${match.employeeNumber}` : "Expediente sin acceso";
}

// ---------------------------------------------------------------------------
// Cifras: FTE y horas (cadenas de dos decimales del contrato → número → texto)
// ---------------------------------------------------------------------------

export type FteInput = string | number | null | undefined;

/** Cadena "5.20" o número → 5.2; null cuando falta o no es numérica (nunca 0 por defecto). */
export function toFte(value: FteInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** «5,2» · «12» · «0,75» — hasta dos decimales, sin ceros de relleno; «—» si falta. */
export function formatFte(value: FteInput): string {
  const parsed = toFte(value);
  return parsed === null ? "—" : number(parsed, { maximumFractionDigits: 2 });
}

/** «5,2 FTE» (con espacio duro), o «—». */
export function formatFteUnit(value: FteInput): string {
  const parsed = toFte(value);
  return parsed === null ? "—" : `${number(parsed, { maximumFractionDigits: 2 })} FTE`;
}

/** «41,6 h», o «—». */
export function formatHours(value: FteInput): string {
  const parsed = toFte(value);
  return parsed === null ? "—" : `${number(parsed, { maximumFractionDigits: 1 })} h`;
}

/** Horas planificadas → FTE del día (jornada de 8 h); null sin horas. */
export function fteFromHours(hours: FteInput, hoursPerDay = 8): number | null {
  const parsed = toFte(hours);
  if (parsed === null || hoursPerDay <= 0) return null;
  return Math.round((parsed / hoursPerDay) * 100) / 100;
}

/** Suma que respeta el «no disponible»: null solo cuando TODOS los sumandos faltan. */
export function sumNullable(values: readonly FteInput[]): number | null {
  let total: number | null = null;
  for (const value of values) {
    const parsed = toFte(value);
    if (parsed === null) continue;
    total = Math.round(((total ?? 0) + parsed) * 100) / 100;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Tramos de fechas: ventana de la previsión (14 / 28 días)
// ---------------------------------------------------------------------------

export const FORECAST_RANGE_DAYS = [14, 28] as const;
export type ForecastRangeDays = (typeof FORECAST_RANGE_DAYS)[number];
export const DEFAULT_FORECAST_RANGE_DAYS: ForecastRangeDays = 14;
/** Tope del API (LaborForecastGenerateSchema · ventana ≤ 92 días). */
export const FORECAST_MAX_DAYS = 92;

export const FORECAST_RANGE_OPTIONS: readonly CocoaSegmentedControlOption[] = FORECAST_RANGE_DAYS.map((days) => ({ value: String(days), label: `${days} días` }));

export function parseForecastRangeDays(value: string | number | null | undefined): ForecastRangeDays {
  const parsed = Number(value);
  return (FORECAST_RANGE_DAYS as readonly number[]).includes(parsed) ? (parsed as ForecastRangeDays) : DEFAULT_FORECAST_RANGE_DAYS;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // «2026-02-30» se desborda a marzo: solo vale el día que vuelve idéntico.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Día civil de `now` en formato ISO (UTC para que el test sea determinista; el picker ya entrega ISO). */
export function isoDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `iso` + n días (calendario, sin zona). */
export function addDays(iso: string, days: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Días de calendario entre dos ISO (inclusive); 0 si el orden es inverso o alguno no es válido. */
export function daysBetween(from: string, to: string): number {
  if (!isIsoDay(from) || !isIsoDay(to)) return 0;
  const diff = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return diff < 0 ? 0 : Math.round(diff) + 1;
}

export type ForecastWindow = { from: string; to: string; days: number };

/** Ventana `[from, from + days − 1]`; un `from` inválido cae al día de hoy. */
export function forecastWindow(from: string | null | undefined, days: number, today: string): ForecastWindow {
  const start = isIsoDay(from) ? from : today;
  const span = Math.min(Math.max(1, Math.trunc(days) || DEFAULT_FORECAST_RANGE_DAYS), FORECAST_MAX_DAYS);
  return { from: start, to: addDays(start, span - 1), days: span };
}

/** «lun, 21 sept – dom, 4 oct» para la cabecera del rango. */
export function windowLabel(window: Pick<ForecastWindow, "from" | "to">): string {
  return `${date(window.from, "weekdayShort")} – ${date(window.to, "weekdayShort")}`;
}

/** «lun, 21 sept» para la lista de días. */
export function dayLabel(iso: string): string {
  return date(iso, "weekdayShort");
}

// ---------------------------------------------------------------------------
// Tramos de puestos (`posts_by_band`) y concepto de un estándar
// ---------------------------------------------------------------------------

/** «≤ 60 hab.: 1 · 1 · 1 | ≤ 150 hab.: 2 · 2 · 1 | resto: 3 · 3 · 3» (mañana · tarde · noche). */
export function bandsLabel(bands: readonly LaborStandardBand[] | null | undefined): string {
  if (!bands || bands.length === 0) return "—";
  return bands
    .map((band) => `${band.maxOccupiedRooms === null ? "resto" : `≤ ${number(band.maxOccupiedRooms)} hab.`}: ${band.posts.map((posts) => number(posts)).join(" · ")}`)
    .join(" | ");
}

/** «Habitaciones cliente · minutos por unidad» — el concepto que mide un estándar. */
export function standardConceptLabel(standard: Pick<LaborStandardDto, "driver" | "unit">): string {
  return `${LABOR_STANDARD_DRIVER_LABELS_ES[standard.driver] ?? standard.driver} · ${LABOR_STANDARD_UNIT_LABELS_ES[standard.unit] ?? standard.unit}`;
}

export function standardValueSuffix(unit: LaborStandardUnit | string): string {
  return LABOR_STANDARD_VALUE_SUFFIX_ES[unit as LaborStandardUnit] ?? "";
}

// ---------------------------------------------------------------------------
// Agrupación de la previsión (día × departamento → por día · por departamento)
// ---------------------------------------------------------------------------

export type ForecastDayGroup = {
  date: string;
  rows: LaborForecastDayDto[];
  requiredHours: number | null;
  requiredFte: number | null;
  plannedHours: number | null;
  /** Horas planificadas / 8. */
  plannedFte: number | null;
  availableFte: number | null;
  approvedFte: number | null;
  estimatedCost: number | null;
  /** Algún departamento del día llegó degradado. */
  degraded: boolean;
  degradedReasons: string[];
  /** Orígenes distintos del día (uno por lo común). */
  sources: LaborForecastSource[];
};

/** Filas por departamento (descarta la agregada «all» cuando hay desglose; la conserva si es lo único que hay). */
export function departmentRows(rows: readonly LaborForecastDayDto[]): LaborForecastDayDto[] {
  const detailed = rows.filter((row) => row.usaliDepartment !== FORECAST_DEPARTMENT_ALL);
  return detailed.length > 0 ? detailed : [...rows];
}

function departmentOrder(department: string): number {
  const index = HR_FORECAST_DEPARTMENTS.indexOf(department as HrUsaliDepartment);
  return index === -1 ? HR_FORECAST_DEPARTMENTS.length : index;
}

/** Ordena filas por fecha y por el orden canónico de departamentos. */
export function sortForecastRows(rows: readonly LaborForecastDayDto[]): LaborForecastDayDto[] {
  return [...rows].sort((a, b) => (a.date === b.date ? departmentOrder(a.usaliDepartment) - departmentOrder(b.usaliDepartment) : a.date < b.date ? -1 : 1));
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

export function groupForecastByDay(rows: readonly LaborForecastDayDto[]): ForecastDayGroup[] {
  const byDate = new Map<string, LaborForecastDayDto[]>();
  for (const row of sortForecastRows(departmentRows(rows))) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  return Array.from(byDate.entries()).map(([day, dayRows]) => {
    const plannedHours = sumNullable(dayRows.map((row) => row.plannedHours));
    return {
      date: day,
      rows: dayRows,
      requiredHours: sumNullable(dayRows.map((row) => row.requiredHours)),
      requiredFte: sumNullable(dayRows.map((row) => row.requiredFte)),
      plannedHours,
      plannedFte: fteFromHours(plannedHours),
      availableFte: sumNullable(dayRows.map((row) => row.availableFte)),
      approvedFte: sumNullable(dayRows.map((row) => row.approvedFte)),
      estimatedCost: sumNullable(dayRows.map((row) => row.estimatedCost)),
      degraded: dayRows.some((row) => row.degraded),
      degradedReasons: unique(dayRows.flatMap((row) => row.degradedReasons ?? [])),
      sources: unique(dayRows.map((row) => row.source).filter((source): source is LaborForecastSource => source !== null))
    };
  });
}

export type ForecastDepartmentGroup = {
  usaliDepartment: string;
  label: string;
  days: number;
  degradedDays: number;
  /** Suma de horas necesarias del periodo. */
  requiredHours: number | null;
  /** Media diaria de FTE necesario (sobre los días con cifra). */
  requiredFteAvg: number | null;
  plannedHours: number | null;
  plannedFteAvg: number | null;
  availableFteAvg: number | null;
  /** Máximo aprobado del periodo (el mayor de los días; el plan cambia por temporada). */
  approvedFteMax: number | null;
  estimatedCost: number | null;
};

function average(values: readonly FteInput[]): number | null {
  const present = values.map(toFte).filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return Math.round((present.reduce((acc, value) => acc + value, 0) / present.length) * 100) / 100;
}

function maxOf(values: readonly FteInput[]): number | null {
  const present = values.map(toFte).filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

export function groupForecastByDepartment(rows: readonly LaborForecastDayDto[]): ForecastDepartmentGroup[] {
  const byDepartment = new Map<string, LaborForecastDayDto[]>();
  for (const row of sortForecastRows(departmentRows(rows))) {
    const list = byDepartment.get(row.usaliDepartment) ?? [];
    list.push(row);
    byDepartment.set(row.usaliDepartment, list);
  }
  const departments = Array.from(byDepartment.keys()).sort((a, b) => departmentOrder(a) - departmentOrder(b));
  return departments.map((department) => [department, byDepartment.get(department) ?? []] as const).map(([department, departmentDays]) => ({
    usaliDepartment: department,
    label: departmentLabel(department),
    days: departmentDays.length,
    degradedDays: departmentDays.filter((row) => row.degraded).length,
    requiredHours: sumNullable(departmentDays.map((row) => row.requiredHours)),
    requiredFteAvg: average(departmentDays.map((row) => row.requiredFte)),
    plannedHours: sumNullable(departmentDays.map((row) => row.plannedHours)),
    plannedFteAvg: average(departmentDays.map((row) => fteFromHours(row.plannedHours))),
    availableFteAvg: average(departmentDays.map((row) => row.availableFte)),
    approvedFteMax: maxOf(departmentDays.map((row) => row.approvedFte)),
    estimatedCost: sumNullable(departmentDays.map((row) => row.estimatedCost))
  }));
}

/** Departamentos presentes en la previsión, en orden canónico, como opciones de un CocoaSelect (con «Todos» delante). */
export function forecastDepartmentOptions(rows: readonly LaborForecastDayDto[]): CocoaSelectOption[] {
  const present = unique(departmentRows(rows).map((row) => row.usaliDepartment)).sort((a, b) => departmentOrder(a) - departmentOrder(b));
  return [{ value: FORECAST_DEPARTMENT_ALL, label: FORECAST_DEPARTMENT_ALL_LABEL_ES }, ...present.map((department) => ({ value: department, label: departmentLabel(department) }))];
}

/** Filas de un departamento (o todas con «all»). */
export function filterForecastDepartment(rows: readonly LaborForecastDayDto[], department: string): LaborForecastDayDto[] {
  const detailed = departmentRows(rows);
  return department === FORECAST_DEPARTMENT_ALL ? detailed : detailed.filter((row) => row.usaliDepartment === department);
}

// ---------------------------------------------------------------------------
// Cobertura: necesario frente a disponible y frente al máximo aprobado
// ---------------------------------------------------------------------------

export type CoverageKey = "unknown" | "ok" | "understaffed" | "overstaffed" | "over_approved";

export type CoverageStatus = { key: CoverageKey; label: string; tone: CocoaTone };

/** Tolerancia del ±10 % antes de avisar (misma banda que las alertas del motor). */
export const COVERAGE_TOLERANCE = 0.1;

/**
 * Estado de cobertura de una fila o de un día: `over_approved` si lo necesario supera el máximo aprobado,
 * `understaffed` / `overstaffed` si lo disponible se aleja más de un 10 % de lo necesario, `ok` en banda,
 * `unknown` sin cifra necesaria o disponible (nunca se inventa un verde).
 */
export function coverageStatus(input: { requiredFte: FteInput; availableFte: FteInput; approvedFte: FteInput }): CoverageStatus {
  const required = toFte(input.requiredFte);
  const available = toFte(input.availableFte);
  const approved = toFte(input.approvedFte);
  if (required === null) return { key: "unknown", label: "Sin previsión", tone: "neutral" };
  if (approved !== null && required > approved) return { key: "over_approved", label: "Supera el máximo aprobado", tone: "danger" };
  if (available === null) return { key: "unknown", label: "Sin disponibilidad", tone: "neutral" };
  const gap = required === 0 ? (available > 0 ? 1 : 0) : (available - required) / required;
  if (gap < -COVERAGE_TOLERANCE) return { key: "understaffed", label: "Falta personal", tone: "warning" };
  if (gap > COVERAGE_TOLERANCE) return { key: "overstaffed", label: "Sobra personal", tone: "info" };
  return { key: "ok", label: "En banda", tone: "success" };
}

// ---------------------------------------------------------------------------
// Barras (CocoaChart.Bars): tres series por departamento, o dos por día
// ---------------------------------------------------------------------------

export type ForecastSeries = "required" | "planned" | "available";

export const FORECAST_SERIES: readonly ForecastSeries[] = ["required", "planned", "available"];

export const FORECAST_SERIES_LABELS_ES: Readonly<Record<ForecastSeries, string>> = Object.freeze({
  required: "Necesario",
  planned: "Planificado",
  available: "Disponible"
});

export const FORECAST_SERIES_TONES: Readonly<Record<ForecastSeries, CocoaTone>> = Object.freeze({
  required: "accent",
  planned: "warning",
  available: "info"
});

function seriesValue(row: Pick<LaborForecastDayDto, "requiredFte" | "plannedHours" | "availableFte">, series: ForecastSeries): number | null {
  if (series === "required") return toFte(row.requiredFte);
  if (series === "planned") return fteFromHours(row.plannedHours);
  return toFte(row.availableFte);
}

/** Barras por departamento de un día (necesario · planificado · disponible); los valores ausentes no se pintan. */
export function forecastBars(rows: readonly LaborForecastDayDto[]): CocoaBarsDatum[] {
  const bars: CocoaBarsDatum[] = [];
  for (const row of sortForecastRows(departmentRows(rows))) {
    for (const series of FORECAST_SERIES) {
      const value = seriesValue(row, series);
      if (value === null) continue;
      bars.push({
        label: `${departmentLabel(row.usaliDepartment)} · ${FORECAST_SERIES_LABELS_ES[series]}`,
        value,
        tone: FORECAST_SERIES_TONES[series],
        hint: `${FORECAST_SERIES_LABELS_ES[series]}: ${formatFteUnit(value)}${row.approvedFte !== null ? ` · máximo aprobado ${formatFteUnit(row.approvedFte)}` : ""}`
      });
    }
  }
  return bars;
}

export type DaySeries = Extract<ForecastSeries, "required" | "planned">;

/**
 * Barras por día de una ventana para el Panel RRHH (un departamento o «all»): una serie
 * (`required` o `planned`, 14 barras legibles en media columna) o, sin `series`, las dos intercaladas.
 */
export function dayBars(groups: readonly ForecastDayGroup[], series?: DaySeries): CocoaBarsDatum[] {
  const bars: CocoaBarsDatum[] = [];
  const wanted: readonly DaySeries[] = series ? [series] : ["required", "planned"];
  for (const group of groups) {
    for (const series of wanted) {
      const value = series === "required" ? group.requiredFte : group.plannedFte;
      if (value === null) continue;
      // RF-16: a degraded day sums only the departments that had a figure — the bar says so instead of posing as a total.
      const partial = series === "required" && group.degraded;
      bars.push({
        label: `${date(group.date, "dayMonth")} · ${FORECAST_SERIES_LABELS_ES[series]}${partial ? ` ${PARTIAL_SUFFIX}` : ""}`,
        value,
        tone: FORECAST_SERIES_TONES[series],
        hint: group.degraded ? `Previsión incompleta: ${partial ? "suma solo los departamentos con cifra; " : ""}revisa los drivers del día` : `${FORECAST_SERIES_LABELS_ES[series]}: ${formatFteUnit(value)}`
      });
    }
  }
  return bars;
}

export const PARTIAL_SUFFIX = "(parcial)";

/** «5,2 FTE necesarios» · «2,8 FTE necesarios (parcial)» when some department of the day is degraded (RF-16) · «— necesarios». */
export function requiredFteLabel(group: Pick<ForecastDayGroup, "requiredFte" | "degraded">): string {
  return `${formatFteUnit(group.requiredFte)} necesarios${group.degraded && group.requiredFte !== null ? ` ${PARTIAL_SUFFIX}` : ""}`;
}

/** Month (1-12, UTC) of an ISO day. */
function monthOfIso(iso: string): number {
  return Number(iso.slice(5, 7));
}

/** The plan's season covers the month (wrapping the year when fromMonth > toMonth, e.g. nov → feb). */
export function planCoversMonth(plan: Pick<StaffingPlanDto, "fromMonth" | "toMonth">, month: number): boolean {
  return plan.fromMonth <= plan.toMonth ? month >= plan.fromMonth && month <= plan.toMonth : month >= plan.fromMonth || month <= plan.toMonth;
}

/**
 * Approved plan in force on `isoDate` (RF-13): same year and season covering the month first (a wrapping season
 * that started the previous year counts), else the most recent approved plan; null without any approved plan.
 */
export function approvedPlanFor(plans: readonly StaffingPlanDto[], isoDate: string): StaffingPlanDto | null {
  const approved = plans.filter((plan) => plan.status === "approved");
  if (approved.length === 0) return null;
  const year = Number(isoDate.slice(0, 4));
  const month = monthOfIso(isoDate);
  const covering = approved.find((plan) => plan.year === year && planCoversMonth(plan, month)) ?? approved.find((plan) => plan.year === year - 1 && plan.fromMonth > plan.toMonth && month <= plan.toMonth) ?? null;
  if (covering) return covering;
  return [...approved].sort((a, b) => b.year - a.year || b.fromMonth - a.fromMonth)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Degradación: `degraded[]` de objetos → etiquetas para DegradedValue / DegradedBanner
// ---------------------------------------------------------------------------

/** Códigos de `degraded[]` que apagan cada KPI del panel (kpis.service.ts). */
export const HR_KPI_DEGRADED_CODES = Object.freeze({
  availableFte: ["HR_WORKFORCE_MISSING", "HR_KPI_QUERY_FAILED"],
  approvedMaxFte: ["HR_STAFFING_PLAN_MISSING", "HR_KPI_QUERY_FAILED"],
  requiredFte: ["HR_FORECAST_MISSING", "HR_KPI_QUERY_FAILED"],
  monthLaborCost: ["HR_LABOR_COST_MISSING", "HR_PAYROLL_SCOPE_MISSING", "HR_KPI_QUERY_FAILED"]
} as const);

/** Códigos únicos de una lista `degraded[]` (lo que DegradedBanner y isDegraded esperan). */
export function degradedCodes(entries: readonly HrDegradedEntry[] | null | undefined): string[] {
  return unique((entries ?? []).map((entry) => entry.code).filter((code): code is string => typeof code === "string" && code.length > 0));
}

/** Mensajes únicos en español de `degraded[]`, para la nota bajo un banner. */
export function degradedMessages(entries: readonly HrDegradedEntry[] | null | undefined): string[] {
  return unique((entries ?? []).map((entry) => entry.message).filter((message): message is string => typeof message === "string" && message.length > 0));
}

/** Etiquetas de degradación de una fila de previsión: el propio código de la fila más sus motivos. */
export function rowDegradedLabels(row: Pick<LaborForecastDayDto, "degraded" | "degradedReasons">): string[] {
  return row.degraded ? unique(["HR_DAY_DEGRADED", ...(row.degradedReasons ?? [])]) : [];
}

/** Motivos del motor (`driver_missing:<driver>`, `no_otb_no_forecast`…) en español; un código desconocido se muestra tal cual. */
export const DEGRADED_REASON_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  no_otb_no_forecast: "sin reservas en cartera ni previsión del PMS",
  no_realized_data: "sin cierre ni estancias reales ese día (el centro aún no opera en el PMS)",
  actual_missing: "sin ocupación realizada",
  deterministic_without_otb: "previsión determinista sin reservas que la corroboren",
  los_unknown: "sin estancia media para estimar llegadas y salidas",
  pax_unknown: "sin huéspedes por habitación",
  covers_unknown: "sin régimen conocido para estimar cubiertos",
  no_standards: "sin estándares vigentes",
  no_drivers: "sin drivers de ocupación",
  rooms: "sin habitaciones ocupadas",
  arrivals: "sin llegadas",
  departures: "sin salidas",
  stayovers: "sin habitaciones cliente",
  pax: "sin huéspedes",
  covers_breakfast: "sin cubiertos de desayuno",
  covers_restaurant: "sin comensales de restaurante",
  occupied_rooms: "sin habitaciones ocupadas",
  rooms_inventory: "sin inventario de habitaciones"
});

const DRIVER_REASON_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  rooms: "habitaciones ocupadas",
  occupied_rooms: "habitaciones ocupadas",
  arrivals: "llegadas",
  departures: "salidas",
  stayovers: "habitaciones cliente",
  pax: "huéspedes",
  covers_breakfast: "cubiertos de desayuno",
  covers_restaurant: "comensales de restaurante",
  rooms_inventory: "inventario de habitaciones"
});

export function degradedReasonLabel(reason: string): string {
  const known = DEGRADED_REASON_LABELS_ES[reason];
  if (known) return known;
  const driver = /^driver_missing:(.+)$/.exec(reason)?.[1];
  if (driver) return `sin ${DRIVER_REASON_LABELS_ES[driver] ?? driver.replace(/_/g, " ")}`;
  return reason;
}

/** Texto de ayuda de un día degradado: sus motivos en español (únicos), o el genérico. */
export function degradedHint(reasons: readonly string[]): string {
  const labels = unique(reasons.map(degradedReasonLabel));
  return labels.length > 0 ? `Previsión incompleta: ${labels.join(", ")}.` : "Previsión incompleta: faltan drivers de ocupación.";
}

// ---------------------------------------------------------------------------
// Estándares: borrador editable ↔ PUT /hr/properties/:id/standards
// ---------------------------------------------------------------------------

export type StandardDraftRow = {
  /** Clave estable de la fila (departamento · driver · unidad). */
  key: string;
  usaliDepartment: HrUsaliDepartment;
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  value: string;
  bands: LaborStandardBand[] | null;
  allowancePct: string;
  coverageFactor: string;
  source: LaborStandardSource;
};

export type StandardDraftField = "value" | "allowancePct" | "coverageFactor";

export function standardKey(standard: Pick<LaborStandardDto, "usaliDepartment" | "driver" | "unit">): string {
  return `${standard.usaliDepartment}:${standard.driver}:${standard.unit}`;
}

function trimDecimal(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const parsed = Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed)) return String(value);
  return String(Math.round(parsed * 1000) / 1000);
}

const DRIVER_ORDER: readonly string[] = ["stayovers", "departures", "arrivals", "occupied_rooms", "pax", "covers_breakfast", "covers_restaurant", "rooms_inventory", "fixed"];

function driverOrder(driver: string): number {
  const index = DRIVER_ORDER.indexOf(driver);
  return index === -1 ? DRIVER_ORDER.length : index;
}

/** Filas editables a partir de los estándares vigentes, en orden canónico (departamento, driver); decimales sin ceros de relleno («32», «13.067»). */
export function standardsToDraft(standards: readonly LaborStandardDto[]): StandardDraftRow[] {
  const ordered = [...standards].sort((a, b) => departmentOrder(a.usaliDepartment) - departmentOrder(b.usaliDepartment) || driverOrder(a.driver) - driverOrder(b.driver) || a.unit.localeCompare(b.unit));
  return ordered.map((standard) => ({
    key: standardKey(standard),
    usaliDepartment: standard.usaliDepartment,
    driver: standard.driver,
    unit: standard.unit,
    value: trimDecimal(standard.value),
    bands: standard.bands ? standard.bands.map((band) => ({ maxOccupiedRooms: band.maxOccupiedRooms, posts: [...band.posts] as [number, number, number] })) : null,
    allowancePct: trimDecimal(standard.allowancePct),
    coverageFactor: trimDecimal(standard.coverageFactor),
    source: standard.source
  }));
}

/** Cambia un campo numérico de una fila; el origen pasa a «medido en el centro». */
export function updateStandardDraft(rows: readonly StandardDraftRow[], key: string, field: StandardDraftField, value: string): StandardDraftRow[] {
  return rows.map((row) => (row.key === key ? { ...row, [field]: value, source: "measured" } : row));
}

const DECIMAL_INPUT = /^\d+([.,]\d{1,3})?$/;

function decimalError(value: string, label: string, options: { min?: number; max?: number } = {}): string | null {
  const text = value.trim();
  if (text === "") return `${label} es obligatorio.`;
  if (!DECIMAL_INPUT.test(text)) return `${label} debe ser un número con hasta tres decimales.`;
  const parsed = Number(text.replace(",", "."));
  if (options.min !== undefined && parsed < options.min) return `${label} no puede ser menor que ${number(options.min)}.`;
  if (options.max !== undefined && parsed > options.max) return `${label} no puede ser mayor que ${number(options.max)}.`;
  return null;
}

/** Errores por fila (clave → primer error en español); vacío cuando todo es válido. */
export function standardDraftErrors(rows: readonly StandardDraftRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const error = decimalError(row.value, "El valor", { min: 0 }) ?? decimalError(row.allowancePct, "El margen", { min: 0, max: 100 }) ?? decimalError(row.coverageFactor, "La cobertura", { min: 0.5, max: 3 });
    if (error) errors[row.key] = error;
  }
  return errors;
}

/** El borrador difiere de lo cargado (solo campos editables). */
export function standardsDirty(draft: readonly StandardDraftRow[], loaded: readonly StandardDraftRow[]): boolean {
  if (draft.length !== loaded.length) return true;
  return draft.some((row, index) => {
    const base = loaded[index];
    return !base || row.key !== base.key || row.value !== base.value || row.allowancePct !== base.allowancePct || row.coverageFactor !== base.coverageFactor;
  });
}

export type StandardsPutBody = {
  validFrom?: string;
  standards: Array<{
    usaliDepartment: HrUsaliDepartment;
    driver: LaborStandardDriver;
    unit: LaborStandardUnit;
    value: string;
    bands: LaborStandardBand[] | null;
    allowancePct: string;
    coverageFactor: string;
    source: LaborStandardSource;
  }>;
};

/** Cuerpo del PUT (coma decimal normalizada a punto; los tramos viajan tal cual). */
export function standardsPutBody(rows: readonly StandardDraftRow[], validFrom?: string): StandardsPutBody {
  const body: StandardsPutBody = {
    standards: rows.map((row) => ({
      usaliDepartment: row.usaliDepartment,
      driver: row.driver,
      unit: row.unit,
      value: row.value.trim().replace(",", "."),
      bands: row.unit === "posts_by_band" ? row.bands : null,
      allowancePct: row.allowancePct.trim().replace(",", "."),
      coverageFactor: row.coverageFactor.trim().replace(",", "."),
      source: row.source
    }))
  };
  if (validFrom) body.validFrom = validFrom;
  return body;
}

// ---------------------------------------------------------------------------
// Plantilla máxima: borrador ↔ POST /hr/properties/:id/staffing-plans
// ---------------------------------------------------------------------------

export type PlanDraft = {
  year: string;
  season: StaffingSeason;
  fromMonth: string;
  toMonth: string;
  /** maxFte por departamento como texto («4,5»); vacío = sin línea. */
  lines: Record<HrUsaliDepartment, string>;
};

/** Meses por defecto de cada temporada (Galicia y cornisa cantábrica: alta jun–sep, media abr–may y oct, baja nov–mar). */
export const SEASON_DEFAULT_MONTHS: Readonly<Record<StaffingSeason, { fromMonth: number; toMonth: number }>> = Object.freeze({
  high: { fromMonth: 6, toMonth: 9 },
  shoulder: { fromMonth: 4, toMonth: 5 },
  low: { fromMonth: 11, toMonth: 3 }
});

export function emptyPlanLines(): Record<HrUsaliDepartment, string> {
  return Object.fromEntries(HR_FORECAST_DEPARTMENTS.map((department) => [department, ""])) as Record<HrUsaliDepartment, string>;
}

export function newPlanDraft(year: number, season: StaffingSeason = "high"): PlanDraft {
  const months = SEASON_DEFAULT_MONTHS[season];
  return { year: String(year), season, fromMonth: String(months.fromMonth), toMonth: String(months.toMonth), lines: emptyPlanLines() };
}

/** Cambia la temporada y propone sus meses por defecto. */
export function planDraftWithSeason(draft: PlanDraft, season: StaffingSeason): PlanDraft {
  const months = SEASON_DEFAULT_MONTHS[season];
  return { ...draft, season, fromMonth: String(months.fromMonth), toMonth: String(months.toMonth) };
}

export type PlanDraftErrors = Partial<Record<"year" | "season" | "months" | "lines", string>>;

export function planDraftErrors(draft: PlanDraft): PlanDraftErrors {
  const errors: PlanDraftErrors = {};
  const year = Number(draft.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.year = "El año debe ser un entero entre 2000 y 2100.";
  if (!STAFFING_SEASONS.includes(draft.season)) errors.season = "Elige una temporada.";
  const fromMonth = Number(draft.fromMonth);
  const toMonth = Number(draft.toMonth);
  if (!Number.isInteger(fromMonth) || fromMonth < 1 || fromMonth > 12 || !Number.isInteger(toMonth) || toMonth < 1 || toMonth > 12) errors.months = "Los meses deben estar entre 1 y 12.";
  let lines = 0;
  for (const department of HR_FORECAST_DEPARTMENTS) {
    const text = draft.lines[department]?.trim() ?? "";
    if (text === "") continue;
    if (!DECIMAL_INPUT.test(text)) {
      errors.lines = `${HR_FORECAST_DEPARTMENT_LABELS_ES[department]}: el máximo de FTE debe ser un número.`;
      break;
    }
    lines += 1;
  }
  if (!errors.lines && lines === 0) errors.lines = "Indica el máximo de FTE de al menos un departamento.";
  return errors;
}

export type StaffingPlanBody = {
  year: number;
  season: StaffingSeason;
  fromMonth: number;
  toMonth: number;
  lines: Array<{ usaliDepartment: HrUsaliDepartment; maxFte: string }>;
};

/** Cuerpo del POST: solo los departamentos con cifra (coma → punto). */
export function planDraftBody(draft: PlanDraft): StaffingPlanBody {
  return {
    year: Number(draft.year),
    season: draft.season,
    fromMonth: Number(draft.fromMonth),
    toMonth: Number(draft.toMonth),
    lines: HR_FORECAST_DEPARTMENTS.filter((department) => (draft.lines[department]?.trim() ?? "") !== "").map((department) => ({ usaliDepartment: department, maxFte: draft.lines[department].trim().replace(",", ".") }))
  };
}

const MONTH_SHORT_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"] as const;

export function monthShortLabel(month: number): string {
  return MONTH_SHORT_ES[month - 1] ?? String(month);
}

/** «jun–sep» · «nov–mar» (cruza el año). */
export function planMonthsLabel(plan: Pick<StaffingPlanDto, "fromMonth" | "toMonth">): string {
  return `${monthShortLabel(plan.fromMonth)}–${monthShortLabel(plan.toMonth)}`;
}

export const MONTH_OPTIONS: readonly CocoaSelectOption[] = MONTH_SHORT_ES.map((label, index) => ({ value: String(index + 1), label: `${index + 1} · ${label}` }));

export const SEASON_OPTIONS: readonly CocoaSelectOption[] = STAFFING_SEASONS.map((season) => ({ value: season, label: STAFFING_SEASON_LABELS_ES[season] }));

/** maxFte de un departamento en un plan, o null. */
export function planLineFte(plan: Pick<StaffingPlanDto, "lines">, department: string): number | null {
  const line = plan.lines.find((item) => item.usaliDepartment === department);
  return line ? toFte(line.maxFte) : null;
}

/** «Habitaciones 6 · A&B 3,5 · Mantenimiento 1» — resumen de líneas de un plan. */
export function planLinesSummary(plan: Pick<StaffingPlanDto, "lines">): string {
  if (plan.lines.length === 0) return "Sin líneas";
  return [...plan.lines]
    .sort((a, b) => departmentOrder(a.usaliDepartment) - departmentOrder(b.usaliDepartment))
    .map((line) => `${departmentLabel(line.usaliDepartment)} ${formatFte(line.maxFte)}`)
    .join(" · ");
}

/** Planes ordenados: año descendente, temporada alta → media → baja. */
export function sortPlans(plans: readonly StaffingPlanDto[]): StaffingPlanDto[] {
  return [...plans].sort((a, b) => (a.year === b.year ? STAFFING_SEASONS.indexOf(a.season) - STAFFING_SEASONS.indexOf(b.season) : b.year - a.year));
}

/** Un plan aprobado no admite otra aprobación; un borrador sí (el API aplica la SoD). */
export function planApprovable(plan: Pick<StaffingPlanDto, "status">): boolean {
  return plan.status === "draft";
}

// ---------------------------------------------------------------------------
// KPIs del panel
// ---------------------------------------------------------------------------

export function kpisDegradedLabels(kpis: Pick<HrKpisDto, "degraded"> | null | undefined): string[] {
  return degradedCodes(kpis?.degraded);
}

/** «5,2 de 6 FTE máximo» · «sin plan aprobado» — pie del KPI de FTE disponible. */
export function fteVsMaxCaption(availableFte: FteInput, approvedMaxFte: FteInput): string {
  const approved = toFte(approvedMaxFte);
  if (approved === null) return "sin plan aprobado";
  return `de ${formatFte(approved)} FTE máximo`;
}

/** «12,4 % s/ ventas del libro» · «12,4 % s/ ventas de referencia» · «nómina calculada · sin dato de ventas» (RF-09) · «sin dato de ventas». */
export function laborCostCaption(pct: string | null, salesSource: "ledger" | "reference" | null, costSource: "import" | "payroll" | null = null): string {
  const parsed = toFte(pct);
  if (parsed === null) return costSource === "payroll" ? "nómina calculada · sin dato de ventas" : "sin dato de ventas";
  return `${percent(parsed)} s/ ventas ${salesSource === "reference" ? "de referencia" : "del libro"}`;
}

/** Coste medio por empleado como pie («1.234,00 € por empleado»), o «sin dato de empleados». */
export function costPerEmployeeCaption(costPerEmployee: string | null): string {
  return costPerEmployee === null ? "sin dato de empleados" : `${money(costPerEmployee)} por empleado`;
}

/** Estado del KPI de FTE disponible frente al máximo aprobado (nunca verde sin cifra). */
export function fteKpiStatus(availableFte: FteInput, approvedMaxFte: FteInput): "ok" | "warning" | "critical" {
  const available = toFte(availableFte);
  const approved = toFte(approvedMaxFte);
  if (available === null || approved === null) return "warning";
  return available > approved ? "critical" : "ok";
}

/** Mes «YYYY-MM» de una fecha ISO o de un Date (UTC). */
export function monthCodeOf(value: string | Date): string {
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 7);
}

/** Opciones de mes hacia atrás desde `current` («sept 2026», «ago 2026»…), la más reciente primero. */
export function monthOptions(current: string, back = 12): CocoaSelectOption[] {
  const [year, month] = current.split("-").map(Number);
  const options: CocoaSelectOption[] = [];
  for (let index = 0; index < back; index += 1) {
    const total = year * 12 + (month - 1) - index;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const code = `${y}-${String(m).padStart(2, "0")}`;
    options.push({ value: code, label: date(`${code}-01`, "monthYear") });
  }
  return options;
}
