import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const manifest = readFileSync(new URL("../packages/product/src/modules/module-manifest.ts", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../packages/product/src/navigation/mobile-navigation.ts", import.meta.url), "utf8");
const permissions = readFileSync(new URL("../packages/shared/src/permissions.ts", import.meta.url), "utf8");
const sharedTypes = readFileSync(new URL("../packages/shared/src/types.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const routePermissions = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
// Rate grid v2: route registrations and manifest entries also live in
// apps/api/src/modules/<module>/{*.routes.ts,route-permissions.partial.ts}.
import { readdirSync } from "node:fs";
const apiModulesDir = new URL("../apps/api/src/modules/", import.meta.url);
const moduleFiles = (suffix) =>
  readdirSync(apiModulesDir).flatMap((mod) => {
    try {
      return readdirSync(new URL(`${mod}/`, apiModulesDir))
        .filter((name) => name.endsWith(suffix))
        .map((name) => readFileSync(new URL(`${mod}/${name}`, apiModulesDir), "utf8"));
    } catch {
      return [];
    }
  });
const apiRoutesSource = [server, ...moduleFiles(".routes.ts")].join("\n");
const routePermissionsSource = [routePermissions, ...moduleFiles("route-permissions.partial.ts")].join("\n");
const advancedService = readFileSync(new URL("../apps/api/src/modules/advanced/advanced-modules.service.ts", import.meta.url), "utf8");
const demoStore = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
const aiTools = readFileSync(new URL("../packages/ai-tools/src/registry.ts", import.meta.url), "utf8");
const toolNames = readFileSync(new URL("../packages/ai-tools/src/tool-names.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
// Tanda L2 (L2-07 · worker honesto): the catalogue is the four pg-boss queues of scheduler.ts.
const workerScheduler = readFileSync(new URL("../apps/worker/src/scheduler.ts", import.meta.url), "utf8");
// Tanda L2 (L2-03): recommendations are applied to the real rate grid by pricing.service.ts.
const pricingService = readFileSync(new URL("../apps/api/src/modules/revenue/pricing.service.ts", import.meta.url), "utf8");
// Rate grid v2 / Tanda L2: the channel sync gate lives in modules/channel-manager (readiness + aggregator).
const channelReadiness = readFileSync(new URL("../apps/api/src/modules/channel-manager/readiness.core.ts", import.meta.url), "utf8");
const channelAggregator = readFileSync(new URL("../apps/api/src/modules/channel-manager/aggregator.service.ts", import.meta.url), "utf8");
const channelAdapter = readFileSync(new URL("../packages/integrations/src/channel-manager.ts", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
// Tanda 5 · L1b: the sidebar renders nav-tree.generated.json (labels, keys, URLs and
// the legacy /backoffice/* redirects live there), so the menu source is both files.
const adminSidebar =
  readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8") +
  readFileSync(new URL("../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const demoScript = readFileSync(new URL("../demo/public/app.js", import.meta.url), "utf8");

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Revenue Management and Channel Manager module", () => {
  it("upgrades the product registry, permissions and mobile visibility for revenue_profit_engine", () => {
    assert.match(manifest, /code: "revenue_profit_engine"/);
    for (const marker of [
      "Previsión, precios dinámicos, gestión de canales, restricciones, inteligencia tarifaria, predicción de demanda y optimización del beneficio",
      "\"payment_vault\"",
      "\"hotel_intelligence_platform\"",
      "\"channel_manager.sync\"",
      "\"RateGrid\"",
      "\"ChannelManagerDashboard\"",
      "\"ChannelMappings\"",
      "\"RateShopperSettings\""
    ]) {
      assert.match(manifest, new RegExp(escaped(marker)));
    }
    for (const permission of [
      "revenue.forecast.read",
      "revenue.manage_restrictions",
      "revenue.automation.manage",
      "channel_manager.read",
      "channel_manager.manage",
      "channel_manager.sync",
      "channel_manager.mappings.manage"
    ]) {
      assert.match(sharedTypes, new RegExp(escaped(permission)));
      assert.match(permissions, new RegExp(escaped(permission)));
    }
    for (const route of ["RevenueRecommendations", "RateGrid", "DemandCalendar", "ChannelManagerDashboard"]) {
      assert.match(navigation, new RegExp(route));
    }
  });

  it("declares the revenue and channel manager data model", () => {
    for (const model of [
      "RatePlan",
      "RateDay",
      "InventoryDay",
      "RestrictionDay",
      "Channel",
      "ChannelRoomMapping",
      "ChannelRateMapping",
      "ChannelSyncJob",
      "RevenueForecast",
      "RevenueRecommendation",
      "CompetitorHotel",
      "CompetitorRateSnapshot",
      "DemandCalendarEvent",
      // Tanda L2 (L2-01): RevenueAutomationRule and RevenueScenario were retired
      // by migration 20260918130000_persistencia_l2 (memory-only legs, 0 rows).
      "RateParityAlert",
      "ExternalReservation"
    ]) {
      assert.match(schema, new RegExp(`model ${model}`));
    }
    for (const field of [
      "expectedAdr",
      "expectedRevpar",
      "expectedTrevpar",
      "expectedGoppar",
      "driversJson",
      "expectedImpactJson",
      "reasonJson",
      "riskLevel",
      "overbookingLimit",
      "credentialsSecretRef",
      "idempotencyKey"
    ]) {
      assert.match(schema, new RegExp(field));
    }
  });

  it("exposes /revenue, /channel-manager and /rate-shopper API namespaces with protected mutations", () => {
    for (const route of [
      "/revenue/properties/:propertyId/forecasts/generate",
      "/revenue/properties/:propertyId/recommendations/generate",
      "/revenue/properties/:propertyId/recommendations/:id/apply",
      // Rate grid v2 (2026-09-14): the grid lives in modules/rate-manager and the
      // channel manager in modules/channel-manager, each with its own *.routes.ts
      // and route-permissions.partial.ts; the /revenue/…/rate-grid family and the
      // demoStore channel legs were retired.
      "/properties/:propertyId/rate-grid",
      "/properties/:propertyId/rate-grid/bulk-update",
      "/properties/:propertyId/rate-grid/push",
      // Tanda L2 (L2-01): the memory-only scenarios / automation-rules legs are
      // retired by L2-02 (tables dropped in 20260918130000_persistencia_l2).
      "/properties/:propertyId/channels",
      "/channel-manager/channels/:channelId/room-mappings",
      "/channel-manager/channels/:channelId/product-mappings",
      "/channel-manager/deliveries",
      "/rate-shopper/properties/:propertyId/competitors",
      "/rate-shopper/properties/:propertyId/shop",
      "/rate-shopper/properties/:propertyId/parity-alerts"
    ]) {
      assert.match(apiRoutesSource, new RegExp(escaped(route)), `route ${route} not registered in server.ts or modules/*/*.routes.ts`);
      assert.match(routePermissionsSource, new RegExp(escaped(route)), `route ${route} missing from the permission manifest (+partials)`);
    }
    // Restrictions are guarded inside the rate-manager services (bulk-update /
    // revert / applyRestrictionPatches escalate to revenue.manage_restrictions
    // when a patch touches restrictions), not by a dedicated route.
    assert.match(moduleFiles(".service.ts").join("\n"), /"revenue.manage_restrictions"/);
    assert.match(routePermissionsSource, /"channel_manager.mappings.manage"/);
    assert.match(routePermissionsSource, /riskLevel: "critical"/);
  });

  it("seeds explainable revenue behavior, health checks, audit events and safety gates", () => {
    for (const marker of [
      "ratePlans",
      "rateDays",
      "inventoryDays",
      "restrictionDays",
      "channels",
      "channelRoomMappings",
      "channelRateMappings",
      "channelSyncJobs",
      "competitorHotels",
      "competitorRateSnapshots",
      "rateParityAlerts",
      "revenueAutomationRules",
      "revenueScenarios",
      "externalReservations"
    ]) {
      // Tanda L2 (L2-03, corrector): the seed mirrors stay in demo-store.ts; the
      // engine service no longer reads any of them (Prisma-only record store).
      assert.match(demoStore, new RegExp(marker));
      assert.doesNotMatch(advancedService, new RegExp(`demoStore\\.${marker}\\b`));
    }
    for (const marker of [
      "channel_mappings_valid",
      "channel_sync_health_ok",
      "competitor_set_configured",
      "automation_rules_safe",
      "RevenueForecastGenerated",
      "RateGridBulkUpdated",
      "ChannelSyncFailed",
      "RateParityAlertCreated",
      "RevenueAutomationBlocked",
      "sync_health",
      "data_quality"
    ]) {
      assert.match(advancedService, new RegExp(marker));
    }
  });

  it("applies confirmed revenue operations into the operational rate grid safely", () => {
    // Tanda L2 (L2-03, corrector): the in-memory applyRevenueRecommendationToRateGrid
    // was retired; the canonical application writes rate_days through Prisma
    // (pricing.service.ts · decideRecommendation "applied") and the front calls
    // POST /revenue/properties/:propertyId/recommendations/:id/apply.
    for (const marker of [
      "decideRecommendation",
      "rateDay.updateMany",
      "manuallyOverridden: true",
      "resolveBarRatePlan",
      "La recomendación ya está aplicada.",
      "No se puede aplicar una recomendación sobre una fecha pasada",
      "REVENUE_RECOMMENDATION_APPLIED",
      "rateDaysUpdated"
    ]) {
      assert.match(pricingService, new RegExp(escaped(marker)));
    }
    assert.match(pricingService, /requirePermissions\(input\.context, \["revenue\.apply_recommendations"\]\)/);
    assert.match(routePermissionsSource, /"\/revenue\/properties\/:propertyId\/recommendations\/:id\/apply"/);
    assert.doesNotMatch(advancedService, /applyRevenueRecommendationToRateGrid/);
  });

  it("blocks unsafe channel syncs and records sync outcomes", () => {
    // Tanda L2 (L2-03, corrector): the in-memory evaluateChannelSyncSafety was
    // retired; the real gate is the channel readiness (credentials, mode,
    // product codes, recent success) of modules/channel-manager and the pushes
    // of the aggregator over Prisma channels. The audit catalogue keeps the
    // sync outcome events.
    for (const marker of ["readinessForGrid", "readyToPush", "credentialsCheck", "modeCheck", "productCodesCheck", "recentSuccessCheck"]) {
      assert.match(channelReadiness, new RegExp(marker));
    }
    for (const marker of ["pushRates", "pushAvailability", "pushRestrictions"]) {
      assert.match(channelAggregator, new RegExp(`export async function ${marker}`));
    }
    for (const marker of ["ChannelSyncSucceeded", "ChannelSyncFailed"]) {
      assert.match(advancedService, new RegExp(marker));
    }
    assert.doesNotMatch(advancedService, /evaluateChannelSyncSafety/);
  });

  it("adds typed channel adapters, AI tools and worker jobs", () => {
    for (const marker of [
      "export interface ChannelManagerAdapter",
      "booking_com_mock",
      "expedia_mock",
      "google_hotels_mock",
      "direct_booking_engine",
      "manual_channel",
      "pushAvailability",
      "pullReservations",
      "handleWebhook"
    ]) {
      assert.match(channelAdapter, new RegExp(marker));
    }
    for (const tool of [
      "analyzePace",
      "detectUnderpricedDates",
      "detectOverpricedDates",
      "simulateRevenueScenario",
      "analyzeRateParity",
      "recommendChannelCloseout",
      "summarizeRevenueRisks",
      "applyRevenueRecommendation",
      "syncChannelRates",
      "syncChannelAvailability"
    ]) {
      assert.match(toolNames, new RegExp(tool));
      assert.match(aiTools, new RegExp(tool));
    }
    assert.match(aiTools, /"revenue.apply_recommendations", "critical", true/);
    assert.match(aiTools, /"channel_manager.sync", "high", true/);
    // Tanda L2 (L2-07 · worker honesto): the scaffolded revenue job names
    // (generateDailyRevenueForecasts, runRateShopper, syncChannelRates…) that
    // answered «completed» without doing anything were retired; the worker
    // catalogue is the four real pg-boss queues and nothing else.
    for (const queue of ["notifications.scheduled", "notifications.retry", "notifications.sending-sweep", "webhooks.deliver"]) {
      assert.match(workerScheduler, new RegExp(`"${escaped(queue)}"`));
    }
    assert.doesNotMatch(worker + workerScheduler, /generateDailyRevenueForecasts|runRateShopper|syncChannelRates|runRevenueAutomationRules/);
  });

  it("adds mobile and admin screens plus a visible browser demo", () => {
    for (const path of [
      "../apps/mobile/src/screens/revenue/RevenueDashboardScreen.tsx",
      "../apps/mobile/src/screens/revenue/RevenueRecommendationsScreen.tsx",
      "../apps/mobile/src/screens/revenue/RateGridScreen.tsx",
      "../apps/mobile/src/screens/revenue/DemandCalendarScreen.tsx",
      "../apps/mobile/src/screens/revenue/ChannelManagerDashboardScreen.tsx",
      "../apps/mobile/src/screens/revenue/ChannelSyncHealthScreen.tsx",
      "../apps/mobile/src/screens/revenue/RateParityAlertsScreen.tsx",
      "../apps/mobile/src/screens/revenue/ScenarioSimulatorScreen.tsx",
      "../apps/mobile/src/screens/revenue/RevenueAIInsightScreen.tsx",
      "../apps/admin-web/src/screens/ChannelMappingsScreen.tsx",
      "../apps/admin-web/src/screens/RateShopperSettingsScreen.tsx",
    ]) {
      assert.equal(existsSync(new URL(path, import.meta.url)), true);
    }
    // Tanda 5 · L1b: ChannelMappingsScreen is the «Correspondencias» tab of
    // Comercial › Canales de venta, loaded by its container (CanalesTabs).
    const canalesTabs = readFileSync(new URL("../apps/admin-web/src/screens/tabs/comercial/CanalesTabs.tsx", import.meta.url), "utf8");
    for (const marker of [
      "ChannelMappingsScreen",
      "RateShopperSettingsScreen",
      // The Spanish label for "Revenue data quality" is "Calidad de datos".
      // The screen key (RevenueDataQuality) is also kept so deep links work.
      "Calidad de datos|RevenueDataQuality"
    ]) {
      assert.match(adminApp + adminSidebar + canalesTabs, new RegExp(marker));
    }
    for (const marker of [
      "Open Revenue",
      "Revenue & Profit Engine",
      "Predict demand, protect profit, control distribution",
      "Increase Double Standard Flexible BAR",
      "Rate grid snapshot",
      "Channel Manager",
      "Rate shopper and parity",
      "Scenario simulator and automation safety"
    ]) {
      assert.match(demoHtml + demoScript, new RegExp(escaped(marker)));
    }
  });
});
