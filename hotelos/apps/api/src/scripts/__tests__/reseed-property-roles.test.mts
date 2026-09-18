// Pure unit tests for the template-role re-seed CLI (Tanda 5 · L1a · rbac).
// No database: flag parsing, the confirm guard, the plan (top-up / adopt /
// create / conflict / platform skip) and the summary. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/reseed-property-roles.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORGANIZATION_TEMPLATE_ROLE_KEYS, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_KEYS, ROLE_TEMPLATE_LABELS_ES } from "@hotelos/shared";
import { resolveTemplateKeyForRoleName, templatePermissionKeys } from "../../lib/rbac-catalog.js";
import {
  USAGE,
  assertConfirmMatches,
  parseFlags,
  planHasConflicts,
  planTemplateRoles,
  summarizePlan,
  type RoleRow
} from "../reseed-property-roles.js";

const ORG = "org_test";

function keys(roleId: string, list: readonly string[]): [string, Set<string>] {
  return [roleId, new Set(list)];
}

describe("parseFlags", () => {
  it("defaults to dry-run with every organisation template", () => {
    const flags = parseFlags(["--org", ORG]);
    assert.deepEqual(flags, { org: ORG, apply: false, confirm: null, templates: [...ORGANIZATION_TEMPLATE_ROLE_KEYS], json: false, help: false });
  });
  it("--help short-circuits the other validations and USAGE names every flag", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["-h"]).help, true);
    assert.equal(parseFlags(["--apply", "--help"]).help, true);
    for (const flag of ["--org", "--dry-run", "--apply", "--confirm", "--templates", "--json", "--help"]) assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
  });
  it("requires --org and rejects unknown flags / duplicated values", () => {
    assert.throws(() => parseFlags([]), /--org/);
    assert.throws(() => parseFlags(["--org", ORG, "--nope"]), /Unknown flag/);
    assert.throws(() => parseFlags(["--org", ORG, "--org", "x"]), /only once/);
    assert.throws(() => parseFlags(["--org"]), /requires a value/);
  });
  it("--apply requires --confirm and --dry-run excludes --apply", () => {
    assert.throws(() => parseFlags(["--org", ORG, "--apply"]), /--confirm/);
    assert.throws(() => parseFlags(["--org", ORG, "--confirm", ORG]), /only makes sense/);
    assert.throws(() => parseFlags(["--org", ORG, "--dry-run", "--apply", "--confirm", ORG]), /mutually exclusive/);
    const flags = parseFlags(["--org", ORG, "--apply", "--confirm", ORG, "--json"]);
    assert.equal(flags.apply, true);
    assert.equal(flags.json, true);
  });
  it("--templates narrows to known organisation templates, in canonical order", () => {
    const flags = parseFlags(["--org", ORG, "--templates", "fnb,receptionist"]);
    assert.deepEqual(flags.templates, ["receptionist", "fnb"]);
    assert.throws(() => parseFlags(["--org", ORG, "--templates", "admin"]), /Unknown template "admin"/);
    assert.throws(() => parseFlags(["--org", ORG, "--templates", ","]), /at least one/);
  });
  it("assertConfirmMatches guards against a different organisation", () => {
    assert.throws(() => assertConfirmMatches({ org: ORG, apply: true, confirm: "other", templates: [], json: false, help: false }), /does not match/);
    assert.doesNotThrow(() => assertConfirmMatches({ org: ORG, apply: true, confirm: ORG, templates: [], json: false, help: false }));
    assert.doesNotThrow(() => assertConfirmMatches({ org: ORG, apply: false, confirm: null, templates: [], json: false, help: false }));
  });
});

describe("shared template catalogue (Tanda 5)", () => {
  it("has sales and fnb templates, labelled in Spanish and resolvable by name", () => {
    assert.ok(ROLE_TEMPLATE_KEYS.includes("sales"));
    assert.ok(ROLE_TEMPLATE_KEYS.includes("fnb"));
    assert.ok(ROLE_PERMISSION_MAP.sales.length >= 20);
    assert.ok(ROLE_PERMISSION_MAP.fnb.length >= 10);
    for (const key of ROLE_TEMPLATE_KEYS) {
      const label = ROLE_TEMPLATE_LABELS_ES[key];
      assert.ok(label && label.length > 0, `${key} has no Spanish label`);
      assert.equal(resolveTemplateKeyForRoleName(label), key, `label «${label}» must resolve back to ${key}`);
    }
    assert.equal(ORGANIZATION_TEMPLATE_ROLE_KEYS.includes("admin"), false, "admin is the platform token; not materialised per organisation");
    assert.ok(ORGANIZATION_TEMPLATE_ROLE_KEYS.includes("owner"));
  });
});

describe("planTemplateRoles", () => {
  const roles: RoleRow[] = [
    { id: "r_owner", organizationId: ORG, name: "Owner", templateKey: null },
    { id: "r_manager", organizationId: ORG, name: "Manager", templateKey: "manager" },
    { id: "r_custom", organizationId: ORG, name: "Turno de noche", templateKey: null },
    { id: "r_other_org", organizationId: "org_other", name: "Recepción", templateKey: "receptionist" }
  ];
  const ownerKeys = templatePermissionKeys("owner");
  const managerKeys = templatePermissionKeys("manager");
  const keysByRole = new Map<string, Set<string>>([
    keys("r_owner", ownerKeys.slice(0, ownerKeys.length - 5)),
    keys("r_manager", managerKeys.slice(0, 10)),
    keys("r_custom", ["pms.reservation.read", "audit.read"]),
    keys("r_other_org", templatePermissionKeys("receptionist"))
  ]);

  it("tops up stamped roles, adopts template-named roles and creates the rest with Spanish names", () => {
    const plan = planTemplateRoles({ organizationId: ORG, templates: ["owner", "manager", "receptionist", "fnb"], roles, keysByRole });
    const byKey = Object.fromEntries(plan.templates.map((t) => [t.templateKey, t]));
    assert.equal(byKey.owner.action, "adopt");
    assert.equal(byKey.owner.roleId, "r_owner");
    assert.equal(byKey.owner.missing, 5);
    assert.equal(byKey.manager.action, "top-up");
    assert.equal(byKey.manager.missing, managerKeys.length - 10);
    assert.equal(byKey.receptionist.action, "create");
    assert.equal(byKey.receptionist.roleName, "Recepción");
    assert.equal(byKey.receptionist.missing, templatePermissionKeys("receptionist").length);
    assert.equal(byKey.fnb.action, "create");
    assert.equal(byKey.fnb.roleName, "Punto de venta");
    assert.equal(planHasConflicts(plan), false);
    assert.deepEqual(plan.skipped.map((s) => s.roleId), ["r_custom"]);
    assert.match(plan.skipped[0]!.reason, /personalizado/);
    assert.ok(!plan.templates.some((t) => t.roleId === "r_other_org"), "roles of another organisation are never touched");
  });

  it("reports +0 once converged (idempotent)", () => {
    const converged = new Map<string, Set<string>>([keys("r_manager", managerKeys)]);
    const plan = planTemplateRoles({ organizationId: ORG, templates: ["manager"], roles: [roles[1]!], keysByRole: converged });
    assert.deepEqual(plan.templates.map((t) => [t.action, t.missing]), [["top-up", 0]]);
  });

  it("flags a conflict instead of shadowing a custom role that carries the template's name", () => {
    const custom: RoleRow[] = [{ id: "r_rec", organizationId: ORG, name: "Recepción", templateKey: null }];
    const withExtra = new Map<string, Set<string>>([keys("r_rec", ["pms.reservation.read", "roles.manage"])]);
    const plan = planTemplateRoles({ organizationId: ORG, templates: ["receptionist"], roles: custom, keysByRole: withExtra });
    assert.equal(plan.templates[0]!.action, "conflict");
    assert.match(plan.templates[0]!.reason ?? "", /personalizado/);
    assert.equal(planHasConflicts(plan), true);
    const stampedOther: RoleRow[] = [{ id: "r_rec2", organizationId: ORG, name: "Recepción", templateKey: "manager" }];
    const plan2 = planTemplateRoles({ organizationId: ORG, templates: ["receptionist"], roles: stampedOther, keysByRole: new Map() });
    assert.equal(plan2.templates[0]!.action, "conflict");
    assert.match(plan2.templates[0]!.reason ?? "", /sigue la plantilla "manager"/);
  });

  it("skips platform roles and unknown template keys", () => {
    const rows: RoleRow[] = [
      { id: "r_platform", organizationId: ORG, name: "Local Super Admin", templateKey: null },
      { id: "r_weird", organizationId: ORG, name: "Algo", templateKey: "nope" }
    ];
    const kb = new Map<string, Set<string>>([keys("r_platform", ["admin.tenants.manage", "audit.read"]), keys("r_weird", ["audit.read"])]);
    const plan = planTemplateRoles({ organizationId: ORG, templates: ["owner"], roles: rows, keysByRole: kb, platformOrganizations: new Set([ORG]) });
    assert.equal(plan.templates[0]!.action, "create");
    // Tanda 8a (design §4.2): the owner template is «Propiedad» (no longer «todo»).
    assert.equal(plan.templates[0]!.roleName, "Propiedad");
    assert.deepEqual(
      plan.skipped.map((s) => [s.roleId, /plataforma/.test(s.reason) || /desconocido/.test(s.reason)]),
      [["r_platform", true], ["r_weird", true]]
    );
  });

  it("summarizes the plan with the per-property assignment report", () => {
    const plan = planTemplateRoles({ organizationId: ORG, templates: ["owner", "receptionist"], roles, keysByRole });
    const text = summarizePlan(plan, [{ propertyId: "p1", propertyName: "Hotel", assignments: { owner: 1, receptionist: 0 }, usersOnCustomRoles: 2 }], "dry-run");
    assert.match(text, /dry-run \(sin escrituras\)/);
    assert.match(text, /owner\s+adopt\s+Owner/);
    assert.match(text, /receptionist\s+create\s+Recepción/);
    assert.match(text, /1 rol\(es\) a crear · 1 a adoptar/);
    assert.match(text, /Hotel \(p1\): owner=1 · 2 en roles personalizados/);
  });
});
