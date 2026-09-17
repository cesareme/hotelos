import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

// Tanda 7c · L0 (2026-09-17): the data contract of the Sage 200 accounting import
// that L1-L6 program against. No database: guards schema.prisma (7 additive
// models, the LedgerImportStatus enum, the `sage200` value of VatBookSourceType,
// JournalEntry / JournalLine WITHOUT new columns), the 12th migration folder
// (pure DDL, one single 'sage200' literal: the ALTER TYPE … ADD VALUE) and the
// wire catalogues of packages/shared (JOURNAL_SOURCE_TYPES, VatBookSourceTypeCode,
// ledger-import-types.ts re-exported from index.ts). Design:
// docs/design/FINANZAS-IMPORTACION-SAGE200.md §4.2, §4.6, §7.2.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("packages/database/prisma/schema.prisma");
const MIGRATION_FOLDER = "20260917110000_sage200_importacion";
const PREVIOUS_MIGRATION_FOLDER = "20260917100000_opera_modo_sombra";
const MIGRATION = `packages/database/prisma/migrations/${MIGRATION_FOLDER}/migration.sql`;
const migration = read(MIGRATION);
const accountingTypes = read("packages/shared/src/accounting-types.ts");
const fiscalTypes = read("packages/shared/src/fiscal-types.ts");
const sharedIndex = read("packages/shared/src/index.ts");
const ledgerImportTypes = read("packages/shared/src/ledger-import-types.ts");

const count = (source, re) => (source.match(re) ?? []).length;

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

// Field names of a model block, in order (comments, blank lines and @@ attributes excluded).
function fieldNames(block) {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
    .map((l) => l.split(/\s+/)[0]);
}

// Values of an `export const NAME = [ "a", "b" ] as const;` array in a TS source, doc comments stripped (no import).
function constArray(source, name) {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  assert.ok(match, `${name} declared as a readonly array`);
  const body = match[1].replace(/\/\*\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const NEW_MODELS = {
  LedgerImport: "ledger_imports",
  LedgerImportEntry: "ledger_import_entries",
  LedgerImportBalance: "ledger_import_balances",
  LedgerAccountMap: "ledger_account_maps",
  LedgerAnalyticsMap: "ledger_analytics_maps",
  LedgerThirdParty: "ledger_third_parties",
  LedgerReconciliation: "ledger_reconciliations"
};

// Pinned blocks (tests/finanzas-schema-contract.test.mjs:58-75): the import is ADDITIVE.
const JOURNAL_ENTRY_FIELDS = [
  "id", "organizationId", "propertyId", "sourceType", "sourceId", "status", "postedAt", "createdBy", "currencyCode", "fxRate",
  "fiscalYearId", "entryKind", "entryDate", "entryNumber", "fiscalYearCode", "description", "reference", "reversalOfId", "reversedById"
];
const JOURNAL_LINE_FIELDS = ["id", "journalEntryId", "accountId", "debit", "credit", "currency", "description", "accountCode", "costCenterId", "taxRateCode", "taxBase"];

describe("Sage 200 · contrato de datos (schema)", () => {
  it("declares the seven import models with their @@map and no foreign key besides the two import_id cascades", () => {
    for (const [model, table] of Object.entries(NEW_MODELS)) {
      const block = modelBlock(model);
      assert.match(block, new RegExp(`@@map\\("${table}"\\)`), `${model} → ${table}`);
      assert.match(block, /^\s+organizationId\s+String\s+@map\("organization_id"\)/m, `${model}.organizationId`);
    }
    assert.match(modelBlock("LedgerImportEntry"), /import\s+LedgerImport\s+@relation\(fields: \[importId\], references: \[id\], onDelete: Cascade\)/);
    assert.match(modelBlock("LedgerImportBalance"), /import\s+LedgerImport\s+@relation\(fields: \[importId\], references: \[id\], onDelete: Cascade\)/);
    for (const model of ["LedgerImport", "LedgerAccountMap", "LedgerAnalyticsMap", "LedgerThirdParty", "LedgerReconciliation"]) {
      assert.doesNotMatch(modelBlock(model), /@relation\(fields:/, `${model} has no FK (no FK to properties / suppliers / journal_entries)`);
    }
    // Relation lists live on the lote, not on JournalEntry / Property / Supplier.
    assert.match(modelBlock("LedgerImport"), /entries\s+LedgerImportEntry\[\]/);
    assert.match(modelBlock("LedgerImport"), /balances\s+LedgerImportBalance\[\]/);
  });

  it("LedgerImport: enum status, hash, kind / format / system as text, Decimal(14,2) totals, entry ids and reversal data", () => {
    const block = modelBlock("LedgerImport");
    assert.match(block, /status\s+LedgerImportStatus\s+@default\(draft\)/);
    assert.match(block, /system\s+String\n/, "system is text without a DB default (the service always writes it)");
    assert.doesNotMatch(block, /system\s+String\s+@default/);
    assert.match(block, /kind\s+String\n/);
    assert.match(block, /format\s+String\n/);
    assert.match(block, /contentHash\s+String\s+@map\("content_hash"\)/);
    assert.match(block, /legalEntityId\s+String\?\s+@map\("legal_entity_id"\)/);
    assert.match(block, /sourceCompanyCode\s+String\?\s+@map\("source_company_code"\)/);
    assert.match(block, /periodFrom\s+String\?\s+@map\("period_from"\)/);
    assert.match(block, /periodTo\s+String\?\s+@map\("period_to"\)/);
    for (const counter of ["rowCount", "entryCount", "skippedCount", "warningCount"]) assert.match(block, new RegExp(`${counter}\\s+Int\\s+@default\\(0\\)`), counter);
    assert.match(block, /mappingJson\s+Json\s+@default\("\{\}"\)/);
    assert.match(block, /warningsJson\s+Json\s+@default\("\[\]"\)/);
    assert.match(block, /totalDebit\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(14, 2\)/);
    assert.match(block, /totalCredit\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(14, 2\)/);
    assert.match(block, /journalEntryIds\s+String\[\]\s+@default\(\[\]\)/);
    assert.match(block, /reversalJournalEntryIds\s+String\[\]\s+@default\(\[\]\)/);
    for (const field of ["replacedById", "notes", "createdBy", "createdAt", "postedAt", "reversedAt", "reversedBy", "reversalReason"]) {
      assert.match(block, new RegExp(`^\\s+${field}\\s`, "m"), `LedgerImport.${field}`);
    }
    assert.match(block, /@@index\(\[organizationId, kind, status, periodFrom, periodTo\]\)/);
    assert.match(block, /@@index\(\[organizationId, contentHash\]\)/);
  });

  it("LedgerImportEntry / LedgerImportBalance: Sage key with period and propertyCode (\"SOC\" at society level), unique per import", () => {
    const entry = modelBlock("LedgerImportEntry");
    for (const field of ["importId", "sourceCompanyCode", "sourceFiscalYear", "sourcePeriod", "sourceEntryNumber", "sourceChannel", "entryDate", "propertyId", "propertyCode", "journalEntryId", "status", "entryKind", "lineCount", "debit", "credit", "sourceType", "sourceId", "warningsJson"]) {
      assert.match(entry, new RegExp(`^\\s+${field}\\s`, "m"), `LedgerImportEntry.${field}`);
    }
    assert.match(entry, /propertyCode\s+String\s+@map\("property_code"\)/, "propertyCode is NOT NULL (the unique key cannot rely on a NULL propertyId)");
    assert.match(entry, /entryDate\s+DateTime\s+@map\("entry_date"\)\s+@db\.Date/);
    assert.match(entry, /entryKind\s+String\s+@default\("normal"\)/);
    assert.match(entry, /debit\s+Decimal\s+@db\.Decimal\(14, 2\)/);
    assert.match(entry, /credit\s+Decimal\s+@db\.Decimal\(14, 2\)/);
    assert.match(entry, /@@unique\(\[importId, sourceCompanyCode, sourceFiscalYear, sourcePeriod, sourceEntryNumber, propertyCode\]\)/);
    assert.match(entry, /@@index\(\[organizationId, sourceFiscalYear, sourceEntryNumber\]\)/);
    assert.match(entry, /@@index\(\[journalEntryId\]\)/);

    const balance = modelBlock("LedgerImportBalance");
    for (const field of ["fiscalYearCode", "periodCode", "propertyId", "propertyCode", "sourceAccount", "sourceName", "accountCode"]) {
      assert.match(balance, new RegExp(`^\\s+${field}\\s`, "m"), `LedgerImportBalance.${field}`);
    }
    for (const amount of ["openingDebit", "openingCredit", "periodDebit", "periodCredit", "closingBalance"]) {
      assert.match(balance, new RegExp(`${amount}\\s+Decimal\\s+@default\\(0\\)\\s+@db\\.Decimal\\(14, 2\\)`), amount);
    }
    assert.match(balance, /@@unique\(\[importId, periodCode, propertyCode, sourceAccount\]\)/);
    assert.match(balance, /@@index\(\[organizationId, fiscalYearCode, periodCode\]\)/);
  });

  it("LedgerAccountMap / LedgerAnalyticsMap / LedgerThirdParty / LedgerReconciliation carry their natural keys", () => {
    const accountMap = modelBlock("LedgerAccountMap");
    assert.match(accountMap, /action\s+String\n/);
    assert.match(accountMap, /accountCode\s+String\?\s+@map\("account_code"\)/, "null only in block");
    assert.match(accountMap, /carryCounterparty\s+Boolean\s+@default\(true\)/);
    assert.match(accountMap, /usaliDepartment\s+String\?/);
    assert.match(accountMap, /usaliLine\s+String\?/);
    assert.match(accountMap, /updatedAt\s+DateTime\s+@updatedAt/);
    assert.match(accountMap, /@@unique\(\[organizationId, system, sourceAccount\]\)/);

    const analyticsMap = modelBlock("LedgerAnalyticsMap");
    assert.match(analyticsMap, /dimension\s+String\n/);
    assert.match(analyticsMap, /propertyId\s+String\?/);
    assert.match(analyticsMap, /costCentreCode\s+String\?\s+@map\("cost_centre_code"\)/);
    assert.match(analyticsMap, /@@unique\(\[organizationId, system, dimension, sourceCode\]\)/);

    const thirdParty = modelBlock("LedgerThirdParty");
    assert.match(thirdParty, /role\s+String\n/);
    assert.match(thirdParty, /taxId\s+String\?\s+@map\("tax_id"\)/);
    assert.match(thirdParty, /countryCode\s+String\s+@default\("ES"\)/);
    assert.match(thirdParty, /supplierId\s+String\?\s+@map\("supplier_id"\)/);
    assert.match(thirdParty, /@@unique\(\[organizationId, system, role, sourceCode\]\)/);
    assert.match(thirdParty, /@@index\(\[organizationId, taxId\]\)/);

    const reconciliation = modelBlock("LedgerReconciliation");
    assert.match(reconciliation, /importId\s+String\?\s+@map\("import_id"\)/);
    assert.match(reconciliation, /periodFrom\s+DateTime\s+@map\("period_from"\)\s+@db\.Date/);
    assert.match(reconciliation, /periodTo\s+DateTime\s+@map\("period_to"\)\s+@db\.Date/);
    assert.match(reconciliation, /sourceHash\s+String\s+@map\("source_hash"\)/);
    assert.match(reconciliation, /accountsCompared\s+Int\s+@map\("accounts_compared"\)/);
    assert.match(reconciliation, /differenceCount\s+Int\s+@map\("difference_count"\)/);
    assert.match(reconciliation, /rowsJson\s+Json\s+@default\("\[\]"\)/);
    assert.match(reconciliation, /summaryJson\s+Json\s+@default\("\{\}"\)/);
    assert.match(reconciliation, /@@index\(\[organizationId, periodFrom, periodTo, createdAt\]\)/);
  });

  it("adds LedgerImportStatus and the sage200 value of VatBookSourceType; never a @default with the new value", () => {
    assert.deepEqual(enumBlock("LedgerImportStatus"), ["draft", "posted", "reversed"]);
    assert.deepEqual(enumBlock("VatBookSourceType"), ["invoice", "rectification", "simplified", "supplier_bill", "expense", "sage200"]);
    assert.doesNotMatch(schema, /@default\("sage200"\)/, "no column defaults to the new value (the migration only ADDs it)");
    assert.doesNotMatch(schema, /@default\(sage200\)/);
  });

  it("JournalEntry and JournalLine gain NO column (pinned blocks) and the sourceType catalogue comment names both import types", () => {
    assert.deepEqual(fieldNames(modelBlock("JournalEntry")), JOURNAL_ENTRY_FIELDS);
    assert.deepEqual(fieldNames(modelBlock("JournalLine")), JOURNAL_LINE_FIELDS);
    const entry = modelBlock("JournalEntry");
    assert.match(entry, /sourceType\s+String\s+@map\("source_type"\)/);
    assert.match(entry, /@@unique\(\[organizationId, fiscalYearCode, entryNumber\]\)/);
    assert.match(entry, /@@index\(\[organizationId, sourceType, sourceId\]\)/);
    const catalogue = /\/\/\/ Asiento del libro diario[\s\S]*?model JournalEntry \{/.exec(schema);
    assert.ok(catalogue, "the /// catalogue comment precedes model JournalEntry");
    assert.match(catalogue[0], /sage200_journal · sage200_balance/);
    assert.match(modelBlock("VatBookEntry"), /@@unique\(\[organizationId, book, sourceType, sourceId, rate\]\)/, "VatBookEntry unique intact");
  });
});

describe("Sage 200 · migración 12.ª (DDL puro, generada por prisma migrate diff)", () => {
  it("exists after the OPERA migration and documents how it was generated", () => {
    assert.ok(existsSync(new URL(`../${MIGRATION}`, import.meta.url)));
    assert.ok(MIGRATION_FOLDER > PREVIOUS_MIGRATION_FOLDER, "newer than 20260917100000_opera_modo_sombra");
    // The banner quotes the literal command (wrapped with backslash continuations).
    assert.match(migration, /corepack pnpm exec prisma migrate diff \\/);
    assert.match(migration, /--from-schema-datasource prisma\/schema\.prisma \\/);
    assert.match(migration, /--to-schema-datamodel prisma\/schema\.prisma --script/);
    assert.match(migration, /VERBATIM/);
    assert.match(migration, /ADITIVA/);
    assert.match(migration, /docs\/design\/FINANZAS-IMPORTACION-SAGE200\.md §4\.2/);
    assert.match(migration, /11 migraciones aplicadas/);
    assert.match(migration, /drift 0/);
    assert.match(migration, /112 asientos \/ 599 líneas/);
    assert.match(migration, /0 fiscal_years/);
  });

  it("creates the 7 tables, 1 enum, 2 cascade FKs and adds the enum value exactly once (no other 'sage200' literal, no data step)", () => {
    for (const table of Object.values(NEW_MODELS)) {
      assert.match(migration, new RegExp(`^CREATE TABLE "${table}" \\($`, "m"), `CREATE TABLE ${table}`);
    }
    assert.equal(count(migration, /^CREATE TABLE "/gm), 7);
    assert.equal(count(migration, /^CREATE TYPE "/gm), 1);
    assert.match(migration, /^CREATE TYPE "LedgerImportStatus" AS ENUM \('draft', 'posted', 'reversed'\);$/m);
    assert.equal(count(migration, /'sage200'/g), 1, "the only 'sage200' literal is the ADD VALUE (55P04: a value added in a transaction cannot be used in it)");
    assert.match(migration, /^ALTER TYPE "VatBookSourceType" ADD VALUE 'sage200';$/m);
    assert.doesNotMatch(migration, /DEFAULT 'sage200'/);
    assert.equal(count(migration, /ADD CONSTRAINT "\w+" FOREIGN KEY/g), 2);
    assert.match(migration, /"ledger_import_entries_import_id_fkey" FOREIGN KEY \("import_id"\) REFERENCES "ledger_imports"\("id"\) ON DELETE CASCADE/);
    assert.match(migration, /"ledger_import_balances_import_id_fkey" FOREIGN KEY \("import_id"\) REFERENCES "ledger_imports"\("id"\) ON DELETE CASCADE/);
    assert.match(migration, /CREATE UNIQUE INDEX "ledger_import_entries_import_id_source_company_code_source__key" ON "ledger_import_entries"\("import_id", "source_company_code", "source_fiscal_year", "source_period", "source_entry_number", "property_code"\)/);
    assert.match(migration, /CREATE UNIQUE INDEX "ledger_import_balances_import_id_period_code_property_code__key"/);
    assert.match(migration, /CREATE UNIQUE INDEX "ledger_account_maps_organization_id_system_source_account_key"/);
    assert.match(migration, /CREATE UNIQUE INDEX "ledger_analytics_maps_organization_id_system_dimension_sour_key"/);
    assert.match(migration, /CREATE UNIQUE INDEX "ledger_third_parties_organization_id_system_role_source_cod_key"/);
    // Additive: nothing existing is touched and there is no data step.
    assert.doesNotMatch(migration, /^(DROP|INSERT|UPDATE|DELETE|CREATE EXTENSION|CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER)/m);
    assert.doesNotMatch(migration, /ALTER TABLE "(journal_entries|journal_lines|vat_book_entries|accounts|fiscal_years)"/);
    assert.doesNotMatch(migration, /^ALTER TABLE "\w+" (ADD|DROP|ALTER) COLUMN/m);
  });
});

describe("Sage 200 · tipos wire (@hotelos/shared)", () => {
  it("JOURNAL_SOURCE_TYPES gains sage200_journal and sage200_balance after pms_shadow_revenue", () => {
    const sourceTypes = constArray(accountingTypes, "JOURNAL_SOURCE_TYPES");
    assert.ok(sourceTypes.includes("sage200_journal"));
    assert.ok(sourceTypes.includes("sage200_balance"));
    assert.equal(sourceTypes.indexOf("sage200_journal"), sourceTypes.indexOf("pms_shadow_revenue") + 1);
    assert.equal(sourceTypes.indexOf("sage200_balance"), sourceTypes.indexOf("sage200_journal") + 1);
    assert.match(accountingTypes, /Tanda 7c: diario importado de Sage 200/);
    assert.match(accountingTypes, /Tanda 7c: saldos importados por periodo/);
  });

  it("VatBookSourceTypeCode accepts sage200 and index.ts re-exports ledger-import-types", () => {
    assert.match(fiscalTypes, /export type VatBookSourceTypeCode = "invoice" \| "rectification" \| "simplified" \| "supplier_bill" \| "expense" \| "sage200";/);
    assert.match(sharedIndex, /^export \* from "\.\/ledger-import-types\.js";$/m);
    assert.match(sharedIndex, /Tanda 7c/);
  });

  it("LEDGER_IMPORT_KINDS are exactly the six --type values of the CLI, plus the formats, source types and limits of the design", () => {
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_IMPORT_KINDS"), ["plan", "fiscal_years", "journal", "vat_books", "third_parties", "balances"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_IMPORT_SYSTEMS"), ["sage200"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_IMPORT_FORMATS"), ["sage_excel", "sage_ime_csv", "sage_xml", "canonical_csv", "canonical_json"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_IMPORT_STATUSES"), ["draft", "posted", "reversed"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_IMPORT_ENTRY_STATUSES"), ["draft", "posted", "skipped_native", "skipped_existing", "unmapped", "unbalanced", "error"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_ACCOUNT_MAP_ACTIONS"), ["map", "map_by_rate", "create", "collapse", "block"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_ANALYTICS_DIMENSIONS"), ["canal", "delegacion", "departamento", "seccion", "proyecto"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_UNASSIGNED_POLICIES"), ["block", "office"]);
    assert.deepEqual(constArray(ledgerImportTypes, "LEDGER_RECONCILIATION_CLASSIFICATIONS"), ["amount_diff", "native_only", "missing_in_ledger", "vat_diff"]);
    assert.match(ledgerImportTypes, /journal: "sage200_journal"/);
    assert.match(ledgerImportTypes, /balance: "sage200_balance"/);
    assert.match(ledgerImportTypes, /as const satisfies Record<string, JournalSourceType>/);
    assert.match(ledgerImportTypes, /export const LEDGER_VAT_BOOK_SOURCE_TYPE = "sage200" as const satisfies VatBookSourceTypeCode;/);
    assert.match(ledgerImportTypes, /export const LEDGER_IMPORT_MAX_BYTES = 20 \* 1024 \* 1024;/);
    assert.match(ledgerImportTypes, /export const LEDGER_IMPORT_MAX_BASE64_CHARS = 28 \* 1024 \* 1024;/);
    assert.match(ledgerImportTypes, /export const LEDGER_IMPORT_MAX_ROWS = 250_000;/);
    assert.match(ledgerImportTypes, /export const LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH = 20_000;/);
    assert.match(ledgerImportTypes, /export const LEDGER_IMPORT_MAX_LINES_PER_ENTRY = 500;/);
    assert.match(ledgerImportTypes, /consolidated: "0\.00"/);
    assert.match(ledgerImportTypes, /perCentrePerSplitEntry: "0\.01"/);
    assert.match(ledgerImportTypes, /vatPerRate: "0\.01"/);
  });

  it("LEDGER_IMPORT_ERROR_CODES cover §7.2 (plus the engine codes) and every code has a Spanish label", () => {
    const codes = constArray(ledgerImportTypes, "LEDGER_IMPORT_ERROR_CODES");
    for (const code of [
      "VALIDATION_ERROR", "LEDGER_IMPORT_INVALID", "LEDGER_IMPORT_FORMAT_UNKNOWN", "LEDGER_IMPORT_XML_UNSUPPORTED", "LEDGER_IMPORT_KIND_MISMATCH",
      "LEDGER_IMPORT_EMPTY", "LEDGER_IMPORT_TOO_LARGE", "LEDGER_IMPORT_TOO_MANY_ROWS", "LEDGER_IMPORT_TOO_MANY_ENTRIES", "LEDGER_IMPORT_COMPANY_MISMATCH",
      "LEDGER_IMPORT_ACCOUNT_UNMAPPED", "LEDGER_IMPORT_ACCOUNT_CODE_INVALID", "LEDGER_IMPORT_ANALYTICS_UNMAPPED", "LEDGER_IMPORT_CENTRE_REQUIRED",
      "LEDGER_IMPORT_UNBALANCED", "LEDGER_IMPORT_YEAR_CODE_INVALID", "LEDGER_IMPORT_MAP_INVALID", "LEDGER_IMPORT_DUPLICATE", "LEDGER_IMPORT_OVERLAP",
      "LEDGER_IMPORT_ENTRY_EXISTS", "LEDGER_IMPORT_ALREADY_POSTED", "LEDGER_IMPORT_REVERSED", "LEDGER_IMPORT_NOT_POSTED", "LEDGER_IMPORT_VAT_SETTINGS_MISSING",
      "LEDGER_IMPORT_NOT_FOUND", "LEDGER_RECONCILIATION_NOT_FOUND", "FISCAL_YEAR_CLOSED_FROM_IMPORT",
      "ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_POSTABLE", "WORK_CENTER_REQUIRED", "PROPERTY_NOT_FOUND", "FISCAL_PERIOD_CLOSED", "FISCAL_YEAR_CLOSED", "JOURNAL_UNBALANCED"
    ]) {
      assert.ok(codes.includes(code), `error code ${code}`);
    }
    assert.equal(new Set(codes).size, codes.length, "no duplicated code");
    assert.match(ledgerImportTypes, /export type LedgerImportErrorCode = \(typeof LEDGER_IMPORT_ERROR_CODES\)\[number\];/);
    const labels = /export const LEDGER_IMPORT_ERROR_LABELS_ES: Readonly<Record<LedgerImportErrorCode, string>> = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(ledgerImportTypes);
    assert.ok(labels, "LEDGER_IMPORT_ERROR_LABELS_ES declared as Record<LedgerImportErrorCode, string>");
    for (const code of codes) assert.match(labels[1], new RegExp(`^\\s+${code}: "`, "m"), `label for ${code}`);
    // Names reserved by other catalogues are not re-declared here (TS2308 on the star exports).
    for (const reserved of ["LEDGER_ERROR_CODES", "LedgerErrorCode", "PmsShadowReconciliationRow", "MoneyString", "IsoDate", "JournalSourceType"]) {
      assert.doesNotMatch(ledgerImportTypes, new RegExp(`^export (const|type|function) ${reserved}\\b`, "m"), `${reserved} not re-declared`);
    }
  });

  it("declares the wire DTOs of §7 (preview, lote, mapas, reconciliación, plantilla)", () => {
    for (const type of [
      "LedgerImportPreviewBody", "LedgerImportMappingInput", "LedgerAccountMapDto", "LedgerAnalyticsMapDto", "LedgerImportPreview", "LedgerImportCreateBody",
      "LedgerImportCreateResult", "LedgerImportRecord", "LedgerImportEntryDto", "LedgerImportDetail", "LedgerImportBalanceDto", "LedgerImportListQuery",
      "LedgerImportReverseBody", "LedgerImportPostBody", "LedgerAccountMapResponse", "LedgerAnalyticsMapResponse", "LedgerReconciliationBody",
      "LedgerReconciliationRow", "LedgerReconciliationDto", "LedgerReconciliationListQuery", "LedgerImportTemplateQuery"
    ]) {
      assert.match(ledgerImportTypes, new RegExp(`^export type ${type} = `, "m"), `type ${type}`);
    }
    assert.match(ledgerImportTypes, /^import type \{[^}]*\} from "\.\/accounting-types\.js";/m);
    assert.doesNotMatch(ledgerImportTypes, /^import (?!type)/m, "type-only imports (no runtime dependency)");
  });
});
