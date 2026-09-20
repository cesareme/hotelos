import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { HrAlertDto, LaborForecastDayDto, LaborStandardDto, StaffingPlanDto } from "@hotelos/shared";
import {
  COVERAGE_TOLERANCE,
  DEFAULT_FORECAST_RANGE_DAYS,
  FORECAST_DEPARTMENT_ALL,
  FORECAST_MAX_DAYS,
  FORECAST_RANGE_OPTIONS,
  FORECAST_SERIES,
  FORECAST_SERIES_TONES,
  HR_ALERT_KIND_LABELS_ES,
  HR_ALERT_SEVERITY_LABELS_ES,
  HR_FORECAST_DEPARTMENTS,
  HR_FORECAST_DEPARTMENT_LABELS_ES,
  HR_KPI_DEGRADED_CODES,
  LABOR_FORECAST_SOURCE_LABELS_ES,
  LABOR_STANDARD_DRIVER_LABELS_ES,
  LABOR_STANDARD_SOURCE_LABELS_ES,
  LABOR_STANDARD_UNIT_LABELS_ES,
  MONTH_OPTIONS,
  SEASON_DEFAULT_MONTHS,
  SEASON_OPTIONS,
  STAFFING_PLAN_STATUS_LABELS_ES,
  STAFFING_SEASONS,
  STAFFING_SEASON_LABELS_ES,
  addDays,
  alertKindLabel,
  alertTone,
  bandsLabel,
  contractExpiringAlerts,
  costPerEmployeeCaption,
  coverageStatus,
  dayBars,
  dayLabel,
  daysBetween,
  degradedCodes,
  degradedHint,
  degradedMessages,
  degradedReasonLabel,
  departmentLabel,
  departmentRows,
  employeeNameFor,
  filterForecastDepartment,
  forecastBars,
  forecastDepartmentOptions,
  forecastSourceLabel,
  forecastWindow,
  formatFte,
  formatFteUnit,
  formatHours,
  fteFromHours,
  fteKpiStatus,
  fteVsMaxCaption,
  groupForecastByDay,
  groupForecastByDepartment,
  isIsoDay,
  isoDayOf,
  kpisDegradedLabels,
  laborCostCaption,
  approvedPlanFor,
  planCoversMonth,
  requiredFteLabel,
  monthCodeOf,
  monthOptions,
  monthShortLabel,
  newPlanDraft,
  parseForecastRangeDays,
  planApprovable,
  planDraftBody,
  planDraftErrors,
  planDraftWithSeason,
  planLineFte,
  planLinesSummary,
  planMonthsLabel,
  planStatusTone,
  rowDegradedLabels,
  sortAlerts,
  sortForecastRows,
  sortPlans,
  standardConceptLabel,
  standardDraftErrors,
  standardKey,
  standardValueSuffix,
  standardsDirty,
  standardsPutBody,
  standardsToDraft,
  sumNullable,
  toFte,
  updateStandardDraft,
  windowLabel
} from "../hr-forecast-helpers.ts";

// Pure helpers only (no React, no api-client). Every figure is SYNTHETIC: the
// fixtures below describe an invented four-star hotel, never a real employee.

/** Intl separates figures from units with a no-break space; the assertions compare on a plain one. */
const plain = (text: string) => text.replace(/ /g, " ");

const shared = readFileSync(new URL("../../../../../../packages/shared/src/hr-types.ts", import.meta.url), "utf8");

function sharedArray(name: string): string[] {
  const block = shared.match(new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(block, `${name} not found in hr-types.ts`);
  return [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

const drivers = (rooms: number | null, arrivals = 10, departures = 8) => ({ rooms, arrivals, departures, stayovers: rooms === null ? null : rooms - departures, pax: rooms === null ? null : rooms * 2, coversBreakfast: rooms === null ? null : rooms * 2, coversRestaurant: null, roomsInventory: 60 });

function row(input: Partial<LaborForecastDayDto> & { date: string; usaliDepartment: LaborForecastDayDto["usaliDepartment"] }): LaborForecastDayDto {
  return {
    propertyId: "prop_hr_test",
    drivers: drivers(42),
    requiredHours: "41.60",
    requiredFte: "5.20",
    plannedHours: "40.00",
    availableFte: "6.00",
    approvedFte: "6.50",
    estimatedCost: "812.50",
    source: "otb",
    degraded: false,
    degradedReasons: [],
    generatedAt: "2026-09-20T06:00:00.000Z",
    ...input
  };
}

const ROWS: LaborForecastDayDto[] = [
  row({ date: "2026-09-22", usaliDepartment: "fnb", requiredHours: "16.00", requiredFte: "2.00", plannedHours: "16.00", availableFte: "2.00", approvedFte: "3.00", estimatedCost: "300.00" }),
  row({ date: "2026-09-22", usaliDepartment: "rooms" }),
  row({ date: "2026-09-21", usaliDepartment: "rooms", requiredHours: null, requiredFte: null, plannedHours: null, availableFte: "6.00", approvedFte: null, estimatedCost: null, source: null, degraded: true, degradedReasons: ["rooms", "arrivals"], drivers: drivers(null) }),
  row({ date: "2026-09-21", usaliDepartment: "pom", requiredHours: "8.00", requiredFte: "1.00", plannedHours: "8.00", availableFte: "1.00", approvedFte: "1.00", estimatedCost: null, source: "pms_forecast" }),
  row({ date: "2026-09-21", usaliDepartment: "all", requiredHours: "99.00", requiredFte: "99.00" })
];

const STANDARDS: LaborStandardDto[] = [
  { id: "std_1", propertyId: "prop_hr_test", usaliDepartment: "rooms", driver: "stayovers", unit: "minutes_per_unit", value: "20.000", bands: null, allowancePct: "12.00", coverageFactor: "1.40", validFrom: "2026-01-01", validTo: null, source: "sector_default" },
  { id: "std_2", propertyId: "prop_hr_test", usaliDepartment: "rooms", driver: "occupied_rooms", unit: "posts_by_band", value: "8.000", bands: [{ maxOccupiedRooms: 60, posts: [1, 1, 1] }, { maxOccupiedRooms: null, posts: [2, 2, 1] }], allowancePct: "0.00", coverageFactor: "1.40", validFrom: "2026-01-01", validTo: null, source: "measured" },
  { id: "std_3", propertyId: "prop_hr_test", usaliDepartment: "fnb", driver: "covers_breakfast", unit: "minutes_per_unit", value: "13.067", bands: null, allowancePct: "0.00", coverageFactor: "1.40", validFrom: "2026-01-01", validTo: null, source: "sector_default" }
];

function plan(input: Partial<StaffingPlanDto>): StaffingPlanDto {
  return {
    id: "plan_high",
    propertyId: "prop_hr_test",
    year: 2026,
    season: "high",
    fromMonth: 6,
    toMonth: 9,
    status: "approved",
    createdBy: "usr_a",
    approvedBy: "usr_b",
    approvedAt: "2026-05-01T10:00:00.000Z",
    lines: [
      { usaliDepartment: "pom", maxFte: "1.00", maxHeadcount: null, budgetMonthlyCost: null },
      { usaliDepartment: "rooms", maxFte: "6.50", maxHeadcount: 8, budgetMonthlyCost: null },
      { usaliDepartment: "fnb", maxFte: "3.00", maxHeadcount: null, budgetMonthlyCost: null }
    ],
    totalMaxFte: "10.50",
    ...input
  };
}

function alert(input: Partial<HrAlertDto>): HrAlertDto {
  return { kind: "understaffed", severity: "warning", propertyId: "prop_hr_test", usaliDepartment: "rooms", date: "2026-09-22", message: "Falta personal en pisos.", value: "4.00", threshold: "5.20", employeeId: null, ...input };
}

describe("hr-forecast-helpers · vocabularios (espejo de hr-types.ts)", () => {
  it("mirrors HR_USALI_DEPARTMENTS, sources, drivers, units, standard sources, seasons, statuses and alert kinds with a Spanish label each", () => {
    assert.deepEqual([...HR_FORECAST_DEPARTMENTS], sharedArray("HR_USALI_DEPARTMENTS"));
    assert.deepEqual(Object.keys(HR_FORECAST_DEPARTMENT_LABELS_ES), sharedArray("HR_USALI_DEPARTMENTS"));
    assert.deepEqual(Object.keys(LABOR_FORECAST_SOURCE_LABELS_ES), sharedArray("LABOR_FORECAST_SOURCES"));
    assert.deepEqual(Object.keys(LABOR_STANDARD_DRIVER_LABELS_ES), sharedArray("LABOR_STANDARD_DRIVERS"));
    assert.deepEqual(Object.keys(LABOR_STANDARD_UNIT_LABELS_ES), sharedArray("LABOR_STANDARD_UNITS"));
    assert.deepEqual(Object.keys(LABOR_STANDARD_SOURCE_LABELS_ES), sharedArray("LABOR_STANDARD_SOURCES"));
    assert.deepEqual([...STAFFING_SEASONS], sharedArray("STAFFING_SEASONS"));
    assert.deepEqual(Object.keys(STAFFING_SEASON_LABELS_ES), sharedArray("STAFFING_SEASONS"));
    assert.deepEqual(Object.keys(STAFFING_PLAN_STATUS_LABELS_ES), sharedArray("STAFFING_PLAN_STATUSES"));
    assert.deepEqual(Object.keys(HR_ALERT_KIND_LABELS_ES), sharedArray("HR_ALERT_KINDS"));
    assert.deepEqual(Object.keys(HR_ALERT_SEVERITY_LABELS_ES), sharedArray("HR_ALERT_SEVERITIES"));
    for (const label of [...Object.values(HR_FORECAST_DEPARTMENT_LABELS_ES), ...Object.values(LABOR_FORECAST_SOURCE_LABELS_ES), ...Object.values(HR_ALERT_KIND_LABELS_ES)]) {
      assert.match(label, /^[A-ZÁÉÍÓÚÑ]/, `label «${label}» starts with a capital`);
      assert.doesNotMatch(label, /_/, `label «${label}» is not an enum`);
    }
    assert.equal(departmentLabel("rooms"), "Habitaciones");
    assert.equal(departmentLabel(FORECAST_DEPARTMENT_ALL), "Todos los departamentos");
    assert.equal(departmentLabel(null), "Todos los departamentos");
    assert.equal(departmentLabel("spa"), "spa");
    assert.equal(forecastSourceLabel("otb"), "Reservas en cartera");
    assert.equal(forecastSourceLabel(null), "Sin origen");
    assert.equal(alertKindLabel("contract_expiring"), "Contrato que vence");
    assert.equal(alertTone("critical"), "danger");
    assert.equal(alertTone("warning"), "warning");
    assert.equal(alertTone("info"), "info");
    assert.equal(planStatusTone("approved"), "success");
    assert.equal(planStatusTone("draft"), "warning");
    assert.deepEqual(SEASON_OPTIONS.map((o) => o.value), ["high", "shoulder", "low"]);
    assert.equal(MONTH_OPTIONS.length, 12);
    assert.equal(MONTH_OPTIONS[8].label, "9 · sept");
    assert.equal(monthShortLabel(12), "dic");
  });
});

describe("hr-forecast-helpers · FTE y horas", () => {
  it("parses two-decimal wire strings (and a Spanish comma) without inventing a 0", () => {
    assert.equal(toFte("5.20"), 5.2);
    assert.equal(toFte("4,5"), 4.5);
    assert.equal(toFte(3), 3);
    assert.equal(toFte(null), null);
    assert.equal(toFte(""), null);
    assert.equal(toFte("abc"), null);
  });

  it("formats «5,2», «12», «5,2 FTE», «41,6 h» and «—» when missing", () => {
    assert.equal(formatFte("5.20"), "5,2");
    assert.equal(formatFte("12.00"), "12");
    assert.equal(formatFte("0.75"), "0,75");
    assert.equal(formatFte(null), "—");
    assert.equal(plain(formatFteUnit("5.20")), "5,2 FTE");
    assert.equal(formatFteUnit(undefined), "—");
    assert.equal(plain(formatHours("41.60")), "41,6 h");
    assert.equal(plain(formatHours("41.65")), "41,7 h");
    assert.equal(formatHours(null), "—");
  });

  it("derives FTE from planned hours on an 8 h day and sums nullable figures (null only when every one is missing)", () => {
    assert.equal(fteFromHours("40.00"), 5);
    assert.equal(fteFromHours("41.60"), 5.2);
    assert.equal(fteFromHours(null), null);
    assert.equal(fteFromHours("8", 0), null);
    assert.equal(sumNullable(["1.10", null, 2.2]), 3.3);
    assert.equal(sumNullable([null, undefined, ""]), null);
    assert.equal(sumNullable([]), null);
  });
});

describe("hr-forecast-helpers · tramos de fechas", () => {
  it("offers 14 and 28 days, parses the segmented value and clamps the window to the API cap", () => {
    assert.deepEqual(FORECAST_RANGE_OPTIONS.map((o) => o.value), ["14", "28"]);
    assert.equal(FORECAST_RANGE_OPTIONS[1].label, "28 días");
    assert.equal(DEFAULT_FORECAST_RANGE_DAYS, 14);
    assert.equal(parseForecastRangeDays("28"), 28);
    assert.equal(parseForecastRangeDays("7"), 14);
    assert.equal(parseForecastRangeDays(null), 14);
    assert.deepEqual(forecastWindow("2026-09-20", 14, "2026-09-01"), { from: "2026-09-20", to: "2026-10-03", days: 14 });
    assert.deepEqual(forecastWindow("2026-12-25", 28, "2026-09-01"), { from: "2026-12-25", to: "2027-01-21", days: 28 });
    assert.deepEqual(forecastWindow("nope", 14, "2026-09-01"), { from: "2026-09-01", to: "2026-09-14", days: 14 });
    assert.equal(forecastWindow("2026-09-01", 500, "2026-09-01").days, FORECAST_MAX_DAYS);
    assert.equal(forecastWindow("2026-09-01", 0, "2026-09-01").days, 14);
  });

  it("adds calendar days, counts inclusive spans and validates ISO days", () => {
    assert.equal(addDays("2026-02-28", 1), "2026-03-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(daysBetween("2026-09-20", "2026-10-03"), 14);
    assert.equal(daysBetween("2026-09-20", "2026-09-20"), 1);
    assert.equal(daysBetween("2026-09-21", "2026-09-20"), 0);
    assert.equal(daysBetween("x", "2026-09-20"), 0);
    assert.equal(isIsoDay("2026-02-30"), false);
    assert.equal(isIsoDay("2026-02-28"), true);
    assert.equal(isoDayOf(new Date("2026-09-20T23:30:00Z")), "2026-09-20");
  });

  it("labels the window and the day in Spanish through lib/format", () => {
    assert.equal(plain(windowLabel({ from: "2026-09-21", to: "2026-10-04" })), "lun, 21 sept – dom, 4 oct");
    assert.equal(plain(dayLabel("2026-09-22")), "mar, 22 sept");
  });
});

describe("hr-forecast-helpers · tramos de puestos y concepto del estándar", () => {
  it("paints the posts_by_band bands as «≤ N hab.: m · t · n | resto: …» and names the concept", () => {
    assert.equal(plain(bandsLabel(STANDARDS[1].bands)), "≤ 60 hab.: 1 · 1 · 1 | resto: 2 · 2 · 1");
    assert.equal(bandsLabel(null), "—");
    assert.equal(bandsLabel([]), "—");
    assert.equal(standardConceptLabel(STANDARDS[0]), "Habitaciones cliente · minutos por unidad");
    assert.equal(standardConceptLabel(STANDARDS[1]), "Habitaciones ocupadas · puestos por tramo");
    assert.equal(standardValueSuffix("minutes_per_unit"), "min");
    assert.equal(standardValueSuffix("fte_per_100"), "FTE/100 hab.");
    assert.equal(standardValueSuffix("nope"), "");
    assert.equal(standardKey(STANDARDS[2]), "fnb:covers_breakfast:minutes_per_unit");
  });
});

describe("hr-forecast-helpers · agrupación de la previsión", () => {
  it("drops the legacy «all» row when the departments are there, keeps it otherwise, and sorts by date then canonical department", () => {
    const detailed = departmentRows(ROWS);
    assert.equal(detailed.length, 4);
    assert.ok(detailed.every((r) => r.usaliDepartment !== "all"));
    const only = departmentRows([ROWS[4]]);
    assert.equal(only.length, 1);
    assert.equal(only[0].usaliDepartment, "all");
    assert.deepEqual(sortForecastRows(ROWS).map((r) => `${r.date}:${r.usaliDepartment}`), ["2026-09-21:rooms", "2026-09-21:pom", "2026-09-21:all", "2026-09-22:rooms", "2026-09-22:fnb"]);
  });

  it("groups by day with null-safe totals, planned FTE from hours, degraded when any department is, and unique sources", () => {
    const days = groupForecastByDay(ROWS);
    assert.deepEqual(days.map((d) => d.date), ["2026-09-21", "2026-09-22"]);
    const monday = days[0];
    assert.equal(monday.rows.length, 2);
    assert.equal(monday.requiredFte, 1);
    assert.equal(monday.requiredHours, 8);
    assert.equal(monday.plannedHours, 8);
    assert.equal(monday.plannedFte, 1);
    assert.equal(monday.availableFte, 7);
    assert.equal(monday.approvedFte, 1);
    assert.equal(monday.estimatedCost, null);
    assert.equal(monday.degraded, true);
    assert.deepEqual(monday.degradedReasons, ["rooms", "arrivals"]);
    assert.deepEqual(monday.sources, ["pms_forecast"]);
    const tuesday = days[1];
    assert.equal(tuesday.requiredFte, 7.2);
    assert.equal(tuesday.plannedHours, 56);
    assert.equal(tuesday.plannedFte, 7);
    assert.equal(tuesday.availableFte, 8);
    assert.equal(tuesday.approvedFte, 9.5);
    assert.equal(tuesday.estimatedCost, 1112.5);
    assert.equal(tuesday.degraded, false);
    assert.deepEqual(tuesday.sources, ["otb"]);
    assert.deepEqual(groupForecastByDay([]), []);
  });

  it("groups by department with averages over the days that have a figure, the degraded count and the max approved", () => {
    const groups = groupForecastByDepartment(ROWS);
    assert.deepEqual(groups.map((g) => g.usaliDepartment), ["rooms", "fnb", "pom"]);
    const rooms = groups[0];
    assert.equal(rooms.label, "Habitaciones");
    assert.equal(rooms.days, 2);
    assert.equal(rooms.degradedDays, 1);
    assert.equal(rooms.requiredFteAvg, 5.2);
    assert.equal(rooms.requiredHours, 41.6);
    assert.equal(rooms.plannedFteAvg, 5);
    assert.equal(rooms.availableFteAvg, 6);
    assert.equal(rooms.approvedFteMax, 6.5);
    assert.equal(rooms.estimatedCost, 812.5);
    const pom = groups[2];
    assert.equal(pom.days, 1);
    assert.equal(pom.estimatedCost, null);
  });

  it("offers the departments present as select options (with «Todos» first) and filters rows by one", () => {
    assert.deepEqual(forecastDepartmentOptions(ROWS).map((o) => o.value), ["all", "rooms", "fnb", "pom"]);
    assert.equal(forecastDepartmentOptions(ROWS)[0].label, "Todos los departamentos");
    assert.equal(filterForecastDepartment(ROWS, "rooms").length, 2);
    assert.equal(filterForecastDepartment(ROWS, "all").length, 4);
    assert.equal(filterForecastDepartment(ROWS, "spa").length, 0);
  });
});

describe("hr-forecast-helpers · cobertura y barras", () => {
  it("never paints a green «ok» without figures and flags over-approved, under and over staffing beyond ±10 %", () => {
    assert.equal(COVERAGE_TOLERANCE, 0.1);
    assert.equal(coverageStatus({ requiredFte: null, availableFte: "6", approvedFte: "6" }).key, "unknown");
    assert.equal(coverageStatus({ requiredFte: "5", availableFte: null, approvedFte: null }).key, "unknown");
    assert.deepEqual(coverageStatus({ requiredFte: "7", availableFte: "7", approvedFte: "6.5" }), { key: "over_approved", label: "Supera el máximo aprobado", tone: "danger" });
    assert.deepEqual(coverageStatus({ requiredFte: "5.2", availableFte: "4", approvedFte: "6.5" }), { key: "understaffed", label: "Falta personal", tone: "warning" });
    assert.deepEqual(coverageStatus({ requiredFte: "5.2", availableFte: "6.5", approvedFte: null }), { key: "overstaffed", label: "Sobra personal", tone: "info" });
    assert.deepEqual(coverageStatus({ requiredFte: "5.2", availableFte: "5.5", approvedFte: "6.5" }), { key: "ok", label: "En banda", tone: "success" });
    assert.equal(coverageStatus({ requiredFte: "0", availableFte: "0", approvedFte: null }).key, "ok");
    assert.equal(coverageStatus({ requiredFte: "0", availableFte: "1", approvedFte: null }).key, "overstaffed");
  });

  it("builds three bars per department (necesario · planificado · disponible) skipping missing values, and two per day for the panel", () => {
    assert.deepEqual([...FORECAST_SERIES], ["required", "planned", "available"]);
    assert.deepEqual(FORECAST_SERIES_TONES, { required: "accent", planned: "warning", available: "info" });
    const tuesday = groupForecastByDay(ROWS)[1];
    const bars = forecastBars(tuesday.rows);
    assert.equal(bars.length, 6);
    assert.equal(bars[0].label, "Habitaciones · Necesario");
    assert.equal(bars[0].value, 5.2);
    assert.equal(bars[0].tone, "accent");
    assert.equal(bars[1].label, "Habitaciones · Planificado");
    assert.equal(bars[1].value, 5);
    assert.equal(bars[2].tone, "info");
    assert.match(plain(bars[0].hint ?? ""), /máximo aprobado 6,5 FTE/);
    const monday = groupForecastByDay(ROWS)[0];
    const mondayBars = forecastBars(monday.rows);
    // rooms on Monday has no required nor planned figure: only its available bar plus the three of pom.
    assert.equal(mondayBars.length, 4);
    assert.equal(mondayBars[0].label, "Habitaciones · Disponible");
    const perDay = dayBars(groupForecastByDay(ROWS));
    assert.equal(perDay.length, 4);
    // RF-16: Monday is degraded (rooms without a figure): the required bar says it is a partial sum.
    assert.equal(plain(perDay[0].label), "21 sept · Necesario (parcial)");
    assert.equal(perDay[0].tone, "accent");
    assert.match(perDay[0].hint ?? "", /Previsión incompleta: suma solo los departamentos con cifra/);
    assert.equal(plain(perDay[1].label), "21 sept · Planificado", "only the required series carries the partial mark");
    assert.equal(plain(perDay[3].label), "22 sept · Planificado");
    assert.equal(perDay[3].value, 7);
    assert.deepEqual(dayBars([]), []);
    const required = dayBars(groupForecastByDay(ROWS), "required");
    assert.deepEqual(required.map((b) => [plain(b.label), b.value, b.tone]), [["21 sept · Necesario (parcial)", 1, "accent"], ["22 sept · Necesario", 7.2, "accent"]]);
    assert.equal(plain(requiredFteLabel(groupForecastByDay(ROWS)[0])), "1 FTE necesarios (parcial)");
    assert.equal(plain(requiredFteLabel(groupForecastByDay(ROWS)[1])), "7,2 FTE necesarios");
    assert.equal(requiredFteLabel({ requiredFte: null, degraded: true }), "— necesarios");
    const planned = dayBars(groupForecastByDay(ROWS), "planned");
    assert.deepEqual(planned.map((b) => [plain(b.label), b.value, b.tone]), [["21 sept · Planificado", 1, "warning"], ["22 sept · Planificado", 7, "warning"]]);
  });
});

describe("hr-forecast-helpers · degradación", () => {
  it("turns `degraded[]` objects into unique code labels and messages, and a day into its own labels", () => {
    const entries = [
      { code: "HR_DRIVERS_DEGRADED", message: "Drivers incompletos el 2026-09-21: rooms.", propertyId: "prop_hr_test", date: "2026-09-21" },
      { code: "HR_DRIVERS_DEGRADED", message: "Drivers incompletos el 2026-09-21: rooms.", propertyId: "prop_hr_test", date: "2026-09-21" },
      { code: "HR_AGREEMENT_MISSING", message: "Centro sin convenio con jornada anual.", propertyId: "prop_hr_test" },
      { code: "", message: "" }
    ];
    assert.deepEqual(degradedCodes(entries), ["HR_DRIVERS_DEGRADED", "HR_AGREEMENT_MISSING"]);
    assert.deepEqual(degradedMessages(entries), ["Drivers incompletos el 2026-09-21: rooms.", "Centro sin convenio con jornada anual."]);
    assert.deepEqual(degradedCodes(null), []);
    assert.deepEqual(rowDegradedLabels(ROWS[2]), ["HR_DAY_DEGRADED", "rooms", "arrivals"]);
    assert.deepEqual(rowDegradedLabels(ROWS[0]), []);
    assert.equal(degradedHint(["rooms", "arrivals"]), "Previsión incompleta: sin habitaciones ocupadas, sin llegadas.");
    assert.equal(degradedHint(["driver_missing:arrivals", "driver_missing:occupied_rooms", "no_otb_no_forecast", "driver_missing:covers_breakfast", "rooms"]), "Previsión incompleta: sin llegadas, sin habitaciones ocupadas, sin reservas en cartera ni previsión del PMS, sin cubiertos de desayuno.");
    assert.equal(degradedReasonLabel("driver_missing:spa_covers"), "sin spa covers");
    assert.equal(degradedReasonLabel("engine_timeout"), "engine_timeout");
    assert.equal(degradedHint([]), "Previsión incompleta: faltan drivers de ocupación.");
    assert.deepEqual(Object.keys(HR_KPI_DEGRADED_CODES), ["availableFte", "approvedMaxFte", "requiredFte", "monthLaborCost"]);
    assert.deepEqual(kpisDegradedLabels({ degraded: [{ code: "HR_WORKFORCE_MISSING", message: "x" }] }), ["HR_WORKFORCE_MISSING"]);
    assert.deepEqual(kpisDegradedLabels(null), []);
  });
});

describe("hr-forecast-helpers · borrador de estándares", () => {
  it("maps the standards to editable rows with trimmed decimals, edits a field marking it as measured, validates and detects changes", () => {
    const draft = standardsToDraft([STANDARDS[2], STANDARDS[1], STANDARDS[0]]);
    // Canonical order (department, then driver) whatever the API order: rooms before fnb, stayovers before occupied_rooms.
    assert.deepEqual(draft.map((r) => r.key), ["rooms:stayovers:minutes_per_unit", "rooms:occupied_rooms:posts_by_band", "fnb:covers_breakfast:minutes_per_unit"]);
    assert.equal(draft[0].value, "20");
    assert.equal(draft[0].allowancePct, "12");
    assert.equal(draft[0].coverageFactor, "1.4");
    assert.equal(draft[2].value, "13.067");
    assert.deepEqual(draft[1].bands, STANDARDS[1].bands);
    assert.notEqual(draft[1].bands, STANDARDS[1].bands, "bands are copied, never shared");
    assert.equal(standardsDirty(draft, draft), false);
    const edited = updateStandardDraft(draft, "rooms:stayovers:minutes_per_unit", "value", "22,5");
    assert.equal(edited[0].value, "22,5");
    assert.equal(edited[0].source, "measured");
    assert.equal(edited[1].source, "measured", "untouched rows keep their source");
    assert.equal(standardsDirty(edited, draft), true);
    assert.deepEqual(standardDraftErrors(edited), {});
    const bad = updateStandardDraft(updateStandardDraft(edited, "fnb:covers_breakfast:minutes_per_unit", "value", "-1"), "rooms:occupied_rooms:posts_by_band", "coverageFactor", "9");
    const errors = standardDraftErrors(bad);
    assert.equal(errors["fnb:covers_breakfast:minutes_per_unit"], "El valor debe ser un número con hasta tres decimales.");
    assert.equal(errors["rooms:occupied_rooms:posts_by_band"], "La cobertura no puede ser mayor que 3.");
    assert.equal(standardDraftErrors(updateStandardDraft(draft, "rooms:stayovers:minutes_per_unit", "allowancePct", ""))["rooms:stayovers:minutes_per_unit"], "El margen es obligatorio.");
    assert.equal(standardDraftErrors(updateStandardDraft(draft, "rooms:stayovers:minutes_per_unit", "allowancePct", "150"))["rooms:stayovers:minutes_per_unit"], "El margen no puede ser mayor que 100.");
  });

  it("builds the PUT body with dot decimals, bands only for posts_by_band and the optional validFrom", () => {
    const edited = updateStandardDraft(standardsToDraft(STANDARDS), "rooms:stayovers:minutes_per_unit", "value", "22,5");
    const body = standardsPutBody(edited, "2026-10-01");
    assert.equal(body.validFrom, "2026-10-01");
    assert.equal(body.standards.length, 3);
    assert.deepEqual(body.standards[0], { usaliDepartment: "rooms", driver: "stayovers", unit: "minutes_per_unit", value: "22.5", bands: null, allowancePct: "12", coverageFactor: "1.4", source: "measured" });
    assert.deepEqual(body.standards[1].bands, STANDARDS[1].bands);
    assert.equal("validFrom" in standardsPutBody(edited), false);
  });
});

describe("hr-forecast-helpers · borrador de plantilla máxima", () => {
  it("starts a season with its default months, validates the draft and builds the POST body with only the departments that have a figure", () => {
    assert.deepEqual(SEASON_DEFAULT_MONTHS.high, { fromMonth: 6, toMonth: 9 });
    const draft = newPlanDraft(2027);
    assert.equal(draft.year, "2027");
    assert.equal(draft.season, "high");
    assert.equal(draft.fromMonth, "6");
    assert.equal(draft.toMonth, "9");
    assert.deepEqual(Object.keys(draft.lines), [...HR_FORECAST_DEPARTMENTS]);
    assert.deepEqual(planDraftErrors(draft), { lines: "Indica el máximo de FTE de al menos un departamento." });
    const low = planDraftWithSeason(draft, "low");
    assert.equal(low.fromMonth, "11");
    assert.equal(low.toMonth, "3");
    const filled = { ...low, lines: { ...low.lines, rooms: "6,5", pom: "1" } };
    assert.deepEqual(planDraftErrors(filled), {});
    assert.deepEqual(planDraftBody(filled), { year: 2027, season: "low", fromMonth: 11, toMonth: 3, lines: [{ usaliDepartment: "rooms", maxFte: "6.5" }, { usaliDepartment: "pom", maxFte: "1" }] });
    assert.equal(planDraftErrors({ ...filled, year: "1999" }).year, "El año debe ser un entero entre 2000 y 2100.");
    assert.equal(planDraftErrors({ ...filled, fromMonth: "13" }).months, "Los meses deben estar entre 1 y 12.");
    assert.equal(planDraftErrors({ ...filled, lines: { ...filled.lines, fnb: "tres" } }).lines, "Alimentos y bebidas: el máximo de FTE debe ser un número.");
  });

  it("approvedPlanFor (RF-13): the approved plan whose season covers the selected month (wrapping the year), else the most recent approved, else null", () => {
    const plan = (over: Partial<StaffingPlanDto>): StaffingPlanDto => ({ id: "p", propertyId: "prop_hr_test", year: 2026, season: "high", fromMonth: 4, toMonth: 10, status: "approved", totalMaxFte: "10.00", lines: [], createdBy: null, approvedBy: null, approvedAt: null, createdAt: "", updatedAt: "", ...over } as unknown as StaffingPlanDto);
    const high27 = plan({ id: "high27", year: 2027, totalMaxFte: "10.00" });
    const high26 = plan({ id: "high26", year: 2026, totalMaxFte: "27.00" });
    const low26 = plan({ id: "low26", year: 2026, season: "low", fromMonth: 11, toMonth: 3, totalMaxFte: "14.00" });
    const draft26 = plan({ id: "draft26", year: 2026, status: "draft" });
    const plans = [high27, high26, low26, draft26];
    assert.equal(approvedPlanFor(plans, "2026-09-20")?.id, "high26", "not the first approved of the list");
    assert.equal(approvedPlanFor(plans, "2026-12-05")?.id, "low26");
    assert.equal(approvedPlanFor(plans, "2027-02-10")?.id, "low26", "a wrapping season started the previous year covers february");
    assert.equal(approvedPlanFor(plans, "2027-06-01")?.id, "high27");
    assert.equal(approvedPlanFor([high27, high26], "2028-01-15")?.id, "high27", "fallback: the most recent approved");
    assert.equal(approvedPlanFor([draft26], "2026-09-20"), null);
    assert.equal(planCoversMonth({ fromMonth: 11, toMonth: 3 }, 1), true);
    assert.equal(planCoversMonth({ fromMonth: 11, toMonth: 3 }, 6), false);
  });

  it("labels months, summarises lines in canonical order, sorts plans and only lets drafts be approved", () => {
    const high = plan({});
    const draft = plan({ id: "plan_draft", season: "shoulder", fromMonth: 4, toMonth: 5, status: "draft", approvedBy: null, approvedAt: null, totalMaxFte: "4.00", lines: [{ usaliDepartment: "rooms", maxFte: "4.00", maxHeadcount: null, budgetMonthlyCost: null }] });
    const next = plan({ id: "plan_2027", year: 2027, season: "low", fromMonth: 11, toMonth: 3, status: "draft" });
    assert.equal(planMonthsLabel(high), "jun–sept");
    assert.equal(planMonthsLabel(next), "nov–mar");
    assert.equal(planLinesSummary(high), "Habitaciones 6,5 · Alimentos y bebidas 3 · Mantenimiento 1");
    assert.equal(planLinesSummary({ lines: [] }), "Sin líneas");
    assert.equal(planLineFte(high, "rooms"), 6.5);
    assert.equal(planLineFte(high, "it"), null);
    assert.deepEqual(sortPlans([draft, high, next]).map((p) => p.id), ["plan_2027", "plan_high", "plan_draft"]);
    assert.equal(planApprovable(high), false);
    assert.equal(planApprovable(draft), true);
  });
});

describe("hr-forecast-helpers · KPIs del panel", () => {
  it("captions FTE vs máximo, coste s/ ventas, coste por empleado and the KPI status without a green when a figure is missing", () => {
    assert.equal(plain(fteVsMaxCaption("5.20", "6.50")), "de 6,5 FTE máximo");
    assert.equal(fteVsMaxCaption("5.20", null), "sin plan aprobado");
    assert.equal(plain(laborCostCaption("12.40", "ledger")), "12,4 % s/ ventas del libro");
    assert.equal(plain(laborCostCaption("12.40", "reference")), "12,4 % s/ ventas de referencia");
    assert.equal(laborCostCaption(null, "ledger"), "sin dato de ventas");
    assert.equal(laborCostCaption(null, null, "payroll"), "nómina calculada · sin dato de ventas", "RF-09: the calculated payroll names its source");
    assert.equal(laborCostCaption(null, null, "import"), "sin dato de ventas");
    assert.equal(plain(costPerEmployeeCaption("1234.50")), "1234,50 € por empleado");
    assert.equal(costPerEmployeeCaption(null), "sin dato de empleados");
    assert.equal(fteKpiStatus("5.20", "6.50"), "ok");
    assert.equal(fteKpiStatus("7.00", "6.50"), "critical");
    assert.equal(fteKpiStatus(null, "6.50"), "warning");
    assert.equal(fteKpiStatus("5.20", null), "warning");
  });

  it("offers the last months as select options (most recent first) and reads the month code of a day", () => {
    assert.equal(monthCodeOf("2026-09-20"), "2026-09");
    assert.equal(monthCodeOf(new Date("2026-01-31T23:00:00Z")), "2026-01");
    const options = monthOptions("2026-02", 4);
    assert.deepEqual(options.map((o) => o.value), ["2026-02", "2026-01", "2025-12", "2025-11"]);
    assert.equal(plain(options[0].label), "feb 2026");
    assert.equal(plain(options[2].label), "dic 2025");
    assert.equal(monthOptions("2026-09").length, 12);
  });
});

describe("hr-forecast-helpers · alertas", () => {
  it("sorts by severity then date, filters the contract alerts and resolves the person only through the PII-free listing", () => {
    const alerts = [
      alert({ kind: "contract_expiring", severity: "info", date: "2026-10-10", employeeId: "emp_2", message: "Contrato temporal vence." }),
      alert({ severity: "critical", date: "2026-09-25", kind: "over_approved" }),
      alert({ severity: "warning", date: null, kind: "forecast_degraded" }),
      alert({ kind: "contract_expiring", severity: "warning", date: "2026-10-01", employeeId: "emp_1", message: "Contrato temporal vence." }),
      alert({ severity: "warning", date: "2026-09-22" })
    ];
    assert.deepEqual(sortAlerts(alerts).map((a) => `${a.severity}:${a.date ?? "-"}`), ["critical:2026-09-25", "warning:2026-09-22", "warning:2026-10-01", "warning:-", "info:2026-10-10"]);
    assert.deepEqual(contractExpiringAlerts(alerts).map((a) => a.employeeId), ["emp_1", "emp_2"]);
    const employees = [
      { id: "emp_1", fullName: "Persona Ficticia Uno", employeeNumber: "E-0001" },
      { id: "emp_2", fullName: "Persona Ficticia Dos", employeeNumber: "E-0002" }
    ];
    assert.equal(employeeNameFor(employees, "emp_2"), "Persona Ficticia Dos · E-0002");
    assert.equal(employeeNameFor(employees, "emp_9"), "Expediente sin acceso");
    assert.equal(employeeNameFor(null, "emp_1"), "Expediente sin acceso");
    assert.equal(employeeNameFor(employees, null), "—");
  });
});
