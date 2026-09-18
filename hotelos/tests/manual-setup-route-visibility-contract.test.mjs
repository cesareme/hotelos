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
      // Tanda 5: labels are Spanish and aligned with pilots/tanda5-nav-tree.csv;
      // options whose destination was a placeholder, a scaffold or a retired hub
      // were removed (RETIRED_MANUAL_SETUP_OPTIONS documents them).
      "Propiedad",
      "Habitaciones y tipos",
      "Espacios y recursos",
      "Categorías",
      "Campos personalizados",
      "Módulos e integraciones",
      "Integraciones",
      "Usuarios y roles",
      "Parrilla de tarifas",
      "Histórico y previsión",
      "Planes de tarifas",
      "Explorador de previsión",
      "Calendario de demanda",
      "Competencia",
      "Reglas y recomendaciones",
      "Canales de venta",
      "Correspondencias",
      "Facturación y pagos",
      "Pagos",
      "Contabilidad y fiscal",
      "Fiscal",
      "Registro de viajeros",
      "SES.Hospedajes",
      "Autoridades",
      "Conservación",
      "Gobernanza de la IA",
      "Portal del huésped",
      "Ajustes de pisos y mantenimiento",
      "RETIRED_MANUAL_SETUP_OPTIONS"
    ]) {
      assert.match(routeMap, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("exposes manual setup through API permissions and backoffice service", () => {
    const service = read("apps/api/src/modules/backoffice/backoffice.service.ts");
    const server = read("apps/api/src/server.ts");
    const permissions = read("apps/api/src/security/route-permissions.ts");
    const setupStore = read("apps/api/src/modules/backoffice/setup.store.ts");
    const demoStore = read("apps/api/src/lib/demo-store.ts");
    assert.match(service, /listManualSetupOptions/);
    assert.match(service, /getManualSetupOptionDetail/);
    assert.match(service, /saveManualSetupOption/);
    assert.match(service, /MANUAL_SETUP_COVERAGE_SUMMARY/);
    // Tanda L2 (L2-04/L2-08): manual setup submissions persist in Prisma
    // (manual_setup_submissions via setup.store.ts); the in-memory
    // demoStore.manualSetupSubmissions leg was retired.
    assert.match(setupStore, /prisma\.manualSetupSubmission\.findMany\(/);
    assert.match(setupStore, /prisma\.manualSetupSubmission\.create\(/);
    assert.doesNotMatch(demoStore, /\n  manualSetupSubmissions: /);
    assert.match(server, /\/backoffice\/properties\/:propertyId\/manual-setup\/options/);
    assert.match(server, /\/backoffice\/properties\/:propertyId\/manual-setup\/:optionCode/);
    assert.match(permissions, /manual-setup\/options/);
    assert.match(permissions, /manual-setup\/:optionCode/);
    assert.match(permissions, /configuration\.read/);
    assert.match(permissions, /configuration\.manage/);
  });

  it("renders admin and mobile manual setup entry points", () => {
    // Tanda 5 · L1b: ManualSetupHubScreen retired into Configuración › Puesta en
    // marcha (SetupCenterScreen); its file is gone and /backoffice/manual-setup redirects.
    assert.equal(existsSync(new URL("../apps/admin-web/src/screens/manualSetup/ManualSetupHubScreen.tsx", import.meta.url)), false);
    const tree = JSON.parse(read("apps/admin-web/src/navigation/nav-tree.generated.json"));
    assert.ok(tree.retired.some((entry) => entry.screenKey === "ManualSetupHubScreen" && entry.url === "/configuracion/puesta-en-marcha"));
    assert.ok(tree.legacyRoutes.some((route) => route.from === "/backoffice/manual-setup" && route.to === "/configuracion/puesta-en-marcha"));
    assert.equal(existsSync(new URL("../apps/mobile/src/screens/backoffice/ManualSetupPreviewScreen.tsx", import.meta.url)), true);
    const adminRoutes = read("apps/admin-web/src/routes/backoffice.routes.tsx");
    // Tanda 5 · L1b: the sidebar renders nav-tree.generated.json (keys, URLs and legacy redirects live there).
    const adminSidebar = read("apps/admin-web/src/navigation/Sidebar.tsx") + read("apps/admin-web/src/navigation/nav-tree.generated.json");
    const adminApp = read("apps/admin-web/src/App.tsx");
    const mobileApp = read("apps/mobile/App.tsx");
    const mobileRoutes = read("apps/mobile/src/navigation/ModuleRoutes.tsx");
    const launcher = read("apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx");
    const mobileScreen = read("apps/mobile/src/screens/backoffice/ManualSetupPreviewScreen.tsx");
    // The Manual Setup Hub now wraps the unified Setup Center, so the form
    // markup (save action, save service call) lives in SetupCenterScreen.
    const setupCenterScreen = read("apps/admin-web/src/screens/backoffice/SetupCenterScreen.tsx");

    for (const marker of [
      // The Manual Setup Center has been folded into the unified Setup Center
      // (Puesta en marcha), the only configuration hub of Tanda 5.
      "Setup Center",
      "ManualSetupPreview",
      "option.inputMethods",
      "option.completionChecks",
      // Form actions are now localized: "Guardar" instead of an English
      // "Save setup data" label.
      "Guardar",
      "saveManualSetupOption"
    ]) {
      assert.match(adminRoutes + adminSidebar + adminApp + mobileApp + mobileRoutes + launcher + mobileScreen + setupCenterScreen, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
