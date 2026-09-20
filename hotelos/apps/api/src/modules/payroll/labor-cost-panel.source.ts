// Panel de costes de personal de dirección (Tanda RRHH · PANEL-A) — lectores de
// Postgres. Diseño: docs/design/PANEL-COSTES-DIRECCION.md §1 (el panel lee el
// libro, no el PMS; nunca un 0 inventado), §3.3 (bloque laboral) y §5.1 (hechos
// de entrada); recon scratchpad RRHH §3.8.
//
// Tres lectores, uno por fuente, todos de SOLO lectura y acotados a los centros
// que la capa de servicio ya filtró por ámbito:
//
//   · loadLaborLedgerRows — el diario por (centro, mes, cuenta, centro de coste):
//     journal_lines ⋈ journal_entries ⋈ accounts LEFT JOIN cost_centers con la
//     MISMA regla de lectura que los estados financieros (source.ts:432 ·
//     `je.status <> 'draft' AND je.reversed_by_id IS NULL AND je.reversal_of_id
//     IS NULL`, sin regularización / cierre / apertura). Trae las cuentas 64x
//     (personal) y todo el grupo 7 (ventas 70x y el ingreso por departamento del
//     USALI). Cada fila dice si el asiento vino del lote de coste de personal
//     (`source_type = payroll_cost_import`): esas líneas se cuentan por el lote
//     (`loadPostedPayrollImports`), nunca dos veces.
//   · loadPostedPayrollImports — líneas y referencias de los lotes `posted`
//     (payroll_cost_lines / payroll_cost_references; cost-report.service.ts:478):
//     coste por departamento USALI, headcount y ventas de referencia.
//   · loadRoomNightsByMonth — habitaciones ocupadas reales por mes con el motor
//     de `getRealizedByDay` (revenue/actuals.ts:399, `realizeDays`) pero SIN los
//     snapshots `demo` (R §2: RA los tiene desde 2025-05 y no son cierres): días
//     con cierre / importación PMS (`night_audit`, `pms_import:*`) y, como reserva,
//     las estancias reales del PMS. Sin ningún día real → `roomNights` null (nunca 0).
//
// Este fichero no toca financial-statements/source.ts (R §2): el SQL es propio,
// con agrupación por mes, que `accountBalances` no ofrece.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import { addDays, dayUtc, isoDate, realizeDays, REALIZED_RESERVATION_SELECT, REALIZED_STATUS_FILTER, SNAPSHOT_SELECT, TOP_LEVEL_SNAPSHOT_WHERE } from "../revenue/actuals.js";
import type { Db } from "../treasury/ledger-bridge.js";
import { daysInMonth, PAYROLL_COST_SOURCE_TYPE } from "./cost-import.posting.js";

/** Cuentas de personal del PGC (640 sueldos, 641 indemnizaciones, 642 SS empresa, 649 otros gastos sociales). */
export const LABOR_ACCOUNT_PREFIX = "64";
/** Ventas del libro: grupo 70 (haber − debe), como el informe de coste (cost-report.service.ts loadLedgerSales). */
export const SALES_ACCOUNT_PREFIX = "70";
/** `revenue_daily_snapshots.data_source` de la demo: nunca cuenta como habitación ocupada real. */
export const DEMO_SNAPSHOT_SOURCE = "demo";

// ---------------------------------------------------------------------------
// Diario
// ---------------------------------------------------------------------------

export type LaborLedgerRow = {
  propertyId: string;
  /** Mes contable "YYYY-MM" de `entry_date`. */
  periodCode: string;
  accountCode: string;
  accountName: string;
  /** `accounts.kind::text` (income · expense · asset…). */
  accountKind: string;
  isPostable: boolean;
  usaliDepartment: string | null;
  usaliLine: string | null;
  /** Centro de coste de las líneas sumadas (tipo + código); null para las líneas sin centro. */
  costCentre: { type: string; code: string } | null;
  /** true = asiento del lote de coste de personal contabilizado: su 64x se cuenta por el lote, no por el diario. */
  fromPayrollImport: boolean;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  /** Asientos distintos que aportan a la fila. */
  entries: number;
};

type RawLedgerRow = {
  property_id: string | null;
  period_code: string;
  account_code: string;
  account_name: string;
  account_kind: string;
  is_postable: boolean;
  usali_department: string | null;
  usali_line: string | null;
  cost_centre_type: string | null;
  cost_centre_code: string | null;
  source_type: string;
  debit: Prisma.Decimal | string | number | null;
  credit: Prisma.Decimal | string | number | null;
  entries: bigint | number | string;
};

const D = (value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal => new Prisma.Decimal(value ?? 0);

/** Primer y último día (UTC, "YYYY-MM-DD") de un rango de meses "YYYY-MM" ordenado. */
export function monthRangeBounds(months: readonly string[]): { from: string; to: string } | null {
  if (months.length === 0) return null;
  const first = months[0]!;
  const last = months[months.length - 1]!;
  return { from: `${first}-01`, to: `${last}-${String(daysInMonth(last)).padStart(2, "0")}` };
}

/** Regla de lectura del libro sobre el alias `je` (espejo de LEDGER_ENTRY_COUNTS_SQL, financial-statements/source.ts:432) + solo movimientos. */
const LEDGER_MOVEMENTS_SQL = Prisma.sql`je.status <> 'draft' AND je.reversed_by_id IS NULL AND je.reversal_of_id IS NULL AND je.entry_kind NOT IN ('regularization', 'closing', 'opening')`;

/**
 * Filas del diario por (centro, mes, cuenta, centro de coste, source_type) para
 * las cuentas 64x y el grupo 7 de los centros y meses pedidos. Una consulta; el
 * agrupado por `source_type` (columna, no expresión con parámetro: Postgres no
 * empareja dos placeholders) es lo que permite apartar los asientos del lote.
 */
export async function loadLaborLedgerRows(db: Db, organizationId: string, propertyIds: readonly string[], months: readonly string[]): Promise<LaborLedgerRow[]> {
  const bounds = monthRangeBounds(months);
  if (!bounds || propertyIds.length === 0) return [];
  const rows = await db.$queryRaw<RawLedgerRow[]>(Prisma.sql`
    SELECT je.property_id AS property_id,
           to_char(je.entry_date, 'YYYY-MM') AS period_code,
           a.code AS account_code, a.name AS account_name, a.kind::text AS account_kind, a.is_postable,
           a.usali_department, a.usali_line,
           cc.type AS cost_centre_type, cc.code AS cost_centre_code,
           je.source_type AS source_type,
           COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit,
           COUNT(DISTINCT je.id) AS entries
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id
    WHERE je.organization_id = ${organizationId}
      AND ${LEDGER_MOVEMENTS_SQL}
      AND je.entry_date >= ${bounds.from}::date AND je.entry_date <= ${bounds.to}::date
      AND je.property_id IN (${Prisma.join([...propertyIds])})
      AND (a.pgc_group = 7 OR a.code LIKE ${`${LABOR_ACCOUNT_PREFIX}%`})
    GROUP BY je.property_id, to_char(je.entry_date, 'YYYY-MM'), a.code, a.name, a.kind, a.is_postable, a.usali_department, a.usali_line,
             cc.type, cc.code, je.source_type
    ORDER BY je.property_id, period_code, a.code, cost_centre_code NULLS FIRST`);
  return rows
    .filter((row): row is RawLedgerRow & { property_id: string } => typeof row.property_id === "string")
    .map((row) => ({
      propertyId: row.property_id,
      periodCode: row.period_code,
      accountCode: row.account_code,
      accountName: row.account_name,
      accountKind: row.account_kind,
      isPostable: row.is_postable,
      usaliDepartment: row.usali_department,
      usaliLine: row.usali_line,
      costCentre: row.cost_centre_type && row.cost_centre_code ? { type: row.cost_centre_type, code: row.cost_centre_code } : null,
      fromPayrollImport: row.source_type === PAYROLL_COST_SOURCE_TYPE,
      debit: D(row.debit),
      credit: D(row.credit),
      entries: Number(row.entries)
    }));
}

/** Asientos DISTINTOS del diario que aportan líneas 64x / 70x en los centros y meses pedidos (para `sources.ledger.entries`). */
export async function countLaborLedgerEntries(db: Db, organizationId: string, propertyIds: readonly string[], months: readonly string[]): Promise<number> {
  const bounds = monthRangeBounds(months);
  if (!bounds || propertyIds.length === 0) return 0;
  const rows = await db.$queryRaw<Array<{ entries: bigint | number | string }>>(Prisma.sql`
    SELECT COUNT(DISTINCT je.id) AS entries
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.organization_id = ${organizationId}
      AND ${LEDGER_MOVEMENTS_SQL}
      AND je.entry_date >= ${bounds.from}::date AND je.entry_date <= ${bounds.to}::date
      AND je.property_id IN (${Prisma.join([...propertyIds])})
      AND (a.code LIKE ${`${LABOR_ACCOUNT_PREFIX}%`} OR a.code LIKE ${`${SALES_ACCOUNT_PREFIX}%`})`);
  return Number(rows[0]?.entries ?? 0);
}

// ---------------------------------------------------------------------------
// Lotes de coste de personal contabilizados
// ---------------------------------------------------------------------------

export type LaborImportLine = {
  importId: string;
  propertyId: string;
  periodCode: string;
  costGroup: string;
  usaliDepartment: string;
  gross: Prisma.Decimal;
  employerSs: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  headcount: Prisma.Decimal;
};

export type LaborImportReference = {
  propertyId: string;
  periodCode: string;
  employeesReported: Prisma.Decimal | null;
  roomsAvailableReported: number | null;
  netSalesReported: Prisma.Decimal | null;
  postedAt: Date | null;
};

export type LaborImportSummary = { importId: string; fileName: string | null; periodFrom: string; periodTo: string; postedAt: string | null };

/** Cota explícita de líneas (espejo de PAYROLL_COST_REPORT_MAX_LINES): ≤ 24 meses × centros × grupos × departamentos. */
export const LABOR_PANEL_MAX_IMPORT_LINES = 50_000;

/** Líneas, referencias y cabeceras de los lotes `posted` de los centros y meses pedidos. */
export async function loadPostedPayrollImports(db: Db, organizationId: string, propertyIds: readonly string[], months: readonly string[]): Promise<{ lines: LaborImportLine[]; references: LaborImportReference[]; imports: LaborImportSummary[] }> {
  if (propertyIds.length === 0 || months.length === 0) return { lines: [], references: [], imports: [] };
  const lineRows = await db.payrollCostLine.findMany({
    where: { organizationId, propertyId: { in: [...propertyIds] }, periodCode: { in: [...months] }, import: { status: "posted" } },
    select: { importId: true, propertyId: true, periodCode: true, costGroup: true, usaliDepartment: true, gross: true, employerSs: true, totalCost: true, headcount: true },
    take: LABOR_PANEL_MAX_IMPORT_LINES
  });
  const referenceRows = await db.payrollCostReference.findMany({
    where: { organizationId, propertyId: { in: [...propertyIds] }, periodCode: { in: [...months] }, import: { status: "posted" } },
    select: { propertyId: true, periodCode: true, employeesReported: true, roomsAvailableReported: true, netSalesReported: true, import: { select: { postedAt: true } } },
    take: Math.max(1, propertyIds.length * months.length)
  });
  const importIds = Array.from(new Set(lineRows.map((line) => line.importId)));
  const importRows = importIds.length
    ? await db.payrollCostImport.findMany({ where: { id: { in: importIds } }, select: { id: true, fileName: true, periodFrom: true, periodTo: true, postedAt: true }, orderBy: { postedAt: "asc" } })
    : [];
  return {
    lines: lineRows.map((line) => ({ ...line, gross: D(line.gross), employerSs: D(line.employerSs), totalCost: D(line.totalCost), headcount: D(line.headcount) })),
    references: referenceRows.map((reference) => ({
      propertyId: reference.propertyId,
      periodCode: reference.periodCode,
      employeesReported: reference.employeesReported === null ? null : D(reference.employeesReported),
      roomsAvailableReported: reference.roomsAvailableReported ?? null,
      netSalesReported: reference.netSalesReported === null ? null : D(reference.netSalesReported),
      postedAt: reference.import.postedAt
    })),
    imports: importRows.map((row) => ({ importId: row.id, fileName: row.fileName ?? null, periodFrom: row.periodFrom, periodTo: row.periodTo, postedAt: row.postedAt ? row.postedAt.toISOString() : null }))
  };
}

// ---------------------------------------------------------------------------
// Habitaciones ocupadas reales por mes (sin demo)
// ---------------------------------------------------------------------------

export type RoomNightsSource = "snapshot" | "night_audit" | "reservations" | "degraded";

export type RoomNightsMonth = {
  propertyId: string;
  periodCode: string;
  /** Σ habitaciones ocupadas de los días con dato real; null sin ningún día real (nunca 0). */
  roomNights: number | null;
  /** Días del mes ya realizados (≤ ayer). */
  realizedDays: number;
  /** Días con cierre o importación PMS (sin `demo`). */
  snapshotDays: number;
  /** Días sin cierre cubiertos por estancias reales del PMS. */
  fallbackDays: number;
  /** El dato no cubre todo el mes realizado (días sin cierre ni estancia, o mes en curso). */
  partial: boolean;
  source: RoomNightsSource;
};

/**
 * Habitaciones ocupadas por mes de un centro: dos consultas (snapshots de
 * primer nivel sin `demo`, estancias reales) + `realizeDays` por mes. Los días
 * de hoy en adelante nunca cuentan (futuro = OTB, no realizado).
 */
export async function loadRoomNightsByMonth(db: Db, propertyId: string, months: readonly string[], today: Date = new Date()): Promise<RoomNightsMonth[]> {
  const bounds = monthRangeBounds(months);
  if (!bounds) return [];
  const todayUtc = dayUtc(today);
  const yesterday = addDays(todayUtc, -1);
  const start = dayUtc(bounds.from);
  const requestedEnd = dayUtc(bounds.to);
  const end = requestedEnd.getTime() < yesterday.getTime() ? requestedEnd : yesterday;
  const nothingRealized = start.getTime() > end.getTime();
  const [totalRooms, snapshots, reservations] = nothingRealized
    ? [0, [], []]
    : await Promise.all([
        db.room.count({ where: { propertyId, sellable: true } }),
        db.revenueDailySnapshot.findMany({
          where: { propertyId, ...TOP_LEVEL_SNAPSHOT_WHERE, dataSource: { not: DEMO_SNAPSHOT_SOURCE }, snapshotDate: { gte: start, lte: end } },
          select: { ...SNAPSHOT_SELECT, dataSource: true }
        }),
        db.reservation.findMany({
          where: { propertyId, status: { in: REALIZED_STATUS_FILTER }, arrivalDate: { lte: end }, departureDate: { gte: start } },
          select: REALIZED_RESERVATION_SELECT
        })
      ]);
  const sourceByDay = new Map<string, string>();
  for (const snapshot of snapshots) sourceByDay.set(isoDate(dayUtc(snapshot.snapshotDate)), snapshot.dataSource);

  return months.map((periodCode) => {
    const monthStart = dayUtc(`${periodCode}-01`);
    const monthEnd = dayUtc(`${periodCode}-${String(daysInMonth(periodCode)).padStart(2, "0")}`);
    const window = realizeDays({ from: monthStart, to: monthEnd, today: todayUtc, totalRooms, snapshots, reservations });
    let snapshotRooms = 0;
    let fallbackRooms = 0;
    let nightAudits = 0;
    for (const [day, realized] of window.days) {
      if (realized.source === "snapshot") {
        snapshotRooms += realized.rooms;
        if ((sourceByDay.get(day) ?? "").startsWith("night_audit")) nightAudits += 1;
      } else {
        fallbackRooms += realized.rooms;
      }
    }
    const realizedDays = window.days.size;
    const hasReal = window.snapshotDays > 0 || fallbackRooms > 0;
    const monthDays = daysInMonth(periodCode);
    const source: RoomNightsSource = window.snapshotDays > 0 ? (nightAudits === window.snapshotDays ? "night_audit" : "snapshot") : fallbackRooms > 0 ? "reservations" : "degraded";
    return {
      propertyId,
      periodCode,
      roomNights: hasReal ? snapshotRooms + fallbackRooms : null,
      realizedDays,
      snapshotDays: window.snapshotDays,
      fallbackDays: window.fallbackDays,
      partial: hasReal && (realizedDays < monthDays || (window.snapshotDays > 0 && window.fallbackDays > 0 && fallbackRooms === 0)),
      source
    };
  });
}

/** Cliente por defecto de los lectores (el servicio admite otro para los tests). */
export const defaultLaborPanelDb: Db = prisma;
