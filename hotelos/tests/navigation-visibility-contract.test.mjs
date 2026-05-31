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
const adminSidebar = readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8");
const adminBackOfficeSidebar = readFileSync(new URL("../apps/admin-web/src/components/BackOfficeSidebar.tsx", import.meta.url), "utf8");
const adminRoutes = readFileSync(new URL("../apps/admin-web/src/routes/backoffice.routes.tsx", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
const backOfficeDashboard = readFileSync(new URL("../apps/admin-web/src/screens/BackOfficeDashboard.tsx", import.meta.url), "utf8");
const localSeed = readFileSync(new URL("../packages/database/seeds/local-demo.seed.ts", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");

function expectMarkers(source, markers) {
  for (const marker of markers) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

describe("Back Office and Revenue visible navigation", () => {
  it("centralizes Back Office, Revenue and Channel Manager routes in the product route map", () => {
    expectMarkers(routeMap, [
      "MODULE_ROUTE_MAP",
      "Back Office",
      "Revenue Management",
      "History & Forecast",
      "Rate Grid",
      "Recommendations",
      "Channel Manager",
      "/backoffice",
      "/backoffice/revenue/history-forecast",
      "/backoffice/channel-manager/mappings"
    ]);
  });

  it("shows local launcher, Back Office and Revenue entry points in mobile", () => {
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/settings/BackOfficePreviewScreen.tsx", import.meta.url)), true);
    expectMarkers(mobileApp + localDevLauncher + moreScreen + commercialTools, [
      "SHOW_DEV_LAUNCHER",
      "HotelOS Local Demo",
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
    expectMarkers(adminRoutes + adminSidebar + adminBackOfficeSidebar + adminApp, [
      "/backoffice",
      "/backoffice/revenue",
      "/backoffice/revenue/history-forecast",
      "/backoffice/revenue/rate-grid",
      "/backoffice/revenue/recommendations",
      "/backoffice/channel-manager",
      "/backoffice/channel-manager/sync-health",
      "RevenueHomeDashboard",
      "BackOfficeSidebar",
      "getModuleRouteItems"
    ]);
  });

  it("shows setup guidance instead of making missing modules feel absent", () => {
    expectMarkers(sharedComponents + moduleDebug + backOfficeDashboard, [
      "ModuleDisabledCard",
      "PermissionDeniedCard",
      "Module disabled",
      "You do not have permission",
      "Hidden because module",
      "Hidden because user lacks",
      "Dev Module Debug",
      "Hidden routes with reason",
      // The Back Office dashboard now surfaces setup entry points by their
      // destination workspace rather than a "<Module> Setup" placeholder.
      // The labels below preserve the same intent (discoverable entry
      // points to revenue, configuration, channel manager and compliance).
      "Revenue Management",
      "Configuration Center",
      "Channel Manager",
      "Compliance Hub"
    ]);
  });

  it("documents the local demo user, permissions and seeded revenue data", () => {
    expectMarkers(localSeed, [
      "admin@hotelos.local",
      "admin123",
      "Local Super Admin",
      "HotelOS Demo Hotel",
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
      "HotelOS Local Demo",
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
