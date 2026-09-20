import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda RRHH · PANEL-B (diseño docs/design/PANEL-COSTES-DIRECCION.md §8 y §8.1
// recortados al bloque laboral por RRHH/recon-delta.md §3.8): la pestaña
// «Costes de personal» de Hoy › Mi día se fija sobre la fuente (llega a
// api-client → no carga bajo node --test). Pins: reglas Cocoa 22 (0 `style={`,
// sin elementos crudos, sin colores literales, sin emoji, sin fetch), «Ámbito»
// único de Finanzas, mes + ventana Mes / Acumulado del año, CocoaKpiStrip de 4
// con `degraded` por KPI (nunca un 0 verde: un mes sin fuente llega como "0.00"
// y se pinta «—»), barras por departamento con «Sin desglose» como serie
// propia y su callout, tabla centro × departamento con pie de totales, ranking
// de la sociedad, fuentes, cableado de la pestaña (MiDiaTabs, App.tsx,
// financeScope, guideContent) y copy en español.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../DirectorLaborCostsScreen.tsx");
const helpers = source("../labor-costs-helpers.ts");
const api = source("../../../services/laborCostPanelApi.ts");
const miDiaTabs = source("../../tabs/hoy/MiDiaTabs.tsx");
const app = source("../../../App.tsx");
const financeScope = source("../../../services/financeScope.ts");
const guide = source("../../../components/guide/guideContent.ts");

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
  assert.doesNotMatch(src, /<h1\b/, `${name}: no raw <h1>`);
}

describe("PANEL-B · pestaña «Costes de personal» de Mi día (DirectorLaborCostsScreen.tsx)", () => {
  it("is born under Cocoa 22 with ZERO inline styles, no raw elements, no colour literals, no emoji and no fetch", () => {
    assertCocoaRules("DirectorLaborCostsScreen.tsx", screen);
    assert.equal(count(screen, /\bstyle=\{/g), 0, "DirectorLaborCostsScreen.tsx is born without inline styles");
    assert.match(screen, /from "\.\.\/\.\.\/components\/cocoa";/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/v2|\.bo-/);
    assert.doesNotMatch(helpers, /\bfetch\s*\(|from "react"/, "the helpers are pure: no React, no network");
    assert.doesNotMatch(api, /\bfetch\s*\(/, "laborCostPanelApi.ts never fetches directly");
    assert.match(api, /import \{ apiRequest \} from "\.\/api-client";/);
  });

  it("paints the Cocoa header from the tree with the ONE «Ámbito» of Finanzas, the month picker, the Mes / Acumulado window and the refresh commands", () => {
    assert.match(screen, /const HEADER = treeHeaderFor\("DirectorLaborCostsScreen", \{ eyebrow: "Hoy · Mi día", title: "Costes de personal" \}\);/);
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("DirectorLaborCostsScreen"\)\)/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\} \/>/);
    assert.match(screen, /eyebrow=\{finance\.eyebrow\("Hoy"\)\}/);
    assert.match(screen, /<CocoaSelect size="small" inline aria-label="Mes" value=\{period\} onChange=\{setPeriod\} options=\{periodOptions\} \/>/);
    assert.match(screen, /monthOptions\(monthCodeOf\(today\), 24\)/);
    assert.match(screen, /<CocoaSegmentedControl size="small" aria-label="Ventana" value=\{mode\} onChange=\{\(value\) => setMode\(parseWindowMode\(value\)\)\} options=\{\[\.\.\.LABOR_WINDOW_OPTIONS\]\} \/>/);
    assert.match(screen, /laborWindow\(period, mode\)/);
    assert.match(screen, /\{ id: "costes-actualizar", label: "Actualizar los costes de personal", run: refresh \}/);
    assert.match(screen, /\{ id: "costes-periodo-anterior", label: "Costes de personal: mes anterior", run: goPreviousPeriod \}/);
    assert.match(screen, /\{ id: "costes-ventana-anual", label: "Costes de personal: acumulado del año", run: \(\) => setMode\("ytd"\) \}/);
  });

  it("reads GET /payroll/labor-cost-panel through useApiData with the window and the scope (sociedad without propertyId, centre with it) and waits for the structure", () => {
    assert.match(api, /export const LABOR_COST_PANEL_PATH = "\/payroll\/labor-cost-panel";/);
    assert.match(api, /propertyId: input\.propertyId \?\? undefined/);
    assert.match(api, /return apiRequest<LaborCostPanelDto>\(LABOR_COST_PANEL_PATH, \{ query: laborCostPanelQuery\(input\) \}\);/);
    assert.match(screen, /laborCostPanelQuery\(\{ from: window\.from, to: window\.to, propertyId: finance\.propertyId \?\? null \}\)/);
    assert.match(screen, /useApiData<LaborCostPanelDto>\(finance\.loading \? null : LABOR_COST_PANEL_PATH, \{ query \}\)/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
    // Errores tipados en español (ENTITY_SCOPE_REQUIRED cuando la sociedad no es legible; 403 sin payroll.read).
    assert.match(api, /ENTITY_SCOPE_REQUIRED: "Toda la sociedad exige el permiso de lectura de la sociedad \(accounting\.entity\.read\)/);
    assert.match(api, /export const LABOR_COST_PANEL_FORBIDDEN = "Sin permiso para ver los costes de personal \(payroll\.read\)\.";/);
  });

  it("paints the 4-KPI strip with `degraded` on every tile (a month without source is «—», never a green 0) and the Δ vs previous period on the cost", () => {
    assert.match(screen, /<CocoaKpiStrip stagger aria-label="Indicadores de coste de personal">/);
    for (const label of ["Coste de personal", "% sobre ventas", "Coste por empleado", "CPOR laboral"]) {
      assert.match(screen, new RegExp(`<CocoaKpi\\s+label="${label.replace(/[%]/g, "\\$&")}"[^]*?degraded=\\{`), `KPI ${label} carries degraded`);
    }
    assert.equal(count(screen, /<CocoaKpi\b/g), 4);
    assert.match(screen, /const hasCost = useMemo\(\(\) => hasLaborCost\(months\), \[months\]\);/);
    assert.match(screen, /const costDegraded = !panel \|\| !hasCost;/);
    assert.match(screen, /const pctDegraded = !panel \|\| !hasCost \|\| panel\.totals\.pctOfSales === null;/);
    assert.match(screen, /const employeeDegraded = !panel \|\| !hasCost \|\| panel\.totals\.costPerEmployee === null;/);
    // CPOR: «—» solo sin cifra (RN de ningún centro); con RN en parte de los centros o mes incompleto, cifra en aviso y el pie dice «n de m centros».
    assert.match(screen, /const cporDegraded = !panel \|\| !hasCost \|\| panel\.totals\.laborCostPerOccupiedRoom === null;/);
    assert.match(screen, /const cporStatus = cporDegraded \|\| isDegraded\(\[LABOR_PANEL_DEGRADED_CODES\.rnMissing, LABOR_PANEL_DEGRADED_CODES\.rnPartial\], codes\) \? "warning" : "ok";/);
    assert.match(screen, /cporCaption\(panel\.totals\.roomNights, rnSource, entityScope \? roomNightsCoverage\(panel\.sources\) : null\)/);
    assert.match(screen, /value=\{panel \? formatMoney\(panel\.totals\.laborCost, hasCost\) : "—"\}/);
    assert.match(screen, /const delta = panel && hasCost \? deltaOf\(panel\.totals\.deltaPrevious\) : undefined;/);
    assert.match(screen, /delta=\{delta\}/);
    // Sin ventana anterior con coste no hay Δ: ni cifra ni la etiqueta «vs periodo anterior» (visto en runtime con org_hr).
    assert.match(screen, /deltaLabel=\{delta === undefined \? undefined : "vs periodo anterior"\}/);
    assert.match(screen, /polarity="negative-good"/);
    assert.match(screen, /caption=\{panel \? salesCaption\(panel\.totals\.sales, months\) : undefined\}/);
    assert.match(screen, /caption=\{panel \? costPerEmployeeCaption\(panel\.totals\.headcount\) : undefined\}/);
    assert.match(screen, /<DegradedBanner degraded=\{labels\} \/>/);
    assert.match(helpers, /export function formatMoney\(value: Numeric, hasSource = true\): string \{\n  if \(!hasSource\) return EMPTY_FIGURE;/);
  });

  it("charts the departments with «Sin desglose» as its own series and explains it, tabulates centre × department with totals, ranks the sociedad or lists the centre's months, and shows the sources", () => {
    assert.match(screen, /departmentBars\(panel\?\.totals\.byDepartment \?\? \[\]\)/);
    assert.match(screen, /<CocoaChart\.Bars data=\{bars\} height=\{180\} valueFormat=\{\(value\) => formatMoney\(value\)\} aria-label="Coste de personal por departamento USALI de la ventana" \/>/);
    assert.match(helpers, /tone: row\.usaliDepartment === NO_BREAKDOWN \? NO_BREAKDOWN_TONE : undefined/);
    assert.match(screen, /<CocoaCallout tone="warning" title=\{`\$\{NO_BREAKDOWN_LABEL_ES\} por departamento`\}>/);
    assert.match(screen, /noBreakdownNote\(months\)/);
    assert.match(helpers, /el coste de personal viene de las cuentas 640\/642 del diario sin centro de coste y no se puede repartir por departamento/);
    assert.match(screen, /<CocoaCallout tone="info" title="Diario y lote en el mismo mes">/);
    assert.match(screen, /<CocoaGrid aria-label="Departamentos y centros" align="start">/);
    assert.equal(count(screen, /<CocoaSpan cols=\{6\} min=\{320\}>/g), 2);
    assert.match(screen, /<CocoaSection title="Coste por departamento"/);
    assert.match(screen, /<CocoaSection title="Centros por % s\/ ventas"/);
    assert.match(screen, /<CocoaSection title="Meses del centro"/);
    assert.match(screen, /entityScope \? \(/);
    assert.match(screen, /<CocoaSection title="Centro × departamento"/);
    assert.match(screen, /<CocoaTable columns=\{centreColumns\} rows=\{rows\} rowKey="key" caption="Coste de personal por centro y departamento USALI" aria-label="Coste de personal por centro y departamento USALI" density="compact" stickyFirstColumn footer=\{footer\} rowTone=\{\(row\) => \(row\.hasCost \? undefined : "warning"\)\} \/>/);
    assert.match(screen, /centreFooter\(panel\?\.totals, hasCost\)/);
    assert.match(screen, /presentDepartments\(panel\)/);
    assert.match(screen, /hideOnNarrow: department === "rooms" \|\| department === "fnb" \|\| department === NO_BREAKDOWN/);
    assert.match(screen, /rankingRows\(panel\?\.ranking\)/);
    assert.match(screen, /rowTone=\{\(row\) => \(row\.hasSales \? undefined : "warning"\)\}/);
    assert.match(screen, /monthRows\(panel\.centres\[0\]\?\.months\)/);
    assert.match(screen, /<CocoaSection title="Fuentes"/);
    assert.match(screen, /sourcesSummary\(panel\?\.sources\)/);
    for (const label of ["Centro", "Total", "% s/ ventas", "Fuente", "Nº", "Coste", "Mes", "CPOR laboral", "Plantilla"]) assert.match(screen, new RegExp(`label: "${label.replace(/[%/]/g, "\\$&")}"`), `column ${label}`);
    assert.match(screen, /<CocoaSkeleton\.Strip count=\{4\} \/>/);
    assert.match(screen, /<CocoaSkeleton\.Grid rows=\{\[\[6, 6\]\]\} height=\{220\} \/>/);
  });

  it("is wired as the tab /hoy/costes-personal of Mi día (loader, App.tsx, finance scope policy, guide narration)", () => {
    assert.match(miDiaTabs, /DirectorLaborCostsScreen: \(\) => import\("\.\.\/\.\.\/costs\/DirectorLaborCostsScreen"\)\.then\(\(m\) => \(\{ default: m\.DirectorLaborCostsScreen \}\)\)/);
    assert.match(app, /DirectorLaborCostsScreen: MiDiaTabs,/);
    assert.match(financeScope, /DirectorLaborCostsScreen: "entity_default",/);
    // La narración del ítem Mi día + la lista generada «Pestañas: …» debe caber en 400 caracteres (guideContent.test «is too long»).
    assert.match(guide, /Costes de personal: lo que cuesta la plantilla frente a las ventas, con la fuente de cada cifra\./);
  });

  it("speaks Spanish: no English literal of the dictionary in the visible copy", () => {
    for (const literal of ["Save", "Loading", "Status", "Type", "Date", "Name", "Refresh", "Retry", "Period", "Actions", "Dashboard", "Details", "Amount", "Count"]) {
      assert.doesNotMatch(screen, new RegExp(`\\b(label|title|placeholder|subtitle|aria-label|message|caption|hint)\\s*[=:]\\s*["']${literal}["']`), `no «${literal}»`);
    }
    for (const literal of ["Coste de personal del centro o de toda la sociedad frente a las ventas", "Sin coste de personal en la ventana\\.", "Indicadores de coste de personal", "Datos incompletos", "vs periodo anterior", "por habitación ocupada"]) assert.match(screen, new RegExp(literal), `copy «${literal}»`);
    assert.doesNotMatch(screen, /\bTODO\b|Próximamente|coming soon/i);
  });
});
