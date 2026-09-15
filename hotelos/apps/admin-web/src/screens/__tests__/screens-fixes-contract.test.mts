import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE_CATEGORY_LABELS, moduleCategoryLabel } from "../module-category-labels.ts";

// Regression contract of lote fix:admin-web-screens (Tanda 5 · L1c).
const SRC = fileURLToPath(new URL("../../", import.meta.url));
/** Source without comments (code comments stay in English by convention; only rendered copy is checked). */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), "utf8"));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
const posix = (file: string) => relative(SRC, file).split(sep).join("/");

describe("screens · un solo canal de navegación (code-review#12, code-review#4)", () => {
  it("keeps pushState + PopStateEvent inside CocoaRouteTabs only", () => {
    const offenders = [...walk(join(SRC, "screens")), ...walk(join(SRC, "components"))]
      .filter((file) => /new PopStateEvent\(/.test(readFileSync(file, "utf8")))
      .map(posix)
      .filter((rel) => rel !== "components/cocoa/CocoaRouteTabs.tsx");
    assert.deepEqual(offenders, []);
  });

  it("opens the guest timeline and the folio through their concrete tab URL", () => {
    const queue = read("screens/operations/FrontDeskActionQueue.tsx");
    assert.match(queue, /urlForScreen\("GuestTimelineScreen", \{ id: gid \}\)/);
    assert.match(queue, /urlForScreen\("ReservationDetailWorkspace", \{ id: rid \}\)/);
    assert.doesNotMatch(queue, /searchParams\.set\("guestId"/);
    assert.doesNotMatch(read("screens/operations/NightAuditScreen.tsx"), /navigateToWithGuest|searchParams\.set\("guestId"/);
  });
});

describe("screens · organización de la sesión (browser-roles#10)", () => {
  it("never sends a fixed demo organisation id", () => {
    const offenders = walk(join(SRC, "screens"))
      .filter((file) => /org_demo/.test(readFileSync(file, "utf8")))
      .map(posix);
    assert.deepEqual(offenders, []);
    for (const rel of ["screens/notifications/NotificationsScreen.tsx", "screens/payroll/PayrollScreen.tsx"]) {
      assert.match(read(rel), /const ORG_ID = getActiveOrganizationId\(\);/, rel);
    }
  });
});

describe("screens · cabeceras Cocoa con las etiquetas del árbol (browser-roles#7, #8)", () => {
  it("standalone dashboards paint CocoaPageHeader from treeHeaderFor", () => {
    const expectations: Array<[string, string]> = [
      ["screens/operations/EnergyDashboard.tsx", "EnergyDashboard"],
      ["screens/operations/SalesPipelineDashboard.tsx", "SalesPipelineDashboard"],
      ["screens/revenue/RevenueHomeDashboard.tsx", "RevenueHomeDashboard"],
      ["screens/RevenueRulesScreen.tsx", "RevenueRules"]
    ];
    for (const [rel, key] of expectations) {
      const source = read(rel);
      assert.match(source, new RegExp(`treeHeaderFor\\("${key}"`), rel);
      assert.match(source, /<CocoaPageHeader/, rel);
      assert.doesNotMatch(source, /bo-page-head"|↻ Refresh|Datos de ejemplo|Couldn't load/, rel);
    }
    const sustainability = read("screens/operations/SustainabilityDashboard.tsx");
    assert.match(sustainability, /treeHeaderFor\("SustainabilityDashboard"/);
    assert.match(sustainability, /pageHead\(embedded\)/);
  });

  it("Panel de revenue shows only real data (no sample KPIs, alerts or setup checks)", () => {
    const source = read("screens/revenue/RevenueHomeDashboard.tsx");
    assert.doesNotMatch(source, /Datos de ejemplo|const kpis: RevenueKpi|const alerts: RevenueAlert|setupChecks|Calidad de datos 82%/);
    assert.match(source, /fetchRecommendations\(\)/);
  });
});

describe("screens · copy en español (browser-roles#13)", () => {
  const RETIRED: Array<[string, RegExp]> = [
    ["screens/operations/GroupsEventsDashboard.tsx", /Cupos \/ Allotments|ciclo y release|Active groups/],
    ["screens/reservations/ReservationsListScreen.tsx", /Departure = hoy/],
    ["screens/backoffice/SetupCenterScreen.tsx", /Readiness by area|View items|Guided tools|\} areas<|\} configured<|setup items · data source/],
    ["screens/compliance/GuestRegisterSettingsScreen.tsx", /SES\.HOSPEDAJES connector|Open Compliance Inbox|Rejected \/ failed|Capture the RD/],
    ["screens/fiscal/FiscalDashboard.tsx", /Reports \(Modelos\)|hash chain|Hash chain|Endpoint separado/],
    ["screens/banking/BankReconciliationScreen.tsx", />SupplierBill<|>Payment<|ejecuta auto-match|El drift|Paste CSV first|Import failed|Name is required/],
    ["screens/guestJourney/GuestJourneyWorkspace.tsx", /No reservations yet|No matches|AI booking agent/],
    ["screens/operations/EnergyDashboard.tsx", /consumption in window|currently reporting|\} meters<|\} days<|kWh per occupied room/],
    ["screens/operations/SalesPipelineDashboard.tsx", /currently in pipeline|month-to-date|won \/ \(won|\} stages<|Closed won MTD|expected close/],
    ["screens/operations/SustainabilityDashboard.tsx", /carbon intensity|CO2 \/ room night|% complete|progress not tracked|\} categories</],
    ["screens/notifications/NotificationsScreen.tsx", /Manage templates per channel|Template performance|>7 days<|Templates \(|Deliveries \(/],
    ["screens/ModuleManager.tsx", /\{module\.category\} · \{module\.code\}/],
    ["components/cocoa-rate-grid/helpers.ts", /sandbox del proveedor/],
    ["content/screen-instructions/revenue.ts", /Dashboard de revenue|drill-down|composicion|optimas|Occupancy/]
  ];
  for (const [rel, pattern] of RETIRED) {
    it(`retired the English or jargon copy of ${rel}`, () => {
      assert.doesNotMatch(read(rel), pattern);
    });
  }

  it("labels every module category of the manifest in Spanish", () => {
    for (const code of ["core", "ai", "distribution", "guest", "operations", "finance", "compliance", "asset", "integrations", "commercial", "analytics", "platform"]) {
      assert.ok(MODULE_CATEGORY_LABELS[code], code);
      assert.notEqual(moduleCategoryLabel(code), code, code);
    }
    assert.equal(moduleCategoryLabel("guest"), "Huésped");
    assert.equal(moduleCategoryLabel("unknown_code"), "unknown_code");
  });
});

describe("screens · «Activar módulo» aterriza en la tarjeta (browser-roles#15)", () => {
  it("re-applies scrollIntoView after the cards settle instead of once at mount", () => {
    const source = read("screens/ModuleManager.tsx");
    assert.match(source, /\[focusedCode, cardCount\]/);
    assert.match(source, /requestAnimationFrame/);
    assert.match(source, /getBoundingClientRect/);
  });
});
