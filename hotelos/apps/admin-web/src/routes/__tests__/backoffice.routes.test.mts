// Route table of the admin shell (Tanda 5 · L1b · lote router-app).
//
// Run: cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json \
//   node --import tsx --test ../admin-web/src/routes/__tests__/*.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_TREE, allUrls, hasRouteParams, matchPath } from "../../navigation/nav-tree";
import {
  BACKOFFICE_ROUTES,
  DEV_ONLY_ROUTES,
  LEGACY_ROUTES,
  LEGACY_SCREEN_KEYS,
  PUBLIC_ROUTES,
  RETIRED_SCREEN_KEYS,
  canonicalScreenKey,
  findLegacyId,
  idFromSearchOrHash,
  legacyIdKeysFor,
  stripLegacyId,
  isDevOnlyScreen,
  isDevRouteAllowed,
  isLegacyPath,
  itemUrlForScreen,
  pathForScreen,
  pathnameBelongsToScreen,
  resolveLegacyLocation,
  resolveLocation,
  retiredScreenUrl,
  routeForPathname,
  routeMatches,
  screenFromPathname,
  urlForScreenWithParams
} from "../backoffice.routes";

const items = NAV_TREE.categories.flatMap((category) => category.items);
const tabs = items.flatMap((item) => item.tabs);

describe("BACKOFFICE_ROUTES · one URL per screen of the tree", () => {
  it("registers the 166 URLs of the tree in tree order, the base URL of every container before its tabs", () => {
    assert.equal(BACKOFFICE_ROUTES.length, 166);
    assert.deepEqual(BACKOFFICE_ROUTES.map((route) => route.path), allUrls());
    for (const item of items) {
      const base = BACKOFFICE_ROUTES.findIndex((route) => route.path === item.url);
      assert.ok(base >= 0, `${item.url} not registered`);
      for (const tab of item.tabs) {
        const index = BACKOFFICE_ROUTES.findIndex((route) => route.path === tab.url);
        assert.ok(index > base, `${tab.url} registered before its base ${item.url}`);
      }
    }
  });

  it("maps every URL to the screen key of the tree (tab keys included) without duplicates", () => {
    const paths = BACKOFFICE_ROUTES.map((route) => route.path);
    assert.equal(new Set(paths).size, paths.length, "duplicate path");
    for (const item of items) assert.equal(routeForPathname(item.url)?.screen, item.screenKey);
    for (const tab of tabs) {
      const sample = tab.url.replace(/:[A-Za-z0-9_]+/g, "abc");
      assert.equal(routeForPathname(sample)?.screen, tab.screenKey, tab.url);
    }
    assert.equal(DEV_ONLY_ROUTES.length, 20);
    assert.ok(DEV_ONLY_ROUTES.every((route) => route.path.startsWith("/desarrollo/") && route.devOnly));
    assert.equal(PUBLIC_ROUTES.length, 2);
    assert.deepEqual(PUBLIC_ROUTES.map((route) => route.path), ["/acceso", "/acceso/recuperar-contrasena"]);
  });

  it("prefers static URLs over parametrised ones", () => {
    assert.equal(screenFromPathname("/recepcion/reservas/lista"), "ReservationsListScreen");
    assert.equal(screenFromPathname("/recepcion/reservas/nueva"), "ReservationCreate");
    assert.equal(screenFromPathname("/recepcion/reservas/res_1"), "ReservationDetailWorkspace");
    assert.equal(screenFromPathname("/recepcion/reservas/res_1/recorrido"), "GuestJourneyWorkspace");
    assert.equal(screenFromPathname("/hoy/"), "FrontDeskDashboard");
    assert.equal(screenFromPathname("/no-existe"), null);
    assert.ok(routeMatches("/informes/cartera/:propiedad", "/informes/cartera/prop_9"));
    assert.ok(!routeMatches("/informes/cartera/:propiedad", "/informes/cartera"));
  });
});

describe("pathForScreen · screen key → URL", () => {
  it("resolves items, tabs (to the tab URL), dev-only, public and aliases; detail keys have no static path", () => {
    assert.equal(pathForScreen("FrontDeskDashboard"), "/hoy");
    assert.equal(pathForScreen("ReservationsListScreen"), "/recepcion/reservas/lista");
    assert.equal(pathForScreen("OwnerHome"), "/hoy/propietario");
    assert.equal(pathForScreen("RevenueAutomationRules"), "/desarrollo/revenue-automatizacion");
    assert.equal(pathForScreen("LoginScreen"), "/acceso");
    assert.equal(pathForScreen("ChannelManagerDashboard"), "/comercial/canales");
    assert.equal(pathForScreen("RevenueSettings"), "/revenue/planes");
    assert.equal(pathForScreen("GuestDetail"), undefined);
    assert.equal(pathForScreen("TenantDetailScreen"), undefined);
    assert.equal(pathForScreen("NoSuchScreen"), undefined);
    for (const tab of tabs.filter((entry) => !entry.detail)) assert.equal(pathForScreen(tab.screenKey), tab.url);
  });

  it("resolves every alias to its canonical key and URL", () => {
    assert.equal(LEGACY_SCREEN_KEYS.length, 24);
    for (const alias of LEGACY_SCREEN_KEYS) {
      assert.equal(canonicalScreenKey(alias.screenKey), alias.canonical);
      if (alias.url && !hasRouteParams(alias.url)) assert.equal(pathForScreen(alias.screenKey), alias.url);
    }
    assert.equal(canonicalScreenKey("FrontDeskDashboard"), "FrontDeskDashboard");
  });

  it("names the covering URL of every retired key", () => {
    assert.equal(RETIRED_SCREEN_KEYS.length, 72);
    assert.equal(retiredScreenUrl("AISetupCenter"), "/configuracion/ia");
    assert.equal(retiredScreenUrl("PersonaLandingScreen"), null);
    assert.equal(retiredScreenUrl("FrontDeskDashboard"), null);
    for (const retired of RETIRED_SCREEN_KEYS) {
      if (retired.url) assert.ok(routeForPathname(retired.url), `${retired.screenKey} → ${retired.url} not registered`);
    }
  });

  it("fills detail URLs and knows the item that owns a screen", () => {
    assert.equal(urlForScreenWithParams("GuestDetail", { id: "g 1" }), "/recepcion/huespedes/g%201");
    assert.equal(urlForScreenWithParams("CategoryOptionForm", { codigo: "bed_types" }), "/configuracion/propiedad/categorias/bed_types/opciones/nueva");
    assert.equal(urlForScreenWithParams("GuestDetail", {}), null);
    assert.equal(itemUrlForScreen("GuestTimelineScreen"), "/recepcion/huespedes");
    assert.equal(itemUrlForScreen("GuestSegments"), "/comercial/clientes");
    assert.equal(itemUrlForScreen("OnboardingProjects"), "/desarrollo/migracion");
    assert.ok(pathnameBelongsToScreen("/recepcion/huespedes/abc", "GuestTimelineScreen"));
    assert.ok(!pathnameBelongsToScreen("/hoy", "GuestTimelineScreen"));
    assert.ok(isDevOnlyScreen("AutomationRules"));
    assert.ok(!isDevOnlyScreen("RevenueRules"));
  });
});

describe("LEGACY_ROUTES · client-side 308 (§5)", () => {
  it("resolves the 205 old /backoffice/* paths to a registered URL", () => {
    assert.equal(LEGACY_ROUTES.length, 205);
    let resolved = 0;
    for (const route of LEGACY_ROUTES) {
      const sample = route.from.replace(/:[A-Za-z0-9_]+/g, "abc");
      assert.ok(isLegacyPath(sample), route.from);
      const legacy = resolveLegacyLocation({ pathname: sample });
      assert.ok(legacy, `${route.from} does not resolve`);
      assert.ok(routeForPathname(legacy.pathname), `${route.from} → ${legacy.pathname} is not registered`);
      resolved += 1;
    }
    assert.equal(resolved, 205);
  });

  it("maps route params by position and keeps the id", () => {
    assert.deepEqual(resolveLegacyLocation({ pathname: "/backoffice/reservations/res_42" }), {
      pathname: "/recepcion/reservas/res_42",
      screen: "ReservationDetailWorkspace",
      devOnly: false,
      consumed: null
    });
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/guests/g_7" })?.pathname, "/recepcion/huespedes/g_7");
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/configuration/categories/bed_types/options/new" })?.pathname, "/configuracion/propiedad/categorias/bed_types/opciones/nueva");
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/revenue/rate-journal" })?.pathname, "/revenue/parrilla/historial");
  });

  it("cuts to the static ancestor when the new URL needs an id the old one did not carry, unless ?query/#hash brings it", () => {
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/guest-journey" })?.pathname, "/recepcion/reservas");
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/guest-portal" })?.pathname, "/recepcion/reservas");
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/property-detail" })?.pathname, "/informes/cartera");
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/guest-journey", search: "?reservationId=res_9" })?.pathname, "/recepcion/reservas/res_9/recorrido");
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/property-detail", hash: "#propertyId=prop_1" })?.pathname, "/informes/cartera/prop_1");
    assert.equal(idFromSearchOrHash("?foo=1&guestId=g_1", ""), "g_1");
    assert.equal(idFromSearchOrHash("", "#org=abc-123"), "abc-123");
    assert.equal(idFromSearchOrHash("?x=1", "#y=2"), null);
  });

  // L1c (code-review#5): the key is chosen by the param the new URL needs and
  // by the entity of its prefix — never the first known id of a fixed list.
  it("reads the id with the key of the param and the entity of the target (a guest id never fills :propiedad)", () => {
    assert.deepEqual(legacyIdKeysFor("propiedad"), ["propertyId", "propiedad", "property"]);
    assert.deepEqual(legacyIdKeysFor("id", "/recepcion/reservas/:id/recorrido"), ["id", "reservationId", "reservation"]);
    assert.deepEqual(legacyIdKeysFor("id", "/recepcion/huespedes/:id"), ["id", "guestId", "guest"]);
    assert.deepEqual(legacyIdKeysFor("id", "/finanzas/facturacion/folios/:id"), ["id", "folioId", "folio"]);
    assert.deepEqual(legacyIdKeysFor("id", "/configuracion/sistema/organizaciones/:id"), ["id", "orgId", "org"]);
    assert.deepEqual(legacyIdKeysFor("codigo"), ["codigo", "categoryCode"]);
    assert.equal(legacyIdKeysFor(null).length, 14, "without a param every key applies (legacy callers)");
    assert.deepEqual(findLegacyId("?guestId=g1&propertyId=p1", "#org=abc", { param: "propiedad" }), { value: "p1", key: "propertyId", source: "search" });
    assert.deepEqual(findLegacyId("?guestId=g1", "#org=abc", { param: "id", targetUrl: "/configuracion/sistema/organizaciones/:id" }), { value: "abc", key: "org", source: "hash" });
    assert.equal(findLegacyId("?guestId=g1", "", { param: "id", targetUrl: "/recepcion/reservas/:id" }), null, "a guest id is not a reservation id");
    assert.deepEqual(resolveLegacyLocation({ pathname: "/backoffice/property-detail", search: "?guestId=g1&propertyId=p1", hash: "#org=abc" }), {
      pathname: "/informes/cartera/p1",
      screen: "PropertyDetailScreen",
      devOnly: false,
      consumed: { value: "p1", key: "propertyId", source: "search" }
    });
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/guest-journey", search: "?guestId=g1" })?.pathname, "/recepcion/reservas", "no reservation id → static ancestor");
  });

  // L1c (browser-roles#14): the consumed id never travels twice on the new URL.
  it("stripLegacyId drops only the consumed key and keeps the rest of the query (?dev=1, filters) and anchors", () => {
    const consumed = resolveLegacyLocation({ pathname: "/backoffice/guest-journey", search: "?reservationId=res_9&dev=1" })?.consumed ?? null;
    assert.deepEqual(stripLegacyId("?reservationId=res_9&dev=1", "", consumed), { search: "?dev=1", hash: "" });
    assert.deepEqual(stripLegacyId("?propertyId=p1", "", { value: "p1", key: "propertyId", source: "search" }), { search: "", hash: "" });
    assert.deepEqual(stripLegacyId("?a=1", "#org=abc&tab=x", { value: "abc", key: "org", source: "hash" }), { search: "?a=1", hash: "#tab=x" });
    assert.deepEqual(stripLegacyId("?a=1", "#nuevo-grupo", null), { search: "?a=1", hash: "#nuevo-grupo" });
    assert.deepEqual(stripLegacyId("", "", null), { search: "", hash: "" });
    const resolution = resolveLocation({ pathname: "/backoffice/property-detail", search: "?propertyId=prop_1" });
    assert.equal(resolution.kind, "screen");
    if (resolution.kind === "screen") {
      assert.equal(resolution.redirect, "/informes/cartera/prop_1");
      assert.deepEqual(resolution.consumed, { value: "prop_1", key: "propertyId", source: "search" });
    }
  });

  it("returns null outside the legacy table", () => {
    assert.equal(resolveLegacyLocation({ pathname: "/backoffice/no-existe" }), null);
    assert.equal(resolveLegacyLocation({ pathname: "/hoy" }), null);
  });
});

describe("resolveLocation · what the shell renders", () => {
  const admin = { search: "?dev=1", isPlatformAdmin: true };

  it("lands / and /backoffice on the role home", () => {
    assert.deepEqual(resolveLocation({ pathname: "/" }), { kind: "home" });
    assert.deepEqual(resolveLocation({ pathname: "/backoffice/" }), { kind: "home" });
  });

  it("serves tree URLs and redirects legacy ones", () => {
    const direct = resolveLocation({ pathname: "/recepcion/reservas/lista" });
    assert.equal(direct.kind, "screen");
    if (direct.kind === "screen") {
      assert.equal(direct.screen, "ReservationsListScreen");
      assert.equal(direct.redirect, undefined);
    }
    const legacy = resolveLocation({ pathname: "/backoffice/timeline?from=2026-09-15" });
    assert.equal(legacy.kind, "screen");
    if (legacy.kind === "screen") {
      assert.equal(legacy.screen, "LiveTimelineWorkspace");
      assert.equal(legacy.redirect, "/recepcion/reservas/cronograma");
    }
    assert.deepEqual(resolveLocation({ pathname: "/no/existe" }), { kind: "not-found", pathname: "/no/existe" });
    assert.deepEqual(resolveLocation({ pathname: "/backoffice/no-existe" }), { kind: "not-found", pathname: "/backoffice/no-existe" });
  });

  it("guards /desarrollo/* with dev mode AND the platform admin, also through legacy paths", () => {
    assert.ok(isDevRouteAllowed(admin));
    assert.ok(isDevRouteAllowed({ storageValue: "1", isPlatformAdmin: true }));
    assert.ok(!isDevRouteAllowed({ search: "?dev=1", isPlatformAdmin: false }));
    assert.ok(!isDevRouteAllowed({ isPlatformAdmin: true }));
    assert.deepEqual(resolveLocation({ pathname: "/desarrollo/migracion" }), { kind: "dev-locked", pathname: "/desarrollo/migracion" });
    assert.deepEqual(resolveLocation({ pathname: "/desarrollo/migracion", search: "?dev=1" }, { search: "?dev=1", isPlatformAdmin: false }), {
      kind: "dev-locked",
      pathname: "/desarrollo/migracion"
    });
    const allowed = resolveLocation({ pathname: "/desarrollo/migracion" }, admin);
    assert.equal(allowed.kind, "screen");
    if (allowed.kind === "screen") assert.equal(allowed.screen, "OnboardingProjects");
    const legacy = resolveLocation({ pathname: "/backoffice/onboarding/projects" });
    assert.deepEqual(legacy, { kind: "dev-locked", pathname: "/desarrollo/migracion" });
    const legacyAllowed = resolveLocation({ pathname: "/backoffice/onboarding/projects" }, admin);
    assert.equal(legacyAllowed.kind, "screen");
    if (legacyAllowed.kind === "screen") assert.equal(legacyAllowed.redirect, "/desarrollo/migracion");
  });

  it("resolves the public URLs to their public route", () => {
    const login = resolveLocation({ pathname: "/acceso" });
    assert.equal(login.kind, "screen");
    if (login.kind === "screen") {
      assert.equal(login.screen, "LoginScreen");
      assert.equal(login.route.public, true);
    }
    assert.ok(matchPath("/acceso/recuperar-contrasena", "/acceso/recuperar-contrasena/"));
  });
});
