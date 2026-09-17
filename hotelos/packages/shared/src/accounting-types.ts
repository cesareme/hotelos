/**
 * Finanzas · lote ledger (2026-09-15) · wire contract of the accounting ledger
 * between the API (`apps/api/src/modules/accounting`, routes in
 * `ledger.routes.ts`) and the admin-web finance screens.
 *
 * Conventions (docs/runbooks/finanzas-contabilidad.md):
 *   · Money travels as 2-decimal strings ("121.00"): the API computes with
 *     Prisma.Decimal and never exposes floats; the front formats the string.
 *   · Dates are calendar days `YYYY-MM-DD` (`entryDate` = fecha contable, the
 *     accrual date that orders the diario and fixes ejercicio/periodo);
 *     instants (`postedAt`) are ISO timestamps.
 *   · `sourceType`/`sourceId` identify the document that produced an entry and
 *     are the idempotency key of the projection: one entry per
 *     (organizationId, sourceType, sourceId).
 *   · Lines carry POSITIVE amounts on `debit` or `credit` (never negative
 *     lines): a rectificativa is an entry in the opposite direction.
 */

export const JOURNAL_SOURCE_TYPES = [
  "folio_line",
  "payment",
  "payment_refund",
  "invoice",
  "invoice_rectification",
  "invoice_cancellation",
  "pos_ticket",
  "supplier_bill",
  "supplier_bill_payment",
  "expense",
  "payroll_slip",
  "payroll_payment",
  /** Tanda 6c: devengo del coste de personal importado (agregado), un asiento por (centro, mes); sourceId `<importId>:<propertyId>:<periodCode>`. */
  "payroll_cost_import",
  /** Tanda 7b: ingresos diarios de OPERA (modo sombra), un asiento por (hotel, business date); sourceId `<propertyId>:<YYYY-MM-DD>`. */
  "pms_shadow_revenue",
  "commission",
  "commission_settlement",
  "depreciation",
  "vat_settlement",
  "cash_closure",
  "card_settlement",
  "tourist_tax",
  "manual",
  "regularization",
  "closing",
  "opening",
  "reversal"
] as const;
export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

export const JOURNAL_ENTRY_KINDS = ["normal", "regularization", "closing", "opening", "reversal"] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

export type JournalEntryStatus = "draft" | "posted" | "reversed";

/**
 * The ONE customer receivable sub-account of the platform (fix:ledger
 * 2026-09-16, hallazgo t6#4): every writer — posting rules / projection /
 * replay (accounting), invoice issuance / cancellation (invoicing), captures
 * and refunds (payments, folio) — debits and credits `4300` «Clientes
 * (euros)», never the 3-digit header `430`, so the customer sub-ledger is one
 * account. Runtime constant imported through the relative
 * `packages/shared/src/accounting-types.js` path (the workspace `.js` stubs
 * are not involved); a contract test pins every writer to it.
 */
export const CUSTOMER_ACCOUNT_CODE = "4300" as const;

/**
 * `details.code` values the ledger engine answers with (all 4xx, message in
 * Spanish). Documented here so the front can branch on them.
 */
export const LEDGER_ERROR_CODES = [
  "JOURNAL_TOO_FEW_LINES",
  "JOURNAL_NEGATIVE_LINE",
  "JOURNAL_LINE_SIDE",
  "JOURNAL_UNBALANCED",
  "ACCOUNT_CODE_INVALID",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_NOT_POSTABLE",
  "JOURNAL_SOURCE_REQUIRED",
  "JOURNAL_DESCRIPTION_REQUIRED",
  /** The fecha contable falls inside a closed FiscalPeriod (month / quarter). */
  "FISCAL_PERIOD_CLOSED",
  /** The fecha contable falls inside a FiscalYear with status `closed` (regularización + cierre posted): reopen it first. */
  "FISCAL_YEAR_CLOSED",
  "JOURNAL_DRAFT_NOT_REVERSIBLE",
  "JOURNAL_REVERSAL_OF_REVERSAL",
  "JOURNAL_REVERSAL_REASON_REQUIRED",
  "CHART_NOT_PROVISIONED",
  /** Tanda 6b (R4): a line of groups 6/7 without a work centre (`propertyId`) and the entry is not exempt nor `societyLevel`. */
  "WORK_CENTER_REQUIRED",
  /** Tanda 6b (R4): `propertyId` sent to GET/POST /accounting/fiscal-years or POST /accounting/fiscal-periods — fiscal years belong to the sociedad. */
  "FISCAL_YEAR_IS_ENTITY_SCOPED",
  /** Tanda 6b (R10.1, fix t6b#6): the `propertyId` of an asiento is not a work centre of the caller's organisation — opaque 404, never 403/409 (`requireJournalWorkCenter`). */
  "PROPERTY_NOT_FOUND",
  /** Tanda 6b (fix t6b#6): `POST /journal-entries/:id/post` on a draft of another organisation — opaque 404. */
  "JOURNAL_ENTRY_NOT_FOUND"
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/** Canonical payment methods (`Payment.methodCode`) and their treasury account. */
export const PAYMENT_METHOD_CODES = ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHOD_CODES)[number];

/** Two-decimal money as a string, e.g. "121.00" (negative values only in balances). */
export type MoneyString = string;

export type JournalLineView = {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string | null;
  debit: MoneyString;
  credit: MoneyString;
  description: string | null;
  /** "21" · "10" · "4" · "7" · "3" · "2" · "0" on VAT quota lines and their base lines. */
  taxRateCode: string | null;
  taxBase: MoneyString | null;
  costCenterId: string | null;
};

export type JournalEntryView = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  /** Sequential per (organization, fiscal year); null only on legacy rows pending numbering. */
  entryNumber: number | null;
  fiscalYearCode: string | null;
  fiscalYearId: string | null;
  entryDate: string;
  postedAt: string | null;
  status: JournalEntryStatus;
  entryKind: JournalEntryKind | string;
  sourceType: JournalSourceType | string;
  sourceId: string | null;
  description: string | null;
  reference: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  createdBy: string | null;
  currencyCode: string;
  lines: JournalLineView[];
  totalDebit: MoneyString;
  totalCredit: MoneyString;
};

export type JournalListQuery = {
  from?: string;
  to?: string;
  propertyId?: string;
  sourceType?: JournalSourceType | string;
  status?: JournalEntryStatus;
  accountCode?: string;
  /** Free text over description / reference / sourceId. */
  q?: string;
  limit?: number;
  cursor?: string | null;
};

export type JournalListPage = {
  items: JournalEntryView[];
  nextCursor: string | null;
  total: number;
};

export type ManualJournalLineInput = {
  accountCode: string;
  debit?: MoneyString | number;
  credit?: MoneyString | number;
  description?: string;
  taxRateCode?: string;
  taxBase?: MoneyString | number;
  costCenterId?: string;
};

export type ManualJournalEntryInput = {
  entryDate: string;
  description: string;
  reference?: string;
  propertyId?: string;
  /**
   * Tanda 6b (R4): `true` marks a manual entry of the sociedad (no work centre)
   * so lines of groups 6/7 without `propertyId` are accepted instead of 400
   * WORK_CENTER_REQUIRED. Only valid on manual entries.
   */
  societyLevel?: boolean;
  lines: ManualJournalLineInput[];
};

export type ReverseJournalEntryInput = {
  reason: string;
  /** Defaults to the reversed entry's date (same period) — pass today's date to reverse in the current period. */
  entryDate?: string;
};

export type LedgerMovementView = {
  journalEntryId: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  description: string | null;
  reference: string | null;
  debit: MoneyString;
  credit: MoneyString;
  /** Running balance after this movement (signed: debit − credit, the PGC «saldo deudor» is positive). */
  balance: MoneyString;
};

export type AccountLedgerView = {
  organizationId: string;
  propertyId: string | null;
  accountCode: string;
  accountName: string;
  kind: string;
  from: string | null;
  to: string;
  /** Balance before `from` (debit − credit), "0.00" when no `from`. */
  openingBalance: MoneyString;
  /** Detail, oldest first, capped at the server limit (5 000): see `truncated`. */
  movements: LedgerMovementView[];
  /** Σ debit / Σ credit of the WHOLE window (SQL sums), exact even when `movements` is truncated. */
  totals: { debit: MoneyString; credit: MoneyString };
  /** openingBalance + totals.debit − totals.credit: the true closing balance of the window. */
  closingBalance: MoneyString;
  /** True when the movement list was cut at the server cap (the last shown running balance is then not the closing one). */
  truncated: boolean;
};

export type ChartAccountView = {
  id: string;
  code: string;
  name: string;
  kind: string;
  /** Legacy alias (revenue == income). */
  accountType: string;
  group: number;
  level: number;
  isPostable: boolean;
  parentId: string | null;
  parentCode: string | null;
  usaliDepartment: string | null;
  usaliLine: string | null;
};

export type ChartAccountCreateInput = {
  code: string;
  name: string;
  /** Required when no parent account exists to inherit the nature from. */
  kind?: "asset" | "liability" | "equity" | "income" | "expense";
  isPostable?: boolean;
  usaliDepartment?: string | null;
  usaliLine?: string | null;
};

export type ChartAccountPatchInput = {
  name?: string;
  isPostable?: boolean;
  usaliDepartment?: string | null;
  usaliLine?: string | null;
};

export type AccountingSettingsView = {
  organizationId: string;
  chartTemplate: string | null;
  chartProvisioned: boolean;
  accountCount: number;
  fiscalYearStartMonth: number;
  vat: {
    periodicity: "quarterly" | "monthly";
    regime: "general" | "redeme" | "recargo";
    prorrataPct: MoneyString | null;
    taxFigure: string;
    /** False until a VatSettings row exists (defaults shown). */
    persisted: boolean;
  };
};

export type AccountingSettingsPatchInput = {
  fiscalYearStartMonth?: number;
  vatPeriodicity?: "quarterly" | "monthly";
  vatRegime?: "general" | "redeme" | "recargo";
  prorrataPct?: MoneyString | number | null;
  taxFigure?: "IVA" | "IGIC" | "IPSI";
};

export type ReplayKind = "invoice" | "payment" | "pos";

export type ReplayRequestInput = {
  /** Platform admins may target another organization; hotel users get their own. */
  organizationId?: string;
  propertyId?: string;
  from: string;
  to: string;
  /** false (default) = dry run: report what would be posted, write nothing. */
  apply?: boolean;
  kinds?: ReplayKind[];
};

export type ReplayItemStatus = "posted" | "exists" | "would_post" | "skipped" | "failed";

export type ReplayItemView = {
  kind: ReplayKind;
  sourceType: JournalSourceType | string;
  sourceId: string;
  reference: string | null;
  entryDate: string;
  amount: MoneyString;
  status: ReplayItemStatus;
  journalEntryId: string | null;
  entryNumber: number | null;
  message: string | null;
  warnings: string[];
};

export type ReplayReportView = {
  organizationId: string;
  propertyId: string | null;
  from: string;
  to: string;
  apply: boolean;
  kinds: ReplayKind[];
  scanned: number;
  posted: number;
  existing: number;
  wouldPost: number;
  skipped: number;
  failed: number;
  items: ReplayItemView[];
  /** After an applied run: every entry of the window balances (Σ debit = Σ credit). */
  balanced: boolean | null;
  generatedAt: string;
};

export type ProjectionFailureView = {
  eventId: string;
  eventType: string;
  organizationId: string;
  sourceType: string | null;
  sourceId: string | null;
  error: string;
  attempts: number;
  failedAt: string;
};

export type ProjectionStatusView = {
  queued: number;
  processed: number;
  posted: number;
  ignored: number;
  failed: number;
  recentFailures: ProjectionFailureView[];
};
