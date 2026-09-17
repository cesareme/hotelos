import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildItemTabs, isTabVisible, itemForScreen, landingKeysFor, missingLoaders, type TabLoaders } from "../../nav-item-tabs.ts";

// Containers of lote tabs-c · Cumplimiento: item screen key → container source file.
const CONTAINERS: Record<string, string> = {
  FiscalDashboard: "VerifactuTabs.tsx",
  Modelo303Screen: "ModelosAeatTabs.tsx",
  PropertyTaxesScreen: "ImpuestosTabs.tsx",
  GuestRegisterSettings: "RegistroViajerosTabs.tsx",
  SustainabilityDashboard: "SostenibilidadTabs.tsx"
};

// Screens merged here that left the L1c bridge in Cocoa 22 · ola 11: every one is a
// `<CocoaPage>` on the host context (no `embedded` prop, no `pageHead(embedded)` head) and
// registers its ⌘K commands through the page. The Modelo*Screen left it in lote 8-B.
const HOST_CONTEXT_SCREENS = [
  "fiscal/FiscalDashboard.tsx",
  "compliance/PropertyTaxesScreen.tsx",
  "compliance/AuthorityRoutingSettingsScreen.tsx",
  "compliance/GuestRegisterRetentionSettingsScreen.tsx",
  "operations/SustainabilityDashboard.tsx"
];

const noop = () => Promise.reject(new Error("loader not meant to run in tests"));
const loadersFor = (item: { screenKey: string; tabs: readonly { screenKey: string }[] }): TabLoaders =>
  Object.fromEntries([item.screenKey, ...item.tabs.map((tab) => tab.screenKey)].map((key) => [key, noop]));
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("tabs-c · Cumplimiento · containers wire every screen of the tree", () => {
  for (const [screenKey, file] of Object.entries(CONTAINERS)) {
    it(`${file} targets ${screenKey} and loads the base screen and every tab`, () => {
      const source = read(`../${file}`);
      const { item } = itemForScreen(screenKey);
      assert.ok(item.baseTab, `${screenKey} must name its base tab in the CSV (tab column) so the base screen stays reachable`);
      assert.match(source, new RegExp(`screenKey="${screenKey}"`));
      for (const key of [item.screenKey, ...item.tabs.map((tab) => tab.screenKey)]) {
        assert.match(source, new RegExp(`^\\s+${key}:\\s*\\(\\)\\s*=>\\s*import\\(`, "m"), `${file}: loader ${key} missing`);
      }
      // ONE convention (L1c, bridge retired in ola 11): every loader is direct (`{ default: m.X }`;
      // the screen reads useTabHost(), directly or through CocoaPage). No `embed()` wrapper left.
      const loaderCount = (source.match(/=>\s*import\(/g) ?? []).length;
      const direct = [...source.matchAll(/\(\{ default: m\.([A-Za-z0-9_]+) \}\)/g)].map((m) => m[1]);
      assert.equal(direct.length, loaderCount, `${file}: every loader is direct`);
      assert.doesNotMatch(source, /embed\(m\./, `${file}: the embed() bridge is gone`);
      assert.deepEqual(missingLoaders(item, loadersFor(item)), []);
    });
  }
});

describe("tabs-c · Cumplimiento · tabs from the tree", () => {
  it("Modelos AEAT: base «Modelo 303» then 390 · 347 · 111 · 115 · 180 · Libros de IVA · Liquidación de IVA (Tanda 6)", () => {
    const { item } = itemForScreen("Modelo303Screen");
    const tabs = buildItemTabs(item, loadersFor(item));
    assert.deepEqual(tabs.map((tab) => tab.key), ["modelos-aeat", "390", "347", "111", "115", "180", "libros-iva", "liquidacion-iva"]);
    assert.deepEqual(tabs.map((tab) => tab.label), ["Modelo 303", "Modelo 390", "Modelo 347", "Modelo 111", "Modelo 115", "Modelo 180", "Libros de IVA", "Liquidación de IVA"]);
    assert.equal(tabs[0].path, "/cumplimiento/modelos-aeat");
    assert.ok(tabs.every((tab) => !tab.hidden));
  });

  it("VeriFactu, Impuestos and Sostenibilidad keep their base screen as the first tab", () => {
    const verifactu = buildItemTabs(itemForScreen("FiscalDashboard").item, loadersFor(itemForScreen("FiscalDashboard").item));
    assert.deepEqual(verifactu.map((tab) => [tab.key, tab.label]), [["verifactu", "VeriFactu"], ["ticketbai", "TicketBAI (forales)"]]);
    const impuestos = buildItemTabs(itemForScreen("PropertyTaxesScreen").item, loadersFor(itemForScreen("PropertyTaxesScreen").item));
    assert.deepEqual(impuestos.map((tab) => [tab.key, tab.label]), [["impuestos", "IVA, IGIC e IPSI"], ["tasa-turistica", "Tasa turística"]]);
    const sostenibilidad = buildItemTabs(itemForScreen("SustainabilityDashboard").item, loadersFor(itemForScreen("SustainabilityDashboard").item));
    assert.deepEqual(sostenibilidad.map((tab) => [tab.key, tab.label]), [["sostenibilidad", "Panel"], ["esrs", "Informe ESRS"]]);
  });

  it("Registro de viajeros: recepción sees Partes de entrada and SES.Hospedajes, not Autoridades nor Conservación", () => {
    const { item } = itemForScreen("GuestRegisterSettings");
    const tabs = buildItemTabs(item, loadersFor(item));
    assert.deepEqual(tabs.map((tab) => tab.key), ["registro-viajeros", "ses-hospedajes", "autoridades", "conservacion"]);
    const recepcion = tabs.filter((tab) => isTabVisible(tab, ["recepcion"], [])).map((tab) => tab.key);
    assert.deepEqual(recepcion, ["registro-viajeros", "ses-hospedajes"]);
    const finanzas = tabs.filter((tab) => isTabVisible(tab, ["finanzas"], [])).map((tab) => tab.key);
    assert.deepEqual(finanzas, ["registro-viajeros", "ses-hospedajes", "autoridades", "conservacion"]);
  });

  it("Sostenibilidad: mantenimiento sees the panel but not the ESRS report", () => {
    const { item } = itemForScreen("SustainabilityDashboard");
    const tabs = buildItemTabs(item, loadersFor(item));
    assert.deepEqual(tabs.filter((tab) => isTabVisible(tab, ["mantenimiento"], [])).map((tab) => tab.key), ["sostenibilidad"]);
    assert.deepEqual(tabs.filter((tab) => isTabVisible(tab, ["direccion"], [])).map((tab) => tab.key), ["sostenibilidad", "esrs"]);
  });

  it("every role lands on the base tab (the base screen is the content, not a landing)", () => {
    for (const screenKey of Object.keys(CONTAINERS)) {
      const { item } = itemForScreen(screenKey);
      const tabs = buildItemTabs(item, loadersFor(item));
      for (const token of ["finanzas", "direccion", "recepcion", "admin"] as const) {
        assert.equal(landingKeysFor(item, tabs, [token], []).defaultTab, tabs[0].key, `${screenKey} · ${token}`);
      }
    }
  });
});

describe("tabs-c · Cumplimiento · registration and hosted screens", () => {
  it("the tabs index exports every container and App.tsx registers it (L1b: no whitelist entry)", () => {
    const index = read("../../index.ts");
    const whitelist = JSON.parse(readFileSync(new URL("../../../../../.discoverability-whitelist.json", import.meta.url), "utf8")) as { screens: string[] };
    const app = read("../../../../App.tsx");
    for (const file of Object.values(CONTAINERS)) {
      const name = file.replace(/\.tsx$/, "");
      assert.match(index, new RegExp(`export \\{ default as ${name} \\} from "\\./cumplimiento/${name}";`), `${name} not exported`);
      // L1b (router-app): the container is a SCREEN_COMPONENTS value, so the coverage gate
      // sees it through the tree and the temporary whitelist entry of L1a is gone.
      assert.match(app, new RegExp(`lazyTab\\("${name}"\\)`), `${name} not registered in App.tsx`);
      assert.ok(!whitelist.screens.includes(name), `${name} must leave the whitelist once App.tsx registers it`);
    }
  });

  it("the eight Modelos AEAT screens read the host context (useTabHost) and take no `embedded` prop (Cocoa 22 · lote 8-B)", () => {
    for (const name of ["Modelo303Screen", "Modelo390Screen", "Modelo347Screen", "Modelo111Screen", "Modelo115Screen", "Modelo180Screen", "VatBooksScreen", "VatSettlementScreen"]) {
      const source = read(`../../../fiscal/${name}.tsx`);
      assert.match(source, /useTabHost\(\)/, `${name}: must read the tab host context`);
      assert.doesNotMatch(source, /embedded\?: boolean/, `${name}: the embedded bridge prop must be gone`);
    }
  });

  it("the five merged screens read the host context (useTabHost / CocoaPage) and take no `embedded` prop (Cocoa 22 · ola 11)", () => {
    for (const file of HOST_CONTEXT_SCREENS) {
      const source = read(`../../../${file}`);
      assert.match(source, /useTabHost\(\)|<CocoaPage\b/, `${file}: must read the tab host context (directly or through CocoaPage)`);
      assert.doesNotMatch(source, /embedded\?: boolean/, `${file}: the embedded bridge prop must be gone`);
    }
  });

  it("every merged screen with a page header is a CocoaPage with ⌘K commands, without the pageHead(embedded) bridge", () => {
    for (const file of HOST_CONTEXT_SCREENS) {
      const source = read(`../../../${file}`);
      assert.doesNotMatch(source, /embedded\?: boolean|pageHead\(/, `${file}: L1c bridge left`);
      assert.match(source, /<CocoaPage\b/, `${file}: the frame must be CocoaPage`);
      assert.match(source, /commands=\{/, `${file}: ⌘K commands go through CocoaPage`);
    }
  });

  it("keep items of the category carry their CSV label as page title", () => {
    assert.match(read("../../../fiscal/FiscalSubmissionsCenter.tsx"), /title="Envíos a autoridades"/);
    assert.match(read("../../../compliance/GdprRequestsScreen.tsx"), /title="Protección de datos"/);
    assert.match(read("../../../compliance/GdprRequestsScreen.tsx"), /Solicitudes RGPD/);
  });
});
