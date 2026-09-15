/**
 * Finanzas · estados financieros (lote «usali-cuentas», 2026-09-15): wire
 * contract between the API module `apps/api/src/modules/financial-statements`
 * and the admin-web screens (USALI, cuentas anuales PGC Pymes, exportación a
 * gestoría).
 *
 * TYPES ONLY. `packages/shared/src/*.js` carries stale `export {}` stubs next
 * to every .ts (see rate-manager-types.js): a runtime constant exported from
 * here would resolve to the stub under tsx, so the vocabularies below are
 * string unions and the API module owns the runtime constants
 * (`chart-of-accounts.service.ts` USALI_DEPARTMENTS / USALI_LINES /
 * USALI_DEPARTMENT_LINES) and asserts they match these unions in its tests.
 *
 * Money: every amount is a `MoneyString` — a decimal with exactly two
 * decimals and a dot ("1234.56", "-12.30", "0.00"), never a float. Ratios and
 * percentages use the same representation (`RatioString`, null when the
 * denominator is 0 — never a fake 0). Dates are calendar days `YYYY-MM-DD`.
 * Sign conventions are stated per statement below.
 */

// ---------------------------------------------------------------------------
// Vocabulary (mirrors chart-of-accounts.service.ts)
// ---------------------------------------------------------------------------

export type MoneyString = string;
export type RatioString = string;
export type IsoDate = string;

export type UsaliDepartmentKey =
  | "rooms"
  | "fnb"
  | "other_operated"
  | "misc_income"
  | "admin_general"
  | "it"
  | "sales_marketing"
  | "pom"
  | "utilities"
  | "management_fees"
  | "non_operating"
  | "below_ebitda";

export type UsaliLineKey =
  | "revenue"
  | "cost_of_sales"
  | "labor"
  | "other_expense"
  | "management_fee"
  | "rent"
  | "property_taxes"
  | "insurance"
  | "other"
  | "interest"
  | "depreciation_amortization"
  | "income_tax";

export type UsaliOperatingDepartmentKey = "rooms" | "fnb" | "other_operated" | "misc_income";
export type UsaliUndistributedDepartmentKey = "admin_general" | "it" | "sales_marketing" | "pom" | "utilities";

/** Where the effective USALI mapping of an account came from (runbook §4 order). */
export type UsaliMappingSource = "mapping" | "account" | "template" | "none";

// ---------------------------------------------------------------------------
// USALI mapping (editor)
// ---------------------------------------------------------------------------

export type UsaliMappingRow = {
  id: string;
  organizationId: string;
  /** Exact PGC code ("705.1") or prefix ("62"): only P&L codes (groups 6-7). */
  accountPrefix: string;
  usaliDepartment: UsaliDepartmentKey;
  usaliLine: UsaliLineKey;
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UsaliMappingUpsert = {
  accountPrefix: string;
  usaliDepartment: UsaliDepartmentKey;
  usaliLine: UsaliLineKey;
  priority?: number;
  active?: boolean;
};

export type UsaliMappingPatchBody = {
  mappings: UsaliMappingUpsert[];
};

/** Effective mapping of ONE postable P&L account after the resolution order. */
export type UsaliAccountResolution = {
  code: string;
  name: string;
  kind: "income" | "expense";
  usaliDepartment: UsaliDepartmentKey | null;
  usaliLine: UsaliLineKey | null;
  source: UsaliMappingSource;
  /** Mapping row that won (source = mapping). */
  mappingId: string | null;
  /** Spanish reason when the account is unmapped or its stored combination is not admitted. */
  issue: string | null;
};

export type UsaliCoverage = {
  organizationId: string;
  period: { from: IsoDate; to: IsoDate } | null;
  totalAccounts: number;
  mapped: number;
  unmapped: number;
  bySource: Record<UsaliMappingSource, number>;
  /** Postable P&L accounts of the chart without an effective mapping. */
  unmappedAccounts: UsaliAccountResolution[];
  /** Accounts WITH movements in the period and no mapping (only when a period is given). */
  unmappedWithMovements: Array<UsaliAccountResolution & { debit: MoneyString; credit: MoneyString }>;
  resolutions: UsaliAccountResolution[];
};

export type UsaliMappingsResponse = {
  organizationId: string;
  mappings: UsaliMappingRow[];
  coverage: UsaliCoverage;
  departments: Array<{ key: UsaliDepartmentKey; label: string; lines: UsaliLineKey[] }>;
  lines: Array<{ key: UsaliLineKey; label: string }>;
};

// ---------------------------------------------------------------------------
// USALI summary operating statement
// ---------------------------------------------------------------------------

/** One PGC account contributing to a USALI line. Amount in the line's own sign (revenue: income; expenses: cost). */
export type UsaliAccountAmount = {
  code: string;
  name: string;
  line: UsaliLineKey;
  amount: MoneyString;
  source: UsaliMappingSource;
};

export type UsaliOperatingDepartment = {
  department: UsaliOperatingDepartmentKey;
  label: string;
  revenue: MoneyString;
  costOfSales: MoneyString;
  labor: MoneyString;
  otherExpense: MoneyString;
  totalExpenses: MoneyString;
  /** revenue − totalExpenses. */
  departmentalProfit: MoneyString;
  accounts: UsaliAccountAmount[];
};

export type UsaliUndistributedDepartment = {
  department: UsaliUndistributedDepartmentKey;
  label: string;
  labor: MoneyString;
  otherExpense: MoneyString;
  total: MoneyString;
  accounts: UsaliAccountAmount[];
};

export type UsaliStatistics = {
  nights: number;
  /** Active rooms of the property (or the sum over the properties compared). */
  roomsInventory: number;
  /** roomsInventory × nights. Out-of-order rooms are not deducted (the PMS does not track them per night yet). */
  roomsAvailable: number;
  /** Room-nights of real stays (reservations checked_in / checked_out) overlapping the period. */
  roomsOccupied: number;
  occupancyPct: RatioString | null;
  source: "pms_stays";
};

export type UsaliRatios = {
  /** Rooms revenue / rooms available. */
  revpar: RatioString | null;
  /** Total operating revenue / rooms available. */
  trevpar: RatioString | null;
  /** GOP / rooms available. */
  goppar: RatioString | null;
  /** Rooms revenue / rooms occupied. */
  adr: RatioString | null;
  totalRevenuePOR: RatioString | null;
  gopPOR: RatioString | null;
  ebitdaPAR: RatioString | null;
  undistributedPAR: RatioString | null;
  perDepartment: Array<{
    department: UsaliDepartmentKey;
    revenuePAR: RatioString | null;
    revenuePOR: RatioString | null;
    profitPAR: RatioString | null;
    profitPOR: RatioString | null;
    expensePAR: RatioString | null;
    expensePOR: RatioString | null;
  }>;
};

export type UsaliPnl = {
  kind: "usali";
  organizationId: string;
  propertyId: string | null;
  propertyName: string | null;
  period: { from: IsoDate; to: IsoDate };
  currency: string;
  generatedAt: string;
  operatingDepartments: UsaliOperatingDepartment[];
  totalOperatingRevenue: MoneyString;
  totalDepartmentalExpenses: MoneyString;
  totalDepartmentalProfit: MoneyString;
  undistributed: UsaliUndistributedDepartment[];
  totalUndistributed: MoneyString;
  /** Gross operating profit = totalDepartmentalProfit − totalUndistributed. */
  gop: MoneyString;
  managementFees: MoneyString;
  managementFeeAccounts: UsaliAccountAmount[];
  /** GOP − management fees (USALI: income before non-operating income and expenses). */
  incomeBeforeNonOperating: MoneyString;
  nonOperating: {
    rent: MoneyString;
    propertyTaxes: MoneyString;
    insurance: MoneyString;
    other: MoneyString;
    total: MoneyString;
    accounts: UsaliAccountAmount[];
  };
  /** incomeBeforeNonOperating − nonOperating.total. */
  ebitda: MoneyString;
  belowEbitda: {
    interest: MoneyString;
    depreciationAmortization: MoneyString;
    incomeTax: MoneyString;
    accounts: UsaliAccountAmount[];
  };
  /** ebitda − interest − depreciationAmortization − incomeTax. */
  netIncome: MoneyString;
  /** P&L accounts with movements and no USALI mapping. Always present, never hidden. */
  unassigned: {
    revenue: MoneyString;
    expense: MoneyString;
    net: MoneyString;
    accounts: Array<{ code: string; name: string; kind: "income" | "expense"; amount: MoneyString }>;
  };
  /** PGC result of the same ledger rows (income − expense) must equal netIncome + unassigned.net. */
  reconciliation: {
    pgcRevenue: MoneyString;
    pgcExpense: MoneyString;
    pgcResult: MoneyString;
    usaliNetIncomePlusUnassigned: MoneyString;
    ok: boolean;
  };
  statistics: UsaliStatistics;
  ratios: UsaliRatios;
};

export type UsaliPropertyComparison = {
  kind: "usali_compare_properties";
  organizationId: string;
  period: { from: IsoDate; to: IsoDate };
  generatedAt: string;
  properties: Array<{ propertyId: string; propertyName: string; pnl: UsaliPnl }>;
  consolidated: UsaliPnl;
};

export type UsaliPeriodDelta = {
  label: string;
  base: MoneyString | RatioString | null;
  compared: MoneyString | RatioString | null;
  delta: MoneyString | null;
  deltaPct: RatioString | null;
};

export type UsaliPeriodComparison = {
  kind: "usali_compare_periods";
  organizationId: string;
  propertyId: string | null;
  generatedAt: string;
  periods: Array<{ from: IsoDate; to: IsoDate; pnl: UsaliPnl }>;
  /** Each period against the FIRST one (base). */
  deltas: Array<{ from: IsoDate; to: IsoDate; lines: UsaliPeriodDelta[] }>;
};

// ---------------------------------------------------------------------------
// Cuentas anuales PGC Pymes
// ---------------------------------------------------------------------------

export type StatementAccountAmount = { code: string; name: string; amount: MoneyString };

/** A line of the balance / P&L models. `amount` is presented in the model's sign (see each statement). */
export type StatementLine = {
  id: string;
  label: string;
  /** 0 = epigraph (A/B/C), 1 = roman numeral, 2 = arabic detail. */
  level: number;
  amount: MoneyString;
  /** Amount of the previous period when a comparative was requested. */
  previousAmount?: MoneyString;
  accounts: StatementAccountAmount[];
};

/**
 * Balance de situación (PGC Pymes). Assets: debit-natural amounts (contra
 * accounts 28x/29x/39x/49x/59x appear negative inside their line); equity and
 * liabilities: credit-natural amounts. `totalAssets` must equal
 * `totalEquityAndLiabilities` (`balanced`).
 */
export type PgcBalanceSheet = {
  kind: "balance";
  organizationId: string;
  propertyId: string | null;
  period: { from: IsoDate; to: IsoDate };
  asOf: IsoDate;
  generatedAt: string;
  assets: { nonCurrent: StatementLine[]; current: StatementLine[]; totalNonCurrent: MoneyString; totalCurrent: MoneyString; total: MoneyString };
  equity: { lines: StatementLine[]; total: MoneyString };
  liabilities: { nonCurrent: StatementLine[]; current: StatementLine[]; totalNonCurrent: MoneyString; totalCurrent: MoneyString; total: MoneyString };
  totalAssets: MoneyString;
  totalEquityAndLiabilities: MoneyString;
  /** |totalAssets − totalEquityAndLiabilities| < 0.005. */
  balanced: boolean;
  /** Result of the period taken to «VII. Resultado del ejercicio» (must equal the P&L result). */
  periodResult: MoneyString;
  /** Income − expense of entries BEFORE the period that were never regularised: shown in its own equity line, never hidden. */
  priorUnregularisedResult: MoneyString;
  warnings: string[];
};

/**
 * Cuenta de pérdidas y ganancias (PGC Pymes). Income positive, expenses
 * negative (PGC presentation), so every subtotal is a plain sum of its lines.
 */
export type PgcProfitAndLoss = {
  kind: "pyg";
  organizationId: string;
  propertyId: string | null;
  period: { from: IsoDate; to: IsoDate };
  generatedAt: string;
  lines: StatementLine[];
  operatingResult: MoneyString;
  financialResult: MoneyString;
  resultBeforeTax: MoneyString;
  incomeTax: MoneyString;
  netResult: MoneyString;
  /** Raw totals of the same rows: Σ income (7xx) and Σ expense (6xx). netResult = revenueTotal − expenseTotal. */
  revenueTotal: MoneyString;
  expenseTotal: MoneyString;
  warnings: string[];
};

export type EcpnColumnKey =
  | "capital"
  | "sharePremium"
  | "reserves"
  | "priorResults"
  | "otherContributions"
  | "periodResult"
  | "interimDividend"
  | "grants"
  | "total";

export type EcpnRow = {
  id: string;
  label: string;
  level: number;
  values: Record<EcpnColumnKey, MoneyString>;
};

/** Estado de cambios en el patrimonio neto (PGC Pymes): A) ingresos y gastos reconocidos; B) estado total de cambios. */
export type PgcEquityChanges = {
  kind: "ecpn";
  organizationId: string;
  propertyId: string | null;
  period: { from: IsoDate; to: IsoDate };
  generatedAt: string;
  recognisedIncomeAndExpense: {
    periodResult: MoneyString;
    directlyToEquity: StatementLine[];
    transfersToPnl: StatementLine[];
    total: MoneyString;
  };
  columns: Array<{ key: EcpnColumnKey; label: string }>;
  rows: EcpnRow[];
  /** closing = opening + rows, per column (|diff| < 0.005). */
  reconciled: boolean;
  warnings: string[];
};

export type MemoriaNoteStatus = "auto" | "requires_input";

export type MemoriaNote = {
  number: number;
  title: string;
  /** Spanish text generated from the data (never invented facts). */
  text: string;
  /** Machine-readable figures backing the text (tables per note). */
  figures: Record<string, unknown>;
  status: MemoriaNoteStatus;
};

export type PgcMemoria = {
  kind: "memoria";
  organizationId: string;
  propertyId: string | null;
  period: { from: IsoDate; to: IsoDate };
  generatedAt: string;
  entity: { name: string; legalName: string | null; taxId: string | null; properties: Array<{ id: string; name: string; address: string | null }> };
  notes: MemoriaNote[];
  warnings: string[];
};

export type AnnualAccounts = {
  kind: "annual_accounts";
  organizationId: string;
  propertyId: string | null;
  fiscalYear: { id: string; code: string; status: string } | null;
  period: { from: IsoDate; to: IsoDate };
  generatedAt: string;
  balance: PgcBalanceSheet;
  pyg: PgcProfitAndLoss;
  ecpn: PgcEquityChanges;
  memoria: PgcMemoria;
  coherence: {
    balanceBalanced: boolean;
    /** balance.periodResult === pyg.netResult */
    resultMatches: boolean;
    ecpnReconciled: boolean;
    ok: boolean;
  };
};

export type FinancialStatementKindKey = "balance" | "pyg" | "ecpn" | "memoria" | "usali";

export type FinancialStatementSnapshotRow = {
  id: string;
  organizationId: string;
  fiscalYearId: string | null;
  kind: FinancialStatementKindKey;
  periodFrom: IsoDate;
  periodTo: IsoDate;
  label: string | null;
  generatedAt: string;
  generatedBy: string | null;
};

export type FinancialStatementSnapshotDetail = FinancialStatementSnapshotRow & { json: unknown };

export type SnapshotCreateBody = {
  kind: FinancialStatementKindKey;
  from?: IsoDate;
  to?: IsoDate;
  fiscalYearId?: string;
  propertyId?: string;
  label?: string;
};

/** Download format of a statement. `xlsx` is a real SpreadsheetML workbook; `csv` is `;`-separated with BOM. */
export type StatementDownloadFormat = "json" | "pdf" | "xlsx" | "csv";

// ---------------------------------------------------------------------------
// Exportación a gestoría
// ---------------------------------------------------------------------------

export type GestoriaExportFormatKey = "csv_universal" | "contaplus_diario" | "a3" | "vat_books_csv";

export type GestoriaExportFormatInfo = {
  format: GestoriaExportFormatKey;
  label: string;
  implemented: boolean;
  /** true → the layout must be validated with the advisor before the first real import. */
  validateWithAdvisor: boolean;
  columns: string[];
  description: string;
};

export type GestoriaExportCreateBody = {
  format: GestoriaExportFormatKey;
  from: IsoDate;
  to: IsoDate;
  propertyId?: string;
  /** contaplus_diario only: length of the sub-account code in the target ContaPlus/Sage 50 company (default 8). */
  subaccountLength?: number;
};

export type GestoriaExportRow = {
  id: string;
  organizationId: string;
  format: GestoriaExportFormatKey;
  periodFrom: IsoDate;
  periodTo: IsoDate;
  rowCount: number;
  validateWithAdvisor: boolean;
  fileName: string;
  sizeBytes: number;
  createdBy: string | null;
  createdAt: string;
};

/** CSV universal de asientos: one row per journal line, `;` separator, UTF-8 BOM, decimal comma. */
export type CsvUniversalColumn = "fecha" | "asiento" | "cuenta" | "concepto" | "debe" | "haber" | "documento" | "nif" | "base" | "iva";
