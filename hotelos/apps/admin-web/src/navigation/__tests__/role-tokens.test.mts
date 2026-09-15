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
  it("maps every RBAC template to the CSV token (§8)", () => {
    assert.deepEqual(ROLE_TEMPLATE_TO_TOKEN, {
      owner: "direccion",
      admin: "admin",
      manager: "direccion",
      receptionist: "recepcion",
      housekeeper: "pisos",
      maintenance: "mantenimiento",
      accountant: "finanzas",
      compliance: "finanzas",
      revenue: "revenue",
      sales: "comercial",
      fnb: "fnb"
    });
    assert.equal(ROLE_TEMPLATE_KEYS_MAPPED.length, 11);
    for (const key of ROLE_TEMPLATE_KEYS_MAPPED) assert.ok(isRoleTemplateKey(key));
  });

  it("returns null for custom roles and is case/space tolerant", () => {
    assert.equal(roleTokenFromTemplate("Owner "), "direccion");
    assert.equal(roleTokenFromTemplate("night_auditor"), null);
    assert.equal(roleTokenFromTemplate(null), null);
    assert.equal(roleTokenFromTemplate(undefined), null);
    assert.equal(roleTokenFromTemplate(""), null);
  });

  it("unions several templates, deduplicated and in priority order", () => {
    assert.deepEqual(roleTokensFromTemplates(["accountant", "compliance", "owner"]), ["direccion", "finanzas"]);
    assert.deepEqual(roleTokensFromTemplates(["housekeeper", "custom", null]), ["pisos"]);
    assert.deepEqual(roleTokensFromTemplates([]), []);
    assert.equal(primaryRoleToken(["pisos", "recepcion"]), "recepcion");
    assert.equal(primaryRoleToken([]), null);
  });

  it("exposes the ten tokens with Spanish labels and a total priority order", () => {
    assert.equal(ROLE_TOKENS.length, 10);
    for (const token of ROLE_TOKENS) {
      assert.ok(isRoleToken(token));
      assert.ok(ROLE_TOKEN_LABELS[token].length > 0);
      assert.ok(ROLE_TOKEN_PRIORITY.includes(token), `${token} missing from priority`);
    }
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
