import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda RRHH · RRHH-9 (diseño docs/design/RRHH-PLANTILLA-NOMINA.md §10 «Panel: la
// foto», recortado por RRHH/recon-delta.md §3.10): la pestaña «Panel RRHH» de
// RRHH y nóminas se fija sobre la fuente (llega a api-client → no carga bajo
// node --test). Pins: reglas Cocoa 22 (0 `style={`, sin elementos crudos, sin
// colores literales, sin emoji, sin fetch), «Ámbito» único de Finanzas, mes,
// CocoaKpiStrip con `degraded` por KPI (nunca un 0 verde), CocoaChart.Bars
// necesidad vs planificado 14 días por departamento, tabla de alertas,
// «Vencimientos 30 días» con el nombre solo bajo hr.employee.read, y copy en
// español.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../HrOverviewScreen.tsx");

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

describe("RRHH · pestaña «Panel RRHH» (HrOverviewScreen.tsx)", () => {
  it("is born under Cocoa 22 with ZERO inline styles, no raw elements, no colour literals, no emoji and no fetch", () => {
    assertCocoaRules("HrOverviewScreen.tsx", screen);
    assert.equal(count(screen, /\bstyle=\{/g), 0, "HrOverviewScreen.tsx is born without inline styles");
    assert.match(screen, /from "\.\.\/\.\.\/components\/cocoa";/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/v2|\.bo-/);
  });

  it("paints the Cocoa header from the tree with the ONE «Ámbito» of Finanzas, the month picker and the refresh command", () => {
    assert.match(screen, /const HEADER = treeHeaderFor\("HrOverviewScreen", \{ eyebrow: "Finanzas · RRHH y nóminas", title: "Panel RRHH" \}\);/);
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("HrOverviewScreen"\), \{ excludeOffice: true \}\)/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\} \/>/);
    assert.match(screen, /eyebrow=\{finance\.eyebrow\("Finanzas"\)\}/);
    assert.match(screen, /<CocoaSelect size="small" inline aria-label="Mes" value=\{period\} onChange=\{setPeriod\} options=\{periodOptions\} \/>/);
    assert.match(screen, /monthOptions\(monthCodeOf\(today\), 12\)/);
    assert.match(screen, /commands=\{\[\{ id: "hr-overview-refresh", label: "Actualizar el panel RRHH", run: refreshAll \}\]\}/);
  });

  it("reads KPIs (sociedad or centre), the 14-day forecast, the alerts and — only with hr.employee.read — the PII-free employee listing through useApiData", () => {
    assert.match(screen, /useApiData<HrKpisDto>\("\/hr\/kpis", \{ query: kpisQuery \}\)/);
    assert.match(screen, /hrKpisQuery\(\{ propertyId: finance\.propertyId \?\? null, period \}\)/);
    assert.match(screen, /const centreId = finance\.propertyId \?\? finance\.active\.propertyId;/);
    assert.match(screen, /forecastWindow\(today, DEFAULT_FORECAST_RANGE_DAYS, today\)/);
    assert.match(screen, /useApiData<LaborForecastListResponse>\(laborForecastPath\(centreId\), \{ query: forecastQuery \}\)/);
    assert.match(screen, /useApiData<HrAlertsResponse>\("\/hr\/alerts", \{ query: \{ propertyId: centreId \} \}\)/);
    assert.match(screen, /const canReadEmployees = canDo\(gate, "hr\.employee\.read"\);/);
    assert.match(screen, /useApiData<EmployeeSummaryDto\[\]>\(canReadEmployees \? "\/hr\/employees" : null, \{ query: \{ propertyId: centreId \} \}\)/);
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ canDo, todayIso \} from "\.\.\/accounting\/accounting-ui";/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
  });

  it("paints the KPI strip with `degraded` on every tile that depends on a figure the API may not have (never a green 0)", () => {
    assert.match(screen, /<CocoaKpiStrip stagger aria-label="Indicadores de plantilla">/);
    for (const label of ["Plantilla activa", "FTE disponible", "FTE necesario", "Coste del mes", "Coste por empleado", "Alertas abiertas"]) {
      assert.match(screen, new RegExp(`<CocoaKpi label="${label}"[^>]*degraded=\\{`), `KPI ${label} carries degraded`);
    }
    assert.equal(count(screen, /<CocoaKpi /g), 6);
    assert.match(screen, /const availableDegraded = !kpis \|\| kpis\.availableFte === null \|\| isDegraded\(HR_KPI_DEGRADED_CODES\.availableFte, kpiLabels\);/);
    assert.match(screen, /const requiredDegraded = !kpis \|\| kpis\.requiredFte === null \|\| isDegraded\(HR_KPI_DEGRADED_CODES\.requiredFte, kpiLabels\);/);
    assert.match(screen, /const costDegraded = !kpis \|\| kpis\.monthLaborCost === null \|\| isDegraded\(HR_KPI_DEGRADED_CODES\.monthLaborCost, kpiLabels\);/);
    assert.match(screen, /kpisDegradedLabels\(kpis\)/);
    assert.match(screen, /status=\{kpis \? fteKpiStatus\(kpis\.availableFte, kpis\.approvedMaxFte\) : "warning"\}/);
    assert.match(screen, /caption=\{kpis \? fteVsMaxCaption\(kpis\.availableFte, kpis\.approvedMaxFte\) : undefined\}/);
    // RF-09: the caption names the source when the cost comes from the calculated payroll (no sales → no %).
    assert.match(screen, /caption=\{kpis \? laborCostCaption\(kpis\.laborCostPctOfSales, kpis\.salesSource, kpis\.monthLaborCostSource\) : undefined\}/);
    assert.match(screen, /status=\{kpis && kpis\.alertsCount > 0 \? "warning" : "ok"\}/);
    assert.match(screen, /<DegradedBanner degraded=\{degradedAll\} \/>/);
    assert.match(screen, /new Set\(\[\.\.\.kpiLabels, \.\.\.forecastLabels, \.\.\.alertLabels\]\)/);
  });

  it("charts necesidad vs planificado of the next 14 days per department (CocoaSelect) in a 6 + 6 grid with «Vencimientos 30 días», and lists the alerts by severity", () => {
    assert.match(screen, /<CocoaGrid aria-label="Previsión y alertas" align="start">/);
    assert.equal(count(screen, /<CocoaSpan cols=\{6\} min=\{320\}>/g), 2);
    assert.match(screen, /<CocoaSection\s+title="Necesidad frente a planificado · 14 días"/);
    assert.match(screen, /<CocoaSelect size="small" inline aria-label="Departamento" value=\{chartDepartment\} onChange=\{setDepartment\} options=\{departmentOptions\}/);
    assert.match(screen, /forecastDepartmentOptions\(rows\)/);
    assert.match(screen, /groupForecastByDay\(filterForecastDepartment\(rows, chartDepartment\)\)/);
    assert.match(screen, /const requiredBars = useMemo\(\(\) => dayBars\(dayGroups, "required"\), \[dayGroups\]\);/);
    assert.match(screen, /const plannedBars = useMemo\(\(\) => dayBars\(dayGroups, "planned"\), \[dayGroups\]\);/);
    assert.match(screen, /<DegradedValue label="HR_FORECAST_MISSING" degraded=\{dayGroups\.length === 0 \? forecastLabels : \[\]\}>/);
    // One chart per series (14 bars each): 28 interleaved bars did not fit half a grid at 1440.
    assert.match(screen, /<CocoaChart\.Bars data=\{requiredBars\} height=\{140\} valueFormat=\{\(value\) => formatFte\(value\)\} aria-label="FTE necesario por día de los próximos 14 días" \/>/);
    assert.match(screen, /<CocoaChart\.Bars data=\{plannedBars\} height=\{140\} valueFormat=\{\(value\) => formatFte\(value\)\} aria-label="FTE planificado por día de los próximos 14 días" \/>/);
    assert.equal(count(screen, /<CocoaChart\.Bars /g), 2);
    assert.match(screen, /title="Sin previsión generada para los próximos 14 días\."/);
    assert.match(screen, /<CocoaSection title="Vencimientos 30 días"/);
    assert.match(screen, /contractExpiringAlerts\(alerts\)/);
    assert.match(screen, /canReadEmployees \? employeeNameFor\(employees, row\.employeeId\) : "—"/);
    assert.match(screen, /Los nombres de las personas exigen el permiso de lectura del expediente \(hr\.employee\.read\)/);
    assert.match(screen, /<CocoaSection title="Alertas"/);
    assert.match(screen, /sortAlerts\(toArray<HrAlertDto>\(alertsState\.data\?\.alerts\)\)/);
    for (const label of ["Gravedad", "Alerta", "Departamento", "Día", "Detalle", "Valor · umbral", "Persona", "Vence"]) assert.match(screen, new RegExp(`label: "${label}"`), `column ${label}`);
    assert.match(screen, /<CocoaBadge tone=\{alertTone\(row\.severity\)\} variant="tinted" size="small">/);
    assert.match(screen, /rowTone=\{\(row\) => \(row\.severity === "critical" \? "danger" : undefined\)\}/);
    assert.match(screen, /la previsión y las alertas son del centro activo/);
  });

  it("speaks Spanish: no English literal of the dictionary in the visible copy", () => {
    for (const literal of ["Save", "Loading", "Status", "Type", "Date", "Name", "Refresh", "Retry", "Period", "Actions", "Dashboard", "Details"]) {
      assert.doesNotMatch(screen, new RegExp(`\\b(label|title|placeholder|subtitle|aria-label|message|caption|hint)\\s*[=:]\\s*["']${literal}["']`), `no «${literal}»`);
    }
    for (const literal of ["La foto de la plantilla", "Indicadores de plantilla", "Sin alertas de plantilla", "Ningún contrato vence en los próximos 30 días"]) assert.match(screen, new RegExp(literal), `copy «${literal}»`);
  });
});
