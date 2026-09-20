/**
 * Tesorería · banca · comisiones · nóminas (lote tesoreria-banca, 2026-09-15):
 * shared wire contract between the API (`apps/api/src/modules/treasury`,
 * `banking`, `banking-spain`, `commissions`, `payroll`) and the admin-web.
 *
 * Money on this contract is a decimal STRING with two decimals ("1234.50",
 * dot separator) — the API computes with Prisma.Decimal and never rounds
 * twice; the legacy dashboards (`/dashboards/finance-position`, `/banking/*`)
 * keep their numeric fields. Dates are calendar days `YYYY-MM-DD` unless the
 * field name ends in `At` (ISO timestamps).
 *
 * Routes (registered by `registerTreasuryRoutes`):
 *   GET  /treasury/position | receivables | payables | forecast  ?propertyId&asOf
 *   POST /treasury/bank-accounts/:id/statements/import          { format: csb43|csv, content }
 *   GET  /treasury/bank-lines/:id/suggestions
 *   POST /treasury/bank-lines/:id/reconcile                      { matchType, matchedEntityId?, notes? }
 *   DELETE /treasury/bank-lines/:id/reconcile
 *   POST /treasury/statements/:id/auto-reconcile                 { dryRun? }
 *   POST /treasury/sepa/remittances                              { kind, body }  · GET (list, :id) · POST :id/status
 *   POST /treasury/sepa/supplier-payments                        { bankAccountId, billIds, executionDate, generate? }
 *   POST /commissions/accrue · /commissions/accruals/:id/settle · /reverse · GET /commissions/accruals/:id
 *   GET  /payroll/periods/:id · POST /payroll/periods/:id/export · POST /payroll/periods/:id/pay
 */

export type MoneyString = string;

export type TreasuryBankRow = {
  bankAccountId: string;
  name: string;
  ibanMasked: string | null;
  ledgerAccountCode: string;
  ledgerBalance: MoneyString;
  statementClosing: MoneyString | null;
  statementDate: string | null;
  reconciledBalance: MoneyString;
  drift: MoneyString;
  unmatchedLines: number;
  unmatchedAmount: MoneyString;
};

export type TreasuryPosition = {
  propertyId: string;
  organizationId: string;
  asOf: string;
  cash: { ledgerAccountCode: string; balance: MoneyString };
  banks: TreasuryBankRow[];
  pendingSettlements: { cardTerminal: MoneyString; paymentGateway: MoneyString; total: MoneyString };
  totals: { cashAndBanks: MoneyString; receivables: MoneyString; payables: MoneyString; net: MoneyString };
  source: "ledger" | "ledger+statements";
  warnings: string[];
};

export type TreasuryAgingBuckets = { current: MoneyString; days0_30: MoneyString; days31_60: MoneyString; days61_90: MoneyString; days90Plus: MoneyString; total: MoneyString };

export type ReceivableItem = {
  kind: "invoice" | "folio";
  id: string;
  reference: string;
  counterparty: string;
  date: string;
  expectedOn: string;
  /** true when the expected date is a convention (issue + 30 days), not a document field. */
  assumedDate: boolean;
  amount: MoneyString;
  outstanding: MoneyString;
  daysOverdue: number;
};

export type PayableItem = {
  kind: "supplier_bill" | "payroll_period" | "commission_accrual" | "tax_liability";
  id: string;
  reference: string;
  counterparty: string;
  date: string;
  expectedOn: string;
  assumedDate: boolean;
  amount: MoneyString;
  outstanding: MoneyString;
  daysOverdue: number;
};

export type TreasuryReceivables = { propertyId: string; asOf: string; total: MoneyString; invoices: MoneyString; openFolios: MoneyString; aging: TreasuryAgingBuckets; items: ReceivableItem[]; method: string[] };
export type TreasuryPayables = { propertyId: string; asOf: string; total: MoneyString; supplierBills: MoneyString; payroll: MoneyString; commissions: MoneyString; taxLiabilities: MoneyString; aging: TreasuryAgingBuckets; items: PayableItem[]; method: string[] };

export type ForecastBucketLabel = "overdue" | "0-30" | "31-60" | "61-90" | "90+";
export type ForecastBucket = { label: ForecastBucketLabel; from: string | null; to: string | null; inflows: MoneyString; outflows: MoneyString; net: MoneyString };
export type TreasuryForecast = {
  propertyId: string;
  asOf: string;
  opening: MoneyString;
  buckets: ForecastBucket[];
  horizons: Array<{ days: 30 | 60 | 90; inflows: MoneyString; outflows: MoneyString; projectedBalance: MoneyString }>;
  items: Array<(ReceivableItem & { direction: "in" }) | (PayableItem & { direction: "out" })>;
  assumptions: string[];
};

// ---- Banca ----

export type ReconcileTargetType = "payment" | "card_settlement" | "supplier_bill" | "payroll_period" | "commission_accrual" | "bank_fee" | "bank_interest" | "manual";
export type MatchConfidence = "high" | "medium" | "low";

export type BankLineSuggestion = {
  kind: Exclude<ReconcileTargetType, "bank_fee" | "bank_interest" | "manual">;
  id: string;
  label: string;
  amount: number;
  date: string;
  confidence: MatchConfidence;
  reason: string;
  /** Card settlements: gross − net (the acquirer fee). */
  fee: number;
  paymentIds?: string[];
};

export type BankLineSuggestions = { bankLineId: string; amount: number; txDate: string; suggestions: BankLineSuggestion[] };

export type ReconcileLineRequest = { matchType: ReconcileTargetType; matchedEntityId?: string; notes?: string };

export type ReconcileLineResult = {
  id: string;
  bankLineId: string;
  matchType: string;
  matchedEntityId: string;
  amount: number;
  confidence: string | null;
  matchedAt: string;
  journalEntryId: string | null;
  notes: string | null;
};

export type AutoReconcileDetail = { bankLineId: string; matched: boolean; matchType?: string; matchedEntityId?: string; confidence?: string; reason?: string; error?: string; suggestions?: BankLineSuggestion[] };
export type AutoReconcileResult = { statementId: string; scanned: number; matched: number; alreadyMatched: number; unmatched: number; dryRun: boolean; details: AutoReconcileDetail[] };

export type StatementImportRequest = { format: "csb43" | "csv"; content: string; source?: string; autoMatch?: boolean; createMissingAccount?: boolean };

export type Csb43ImportAccount = {
  bankCode: string;
  branchCode: string;
  accountNumber: string;
  ccc: string;
  iban: string;
  ownerName: string | null;
  fromDate: string;
  toDate: string;
  currency: string;
  initialBalance: number;
  finalBalance: number;
  bankAccountId: string | null;
  statementId: string | null;
  persisted: boolean;
  newLines: number;
  duplicateLines: number;
  movements: Array<{ operationDate: string; valueDate: string; conceptCode: string; amount: number; descriptions: string[]; referenceA: string | null; referenceB: string | null; runningBalance: number; fingerprint: string }>;
  matches: Array<{ movementIndex: number; paymentId: string; matchType: string; confidence: MatchConfidence; reason: string }>;
  unmatchedMovementIdxs: number[];
  warnings: string[];
};

export type Csb43ImportResult = { accounts: Csb43ImportAccount[]; unmatchedPayments: string[]; warnings: string[] };

// ---- SEPA ----

export type SepaRemittanceKind = "norma19" | "norma34";
export type SepaRemittanceStatus = "generated" | "sent" | "accepted" | "rejected" | "cancelled";

export type SepaRemittanceRecord = {
  id: string;
  kind: SepaRemittanceKind;
  organizationId: string;
  propertyId: string;
  bankAccountId: string | null;
  messageId: string;
  status: SepaRemittanceStatus;
  totalAmount: MoneyString;
  transactions: number;
  executionDate: string;
  warnings: string[];
  history: Array<{ status: SepaRemittanceStatus; at: string; by: string | null; note: string | null }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only on the detail read and on creation. */
  xml?: string;
};

export type SepaNorma19Request = {
  schema: "CORE" | "B2B";
  collectionDate: string;
  sequenceType: "FRST" | "RCUR" | "OOFF" | "FNAL";
  creditor: { name: string; creditorId: string; iban: string; bic?: string };
  debtors: Array<{ mandateId: string; mandateSignedAt: string; name: string; iban: string; bic?: string; amount: number | string; description: string; endToEndId: string }>;
};

export type SepaNorma34Request = {
  executionDate: string;
  debtor: { name: string; taxId: string; iban: string; bic?: string };
  creditors: Array<{ name: string; iban: string; bic?: string; amount: number | string; description: string; endToEndId: string; category?: "SUPP" | "SALA" | "OTHR" }>;
  batchBooking?: boolean;
};

export type CreateSepaRemittanceRequest = { kind: SepaRemittanceKind; propertyId?: string; bankAccountId?: string; body: SepaNorma19Request | SepaNorma34Request };

// ---- Comisiones ----

export type CommissionAccrualStatus = "accrued" | "settled" | "reversed";

export type CommissionAccrualRecord = {
  id: string;
  propertyId: string;
  reservationId: string | null;
  invoiceId: string | null;
  channelId: string | null;
  channelCode: string | null;
  baseAmount: MoneyString;
  ratePct: string;
  commissionAmount: MoneyString;
  currencyCode: string;
  accruedAt: string;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  settledAt: string | null;
  settlementJournalEntryId: string | null;
  status: CommissionAccrualStatus | string;
};

export type AccrueCommissionResult = {
  accrual: CommissionAccrualRecord | null;
  journalEntryId: string | null;
  created: boolean;
  skippedReason: string | null;
  base: { base: MoneyString | unknown; source: string; warnings: string[] } | null;
};

// ---- Nóminas ----

/** Tanda 8a: `approved` (dirección aprueba el registro mensual antes de exportar y pagar). */
export type PayrollPeriodStatus = "open" | "calculated" | "approved" | "exported" | "closed";

export type PayrollPeriodRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  startDate: string;
  endDate: string;
  status: PayrollPeriodStatus;
  totalGross: number;
  totalNet: number;
  totalIrpf: number;
  totalSs: number;
  exportedAt?: string;
  createdAt: string;
  journalEntryIds: string[];
  reversalJournalEntryIds: string[];
  postedAt: string | null;
  reversedAt: string | null;
  paymentJournalEntryId: string | null;
  paidAt: string | null;
  // Tanda 8a (SoD): quién calculó y quién aprobó.
  calculatedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  /** Tanda RRHH (corrector SEC-12): `external` (la gestoría calcula) o `calculated` (preparación del ERP); y el sello de cierre. */
  mode: "external" | "calculated";
  closedAt: string | null;
};

export type PayrollExportFormat = "a3" | "sage" | "csv";

export type PayrollExportResult = {
  periodId: string;
  periodCode: string;
  format: PayrollExportFormat;
  filename: string;
  contentType: string;
  text: string;
  slipCount: number;
  exportedAt: string | null;
  validateWithAdvisor: boolean;
  warnings: string[];
};

/** `details.code` values the treasury routes answer with on 4xx. */
export type TreasuryErrorCode =
  | "VALIDATION_ERROR"
  | "CHART_NOT_PROVISIONED"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_NOT_POSTABLE"
  | "FISCAL_PERIOD_CLOSED"
  | "JOURNAL_UNBALANCED"
  | "JOURNAL_NEGATIVE_LINE"
  | "STATEMENT_ALREADY_IMPORTED"
  | "LINE_ALREADY_MATCHED"
  | "DIRECTION_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "PAYMENT_NOT_CAPTURED"
  | "SUPPLIER_BILL_NOT_POSTED"
  | "SUPPLIER_BILL_AMOUNT_MISMATCH"
  | "REMITTANCE_STATUS_TRANSITION"
  | "REMITTANCE_EMPTY"
  | "COMMISSION_NOT_ACCRUED"
  | "COMMISSION_SETTLED"
  | "PAYROLL_PERIOD_EXISTS"
  | "PAYROLL_PERIOD_CLOSED"
  | "PAYROLL_PERIOD_PAID"
  | "PAYROLL_PERIOD_NOT_CALCULATED"
  | "PAYROLL_NOTHING_TO_PAY";
