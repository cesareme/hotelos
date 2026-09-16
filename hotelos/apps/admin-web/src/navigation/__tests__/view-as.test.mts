import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyViewAs, getViewAs, setViewAs } from "../view-as.ts";
import { NAV_TREE, countMenu, flatMenuEntries, menuCategories } from "../nav-tree.ts";

// Every module code the tree references, so "all modules on" is exact (as in sidebar-menu.test.mts).
const ALL_MODULES = Array.from(
  new Set([
    ...NAV_TREE.categories.flatMap((category) => category.items.flatMap((item) => [...item.modulesAny, ...item.tabs.flatMap((tab) => tab.modulesAny)])),
    ...NAV_TREE.devOnly.flatMap((screen) => screen.modulesAny)
  ])
);

// Tanda 5 · L1c (code-review#11): «Ver como…» is one in-memory store applied
// by the gate, so the Sidebar, ⌘K and the containers share the simulation.

const ADMIN = { tokens: ["admin" as const], templateKey: "admin", isPlatformAdmin: true, canEnableModules: true };

describe("view-as · store", () => {
  it("starts empty, accepts a role token, ends with an empty string or an unknown value", () => {
    assert.equal(getViewAs(), null);
    setViewAs("pisos");
    assert.equal(getViewAs(), "pisos");
    setViewAs("");
    assert.equal(getViewAs(), null);
    setViewAs("recepcion");
    setViewAs("not-a-token" as never);
    assert.equal(getViewAs(), null);
  });
});

describe("view-as · applyViewAs (the gate every consumer reads)", () => {
  it("only the platform administrator can simulate; the simulation replaces the tokens, drops the template and «Activar módulo»", () => {
    const simulated = applyViewAs(ADMIN, "pisos");
    assert.deepEqual(simulated.tokens, ["pisos"]);
    assert.deepEqual(simulated.realTokens, ["admin"]);
    assert.equal(simulated.viewAs, "pisos");
    assert.equal(simulated.templateKey, null);
    assert.equal(simulated.canEnableModules, false);
    assert.equal(simulated.isPlatformAdmin, true);
  });

  it("without a token, or for a user who is not the platform administrator, the real gate is returned untouched", () => {
    const plain = applyViewAs(ADMIN, null);
    assert.deepEqual(plain.tokens, ["admin"]);
    assert.equal(plain.viewAs, null);
    assert.equal(plain.canEnableModules, true);
    const owner = applyViewAs({ tokens: ["direccion"], templateKey: "owner", isPlatformAdmin: false, canEnableModules: true }, "pisos");
    assert.deepEqual(owner.tokens, ["direccion"]);
    assert.equal(owner.viewAs, null);
    assert.equal(owner.templateKey, "owner");
  });

  it("⌘K built from the simulated gate offers the pisos catalogue (5 items, §3), not the administrator's 66", () => {
    const simulated = applyViewAs(ADMIN, "pisos");
    const palette = flatMenuEntries(menuCategories(simulated.tokens, ALL_MODULES, { devMode: true }), { includeTabs: true });
    assert.equal(countMenu(menuCategories(simulated.tokens, ALL_MODULES, { devMode: true })).items, 5);
    // Tanda 5: 64 · Tanda 6 (Contabilidad, Proveedores y gastos): 66.
    assert.equal(countMenu(menuCategories(ADMIN.tokens, ALL_MODULES, { devMode: false })).items, 66);
    assert.ok(palette.every((entry) => entry.categoryKey !== "desarrollo"), "no «Desarrollo» while simulating a hotel role");
    assert.ok(palette.every((entry) => entry.categoryKey !== "finanzas" && entry.categoryKey !== "configuracion"));
  });
});
