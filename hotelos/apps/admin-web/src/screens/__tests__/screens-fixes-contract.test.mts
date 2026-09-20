import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { availabilityLabel, hotelCategoryLabel } from "../../lib/format.ts";
import { MODULE_CATEGORY_LABELS, moduleCategoryLabel } from "../module-category-labels.ts";
import { CodeCell, alertHeadLabel, codeTitle, shopSourceLabel } from "../rate-shopper-labels.ts";

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
      // `CocoaPage` paints the CocoaPageHeader by itself (Cocoa 22 · ola 4): both spellings are a Cocoa header.
      assert.match(source, /<CocoaPage(?:Header)?\b/, rel);
      assert.doesNotMatch(source, /bo-page-head"|↻ Refresh|Datos de ejemplo|Couldn't load/, rel);
    }
    const sustainability = read("screens/operations/SustainabilityDashboard.tsx");
    assert.match(sustainability, /treeHeaderFor\("SustainabilityDashboard"/);
    assert.match(sustainability, /<CocoaPage\b/);
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

// Regression contract of lote fix:5-C (qa#15): the night of a recommendation on
// /revenue/reglas measured 78×16 px on a coarse pointer (COCOA-22.md §5 V6 asks
// ≥ 44 px). The link stays a real <a> (middle-click, «abrir en pestaña nueva»)
// and `.cocoa-link` grows to the tap target on touch. Source-level: the cascade
// is pinned without a browser.
describe("screens · objetivo táctil de los enlaces de fecha (qa#15, fix:5-C)", () => {
  it("la noche de una recomendación sigue siendo un enlace real con .cocoa-link", () => {
    const source = read("screens/RevenueRulesScreen.tsx");
    assert.match(source, /<a href=\{rateGridHref\(r\.targetDate\)\} className="cocoa-link"/);
    assert.doesNotMatch(source, /<CocoaButton[^>]*>\s*\{fmtDate\(r\.targetDate\)\}/);
  });

  it(".cocoa-link crece al objetivo de 44 px solo con puntero grueso y fuera de un párrafo", () => {
    const sheet = read("styles/cocoa-base.css");
    const coarse = sheet.match(/@media \(pointer: coarse\) \{\s*\.cocoa-link:not\(p \*\) \{([^}]*)\}\s*\}/);
    assert.ok(coarse, "the (pointer: coarse) block of .cocoa-link is missing");
    assert.match(coarse[1], /display: inline-flex;/);
    assert.match(coarse[1], /align-items: center;/);
    assert.match(coarse[1], /min-height: var\(--cocoa-touch-target\);/);
    // On a mouse the link keeps its inline line box: the base rule sets no display.
    const base = sheet.match(/\n\.cocoa-link \{([^}]*)\}/);
    assert.ok(base, "the base .cocoa-link rule is missing");
    assert.doesNotMatch(base[1], /display:|min-height:/);
    const tokens = readFileSync(join(SRC, "styles/cocoa-tokens.css"), "utf8");
    assert.match(tokens, /--cocoa-touch-target:\s*44px;/);
  });
});

describe("screens · correcciones de Recepción (fix:3-C)", () => {
  it("Cupos: los dos drawers hermanos llevan keys con prefijo, nunca el mismo contador (qa#5)", () => {
    const source = read("screens/admin/AllotmentsScreen.tsx");
    assert.match(source, /<NewTourOperatorDrawer\s+key=\{`to-\$\{toSession\}`\}/);
    assert.match(source, /<NewAllotmentDrawer\s+key=\{`allot-\$\{allotSession\}`\}/);
    assert.doesNotMatch(source, /key=\{(toSession|allotSession)\}/);
  });

  it("Recorrido: el paso «Habitación asignada» pinta el número de la habitación, nunca su id (qa#9)", () => {
    const source = read("screens/guestJourney/GuestJourneyWorkspace.tsx");
    assert.match(source, /fetchRooms\(PROPERTY_ID\)/);
    assert.match(source, /rooms\.find\(\(r\) => r\.id === selected\.assignedRoomId\)\?\.number/);
    // Tanda L7 · L7-07: computeJourney vive en screens/guestJourney/journey.ts (puro, probado bajo node --test).
    const journey = read("screens/guestJourney/journey.ts");
    assert.match(journey, /assignedRoomNumber \? `Habitación \$\{assignedRoomNumber\}\.` : "Habitación asignada\."/);
    assert.doesNotMatch(journey, /Habitación \$\{res\.assignedRoomId\}/);
    assert.doesNotMatch(source, /Habitación \$\{res\.assignedRoomId\}/);
  });

  it("Recorrido: en portátil (900–1199) la lista apilada es más corta para que el detalle quede a la vista (qa#10)", () => {
    const source = read("screens/guestJourney/GuestJourneyWorkspace.tsx");
    assert.match(source, /const LIST_MAX_HEIGHT_STACKED = 360;/);
    assert.match(source, /maxHeight=\{compact \? undefined : tier === "laptop" \? LIST_MAX_HEIGHT_STACKED : LIST_MAX_HEIGHT\}/);
    // The pair itself stays the Workspace template (4/8 with the canon minimums): the stylesheet packs it.
    assert.match(source, /<CocoaSpan cols=\{4\} min=\{320\}>/);
    assert.match(source, /<CocoaSpan cols=\{8\} min=\{480\}>/);
  });
});

// Regression contract of lote fix:5-C (qa#18): /revenue/competencia painted the
// competitor category as stored («urban» for the three Faranda competitors), the
// channel of a shopped rate («demo») and its availability («available»). The
// cells read in Spanish through lib/format and ./rate-shopper-labels and keep
// the raw code in `title` when it differs; a free-text category typed in the
// form («4*») stays as typed, without a redundant title.
describe("screens · códigos de la competencia en español (qa#18, fix:5-C)", () => {
  const cell = (code: string | null, label: string) => renderToStaticMarkup(createElement(CodeCell, { code, label }));

  it("la columna «Categoría» lee «Urbano» y guarda «urban» en title", () => {
    assert.equal(cell("urban", hotelCategoryLabel("urban")), '<span title="urban">Urbano</span>');
    assert.equal(cell("resort", hotelCategoryLabel("resort")), '<span title="resort">Vacacional</span>');
    assert.equal(cell("urban boutique", hotelCategoryLabel("urban boutique")), '<span title="urban boutique">Boutique urbano</span>');
  });

  it("una categoría libre («4*») se pinta tal cual, sin title redundante; sin categoría, «—»", () => {
    assert.equal(cell("4*", hotelCategoryLabel("4*")), "<span>4*</span>");
    assert.equal(cell("Boutique", hotelCategoryLabel("Boutique")), "<span>Boutique</span>");
    assert.equal(cell(null, hotelCategoryLabel(null)), "<span>—</span>");
    assert.equal(codeTitle("urban", "Urbano"), "urban");
    assert.equal(codeTitle("4*", "4*"), undefined);
    assert.equal(codeTitle(null, "—"), undefined);
  });

  it("el canal «demo» del sondeo interno y la disponibilidad «available» leen en español", () => {
    assert.equal(cell("demo", shopSourceLabel("demo")), '<span title="demo">Sondeo interno</span>');
    assert.equal(shopSourceLabel("manual"), "Registro manual");
    assert.equal(shopSourceLabel("booking_com"), "Booking.com");
    assert.equal(shopSourceLabel("expedia_mock"), "Expedia (conector de pruebas)");
    assert.equal(shopSourceLabel(null), "—");
    assert.equal(cell("available", availabilityLabel("available")), '<span title="available">Disponible</span>');
    assert.equal(cell(null, availabilityLabel(null)), "<span>—</span>");
  });

  it("la cabecera de una alerta de paridad lee el canal o el tipo de alerta en español", () => {
    assert.equal(alertHeadLabel("booking_com", "ota_cheaper_than_direct"), "Booking.com");
    assert.equal(alertHeadLabel(null, "ota_cheaper_than_direct"), "OTA más barata que el directo");
    assert.equal(alertHeadLabel(null, "channel_gap"), "Diferencia con el canal");
    assert.equal(alertHeadLabel(null, "new_alert_type"), "new_alert_type");
  });

  it("la pantalla ya no pinta los códigos como llegan", () => {
    const source = read("screens/RateShopperSettingsScreen.tsx");
    assert.doesNotMatch(source, /render: \(c\) => c\.category \?\? "—"/);
    assert.doesNotMatch(source, /render: \(r\) => r\.(sourceChannel|availabilityStatus) \?\? "—"/);
    assert.doesNotMatch(source, /<strong>\{a\.sourceChannel \?\? a\.alertType\}<\/strong>/);
    assert.match(source, /<CodeCell code=\{c\.category\} label=\{hotelCategoryLabel\(c\.category\)\} \/>/);
    assert.match(source, /<CodeCell code=\{r\.sourceChannel\} label=\{shopSourceLabel\(r\.sourceChannel\)\} \/>/);
    assert.match(source, /<CodeCell code=\{r\.availabilityStatus\} label=\{availabilityLabel\(r\.availabilityStatus\)\} \/>/);
    assert.match(source, /label=\{alertHeadLabel\(a\.sourceChannel, a\.alertType\)\}/);
  });
});
