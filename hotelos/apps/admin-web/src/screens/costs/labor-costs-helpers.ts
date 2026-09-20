// Panel de costes de personal de dirección (Tanda RRHH · PANEL-B; diseño
// docs/design/PANEL-COSTES-DIRECCION.md §8 recortado al bloque laboral por
// RRHH/recon-delta.md §3.8). Lógica PURA de la pestaña Hoy › Mi día › Costes de
// personal (/hoy/costes-personal): ventana mes / acumulado del año, formato de
// las cifras del DTO `LaborCostPanelDto`, barras por departamento con «Sin
// desglose» como serie propia, tabla centro × departamento con totales, ranking
// por % s/ ventas y etiquetas en español de `degraded[]`, orígenes y fuentes.
// Sin React, sin red, sin variables de entorno de Vite:
// screens/costs/__tests__/labor-costs-helpers.test.mts lo ejecuta bajo node --test.
//
// Los vocabularios se redeclaran aquí a propósito (tipados contra el contrato
// compartido): bajo `node --import tsx` los stubs `.js` de @hotelos/shared
// ganan a las fuentes y un import en tiempo de ejecución del paquete llegaría
// vacío a los tests (mismo motivo que hr/hr-forecast-helpers.ts).
//
// Regla de la casa: una cifra que el API no pudo calcular llega como `null`
// (o, en el coste de un mes sin fuente, como "0.00" con `source: null`) más una
// entrada en `degraded[]`; aquí nunca se pinta ese 0 como coste — el que pinta
// recibe «—» y la etiqueta de por qué.

import type {
  HrDegradedEntry,
  HrSalesSource,
  HrUsaliDepartment,
  LaborCostPanelCentreDto,
  LaborCostPanelDepartment,
  LaborCostPanelDepartmentDto,
  LaborCostPanelDto,
  LaborCostPanelMonthDto,
  LaborCostPanelRankingRowDto,
  LaborCostPanelSourcesDto,
  LaborCostPanelTotalsDto,
  LaborCostSource
} from "@hotelos/shared";
import type { CocoaBarsDatum, CocoaSegmentedControlOption, CocoaSelectOption, CocoaTone } from "../../components/cocoa";
import { date, money, number, percent } from "../../lib/format";

export const EMPTY_FIGURE = "—";

// ---------------------------------------------------------------------------
// Departamentos (espejo de HR_USALI_DEPARTMENTS + `sin_desglose`)
// ---------------------------------------------------------------------------

export const NO_BREAKDOWN: LaborCostPanelDepartment = "sin_desglose";
export const NO_BREAKDOWN_LABEL_ES = "Sin desglose";

export const LABOR_DEPARTMENTS: readonly HrUsaliDepartment[] = ["rooms", "fnb", "other_operated", "admin_general", "it", "sales_marketing", "pom"];

/** Orden canónico de las columnas y barras: departamentos USALI y, al final, «Sin desglose». */
export const LABOR_DEPARTMENT_ORDER: readonly LaborCostPanelDepartment[] = [...LABOR_DEPARTMENTS, NO_BREAKDOWN];

export const LABOR_DEPARTMENT_LABELS_ES: Readonly<Record<LaborCostPanelDepartment, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operativos",
  admin_general: "Administración y dirección",
  it: "Sistemas",
  sales_marketing: "Comercial y marketing",
  pom: "Mantenimiento",
  sin_desglose: NO_BREAKDOWN_LABEL_ES
});

/** Etiquetas cortas para las barras y las cabeceras de la tabla. */
export const LABOR_DEPARTMENT_SHORT_LABELS_ES: Readonly<Record<LaborCostPanelDepartment, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "A&B",
  other_operated: "Otros operativos",
  admin_general: "Administración",
  it: "Sistemas",
  sales_marketing: "Comercial",
  pom: "Mantenimiento",
  sin_desglose: NO_BREAKDOWN_LABEL_ES
});

export function departmentLabel(department: string | null | undefined, short = false): string {
  if (!department) return EMPTY_FIGURE;
  const map = short ? LABOR_DEPARTMENT_SHORT_LABELS_ES : LABOR_DEPARTMENT_LABELS_ES;
  return (map as Record<string, string>)[department] ?? department;
}

function departmentOrder(department: string): number {
  const index = LABOR_DEPARTMENT_ORDER.indexOf(department as LaborCostPanelDepartment);
  return index === -1 ? LABOR_DEPARTMENT_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// Orígenes y fuentes
// ---------------------------------------------------------------------------

export const LABOR_SOURCE_LABELS_ES: Readonly<Record<LaborCostSource, string>> = Object.freeze({
  ledger: "diario contable (64x)",
  import: "lote de nómina contabilizado"
});

export const LABOR_SOURCE_SHORT_LABELS_ES: Readonly<Record<LaborCostSource, string>> = Object.freeze({
  ledger: "diario",
  import: "lote"
});

export const NO_SOURCE_LABEL_ES = "sin datos";

export function sourceLabel(source: LaborCostSource | null | undefined, short = false): string {
  if (!source) return NO_SOURCE_LABEL_ES;
  return (short ? LABOR_SOURCE_SHORT_LABELS_ES : LABOR_SOURCE_LABELS_ES)[source] ?? source;
}

export const SALES_SOURCE_LABELS_ES: Readonly<Record<HrSalesSource, string>> = Object.freeze({
  ledger: "ventas del libro",
  reference: "ventas de referencia del lote"
});

export type RoomNightsSource = LaborCostPanelSourcesDto["roomNights"][number]["source"];

export const ROOM_NIGHTS_SOURCE_LABELS_ES: Readonly<Record<RoomNightsSource, string>> = Object.freeze({
  snapshot: "importación del PMS",
  night_audit: "cierres del día",
  reservations: "estancias",
  degraded: "sin habitaciones ocupadas reales"
});

export function roomNightsSourceLabel(source: RoomNightsSource | null | undefined): string {
  return source ? ROOM_NIGHTS_SOURCE_LABELS_ES[source] ?? source : ROOM_NIGHTS_SOURCE_LABELS_ES.degraded;
}

/** Fuente de RN de un centro en `sources.roomNights` (o null si el API no la informó). */
export function roomNightsSourceFor(sources: Pick<LaborCostPanelSourcesDto, "roomNights"> | null | undefined, propertyId: string | null | undefined): RoomNightsSource | null {
  if (!sources || !propertyId) return null;
  return sources.roomNights.find((row) => row.propertyId === propertyId)?.source ?? null;
}

/** Fuente de RN de la sociedad: la mejor de los centros (snapshot > night_audit > reservations), o degraded. */
export function roomNightsSourceOverall(sources: Pick<LaborCostPanelSourcesDto, "roomNights"> | null | undefined): RoomNightsSource {
  const all = (sources?.roomNights ?? []).map((row) => row.source);
  if (all.includes("snapshot")) return "snapshot";
  if (all.includes("night_audit")) return "night_audit";
  if (all.includes("reservations")) return "reservations";
  return "degraded";
}

/** «diario 7 · lote 1 · sin datos 4»: cuántos meses de la ventana vienen de cada origen (se omiten los ceros). */
export function sourceSummary(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "source">>): string {
  let ledger = 0;
  let imported = 0;
  let none = 0;
  for (const month of months) {
    if (month.source === "ledger") ledger += 1;
    else if (month.source === "import") imported += 1;
    else none += 1;
  }
  const parts: string[] = [];
  if (ledger > 0) parts.push(`${LABOR_SOURCE_SHORT_LABELS_ES.ledger} ${ledger}`);
  if (imported > 0) parts.push(`${LABOR_SOURCE_SHORT_LABELS_ES.import} ${imported}`);
  if (none > 0) parts.push(`${NO_SOURCE_LABEL_ES} ${none}`);
  return parts.length > 0 ? parts.join(" · ") : NO_SOURCE_LABEL_ES;
}

// ---------------------------------------------------------------------------
// Ventana: mes o acumulado del año
// ---------------------------------------------------------------------------

export type LaborWindowMode = "month" | "ytd";

export const LABOR_WINDOW_MODES: readonly LaborWindowMode[] = ["month", "ytd"];

export const LABOR_WINDOW_LABELS_ES: Readonly<Record<LaborWindowMode, string>> = Object.freeze({
  month: "Mes",
  ytd: "Acumulado del año"
});

export const LABOR_WINDOW_OPTIONS: readonly CocoaSegmentedControlOption[] = LABOR_WINDOW_MODES.map((mode) => ({ value: mode, label: LABOR_WINDOW_LABELS_ES[mode] }));

export function parseWindowMode(value: string | null | undefined): LaborWindowMode {
  return value === "ytd" ? "ytd" : "month";
}

const MONTH_CODE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthCode(value: string | null | undefined): value is string {
  return typeof value === "string" && MONTH_CODE.test(value);
}

/** "2026-09-20" o Date → "2026-09". */
export function monthCodeOf(value: string | Date): string {
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 7);
}

function shiftMonth(code: string, delta: number): string {
  const [year, month] = code.split("-").map(Number);
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Mes anterior ("2026-01" → "2025-12"). */
export function previousMonth(code: string): string {
  return shiftMonth(code, -1);
}

/** Mes siguiente ("2025-12" → "2026-01"). */
export function nextMonth(code: string): string {
  return shiftMonth(code, 1);
}

export type LaborWindow = { from: string; to: string; months: number };

/** Ventana de la consulta: el mes elegido, o de enero al mes elegido (acumulado del año). */
export function laborWindow(period: string, mode: LaborWindowMode): LaborWindow {
  const to = isMonthCode(period) ? period : monthCodeOf(new Date());
  if (mode === "ytd") {
    const from = `${to.slice(0, 4)}-01`;
    return { from, to, months: Number(to.slice(5, 7)) };
  }
  return { from: to, to, months: 1 };
}

export function monthLabel(code: string): string {
  return isMonthCode(code) ? date(`${code}-01`, "monthYear") : code;
}

/** «sept 2026» · «ene–sept 2026». */
export function windowLabel(window: Pick<LaborWindow, "from" | "to">): string {
  if (window.from === window.to) return monthLabel(window.to);
  const from = date(`${window.from}-01`, "monthYear");
  const to = date(`${window.to}-01`, "monthYear");
  if (window.from.slice(0, 4) === window.to.slice(0, 4)) return `${from.replace(/\s+\d{4}$/, "")}–${to}`;
  return `${from}–${to}`;
}

/** Opciones de mes hacia atrás desde `current`, la más reciente primero. */
export function monthOptions(current: string, back = 12): CocoaSelectOption[] {
  const options: CocoaSelectOption[] = [];
  for (let index = 0; index < back; index += 1) {
    const code = shiftMonth(current, -index);
    options.push({ value: code, label: monthLabel(code) });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Cifras
// ---------------------------------------------------------------------------

export type Numeric = string | number | null | undefined;

export function toNumberOrNull(value: Numeric): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Importe o «—» (nunca «0,00 €» para un coste sin fuente). */
export function formatMoney(value: Numeric, hasSource = true): string {
  if (!hasSource) return EMPTY_FIGURE;
  const parsed = toNumberOrNull(value);
  return parsed === null ? EMPTY_FIGURE : money(parsed);
}

/** «31,8 %» (RatioString en unidades de porcentaje) o «—». */
export function formatPct(value: Numeric): string {
  const parsed = toNumberOrNull(value);
  return parsed === null ? EMPTY_FIGURE : percent(parsed, { maximumFractionDigits: 1 });
}

/** «+3,1 %» / «−2,0 %» (Δ frente al periodo anterior) o «—». */
export function formatDelta(value: Numeric): string {
  const parsed = toNumberOrNull(value);
  return parsed === null ? EMPTY_FIGURE : percent(parsed, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
}

/** Plantilla media («56,0») o «—». */
export function formatHeadcount(value: Numeric): string {
  const parsed = toNumberOrNull(value);
  return parsed === null ? EMPTY_FIGURE : number(parsed, { maximumFractionDigits: 1 });
}

/** Habitaciones ocupadas («1.234») o «—». */
export function formatRoomNights(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY_FIGURE : number(value, { maximumFractionDigits: 0 });
}

/** Δ del KPI de coste (CocoaKpi.delta), o undefined cuando no hay periodo anterior. */
export function deltaOf(value: Numeric): number | undefined {
  const parsed = toNumberOrNull(value);
  return parsed === null ? undefined : Math.round(parsed * 10) / 10;
}

// ---------------------------------------------------------------------------
// Estado del panel: coste real frente a «0.00 sin fuente»
// ---------------------------------------------------------------------------

/** Meses de la ventana de todos los centros en ámbito (la sociedad suma centros). */
export function allMonths(dto: Pick<LaborCostPanelDto, "centres"> | null | undefined): LaborCostPanelMonthDto[] {
  return (dto?.centres ?? []).flatMap((centre) => centre.months);
}

/** Al menos un (centro, mes) con coste de una fuente real: si no, el total "0.00" no es un coste. */
export function hasLaborCost(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "source">>): boolean {
  return months.some((month) => month.source !== null);
}

/** Meses (códigos únicos, ordenados) cuyo coste va íntegro a «Sin desglose». */
export function noBreakdownMonths(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "periodCode" | "noBreakdown" | "source">>): string[] {
  const codes = new Set<string>();
  for (const month of months) if (month.source !== null && month.noBreakdown) codes.add(month.periodCode);
  return Array.from(codes).sort();
}

/** Meses (códigos únicos, ordenados) con diario y lote a la vez (prevalece el diario). */
export function overlapMonths(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "periodCode" | "overlap">>): string[] {
  const codes = new Set<string>();
  for (const month of months) if (month.overlap) codes.add(month.periodCode);
  return Array.from(codes).sort();
}

/** «ene–jul 2026» a partir de una lista ordenada de meses (rango si son consecutivos; lista si no). */
export function monthsLabel(codes: readonly string[]): string {
  if (codes.length === 0) return EMPTY_FIGURE;
  if (codes.length === 1) return monthLabel(codes[0]);
  let consecutive = true;
  for (let index = 1; index < codes.length; index += 1) {
    if (nextMonth(codes[index - 1]) !== codes[index]) {
      consecutive = false;
      break;
    }
  }
  if (consecutive) return windowLabel({ from: codes[0], to: codes[codes.length - 1] });
  return codes.map(monthLabel).join(", ");
}

/** Nota del callout «Sin desglose» (null cuando ningún mes lo necesita). */
export function noBreakdownNote(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "periodCode" | "noBreakdown" | "source">>): string | null {
  const codes = noBreakdownMonths(months);
  if (codes.length === 0) return null;
  return `${monthsLabel(codes)}: el coste de personal viene de las cuentas 640/642 del diario sin centro de coste y no se puede repartir por departamento; se muestra íntegro como «${NO_BREAKDOWN_LABEL_ES}».`;
}

// ---------------------------------------------------------------------------
// Pies de los KPI
// ---------------------------------------------------------------------------

/** «31,8 % s/ ventas del libro» · «sin dato de ventas». */
export function pctOfSalesCaption(pct: Numeric, salesSource: HrSalesSource | null | undefined): string {
  const parsed = toNumberOrNull(pct);
  if (parsed === null) return "sin dato de ventas";
  return `${formatPct(parsed)} s/ ${salesSource === "reference" ? SALES_SOURCE_LABELS_ES.reference : SALES_SOURCE_LABELS_ES.ledger}`;
}

/** Origen de las ventas de una ventana: `reference` solo si ningún mes las tiene del libro; null sin ventas. */
export function salesSourceOf(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "salesSource">>): HrSalesSource | null {
  const sources = new Set(months.map((month) => month.salesSource).filter((source): source is HrSalesSource => source !== null));
  if (sources.size === 0) return null;
  return sources.has("reference") && !sources.has("ledger") ? "reference" : "ledger";
}

/** «s/ 1.234,00 € · ventas del libro» · «s/ 1.234,00 € · ventas de referencia del lote» · «sin dato de ventas». */
export function salesCaption(sales: Numeric, months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "salesSource">>): string {
  const parsed = toNumberOrNull(sales);
  const source = salesSourceOf(months);
  if (parsed === null || source === null) return "sin dato de ventas";
  return `s/ ${money(parsed)} · ${SALES_SOURCE_LABELS_ES[source]}`;
}

/** «plantilla media 56,0 personas (lote de nómina)» · «sin plantilla de referencia». */
export function costPerEmployeeCaption(headcount: Numeric): string {
  const parsed = toNumberOrNull(headcount);
  if (parsed === null) return "sin plantilla de referencia (lote contabilizado)";
  return `plantilla media ${formatHeadcount(parsed)} personas (lote de nómina)`;
}

export type RoomNightsCoverage = { real: number; total: number };

/** Centros con habitaciones ocupadas reales frente a los del ámbito (para el pie del CPOR de la sociedad). */
export function roomNightsCoverage(sources: Pick<LaborCostPanelSourcesDto, "roomNights"> | null | undefined): RoomNightsCoverage {
  const rows = sources?.roomNights ?? [];
  return { real: rows.filter((row) => row.source !== "degraded").length, total: rows.length };
}

/** «1.234 habitaciones ocupadas · cierres del día» (+ « · 5 de 8 centros» cuando no todos tienen RN) · «sin habitaciones ocupadas reales». */
export function cporCaption(roomNights: number | null | undefined, source: RoomNightsSource | null | undefined, coverage?: RoomNightsCoverage | null): string {
  if (roomNights === null || roomNights === undefined) return ROOM_NIGHTS_SOURCE_LABELS_ES.degraded;
  const partial = coverage && coverage.total > 1 && coverage.real < coverage.total ? ` · ${coverage.real} de ${coverage.total} centros` : "";
  return `${formatRoomNights(roomNights)} habitaciones ocupadas · ${roomNightsSourceLabel(source)}${partial}`;
}

/** «diario contable (64x) · sept 2026» · «diario 7 · lote 1 · sin datos 4 · ene–sept 2026». */
export function laborCostCaption(months: ReadonlyArray<Pick<LaborCostPanelMonthDto, "source">>, window: Pick<LaborWindow, "from" | "to">): string {
  const sources = new Set(months.map((month) => month.source).filter((source): source is LaborCostSource => source !== null));
  const label = sources.size === 1 ? sourceLabel(Array.from(sources)[0]) : sourceSummary(months);
  return `${label} · ${windowLabel(window)}`;
}

// ---------------------------------------------------------------------------
// Barras por departamento («Sin desglose» como serie propia)
// ---------------------------------------------------------------------------

export const NO_BREAKDOWN_TONE: CocoaTone = "warning";

/** Una barra por departamento con coste > 0, en orden canónico; «Sin desglose» va al final con su propio tono. */
export function departmentBars(rows: readonly LaborCostPanelDepartmentDto[]): CocoaBarsDatum[] {
  return rows
    .map((row) => ({ row, value: toNumberOrNull(row.laborCost) ?? 0 }))
    .filter(({ value }) => value > 0)
    .sort((a, b) => departmentOrder(a.row.usaliDepartment) - departmentOrder(b.row.usaliDepartment))
    .map(({ row, value }) => ({
      label: departmentLabel(row.usaliDepartment, true),
      value,
      tone: row.usaliDepartment === NO_BREAKDOWN ? NO_BREAKDOWN_TONE : undefined,
      hint: row.pctOfSales === null ? "sin dato de ventas" : `${formatPct(row.pctOfSales)} s/ ${row.usaliDepartment === "rooms" || row.usaliDepartment === "fnb" || row.usaliDepartment === "other_operated" ? "ingreso del departamento" : "ventas"}`
    }));
}

// ---------------------------------------------------------------------------
// Tabla centro × departamento
// ---------------------------------------------------------------------------

export type CentreRow = {
  key: string;
  propertyId: string;
  centre: string;
  cells: Partial<Record<LaborCostPanelDepartment, string>>;
  total: string;
  hasCost: boolean;
  pctOfSales: string | null;
  salesSource: HrSalesSource | null;
  sources: string;
  noBreakdown: boolean;
};

/** Nombre del centro con su código («Hotel X (AS)»). */
export function centreName(centre: Pick<LaborCostPanelCentreDto, "propertyCode" | "propertyName">): string {
  return centre.propertyCode ? `${centre.propertyName} (${centre.propertyCode})` : centre.propertyName;
}

/** Departamentos presentes (coste > 0 en algún centro o en los totales), en orden canónico. */
export function presentDepartments(dto: Pick<LaborCostPanelDto, "centres" | "totals"> | null | undefined): LaborCostPanelDepartment[] {
  const present = new Set<LaborCostPanelDepartment>();
  const collect = (rows: readonly LaborCostPanelDepartmentDto[]) => {
    for (const row of rows) if ((toNumberOrNull(row.laborCost) ?? 0) !== 0) present.add(row.usaliDepartment);
  };
  for (const centre of dto?.centres ?? []) collect(centre.totals.byDepartment);
  collect(dto?.totals.byDepartment ?? []);
  return LABOR_DEPARTMENT_ORDER.filter((department) => present.has(department));
}

/** Una fila por centro en ámbito (hoteles primero, como llega del API). */
export function centreRows(dto: Pick<LaborCostPanelDto, "centres"> | null | undefined): CentreRow[] {
  return (dto?.centres ?? []).map((centre) => {
    const hasCost = hasLaborCost(centre.months);
    const cells: Partial<Record<LaborCostPanelDepartment, string>> = {};
    for (const row of centre.totals.byDepartment) {
      if ((toNumberOrNull(row.laborCost) ?? 0) !== 0) cells[row.usaliDepartment] = formatMoney(row.laborCost);
    }
    return {
      key: centre.propertyId,
      propertyId: centre.propertyId,
      centre: centreName(centre),
      cells,
      total: formatMoney(centre.totals.laborCost, hasCost),
      hasCost,
      pctOfSales: hasCost && centre.totals.pctOfSales !== null ? formatPct(centre.totals.pctOfSales) : null,
      salesSource: salesSourceOf(centre.months),
      sources: sourceSummary(centre.months),
      noBreakdown: noBreakdownMonths(centre.months).length > 0
    };
  });
}

/** Pie de totales de la tabla (sociedad o centro): coste por departamento y total, «—» si nada tiene fuente. */
export function centreFooter(totals: Pick<LaborCostPanelTotalsDto, "laborCost" | "pctOfSales" | "byDepartment"> | null | undefined, hasCost: boolean): Record<string, string> {
  const footer: Record<string, string> = { centre: "Total" };
  for (const row of totals?.byDepartment ?? []) {
    if ((toNumberOrNull(row.laborCost) ?? 0) !== 0) footer[row.usaliDepartment] = formatMoney(row.laborCost);
  }
  footer.total = formatMoney(totals?.laborCost, hasCost);
  footer.pctOfSales = hasCost ? formatPct(totals?.pctOfSales) : EMPTY_FIGURE;
  return footer;
}

// ---------------------------------------------------------------------------
// Ranking de centros por % s/ ventas (solo sociedad)
// ---------------------------------------------------------------------------

export type RankingRow = {
  key: string;
  position: number;
  centre: string;
  laborCost: string;
  pctOfSales: string;
  hasSales: boolean;
};

/** Filas del ranking tal como las ordena el API (% s/ ventas desc; sin ventas al final), numeradas. */
export function rankingRows(ranking: readonly LaborCostPanelRankingRowDto[] | null | undefined): RankingRow[] {
  return (ranking ?? []).map((row, index) => ({
    key: row.propertyId,
    position: index + 1,
    centre: centreName(row),
    laborCost: formatMoney(row.laborCost, (toNumberOrNull(row.laborCost) ?? 0) !== 0),
    pctOfSales: row.pctOfSales === null ? "sin ventas" : formatPct(row.pctOfSales),
    hasSales: row.pctOfSales !== null
  }));
}

// ---------------------------------------------------------------------------
// Meses de un centro (ámbito centro)
// ---------------------------------------------------------------------------

export type MonthRow = {
  key: string;
  month: string;
  laborCost: string;
  hasCost: boolean;
  pctOfSales: string;
  salesSource: HrSalesSource | null;
  cpor: string;
  roomNights: string;
  headcount: string;
  source: string;
  overlap: boolean;
  noBreakdown: boolean;
};

/** Una fila por mes de la ventana (el más reciente primero). */
export function monthRows(months: readonly LaborCostPanelMonthDto[] | null | undefined): MonthRow[] {
  return [...(months ?? [])]
    .sort((a, b) => (a.periodCode < b.periodCode ? 1 : a.periodCode > b.periodCode ? -1 : 0))
    .map((month) => {
      const hasCost = month.source !== null;
      return {
        key: month.periodCode,
        month: monthLabel(month.periodCode),
        laborCost: formatMoney(month.laborCost, hasCost),
        hasCost,
        pctOfSales: hasCost ? formatPct(month.pctOfSales) : EMPTY_FIGURE,
        salesSource: month.salesSource,
        cpor: hasCost ? formatMoney(month.laborCostPerOccupiedRoom) : EMPTY_FIGURE,
        roomNights: formatRoomNights(month.roomNights),
        headcount: formatHeadcount(month.headcount),
        source: sourceLabel(month.source, true),
        overlap: month.overlap,
        noBreakdown: hasCost && month.noBreakdown
      };
    });
}

// ---------------------------------------------------------------------------
// degraded[] en español
// ---------------------------------------------------------------------------

/** Códigos de `LABOR_PANEL_DEGRADED_CODES` (labor-cost-panel.service.ts) → etiqueta corta. */
export const LABOR_PANEL_DEGRADED_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  LABOR_PANEL_COST_MISSING: "Sin coste de personal (ni diario ni lote contabilizado)",
  LABOR_PANEL_OVERLAP: "Diario y lote en el mismo mes: prevalece el diario",
  LABOR_PANEL_SALES_MISSING: "Sin ventas: % sobre ventas no calculable",
  LABOR_PANEL_RN_MISSING: "Sin habitaciones ocupadas reales: CPOR laboral no calculable",
  LABOR_PANEL_RN_PARTIAL: "Mes incompleto: CPOR laboral orientativo",
  LABOR_PANEL_RN_QUERY_FAILED: "No se pudieron leer las habitaciones ocupadas",
  LABOR_PANEL_HEADCOUNT_MISSING: "Sin plantilla de referencia: coste por empleado no calculable",
  LABOR_PANEL_USALI_FORBIDDEN: "Ingreso por departamento no disponible (requiere accounting.read)",
  LABOR_PANEL_USALI_FAILED: "Ingreso por departamento no disponible: el cálculo USALI falló",
  LABOR_PANEL_COST_CENTRE_UNMAPPED: "Centros de coste que no son departamento USALI contados en «Sin desglose»"
});

export const LABOR_PANEL_DEGRADED_CODES = Object.freeze({
  costMissing: "LABOR_PANEL_COST_MISSING",
  overlap: "LABOR_PANEL_OVERLAP",
  salesMissing: "LABOR_PANEL_SALES_MISSING",
  rnMissing: "LABOR_PANEL_RN_MISSING",
  rnPartial: "LABOR_PANEL_RN_PARTIAL",
  rnQueryFailed: "LABOR_PANEL_RN_QUERY_FAILED",
  headcountMissing: "LABOR_PANEL_HEADCOUNT_MISSING",
  usaliForbidden: "LABOR_PANEL_USALI_FORBIDDEN",
  usaliFailed: "LABOR_PANEL_USALI_FAILED",
  costCentreUnmapped: "LABOR_PANEL_COST_CENTRE_UNMAPPED"
});

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

export function degradedLabel(code: string): string {
  return LABOR_PANEL_DEGRADED_LABELS_ES[code] ?? code;
}

/** Códigos únicos de `degraded[]` (para DegradedBanner / isDegraded). */
export function degradedCodes(entries: readonly HrDegradedEntry[] | null | undefined): string[] {
  return unique((entries ?? []).map((entry) => entry.code).filter((code): code is string => typeof code === "string" && code.length > 0));
}

/** Etiquetas cortas únicas de `degraded[]`, en orden de aparición. */
export function degradedLabels(entries: readonly HrDegradedEntry[] | null | undefined): string[] {
  return unique(degradedCodes(entries).map(degradedLabel));
}

/** Mensajes únicos del API (ya en español, con centro y meses), para la nota bajo el banner. */
export function degradedMessages(entries: readonly HrDegradedEntry[] | null | undefined): string[] {
  return unique((entries ?? []).map((entry) => entry.message).filter((message): message is string => typeof message === "string" && message.length > 0));
}

/** Entradas de un centro concreto (o las globales, con `propertyId` nulo). */
export function degradedFor(entries: readonly HrDegradedEntry[] | null | undefined, propertyId: string | null): HrDegradedEntry[] {
  return (entries ?? []).filter((entry) => (entry.propertyId ?? null) === propertyId || (entry.propertyId ?? null) === null);
}

// ---------------------------------------------------------------------------
// Fuentes (pie del panel)
// ---------------------------------------------------------------------------

/** «Diario: 1.234 asientos (640, 641, 642, 700…) · lotes: 1 (nomina-2026-08.json) · RN: cierres del día». */
export function sourcesSummary(sources: LaborCostPanelSourcesDto | null | undefined): string[] {
  if (!sources) return [];
  const lines: string[] = [];
  const accounts = sources.ledger.accounts.length > 0 ? ` (cuentas ${sources.ledger.accounts.join(", ")})` : "";
  lines.push(`Diario contable: ${number(sources.ledger.entries)} ${sources.ledger.entries === 1 ? "asiento" : "asientos"}${accounts}.`);
  if (sources.imports.length === 0) lines.push("Lotes de nómina contabilizados: ninguno en la ventana.");
  else {
    const items = sources.imports.map((row) => `${row.fileName || row.importId} (${row.periodFrom === row.periodTo ? monthLabel(row.periodFrom) : `${monthLabel(row.periodFrom)}–${monthLabel(row.periodTo)}`})`);
    lines.push(`Lotes de nómina contabilizados: ${items.join(" · ")}.`);
  }
  const rn = sources.roomNights.map((row) => row.source);
  if (rn.length > 0) {
    const real = rn.filter((source) => source !== "degraded").length;
    lines.push(`Habitaciones ocupadas reales en ${real} de ${rn.length} ${rn.length === 1 ? "centro" : "centros"} (${unique(rn).map((source) => ROOM_NIGHTS_SOURCE_LABELS_ES[source]).join(" · ")}).`);
  }
  return lines;
}
