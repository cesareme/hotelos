import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CocoaPageHeader } from "../../../../components/cocoa/CocoaPageHeader.tsx";
import { NAV_TREE, urlForScreen } from "../../../../navigation/nav-tree.ts";
import { buildItemTabs, isTabVisible, itemForScreen, landingKeysFor, missingLoaders, type TabLoaders } from "../../nav-item-tabs.ts";
import { HostedHead } from "../../../../components/cocoa/HostedHead.tsx";

// Containers of lote tabs-c · Configuración: item screen key → container source file.
const CONTAINERS: Record<string, string> = {
  SetupCenterScreen: "PuestaEnMarchaTabs.tsx",
  PropertyProfileSetupForm: "PropiedadTabs.tsx",
  RoomSetupForm: "HabitacionesTabs.tsx",
  NotificationsScreen: "ComunicacionesTabs.tsx",
  BillingSettings: "FacturacionPagosTabs.tsx",
  AccountingSettings: "ContabilidadFiscalTabs.tsx",
  ModuleManager: "ModulosTabs.tsx",
  PropertyAiScreen: "InteligenciaArtificialTabs.tsx",
  AuditLogViewer: "SistemaTabs.tsx"
};

// Screens merged here that left the L1c bridge in Cocoa 22 · ola 11: every one reads
// `useTabHost()` (directly or through CocoaPage), takes no `embedded` prop and its loader
// hands it over as it is (`{ default: m.X }`) — no `embed()` wrapper, no `hosted = … || embedded`.
const HOST_CONTEXT_SCREENS = [
  "backoffice/SetupCenterScreen.tsx",
  "GoLiveChecklist.tsx",
  "notifications/NotificationsScreen.tsx",
  "ModuleManager.tsx",
  "ModuleHealthCenter.tsx",
  "aiOperations/PropertyAiScreen.tsx",
  "aiOperations/AiToolRegistryScreen.tsx",
  "aiOperations/AiPipelineStatusScreen.tsx",
  "aiOperations/AiGovernanceScreen.tsx",
  "developer/ApiReferenceScreen.tsx",
  "admin/TenantAdminConsoleScreen.tsx",
  "admin/TenantDetailScreen.tsx"
];

const noop = () => Promise.reject(new Error("loader not meant to run in tests"));
const loadersFor = (item: { screenKey: string; tabs: readonly { screenKey: string }[] }): TabLoaders =>
  Object.fromEntries([item.screenKey, ...item.tabs.map((tab) => tab.screenKey)].map((key) => [key, noop]));
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("tabs-c · Configuración · containers wire every screen of the tree", () => {
  for (const [screenKey, file] of Object.entries(CONTAINERS)) {
    it(`${file} targets ${screenKey} and loads the base screen and every tab`, () => {
      const source = read(`../${file}`);
      const { item } = itemForScreen(screenKey);
      assert.ok(item.baseTab, `${screenKey} must name its base tab in the CSV (tab column) so the base screen stays reachable`);
      assert.match(source, new RegExp(`screenKey="${screenKey}"`));
      for (const key of [item.screenKey, ...item.tabs.map((tab) => tab.screenKey)]) {
        assert.match(source, new RegExp(`^\\s+${key}:\\s*\\(\\)\\s*=>\\s*import\\(`, "m"), `${file}: loader ${key} missing`);
      }
      assert.deepEqual(missingLoaders(item, loadersFor(item)), []);
      // ONE convention (L1c, bridge retired in ola 11): a loader hands the screen over as it is
      // (`{ default: m.X }`, the screen reads useTabHost()) or injects the URL param of a detail
      // sub-URL. No `embed()` wrapper left.
      const loaderCount = (source.match(/=>\s*import\(/g) ?? []).length;
      const direct = [...source.matchAll(/\(\{ default: m\.([A-Za-z0-9_]+) \}\)/g)].map((m) => m[1]);
      const wrapped = (source.match(/withCategoryParam\(m\.|withOrganizacionParam\(m\./g) ?? []).length;
      assert.equal(direct.length + wrapped, loaderCount, `${file}: every loader is direct or a param wrapper`);
      assert.doesNotMatch(source, /embed\(m\./, `${file}: the embed() bridge is gone`);
    });
  }
});

describe("tabs-c · Configuración · tabs from the tree", () => {
  it("Propiedad: eight tabs after «Perfil»; category detail and new option are sub-URLs painted only with a code", () => {
    const { item } = itemForScreen("PropertyProfileSetupForm");
    const onBase = buildItemTabs(item, loadersFor(item), { pathname: "/configuracion/propiedad" });
    assert.deepEqual(
      onBase.map((tab) => tab.key),
      ["propiedad", "edificios", "plantas", "zonas", "departamentos", "categorias", "detalle-de-categoria", "nueva", "campos-personalizados"]
    );
    assert.equal(onBase[0].label, "Perfil");
    assert.deepEqual(onBase.filter((tab) => tab.hidden).map((tab) => tab.key), ["detalle-de-categoria", "nueva"]);
    const onCategory = buildItemTabs(item, loadersFor(item), { pathname: "/configuracion/propiedad/categorias/room_features" });
    const detail = onCategory.find((tab) => tab.key === "detalle-de-categoria");
    assert.deepEqual([detail?.path, detail?.hidden], ["/configuracion/propiedad/categorias/room_features", false]);
    assert.equal(urlForScreen("CategoryDetailScreen"), "/configuracion/propiedad/categorias/:codigo");
    assert.equal(urlForScreen("CategoryOptionForm"), "/configuracion/propiedad/categorias/:codigo/opciones/nueva");
  });

  it("Sistema: Auditoría for dirección, platform-only tabs for admin, organization detail as sub-URL", () => {
    const { item } = itemForScreen("AuditLogViewer");
    const tabs = buildItemTabs(item, loadersFor(item), { pathname: "/configuracion/sistema" });
    assert.deepEqual(tabs.map((tab) => tab.key), ["sistema", "webhooks", "aplicaciones", "api", "organizaciones", "organizacion"]);
    assert.equal(tabs[0].label, "Auditoría");
    assert.equal(tabs.find((tab) => tab.key === "organizacion")?.hidden, true);
    assert.deepEqual(tabs.filter((tab) => isTabVisible(tab, ["direccion"], [])).map((tab) => tab.key), ["sistema", "api"]);
    assert.deepEqual(tabs.filter((tab) => isTabVisible(tab, ["admin"], [])).map((tab) => tab.key), tabs.map((tab) => tab.key));
    const onOrg = buildItemTabs(item, loadersFor(item), { pathname: "/configuracion/sistema/organizaciones/org_1" });
    assert.deepEqual([onOrg.find((tab) => tab.key === "organizacion")?.path, onOrg.find((tab) => tab.key === "organizacion")?.hidden], ["/configuracion/sistema/organizaciones/org_1", false]);
  });

  it("Puesta en marcha: Resumen · Salida en vivo · Importar desde documentos; Migración asistida stays dev-only under /desarrollo", () => {
    const { item } = itemForScreen("SetupCenterScreen");
    const tabs = buildItemTabs(item, loadersFor(item));
    assert.deepEqual(tabs.map((tab) => [tab.key, tab.label]), [
      ["puesta-en-marcha", "Resumen"],
      ["salida-en-vivo", "Salida en vivo"],
      ["importar-documentos", "Importar desde documentos"]
    ]);
    const migration = NAV_TREE.devOnly.find((screen) => screen.screenKey === "OnboardingProjects");
    assert.equal(migration?.parent, "SetupCenterScreen");
    assert.equal(migration?.url, "/desarrollo/migracion");
    assert.deepEqual(migration?.roles, ["admin"]);
    const source = read("../PuestaEnMarchaTabs.tsx");
    assert.match(source, /isDevModeEnabled\(/, "the dev-only link must honour ?dev=1 / localStorage anfitorio.dev");
    assert.match(source, /screenKey === "OnboardingProjects"/);
  });

  it("Comunicaciones, Facturación y pagos, Contabilidad y fiscal, Módulos, IA and Habitaciones keep the CSV order and base labels", () => {
    const expect = (screenKey: string, keys: string[], baseLabel: string) => {
      const { item } = itemForScreen(screenKey);
      const tabs = buildItemTabs(item, loadersFor(item));
      assert.deepEqual(tabs.map((tab) => tab.key), keys, screenKey);
      assert.equal(tabs[0].label, baseLabel, screenKey);
      assert.ok(tabs.every((tab) => !tab.hidden), screenKey);
    };
    expect("NotificationsScreen", ["comunicaciones", "correo-entrante"], "Plantillas y envíos");
    expect("BillingSettings", ["facturacion-pagos", "pagos"], "Facturación");
    expect("AccountingSettings", ["contabilidad-fiscal", "fiscal", "perfil-inicial", "categorias-ingresos"], "Contabilidad");
    expect("ModuleManager", ["modulos", "salud", "integraciones"], "Módulos");
    expect("PropertyAiScreen", ["ia", "herramientas", "actividad", "gobernanza", "alta"], "Ajustes");
    expect("RoomSetupForm", ["habitaciones", "tipos", "espacios"], "Habitaciones");
  });

  it("Comunicaciones: recepción sees templates but not the inbound mailboxes", () => {
    const { item } = itemForScreen("NotificationsScreen");
    const tabs = buildItemTabs(item, loadersFor(item));
    assert.deepEqual(tabs.filter((tab) => isTabVisible(tab, ["recepcion"], [])).map((tab) => tab.key), ["comunicaciones"]);
  });

  it("every role lands on the base tab (the base screen is the content, not a landing)", () => {
    for (const screenKey of Object.keys(CONTAINERS)) {
      const { item } = itemForScreen(screenKey);
      const tabs = buildItemTabs(item, loadersFor(item));
      for (const token of ["direccion", "finanzas", "admin"] as const) {
        assert.equal(landingKeysFor(item, tabs, [token], []).defaultTab, tabs[0].key, `${screenKey} · ${token}`);
      }
    }
  });
});

describe("tabs · HostedHead (components/cocoa/HostedHead.tsx)", () => {
  it("tab-helpers keeps only the tree and route helpers: no embed() / pageHead() bridge, no head of its own", () => {
    const helpers = read("../../tab-helpers.tsx");
    assert.doesNotMatch(helpers, /export function (embed|pageHead|HostedHead)\b|createElement\(|style=\{/);
    assert.match(helpers, /export function treeHeaderFor\(/);
    assert.match(helpers, /export function useRouteParam\(/);
    assert.match(helpers, /export function shellNavigate\(/);
    assert.notEqual(HostedHead, CocoaPageHeader);
  });

  it("HostedHead paints nothing without subtitle, tabs or actions (no empty toolbar in the panel)", () => {
    assert.equal(HostedHead({ title: "Pagos" }), null);
    const withActions = HostedHead({ title: "Pagos", actions: "x" }) as { props: { "data-hosted-head": string } } | null;
    assert.equal(withActions?.props["data-hosted-head"], "Pagos");
  });

  it("HostedHead never paints its eyebrow: it hands it to the container (fix:L7 qa#12) and paints no toolbar for it alone", () => {
    type El = { type: { displayName?: string }; props: Record<string, unknown> } | null;
    const alone = HostedHead({ title: "USALI", eyebrow: "Finanzas · CELUISMA S.A." }) as El;
    assert.equal(alone?.type.displayName, "HostedEyebrow", "only the registration, no toolbar without subtitle / tabs / actions");
    assert.equal(alone?.props.eyebrow, "Finanzas · CELUISMA S.A.");
    const withActions = HostedHead({ title: "USALI", eyebrow: "Finanzas · CELUISMA S.A.", actions: "x" }) as El;
    assert.equal(withActions?.props["data-hosted-head"], "USALI");
    const rendered = JSON.stringify(withActions);
    assert.doesNotMatch(rendered, /"children":"Finanzas · CELUISMA S\.A\."/, "the eyebrow text is not painted by the hosted head");
    assert.match(rendered, /"eyebrow":"Finanzas · CELUISMA S\.A\."/, "the eyebrow is registered through the HostedEyebrow carrier");
  });
});

describe("tabs-c · Configuración · registration and hosted screens", () => {
  it("the tabs index exports every container and App.tsx registers it (L1b: no whitelist entry)", () => {
    const index = read("../../index.ts");
    const whitelist = JSON.parse(readFileSync(new URL("../../../../../.discoverability-whitelist.json", import.meta.url), "utf8")) as { screens: string[] };
    const app = read("../../../../App.tsx");
    for (const file of Object.values(CONTAINERS)) {
      const name = file.replace(/\.tsx$/, "");
      assert.match(index, new RegExp(`export \\{ default as ${name} \\} from "\\./configuracion/${name}";`), `${name} not exported`);
      // L1b (router-app): the container is a SCREEN_COMPONENTS value, so the coverage gate
      // sees it through the tree and the temporary whitelist entry of L1a is gone.
      assert.match(app, new RegExp(`lazyTab\\("${name}"\\)`), `${name} not registered in App.tsx`);
      assert.ok(!whitelist.screens.includes(name), `${name} must leave the whitelist once App.tsx registers it`);
    }
  });

  it("every merged screen reads the host context and carries no `embedded` bridge (prop, wrapper forward or `|| embedded`)", () => {
    for (const file of HOST_CONTEXT_SCREENS) {
      const source = read(`../../../${file}`);
      assert.match(source, /useTabHost\(\)/, `${file}: must read the tab host context`);
      assert.doesNotMatch(source, /embedded\?: boolean|embedded=\{embedded\}|\|\| embedded\b|embedded \|\|/, `${file}: L1c bridge left`);
    }
  });

  it("detail screens take their key from the URL and the keep items carry their CSV label", () => {
    assert.match(read("../../../backoffice/categories/CategoryDetailScreen.tsx"), /categoryCode\?: string/);
    assert.match(read("../../../backoffice/categories/CategoryOptionForm.tsx"), /categoryCode\?: string/);
    assert.doesNotMatch(read("../../../admin/TenantDetailScreen.tsx"), /embedded\?: boolean/);
    assert.match(read("../../../UserRoleManager.tsx"), /title="Usuarios y roles"/);
    assert.match(read("../../../ModuleManager.tsx"), /menuEntriesUnlockedBy\(/);
    assert.match(read("../../../backoffice/SetupCenterScreen.tsx"), /Todos los ajustes/);
  });
});
