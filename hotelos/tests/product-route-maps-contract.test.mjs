import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Contract of the product package against the Tanda 5 navigation tree
// (lote product-manifest, L1a). The semantic checks (screen ↔ url ↔ legacy path,
// menuEntries ↔ tree) live in packages/product/src/__tests__/*.test.mts; this
// file guards the textual contract without importing TypeScript.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = read("packages/product/src/modules/module-manifest.ts");
const seeds = read("packages/product/src/modules/module-seeds.ts");
const routeMap = read("packages/product/src/navigation/module-route-map.ts");
const manualSetup = read("packages/product/src/navigation/manual-setup-route-map.ts");
const commerce = read("packages/product/src/navigation/reservation-commerce-route-map.ts");
const mobileNavigation = read("packages/product/src/navigation/mobile-navigation.ts");
const productService = read("apps/api/src/modules/product-modules/product-modules.service.ts");
const tree = JSON.parse(read("apps/admin-web/src/navigation/nav-tree.generated.json"));

const treeUrls = new Set();
const treeScreens = new Set();
for (const category of tree.categories) {
  for (const item of category.items) {
    treeUrls.add(item.url);
    treeScreens.add(item.screenKey);
    for (const tab of item.tabs) {
      treeUrls.add(tab.url);
      treeScreens.add(tab.screenKey);
    }
  }
}
for (const screen of tree.devOnly) {
  treeUrls.add(screen.url);
  treeScreens.add(screen.screenKey);
}
for (const screen of tree.publicScreens) {
  treeUrls.add(screen.url);
  treeScreens.add(screen.screenKey);
}
const retiredScreens = new Set(tree.retired.map((entry) => entry.screenKey));
const aliasScreens = new Set(tree.aliases.map((entry) => entry.screenKey));
const legacyFrom = new Set(tree.legacyRoutes.map((route) => route.from));

const all = (source, regex) => [...source.matchAll(regex)].map((match) => match[1]);

describe("product package · Tanda 5 navigation contract", () => {
  it("route maps only use URLs of the navigation tree (no /backoffice in url fields)", () => {
    for (const [name, source] of [["module-route-map", routeMap], ["manual-setup-route-map", manualSetup], ["reservation-commerce-route-map", commerce]]) {
      const urls = all(source, /\burl: "([^"]+)"/g);
      assert.ok(urls.length > 0, `${name}: no url fields`);
      for (const url of urls) {
        assert.doesNotMatch(url, /^\/backoffice/, `${name}: ${url}`);
        assert.ok(treeUrls.has(url), `${name}: ${url} is not a URL of nav-tree.generated.json`);
      }
    }
  });

  it("legacy paths kept for compatibility are registered /backoffice/* routes", () => {
    for (const [name, source, regex] of [
      ["module-route-map", routeMap, /\bpath: "([^"]+)"/g],
      ["manual-setup-route-map", manualSetup, /\badminPath: "([^"]+)"/g],
      ["reservation-commerce-route-map", commerce, /\badminPath: "([^"]+)"/g]
    ]) {
      for (const path of all(source, regex)) {
        assert.ok(legacyFrom.has(path), `${name}: ${path} is not a legacy route of the tree`);
      }
    }
  });

  it("screen keys are canonical (no retired screens, aliases or ghosts)", () => {
    const sources = [["module-route-map", routeMap], ["manual-setup-route-map", manualSetup], ["reservation-commerce-route-map", commerce]];
    for (const [name, source] of sources) {
      for (const screen of all(source, /\bscreen: "([A-Za-z0-9]+)"/g)) {
        assert.ok(treeScreens.has(screen), `${name}: ${screen} is not a screen of the tree`);
        assert.ok(!retiredScreens.has(screen), `${name}: ${screen} is retired`);
        assert.ok(!aliasScreens.has(screen), `${name}: ${screen} is an alias`);
      }
    }
    for (const ghost of ["AIEvals", "POSSettings", "AssetSettings", "ConciergeSettings", "CustomFieldManagerScreen", "AISetupCenter", "ManualSetupHubScreen", "ConfigurationCenterScreen"]) {
      assert.doesNotMatch(manifest + routeMap + manualSetup + commerce, new RegExp(`"${ghost}"`), `${ghost} still referenced`);
    }
  });

  it("the 13 configuration/forms/* screens and the retired hubs are not manual setup destinations", () => {
    for (const screen of all(manualSetup, /\bscreen: "([A-Za-z0-9]+)"/g)) {
      assert.doesNotMatch(screen, /^Configuration[A-Z]/, `manual setup still points to ${screen}`);
    }
    assert.match(manualSetup, /RETIRED_MANUAL_SETUP_OPTIONS/);
    for (const code of ["pos_outlets_products", "asset_capex_energy", "concierge_messaging_templates", "developer_platform", "analytics_owner_reporting", "ai_setup_wizard"]) {
      assert.doesNotMatch(manualSetup, new RegExp(`code: "${code}",\\s*\\n\\s*group:`), `${code} is still an option`);
      assert.match(manualSetup, new RegExp(`\\{ code: "${code}", coveredBy`), `${code} must be documented as retired`);
    }
    assert.doesNotMatch(manualSetup, /status: "coming_soon"/);
  });

  it("labels are Spanish (no English UI literals) in every navigation file", () => {
    const english = /\b(label|name): "(?:[^"]*\b(and|with|for|the|of|management|settings|setup|center|manager|reports?|register|shopper|forecast|grid|calendar|readiness)\b[^"]*)"/i;
    for (const [name, source] of [["module-route-map", routeMap], ["manual-setup-route-map", manualSetup], ["reservation-commerce-route-map", commerce], ["mobile-navigation", mobileNavigation], ["module-manifest", manifest]]) {
      const hit = source.match(english);
      assert.equal(hit, null, `${name}: English label ${hit?.[0]}`);
    }
    for (const label of ["Reservas", "Nueva reserva", "Parrilla de tarifas", "Canales de venta", "Correspondencias", "Facturación y cobros", "Centro de informes", "Puesta en marcha", "Módulos e integraciones"]) {
      assert.match(routeMap, new RegExp(`label: "${label}"`), label);
    }
  });

  it("manifest exposes enabledByDefault (§14.1, reversible) and menuEntries derived from the tree", () => {
    assert.match(manifest, /DEFAULT_ENABLED_MODULE_CODES/);
    assert.match(manifest, /DECISIÓN REVERSIBLE, PENDIENTE DE CÉSAR/);
    assert.match(manifest, /enabledByDefault: boolean/);
    assert.match(manifest, /menuEntries: HotelModuleMenuEntry\[\]/);
    assert.match(manifest, /export const MODULE_MENU_ENTRIES/);
    assert.match(seeds, /CORE_ENABLED_MODULES = DEFAULT_ENABLED_MODULES/);
    assert.match(seeds, /DECISIÓN REVERSIBLE/);
    for (const code of ["housekeeping", "maintenance", "compliance_hub", "compliance_billing", "spain_guest_register_compliance", "erp_accounting", "guest_experience", "outlet_pos"]) {
      assert.match(manifest, new RegExp(`"${code}"`));
    }
    // isCore stays pms_core-only: the eight modules remain disable-able.
    assert.equal(all(manifest, /isCore: (true|false)/g).filter((value) => value === "true").length, 1);
    // Every gating module of the tree has menu entries in the manifest.
    const gating = new Set();
    for (const category of tree.categories) {
      for (const item of category.items) {
        item.modulesAny.forEach((code) => gating.add(code));
        item.tabs.forEach((tab) => tab.modulesAny.forEach((code) => gating.add(code)));
      }
    }
    for (const code of gating) assert.match(manifest, new RegExp(`^  ${code}: \\[`, "m"), `MODULE_MENU_ENTRIES lacks ${code}`);
    // API: catalog carries the new fields and new rows default from the manifest.
    assert.match(productService, /defaultEnabled: module\.enabledByDefault/);
    assert.match(productService, /unlocks: module\.menuEntries/);
    assert.match(productService, /getHotelModuleManifest\(moduleCode\)\.enabledByDefault/);
  });
});
