import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const routeMap = readFileSync(new URL("../packages/product/src/navigation/module-route-map.ts", import.meta.url), "utf8");
const mobileApp = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
const moreScreen = readFileSync(new URL("../apps/mobile/src/screens/more/MoreScreen.tsx", import.meta.url), "utf8");
const commercialTools = readFileSync(new URL("../apps/mobile/src/screens/more/CommercialToolsSection.tsx", import.meta.url), "utf8");
const todayScreen = readFileSync(new URL("../apps/mobile/src/screens/today/TodayDashboardScreen.tsx", import.meta.url), "utf8");
const revenueSnapshot = readFileSync(new URL("../apps/mobile/src/screens/today/components/RevenueSnapshotCard.tsx", import.meta.url), "utf8");
const revenueHome = readFileSync(new URL("../apps/mobile/src/screens/revenue/RevenueHomeScreen.tsx", import.meta.url), "utf8");
const localDevLauncher = readFileSync(new URL("../apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx", import.meta.url), "utf8");
const moduleDebug = readFileSync(new URL("../apps/mobile/src/screens/dev/ModuleVisibilityDebugScreen.tsx", import.meta.url), "utf8");
const sharedComponents = readFileSync(new URL("../packages/ui/src/components/shared.tsx", import.meta.url), "utf8");
// Tanda 5 · L1b: the sidebar renders nav-tree.generated.json (labels, keys, URLs and
// the legacy /backoffice/* redirects live there), so the menu source is both files.
const adminSidebar =
  readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8") +
  readFileSync(new URL("../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8");
const adminRoutes = readFileSync(new URL("../apps/admin-web/src/routes/backoffice.routes.tsx", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
const navTree = JSON.parse(readFileSync(new URL("../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8"));
const localSeed = readFileSync(new URL("../packages/database/seeds/local-demo.seed.ts", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");

function expectMarkers(source, markers) {
  for (const marker of markers) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

describe("Back Office and Revenue visible navigation", () => {
  it("centralizes Back Office, Revenue and Channel Manager routes in the product route map", () => {
    // Tanda 5: labels are Spanish and aligned with pilots/tanda5-nav-tree.csv;
    // `url` carries the tree URL and the legacy /backoffice/* `path` was retired
    // in L1c — the router redirects old paths through NAV_TREE.legacyRoutes
    // (see tests/product-route-maps-contract.test.mjs).
    expectMarkers(routeMap, [
      "MODULE_ROUTE_MAP",
      "Puesta en marcha",
      "Panel de revenue",
      "Histórico y previsión",
      "Parrilla de tarifas",
      "Reglas y recomendaciones",
      "Canales de venta",
      "url: \"/revenue/historico-prevision\"",
      "url: \"/comercial/canales/correspondencias\""
    ]);
    assert.doesNotMatch(routeMap, /\bpath: "\/backoffice/, "legacy paths retired from the product map (L1c)");
  });

  it("shows local launcher, Back Office and Revenue entry points in mobile", () => {
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/settings/BackOfficePreviewScreen.tsx", import.meta.url)), true);
    expectMarkers(mobileApp + localDevLauncher + moreScreen + commercialTools, [
      "SHOW_DEV_LAUNCHER",
      "ehotelOS Local Demo",
      "Back Office / Configuración",
      "Revenue Management",
      "Owner Dashboard",
      "Configuration & Admin",
      "CommercialToolsSection",
      "EXPO_PUBLIC_ADMIN_WEB_URL",
      "BackOfficePreview",
      "Linking.openURL",
      "History & Forecast",
      "Rate Grid",
      "Channel Manager"
    ]);
  });

  it("surfaces revenue from Today and from the Revenue home screen", () => {
    expectMarkers(todayScreen + revenueSnapshot + revenueHome, [
      "RevenueSnapshotCard",
      "Revenue Snapshot",
      "Open Revenue",
      "History & Forecast",
      "View Recommendations",
      "RevenueHomeScreen",
      "Forecast Graphs",
      "Rate Parity",
      "Scenario Simulator",
      "RevenueSetupRequiredCard"
    ]);
  });

  it("keeps admin-web /backoffice and revenue routes visible", () => {
    // Tanda 5 · L1b: the old /backoffice/* paths are client-side redirects
    // (NAV_TREE.legacyRoutes → resolveLegacyPath) to the URLs of the tree.
    const treeUrls = new Set([
      ...navTree.categories.flatMap((category) => category.items.flatMap((item) => [item.url, ...item.tabs.map((tab) => tab.url)])),
      ...navTree.devOnly.map((screen) => screen.url)
    ]);
    for (const [from, to] of [
      ["/backoffice", "/hoy"],
      ["/backoffice/revenue", "/revenue"],
      ["/backoffice/revenue/history-forecast", "/revenue/historico-prevision"],
      ["/backoffice/revenue/rate-grid", "/revenue/parrilla"],
      ["/backoffice/revenue/recommendations", "/revenue/reglas"],
      ["/backoffice/channel-manager", "/comercial/canales"],
      ["/backoffice/channel-manager/sync-health", "/comercial/canales"]
    ]) {
      const legacy = navTree.legacyRoutes.find((route) => route.from === from);
      assert.ok(legacy, `${from} is not a legacy route`);
      assert.equal(legacy.to, to);
      assert.ok(treeUrls.has(to), `${to} is not a URL of the tree`);
    }
    expectMarkers(adminRoutes, ["NAV_TREE.legacyRoutes", "resolveLegacyPath(", "allUrls("]);
    expectMarkers(adminRoutes + adminSidebar + adminApp, [
      "RevenueHomeDashboard",
      // Tanda 5 · L1b: the sidebar renders the tree (menuCategories) instead of
      // spreading getModuleRouteItems; the product map still feeds ⌘K/help.
      "menuCategories"
    ]);
  });

  it("shows setup guidance instead of making missing modules feel absent", () => {
    expectMarkers(sharedComponents + moduleDebug, [
      "ModuleDisabledCard",
      "PermissionDeniedCard",
      "Module disabled",
      "You do not have permission",
      "Hidden because module",
      "Hidden because user lacks",
      "Dev Module Debug",
      "Hidden routes with reason",
      "Hidden routes with reason"
    ]);
    // Tanda 5: the discoverable entry points to revenue, configuration, channel
    // manager and compliance are items of the navigation tree (the Back Office
    // dashboard retired into Puesta en marcha).
    const itemKeys = new Set(navTree.categories.flatMap((category) => category.items.map((item) => item.screenKey)));
    for (const key of ["RevenueHomeDashboard", "SetupCenterScreen", "ChannelAggregatorHub", "ComplianceCenter"]) {
      assert.ok(itemKeys.has(key), `${key} must be a menu item of the tree`);
    }
  });

  it("documents the local demo user, permissions and seeded revenue data", () => {
    expectMarkers(localSeed, [
      "admin@hotelos.local",
      "admin123",
      "Local Super Admin",
      'name: "Hotel Demo",',
      "revenue_profit_engine",
      "channel_manager",
      "revenue.history_forecast.read",
      "revenue.manage_rates",
      "channel_manager.mappings.manage",
      "Flexible BAR",
      "Booking.com Mock",
      "History subtotal",
      "Forecast subtotal",
      "Total Occ.",
      "Average Rate"
    ]);
  });

  it("makes the browser simulator expose the same visible entry points", () => {
    expectMarkers(demoHtml, [
      "ehotelOS Local Demo",
      "Back Office / Configuración",
      "Revenue Management",
      "Owner Dashboard",
      "Configuration & Admin",
      "Commercial Tools",
      "Revenue Snapshot",
      "History & Forecast",
      "Rate Grid",
      "Forecast",
      "Recommendations",
      "Channel Manager",
      "Rate Shopper",
      "Parity Alerts",
      "Visible revenue navigation"
    ]);
  });
});
