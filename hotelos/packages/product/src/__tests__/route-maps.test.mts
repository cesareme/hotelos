// Route maps of the product package against the Tanda 5 navigation tree.
// Run from apps/api: cd apps/api && node --import tsx --test ../../packages/product/src/__tests__/*.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MODULE_ROUTE_MAP, getModuleRouteItems, type ModuleRouteMapItem } from "../navigation/module-route-map.js";
import { MANUAL_SETUP_COVERAGE_SUMMARY, MANUAL_SETUP_OPTIONS, RETIRED_MANUAL_SETUP_OPTIONS, getManualSetupOptionsByGroup } from "../navigation/manual-setup-route-map.js";
import { RESERVATION_COMMERCE_ROUTES } from "../navigation/reservation-commerce-route-map.js";
import { MOBILE_NAVIGATION, MOBILE_SUITE_TABS } from "../navigation/mobile-navigation.js";
import { HOTEL_MODULE_CODES } from "../modules/module-codes.js";

type NavTab = { screenKey: string; label: string; url: string; detail?: boolean };
type NavTree = {
  categories: Array<{ key: string; label: string; items: Array<NavTab & { tabs: NavTab[] }> }>;
  devOnly: Array<{ screenKey: string; label: string; url: string }>;
  publicScreens: Array<{ screenKey: string; url: string }>;
  legacyRoutes: Array<{ from: string; to: string }>;
  retired: Array<{ screenKey: string }>;
  aliases: Array<{ screenKey: string }>;
};

const tree = JSON.parse(
  readFileSync(new URL("../../../../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8")
) as NavTree;

const screenByUrl = new Map<string, { screenKey: string; label: string; devOnly: boolean; tab: boolean; detail: boolean }>();
for (const category of tree.categories) {
  for (const item of category.items) {
    screenByUrl.set(item.url, { screenKey: item.screenKey, label: item.label, devOnly: false, tab: false, detail: false });
    for (const tab of item.tabs) screenByUrl.set(tab.url, { screenKey: tab.screenKey, label: tab.label, devOnly: false, tab: true, detail: Boolean(tab.detail) });
  }
}
for (const screen of tree.devOnly) screenByUrl.set(screen.url, { screenKey: screen.screenKey, label: screen.label, devOnly: true, tab: false, detail: false });
const retired = new Set(tree.retired.map((entry) => entry.screenKey));
const aliases = new Set(tree.aliases.map((entry) => entry.screenKey));
const ENGLISH = /\b(and|with|for|the|of|management|settings|setup|center|manager|reports?)\b/i;

function adminItems(): Array<{ module: string; item: ModuleRouteMapItem }> {
  return Object.entries(MODULE_ROUTE_MAP).flatMap(([module, entry]) => (entry?.admin ?? []).map((item) => ({ module, item })));
}

describe("module-route-map · admin surface", () => {
  it("every admin entry names a Tanda 5 URL, its canonical screen and the tab it hangs from", () => {
    for (const { module, item } of adminItems()) {
      assert.ok(item.url, `${module}: «${item.label}» has no url`);
      const target = screenByUrl.get(item.url!);
      assert.ok(target, `${module}: url ${item.url} is not in nav-tree.generated.json`);
      assert.equal(item.screen, target!.screenKey, `${module}: «${item.label}» screen ≠ tree`);
      assert.ok(!retired.has(item.screen!) && !aliases.has(item.screen!), `${module}: ${item.screen} is retired or an alias`);
      assert.equal(Boolean(item.devOnly), target!.devOnly, `${module}: «${item.label}» devOnly flag ≠ tree`);
      if (item.devOnly) assert.equal(item.status, "coming_soon", `${module}: dev-only «${item.label}» must be coming_soon`);
      if (target!.tab && !target!.detail && !item.devOnly) {
        assert.equal(item.tab, target!.label, `${module}: «${item.label}» must declare tab «${target!.label}»`);
        assert.ok(item.parent, `${module}: tab «${item.label}» needs parent`);
      }
      if (!target!.tab) assert.equal(item.tab, undefined, `${module}: «${item.label}» is an item, not a tab`);
      assert.ok(!item.label.includes("/backoffice"));
    }
  });

  it("carries no legacy /backoffice path (L1c): the router redirects old paths through legacyRoutes", () => {
    for (const { module, item } of adminItems()) {
      assert.equal("path" in item, false, `${module}: «${item.label}» still carries a legacy path`);
      assert.doesNotMatch(item.url!, /^\/backoffice/, `${module}: «${item.label}» url is a legacy path`);
    }
    assert.ok(tree.legacyRoutes.length > 0, "the tree keeps the legacy redirects the router serves");
  });

  it("one entry per screen (no duplicates) and Spanish labels aligned with the tree", () => {
    for (const [module, entry] of Object.entries(MODULE_ROUTE_MAP)) {
      const screens = (entry?.admin ?? []).map((item) => item.screen);
      assert.equal(new Set(screens).size, screens.length, `${module}: duplicated admin screens`);
      for (const item of entry?.admin ?? []) {
        const target = screenByUrl.get(item.url!)!;
        assert.equal(item.label, target.label, `${module}: label «${item.label}» ≠ tree «${target.label}»`);
        assert.doesNotMatch(item.description ?? "", ENGLISH, `${module}: description of «${item.label}» looks English`);
      }
    }
  });

  it("every admin entry of the product modules resolves to a URL of the tree (consumers navigate by url)", () => {
    for (const module of ["pms_core", "revenue_profit_engine", "distribution_hub", "compliance_billing", "hotel_intelligence_platform"] as const) {
      for (const item of getModuleRouteItems(module, "admin")) {
        assert.ok(item.url && screenByUrl.has(item.url), `${module}: «${item.label}» has no tree URL`);
      }
    }
  });

  it("mobile labels are Spanish and keep their screen names", () => {
    for (const [module, entry] of Object.entries(MODULE_ROUTE_MAP)) {
      for (const item of entry?.mobile ?? []) {
        assert.ok(item.route, `${module}: mobile «${item.label}» has no route`);
        assert.doesNotMatch(item.label, ENGLISH, `${module}: mobile label «${item.label}» looks English`);
      }
    }
    assert.ok(getModuleRouteItems("backoffice", "mobile").some((item) => item.route === "ManualSetupPreview"));
  });
});

describe("manual-setup-route-map · Setup Center data", () => {
  it("points every option to a canonical screen and its Tanda 5 URL", () => {
    for (const option of MANUAL_SETUP_OPTIONS) {
      const target = screenByUrl.get(option.url);
      assert.ok(target, `${option.code}: url ${option.url} is not in the tree`);
      assert.equal(option.screen, target!.screenKey, `${option.code}: screen ≠ tree`);
      assert.ok(!target!.devOnly, `${option.code}: points to a dev-only placeholder`);
      assert.ok(!retired.has(option.screen) && !aliases.has(option.screen), `${option.code}: ${option.screen} retired or alias`);
      assert.equal("adminPath" in option, false, `${option.code}: legacy adminPath retired in L1c`);
      assert.notEqual(option.status, "coming_soon", `${option.code}: no «Próximamente» cards in the Setup Center`);
      assert.doesNotMatch(option.label, ENGLISH, `${option.code}: label looks English`);
      assert.doesNotMatch(option.description, ENGLISH, `${option.code}: description looks English`);
      for (const input of option.requiredInputs) assert.doesNotMatch(input, ENGLISH, `${option.code}: input «${input}»`);
      for (const method of option.inputMethods) assert.doesNotMatch(method.label, ENGLISH, `${option.code}: method «${method.label}»`);
      for (const check of option.completionChecks) assert.doesNotMatch(check.label, /\b(is|are|exists|before)\b/, `${option.code}: check «${check.label}»`);
      if (option.moduleCode && option.moduleCode !== "backoffice") assert.ok(HOTEL_MODULE_CODES.includes(option.moduleCode));
    }
  });

  it("retired options are gone and their codes are documented once", () => {
    const codes = new Set(MANUAL_SETUP_OPTIONS.map((option) => option.code));
    assert.equal(codes.size, MANUAL_SETUP_OPTIONS.length);
    for (const entry of RETIRED_MANUAL_SETUP_OPTIONS) {
      assert.ok(!codes.has(entry.code), `${entry.code} is retired but still listed`);
      if (entry.coveredBy) assert.ok(codes.has(entry.coveredBy), `${entry.code}: coveredBy ${entry.coveredBy} missing`);
    }
    for (const ghost of ["POSSettings", "AssetSettings", "ConciergeSettings", "CustomFieldManagerScreen", "AISetupCenter", "DeveloperPortal", "AnalyticsSettings"]) {
      assert.ok(!MANUAL_SETUP_OPTIONS.some((option) => option.screen === ghost), `${ghost} still referenced`);
    }
    assert.equal(MANUAL_SETUP_COVERAGE_SUMMARY.uncheckedOptions, 0);
    assert.equal(MANUAL_SETUP_COVERAGE_SUMMARY.totalOptions, MANUAL_SETUP_OPTIONS.length);
  });

  it("groups are the categories of the tree", () => {
    const groups = Object.keys(getManualSetupOptionsByGroup());
    const categoryLabels = new Set(tree.categories.map((category) => category.label));
    for (const group of groups) {
      assert.ok(categoryLabels.has(group) || ["Módulos e integraciones", "Canales de venta", "Inteligencia artificial", "Huéspedes", "Propiedad"].includes(group), `group «${group}» is not a tree category`);
    }
  });
});

describe("reservation-commerce-route-map", () => {
  it("every flow names its canonical screen and Tanda 5 URL (no legacy path)", () => {
    for (const route of RESERVATION_COMMERCE_ROUTES) {
      const target = screenByUrl.get(route.url);
      assert.ok(target, `${route.code}: url ${route.url} not in tree`);
      assert.equal(route.screen, target!.screenKey, `${route.code}: screen ≠ tree`);
      assert.equal("adminPath" in route, false, `${route.code}: legacy adminPath retired in L1c`);
      assert.doesNotMatch(route.label, ENGLISH, `${route.code}: label looks English`);
    }
  });
});

describe("mobile-navigation", () => {
  it("keeps the five suite tabs, Spanish labels and known module codes", () => {
    assert.deepEqual(MOBILE_SUITE_TABS, ["Hoy", "Timeline", "IA", "Operaciones", "Mas"]);
    for (const item of MOBILE_NAVIGATION) {
      assert.ok(MOBILE_SUITE_TABS.includes(item.tab));
      assert.ok(HOTEL_MODULE_CODES.includes(item.moduleCode), item.route);
      assert.doesNotMatch(item.label, ENGLISH, `mobile «${item.label}» looks English`);
    }
    const routes = MOBILE_NAVIGATION.map((item) => item.route);
    assert.equal(new Set(routes).size, routes.length, "duplicated mobile routes");
  });
});
