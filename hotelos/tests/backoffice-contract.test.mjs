import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const sharedTypes = readFileSync(new URL("../packages/shared/src/types.ts", import.meta.url), "utf8");
const permissions = readFileSync(new URL("../packages/shared/src/permissions.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const routePermissions = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const backofficeService = readFileSync(new URL("../apps/api/src/modules/backoffice/backoffice.service.ts", import.meta.url), "utf8");
const demoStore = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
const adminStyles = readFileSync(new URL("../apps/admin-web/src/styles.css", import.meta.url), "utf8");
const backOfficeDashboard = readFileSync(new URL("../apps/admin-web/src/screens/BackOfficeDashboard.tsx", import.meta.url), "utf8");
const propertyMapper = readFileSync(new URL("../apps/admin-web/src/screens/PropertyMapper.tsx", import.meta.url), "utf8");
const aiSettings = readFileSync(new URL("../apps/admin-web/src/screens/AISettings.tsx", import.meta.url), "utf8");
const departmentManager = readFileSync(new URL("../apps/admin-web/src/screens/DepartmentManager.tsx", import.meta.url), "utf8");
const mobileSummary = readFileSync(new URL("../apps/mobile/src/screens/settings/BackOfficeSetupScreen.tsx", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/backoffice-addendum.md", import.meta.url), "utf8");

describe("Back Office hotel setup layer", () => {
  it("adds the Back Office admin-web shell and required screen modules", () => {
    for (const screen of [
      "BackOfficeDashboard",
      "PropertySetupWizard",
      "GoLiveChecklist",
      "OrganizationSettings",
      "PropertySettings",
      "PropertyMapper",
      "RoomTypeManager",
      "RoomInventoryManager",
      "DepartmentManager",
      "UserRoleManager",
      "ModuleManager",
      "ModuleConfigurationCenter",
      "ModuleHealthCenter",
      "IntegrationManager",
      "TaxComplianceSettings",
      "BillingSettings",
      "AccountingSettings",
      "PaymentSettings",
      "AISettings",
      "DocumentTemplateManager",
      "AuditLogViewer"
    ]) {
      assert.equal(existsSync(new URL(`../apps/admin-web/src/screens/${screen}.tsx`, import.meta.url)), true);
      assert.match(adminApp + sidebar, new RegExp(screen));
    }

    for (const navLabel of [
      // The sidebar has been translated to Spanish. Each English label below
      // is matched against its Spanish equivalent (or a representative entry
      // when the section was reorganised).
      "Configuración de propiedad", // Hotel Setup
      "Módulos e integraciones",    // Modules
      "Operaciones",                // Operations
      "Comercial",                  // Commercial
      "Experiencia del huésped",    // Guest Experience
      "Finanzas y fiscal",          // Finance and Compliance
      "activos",                    // Asset and Sustainability (asset role nav)
      "Plataforma de desarrollador" // Platform (Developer & system)
    ]) {
      assert.match(sidebar, new RegExp(navLabel));
    }
  });

  it("persists property mapping, readiness, settings, QR and import contracts", () => {
    for (const model of [
      "model Building",
      "model Floor",
      "model PropertyZone",
      "model PropertySpace",
      "model PropertyMapPosition",
      "model RoomFeature",
      "model RoomFeatureAssignment",
      "model BedType",
      "model RoomBed",
      "model PropertySetupStep",
      "model PropertyReadinessCheck",
      "model ModuleHealthCheck",
      "model Department",
      "model UserDepartment",
      "model HousekeepingSection",
      "model HousekeepingSectionRoom",
      "model HousekeepingRule",
      "model MaintenanceArea",
      "model MaintenanceAreaRoom",
      "model MaintenanceRule",
      "model PropertyComplianceSetting",
      "model InvoiceSequence",
      "model AccountingSetting",
      "model CostCenter",
      "model PropertyAiSetting",
      "model PropertyAiToolSetting",
      "model DocumentTemplate",
      "model QrCode",
      "model PropertyImport",
      "model BackOfficeAiSuggestion"
    ]) {
      assert.match(schema, new RegExp(model));
    }

    for (const roomField of ["buildingId", "floorId", "zoneId", "bedConfigurationJson", "featuresJson", "accessibilityJson", "squareMeters"]) {
      assert.match(schema, new RegExp(roomField));
    }

    for (const assetField of ["assetCode", "manufacturer", "model", "installationDate", "purchaseCost", "qrCodeValue"]) {
      assert.match(schema, new RegExp(assetField));
    }
  });

  it("exposes the /backoffice API namespace with route permissions", () => {
    for (const route of [
      "/backoffice/properties/:propertyId/dashboard",
      "/backoffice/properties/:propertyId/setup",
      "/backoffice/properties/:propertyId/readiness",
      "/backoffice/properties/:propertyId/go-live",
      "/backoffice/properties/:propertyId/map",
      "/backoffice/properties/:propertyId/buildings",
      "/backoffice/properties/:propertyId/floors",
      "/backoffice/properties/:propertyId/zones",
      "/backoffice/properties/:propertyId/spaces",
      "/backoffice/properties/:propertyId/map-positions",
      "/backoffice/properties/:propertyId/rooms/bulk",
      "/backoffice/properties/:propertyId/property-map/export",
      "/backoffice/properties/:propertyId/room-types",
      "/backoffice/properties/:propertyId/room-types/:roomTypeId",
      "/backoffice/properties/:propertyId/room-types/:roomTypeId/deactivate",
      "/backoffice/properties/:propertyId/room-types/:roomTypeId/merge",
      "/backoffice/room-types/:roomTypeId/rooms",
      "/backoffice/properties/:propertyId/room-features",
      "/backoffice/properties/:propertyId/bed-types",
      "/backoffice/properties/:propertyId/imports/property-map/preview",
      "/backoffice/properties/:propertyId/imports/property-map/commit",
      "/backoffice/properties/:propertyId/modules",
      "/backoffice/properties/:propertyId/modules/:moduleCode/configuration",
      "/backoffice/properties/:propertyId/modules/:moduleCode/health",
      "/backoffice/properties/:propertyId/integrations",
      "/backoffice/properties/:propertyId/departments/:departmentId/users",
      "/backoffice/properties/:propertyId/housekeeping-settings",
      "/backoffice/properties/:propertyId/housekeeping-sections",
      "/backoffice/properties/:propertyId/housekeeping-sections/:sectionId/rooms",
      "/backoffice/properties/:propertyId/housekeeping-rules/:ruleCode",
      "/backoffice/properties/:propertyId/maintenance-settings",
      "/backoffice/properties/:propertyId/maintenance-areas",
      "/backoffice/properties/:propertyId/maintenance-areas/:areaId/rooms",
      "/backoffice/properties/:propertyId/maintenance-rules/:ruleCode",
      "/backoffice/properties/:propertyId/users",
      "/backoffice/properties/:propertyId/users/invite",
      "/backoffice/properties/:propertyId/users/:userId/disable",
      "/backoffice/roles",
      "/backoffice/permissions",
      "/backoffice/properties/:propertyId/compliance-settings",
      "/backoffice/properties/:propertyId/billing-settings",
      "/backoffice/properties/:propertyId/accounting-settings",
      "/backoffice/properties/:propertyId/ai-settings",
      "/backoffice/properties/:propertyId/ai/suggestions",
      "/backoffice/properties/:propertyId/ai/suggestions/:suggestionId/apply",
      "/backoffice/properties/:propertyId/templates",
      "/backoffice/properties/:propertyId/qr-codes",
      "/backoffice/properties/:propertyId/qr-codes/bulk",
      "/backoffice/properties/:propertyId/audit"
    ]) {
      const escaped = route.replace(/[/:]/g, "\\$&");
      assert.match(server, new RegExp(escaped));
      assert.match(routePermissions, new RegExp(escaped));
    }
  });

  it("adds Back Office permissions and role mappings", () => {
    for (const permission of [
      "backoffice.access",
      "property.configure",
      "property.map.read",
      "property.map.manage",
      "property.import",
      "property.go_live",
      "modules.configure",
      "integrations.configure",
      "integrations.view_logs",
      "users.read",
      "users.invite",
      "roles.manage",
      "tax.configure",
      "compliance.configure",
      "billing.configure",
      "accounting.configure",
      "payments.configure",
      "ai.configure",
      "templates.manage",
      "audit.read"
    ]) {
      assert.match(sharedTypes, new RegExp(permission.replace(".", "\\.")));
      assert.match(permissions, new RegExp(permission.replace(".", "\\.")));
      assert.match(demoStore, new RegExp(permission.replace(".", "\\.")));
    }
  });

  it("implements Back Office validation, audit, imports and go-live blockers", () => {
    for (const marker of [
      "Room number must be unique per property",
      "Sellable rooms must have a room type",
      "PropertyImportPreviewed",
      "PropertyImportCommitted",
      "PropertyGoLiveApproved",
      "RoomTypeCreated",
      "RoomTypeUpdated",
      "RoomTypeDeactivated",
      "RoomTypeMerged",
      "RoomBulkUpdated",
      "Changing max occupancy must validate future reservations",
      "Room cannot be marked sellable if no room type is assigned",
      "UserInvited",
      "UserDisabled",
      "TemplateCreated",
      "blockingCount",
      "AI settings cannot allow ID image storage by default",
      "QRCodeGenerated",
      "QRCodeBulkGenerated",
      "PropertyMapPositionCreated",
      "HousekeepingSectionCreated",
      "MaintenanceAreaCreated",
      "BackOfficeAiSuggestionCreated",
      "BackOfficeAiSuggestionApplied",
      "AI cannot apply Back Office changes without preview and confirmation",
      "ModuleConfigured"
    ]) {
      assert.match(backofficeService, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("scaffolds the Property Mapper UI and mobile setup summary", () => {
    // The Property Mapper was refactored from a multi-view (tree/grid/floor
    // plan) tool into an AI-assisted document-upload assistant. The markers
    // below cover the same intent (import → preview → review → apply) in the
    // current Spanish-first UI.
    for (const marker of [
      "Mapeador de propiedad",                     // page eyebrow / nav
      "Mapea tu propiedad desde documentos",        // import entry point
      "CSV",                                        // CSV import flow remains
      "Mapa de propiedad propuesto",                // proposal preview
      "Revisa antes de aplicar",                    // review step before apply
      "Lo que hay mapeado ahora"                    // existing structure view
    ]) {
      assert.match(propertyMapper, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    assert.match(mobileSummary, /Back Office/);
    assert.match(mobileSummary, /Go-live blockers/);
    assert.match(aiSettings, /AI Setup Assistant/);
    assert.match(aiSettings, /Preview before apply/);
    assert.match(departmentManager, /Housekeeping configuration/);
    assert.match(departmentManager, /Maintenance configuration/);
    assert.match(docs, /The Back Office is the configuration and control center/);
  });

  it("adds Aurora Back Office readiness and setup control surfaces", () => {
    // The eyebrow now uses a separator between "Aurora" and "Back Office".
    // The other markers cover the same intent (setup checklist, go-live
    // readiness, recent audit signals) in the redesigned dashboard.
    for (const marker of [
      "HotelOS Aurora · Back Office",  // page eyebrow
      "Continue setup checklist",      // primary CTA in hero
      "Go-live readiness",             // readiness card
      "Recalculate readiness",         // module health / readiness action
      "OnboardingGoLiveReadiness"      // routed event surface
    ]) {
      assert.match(backOfficeDashboard, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    // The Aurora theme tokens were migrated from per-component --bo-* vars to
    // the shared design-token system. The CSS classes that the dashboard
    // relies on still exist; we keep checking those.
    for (const marker of ["bo-hero", "bo-progress-list", "bo-readiness-card", "bo-import-preview", "bo-page-title"]) {
      assert.match(adminStyles, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    assert.match(mobileSummary, /Setup track/);
  });
});
