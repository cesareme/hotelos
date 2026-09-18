import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const mobileTabs = readFileSync(new URL("../apps/mobile/src/navigation/HotelOSTabs.tsx", import.meta.url), "utf8");
const mobileNavigation = readFileSync(new URL("../packages/product/src/navigation/mobile-navigation.ts", import.meta.url), "utf8");
const mobileApp = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
const routeMap = readFileSync(new URL("../packages/product/src/navigation/module-route-map.ts", import.meta.url), "utf8");
const adminRoutes = readFileSync(new URL("../apps/admin-web/src/routes/backoffice.routes.tsx", import.meta.url), "utf8");
// Tanda 5 · L1b: the sidebar renders nav-tree.generated.json (labels, keys, URLs and
// the legacy /backoffice/* redirects live there), so the menu source is both files.
const adminSidebar =
  readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8") +
  readFileSync(new URL("../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8");
const uiIndex = readFileSync(new URL("../packages/ui/src/index.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const localSeed = readFileSync(new URL("../packages/database/seeds/local-demo.seed.ts", import.meta.url), "utf8");
const sharedComponents = readFileSync(new URL("../packages/ui/src/components/shared.tsx", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const demoJs = readFileSync(new URL("../demo/public/app.js", import.meta.url), "utf8");

describe("ehotelOS Flow UI/UX shift", () => {
  it("renames the mobile shell around timeline and operations workflows", () => {
    for (const label of ["Hoy", "Timeline", "IA", "Operaciones", "Mas"]) {
      assert.match(mobileTabs + mobileNavigation + demoHtml + demoJs, new RegExp(label));
    }
    assert.doesNotMatch(mobileTabs, /Habitaciones|Tareas/);
    assert.match(mobileApp, /LiveTimelineScreen/);
    assert.match(mobileApp, /TasksHomeScreen/);
    assert.match(mobileApp, /ComingSoonMobileScreen/);
  });

  it("creates the visible Flow OS screens and components", () => {
    for (const path of [
      "../apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx",
      "../apps/mobile/src/screens/timeline/LiveTimelineScreen.tsx",
      "../apps/mobile/src/screens/guestJourney/GuestJourneyScreen.tsx",
      "../apps/mobile/src/screens/channelManager/ChannelManagerHomeScreen.tsx",
      "../apps/mobile/src/screens/marketplace/IntegrationMarketplaceHome.tsx",
      "../apps/mobile/src/screens/settings/SetupCenterPreviewScreen.tsx",
      "../apps/admin-web/src/screens/timeline/LiveTimelineWorkspace.tsx",
      "../apps/admin-web/src/screens/guestJourney/GuestJourneyWorkspace.tsx",
      // ChannelManagerDashboard.tsx was renamed to ChannelAggregatorHub.tsx
      // when the OTA aggregator surface was unified. The screen key
      // "ChannelManagerDashboard" is still kept as an alias in App.tsx so any
      // existing deep link still resolves.
      "../apps/admin-web/src/screens/channelManager/ChannelAggregatorHub.tsx",
      "../apps/admin-web/src/screens/backoffice/SetupCenterScreen.tsx",
      "../packages/ui/src/components/SmartTipCard.tsx",
      "../packages/ui/src/components/CommandPalette.tsx",
      "../packages/ui/src/components/GlobalSearchCommand.tsx",
      "../packages/ui/src/components/guestJourney/GuestJourneyStepper.tsx",
      "../packages/ui/src/components/panels/ContextDetailPanel.tsx",
      "../packages/ui/src/components/panels/ReservationDetailPanel.tsx"
    ]) {
      assert.equal(existsSync(new URL(path, import.meta.url)), true, path);
    }
    for (const marker of [
      "SmartTipCard",
      "CommandPalette",
      "GlobalSearchCommand",
      "GuestJourneyStepper",
      // ReservationDetailPanel ships via the panels barrel export
      // (./components/panels/index.js) rather than a dedicated re-export
      // line, so we accept either form.
      "ReservationDetailPanel|components\\/panels\\/index",
      "hotelos-flow.tokens"
    ]) {
      assert.match(uiIndex, new RegExp(marker));
    }
  });

  it("makes Back Office, Revenue, Channel Manager and Marketplace reachable", () => {
    for (const marker of [
      "Revenue Management",
      "History & Forecast",
      "Rate Grid",
      "Recommendations",
      "Channel Manager",
      "Channel Mappings",
      "Scenario Simulator",
      "Data Quality",
      "Setup Center",
      "Integration Marketplace",
      "Guest Journey"
    ]) {
      assert.match(routeMap + demoHtml, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    // Tanda 5 · L1b: the old /backoffice/* paths are client-side redirects
    // (NAV_TREE.legacyRoutes) to the URLs of the navigation tree.
    const navTree = JSON.parse(readFileSync(new URL("../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8"));
    for (const [from, to] of [
      ["/backoffice", "/hoy"],
      ["/backoffice/setup", "/configuracion/puesta-en-marcha"],
      ["/backoffice/timeline", "/recepcion/reservas/cronograma"],
      ["/backoffice/revenue", "/revenue"],
      ["/backoffice/revenue/history-forecast", "/revenue/historico-prevision"],
      ["/backoffice/channel-manager", "/comercial/canales"],
      ["/backoffice/channel-manager/mappings", "/comercial/canales/correspondencias"],
      ["/backoffice/guest-journey", "/recepcion/reservas/:id/recorrido"],
      ["/backoffice/marketplace", "/configuracion/modulos/integraciones"],
      ["/backoffice/ai-governance", "/configuracion/ia/gobernanza"]
    ]) {
      assert.ok(navTree.legacyRoutes.some((route) => route.from === from && route.to === to), `${from} → ${to}`);
    }
    assert.match(adminRoutes, /NAV_TREE\.legacyRoutes/);
  });

  it("generalizes inventory and seeds the local demo for exploration", () => {
    for (const marker of [
      "model InventoryResource",
      "@@map(\"inventory_resources\")",
      // Tanda L2 (L2-01): ReservationResource was retired by migration
      // 20260918130000_persistencia_l2 (0 readers / writers, 0 rows).
      "resourceType",
      "hourlyBookable",
      "monthlyBookable"
    ]) {
      assert.match(schema, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const marker of [
      "LOCAL_DEMO_INVENTORY_RESOURCES",
      "parking_space",
      "meeting_room",
      "coworking_desk",
      "event_space",
      "LOCAL_DEMO_GUEST_JOURNEY",
      "LOCAL_DEMO_RESERVATIONS",
      "admin@hotelos.local",
      "revenue_profit_engine",
      "channel_manager",
      "History & Forecast"
    ]) {
      assert.match(localSeed, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("keeps hidden modules and permissions explainable", () => {
    assert.match(sharedComponents, /ModuleDisabledCard/);
    assert.match(sharedComponents, /PermissionDeniedCard/);
    assert.match(sharedComponents, /Hidden because module/);
    assert.match(sharedComponents, /Hidden because user lacks/);
    assert.doesNotMatch(sharedComponents, /if \(!enabled\) return null/);
  });
});
