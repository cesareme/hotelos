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
const advancedService = readFileSync(new URL("../apps/api/src/modules/advanced/advanced-modules.service.ts", import.meta.url), "utf8");
const demoStore = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
const aiTools = readFileSync(new URL("../packages/ai-tools/src/registry.ts", import.meta.url), "utf8");
const toolNames = readFileSync(new URL("../packages/ai-tools/src/tool-names.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
const channelAdapter = readFileSync(new URL("../packages/integrations/src/channel-manager.ts", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
const adminSidebar = readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const demoScript = readFileSync(new URL("../demo/public/app.js", import.meta.url), "utf8");

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Revenue Management and Channel Manager module", () => {
  it("upgrades the product registry, permissions and mobile visibility for revenue_profit_engine", () => {
    assert.match(manifest, /code: "revenue_profit_engine"/);
    for (const marker of [
      "Forecasting, dynamic pricing, channel management, restrictions, rate intelligence, demand prediction and profit optimization",
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
      "RevenueAutomationRule",
      "RevenueScenario",
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
      "/revenue/recommendations/:recommendationId/apply",
      "/revenue/properties/:propertyId/rate-grid",
      "/revenue/properties/:propertyId/rate-grid/bulk-update",
      "/revenue/properties/:propertyId/scenarios/simulate",
      "/revenue/properties/:propertyId/automation-rules",
      "/channel-manager/properties/:propertyId/channels",
      "/channel-manager/channels/:channelId/room-mappings",
      "/channel-manager/channels/:channelId/sync/rates",
      "/channel-manager/channels/:channelId/reservations/import",
      "/rate-shopper/properties/:propertyId/competitors",
      "/rate-shopper/properties/:propertyId/shop",
      "/rate-shopper/properties/:propertyId/parity-alerts"
    ]) {
      assert.match(server, new RegExp(escaped(route)));
      assert.match(routePermissions, new RegExp(escaped(route)));
    }
    assert.match(routePermissions, /"revenue.manage_restrictions"/);
    assert.match(routePermissions, /"channel_manager.mappings.manage"/);
    assert.match(routePermissions, /riskLevel: "critical"/);
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
      assert.match(demoStore, new RegExp(marker));
      assert.match(advancedService, new RegExp(marker));
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
      "data_quality",
      "revenue_alerts"
    ]) {
      assert.match(advancedService, new RegExp(marker));
    }
  });

  it("applies confirmed revenue operations into the operational rate grid safely", () => {
    for (const marker of [
      "applyRevenueRecommendationToRateGrid",
      "applyRateDayUpdates",
      "applyRestrictionDayUpdates",
      "applyInventoryDayUpdates",
      "manualOverrideBlocked",
      "priceLimitBlocked",
      "previewRequired: !confirmed",
      "appliedChanges",
      "approvalRequired",
      "RevenueAutomationBlocked"
    ]) {
      assert.match(advancedService, new RegExp(marker));
    }
    assert.match(advancedService, /recommendation\.status !== "approved"/);
    assert.match(advancedService, /existing\.syncStatus = "pending"/);
  });

  it("blocks unsafe channel syncs and records sync outcomes", () => {
    for (const marker of [
      "evaluateChannelSyncSafety",
      "Channel sync is unhealthy or disabled",
      "Missing room or rate mapping blocks channel sync",
      "ChannelSyncSucceeded",
      "ChannelSyncFailed",
      "lastSyncAt",
      "exportedAvailability",
      "exportedRates"
    ]) {
      assert.match(advancedService, new RegExp(marker));
    }
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
    for (const job of [
      "generateDailyRevenueForecasts",
      "calculatePickupAndPace",
      "detectRateParityIssues",
      "runRateShopper",
      "syncChannelAvailability",
      "syncChannelRates",
      "syncChannelRestrictions",
      "pullChannelReservations",
      "retryFailedChannelSyncJobs",
      "calculateForecastAccuracy",
      "runRevenueAutomationRules",
      "detectUnderpricingRisk"
    ]) {
      assert.match(worker, new RegExp(job));
    }
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
      "../apps/admin-web/src/screens/RevenueSettingsScreen.tsx",
      "../apps/admin-web/src/screens/RevenueAutomationRulesScreen.tsx",
      "../apps/admin-web/src/screens/ChannelMappingsScreen.tsx",
      "../apps/admin-web/src/screens/RateShopperSettingsScreen.tsx",
      "../apps/admin-web/src/screens/RevenueDataQualityScreen.tsx"
    ]) {
      assert.equal(existsSync(new URL(path, import.meta.url)), true);
    }
    for (const marker of [
      "RevenueSettingsScreen",
      "RevenueAutomationRulesScreen",
      "ChannelManagerSettingsScreen",
      "ChannelMappingsScreen",
      "RateShopperSettingsScreen",
      // The Spanish label for "Revenue data quality" is "Calidad de datos".
      // The screen key (RevenueDataQuality) is also kept so deep links work.
      "Calidad de datos|RevenueDataQuality"
    ]) {
      assert.match(adminApp + adminSidebar, new RegExp(marker));
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
