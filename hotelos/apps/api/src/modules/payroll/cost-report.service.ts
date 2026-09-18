// Coste de personal importado (Tanda 6c · L1) — informe centros × meses
// (`GET /payroll/cost-report`, pestaña «Coste de personal» de Nóminas).
//
// `aggregatePayrollCostReport` es PURA (sin BD): recibe las líneas de los lotes
// `posted`, las referencias del informe (empleados, inventario de habitaciones,
// ventas sin IVA), las ventas netas del libro (grupo 70 por centro × mes) y el
// inventario de habitaciones del ERP, y produce todas las celdas y agregados
// con sus derivados; el front solo formatea. `buildPayrollCostReport` carga
// esas entradas de Postgres (una sola `$queryRaw` para las ventas, con la misma
// regla de exclusión que los estados: sin borradores, sin parejas de reverso
// marcadas, sin regularización / cierre / apertura) y filtra los centros por el
// ámbito del usuario (`propertyWithinScope`; la ruta aplica `assertFinanceReadScope`).
//
// Derivados por celda (diseño §5):
//   headcountEffective   = employeesReported ?? Σ headcount de las filas (con `headcountSource`);
//                          con filtro de grupo SIEMPRE Σ de las filas del grupo (la referencia cubre todos los grupos)
//   costPerEmployee      = totalCost / headcountEffective
//   roomsAvailable       = (roomsInventoryReported ?? roomsInventory) × días del mes
//   costPerAvailableRoom = totalCost / roomsAvailable
//   laborPctLedger       = 100 × totalCost / ledgerNetSales · laborPctReference = 100 × totalCost / netSalesReported
//   salesSource          = fuente PRINCIPAL de ventas (contable-6C-03): `ledger` solo cuando el libro cubre el
//                          periodo (tiene ventas y, si hay referencia, alcanza PAYROLL_COST_LEDGER_COVERAGE_MIN
//                          de ella); si no, `reference` cuando la hay; null sin ventas. Sin la regla, 10,33 € de
//                          ventas en el libro daban un «Personal s/ ventas» de 23.645.296,81 %.
//   null con denominador 0 (nunca un 0 falso); el filtro `group` afecta SOLO a las líneas de coste
//   (ventas y referencia no se filtran). En agregados el headcount es Σ por mes y media de los
//   meses con dato entre meses; `totals.headcountAverage` y `costPerEmployeeAverage` (coste ACUMULADO
//   del rango por empleado medio) en la sociedad.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type {
  PayrollCostGroup,
  PayrollCostHeadcountSource,
  PayrollCostReport,
  PayrollCostReportCell,
  PayrollCostReportCentre,
  PayrollCostReportMetrics,
  PayrollCostReportMonth,
  PayrollCostSalesSource,
  PropertyKind
} from "@hotelos/shared";
import { PAYROLL_COST_LEDGER_COVERAGE_MIN, PAYROLL_COST_REPORT_MAX_MONTHS } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { propertyWithinScope, resolveLedgerScope } from "../../lib/finance-scope.js";
import { ledgerBadRequest, ledgerNotFound } from "../accounting/accounting.service.js";
import { pct } from "../financial-statements/money.js";
import { type Db } from "../treasury/ledger-bridge.js";
import { dec, money, round2, type Dec } from "../treasury/money.js";
import { PAYROLL_READ_KEYS, requireAnyPermission } from "../treasury/permissions.js";
import { daysInMonth } from "./cost-import.posting.js";
import { costTotalsByDepartment, costTotalsByGroup, sumCostTotals, type CostRowLike } from "./cost-import.service.js";

const ZERO = new Prisma.Decimal(0);
const MONTH = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------
// Entradas de la función pura
// ---------------------------------------------------------------------------

export type PayrollCostReportLineInput = {
  importId: string;
  propertyId: string;
  periodCode: string;
  costGroup: string;
  usaliDepartment: string;
  gross: Dec | string | number;
  employerSs: Dec | string | number;
  totalCost: Dec | string | number;
  reportedTotalCost: Dec | string | number | null;
  headcount: Dec | string | number;
};

export type PayrollCostReportReferenceInput = {
  propertyId: string;
  periodCode: string;
  employeesReported: Dec | string | number | null;
  roomsAvailableReported: number | null;
  netSalesReported: Dec | string | number | null;
  /** Para desempatar varias referencias de la misma celda: gana el `postedAt` más reciente. */
  postedAt?: Date | string | null;
};

export type PayrollCostReportSalesInput = {
  propertyId: string;
  periodCode: string;
  netSales: Dec | string | number;
};

export type PayrollCostReportCentreInput = {
  propertyId: string;
  code: string | null;
  name: string;
  kind: PropertyKind;
};

export type AggregatePayrollCostReportInput = {
  lines: readonly PayrollCostReportLineInput[];
  references: readonly PayrollCostReportReferenceInput[];
  ledgerSales: readonly PayrollCostReportSalesInput[];
  /** Habitaciones activas del ERP por centro (hoteles); ausente = 0. */
  roomsInventory: Readonly<Record<string, number>>;
  /** Meses del rango en orden ("YYYY-MM"). */
  months: readonly string[];
  /** Centros a presentar (hoteles primero), ya filtrados por ámbito. */
  centres: readonly PayrollCostReportCentreInput[];
  group?: PayrollCostGroup | null;
  organizationId?: string;
  legalEntityId?: string | null;
  propertyId?: string | null;
  imports?: PayrollCostReport["imports"];
  generatedAt?: string;
  warnings?: string[];
};

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

/** Meses "YYYY-MM" inclusivos entre from y to; lanza 400 VALIDATION_ERROR fuera de forma o de rango. */
export function monthsBetween(from: string, to: string): string[] {
  if (!MONTH.test(from) || !MONTH.test(to)) throw ledgerBadRequest("VALIDATION_ERROR", "from y to deben tener formato YYYY-MM.");
  if (to < from) throw ledgerBadRequest("VALIDATION_ERROR", "to debe ser igual o posterior a from.");
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number) as [number, number];
  if (month < 1 || month > 12 || Number(to.slice(5)) < 1 || Number(to.slice(5)) > 12) throw ledgerBadRequest("VALIDATION_ERROR", "El mes debe estar entre 01 y 12.");
  for (;;) {
    const code = `${year}-${String(month).padStart(2, "0")}`;
    out.push(code);
    if (code === to) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (out.length > PAYROLL_COST_REPORT_MAX_MONTHS) throw ledgerBadRequest("VALIDATION_ERROR", `El rango no puede superar ${PAYROLL_COST_REPORT_MAX_MONTHS} meses.`);
  }
  return out;
}

function divide(numerator: Dec, denominator: Dec | number | null): string | null {
  if (denominator === null) return null;
  const den = dec(denominator);
  if (den.isZero()) return null;
  return money(numerator.div(den));
}

function headcountText(value: Dec | null): string | null {
  return value === null ? null : round2(value).toFixed(2);
}

/** Fuente principal de ventas de una celda o agregado (regla de cobertura del libro, contable-6C-03). */
export function salesSourceOf(ledgerNetSales: Dec, netSalesReported: Dec | null): PayrollCostSalesSource | null {
  const hasReference = netSalesReported !== null && netSalesReported.gt(0);
  if (ledgerNetSales.gt(0) && (!hasReference || ledgerNetSales.gte(netSalesReported!.times(PAYROLL_COST_LEDGER_COVERAGE_MIN)))) return "ledger";
  if (hasReference) return "reference";
  return null;
}

/** Valores Decimal de una celda antes de serializar (para poder agregar). */
type CellCalc = {
  propertyId: string;
  periodCode: string;
  days: number;
  rows: CostRowLike[];
  employeesReported: Dec | null;
  headcountEffective: Dec | null;
  headcountSource: PayrollCostHeadcountSource | null;
  ledgerNetSales: Dec;
  netSalesReported: Dec | null;
  roomsInventory: number;
  roomsInventoryReported: number | null;
  roomsAvailable: number;
  importIds: string[];
};

type Aggregate = {
  rows: CostRowLike[];
  employeesReported: Dec | null;
  headcountEffective: Dec | null;
  headcountSource: PayrollCostHeadcountSource | null;
  ledgerNetSales: Dec;
  netSalesReported: Dec | null;
  roomsInventory: number;
  roomsInventoryReported: number | null;
  roomsAvailable: number;
};

function metricsOf(a: Aggregate): PayrollCostReportMetrics {
  const totals = sumCostTotals(a.rows);
  const totalCost = dec(totals.totalCost);
  return {
    ...totals,
    employeesReported: headcountText(a.employeesReported),
    headcountEffective: headcountText(a.headcountEffective),
    headcountSource: a.headcountSource,
    costPerEmployee: a.headcountEffective && !a.headcountEffective.isZero() ? divide(totalCost, a.headcountEffective) : null,
    ledgerNetSales: money(a.ledgerNetSales),
    netSalesReported: a.netSalesReported === null ? null : money(a.netSalesReported),
    laborPctLedger: a.ledgerNetSales.gt(0) ? pct(totalCost, a.ledgerNetSales) : null,
    laborPctReference: a.netSalesReported !== null && a.netSalesReported.gt(0) ? pct(totalCost, a.netSalesReported) : null,
    salesSource: salesSourceOf(a.ledgerNetSales, a.netSalesReported),
    roomsInventory: a.roomsInventory,
    roomsInventoryReported: a.roomsInventoryReported,
    roomsAvailable: a.roomsAvailable,
    costPerAvailableRoom: a.roomsAvailable > 0 ? divide(totalCost, a.roomsAvailable) : null,
    byGroup: costTotalsByGroup(a.rows),
    byDepartment: costTotalsByDepartment(a.rows)
  };
}

/** Σ de celdas del MISMO mes (varios centros): el headcount se suma. */
function sumSameMonth(cells: readonly CellCalc[]): Aggregate {
  let employeesReported: Dec | null = null;
  let headcountEffective: Dec | null = null;
  let anyReference = false;
  let anyLines = false;
  let ledgerNetSales: Dec = ZERO;
  let netSalesReported: Dec | null = null;
  let roomsInventory = 0;
  let roomsInventoryReported: number | null = null;
  let roomsAvailable = 0;
  const rows: CostRowLike[] = [];
  for (const cell of cells) {
    rows.push(...cell.rows);
    if (cell.employeesReported !== null) employeesReported = (employeesReported ?? ZERO).plus(cell.employeesReported);
    if (cell.headcountEffective !== null) {
      headcountEffective = (headcountEffective ?? ZERO).plus(cell.headcountEffective);
      if (cell.headcountSource === "reference") anyReference = true;
      else anyLines = true;
    }
    ledgerNetSales = ledgerNetSales.plus(cell.ledgerNetSales);
    if (cell.netSalesReported !== null) netSalesReported = (netSalesReported ?? ZERO).plus(cell.netSalesReported);
    roomsInventory += cell.roomsInventory;
    if (cell.roomsInventoryReported !== null) roomsInventoryReported = (roomsInventoryReported ?? 0) + cell.roomsInventoryReported;
    roomsAvailable += cell.roomsAvailable;
  }
  return { rows, employeesReported, headcountEffective, headcountSource: anyReference ? "reference" : anyLines ? "lines" : null, ledgerNetSales, netSalesReported, roomsInventory, roomsInventoryReported, roomsAvailable };
}

/** Σ de agregados de DISTINTOS meses: importes y habitaciones se suman, el headcount es la media de los meses con dato. */
function sumAcrossMonths(months: readonly Aggregate[]): Aggregate & { headcountAverage: Dec | null } {
  const rows: CostRowLike[] = [];
  let ledgerNetSales: Dec = ZERO;
  let netSalesReported: Dec | null = null;
  let roomsInventory = 0;
  let roomsInventoryReported: number | null = null;
  let roomsAvailable = 0;
  let reportedSum: Dec = ZERO;
  let reportedMonths = 0;
  let effectiveSum: Dec = ZERO;
  let effectiveMonths = 0;
  let anyReference = false;
  let anyLines = false;
  for (const month of months) {
    rows.push(...month.rows);
    ledgerNetSales = ledgerNetSales.plus(month.ledgerNetSales);
    if (month.netSalesReported !== null) netSalesReported = (netSalesReported ?? ZERO).plus(month.netSalesReported);
    if (month.employeesReported !== null) {
      reportedSum = reportedSum.plus(month.employeesReported);
      reportedMonths += 1;
    }
    if (month.headcountEffective !== null) {
      effectiveSum = effectiveSum.plus(month.headcountEffective);
      effectiveMonths += 1;
      if (month.headcountSource === "reference") anyReference = true;
      else anyLines = true;
    }
    if (month.roomsInventory > 0 || month.roomsInventoryReported !== null) {
      roomsInventory = Math.max(roomsInventory, month.roomsInventory);
      if (month.roomsInventoryReported !== null) roomsInventoryReported = Math.max(roomsInventoryReported ?? 0, month.roomsInventoryReported);
    }
    roomsAvailable += month.roomsAvailable;
  }
  const headcountAverage = effectiveMonths > 0 ? round2(effectiveSum.div(effectiveMonths)) : null;
  return {
    rows,
    employeesReported: reportedMonths > 0 ? round2(reportedSum.div(reportedMonths)) : null,
    headcountEffective: headcountAverage,
    headcountSource: anyReference ? "reference" : anyLines ? "lines" : null,
    ledgerNetSales,
    netSalesReported,
    roomsInventory,
    roomsInventoryReported,
    roomsAvailable,
    headcountAverage
  };
}

// ---------------------------------------------------------------------------
// Agregador (puro)
// ---------------------------------------------------------------------------

export function aggregatePayrollCostReport(input: AggregatePayrollCostReportInput): PayrollCostReport {
  const group = input.group ?? null;
  const months = [...input.months];
  const monthSet = new Set(months);
  const centreIds = new Set(input.centres.map((centre) => centre.propertyId));

  // Líneas por celda (el filtro de grupo afecta SOLO a las líneas de coste).
  const linesByCell = new Map<string, CostRowLike[]>();
  const importsByCell = new Map<string, string[]>();
  for (const line of input.lines) {
    if (!monthSet.has(line.periodCode) || !centreIds.has(line.propertyId)) continue;
    if (group && line.costGroup !== group) continue;
    const key = `${line.propertyId}|${line.periodCode}`;
    linesByCell.set(key, [...(linesByCell.get(key) ?? []), { costGroup: line.costGroup, usaliDepartment: line.usaliDepartment, gross: dec(line.gross), employerSs: dec(line.employerSs), totalCost: dec(line.totalCost), reportedTotalCost: line.reportedTotalCost === null ? null : dec(line.reportedTotalCost), headcount: dec(line.headcount) }]);
    const imports = importsByCell.get(key) ?? [];
    if (!imports.includes(line.importId)) imports.push(line.importId);
    importsByCell.set(key, imports);
  }
  // Referencias: gana el postedAt más reciente por celda.
  const referenceByCell = new Map<string, PayrollCostReportReferenceInput>();
  const stamp = (value: Date | string | null | undefined): number => (value ? new Date(value).getTime() : 0);
  for (const reference of input.references) {
    if (!monthSet.has(reference.periodCode) || !centreIds.has(reference.propertyId)) continue;
    const key = `${reference.propertyId}|${reference.periodCode}`;
    const current = referenceByCell.get(key);
    if (!current || stamp(reference.postedAt) >= stamp(current.postedAt)) referenceByCell.set(key, reference);
  }
  const salesByCell = new Map<string, Dec>();
  for (const sale of input.ledgerSales) {
    const key = `${sale.propertyId}|${sale.periodCode}`;
    salesByCell.set(key, (salesByCell.get(key) ?? ZERO).plus(dec(sale.netSales)));
  }

  const centres: PayrollCostReportCentre[] = [];
  const cellsByMonth = new Map<string, CellCalc[]>();
  const monthAggregates: Aggregate[] = [];
  for (const centre of input.centres) {
    const calcs: CellCalc[] = [];
    for (const periodCode of months) {
      const key = `${centre.propertyId}|${periodCode}`;
      const rows = linesByCell.get(key) ?? [];
      const reference = referenceByCell.get(key);
      const employeesReported = reference && reference.employeesReported !== null ? dec(reference.employeesReported) : null;
      let linesHeadcount: Dec = ZERO;
      for (const row of rows) linesHeadcount = linesHeadcount.plus(row.headcount);
      let headcountEffective: Dec | null = null;
      let headcountSource: PayrollCostHeadcountSource | null = null;
      if (!group && employeesReported !== null) {
        headcountEffective = employeesReported;
        headcountSource = "reference";
      } else if (rows.length > 0) {
        headcountEffective = linesHeadcount;
        headcountSource = "lines";
      }
      const roomsInventory = input.roomsInventory[centre.propertyId] ?? 0;
      const roomsInventoryReported = reference?.roomsAvailableReported ?? null;
      const days = daysInMonth(periodCode);
      const calc: CellCalc = {
        propertyId: centre.propertyId,
        periodCode,
        days,
        rows,
        employeesReported,
        headcountEffective,
        headcountSource,
        ledgerNetSales: salesByCell.get(key) ?? ZERO,
        netSalesReported: reference && reference.netSalesReported !== null ? dec(reference.netSalesReported) : null,
        roomsInventory,
        roomsInventoryReported,
        roomsAvailable: (roomsInventoryReported ?? roomsInventory) * days,
        importIds: importsByCell.get(key) ?? []
      };
      calcs.push(calc);
      cellsByMonth.set(periodCode, [...(cellsByMonth.get(periodCode) ?? []), calc]);
    }
    const cells: PayrollCostReportCell[] = calcs.map((calc) => ({
      ...metricsOf(sumSameMonth([calc])),
      propertyId: calc.propertyId,
      periodCode: calc.periodCode,
      daysInMonth: calc.days,
      importIds: calc.importIds
    }));
    const totals = metricsOf(sumAcrossMonths(calcs.map((calc) => sumSameMonth([calc]))));
    centres.push({ propertyId: centre.propertyId, code: centre.code, name: centre.name, kind: centre.kind, cells, totals });
  }

  const byMonth: PayrollCostReportMonth[] = months.map((periodCode) => {
    const aggregate = sumSameMonth(cellsByMonth.get(periodCode) ?? []);
    monthAggregates.push(aggregate);
    const metrics = metricsOf(aggregate);
    return { ...metrics, periodCode, salesSource: metrics.salesSource };
  });
  const society = sumAcrossMonths(monthAggregates);
  const societyMetrics = metricsOf(society);
  const totalCost = dec(societyMetrics.totalCost);
  const imports = input.imports ?? [];
  return {
    organizationId: input.organizationId ?? "",
    legalEntityId: input.legalEntityId ?? null,
    period: { from: months[0] ?? "", to: months[months.length - 1] ?? "" },
    months,
    propertyId: input.propertyId ?? null,
    group,
    centres,
    byMonth,
    totals: {
      ...societyMetrics,
      headcountAverage: headcountText(society.headcountAverage),
      costPerEmployeeAverage: society.headcountAverage && !society.headcountAverage.isZero() ? divide(totalCost, society.headcountAverage) : null
    },
    imports,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    warnings: input.warnings ?? []
  };
}

// ---------------------------------------------------------------------------
// Lectura de Postgres
// ---------------------------------------------------------------------------

type SalesRow = { property_id: string | null; period_code: string; net_sales: Prisma.Decimal | string | number | null };

/** Ventas netas del libro (cuentas 70x, haber − debe) por centro × mes con la regla de exclusión de los estados. */
async function loadLedgerSales(db: Db, organizationId: string, propertyIds: readonly string[], months: readonly string[]): Promise<PayrollCostReportSalesInput[]> {
  if (propertyIds.length === 0 || months.length === 0) return [];
  const from = `${months[0]}-01`;
  const last = months[months.length - 1]!;
  const to = `${last}-${String(daysInMonth(last)).padStart(2, "0")}`;
  const rows = await db.$queryRaw<SalesRow[]>(Prisma.sql`
    SELECT je.property_id AS property_id,
           to_char(je.entry_date, 'YYYY-MM') AS period_code,
           COALESCE(SUM(jl.credit - jl.debit), 0) AS net_sales
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.organization_id = ${organizationId}
      AND je.status <> 'draft' AND je.reversed_by_id IS NULL AND je.reversal_of_id IS NULL
      AND je.entry_kind NOT IN ('regularization', 'closing', 'opening')
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
      AND je.property_id IN (${Prisma.join([...propertyIds])})
      AND a.code LIKE '70%'
    GROUP BY je.property_id, to_char(je.entry_date, 'YYYY-MM')`);
  return rows
    .filter((row): row is SalesRow & { property_id: string } => typeof row.property_id === "string")
    .map((row) => ({ propertyId: row.property_id, periodCode: row.period_code, netSales: dec(row.net_sales) }));
}

/**
 * Cota explícita de las líneas del informe (L2-05): ≤ 24 meses × centros ×
 * grupos × departamentos; un lote admite PAYROLL_COST_IMPORT_MAX_ROWS filas y
 * un mes solo tiene un lote contabilizado por centro, así que la cota nunca
 * corta un informe real. Si se alcanzase, el informe lo dice en `warnings`.
 */
export const PAYROLL_COST_REPORT_MAX_LINES = 50_000;

export async function buildPayrollCostReport(input: { context: UserContext; organizationId?: string; from: string; to: string; propertyId?: string | null; group?: PayrollCostGroup | null; db?: Db }): Promise<PayrollCostReport> {
  requireAnyPermission(input.context, PAYROLL_READ_KEYS);
  const db = input.db ?? prisma;
  const organizationId = input.organizationId?.trim() || input.context.organizationId;
  if (organizationId !== input.context.organizationId && !input.context.isPlatformAdmin) throw ledgerBadRequest("VALIDATION_ERROR", "organizationId no válido para este contexto.");
  const scopeContext: UserContext = organizationId === input.context.organizationId ? input.context : { ...input.context, organizationId };
  const months = monthsBetween(input.from, input.to);
  const group = input.group ?? null;
  // Tenencia y ámbito del centro filtrado: 404 opaco con código (el mismo que el resto de rutas de Finanzas).
  if (input.propertyId) {
    const owned = await db.property.findFirst({ where: { id: input.propertyId, organizationId }, select: { id: true } });
    if (!owned || !propertyWithinScope(scopeContext, owned.id)) throw ledgerNotFound("PROPERTY_NOT_FOUND", "Propiedad no encontrada.", { propertyId: input.propertyId });
  }
  // Sociedad (legalEntityId) vía resolveLedgerScope (nunca organization.taxId / legalName).
  const scope = await resolveLedgerScope(scopeContext, { propertyId: input.propertyId ?? null }, db);

  const properties = await db.property.findMany({
    where: { organizationId, ...(input.propertyId ? { id: input.propertyId } : {}) },
    select: { id: true, code: true, name: true, kind: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }]
  });
  const centres = properties
    .filter((property) => propertyWithinScope(scopeContext, property.id))
    .sort((a, b) => (a.kind === "hotel" ? 0 : 1) - (b.kind === "hotel" ? 0 : 1) || a.name.localeCompare(b.name))
    .map((property) => ({ propertyId: property.id, code: property.code ?? null, name: property.name, kind: property.kind }));
  const propertyIds = centres.map((centre) => centre.propertyId);

  const lineRows = propertyIds.length
    ? await db.payrollCostLine.findMany({
        where: { organizationId, propertyId: { in: propertyIds }, periodCode: { in: months }, import: { status: "posted" } },
        select: { importId: true, propertyId: true, periodCode: true, costGroup: true, usaliDepartment: true, gross: true, employerSs: true, totalCost: true, reportedTotalCost: true, headcount: true },
        take: PAYROLL_COST_REPORT_MAX_LINES
      })
    : [];
  const warnings: string[] = [];
  if (lineRows.length >= PAYROLL_COST_REPORT_MAX_LINES) {
    warnings.push(`El informe supera ${PAYROLL_COST_REPORT_MAX_LINES} líneas de coste: se calcula con las primeras ${PAYROLL_COST_REPORT_MAX_LINES}; acota el rango o filtra por centro.`);
  }
  // Una referencia por celda (centro × mes) contabilizada: la cota es exacta.
  const referenceRows = propertyIds.length
    ? await db.payrollCostReference.findMany({
        where: { organizationId, propertyId: { in: propertyIds }, periodCode: { in: months }, import: { status: "posted" } },
        select: { propertyId: true, periodCode: true, employeesReported: true, roomsAvailableReported: true, netSalesReported: true, import: { select: { postedAt: true } } },
        take: Math.max(1, propertyIds.length * months.length)
      })
    : [];
  const ledgerSales = await loadLedgerSales(db, organizationId, propertyIds, months);
  const roomGroups = propertyIds.length ? await db.room.groupBy({ by: ["propertyId"], where: { propertyId: { in: propertyIds }, active: true }, _count: { _all: true } }) : [];
  const roomsInventory: Record<string, number> = {};
  for (const row of roomGroups) roomsInventory[row.propertyId] = row._count._all;
  const importIds = Array.from(new Set(lineRows.map((line) => line.importId)));
  const importRows = importIds.length ? await db.payrollCostImport.findMany({ where: { id: { in: importIds } }, select: { id: true, fileName: true, periodFrom: true, periodTo: true, postedAt: true }, orderBy: { postedAt: "asc" } }) : [];

  return aggregatePayrollCostReport({
    lines: lineRows.map((line) => ({ ...line, reportedTotalCost: line.reportedTotalCost ?? null })),
    references: referenceRows.map((reference) => ({ propertyId: reference.propertyId, periodCode: reference.periodCode, employeesReported: reference.employeesReported ?? null, roomsAvailableReported: reference.roomsAvailableReported ?? null, netSalesReported: reference.netSalesReported ?? null, postedAt: reference.import.postedAt })),
    ledgerSales,
    roomsInventory,
    months,
    centres,
    group,
    organizationId,
    legalEntityId: scope.legalEntityId,
    propertyId: input.propertyId ?? null,
    imports: importRows.map((row) => ({ importId: row.id, fileName: row.fileName ?? null, periodFrom: row.periodFrom, periodTo: row.periodTo, postedAt: row.postedAt ? row.postedAt.toISOString() : null })),
    generatedAt: new Date().toISOString(),
    warnings
  });
}
