// In-memory FinancialStatementsSource for the unit tests: a tiny ledger with
// the SAME period semantics as the SQL implementation (balance_at excludes the
// closing dated at the cut-off; movements exclude regularization / closing /
// opening; reversed pairs are left out through the shared `ledgerEntryCounts`
// rule while the diario keeps both halves — hallazgo t6#2), accounts typed
// from the «PGC Pymes hotelero» template, and fixed PMS occupancy facts.
// `reverse()` mirrors accounting.service.reverseJournalEntry (sides swapped,
// entryKind reversal, original flagged reversedById / status reversed).

import { Prisma } from "@prisma/client";
import { accountGroup, isPostableCode, templateAccount, templateUsaliFor, type AccountKind } from "../../accounting/chart-of-accounts.service.js";
import type { LegalIdentityDto } from "@hotelos/shared";
import {
  compareAccountBalanceRows,
  ledgerEntryCounts,
  ledgerEntryIsBooked,
  sortWorkCentres,
  type AccountBalanceRow,
  type ChartAccountLite,
  type CostCentreRef,
  type DocumentRef,
  type FinancialStatementsSource,
  type FixedAssetLite,
  type HeadcountByProperty,
  type JournalLineExportRow,
  type LedgerQuery,
  type OccupancyFacts,
  type PropertyLite,
  type UsaliMappingSourceRow,
  type VatBookExportRow,
  type VatTotalsRow
} from "../source.js";

/** A legal entity of the tests (Tanda 6b): the sociedad behind `org_t`. */
export function testIdentity(overrides: Partial<LegalIdentityDto> = {}): LegalIdentityDto {
  return {
    legalEntityId: "le_t",
    organizationId: "org_t",
    code: "TST",
    legalName: "Test Org SL",
    taxId: "B12345674",
    taxIdValid: true,
    source: "legal_entity",
    legalForm: "sl",
    fiscalAddress: "Calle Real 1",
    fiscalPostalCode: "15001",
    fiscalMunicipality: "A Coruña",
    fiscalIneCode: "15030",
    fiscalProvince: "A Coruña",
    pgcVariant: "pymes",
    largeCompany: false,
    siiEnabled: false,
    verifactuChainScope: "per_center",
    cccPrincipal: null,
    ...overrides
  };
}

/** A work centre of the tests; `kind` defaults to hotel. */
export function testProperty(overrides: Partial<PropertyLite> & Pick<PropertyLite, "id" | "name">): PropertyLite {
  return {
    organizationId: "org_t",
    legalEntityId: "le_t",
    code: null,
    tradeName: null,
    kind: "hotel",
    address: null,
    municipality: null,
    province: null,
    currency: "EUR",
    ...overrides
  };
}

const D = (v: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(v);

export type MemoryEntry = {
  id?: string;
  date: string;
  kind?: "normal" | "regularization" | "closing" | "opening" | "reversal";
  propertyId?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  number?: number | null;
  description?: string;
  reference?: string;
  /** JournalStatus: `posted` (default) · `reversed` (set by `reverse`) · `draft` (never counts). */
  status?: "posted" | "reversed" | "draft";
  /** Reversal links, same contract as JournalEntry.reversalOfId / reversedById. */
  reversalOfId?: string | null;
  reversedById?: string | null;
  /** `costCenterId` (Tanda 6c): id registered with `costCentre()`; an unknown id behaves like the SQL LEFT JOIN (no centre). */
  lines: Array<{ code: string; debit?: string; credit?: string; description?: string; taxRateCode?: string; taxBase?: string; costCenterId?: string | null }>;
};

export type ReverseOptions = { date?: string; sourceType?: string; sourceId?: string | null; description?: string };

export type MemoryAccount = { code: string; name: string; kind: AccountKind; usaliDepartment?: string | null; usaliLine?: string | null };

function kindOf(code: string): AccountKind {
  const template = templateAccount(code);
  if (template) return template.kind;
  const group = accountGroup(code);
  if (group === 6) return "expense";
  if (group === 7) return "income";
  if (group === 1) return "equity";
  if (group === 4 || group === 5) return "liability";
  return "asset";
}

export class MemorySource implements FinancialStatementsSource {
  readonly entries: MemoryEntry[] = [];
  readonly accounts = new Map<string, MemoryAccount>();
  mappings: UsaliMappingSourceRow[] = [];
  props: PropertyLite[] = [];
  occupancyFacts: OccupancyFacts = { roomsInventory: 0, roomsOccupied: 0 };
  /** Per-property occupancy (Tanda 6b compare tests); falls back to `occupancyFacts` when a property is not listed. */
  occupancyByProperty = new Map<string, OccupancyFacts>();
  identity: LegalIdentityDto | null = null;
  assets: FixedAssetLite[] = [];
  vat: VatTotalsRow[] = [];
  vatRows: VatBookExportRow[] = [];
  people: number | null = null;
  /** Rows of `headcountByProperty`; `source` optional (Tanda 6c: `payroll_slips` · `payroll_cost_import`). */
  peopleByProperty: HeadcountByProperty = [];
  /** Cost centres of the ledger (Tanda 6c), by id: `{ type: "usali" | "operating" | "cost", code: "ROOMS" | … }`. */
  readonly costCentres = new Map<string, CostCentreRef>();
  /** Raw AccountingSetting.configurationJson of the organisation (corporateAllocation lives here). */
  configuration: unknown = null;
  refs: Record<string, Map<string, DocumentRef>> = { invoice: new Map(), supplier_bill: new Map(), expense: new Map() };
  private seq = 0;

  constructor(readonly organizationId: string) {}

  account(code: string, overrides: Partial<MemoryAccount> = {}): MemoryAccount {
    const existing = this.accounts.get(code);
    if (existing) return existing;
    const template = templateAccount(code);
    const usali = templateUsaliFor(code);
    const row: MemoryAccount = {
      code,
      name: template?.name ?? overrides.name ?? `Cuenta ${code}`,
      kind: overrides.kind ?? kindOf(code),
      usaliDepartment: overrides.usaliDepartment !== undefined ? overrides.usaliDepartment : (usali?.usaliDepartment ?? null),
      usaliLine: overrides.usaliLine !== undefined ? overrides.usaliLine : (usali?.usaliLine ?? null)
    };
    this.accounts.set(code, row);
    return row;
  }

  /** Registers a cost centre (Tanda 6c) so `accountBalances({ byCostCentre: true })` can partition the lines that reference it. */
  costCentre(id: string, ref: CostCentreRef): CostCentreRef {
    this.costCentres.set(id, ref);
    return ref;
  }

  post(entry: MemoryEntry): MemoryEntry {
    this.seq += 1;
    const full: MemoryEntry = {
      id: entry.id ?? `je_${this.seq}`,
      kind: "normal",
      propertyId: null,
      sourceType: "manual",
      sourceId: null,
      number: this.seq,
      status: "posted",
      reversalOfId: null,
      reversedById: null,
      ...entry
    };
    let debit = D(0);
    let credit = D(0);
    for (const line of full.lines) {
      this.account(line.code);
      debit = debit.plus(D(line.debit ?? 0));
      credit = credit.plus(D(line.credit ?? 0));
    }
    if (!debit.equals(credit)) throw new Error(`fixture entry ${full.id} not balanced: ${debit} vs ${credit}`);
    this.entries.push(full);
    return full;
  }

  /**
   * Marked inverse of a booked entry, like reverseJournalEntry: same accounts
   * with the sides swapped, kind `reversal`, dated as the original unless
   * `date` says otherwise (an invoice cancellation is dated the day it is
   * cancelled), the original flagged `reversedById` / `status = reversed`.
   * Idempotent; a reversal cannot be reversed; drafts cannot be reversed.
   */
  reverse(entryId: string, options: ReverseOptions = {}): MemoryEntry {
    const original = this.entries.find((e) => e.id === entryId);
    if (!original) throw new Error(`fixture entry ${entryId} not found`);
    if (original.status === "draft") throw new Error(`fixture entry ${entryId} is a draft: not reversible`);
    if (original.reversedById) return this.entries.find((e) => e.id === original.reversedById)!;
    if (original.kind === "reversal") throw new Error(`fixture entry ${entryId} is a reversal: not reversible`);
    const reversal = this.post({
      date: options.date ?? original.date,
      kind: "reversal",
      propertyId: original.propertyId,
      sourceType: options.sourceType ?? "reversal",
      sourceId: options.sourceId === undefined ? `reversal:${original.id}` : options.sourceId,
      description: options.description ?? `Anulación del asiento ${original.number ?? original.id}`,
      reference: original.reference,
      reversalOfId: original.id,
      lines: original.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit }))
    });
    original.reversedById = reversal.id!;
    original.status = "reversed";
    return reversal;
  }

  private select(query: LedgerQuery): MemoryEntry[] {
    return this.entries.filter((e) => {
      if (!ledgerEntryCounts({ status: e.status ?? "posted", reversedById: e.reversedById ?? null, reversalOfId: e.reversalOfId ?? null })) return false;
      if (query.propertyId && e.propertyId !== query.propertyId) return false;
      if (!query.propertyId && query.unassignedOnly && (e.propertyId ?? null) !== null) return false;
      if (query.mode === "balance_at") {
        if (e.date > query.to) return false;
        if (e.kind === "closing" && e.date === query.to) return false;
        return true;
      }
      if (e.date < (query.from ?? "0000-00-00") || e.date > query.to) return false;
      return e.kind !== "regularization" && e.kind !== "closing" && e.kind !== "opening";
    });
  }

  async accountBalances(query: LedgerQuery): Promise<AccountBalanceRow[]> {
    const byKey = new Map<string, AccountBalanceRow>();
    for (const entry of this.select(query)) {
      for (const line of entry.lines) {
        const account = this.account(line.code);
        if (query.groups && !query.groups.includes(accountGroup(line.code))) continue;
        // Tanda 6c: with the flag one row per (account, cost centre type, code) as the SQL LEFT JOIN cost_centers; without it, by account only (no `costCentre` key).
        const costCentre: CostCentreRef | null = line.costCenterId ? (this.costCentres.get(line.costCenterId) ?? null) : null;
        const key = query.byCostCentre && costCentre ? `${line.code}|${costCentre.type}|${costCentre.code}` : line.code;
        const row = byKey.get(key) ?? {
          code: line.code,
          name: account.name,
          kind: account.kind,
          isPostable: isPostableCode(line.code),
          usaliDepartment: account.usaliDepartment ?? null,
          usaliLine: account.usaliLine ?? null,
          debit: D(0),
          credit: D(0),
          ...(query.byCostCentre ? { costCentre } : {})
        };
        row.debit = row.debit.plus(D(line.debit ?? 0));
        row.credit = row.credit.plus(D(line.credit ?? 0));
        byKey.set(key, row);
      }
    }
    return Array.from(byKey.values()).sort(compareAccountBalanceRows);
  }

  async plAccounts(): Promise<ChartAccountLite[]> {
    return Array.from(this.accounts.values())
      .filter((a) => (a.kind === "income" || a.kind === "expense") && isPostableCode(a.code))
      .map((a, index) => ({
        id: `acc_${index}`,
        code: a.code,
        name: a.name,
        kind: a.kind,
        group: accountGroup(a.code),
        isPostable: true,
        usaliDepartment: a.usaliDepartment ?? null,
        usaliLine: a.usaliLine ?? null
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  async usaliMappings(): Promise<UsaliMappingSourceRow[]> {
    return this.mappings;
  }

  async properties(): Promise<PropertyLite[]> {
    return sortWorkCentres(this.props);
  }

  async occupancy(propertyIds: string[]): Promise<OccupancyFacts> {
    if (this.occupancyByProperty.size === 0) return this.occupancyFacts;
    let roomsInventory = 0;
    let roomsOccupied = 0;
    for (const id of propertyIds) {
      const facts = this.occupancyByProperty.get(id);
      if (!facts) continue;
      roomsInventory += facts.roomsInventory;
      roomsOccupied += facts.roomsOccupied;
    }
    return { roomsInventory, roomsOccupied };
  }

  async legalIdentity(): Promise<LegalIdentityDto | null> {
    return this.identity;
  }

  async headcountByProperty(): Promise<HeadcountByProperty> {
    return this.peopleByProperty;
  }

  async accountingConfiguration(): Promise<unknown> {
    return this.configuration;
  }

  async fixedAssets(): Promise<FixedAssetLite[]> {
    return this.assets;
  }

  async vatTotals(): Promise<VatTotalsRow[]> {
    return this.vat;
  }

  async headcount(): Promise<number | null> {
    return this.people;
  }

  async *journalLines(query: { organizationId: string; propertyId?: string | null; from: string; to: string }): AsyncIterable<JournalLineExportRow[]> {
    const rows: JournalLineExportRow[] = [];
    const entries = this.entries
      .filter((e) => ledgerEntryIsBooked({ status: e.status ?? "posted" }))
      .filter((e) => e.date >= query.from && e.date <= query.to && (!query.propertyId || e.propertyId === query.propertyId))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? 0) - (b.number ?? 0));
    for (const entry of entries) {
      entry.lines.forEach((line, index) => {
        rows.push({
          entryId: entry.id!,
          entryDate: entry.date,
          entryNumber: entry.number ?? null,
          fiscalYearCode: entry.date.slice(0, 4),
          sourceType: entry.sourceType ?? "manual",
          sourceId: entry.sourceId ?? null,
          description: entry.description ?? null,
          reference: entry.reference ?? null,
          propertyId: entry.propertyId ?? null,
          lineId: `${entry.id}_${index}`,
          accountCode: line.code,
          accountName: this.account(line.code).name,
          lineDescription: line.description ?? null,
          debit: D(line.debit ?? 0),
          credit: D(line.credit ?? 0),
          taxRateCode: line.taxRateCode ?? null,
          taxBase: line.taxBase === undefined ? null : D(line.taxBase)
        });
      });
    }
    if (rows.length > 0) yield rows;
  }

  async documentRefs(kind: "invoice" | "supplier_bill" | "expense", ids: string[]): Promise<Map<string, DocumentRef>> {
    const out = new Map<string, DocumentRef>();
    for (const id of ids) {
      const ref = this.refs[kind]?.get(id);
      if (ref) out.set(id, ref);
    }
    return out;
  }

  async vatBookEntries(): Promise<VatBookExportRow[]> {
    return this.vatRows;
  }
}

/**
 * The reference ledger of the unit tests (org "org_t", property "prop_t",
 * period 2027-01-01..2027-12-31). Expected figures are documented in the
 * tests that use it: result −1.902,00; total assets 60.184,80; USALI net
 * income −1.895,00 with 7,00 unassigned (account 645 has no USALI default).
 */
export function referenceLedger(): MemorySource {
  const s = new MemorySource("org_t");
  s.props = [testProperty({ id: "prop_t", name: "Hotel Test", code: "HT", tradeName: "Hotel Test", address: "Calle Real 1", municipality: "A Coruña", province: "A Coruña" })];
  s.identity = testIdentity();
  s.occupancyFacts = { roomsInventory: 10, roomsOccupied: 45 };
  s.account("645", { name: "Retribuciones en especie", kind: "expense", usaliDepartment: null, usaliLine: null });
  const P = "prop_t";
  s.post({ date: "2027-01-02", propertyId: P, description: "Aportación de capital", lines: [{ code: "572", debit: "60000.00" }, { code: "100", credit: "60000.00" }] });
  s.post({ date: "2027-01-05", propertyId: P, description: "Compra de mobiliario", lines: [{ code: "216", debit: "12000.00" }, { code: "572", credit: "12000.00" }] });
  s.post({
    date: "2027-03-10",
    propertyId: P,
    sourceType: "invoice",
    sourceId: "inv_1",
    reference: "FAC-2027-000001",
    description: "Factura alojamiento",
    lines: [{ code: "4300", debit: "121.00" }, { code: "705.1", credit: "100.00", taxRateCode: "21" }, { code: "477.21", credit: "21.00", taxRateCode: "21", taxBase: "100.00" }]
  });
  s.post({
    date: "2027-03-11",
    propertyId: P,
    sourceType: "invoice",
    sourceId: "inv_2",
    reference: "FAC-2027-000002",
    description: "Factura restauración",
    lines: [{ code: "4300", debit: "55.00" }, { code: "705.2", credit: "50.00", taxRateCode: "10" }, { code: "477.10", credit: "5.00", taxRateCode: "10", taxBase: "50.00" }]
  });
  s.post({ date: "2027-03-12", propertyId: P, sourceType: "payment", description: "Cobro en efectivo", lines: [{ code: "570", debit: "176.00" }, { code: "4300", credit: "176.00" }] });
  s.post({
    date: "2027-03-15",
    propertyId: P,
    sourceType: "supplier_bill",
    sourceId: "sb_1",
    description: "Factura proveedor alimentos",
    lines: [{ code: "601.1", debit: "40.00" }, { code: "472.10", debit: "4.00", taxRateCode: "10", taxBase: "40.00" }, { code: "400", credit: "44.00" }]
  });
  s.post({
    date: "2027-03-31",
    propertyId: P,
    sourceType: "payroll_slip",
    description: "Nómina marzo",
    lines: [{ code: "640.1", debit: "1000.00" }, { code: "642.1", debit: "300.00" }, { code: "476", credit: "400.00" }, { code: "4751", credit: "150.00" }, { code: "465", credit: "750.00" }]
  });
  s.post({ date: "2027-03-31", propertyId: P, description: "Alquiler", lines: [{ code: "621", debit: "500.00" }, { code: "472.21", debit: "105.00", taxRateCode: "21", taxBase: "500.00" }, { code: "410", credit: "605.00" }] });
  s.post({ date: "2027-03-31", propertyId: P, description: "Electricidad", lines: [{ code: "628.1", debit: "80.00" }, { code: "472.21", debit: "16.80", taxRateCode: "21", taxBase: "80.00" }, { code: "410", credit: "96.80" }] });
  s.post({ date: "2027-03-31", propertyId: P, sourceType: "commission", description: "Comisión canal", lines: [{ code: "629.1", debit: "15.00" }, { code: "410", credit: "15.00" }] });
  s.post({ date: "2027-03-31", propertyId: P, sourceType: "depreciation", description: "Amortización marzo", lines: [{ code: "681", debit: "100.00" }, { code: "2816", credit: "100.00" }] });
  s.post({ date: "2027-03-31", propertyId: P, description: "Intereses", lines: [{ code: "662", debit: "10.00" }, { code: "572", credit: "10.00" }] });
  s.post({ date: "2027-03-31", propertyId: P, description: "Retribución en especie", lines: [{ code: "645", debit: "7.00" }, { code: "572", credit: "7.00" }] });
  s.refs.invoice.set("inv_1", { number: "FAC-2027-000001", nif: "12345678Z", name: "Cliente Uno" });
  s.refs.invoice.set("inv_2", { number: "FAC-2027-000002", nif: null, name: "Cliente Dos" });
  s.refs.supplier_bill.set("sb_1", { number: "PROV-77", nif: "B98765432", name: "Alimentos SL" });
  return s;
}

/** Adds the 2027 regularization + closing and the 2028 opening to the reference ledger. */
export function closeReferenceYear(s: MemorySource): void {
  const P = "prop_t";
  s.post({
    date: "2027-12-31",
    kind: "regularization",
    propertyId: P,
    description: "Regularización 2027",
    lines: [
      { code: "705.1", debit: "100.00" },
      { code: "705.2", debit: "50.00" },
      { code: "129", debit: "1902.00" },
      { code: "601.1", credit: "40.00" },
      { code: "640.1", credit: "1000.00" },
      { code: "642.1", credit: "300.00" },
      { code: "621", credit: "500.00" },
      { code: "628.1", credit: "80.00" },
      { code: "629.1", credit: "15.00" },
      { code: "681", credit: "100.00" },
      { code: "662", credit: "10.00" },
      { code: "645", credit: "7.00" }
    ]
  });
  const closing: MemoryEntry["lines"] = [
    { code: "100", debit: "60000.00" },
    { code: "2816", debit: "100.00" },
    { code: "400", debit: "44.00" },
    { code: "410", debit: "716.80" },
    { code: "476", debit: "400.00" },
    { code: "4751", debit: "150.00" },
    { code: "465", debit: "750.00" },
    { code: "477.21", debit: "21.00" },
    { code: "477.10", debit: "5.00" },
    { code: "216", credit: "12000.00" },
    { code: "472.10", credit: "4.00" },
    { code: "472.21", credit: "121.80" },
    { code: "570", credit: "176.00" },
    { code: "572", credit: "47983.00" },
    { code: "129", credit: "1902.00" }
  ];
  s.post({ date: "2027-12-31", kind: "closing", propertyId: P, description: "Cierre 2027", lines: closing });
  s.post({
    date: "2028-01-01",
    kind: "opening",
    propertyId: P,
    description: "Apertura 2028",
    lines: closing.map((l) => ({ code: l.code, debit: l.credit, credit: l.debit }))
  });
}
