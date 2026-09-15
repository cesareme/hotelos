/**
 * Payables & fixed assets · shared wire contract between the API (`apps/api`,
 * modules payables and fixed-assets) and admin-web (Finanzas 2026-09-15, lote
 * proveedores-activos).
 *
 * Design:
 *   · Money is a decimal STRING with 2 decimals ("1060.00") on every response;
 *     requests accept numbers or decimal strings with at most 2 decimals
 *     (more → 400 VALIDATION_ERROR). Dates are calendar days `YYYY-MM-DD`;
 *     timestamps are ISO-8601.
 *   · Rounding: per line to the cent (half-up); header totals are sums of the
 *     rounded lines; `total = baseTotal + taxTotal − retentionAmount`.
 *   · Every 4xx carries `details.code` (see PayablesErrorCode) and a Spanish
 *     message.
 *   · Routes (integrator registers them in server.ts):
 *       GET/POST   /organizations/:organizationId/payables/suppliers
 *       GET/PATCH  /organizations/:organizationId/payables/suppliers/:supplierId
 *       GET/POST   /properties/:propertyId/payables/supplier-bills
 *       GET        /properties/:propertyId/payables/aging?asOf=
 *       GET/PATCH  /properties/:propertyId/payables/supplier-bills/:billId
 *       POST       /properties/:propertyId/payables/supplier-bills/:billId/{approve|post|pay|cancel}
 *       GET        /properties/:propertyId/payables/supplier-bills/:billId/attachment
 *       GET/POST   /properties/:propertyId/payables/expenses
 *       GET        /properties/:propertyId/payables/expenses/:expenseId
 *       POST       /properties/:propertyId/payables/expenses/:expenseId/reverse
 *       GET/POST   /properties/:propertyId/asset-register
 *       GET/PATCH  /properties/:propertyId/asset-register/:assetId
 *       POST       /properties/:propertyId/asset-register/:assetId/dispose
 *       GET/POST   /organizations/:organizationId/depreciation-runs
 *       GET        /organizations/:organizationId/depreciation-runs/preview?period=YYYY-MM
 *       GET        /organizations/:organizationId/depreciation-runs/:runId
 *       POST       /organizations/:organizationId/depreciation-runs/:runId/reverse
 */

/** Decimal string with 2 decimals ("1060.00"). */
export type MoneyString = string;
/** Calendar day "YYYY-MM-DD". */
export type IsoDay = string;

export const PAYABLES_RETENTION_ROW_CODES = ["02", "03", "L01"] as const;
/** Modelo 111 row 02 (profesionales) / 03 (actividades agrarias); Modelo 115 row L01 (arrendamientos urbanos). */
export type RetentionRowCode = (typeof PAYABLES_RETENTION_ROW_CODES)[number];

export type SupplierDto = {
  id: string;
  organizationId: string;
  name: string;
  /** NIF/CIF normalised (upper-case, no separators) or null. */
  taxId: string | null;
  /** When the Spanish control-character check passed; null for foreign suppliers or no NIF. */
  nifValidatedAt: string | null;
  /** true = CIF (company), false = natural person (DNI/NIE), null = unknown. */
  isCompany: boolean | null;
  contact: { contactName?: string; email?: string; phone?: string };
  paymentTermDays: number | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  countryCode: string;
  iban: string | null;
  ibanFormatted: string | null;
  /** Default 6xx (or 20x/21x) of its bills. */
  defaultExpenseAccountCode: string | null;
  /** IRPF % ("15.00", "7.00", "19.00") or null. */
  retentionRate: string | null;
  retentionRowCode: RetentionRowCode | string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SupplierUpsertRequest = {
  name: string;
  taxId?: string | null;
  countryCode?: string;
  contact?: { contactName?: string; email?: string; phone?: string };
  paymentTermDays?: number | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  province?: string | null;
  iban?: string | null;
  defaultExpenseAccountCode?: string | null;
  retentionRate?: number | string | null;
  retentionRowCode?: RetentionRowCode | null;
  active?: boolean;
};

export const SUPPLIER_BILL_STATUSES = ["draft", "approved", "posted", "paid", "cancelled"] as const;
export type SupplierBillStatus = (typeof SUPPLIER_BILL_STATUSES)[number];

export const PAYABLE_ACCOUNT_CODES = ["400", "410", "4100", "4109"] as const;
export type PayableAccountCode = (typeof PAYABLE_ACCOUNT_CODES)[number];

/** Inline attachment (≤ 512 KiB decoded) stored as a data: URI; otherwise send `documentObjectKey` of the object store. */
export type InlineAttachment = { fileName: string; mimeType: "application/pdf" | "image/jpeg" | "image/png"; base64: string };

export type SupplierBillLineRequest = {
  description: string;
  /** 6xx expense (or 20x/21x when investmentGood). */
  expenseAccountCode: string;
  base: number | string;
  /** 21 | 10 | 4 | 7 | 3 | 2 | 0 */
  taxRate: number | string;
  /** Printed quota; must be within ±0.01 of base × rate. */
  quota?: number | string;
  /** Override of base × bill retentionRate. */
  retention?: number | string;
  costCenterId?: string | null;
  investmentGood?: boolean;
};

export type SupplierBillRequest = {
  supplierId?: string | null;
  /** Required when no supplierId. */
  supplierName?: string;
  supplierTaxId?: string | null;
  invoiceNumber: string;
  issueDate: IsoDay;
  dueDate?: IsoDay | null;
  /** Default: the supplier's retentionRate. */
  retentionRate?: number | string | null;
  retentionRowCode?: RetentionRowCode | null;
  /** Default: 400 when a line is 60x (purchases), else 410. */
  payableAccountCode?: PayableAccountCode;
  /** Printed total; 400 TOTAL_MISMATCH when it differs from the lines. */
  expectedTotal?: number | string;
  documentObjectKey?: string | null;
  attachment?: InlineAttachment;
  roomId?: string | null;
  lines: SupplierBillLineRequest[];
};

export type SupplierBillLineDto = {
  id: string;
  lineNo: number;
  description: string;
  expenseAccountCode: string;
  base: MoneyString;
  taxRate: string;
  quota: MoneyString;
  retention: MoneyString;
  costCenterId: string | null;
  investmentGood: boolean;
  fixedAssetId: string | null;
};

export type LedgerLineDto = {
  id: string;
  accountId: string;
  accountCode: string;
  debit: MoneyString;
  credit: MoneyString;
  description: string | null;
  taxRateCode: string | null;
  taxBase: MoneyString | null;
  costCenterId: string | null;
};

export type LedgerEntryDto = {
  id: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  entryDate: IsoDay;
  sourceType: string;
  sourceId: string | null;
  description: string | null;
  reference: string | null;
  status: string;
  reversalOfId: string | null;
  reversedById: string | null;
  totalDebit: MoneyString;
  totalCredit: MoneyString;
  lines: LedgerLineDto[];
  alreadyExisted: boolean;
};

export type VatBookRowDto = {
  id: string;
  book: "emitidas" | "recibidas" | "bienes_inversion" | string;
  date: IsoDay;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  base: MoneyString;
  rate: string;
  quota: MoneyString;
  total: MoneyString;
  retention: MoneyString;
  /** "2026-Q3" or "2026-09". */
  period: string;
  deductible: boolean;
};

export type SupplierBillDto = {
  id: string;
  organizationId: string;
  propertyId: string;
  supplierId: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  invoiceNumber: string | null;
  issueDate: IsoDay | null;
  dueDate: IsoDay | null;
  paymentDate: IsoDay | null;
  baseTotal: MoneyString;
  taxTotal: MoneyString;
  retentionRate: string | null;
  retentionAmount: MoneyString;
  retentionRowCode: string | null;
  total: MoneyString;
  payableAccountCode: string | null;
  status: SupplierBillStatus;
  hasAttachment: boolean;
  journalEntryId: string | null;
  paidJournalEntryId: string | null;
  postedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: SupplierBillLineDto[];
};

export type SupplierBillDetailDto = SupplierBillDto & {
  vatRows: VatBookRowDto[];
  accrualEntry: LedgerEntryDto | null;
  paymentEntry: LedgerEntryDto | null;
};

export type PaySupplierBillRequest = {
  paymentDate: IsoDay;
  paidWith?: "bank" | "cash";
  /** 572 (bank, default) · 570 (cash) or a sub-account of 572. */
  counterAccountCode?: string;
  reference?: string;
};

export type CancelRequest = { reason: string };

export const AGING_BUCKETS = ["notDue", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export type AgingReportDto = {
  asOf: IsoDay;
  currency: "EUR";
  totals: Record<AgingBucket, MoneyString> & { outstanding: MoneyString; count: number };
  suppliers: Array<{
    supplierId: string | null;
    supplierName: string | null;
    supplierTaxId: string | null;
    outstanding: MoneyString;
    buckets: Record<AgingBucket, MoneyString>;
    bills: Array<{ id: string; invoiceNumber: string | null; issueDate: IsoDay | null; dueDate: IsoDay | null; daysPastDue: number; bucket: AgingBucket; total: MoneyString }>;
  }>;
};

export const EXPENSE_PAID_WITH = ["cash", "card", "bank"] as const;
export type ExpensePaidWith = (typeof EXPENSE_PAID_WITH)[number];

export type ExpenseRequest = {
  date: IsoDay;
  supplierName: string;
  supplierNif?: string | null;
  concept: string;
  /** 6xx */
  accountCode: string;
  base: number | string;
  taxRate: number | string;
  quota?: number | string;
  total?: number | string;
  paidWith: ExpensePaidWith;
  /** Override of the paidWith default (cash→570, card→5721, bank→572). */
  counterAccountCode?: "570" | "572" | "5721" | "5722";
  /** Default: true when supplierNif is given; a ticket without NIF cannot deduct (400). */
  vatDeductible?: boolean;
  costCenterId?: string | null;
  receiptObjectKey?: string | null;
  attachment?: InlineAttachment;
};

export type ExpenseDto = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  date: IsoDay;
  supplierName: string;
  supplierNif: string | null;
  concept: string;
  accountCode: string;
  base: MoneyString;
  taxRate: string;
  quota: MoneyString;
  total: MoneyString;
  paidWith: ExpensePaidWith;
  vatDeductible: boolean;
  hasReceipt: boolean;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  cancelledAt: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type ExpenseDetailDto = ExpenseDto & { vatRows: VatBookRowDto[]; entry: LedgerEntryDto | null };

export const FIXED_ASSET_CATEGORIES = ["mobiliario", "instalaciones", "informatica", "construcciones", "vehiculos", "intangible", "otro"] as const;
export type FixedAssetCategory = (typeof FIXED_ASSET_CATEGORIES)[number];

/** Maximum annual coefficient (%) per category (tablas art. 12 LIS). */
export const FIXED_ASSET_MAX_COEFFICIENT_PCT: Record<FixedAssetCategory, string> = {
  mobiliario: "10",
  instalaciones: "10",
  informatica: "25",
  construcciones: "3",
  vehiculos: "16",
  intangible: "33",
  otro: "25"
};

export type FixedAssetStatus = "active" | "fully_depreciated" | "disposed";

export type FixedAssetRequest = {
  name: string;
  /** Either category or accountCode (20x/21x) is required; the other is derived. */
  category?: FixedAssetCategory;
  accountCode?: string;
  depreciationAccountCode?: string;
  expenseAccountCode?: string;
  acquisitionDate: IsoDay;
  /** Start of depreciation (default acquisitionDate). */
  startDate?: IsoDay | null;
  acquisitionCost: number | string;
  residualValue?: number | string;
  /** ≤ the category maximum (400 COEFFICIENT_ABOVE_MAX); default = table value of the account. */
  coefficientPct?: number | string;
  usefulLifeMonths?: number | null;
  supplierBillId?: string | null;
  assetId?: string | null;
};

export type FixedAssetPatchRequest = Partial<Pick<FixedAssetRequest, "name" | "coefficientPct" | "residualValue" | "startDate" | "depreciationAccountCode" | "expenseAccountCode" | "usefulLifeMonths" | "assetId">>;

export type DisposeFixedAssetRequest = { date: IsoDay; saleAmount?: number | string; counterAccountCode?: "572" | "570" | "430"; reason?: string };

export type FixedAssetDto = {
  id: string;
  organizationId: string | null;
  propertyId: string;
  name: string;
  category: FixedAssetCategory | null;
  accountCode: string | null;
  depreciationAccountCode: string | null;
  expenseAccountCode: string | null;
  acquisitionDate: IsoDay | null;
  startDate: IsoDay | null;
  acquisitionCost: MoneyString;
  residualValue: MoneyString;
  coefficientPct: string | null;
  maxCoefficientPct: string | null;
  monthlyAmount: MoneyString | null;
  accumulatedDepreciation: MoneyString;
  netBookValue: MoneyString;
  status: FixedAssetStatus;
  disposedAt: IsoDay | null;
  supplierBillId: string | null;
  assetId: string | null;
  usefulLifeMonths: number | null;
  /** false = legacy row without category / coefficient / accounts: the run skips it. */
  depreciable: boolean;
  updatedAt: string;
};

export type FixedAssetDetailDto = FixedAssetDto & {
  history: Array<{ runId: string; period: string; status: string; amount: MoneyString; accumulatedAfter: MoneyString; netBookValueAfter: MoneyString }>;
  disposalEntry: LedgerEntryDto | null;
};

export type DepreciationRunLineDto = {
  fixedAssetId: string;
  name: string;
  propertyId: string;
  accountCode: string | null;
  depreciationAccountCode: string | null;
  expenseAccountCode: string | null;
  amount: MoneyString;
  accumulatedAfter: MoneyString;
  netBookValueAfter: MoneyString;
};

export type DepreciationRunDto = {
  id: string | null;
  organizationId: string;
  /** "YYYY-MM" */
  period: string;
  periodStart: IsoDay;
  periodEnd: IsoDay;
  status: "draft" | "posted" | "reversed" | "preview";
  totalAmount: MoneyString;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  createdBy: string | null;
  createdAt: string | null;
  lines: DepreciationRunLineDto[];
  skipped: Array<{ fixedAssetId: string; name: string; propertyId: string; reason: string }>;
  alreadyPosted: boolean;
  /**
   * Preview only: earlier months that must be posted before this one, ascending
   * (runs are posted month by month without gaps: after the latest posted run
   * the chain is consecutive; the first run of the organisation starts at the
   * earliest start date of its depreciable elements; months in which nothing
   * would depreciate are not required). While non-empty, POST of this period
   * answers 409 PREVIOUS_PERIOD_MISSING with the same list in
   * `details.pendingPeriods` (+ `details.latestPostedPeriod`). [] on posted /
   * reversed runs.
   */
  pendingPeriods: string[];
  entry: LedgerEntryDto | null;
};

export type DepreciationRunRequest = { period: string };

/** Every `details.code` a 4xx of the payables / fixed-assets routes can carry. */
export type PayablesErrorCode =
  | "VALIDATION_ERROR"
  | "SUPPLIER_NIF_INVALID"
  | "SUPPLIER_NIF_DUPLICATE"
  | "SUPPLIER_IBAN_INVALID"
  | "SUPPLIER_REQUIRED"
  | "SUPPLIER_NIF_REQUIRED"
  | "EXPENSE_ACCOUNT_INVALID"
  | "UNSUPPORTED_TAX_RATE"
  | "LINE_QUOTA_MISMATCH"
  | "LINE_RETENTION_MISMATCH"
  | "TOTAL_MISMATCH"
  | "DUE_DATE_BEFORE_ISSUE"
  | "ISSUE_DATE_REQUIRED"
  | "PAYMENT_BEFORE_ISSUE"
  | "COUNTER_ACCOUNT_INVALID"
  | "SUPPLIER_BILL_DUPLICATE"
  | "INVALID_STATUS_TRANSITION"
  | "BILL_HAS_FIXED_ASSETS"
  | "ATTACHMENT_INVALID"
  | "ATTACHMENT_TOO_LARGE"
  | "EXPENSE_VAT_NOT_DEDUCTIBLE_WITHOUT_NIF"
  | "ASSET_CATEGORY_REQUIRED"
  | "ASSET_ACCOUNT_INVALID"
  | "COEFFICIENT_REQUIRED"
  | "COEFFICIENT_ABOVE_MAX"
  | "RESIDUAL_ABOVE_COST"
  | "RESIDUAL_ABOVE_NBV"
  | "START_BEFORE_ACQUISITION"
  | "DISPOSAL_BEFORE_ACQUISITION"
  | "ASSET_DISPOSED"
  | "ASSET_NOT_CONFIGURED"
  | "ASSET_HAS_DEPRECIATION"
  | "PERIOD_INVALID"
  | "PERIOD_IN_FUTURE"
  | "LATER_RUN_EXISTS"
  | "PREVIOUS_PERIOD_MISSING"
  // ledger port
  | "UNBALANCED_ENTRY"
  | "INVALID_LEDGER_LINE"
  | "CHART_NOT_PROVISIONED"
  | "ACCOUNT_NOT_IN_CHART"
  | "ACCOUNT_NOT_POSTABLE"
  | "FISCAL_PERIOD_CLOSED"
  | "FISCAL_YEAR_CLOSED"
  | "ENTRY_ALREADY_REVERSED"
  | "ENTRY_NOT_FOUND";
