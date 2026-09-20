import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MOBILE_BREAKPOINT_PX,
  NO_ROLE_HOME,
  ROLE_TEMPLATE_KEYS_MAPPED,
  ROLE_TEMPLATE_TO_TOKEN,
  ROLE_TOKENS,
  ROLE_TOKEN_LABELS,
  ROLE_TOKEN_PRIORITY,
  canSee,
  isRoleTemplateKey,
  isRoleToken,
  moduleAllows,
  navVisibility,
  primaryRoleToken,
  roleAllows,
  roleHome,
  roleHomeForTokens,
  roleTokenFromTemplate,
  roleTokensFromTemplates
} from "../role-tokens.ts";

describe("role-tokens · derivation from template keys", () => {
  it("maps the 24 RBAC templates to the 16 CSV tokens (Tanda 8a design §4.2)", () => {
    assert.deepEqual(ROLE_TEMPLATE_TO_TOKEN, {
      receptionist: "recepcion",
      night_auditor: "recepcion",
      front_office_manager: "recepcion",
      housekeeper: "pisos",
      housekeeping_manager: "pisos",
      maintenance: "mantenimiento",
      maintenance_manager: "mantenimiento",
      fnb: "fnb",
      fnb_manager: "fnb",
      sales: "comercial",
      admin_clerk: "administracion",
      manager: "direccion",
      operations_director: "direccion",
      general_manager: "direccion",
      break_glass: "direccion",
      revenue: "revenue",
      accountant: "finanzas",
      controller: "finanzas",
      compliance: "finanzas",
      payroll_hr: "rrhh",
      asset_manager: "activos",
      owner: "propiedad",
      auditor: "auditoria",
      admin: "sistemas"
    });
    assert.equal(ROLE_TEMPLATE_KEYS_MAPPED.length, 24);
    for (const key of ROLE_TEMPLATE_KEYS_MAPPED) assert.ok(isRoleTemplateKey(key));
    // The `admin` token is the platform administrator's only (H11): no template yields it.
    assert.ok(!Object.values(ROLE_TEMPLATE_TO_TOKEN).includes("admin"));
  });

  it("returns null for custom roles and is case/space tolerant", () => {
    assert.equal(roleTokenFromTemplate("Owner "), "propiedad");
    assert.equal(roleTokenFromTemplate("night_auditor"), "recepcion");
    assert.equal(roleTokenFromTemplate("local_super_admin"), null);
    assert.equal(roleTokenFromTemplate(null), null);
    assert.equal(roleTokenFromTemplate(undefined), null);
    assert.equal(roleTokenFromTemplate(""), null);
  });

  it("unions several templates, deduplicated and in priority order", () => {
    assert.deepEqual(roleTokensFromTemplates(["accountant", "compliance", "owner"]), ["propiedad", "finanzas"]);
    assert.deepEqual(roleTokensFromTemplates(["housekeeper", "custom", null]), ["pisos"]);
    assert.deepEqual(roleTokensFromTemplates(["admin", "auditor", "admin_clerk"]), ["sistemas", "auditoria", "administracion"]);
    assert.deepEqual(roleTokensFromTemplates([]), []);
    assert.equal(primaryRoleToken(["pisos", "recepcion"]), "recepcion");
    assert.equal(primaryRoleToken(["rrhh", "activos"]), "rrhh");
    assert.equal(primaryRoleToken([]), null);
  });

  it("exposes the sixteen tokens with Spanish labels and a total priority order (admin, sistemas, direccion, propiedad, auditoria, finanzas, rrhh, activos, revenue, comercial, administracion, recepcion, fnb, mantenimiento, pisos, publico)", () => {
    assert.equal(ROLE_TOKENS.length, 16);
    for (const token of ROLE_TOKENS) {
      assert.ok(isRoleToken(token));
      assert.ok(ROLE_TOKEN_LABELS[token].length > 0);
      assert.ok(ROLE_TOKEN_PRIORITY.includes(token), `${token} missing from priority`);
    }
    assert.deepEqual(ROLE_TOKEN_PRIORITY, ["admin", "sistemas", "direccion", "propiedad", "auditoria", "finanzas", "rrhh", "activos", "revenue", "comercial", "administracion", "recepcion", "fnb", "mantenimiento", "pisos", "publico"]);
    assert.equal(ROLE_TOKEN_LABELS.administracion, "Administración de hotel");
    assert.equal(ROLE_TOKEN_LABELS.rrhh, "RRHH y nóminas");
    assert.equal(ROLE_TOKEN_LABELS.propiedad, "Propiedad");
    assert.equal(ROLE_TOKEN_LABELS.activos, "Gestión del activo");
    assert.equal(ROLE_TOKEN_LABELS.auditoria, "Auditoría interna");
    assert.equal(ROLE_TOKEN_LABELS.sistemas, "Administración de sistema");
    assert.equal(isRoleToken("all"), false);
    assert.equal(isRoleToken("reception"), false);
  });
});

describe("role-tokens · roleHome (§3)", () => {
  it("lands each role where the tree says", () => {
    assert.equal(roleHome("direccion"), "/hoy/direccion");
    assert.equal(roleHome("direccion", { templateKey: "owner" }), "/hoy/propietario");
    assert.equal(roleHome("direccion", { templateKey: "manager" }), "/hoy/direccion");
    assert.equal(roleHome("recepcion"), "/hoy");
    assert.equal(roleHome("revenue"), "/hoy/direccion");
    assert.equal(roleHome("finanzas"), "/hoy/direccion");
    assert.equal(roleHome("comercial"), "/hoy/direccion");
    assert.equal(roleHome("admin"), "/hoy/direccion");
    assert.equal(roleHome("fnb"), "/hoy/operaciones");
    assert.equal(roleHome("publico"), "/acceso");
  });

  it("lands the six Tanda 8a tokens on their own screen (design §4.9 / §10.2)", () => {
    assert.equal(roleHome("administracion"), "/finanzas/facturacion");
    assert.equal(roleHome("rrhh"), "/finanzas/nominas");
    assert.equal(roleHome("propiedad"), "/hoy/propietario");
    assert.equal(roleHome("activos"), "/finanzas/activo-inmobiliario"); // Tanda ACT · F4: Finanzas › Activo inmobiliario (before: Cumplimiento › Centro de cumplimiento)
    assert.equal(roleHome("auditoria"), "/configuracion/sistema");
    assert.equal(roleHome("sistemas"), "/configuracion/usuarios");
    assert.equal(roleHomeForTokens(["recepcion", "sistemas"]), "/configuracion/usuarios", "sistemas outranks recepcion");
    assert.equal(roleHomeForTokens(["propiedad", "auditoria"]), "/hoy/propietario");
  });

  it("uses the mobile tab for housekeeping and maintenance below 700 px", () => {
    assert.equal(MOBILE_BREAKPOINT_PX, 700);
    assert.equal(roleHome("pisos"), "/hoy/operaciones");
    assert.equal(roleHome("pisos", { mobile: true }), "/operaciones/pisos/mi-turno");
    assert.equal(roleHome("mantenimiento"), "/hoy/operaciones");
    assert.equal(roleHome("mantenimiento", { mobile: true }), "/operaciones/mantenimiento/mis-averias");
    assert.equal(roleHome("fnb", { mobile: true }), "/hoy/operaciones");
  });

  it("falls back to Mi día without a role and picks the primary token for multi-role users", () => {
    assert.equal(roleHome(null), NO_ROLE_HOME);
    assert.equal(roleHome(undefined), "/hoy");
    assert.equal(roleHomeForTokens([]), "/hoy");
    assert.equal(roleHomeForTokens(["pisos", "direccion"], { mobile: true, templateKey: "owner" }), "/hoy/propietario");
    assert.equal(roleHomeForTokens(["pisos", "mantenimiento"], { mobile: true }), "/operaciones/mantenimiento/mis-averias");
  });
});

describe("role-tokens · canSee / navVisibility (§3 + §6)", () => {
  const gated = { roles: ["comercial", "direccion", "admin"], modulesAny: ["guest_data_crm_loyalty"] };
  const core = { roles: ["recepcion", "direccion", "admin"], modulesAny: [] };

  it("requires a matching token and an enabled module", () => {
    assert.equal(roleAllows(gated, ["comercial"]), true);
    assert.equal(roleAllows(gated, ["recepcion"]), false);
    assert.equal(roleAllows({ roles: [] }, []), true);
    assert.equal(roleAllows({ roles: ["publico"] }, []), true);
    assert.equal(moduleAllows(gated, ["guest_data_crm_loyalty"]), true);
    assert.equal(moduleAllows(gated, ["pms_core"]), false);
    assert.equal(moduleAllows(core, []), true);
    assert.equal(canSee(gated, ["comercial"], ["guest_data_crm_loyalty"]), true);
    assert.equal(canSee(gated, ["comercial"], []), false);
    assert.equal(canSee(gated, ["recepcion"], ["guest_data_crm_loyalty"]), false);
    assert.equal(canSee(core, ["recepcion"], []), true);
  });

  it("admin is not exempt from the module gate (the API answers 403 regardless of role)", () => {
    assert.equal(canSee(gated, ["admin"], []), false);
    assert.equal(canSee(gated, ["admin"], ["guest_data_crm_loyalty"]), true);
  });

  it("shows a locked entry only to users who can enable modules", () => {
    assert.equal(navVisibility(gated, ["comercial"], ["guest_data_crm_loyalty"]), "visible");
    assert.equal(navVisibility(gated, ["comercial"], []), "hidden");
    assert.equal(navVisibility(gated, ["direccion"], [], { canEnableModules: true }), "locked");
    assert.equal(navVisibility(gated, ["recepcion"], [], { canEnableModules: true }), "hidden");
    assert.equal(navVisibility(core, ["recepcion"], []), "visible");
  });
});
