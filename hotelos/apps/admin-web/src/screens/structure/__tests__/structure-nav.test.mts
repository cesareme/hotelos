import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NAV_TREE, findByScreen, urlForScreen } from "../../../navigation/nav-tree.ts";
import { buildItemTabs, itemForScreen, missingLoaders, type TabLoaders } from "../../tabs/nav-item-tabs.ts";
import { STRUCTURE_VIEW_SCREEN_KEYS } from "../structure-ui.ts";

// Navigation contract of Configuración › Estructura societaria (Tanda 6b · L6):
// the item and its four tabs in pilots/tanda5-nav-tree.csv → nav-tree.generated.json,
// the container that serves them and the model that names them. Source reads only.

const noop = () => Promise.reject(new Error("loader not meant to run in tests"));
const loadersFor = (...keys: string[]): TabLoaders => Object.fromEntries(keys.map((key) => [key, noop]));
const CONTAINER = new URL("../../tabs/configuracion/EstructuraSocietariaTabs.tsx", import.meta.url);

describe("estructura societaria · árbol de navegación", () => {
  it("es un ítem de Configuración tras Propiedad, con URL propia, pestaña base «Datos fiscales» y roles finanzas · direccion · admin", () => {
    const configuracion = NAV_TREE.categories.find((category) => category.key === "configuracion");
    assert.ok(configuracion);
    const keys = configuracion.items.map((item) => item.screenKey);
    assert.equal(keys.indexOf("StructureScreen"), keys.indexOf("PropertyProfileSetupForm") + 1);
    assert.ok(configuracion.items.length <= 12, `Configuración tiene ${configuracion.items.length} ítems (máximo 12)`);
    const { item, category } = itemForScreen("StructureScreen");
    assert.equal(category.label, "Configuración");
    assert.equal(item.label, "Estructura societaria");
    assert.equal(item.url, "/configuracion/estructura-societaria");
    assert.equal(item.baseTab, "Datos fiscales");
    assert.deepEqual(item.roles, ["finanzas", "direccion", "admin"]);
    assert.deepEqual(item.modulesAny, []);
  });

  it("lleva las cuatro pestañas del diseño §5.3 en orden, todas core y con los roles del ítem", () => {
    const { item } = itemForScreen("StructureScreen");
    assert.deepEqual(
      item.tabs.map((tab) => [tab.screenKey, tab.label, tab.url]),
      [
        ["StructurePropertiesTab", "Centros", "/configuracion/estructura-societaria/centros"],
        ["StructureSeriesTab", "Series y VeriFactu", "/configuracion/estructura-societaria/series-verifactu"],
        ["StructureVatTab", "IVA y ejercicio", "/configuracion/estructura-societaria/iva-ejercicio"],
        ["StructureAllocationTab", "Reparto", "/configuracion/estructura-societaria/reparto"]
      ]
    );
    for (const tab of item.tabs) {
      assert.deepEqual(tab.roles, item.roles, tab.screenKey);
      assert.equal(tab.detail, undefined, `${tab.screenKey} no es una sub-URL de detalle`);
    }
  });

  it("el contenedor cablea un loader por clave (base + 4 pestañas) y la pestaña base aterriza en la URL del ítem", () => {
    const { item } = itemForScreen("StructureScreen");
    const source = readFileSync(CONTAINER, "utf8");
    const expected = [item.screenKey, ...item.tabs.map((tab) => tab.screenKey)];
    for (const key of expected) {
      assert.match(source, new RegExp(`^\\s+${key}:\\s*\\(\\)\\s*=>\\s*import\\(`, "m"), `loader ${key} missing`);
    }
    assert.match(source, /screenKey="StructureScreen"/);
    assert.deepEqual(missingLoaders(item, loadersFor(...expected)), []);
    const tabs = buildItemTabs(item, loadersFor(...expected));
    assert.deepEqual(tabs.map((tab) => tab.key), ["estructura-societaria", "centros", "series-verifactu", "iva-ejercicio", "reparto"]);
    assert.equal(tabs[0]!.path, item.url);
  });

  it("el modelo nombra las cinco vistas con las claves del árbol y el eyebrow sale de la categoría", () => {
    for (const [view, key] of Object.entries(STRUCTURE_VIEW_SCREEN_KEYS)) {
      const match = findByScreen(key);
      assert.ok(match, `${view} → ${key} no está en el árbol`);
      assert.ok(match.kind === "item" || match.kind === "tab", `${key} debe ser ítem o pestaña`);
      assert.ok(urlForScreen(key)?.startsWith("/configuracion/estructura-societaria"), key);
    }
  });
});
