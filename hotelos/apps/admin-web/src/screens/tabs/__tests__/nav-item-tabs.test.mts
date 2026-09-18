import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { ACTIONS, UI_STATES } from "../../../content/actions.ts";
import {
  baseKeyFor,
  buildItemTabs,
  containerEyebrow,
  detailParamsFor,
  emptyTabsCopy,
  emptyTabsReason,
  isTabVisible,
  itemForScreen,
  landingKeysFor,
  missingLoaders,
  slugify,
  tabKeyFor,
  unlockingModulesFor,
  type TabLoaders
} from "../nav-item-tabs.ts";

// Tab containers of lote tabs-a: item screen key → container source file.
const CONTAINERS: Record<string, string> = {
  FrontDeskDashboard: "hoy/MiDiaTabs.tsx",
  ReservationWorkspace: "recepcion/ReservasTabs.tsx",
  ReservationCreate: "recepcion/NuevaReservaTabs.tsx",
  GuestsList: "recepcion/HuespedesTabs.tsx",
  GroupsEventsDashboard: "recepcion/GruposEventosTabs.tsx",
  HousekeepingDashboard: "operaciones/PisosTabs.tsx",
  MaintenanceDashboard: "operaciones/MantenimientoTabs.tsx",
  PosDashboard: "operaciones/PuntoVentaTabs.tsx",
  ProcurementDashboard: "operaciones/ComprasInventarioTabs.tsx"
};

const noop = () => Promise.reject(new Error("loader not meant to run in tests"));
const loadersFor = (...keys: string[]): TabLoaders => Object.fromEntries(keys.map((key) => [key, noop]));
const ALL_MODULES = ["outlet_pos", "procurement_inventory", "workforce_labor", "safety_incident_management"];

describe("nav-item-tabs · tree lookups", () => {
  it("resolves the nine items of the lot and rejects tab/alias keys", () => {
    for (const key of Object.keys(CONTAINERS)) assert.equal(itemForScreen(key).item.screenKey, key);
    assert.throws(() => itemForScreen("ReservationsListScreen"));
    assert.throws(() => itemForScreen("ChannelManagerDashboard"));
  });

  it("derives keys from the URL (static) or the label (detail)", () => {
    assert.equal(slugify("Cronología"), "cronologia");
    assert.equal(slugify("Dictar (IA)"), "dictar-ia");
    assert.equal(tabKeyFor({ url: "/operaciones/pisos/mi-turno", label: "Mi turno" }), "mi-turno");
    assert.equal(tabKeyFor({ url: "/recepcion/reservas/:id", label: "Detalle" }), "detalle");
    assert.equal(tabKeyFor({ url: "/recepcion/reservas/:id/recorrido", label: "Recorrido" }), "recorrido");
    assert.equal(baseKeyFor({ url: "/hoy" }), "hoy");
    assert.equal(baseKeyFor({ url: "/recepcion/reservas/nueva" }), "nueva");
  });
});

describe("nav-item-tabs · buildItemTabs", () => {
  it("Mi día: base tab «Recepción» at /hoy with narrowed roles, then the three role tabs", () => {
    const { item } = itemForScreen("FrontDeskDashboard");
    const tabs = buildItemTabs(item, loadersFor("FrontDeskDashboard", "OperationsDirectorScreen", "GeneralManagerScreen", "OwnerHome"), {
      baseRoles: ["recepcion", "direccion", "admin"]
    });
    assert.deepEqual(tabs.map((tab) => tab.key), ["hoy", "operaciones", "direccion", "propietario"]);
    assert.deepEqual(tabs.map((tab) => tab.path), ["/hoy", "/hoy/operaciones", "/hoy/direccion", "/hoy/propietario"]);
    assert.equal(tabs[0].label, "Recepción");
    assert.deepEqual(tabs[0].roles, ["recepcion", "direccion", "admin"]);
    assert.deepEqual(tabs[1].roles, ["pisos", "mantenimiento", "fnb", "direccion", "admin", "auditoria"]); // Tanda 8a: auditoría interna ve Mi día
    assert.ok(tabs.every((tab) => !tab.hidden));
  });

  it("Reservas: no base tab; detail sub-URLs stay hidden with their pattern until the URL carries the id", () => {
    const { item } = itemForScreen("ReservationWorkspace");
    const loaders = loadersFor("ReservationsListScreen", "LiveTimelineWorkspace", "RoomRackScreen", "ReservationDetailWorkspace", "GuestJourneyWorkspace");
    const onList = buildItemTabs(item, loaders, { pathname: "/recepcion/reservas/lista" });
    assert.deepEqual(onList.map((tab) => tab.key), ["lista", "cronograma", "tablero", "detalle", "recorrido"]);
    assert.equal(onList.find((tab) => tab.key === "detalle")?.hidden, true);
    assert.equal(onList.find((tab) => tab.key === "detalle")?.path, "/recepcion/reservas/:id");
    assert.equal(onList.find((tab) => tab.key === "lista")?.hidden, undefined);

    const onDetail = buildItemTabs(item, loaders, { pathname: "/recepcion/reservas/res_42" });
    const detalle = onDetail.find((tab) => tab.key === "detalle");
    const recorrido = onDetail.find((tab) => tab.key === "recorrido");
    assert.deepEqual([detalle?.path, detalle?.hidden], ["/recepcion/reservas/res_42", false]);
    assert.deepEqual([recorrido?.path, recorrido?.hidden], ["/recepcion/reservas/res_42/recorrido", false]);
    assert.deepEqual(detailParamsFor(item, "/recepcion/reservas/res_42/recorrido"), { id: "res_42" });
    assert.equal(detailParamsFor(item, "/recepcion/reservas/cronograma"), null);
    assert.equal(detailParamsFor(item, "/recepcion/reservas/nueva"), null);
    assert.equal(detailParamsFor(item, "/recepcion/reservas/nueva/dictar"), null);
    assert.equal(detailParamsFor(itemForScreen("GuestsList").item, "/recepcion/reservas/res_42"), null);
  });

  it("Huéspedes: «Listado» base tab; Ficha and Cronología concretized together on a guest", () => {
    const { item } = itemForScreen("GuestsList");
    const loaders = loadersFor("GuestsList", "GuestDetail", "GuestTimelineScreen");
    const onList = buildItemTabs(item, loaders, { pathname: "/recepcion/huespedes" });
    assert.deepEqual(onList.map((tab) => [tab.key, tab.hidden ?? false]), [["huespedes", false], ["ficha", true], ["cronologia", true]]);
    const onGuest = buildItemTabs(item, loaders, { pathname: "/recepcion/huespedes/g%201/cronologia" });
    assert.deepEqual(onGuest.map((tab) => tab.path), ["/recepcion/huespedes", "/recepcion/huespedes/g%201", "/recepcion/huespedes/g%201/cronologia"]);
    assert.ok(onGuest.every((tab) => !tab.hidden));
  });

  it("skips tabs without loader and reports them", () => {
    const { item } = itemForScreen("PosDashboard");
    const partial = loadersFor("PosDashboard", "FnbMenu");
    assert.deepEqual(buildItemTabs(item, partial).map((tab) => tab.key), ["tpv", "cartas"]);
    // Tanda 6: the Punto de venta item gained the Cierre de caja tab (CashClosureScreen).
    assert.deepEqual(missingLoaders(item, partial), ["FnbInventory", "CashClosureScreen"]);
    assert.deepEqual(missingLoaders(item, loadersFor("FnbMenu", "FnbInventory")), ["PosDashboard", "CashClosureScreen"]);
  });

  it("every container wires a loader for its base screen and every tab of the tree", () => {
    for (const [screenKey, file] of Object.entries(CONTAINERS)) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const { item } = itemForScreen(screenKey);
      const expected = [...(item.baseTab ? [item.screenKey] : []), ...item.tabs.map((tab) => tab.screenKey)];
      for (const key of expected) {
        assert.match(source, new RegExp(`^\\s+${key}:\\s*\\(\\)\\s*=>\\s*import\\(`, "m"), `${file}: loader ${key} missing`);
      }
      assert.match(source, new RegExp(`screenKey="${screenKey}"`), `${file}: container must target ${screenKey}`);
    }
  });

  it("the tabs index exports every container of the lot", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    for (const file of Object.values(CONTAINERS)) {
      const name = file.split("/").pop()!.replace(/\.tsx$/, "");
      assert.match(index, new RegExp(`export \\{ default as ${name} \\} from "\\./${file.replace(/\.tsx$/, "")}";`), `${name} not exported`);
    }
    const lotFiles = readdirSync(new URL("../hoy", import.meta.url)).length + readdirSync(new URL("../recepcion", import.meta.url)).length + readdirSync(new URL("../operaciones", import.meta.url)).length;
    assert.equal(lotFiles, Object.keys(CONTAINERS).length);
  });
});

describe("nav-item-tabs · landing per role (§1/§3)", () => {
  const miDia = itemForScreen("FrontDeskDashboard").item;
  const miDiaTabs = buildItemTabs(miDia, loadersFor("FrontDeskDashboard", "OperationsDirectorScreen", "GeneralManagerScreen", "OwnerHome"), {
    baseRoles: ["recepcion", "direccion", "admin"]
  });

  it("Mi día lands each role on its home tab", () => {
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["recepcion"], []).defaultTab, "hoy");
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["pisos"], []).defaultTab, "operaciones");
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["fnb"], []).defaultTab, "operaciones");
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["revenue"], []).defaultTab, "direccion");
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["finanzas"], []).defaultTab, "direccion");
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["direccion"], [], { templateKey: "manager" }).defaultTab, "direccion");
    assert.equal(landingKeysFor(miDia, miDiaTabs, ["direccion"], [], { templateKey: "owner" }).defaultTab, "propietario");
    assert.equal(landingKeysFor(miDia, miDiaTabs, [], []).defaultTab, "hoy");
  });

  it("Reservas lands on the first visible tab (Lista; Cronograma for pisos)", () => {
    const { item } = itemForScreen("ReservationWorkspace");
    const tabs = buildItemTabs(item, loadersFor("ReservationsListScreen", "LiveTimelineWorkspace", "RoomRackScreen", "ReservationDetailWorkspace", "GuestJourneyWorkspace"));
    assert.equal(landingKeysFor(item, tabs, ["recepcion"], []).defaultTab, "lista");
    assert.equal(landingKeysFor(item, tabs, ["pisos"], []).defaultTab, "cronograma");
    assert.equal(landingKeysFor(item, tabs, [], []).defaultTab, "lista");
  });

  it("Pisos and Mantenimiento land on the board on desktop and on the mobile tab below 700 px", () => {
    const pisos = itemForScreen("HousekeepingDashboard").item;
    const pisosTabs = buildItemTabs(pisos, loadersFor("HousekeepingDashboard", "HousekeepingMobileScreen", "HousekeepingSetupForm"));
    assert.deepEqual(landingKeysFor(pisos, pisosTabs, ["pisos"], []), { defaultTab: "pisos", mobileDefaultTab: "mi-turno" });
    assert.deepEqual(landingKeysFor(pisos, pisosTabs, ["direccion"], []), { defaultTab: "pisos", mobileDefaultTab: "pisos" });
    const maint = itemForScreen("MaintenanceDashboard").item;
    const maintTabs = buildItemTabs(maint, loadersFor("MaintenanceDashboard", "MaintenanceMobileScreen", "MaintenanceSetupForm"));
    assert.deepEqual(landingKeysFor(maint, maintTabs, ["mantenimiento"], []), { defaultTab: "mantenimiento", mobileDefaultTab: "mis-averias" });
  });

  it("module-gated containers land on the base tab and hide gated tabs until the module is known", () => {
    const tpv = itemForScreen("PosDashboard").item;
    const tabs = buildItemTabs(tpv, loadersFor("PosDashboard", "FnbMenu", "FnbInventory"));
    assert.equal(landingKeysFor(tpv, tabs, ["finanzas"], ALL_MODULES).defaultTab, "tpv");
    assert.equal(isTabVisible(tabs[0], ["recepcion"], []), false);
    assert.equal(isTabVisible(tabs[0], ["recepcion"], ["outlet_pos"]), true);
    assert.equal(isTabVisible(tabs[1], ["recepcion"], ["outlet_pos"]), false);
    assert.equal(isTabVisible(tabs[2], ["finanzas"], ["outlet_pos"]), true);
    // No token: module gate only.
    assert.equal(isTabVisible(tabs[1], [], ["outlet_pos"]), true);
    assert.equal(isTabVisible(tabs[1], [], []), false);
  });
});

// qa#12 (fix:nav · Tanda 5): with outlet_pos disabled in prop_123 the platform
// admin used to read «No hay secciones disponibles para tu perfil» in Punto de
// venta, although the cause was the module, not the profile.
describe("nav-item-tabs · empty container tells module from role (qa#12)", () => {
  const tpv = itemForScreen("PosDashboard").item;
  const tpvTabs = buildItemTabs(tpv, loadersFor("PosDashboard", "FnbMenu", "FnbInventory", "CashClosureScreen"));

  it("Punto de venta with outlet_pos off: the module is the reason for the platform admin and for recepción", () => {
    assert.equal(emptyTabsReason(tpvTabs, ["admin"], []), "module");
    assert.equal(emptyTabsReason(tpvTabs, ["recepcion"], ["pms_core"]), "module");
    // «Ver como…» recepción or a custom role without token: module gate only.
    assert.equal(emptyTabsReason(tpvTabs, [], []), "module");
    // Module on → at least one tab is visible → nothing to explain.
    assert.equal(emptyTabsReason(tpvTabs, ["admin"], ["outlet_pos"]), null);
    assert.equal(emptyTabsReason(tpvTabs, [], ["outlet_pos"]), null);
  });

  it("a profile with no tab in the item reads the role gap, even when the module is off too", () => {
    assert.equal(emptyTabsReason(tpvTabs, ["pisos"], ["outlet_pos"]), "role");
    assert.equal(emptyTabsReason(tpvTabs, ["pisos"], []), "role");
    assert.equal(emptyTabsReason(tpvTabs, ["pisos", "mantenimiento"], []), "role");
  });

  it("an unreadable module list (403 on GET /modules, or load failure) is unknown, never «no activado»", () => {
    assert.equal(emptyTabsReason(tpvTabs, ["admin"], [], { listUnavailable: true }), "modules_unknown");
    assert.equal(emptyTabsReason(tpvTabs, ["pisos"], [], { listUnavailable: true }), "role");
    assert.equal(emptyTabsReason(tpvTabs, ["admin"], ["outlet_pos"], { listUnavailable: true }), null);
  });

  it("core items are never empty for a role the item is for", () => {
    const miDia = itemForScreen("FrontDeskDashboard").item;
    const tabs = buildItemTabs(miDia, loadersFor("FrontDeskDashboard", "OperationsDirectorScreen", "GeneralManagerScreen", "OwnerHome"), {
      baseRoles: ["recepcion", "direccion", "admin"]
    });
    for (const token of ["recepcion", "pisos", "fnb", "direccion", "finanzas", "admin"] as const) assert.equal(emptyTabsReason(tabs, [token], []), null);
    assert.equal(emptyTabsReason(tabs, [], []), null);
  });

  it("lists the modules «Activar módulo» may preselect, only from the tabs the role may see", () => {
    assert.deepEqual(unlockingModulesFor(tpvTabs, ["admin"]), ["outlet_pos"]);
    assert.deepEqual(unlockingModulesFor(tpvTabs, ["recepcion"]), ["outlet_pos"]);
    assert.deepEqual(unlockingModulesFor(tpvTabs, []), ["outlet_pos"]);
    assert.deepEqual(unlockingModulesFor(tpvTabs, ["pisos"]), []);
    const compras = itemForScreen("ProcurementDashboard").item;
    const comprasTabs = buildItemTabs(compras, loadersFor(compras.screenKey, ...compras.tabs.map((tab) => tab.screenKey)));
    assert.deepEqual(unlockingModulesFor(comprasTabs, ["direccion"]), ["procurement_inventory"]);
  });

  it("copies: canonical «Módulo no activado» with the CTA only for modules.enable, «Sin acceso» for a role gap, honest text when unknown", () => {
    const withCta = emptyTabsCopy("module", { canEnable: true });
    assert.equal(withCta.title, UI_STATES.moduleDisabled.title);
    assert.equal(withCta.message, UI_STATES.moduleDisabled.message);
    assert.equal(withCta.cta, ACTIONS.enableModule);
    const withoutCta = emptyTabsCopy("module", { canEnable: false });
    assert.equal(withoutCta.title, UI_STATES.moduleDisabled.title);
    assert.match(withoutCta.message, /Módulos e integraciones/);
    assert.equal(withoutCta.cta, undefined);
    const role = emptyTabsCopy("role", { canEnable: true });
    assert.deepEqual(role, { title: UI_STATES.forbidden.title, message: UI_STATES.forbidden.message });
    const unknown = emptyTabsCopy("modules_unknown", { canEnable: true });
    assert.match(unknown.message, /módulos/);
    assert.equal(unknown.cta, undefined, "no «Activar módulo» when we do not know whether the module is off");
    for (const copy of [withCta, withoutCta, role, unknown]) assert.doesNotMatch(`${copy.title} ${copy.message}`, /para tu perfil/);
  });
});

describe("nav-item-tabs · eyebrow qualified by the hosted screen (Tanda 6b · L7, fix qa#12)", () => {
  it("paints the category alone until a hosted screen registers an eyebrow", () => {
    assert.equal(containerEyebrow("Finanzas", "Estados contables", null), "Finanzas");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", undefined), "Finanzas");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", ""), "Finanzas");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "   "), "Finanzas");
  });

  it("extends the category with the sociedad or centre of the finance scope (design §5.3: «FINANZAS · <sociedad>»)", () => {
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "Finanzas · CELUISMA S.A."), "Finanzas · CELUISMA S.A.");
    assert.equal(containerEyebrow("Cumplimiento", "Modelos AEAT", "Cumplimiento · Hotel Faranda Rías Altas (RA)"), "Cumplimiento · Hotel Faranda Rías Altas (RA)");
    assert.equal(containerEyebrow("Operaciones", "Punto de venta", " Operaciones · Oficina central (OC) "), "Operaciones · Oficina central (OC)");
  });

  it("ignores an eyebrow that does not qualify the container's own category (the header never drifts from the menu)", () => {
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "Finanzas"), "Finanzas", "the plain category adds nothing");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "Finanzas ·  "), "Finanzas", "an empty qualifier adds nothing");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "Contabilidad · CELUISMA S.A."), "Finanzas", "another category is not this container");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "Finanzas · Estados contables"), "Finanzas", "«Categoría · Ítem» (treeHeaderFor of a tab) is already the H1");
    assert.equal(containerEyebrow("Finanzas", "Estados contables", "FINANZAS · CELUISMA S.A."), "Finanzas", "the prefix is the label as the tree writes it");
  });
});
