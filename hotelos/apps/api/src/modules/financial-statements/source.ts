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
import type { AccountKind } from "../accounting/chart-of-accounts.service.js";
import { kindFromLegacyType } from "../accounting/chart-of-accounts.service.js";
import { toDec, type Dec } from "./money.js";

export type LedgerMode = "balance_at" | "movements";

export type LedgerQuery = {
  organizationId: string;
  propertyId?: string | null;
  mode: LedgerMode;
  /** Required for `movements`; ignored for `balance_at`. */
  from?: string | null;
  to: string;
  /** Restrict to PGC groups (first digit). */
  groups?: number[];
};

export type AccountBalanceRow = {
  code: string;
  name: string;
  kind: AccountKind;
  isPostable: boolean;
  usaliDepartment: string | null;
  usaliLine: string | null;
  debit: Dec;
  credit: Dec;
};

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

export type PropertyLite = {
  id: string;
  organizationId: string;
  name: string;
  legalName: string | null;
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

export type OrganizationLite = { id: string; name: string; legalName: string | null; taxId: string | null };

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
  organization(organizationId: string): Promise<OrganizationLite | null>;
  fixedAssets(organizationId: string, propertyId?: string | null): Promise<FixedAssetLite[]>;
  vatTotals(organizationId: string, from: string, to: string): Promise<VatTotalsRow[]>;
  headcount(organizationId: string, from: string, to: string): Promise<number | null>;
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

export const prismaFinancialStatementsSource: FinancialStatementsSource = {
  async accountBalances(query) {
    const rows = await prisma.$queryRaw<RawBalanceRow[]>(Prisma.sql`
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
    const rows = await prisma.account.findMany({
      where: { organizationId, group: { in: [6, 7] }, isPostable: true },
      select: { id: true, code: true, name: true, kind: true, group: true, isPostable: true, usaliDepartment: true, usaliLine: true },
      orderBy: { code: "asc" }
    });
    return rows.map((row) => ({ ...row, kind: row.kind as AccountKind }));
  },

  async usaliMappings(organizationId) {
    return prisma.usaliMapping.findMany({ where: { organizationId }, orderBy: [{ priority: "desc" }, { accountPrefix: "asc" }] });
  },

  async properties(organizationId) {
    return prisma.property.findMany({
      where: { organizationId },
      select: { id: true, organizationId: true, name: true, legalName: true, address: true, municipality: true, province: true, currency: true },
      orderBy: { name: "asc" }
    });
  },

  async occupancy(propertyIds, from, to) {
    if (propertyIds.length === 0) return { roomsInventory: 0, roomsOccupied: 0 };
    const roomsInventory = await prisma.room.count({ where: { propertyId: { in: propertyIds }, active: true } });
    const windowStart = dayUtc(from);
    const windowEnd = dayUtc(addDays(to, 1)); // exclusive
    const reservations = await prisma.reservation.findMany({
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

  async organization(organizationId) {
    return prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, legalName: true, taxId: true } });
  },

  async fixedAssets(organizationId, propertyId) {
    const rows = await prisma.fixedAsset.findMany({
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
    const rows = await prisma.vatBookEntry.groupBy({
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
    const periods = await prisma.payrollPeriod.findMany({ where: { organizationId }, select: { id: true, periodCode: true } });
    const fromMonth = from.slice(0, 7);
    const toMonth = to.slice(0, 7);
    const ids = periods.filter((p) => /^\d{4}-\d{2}$/.test(p.periodCode) && p.periodCode >= fromMonth && p.periodCode <= toMonth).map((p) => p.id);
    if (ids.length === 0) return null;
    const slips = await prisma.payrollSlip.findMany({ where: { periodId: { in: ids } }, select: { staffProfileId: true }, distinct: ["staffProfileId"] });
    return slips.length;
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
      }> = await prisma.journalEntry.findMany({
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
      const lines = await prisma.journalLine.findMany({
        where: { journalEntryId: { in: entries.map((e) => e.id) } },
        orderBy: [{ journalEntryId: "asc" }, { id: "asc" }]
      });
      const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
      const accounts = accountIds.length
        ? await prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true, name: true } })
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
      const rows = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true, customerTaxId: true, customerName: true } });
      for (const row of rows) out.set(row.id, { number: row.invoiceNumber, nif: row.customerTaxId, name: row.customerName });
    } else if (kind === "supplier_bill") {
      const rows = await prisma.supplierBill.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true, supplierTaxId: true, supplierName: true } });
      for (const row of rows) out.set(row.id, { number: row.invoiceNumber, nif: row.supplierTaxId, name: row.supplierName });
    } else {
      const rows = await prisma.expense.findMany({ where: { id: { in: ids } }, select: { id: true, supplierNif: true, supplierName: true, concept: true } });
      for (const row of rows) out.set(row.id, { number: null, nif: row.supplierNif, name: row.supplierName ?? row.concept });
    }
    return out;
  },

  async vatBookEntries(query) {
    const rows = await prisma.vatBookEntry.findMany({
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
