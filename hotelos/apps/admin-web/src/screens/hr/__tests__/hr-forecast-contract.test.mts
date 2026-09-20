import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda RRHH · RRHH-9 (diseño docs/design/RRHH-PLANTILLA-NOMINA.md §10 recortado
// por RRHH/recon-delta.md §3.10): la pestaña «Previsión de plantilla» de RRHH y
// nóminas, su cliente tipado y los helpers puros se fijan sobre la fuente — la
// pantalla llega a api-client (import.meta.env) y no carga bajo node --test,
// como payroll-cost-screen-contract.test.mts. Los pins son los que prometió el
// lote: reglas Cocoa 22 (0 `style={`, sin elementos crudos, sin colores
// literales, sin emoji, sin fetch), cabecera del árbol, centro + rango 14/28
// con CocoaDatePicker, CocoaSplitView (sidebar necesidad por día con origen y
// DegradedValue; content tabla + CocoaChart.Bars de tres series), estándares
// editables con «Restablecer valores del sector» (gate hr.standards.manage),
// plantilla máxima con «Aprobar» SOLO con hr.staffing.approve, «Generar
// previsión» con workforce.schedule.manage, `degraded` en todo lo que depende de
// la ocupación y copy en español; y la superficie de services/hrForecastApi.ts.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../HrForecastScreen.tsx");
const helpers = source("../hr-forecast-helpers.ts");
const api = source("../../../services/hrForecastApi.ts");

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

describe("RRHH · pestaña «Previsión de plantilla» (HrForecastScreen.tsx)", () => {
  it("is born under Cocoa 22 with ZERO inline styles, no raw elements, no colour literals, no emoji and no fetch", () => {
    assertCocoaRules("HrForecastScreen.tsx", screen);
    assert.equal(count(screen, /\bstyle=\{/g), 0, "HrForecastScreen.tsx is born without inline styles");
    assert.match(screen, /from "\.\.\/\.\.\/components\/cocoa";/);
    assert.match(screen, /className="cocoa-(?:stack|row|cluster)"/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/v2|\.bo-/);
  });

  it("paints a Cocoa header from the tree (treeHeaderFor) with the centre picker, the 14 / 28 range and the CocoaDatePicker «Desde»", () => {
    assert.match(screen, /const HEADER = treeHeaderFor\("HrForecastScreen", \{ eyebrow: "Finanzas · RRHH y nóminas", title: "Previsión de plantilla" \}\);/);
    assert.match(screen, /<CocoaPage\s+eyebrow=\{HEADER\.eyebrow\}\s+title=\{HEADER\.title\}/);
    assert.match(screen, /<CocoaSelect size="small" inline aria-label="Centro" value=\{centreId\} onChange=\{setCentreChoice\} options=\{centreOptions\}/);
    assert.match(screen, /eligibleCentres\(finance\.structure, finance\.active, \{ excludeOffice: true \}\)/);
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("HrForecastScreen"\)/);
    assert.match(screen, /<CocoaSegmentedControl size="small" aria-label="Rango de días" value=\{rangeDays\} onChange=\{setRangeDays\} options=\{\[\.\.\.FORECAST_RANGE_OPTIONS\]\}/);
    assert.match(screen, /<CocoaDatePicker size="small" aria-label="Desde" value=\{from\} onChange=\{setFrom\} arithmetic today=\{today\}/);
    assert.match(screen, /forecastWindow\(from, parseForecastRangeDays\(rangeDays\), today\)/);
    assert.match(screen, /commands=\{\[\s*\{ id: "hr-forecast-generate"/);
  });

  it("reads forecast, standards and plans through useApiData over the typed paths of hrForecastApi (never fetch, never a hand-written /hr URL)", () => {
    assert.match(screen, /useApiData<LaborForecastListResponse>\(laborForecastPath\(centreId\), \{ query \}\)/);
    assert.match(screen, /useApiData<LaborStandardsResponse>\(laborStandardsPath\(centreId\)\)/);
    assert.match(screen, /useApiData<StaffingPlansResponse>\(staffingPlansPath\(centreId\)\)/);
    assert.match(screen, /const query = useMemo\(\(\) => laborForecastQuery\(window\), \[window\]\);/);
    assert.doesNotMatch(screen, /"\/hr\//, "the screen never types an /hr URL by hand");
    assert.match(screen, /import \{ useApiData \} from "\.\.\/\.\.\/hooks\/useApiData";/);
  });

  it("gates «Generar previsión» on workforce.schedule.manage, the standards on hr.standards.manage and «Aprobar» ONLY on hr.staffing.approve (button absent without it)", () => {
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ canDo, todayIso \} from "\.\.\/accounting\/accounting-ui";/);
    assert.match(screen, /const canGenerate = canDo\(gate, "workforce\.schedule\.manage"\);/);
    assert.match(screen, /const canManageStandards = canDo\(gate, "hr\.standards\.manage"\);/);
    assert.match(screen, /const canApprove = canDo\(gate, "hr\.staffing\.approve"\);/);
    assert.match(screen, /onClick=\{generate\} loading=\{generating\} disabled=\{!canGenerate\}/);
    assert.match(screen, /if \(!canGenerate \|\| generating\) return;/);
    assert.match(screen, /disabled=\{!canManageStandards \|\| resetting\}/);
    assert.match(screen, /disabled=\{!canManageStandards \|\| !draftDirty \|\| Boolean\(firstDraftError\)\}/);
    assert.match(screen, /onClick=\{openPlanDrawer\} disabled=\{!canManageStandards\}/);
    assert.match(screen, /canApprove && planApprovable\(row\) \? \(/);
    assert.match(screen, /if \(!approveTarget \|\| !canApprove \|\| approving\) return;/);
    assert.match(screen, /\{!canGenerate \? <p className="cocoa-note">\{GENERATE_NOTE\}<\/p> : null\}/);
    assert.match(screen, /Necesitas el permiso de estándares de dotación \(hr\.standards\.manage\)/);
    assert.match(screen, /Necesitas el permiso de planificación de turnos \(workforce\.schedule\.manage\)/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
  });

  it("splits the page: sidebar = necesidad por día with source badge and DegradedValue; content = drivers, table necesario · planificado · disponible · máximo aprobado and CocoaChart.Bars with three series", () => {
    assert.match(screen, /<CocoaSplitView sidebar=\{sidebar\} content=\{content\} sidebarWidth=\{300\} collapsibleSidebar \/>/);
    assert.match(screen, /role="list" aria-label="Necesidad por día"/);
    assert.match(screen, /aria-pressed=\{selected\} onClick=\{\(\) => setSelectedDate\(group\.date\)\}/);
    assert.match(screen, /group\.sources\.map\(forecastSourceLabel\)/);
    assert.ok(count(screen, /<DegradedValue label=\{DAY_DEGRADED_LABEL\}/g) >= 7, "every occupancy-dependent figure (day total, required FTE, five drivers) goes through DegradedValue");
    assert.match(screen, /const DAY_DEGRADED_LABEL = "HR_DAY_DEGRADED";/);
    assert.match(screen, /<DegradedBanner degraded=\{degradedLabels\} \/>/);
    assert.match(screen, /degradedCodes\(forecastState\.data\?\.degraded\)/);
    assert.match(screen, /degradedMessages\(forecastState\.data\?\.degraded\)/);
    for (const label of ["Departamento", "Necesario", "Horas", "Planificado", "Disponible", "Máximo aprobado", "Cobertura"]) assert.match(screen, new RegExp(`label: "${label}"`), `column ${label}`);
    assert.match(screen, /row\.plannedHours === null \? "Sin cuadrante"/);
    assert.match(screen, /row\.approvedFte === null \? "Sin plan"/);
    assert.match(screen, /const status = coverageStatus\(row\);/);
    assert.match(screen, /\{row\.degraded \? "Incompleta" : status\.label\}/);
    for (const label of ["Hab. ocupadas", "Llegadas", "Salidas", "Huéspedes", "Desayunos", "Coste estimado"]) assert.match(screen, new RegExp(`<CocoaStat label="${label}"`), `driver ${label}`);
    assert.match(screen, /<CocoaChart\.Bars data=\{dayBarsData\} height=\{180\} valueFormat=\{\(value\) => formatFteUnit\(value\)\} aria-label="FTE necesario, planificado y disponible por departamento del día" \/>/);
    assert.match(screen, /forecastBars\(selectedGroup\.rows\)/);
    assert.match(screen, /FORECAST_SERIES\.map\(\(series\) => \(/);
    assert.match(screen, /<CocoaCallout tone="warning" title="Previsión incompleta">/);
    assert.match(screen, /primaryAction=\{canGenerate \? \{ label: "Generar previsión", onClick: generate \} : undefined\}/);
  });

  it("summarises the period by department and edits the standards in a CocoaTable (inputs per cell) with «Guardar estándares» and «Restablecer valores del sector» behind a CocoaDialog", () => {
    assert.match(screen, /<CocoaSection title="Resumen del periodo"/);
    assert.match(screen, /groupForecastByDepartment\(rows\)/);
    assert.match(screen, /<CocoaSection\s+title="Estándares de dotación"/);
    assert.match(screen, /standardsToDraft\(toArray\(standardsState\.data\?\.standards\)\)/);
    assert.equal(count(screen, /updateStandardDraft\(current, row\.key, "(?:value|allowancePct|coverageFactor)", value\)/g), 3);
    assert.match(screen, /aria-label=\{`Valor · \$\{standardConceptLabel\(row\)\}`\}/);
    assert.match(screen, /standardDraftErrors\(draft\)/);
    assert.match(screen, /standardsDirty\(draft, loadedStandards\)/);
    assert.match(screen, /putLaborStandards\(centreId, standardsPutBody\(draft\)\)/);
    assert.match(screen, /resetLaborStandardDefaults\(centreId\)/);
    assert.match(screen, /Restablecer valores del sector/);
    assert.match(screen, /Guardar estándares/);
    assert.match(screen, /<CocoaDialog\s+open=\{resetOpen\}[\s\S]*?title="Restablecer los valores del sector"[\s\S]*?confirmLabel="Restablecer"\s+onConfirm=\{resetStandards\}/);
    assert.match(screen, /bandsLabel\(row\.bands\)/);
    assert.match(screen, /LABOR_STANDARD_SOURCE_LABELS_ES\[row\.source\]/);
  });

  it("lists the staffing plans by season with «Nuevo borrador» (drawer per department) and approves through a CocoaDialog that names the SoD", () => {
    assert.match(screen, /<CocoaSection\s+title="Plantilla máxima"/);
    assert.match(screen, /sortPlans\(toArray<StaffingPlanDto>\(plansState\.data\?\.plans\)\)/);
    for (const label of ["Año", "Temporada", "Meses", "Estado", "FTE máximo", "Por departamento"]) assert.match(screen, new RegExp(`label: "${label}"`), `plan column ${label}`);
    assert.match(screen, /rowActionsVisible="always"/);
    assert.match(screen, /\{ACTIONS\.approve\}/);
    assert.match(screen, /approveStaffingPlan\(centreId, approveTarget\.id\)/);
    assert.match(screen, /Quien preparó el borrador no puede aprobarlo\./);
    assert.match(screen, /<CocoaDrawer\s+open=\{planOpen\}[\s\S]*?title="Nuevo borrador de plantilla máxima"/);
    assert.match(screen, /createStaffingPlan\(centreId, planDraftBody\(planDraft\)\)/);
    assert.match(screen, /planDraftErrors\(planDraft\)/);
    assert.match(screen, /HR_FORECAST_DEPARTMENTS\.map\(\(department\) => \(/);
    assert.match(screen, /<CocoaField label="Temporada" required error=\{planErrors\.season\}>/);
    assert.match(screen, /<CocoaCallout tone="danger" role="alert" title="No se pudo guardar el borrador">/);
    assert.match(screen, /hrForecastErrorMessage\(error, "No se pudo aprobar el plan\."\)/);
    assert.match(screen, /hrForecastErrorMessage\(error, "No se pudo generar la previsión\."\)/);
  });

  it("speaks Spanish: no English literal of the dictionary in the visible copy", () => {
    for (const literal of ["Save", "Loading", "Status", "Type", "Date", "Name", "Refresh", "Retry", "Period", "Actions", "Draft", "Approve"]) {
      assert.doesNotMatch(screen, new RegExp(`\\b(label|title|placeholder|subtitle|aria-label|message|caption|hint)\\s*[=:]\\s*["']${literal}["']`), `no «${literal}»`);
    }
    for (const literal of ["Generar previsión", "Necesidad por día", "Resumen del periodo", "Estándares de dotación", "Plantilla máxima", "Nuevo borrador", "Guardar borrador"]) assert.match(screen, new RegExp(literal), `copy «${literal}»`);
  });
});

describe("RRHH · helpers puros (hr-forecast-helpers.ts)", () => {
  it("has no React, no api-client, no import.meta and only type imports from @hotelos/shared and components/cocoa", () => {
    assert.doesNotMatch(helpers, /from "react"|import\.meta|api-client|useApiData|\bfetch\s*\(/);
    assert.match(helpers, /^import type \{[\s\S]*?\} from "@hotelos\/shared";/m);
    assert.match(helpers, /^import type \{ CocoaBarsDatum, CocoaSegmentedControlOption, CocoaSelectOption, CocoaTone \} from "\.\.\/\.\.\/components\/cocoa";/m);
    assert.match(helpers, /^import \{ date, money, number, percent \} from "\.\.\/\.\.\/lib\/format";/m);
    assert.doesNotMatch(helpers, /\bIntl\.|toLocale(Date|Time)?String|toFixed\(\d\)\s*\+?\s*["'](€|%)/);
  });

  it("exports the surface the two screens and the test consume (format, tramos, grouping, bars, degraded, drafts, KPIs, alerts)", () => {
    for (const name of [
      "formatFte",
      "formatFteUnit",
      "formatHours",
      "fteFromHours",
      "sumNullable",
      "forecastWindow",
      "bandsLabel",
      "groupForecastByDay",
      "groupForecastByDepartment",
      "coverageStatus",
      "forecastBars",
      "dayBars",
      "degradedCodes",
      "degradedMessages",
      "rowDegradedLabels",
      "standardsToDraft",
      "updateStandardDraft",
      "standardDraftErrors",
      "standardsPutBody",
      "newPlanDraft",
      "planDraftErrors",
      "planDraftBody",
      "planLinesSummary",
      "sortPlans",
      "planApprovable",
      "kpisDegradedLabels",
      "fteVsMaxCaption",
      "laborCostCaption",
      "monthOptions",
      "sortAlerts",
      "contractExpiringAlerts",
      "employeeNameFor",
      // Corrector RRHH: plan aprobado de la temporada seleccionada (RF-13) y total «(parcial)» de un día degradado (RF-16).
      "approvedPlanFor",
      "planCoversMonth",
      "requiredFteLabel"
    ]) {
      assert.match(helpers, new RegExp(`^export function ${name}\\(`, "m"), `export ${name}`);
    }
    assert.match(helpers, /^export const HR_KPI_DEGRADED_CODES = Object\.freeze\(\{/m);
    assert.match(helpers, /^export const COVERAGE_TOLERANCE = 0\.1;/m);
  });
});

describe("RRHH · cliente tipado (services/hrForecastApi.ts)", () => {
  it("wraps the ten /hr routes over apiRequest with its own Spanish error messages (never fetch)", () => {
    assertCocoaRules("hrForecastApi.ts", api);
    assert.match(api, /import \{ apiRequest \} from "\.\/api-client";/);
    assert.doesNotMatch(api, /VITE_API_URL|import\.meta/);
    assert.match(api, /export function laborForecastPath\(propertyId: string\): string \{\s*return `\/hr\/properties\/\$\{encodeURIComponent\(propertyId\)\}\/labor-forecast`;/);
    assert.match(api, /export function laborStandardsPath\(propertyId: string\): string \{\s*return `\/hr\/properties\/\$\{encodeURIComponent\(propertyId\)\}\/standards`;/);
    assert.match(api, /export function staffingPlansPath\(propertyId: string\): string \{\s*return `\/hr\/properties\/\$\{encodeURIComponent\(propertyId\)\}\/staffing-plans`;/);
    for (const fn of ["listLaborForecast", "generateLaborForecast", "listLaborStandards", "putLaborStandards", "resetLaborStandardDefaults", "listStaffingPlans", "createStaffingPlan", "approveStaffingPlan", "getHrKpis", "listHrAlerts"]) {
      assert.match(api, new RegExp(`^export async function ${fn}\\(`, "m"), `export ${fn}`);
    }
    assert.match(api, /apiRequest<LaborForecastGenerateResponse>\(`\$\{laborForecastPath\(propertyId\)\}\/generate`, \{ method: "POST", body: \{ from: window\.from, to: window\.to \} \}\)/);
    assert.match(api, /apiRequest<LaborStandardsWriteResponse>\(laborStandardsPath\(propertyId\), \{ method: "PUT", body \}\)/);
    assert.match(api, /apiRequest<LaborStandardsWriteResponse>\(`\$\{laborStandardsPath\(propertyId\)\}\/reset-defaults`, \{ method: "POST", body: validFrom \? \{ validFrom \} : \{\} \}\)/);
    assert.match(api, /apiRequest<StaffingPlanDto>\(`\$\{staffingPlansPath\(propertyId\)\}\/\$\{encodeURIComponent\(planId\)\}\/approve`, \{ method: "POST", body: \{\} \}\)/);
    assert.match(api, /apiRequest<HrKpisDto>\("\/hr\/kpis", \{ query: hrKpisQuery\(input\) \}\)/);
    assert.match(api, /apiRequest<HrAlertsResponse>\("\/hr\/alerts", \{ query: \{ propertyId \} \}\)/);
    assert.match(api, /export const HR_FORECAST_ERROR_MESSAGES_ES: Readonly<Record<string, string>> = Object\.freeze\(\{/);
    for (const code of ["VALIDATION_ERROR", "PROPERTY_NOT_FOUND", "HR_STANDARD_INVALID", "HR_STAFFING_PLAN_NOT_FOUND", "HR_STAFFING_PLAN_ALREADY_APPROVED", "APPROVAL_SELF_DECISION", "HR_INVALID_TRANSITION", "ENTITY_SCOPE_REQUIRED"]) {
      assert.match(api, new RegExp(`^  ${code}: "[^"]+\\."`, "m"), `message for ${code}`);
    }
    assert.match(api, /APPROVAL_SELF_DECISION: "Quien preparó el plan no puede aprobarlo: pídeselo a dirección\."/);
    assert.match(api, /export function hrForecastErrorMessage\(error: unknown, fallback: string = HR_FORECAST_ERROR_FALLBACK\): string \{/);
    assert.match(api, /if \(like\?\.status === 403\) return HR_FORECAST_FORBIDDEN;/);
    assert.match(api, /export type LaborForecastListResponse = \{[\s\S]*?rows: LaborForecastDayDto\[\];\s*degraded: HrDegradedEntry\[\];/);
  });
});
