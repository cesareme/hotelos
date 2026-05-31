import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const sharedTypes = readFileSync(new URL("../packages/shared/src/types.ts", import.meta.url), "utf8");
const permissions = readFileSync(new URL("../packages/shared/src/permissions.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const routePermissions = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("../apps/api/src/modules/backoffice/backoffice.service.ts", import.meta.url), "utf8");
const seed = readFileSync(new URL("../packages/database/seeds/local-demo.seed.ts", import.meta.url), "utf8");
const demoStore = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
const routeMap = readFileSync(new URL("../packages/product/src/navigation/module-route-map.ts", import.meta.url), "utf8");
const mobileRoutes = readFileSync(new URL("../apps/mobile/src/navigation/ModuleRoutes.tsx", import.meta.url), "utf8");
const mobileApp = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
const mobileBackOffice = readFileSync(new URL("../apps/mobile/src/screens/settings/BackOfficePreviewScreen.tsx", import.meta.url), "utf8");
const adminApp = readFileSync(new URL("../apps/admin-web/src/App.tsx", import.meta.url), "utf8");
const adminRoutes = readFileSync(new URL("../apps/admin-web/src/routes/backoffice.routes.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../apps/admin-web/src/navigation/Sidebar.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../apps/admin-web/src/screens/BackOfficeDashboard.tsx", import.meta.url), "utf8");
const forms = readFileSync(new URL("../apps/admin-web/src/components/forms/FormComponents.tsx", import.meta.url), "utf8");
const apiClient = readFileSync(new URL("../apps/admin-web/src/services/backofficeApi.ts", import.meta.url), "utf8");
const categoryManager = readFileSync(new URL("../apps/admin-web/src/screens/backoffice/categories/CategoryManagerScreen.tsx", import.meta.url), "utf8");
const categoryDetail = readFileSync(new URL("../apps/admin-web/src/screens/backoffice/categories/CategoryDetailScreen.tsx", import.meta.url), "utf8");
const categoryOptionForm = readFileSync(new URL("../apps/admin-web/src/screens/backoffice/categories/CategoryOptionForm.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../apps/admin-web/src/styles.css", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/property-configuration-category-manager.md", import.meta.url), "utf8");

describe("Property Configuration & Category Manager", () => {
  it("persists category definitions, property options, translations and custom fields", () => {
    for (const model of [
      "model CategoryDefinition",
      "model PropertyCategoryOption",
      "model PropertyCategoryOptionTranslation",
      "model PropertyCustomFieldDefinition",
      "model PropertyCustomFieldValue"
    ]) {
      assert.match(schema, new RegExp(model));
    }

    for (const table of [
      "category_definitions",
      "property_category_options",
      "property_category_option_translations",
      "property_custom_field_definitions",
      "property_custom_field_values"
    ]) {
      assert.match(schema, new RegExp(table));
    }
  });

  it("adds configuration, category and custom field permissions to shared contracts and demo access", () => {
    for (const permission of [
      "configuration.read",
      "configuration.manage",
      "categories.read",
      "categories.manage",
      "categories.import",
      "categories.export",
      "custom_fields.read",
      "custom_fields.manage",
      "property_profile.edit",
      "room_types.manage",
      "rooms.manage",
      "spaces.manage",
      "departments.manage",
      "operations_setup.manage",
      "revenue_setup.manage",
      "compliance_setup.manage",
      "ai_category_setup.use"
    ]) {
      const escaped = permission.replace(".", "\\.");
      assert.match(sharedTypes, new RegExp(escaped));
      assert.match(permissions, new RegExp(escaped));
      assert.match(seed, new RegExp(escaped));
      assert.match(demoStore, new RegExp(escaped));
      assert.match(mobileRoutes, new RegExp(escaped));
    }
  });

  it("exposes the Back Office Configuration API with route permissions", () => {
    for (const route of [
      "/backoffice/properties/:propertyId/configuration",
      "/backoffice/properties/:propertyId/configuration/categories",
      "/backoffice/properties/:propertyId/configuration/categories/:categoryCode",
      "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options",
      "/backoffice/properties/:propertyId/configuration/category-options/:optionId",
      "/backoffice/properties/:propertyId/configuration/category-options/:optionId/deactivate",
      "/backoffice/properties/:propertyId/configuration/category-options/:optionId/reactivate",
      "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/reorder",
      "/backoffice/properties/:propertyId/configuration/custom-fields",
      "/backoffice/properties/:propertyId/configuration/custom-fields/:fieldId",
      "/backoffice/properties/:propertyId/configuration/custom-fields/:fieldId/deactivate",
      "/backoffice/properties/:propertyId/configuration/entity/:entityType/:entityId/custom-fields",
      "/backoffice/properties/:propertyId/configuration/categories/seed-defaults",
      "/backoffice/properties/:propertyId/configuration/categories/import",
      "/backoffice/properties/:propertyId/configuration/categories/export",
      "/backoffice/configuration/category-templates",
      "/backoffice/properties/:propertyId/configuration/category-templates/:templateCode/apply-preview",
      "/backoffice/properties/:propertyId/configuration/category-templates/:templateCode/apply",
      "/backoffice/properties/:propertyId/configuration/ai/suggest-categories"
    ]) {
      const escaped = route.replace(/[/:]/g, "\\$&");
      assert.match(server, new RegExp(escaped));
      assert.match(routePermissions, new RegExp(escaped));
    }
  });

  it("implements controlled category modes, safe option management, templates, import/export and AI preview", () => {
    for (const marker of [
      "system_controlled",
      "property_editable",
      "property_extendable",
      "read_only",
      "canDelete",
      "linkedRecordsUrl",
      "Options in use cannot be deleted",
      "CategoryOptionCreated",
      "CategoryOptionUpdated",
      "CategoryOptionDeactivated",
      "CategoryOptionReactivated",
      "CategoryOptionsReordered",
      "CategoryTemplatePreviewed",
      "CategoryTemplateApplied",
      "CategoryImportPreviewed",
      "CategoryImportApplied",
      "CustomFieldCreated",
      "CustomFieldUpdated",
      "CustomFieldDeactivated",
      "AIPropertyCategoriesSuggested",
      "AIPropertyCategoriesApplied",
      "suggestPropertyCategories",
      "previewCategoryImport",
      "applyCategoryTemplate"
    ]) {
      assert.match(service + seed + docs, new RegExp(marker));
    }

    for (const category of [
      "room_features",
      "bed_types",
      "space_types",
      "housekeeping_task_types",
      "maintenance_issue_types",
      "market_segments",
      "channel_categories",
      "revenue_report_fields",
      "payment_method_categories",
      "invoice_sequence_types",
      "document_types",
      "pos_product_categories",
      "asset_categories",
      "safety_incident_categories"
    ]) {
      assert.match(service + seed, new RegExp(category));
    }
  });

  it("renders admin Configuration Center, Category Manager, custom fields, forms and sidebar entry points", () => {
    for (const screen of [
      "ConfigurationCenterScreen",
      "CustomFieldManagerScreen",
      "CategoryManagerScreen",
      "CategoryDetailScreen",
      "CategoryOptionForm"
    ]) {
      assert.equal(
        existsSync(new URL(`../apps/admin-web/src/screens/backoffice/${screen}.tsx`, import.meta.url)) ||
          existsSync(new URL(`../apps/admin-web/src/screens/backoffice/categories/${screen}.tsx`, import.meta.url)),
        true
      );
      assert.match(adminApp + adminRoutes + sidebar, new RegExp(screen));
    }

    // The sidebar nav labels have been translated to Spanish. Each English
    // label below is matched against its Spanish equivalent (or a
    // representative entry where the section was reorganised). The intent —
    // that every Configuration Center area has a discoverable entry point —
    // is preserved.
    for (const label of [
      "Configuración",                  // Configuration
      "Perfil de la propiedad",          // Property profile
      "Mapeador de propiedad",           // Property mapper
      "Categorías",                      // Categories
      "Campos personalizados",           // Custom fields
      "Tipos de habitación",             // Rooms & room types
      "Espacios y recursos",             // Spaces & resources
      "Departamentos",                   // Departments
      "Configuración operativa",         // Operations setup
      "Configuración de revenue",        // Revenue setup
      "Configuración de finanzas",       // Finance setup
      "Configuración de cumplimiento|Configuración de finanzas y cumplimiento", // Compliance setup
      "Configuración de IA",             // AI setup
      "Inicio de configuración",         // Configuration Center entry point (was "Configuration Center")
      "ConfigurationCenterScreen"        // Open Configuration Center destination
    ]) {
      assert.match(sidebar + dashboard + adminRoutes, new RegExp(label.replace(/[.*+?^${}()[\]\\]/g, "\\$&")));
    }

    for (const formComponent of [
      "FormPage",
      "FormSection",
      "FormRow",
      "FormField",
      "FormSelect",
      "FormMultiSelect",
      "FormSwitch",
      "FormNumberInput",
      "FormMoneyInput",
      "FormDateInput",
      "FormTextarea",
      "FormColorPicker",
      "FormIconPicker",
      "FormRepeater",
      "FormPreviewPanel",
      "FormStickyActionBar",
      "FormValidationSummary"
    ]) {
      assert.match(forms, new RegExp(`export function ${formComponent}`));
    }
    assert.match(styles, /\.bo-form-field/);
  });

  it("wires Category Manager UI to category APIs and save endpoints", () => {
    for (const marker of [
      "fetchConfigurationCategories",
      "fetchConfigurationCategory",
      "createConfigurationCategoryOption",
      "configurationCategoryOptions",
      "Save category option",
      "Category option form",
      "source: {source}",
      "onSaved",
      "usageCount",
      "linked records"
    ]) {
      assert.match(apiClient + categoryManager + categoryDetail + categoryOptionForm, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("keeps the Category Manager visible from mobile and the local demo", () => {
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/backoffice/CategoryManagerPreviewScreen.tsx", import.meta.url)), true);
    for (const marker of [
      "CategoryManagerPreview",
      "Category Manager",
      "Configuration Center",
      "Custom Fields",
      "BackOfficePreview",
      "No code changes",
      "AI category assistant"
    ]) {
      assert.match(mobileApp + mobileBackOffice + routeMap + demoHtml, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
