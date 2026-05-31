import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const moduleCodes = readFileSync(new URL("../packages/product/src/modules/module-codes.ts", import.meta.url), "utf8");
const moduleManifest = readFileSync(new URL("../packages/product/src/modules/module-manifest.ts", import.meta.url), "utf8");
const permissions = readFileSync(new URL("../packages/shared/src/permissions.ts", import.meta.url), "utf8");
const sharedTypes = readFileSync(new URL("../packages/shared/src/types.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const routePermissions = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const advancedService = readFileSync(new URL("../apps/api/src/modules/advanced/advanced-modules.service.ts", import.meta.url), "utf8");
const demoStore = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8");
const mobileNavigation = readFileSync(new URL("../packages/product/src/navigation/mobile-navigation.ts", import.meta.url), "utf8");
const aiTools = readFileSync(new URL("../packages/ai-tools/src/registry.ts", import.meta.url), "utf8");
const toolNames = readFileSync(new URL("../packages/ai-tools/src/tool-names.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/advanced-modules-addendum.md", import.meta.url), "utf8");
const preview = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");

const advancedModules = [
  "revenue_profit_engine",
  "guest_data_crm_loyalty",
  "groups_events_sales",
  "workforce_labor",
  "procurement_inventory",
  "guest_self_service",
  "reputation_quality",
  "energy_sustainability",
  "safety_incident_management",
  "hotel_intelligence_platform",
  "developer_platform",
  "ai_governance"
];

describe("Advanced HotelOS modules foundation", () => {
  it("registers advanced modules through the existing product registry", () => {
    assert.match(moduleCodes, /AdvancedHotelModuleCode/);
    assert.match(moduleManifest, /ADVANCED_HOTEL_MODULES/);
    for (const code of advancedModules) {
      assert.match(moduleCodes, new RegExp(code));
      assert.match(moduleManifest, new RegExp(code));
      assert.match(moduleManifest, /adminRoutes/);
    }
  });

  it("adds advanced RBAC permissions", () => {
    for (const permission of [
      "revenue.read",
      "revenue.apply_recommendations",
      "crm.manage_campaigns",
      "groups.block_inventory",
      "workforce.timeclock.use",
      "purchase_orders.approve",
      "guest_portal.configure",
      "reputation.respond",
      "quality_cases.manage",
      "energy.manage",
      "sustainability.report",
      "incidents.manage",
      "analytics.ai_ask",
      "developer.manage_webhooks",
      "ai_governance.configure",
      "ai_tool_registry.manage"
    ]) {
      assert.match(sharedTypes, new RegExp(permission.replace(".", "\\.")));
      assert.match(permissions, new RegExp(permission.replace(".", "\\.")));
    }
  });

  it("adds schema contracts for advanced domains", () => {
    for (const model of [
      "RevenueForecast",
      "RevenueRecommendation",
      "GuestProfile",
      "CrmCampaign",
      "LoyaltyMembership",
      "GroupBooking",
      "GroupRoomBlock",
      "EventSpace",
      "StaffProfile",
      "TimeClockEntry",
      "Supplier",
      "InventoryItem",
      "PurchaseOrder",
      "GuestPortalSession",
      "UpsellOffer",
      "GuestReview",
      "QualityCase",
      "UtilityMeter",
      "SafetyIncident",
      "MetricDefinition",
      "DeveloperApp",
      "WebhookSubscription",
      "AiPolicy",
      "AiToolRegistry",
      "AiPromptVersion",
      "AiEvaluation",
      "AiIncident",
      "AiHumanReviewItem"
    ]) {
      assert.match(schema, new RegExp(`model ${model}`));
    }
  });

  it("exposes advanced API namespaces with route permissions for mutations", () => {
    for (const route of [
      "/revenue/properties/:propertyId/dashboard",
      "/revenue/properties/:propertyId/recommendations/:id/apply",
      "/crm/profiles/:id/merge",
      "/groups/:id/room-blocks",
      "/events/:id/generate-beo",
      "/workforce/time-clock/clock-in",
      "/procurement/purchase-orders/:id/approve",
      "/guest-portal/session/:token/check-in",
      "/reputation/reviews/:id/respond",
      "/energy/properties/:propertyId/readings",
      "/safety/properties/:propertyId/incidents",
      "/analytics/query",
      "/developer/webhooks/:id/test",
      "/ai-governance/tools/:toolName"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
    for (const protectedRoute of [
      "/revenue/properties/:propertyId/recommendations/:id/apply",
      "/groups/:id/room-blocks",
      "/procurement/purchase-orders/:id/approve",
      "/ai-governance/tools/:toolName"
    ]) {
      assert.match(routePermissions, new RegExp(protectedRoute.replace(/[/:]/g, "\\$&")));
    }
  });

  it("adds health checks, audit events, AI gates, workers and navigation", () => {
    for (const marker of [
      "ADVANCED_MODULE_HEALTH_CHECKS",
      "RevenueRecommendationApplied",
      "GuestProfileMerged",
      "GroupRoomBlockCreated",
      "StaffClockedIn",
      "PurchaseOrderApproved",
      "GuestOnlineCheckInCompleted",
      "ReviewResponseSent",
      "UtilityReadingCreated",
      "SafetyIncidentCreated",
      "MetricDefinitionCreated",
      "DeveloperAppSecretRotated",
      "AIEvaluationRun",
      "AIHumanReviewResolved"
    ]) {
      assert.match(advancedService, new RegExp(marker));
    }
    assert.match(aiTools, /canExecuteToolForModules/);
    assert.match(toolNames, /runAiSafetyEvaluation/);
    assert.match(worker, /ADVANCED_WORKER_JOB_NAMES/);
    assert.match(worker, /generateRevenueForecasts/);
    assert.match(worker, /processHumanReviewQueue/);
    assert.match(sidebar, /Comercial/);
    assert.match(sidebar, /Plataforma de desarrollador|Desarrollador y sistema/);
    assert.match(mobileNavigation, /RevenueDashboard/);
    assert.match(mobileNavigation, /AIGovernanceSettings/);
    assert.match(preview, /Advanced HotelOS modules/);
    assert.match(docs, /incremental extension/);
  });

  it("moves Phase 2 commercial modules beyond empty scaffolds", () => {
    for (const marker of [
      "revenueForecasts",
      "revenueRecommendations",
      "channelProfitabilitySnapshots",
      "guestProfiles",
      "guestProfileLinks",
      "crmSegments",
      "crmCampaigns",
      "loyaltyMemberships",
      "salesAccounts",
      "salesOpportunities",
      "groupBookings",
      "groupRoomBlocks",
      "eventSpaces",
      "hotelEvents",
      "eventOrders"
    ]) {
      assert.match(demoStore, new RegExp(marker));
    }

    for (const behavior of [
      "forecastOccupancy",
      "pendingRecommendations",
      "duplicateCandidates",
      "pipelineValue",
      "blockedRoomNights",
      "sourceProfileId",
      "blockedCount = block.pickedUpCount",
      "Review revenue recommendations",
      "Review guest duplicate merge",
      "Review group pickup"
    ]) {
      assert.match(advancedService + preview, new RegExp(behavior));
    }
  });
});
