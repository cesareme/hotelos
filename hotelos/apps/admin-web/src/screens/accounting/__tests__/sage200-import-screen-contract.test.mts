import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FINANCE_SCOPE_POLICIES } from "../../../services/financeScope.ts";

// Tanda 7c · L4 (design docs/design/FINANZAS-IMPORTACION-SAGE200.md §7.4): the
// «Importar desde Sage 200» tab of Finanzas › Contabilidad, its helpers, its
// service and its wiring are pinned on the source — the screen reaches
// api-client (import.meta.env) and cannot load under node --test, like
// reservation-import-screen-contract.test.mts. The pins are the ones the lot
// promised: Cocoa 22 rules with ZERO inline styles in the three new files, the
// tree header and the ONE finance scope (`entity_default`, no local centre
// control), the file input (.xlsx / .csv / .txt / .json, ≤ 20 MiB; no XML until the API reads it)
// whose bytes travel as base64, the five steps with ONE aria-current="step",
// the gates over accounting.journal.post / accounting.configure /
// ai.high_risk.confirm through canDo(useNavGate()), the three views, the
// reconciliation with the row semáforo and the ledger link, the lots with the
// destructive reversal dialog, one live region, and the navigation (tree,
// tab loader, App registry, ⌘K, policy, labels, service surface, inventory).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
/** Source without comments: only rendered code is checked. */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const screen = source("../Sage200ImportScreen.tsx");
const helpers = source("../sage200-import-helpers.ts");
const service = source("../../../services/ledgerImportApi.ts");
const ui = source("../accounting-ui.ts");
const tabs = source("../../tabs/finanzas/ContabilidadTabs.tsx");
const provider = source("../../../providers/CocoaGlobalProvider.tsx");
const app = source("../../../App.tsx");
const scopeUsage = source("../../finance/__tests__/finance-scope-usage.test.mts");
const surface = source("../../../services/__tests__/finance-api-surface.test.mts");
const shared = source("../../../../../../packages/shared/src/ledger-import-types.ts");
const tree = JSON.parse(source("../../../navigation/nav-tree.generated.json")) as {
  categories: Array<{ items: Array<{ screenKey: string; tabs: Array<{ screenKey: string; label: string; url: string; roles: string[] }> }> }>;
};
const navCsvUrl = new URL("../../../../../../../pilots/tanda5-nav-tree.csv", import.meta.url);
const inventoryCsvUrl = new URL("../../../../../../../pilots/screens-inventory.csv", import.meta.url);

/** Rules 1-5, 9-11 of tests/cocoa-22-contract.test.mjs, applied to one file. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/, `${name}: formats only through lib/format`);
}

describe("Contabilidad › Importar desde Sage 200 · pantalla (Tanda 7c · L4)", () => {
  it("keeps the Cocoa 22 rules with ZERO inline styles in the screen, the helpers and the service", () => {
    assertCocoaRules("Sage200ImportScreen.tsx", screen);
    assertCocoaRules("sage200-import-helpers.ts", helpers);
    for (const [name, src] of [
      ["Sage200ImportScreen.tsx", screen],
      ["sage200-import-helpers.ts", helpers],
      ["ledgerImportApi.ts", service]
    ] as const) {
      assert.equal(count(src, /\bstyle=\{/g), 0, `${name} is born without inline styles`);
    }
    assert.match(screen, /from "\.\.\/\.\.\/components\/cocoa";/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/v2\//);
    // Only `import type` from the shared contract (the .js stubs win under node --import tsx).
    for (const src of [screen, helpers, service]) {
      for (const line of src.split("\n").filter((entry) => /from "@hotelos\/shared"/.test(entry))) assert.match(line, /^(?:import|export) type\b|^\} from "@hotelos\/shared";$/, `runtime import from @hotelos/shared: ${line}`);
      assert.doesNotMatch(src, /^import \{[^}]*\} from "@hotelos\/shared";/m, "runtime import from @hotelos/shared");
    }
  });

  it("takes its header from the tree and the ONE finance scope with the explicit entity_default policy (no local centre control)", () => {
    assert.match(screen, /const header = treeHeaderFor\("Sage200ImportScreen", \{ eyebrow: "Finanzas · Contabilidad", title: "Importar desde Sage 200" \}\);/);
    assert.match(screen, /<CocoaPage\s+eyebrow=\{finance\.eyebrow\("Finanzas"\)\}\s+title=\{header\.title\}/);
    assert.match(screen, /import \{[^}]*useFinanceScope[^}]*\} from "\.\.\/\.\.\/services\/financeScope";/);
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("Sage200ImportScreen"\)\)/);
    assert.match(screen, /import \{[^}]*FinanceScopeSelector[^}]*\} from "\.\.\/\.\.\/components\/finance\/FinanceScopeSelector";/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\} \/>/);
    assert.equal(FINANCE_SCOPE_POLICIES.Sage200ImportScreen, "entity_default");
    assert.match(source("../../../services/financeScope.ts"), /^\s+Sage200ImportScreen: "entity_default",$/m);
    assert.doesNotMatch(screen, /usePropertyScopeOptions|ORGANIZATION_SCOPE_LABEL|label: "Toda la organización"|aria-label="Ámbito del modelo"/);
    // The reconciliation compares the centre of the selector (undefined = consolidado), never a local picker.
    assert.match(screen, /reconcileLedger\(\{ from: reconFrom, to: reconTo, propertyId: finance\.propertyId, /);
    assert.match(screen, /reconcileLedger\(\{ from: range\.from, to: range\.to, propertyId: finance\.propertyId, /);
    assert.match(screen, /centreSelectOptions\(finance\.structure, finance\.active, \{ societyLevel: true/);
    assert.match(scopeUsage, /\["accounting\/Sage200ImportScreen\.tsx", "Sage200ImportScreen"\]/);
  });

  it("gates import, maps, reversal and reading on the real grants through canDo(useNavGate()), with a Spanish note otherwise", () => {
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ accountDisplay, canDo, chartSelectOptions, saveDownload, todayIso, withQuery \} from "\.\/accounting-ui";/);
    assert.match(screen, /const canRead = canDo\(gate, "accounting\.reports\.read"\) \|\| canDo\(gate, "accounting\.read"\);/);
    assert.match(screen, /const canImport = canDo\(gate, "accounting\.journal\.post"\);/);
    assert.match(screen, /const canMap = canDo\(gate, "accounting\.configure"\);/);
    assert.match(screen, /const canReverse = canImport && canDo\(gate, "ai\.high_risk\.confirm"\);/);
    assert.match(screen, /Necesitas el permiso de contabilizar asientos para analizar y contabilizar un lote/);
    assert.match(screen, /Necesitas el permiso de lectura de informes contables/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
    assert.equal(count(screen, /disabled=\{!canReverse\}/g), 2, "both reverse buttons use canReverse");
    assert.match(screen, /canMap \? \(\s*<CocoaButton[^>]*onClick=\{\(\) => void saveAccountMap\(\)\}/);
    assert.match(screen, /canMap \? \(\s*<CocoaButton[^>]*onClick=\{\(\) => void saveAnalyticsMap\(\)\}/);
  });

  it("offers the four views on a segmented control and picks the file with CocoaFileInput (IMPORT_ACCEPT, ≤ 20 MiB, only for accounting.journal.post) sending base64, never text", () => {
    assert.match(screen, /<CocoaSegmentedControl aria-label="Vista de la importación desde Sage 200" value=\{view\}/);
    assert.match(helpers, /\{ value: "importar", label: "Importar" \},\s*\{ value: "reconciliacion", label: "Reconciliación" \},\s*\{ value: "lotes", label: "Lotes" \},\s*\{ value: "terceros", label: "Terceros" \}/);
    assert.match(screen, /view === "lotes" \? renderLotsView\(\) : renderThirdPartiesView\(\)/);
    assert.match(screen, /<CocoaSelect value=\{kind\} onChange=\{changeKind\} options=\{KIND_OPTIONS\}/);
    assert.match(screen, /<CocoaFileInput accept=\{IMPORT_ACCEPT\} maxBytes=\{20 \* 1024 \* 1024\}.*disabled=\{previewing \|\| importing \|\| !canImport\} label="Elegir fichero de Sage 200"/, "FUX-10: the picker is disabled for read-only sessions (the analysis would end in 403)");
    assert.match(screen, /el XML «Datos contables» de Sage todavía no se admite/, "FUX-06");
    // FUX-05: options.reconcile never travels by HTTP (the screen reconciles itself after posting).
    assert.doesNotMatch(screen, /reconcile: forKind === "journal"/);
    assert.doesNotMatch(screen, /reconcile: balanceFile !== null/);
    // FUX-08: the VAT settings warning only for vat_books lots; FUX-09: «Ver en Reconciliación» selects the lot's reconciliation.
    assert.match(screen, /const vatSettingsWarning = preview\.kind === "vat_books" && preview\.vatSettingsMissing;/);
    assert.match(screen, /setRecon\(reconciliation\);\s*setView\("reconciliacion"\);/);
    // FUX-04: the USALI column has no showFrom (a create in 6 / 7 must be resolvable on a phone).
    const usaliColumn = screen.slice(screen.indexOf('key: "usali"'), screen.indexOf('key: "origin"'));
    assert.doesNotMatch(usaliColumn, /showFrom/);
    // FUX-11: an inverted range explains itself; FUX-12: «Guardar mapa» never sends rows without a valid destination; FUX-03: stepAfter.
    assert.match(screen, /reconRangeInverted \? \(\s*<CocoaCallout tone="warning" title="Rango de fechas invertido"/);
    assert.match(screen, /const isSaveable = \(dto: LedgerAccountMapDto\): boolean => dto\.action === "block" \|\| accountRowIssue\(dto\) === null;/);
    assert.match(screen, /setStepKey\(stepAfter\(stepsForKind\(kind, analysed\.unmappedAccounts\.length\), "accounts"\)\)/);
    // FUX-07: the primary of «Revisión» names what the lot creates.
    assert.match(screen, /postActionLabel\(kind, preview\?\.entryCount \?\? 0\)/);
    assert.match(screen, /onPick=\{\(picked\) => void pickFile\(picked\)\}/);
    assert.match(screen, /onReject=\{setFileError\}/);
    assert.match(screen, /base64OfArrayBuffer\(await picked\.arrayBuffer\(\)\)/);
    assert.match(screen, /contentBase64: input\.file\.contentBase64/);
    assert.match(screen, /contentBase64: file\.contentBase64/);
    assert.doesNotMatch(stripComments(screen), /\.text\(\)/, "the browser never decodes the file (latin1 and binary must reach the API)");
    assert.doesNotMatch(screen, /\bcontent:/, "the text body of the contract is for the CLI and the tests only");
    assert.match(screen, /downloadLedgerImportTemplate\(kind\)/);
    assert.match(screen, /Descargar plantilla canónica/);
    assert.match(screen, /importKindHint\(kind\)/);
    assert.match(screen, /El fichero no se guarda: solo el lote y el resultado por asiento\./);
  });

  it("corrector CIERRE-1 (FUN-01): «Terceros» is of the whole sociedad — a centre-scoped reader (structure.entityReadable false) gets a specific state, never a request that always fails nor «elige un centro»", () => {
    assert.match(screen, /const thirdPartiesEntityLocked = canRead && finance\.structure !== null && !finance\.structure\.entityReadable;/);
    assert.match(screen, /if \(view !== "terceros" \|\| !canRead \|\| thirdPartiesEntityLocked\) return undefined;/, "no request while the directory is locked for the reader");
    assert.match(screen, /\}, \[view, canRead, thirdPartiesEntityLocked, tpQuery, tpRole, tpNonce\]\);/);
    assert.match(screen, /function renderThirdPartiesView\(\) \{\s*if \(thirdPartiesEntityLocked\) \{\s*return <CocoaState kind="empty" illustration="search" title="Directorio de toda la sociedad" message=\{THIRD_PARTIES_ENTITY_SCOPE_MESSAGE\} \/>;/);
    assert.equal(count(screen, /ledgerThirdPartiesErrorMessage\(err, "No se pudieron cargar (?:los terceros importados|más terceros)\."\)/g), 2, "both directory loads map their errors through the directory helper");
    assert.doesNotMatch(screen, /ledgerImportErrorMessage\(err, "No se pudieron cargar (?:los|más) terceros/);
    assert.match(service, /export function ledgerThirdPartiesErrorMessage\(error: unknown, fallback: string = "No se pudieron cargar los terceros importados\."\): string \{\s*if \(financeErrorCode\(error\) === "ENTITY_SCOPE_REQUIRED"\) return THIRD_PARTIES_ENTITY_SCOPE_MESSAGE;\s*return ledgerImportErrorMessage\(error, fallback\);/);
    const sentence = /export const THIRD_PARTIES_ENTITY_SCOPE_MESSAGE = "([^"]+)";/.exec(service)?.[1] ?? "";
    assert.match(sentence, /accounting\.entity\.read/, "names the key that unlocks the directory");
    assert.match(sentence, /toda la sociedad/);
    assert.doesNotMatch(sentence, /elige un centro|indica el centro|propertyId/, "never a remedy the route does not offer");
    assert.match(sentence, /[.]$/, "full sentence");
  });

  it("paints the steps of the kind with CocoaChart.Progress and ONE aria-current=\"step\" on the step button", () => {
    assert.match(screen, /<CocoaChart\.Progress value=\{\(\(stepIndex \+ 1\) \/ steps\.length\) \* 100\}/);
    assert.match(screen, /<ol className="c22-section__list" aria-label="Pasos del asistente">/);
    const start = screen.indexOf("{steps.map((item, index) => (");
    const end = screen.indexOf("</ol>", start);
    assert.ok(start > 0 && end > start, "step list not found");
    const stepItem = screen.slice(start, end);
    assert.equal(count(stepItem, /aria-current=/g), 1);
    assert.match(stepItem, /<CocoaButton[^>]*wrap fullWidth align="start" aria-current=\{index === stepIndex \? "step" : undefined\}/);
    assert.match(stepItem, /<CocoaBadge tone=\{stepTone\(index, stepIndex\)\} variant="dot" size="small">/);
    assert.match(screen, /const steps = useMemo\(\(\) => stepsForKind\(kind, preview\?\.unmappedAccounts\.length \?\? 0\), \[kind, preview\]\);/);
    assert.match(screen, /<CocoaGrid columns=\{12\} align="start">/);
    assert.match(screen, /<CocoaSpan cols=\{4\} min=\{240\}>/);
    assert.match(screen, /<CocoaSpan cols=\{8\} min=\{480\}>/);
    for (const key of ["file", "accounts", "analytics", "review", "result"]) assert.match(screen, new RegExp(`stepTitle\\(steps, "${key}"\\)`), `section title of ${key}`);
    assert.match(screen, /<CocoaActionBar aria-label="Navegación del asistente de importación desde Sage 200"/);
  });

  it("maps accounts in a virtualised compact table (action · destination over the chart · USALI · origin) with the pending filter, and saves the map through PUT account-map", () => {
    assert.match(screen, /<CocoaTable\s+columns=\{accountColumns\}\s+rows=\{accountRows\}\s+rowKey="sourceAccount"\s+density="compact"\s+virtualize/);
    assert.match(screen, /listChartAccounts\(\{ postableOnly: true \}\)/);
    assert.match(screen, /chartSelectOptions\(chart, \{ postableOnly: true \}\)/);
    assert.match(screen, /<CocoaSearchInput value=\{accountFilter\} onChange=\{setAccountFilter\}/);
    assert.match(screen, /<CocoaSwitch checked=\{onlyPending\} onChange=\{setOnlyPending\} label="Solo pendientes" size="small" \/>/);
    assert.match(screen, /options=\{accountActionOptions\(row\.byRate\)\}/);
    assert.match(screen, /needsUsaliDepartment\(row\.dto\) \? \(\s*<CocoaSelect size="small" inline aria-label=\{`Departamento USALI de la subcuenta[\s\S]*?options=\{USALI_OPTIONS\}/);
    assert.match(screen, /\{ACCOUNT_ORIGIN_LABELS\[row\.origin\]\}/);
    assert.match(screen, /putAccountMap\(\{ system: accountMap\.system, entries: \[\.\.\.merged\.values\(\)\] \}\)/);
    assert.match(screen, /Guardar mapa\s*<\/CocoaButton>/);
    assert.match(screen, /label: "Aplicar y continuar", disabled: previewing \|\| importing \|\| accountIssues > 0/);
    assert.match(screen, /mapping: mappingInput\(input\.kind, input\.choices, input\.analytics\)/);
  });

  it("maps analytics (centre and cost-centre dimensions, code → centre of the scope structure or USALI cost centre, unassigned policy) and warns with centreRequired", () => {
    for (const label of ["Dimensión del centro de trabajo", "Dimensión del centro de coste", "Apuntes de gasto o ingreso sin analítica"]) assert.match(screen, new RegExp(`<CocoaField label="${label}">`), label);
    assert.match(screen, /options=\{centreOptions\}/);
    assert.match(screen, /options=\{COST_CENTRE_OPTIONS\}/);
    assert.match(screen, /const policyOptions = useMemo\(\(\) => unassignedPolicyOptions\(centres\), \[centres\]\);/);
    assert.match(screen, /putAnalyticsMap\(\{ system: analyticsMap\?\.system, centreDimension, costCentreDimension, unassignedPolicy, entries: analyticsInput\.entries \}\)/);
    assert.match(screen, /centreRequiredLine\(row\)/);
    assert.match(screen, /Guardar mapa analítico/);
  });

  it("reviews with the KPI strip, the month and centre tables, the native documents excluded, the warnings callout with the replace switch, the optional Sage balance and «Contabilizar» only on canPost + canImport", () => {
    assert.match(screen, /<CocoaKpiStrip aria-label="Resumen de la revisión">/);
    assert.match(screen, /previewKpis\(preview\)\.map\(/);
    assert.match(screen, /const monthRows = formatByMonthRows\(preview\);/);
    assert.match(screen, /const propertyRows = formatByPropertyRows\(preview\);/);
    assert.match(screen, /title="Documentos propios excluidos"/);
    assert.match(screen, /nativeSkippedLine\(row\)/);
    assert.match(screen, /existingLine\(row\)/);
    assert.match(screen, /closingDetectedLine\(row\)/);
    assert.match(screen, /title="Antes de contabilizar"/);
    for (const marker of ["preview.duplicateOf", "preview.overlaps.length", "preview.payrollCostImportsPosted", "preview.vatSettingsMissing", "preview.existingNativeEntries"]) assert.ok(screen.includes(marker), marker);
    assert.match(screen, /<CocoaSwitch checked=\{replace\} onChange=\{changeReplace\} label="Sustituir los lotes anteriores \(reverso \+ lote nuevo\)" size="small"/);
    assert.match(screen, /label="Balance de sumas y saldos de Sage del mismo periodo"/);
    assert.match(screen, /const postDisabled = !preview\?\.canPost \|\| !canImport \|\| importing \|\| previewing;/);
    assert.match(screen, /disabled: postDisabled \|\| previewStale/);
    assert.match(screen, /const previewStale = preview !== null && previewError !== null;/);
    assert.match(screen, /const blockers = previewBlockers\(preview\);/);
    assert.match(screen, /createLedgerImport\(\{[\s\S]*?post: true,\s*notes: notes\.trim\(\) \|\| undefined\s*\}\)/);
    // A successful commit discards the spent preview (a second «Contabilizar» would end in 409 LEDGER_IMPORT_DUPLICATE).
    assert.match(screen, /setStepKey\("result"\);\s*(?:\/\/[^\n]*\n\s*)*discardPreview\(\);/);
    assert.doesNotMatch(stripComments(screen.slice(screen.indexOf("const runPreview"), screen.indexOf("function discardPreview"))), /setPreview\(null\)/, "a failed re-analysis keeps the preview on screen");
  });

  it("shows the result with the entry lines, the per-entry table, the reconciliation of the lot and the report CSV through saveDownload", () => {
    assert.match(screen, /entryLine\(entry\)/);
    assert.match(screen, /<CocoaTable\s+columns=\{ENTRY_COLUMNS\}\s+rows=\{result\.created\.entries\}/);
    assert.match(screen, /label: "Descargar informe CSV"/);
    assert.match(screen, /buildImportReportCsv\(result\.created\.entries\)/);
    assert.match(screen, /saveDownload\(\{ blob: new Blob\(\[csv\], \{ type: "text\/csv;charset=utf-8" \}\), filename: reportFileName\(result\.created\.import\)/);
    assert.match(screen, /title="Reconciliación del lote"/);
    assert.match(screen, /label: "Nueva importación", onClick: resetAll/);
  });

  it("reconciles a date range against the Sage balance for the scope's centre, paints the semáforo per account with a ledger link, and lists the history", () => {
    assert.match(screen, /<CocoaInput type="date" size="small" value=\{reconFrom\} onChange=\{setReconFrom\}/);
    assert.match(screen, /<CocoaInput type="date" size="small" value=\{reconTo\} onChange=\{setReconTo\}/);
    assert.match(screen, /label="Balance de sumas y saldos de Sage"/);
    assert.match(screen, /reconciliationKpis\(recon\)\.map\(/);
    assert.equal(count(screen, /rowTone=\{reconciliationRowTone\}/g), 2, "the per-account table (lot result and reconciliation view) uses the row semáforo");
    assert.match(screen, /openTabPath\(withQuery\(ledgerUrl, \{ cuenta: row\.accountCode, desde: current\.periodFrom, hasta: current\.periodTo, ambito: finance\.value \}\)\)/);
    assert.match(screen, /const ledgerUrl = urlForScreen\("LedgerScreen"\) \?\? LEDGER_FALLBACK;/);
    assert.match(screen, /useApiData<LedgerReconciliationDto\[\]>\(canRead \? `\$\{LEDGER_IMPORTS_PATH\}\/reconciliation` : null, \{ query: \{ propertyId: finance\.propertyId, limit: RECON_LIST_LIMIT \} \}\)/);
    assert.match(screen, /toArray<LedgerReconciliationDto>\(reconciliations\.data\)/);
    assert.match(screen, /saveDownload\(await downloadReconciliationCsv\(row\.id\)\)/);
    assert.match(screen, /buildReconciliationCsv\(recon\)/);
    assert.match(screen, /emptyState="Todavía no hay reconciliaciones con este ámbito\."/);
  });

  it("lists the lots with «Ver» (drawer), «Contabilizar» (draft) and «Revertir» (posted → destructive dialog with a 3..500 reason); «Autor» is a name, never createdBy raw", () => {
    assert.match(screen, /useApiData<LedgerImportRecord\[\]>\(canRead \? LEDGER_IMPORTS_PATH : null, \{ query: \{ kind: lotKind \|\| undefined, status: lotStatus \|\| undefined, limit: LIST_LIMIT \} \}\)/);
    assert.match(screen, /toArray<LedgerImportRecord>\(lots\.data\)/);
    assert.match(screen, /render: \(row\) => importAuthorLabel\(row\.createdBy, session\)/);
    assert.doesNotMatch(stripComments(screen), /row\.createdBy \?\? EMPTY/);
    assert.match(screen, /import \{ useCurrentUserProfile \} from "\.\.\/\.\.\/services\/usersApi";/);
    assert.match(screen, /emptyState="Todavía no hay lotes importados desde Sage 200\."/);
    assert.match(screen, /rowActionsVisible="always"/);
    assert.match(screen, /canPostImport\(row\) \? \(\s*<CocoaButton[^>]*onClick=\{\(\) => void postLot\(row\)\}/);
    assert.match(screen, /canReverseImport\(row\) \? \(\s*<CocoaButton variant="plain" tone="destructive"/);
    assert.match(screen, /<CocoaDrawer open=\{lotDetail !== null\}/);
    assert.match(screen, /<CocoaDialog\s+open=\{reverseTarget !== null\}[\s\S]*?tone="destructive"/);
    assert.match(screen, /confirmLabel="Revertir lote"/);
    assert.match(screen, /confirmDisabled=\{!isReversalReasonValid\(reverseReason\)\}/);
    assert.match(screen, /<CocoaInput value=\{reverseReason\} onChange=\{setReverseReason\} multiline rows=\{3\} maxLength=\{REVERSAL_REASON_MAX\}/);
    assert.match(screen, /reverseLedgerImport\(reverseTarget\.id, \{ reason: reverseReason\.trim\(\) \}\)/);
    assert.match(screen, /postLedgerImport\(record\.id, \{\}\)/);
    assert.match(helpers, /export const REVERSAL_REASON_MIN = 3;/);
    assert.match(helpers, /export const REVERSAL_REASON_MAX = 500;/);
  });

  it("FIX-1 · F11: the «Terceros» view is a read-only directory (search + role filter, compact table with the lot, «Cargar más» by cursor, CocoaState empty / loading / error) that never prints a withheld name", () => {
    assert.match(screen, /function renderThirdPartiesView\(\)/);
    assert.match(screen, /listLedgerThirdParties\(\{ q: tpQuery\.trim\(\) \|\| undefined, role: tpRole \|\| undefined, limit: THIRD_PARTY_PAGE_LIMIT \}\)/, "first page on view / filter change");
    assert.match(screen, /listLedgerThirdParties\(\{ q: tpQuery\.trim\(\) \|\| undefined, role: tpRole \|\| undefined, limit: THIRD_PARTY_PAGE_LIMIT, cursor \}\)/, "«Cargar más» sends the cursor");
    assert.match(screen, /window\.setTimeout\(\(\) => \{[\s\S]*?listLedgerThirdParties/, "the search is debounced");
    assert.match(screen, /<CocoaFormRow columns=\{2\} aria-label="Filtros del directorio de terceros">/);
    assert.match(screen, /<CocoaInput value=\{tpQuery\} onChange=\{setTpQuery\} placeholder="Código, NIF, cuenta o nombre"/);
    assert.match(screen, /<CocoaSelect value=\{tpRole\} onChange=\{\(value\) => setTpRole\(isThirdPartyRole\(value\) \? value : ""\)\} options=\{\[\.\.\.THIRD_PARTY_ROLE_FILTER_OPTIONS\]\}/);
    assert.match(helpers, /\{ value: "", label: "Todos" \},\s*\{ value: "customer", label: "Clientes" \},\s*\{ value: "supplier", label: "Proveedores" \}/);
    assert.match(screen, /<CocoaSection\s+title="Terceros importados"\s+padding="none"\s+meta=\{tpPage \? plural\(tpPage\.total, "tercero", "terceros"\) : undefined\}/);
    assert.match(screen, /<CocoaTable columns=\{THIRD_PARTY_COLUMNS\} rows=\{rows\} rowKey="id" density="compact"/);
    const columns = screen.slice(screen.indexOf("const THIRD_PARTY_COLUMNS"), screen.indexOf("/** Columns of «Lotes»"));
    for (const label of ["Código", "NIF", "Cuenta Sage", "Rol", "Nombre", "Lote"]) assert.ok(columns.includes(`label: "${label}"`), `column ${label}`);
    assert.match(columns, /key: "sourceAccount"[^\n]*className="cocoa-mono"/, "the Sage account is mono");
    assert.match(columns, /render: \(row\) => row\.name \?\? EMPTY/, "a withheld name paints «—»");
    assert.match(columns, /render: \(row\) => thirdPartyLotLabel\(row\.lote\)/);
    assert.match(screen, /Cargar más/);
    assert.match(screen, /tpPage\?\.nextCursor \? \(/, "«Cargar más» only while the API returns a cursor");
    assert.match(screen, /<CocoaState kind="error" title="No se pudieron cargar los terceros"/);
    assert.match(screen, /<CocoaState kind="loading" title="Cargando los terceros importados…" inline \/>/);
    assert.match(screen, /<CocoaState kind="empty" title="Sin terceros" message=\{thirdPartyEmptyMessage\(filtered\)\} inline \/>/);
    assert.match(service, /export function listLedgerThirdParties\(query: LedgerThirdPartyListQuery = \{\}\): Promise<LedgerThirdPartyPage>/);
    assert.match(service, /apiRequest<LedgerThirdPartyPage>\(`\$\{LEDGER_IMPORTS_PATH\}\/third-parties`, \{ query: compactQuery\(\{ q: query\.q, role: query\.role, limit: query\.limit, cursor: query\.cursor \}\) \}\)/);
    // The name rule lives in the API (ledger-third-parties.service.ts): the screen paints `name` as it arrives and never rebuilds it from other fields.
    assert.doesNotMatch(stripComments(screen), /row\.name\.(?:split|replace|toUpperCase)/);
    assert.match(shared, /name: string \| null;\s*supplierId: string \| null;\s*updatedAt: string;\s*lote: LedgerThirdPartyLotRef \| null;/);
    // No new inline style with the view (rule 1 is re-asserted on the whole file in the first test).
    assert.equal(count(screen.slice(screen.indexOf("function renderThirdPartiesView"), screen.indexOf("const lotRecord = ")), /\bstyle=\{/g), 0);
  });

  it("announces with ONE live region, focuses the step content on every change of step and never puts aria-live on a badge", () => {
    assert.doesNotMatch(screen, /aria-live=/);
    assert.equal(count(screen, /<CocoaLiveRegion message=\{liveMessage\}/g), 1);
    assert.match(screen, /ref=\{stepContentRef\} tabIndex=\{-1\} role="region" aria-label=\{`Paso \$\{number\(stepIndex \+ 1\)\}: \$\{current\?\.label \?\? ""\}`\}/);
    assert.match(screen, /stepContentRef\.current\?\.focus\(\);\s*\}, \[stepKey\]\);/);
  });
});

describe("Contabilidad › Importar desde Sage 200 · helpers y servicio", () => {
  it("the helpers are pure (no React, no api-client, no import.meta), format only through lib/format and own their importAuthorLabel over actor-label", () => {
    const helpersCode = stripComments(helpers);
    assert.doesNotMatch(helpersCode, /from "react"|api-client|import\.meta/);
    assert.match(helpersCode, /from "\.\.\/\.\.\/lib\/format";/);
    assert.doesNotMatch(helpersCode, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/);
    assert.match(helpers, /export function base64OfArrayBuffer\(buffer: ArrayBuffer\): string/);
    assert.match(helpers, /export function detectFormatFromName\(fileName: string \| null \| undefined\): LedgerImportFormat \| null/);
    assert.match(helpers, /export function buildImportReportCsv\(entries: readonly LedgerImportEntryDto\[\]\): string/);
    assert.match(helpers, /export function buildReconciliationCsv\(recon: Pick<LedgerReconciliationDto, "periodFrom" \| "periodTo" \| "rows">\): string/);
    assert.equal(count(helpers, /return `\\uFEFF\$\{lines\.join\("\\r\\n"\)\}\\r\\n`;/g), 2, "both CSV builders write BOM + CRLF");
    assert.match(helpers, /import \{ actorLabel, type ActorSession \} from "\.\/actor-label";/);
    assert.match(helpers, /export function importAuthorLabel\(createdBy: string \| null \| undefined, session: ActorSession\): string/);
    assert.doesNotMatch(helpers, /from "\.\.\/reservations\//, "the reservations wizard keeps its own importAuthorLabel");
    for (const name of ["IMPORT_KIND_OPTIONS", "IMPORT_STEPS", "stepsForKind", "stepTone", "stepStateLabel", "accountActionOptions", "suggestedAccountLabel", "previewBlockers", "entryStatusTone", "entryStatusLabel", "importStatusTone", "importStatusLabel", "reconciliationRowTone", "RECON_STATUS_LABELS", "reconciliationSummary", "formatByMonthRows"]) {
      assert.match(helpers, new RegExp(`export (?:const|function) ${name}\\b`), `helpers export ${name}`);
    }
  });

  it("the service wraps the fifteen routes under /accounting/ledger-imports through apiRequest / apiRequestBlob and carries a Spanish sentence for every LEDGER_IMPORT_ERROR_CODES entry", () => {
    assert.match(service, /export const LEDGER_IMPORTS_PATH = "\/accounting\/ledger-imports";/);
    assert.match(service, /import \{ apiRequest, apiRequestBlob \} from "\.\/api-client";/);
    assert.doesNotMatch(service, /\bfetch\s*\(/);
    for (const fn of ["previewLedgerImport", "createLedgerImport", "listLedgerImports", "getLedgerImport", "postLedgerImport", "reverseLedgerImport", "getAccountMap", "putAccountMap", "getAnalyticsMap", "putAnalyticsMap", "reconcileLedger", "listReconciliations", "getReconciliation", "downloadReconciliationCsv", "downloadLedgerImportTemplate", "listLedgerThirdParties", "ledgerImportErrorMessage"]) {
      assert.match(service, new RegExp(`export (?:async )?function ${fn}\\(`), `service exports ${fn}`);
    }
    for (const route of ["/preview", "/post", "/reverse", "/account-map", "/analytics-map", "/reconciliation", "/csv", "/template", "/third-parties"]) assert.ok(service.includes(route), `route ${route}`);
    assert.match(service, /apiRequestBlob\(`\$\{LEDGER_IMPORTS_PATH\}\/template`, \{ query: \{ kind, format: "csv" \} \}\)/);
    assert.match(service, /financeErrorStatus\(error\) === 413/);
    assert.match(service, /export const LEDGER_IMPORT_ERROR_MESSAGES: Readonly<Record<LedgerImportErrorCode, string>>/);
    const block = /LEDGER_IMPORT_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(shared);
    assert.ok(block, "LEDGER_IMPORT_ERROR_CODES not found in the shared contract");
    const codes = [...block[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    assert.ok(codes.length >= 30, `expected at least 30 codes, parsed ${codes.length}`);
    const messages = /LEDGER_IMPORT_ERROR_MESSAGES[^=]*= Object\.freeze\(\{([\s\S]*?)\}\);/.exec(service);
    assert.ok(messages, "LEDGER_IMPORT_ERROR_MESSAGES not found");
    const keys = [...messages[1].matchAll(/^\s*([A-Z0-9_]+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]] as const);
    assert.deepEqual(
      codes.filter((code) => !keys.some(([key]) => key === code)),
      [],
      "codes without a Spanish sentence"
    );
    for (const [code, sentence] of keys) assert.match(sentence, /[.]$/, `${code}: full sentence`);
    for (const code of ["LEDGER_IMPORT_DUPLICATE", "LEDGER_IMPORT_ACCOUNT_UNMAPPED", "LEDGER_IMPORT_OVERLAP", "LEDGER_IMPORT_ANALYTICS_UNMAPPED", "LEDGER_IMPORT_CENTRE_REQUIRED", "LEDGER_IMPORT_TOO_MANY_ENTRIES"]) assert.match(service, new RegExp(`case "${code}": \\{`), `datum of ${code}`);
    assert.match(service, /«Sustituir los lotes anteriores»/);
    assert.match(surface, /file: "ledgerImportApi\.ts"/);
    assert.match(surface, /errorHelper: "ledgerImportErrorMessage"/);
  });

  it("SOURCE_TYPE_LABELS names the OPERA and Sage 200 source types", () => {
    assert.match(ui, /^\s+pms_shadow_revenue: "Ingresos diarios de OPERA",$/m);
    assert.match(ui, /^\s+sage200_journal: "Diario importado de Sage 200",$/m);
    assert.match(ui, /^\s+sage200_balance: "Saldos importados de Sage 200",$/m);
  });
});

describe("Contabilidad › Importar desde Sage 200 · navegación", () => {
  it("is the sixth tab of Contabilidad in the tree (/finanzas/contabilidad/importar-sage200) for finanzas, dirección and admin", () => {
    const contabilidad = tree.categories.flatMap((category) => category.items).find((item) => item.screenKey === "JournalScreen");
    assert.ok(contabilidad, "JournalScreen item");
    const tab = contabilidad.tabs.find((entry) => entry.screenKey === "Sage200ImportScreen");
    assert.ok(tab, "Importar desde Sage 200 tab");
    assert.equal(tab.label, "Importar desde Sage 200");
    assert.equal(tab.url, "/finanzas/contabilidad/importar-sage200");
    assert.deepEqual(tab.roles, ["finanzas", "direccion", "admin", "auditoria"]); // Tanda 8a: auditoría interna (solo lectura) ve toda Contabilidad
    assert.equal(contabilidad.tabs.length, 6);
    assert.equal(contabilidad.tabs.indexOf(tab), 5, "Importar desde Sage 200 is the last tab (orden 6)");
  });

  it("ContabilidadTabs loads the screen in one line, App.tsx binds the key to the container and ⌘K navigates to it", () => {
    assert.match(tabs, /^\s+Sage200ImportScreen: \(\) => import\("\.\.\/\.\.\/accounting\/Sage200ImportScreen"\)\.then\(\(m\) => \(\{ default: m\.Sage200ImportScreen \}\)\)$/m);
    assert.match(tabs, /importar-sage200/);
    assert.match(app, /^\s+Sage200ImportScreen: ContabilidadTabs,$/m);
    assert.match(provider, /\{ id: "nav\.sage200-import", label: "Importar desde Sage 200", category: "Navegación", onSelect: \(\) => navigateTo\("Sage200ImportScreen"\) \},/);
  });

  it("the pilots CSVs carry the row (11 «;» fields in the nav tree, 15 columns in the inventory)", { skip: !existsSync(navCsvUrl) && "pilots/ not present (CI)" }, () => {
    const navRow = readFileSync(navCsvUrl, "utf8")
      .split("\n")
      .find((line) => line.startsWith("Sage200ImportScreen;"));
    assert.ok(navRow, "nav tree row");
    assert.equal(navRow.split(";").length, 11);
    assert.match(navRow, /;merge-into;JournalScreen;Importar desde Sage 200;\/finanzas\/contabilidad\/importar-sage200;Importar desde Sage 200;finanzas\|direccion\|admin\|auditoria;core;.*;6$/);
    const inventoryRow = readFileSync(inventoryCsvUrl, "utf8")
      .split("\n")
      .find((line) => line.startsWith("Sage200ImportScreen,"));
    assert.ok(inventoryRow, "inventory row");
    assert.match(inventoryRow, /^Sage200ImportScreen,Sage200ImportScreen,screens\/accounting\/Sage200ImportScreen\.tsx,\/finanzas\/contabilidad\/importar-sage200,Importar desde Sage 200,Finanzas,Contabilidad,asset,,erp_accounting,\/accounting\/ledger-imports /);
    assert.match(inventoryRow, /,6,0,nueva \(Tanda 7c\),"/);
  });
});
