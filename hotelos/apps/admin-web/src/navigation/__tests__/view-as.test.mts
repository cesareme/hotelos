import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyViewAs, getViewAs, setViewAs, tokenMinRank, viewAsTokensFor } from "../view-as.ts";
import { NAV_TREE, countMenu, flatMenuEntries, menuCategories } from "../nav-tree.ts";
import { ROLE_TOKENS } from "../role-tokens.ts";

// Every module code the tree references, so "all modules on" is exact (as in sidebar-menu.test.mts).
const ALL_MODULES = Array.from(
  new Set([
    ...NAV_TREE.categories.flatMap((category) => category.items.flatMap((item) => [...item.modulesAny, ...item.tabs.flatMap((tab) => tab.modulesAny)])),
    ...NAV_TREE.devOnly.flatMap((screen) => screen.modulesAny)
  ])
);

// Tanda 5 · L1c (code-review#11): «Ver como…» is one in-memory store applied
// by the gate, so the Sidebar, ⌘K and the containers share the simulation.

const ADMIN = { tokens: ["admin" as const], templateKey: "admin", isPlatformAdmin: true, canEnableModules: true, canViewAs: true, maxViewAsRank: null };

// ROLE_LEVEL_RANK over ROLE_TEMPLATE_LEVEL of packages/shared (design §4.1), as useEnabledModules.ts computes it.
const RANKS = {
  receptionist: 1, night_auditor: 1, front_office_manager: 2, housekeeper: 1, housekeeping_manager: 2, maintenance: 1, maintenance_manager: 2,
  fnb: 1, fnb_manager: 2, sales: 1, admin_clerk: 1, manager: 3, operations_director: 4, revenue: 4, accountant: 4, controller: 5,
  payroll_hr: 4, compliance: 4, asset_manager: 4, general_manager: 5, owner: 6, auditor: 4, admin: 4, break_glass: 5
};

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

  it("without a token, or for a user who may not simulate (no users.assign / roles.manage), the real gate is returned untouched", () => {
    const plain = applyViewAs(ADMIN, null);
    assert.deepEqual(plain.tokens, ["admin"]);
    assert.equal(plain.viewAs, null);
    assert.equal(plain.canEnableModules, true);
    const owner = applyViewAs({ tokens: ["propiedad"], templateKey: "owner", isPlatformAdmin: false, canEnableModules: true, canViewAs: false, maxViewAsRank: 6 }, "pisos");
    assert.deepEqual(owner.tokens, ["propiedad"]);
    assert.equal(owner.viewAs, null);
    assert.equal(owner.templateKey, "owner");
  });

  it("Tanda 8a: a hotel director with users.assign simulates too (canViewAs), keeping their own flags", () => {
    const director = applyViewAs({ tokens: ["direccion"], templateKey: "manager", isPlatformAdmin: false, canEnableModules: true, canViewAs: true, maxViewAsRank: 3 }, "recepcion");
    assert.deepEqual(director.tokens, ["recepcion"]);
    assert.deepEqual(director.realTokens, ["direccion"]);
    assert.equal(director.viewAs, "recepcion");
    assert.equal(director.isPlatformAdmin, false);
    assert.equal(director.canEnableModules, false);
    assert.equal(director.canViewAs, true);
    assert.equal(director.maxViewAsRank, 3);
  });

  it("⌘K built from the simulated gate offers the pisos catalogue (6 items: §3 + Pendientes de aprobación), not the administrator's 68", () => {
    const simulated = applyViewAs(ADMIN, "pisos");
    const palette = flatMenuEntries(menuCategories(simulated.tokens, ALL_MODULES, { devMode: true }), { includeTabs: true });
    assert.equal(countMenu(menuCategories(simulated.tokens, ALL_MODULES, { devMode: true })).items, 6);
    // Tanda 5: 64 · Tanda 6 (Contabilidad, Proveedores y gastos): 66 · Tanda 6b (Estructura societaria): 67 · Tanda 8a (Pendientes de aprobación): 68.
    assert.equal(countMenu(menuCategories(ADMIN.tokens, ALL_MODULES, { devMode: false })).items, 68);
    assert.ok(palette.every((entry) => entry.categoryKey !== "desarrollo"), "no «Desarrollo» while simulating a hotel role");
    assert.ok(palette.every((entry) => entry.categoryKey !== "finanzas" && entry.categoryKey !== "configuracion"));
  });
});

describe("view-as · tokens offered: rango ≤ propio (design §5.3)", () => {
  it("the platform administrator may simulate every hotel token (never admin nor público), broadest first", () => {
    const offered = viewAsTokensFor({ canViewAs: true, isPlatformAdmin: true, maxViewAsRank: null }, RANKS);
    assert.equal(offered.length, ROLE_TOKENS.length - 2);
    assert.ok(!offered.includes("admin") && !offered.includes("publico"));
    assert.equal(offered[0], "sistemas");
    assert.equal(offered[offered.length - 1], "pisos");
  });

  it("a user who may not simulate gets nothing; an unknown rank gets nothing", () => {
    assert.deepEqual(viewAsTokensFor({ canViewAs: false, isPlatformAdmin: false, maxViewAsRank: 6 }, RANKS), []);
    assert.deepEqual(viewAsTokensFor({ canViewAs: true, isPlatformAdmin: false, maxViewAsRank: null }, RANKS), []);
  });

  it("a hotel director (rank 3) simulates the operative and supervisor tokens and direccion itself, never propiedad or auditoria", () => {
    const offered = viewAsTokensFor({ canViewAs: true, isPlatformAdmin: false, maxViewAsRank: 3 }, RANKS);
    for (const token of ["recepcion", "pisos", "mantenimiento", "fnb", "comercial", "administracion", "direccion"]) assert.ok(offered.includes(token as never), token);
    for (const token of ["propiedad", "auditoria", "finanzas", "rrhh", "activos", "revenue", "sistemas", "admin", "publico"]) assert.ok(!offered.includes(token as never), token);
  });

  it("an operations director (rank 4) reaches the central tokens; the general manager (rank 5) everything but propiedad", () => {
    const ops = viewAsTokensFor({ canViewAs: true, isPlatformAdmin: false, maxViewAsRank: 4 }, RANKS);
    for (const token of ["finanzas", "rrhh", "activos", "revenue", "auditoria", "sistemas"]) assert.ok(ops.includes(token as never), token);
    assert.ok(!ops.includes("propiedad"));
    const gm = viewAsTokensFor({ canViewAs: true, isPlatformAdmin: false, maxViewAsRank: 5 }, RANKS);
    assert.ok(!gm.includes("propiedad"));
    assert.ok(viewAsTokensFor({ canViewAs: true, isPlatformAdmin: false, maxViewAsRank: 6 }, RANKS).includes("propiedad"));
  });

  it("tokenMinRank takes the cheapest template of a token and ignores break_glass", () => {
    assert.equal(tokenMinRank("direccion", RANKS), 3, "manager (3), not break_glass (5)");
    assert.equal(tokenMinRank("recepcion", RANKS), 1);
    assert.equal(tokenMinRank("finanzas", RANKS), 4);
    assert.equal(tokenMinRank("propiedad", RANKS), 6);
    assert.equal(tokenMinRank("admin", RANKS), Number.POSITIVE_INFINITY, "no template yields the platform token");
  });
});
