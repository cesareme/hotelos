import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LaborCostPanelCentreDto, LaborCostPanelDepartmentDto, LaborCostPanelDto, LaborCostPanelMonthDto, LaborCostPanelSourcesDto, LaborCostPanelTotalsDto } from "@hotelos/shared";
import {
  LABOR_DEPARTMENT_ORDER,
  LABOR_PANEL_DEGRADED_CODES,
  LABOR_PANEL_DEGRADED_LABELS_ES,
  LABOR_WINDOW_OPTIONS,
  NO_BREAKDOWN,
  NO_BREAKDOWN_LABEL_ES,
  NO_BREAKDOWN_TONE,
  allMonths,
  centreFooter,
  centreRows,
  costPerEmployeeCaption,
  cporCaption,
  degradedCodes,
  degradedFor,
  degradedLabels,
  degradedMessages,
  deltaOf,
  departmentBars,
  departmentLabel,
  formatDelta,
  formatHeadcount,
  formatMoney,
  formatPct,
  formatRoomNights,
  hasLaborCost,
  laborCostCaption,
  laborWindow,
  monthCodeOf,
  monthLabel,
  monthOptions,
  monthRows,
  monthsLabel,
  nextMonth,
  noBreakdownMonths,
  noBreakdownNote,
  overlapMonths,
  parseWindowMode,
  pctOfSalesCaption,
  presentDepartments,
  previousMonth,
  rankingRows,
  roomNightsCoverage,
  roomNightsSourceFor,
  roomNightsSourceOverall,
  salesCaption,
  salesSourceOf,
  sourceLabel,
  sourceSummary,
  sourcesSummary,
  windowLabel
} from "../labor-costs-helpers.ts";

// Tanda RRHH · PANEL-B: lógica pura de Hoy › Mi día › Costes de personal
// (recon §3.8). Fixtures sintéticos (sin nombres reales): un centro con
// enero-febrero «sin desglose» del diario, marzo por lote con departamentos y
// abril sin fuente («0.00» + LABOR_PANEL_COST_MISSING → «—», nunca 0).

/** Intl pone un espacio duro antes de «€» y «%»: se compara con espacio normal. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replace(/\u00a0|\u202f/g, " ")) as T;

const dept = (usaliDepartment: LaborCostPanelDepartmentDto["usaliDepartment"], laborCost: string, extra: Partial<LaborCostPanelDepartmentDto> = {}): LaborCostPanelDepartmentDto => ({
  usaliDepartment,
  label: departmentLabel(usaliDepartment),
  laborCost,
  revenue: null,
  pctOfSales: null,
  headcount: null,
  costPerEmployee: null,
  source: "ledger",
  ...extra
});

const month = (periodCode: string, extra: Partial<LaborCostPanelMonthDto> = {}): LaborCostPanelMonthDto => ({
  periodCode,
  laborCost: "0.00",
  sales: null,
  salesSource: null,
  pctOfSales: null,
  roomNights: null,
  laborCostPerOccupiedRoom: null,
  headcount: null,
  costPerEmployee: null,
  source: null,
  overlap: false,
  noBreakdown: false,
  departments: [],
  ...extra
});

const totals = (extra: Partial<LaborCostPanelTotalsDto> = {}): LaborCostPanelTotalsDto => ({
  laborCost: "0.00",
  sales: null,
  pctOfSales: null,
  roomNights: null,
  laborCostPerOccupiedRoom: null,
  headcount: null,
  costPerEmployee: null,
  deltaPrevious: null,
  byDepartment: [],
  ...extra
});

const MONTHS: LaborCostPanelMonthDto[] = [
  month("2026-01", { laborCost: "1000.00", sales: "4000.00", salesSource: "ledger", pctOfSales: "25.00", source: "ledger", noBreakdown: true, departments: [dept(NO_BREAKDOWN, "1000.00", { pctOfSales: "25.00" })] }),
  month("2026-02", { laborCost: "1200.00", sales: "4000.00", salesSource: "ledger", pctOfSales: "30.00", source: "ledger", noBreakdown: true, departments: [dept(NO_BREAKDOWN, "1200.00", { pctOfSales: "30.00" })] }),
  month("2026-03", {
    laborCost: "1500.00",
    sales: "5000.00",
    salesSource: "reference",
    pctOfSales: "30.00",
    roomNights: 400,
    laborCostPerOccupiedRoom: "3.75",
    headcount: "12.00",
    costPerEmployee: "125.00",
    source: "import",
    departments: [dept("rooms", "900.00", { source: "import", revenue: "3000.00", pctOfSales: "30.00" }), dept("fnb", "600.00", { source: "import", revenue: "2000.00", pctOfSales: "30.00" })]
  }),
  month("2026-04")
];

const CENTRE: LaborCostPanelCentreDto = {
  propertyId: "prop_a",
  propertyCode: "HA",
  propertyName: "Hotel Alfa (prueba)",
  legalEntityId: "le_1",
  months: MONTHS,
  totals: totals({ laborCost: "3700.00", sales: "13000.00", pctOfSales: "28.46", roomNights: 400, laborCostPerOccupiedRoom: "9.25", headcount: "12.00", byDepartment: [dept("rooms", "900.00"), dept("fnb", "600.00"), dept(NO_BREAKDOWN, "2200.00")] })
};

const SOURCES: LaborCostPanelSourcesDto = {
  ledger: { entries: 42, accounts: ["640", "642", "700"] },
  imports: [{ importId: "imp_1", fileName: "nomina-2026-03.json", periodFrom: "2026-03", periodTo: "2026-03", postedAt: "2026-04-02T10:00:00.000Z" }],
  roomNights: [
    { propertyId: "prop_a", source: "night_audit" },
    { propertyId: "prop_b", source: "degraded" }
  ]
};

const PANEL: LaborCostPanelDto = {
  from: "2026-01",
  to: "2026-04",
  scope: "entity",
  legalEntityId: "le_1",
  centres: [CENTRE, { ...CENTRE, propertyId: "prop_b", propertyCode: "HB", propertyName: "Hotel Beta (prueba)", months: [month("2026-01"), month("2026-02"), month("2026-03"), month("2026-04")], totals: totals() }],
  totals: CENTRE.totals,
  ranking: [
    { propertyId: "prop_a", propertyCode: "HA", propertyName: "Hotel Alfa (prueba)", laborCost: "3700.00", pctOfSales: "28.46" },
    { propertyId: "prop_b", propertyCode: "HB", propertyName: "Hotel Beta (prueba)", laborCost: "0.00", pctOfSales: null }
  ],
  sources: SOURCES,
  degraded: [
    { code: "LABOR_PANEL_COST_MISSING", message: "HA: sin coste en abr 2026", propertyId: "prop_a", periodCode: "2026-04" },
    { code: "LABOR_PANEL_COST_MISSING", message: "HB: sin coste en ene–abr 2026", propertyId: "prop_b", periodCode: null },
    { code: "LABOR_PANEL_RN_MISSING", message: "HA: sin RN en ene–feb 2026", propertyId: "prop_a", periodCode: null },
    { code: "LABOR_PANEL_USALI_FORBIDDEN", message: "Ingreso por departamento no disponible", propertyId: null, periodCode: null }
  ],
  generatedAt: "2026-09-20T12:00:00.000Z"
};

describe("labor-costs-helpers · ventana mes / acumulado del año", () => {
  it("resuelve la ventana: el mes elegido, o de enero al mes (acumulado del año)", () => {
    assert.deepEqual(laborWindow("2026-09", "month"), { from: "2026-09", to: "2026-09", months: 1 });
    assert.deepEqual(laborWindow("2026-09", "ytd"), { from: "2026-01", to: "2026-09", months: 9 });
    assert.deepEqual(laborWindow("2026-01", "ytd"), { from: "2026-01", to: "2026-01", months: 1 });
    assert.equal(parseWindowMode("ytd"), "ytd");
    assert.equal(parseWindowMode("cualquier cosa"), "month");
    assert.deepEqual(LABOR_WINDOW_OPTIONS.map((option) => option.label), ["Mes", "Acumulado del año"]);
  });

  it("navega por meses y etiqueta en español", () => {
    assert.equal(monthCodeOf("2026-09-20"), "2026-09");
    assert.equal(monthCodeOf(new Date("2026-02-15T10:00:00Z")), "2026-02");
    assert.equal(previousMonth("2026-01"), "2025-12");
    assert.equal(nextMonth("2025-12"), "2026-01");
    assert.equal(monthLabel("2026-09"), "sept 2026");
    assert.equal(windowLabel({ from: "2026-09", to: "2026-09" }), "sept 2026");
    assert.equal(windowLabel({ from: "2026-01", to: "2026-09" }), "ene–sept 2026");
    assert.equal(windowLabel({ from: "2025-11", to: "2026-02" }), "nov 2025–feb 2026");
    assert.equal(monthsLabel(["2026-01", "2026-02", "2026-03"]), "ene–mar 2026");
    assert.equal(monthsLabel(["2026-01", "2026-03"]), "ene 2026, mar 2026");
    assert.equal(monthsLabel([]), "—");
    const options = monthOptions("2026-09", 3);
    assert.deepEqual(options.map((option) => option.value), ["2026-09", "2026-08", "2026-07"]);
    assert.equal(options[0].label, "sept 2026");
  });
});

describe("labor-costs-helpers · cifras (nunca un 0 inventado)", () => {
  it("formatea importes, porcentajes en unidades de porcentaje, Δ con signo, plantilla y RN", () => {
    assert.equal(plain(formatMoney("1234.5")), "1234,50 €");
    assert.equal(plain(formatMoney("0.00", false)), "—", "coste sin fuente: «—», no 0,00 €");
    assert.equal(formatMoney(null), "—");
    assert.equal(plain(formatPct("28.46")), "28,5 %");
    assert.equal(formatPct(null), "—");
    assert.equal(plain(formatDelta("3.14")), "+3,1 %");
    assert.equal(plain(formatDelta("-2")), "-2 %");
    assert.equal(formatDelta(null), "—");
    assert.equal(formatHeadcount("12.00"), "12");
    assert.equal(formatHeadcount("12.50"), "12,5");
    assert.equal(formatRoomNights(1234), "1234");
    assert.equal(formatRoomNights(null), "—");
    assert.equal(deltaOf("3.14"), 3.1);
    assert.equal(deltaOf(null), undefined);
  });

  it("distingue coste real de «0.00 sin fuente» y localiza los meses sin desglose y solapados", () => {
    assert.equal(hasLaborCost(MONTHS), true);
    assert.equal(hasLaborCost([month("2026-04")]), false, "un mes con source null y laborCost 0.00 no es coste");
    assert.deepEqual(noBreakdownMonths(MONTHS), ["2026-01", "2026-02"]);
    assert.deepEqual(noBreakdownMonths([month("2026-04", { noBreakdown: true })]), [], "sin fuente no cuenta como sin desglose");
    assert.match(noBreakdownNote(MONTHS) ?? "", /^ene–feb 2026: el coste de personal viene de las cuentas 640\/642 del diario sin centro de coste/);
    assert.equal(noBreakdownNote([month("2026-04")]), null);
    assert.deepEqual(overlapMonths([month("2026-01", { overlap: true }), month("2026-02")]), ["2026-01"]);
    assert.equal(allMonths(PANEL).length, 8);
  });

  it("escribe los pies de los KPI con la fuente de cada cifra", () => {
    assert.equal(plain(pctOfSalesCaption("31.8", "ledger")), "31,8 % s/ ventas del libro");
    assert.equal(plain(pctOfSalesCaption("31.8", "reference")), "31,8 % s/ ventas de referencia del lote");
    assert.equal(pctOfSalesCaption(null, "ledger"), "sin dato de ventas");
    assert.equal(salesSourceOf(MONTHS), "ledger", "con libro en algún mes las ventas son del libro");
    assert.equal(salesSourceOf([MONTHS[2]]), "reference");
    assert.equal(salesSourceOf([month("2026-04")]), null);
    assert.equal(plain(salesCaption("13000.00", MONTHS)), "s/ 13.000,00 € · ventas del libro");
    assert.equal(salesCaption(null, MONTHS), "sin dato de ventas");
    assert.equal(costPerEmployeeCaption("12.00"), "plantilla media 12 personas (lote de nómina)");
    assert.equal(costPerEmployeeCaption(null), "sin plantilla de referencia (lote contabilizado)");
    assert.equal(cporCaption(400, "night_audit"), "400 habitaciones ocupadas · cierres del día");
    assert.equal(cporCaption(null, "degraded"), "sin habitaciones ocupadas reales");
    // Sociedad con RN en parte de los centros: la cifra existe (sobre los meses con RN) y el pie dice la cobertura.
    assert.deepEqual(roomNightsCoverage(SOURCES), { real: 1, total: 2 });
    assert.deepEqual(roomNightsCoverage(null), { real: 0, total: 0 });
    assert.equal(cporCaption(400, "night_audit", roomNightsCoverage(SOURCES)), "400 habitaciones ocupadas · cierres del día · 1 de 2 centros");
    assert.equal(cporCaption(400, "night_audit", { real: 1, total: 1 }), "400 habitaciones ocupadas · cierres del día", "un solo centro no lleva cobertura");
    assert.equal(cporCaption(400, "snapshot", { real: 3, total: 3 }), "400 habitaciones ocupadas · importación del PMS", "cobertura completa no lleva sufijo");
    assert.equal(laborCostCaption(MONTHS, { from: "2026-01", to: "2026-04" }), "diario 2 · lote 1 · sin datos 1 · ene–abr 2026");
    assert.equal(laborCostCaption([MONTHS[0]], { from: "2026-01", to: "2026-01" }), "diario contable (64x) · ene 2026");
    assert.equal(sourceSummary([month("2026-04")]), "sin datos 1");
    assert.equal(sourceLabel("import"), "lote de nómina contabilizado");
    assert.equal(sourceLabel(null, true), "sin datos");
  });

  it("resuelve la fuente de las habitaciones ocupadas por centro y para la sociedad", () => {
    assert.equal(roomNightsSourceFor(SOURCES, "prop_a"), "night_audit");
    assert.equal(roomNightsSourceFor(SOURCES, "prop_zzz"), null);
    assert.equal(roomNightsSourceOverall(SOURCES), "night_audit");
    assert.equal(roomNightsSourceOverall({ roomNights: [{ propertyId: "x", source: "degraded" }] }), "degraded");
    assert.equal(roomNightsSourceOverall(null), "degraded");
  });
});

describe("labor-costs-helpers · barras, tabla, ranking y meses", () => {
  it("pinta una barra por departamento con coste en orden canónico y «Sin desglose» como serie propia al final", () => {
    const bars = departmentBars(CENTRE.totals.byDepartment);
    assert.deepEqual(bars.map((bar) => bar.label), ["Habitaciones", "A&B", NO_BREAKDOWN_LABEL_ES]);
    assert.deepEqual(bars.map((bar) => bar.value), [900, 600, 2200]);
    assert.equal(bars[2].tone, NO_BREAKDOWN_TONE);
    assert.equal(bars[0].tone, undefined);
    assert.equal(bars[0].hint, "sin dato de ventas");
    assert.equal(departmentBars([dept("rooms", "0.00"), dept("fnb", "10.00", { pctOfSales: "12.5" })]).length, 1, "sin coste no hay barra");
    assert.equal(plain(departmentBars([dept("fnb", "10.00", { pctOfSales: "12.5" })])[0].hint), "12,5 % s/ ingreso del departamento");
    assert.equal(plain(departmentBars([dept("admin_general", "10.00", { pctOfSales: "2" })])[0].hint), "2 % s/ ventas");
    assert.equal(LABOR_DEPARTMENT_ORDER[LABOR_DEPARTMENT_ORDER.length - 1], NO_BREAKDOWN);
    assert.equal(departmentLabel("pom"), "Mantenimiento");
    assert.equal(departmentLabel("fnb", true), "A&B");
    assert.equal(departmentLabel("desconocido"), "desconocido");
    assert.equal(departmentLabel(null), "—");
  });

  it("construye la tabla centro × departamento con los departamentos presentes, «—» sin fuente y pie de totales", () => {
    assert.deepEqual(presentDepartments(PANEL), ["rooms", "fnb", NO_BREAKDOWN]);
    const rows = centreRows(PANEL);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].centre, "Hotel Alfa (prueba) (HA)");
    assert.deepEqual(plain(rows[0].cells), { rooms: "900,00 €", fnb: "600,00 €", sin_desglose: "2200,00 €" });
    assert.equal(plain(rows[0].total), "3700,00 €");
    assert.equal(plain(rows[0].pctOfSales), "28,5 %");
    assert.equal(rows[0].salesSource, "ledger");
    assert.equal(rows[0].sources, "diario 2 · lote 1 · sin datos 1");
    assert.equal(rows[0].noBreakdown, true);
    assert.equal(rows[1].hasCost, false);
    assert.equal(plain(rows[1].total), "—", "centro sin fuente: «—», nunca 0,00 €");
    assert.equal(rows[1].pctOfSales, null);
    assert.deepEqual(rows[1].cells, {});
    const footer = centreFooter(PANEL.totals, true);
    assert.equal(footer.centre, "Total");
    assert.equal(plain(footer.total), "3700,00 €");
    assert.equal(plain(footer.rooms), "900,00 €");
    assert.equal(plain(footer.sin_desglose), "2200,00 €");
    assert.equal(plain(footer.pctOfSales), "28,5 %");
    assert.deepEqual(centreFooter(totals(), false), { centre: "Total", total: "—", pctOfSales: "—" });
  });

  it("numera el ranking del API (sin ventas al final) y lista los meses del centro del más reciente al más antiguo", () => {
    const ranking = rankingRows(PANEL.ranking);
    assert.deepEqual(plain(ranking.map((row) => [row.position, row.pctOfSales, row.hasSales])), [[1, "28,5 %", true], [2, "sin ventas", false]]);
    assert.equal(ranking[1].laborCost, "—");
    assert.deepEqual(rankingRows(null), []);
    const months = monthRows(MONTHS);
    assert.deepEqual(months.map((row) => row.key), ["2026-04", "2026-03", "2026-02", "2026-01"]);
    assert.equal(months[0].laborCost, "—");
    assert.equal(months[0].hasCost, false);
    assert.equal(months[0].source, "sin datos");
    assert.equal(plain(months[1].laborCost), "1500,00 €");
    assert.equal(plain(months[1].cpor), "3,75 €");
    assert.equal(months[1].roomNights, "400");
    assert.equal(months[1].headcount, "12");
    assert.equal(months[1].source, "lote");
    assert.equal(months[1].salesSource, "reference");
    assert.equal(months[3].noBreakdown, true);
    assert.equal(months[3].cpor, "—");
  });
});

describe("labor-costs-helpers · degraded[] y fuentes en español", () => {
  it("traduce cada código de LABOR_PANEL_DEGRADED_CODES y deduplica códigos, etiquetas y mensajes", () => {
    for (const code of Object.values(LABOR_PANEL_DEGRADED_CODES)) assert.ok(LABOR_PANEL_DEGRADED_LABELS_ES[code], `etiqueta de ${code}`);
    assert.deepEqual(degradedCodes(PANEL.degraded), ["LABOR_PANEL_COST_MISSING", "LABOR_PANEL_RN_MISSING", "LABOR_PANEL_USALI_FORBIDDEN"]);
    assert.deepEqual(degradedLabels(PANEL.degraded), [
      "Sin coste de personal (ni diario ni lote contabilizado)",
      "Sin habitaciones ocupadas reales: CPOR laboral no calculable",
      "Ingreso por departamento no disponible (requiere accounting.read)"
    ]);
    assert.equal(degradedMessages(PANEL.degraded).length, 4);
    assert.deepEqual(degradedCodes(null), []);
    assert.deepEqual(degradedFor(PANEL.degraded, "prop_b").map((entry) => entry.code), ["LABOR_PANEL_COST_MISSING", "LABOR_PANEL_USALI_FORBIDDEN"]);
  });

  it("resume las fuentes: asientos y cuentas del diario, lotes con su ventana y centros con habitaciones ocupadas reales", () => {
    const lines = sourcesSummary(SOURCES);
    assert.equal(lines[0], "Diario contable: 42 asientos (cuentas 640, 642, 700).");
    assert.equal(lines[1], "Lotes de nómina contabilizados: nomina-2026-03.json (mar 2026).");
    assert.equal(lines[2], "Habitaciones ocupadas reales en 1 de 2 centros (cierres del día · sin habitaciones ocupadas reales).");
    assert.deepEqual(sourcesSummary(null), []);
    assert.equal(sourcesSummary({ ledger: { entries: 1, accounts: [] }, imports: [], roomNights: [] })[1], "Lotes de nómina contabilizados: ninguno en la ventana.");
  });
});
