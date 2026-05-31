import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const service = readFileSync(new URL("../apps/api/src/modules/backoffice/backoffice.service.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const routePermissions = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const demoStore = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
const apiClient = readFileSync(new URL("../apps/admin-web/src/services/backofficeApi.ts", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
const adminRoutes = readFileSync(new URL("../apps/admin-web/src/routes/backoffice.routes.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const demoJs = readFileSync(new URL("../demo/public/app.js", import.meta.url), "utf8");

describe("Property setup form routes", () => {
  it("adds a database-backed submission model and demo store records", () => {
    assert.match(schema, /model PropertySetupFormSubmission/);
    assert.match(schema, /property_setup_form_submissions/);
    assert.match(schema, /model ManualSetupSubmission/);
    assert.match(schema, /manual_setup_submissions/);
    assert.match(demoStore, /PropertySetupFormSubmissionRecord/);
    assert.match(demoStore, /propertySetupFormSubmissions/);
    assert.match(demoStore, /ManualSetupSubmissionRecord/);
    assert.match(demoStore, /manualSetupSubmissions/);
  });

  it("exposes form metadata and save endpoints with permissions", () => {
    for (const marker of [
      "PROPERTY_SETUP_FORM_DEFINITIONS",
      "listPropertySetupForms",
      "getPropertySetupForm",
      "savePropertySetupForm",
      "PropertySetupFormSaved",
      "PropertySetupFormValidationFailed",
      "applyPropertySetupForm"
    ]) {
      assert.match(service, new RegExp(marker));
    }

    for (const route of [
      "/backoffice/properties/:propertyId/property-setup/forms",
      "/backoffice/properties/:propertyId/property-setup/forms/:formCode"
    ]) {
      const escaped = route.replace(/[/:]/g, "\\$&");
      assert.match(server, new RegExp(escaped));
      assert.match(routePermissions, new RegExp(escaped));
      assert.match(apiClient, new RegExp(escaped));
    }
  });

  it("defines every manual setup form and its input categories", () => {
    for (const formCode of [
      "property_profile",
      "building",
      "floor",
      "zone",
      "room_type",
      "room",
      "space_resource",
      "department",
      "housekeeping_setup",
      "maintenance_setup",
      "revenue_setup",
      "finance_compliance_setup",
      "ai_setup",
      "custom_field"
    ]) {
      assert.match(service, new RegExp(`code: "${formCode}"`));
      assert.match(demoJs, new RegExp(`${formCode}: \\{`));
    }

    for (const category of [
      "Property profile",
      "Buildings",
      "Floors",
      "Zones",
      "Room types",
      "Rooms",
      "Spaces",
      "Bookable resources",
      "Departments",
      "Housekeeping sections",
      "Maintenance areas",
      "Market segments",
      "Invoice sequences",
      "AI settings",
      "Custom fields"
    ]) {
      assert.match(service + demoHtml, new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("adds admin routes and screens for every form", () => {
    assert.equal(existsSync(new URL("../apps/admin-web/src/screens/propertySetup/PropertySetupForms.tsx", import.meta.url)), true);
    for (const screen of [
      "PropertySetupHomeScreen",
      "PropertyProfileSetupForm",
      "BuildingSetupForm",
      "FloorSetupForm",
      "ZoneSetupForm",
      "RoomTypeSetupForm",
      "RoomSetupForm",
      "SpaceResourceSetupForm",
      "DepartmentSetupForm",
      "HousekeepingSetupForm",
      "MaintenanceSetupForm",
      "RevenueCategorySetupForm",
      "FinanceComplianceSetupForm",
      "AiPropertySetupForm",
      "CustomFieldSetupForm"
    ]) {
      assert.match(adminApp + adminRoutes + sidebar, new RegExp(screen));
    }

    for (const path of [
      "/backoffice/property-setup",
      "/backoffice/property-setup/property-profile",
      "/backoffice/property-setup/buildings",
      "/backoffice/property-setup/floors",
      "/backoffice/property-setup/zones",
      "/backoffice/property-setup/room-types",
      "/backoffice/property-setup/rooms",
      "/backoffice/property-setup/spaces-resources",
      "/backoffice/property-setup/departments",
      "/backoffice/property-setup/operations",
      "/backoffice/property-setup/maintenance",
      "/backoffice/property-setup/revenue",
      "/backoffice/property-setup/finance-compliance",
      "/backoffice/property-setup/ai",
      "/backoffice/property-setup/custom-fields"
    ]) {
      assert.match(adminRoutes + sidebar, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("links the local demo Property Setup cards to form routes", () => {
    for (const marker of [
      "property-form",
      "data-property-form=\"property_profile\"",
      "data-property-form=\"room\"",
      "data-property-form=\"space_resource\"",
      "data-property-form=\"finance_compliance_setup\"",
      "propertyFormEndpoint",
      "Save to database",
      "propertyFormSaveButton",
      "savePropertyFormDemo",
      "hotelos.propertySetupFormSubmissions",
      "renderPropertyForm"
    ]) {
      assert.match(demoHtml + demoJs, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("makes admin property setup forms saveable against the API", () => {
    const propertySetupScreen = readFileSync(new URL("../apps/admin-web/src/screens/propertySetup/PropertySetupForms.tsx", import.meta.url), "utf8");
    const formComponents = readFileSync(new URL("../apps/admin-web/src/components/forms/FormComponents.tsx", import.meta.url), "utf8");
    // The form labels were translated to Spanish during the Aurora refactor.
    // The semantic intent (current data preview, submission history,
    // entry point to the form, source-of-truth display) is preserved.
    for (const marker of [
      "fetchPropertySetupForm",
      "fetchPropertySetupForms",
      "savePropertySetupForm",
      "handleSave",
      "Valores actuales",          // Existing database data (panel header)
      "envíos anteriores",         // Submission history (chip in status panel)
      "Abrir formulario",          // Open form (link in form index)
      "onChange"
    ]) {
      assert.match(propertySetupScreen + formComponents, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const marker of ["BACKOFFICE_ROUTES", "screenFromPathname", "routeMatches", "window.history.pushState"]) {
      assert.match(adminApp, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
