import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";

const productManifest = readFileSync(new URL("../packages/product/src/modules/module-manifest.ts", import.meta.url), "utf8");
const productNavigation = readFileSync(new URL("../packages/product/src/navigation/mobile-navigation.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const routePermissions = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const productService = readFileSync(new URL("../apps/api/src/modules/product-modules/product-modules.service.ts", import.meta.url), "utf8");
const integrationService = readFileSync(new URL("../apps/api/src/modules/integrations/integrations.service.ts", import.meta.url), "utf8");
const mobileApp = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
const bottomTabs = readFileSync(new URL("../apps/mobile/src/navigation/BottomTabs.tsx", import.meta.url), "utf8");
const uiShared = readFileSync(new URL("../packages/ui/src/components/shared.tsx", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../packages/integrations/src/adapters/base-adapter.ts", import.meta.url), "utf8");
const aiRegistry = readFileSync(new URL("../packages/ai-tools/src/registry.ts", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/modular-suite-addendum.md", import.meta.url), "utf8");

describe("Modular suite organization", () => {
  it("adds product module manifests without replacing the architecture", () => {
    for (const code of [
      "pms_core",
      "ai_front_desk",
      "distribution_hub",
      "ai_booking_engine",
      "compliance_billing",
      "payment_vault",
      "outlet_pos",
      "integration_marketplace",
      "module_marketplace"
    ]) {
      assert.match(productManifest, new RegExp(code));
    }
    assert.match(productManifest, /dependencies/);
    assert.match(productManifest, /mobileRoutes/);
    assert.match(docs, /does not replace the existing HotelOS architecture/);
    assert.match(docs, /must not copy third-party/);
  });

  it("persists module and integration marketplace tables", () => {
    for (const model of [
      "model Module",
      "model PropertyModule",
      "model ModuleDependency",
      "model IntegrationCategory",
      "model IntegrationProvider",
      "model IntegrationConnection",
      "model IntegrationEvent",
      "model Channel",
      "model InventoryDay",
      "model RateDay",
      "model PaymentIntent",
      "model PaymentRefund",
      "model Outlet",
      "model PosOrder"
    ]) {
      assert.match(schema, new RegExp(model));
    }
  });

  it("exposes module registry endpoints with dependency validation and audit events", () => {
    for (const route of [
      "/modules/catalog",
      "/modules/:moduleCode/dependencies",
      "/properties/:propertyId/modules",
      "/properties/:propertyId/modules/:moduleCode/enable",
      "/properties/:propertyId/modules/:moduleCode/disable"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
      assert.match(routePermissions, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
    assert.match(productService, /getMissingModuleDependencies/);
    assert.match(productService, /Core modules cannot be disabled/);
    assert.match(productService, /ModuleEnabled/);
    assert.match(productService, /ModuleDisabled/);
  });

  it("adds mobile-first suite navigation and required screen files", () => {
    for (const tab of ["Hoy", "Timeline", "IA", "Operaciones", "Mas"]) {
      assert.match(productNavigation + bottomTabs + mobileApp, new RegExp(tab));
    }
    for (const path of [
      "../apps/mobile/src/screens/rooms/MobilePlanningScreen.tsx",
      "../apps/mobile/src/screens/rooms/TabletPlanningScreen.tsx",
      "../apps/mobile/src/screens/more/ModuleMarketplaceScreen.tsx",
      "../apps/mobile/src/screens/more/IntegrationMarketplaceScreen.tsx"
    ]) {
      assert.equal(existsSync(new URL(path, import.meta.url)), true);
    }
    assert.match(productNavigation, /filterMobileNavigation/);
  });

  it("adds the required reusable UI components", () => {
    for (const component of [
      "MetricCard",
      "StatusChip",
      "RoomStatusBadge",
      "ReservationCard",
      "RoomCard",
      "TaskCard",
      "ConfirmationCard",
      "ComplianceAlertCard",
      "AiCommandInput",
      "VoiceButton",
      "CameraActionButton",
      "TimelineGrid",
      "RateGridCell",
      "IntegrationCard",
      "ModuleCard",
      "BottomSheet",
      "ActionDrawer",
      "AuditTrailPanel"
    ]) {
      // Each component must have a public entry file (the public surface);
      // most are implemented inline in shared.tsx, but TimelineGrid lives in
      // shared.tsx as TimelineDataGrid and is re-exported via TimelineGrid.tsx.
      assert.equal(existsSync(new URL(`../packages/ui/src/components/${component}.tsx`, import.meta.url)), true);
      const sharedAlias = component === "TimelineGrid" ? "TimelineDataGrid" : component;
      assert.match(uiShared, new RegExp(sharedAlias));
    }
    assert.match(uiShared, /riskLevel/);
    assert.match(uiShared, /requiredApprovals/);
  });

  it("adds integration marketplace registry, adapters, endpoints and secret-reference rule", () => {
    for (const marker of ["IntegrationAuthType", "IntegrationCapability", "IntegrationAdapter", "validateConnection", "testConnection"]) {
      assert.match(adapter, new RegExp(marker));
    }
    for (const route of [
      "/integrations/categories",
      "/integrations/providers",
      "/properties/:propertyId/integrations",
      "/properties/:propertyId/integrations/:providerCode/connect",
      "/properties/:propertyId/integrations/:connectionId/test",
      "/properties/:propertyId/integrations/:connectionId/events"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
    assert.match(integrationService, /credentialsSecretRef/);
    assert.match(integrationService, /must be stored in a secret manager reference/);
    assert.match(integrationService, /IntegrationConnected/);
    assert.match(integrationService, /IntegrationDisconnected/);
  });

  it("makes AI tools module-aware before execution", () => {
    assert.match(aiRegistry, /moduleCode/);
    assert.match(aiRegistry, /canExecuteToolForModules/);
    assert.match(aiRegistry, /Module .* is disabled/);
    assert.match(aiRegistry, /Missing permission/);
  });
});
