-- ============================================================================
-- 20260915140000_finanzas_contabilidad_pgc · Finanzas / contabilidad PGC Pymes (lote schema)
-- ============================================================================
-- Generated on 2026-09-15 with:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- then reviewed by hand. Everything the generator emitted is here verbatim EXCEPT:
--
--   1. accounts.kind / accounts.level / accounts.pgc_group are NOT NULL without a
--      default in schema.prisma (they are intrinsic to the code). The generator
--      emits `ADD COLUMN ... NOT NULL`, which fails on the 78 seeded rows of
--      org_123, so they are added nullable, backfilled (kind from the legacy
--      account_type with revenue→income; group = first digit; level = digits up
--      to 3, 4 for sub-accounts) and only then SET NOT NULL. End state == schema.
--   2. supplier_bills.status changes from TEXT to the SupplierBillStatus enum. The
--      generator DROPs and re-ADDs the column (data loss) and re-creates the
--      index it dropped. Here the column is converted in place with
--      `ALTER COLUMN ... TYPE ... USING`, so rows and the existing
--      supplier_bills_property_id_status_idx survive (the table is empty in the
--      demo DB today, but the VPS must not depend on that).
--   3. Data steps (hand-written, all idempotent):
--      · journal_entries: entry_date = posted_at::date (accounting date of the
--        4 existing entries = the day they were projected), fiscal_year_code =
--        year of entry_date (no FiscalYear rows exist yet) and entry_number =
--        sequence per (organization, fiscal_year_code) ordered by posted_at, id.
--        The unique index (organization_id, fiscal_year_code, entry_number) is
--        created AFTER the numbering.
--      · journal_lines.account_code = accounts.code of account_id (denormalised).
--      · supplier_bills.organization_id / fixed_assets.organization_id from
--        properties.organization_id.
--      · payments.method_code from the legacy free-text `method`
--        (cash→cash, card→card_terminal, bank_transfer|transfer→bank_transfer,
--        payment_link→payment_link, anything else→other). `method` is kept:
--        folio.service still writes it; readers fall back to it when
--        method_code is NULL.
--      · pos_orders.business_date = closed_at (Europe/Madrid) for closed tickets.
--
-- Pre-checks run on the demo DB right before applying (all OK): no duplicate
-- (property, reservation, channel) commission accruals, no duplicate
-- (supplier, invoice_number) bills, no supplier bill status outside the enum,
-- every account code numeric, every account_type known, every journal line
-- resolves its account, no closed POS ticket without closed_at.
-- Contract of every new column/table: docs/runbooks/finanzas-contabilidad.md.
-- ============================================================================

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card_terminal', 'card_online', 'bank_transfer', 'payment_link', 'other');

-- CreateEnum
CREATE TYPE "SupplierBillStatus" AS ENUM ('draft', 'approved', 'posted', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "ExpensePaidWith" AS ENUM ('cash', 'card', 'bank');

-- CreateEnum
CREATE TYPE "FixedAssetStatus" AS ENUM ('active', 'fully_depreciated', 'disposed');

-- CreateEnum
CREATE TYPE "DepreciationRunStatus" AS ENUM ('draft', 'posted', 'reversed');

-- CreateEnum
CREATE TYPE "CashClosureStatus" AS ENUM ('open', 'closed', 'approved');

-- CreateEnum
CREATE TYPE "VatBook" AS ENUM ('emitidas', 'recibidas', 'bienes_inversion');

-- CreateEnum
CREATE TYPE "VatBookSourceType" AS ENUM ('invoice', 'rectification', 'simplified', 'supplier_bill', 'expense');

-- CreateEnum
CREATE TYPE "VatPeriodicity" AS ENUM ('quarterly', 'monthly');

-- CreateEnum
CREATE TYPE "VatRegime" AS ENUM ('general', 'redeme', 'recargo');

-- CreateEnum
CREATE TYPE "FinancialStatementKind" AS ENUM ('balance', 'pyg', 'ecpn', 'memoria', 'usali');

-- CreateEnum
CREATE TYPE "GestoriaExportFormat" AS ENUM ('csv_universal', 'contaplus_diario', 'a3', 'vat_books_csv');

-- AlterTable (hand-edited: kind/level/pgc_group added nullable, backfilled below, then SET NOT NULL)
ALTER TABLE "accounts" ADD COLUMN     "is_postable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" "AccountKind",
ADD COLUMN     "level" INTEGER,
ADD COLUMN     "pgc_group" INTEGER,
ADD COLUMN     "usali_department" TEXT,
ADD COLUMN     "usali_line" TEXT;

-- BackfillAccounts (kind from the legacy account_type; group = first digit; level = digits up to 3, 4 for sub-accounts)
UPDATE "accounts" SET
  "kind" = CASE "account_type"
    WHEN 'asset' THEN 'asset'::"AccountKind"
    WHEN 'liability' THEN 'liability'::"AccountKind"
    WHEN 'equity' THEN 'equity'::"AccountKind"
    WHEN 'revenue' THEN 'income'::"AccountKind"
    WHEN 'income' THEN 'income'::"AccountKind"
    ELSE 'expense'::"AccountKind"
  END,
  "pgc_group" = CASE WHEN "code" ~ '^[1-9]' THEN substr("code", 1, 1)::integer ELSE 0 END,
  "level" = LEAST(length(regexp_replace("code", '[^0-9]', '', 'g')), 4),
  "is_postable" = (LEAST(length(regexp_replace("code", '[^0-9]', '', 'g')), 4) >= 3)
WHERE "kind" IS NULL OR "level" IS NULL OR "pgc_group" IS NULL;

ALTER TABLE "accounts" ALTER COLUMN "kind" SET NOT NULL,
ALTER COLUMN "level" SET NOT NULL,
ALTER COLUMN "pgc_group" SET NOT NULL;

-- AlterTable
ALTER TABLE "commission_accruals" ADD COLUMN     "reversal_journal_entry_id" TEXT,
ADD COLUMN     "settled_at" TIMESTAMP(3),
ADD COLUMN     "settlement_journal_entry_id" TEXT;

-- AlterTable
ALTER TABLE "fixed_assets" ADD COLUMN     "account_code" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "coefficient_pct" DECIMAL(5,2),
ADD COLUMN     "depreciation_account_code" TEXT,
ADD COLUMN     "disposed_at" DATE,
ADD COLUMN     "expense_account_code" TEXT,
ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "residual_value" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "start_date" DATE,
ADD COLUMN     "status" "FixedAssetStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "supplier_bill_id" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "customer_required" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "series_code" TEXT,
ADD COLUMN     "simplified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "snapshot_json" JSONB;

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "description" TEXT,
ADD COLUMN     "entry_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "entry_number" INTEGER,
ADD COLUMN     "fiscal_year_code" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "reversal_of_id" TEXT,
ADD COLUMN     "reversed_by_id" TEXT;

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "account_code" TEXT,
ADD COLUMN     "cost_center_id" TEXT,
ADD COLUMN     "tax_base" DECIMAL(12,2),
ADD COLUMN     "tax_rate_code" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "client_request_id" TEXT,
ADD COLUMN     "journal_entry_id" TEXT,
ADD COLUMN     "method_code" "PaymentMethod",
ADD COLUMN     "reversal_of_id" TEXT;

-- AlterTable
ALTER TABLE "payroll_periods" ADD COLUMN     "journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "payment_journal_entry_id" TEXT,
ADD COLUMN     "posted_at" TIMESTAMP(3),
ADD COLUMN     "reversal_journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reversed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "business_date" DATE,
ADD COLUMN     "cash_closure_id" TEXT,
ADD COLUMN     "invoice_id" TEXT,
ADD COLUMN     "journal_entry_id" TEXT,
ADD COLUMN     "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable (hand-edited: status converted in place instead of DROP + ADD)
ALTER TABLE "supplier_bills" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "base_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "journal_entry_id" TEXT,
ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "paid_journal_entry_id" TEXT,
ADD COLUMN     "posted_at" TIMESTAMP(3),
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ConvertSupplierBillStatus (unknown legacy values fall back to draft before the cast)
UPDATE "supplier_bills" SET "status" = 'draft' WHERE "status" NOT IN ('draft', 'approved', 'posted', 'paid', 'cancelled');
ALTER TABLE "supplier_bills" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "supplier_bills" ALTER COLUMN "status" TYPE "SupplierBillStatus" USING ("status"::"SupplierBillStatus");
ALTER TABLE "supplier_bills" ALTER COLUMN "status" SET DEFAULT 'draft';

-- BackfillSupplierBillOrganization
UPDATE "supplier_bills" AS sb SET "organization_id" = p."organization_id"
FROM "properties" AS p
WHERE p."id" = sb."property_id" AND sb."organization_id" IS NULL;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country_code" TEXT NOT NULL DEFAULT 'ES',
ADD COLUMN     "default_expense_account_code" TEXT,
ADD COLUMN     "iban" TEXT,
ADD COLUMN     "nif_validated_at" TIMESTAMP(3),
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "province" TEXT,
ADD COLUMN     "retention_rate" DECIMAL(5,2),
ADD COLUMN     "retention_row_code" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ============================================================================
-- Data steps (hand-written, idempotent)
-- ============================================================================

-- BackfillJournalEntryDates: accounting date of the existing entries = the day they were projected.
UPDATE "journal_entries" SET "entry_date" = "posted_at"::date
WHERE "posted_at" IS NOT NULL AND "entry_number" IS NULL;

-- BackfillJournalEntryFiscalYear: no FiscalYear rows exist yet → calendar year of the accounting date.
UPDATE "journal_entries" SET "fiscal_year_code" = to_char("entry_date", 'YYYY')
WHERE "fiscal_year_code" IS NULL;

-- BackfillJournalEntryNumbers: sequence per (organization, fiscal year) in posting order; only rows still unnumbered.
UPDATE "journal_entries" AS je SET "entry_number" = numbered."n" + COALESCE(taken."max_n", 0)
FROM (
  SELECT "id", "organization_id", "fiscal_year_code",
         row_number() OVER (PARTITION BY "organization_id", "fiscal_year_code" ORDER BY "posted_at" NULLS LAST, "id") AS "n"
  FROM "journal_entries"
  WHERE "entry_number" IS NULL
) AS numbered
LEFT JOIN (
  SELECT "organization_id", "fiscal_year_code", max("entry_number") AS "max_n"
  FROM "journal_entries"
  WHERE "entry_number" IS NOT NULL
  GROUP BY "organization_id", "fiscal_year_code"
) AS taken
  ON taken."organization_id" = numbered."organization_id" AND taken."fiscal_year_code" = numbered."fiscal_year_code"
WHERE je."id" = numbered."id";

-- BackfillJournalLineAccountCodes (denormalised copy of accounts.code)
UPDATE "journal_lines" AS jl SET "account_code" = a."code"
FROM "accounts" AS a
WHERE a."id" = jl."account_id" AND jl."account_code" IS NULL;

-- BackfillFixedAssetOrganization
UPDATE "fixed_assets" AS fa SET "organization_id" = p."organization_id"
FROM "properties" AS p
WHERE p."id" = fa."property_id" AND fa."organization_id" IS NULL;

-- BackfillPaymentMethodCode (legacy free-text method → canonical enum; `method` is kept)
UPDATE "payments" SET "method_code" = CASE "method"
  WHEN 'cash' THEN 'cash'::"PaymentMethod"
  WHEN 'card' THEN 'card_terminal'::"PaymentMethod"
  WHEN 'bank_transfer' THEN 'bank_transfer'::"PaymentMethod"
  WHEN 'transfer' THEN 'bank_transfer'::"PaymentMethod"
  WHEN 'payment_link' THEN 'payment_link'::"PaymentMethod"
  ELSE 'other'::"PaymentMethod"
END
WHERE "method_code" IS NULL;

-- BackfillPosOrderBusinessDate (closed tickets: the local day they were closed)
UPDATE "pos_orders" SET "business_date" = ("closed_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid')::date
WHERE "business_date" IS NULL AND "closed_at" IS NOT NULL AND "status" = 'closed';

-- CreateTable
CREATE TABLE "usali_mappings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_prefix" TEXT NOT NULL,
    "usali_department" TEXT NOT NULL,
    "usali_line" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usali_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "periodicity" "VatPeriodicity" NOT NULL DEFAULT 'quarterly',
    "regime" "VatRegime" NOT NULL DEFAULT 'general',
    "prorrata_pct" DECIMAL(5,2),
    "tax_figure" TEXT NOT NULL DEFAULT 'IVA',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vat_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_book_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "book" "VatBook" NOT NULL,
    "date" DATE NOT NULL,
    "series" TEXT,
    "number" TEXT,
    "counterparty_nif" TEXT,
    "counterparty_name" TEXT,
    "base" DECIMAL(12,2) NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "quota" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "retention" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_figure" TEXT NOT NULL DEFAULT 'IVA',
    "surcharge_rate" DECIMAL(5,2),
    "surcharge_quota" DECIMAL(12,2),
    "source_type" "VatBookSourceType" NOT NULL,
    "source_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "deductible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_book_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bill_lines" (
    "id" TEXT NOT NULL,
    "supplier_bill_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "expense_account_code" TEXT NOT NULL,
    "base" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "quota" DECIMAL(12,2) NOT NULL,
    "retention" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cost_center_id" TEXT,
    "investment_good" BOOLEAN NOT NULL DEFAULT false,
    "fixed_asset_id" TEXT,

    CONSTRAINT "supplier_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "date" DATE NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "supplier_nif" TEXT,
    "concept" TEXT NOT NULL,
    "account_code" TEXT NOT NULL,
    "base" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "quota" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "paid_with" "ExpensePaidWith" NOT NULL,
    "vat_deductible" BOOLEAN NOT NULL DEFAULT true,
    "receipt_object_key" TEXT,
    "journal_entry_id" TEXT,
    "reversal_journal_entry_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "period" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "DepreciationRunStatus" NOT NULL DEFAULT 'draft',
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "reversal_journal_entry_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "depreciation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_lines" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "fixed_asset_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "accumulated_after" DECIMAL(12,2) NOT NULL,
    "net_book_value_after" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "depreciation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_closures" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "outlet_id" TEXT NOT NULL DEFAULT '*',
    "business_date" DATE NOT NULL,
    "status" "CashClosureStatus" NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "opening_float" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expected_cash" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "counted_cash" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "expected_by_method_json" JSONB NOT NULL DEFAULT '{}',
    "counted_by_method_json" JSONB NOT NULL DEFAULT '{}',
    "counts_json" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "opened_by" TEXT,
    "closed_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "journal_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_statement_snapshots" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "fiscal_year_id" TEXT,
    "kind" "FinancialStatementKind" NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "json" JSONB NOT NULL,
    "label" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" TEXT,

    CONSTRAINT "financial_statement_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gestoria_exports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "format" "GestoriaExportFormat" NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "object_key" TEXT,
    "inline" TEXT,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "validate_with_advisor" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gestoria_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usali_mappings_organization_id_active_priority_idx" ON "usali_mappings"("organization_id", "active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "usali_mappings_organization_id_account_prefix_key" ON "usali_mappings"("organization_id", "account_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "vat_settings_organization_id_key" ON "vat_settings"("organization_id");

-- CreateIndex
CREATE INDEX "vat_book_entries_organization_id_book_period_idx" ON "vat_book_entries"("organization_id", "book", "period");

-- CreateIndex
CREATE INDEX "vat_book_entries_organization_id_book_date_idx" ON "vat_book_entries"("organization_id", "book", "date");

-- CreateIndex
CREATE INDEX "vat_book_entries_organization_id_counterparty_nif_period_idx" ON "vat_book_entries"("organization_id", "counterparty_nif", "period");

-- CreateIndex
CREATE UNIQUE INDEX "vat_book_entries_organization_id_book_source_type_source_id_key" ON "vat_book_entries"("organization_id", "book", "source_type", "source_id", "rate");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_supplier_bill_id_idx" ON "supplier_bill_lines"("supplier_bill_id");

-- CreateIndex
CREATE INDEX "expenses_organization_id_date_idx" ON "expenses"("organization_id", "date");

-- CreateIndex
CREATE INDEX "expenses_property_id_date_idx" ON "expenses"("property_id", "date");

-- CreateIndex
CREATE INDEX "depreciation_runs_organization_id_status_idx" ON "depreciation_runs"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_runs_organization_id_period_key" ON "depreciation_runs"("organization_id", "period");

-- CreateIndex
CREATE INDEX "depreciation_lines_fixed_asset_id_idx" ON "depreciation_lines"("fixed_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_lines_run_id_fixed_asset_id_key" ON "depreciation_lines"("run_id", "fixed_asset_id");

-- CreateIndex
CREATE INDEX "cash_closures_property_id_status_idx" ON "cash_closures"("property_id", "status");

-- CreateIndex
CREATE INDEX "cash_closures_property_id_business_date_idx" ON "cash_closures"("property_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "cash_closures_property_id_outlet_id_business_date_key" ON "cash_closures"("property_id", "outlet_id", "business_date");

-- CreateIndex
CREATE INDEX "financial_statement_snapshots_organization_id_kind_generate_idx" ON "financial_statement_snapshots"("organization_id", "kind", "generated_at");

-- CreateIndex
CREATE INDEX "financial_statement_snapshots_fiscal_year_id_kind_idx" ON "financial_statement_snapshots"("fiscal_year_id", "kind");

-- CreateIndex
CREATE INDEX "gestoria_exports_organization_id_created_at_idx" ON "gestoria_exports"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "accounts_organization_id_kind_idx" ON "accounts"("organization_id", "kind");

-- CreateIndex
CREATE INDEX "accounts_organization_id_parent_id_idx" ON "accounts"("organization_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "commission_accruals_property_id_reservation_id_channel_code_key" ON "commission_accruals"("property_id", "reservation_id", "channel_code");

-- CreateIndex
CREATE INDEX "fixed_assets_organization_id_status_idx" ON "fixed_assets"("organization_id", "status");

-- CreateIndex
CREATE INDEX "invoices_property_id_series_code_issued_at_idx" ON "invoices"("property_id", "series_code", "issued_at");

-- CreateIndex
CREATE INDEX "journal_entries_organization_id_entry_date_idx" ON "journal_entries"("organization_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_organization_id_source_type_source_id_idx" ON "journal_entries"("organization_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "journal_entries_reversal_of_id_idx" ON "journal_entries"("reversal_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organization_id_fiscal_year_code_entry_numb_key" ON "journal_entries"("organization_id", "fiscal_year_code", "entry_number");

-- CreateIndex
CREATE INDEX "journal_lines_account_code_idx" ON "journal_lines"("account_code");

-- CreateIndex
CREATE INDEX "payments_reversal_of_id_idx" ON "payments"("reversal_of_id");

-- CreateIndex
CREATE INDEX "payments_property_id_method_code_created_at_idx" ON "payments"("property_id", "method_code", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_folio_id_client_request_id_key" ON "payments"("folio_id", "client_request_id");

-- CreateIndex
CREATE INDEX "pos_orders_invoice_id_idx" ON "pos_orders"("invoice_id");

-- CreateIndex
CREATE INDEX "pos_orders_cash_closure_id_idx" ON "pos_orders"("cash_closure_id");

-- CreateIndex
CREATE INDEX "supplier_bills_organization_id_status_idx" ON "supplier_bills"("organization_id", "status");

-- CreateIndex
CREATE INDEX "supplier_bills_organization_id_issue_date_idx" ON "supplier_bills"("organization_id", "issue_date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_organization_id_supplier_id_invoice_number_key" ON "supplier_bills"("organization_id", "supplier_id", "invoice_number");

-- CreateIndex
CREATE INDEX "suppliers_organization_id_tax_id_idx" ON "suppliers"("organization_id", "tax_id");

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_supplier_bill_id_fkey" FOREIGN KEY ("supplier_bill_id") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "depreciation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

