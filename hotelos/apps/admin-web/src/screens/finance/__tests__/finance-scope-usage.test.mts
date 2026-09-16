import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FINANCE_SCOPE_POLICIES } from "../../../services/financeScope.ts";

// Tanda 6b · L7 (design §5.3): ONE «Ámbito» selector in the header of every
// money screen, driven by services/financeScope.ts with the policy of the
// screen key; the fiscal screens paint the declarant badge and the regime
// notice; the ledger filters and the statements read `propertyId` from the
// scope, never from a local «Propiedad» select nor from the operational
// active property. The screens reach api-client (import.meta.env) and cannot
// load under node --test: the recipe is pinned on the source, like
// configure-gate.test.mts does.

const SCREENS = "../../";
const source = (rel: string) => readFileSync(new URL(`${SCREENS}${rel}`, import.meta.url), "utf8");

/** Screen file → screen key of FINANCE_SCOPE_POLICIES (the fiscal body shares one key). */
const MONEY_SCREENS: ReadonlyArray<[string, string]> = [
  ["accounting/JournalScreen.tsx", "JournalScreen"],
  ["accounting/LedgerScreen.tsx", "LedgerScreen"],
  ["accounting/ChartOfAccountsScreen.tsx", "ChartOfAccountsScreen"],
  ["accounting/AccountingSettingsScreen.tsx", "AccountingSettingsScreen"],
  ["accounting/GestoriaExportScreen.tsx", "GestoriaExportScreen"],
  ["finance/YearEndCloseScreen.tsx", "YearEndCloseScreen"],
  ["finance/TrialBalanceScreen.tsx", "TrialBalanceScreen"],
  ["finance/BalanceSheetScreen.tsx", "BalanceSheetScreen"],
  ["finance/ProfitAndLossScreen.tsx", "ProfitAndLossScreen"],
  ["finance/CashFlowScreen.tsx", "CashFlowScreen"],
  ["finance/AnnualAccountsScreen.tsx", "AnnualAccountsScreen"],
  ["finance/UsaliScreen.tsx", "UsaliScreen"],
  ["operations/FinancePositionDashboard.tsx", "FinancePositionDashboard"],
  ["banking/BankReconciliationScreen.tsx", "BankReconciliationScreen"],
  ["banking/BankingSpainScreen.tsx", "BankingSpainScreen"],
  ["payables/SupplierBillsScreen.tsx", "SupplierBillsScreen"],
  ["payables/ExpensesScreen.tsx", "ExpensesScreen"],
  ["payables/FixedAssetsScreen.tsx", "FixedAssetsScreen"],
  ["payables/SuppliersScreen.tsx", "SuppliersScreen"],
  ["payroll/PayrollScreen.tsx", "PayrollScreen"],
  ["commissions/CommissionsScreen.tsx", "CommissionsScreen"],
  ["billing/BillingCenterScreen.tsx", "BillingCenterScreen"],
  ["pos/CashClosureScreen.tsx", "CashClosureScreen"],
  ["fiscal/FiscalModelReport.tsx", "FiscalModelReport"],
  ["fiscal/VatBooksScreen.tsx", "VatBooksScreen"],
  ["fiscal/VatSettlementScreen.tsx", "VatSettlementScreen"]
];

/** Screens that paint the disabled «Sociedad» cue only through the selector (no centre filter anywhere). */
const FORCED = MONEY_SCREENS.filter(([, key]) => FINANCE_SCOPE_POLICIES[key] === "entity_forced").map(([rel]) => rel);
/** Emission / POS / bank-account screens: the oficina central is never an option. */
const NO_OFFICE = ["billing/BillingCenterScreen.tsx", "pos/CashClosureScreen.tsx", "banking/BankReconciliationScreen.tsx", "banking/BankingSpainScreen.tsx", "commissions/CommissionsScreen.tsx"];
/** Readers keyed on the centre that wait for the structure (`finance.loading`) so an active oficina is never asked before it is excluded. */
const WAITS_FOR_STRUCTURE = ["billing/BillingCenterScreen.tsx", "pos/CashClosureScreen.tsx"];

describe("Finanzas · ámbito único (Tanda 6b · L7)", () => {
  for (const [rel, key] of MONEY_SCREENS) {
    describe(rel, () => {
      const src = source(rel);

      it(`reads its scope with useFinanceScope(financeScopePolicy("${key}"))`, () => {
        assert.match(src, /import \{[^}]*useFinanceScope[^}]*\} from "\.\.\/\.\.\/services\/financeScope";/);
        assert.match(src, new RegExp(`useFinanceScope\\(financeScopePolicy\\("${key}"\\)`));
        assert.ok(FINANCE_SCOPE_POLICIES[key], `${key} has a policy in FINANCE_SCOPE_POLICIES`);
      });

      it("names the sociedad or the centre in its eyebrow (never the operational hotel)", () => {
        assert.match(src, /eyebrow=\{finance\.eyebrow\("(?:Finanzas|Cumplimiento|Operaciones)"\)\}/);
        assert.doesNotMatch(src, /eyebrow=\{`(?:Finanzas|Cumplimiento|Operaciones) · \$\{(?:property\.propertyName|propertyName|getActivePropertyName\(\)|organizationName)\}`\}/);
      });

      if (rel !== "payables/SuppliersScreen.tsx") {
        it("paints the ONE «Ámbito» selector in its actions row", () => {
          assert.match(src, /import \{[^}]*FinanceScopeSelector[^}]*\} from "\.\.\/\.\.\/components\/finance\/FinanceScopeSelector";/);
          assert.match(src, /<FinanceScopeSelector scope=\{finance\} \/>/);
        });
      }

      it("keeps no local «Propiedad» / «Toda la organización» scope control", () => {
        assert.doesNotMatch(src, /usePropertyScopeOptions|ORGANIZATION_SCOPE_LABEL/);
        assert.doesNotMatch(src, /label: "Toda la organización"/);
        assert.doesNotMatch(src, /aria-label="Ámbito del modelo"/);
      });

      if (NO_OFFICE.includes(rel)) {
        it("never offers the oficina central (emission, POS and bank accounts hang from a hotel)", () => {
          assert.match(src, /useFinanceScope\(financeScopePolicy\("[A-Za-z]+"\), \{ excludeOffice: true \}\)/);
        });
      }

      if (WAITS_FOR_STRUCTURE.includes(rel)) {
        it("waits for the structure before reading its centre (fix:L7 qa#11: an active oficina must not be asked for invoices or cash closures)", () => {
          assert.match(src, /if \(finance\.loading\) return;/);
          assert.doesNotMatch(src, /\}, \[propertyId\]\);/, "every reader keyed on propertyId also depends on finance.loading");
        });
      }
    });
  }

  it("forces the sociedad exactly where the design says (Plan · Ajustes · Cierre · Gestoría · Balance · Flujos · Cuentas anuales · Modelos · Libros · Liquidación · Proveedores)", () => {
    assert.deepEqual(FORCED.sort(), [
      "accounting/AccountingSettingsScreen.tsx",
      "accounting/ChartOfAccountsScreen.tsx",
      "accounting/GestoriaExportScreen.tsx",
      "finance/AnnualAccountsScreen.tsx",
      "finance/BalanceSheetScreen.tsx",
      "finance/CashFlowScreen.tsx",
      "finance/YearEndCloseScreen.tsx",
      "fiscal/FiscalModelReport.tsx",
      "fiscal/VatBooksScreen.tsx",
      "fiscal/VatSettlementScreen.tsx",
      "payables/SuppliersScreen.tsx"
    ]);
  });
});

describe("Cumplimiento · declarante, desglose y régimen (design §5.3)", () => {
  for (const rel of ["fiscal/FiscalModelReport.tsx", "fiscal/VatBooksScreen.tsx", "fiscal/VatSettlementScreen.tsx"]) {
    describe(rel, () => {
      const src = source(rel);
      it("paints «Declarante: razón social · NIF» from the typed `sociedad` block and the SII / gran empresa callout", () => {
        assert.match(src, /<FinanceDeclaranteBadge sociedad=\{sociedad\} \/>/);
        assert.match(src, /<FinanceRegimeCallout regimen=/);
        assert.match(src, /\.sociedad\b/);
      });
      it("no longer offers «Solo <hotel>» nor reads the active property", () => {
        assert.doesNotMatch(src, /getActiveProperty\(/);
        assert.doesNotMatch(src, /Solo \$\{property\.propertyName\}/);
      });
    });
  }

  it("the models and the books keep a centre breakdown as an informative partial view («no liquidable»)", () => {
    for (const rel of ["fiscal/FiscalModelReport.tsx", "fiscal/VatBooksScreen.tsx"]) {
      const src = source(rel);
      assert.match(src, /aria-label="Desglose por centro"/);
      assert.match(src, /vista parcial, no liquidable/);
      assert.match(src, /centreSelectOptions\(finance\.structure, finance\.active\)/);
    }
  });

  it("the period pickers of the actions row shrink to their widest option (`inline`), never to the row (fix:L7 qa#6)", () => {
    for (const rel of ["fiscal/FiscalModelReport.tsx", "fiscal/VatSettlementScreen.tsx", "fiscal/VatBooksScreen.tsx"]) {
      const src = source(rel);
      const pickers = src.match(/<CocoaSelect size="small"[^>]*aria-label="(?:Trimestre|Mes|Periodo|Ejercicio|Desglose por centro)"/g) ?? [];
      assert.ok(pickers.length >= 2, `${rel}: period pickers in the actions row`);
      for (const picker of pickers) assert.match(picker, /<CocoaSelect size="small" inline /, `${rel}: ${picker}`);
    }
  });

  it("a model that is not filed (SII) says so instead of the manual-filing note", () => {
    const src = source("fiscal/FiscalModelReport.tsx");
    assert.match(src, /report\.presentacion\.noSePresenta/);
    assert.match(src, /no se presenta/);
  });
});

describe("Contabilidad y estados · centro como filtro y vistas «Por centro»", () => {
  it("the journal filters by the scope, names the centre of an entry and posts society-level manual entries with `societyLevel`", () => {
    const src = source("accounting/JournalScreen.tsx");
    assert.match(src, /propertyId: finance\.propertyId \?\? ""/);
    assert.match(src, /centreNameFor\(finance\.structure, selected\.propertyId\)/);
    assert.match(src, /\{ societyLevel: true \}/);
    assert.match(src, /centreSelectOptions\(finance\.structure, finance\.active, \{ societyLevel: true \}\)/);
    assert.match(src, /key !== "propertyId"/, "the centre is not a toolbar filter to clear");
  });

  it("PyG offers «Sociedad · Por centro» over GET /accounting/pnl/by-property with the office, unassigned and total columns and the informative allocation", () => {
    const src = source("finance/ProfitAndLossScreen.tsx");
    assert.match(src, /"\/accounting\/pnl\/by-property"/);
    assert.match(src, /allocation: input\.applyAllocation \? undefined : "none"/);
    for (const label of ["UNASSIGNED_COLUMN_LABEL", "ENTITY_TOTAL_LABEL", "ENTITY_TOTAL_FOOTNOTE", "ALLOCATION_ROW_LABEL"]) assert.match(src, new RegExp(`\\b${label}\\b`));
    assert.match(src, /Aplicar reparto de oficina central \(informativo\)/);
    assert.match(src, /stickyFirstColumn/);
    assert.match(src, /label: "Por centro"/);
  });

  it("USALI compares the centres with includeCorporate=1, paints «Oficina central» · «Sin asignar» · «Total sociedad», the rollup and the allocation switch", () => {
    const src = source("finance/UsaliScreen.tsx");
    assert.match(src, /includeCorporate: "1"/);
    assert.match(src, /allocation: window\.applyAllocation \? undefined : "none"/);
    for (const label of ["CORPORATE_COLUMN_LABEL", "UNASSIGNED_COLUMN_LABEL", "ENTITY_TOTAL_LABEL", "ALLOCATION_ROW_LABEL"]) assert.match(src, new RegExp(`\\b${label}\\b`));
    assert.match(src, /comparison\.rollup/);
    assert.match(src, /Aplicar reparto de oficina central \(informativo\)/);
    assert.match(src, /label: "Por centro"/);
    assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, "currency from the statement, never a literal");
  });

  it("the treasury dashboard asks the sociedad with scope=entity and labels the centre of every bank account", () => {
    const src = source("operations/FinancePositionDashboard.tsx");
    assert.match(src, /const query = finance\.treasuryQuery;/);
    assert.match(src, /centreNameFor\(finance\.structure, bank\.propertyId \?\? null\)/);
    assert.match(src, /SOCIETY_NO_CENTRE_LABEL/);
  });

  it("cuentas anuales paints the entity label, the non-depositable format and the establishments with code and kind", () => {
    const src = source("finance/AnnualAccountsScreen.tsx");
    assert.match(src, /accounts\.entityLabel/);
    assert.match(src, /accounts\.format\.depositable/);
    assert.match(src, /PROPERTY_KIND_LABELS\[property\.kind\]/);
    assert.doesNotMatch(src, /SwitchableProperty|loadSwitchableProperties/);
  });

  it("the balance and the annual accounts drop the per-centre filter and warn when the Pymes format is not depositable", () => {
    for (const rel of ["finance/BalanceSheetScreen.tsx", "finance/AnnualAccountsScreen.tsx"]) {
      const src = source(rel);
      assert.match(src, /format[?.]*\.depositable/);
      assert.doesNotMatch(src, /<CocoaField label="Propiedad">/);
    }
  });
});

describe("Facturación, nóminas y payables · sociedad emisora, empleador y centro del documento", () => {
  it("the invoice detail shows the sociedad emisora, the establishment block and the «VeriFactu no aplica (SII)» badge", () => {
    const src = source("billing/BillingCenterScreen.tsx");
    assert.match(src, /VeriFactu no aplica \(SII\)/);
    assert.match(src, /verifactuExclusionText\(/);
    assert.match(src, /label="Sociedad emisora"/);
    assert.match(src, /label="Establecimiento"/);
  });

  it("payroll names the employer block of the export (NIF · razón social · CCC)", () => {
    const src = source("payroll/PayrollScreen.tsx");
    assert.match(src, /employer\.legalName/);
    assert.match(src, /employer\.ccc/);
  });

  it("supplier bills, expenses, fixed assets and the cash closure pass the scope's centre to every property-bound call", () => {
    const bills = source("payables/SupplierBillsScreen.tsx");
    for (const call of ["listSupplierBills(", "getPayablesAging(undefined, propertyId)", "getSupplierBill(selectedId, propertyId)", "createSupplierBill(bodyOf(form), propertyId)", "postSupplierBill(selectedId, propertyId)", "approveSupplierBill(selected.id, propertyId)", "cancelSupplierBill(selectedId, { reason: text }, propertyId)", "getSupplierBillAttachment(selectedId, propertyId)"]) {
      assert.ok(bills.includes(call), `SupplierBillsScreen: ${call}`);
    }
    const expenses = source("payables/ExpensesScreen.tsx");
    for (const call of ["getExpense(selectedId, propertyId)", "createExpense(bodyOf(form), propertyId)", "reverseExpense(selectedId, { reason: text }, propertyId)"]) assert.ok(expenses.includes(call), `ExpensesScreen: ${call}`);
    const assets = source("payables/FixedAssetsScreen.tsx");
    for (const call of ["getFixedAsset(selectedId, propertyId)", "createFixedAsset(createBody(form), propertyId)", "updateFixedAsset(selected.id, body, propertyId)", "disposeFixedAsset(selected.id, body, propertyId)"]) assert.ok(assets.includes(call), `FixedAssetsScreen: ${call}`);
    assert.doesNotMatch(assets, /const PROPERTY_ID = getActivePropertyId\(\)/);
    const closure = source("pos/CashClosureScreen.tsx");
    for (const call of ["listCashClosures(", "getCashClosure(closureId, propertyId)", "closeCashClosure(selected.id, closeRequest.body, propertyId)", "fetchPosOutlets(propertyId)"]) assert.ok(closure.includes(call), `CashClosureScreen: ${call}`);
  });
});
