// Panel de costes de personal de dirección (Tanda RRHH · PANEL-A) —
// `GET /payroll/labor-cost-panel?from=YYYY-MM&to=YYYY-MM[&propertyId]`
// (payroll.routes.ts; pantalla /hoy/costes-personal de PANEL-B). Diseño:
// docs/design/PANEL-COSTES-DIRECCION.md §1 :16-18, §3.3 :139-150, §5.1 :222-228;
// recon scratchpad RRHH §3.8; decisiones de César en el brief (coste por
// departamento a partir del reparto del lote de agosto y de la cuenta 640/642
// sin departamento para ene-jul, marcado «sin desglose»).
//
// `aggregateLaborCostPanel` es PURA (sin BD): recibe las filas del diario, las
// líneas / referencias de los lotes contabilizados, las habitaciones ocupadas
// reales por mes y el ingreso por departamento del USALI, y produce el
// `LaborCostPanelDto` (packages/shared/src/hr-types.ts). `buildLaborCostPanel`
// carga esas entradas con los lectores de labor-cost-panel.source.ts y filtra
// los centros por el ámbito del usuario.
//
// Regla por (centro, mes) — R §2 «Coste por departamento del panel»:
//   · coste = 64x del diario (asientos que NO son del lote de coste de personal),
//     repartido por el centro de coste `usali` de cada línea (ROOMS → rooms…);
//     las líneas sin centro (o con un centro que no es un departamento USALI)
//     van a la fila `sin_desglose` (ene-jul 2026 en Faranda: Sage no trae
//     departamento en 640/641/642) → `source: "ledger"`;
//   · sin 64x en el diario ese mes → líneas del lote `posted` por
//     `usali_department` (agosto 2026) → `source: "import"`;
//   · ambos → prevalece el diario y `overlap: true` (+ entrada en `degraded[]`);
//     el lote aporta solo headcount y ventas de referencia. Nunca se suman las
//     dos fuentes (los asientos del propio lote se excluyen del diario por
//     `source_type = payroll_cost_import`: cero doble cómputo);
//   · sin ninguna de las dos → `source: null`, `laborCost: "0.00"` y entrada
//     `LABOR_PANEL_COST_MISSING` en `degraded[]` (el front pinta «—», nunca 0).
//   · ventas = 70x del diario; con referencia del lote se aplica la regla de
//     cobertura del informe de coste (`salesSourceOf`, contable-6C-03) →
//     `salesSource` ledger | reference | null; % s/ ventas null sin ventas;
//   · ingreso por departamento (Habitaciones, A&B, Otros operados) = USALI del
//     mes con `computeUsaliPnl` (núcleo puro de `buildUsaliPnl`) sobre las mismas
//     filas del diario — una lectura por petición en vez de N centros × M meses
//     lecturas; requiere `accounting.read` como `buildUsaliPnl` (sin la clave:
//     revenue null + `LABOR_PANEL_USALI_FORBIDDEN`). Los no distribuidos y
//     `sin_desglose` se miden sobre las ventas totales del mes (P §3.3);
//   · RN = habitaciones ocupadas reales (sin `demo`): CPOR laboral null sin RN
//     (`LABOR_PANEL_RN_MISSING`); mes incompleto → `LABOR_PANEL_RN_PARTIAL`;
//   · headcount = `employees_reported` de la referencia del lote, si no Σ
//     headcount de sus líneas; sin lote → null y coste por empleado null.
// Agregados (centro y sociedad): coste = Σ meses; ratios sobre los meses que
// tienen denominador (nunca se diluye un % con meses sin ventas); headcount =
// media de los meses con dato; `deltaPrevious` = Δ % del coste frente a la
// ventana anterior de la misma longitud (null si aquella no tiene coste).
// Sociedad = Σ de los centros en ámbito (hoteles + oficina central); `ranking`
// solo con ámbito sociedad, por % s/ ventas (sin ventas al final).

import { Prisma } from "@prisma/client";
import type { HrDegradedEntry, HrSalesSource, HrUsaliDepartment, LaborCostPanelCentreDto, LaborCostPanelDepartment, LaborCostPanelDepartmentDto, LaborCostPanelDto, LaborCostPanelMonthDto, LaborCostPanelRankingRowDto, LaborCostPanelTotalsDto, LaborCostSource, PermissionKey, PropertyKind } from "@hotelos/shared";
import { HR_USALI_DEPARTMENT_LABELS_ES, HR_USALI_DEPARTMENTS, LABOR_COST_PANEL_NO_BREAKDOWN, LABOR_COST_PANEL_NO_BREAKDOWN_LABEL_ES } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { assertFinanceReadScope, propertyWithinScope, resolveLedgerScope } from "../../lib/finance-scope.js";
import { ledgerNotFound } from "../accounting/accounting.service.js";
import type { AccountKind } from "../accounting/chart-of-accounts.service.js";
import { pct } from "../financial-statements/money.js";
import { prismaFinancialStatementsSource, type AccountBalanceRow, type UsaliMappingSourceRow } from "../financial-statements/source.js";
import { computeUsaliPnl } from "../financial-statements/usali.service.js";
import type { Db } from "../treasury/ledger-bridge.js";
import { money, round2 } from "../treasury/money.js";
import { PAYROLL_READ_KEYS, requireAnyPermission } from "../treasury/permissions.js";
import { monthsBetween, salesSourceOf } from "./cost-report.service.js";
import {
  countLaborLedgerEntries,
  defaultLaborPanelDb,
  LABOR_ACCOUNT_PREFIX,
  loadLaborLedgerRows,
  loadPostedPayrollImports,
  loadRoomNightsByMonth,
  SALES_ACCOUNT_PREFIX,
  type LaborImportLine,
  type LaborImportReference,
  type LaborImportSummary,
  type LaborLedgerRow,
  type RoomNightsMonth,
  type RoomNightsSource
} from "./labor-cost-panel.source.js";

type Dec = Prisma.Decimal;
const D = (value: Prisma.Decimal.Value = 0): Dec => new Prisma.Decimal(value);
const ZERO = D(0);

/** Permiso del USALI (`buildUsaliPnl` → requirePermissions): sin él no se calcula el ingreso por departamento. */
export const LABOR_PANEL_USALI_PERMISSION: PermissionKey = "accounting.read";

/** Códigos de `degraded[]` del panel (HrDegradedEntry.code). */
export const LABOR_PANEL_DEGRADED_CODES = {
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
} as const;

/** Departamentos USALI con ingreso propio (el % del departamento se mide sobre su ingreso; el resto sobre las ventas del mes). */
const OPERATING_DEPARTMENTS: ReadonlySet<string> = new Set<HrUsaliDepartment>(["rooms", "fnb", "other_operated"]);
const HR_DEPARTMENT_SET: ReadonlySet<string> = new Set(HR_USALI_DEPARTMENTS);
const DEPARTMENT_ORDER: readonly LaborCostPanelDepartment[] = [...HR_USALI_DEPARTMENTS, LABOR_COST_PANEL_NO_BREAKDOWN];

// ---------------------------------------------------------------------------
// Entradas de la función pura
// ---------------------------------------------------------------------------

export type LaborCostPanelCentreInput = { propertyId: string; code: string | null; name: string; kind: PropertyKind; legalEntityId: string | null };

export type LaborCostPanelRoomNightsInput = Pick<RoomNightsMonth, "propertyId" | "periodCode" | "roomNights" | "partial" | "source">;

/** Ingreso USALI de un departamento operativo en un (centro, mes); null en toda la entrada = no disponible (sin clave o fallo). */
export type LaborCostPanelDepartmentRevenueInput = { propertyId: string; periodCode: string; usaliDepartment: string; revenue: Prisma.Decimal.Value };

export type AggregateLaborCostPanelInput = {
  from: string;
  to: string;
  /** Meses de la ventana en orden ("YYYY-MM"). */
  months: readonly string[];
  /** Ventana anterior de la misma longitud (para `deltaPrevious`); vacía = sin comparación. */
  previousMonths?: readonly string[];
  scope: "entity" | "property";
  legalEntityId: string | null;
  /** Centros a presentar (hoteles primero), ya filtrados por ámbito. */
  centres: readonly LaborCostPanelCentreInput[];
  ledgerRows: readonly LaborLedgerRow[];
  importLines: readonly LaborImportLine[];
  references: readonly LaborImportReference[];
  imports?: readonly LaborImportSummary[];
  roomNights: readonly LaborCostPanelRoomNightsInput[];
  departmentRevenue: readonly LaborCostPanelDepartmentRevenueInput[] | null;
  ledgerEntries?: number;
  /** Entradas ya recogidas por los lectores (p. ej. RN no consultable). */
  degraded?: readonly HrDegradedEntry[];
  generatedAt?: string;
};

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

const cellKey = (propertyId: string, periodCode: string): string => `${propertyId}|${periodCode}`;

/** Ventana anterior de la misma longitud: los N meses que preceden a `months[0]`. */
export function previousMonthsOf(months: readonly string[]): string[] {
  if (months.length === 0) return [];
  let [year, month] = months[0]!.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < months.length; i += 1) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    out.unshift(`${year}-${String(month).padStart(2, "0")}`);
  }
  return out;
}

/** Departamento del panel de un centro de coste del diario: `usali` + código de departamento USALI con personal; el resto → sin desglose. */
export function departmentOfCostCentre(costCentre: { type: string; code: string } | null): { department: LaborCostPanelDepartment; unmapped: boolean } {
  if (!costCentre) return { department: LABOR_COST_PANEL_NO_BREAKDOWN, unmapped: false };
  const candidate = costCentre.code.toLowerCase();
  if (costCentre.type === "usali" && HR_DEPARTMENT_SET.has(candidate)) return { department: candidate as HrUsaliDepartment, unmapped: false };
  return { department: LABOR_COST_PANEL_NO_BREAKDOWN, unmapped: true };
}

function departmentOfImportLine(usaliDepartment: string): LaborCostPanelDepartment {
  return HR_DEPARTMENT_SET.has(usaliDepartment) ? (usaliDepartment as HrUsaliDepartment) : LABOR_COST_PANEL_NO_BREAKDOWN;
}

export function departmentLabel(department: LaborCostPanelDepartment): string {
  return department === LABOR_COST_PANEL_NO_BREAKDOWN ? LABOR_COST_PANEL_NO_BREAKDOWN_LABEL_ES : HR_USALI_DEPARTMENT_LABELS_ES[department];
}

function divide(numerator: Dec, denominator: Dec | number | null): string | null {
  if (denominator === null) return null;
  const den = D(denominator);
  if (den.lte(0)) return null;
  return money(numerator.div(den));
}

function pctOf(numerator: Dec, denominator: Dec | null): string | null {
  if (denominator === null || denominator.lte(0)) return null;
  return pct(numerator, denominator);
}

function headcountText(value: Dec | null): string | null {
  return value === null ? null : round2(value).toFixed(2);
}

/** Media de los valores no nulos (2 decimales); null sin ninguno. */
function meanOf(values: readonly (Dec | null)[]): Dec | null {
  const present = values.filter((value): value is Dec => value !== null);
  if (present.length === 0) return null;
  let total = ZERO;
  for (const value of present) total = total.plus(value);
  return round2(total.div(present.length));
}

// ---------------------------------------------------------------------------
// Celda (centro × mes) — valores Decimal antes de serializar
// ---------------------------------------------------------------------------

type DepartmentCalc = {
  department: LaborCostPanelDepartment;
  laborCost: Dec;
  /** Ingreso USALI del departamento (operativos) cuando está disponible. */
  revenue: Dec | null;
  headcount: Dec | null;
  source: LaborCostSource;
};

type CellCalc = {
  propertyId: string;
  periodCode: string;
  laborCost: Dec;
  source: LaborCostSource | null;
  overlap: boolean;
  unmappedCostCentres: string[];
  departments: DepartmentCalc[];
  ledgerNetSales: Dec;
  netSalesReported: Dec | null;
  salesSource: HrSalesSource | null;
  /** Ventas efectivas según `salesSource`; null sin ventas. */
  sales: Dec | null;
  roomNights: number | null;
  roomNightsPartial: boolean;
  roomNightsSource: RoomNightsSource | null;
  headcount: Dec | null;
};

type Indexed = {
  laborRows: Map<string, LaborLedgerRow[]>;
  salesByCell: Map<string, Dec>;
  linesByCell: Map<string, LaborImportLine[]>;
  referenceByCell: Map<string, LaborImportReference>;
  roomNightsByCell: Map<string, LaborCostPanelRoomNightsInput>;
  revenueByCell: Map<string, Map<string, Dec>> | null;
};

function indexInputs(input: AggregateLaborCostPanelInput): Indexed {
  const laborRows = new Map<string, LaborLedgerRow[]>();
  const salesByCell = new Map<string, Dec>();
  for (const row of input.ledgerRows) {
    const key = cellKey(row.propertyId, row.periodCode);
    if (row.accountCode.startsWith(LABOR_ACCOUNT_PREFIX) && !row.fromPayrollImport) laborRows.set(key, [...(laborRows.get(key) ?? []), row]);
    if (row.accountCode.startsWith(SALES_ACCOUNT_PREFIX)) salesByCell.set(key, (salesByCell.get(key) ?? ZERO).plus(row.credit.minus(row.debit)));
  }
  const linesByCell = new Map<string, LaborImportLine[]>();
  for (const line of input.importLines) {
    const key = cellKey(line.propertyId, line.periodCode);
    linesByCell.set(key, [...(linesByCell.get(key) ?? []), line]);
  }
  // Referencias: gana el postedAt más reciente por celda (misma regla que el informe de coste).
  const referenceByCell = new Map<string, LaborImportReference>();
  const stamp = (value: Date | null | undefined): number => (value ? value.getTime() : 0);
  for (const reference of input.references) {
    const key = cellKey(reference.propertyId, reference.periodCode);
    const current = referenceByCell.get(key);
    if (!current || stamp(reference.postedAt) >= stamp(current.postedAt)) referenceByCell.set(key, reference);
  }
  const roomNightsByCell = new Map<string, LaborCostPanelRoomNightsInput>();
  for (const row of input.roomNights) roomNightsByCell.set(cellKey(row.propertyId, row.periodCode), row);
  let revenueByCell: Map<string, Map<string, Dec>> | null = null;
  if (input.departmentRevenue !== null) {
    revenueByCell = new Map();
    for (const row of input.departmentRevenue) {
      const key = cellKey(row.propertyId, row.periodCode);
      const byDepartment = revenueByCell.get(key) ?? new Map<string, Dec>();
      byDepartment.set(row.usaliDepartment, (byDepartment.get(row.usaliDepartment) ?? ZERO).plus(D(row.revenue)));
      revenueByCell.set(key, byDepartment);
    }
  }
  return { laborRows, salesByCell, linesByCell, referenceByCell, roomNightsByCell, revenueByCell };
}

function computeCell(propertyId: string, periodCode: string, index: Indexed): CellCalc {
  const key = cellKey(propertyId, periodCode);
  const ledger = index.laborRows.get(key) ?? [];
  const lines = index.linesByCell.get(key) ?? [];
  const reference = index.referenceByCell.get(key) ?? null;
  const revenueOf = index.revenueByCell?.get(key) ?? null;

  const byDepartment = new Map<LaborCostPanelDepartment, DepartmentCalc>();
  const unmapped = new Set<string>();
  let source: LaborCostSource | null = null;
  if (ledger.length > 0) {
    source = "ledger";
    for (const row of ledger) {
      const amount = row.debit.minus(row.credit);
      if (amount.isZero()) continue;
      const resolved = departmentOfCostCentre(row.costCentre);
      if (resolved.unmapped && row.costCentre) unmapped.add(`${row.costCentre.type}:${row.costCentre.code}`);
      const current = byDepartment.get(resolved.department) ?? { department: resolved.department, laborCost: ZERO, revenue: null, headcount: null, source: "ledger" as const };
      current.laborCost = current.laborCost.plus(amount);
      byDepartment.set(resolved.department, current);
    }
  } else if (lines.length > 0) {
    source = "import";
    for (const line of lines) {
      const department = departmentOfImportLine(line.usaliDepartment);
      const current = byDepartment.get(department) ?? { department, laborCost: ZERO, revenue: null, headcount: null, source: "import" as const };
      current.laborCost = current.laborCost.plus(line.totalCost);
      byDepartment.set(department, current);
    }
  }
  // Headcount por departamento: solo lo aporta el lote (también en solapamiento, como referencia).
  if (lines.length > 0) {
    const headcountByDepartment = new Map<LaborCostPanelDepartment, Dec>();
    for (const line of lines) {
      const department = departmentOfImportLine(line.usaliDepartment);
      headcountByDepartment.set(department, (headcountByDepartment.get(department) ?? ZERO).plus(line.headcount));
    }
    for (const [department, headcount] of headcountByDepartment) {
      const current = byDepartment.get(department);
      if (current && headcount.gt(0)) current.headcount = headcount;
    }
  }
  // Ingreso USALI de los departamentos operativos (nunca de `sin_desglose` ni de los no distribuidos).
  if (revenueOf) {
    for (const calc of byDepartment.values()) {
      if (OPERATING_DEPARTMENTS.has(calc.department)) calc.revenue = revenueOf.get(calc.department) ?? ZERO;
    }
  }

  let laborCost = ZERO;
  for (const calc of byDepartment.values()) laborCost = laborCost.plus(calc.laborCost);

  let headcount: Dec | null = null;
  if (reference?.employeesReported && reference.employeesReported.gt(0)) headcount = reference.employeesReported;
  else if (lines.length > 0) {
    let total = ZERO;
    for (const line of lines) total = total.plus(line.headcount);
    headcount = total.gt(0) ? total : null;
  }

  const ledgerNetSales = index.salesByCell.get(key) ?? ZERO;
  const netSalesReported = reference?.netSalesReported ?? null;
  const salesSource = salesSourceOf(ledgerNetSales, netSalesReported);
  const sales = salesSource === "ledger" ? ledgerNetSales : salesSource === "reference" ? netSalesReported : null;
  const rn = index.roomNightsByCell.get(key) ?? null;

  const departments = Array.from(byDepartment.values()).sort((a, b) => DEPARTMENT_ORDER.indexOf(a.department) - DEPARTMENT_ORDER.indexOf(b.department));
  return {
    propertyId,
    periodCode,
    laborCost,
    source,
    overlap: ledger.length > 0 && lines.length > 0,
    unmappedCostCentres: Array.from(unmapped).sort(),
    departments,
    ledgerNetSales,
    netSalesReported,
    salesSource,
    sales,
    roomNights: rn?.roomNights ?? null,
    roomNightsPartial: rn?.partial ?? false,
    roomNightsSource: rn?.source ?? null,
    headcount
  };
}

// ---------------------------------------------------------------------------
// Serialización de celdas y agregados
// ---------------------------------------------------------------------------

function departmentDto(calc: DepartmentCalc, monthSales: Dec | null): LaborCostPanelDepartmentDto {
  const own = OPERATING_DEPARTMENTS.has(calc.department);
  return {
    usaliDepartment: calc.department,
    label: departmentLabel(calc.department),
    laborCost: money(calc.laborCost),
    revenue: own && calc.revenue !== null ? money(calc.revenue) : null,
    pctOfSales: own ? (calc.revenue !== null ? pctOf(calc.laborCost, calc.revenue) : null) : pctOf(calc.laborCost, monthSales),
    headcount: headcountText(calc.headcount),
    costPerEmployee: calc.headcount !== null ? divide(calc.laborCost, calc.headcount) : null,
    source: calc.source
  };
}

function monthDto(cell: CellCalc): LaborCostPanelMonthDto {
  return {
    periodCode: cell.periodCode,
    laborCost: money(cell.laborCost),
    sales: cell.sales === null ? null : money(cell.sales),
    salesSource: cell.salesSource,
    pctOfSales: pctOf(cell.laborCost, cell.sales),
    roomNights: cell.roomNights,
    laborCostPerOccupiedRoom: cell.roomNights !== null && cell.roomNights > 0 ? divide(cell.laborCost, cell.roomNights) : null,
    headcount: headcountText(cell.headcount),
    costPerEmployee: cell.headcount !== null ? divide(cell.laborCost, cell.headcount) : null,
    source: cell.source,
    overlap: cell.overlap,
    noBreakdown: cell.departments.length > 0 && cell.departments.every((department) => department.department === LABOR_COST_PANEL_NO_BREAKDOWN),
    departments: cell.departments.map((department) => departmentDto(department, cell.sales))
  };
}

/**
 * Agregado de un conjunto de celdas (los meses de un centro, o todos los
 * centros × meses de la sociedad). Cada ratio se calcula sobre las celdas que
 * tienen su denominador; el coste total suma todas.
 */
function totalsOf(cells: readonly CellCalc[], previousCells: readonly CellCalc[] | null): LaborCostPanelTotalsDto {
  let laborCost = ZERO;
  let salesLabor = ZERO;
  let sales: Dec | null = null;
  let rnLabor = ZERO;
  let roomNights: number | null = null;
  let headcountLabor = ZERO;
  const headcountByMonth = new Map<string, Dec>();
  const byDepartment = new Map<LaborCostPanelDepartment, { laborCost: Dec; revenue: Dec | null; revenueLabor: Dec; headcountByMonth: Map<string, Dec>; headcountLabor: Dec; source: LaborCostSource; salesLabor: Dec; sales: Dec | null }>();
  for (const cell of cells) {
    laborCost = laborCost.plus(cell.laborCost);
    if (cell.sales !== null) {
      sales = (sales ?? ZERO).plus(cell.sales);
      salesLabor = salesLabor.plus(cell.laborCost);
    }
    if (cell.roomNights !== null) {
      roomNights = (roomNights ?? 0) + cell.roomNights;
      rnLabor = rnLabor.plus(cell.laborCost);
    }
    if (cell.headcount !== null) {
      headcountByMonth.set(cell.periodCode, (headcountByMonth.get(cell.periodCode) ?? ZERO).plus(cell.headcount));
      headcountLabor = headcountLabor.plus(cell.laborCost);
    }
    for (const department of cell.departments) {
      const current = byDepartment.get(department.department) ?? { laborCost: ZERO, revenue: null, revenueLabor: ZERO, headcountByMonth: new Map<string, Dec>(), headcountLabor: ZERO, source: department.source, salesLabor: ZERO, sales: null };
      current.laborCost = current.laborCost.plus(department.laborCost);
      if (department.revenue !== null) {
        current.revenue = (current.revenue ?? ZERO).plus(department.revenue);
        current.revenueLabor = current.revenueLabor.plus(department.laborCost);
      }
      if (cell.sales !== null) {
        current.sales = (current.sales ?? ZERO).plus(cell.sales);
        current.salesLabor = current.salesLabor.plus(department.laborCost);
      }
      if (department.headcount !== null) {
        current.headcountByMonth.set(cell.periodCode, (current.headcountByMonth.get(cell.periodCode) ?? ZERO).plus(department.headcount));
        current.headcountLabor = current.headcountLabor.plus(department.laborCost);
      }
      if (current.source !== department.source) current.source = "ledger";
      byDepartment.set(department.department, current);
    }
  }
  const headcount = meanOf(Array.from(headcountByMonth.values()));
  let deltaPrevious: string | null = null;
  if (previousCells && cells.some((cell) => cell.source !== null)) {
    let previous = ZERO;
    let anyPrevious = false;
    for (const cell of previousCells) {
      if (cell.source === null) continue;
      anyPrevious = true;
      previous = previous.plus(cell.laborCost);
    }
    if (anyPrevious && previous.gt(0)) deltaPrevious = pct(laborCost.minus(previous), previous);
  }
  return {
    laborCost: money(laborCost),
    sales: sales === null ? null : money(sales),
    pctOfSales: pctOf(salesLabor, sales),
    roomNights,
    laborCostPerOccupiedRoom: roomNights !== null && roomNights > 0 ? divide(rnLabor, roomNights) : null,
    headcount: headcountText(headcount),
    costPerEmployee: headcount !== null ? divide(headcountLabor, headcount) : null,
    deltaPrevious,
    byDepartment: Array.from(byDepartment.entries())
      .sort((a, b) => DEPARTMENT_ORDER.indexOf(a[0]) - DEPARTMENT_ORDER.indexOf(b[0]))
      .map(([department, agg]) => {
        const own = OPERATING_DEPARTMENTS.has(department);
        const deptHeadcount = meanOf(Array.from(agg.headcountByMonth.values()));
        return {
          usaliDepartment: department,
          label: departmentLabel(department),
          laborCost: money(agg.laborCost),
          revenue: own && agg.revenue !== null ? money(agg.revenue) : null,
          pctOfSales: own ? (agg.revenue !== null ? pctOf(agg.revenueLabor, agg.revenue) : null) : pctOf(agg.salesLabor, agg.sales),
          headcount: headcountText(deptHeadcount),
          costPerEmployee: deptHeadcount !== null ? divide(agg.headcountLabor, deptHeadcount) : null,
          source: agg.source
        };
      })
  };
}

/** Una entrada de `degraded[]` por (centro, código) con los meses afectados en el mensaje; `periodCode` solo cuando es un único mes. */
function degradedEntry(code: string, centre: LaborCostPanelCentreInput | null, months: readonly string[], text: string): HrDegradedEntry {
  const where = centre ? `${centre.code ?? centre.name}: ` : "";
  const when = months.length === 0 ? "" : months.length === 1 ? ` (${months[0]})` : ` (${months.join(", ")})`;
  return { code, message: `${where}${text}${when}.`, propertyId: centre?.propertyId ?? null, periodCode: months.length === 1 ? months[0]! : null };
}

// ---------------------------------------------------------------------------
// Agregador (puro)
// ---------------------------------------------------------------------------

export function aggregateLaborCostPanel(input: AggregateLaborCostPanelInput): LaborCostPanelDto {
  const months = [...input.months];
  const previousMonths = [...(input.previousMonths ?? [])];
  const index = indexInputs(input);
  const degraded: HrDegradedEntry[] = [...(input.degraded ?? [])];
  const usedImportIds = new Set<string>();
  const accountCodes = new Set<string>();

  const centres: LaborCostPanelCentreDto[] = [];
  const allCells: CellCalc[] = [];
  const allPrevious: CellCalc[] = [];
  const roomNightsSources: LaborCostPanelDto["sources"]["roomNights"] = [];

  for (const centre of input.centres) {
    const cells = months.map((periodCode) => computeCell(centre.propertyId, periodCode, index));
    const previous = previousMonths.map((periodCode) => computeCell(centre.propertyId, periodCode, index));
    allCells.push(...cells);
    allPrevious.push(...previous);
    for (const cell of cells) {
      for (const line of index.linesByCell.get(cellKey(cell.propertyId, cell.periodCode)) ?? []) usedImportIds.add(line.importId);
    }
    // Degradados por centro, un código por vez con la lista de meses.
    const collect = (predicate: (cell: CellCalc) => boolean): string[] => cells.filter(predicate).map((cell) => cell.periodCode);
    const costMissing = collect((cell) => cell.source === null);
    if (costMissing.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.costMissing, centre, costMissing, "sin coste de personal en el diario ni en un lote contabilizado"));
    const overlap = collect((cell) => cell.overlap);
    if (overlap.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.overlap, centre, overlap, "diario 64x y lote contabilizado en el mismo mes: prevalece el diario; el lote solo aporta headcount y ventas de referencia"));
    const salesMissing = collect((cell) => cell.source !== null && cell.sales === null);
    if (salesMissing.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.salesMissing, centre, salesMissing, "sin ventas 70x en el diario ni referencia del lote: % sobre ventas no calculable"));
    const rnMissing = collect((cell) => cell.source !== null && cell.roomNights === null);
    if (rnMissing.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.rnMissing, centre, rnMissing, "sin habitaciones ocupadas reales (cierres, importación PMS o estancias): CPOR laboral no calculable"));
    const rnPartial = collect((cell) => cell.source !== null && cell.roomNights !== null && cell.roomNightsPartial);
    if (rnPartial.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.rnPartial, centre, rnPartial, "habitaciones ocupadas de un mes incompleto (días sin cierre o mes en curso): CPOR laboral orientativo"));
    const headcountMissing = collect((cell) => cell.source !== null && cell.headcount === null);
    if (headcountMissing.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.headcountMissing, centre, headcountMissing, "sin plantilla de referencia (lote contabilizado): coste por empleado no calculable"));
    const unmapped = Array.from(new Set(cells.flatMap((cell) => cell.unmappedCostCentres))).sort();
    if (unmapped.length > 0) degraded.push(degradedEntry(LABOR_PANEL_DEGRADED_CODES.costCentreUnmapped, centre, collect((cell) => cell.unmappedCostCentres.length > 0), `líneas 64x con centro de coste que no es un departamento USALI (${unmapped.join(", ")}): contadas en «${LABOR_COST_PANEL_NO_BREAKDOWN_LABEL_ES}»`));

    const rnSources = cells.map((cell) => cell.roomNightsSource).filter((source): source is RoomNightsSource => source !== null);
    const rnSource: RoomNightsSource = rnSources.includes("snapshot") ? "snapshot" : rnSources.includes("night_audit") ? "night_audit" : rnSources.includes("reservations") ? "reservations" : "degraded";
    roomNightsSources.push({ propertyId: centre.propertyId, source: rnSource });

    centres.push({
      propertyId: centre.propertyId,
      propertyCode: centre.code,
      propertyName: centre.name,
      legalEntityId: centre.legalEntityId,
      months: cells.map(monthDto),
      totals: totalsOf(cells, previousMonths.length > 0 ? previous : null)
    });
  }

  for (const row of input.ledgerRows) {
    if (!months.includes(row.periodCode)) continue;
    if (row.accountCode.startsWith(LABOR_ACCOUNT_PREFIX) || row.accountCode.startsWith(SALES_ACCOUNT_PREFIX)) accountCodes.add(row.accountCode);
  }

  const ranking: LaborCostPanelRankingRowDto[] =
    input.scope === "entity"
      ? centres
          .map((centre) => ({ propertyId: centre.propertyId, propertyCode: centre.propertyCode, propertyName: centre.propertyName, laborCost: centre.totals.laborCost, pctOfSales: centre.totals.pctOfSales }))
          .sort((a, b) => {
            if (a.pctOfSales === null && b.pctOfSales === null) return Number(b.laborCost) - Number(a.laborCost);
            if (a.pctOfSales === null) return 1;
            if (b.pctOfSales === null) return -1;
            return Number(b.pctOfSales) - Number(a.pctOfSales) || Number(b.laborCost) - Number(a.laborCost);
          })
      : [];

  return {
    from: input.from,
    to: input.to,
    scope: input.scope,
    legalEntityId: input.legalEntityId,
    centres,
    totals: totalsOf(allCells, previousMonths.length > 0 ? allPrevious : null),
    ranking,
    sources: {
      ledger: { entries: input.ledgerEntries ?? 0, accounts: Array.from(accountCodes).sort() },
      imports: (input.imports ?? []).filter((row) => usedImportIds.has(row.importId)).map((row) => ({ ...row, fileName: row.fileName ?? "" })),
      roomNights: roomNightsSources
    },
    degraded,
    generatedAt: input.generatedAt ?? new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Ingreso por departamento (núcleo puro del USALI sobre las filas del panel)
// ---------------------------------------------------------------------------

function toBalanceRow(row: LaborLedgerRow): AccountBalanceRow {
  return {
    code: row.accountCode,
    name: row.accountName,
    kind: row.accountKind as AccountKind,
    isPostable: row.isPostable,
    usaliDepartment: row.usaliDepartment,
    usaliLine: row.usaliLine,
    debit: row.debit,
    credit: row.credit,
    costCentre: row.costCentre
  };
}

/**
 * Ingreso USALI por departamento operativo de cada (centro, mes): `computeUsaliPnl`
 * (usali.service.ts, el mismo núcleo que `buildUsaliPnl`) sobre las filas del
 * diario ya leídas — ocupación y headcount no intervienen en el ingreso. Un mes
 * sin cuentas de ingreso en el diario no produce entrada (revenue null).
 */
export function departmentRevenueOf(input: { organizationId: string; centres: readonly LaborCostPanelCentreInput[]; months: readonly string[]; ledgerRows: readonly LaborLedgerRow[]; mappings: readonly UsaliMappingSourceRow[]; currency?: string }): LaborCostPanelDepartmentRevenueInput[] {
  const rowsByCell = new Map<string, AccountBalanceRow[]>();
  for (const row of input.ledgerRows) {
    const key = cellKey(row.propertyId, row.periodCode);
    rowsByCell.set(key, [...(rowsByCell.get(key) ?? []), toBalanceRow(row)]);
  }
  const out: LaborCostPanelDepartmentRevenueInput[] = [];
  for (const centre of input.centres) {
    for (const periodCode of input.months) {
      const rows = rowsByCell.get(cellKey(centre.propertyId, periodCode));
      // Sin ninguna cuenta de ingreso en el mes (p. ej. agosto de Faranda: solo el asiento del lote) no hay
      // ingreso por departamento que declarar: null, nunca un «0,00» que el front tomaría por ventas reales.
      if (!rows || !rows.some((row) => row.kind === "income")) continue;
      const pnl = computeUsaliPnl({
        organizationId: input.organizationId,
        propertyId: centre.propertyId,
        propertyName: centre.name,
        propertyKind: centre.kind,
        propertyCode: centre.code,
        period: { from: `${periodCode}-01`, to: `${periodCode}-01` },
        currency: input.currency ?? "EUR",
        rows,
        mappings: [...input.mappings],
        occupancy: { roomsInventory: 0, roomsOccupied: 0 }
      });
      for (const department of pnl.operatingDepartments) {
        if (!OPERATING_DEPARTMENTS.has(department.department)) continue;
        out.push({ propertyId: centre.propertyId, periodCode, usaliDepartment: department.department, revenue: department.revenue });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Servicio (Prisma)
// ---------------------------------------------------------------------------

export type BuildLaborCostPanelInput = {
  context: UserContext;
  from: string;
  to: string;
  propertyId?: string | null;
  db?: Db;
  today?: Date;
};

export async function buildLaborCostPanel(input: BuildLaborCostPanelInput): Promise<LaborCostPanelDto> {
  requireAnyPermission(input.context, PAYROLL_READ_KEYS);
  const db = input.db ?? defaultLaborPanelDb;
  const organizationId = input.context.organizationId;
  const months = monthsBetween(input.from, input.to);
  const previousMonths = previousMonthsOf(months);
  const propertyId = input.propertyId ?? null;

  // Tenencia y ámbito: 404 opaco (mismo cuerpo para un centro ajeno y uno inexistente); sin centro, toda la sociedad.
  if (propertyId) {
    const owned = await db.property.findFirst({ where: { id: propertyId, organizationId }, select: { id: true } });
    if (!owned || !propertyWithinScope(input.context, owned.id)) throw ledgerNotFound("PROPERTY_NOT_FOUND", "Propiedad no encontrada.");
  } else {
    assertFinanceReadScope(input.context, null);
  }
  const scope = await resolveLedgerScope(input.context, { propertyId }, db);

  const properties = await db.property.findMany({
    where: { organizationId, ...(propertyId ? { id: propertyId } : {}) },
    select: { id: true, code: true, name: true, kind: true, legalEntityId: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }]
  });
  const centres: LaborCostPanelCentreInput[] = properties
    .filter((property) => propertyWithinScope(input.context, property.id))
    .sort((a, b) => (a.kind === "hotel" ? 0 : 1) - (b.kind === "hotel" ? 0 : 1) || a.name.localeCompare(b.name))
    .map((property) => ({ propertyId: property.id, code: property.code ?? null, name: property.name, kind: property.kind, legalEntityId: property.legalEntityId ?? null }));
  const propertyIds = centres.map((centre) => centre.propertyId);
  const allMonths = [...previousMonths, ...months];
  const degraded: HrDegradedEntry[] = [];
  const today = input.today ?? new Date();

  const canReadUsali = Boolean(input.context.isPlatformAdmin) || (input.context.permissions ?? []).includes(LABOR_PANEL_USALI_PERMISSION);
  const [ledgerRows, ledgerEntries, posted, mappings, roomNightsByCentre] = await Promise.all([
    loadLaborLedgerRows(db, organizationId, propertyIds, allMonths),
    countLaborLedgerEntries(db, organizationId, propertyIds, months),
    loadPostedPayrollImports(db, organizationId, propertyIds, allMonths),
    canReadUsali ? prismaFinancialStatementsSource.usaliMappings(organizationId) : Promise.resolve<UsaliMappingSourceRow[]>([]),
    Promise.all(
      centres.map(async (centre) => {
        try {
          return await loadRoomNightsByMonth(db, centre.propertyId, months, today);
        } catch (error) {
          console.warn("[payroll.labor-cost-panel] room-nights read failed → degraded", { organizationId, propertyId: centre.propertyId, error: error instanceof Error ? error.message : String(error) });
          degraded.push({ code: LABOR_PANEL_DEGRADED_CODES.rnQueryFailed, message: `${centre.code ?? centre.name}: no se pudieron leer las habitaciones ocupadas; CPOR laboral no calculable.`, propertyId: centre.propertyId, periodCode: null });
          return [] as RoomNightsMonth[];
        }
      })
    )
  ]);

  let departmentRevenue: LaborCostPanelDepartmentRevenueInput[] | null = null;
  if (!canReadUsali) {
    degraded.push({ code: LABOR_PANEL_DEGRADED_CODES.usaliForbidden, message: `Ingreso por departamento no disponible: requiere ${LABOR_PANEL_USALI_PERMISSION} (USALI).`, propertyId: null, periodCode: null });
  } else {
    try {
      departmentRevenue = departmentRevenueOf({ organizationId, centres, months, ledgerRows: ledgerRows.filter((row) => months.includes(row.periodCode)), mappings });
    } catch (error) {
      console.warn("[payroll.labor-cost-panel] USALI department revenue failed → degraded", { organizationId, error: error instanceof Error ? error.message : String(error) });
      degraded.push({ code: LABOR_PANEL_DEGRADED_CODES.usaliFailed, message: "Ingreso por departamento no disponible: el cálculo USALI del mes falló.", propertyId: null, periodCode: null });
    }
  }

  return aggregateLaborCostPanel({
    from: months[0]!,
    to: months[months.length - 1]!,
    months,
    previousMonths,
    scope: scope.kind,
    legalEntityId: scope.legalEntityId,
    centres,
    ledgerRows,
    importLines: posted.lines,
    references: posted.references,
    imports: posted.imports,
    roomNights: roomNightsByCentre.flat(),
    departmentRevenue,
    ledgerEntries,
    degraded,
    generatedAt: new Date().toISOString()
  });
}
