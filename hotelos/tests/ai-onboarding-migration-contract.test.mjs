import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("AI Onboarding & Migration module", () => {
  it("registers the module, permissions, routes, AI tools and workers", () => {
    const moduleCodes = read("packages/product/src/modules/module-codes.ts");
    const manifest = read("packages/product/src/modules/module-manifest.ts");
    const permissions = read("packages/shared/src/types.ts");
    const routeMap = read("packages/product/src/navigation/module-route-map.ts");
    const toolNames = read("packages/ai-tools/src/tool-names.ts");
    const aiRegistry = read("packages/ai-tools/src/registry.ts");
    const workers = read("apps/worker/src/index.ts");

    assert.match(moduleCodes, /"ai_onboarding_migration"/);
    assert.match(manifest, /AI Onboarding & Migration/);
    assert.match(manifest, /onboarding\.upload/);
    assert.match(manifest, /AISetupWizard/);
    assert.match(permissions, /"onboarding\.manage_cutover"/);
    assert.match(routeMap, /\/backoffice\/ai-setup/);
    assert.match(routeMap, /Go-Live Readiness/);

    [
      "classifyOnboardingFile",
      "extractFloorPlanStructure",
      "extractRevenueHistoryFromReport",
      "generatePropertyBlueprint",
      "suggestReservationImportMapping",
      "detectMigrationConflicts",
      "generateGoLiveChecklist"
    ].forEach((toolName) => {
      assert.match(toolNames, new RegExp(`"${toolName}"`));
      assert.match(aiRegistry, new RegExp(`"${toolName}", "ai_onboarding_migration"`));
    });

    [
      "classifyOnboardingFiles",
      "extractOnboardingDocuments",
      "parseOnboardingSpreadsheets",
      "syncSourcePmsData",
      "generateHotelBlueprintSuggestions",
      "runMigrationDryRun",
      "applyMigrationBatch",
      "rollbackMigrationBatch",
      "generateGoLiveReadinessReport",
      "runCutoverDeltaImport"
    ].forEach((jobName) => assert.match(workers, new RegExp(`"${jobName}"`)));
  });

  it("creates canonical onboarding schemas, connector interfaces and AI gateway agents", () => {
    const connectors = read("packages/onboarding/src/connectors/pms-source-connector.ts");
    const extraction = read("packages/onboarding/src/extraction/document-extraction-provider.ts");
    const dataQuality = read("packages/onboarding/src/data-quality/checks.ts");
    const dryRun = read("packages/onboarding/src/dry-run/migration-dry-run.ts");
    const cutover = read("packages/onboarding/src/cutover/cutover-plan.ts");
    const deltaImport = read("packages/onboarding/src/cutover/delta-import.ts");
    const floorPlan = read("packages/onboarding/src/floor-plan/floor-plan-mapping.ts");
    const roomWalk = read("packages/onboarding/src/property-blueprint/room-walk-setup.ts");
    const humanReview = read("packages/onboarding/src/review/human-review-queue.ts");
    const previewMasking = read("packages/onboarding/src/security/preview-masking.ts");
    const historyImporter = read("packages/onboarding/src/revenue-history/history-forecast-importer.ts");
    const safety = read("packages/onboarding/src/security/onboarding-safety.ts");
    const blueprint = read("packages/onboarding/src/schemas/hotel-blueprint.schema.ts");
    const revenueSnapshot = read("packages/onboarding/src/schemas/revenue-snapshot-mapping.schema.ts");
    const agents = read("apps/ai-gateway/src/onboarding-agents.ts");

    [
      "PmsSourceConnector",
      "mews_connector_adapter",
      "oracle_ohip_adapter",
      "cloudbeds_adapter",
      "apaleo_adapter",
      "generic_csv_adapter",
      "generic_xlsx_adapter",
      "generic_pdf_report_adapter",
      "manual_setup_adapter"
    ].forEach((needle) => assert.match(connectors, new RegExp(needle)));

    assert.match(extraction, /DocumentExtractionProvider/);
    assert.match(extraction, /openai_vision/);
    assert.match(dataQuality, /runOnboardingDataQualityChecks/);
    assert.match(dataQuality, /history_forecast_totals_mismatch/);
    assert.match(dataQuality, /missing_ses_hospedajes_configuration/);
    assert.match(dryRun, /ONBOARDING_IMPORT_APPLICATION_ORDER/);
    assert.match(dryRun, /assertMigrationCanApply/);
    assert.match(dryRun, /Migration apply requires explicit human confirmation/);
    assert.match(cutover, /generateCutoverAssistantPlan/);
    assert.match(cutover, /deltaImportRequired: true/);
    assert.match(deltaImport, /generateCutoverDeltaImportDryRun/);
    assert.match(deltaImport, /dryRunOnly: true/);
    assert.match(deltaImport, /applyRequiresConfirmation: true/);
    assert.match(floorPlan, /createFloorPlanMappingReview/);
    assert.match(floorPlan, /aiFloorPlanMappingIsAssistive: true/);
    assert.match(floorPlan, /cannotUseForLegalSafetyWithoutReview: true/);
    assert.match(roomWalk, /parseRoomWalkTranscript/);
    assert.match(roomWalk, /applyBlockedUntilApproved: true/);
    assert.match(humanReview, /buildHumanReviewQueue/);
    assert.match(humanReview, /applyBlockedUntilQueueCleared/);
    assert.match(previewMasking, /maskOnboardingPreview/);
    assert.match(historyImporter, /HISTORY_FORECAST_REQUIRED_COLUMNS/);
    assert.match(historyImporter, /History subtotal/);
    assert.match(historyImporter, /totalsMatch/);
    assert.match(safety, /inspectOnboardingPayloadForSensitiveData/);
    assert.match(safety, /Do not import CVV/);
    assert.match(blueprint, /HotelBlueprint/);
    assert.match(blueprint, /inventoryResources/);
    assert.match(revenueSnapshot, /RevenueSnapshotMappingTarget/);
    assert.match(revenueSnapshot, /totalsMatchReport/);

    [
      "OnboardingOrchestratorAgent",
      "DocumentClassifierAgent",
      "PropertyMapperAgent",
      "RevenueHistoryAgent",
      "ComplianceSetupAgent",
      "GoLiveReadinessAgent",
      "HumanReviewAgent"
    ].forEach((agentName) => assert.match(agents, new RegExp(agentName)));
    assert.match(agents, /canApplyMigration: false/);
    assert.match(agents, /writesDatabaseDirectly: false/);
  });

  it("exposes protected onboarding API endpoints and visible UI entry points", () => {
    const routePermissions = read("apps/api/src/security/route-permissions.ts");
    const server = read("apps/api/src/server.ts");
    const onboardingService = read("apps/api/src/modules/onboarding/onboarding.service.ts");
    const mobileApp = read("apps/mobile/App.tsx");
    const localLauncher = read("apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx");
    const moreScreen = read("apps/mobile/src/screens/more/MoreScreen.tsx");
    const setupCenter = read("apps/admin-web/src/screens/backoffice/SetupCenterScreen.tsx");
    const adminRoutes = read("apps/admin-web/src/routes/backoffice.routes.tsx");
    const sidebar = read("apps/admin-web/src/navigation/Sidebar.tsx");
    const demo = read("demo/public/index.html");
    const docs = read("docs/ai-onboarding-migration.md");

    [
      "/onboarding/projects",
      "/onboarding/projects/:projectId/files",
      "/onboarding/files/:fileId/classify",
      "/onboarding/projects/:projectId/ai/generate-blueprint",
      "/onboarding/projects/:projectId/room-walk/parse",
      "/onboarding/files/:fileId/floor-plan/map",
      "/onboarding/projects/:projectId/human-review-queue",
      "/onboarding/projects/:projectId/dry-run",
      "/onboarding/projects/:projectId/cutover-plan",
      "/onboarding/projects/:projectId/cutover/delta-import/dry-run",
      "/onboarding/projects/:projectId/apply",
      "/onboarding/projects/:projectId/go-live"
    ].forEach((path) => {
      assert.match(routePermissions, new RegExp(path.replaceAll("/", "\\/").replaceAll(":", ":")));
    });

    assert.match(routePermissions, /"onboarding\.apply"/);
    assert.match(routePermissions, /riskLevel: "critical"/);
    assert.match(server, /createOnboardingProject/);
    assert.match(server, /uploadOnboardingFile/);
    assert.match(server, /classifyOnboardingFileApi/);
    assert.match(server, /parseRoomWalkSetup/);
    assert.match(server, /mapFloorPlanFile/);
    assert.match(server, /getHumanReviewQueue/);
    assert.match(server, /runMigrationDryRun/);
    assert.match(server, /getCutoverPlan/);
    assert.match(server, /runCutoverDeltaImportDryRun/);
    assert.match(server, /approveOnboardingGoLive/);
    assert.match(onboardingService, /inspectOnboardingPayloadForSensitiveData/);
    assert.match(onboardingService, /maskOnboardingPreview/);
    assert.match(onboardingService, /buildHumanReviewQueue/);
    assert.match(onboardingService, /buildHistoryForecastImportPreview/);
    assert.match(onboardingService, /createFloorPlanMappingReview/);
    assert.match(onboardingService, /parseRoomWalkTranscript/);
    assert.match(onboardingService, /generateCutoverAssistantPlan/);
    assert.match(onboardingService, /generateCutoverDeltaImportDryRun/);
    assert.match(onboardingService, /generateMigrationDryRun/);
    assert.match(onboardingService, /confirmation_required/);

    assert.match(mobileApp, /AISetupWizardScreen/);
    assert.match(mobileApp, /GoLiveReadinessMobileScreen/);
    assert.match(localLauncher, /AI Setup Wizard/);
    assert.match(moreScreen, /ai_onboarding_migration/);
    assert.match(setupCenter, /Start AI Setup/);
    assert.match(adminRoutes, /\/backoffice\/ai-setup/);
    assert.match(sidebar, /Alta y migración|AI Setup & Migration/);
    assert.match(demo, /AI Setup Wizard/);
    assert.match(demo, /Dry-run result/);
    assert.match(demo, /Import application order/);
    assert.match(demo, /Apply gate/);
    assert.match(demo, /Room Walk Setup/);
    assert.match(demo, /Floor plan assist/);
    assert.match(demo, /Cutover Assistant/);
    assert.match(demo, /Human Review Queue/);
    assert.match(demo, /Delta import dry-run/);
    assert.match(docs, /AI suggests, humans approve/);
    assert.match(docs, /Dry-run is mandatory/);
    assert.match(docs, /Data Quality Gate/);
    assert.match(docs, /Property Blueprint Assist/);
    assert.match(docs, /Cutover Assistant/);
    assert.match(docs, /Human Review Queue/);
    assert.match(docs, /Delta Import Dry-Run/);
    assert.match(docs, /History & Forecast totals mismatch/);
  });

  it("seeds local demo permissions and a demo onboarding project", () => {
    const seed = read("packages/database/seeds/local-demo.seed.ts");
    const demoStore = read("apps/api/src/lib/demo-store.ts");

    assert.match(seed, /ai_onboarding_migration/);
    assert.match(seed, /LOCAL_DEMO_ONBOARDING_PROJECT/);
    assert.match(seed, /history_forecast_may_2026\.xlsx/);
    assert.match(seed, /onboarding\.manage_cutover/);
    assert.match(demoStore, /"ai_onboarding_migration"/);
    assert.match(demoStore, /"onboarding\.go_live"/);
  });
});
