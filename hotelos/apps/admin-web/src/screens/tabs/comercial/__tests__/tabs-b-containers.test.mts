// Lote tabs-b (Comercial · Revenue · Finanzas · Informes): the twelve containers
// against nav-tree.generated.json through the shared helpers of screens/tabs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { NAV_CATEGORIES, gatingModuleCodes } from "../../../../navigation/nav-tree.ts";
import { baseKeyFor, buildItemTabs, itemForScreen, landingKeysFor, missingLoaders, type TabLoaders } from "../../nav-item-tabs.ts";

const LOT_CATEGORIES = ["comercial", "revenue", "finanzas", "informes"];

// Item screen key → container source file (relative to screens/tabs).
const CONTAINERS: Record<string, string> = {
  CrmDashboard: "comercial/ClientesTabs.tsx",
  ReputationDashboard: "comercial/ReputacionTabs.tsx",
  UpsellsDashboard: "comercial/VentasAdicionalesTabs.tsx",
  ChannelAggregatorHub: "comercial/CanalesTabs.tsx",
  RateGridEditorScreen: "revenue/ParrillaTabs.tsx",
  RevenueHistoryForecastDashboard: "revenue/HistoricoPrevisionTabs.tsx",
  BillingCenter: "finanzas/FacturacionTabs.tsx",
  FinancePositionDashboard: "finanzas/TesoreriaTabs.tsx",
  BankReconciliationScreen: "finanzas/ConciliacionTabs.tsx",
  TrialBalanceScreen: "finanzas/EstadosContablesTabs.tsx",
  ReportingCenter: "informes/CentroInformesTabs.tsx",
  PortfolioDashboard: "informes/CarteraTabs.tsx"
};

const noop = () => Promise.reject(new Error("loader not meant to run in tests"));
const loadersFor = (...keys: string[]): TabLoaders => Object.fromEntries(keys.map((key) => [key, noop]));
const ALL_MODULES = gatingModuleCodes();
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

function expectedKeys(screenKey: string): string[] {
  const { item } = itemForScreen(screenKey);
  return [item.screenKey, ...item.tabs.map((tab) => tab.screenKey)];
}

describe("tabs-b · coverage", () => {
  it("has a container for every item with tabs of Comercial, Revenue, Finanzas and Informes, and nothing else", () => {
    const itemsWithTabs = NAV_CATEGORIES.filter((category) => LOT_CATEGORIES.includes(category.key)).flatMap((category) =>
      category.items.filter((item) => item.tabs.length > 0).map((item) => item.screenKey)
    );
    assert.deepEqual(Object.keys(CONTAINERS).sort(), itemsWithTabs.sort());
  });

  it("every base screen of the lot is a named tab of the tree (the base screen is the item's main content)", () => {
    for (const screenKey of Object.keys(CONTAINERS)) {
      const { item } = itemForScreen(screenKey);
      assert.equal(typeof item.baseTab, "string", `${screenKey}: baseTab must be named in the CSV`);
      assert.ok(item.baseTab!.length <= 28);
    }
    assert.equal(itemForScreen("CrmDashboard").item.baseTab, "Clientes");
    assert.equal(itemForScreen("ReputationDashboard").item.baseTab, "Reseñas");
    assert.equal(itemForScreen("TrialBalanceScreen").item.baseTab, "Balance de comprobación");
  });

  it("the lot folders hold exactly the twelve containers", () => {
    const files = ["comercial", "revenue", "finanzas", "informes"].flatMap((folder) =>
      readdirSync(new URL(`../../${folder}`, import.meta.url))
        .filter((entry) => entry.endsWith(".tsx"))
        .map((entry) => `${folder}/${entry}`)
    );
    assert.deepEqual(files.sort(), Object.values(CONTAINERS).sort());
  });
});

describe("tabs-b · containers", () => {
  for (const [screenKey, file] of Object.entries(CONTAINERS)) {
    it(`${file}: wires the base screen and every tab of the tree, targets ${screenKey}, is exported`, () => {
      const source = read(file);
      for (const key of expectedKeys(screenKey)) {
        assert.match(source, new RegExp(`^\\s+${key}:\\s*\\(\\)\\s*=>\\s*import\\(`, "m"), `${file}: loader ${key} missing`);
      }
      const loaderKeys = [...source.matchAll(/^\s{2}([A-Za-z0-9]+):\s*\(\)\s*=>\s*import\(/gm)].map((match) => match[1]);
      assert.deepEqual(loaderKeys, expectedKeys(screenKey), `${file}: loaders in tree order, none extra`);
      assert.match(source, new RegExp(`<NavItemTabs screenKey="${screenKey}" loaders=\\{LOADERS\\} subtitle="[^"]+" />`));
      // check-sidebar-coverage flags `export default function X`; containers export the identifier.
      assert.match(source, /^export default [A-Z][A-Za-z]+Tabs;$/m);
      assert.doesNotMatch(source, /export (default )?function [A-Z]|export const [A-Z]/);
      const name = file.split("/").pop()!.replace(/\.tsx$/, "");
      assert.match(read("index.ts"), new RegExp(`export \\{ default as ${name} \\} from "\\./${file.replace(/\.tsx$/, "")}";`));
      assert.deepEqual(missingLoaders(itemForScreen(screenKey).item, loadersFor(...expectedKeys(screenKey))), []);
    });
  }

  it("paints the base tab first at the item URL, then the tree's tabs; detail sub-URLs stay hidden until the URL names them", () => {
    for (const screenKey of Object.keys(CONTAINERS)) {
      const { item } = itemForScreen(screenKey);
      const tabs = buildItemTabs(item, loadersFor(...expectedKeys(screenKey)), { pathname: item.url });
      assert.equal(tabs.length, 1 + item.tabs.length, screenKey);
      assert.equal(tabs[0].key, baseKeyFor(item));
      assert.equal(tabs[0].path, item.url);
      assert.equal(tabs[0].label, item.baseTab);
      assert.deepEqual(tabs[0].roles, item.roles);
      item.tabs.forEach((tab, index) => {
        const painted = tabs[index + 1];
        assert.equal(painted.path, tab.url, `${screenKey}: ${tab.screenKey} keeps the CSV URL`);
        assert.equal(painted.label, tab.label);
        assert.equal(painted.hidden ?? false, tab.detail === true, `${screenKey}: ${tab.screenKey}`);
        assert.match(painted.key, /^[a-z0-9-]+$/);
      });
    }
  });

  it("Facturación: the Folio sub-URL is painted with its concrete path while a folio is open", () => {
    const { item } = itemForScreen("BillingCenter");
    const loaders = loadersFor(...expectedKeys("BillingCenter"));
    const onBase = buildItemTabs(item, loaders, { pathname: "/finanzas/facturacion" });
    assert.deepEqual(onBase.map((tab) => [tab.key, tab.hidden ?? false]), [["facturacion", false], ["folio", true], ["rectificativas", false], ["enrutamiento", false]]);
    const onFolio = buildItemTabs(item, loaders, { pathname: "/finanzas/facturacion/folios/fol_42" });
    const folio = onFolio.find((tab) => tab.key === "folio");
    assert.deepEqual([folio?.path, folio?.hidden], ["/finanzas/facturacion/folios/fol_42", false]);
    assert.equal(onFolio.find((tab) => tab.key === "rectificativas")?.hidden, undefined);
  });

  it("Cartera: the property detail is painted with its concrete path while a property is open", () => {
    const { item } = itemForScreen("PortfolioDashboard");
    const loaders = loadersFor(...expectedKeys("PortfolioDashboard"));
    assert.deepEqual(buildItemTabs(item, loaders, { pathname: "/informes/cartera" }).map((tab) => [tab.key, tab.hidden ?? false]), [["cartera", false], ["detalle", true]]);
    const detalle = buildItemTabs(item, loaders, { pathname: "/informes/cartera/prop_9" }).find((tab) => tab.key === "detalle");
    assert.deepEqual([detalle?.path, detalle?.hidden], ["/informes/cartera/prop_9", false]);
  });
});

describe("tabs-b · landing", () => {
  it("every container lands on its base screen for each role that sees the item, and with no token", () => {
    for (const screenKey of Object.keys(CONTAINERS)) {
      const { item } = itemForScreen(screenKey);
      const tabs = buildItemTabs(item, loadersFor(...expectedKeys(screenKey)), { pathname: item.url });
      const base = baseKeyFor(item);
      for (const role of [...item.roles, null]) {
        const tokens = role === null ? [] : [role as never];
        const landing = landingKeysFor(item, tabs, tokens, ALL_MODULES, role === "direccion" ? { templateKey: "owner" } : {});
        assert.equal(landing.defaultTab, base, `${screenKey} · ${role ?? "sin token"}`);
        assert.equal(landing.mobileDefaultTab, base, `${screenKey} · ${role ?? "sin token"} · móvil`);
      }
    }
  });
});
