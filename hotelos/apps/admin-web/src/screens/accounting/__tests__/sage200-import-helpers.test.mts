import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { LedgerAccountMapDto, LedgerImportEntryDto, LedgerImportPreview, LedgerImportRecord, LedgerReconciliationDto, LedgerReconciliationRow } from "@hotelos/shared";
import {
  ACCOUNT_ACTION_LABELS,
  ANALYTICS_DIMENSION_LABELS,
  COST_CENTRE_LABELS,
  ENTRY_KIND_LABELS,
  ENTRY_STATUS_LABELS,
  IMPORT_ACCEPT,
  IMPORT_KIND_LABELS,
  IMPORT_KIND_OPTIONS,
  IMPORT_MAX_BYTES,
  IMPORT_REPORT_HEADER,
  IMPORT_STATUS_LABELS,
  IMPORT_STEPS,
  IMPORT_VIEWS,
  RECONCILIATION_CSV_HEADER,
  RECON_CLASSIFICATION_LABELS,
  RECON_STATUS_LABELS,
  SAGE200_SYSTEM_ACTOR_LABEL,
  THIRD_PARTY_PAGE_LIMIT,
  THIRD_PARTY_QUERY_MAX,
  THIRD_PARTY_ROLE_FILTER_OPTIONS,
  THIRD_PARTY_ROLE_LABELS,
  USALI_DEPARTMENT_LABELS,
  accountActionOptions,
  accountRowIssue,
  analyticsRowKey,
  base64OfArrayBuffer,
  blockedAccountDto,
  buildImportReportCsv,
  buildReconciliationCsv,
  canPostImport,
  canReverseImport,
  centreRequiredLine,
  closingDetectedLine,
  costCentreOptions,
  csvCell,
  detectFormatFromName,
  entryLine,
  entryStatusTone,
  existingLine,
  fileSizeLabel,
  formatByMonthRows,
  formatByPropertyRows,
  formatLabel,
  importAuthorLabel,
  importFileLabel,
  importKindHint,
  importKindOptions,
  importStatusTone,
  isImportView,
  isReversalReasonValid,
  isThirdPartyRole,
  isUnassignedPolicy,
  isValidAccountCode,
  nativeSkippedLine,
  needsUsaliDepartment,
  periodLabel,
  periodRangeDates,
  periodRangeLabel,
  previewBlockers,
  previewKpis,
  reconciliationClassificationLabel,
  reconciliationFileName,
  reconciliationKpis,
  reconciliationRowTone,
  reconciliationStatusTone,
  reconciliationSummary,
  reportFileName,
  postActionLabel,
  entryCountLabel,
  entryNoun,
  resultTitle,
  resultTone,
  stepAfter,
  stepIndexOf,
  stepStateLabel,
  stepSummary,
  stepTitle,
  stepTone,
  stepsForKind,
  suggestedAccountLabel,
  thirdPartyEmptyMessage,
  thirdPartyLotLabel,
  thirdPartyRoleLabel,
  unassignedPolicyLabel,
  unassignedPolicyOptions,
  unbalancedLine,
  usaliDepartmentOptions,
  usesAnalytics
} from "../sage200-import-helpers.ts";

// Pure helpers only (no React, no api-client). Every company, account and
// name in these fixtures is FICTITIOUS (Sage company «1», invented codes): no
// fixture carries a real NIF.

/** Intl separates figures from «€» with a no-break space; the assertions compare on a plain one. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");

const shared = readFileSync(new URL("../../../../../../packages/shared/src/ledger-import-types.ts", import.meta.url), "utf8");
const statements = readFileSync(new URL("../../../../../../packages/shared/src/financial-statements-types.ts", import.meta.url), "utf8");

/** Values of an `export const X = [ … ] as const` array of the shared contract (doc comments stripped). */
function sharedArray(name: string): string[] {
  const match = new RegExp(`export const ${name}(?::[^=]+)? = \\[([\\s\\S]*?)\\] as const`).exec(shared);
  assert.ok(match, `${name} not found in the shared contract`);
  const code = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Entries of an `Object.freeze({ key: "label" })` record of the shared contract. */
function sharedRecord(name: string): Record<string, string> {
  const match = new RegExp(`export const ${name}[^=]*= Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`).exec(shared);
  assert.ok(match, `${name} not found in the shared contract`);
  const code = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return Object.fromEntries([...code.matchAll(/([A-Za-z0-9_]+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

/** Members of the UsaliDepartmentKey union of financial-statements-types.ts. */
function usaliDepartmentKeys(): string[] {
  const match = /export type UsaliDepartmentKey =([\s\S]*?);/.exec(statements);
  assert.ok(match, "UsaliDepartmentKey not found");
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

const preview = (patch: Partial<LedgerImportPreview> = {}): LedgerImportPreview => ({
  kind: "journal",
  format: "sage_ime_csv",
  system: "sage200",
  fileName: "diario-2026-09.csv",
  contentHash: "abc",
  sourceCompanyCode: "1",
  fiscalYearCode: "2026",
  periodFrom: "2026-09",
  periodTo: "2026-09",
  rowCount: 120,
  entryCount: 40,
  lineCount: 120,
  totalDebit: "12345.67",
  totalCredit: "12345.67",
  byMonth: [{ periodCode: "2026-09", entries: 40, lines: 120, debit: "12345.67", credit: "12345.67" }],
  byProperty: [
    { propertyId: "prop_ra", propertyCode: "RA", entries: 30, debit: "10000.00", credit: "10000.00" },
    { propertyId: null, propertyCode: "SOC", entries: 10, debit: "2345.67", credit: "2345.67" }
  ],
  unmappedAccounts: [],
  unmappedAnalytics: [],
  centreRequired: [],
  unbalanced: [],
  nativeSkipped: [],
  existing: [],
  closingDetected: [],
  duplicateOf: null,
  overlaps: [],
  payrollCostImportsPosted: [],
  existingNativeEntries: 0,
  vatSettingsMissing: false,
  warnings: [],
  canPost: true,
  blockers: [],
  ...patch
});

const entry = (patch: Partial<LedgerImportEntryDto> = {}): LedgerImportEntryDto => ({
  id: "lie_1",
  sourceCompanyCode: "1",
  sourceFiscalYear: "2026",
  sourcePeriod: "9",
  sourceEntryNumber: "1501",
  sourceChannel: null,
  entryDate: "2026-09-03",
  propertyId: "prop_ra",
  propertyCode: "RA",
  journalEntryId: "je_110",
  entryNumber: 110,
  fiscalYearCode: "2026",
  status: "posted",
  entryKind: "normal",
  lineCount: 3,
  debit: "302.50",
  credit: "302.50",
  sourceType: null,
  sourceId: null,
  warnings: [],
  ...patch
});

const record = (patch: Partial<LedgerImportRecord> = {}): LedgerImportRecord => ({
  id: "li_1",
  kind: "journal",
  format: "sage_ime_csv",
  system: "sage200",
  fileName: "diario-2026-09.csv",
  contentHash: "abc",
  sourceCompanyCode: "1",
  fiscalYearCode: "2026",
  periodFrom: "2026-09",
  periodTo: "2026-09",
  status: "posted",
  rowCount: 120,
  entryCount: 40,
  skippedCount: 2,
  warningCount: 0,
  totalDebit: "12345.67",
  totalCredit: "12345.67",
  journalEntryIds: [],
  reversalJournalEntryIds: [],
  replacedById: null,
  notes: null,
  createdBy: "usr_carmen",
  createdAt: "2026-09-17T10:00:00.000Z",
  postedAt: "2026-09-17T10:00:00.000Z",
  reversedAt: null,
  reversedBy: null,
  reversalReason: null,
  ...patch
});

const reconRow = (patch: Partial<LedgerReconciliationRow> = {}): LedgerReconciliationRow => ({
  accountCode: "477.21",
  sourceAccounts: ["4770021"],
  accountName: "IVA repercutido 21 %",
  sourceDebit: "0.00",
  sourceCredit: "1000.00",
  ledgerDebit: "0.00",
  ledgerCredit: "1000.00",
  diffDebit: "0.00",
  diffCredit: "0.00",
  sourceBalance: "-1000.00",
  ledgerBalance: "-1000.00",
  diffBalance: "0.00",
  classification: null,
  tolerance: "0.00",
  ok: true,
  ...patch
});

const recon = (rows: LedgerReconciliationRow[]): LedgerReconciliationDto => ({
  id: "lr_1",
  importId: "li_1",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  propertyId: null,
  propertyCode: "SOC",
  status: rows.some((row) => !row.ok) ? "differences" : "ok",
  accountsCompared: rows.length,
  differenceCount: rows.filter((row) => !row.ok).length,
  rows,
  summary: { nativeOnly: rows.filter((row) => row.classification === "native_only").length, missingInLedger: rows.filter((row) => row.classification === "missing_in_ledger").length, amountDiff: rows.filter((row) => row.classification === "amount_diff").length, vatDiff: rows.filter((row) => row.classification === "vat_diff").length, tolerance: "0.00", criterion: "status ≠ draft" },
  missingEntries: [],
  createdBy: null,
  createdAt: "2026-09-17T10:00:00.000Z"
});

describe("Sage 200 · vocabularios (espejo del contrato compartido)", () => {
  it("the six lot kinds match LEDGER_IMPORT_KINDS in order, with the Spanish labels of the contract and a Sage export hint each", () => {
    assert.deepEqual(
      IMPORT_KIND_OPTIONS.map((option) => option.value),
      sharedArray("LEDGER_IMPORT_KINDS")
    );
    assert.deepEqual(IMPORT_KIND_LABELS, sharedRecord("LEDGER_IMPORT_KIND_LABELS_ES"));
    for (const option of IMPORT_KIND_OPTIONS) {
      assert.match(option.sageExport, /^En Sage 200: /, option.value);
      assert.ok(option.description.length > 40, option.value);
      assert.equal(importKindHint(option.value), option.sageExport);
    }
    assert.deepEqual(
      importKindOptions().map((option) => option.label),
      IMPORT_KIND_OPTIONS.map((option) => option.label)
    );
  });

  it("entry statuses, lot statuses, actions, dimensions, cost centres, reconciliation statuses and classifications cover the contract", () => {
    assert.deepEqual(Object.keys(ENTRY_STATUS_LABELS).sort(), sharedArray("LEDGER_IMPORT_ENTRY_STATUSES").sort());
    assert.deepEqual(Object.keys(IMPORT_STATUS_LABELS).sort(), sharedArray("LEDGER_IMPORT_STATUSES").sort());
    assert.deepEqual(Object.keys(ACCOUNT_ACTION_LABELS).sort(), sharedArray("LEDGER_ACCOUNT_MAP_ACTIONS").sort());
    assert.deepEqual(Object.keys(ANALYTICS_DIMENSION_LABELS).sort(), sharedArray("LEDGER_ANALYTICS_DIMENSIONS").sort());
    assert.deepEqual(Object.keys(COST_CENTRE_LABELS).sort(), sharedArray("LEDGER_USALI_COST_CENTRE_CODES").sort());
    assert.deepEqual(Object.keys(RECON_STATUS_LABELS).sort(), sharedArray("LEDGER_RECONCILIATION_STATUSES").sort());
    assert.deepEqual(Object.keys(RECON_CLASSIFICATION_LABELS).sort(), sharedArray("LEDGER_RECONCILIATION_CLASSIFICATIONS").sort());
    assert.deepEqual(Object.keys(ENTRY_KIND_LABELS).sort(), sharedArray("LEDGER_IMPORT_ENTRY_KINDS").sort());
    assert.deepEqual(RECON_STATUS_LABELS, sharedRecord("LEDGER_RECONCILIATION_STATUS_LABELS_ES"));
    assert.deepEqual(RECON_CLASSIFICATION_LABELS, sharedRecord("LEDGER_RECONCILIATION_CLASSIFICATION_LABELS_ES"));
    assert.deepEqual(IMPORT_STATUS_LABELS, sharedRecord("LEDGER_IMPORT_STATUS_LABELS_ES"));
  });

  it("the USALI departments of a `create` in 6 / 7 cover the UsaliDepartmentKey union", () => {
    assert.deepEqual(Object.keys(USALI_DEPARTMENT_LABELS).sort(), usaliDepartmentKeys().sort());
    const options = usaliDepartmentOptions();
    assert.equal(options[0].value, "");
    assert.equal(options.length, usaliDepartmentKeys().length + 1);
  });

  it("the limits mirror LEDGER_IMPORT_MAX_BYTES (20 MiB) and the picker accepts the four extensions the API can read (no XML «Datos contables» until it has a parser)", () => {
    assert.equal(IMPORT_MAX_BYTES, 20 * 1024 * 1024);
    assert.match(shared, /LEDGER_IMPORT_MAX_BYTES = 20 \* 1024 \* 1024/);
    assert.equal(IMPORT_ACCEPT, ".xlsx,.csv,.txt,.json");
    // FUX-06: no hint invites to export the XML that LEDGER_IMPORT_XML_UNSUPPORTED rejects.
    for (const option of IMPORT_KIND_OPTIONS) assert.doesNotMatch(option.sageExport, /bloque «[^»]+» del XML/, option.value);
    assert.match(IMPORT_STEPS[0]!.description, /XML «Datos contables» todavía no se admite/);
  });

  it("the four views are Importar · Reconciliación · Lotes · Terceros (FIX-1 · F11)", () => {
    assert.deepEqual(
      IMPORT_VIEWS.map((view) => view.label),
      ["Importar", "Reconciliación", "Lotes", "Terceros"]
    );
    assert.ok(isImportView("lotes"));
    assert.ok(isImportView("terceros"));
    assert.ok(!isImportView("otro"));
  });

  it("the third-party directory vocabulary mirrors the shared contract (roles, query max) and labels the lot as «fichero · fecha»", () => {
    assert.deepEqual(THIRD_PARTY_ROLE_LABELS, { customer: "Cliente", supplier: "Proveedor" });
    assert.deepEqual(
      THIRD_PARTY_ROLE_FILTER_OPTIONS.map((option) => [option.value, option.label]),
      [
        ["", "Todos"],
        ["customer", "Clientes"],
        ["supplier", "Proveedores"]
      ]
    );
    assert.ok(isThirdPartyRole("supplier") && isThirdPartyRole("customer") && !isThirdPartyRole("") && !isThirdPartyRole("proveedor"));
    assert.equal(thirdPartyRoleLabel("customer"), "Cliente");
    assert.equal(THIRD_PARTY_QUERY_MAX, 80);
    assert.match(shared, /LEDGER_THIRD_PARTY_QUERY_MAX = 80;/);
    assert.ok(THIRD_PARTY_PAGE_LIMIT >= 1 && THIRD_PARTY_PAGE_LIMIT <= 200);
    assert.match(shared, /LEDGER_THIRD_PARTY_LIST_MAX_LIMIT = 200;/);
    assert.equal(thirdPartyLotLabel(null), "—");
    assert.equal(thirdPartyLotLabel({ importId: "imp_1", fileName: "terceros-2026-09.xlsx", createdAt: "2026-09-18T10:30:00.000Z" }), "terceros-2026-09.xlsx · 18/09/2026");
    assert.equal(thirdPartyLotLabel({ importId: "imp_2", fileName: null, createdAt: "2026-09-18T10:30:00.000Z" }), "imp_2 · 18/09/2026");
    assert.equal(thirdPartyEmptyMessage(true), "Ningún tercero coincide con la búsqueda.");
    assert.match(thirdPartyEmptyMessage(false), /^Todavía no hay terceros importados desde Sage 200/);
  });
});

describe("Sage 200 · pasos del asistente", () => {
  it("has the five steps in order and numbers them by the kind's path", () => {
    assert.deepEqual(
      IMPORT_STEPS.map((step) => step.label),
      ["Fichero", "Cuentas", "Analítica", "Revisión", "Resultado"]
    );
    const journal = stepsForKind("journal");
    assert.deepEqual(
      journal.map((step) => step.key),
      ["file", "accounts", "analytics", "review", "result"]
    );
    assert.equal(stepTitle(journal, "review"), "4 · Revisión");
    assert.equal(stepSummary(journal, 1), "Paso 2 de 5 · Cuentas");
    assert.equal(stepIndexOf(journal, "analytics"), 2);
  });

  it("plan, third_parties and vat_books skip Analítica; balances skips Cuentas when nothing is unmapped", () => {
    for (const kind of ["plan", "third_parties", "vat_books"] as const) {
      assert.deepEqual(
        stepsForKind(kind).map((step) => step.key),
        ["file", "accounts", "review", "result"],
        kind
      );
      assert.ok(!usesAnalytics(kind), kind);
    }
    assert.deepEqual(
      stepsForKind("balances", 0).map((step) => step.key),
      ["file", "analytics", "review", "result"]
    );
    assert.deepEqual(
      stepsForKind("balances", 3).map((step) => step.key),
      ["file", "accounts", "analytics", "review", "result"]
    );
    assert.equal(stepTitle(stepsForKind("balances", 0), "review"), "3 · Revisión");
    assert.ok(usesAnalytics("fiscal_years"));
  });

  it("FUX-03 · stepAfter continues past a step the re-analysis dropped from the path (balances with every account mapped → Analítica, never Fichero)", () => {
    assert.equal(stepAfter(stepsForKind("balances", 3), "accounts"), "analytics");
    assert.equal(stepAfter(stepsForKind("balances", 0), "accounts"), "analytics");
    assert.equal(stepAfter(stepsForKind("journal"), "accounts"), "analytics");
    assert.equal(stepAfter(stepsForKind("plan"), "accounts"), "review");
    assert.equal(stepAfter(stepsForKind("journal"), "analytics"), "review");
    assert.equal(stepAfter(stepsForKind("journal"), "result"), "review");
  });

  it("tones and state labels of the step list", () => {
    assert.equal(stepTone(0, 2), "success");
    assert.equal(stepTone(2, 2), "accent");
    assert.equal(stepTone(3, 2), "neutral");
    assert.deepEqual([stepStateLabel(0, 2), stepStateLabel(2, 2), stepStateLabel(3, 2)], ["hecho", "actual", "pendiente"]);
  });
});

describe("Sage 200 · fichero", () => {
  it("base64OfArrayBuffer keeps every byte 0x00-0xFF (latin1 and binary survive)", () => {
    const bytes = new Uint8Array(256 + 40_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const encoded = base64OfArrayBuffer(bytes.buffer);
    assert.deepEqual(Buffer.from(encoded, "base64"), Buffer.from(bytes));
  });

  it("detectFormatFromName infers only the unambiguous extensions and leaves CSV / text to the API header sniffing", () => {
    assert.equal(detectFormatFromName("Diario.XLSX"), "sage_excel");
    assert.equal(detectFormatFromName("diario.xlsm"), "sage_excel");
    assert.equal(detectFormatFromName("Temporal.zip"), "sage_xml");
    assert.equal(detectFormatFromName("movimientos.xml"), "sage_xml");
    assert.equal(detectFormatFromName("plan.json"), "canonical_json");
    assert.equal(detectFormatFromName("diario-2026-09.csv"), null);
    assert.equal(detectFormatFromName("diario.txt"), null);
    assert.equal(detectFormatFromName(null), null);
    assert.equal(formatLabel(null), "según la cabecera");
    assert.equal(formatLabel("sage_ime_csv"), "CSV de asientos de Sage 200 (60 columnas)");
  });

  it("fileSizeLabel paints binary units through lib/format", () => {
    assert.equal(fileSizeLabel(0), "0 B");
    assert.equal(fileSizeLabel(2048), "2 KB");
    assert.equal(fileSizeLabel(20 * 1024 * 1024), "20 MB");
    assert.equal(fileSizeLabel(1.5 * 1024 * 1024), "1,5 MB");
    assert.equal(fileSizeLabel(-1), "—");
  });
});

describe("Sage 200 · mapa de cuentas", () => {
  it("offers map · create · collapse · block to a person, and map_by_rate only when the mapper proposed it", () => {
    assert.deepEqual(
      accountActionOptions().map((option) => option.value),
      ["map", "create", "collapse", "block"]
    );
    assert.deepEqual(
      accountActionOptions(true).map((option) => option.value),
      ["map", "map_by_rate", "create", "collapse", "block"]
    );
  });

  it("suggestedAccountLabel names the proposal of the seven rules", () => {
    assert.equal(suggestedAccountLabel({ action: "map", accountCode: "477.21" }), "→ 477.21 · cuenta existente");
    assert.equal(suggestedAccountLabel({ action: "map_by_rate", accountCode: "477" }), "477.<tipo> por tipo de IVA");
    assert.equal(suggestedAccountLabel({ action: "create", accountCode: "623.2" }), "crear 623.2");
    assert.equal(suggestedAccountLabel({ action: "collapse", accountCode: "4300" }), "agrupar en 4300");
    assert.equal(suggestedAccountLabel({ action: "block", accountCode: null }), "bloquear");
    assert.equal(suggestedAccountLabel(null), "sin propuesta: bloquear");
  });

  it("validates the destination code like the engine (1-8 digits, optional .ddd) and asks a USALI department only for a create in 6 / 7", () => {
    assert.ok(isValidAccountCode("477.21"));
    assert.ok(isValidAccountCode("4300"));
    assert.ok(isValidAccountCode("62800001"));
    assert.ok(!isValidAccountCode("4300000123"));
    assert.ok(!isValidAccountCode("0123"));
    assert.ok(!isValidAccountCode(""));
    assert.ok(needsUsaliDepartment({ action: "create", accountCode: "623.2" }));
    assert.ok(needsUsaliDepartment({ action: "create", accountCode: "705.9" }));
    assert.ok(!needsUsaliDepartment({ action: "create", accountCode: "472.10" }));
    assert.ok(!needsUsaliDepartment({ action: "map", accountCode: "623.2" }));
  });

  it("accountRowIssue explains why a row still blocks the lot", () => {
    const dto = (patch: Partial<LedgerAccountMapDto>): LedgerAccountMapDto => ({ ...blockedAccountDto("6230002", "Servicios"), ...patch });
    assert.equal(accountRowIssue(dto({})), "bloqueada: sus apuntes no se contabilizan");
    assert.equal(accountRowIssue(dto({ action: "map", accountCode: null })), "falta la cuenta destino");
    assert.match(accountRowIssue(dto({ action: "map", accountCode: "4300000123" })) ?? "", /formato no admitido/);
    assert.match(accountRowIssue(dto({ action: "create", accountCode: "623.2" })) ?? "", /departamento USALI/);
    assert.equal(accountRowIssue(dto({ action: "create", accountCode: "623.2", usaliDepartment: "admin_general" })), null);
    assert.equal(accountRowIssue(dto({ action: "collapse", accountCode: "4300" })), null);
  });
});

describe("Sage 200 · mapa analítico", () => {
  it("offers the policy block · office · one property:<id> per centre and labels it back", () => {
    const centres = [
      { id: "prop_ra", label: "Rías Altas (RA)" },
      { id: "prop_oc", label: "Oficina central (OC)" }
    ];
    assert.deepEqual(
      unassignedPolicyOptions(centres).map((option) => option.value),
      ["block", "office", "property:prop_ra", "property:prop_oc"]
    );
    assert.equal(unassignedPolicyLabel("property:prop_ra", centres), "Imputar a Rías Altas (RA)");
    assert.equal(unassignedPolicyLabel("property:otro", centres), "Imputar al centro otro");
    assert.equal(unassignedPolicyLabel("office"), "Imputar a la oficina central");
    assert.ok(isUnassignedPolicy("block"));
    assert.ok(isUnassignedPolicy("property:prop_ra"));
    assert.ok(!isUnassignedPolicy("property:"));
    assert.ok(!isUnassignedPolicy("manual"));
  });

  it("cost centre options carry the code and the Spanish name; rows key on dimension + code", () => {
    const options = costCentreOptions();
    assert.equal(options[0].value, "");
    assert.ok(options.some((option) => option.value === "POM" && option.label === "POM · Mantenimiento y operación"));
    assert.equal(analyticsRowKey({ dimension: "delegacion", sourceCode: "RA" }), "delegacion:RA");
  });
});

describe("Sage 200 · previsualización", () => {
  it("previewKpis paints the seven KPIs with money through lib/format and flags an unbalanced file", () => {
    const kpis = previewKpis(preview());
    assert.deepEqual(
      kpis.map((kpi) => kpi.label),
      ["Asientos", "Apuntes", "Debe", "Haber", "Excluidos (propios)", "Ya importados", "Avisos"]
    );
    assert.equal(plain(kpis[2].value), "12.345,67 €");
    assert.equal(kpis[3].caption, "Cuadra con el Debe");
    const off = previewKpis(preview({ totalCredit: "12000.00" }));
    assert.equal(off[2].tone, "danger");
    assert.equal(off[3].caption, "No cuadra con el Debe");
  });

  it("previewBlockers lists the API blockers once and adds the local reasons the API did not name", () => {
    assert.deepEqual(previewBlockers(null), ["carga un fichero y analízalo antes de contabilizar"]);
    assert.deepEqual(previewBlockers(preview()), []);
    const api = previewBlockers(preview({ canPost: false, blockers: ["Hay 2 cuentas de Sage sin mapear."], unmappedAccounts: [{ sourceAccount: "6230002", sourceName: "Servicios", lineCount: 3, suggestion: null }] }));
    assert.deepEqual(api, ["Hay 2 cuentas de Sage sin mapear"]);
    const local = previewBlockers(
      preview({
        canPost: false,
        unmappedAccounts: [{ sourceAccount: "6230002", sourceName: null, lineCount: 3, suggestion: null }],
        unmappedAnalytics: [{ dimension: "delegacion", sourceCode: "ZZ", sourceName: null, lineCount: 2 }],
        centreRequired: [{ sourceEntryNumber: "7", sourcePeriod: "9", accounts: ["6280001"] }],
        unbalanced: [{ sourceEntryNumber: "8", sourcePeriod: "9", debit: "10.00", credit: "9.00" }],
        duplicateOf: { importId: "li_0", fileName: "diario.csv", createdAt: "2026-09-01T00:00:00.000Z", status: "posted" }
      })
    );
    assert.equal(local.length, 5);
    assert.match(local[0], /^1 cuenta de Sage sin mapear/);
    assert.match(local[1], /^1 código analítico sin centro/);
    assert.match(local[2], /^1 asiento con gastos o ingresos sin centro/);
    assert.match(local[3], /^1 asiento descuadrado/);
    assert.match(local[4], /lote diario\.csv, contabilizado/);
    assert.deepEqual(previewBlockers(preview({ kind: "vat_books", canPost: false, vatSettingsMissing: true })), ["falta la configuración de IVA de la organización (periodicidad y régimen): configúrala en Ajustes contables"]);
    assert.deepEqual(previewBlockers(preview({ entryCount: 0 })), ["no hay ningún asiento que contabilizar"]);
    assert.deepEqual(previewBlockers(preview({ entryCount: 0, rowCount: 0 })), ["el fichero no tiene filas de datos"]);
  });

  it("periodLabel and periodRangeDates read the period codes of the contract (YYYY-MM · YYYY-Qn · YYYY · apertura)", () => {
    assert.match(periodLabel("2026-09"), /^sept\.? 2026$/);
    assert.equal(periodLabel("2026-Q3"), "3.º trimestre de 2026");
    assert.equal(periodLabel("2026"), "Ejercicio 2026");
    assert.equal(periodLabel("apertura"), "Apertura");
    assert.equal(periodLabel(null), "—");
    assert.match(periodRangeLabel("2026-01", "2026-07"), /^ene\.? 2026 – jul\.? 2026$/);
    assert.match(periodRangeLabel("2026-09", "2026-09"), /^sept/);
    assert.deepEqual(periodRangeDates("2026-09", "2026-09"), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(periodRangeDates("2026-01", "2026-02"), { from: "2026-01-01", to: "2026-02-28" });
    assert.deepEqual(periodRangeDates("2024-02", null), { from: "2024-02-01", to: "2024-02-29" });
    assert.equal(periodRangeDates("2026", "2026"), null);
  });

  it("formatByMonthRows and formatByPropertyRows keep the MoneyStrings for the screen to format", () => {
    const months = formatByMonthRows(preview());
    assert.equal(months.length, 1);
    assert.equal(months[0].key, "2026-09");
    assert.equal(months[0].debit, "12345.67");
    const properties = formatByPropertyRows(preview());
    assert.deepEqual(
      properties.map((row) => row.key),
      ["prop_ra", "SOC"]
    );
  });

  it("lines of the review lists name the Sage entry and period, never a raw code alone", () => {
    assert.equal(nativeSkippedLine({ sourceEntryNumber: "1501", sourcePeriod: "9", series: "FAC-2026", number: "12", invoiceNumber: "FAC-2026-000012", sourceType: "invoice" }), "Asiento 1501 (periodo 9) · FAC-2026-000012 · asiento propio invoice");
    assert.equal(nativeSkippedLine({ sourceEntryNumber: "1502", sourcePeriod: "9", series: null, number: null, invoiceNumber: null, sourceType: "payment" }), "Asiento 1502 (periodo 9) · asiento propio payment");
    assert.equal(existingLine({ sourceEntryNumber: "1503", sourcePeriod: "9", entryNumber: 87, fiscalYearCode: "2026" }), "Asiento 1503 (periodo 9) · ya importado como 2026/87");
    assert.equal(centreRequiredLine({ sourceEntryNumber: "7", sourcePeriod: "9", accounts: ["6280001", "6290001"] }), "Asiento 7 (periodo 9): cuentas 6280001, 6290001");
    assert.equal(plain(unbalancedLine({ sourceEntryNumber: "8", sourcePeriod: "9", debit: "302.50", credit: "300.00" })), "Asiento 8 (periodo 9): Debe 302,50 € · Haber 300,00 €");
    assert.equal(closingDetectedLine({ sourceEntryNumber: "1", sourcePeriod: "0", entryKind: "opening" }), "Asiento 1 (periodo 0) · Apertura");
  });
});

describe("Sage 200 · resultado y lotes", () => {
  it("entryLine paints «2026/110 · RA · 03/09/2026 · Sage 2026/1501 · 302,50 €»", () => {
    assert.equal(plain(entryLine(entry())), "2026/110 · RA · 03/09/2026 · Sage 2026/1501 · 302,50 €");
    assert.equal(plain(entryLine(entry({ entryNumber: null, status: "skipped_native" }))), "RA · 03/09/2026 · Sage 2026/1501 · 302,50 €");
  });

  it("entry and lot statuses have a tone each; draft lots post and posted lots reverse", () => {
    assert.equal(entryStatusTone("posted"), "success");
    assert.equal(entryStatusTone("unmapped"), "warning");
    assert.equal(entryStatusTone("unbalanced"), "danger");
    assert.equal(entryStatusTone("skipped_native"), "info");
    assert.equal(entryStatusTone("otro"), "neutral");
    assert.equal(importStatusTone("draft"), "warning");
    assert.equal(importStatusTone("posted"), "success");
    assert.equal(importStatusTone("reversed"), "neutral");
    assert.ok(canPostImport({ status: "draft" }));
    assert.ok(!canPostImport({ status: "posted" }));
    assert.ok(canReverseImport({ status: "posted" }));
    assert.ok(!canReverseImport({ status: "reversed" }));
  });

  it("FUX-07 · the noun of what a lot creates and the primary of «Revisión» follow the kind (asientos · cuentas nuevas · terceros · filas de libro)", () => {
    assert.deepEqual(entryNoun("journal"), { singular: "asiento", plural: "asientos" });
    assert.deepEqual(entryNoun("plan"), { singular: "cuenta nueva", plural: "cuentas nuevas" });
    assert.deepEqual(entryNoun("third_parties"), { singular: "tercero", plural: "terceros" });
    assert.deepEqual(entryNoun("vat_books"), { singular: "fila de libro", plural: "filas de libro" });
    assert.equal(entryCountLabel("vat_books", 3), "3 filas de libro");
    assert.equal(postActionLabel("journal", 38), "Contabilizar 38 asientos");
    assert.equal(postActionLabel("balances", 4), "Contabilizar 4 asientos");
    assert.equal(postActionLabel("plan", 12), "Importar 12 cuentas nuevas");
    assert.equal(postActionLabel("third_parties", 1), "Importar 1 tercero");
    assert.equal(postActionLabel("vat_books", 3), "Importar 3 filas de libro");
  });

  it("resultTone and resultTitle follow the lot status and its skips", () => {
    assert.equal(resultTone(record()), "warning");
    assert.equal(resultTone(record({ skippedCount: 0 })), "success");
    assert.equal(resultTone(record({ status: "draft" })), "warning");
    assert.equal(resultTone(record({ status: "reversed" })), "neutral");
    assert.equal(resultTitle(record(), 38), "Lote de diario contabilizado: 38 asientos creados, 2 omitidos");
    assert.equal(resultTitle(record({ kind: "plan", skippedCount: 0 }), 12), "Lote de plan de cuentas contabilizado: 12 filas creadas");
    assert.equal(resultTitle(record({ status: "draft" }), 0), "Lote de diario en borrador: 40 asientos previsualizados, 2 omitidos");
    assert.equal(resultTitle(record({ status: "reversed" }), 0), "Lote de diario revertido");
  });

  it("importAuthorLabel names the CLI as a system actor and never paints a raw id", () => {
    assert.equal(importAuthorLabel("cli:import-sage200", null), SAGE200_SYSTEM_ACTOR_LABEL);
    assert.equal(importAuthorLabel("usr_system_sage200_import", null), SAGE200_SYSTEM_ACTOR_LABEL);
    assert.equal(importAuthorLabel("usr_carmen", { userId: "usr_carmen", fullName: "Carmen Ferreiro" }), "Carmen Ferreiro");
    assert.equal(importAuthorLabel("usr_carmen", { userId: "usr_carmen" }), "tú");
    assert.equal(importAuthorLabel("usr_otro", { userId: "usr_carmen" }), "otro usuario");
    assert.equal(importAuthorLabel("usr_system_accounting_replay", null), "Sistema · re-proyección contable");
    assert.equal(importAuthorLabel(null, null), "—");
    assert.equal(importFileLabel(record({ fileName: null })), "li_1");
  });

  it("the reversal reason must have 3..500 characters", () => {
    assert.ok(!isReversalReasonValid("  no "));
    assert.ok(isReversalReasonValid("Diario reexportado"));
    assert.ok(!isReversalReasonValid("x".repeat(501)));
  });
});

describe("Sage 200 · reconciliación", () => {
  it("reconciliationRowTone: ok → none, native_only → warning, the rest → danger", () => {
    assert.equal(reconciliationRowTone(reconRow()), undefined);
    assert.equal(reconciliationRowTone(reconRow({ ok: false, classification: "native_only" })), "warning");
    assert.equal(reconciliationRowTone(reconRow({ ok: false, classification: "amount_diff" })), "danger");
    assert.equal(reconciliationRowTone(reconRow({ ok: false, classification: "missing_in_ledger" })), "danger");
    assert.equal(reconciliationRowTone(reconRow({ ok: false, classification: "vat_diff" })), "danger");
    assert.equal(reconciliationStatusTone("ok"), "success");
    assert.equal(reconciliationStatusTone("differences"), "warning");
    assert.equal(reconciliationClassificationLabel(null), "Cuadra");
    assert.equal(reconciliationClassificationLabel("native_only"), "Solo en ehotelOS");
  });

  it("reconciliationSummary and reconciliationKpis count by classification", () => {
    const rows = [reconRow(), reconRow({ accountCode: "4300", ok: false, classification: "native_only" }), reconRow({ accountCode: "572", ok: false, classification: "amount_diff" })];
    assert.equal(reconciliationSummary(rows), "1 cuenta cuadra · 1 con importe distinto · 1 solo en ehotelOS · 0 faltan en ehotelOS · 0 de IVA");
    const kpis = reconciliationKpis(recon(rows));
    assert.deepEqual(
      kpis.map((kpi) => kpi.label),
      ["Cuentas comparadas", "Diferencias", "Solo en ehotelOS", "Faltan en ehotelOS", "Diferencias de IVA"]
    );
    assert.equal(kpis[0].value, "3");
    assert.equal(kpis[1].tone, "danger");
    assert.equal(kpis[2].tone, "warning");
  });

  it("buildReconciliationCsv writes BOM + CRLF with the classification in Spanish", () => {
    const csv = buildReconciliationCsv(recon([reconRow(), reconRow({ accountCode: "4300", ok: false, classification: "native_only", note: "=cmd" })]));
    assert.ok(csv.startsWith("\uFEFF"));
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines[0], RECONCILIATION_CSV_HEADER.join(";"));
    assert.match(lines[1], /^477\.21;IVA repercutido 21 %;4770021;2026-09-01;2026-09-30;/);
    assert.match(lines[1], /;cuadra;$/);
    assert.match(lines[2], /;Solo en ehotelOS;"'=cmd"$/);
    assert.equal(reconciliationFileName({ id: "lr_1" }), "reconciliacion-sage200-lr_1.csv");
  });
});

describe("Sage 200 · informe CSV", () => {
  it("csvCell quotes «;», quotes and line breaks and neutralises formula starters; numbers untouched", () => {
    assert.equal(csvCell("texto"), "texto");
    assert.equal(csvCell("a;b"), '"a;b"');
    assert.equal(csvCell('di "hola"'), '"di ""hola"""');
    assert.equal(csvCell("=HYPERLINK(1)"), "\"'=HYPERLINK(1)\"");
    assert.equal(csvCell(" +34"), "\"' +34\"");
    assert.equal(csvCell(12), "12");
    assert.equal(csvCell(null), "");
  });

  it("buildImportReportCsv writes one line per entry with the Sage key, the ehotelOS number, the status and the collision", () => {
    const csv = buildImportReportCsv([entry(), entry({ id: "lie_2", sourceEntryNumber: "1502", status: "skipped_native", entryNumber: null, journalEntryId: null, sourceType: "invoice", sourceId: "inv_1", warnings: ["Coincide con FAC-2026-000012"] })]);
    assert.ok(csv.startsWith("\uFEFF"));
    assert.ok(csv.endsWith("\r\n"));
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines[0], IMPORT_REPORT_HEADER.join(";"));
    assert.equal(lines[1], "1;2026;9;1501;;2026-09-03;RA;2026;110;Normal;Contabilizado;3;302.50;302.50;;");
    assert.equal(lines[2], "1;2026;9;1502;;2026-09-03;RA;2026;;Normal;Omitido: documento propio;3;302.50;302.50;invoice/inv_1;Coincide con FAC-2026-000012");
    assert.equal(reportFileName({ id: "li_1" }), "informe-sage200-li_1.csv");
  });
});
