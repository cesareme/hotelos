import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Surface contract of the Tanda 6 finance clients (lote nav-services): each
// client wraps the routes of its API module (docs/runbooks/finanzas-contabilidad.md
// §13) through apiRequest / apiRequestBlob, types its answers with the shared
// contracts and maps details.code through finance-contracts.ts. Source reads
// only — no network, no api-client import (import.meta.env is not available
// under node --test).

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// Source without line comments and block comments (the comments cite forbidden
// names on purpose). Line comments go first: a header line such as
// `packages/shared/src/*-types.ts` must not open a false block comment.
const code = (source: string) => source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

type Surface = { file: string; routes: string[]; functions: string[]; errorHelper: string };

const SURFACE: Surface[] = [
  {
    file: "accountingApi.ts",
    routes: ["/accounting/journal", "/accounting/journal/export", "/reverse", "/accounting/ledger/", "/accounting/chart", "/accounting/settings", "/accounting/replay", "/accounting/projection/status"],
    functions: [
      "listJournal",
      "getJournalEntry",
      "createManualJournalEntry",
      "reverseJournalEntry",
      "downloadJournalCsv",
      "getAccountLedger",
      "downloadLedgerCsv",
      "listChartAccounts",
      "createChartAccount",
      "patchChartAccount",
      "getAccountingSettings",
      "patchAccountingSettings",
      "replayProjection",
      "getProjectionStatus"
    ],
    errorHelper: "accountingErrorMessage"
  },
  {
    file: "fiscalApi.ts",
    routes: ["/fiscal/models/", "/pdf", "/fiscal/vat-books", "/fiscal/vat-books/rebuild", "/fiscal/vat-settings", "/fiscal/vat-settlement", "/fiscal/vat-settlement/reverse"],
    functions: ["getFiscalModel", "downloadFiscalModelPdf", "getVatBook", "rebuildVatBooks", "getVatSettings", "putVatSettings", "previewVatSettlement", "postVatSettlement", "reverseVatSettlement"],
    errorHelper: "fiscalErrorMessage"
  },
  {
    file: "payablesApi.ts",
    routes: ["/payables/suppliers", "/payables/supplier-bills", "/approve", "/post", "/pay", "/cancel", "/attachment", "/payables/aging", "/payables/expenses", "/reverse"],
    functions: [
      "listSuppliers",
      "createSupplier",
      "getSupplier",
      "updateSupplier",
      "listSupplierBills",
      "createSupplierBill",
      "getSupplierBill",
      "updateSupplierBill",
      "approveSupplierBill",
      "postSupplierBill",
      "paySupplierBill",
      "cancelSupplierBill",
      "getSupplierBillAttachment",
      "getPayablesAging",
      "listExpenses",
      "createExpense",
      "getExpense",
      "reverseExpense"
    ],
    errorHelper: "payablesErrorMessage"
  },
  {
    file: "assetsApi.ts",
    routes: ["/asset-register", "/dispose", "/depreciation-runs", "/depreciation-runs/preview", "/reverse"],
    functions: ["listFixedAssets", "createFixedAsset", "getFixedAsset", "updateFixedAsset", "disposeFixedAsset", "listDepreciationRuns", "previewDepreciationRun", "postDepreciationRun", "getDepreciationRun", "reverseDepreciationRun"],
    errorHelper: "assetsErrorMessage"
  },
  {
    file: "treasuryApi.ts",
    routes: ["/treasury/position", "/treasury/receivables", "/treasury/payables", "/treasury/forecast", "/statements/import", "/suggestions", "/reconcile", "/auto-reconcile", "/treasury/sepa/remittances", "/status", "/treasury/sepa/supplier-payments"],
    functions: [
      "getTreasuryPosition",
      "getTreasuryReceivables",
      "getTreasuryPayables",
      "getTreasuryForecast",
      "importBankStatement",
      "getBankLineSuggestions",
      "reconcileBankLine",
      "unreconcileBankLine",
      "autoReconcileStatement",
      "createSepaRemittance",
      "listSepaRemittances",
      "getSepaRemittance",
      "updateSepaRemittanceStatus",
      "buildSupplierPaymentRemittance"
    ],
    errorHelper: "treasuryErrorMessage"
  },
  {
    file: "financialStatementsApi.ts",
    routes: [
      "/accounting/usali/mappings",
      "/accounting/usali/coverage",
      "/accounting/usali/pnl",
      "/accounting/usali/compare",
      "/accounting/usali/periods",
      "/accounting/annual-accounts",
      "/accounting/annual-accounts/balance",
      "/accounting/annual-accounts/pyg",
      "/accounting/annual-accounts/ecpn",
      "/accounting/annual-accounts/memoria",
      "/accounting/annual-accounts/snapshots",
      "/download",
      "/accounting/gestoria-exports/formats",
      "/accounting/gestoria-exports"
    ],
    functions: [
      "getUsaliMappings",
      "patchUsaliMappings",
      "deleteUsaliMapping",
      "getUsaliCoverage",
      "getUsaliPnl",
      "compareUsaliProperties",
      "compareUsaliPeriods",
      "getAnnualAccounts",
      "getBalanceSheet",
      "getProfitAndLoss",
      "getEquityChanges",
      "getMemoria",
      "downloadStatement",
      "listSnapshots",
      "createSnapshot",
      "getSnapshot",
      "downloadSnapshot",
      "listGestoriaFormats",
      "listGestoriaExports",
      "createGestoriaExport",
      "getGestoriaExport",
      "downloadGestoriaExport"
    ],
    errorHelper: "statementsErrorMessage"
  },
  {
    file: "cashClosureApi.ts",
    routes: ["/pos/cash-closures", "/close", "/approve"],
    functions: ["listCashClosures", "openCashClosure", "getCashClosure", "closeCashClosure", "approveCashClosure"],
    errorHelper: "cashClosureErrorMessage"
  },
  {
    file: "payrollApi.ts",
    // Tanda 6c: the seven routes of the imported labour cost (preview · create · list · detail · post · reverse · report).
    routes: ["/payroll/contracts", "/deactivate", "/payroll/periods", "/calculate", "/slips", "/export", "/pay", "/payroll/cost-imports/preview", "/payroll/cost-imports", "/post", "/reverse", "/payroll/cost-report"],
    functions: [
      "listPayrollContracts",
      "createPayrollContract",
      "deactivatePayrollContract",
      "listPayrollPeriods",
      "createPayrollPeriod",
      "calculatePayrollPeriod",
      "getPayrollPeriod",
      "listPayrollSlips",
      "previewPayrollExport",
      "exportPayrollPeriod",
      "payPayrollPeriod",
      "previewPayrollCostImport",
      "createPayrollCostImport",
      "listPayrollCostImports",
      "getPayrollCostImport",
      "postPayrollCostImport",
      "reversePayrollCostImport",
      "getPayrollCostReport"
    ],
    errorHelper: "payrollErrorMessage"
  },
  {
    file: "commissionsApi.ts",
    routes: ["/commissions/rules", "/deactivate", "/commissions/accruals", "/commissions/summary", "/commissions/accrue", "/settle", "/reverse"],
    functions: ["listCommissionRules", "createCommissionRule", "deactivateCommissionRule", "listCommissionAccruals", "getCommissionSummary", "getCommissionAccrual", "accrueCommission", "settleCommissionAccrual", "reverseCommissionAccrual"],
    errorHelper: "commissionsErrorMessage"
  }
];

describe("servicios de finanzas · superficie tipada (Tanda 6)", () => {
  for (const surface of SURFACE) {
    it(`${surface.file} wraps its routes, exports one function per route and maps errors through finance-contracts`, () => {
      const source = read(surface.file);
      for (const route of surface.routes) assert.ok(source.includes(route), `${surface.file}: route ${route} missing`);
      for (const name of surface.functions) assert.match(source, new RegExp(`export (async )?function ${name}\\(`), `${surface.file}: ${name} missing`);
      assert.match(source, new RegExp(`export function ${surface.errorHelper}\\(`), `${surface.file}: ${surface.errorHelper} missing`);
      assert.match(source, /from "\.\/finance-contracts"/, `${surface.file}: must build queries / messages with finance-contracts`);
      assert.match(source, /import type \{[\s\S]*?\} from "@hotelos\/shared"/, `${surface.file}: answers must be typed with the shared contracts (type-only import)`);
      assert.doesNotMatch(source, /^import \{[^}]*\} from "@hotelos\/shared"/m, `${surface.file}: no runtime import from @hotelos/shared (the .js stubs would win under tsx)`);
      assert.match(source, /from "\.\/api-client"/, `${surface.file}: every call goes through api-client`);
      assert.doesNotMatch(source, /\bfetch\s*\(/, `${surface.file}: no raw fetch`);
    });
  }

  it("the pure module never touches api-client, React or import.meta", () => {
    const source = code(read("finance-contracts.ts"));
    assert.doesNotMatch(source, /from "\.\/api-client"|from "react"|import\.meta/);
    assert.match(source, /^import type \{[^}]+\} from "@hotelos\/shared";/m);
    assert.equal((source.match(/^import /gm) ?? []).length, 1, "finance-contracts.ts has one (type-only) import");
  });

  it("payrollApi builds the cost-report and cost-imports queries with finance-contracts (strict query schemas) and re-exports the Tanda 6c contracts", () => {
    const source = code(read("payrollApi.ts"));
    assert.match(source, /payrollCostReportQuery\(query\)/);
    assert.match(source, /payrollCostImportListQuery\(/);
    for (const name of ["PayrollCostImportPreview", "PayrollCostImportCreateResult", "PayrollCostImportDetail", "PayrollCostImportRecord", "PayrollCostReport", "PayrollCostReportQuery"]) {
      assert.match(source, new RegExp(`export type \\{[\\s\\S]*?\\b${name}\\b[\\s\\S]*?\\} from "@hotelos/shared"`), `payrollApi.ts re-exports ${name}`);
    }
    const contracts = code(read("finance-contracts.ts"));
    assert.match(contracts, /export function payrollCostReportQuery\(/);
    assert.match(contracts, /export function payrollCostImportListQuery\(/);
  });

  it("finance-contracts carries a Spanish sentence for every PAYROLL_COST_ERROR_CODES entry of the shared contract", async () => {
    const shared = readFileSync(new URL("../../../../../packages/shared/src/payroll-cost-types.ts", import.meta.url), "utf8");
    const block = shared.match(/PAYROLL_COST_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/);
    assert.ok(block, "PAYROLL_COST_ERROR_CODES not found");
    const codes = [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    assert.ok(codes.length >= 19, `expected the shared contract to declare at least 19 codes, parsed ${codes.length}`);
    const { FINANCE_ERROR_MESSAGES } = await import("../finance-contracts.ts");
    const missing = codes.filter((code) => !FINANCE_ERROR_MESSAGES[code]);
    assert.deepEqual(missing, [], `codes without a Spanish message: ${missing.join(", ")}`);
    for (const code of codes) assert.match(FINANCE_ERROR_MESSAGES[code], /[.]$/, `${code}: full sentence`);
  });

  it("pmsCommerceApi sends the Tanda 6 payment fields and downloads the invoice PDF as a Blob", () => {
    const source = code(read("pmsCommerceApi.ts"));
    for (const marker of ["clientRequestId", "reference", "returnUrl", "FolioPaymentResult", "refundFolioPayment", "createFolioPaymentLink", "fetchPaymentIntent", "fetchPspStatus", "getInvoicePdf", "apiRequestBlob", "/invoices/${invoiceId}/pdf", "refundPayments", "InvoiceEmailResponse"]) {
      assert.ok(source.includes(marker), `pmsCommerceApi.ts: ${marker} missing`);
    }
    assert.doesNotMatch(source, /window\.print/);
  });

  it("posApi lists tickets by status and exposes the night-audit runs; bankingApi answers the shared Csb43ImportResult", () => {
    const pos = read("posApi.ts");
    for (const marker of ["posTicketsQuery", "/night-audit/runs", "/night-audit/run`", "NightAuditRunWire", "PosTicketWire"]) assert.ok(pos.includes(marker), `posApi.ts: ${marker} missing`);
    const banking = read("bankingApi.ts");
    assert.match(banking, /import type \{[^}]*Csb43ImportResult[^}]*\} from "@hotelos\/shared"/);
    for (const marker of ["bankAccountId", "autoMatch", "createMissingAccount"]) assert.ok(banking.includes(marker), `bankingApi.ts: ${marker} missing`);
  });

  it("api-client owns the blob request with the same 401 / error handling", () => {
    const source = read("api-client.ts");
    assert.match(source, /export async function apiRequestBlob\(/);
    assert.match(source, /export type BlobResponse = \{/);
    assert.match(source, /contentDisposition: response\.headers\.get\("Content-Disposition"\)/);
    assert.equal((source.match(/clearSession\(\)/g) ?? []).length >= 2, true, "the blob request clears the session on 401 like apiRequest");
  });
});
