import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEV_CATEGORY_KEY,
  NAV_TREE,
  activeMenuItemFor,
  countMenu,
  enableModuleTarget,
  flatMenuEntries,
  landingFor,
  menuCategories,
  menuItemMatches,
  screenKeyForUrl,
  type MenuCategory
} from "../nav-tree.ts";
import { ROLE_TOKENS, resolveRoleTokens, roleAllowsEveryone, templatesCoveredByPermissions, type RoleToken } from "../role-tokens.ts";

// Every module code the tree references, so "all modules on" is exact.
const ALL_MODULES = Array.from(
  new Set([
    ...NAV_TREE.categories.flatMap((category) => category.items.flatMap((item) => [...item.modulesAny, ...item.tabs.flatMap((tab) => tab.modulesAny)])),
    ...NAV_TREE.devOnly.flatMap((screen) => screen.modulesAny)
  ])
);
// Faranda (pilots/tanda5-nav-tree.md §6): six modules enabled.
const FARANDA_MODULES = ["pms_core", "distribution_hub", "compliance_hub", "guest_experience", "outlet_pos", "revenue_profit_engine"];

// pilots/tanda5-nav-tree.md §3 — items / categories per role with every module on.
const EXPECTED: Record<Exclude<RoleToken, "publico">, { items: number; categories: number }> = {
  // Tanda 6 (Finanzas): Contabilidad and Proveedores y gastos add 2 items for direccion, finanzas and admin.
  // Tanda 6b: Estructura societaria adds 1 item for direccion, finanzas and admin.
  // Tanda 8a (RBAC): Hoy › Pendientes de aprobación and the six department tokens (design §5.1);
  // counts computed over nav-tree.generated.json (node scripts/check-route-access.mjs prints them).
  direccion: { items: 68, categories: 9 },
  recepcion: { items: 23, categories: 9 },
  pisos: { items: 6, categories: 3 },
  mantenimiento: { items: 9, categories: 3 },
  revenue: { items: 21, categories: 5 },
  finanzas: { items: 32, categories: 6 },
  comercial: { items: 14, categories: 5 },
  fnb: { items: 6, categories: 2 },
  administracion: { items: 12, categories: 5 }, // corrector 8a (FX-06): + Hoy › Pendientes de aprobación
  rrhh: { items: 3, categories: 3 }, // corrector 8a (FX-06): + Hoy › Pendientes de aprobación (its own payroll requests)
  propiedad: { items: 5, categories: 3 },
  activos: { items: 3, categories: 3 }, // corrector 8a (FX-06): + Hoy › Pendientes de aprobación (its own CAPEX requests)
  auditoria: { items: 65, categories: 9 },
  sistemas: { items: 4, categories: 1 },
  admin: { items: 68, categories: 9 }
};

function screenKeys(categories: readonly MenuCategory[]): string[] {
  return categories.flatMap((category) => category.items.map((item) => item.screenKey));
}

describe("Sidebar menu · visibility per role (§3 of the tree)", () => {
  for (const token of ROLE_TOKENS.filter((value): value is Exclude<RoleToken, "publico"> => value !== "publico")) {
    it(`${token} sees ${EXPECTED[token].items} items in ${EXPECTED[token].categories} categories`, () => {
      const categories = menuCategories([token], ALL_MODULES);
      const counts = countMenu(categories);
      assert.equal(counts.items, EXPECTED[token].items);
      assert.equal(counts.categories, EXPECTED[token].categories);
      assert.equal(counts.locked, 0, "nothing is locked with every module on");
    });
  }

  it("never exceeds 9 categories nor 12 items per category, and every item has a URL", () => {
    const categories = menuCategories(["admin"], ALL_MODULES);
    assert.ok(categories.length <= 9);
    for (const category of categories) {
      assert.ok(category.items.length <= 12, `${category.key} has ${category.items.length} items`);
      for (const item of category.items) {
        assert.match(item.url, /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/, `${item.screenKey} url`);
        assert.ok(item.label.length > 0);
      }
    }
  });

  it("has no duplicated screen keys nor URLs across the menu", () => {
    const categories = menuCategories(["admin"], ALL_MODULES);
    const keys = screenKeys(categories);
    assert.equal(new Set(keys).size, keys.length, "duplicated screen keys");
    const urls = categories.flatMap((category) => category.items.map((item) => item.url));
    assert.equal(new Set(urls).size, urls.length, "duplicated URLs");
  });

  it("a multi-role user sees the union (finanzas + recepcion)", () => {
    const union = new Set(screenKeys(menuCategories(["finanzas", "recepcion"], ALL_MODULES)));
    for (const key of screenKeys(menuCategories(["finanzas"], ALL_MODULES))) assert.ok(union.has(key), key);
    for (const key of screenKeys(menuCategories(["recepcion"], ALL_MODULES))) assert.ok(union.has(key), key);
  });

  it("tabs of a visible item are filtered by role too (Reservas: pisos sees Cronograma, not Detalle)", () => {
    const recepcion = menuCategories(["recepcion"], ALL_MODULES).find((category) => category.key === "recepcion");
    const reservas = recepcion?.items.find((item) => item.screenKey === "ReservationWorkspace");
    assert.ok(reservas);
    assert.ok(reservas.tabs.some((tab) => tab.label === "Cronograma"));
    const pisos = menuCategories(["pisos"], ALL_MODULES).find((category) => category.key === "recepcion");
    const reservasPisos = pisos?.items.find((item) => item.screenKey === "ReservationWorkspace");
    assert.ok(reservasPisos);
    assert.ok(reservasPisos.tabs.some((tab) => tab.label === "Cronograma"));
    assert.ok(!reservasPisos.tabs.some((tab) => tab.label === "Detalle"));
  });
});

describe("Sidebar menu · module gates (§6)", () => {
  it("Faranda's six modules hide the six module-gated items for dirección (61 visible)", () => {
    const categories = menuCategories(["direccion"], FARANDA_MODULES);
    const counts = countMenu(categories);
    // Tanda 6b: Estructura societaria (core) adds one visible item; Tanda 8a: Pendientes de aprobación (core) another.
    assert.equal(counts.items, 62);
    assert.equal(counts.locked, 0);
    const keys = new Set(screenKeys(categories));
    for (const hidden of ["WorkforceDashboard", "SafetyDashboard", "ProcurementDashboard", "CrmDashboard", "ReputationDashboard", "AnalyticsCenterDashboard"]) {
      assert.ok(!keys.has(hidden), `${hidden} should be hidden`);
    }
    assert.ok(keys.has("PosDashboard"), "outlet_pos is on");
    assert.ok(keys.has("RevenueHomeDashboard"), "revenue_profit_engine is on");
  });

  it("with modules.enable the same six items are painted locked with «Activar módulo»", () => {
    const categories = menuCategories(["direccion"], FARANDA_MODULES, { canEnableModules: true });
    const counts = countMenu(categories);
    assert.equal(counts.items, 68);
    assert.equal(counts.locked, 6);
    const crm = categories.flatMap((category) => category.items).find((item) => item.screenKey === "CrmDashboard");
    assert.ok(crm);
    assert.equal(crm.visibility, "locked");
    assert.deepEqual(crm.lockedBy, ["guest_data_crm_loyalty"]);
    assert.equal(crm.tabs.length, 0, "a locked item paints no tabs");
    assert.equal(enableModuleTarget(crm), "ModuleManager#modulo=guest_data_crm_loyalty");
    assert.equal(enableModuleTarget({ lockedBy: [] }), "ModuleManager");
  });

  it("a module-gated tab disappears while its module is off (Portal del huésped needs guest_self_service)", () => {
    const withAll = menuCategories(["comercial"], ALL_MODULES).flatMap((category) => category.items).find((item) => item.screenKey === "UpsellsDashboard");
    const withFaranda = menuCategories(["comercial"], FARANDA_MODULES).flatMap((category) => category.items).find((item) => item.screenKey === "UpsellsDashboard");
    assert.ok(withAll && withFaranda);
    assert.ok(withAll.tabs.some((tab) => tab.label === "Portal del huésped"));
    assert.ok(!withFaranda.tabs.some((tab) => tab.label === "Portal del huésped"));
  });

  it("while the module list is unknown ([]) only core items show — nothing can open a 403", () => {
    const categories = menuCategories(["direccion"], []);
    for (const item of categories.flatMap((category) => category.items)) {
      assert.equal(item.modulesAny.length, 0, `${item.screenKey} is module-gated`);
    }
    assert.ok(countMenu(categories).items >= 40, "core items still paint");
  });

  it("without modules.enable a role that cannot enable modules never sees a locked entry", () => {
    const categories = menuCategories(["recepcion"], FARANDA_MODULES, { canEnableModules: false });
    assert.equal(countMenu(categories).locked, 0);
    assert.ok(!screenKeys(categories).includes("CrmDashboard"));
  });
});

describe("Sidebar menu · no role, dev group, active item and landing", () => {
  it("no token → only the entries every authenticated token can open: none since Tanda 8a (rrhh, activos and sistemas do not see Mi día), so the shell shows UI_STATES.noRole", () => {
    const categories = menuCategories([], ALL_MODULES);
    assert.deepEqual(categories, []);
    for (const category of NAV_TREE.categories) for (const item of category.items) assert.ok(!roleAllowsEveryone(item), `${item.screenKey} is not open to every token`);
    // «Activar módulo» is never offered without a token either.
    assert.deepEqual(menuCategories([], [], { canEnableModules: true }), []);
  });

  it("the six Tanda 8a tokens see exactly the rows of design §5.1", () => {
    const keysOf = (token: RoleToken) => screenKeys(menuCategories([token], ALL_MODULES)).sort();
    // Corrector 8a (FX-06): the makers of RRHH (payroll), gestión del activo (CAPEX) and administración de hotel see the state of their own requests in the inbox.
    assert.deepEqual(keysOf("rrhh"), ["ApprovalsInbox", "PayrollScreen", "WorkforceDashboard"]);
    assert.deepEqual(keysOf("activos"), ["ApprovalsInbox", "ComplianceCenter", "StructureScreen"]);
    assert.deepEqual(keysOf("sistemas"), ["AuditLogViewer", "ModuleManager", "NotificationsScreen", "UserRoleManager"]);
    assert.deepEqual(keysOf("propiedad"), ["FrontDeskDashboard", "PortfolioDashboard", "ReportingCenter", "TrialBalanceScreen"].concat(["ApprovalsInbox"]).sort());
    assert.deepEqual(keysOf("administracion"), [
      "ApprovalsInbox",
      "AssistantChat",
      "BankReconciliationScreen",
      "BillingCenter",
      "ComplianceInbox",
      "FinancePositionDashboard",
      "FrontDeskDashboard",
      "GuestRegisterSettings",
      "NightAuditScreen",
      "ProcurementDashboard",
      "ReportingCenter",
      "SupplierBillsScreen"
    ]);
    const auditor = new Set(keysOf("auditoria"));
    assert.ok(!auditor.has("UserRoleManager"), "auditoria never sees Usuarios y roles");
    assert.ok(!auditor.has("ApprovalsInbox"), "the inbox is for approvers, not for the read-only auditor");
    const sistema = menuCategories(["auditoria"], ALL_MODULES).flatMap((category) => category.items).find((item) => item.screenKey === "AuditLogViewer");
    assert.deepEqual(sistema?.tabs.map((tab) => tab.screenKey), ["ApiReferenceScreen"], "auditoria: no Webhooks, Aplicaciones, Organizaciones nor Organización");
    const modulos = menuCategories(["sistemas"], ALL_MODULES).flatMap((category) => category.items).find((item) => item.screenKey === "ModuleManager");
    assert.deepEqual(modulos?.tabs.map((tab) => tab.screenKey), ["ModuleHealthCenter", "MarketplaceCatalog"], "sistemas: no Modo sombra OPERA");
    const inbox = NAV_TREE.categories.flatMap((category) => category.items).find((item) => item.screenKey === "ApprovalsInbox");
    // Corrector 8a (FX-06): the makers of administración de hotel, RRHH and gestión del activo see the state of their own requests too.
    assert.deepEqual(inbox?.roles, ["direccion", "recepcion", "pisos", "mantenimiento", "fnb", "revenue", "finanzas", "propiedad", "administracion", "rrhh", "activos", "admin"]);
    assert.equal(inbox?.url, "/hoy/pendientes");
  });

  it("«Desarrollo» appears only with dev mode AND the admin token", () => {
    const withDev = menuCategories(["admin"], ALL_MODULES, { devMode: true });
    const dev = withDev.find((category) => category.key === DEV_CATEGORY_KEY);
    assert.ok(dev && dev.devOnly);
    assert.equal(dev.items.length, NAV_TREE.devOnly.length);
    for (const item of dev.items) assert.match(item.url, /^\/desarrollo\//);
    assert.equal(withDev.length, 10);
    assert.ok(!menuCategories(["sistemas"], ALL_MODULES, { devMode: true }).some((category) => category.key === DEV_CATEGORY_KEY), "the organisation admin template (sistemas) is not the platform");
    assert.ok(!menuCategories(["admin"], ALL_MODULES).some((category) => category.key === DEV_CATEGORY_KEY), "no dev mode");
    assert.ok(!menuCategories(["direccion"], ALL_MODULES, { devMode: true }).some((category) => category.key === DEV_CATEGORY_KEY), "no admin");
  });

  it("activeMenuItemFor resolves tabs, aliases, retired keys and dev-only screens to their menu item", () => {
    assert.deepEqual(activeMenuItemFor("ReservationWorkspace"), { categoryKey: "recepcion", screenKey: "ReservationWorkspace" });
    assert.deepEqual(activeMenuItemFor("ReservationsListScreen"), { categoryKey: "recepcion", screenKey: "ReservationWorkspace" });
    assert.deepEqual(activeMenuItemFor("ChannelManagerDashboard"), { categoryKey: "comercial", screenKey: "ChannelAggregatorHub" });
    assert.deepEqual(activeMenuItemFor("AISettings"), { categoryKey: "configuracion", screenKey: "PropertyAiScreen" });
    assert.deepEqual(activeMenuItemFor("RevenueDataQuality"), { categoryKey: DEV_CATEGORY_KEY, screenKey: "RevenueDataQuality" });
    assert.equal(activeMenuItemFor("LoginScreen"), null);
    assert.equal(activeMenuItemFor("NoSuchScreen"), null);
  });

  it("landingFor follows §3: owner → Propietario, recepción → Mi día, pisos on a phone → Mi turno, no role → Mi día", () => {
    assert.deepEqual(landingFor(["direccion"], { templateKey: "owner" }), { url: "/hoy/propietario", screenKey: "OwnerHome" });
    assert.equal(landingFor(["direccion"], { templateKey: "manager" }).url, "/hoy/direccion");
    assert.deepEqual(landingFor(["recepcion"]), { url: "/hoy", screenKey: "FrontDeskDashboard" });
    assert.deepEqual(landingFor(["pisos"], { mobile: true }), { url: "/operaciones/pisos/mi-turno", screenKey: "HousekeepingMobileScreen" });
    assert.equal(landingFor(["pisos"], { mobile: false }).url, "/hoy/operaciones");
    assert.equal(landingFor(["mantenimiento"], { mobile: true }).url, "/operaciones/mantenimiento/mis-averias");
    assert.deepEqual(landingFor([]), { url: "/hoy", screenKey: "FrontDeskDashboard" });
    assert.equal(screenKeyForUrl("/no/existe"), null);
  });

  it("flatMenuEntries lists items and paintable tabs (never detail sub-URLs) for ⌘K", () => {
    const categories = menuCategories(["recepcion"], ALL_MODULES);
    const items = flatMenuEntries(categories);
    assert.equal(items.length, 23);
    assert.ok(items.every((entry) => entry.tab === null));
    const withTabs = flatMenuEntries(categories, { includeTabs: true });
    assert.ok(withTabs.length > items.length);
    assert.ok(withTabs.some((entry) => entry.tab === "Cronograma" && entry.itemScreenKey === "ReservationWorkspace"));
    assert.ok(!withTabs.some((entry) => entry.url.includes(":")), "detail sub-URLs are not entries");
  });

  it("the menu search is accent-insensitive and matches tab labels", () => {
    const reservas = menuCategories(["recepcion"], ALL_MODULES).flatMap((category) => category.items).find((item) => item.screenKey === "ReservationWorkspace");
    assert.ok(reservas);
    assert.ok(menuItemMatches(reservas, "cronograma"));
    assert.ok(menuItemMatches(reservas, "RESERVAS"));
    assert.ok(!menuItemMatches(reservas, "nóminas"));
    assert.ok(menuItemMatches({ label: "Huéspedes", tabs: [] }, "huespedes"));
    assert.ok(menuItemMatches(reservas, ""));
  });
});

describe("resolveRoleTokens · session → tokens (L1b)", () => {
  const TEMPLATES = {
    receptionist: ["pms.reservation.read", "pms.checkin.execute"],
    housekeeper: ["housekeeping.task.manage"],
    owner: ["everything"],
    admin: ["platform.admin"]
  };

  it("maps template keys to tokens and adds admin for the platform administrator", () => {
    assert.deepEqual(resolveRoleTokens({ templateKeys: ["owner"] }), { tokens: ["propiedad"], templateKey: "owner", fromPermissions: false });
    assert.deepEqual(resolveRoleTokens({ templateKeys: ["accountant", "compliance"] }).tokens, ["finanzas"]);
    assert.deepEqual(resolveRoleTokens({ templateKeys: [], isPlatformAdmin: true }), { tokens: ["admin"], templateKey: null, fromPermissions: false });
    assert.deepEqual(resolveRoleTokens({ templateKeys: ["Receptionist "], isPlatformAdmin: true }).tokens, ["admin", "recepcion"]);
    // Tanda 8a: the organisation admin template is `sistemas`, never the platform token.
    assert.deepEqual(resolveRoleTokens({ templateKeys: ["admin"] }).tokens, ["sistemas"]);
    assert.deepEqual(resolveRoleTokens({ templateKeys: ["owner", "general_manager"] }).tokens, ["direccion", "propiedad"]);
  });

  it("picks owner over the rest for the landing template, then the most specific template", () => {
    assert.equal(resolveRoleTokens({ templateKeys: ["manager", "owner"] }).templateKey, "owner");
    assert.equal(resolveRoleTokens({ templateKeys: ["manager"] }).templateKey, "manager");
    assert.equal(resolveRoleTokens({ templateKeys: ["manager", "general_manager"] }).templateKey, "general_manager");
    assert.equal(resolveRoleTokens({ templateKeys: ["receptionist", "front_office_manager"] }).templateKey, "front_office_manager");
  });

  it("falls back to the templates fully covered by the granted permissions only when no template applies", () => {
    const custom = resolveRoleTokens({
      templateKeys: [],
      grantedPermissions: ["housekeeping.task.manage", "pms.reservation.read"],
      templatePermissions: TEMPLATES
    });
    assert.deepEqual(custom.tokens, ["pisos"]);
    assert.equal(custom.fromPermissions, true);
    assert.equal(custom.templateKey, "housekeeper");
    // A template applies: the permissions are ignored even if they cover more.
    const templated = resolveRoleTokens({
      templateKeys: ["receptionist"],
      grantedPermissions: ["housekeeping.task.manage", "pms.reservation.read", "pms.checkin.execute"],
      templatePermissions: TEMPLATES
    });
    assert.deepEqual(templated.tokens, ["recepcion"]);
    assert.equal(templated.fromPermissions, false);
    // Partial coverage is not enough; admin is never derived from permissions.
    assert.deepEqual(templatesCoveredByPermissions(["pms.reservation.read", "platform.admin"], TEMPLATES), []);
    assert.deepEqual(resolveRoleTokens({ templateKeys: ["custom"], grantedPermissions: [], templatePermissions: TEMPLATES }).tokens, []);
  });
});
