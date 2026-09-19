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
// Tanda 5 · L1b: the sidebar renders nav-tree.generated.json (labels, keys, URLs and
// the legacy /backoffice/* redirects live there), so the menu source is both files.
const sidebar =
  readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8") +
  readFileSync(new URL("../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8");
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

describe("Advanced ehotelOS modules foundation", () => {
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

  it("PATCH /quality/cases/:id audits QualityCaseUpdated unless the status is resolved|closed (T8F-04)", () => {
    assert.match(advancedService, /"QualityCaseResolved",\s*\n\s*"QualityCaseUpdated",/);
    assert.match(server, /auditAction: \["resolved", "closed"\]\.includes\([^\n]*\) \? "QualityCaseResolved" : "QualityCaseUpdated"/);
  });

  it("exposes advanced API namespaces with route permissions for mutations", () => {
    // Tanda L2 (L2-01): the duplicated / memory-only legs that L2-02 retires
    // (/revenue/…/dashboard, /crm/profiles/:id/merge, /guest-portal/session/
    // :token/check-in, /analytics/query, /developer/webhooks/:id/test,
    // /ai-governance/tools/:toolName) are no longer pinned here.
    for (const route of [
      "/revenue/properties/:propertyId/recommendations/:id/apply",
      "/groups/:id/room-blocks",
      "/events/:id/generate-beo",
      "/workforce/time-clock/clock-in",
      "/procurement/purchase-orders/:id/approve",
      "/reputation/reviews/:id/respond",
      "/energy/properties/:propertyId/readings",
      "/safety/properties/:propertyId/incidents"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
    for (const protectedRoute of [
      "/revenue/properties/:propertyId/recommendations/:id/apply",
      "/groups/:id/room-blocks",
      "/procurement/purchase-orders/:id/approve"
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
    // Tanda L2 (L2-01): the scaffolded job catalogue (ADVANCED_WORKER_JOB_NAMES,
    // generateRevenueForecasts, processHumanReviewQueue) is retired by L2-07
    // (worker honesto): no longer pinned here.
    assert.match(sidebar, /Comercial/);
    // The developer/platform zone is now Configuración › Sistema (Webhooks, Aplicaciones, Referencia de API).
    assert.match(sidebar, /Webhooks|Aplicaciones|Plataforma de desarrollador|Desarrollador y sistema/);
    assert.match(mobileNavigation, /RevenueDashboard/);
    assert.match(mobileNavigation, /AIGovernanceSettings/);
    assert.match(preview, /Advanced ehotelOS modules/);
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

    // Tanda L2 (L2-03, corrector): the in-memory dashboards of the engine
    // (forecastOccupancy, pendingRecommendations, duplicateCandidates,
    // pipelineValue, blockedRoomNights…) were retired with the memory-only
    // routes (/dashboards/* and the Prisma record store replace them), so only
    // the browser demo copy is pinned here.
    for (const behavior of ["Review revenue recommendations", "Review guest duplicate merge", "Review group pickup"]) {
      assert.match(preview, new RegExp(behavior));
    }
    assert.doesNotMatch(advancedService, /forecastOccupancy|pendingRecommendations|duplicateCandidates|pipelineValue/, "the engine no longer computes dashboards from memory (L2-03)");
  });
});
