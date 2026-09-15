import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_GROUPS_STORAGE_KEY, isGroupOpen, toggleGroup, togglesOnArrival } from "../nav-preferences.ts";
import { NAV_TREE, findByUrl, menuCategories } from "../nav-tree.ts";
import type { RoleToken } from "../role-tokens.ts";
import { createForbiddenRegistry } from "../modules-forbidden.ts";

// Tanda 5 · L1c (browser-roles#6): every category starts expanded, a collapse
// is remembered, and the group of the screen the user arrives at reopens.

describe("nav-preferences · group state", () => {
  it("every group is open by default; searching opens them all; an explicit toggle wins otherwise", () => {
    assert.ok(isGroupOpen({ key: "finanzas", toggled: {}, searching: false }));
    assert.ok(!isGroupOpen({ key: "finanzas", toggled: { finanzas: false }, searching: false }));
    assert.ok(isGroupOpen({ key: "finanzas", toggled: { finanzas: false }, searching: true }));
    assert.ok(isGroupOpen({ key: "finanzas", toggled: { finanzas: true }, searching: false }));
    assert.equal(NAV_GROUPS_STORAGE_KEY, "anfitorio.nav.groups");
  });

  it("clicking a head stores the opposite of what the user saw", () => {
    assert.deepEqual(toggleGroup({}, "hoy", true), { hoy: false });
    assert.deepEqual(toggleGroup({ hoy: false }, "hoy", false), { hoy: true });
  });

  it("arriving at a screen drops the collapse of its group and nothing else", () => {
    const toggled = { recepcion: false, finanzas: false };
    assert.deepEqual(togglesOnArrival(toggled, "recepcion"), { finanzas: false });
    assert.equal(togglesOnArrival(toggled, "hoy"), toggled, "same object when nothing changes");
    assert.equal(togglesOnArrival(toggled, null), toggled);
  });
});

// pilots/tanda5-nav-tree.md §11: the frequent tasks measured at 3 clicks in the
// browser round (all categories collapsed) must be ≤ 2 with the default state.
const ALL_MODULES = Array.from(
  new Set(NAV_TREE.categories.flatMap((category) => category.items.flatMap((item) => [...item.modulesAny, ...item.tabs.flatMap((tab) => tab.modulesAny)])))
);

// `action`: the last click happens inside the screen (a button the menu does not list).
const FREQUENT_TASKS: { task: string; role: RoleToken; url: string; action?: string; clicks: number }[] = [
  { task: "#6 Dictar una reserva", role: "recepcion", url: "/recepcion/reservas/nueva/dictar", clicks: 2 },
  { task: "#8 Tablero de habitaciones", role: "recepcion", url: "/recepcion/reservas/tablero", clicks: 2 },
  { task: "#10 Emitir una factura", role: "recepcion", url: "/finanzas/facturacion", action: "Crear borrador", clicks: 2 },
  { task: "#19 Importar rooming list", role: "recepcion", url: "/recepcion/grupos", action: "Importar", clicks: 2 },
  { task: "#14 Pisos › Mi turno", role: "pisos", url: "/operaciones/pisos/mi-turno", clicks: 2 },
  { task: "#15 Mantenimiento › Mis averías", role: "mantenimiento", url: "/operaciones/mantenimiento/mis-averias", clicks: 2 },
  { task: "#12 Bandeja de cumplimiento", role: "recepcion", url: "/cumplimiento/bandeja", clicks: 1 },
  { task: "#20 Punto de venta", role: "fnb", url: "/operaciones/tpv", clicks: 1 }
];

describe("§11 · frequent tasks stay at ≤ 2 clicks with the default group state", () => {
  for (const { task, role, url, action, clicks } of FREQUENT_TASKS) {
    it(`${task} (${role}) → ${url}${action ? ` › ${action}` : ""} in ${clicks} click(s)`, () => {
      const match = findByUrl(url);
      assert.ok(match && match.kind !== "dev-only" && match.kind !== "public", `${url} is not an item/tab of the tree`);
      const categories = menuCategories([role], ALL_MODULES);
      const category = categories.find((entry) => entry.key === match.category.key);
      assert.ok(category, `${role} does not see the category ${match.category.key}`);
      assert.ok(isGroupOpen({ key: category.key, toggled: {}, searching: false }), `${category.key} is collapsed by default`);
      const item = category.items.find((entry) => entry.screenKey === match.item.screenKey);
      assert.ok(item && item.visibility === "visible", `${role} does not see ${match.item.screenKey}`);
      let menuClicks = 1;
      if (match.kind === "tab") {
        assert.ok(item.tabs.some((tab) => tab.url === url), `${role} does not see the tab ${url}`);
        menuClicks = 2;
      }
      assert.equal(menuClicks + (action ? 1 : 0), clicks);
      assert.ok(clicks <= 2);
    });
  }
});

describe("modules-forbidden · one 403 per property and session", () => {
  it("remembers, forgets one, forgets all", () => {
    const registry = createForbiddenRegistry();
    assert.ok(!registry.has("p1"));
    registry.add("p1");
    registry.add("p2");
    assert.ok(registry.has("p1"));
    assert.equal(registry.size(), 2);
    registry.forget("p1");
    assert.ok(!registry.has("p1") && registry.has("p2"));
    registry.forget();
    assert.equal(registry.size(), 0);
  });
});
