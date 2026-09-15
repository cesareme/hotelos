// Unit tests of the product manifest against the Tanda 5 navigation tree.
// Run from apps/api (tsx is a devDependency there):
//   cd apps/api && node --import tsx --test ../../packages/product/src/__tests__/*.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ADVANCED_HOTEL_MODULES,
  CORE_HOTEL_MODULES,
  DEFAULT_ENABLED_MODULE_CODES,
  HOTEL_MODULES,
  MODULE_MENU_ENTRIES,
  getHotelModuleManifest,
  getModuleMenuEntries,
  isModuleEnabledByDefault,
  type HotelModuleMenuEntry
} from "../modules/module-manifest.js";
import { HOTEL_MODULE_CODES } from "../modules/module-codes.js";
import { CORE_ENABLED_MODULES, DEFAULT_ENABLED_MODULES, buildModuleSeedRows } from "../modules/module-seeds.js";

type NavTab = { screenKey: string; label: string; url: string; modulesAny: string[]; detail?: boolean };
type NavItem = NavTab & { tabs: NavTab[] };
type NavTree = {
  categories: Array<{ key: string; label: string; items: NavItem[] }>;
  devOnly: Array<{ screenKey: string; url: string }>;
  publicScreens: Array<{ screenKey: string; url: string }>;
  aliases: Array<{ screenKey: string }>;
  retired: Array<{ screenKey: string }>;
};

const tree = JSON.parse(
  readFileSync(new URL("../../../../apps/admin-web/src/navigation/nav-tree.generated.json", import.meta.url), "utf8")
) as NavTree;

/** Same derivation as scripts/build-nav-tree.mjs consumers (§6.2): gated items with their non-detail tabs, and gated tabs of core items. */
function expectedMenuEntries(): Record<string, HotelModuleMenuEntry[]> {
  const out: Record<string, HotelModuleMenuEntry[]> = {};
  for (const category of tree.categories) {
    for (const item of category.items) {
      const base = { categoryKey: category.key, category: category.label };
      for (const code of item.modulesAny) {
        (out[code] ??= []).push({ kind: "item", ...base, screenKey: item.screenKey, label: item.label, url: item.url });
        for (const tab of item.tabs) {
          if (tab.detail) continue;
          out[code].push({ kind: "tab", ...base, screenKey: tab.screenKey, label: tab.label, url: tab.url, parentLabel: item.label, parentUrl: item.url });
        }
      }
      if (item.modulesAny.length === 0) {
        for (const tab of item.tabs) {
          if (tab.detail) continue;
          for (const code of tab.modulesAny) {
            (out[code] ??= []).push({ kind: "tab", ...base, screenKey: tab.screenKey, label: tab.label, url: tab.url, parentLabel: item.label, parentUrl: item.url });
          }
        }
      }
    }
  }
  return out;
}

function canonicalScreenKeys(): Set<string> {
  const keys = new Set<string>();
  for (const category of tree.categories) {
    for (const item of category.items) {
      keys.add(item.screenKey);
      item.tabs.forEach((tab) => keys.add(tab.screenKey));
    }
  }
  tree.devOnly.forEach((screen) => keys.add(screen.screenKey));
  tree.publicScreens.forEach((screen) => keys.add(screen.screenKey));
  return keys;
}

describe("module manifest · Tanda 5", () => {
  it("covers every module code exactly once", () => {
    assert.deepEqual(HOTEL_MODULES.map((module) => module.code).sort(), [...HOTEL_MODULE_CODES].sort());
    assert.equal(new Set(HOTEL_MODULES.map((module) => module.code)).size, HOTEL_MODULES.length);
    assert.equal(CORE_HOTEL_MODULES.length + ADVANCED_HOTEL_MODULES.length, HOTEL_MODULES.length);
  });

  it("menuEntries match the navigation tree (§6.2) for every module", () => {
    const expected = expectedMenuEntries();
    for (const module of HOTEL_MODULES) {
      assert.deepEqual(module.menuEntries, expected[module.code] ?? [], `menuEntries of ${module.code} drifted from nav-tree.generated.json`);
      assert.deepEqual(getModuleMenuEntries(module.code), module.menuEntries);
    }
    assert.deepEqual(Object.keys(MODULE_MENU_ENTRIES).sort(), Object.keys(expected).sort());
  });

  it("names only canonical screen keys in adminRoutes (no aliases, retired or ghost screens)", () => {
    const canonical = canonicalScreenKeys();
    const aliases = new Set(tree.aliases.map((alias) => alias.screenKey));
    const retired = new Set(tree.retired.map((entry) => entry.screenKey));
    for (const module of HOTEL_MODULES) {
      for (const screen of module.adminRoutes ?? []) {
        assert.ok(!aliases.has(screen), `${module.code}.adminRoutes uses alias ${screen}`);
        assert.ok(!retired.has(screen), `${module.code}.adminRoutes uses retired ${screen}`);
        assert.ok(canonical.has(screen), `${module.code}.adminRoutes uses unknown screen ${screen}`);
      }
    }
  });

  it("shows Spanish names and descriptions to hoteliers", () => {
    const english = /\b(and|with|for|the|management|settings|engine|platform|register)\b/i;
    for (const module of HOTEL_MODULES) {
      assert.ok(module.name.length > 0 && module.name.length <= 40, `${module.code} name length`);
      assert.doesNotMatch(module.name, english, `${module.code} name looks English: ${module.name}`);
      assert.doesNotMatch(module.description, english, `${module.code} description looks English`);
    }
  });

  it("keeps isCore for pms_core only and applies the §14.1 default set (reversible)", () => {
    assert.deepEqual(HOTEL_MODULES.filter((module) => module.isCore).map((module) => module.code), ["pms_core"]);
    const expectedDefaults = [
      "pms_core",
      "housekeeping",
      "maintenance",
      "compliance_hub",
      "compliance_billing",
      "spain_guest_register_compliance",
      "erp_accounting",
      "guest_experience",
      "outlet_pos"
    ];
    assert.deepEqual([...DEFAULT_ENABLED_MODULE_CODES].sort(), [...expectedDefaults].sort());
    assert.deepEqual([...DEFAULT_ENABLED_MODULES].sort(), [...expectedDefaults].sort());
    assert.deepEqual(CORE_ENABLED_MODULES, DEFAULT_ENABLED_MODULES);
    for (const module of HOTEL_MODULES) {
      assert.equal(module.enabledByDefault, expectedDefaults.includes(module.code), module.code);
      assert.equal(isModuleEnabledByDefault(module.code), module.enabledByDefault);
    }
    // Known gap of the §14.1 proposal (openItems for César): two default-enabled
    // modules declare dependencies outside the default set. The default path
    // (ensurePropertyModulePersisted / provisioning) does not run the dependency
    // gate, so they start enabled anyway; enabling them by hand after a disable
    // would be rejected until the dependencies are enabled. Keep this list
    // explicit so any change of the set is deliberate.
    const knownUnmet: Record<string, string[]> = {
      outlet_pos: ["payment_vault"],
      guest_experience: ["ai_concierge"],
      spain_guest_register_compliance: ["checkin_online", "ai_front_desk"]
    };
    for (const code of DEFAULT_ENABLED_MODULE_CODES) {
      const missing = getHotelModuleManifest(code).dependencies.filter((dependency) => !DEFAULT_ENABLED_MODULE_CODES.includes(dependency));
      assert.deepEqual(missing, knownUnmet[code] ?? [], `${code} depends on modules outside the default set`);
    }
  });

  it("seed rows keep the historical shape", () => {
    const rows = buildModuleSeedRows();
    assert.equal(rows.length, HOTEL_MODULES.length);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["category", "code", "description", "isCore", "name"]);
  });
});
