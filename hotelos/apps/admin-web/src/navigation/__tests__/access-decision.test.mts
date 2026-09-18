import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accessDecision, devUnlocked, opensEntry, tabAccessDecision, type AccessScope } from "../access-decision.ts";
import { NAV_TREE, gatingModuleCodes, menuCategories } from "../nav-tree.ts";
import { AUTHENTICATED_ROLE_TOKENS, ROLE_TOKENS, canSee, navVisibility, roleAllowsEveryone, type RoleToken } from "../role-tokens.ts";

// Tanda 8a · L4: ONE decision for the menu, the router and the containers.
// This file pins the table of cases and the equivalence with the Tanda 5
// helpers (`canSee`, `navVisibility`) for every item and tab of the tree × every token.

const ALL_MODULES = gatingModuleCodes();
const scope = (overrides: Partial<AccessScope> = {}): AccessScope => ({
  tokens: [],
  modules: ALL_MODULES,
  modulesKnown: true,
  isPlatformAdmin: false,
  devMode: false,
  canEnableModules: false,
  ...overrides
});

const gated = { roles: ["comercial", "direccion", "admin"], modulesAny: ["guest_data_crm_loyalty"] };
const core = { roles: ["recepcion", "direccion", "admin"], modulesAny: [] };
const dev = { roles: ["admin"], modulesAny: [], devOnly: true };
const everyone = { roles: [...AUTHENTICATED_ROLE_TOKENS], modulesAny: [] };

describe("accessDecision · table of cases", () => {
  it("role gate: a token of the session must be in roles; without token only entries open to every authenticated token", () => {
    assert.equal(accessDecision(core, scope({ tokens: ["recepcion"] })), "visible");
    assert.equal(accessDecision(core, scope({ tokens: ["pisos"] })), "hidden-role");
    assert.equal(accessDecision(core, scope({ tokens: ["pisos", "direccion"] })), "visible");
    assert.equal(accessDecision(core, scope({ tokens: [] })), "hidden-role");
    assert.equal(accessDecision(everyone, scope({ tokens: [] })), "visible");
    assert.equal(accessDecision({ roles: [] }, scope({ tokens: [] })), "visible");
    assert.equal(accessDecision({ roles: ["publico"] }, scope({ tokens: [] })), "visible");
  });

  it("module gate: visible with a code on, locked for who may enable modules, hidden-module otherwise (the list unknown hides too)", () => {
    assert.equal(accessDecision(gated, scope({ tokens: ["comercial"] })), "visible");
    assert.equal(accessDecision(gated, scope({ tokens: ["comercial"], modules: [] })), "hidden-module");
    assert.equal(accessDecision(gated, scope({ tokens: ["comercial"], modules: [], canEnableModules: true })), "locked");
    assert.equal(accessDecision(gated, scope({ tokens: ["comercial"], modules: [], modulesKnown: false })), "hidden-module");
    assert.equal(accessDecision(gated, scope({ tokens: ["recepcion"], modules: [], canEnableModules: true })), "hidden-role", "the role gate wins over the module gate");
    assert.equal(accessDecision(gated, scope({ tokens: ["admin"], modules: [] })), "hidden-module", "admin is not exempt from the module gate");
  });

  it("dev-only entries need dev mode AND the admin token (never a simulated hotel token)", () => {
    assert.equal(accessDecision(dev, scope({ tokens: ["admin"] })), "dev-locked");
    assert.equal(accessDecision(dev, scope({ tokens: ["admin"], devMode: true })), "visible");
    assert.equal(accessDecision(dev, scope({ tokens: ["direccion"], devMode: true, isPlatformAdmin: true })), "dev-locked", "«Ver como» drops the admin token: no dev group while simulating");
    assert.equal(accessDecision({ ...dev, modulesAny: ["revenue_profit_engine"] }, scope({ tokens: ["admin"], devMode: true, modules: [] })), "hidden-module");
    assert.ok(devUnlocked({ devMode: true, tokens: ["admin"] }));
    assert.ok(!devUnlocked({ devMode: true, tokens: ["sistemas"] }), "the organisation admin template (sistemas) is not the platform");
    assert.ok(!devUnlocked({ devMode: false, tokens: ["admin"] }));
  });

  it("a tab opens only when its item does: the stricter decision wins", () => {
    const item = { roles: ["direccion", "admin"], modulesAny: ["outlet_pos"] };
    const tab = { roles: ["direccion"], modulesAny: [] };
    assert.equal(tabAccessDecision(item, tab, scope({ tokens: ["direccion"] })), "visible");
    assert.equal(tabAccessDecision(item, tab, scope({ tokens: ["direccion"], modules: [] })), "hidden-module");
    assert.equal(tabAccessDecision(item, tab, scope({ tokens: ["direccion"], modules: [], canEnableModules: true })), "locked");
    assert.equal(tabAccessDecision(item, tab, scope({ tokens: ["admin"] })), "hidden-role", "the tab roles are narrower than the item's");
    assert.equal(tabAccessDecision(item, { ...tab, devOnly: true }, scope({ tokens: ["direccion"] })), "dev-locked");
  });

  it("opensEntry: visible and locked open a screen; the three hidden kinds do not", () => {
    assert.ok(opensEntry("visible"));
    assert.ok(opensEntry("locked"));
    assert.ok(!opensEntry("hidden-role"));
    assert.ok(!opensEntry("hidden-module"));
    assert.ok(!opensEntry("dev-locked"));
  });
});

describe("accessDecision · equivalence with canSee / navVisibility for every entry of the tree × every token", () => {
  const entries = NAV_TREE.categories.flatMap((category) => category.items.flatMap((item) => [item, ...item.tabs]));
  const tokens = ROLE_TOKENS.filter((token): token is Exclude<RoleToken, "publico"> => token !== "publico");
  const moduleSets: Array<{ label: string; modules: string[] }> = [
    { label: "every module on", modules: ALL_MODULES },
    { label: "no module on", modules: [] },
    { label: "Faranda", modules: ["pms_core", "compliance_hub", "distribution_hub", "guest_experience", "outlet_pos", "revenue_profit_engine"] }
  ];

  for (const { label, modules } of moduleSets) {
    it(`${label}: visible ⇔ canSee, and visible/locked/hidden-* ⇔ navVisibility, for ${entries.length} entries × ${tokens.length} tokens`, () => {
      let checked = 0;
      for (const entry of entries) {
        for (const token of tokens) {
          for (const canEnableModules of [false, true]) {
            const decision = accessDecision(entry, scope({ tokens: [token], modules, canEnableModules }));
            assert.equal(decision === "visible", canSee(entry, [token], modules), `${entry.screenKey} × ${token}: visible ⇔ canSee`);
            const visibility = navVisibility(entry, [token], modules, { canEnableModules });
            const mapped = decision === "hidden-role" || decision === "hidden-module" ? "hidden" : decision;
            assert.equal(mapped, visibility, `${entry.screenKey} × ${token} (canEnable ${canEnableModules}): navVisibility`);
            checked += 1;
          }
        }
      }
      assert.ok(checked >= entries.length * tokens.length * 2);
    });
  }

  it("without token the decision follows roleAllowsEveryone (the no-role branch of menuCategories): nothing since Tanda 8a", () => {
    for (const entry of entries) {
      assert.equal(accessDecision(entry, scope({ tokens: [] })) === "visible", roleAllowsEveryone(entry), entry.screenKey);
    }
    assert.deepEqual(menuCategories([], ALL_MODULES), [], "a custom role without template sees the no-role notice only");
  });

  it("menuCategories paints exactly the entries the decision opens, for every token", () => {
    for (const token of tokens) {
      const painted = new Set(menuCategories([token], ALL_MODULES).flatMap((category) => category.items.map((item) => item.screenKey)));
      const expected = new Set(NAV_TREE.categories.flatMap((category) => category.items.filter((item) => opensEntry(accessDecision(item, scope({ tokens: [token] })))).map((item) => item.screenKey)));
      assert.deepEqual([...painted].sort(), [...expected].sort(), token);
    }
  });
});
