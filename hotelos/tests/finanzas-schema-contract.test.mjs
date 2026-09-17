import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

// Finanzas · lote schema (2026-09-15): the data contract the other finance
// batches program against. No database: guards schema.prisma, the migration
// folder, the chart-of-accounts service and the runbook that documents them.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("packages/database/prisma/schema.prisma");
const MIGRATION = "packages/database/prisma/migrations/20260915140000_finanzas_contabilidad_pgc/migration.sql";
const migration = read(MIGRATION);
const service = read("apps/api/src/modules/accounting/chart-of-accounts.service.ts");
const cli = read("apps/api/src/scripts/accounting-provision-chart.ts");
const runbook = read("docs/runbooks/finanzas-contabilidad.md");

function modelBlock(name) {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  assert.ok(match, `model ${name} exists`);
  return match[1];
}

function enumBlock(name) {
  const match = new RegExp(`^enum ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  assert.ok(match, `enum ${name} exists`);
  return match[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
}

describe("Finanzas · contrato de datos (schema)", () => {
  it("declares the finance enums with the agreed values", () => {
    assert.deepEqual(enumBlock("AccountKind"), ["asset", "liability", "equity", "income", "expense"]);
    assert.deepEqual(enumBlock("PaymentMethod"), ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"]);
    assert.deepEqual(enumBlock("SupplierBillStatus"), ["draft", "approved", "posted", "paid", "cancelled"]);
    assert.deepEqual(enumBlock("ExpensePaidWith"), ["cash", "card", "bank"]);
    assert.deepEqual(enumBlock("FixedAssetStatus"), ["active", "fully_depreciated", "disposed"]);
    assert.deepEqual(enumBlock("DepreciationRunStatus"), ["draft", "posted", "reversed"]);
    assert.deepEqual(enumBlock("CashClosureStatus"), ["open", "closed", "approved"]);
    assert.deepEqual(enumBlock("VatBook"), ["emitidas", "recibidas", "bienes_inversion"]);
    // Tanda 7c (Sage 200): «sage200» = filas de libro importadas del Libro Registro de IVA de Sage.
    assert.deepEqual(enumBlock("VatBookSourceType"), ["invoice", "rectification", "simplified", "supplier_bill", "expense", "sage200"]);
    assert.deepEqual(enumBlock("VatPeriodicity"), ["quarterly", "monthly"]);
    assert.deepEqual(enumBlock("VatRegime"), ["general", "redeme", "recargo"]);
    assert.deepEqual(enumBlock("FinancialStatementKind"), ["balance", "pyg", "ecpn", "memoria", "usali"]);
    assert.deepEqual(enumBlock("GestoriaExportFormat"), ["csv_universal", "contaplus_diario", "a3", "vat_books_csv"]);
  });

  it("Account carries kind/group/level/isPostable/USALI defaults and keeps the legacy accountType", () => {
    const block = modelBlock("Account");
    assert.match(block, /accountType\s+String\s+@map\("account_type"\)/);
    assert.match(block, /kind\s+AccountKind\n/);
    assert.match(block, /group\s+Int\s+@map\("pgc_group"\)/);
    assert.match(block, /level\s+Int\n/);
    assert.match(block, /isPostable\s+Boolean\s+@default\(true\)/);
    assert.match(block, /usaliDepartment\s+String\?/);
    assert.match(block, /usaliLine\s+String\?/);
    assert.match(block, /@@unique\(\[organizationId, code\]\)/);
  });

  it("JournalEntry has the accounting date, per-year numbering (unique), description, reference and reversal links; sourceType stays text", () => {
    const block = modelBlock("JournalEntry");
    assert.match(block, /entryDate\s+DateTime\s+@default\(now\(\)\)\s+@map\("entry_date"\)\s+@db\.Date/);
    assert.match(block, /entryNumber\s+Int\?\s+@map\("entry_number"\)/);
    assert.match(block, /fiscalYearCode\s+String\?\s+@map\("fiscal_year_code"\)/);
    assert.match(block, /description\s+String\?/);
    assert.match(block, /reference\s+String\?/);
    assert.match(block, /reversalOfId\s+String\?\s+@map\("reversal_of_id"\)/);
    assert.match(block, /reversedById\s+String\?\s+@map\("reversed_by_id"\)/);
    assert.match(block, /sourceType\s+String\s+@map\("source_type"\)/, "legacy writers type sourceType as string");
    assert.match(block, /@@unique\(\[organizationId, fiscalYearCode, entryNumber\]\)/);
    assert.match(block, /@@index\(\[organizationId, sourceType, sourceId\]\)/);
    const lines = modelBlock("JournalLine");
    assert.match(lines, /accountCode\s+String\?\s+@map\("account_code"\)/);
    assert.match(lines, /costCenterId\s+String\?/);
    assert.match(lines, /taxRateCode\s+String\?/);
    assert.match(lines, /taxBase\s+Decimal\?\s+@map\("tax_base"\)\s+@db\.Decimal\(12, 2\)/);
  });

  it("declares the new finance models with their natural keys", () => {
    assert.match(modelBlock("UsaliMapping"), /@@unique\(\[organizationId, accountPrefix\]\)/);
    assert.match(modelBlock("VatSettings"), /organizationId\s+String\s+@unique/);
    const vat = modelBlock("VatBookEntry");
    assert.match(vat, /@@unique\(\[organizationId, book, sourceType, sourceId, rate\]\)/);
    for (const field of ["book", "date", "series", "number", "counterpartyNif", "counterpartyName", "base", "rate", "quota", "total", "retention", "period", "deductible"]) {
      assert.match(vat, new RegExp(`^\\s+${field}\\s`, "m"), `VatBookEntry.${field}`);
    }
    const bill = modelBlock("SupplierBill");
    assert.match(bill, /organizationId\s+String\?/);
    assert.match(bill, /status\s+SupplierBillStatus\s+@default\(draft\)/);
    assert.match(bill, /journalEntryId\s+String\?/);
    assert.match(bill, /paidJournalEntryId\s+String\?/);
    assert.match(bill, /lines\s+SupplierBillLine\[\]/);
    assert.match(bill, /@@unique\(\[organizationId, supplierId, invoiceNumber\]\)/);
    const line = modelBlock("SupplierBillLine");
    for (const field of ["description", "expenseAccountCode", "base", "taxRate", "quota", "retention", "investmentGood"]) assert.match(line, new RegExp(`^\\s+${field}\\s`, "m"));
    assert.match(line, /@relation\(fields: \[supplierBillId\], references: \[id\], onDelete: Cascade\)/);
    const expense = modelBlock("Expense");
    for (const field of ["date", "supplierName", "supplierNif", "concept", "accountCode", "base", "taxRate", "quota", "total", "journalEntryId"]) assert.match(expense, new RegExp(`^\\s+${field}\\s`, "m"));
    assert.match(expense, /paidWith\s+ExpensePaidWith/);
    const asset = modelBlock("FixedAsset");
    for (const field of ["accountCode", "depreciationAccountCode", "expenseAccountCode", "coefficientPct", "startDate", "residualValue"]) assert.match(asset, new RegExp(`^\\s+${field}\\s`, "m"));
    assert.match(asset, /status\s+FixedAssetStatus\s+@default\(active\)/);
    assert.match(modelBlock("DepreciationRun"), /@@unique\(\[organizationId, period\]\)/);
    assert.match(modelBlock("DepreciationLine"), /@@unique\(\[runId, fixedAssetId\]\)/);
    const closure = modelBlock("CashClosure");
    for (const field of ["outletId", "businessDate", "openedAt", "closedAt", "expectedCash", "countedCash", "difference", "countsJson", "notes", "closedBy", "journalEntryId"]) assert.match(closure, new RegExp(`^\\s+${field}\\s`, "m"));
    assert.match(closure, /@@unique\(\[propertyId, outletId, businessDate\]\)/);
    assert.match(modelBlock("FinancialStatementSnapshot"), /kind\s+FinancialStatementKind/);
    assert.match(modelBlock("GestoriaExport"), /format\s+GestoriaExportFormat/);
  });

  it("extends Invoice, Payment, PosOrder, Supplier, PayrollPeriod and CommissionAccrual as agreed", () => {
    const invoice = modelBlock("Invoice");
    assert.match(invoice, /snapshotJson\s+Json\?/);
    assert.match(invoice, /seriesCode\s+String\?/);
    assert.match(invoice, /simplified\s+Boolean\s+@default\(false\)/);
    assert.match(invoice, /customerRequired\s+Boolean\s+@default\(true\)/);
    assert.match(invoice, /issuerTaxId\s+String\?/);
    assert.match(invoice, /issuerLegalName\s+String\?/);
    const payment = modelBlock("Payment");
    assert.match(payment, /clientRequestId\s+String\?/);
    assert.match(payment, /methodCode\s+PaymentMethod\?/);
    assert.match(payment, /method\s+String\n/, "legacy method stays: folio.service still writes it");
    assert.match(payment, /reversalOfId\s+String\?/);
    assert.match(payment, /journalEntryId\s+String\?/);
    assert.match(payment, /@@unique\(\[folioId, clientRequestId\]\)/);
    const pos = modelBlock("PosOrder");
    for (const field of ["invoiceId", "journalEntryId", "cashClosureId", "taxTotal", "businessDate"]) assert.match(pos, new RegExp(`^\\s+${field}\\s`, "m"));
    const supplier = modelBlock("Supplier");
    for (const field of ["nifValidatedAt", "address", "postalCode", "city", "province", "countryCode", "iban", "defaultExpenseAccountCode", "retentionRate", "retentionRowCode"]) assert.match(supplier, new RegExp(`^\\s+${field}\\s`, "m"));
    const payroll = modelBlock("PayrollPeriod");
    assert.match(payroll, /journalEntryIds\s+String\[\]\s+@default\(\[\]\)/);
    assert.match(payroll, /reversalJournalEntryIds\s+String\[\]\s+@default\(\[\]\)/);
    assert.match(payroll, /paymentJournalEntryId\s+String\?/);
    const commission = modelBlock("CommissionAccrual");
    assert.match(commission, /reversalJournalEntryId\s+String\?/);
    assert.match(commission, /@@unique\(\[propertyId, reservationId, channelCode\]\)/);
    assert.match(schema, /PENDIENTE PSP[\s\S]*model PaymentProviderConnection/);
    assert.match(schema, /PENDIENTE PSP[\s\S]*model PaymentIntent/);
  });
});

describe("Finanzas · migración revisada a mano", () => {
  it("exists after the baseline, documents its edits and keeps the hand-written data steps", () => {
    assert.ok(existsSync(new URL(`../${MIGRATION}`, import.meta.url)));
    assert.match(migration, /migrate diff --from-schema-datasource/);
    assert.match(migration, /reviewed by hand/);
    // accounts.kind/level/pgc_group: nullable → backfill → NOT NULL (never a bare NOT NULL ADD COLUMN).
    assert.doesNotMatch(migration, /ADD COLUMN\s+"kind" "AccountKind" NOT NULL/);
    assert.match(migration, /-- BackfillAccounts/);
    assert.match(migration, /WHEN 'revenue' THEN 'income'::"AccountKind"/);
    assert.match(migration, /ALTER TABLE "accounts" ALTER COLUMN "kind" SET NOT NULL/);
    // supplier_bills.status converted in place, not dropped.
    assert.doesNotMatch(migration, /DROP COLUMN "status"/);
    assert.match(migration, /ALTER COLUMN "status" TYPE "SupplierBillStatus" USING \("status"::"SupplierBillStatus"\)/);
    // Data steps.
    for (const step of [
      "BackfillJournalEntryDates",
      "BackfillJournalEntryFiscalYear",
      "BackfillJournalEntryNumbers",
      "BackfillJournalLineAccountCodes",
      "BackfillSupplierBillOrganization",
      "BackfillFixedAssetOrganization",
      "BackfillPaymentMethodCode",
      "BackfillPosOrderBusinessDate"
    ]) {
      assert.match(migration, new RegExp(`-- ${step}`), `${step} present`);
    }
    assert.match(migration, /row_number\(\) OVER \(PARTITION BY "organization_id", "fiscal_year_code" ORDER BY "posted_at" NULLS LAST, "id"\)/);
    const numberingIndex = migration.indexOf('CREATE UNIQUE INDEX "journal_entries_organization_id_fiscal_year_code_entry_numb_key"');
    assert.ok(numberingIndex > migration.indexOf("-- BackfillJournalEntryNumbers"), "the unique index is created after the numbering");
    assert.match(migration, /WHEN 'card' THEN 'card_terminal'::"PaymentMethod"/);
    // Every new table and enum is created by this migration.
    for (const table of ["usali_mappings", "vat_settings", "vat_book_entries", "supplier_bill_lines", "expenses", "depreciation_runs", "depreciation_lines", "cash_closures", "financial_statement_snapshots", "gestoria_exports"]) {
      assert.match(migration, new RegExp(`^CREATE TABLE "${table}" \\(`, "m"), `CREATE TABLE ${table}`);
    }
    assert.equal((migration.match(/^CREATE TYPE "/gm) ?? []).length, 13);
    assert.equal((migration.match(/ADD CONSTRAINT "\w+" FOREIGN KEY/g) ?? []).length, 2);
  });
});

describe("Finanzas · plantilla PGC Pymes hotelero y provisionador", () => {
  it("exposes the template, the canonical account list, the idempotent provisioner and the CLI", () => {
    assert.match(service, /export const CHART_TEMPLATE_CODE = "pgc_pymes_hotelero_v1"/);
    assert.match(service, /export const PGC_PYMES_HOTEL_TEMPLATE/);
    assert.match(service, /export const CANONICAL_RULE_ACCOUNT_CODES/);
    assert.match(service, /export function validateChartTemplate/);
    assert.match(service, /export async function provisionOrganizationChart/);
    assert.match(service, /skipDuplicates: true/, "createMany never duplicates");
    assert.doesNotMatch(service, /account\.delete/, "the provisioner never deletes");
    for (const code of ["705.1", "705.2", "705.3", "705.4", "477.21", "477.10", "477.04", "472.21", "472.10", "472.04", "5721", "5722", "629.1", "4759", "4750", "4751", "4700", "681", "281", "640", "642", "476", "465", "129"]) {
      assert.match(service, new RegExp(`A\\("${code.replace(".", "\\.")}", `), `template has ${code}`);
    }
    assert.match(cli, /--apply/);
    assert.match(cli, /--confirm/);
    assert.match(cli, /ACCOUNTING_CHART_PROVISIONED/);
    assert.match(cli, /provisionOrganizationChart\(organizationId, \{ dryRun: !flags\.apply \}\)/);
  });
});

describe("Finanzas · runbook (contrato de datos)", () => {
  it("documents every model, enum, the canonical rules and the writer/reader matrix", () => {
    assert.match(runbook, /## 1\. Contrato de datos/);
    assert.match(runbook, /## 2\. Reglas contables canónicas/);
    assert.match(runbook, /## 3\. Quién escribe y quién lee cada tabla/);
    assert.match(runbook, /## 4\. USALI/);
    for (const model of ["Account", "UsaliMapping", "JournalEntry", "JournalLine", "VatSettings", "VatBookEntry", "Invoice", "Payment", "PosOrder", "CashClosure", "Supplier", "SupplierBill", "SupplierBillLine", "Expense", "FixedAsset", "DepreciationRun", "DepreciationLine", "PayrollPeriod", "CommissionAccrual", "FinancialStatementSnapshot", "GestoriaExport"]) {
      assert.match(runbook, new RegExp(`\\*\\*\`${model}\`\\*\\*`), `runbook documents ${model}`);
    }
    for (const enumName of ["AccountKind", "PaymentMethod", "SupplierBillStatus", "ExpensePaidWith", "FixedAssetStatus", "DepreciationRunStatus", "CashClosureStatus", "VatBook", "VatBookSourceType", "VatPeriodicity", "VatRegime", "FinancialStatementKind", "GestoriaExportFormat"]) {
      assert.match(runbook, new RegExp(`\`${enumName}\``), `runbook documents ${enumName}`);
    }
    // fix:ledger t6#4 (2026-09-16): the customer receivable is the sub-account 4300 (430 is its header).
    assert.match(runbook, /D 4300 \(total\) \/ H 705\.x/);
    assert.match(runbook, /D 681 \/ H 281x/);
    assert.match(runbook, /nunca borrar/);
    assert.match(runbook, /20260915140000_finanzas_contabilidad_pgc/);
    assert.match(runbook, /accounting-provision-chart\.ts/);
  });
});
