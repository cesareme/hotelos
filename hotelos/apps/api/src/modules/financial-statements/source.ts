// Data source of the financial-statements module (Finanzas · lote
// usali-cuentas). Every statement (USALI, balance, PyG, ECPN, memoria,
// exportación) reads the ledger through this ONE interface so the
// computations are pure functions over its rows: the unit tests run on an
// in-memory implementation; the Prisma implementation below aggregates in SQL
// (hallazgo 141: no full-table reads for aggregates).
//
// Period semantics (docs/runbooks/finanzas-contabilidad.md §1.3): everything
// is filtered by `entry_date` (fecha contable), never by postedAt. Which
// entries count is ONE rule, `ledgerEntryCounts` below (hallazgo t6#2): every
// booked entry (`posted` or `reversed`, never `draft`) that is not half of a
// marked reversal pair — a reversed original and its reversal net to zero, so
// leaving both out is the same as adding both, whereas `status = 'posted'`
// dropped the original and kept the reversal (every annulled invoice,
// recalculated payroll or reopened close was subtracted twice). It is the
// criterion of accounting.service.aggregateAccountBalances, so the PyG equals
// the regularization of the year-end close and the trial balance. The diario
// export (`journalLines`) is the other way round: the libro diario keeps both
// halves (an annulment is an operation of the book; nothing is ever deleted).
// Two read modes:
//   · balance_at(to): cumulative balances up to and including `to`, EXCLUDING
//     the closing entries dated exactly `to` (the year-end closing zeroes every
//     account; the balance «a 31/12» is the pre-closing one). A closing dated
//     before `to` stays in (its opening on the following day restores the
//     balances), so a balance at any later date is right too.
//   · movements(from, to): movements inside [from, to] EXCLUDING
//     regularization / closing / opening entries (they would zero the P&L or
//     double the opening balances of the year).

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type { FinanceEntityBadge, FinanceWorkCentre } from "../../../../../packages/shared/src/financial-statements-types.js";
import type { LegalIdentityDto, PropertyKind } from "@hotelos/shared";
import { resolveLegalIdentity } from "../../lib/finance-scope.js";
import type { AccountKind } from "../accounting/chart-of-accounts.service.js";
import { kindFromLegacyType } from "../accounting/chart-of-accounts.service.js";
import { toDec, type Dec } from "./money.js";

export type LedgerMode = "balance_at" | "movements";

export type LedgerQuery = {
  organizationId: string;
  propertyId?: string | null;
  /**
   * Tanda 6b: only the entries booked WITHOUT a work centre (society-level:
   * settlement, close, manual `societyLevel`) — the «Sin asignar» column of
   * USALI / PyG por centro. Ignored when `propertyId` is set.
   */
  unassignedOnly?: boolean;
  mode: LedgerMode;
  /** Required for `movements`; ignored for `balance_at`. */
  from?: string | null;
  to: string;
  /** Restrict to PGC groups (first digit). */
  groups?: number[];
  /**
   * Tanda 6c: also partition every account by the cost centre of its lines
   * (`cost_centers.type` / `code` — never by id: the consolidated statement
   * merges RA/ROOMS and LT/ROOMS). Only the USALI reader asks for it; every
   * other statement indexes its rows by account code and keeps the plain
   * query, whose SQL does not change.
   */
  byCostCentre?: boolean;
};

/** Cost centre of a partitioned balance row (Tanda 6c): `type` (`usali` · `operating` · `cost`) and `code` (ROOMS, FNB…). */
export type CostCentreRef = { type: string; code: string };

export type AccountBalanceRow = {
  code: string;
  name: string;
  kind: AccountKind;
  isPostable: boolean;
  usaliDepartment: string | null;
  usaliLine: string | null;
  debit: Dec;
  credit: Dec;
  /**
   * Tanda 6c: present only in `byCostCentre` queries — the cost centre of the
   * lines summed in this row, null for the lines booked without one. The rows
   * of one account add up exactly to its plain balance.
   */
  costCentre?: CostCentreRef | null;
};

/** Sort order of the balance rows: account code, then the row without cost centre first, then cost-centre code (the SQL `ORDER BY a.code, cost_centre_code NULLS FIRST`). */
export function compareAccountBalanceRows(a: Pick<AccountBalanceRow, "code" | "costCentre">, b: Pick<AccountBalanceRow, "code" | "costCentre">): number {
  if (a.code !== b.code) return a.code.localeCompare(b.code);
  if (!a.costCentre || !b.costCentre) return Number(Boolean(a.costCentre)) - Number(Boolean(b.costCentre));
  return a.costCentre.code.localeCompare(b.costCentre.code) || a.costCentre.type.localeCompare(b.costCentre.type);
}

export type ChartAccountLite = {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  group: number;
  isPostable: boolean;
  usaliDepartment: string | null;
  usaliLine: string | null;
};

export type UsaliMappingSourceRow = {
  id: string;
  organizationId: string;
  accountPrefix: string;
  usaliDepartment: string;
  usaliLine: string;
  priority: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A work centre as the statements see it (Tanda 6b): `kind` tells hotel /
 * office / other, `code` and `tradeName` label the columns. The deprecated
 * `Property.legalName` is NOT read: the razón social is the legal entity's.
 */
export type PropertyLite = {
  id: string;
  organizationId: string;
  legalEntityId: string | null;
  name: string;
  code: string | null;
  tradeName: string | null;
  kind: PropertyKind;
  address: string | null;
  municipality: string | null;
  province: string | null;
  currency: string;
};

export type OccupancyFacts = {
  /** Active rooms of the properties. */
  roomsInventory: number;
  /** Room-nights of reservations checked_in / checked_out overlapping the period. */
  roomsOccupied: number;
};

/** Where a headcount comes from: distinct staff with a payslip, or the monthly average of the posted payroll-cost imports (Tanda 6c). */
export type HeadcountSource = "payroll_slips" | "payroll_cost_import";

/**
 * Headcount per work centre (`propertyId` null = payroll periods without
 * centre): distinct staff with a payslip in the window or, when no payslip
 * exists, the average monthly headcount of the posted payroll-cost imports
 * (`source` says which; absent = payslips, the pre-6c rows).
 */
export type HeadcountByProperty = Array<{ propertyId: string | null; headcount: number; source?: HeadcountSource }>;

export type FixedAssetLite = {
  id: string;
  name: string;
  category: string | null;
  accountCode: string | null;
  acquisitionDate: string | null;
  acquisitionCost: Dec;
  accumulatedDepreciation: Dec;
  residualValue: Dec;
  coefficientPct: Dec | null;
  status: string;
};

export type VatTotalsRow = { book: string; rate: Dec; base: Dec; quota: Dec; total: Dec; retention: Dec; count: number };

export type JournalLineExportRow = {
  entryId: string;
  entryDate: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  sourceType: string;
  sourceId: string | null;
  description: string | null;
  reference: string | null;
  propertyId: string | null;
  lineId: string;
  accountCode: string;
  accountName: string;
  lineDescription: string | null;
  debit: Dec;
  credit: Dec;
  taxRateCode: string | null;
  taxBase: Dec | null;
};

export type DocumentRef = { number: string | null; nif: string | null; name: string | null };

export type VatBookExportRow = {
  book: string;
  date: string;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  base: Dec;
  rate: Dec;
  quota: Dec;
  total: Dec;
  retention: Dec;
  taxFigure: string;
  surchargeRate: Dec | null;
  surchargeQuota: Dec | null;
  sourceType: string;
  sourceId: string;
  period: string;
  deductible: boolean;
};

export interface FinancialStatementsSource {
  accountBalances(query: LedgerQuery): Promise<AccountBalanceRow[]>;
  /** Postable P&L accounts (groups 6-7) of the organisation. */
  plAccounts(organizationId: string): Promise<ChartAccountLite[]>;
  usaliMappings(organizationId: string): Promise<UsaliMappingSourceRow[]>;
  properties(organizationId: string): Promise<PropertyLite[]>;
  occupancy(propertyIds: string[], from: string, to: string): Promise<OccupancyFacts>;
  /**
   * The sociedad of the organisation (`resolveLegalIdentity`, lib/finance-scope.ts):
   * the ONLY reader of the razón social / NIF for the statements. Null when
   * the organisation does not exist.
   */
  legalIdentity(organizationId: string): Promise<LegalIdentityDto | null>;
  fixedAssets(organizationId: string, propertyId?: string | null): Promise<FixedAssetLite[]>;
  vatTotals(organizationId: string, from: string, to: string): Promise<VatTotalsRow[]>;
  headcount(organizationId: string, from: string, to: string): Promise<number | null>;
  /** Headcount per work centre for the `headcount` allocation key (Tanda 6b · R5). */
  headcountByProperty(organizationId: string, from: string, to: string): Promise<HeadcountByProperty>;
  /**
   * Raw `AccountingSetting.configurationJson` of the organisation-level row
   * (null when absent). allocation.service.ts parses `corporateAllocation` out
   * of it; the source stays a plain reader.
   */
  accountingConfiguration(organizationId: string): Promise<unknown>;
  journalLines(query: { organizationId: string; propertyId?: string | null; from: string; to: string }): AsyncIterable<JournalLineExportRow[]>;
  documentRefs(kind: "invoice" | "supplier_bill" | "expense", ids: string[]): Promise<Map<string, DocumentRef>>;
  vatBookEntries(query: { organizationId: string; propertyId?: string | null; from: string; to: string }): Promise<VatBookExportRow[]>;
}

// ---------------------------------------------------------------------------
// Date helpers (calendar days, UTC)
// ---------------------------------------------------------------------------

export function dayUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = dayUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

/** Calendar days from `from` to `to`, both inclusive. */
export function nightsBetween(from: string, to: string): number {
  return Math.round((dayUtc(to).getTime() - dayUtc(from).getTime()) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Work centres (Tanda 6b): hotels vs corporate centres
// ---------------------------------------------------------------------------

/** `hotel` centres run the operation; `office` / `other` are the corporate («Oficina central») centres. */
export function isHotelCentre(property: Pick<PropertyLite, "kind">): boolean {
  return property.kind === "hotel";
}

/** Stable presentation order: hotels by name, then office / other by name. */
export function sortWorkCentres<T extends Pick<PropertyLite, "kind" | "name">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(!isHotelCentre(a)) - Number(!isHotelCentre(b)) || a.name.localeCompare(b.name, "es"));
}

/** Spanish labels of the work-centre kinds (runtime constant kept in the API: the shared package is types-only). */
export const WORK_CENTRE_KIND_LABELS_ES: Record<PropertyKind, string> = { hotel: "Hotel", office: "Oficina", other: "Otro" };

/** Wire view of a work centre for the statements. */
export function toWorkCentre(property: PropertyLite): FinanceWorkCentre {
  return { propertyId: property.id, code: property.code, name: property.name, tradeName: property.tradeName, kind: property.kind };
}

/**
 * The sociedad badge of a statement. A missing identity (organisation row
 * absent: contexts assembled outside Prisma) renders «Sociedad pendiente»
 * with the default regime instead of failing the whole statement.
 */
export function entityBadgeOf(identity: LegalIdentityDto | null): FinanceEntityBadge {
  if (!identity) {
    return { legalEntityId: null, code: null, legalName: "Sociedad pendiente", taxId: null, taxIdValid: false, legalForm: null, source: "organization_fallback", pgcVariant: "pymes", largeCompany: false, siiEnabled: false };
  }
  return {
    legalEntityId: identity.legalEntityId,
    code: identity.code,
    legalName: identity.legalName,
    taxId: identity.taxId,
    taxIdValid: identity.taxIdValid,
    legalForm: identity.legalForm,
    source: identity.source,
    pgcVariant: identity.pgcVariant,
    largeCompany: identity.largeCompany,
    siiEnabled: identity.siiEnabled
  };
}

/** «<razón social> · NIF <nif>» (or «NIF pendiente») — the header of every rendered statement. */
export function entityLabelOf(entity: Pick<FinanceEntityBadge, "legalName" | "taxId">): string {
  return `${entity.legalName} · ${entity.taxId ? `NIF ${entity.taxId}` : "NIF pendiente"}`;
}

// ---------------------------------------------------------------------------
// Headcount (Tanda 6c): payslips first, imported payroll cost as fallback
// ---------------------------------------------------------------------------

/**
 * Average of the monthly headcounts that HAVE a figure: 10 and 12 → 11. Two
 * decimals, half-up; null when no month has data (never 0: the memoria and
 * the allocation warning distinguish «sin datos» from «cero empleados»).
 */
export function averageMonthlyHeadcount(monthly: readonly Prisma.Decimal.Value[]): number | null {
  if (monthly.length === 0) return null;
  let total = new Prisma.Decimal(0);
  for (const value of monthly) total = total.plus(value);
  return total.div(monthly.length).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

const MONTH_CODE = /^\d{4}-\d{2}$/;

/** Payroll periods of the organisation whose "YYYY-MM" code falls in [fromMonth, toMonth] (anything else is skipped). */
async function payrollPeriodsIn(organizationId: string, fromMonth: string, toMonth: string): Promise<Array<{ id: string; periodCode: string; propertyId: string | null }>> {
  const periods = await prisma.payrollPeriod.findMany({ where: { organizationId }, select: { id: true, periodCode: true, propertyId: true } });
  return periods.filter((p) => MONTH_CODE.test(p.periodCode) && p.periodCode >= fromMonth && p.periodCode <= toMonth);
}

/**
 * Fallback of `headcount` / `headcountByProperty` when no payslip exists:
 * the posted payroll-cost imports (`payroll_cost_import`, Tanda 6c). For
 * every (centre, month) the `employeesReported` of the report's reference
 * wins — Σ headcount of the cells over-counts a person that appears in two
 * groups —, else Σ `PayrollCostLine.headcount` of the cells; then the
 * average of the months WITH data per centre (`averageMonthlyHeadcount`).
 * Empty when nothing posted covers the window (never 0). Drafts and
 * reversed imports never count.
 */
async function importedHeadcountByProperty(organizationId: string, fromMonth: string, toMonth: string): Promise<HeadcountByProperty> {
  const imports = await prisma.payrollCostImport.findMany({ where: { organizationId, status: "posted" }, select: { id: true }, orderBy: [{ postedAt: "asc" }, { id: "asc" }] });
  if (imports.length === 0) return [];
  const importIds = imports.map((row) => row.id);
  const periodCode = { gte: fromMonth, lte: toMonth };
  const [cells, references] = await Promise.all([
    prisma.payrollCostLine.groupBy({ by: ["propertyId", "periodCode"], where: { organizationId, importId: { in: importIds }, periodCode }, _sum: { headcount: true } }),
    prisma.payrollCostReference.findMany({
      where: { organizationId, importId: { in: importIds }, periodCode, employeesReported: { not: null } },
      select: { importId: true, propertyId: true, periodCode: true, employeesReported: true }
    })
  ]);
  const monthsByProperty = new Map<string, Map<string, Prisma.Decimal>>();
  const monthsOf = (propertyId: string): Map<string, Prisma.Decimal> => {
    let months = monthsByProperty.get(propertyId);
    if (!months) {
      months = new Map<string, Prisma.Decimal>();
      monthsByProperty.set(propertyId, months);
    }
    return months;
  };
  for (const cell of cells) monthsOf(cell.propertyId).set(cell.periodCode, toDec(cell._sum.headcount));
  // The reference of the last posted import wins (same rule as the cost report).
  const rank = new Map(importIds.map((id, index) => [id, index]));
  references.sort((a, b) => (rank.get(a.importId) ?? 0) - (rank.get(b.importId) ?? 0));
  for (const reference of references) {
    if (reference.employeesReported === null) continue;
    monthsOf(reference.propertyId).set(reference.periodCode, toDec(reference.employeesReported));
  }
  const rows: HeadcountByProperty = [];
  for (const [propertyId, months] of monthsByProperty) {
    const average = averageMonthlyHeadcount(Array.from(months.values()));
    if (average !== null) rows.push({ propertyId, headcount: average, source: "payroll_cost_import" });
  }
  return rows.sort((a, b) => (a.propertyId ?? "").localeCompare(b.propertyId ?? ""));
}

// ---------------------------------------------------------------------------
// Prisma implementation
// ---------------------------------------------------------------------------

type RawBalanceRow = {
  code: string;
  name: string;
  kind: string;
  account_type: string;
  is_postable: boolean;
  usali_department: string | null;
  usali_line: string | null;
  debit: Prisma.Decimal | string | number | null;
  credit: Prisma.Decimal | string | number | null;
  /** Only in the `byCostCentre` query (LEFT JOIN cost_centers): both null for the lines without cost centre. */
  cost_centre_type?: string | null;
  cost_centre_code?: string | null;
};

/**
 * Whether a journal entry counts in the statements (balance, PyG, ECPN,
 * USALI): booked (`posted` / `reversed`, never `draft`) and not half of a
 * marked reversal pair. Shared by the SQL reader (`ledgerWhere`) and the
 * in-memory source of the unit tests so both implement the same rule.
 */
export function ledgerEntryCounts(entry: { status: string; reversedById: string | null; reversalOfId: string | null }): boolean {
  return entry.status !== "draft" && entry.reversedById === null && entry.reversalOfId === null;
}

/** Whether a journal entry belongs to the libro diario (every booked entry, both halves of a reversal pair). */
export function ledgerEntryIsBooked(entry: { status: string }): boolean {
  return entry.status !== "draft";
}

/** SQL form of `ledgerEntryCounts` over the `je` alias — keep both in sync. */
const LEDGER_ENTRY_COUNTS_SQL = Prisma.sql`je.status <> 'draft' AND je.reversed_by_id IS NULL AND je.reversal_of_id IS NULL`;

function ledgerWhere(query: LedgerQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`je.organization_id = ${query.organizationId}`, LEDGER_ENTRY_COUNTS_SQL];
  if (query.propertyId) conditions.push(Prisma.sql`je.property_id = ${query.propertyId}`);
  else if (query.unassignedOnly) conditions.push(Prisma.sql`je.property_id IS NULL`);
  if (query.mode === "balance_at") {
    conditions.push(Prisma.sql`je.entry_date <= ${query.to}::date`);
    conditions.push(Prisma.sql`NOT (je.entry_kind = 'closing' AND je.entry_date = ${query.to}::date)`);
  } else {
    if (!query.from) throw new Error("movements query requires from");
    conditions.push(Prisma.sql`je.entry_date >= ${query.from}::date`);
    conditions.push(Prisma.sql`je.entry_date <= ${query.to}::date`);
    conditions.push(Prisma.sql`je.entry_kind NOT IN ('regularization', 'closing', 'opening')`);
  }
  if (query.groups && query.groups.length > 0) {
    conditions.push(Prisma.sql`a.pgc_group IN (${Prisma.join(query.groups)})`);
  }
  return Prisma.join(conditions, " AND ");
}

/** Prisma client (or interactive-transaction client) the SQL source reads through. */
export type FinancialStatementsClient = Prisma.TransactionClient;

/**
 * SQL implementation over `client` (corrector L3 · Puerta 9 / structure-l5):
 * built on the shared client for the routes and on an interactive
 * transaction by `withFinancialStatementsSnapshot`, so the reads of ONE
 * statement see ONE snapshot (REPEATABLE READ) — a journal entry committed
 * by another request between the per-property and the entity-wide reads
 * used to break the reconciliation (`rowsOff`) of the PyG por centro.
 */
export function buildPrismaFinancialStatementsSource(client: FinancialStatementsClient): FinancialStatementsSource {
  return {
    async accountBalances(query) {
      if (query.byCostCentre) {
        // Tanda 6c: one row per (account, cost centre type, cost centre code); the rows of an account add up to its plain balance.
        const rows = await client.$queryRaw<RawBalanceRow[]>(Prisma.sql`
          SELECT a.code, a.name, a.kind::text AS kind, a.account_type, a.is_postable, a.usali_department, a.usali_line,
                 cc.type AS cost_centre_type, cc.code AS cost_centre_code,
                 COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.journal_entry_id
          JOIN accounts a ON a.id = jl.account_id
          LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id
          WHERE ${ledgerWhere(query)}
          GROUP BY a.code, a.name, a.kind, a.account_type, a.is_postable, a.usali_department, a.usali_line, cc.type, cc.code
          ORDER BY a.code, cost_centre_code NULLS FIRST`);
        return rows.map((row) => ({
          code: row.code,
          name: row.name,
          kind: (row.kind as AccountKind) ?? kindFromLegacyType(row.account_type),
          isPostable: row.is_postable,
          usaliDepartment: row.usali_department,
          usaliLine: row.usali_line,
          debit: toDec(row.debit),
          credit: toDec(row.credit),
          costCentre: row.cost_centre_type && row.cost_centre_code ? { type: row.cost_centre_type, code: row.cost_centre_code } : null
        }));
      }
      const rows = await client.$queryRaw<RawBalanceRow[]>(Prisma.sql`
        SELECT a.code, a.name, a.kind::text AS kind, a.account_type, a.is_postable, a.usali_department, a.usali_line,
               COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE ${ledgerWhere(query)}
        GROUP BY a.code, a.name, a.kind, a.account_type, a.is_postable, a.usali_department, a.usali_line
        ORDER BY a.code`);
      return rows.map((row) => ({
        code: row.code,
        name: row.name,
        kind: (row.kind as AccountKind) ?? kindFromLegacyType(row.account_type),
        isPostable: row.is_postable,
        usaliDepartment: row.usali_department,
        usaliLine: row.usali_line,
        debit: toDec(row.debit),
        credit: toDec(row.credit)
      }));
    },

    async plAccounts(organizationId) {
      const rows = await client.account.findMany({
        where: { organizationId, group: { in: [6, 7] }, isPostable: true },
        select: { id: true, code: true, name: true, kind: true, group: true, isPostable: true, usaliDepartment: true, usaliLine: true },
        orderBy: { code: "asc" }
      });
      return rows.map((row) => ({ ...row, kind: row.kind as AccountKind }));
    },

    async usaliMappings(organizationId) {
      return client.usaliMapping.findMany({ where: { organizationId }, orderBy: [{ priority: "desc" }, { accountPrefix: "asc" }] });
    },

    async properties(organizationId) {
      // Hotels first (by name), then office / other centres: the column order of every per-centre statement.
      const rows = await client.property.findMany({
        where: { organizationId },
        select: { id: true, organizationId: true, legalEntityId: true, name: true, code: true, tradeName: true, kind: true, address: true, municipality: true, province: true, currency: true },
        orderBy: { name: "asc" }
      });
      return sortWorkCentres(rows);
    },

    async occupancy(propertyIds, from, to) {
      if (propertyIds.length === 0) return { roomsInventory: 0, roomsOccupied: 0 };
      const roomsInventory = await client.room.count({ where: { propertyId: { in: propertyIds }, active: true } });
      const windowStart = dayUtc(from);
      const windowEnd = dayUtc(addDays(to, 1)); // exclusive
      const reservations = await client.reservation.findMany({
        where: {
          propertyId: { in: propertyIds },
          status: { in: ["checked_in", "checked_out"] },
          arrivalDate: { lt: windowEnd },
          departureDate: { gt: windowStart }
        },
        select: { arrivalDate: true, departureDate: true, roomsCount: true }
      });
      let roomsOccupied = 0;
      for (const reservation of reservations) {
        const start = Math.max(reservation.arrivalDate.getTime(), windowStart.getTime());
        const end = Math.min(reservation.departureDate.getTime(), windowEnd.getTime());
        const nights = Math.max(0, Math.round((end - start) / 86_400_000));
        roomsOccupied += nights * Math.max(1, reservation.roomsCount ?? 1);
      }
      return { roomsInventory, roomsOccupied };
    },

    async legalIdentity(organizationId) {
      return resolveLegalIdentity(organizationId);
    },

    async fixedAssets(organizationId, propertyId) {
      const rows = await client.fixedAsset.findMany({
        where: { organizationId, ...(propertyId ? { propertyId } : {}) },
        select: {
          id: true,
          name: true,
          category: true,
          accountCode: true,
          acquisitionDate: true,
          acquisitionCost: true,
          accumulatedDepreciation: true,
          residualValue: true,
          coefficientPct: true,
          status: true
        },
        orderBy: { name: "asc" }
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        accountCode: row.accountCode,
        acquisitionDate: row.acquisitionDate ? isoDay(row.acquisitionDate) : null,
        acquisitionCost: toDec(row.acquisitionCost),
        accumulatedDepreciation: toDec(row.accumulatedDepreciation),
        residualValue: toDec(row.residualValue),
        coefficientPct: row.coefficientPct === null ? null : toDec(row.coefficientPct),
        status: String(row.status)
      }));
    },

    async vatTotals(organizationId, from, to) {
      const rows = await client.vatBookEntry.groupBy({
        by: ["book", "rate"],
        where: { organizationId, date: { gte: dayUtc(from), lte: dayUtc(to) } },
        _sum: { base: true, quota: true, total: true, retention: true },
        _count: { _all: true }
      });
      return rows.map((row) => ({
        book: String(row.book),
        rate: toDec(row.rate),
        base: toDec(row._sum.base),
        quota: toDec(row._sum.quota),
        total: toDec(row._sum.total),
        retention: toDec(row._sum.retention),
        count: row._count._all
      }));
    },

    async headcount(organizationId, from, to) {
      // PayrollPeriod.periodCode is "YYYY-MM" for the monthly runs; anything else is skipped (null = unknown, never 0).
      const fromMonth = from.slice(0, 7);
      const toMonth = to.slice(0, 7);
      const ids = (await payrollPeriodsIn(organizationId, fromMonth, toMonth)).map((p) => p.id);
      if (ids.length > 0) {
        const slips = await client.payrollSlip.findMany({ where: { periodId: { in: ids } }, select: { staffProfileId: true }, distinct: ["staffProfileId"] });
        if (slips.length > 0) return slips.length;
      }
      // Tanda 6c: no payslip → the posted payroll-cost imports (Σ of the per-centre monthly averages, whole people).
      const imported = await importedHeadcountByProperty(organizationId, fromMonth, toMonth);
      if (imported.length === 0) return null;
      let total = new Prisma.Decimal(0);
      for (const row of imported) total = total.plus(row.headcount);
      const rounded = total.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
      return rounded > 0 ? rounded : null;
    },

    async headcountByProperty(organizationId, from, to) {
      const fromMonth = from.slice(0, 7);
      const toMonth = to.slice(0, 7);
      const periods = await payrollPeriodsIn(organizationId, fromMonth, toMonth);
      if (periods.length > 0) {
        const slips = await client.payrollSlip.findMany({ where: { periodId: { in: periods.map((p) => p.id) } }, select: { periodId: true, staffProfileId: true } });
        const propertyOfPeriod = new Map(periods.map((p) => [p.id, p.propertyId]));
        const staffByProperty = new Map<string | null, Set<string>>();
        for (const slip of slips) {
          const propertyId = propertyOfPeriod.get(slip.periodId) ?? null;
          const set = staffByProperty.get(propertyId) ?? new Set<string>();
          set.add(slip.staffProfileId);
          staffByProperty.set(propertyId, set);
        }
        if (staffByProperty.size > 0) return Array.from(staffByProperty.entries()).map(([propertyId, staff]) => ({ propertyId, headcount: staff.size, source: "payroll_slips" as const }));
      }
      // Tanda 6c: no payslip → the posted payroll-cost imports (average of the months with data per centre).
      return importedHeadcountByProperty(organizationId, fromMonth, toMonth);
    },

    async accountingConfiguration(organizationId) {
      const setting = await client.accountingSetting.findFirst({ where: { organizationId, propertyId: null }, orderBy: { updatedAt: "asc" }, select: { configurationJson: true } });
      return setting?.configurationJson ?? null;
    },

    async *journalLines(query) {
      const pageSize = 500;
      let cursor: string | null = null;
      for (;;) {
        const entries: Array<{
          id: string;
          entryDate: Date;
          entryNumber: number | null;
          fiscalYearCode: string | null;
          sourceType: string;
          sourceId: string | null;
          description: string | null;
          reference: string | null;
          propertyId: string | null;
        }> = await client.journalEntry.findMany({
          where: {
            organizationId: query.organizationId,
            // Libro diario: reversed originals AND their reversals are exported (`ledgerEntryIsBooked`).
            status: { not: "draft" },
            entryDate: { gte: dayUtc(query.from), lte: dayUtc(query.to) },
            ...(query.propertyId ? { propertyId: query.propertyId } : {})
          },
          select: {
            id: true,
            entryDate: true,
            entryNumber: true,
            fiscalYearCode: true,
            sourceType: true,
            sourceId: true,
            description: true,
            reference: true,
            propertyId: true
          },
          orderBy: [{ entryDate: "asc" }, { entryNumber: "asc" }, { id: "asc" }],
          take: pageSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        if (entries.length === 0) return;
        const lines = await client.journalLine.findMany({
          where: { journalEntryId: { in: entries.map((e) => e.id) } },
          orderBy: [{ journalEntryId: "asc" }, { id: "asc" }]
        });
        const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
        const accounts = accountIds.length
          ? await client.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true, name: true } })
          : [];
        const accountById = new Map(accounts.map((a) => [a.id, a]));
        const linesByEntry = new Map<string, typeof lines>();
        for (const line of lines) {
          const list = linesByEntry.get(line.journalEntryId) ?? [];
          list.push(line);
          linesByEntry.set(line.journalEntryId, list);
        }
        const batch: JournalLineExportRow[] = [];
        for (const entry of entries) {
          for (const line of linesByEntry.get(entry.id) ?? []) {
            const account = accountById.get(line.accountId);
            batch.push({
              entryId: entry.id,
              entryDate: isoDay(entry.entryDate),
              entryNumber: entry.entryNumber,
              fiscalYearCode: entry.fiscalYearCode,
              sourceType: entry.sourceType,
              sourceId: entry.sourceId,
              description: entry.description,
              reference: entry.reference,
              propertyId: entry.propertyId,
              lineId: line.id,
              accountCode: line.accountCode ?? account?.code ?? line.accountId,
              accountName: account?.name ?? "",
              lineDescription: line.description,
              debit: toDec(line.debit),
              credit: toDec(line.credit),
              taxRateCode: line.taxRateCode,
              taxBase: line.taxBase === null ? null : toDec(line.taxBase)
            });
          }
        }
        yield batch;
        if (entries.length < pageSize) return;
        cursor = entries[entries.length - 1]!.id;
      }
    },

    async documentRefs(kind, ids) {
      const out = new Map<string, DocumentRef>();
      if (ids.length === 0) return out;
      if (kind === "invoice") {
        const rows = await client.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true, customerTaxId: true, customerName: true } });
        for (const row of rows) out.set(row.id, { number: row.invoiceNumber, nif: row.customerTaxId, name: row.customerName });
      } else if (kind === "supplier_bill") {
        const rows = await client.supplierBill.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true, supplierTaxId: true, supplierName: true } });
        for (const row of rows) out.set(row.id, { number: row.invoiceNumber, nif: row.supplierTaxId, name: row.supplierName });
      } else {
        const rows = await client.expense.findMany({ where: { id: { in: ids } }, select: { id: true, supplierNif: true, supplierName: true, concept: true } });
        for (const row of rows) out.set(row.id, { number: null, nif: row.supplierNif, name: row.supplierName ?? row.concept });
      }
      return out;
    },

    async vatBookEntries(query) {
      const rows = await client.vatBookEntry.findMany({
        where: {
          organizationId: query.organizationId,
          date: { gte: dayUtc(query.from), lte: dayUtc(query.to) },
          ...(query.propertyId ? { propertyId: query.propertyId } : {})
        },
        orderBy: [{ book: "asc" }, { date: "asc" }, { series: "asc" }, { number: "asc" }, { rate: "asc" }]
      });
      return rows.map((row) => ({
        book: String(row.book),
        date: isoDay(row.date),
        series: row.series,
        number: row.number,
        counterpartyNif: row.counterpartyNif,
        counterpartyName: row.counterpartyName,
        base: toDec(row.base),
        rate: toDec(row.rate),
        quota: toDec(row.quota),
        total: toDec(row.total),
        retention: toDec(row.retention),
        taxFigure: row.taxFigure,
        surchargeRate: row.surchargeRate === null ? null : toDec(row.surchargeRate),
        surchargeQuota: row.surchargeQuota === null ? null : toDec(row.surchargeQuota),
        sourceType: String(row.sourceType),
        sourceId: row.sourceId,
        period: row.period,
        deductible: row.deductible
      }));
    }
  };
}

export const prismaFinancialStatementsSource: FinancialStatementsSource = buildPrismaFinancialStatementsSource(prisma);

/**
 * Runs `fn` with a SQL source bound to a REPEATABLE READ interactive
 * transaction: every read inside sees the same snapshot of the ledger.
 */
export async function withFinancialStatementsSnapshot<T>(fn: (source: FinancialStatementsSource) => Promise<T>): Promise<T> {
  return prisma.$transaction((tx) => fn(buildPrismaFinancialStatementsSource(tx)), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 10_000,
    timeout: 120_000
  });
}
