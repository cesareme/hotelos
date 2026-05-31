import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("manual setup route visibility", () => {
  it("defines a central manual setup route map with every major hotel-input setup area", () => {
    const routeMap = read("packages/product/src/navigation/manual-setup-route-map.ts");
    for (const marker of [
      "MANUAL_SETUP_OPTIONS",
      "MANUAL_SETUP_COVERAGE_SUMMARY",
      "validateManualSetupCoverage",
      "ManualSetupInputMethod",
      "ManualSetupCoverageIssue",
      "completionChecks",
      "inputMethods",
      "manual_form",
      "bulk_csv_xlsx",
      "ai_assisted",
      "api_connector",
      "credential_secret",
      "dry_run",
      "Property Profile",
      "Rooms & Room Types",
      "Spaces & Bookable Resources",
      "Category Manager",
      "Custom Fields",
      "Module Setup",
      "Integration Marketplace",
      "Users & Roles",
      "Revenue Settings",
      "Rate Grid",
      "History & Forecast",
      "Rate Plans & Rate Categories",
      "Forecast Settings",
      "Demand Calendar",
      "Rate Shopper & Competitor Set",
      "Recommendation & Automation Rules",
      "Channel Connections",
      "Channel Mappings",
      "Channel Sync Rules & Health",
      "Billing & Invoice Sequences",
      "Payment Settings",
      "Accounting Settings",
      "Tax, Fees & Tourism Tax Settings",
      "POS Outlets & Product Categories",
      "Procurement & Inventory Setup",
      "Assets, Capex & Energy Setup",
      "Workforce & Labor Setup",
      "Safety & Incident Setup",
      "Spain Guest Register",
      "SES.HOSPEDAJES Settings",
      "Authority Routing",
      "Guest Register Retention & Field Mapping",
      "AI Setup Wizard",
      "AI Governance",
      "Guest Portal & Online Check-in",
      "Concierge & Messaging Templates",
      "Analytics & Owner Reporting",
      "Audit, Security & Access Policies"
    ]) {
      assert.match(routeMap, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("exposes manual setup through API permissions and backoffice service", () => {
    const service = read("apps/api/src/modules/backoffice/backoffice.service.ts");
    const server = read("apps/api/src/server.ts");
    const permissions = read("apps/api/src/security/route-permissions.ts");
    const demoStore = read("apps/api/src/lib/demo-store.ts");
    assert.match(service, /listManualSetupOptions/);
    assert.match(service, /getManualSetupOptionDetail/);
    assert.match(service, /saveManualSetupOption/);
    assert.match(service, /MANUAL_SETUP_COVERAGE_SUMMARY/);
    assert.match(demoStore, /ManualSetupSubmissionRecord/);
    assert.match(demoStore, /manualSetupSubmissions/);
    assert.match(server, /\/backoffice\/properties\/:propertyId\/manual-setup\/options/);
    assert.match(server, /\/backoffice\/properties\/:propertyId\/manual-setup\/:optionCode/);
    assert.match(permissions, /manual-setup\/options/);
    assert.match(permissions, /manual-setup\/:optionCode/);
    assert.match(permissions, /configuration\.read/);
    assert.match(permissions, /configuration\.manage/);
  });

  it("renders admin and mobile manual setup entry points", () => {
    assert.equal(existsSync(new URL("../apps/admin-web/src/screens/manualSetup/ManualSetupHubScreen.tsx", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/backoffice/ManualSetupPreviewScreen.tsx", import.meta.url)), true);
    const adminRoutes = read("apps/admin-web/src/routes/backoffice.routes.tsx");
    const adminSidebar = read("apps/admin-web/src/navigation/Sidebar.tsx");
    const adminApp = read("apps/admin-web/src/App.tsx");
    const mobileApp = read("apps/mobile/App.tsx");
    const mobileRoutes = read("apps/mobile/src/navigation/ModuleRoutes.tsx");
    const launcher = read("apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx");
    const adminScreen = read("apps/admin-web/src/screens/manualSetup/ManualSetupHubScreen.tsx");
    const mobileScreen = read("apps/mobile/src/screens/backoffice/ManualSetupPreviewScreen.tsx");
    // The Manual Setup Hub now wraps the unified Setup Center, so the form
    // markup (save action, save service call) lives in SetupCenterScreen.
    const setupCenterScreen = read("apps/admin-web/src/screens/backoffice/SetupCenterScreen.tsx");

    for (const marker of [
      "/backoffice/manual-setup",
      "ManualSetupHubScreen",
      // The Manual Setup Center has been folded into the unified Setup Center
      // — the wrapper screen still mounts but the user-facing surface is the
      // localized Spanish Setup Center.
      "Setup Center",
      "ManualSetupPreview",
      "option.inputMethods",
      "option.completionChecks",
      // Form actions are now localized: "Guardar" instead of an English
      // "Save setup data" label.
      "Guardar",
      "saveManualSetupOption"
    ]) {
      assert.match(adminRoutes + adminSidebar + adminApp + mobileApp + mobileRoutes + launcher + adminScreen + mobileScreen + setupCenterScreen, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("links the local demo to manual setup options instead of generic backoffice jumps", () => {
    const demoHtml = read("demo/public/index.html");
    const demoJs = read("demo/public/app.js");

    for (const marker of [
      "manual-setup",
      "manual-setup-option",
      "manualSetupOptions",
      "renderManualSetupHub",
      "renderManualSetupOption",
      "manualSetupInputMethodsFor",
      "manualSetupCompletionChecksFor",
      "manualSetupCoverageSummary",
      "manualSetupCoverageUnchecked",
      "manualSetupOptionSaveButton",
      "saveManualSetupOptionDemo",
      "manualSetupOptionMethods",
      "manualSetupOptionChecks",
      "data-manual-setup=\"billing\"",
      "data-manual-setup=\"ses_hospedajes\"",
      "data-manual-setup=\"channel_mappings\"",
      "data-manual-setup=\"rate_grid\"",
      "data-manual-setup=\"category_manager\"",
      "manualSetupOptionRoute",
      "manualSetupOptionEndpoint",
      "manualSetupOptionSaveEndpoint"
    ]) {
      assert.match(demoHtml + demoJs, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
