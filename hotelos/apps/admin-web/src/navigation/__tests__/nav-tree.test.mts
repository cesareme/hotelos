import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEV_MODE_STORAGE_KEY,
  DEV_ONLY_PREFIX,
  NAV_CATEGORIES,
  NAV_TREE,
  allUrls,
  countVisible,
  fillParams,
  findByScreen,
  findByUrl,
  gatingModuleCodes,
  hasRouteParams,
  isDevModeEnabled,
  isDevOnlyPath,
  landingTabFor,
  matchPath,
  menuEntriesUnlockedBy,
  normalizePathname,
  paintableTabs,
  resolveLegacyPath,
  urlForScreen,
  visibleCategories,
  type NavItem
} from "../nav-tree.ts";
import { ROLE_TOKENS, roleHome, type RoleToken } from "../role-tokens.ts";

// Faranda Rías Altas / Los Tilos today (pilots/tanda5-nav-tree.md §6).
const FARANDA_MODULES = ["pms_core", "compliance_hub", "distribution_hub", "guest_experience", "outlet_pos", "revenue_profit_engine"];
const ALL_MODULES = gatingModuleCodes();

function item(label: string): NavItem {
  for (const category of NAV_CATEGORIES) {
    const found = category.items.find((candidate) => candidate.label === label);
    if (found) return found;
  }
  throw new Error(`item ${label} not in tree`);
}

describe("nav-tree · generated tree shape", () => {
  it("has the nine plan categories in menu order", () => {
    assert.deepEqual(
      NAV_CATEGORIES.map((category) => category.key),
      ["hoy", "recepcion", "operaciones", "comercial", "revenue", "finanzas", "cumplimiento", "informes", "configuracion"]
    );
    assert.equal(NAV_TREE.meta.counts.items, 64);
    assert.equal(NAV_TREE.meta.counts.tabs, 80);
    assert.equal(NAV_TREE.devOnly.length, 20);
    assert.equal(NAV_TREE.publicScreens.length, 2);
  });

  it("starts Hoy with Mi día and its role-landing tabs", () => {
    const today = item("Mi día");
    assert.equal(today.url, "/hoy");
    assert.equal(today.baseTab, "Recepción");
    assert.deepEqual(
      today.tabs.map((tab) => tab.url),
      ["/hoy/operaciones", "/hoy/direccion", "/hoy/propietario"]
    );
  });
});

describe("nav-tree · paths", () => {
  it("normalizes and matches segment by segment with :params", () => {
    assert.equal(normalizePathname("/hoy/"), "/hoy");
    assert.equal(normalizePathname("/hoy?x=1#y"), "/hoy");
    assert.equal(normalizePathname("/"), "/");
    assert.deepEqual(matchPath("/recepcion/reservas/:id", "/recepcion/reservas/RS%2D1"), { id: "RS-1" });
    assert.equal(matchPath("/recepcion/reservas/:id", "/recepcion/reservas"), null);
    assert.equal(matchPath("/recepcion/reservas/:id", "/recepcion/reservas/a/recorrido"), null);
    assert.deepEqual(matchPath("/hoy", "/hoy/"), {});
    assert.equal(hasRouteParams("/informes/cartera/:propiedad"), true);
    assert.equal(hasRouteParams("/informes/cartera"), false);
    assert.equal(fillParams("/recepcion/huespedes/:id/cronologia", { id: "g 1" }), "/recepcion/huespedes/g%201/cronologia");
    assert.equal(fillParams("/x/:a/:b", { a: 1 }), "/x/1/:b");
  });

  it("recognises the dev-only prefix and the dev switch", () => {
    assert.equal(DEV_ONLY_PREFIX, "/desarrollo");
    assert.equal(isDevOnlyPath("/desarrollo/migracion"), true);
    assert.equal(isDevOnlyPath("/desarrollo"), true);
    assert.equal(isDevOnlyPath("/desarrollos"), false);
    assert.equal(DEV_MODE_STORAGE_KEY, "anfitorio.dev");
    assert.equal(isDevModeEnabled({ search: "?dev=1" }), true);
    assert.equal(isDevModeEnabled({ search: "dev=1&x=2" }), true);
    assert.equal(isDevModeEnabled({ search: "?dev=0", storageValue: "1" }), true);
    assert.equal(isDevModeEnabled({ search: "", storageValue: null }), false);
  });
});

describe("nav-tree · lookups", () => {
  it("finds items, tabs, detail sub-URLs, dev-only and public screens by URL", () => {
    const today = findByUrl("/hoy");
    assert.equal(today?.kind, "item");
    assert.equal(today?.kind === "item" && today.item.screenKey, "FrontDeskDashboard");
    const ops = findByUrl("/hoy/operaciones/");
    assert.equal(ops?.kind === "tab" && ops.tab.screenKey, "OperationsDirectorScreen");
    const detail = findByUrl("/recepcion/reservas/RS-42");
    assert.equal(detail?.kind, "tab");
    assert.equal(detail?.kind === "tab" && detail.tab.screenKey, "ReservationDetailWorkspace");
    assert.deepEqual(detail?.params, { id: "RS-42" });
    // Static URL wins over the :id sibling.
    const create = findByUrl("/recepcion/reservas/nueva");
    assert.equal(create?.kind === "item" && create.item.screenKey, "ReservationCreate");
    const journey = findByUrl("/recepcion/reservas/RS-42/recorrido");
    assert.equal(journey?.kind === "tab" && journey.tab.screenKey, "GuestJourneyWorkspace");
    const dev = findByUrl("/desarrollo/migracion");
    assert.equal(dev?.kind === "dev-only" && dev.screen.screenKey, "OnboardingProjects");
    const login = findByUrl("/acceso");
    assert.equal(login?.kind === "public" && login.screen.screenKey, "LoginScreen");
    assert.equal(findByUrl("/no-existe"), null);
    assert.equal(findByUrl("/backoffice"), null);
  });

  it("finds screens by key, following aliases and retirements", () => {
    assert.equal(findByScreen("RateJournalScreen")?.kind, "tab");
    assert.equal(findByScreen("RateJournalScreen")?.url, "/revenue/parrilla/historial");
    assert.equal(findByScreen("ChannelManagerDashboard")?.kind, "alias");
    assert.equal(urlForScreen("ChannelManagerDashboard"), "/comercial/canales");
    assert.equal(findByScreen("AISettings")?.kind, "retired");
    assert.equal(urlForScreen("AISettings"), "/configuracion/ia");
    assert.equal(urlForScreen("PersonaLandingScreen"), null);
    assert.equal(urlForScreen("GuestDetail", { id: "g1" }), "/recepcion/huespedes/g1");
    assert.equal(urlForScreen("LoginScreen"), "/acceso");
    assert.equal(urlForScreen("Nope"), null);
  });

  it("lists every URL the router must register, unique and without /backoffice", () => {
    const urls = allUrls();
    assert.equal(urls.length, 64 + 80 + 20 + 2);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(urls.every((url) => !url.startsWith("/backoffice")));
  });
});

describe("nav-tree · legacy redirects (§5)", () => {
  it("resolves the 205 old /backoffice/* paths", () => {
    assert.equal(NAV_TREE.legacyRoutes.length, 205);
    for (const route of NAV_TREE.legacyRoutes) {
      const sample = route.from.replace(/:[A-Za-z0-9_]+/g, "x1");
      assert.ok(resolveLegacyPath(sample), `${route.from} does not resolve`);
    }
  });

  it("maps params by position and cuts before params the old URL never had", () => {
    assert.equal(resolveLegacyPath("/backoffice"), "/hoy");
    assert.equal(resolveLegacyPath("/backoffice/"), "/hoy");
    assert.equal(resolveLegacyPath("/backoffice/reservations/RS-1"), "/recepcion/reservas/RS-1");
    assert.equal(resolveLegacyPath("/backoffice/reservations/new"), "/recepcion/reservas/nueva");
    assert.equal(resolveLegacyPath("/backoffice/guests/g1"), "/recepcion/huespedes/g1");
    assert.equal(
      resolveLegacyPath("/backoffice/configuration/categories/room_features/options/new"),
      "/configuracion/propiedad/categorias/room_features/opciones/nueva"
    );
    assert.equal(resolveLegacyPath("/backoffice/guest-journey"), "/recepcion/reservas");
    assert.equal(resolveLegacyPath("/backoffice/property-detail"), "/informes/cartera");
    assert.equal(resolveLegacyPath("/backoffice/revenue/rate-journal"), "/revenue/parrilla/historial");
    assert.equal(resolveLegacyPath("/backoffice/revenue/rate-grid"), "/revenue/parrilla");
    assert.equal(resolveLegacyPath("/backoffice/unknown"), null);
    assert.equal(resolveLegacyPath("/hoy"), null);
  });
});

describe("nav-tree · visibility per role (§3 counts)", () => {
  const expected: Record<Exclude<RoleToken, "publico">, { items: number; categories: number }> = {
    direccion: { items: 64, categories: 9 },
    recepcion: { items: 22, categories: 9 },
    pisos: { items: 5, categories: 3 },
    mantenimiento: { items: 8, categories: 3 },
    revenue: { items: 20, categories: 5 },
    finanzas: { items: 28, categories: 6 },
    comercial: { items: 14, categories: 5 },
    fnb: { items: 5, categories: 2 },
    admin: { items: 64, categories: 9 }
  };

  for (const [token, counts] of Object.entries(expected) as Array<[RoleToken, { items: number; categories: number }]>) {
    it(`${token} sees ${counts.items} items in ${counts.categories} categories with every module enabled`, () => {
      const visible = countVisible([token], ALL_MODULES);
      assert.equal(visible.items, counts.items);
      assert.equal(visible.categories, counts.categories);
    });
  }

  it("hides the 14 entries that would open 403 in Faranda (§6) and nothing else", () => {
    const visible = countVisible(["direccion"], FARANDA_MODULES);
    assert.equal(visible.items, 58);
    const upsells = visibleCategories(["direccion"], FARANDA_MODULES)
      .find((category) => category.key === "comercial")
      ?.items.find((entry) => entry.label === "Ventas adicionales");
    assert.ok(upsells);
    assert.deepEqual(upsells.tabs.map((tab) => tab.label), ["Ofertas"]);
    const labels = visibleCategories(["direccion"], FARANDA_MODULES).flatMap((category) => category.items.map((entry) => entry.label));
    for (const hidden of ["Reputación y calidad", "Personal y turnos", "Clientes y fidelización", "Seguridad e incidentes", "Compras e inventario", "Analítica"]) {
      assert.ok(!labels.includes(hidden), `${hidden} should be hidden`);
    }
    for (const shown of ["Pisos", "Punto de venta", "Facturación y cobros", "Registro de viajeros", "Informe IA del día", "Sostenibilidad", "Energía y agua"]) {
      assert.ok(labels.includes(shown), `${shown} should be visible`);
    }
  });

  it("shows only core entries when no module is enabled", () => {
    const categories = visibleCategories(["admin"], []);
    for (const category of categories) {
      for (const entry of category.items) {
        assert.deepEqual(entry.modulesAny, [], `${entry.label} is gated`);
        for (const tab of entry.tabs) assert.deepEqual(tab.modulesAny, [], `${tab.label} is gated`);
      }
    }
    assert.equal(countVisible(["admin"], []).items, 48);
  });

  it("filters tabs by role inside a visible item", () => {
    const groups = visibleCategories(["recepcion"], ALL_MODULES)
      .find((category) => category.key === "recepcion")
      ?.items.find((entry) => entry.label === "Grupos y eventos");
    assert.deepEqual(groups?.tabs.map((tab) => tab.label), ["Calendario"]);
    assert.deepEqual(paintableTabs(item("Reservas"), ["pisos"], []).map((tab) => tab.label), ["Cronograma", "Tablero de habitaciones"]);
  });

  it("every ROLE_TOKENS entry is used by the CSV", () => {
    const used = new Set<string>();
    for (const category of NAV_CATEGORIES) {
      for (const entry of category.items) {
        entry.roles.forEach((role) => used.add(role));
        entry.tabs.forEach((tab) => tab.roles.forEach((role) => used.add(role)));
      }
    }
    NAV_TREE.publicScreens.length > 0 && used.add("publico");
    for (const token of ROLE_TOKENS) assert.ok(used.has(token), `${token} unused`);
  });
});

describe("nav-tree · landing tab (§1/§3)", () => {
  const today = item("Mi día");
  const reservations = item("Reservas");

  it("lands each role on its home tab of Mi día", () => {
    assert.equal(landingTabFor(today, ["fnb"], [])?.url, "/hoy/operaciones");
    assert.equal(landingTabFor(today, ["pisos"], [])?.url, "/hoy/operaciones");
    assert.equal(landingTabFor(today, ["revenue"], [])?.url, "/hoy/direccion");
    assert.equal(landingTabFor(today, ["direccion"], [], { templateKey: "owner" })?.url, "/hoy/propietario");
    assert.equal(landingTabFor(today, ["direccion"], [], { templateKey: "manager" })?.url, "/hoy/direccion");
    // Reception's home is the base screen itself.
    assert.equal(landingTabFor(today, ["recepcion"], []), null);
  });

  it("lands on the first paintable tab elsewhere, never on a detail sub-URL", () => {
    assert.equal(landingTabFor(reservations, ["recepcion"], [])?.label, "Lista");
    assert.equal(landingTabFor(reservations, ["pisos"], [])?.label, "Cronograma");
    assert.equal(landingTabFor(item("Modelos AEAT"), ["finanzas"], []), null);
    assert.equal(landingTabFor(item("Turno"), ["recepcion"], []), null);
  });

  it("role homes exist in the tree", () => {
    const urls = new Set(allUrls());
    for (const token of ROLE_TOKENS) {
      assert.ok(urls.has(roleHome(token)), `${token} home missing`);
      assert.ok(urls.has(roleHome(token, { mobile: true })), `${token} mobile home missing`);
    }
    assert.ok(urls.has(roleHome("direccion", { templateKey: "owner" })));
  });
});

describe("nav-tree · module cross-reference (§6.2)", () => {
  it("lists what each inactive module unlocks", () => {
    const crm = menuEntriesUnlockedBy("guest_data_crm_loyalty");
    assert.equal(crm.length, 1);
    assert.equal(crm[0].item.label, "Clientes y fidelización");
    assert.equal(crm[0].wholeItem, true);
    const selfService = menuEntriesUnlockedBy("guest_self_service");
    assert.equal(selfService.length, 1);
    assert.equal(selfService[0].item.label, "Ventas adicionales");
    assert.equal(selfService[0].wholeItem, false);
    assert.deepEqual(selfService[0].tabs.map((tab) => tab.label), ["Portal del huésped"]);
    assert.deepEqual(menuEntriesUnlockedBy("energy_sustainability"), []);
  });

  it("gates only the modules the API answers 403 for (§9) plus the three product gates", () => {
    assert.deepEqual(gatingModuleCodes(), [
      "distribution_hub",
      "guest_data_crm_loyalty",
      "guest_self_service",
      "hotel_intelligence_platform",
      "outlet_pos",
      "procurement_inventory",
      "reputation_quality",
      "revenue_profit_engine",
      "safety_incident_management",
      "workforce_labor"
    ]);
  });
});
