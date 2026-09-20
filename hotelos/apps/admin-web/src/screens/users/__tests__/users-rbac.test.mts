import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORG_PERMISSION_KEYS, ROLE_LEVEL_RANK, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_KEYS, ROLE_TEMPLATE_LEVEL, SOD_STATIC_PAIRS, type UserRoleAssignmentDto } from "@hotelos/shared";
import {
  MODULE_OF_PREFIX,
  MODULE_ORDER,
  OFFERABLE_TEMPLATES,
  assignableTemplates,
  assignmentsCovering,
  callerMaxRank,
  canManageRow,
  compareTemplates,
  describeSodWarning,
  hotelsOf,
  identicalRoles,
  levelWarningFor,
  moduleOfPermission,
  primaryAssignment,
  rankOfTemplate,
  scopeWithinReach,
  sodWarningsFor,
  templateLabel
} from "../users-rbac.ts";

// Usuarios y roles (Tanda 8a · L4): the pure helpers behind the assignment
// drawer, the comparator and the rows.

function assignment(overrides: Partial<UserRoleAssignmentDto>): UserRoleAssignmentDto {
  return {
    id: "a1",
    userId: "u1",
    roleId: "r1",
    roleName: "Recepción",
    templateKey: "receptionist",
    level: "operative",
    scopeType: "property",
    propertyId: "p1",
    propertyGroupId: null,
    legalEntityId: null,
    organizationId: "org",
    validFrom: "2026-09-18T00:00:00.000Z",
    validTo: null,
    revokedAt: null,
    reason: null,
    grantedByUserId: null,
    ...overrides
  };
}

describe("users-rbac · §4.3 dictionary prefix → module", () => {
  it("assigns every key of the organisation catalogue to a module (never the platform fallback for hotel keys)", () => {
    const fallback = ORG_PERMISSION_KEYS.filter((key) => moduleOfPermission(key) === "PLAT" && !key.startsWith("security."));
    assert.deepEqual(fallback, [], "hotel keys without module");
    const prefixes = new Set(ORG_PERMISSION_KEYS.map((key) => key.split(".")[0]));
    for (const prefix of prefixes) assert.ok(prefix in MODULE_OF_PREFIX, `prefix ${prefix} missing from MODULE_OF_PREFIX`);
  });

  it("places the exceptions of §4.3 in M20 / M15b and keeps the module order", () => {
    assert.equal(moduleOfPermission("billing.configure"), "M20");
    assert.equal(moduleOfPermission("payments.configure"), "M20");
    assert.equal(moduleOfPermission("accounting.entity.read"), "M20");
    assert.equal(moduleOfPermission("compliance.configure"), "M15b");
    assert.equal(moduleOfPermission("compliance.read"), "M15");
    assert.equal(moduleOfPermission("pms.reservation.read"), "M1");
    assert.equal(moduleOfPermission("security.break_glass"), "PLAT");
    assert.equal(moduleOfPermission("admin.tenants.manage"), "PLAT");
    assert.equal(MODULE_ORDER[0], "M1");
    assert.equal(MODULE_ORDER[MODULE_ORDER.length - 1], "PLAT");
  });
});

describe("users-rbac · levels, ranks and offerable templates", () => {
  it("ranks templates through ROLE_LEVEL_RANK and never offers break_glass", () => {
    assert.equal(rankOfTemplate("receptionist"), 1);
    assert.equal(rankOfTemplate("front_office_manager"), 2);
    assert.equal(rankOfTemplate("manager"), 3);
    assert.equal(rankOfTemplate("general_manager"), 5);
    assert.equal(rankOfTemplate("owner"), 6);
    assert.equal(rankOfTemplate("custom"), null);
    assert.equal(rankOfTemplate(null), null);
    assert.ok(!OFFERABLE_TEMPLATES.includes("break_glass"));
    assert.equal(OFFERABLE_TEMPLATES.length, ROLE_TEMPLATE_KEYS.length - 1);
    for (const key of assignableTemplates(2, false)) assert.ok(ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[key]] <= 2, key);
    assert.ok(assignableTemplates(2, false).includes("front_office_manager"));
    assert.ok(!assignableTemplates(2, false).includes("manager"));
    assert.deepEqual(assignableTemplates(null, false), []);
    assert.deepEqual(assignableTemplates(null, true), [...OFFERABLE_TEMPLATES]);
    assert.equal(callerMaxRank(["receptionist", "manager", "x"]), 3);
    assert.equal(callerMaxRank([]), null);
  });

  it("explains the «nivel ≤ propio» rule and the scope rule before the API does", () => {
    assert.equal(levelWarningFor(3, 3, false), null);
    assert.match(levelWarningFor(5, 3, false) ?? "", /RBAC_LEVEL_EXCEEDED/);
    assert.match(levelWarningFor(1, null, false) ?? "", /403/);
    assert.equal(levelWarningFor(6, null, true), null, "the platform administrator assigns anything");
    assert.ok(scopeWithinReach("property", ["property"], false));
    assert.ok(!scopeWithinReach("organization", ["property"], false));
    assert.ok(scopeWithinReach("property_group", ["legal_entity"], false));
    assert.ok(scopeWithinReach("organization", [], true));
  });
});

describe("users-rbac · separation of duties (§4.7)", () => {
  it("no offerable template violates a static pair on its own (break_glass holds everything and is never offered); a combination can", () => {
    for (const key of OFFERABLE_TEMPLATES) assert.deepEqual(sodWarningsFor([key]), [], `${key} alone`);
    assert.ok(sodWarningsFor(["break_glass"]).length > 0);
    const clerkAndDirector = sodWarningsFor(["admin_clerk", "manager"]);
    assert.ok(clerkAndDirector.some((warning) => warning.pair.a === "payables.create" && warning.pair.b === "payables.approve"), "registrar + aprobar facturas de proveedor");
    const warning = clerkAndDirector[0];
    assert.match(describeSodWarning(warning), /no pueden coincidir en la misma persona/);
    assert.ok(warning.holdersA.length > 0 && warning.holdersB.length > 0);
  });

  it("the controller exception applies alone but not once combined with another approver", () => {
    assert.deepEqual(sodWarningsFor(["controller"]), []);
    const combined = sodWarningsFor(["controller", "accountant"]);
    assert.ok(combined.some((warning) => warning.pair.a === "payables.approve" && warning.pair.b === "payables.pay"));
    assert.ok(SOD_STATIC_PAIRS.some((pair) => pair.except?.includes("controller")));
  });
});

describe("users-rbac · comparator and identical roles (§5.4)", () => {
  it("groups the keys of two templates by module: only A, both, only B", () => {
    const rows = compareTemplates(ROLE_PERMISSION_MAP.receptionist, ROLE_PERMISSION_MAP.front_office_manager);
    assert.ok(rows.length > 0);
    const total = rows.reduce((sum, row) => sum + row.onlyA.length + row.onlyB.length + row.both.length, 0);
    assert.equal(total, new Set([...ROLE_PERMISSION_MAP.receptionist, ...ROLE_PERMISSION_MAP.front_office_manager]).size);
    for (const row of rows) {
      assert.ok(row.onlyA.every((key) => !ROLE_PERMISSION_MAP.front_office_manager.includes(key)));
      assert.ok(row.both.every((key) => ROLE_PERMISSION_MAP.receptionist.includes(key) && ROLE_PERMISSION_MAP.front_office_manager.includes(key)));
    }
    const order = rows.map((row) => MODULE_ORDER.indexOf(row.module));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "modules in §4.3 order");
  });

  it("compareTemplates tolera plantillas sin claves", () => {
    // FIX-1 · F6: a template the served catalogue does not know (a stale compiled
    // permissions.js shadowing the source) threw «b is not iterable»; an undefined
    // side now counts as empty and the rows come from the other side only.
    const size = new Set(ROLE_PERMISSION_MAP.receptionist).size;
    const onlyLeft = compareTemplates(ROLE_PERMISSION_MAP.receptionist, undefined);
    assert.ok(onlyLeft.length > 0);
    assert.equal(onlyLeft.reduce((sum, row) => sum + row.onlyA.length, 0), size);
    assert.ok(onlyLeft.every((row) => row.both.length === 0 && row.onlyB.length === 0), "nothing on the B side");
    const onlyRight = compareTemplates(undefined, ROLE_PERMISSION_MAP.receptionist);
    assert.ok(onlyRight.length > 0);
    assert.equal(onlyRight.reduce((sum, row) => sum + row.onlyB.length, 0), size);
    assert.ok(onlyRight.every((row) => row.both.length === 0 && row.onlyA.length === 0), "nothing on the A side");
    assert.deepEqual(compareTemplates(undefined, undefined), []);
    assert.deepEqual(compareTemplates([], undefined), []);
    const twins = identicalRoles([
      { id: "a", name: "A", permissions: undefined },
      { id: "b", name: "B", permissions: [] },
      { id: "c", name: "C", permissions: ["x.read"] }
    ]);
    assert.equal(twins.length, 1, "undefined and [] share the empty signature");
    assert.deepEqual(twins[0].roles.map((role) => role.id), ["a", "b"]);
    assert.equal(twins[0].permissionCount, 0);
  });

  it("todas las OFFERABLE_TEMPLATES tienen claves en ROLE_PERMISSION_MAP", () => {
    assert.ok(OFFERABLE_TEMPLATES.length >= 2, "the drawer opens on the first two offerable templates");
    for (const key of OFFERABLE_TEMPLATES) {
      assert.ok(Array.isArray(ROLE_PERMISSION_MAP[key]), `${key}: sin claves en ROLE_PERMISSION_MAP`);
      assert.ok(ROLE_PERMISSION_MAP[key].length > 0, `${key}: plantilla sin ninguna clave`);
    }
    assert.ok(Array.isArray(ROLE_PERMISSION_MAP.receptionist) && Array.isArray(ROLE_PERMISSION_MAP.front_office_manager), "fallback pair of the drawer");
  });

  it("finds roles with identical key sets and drops singletons", () => {
    const twins = identicalRoles([
      { id: "a", name: "A", permissions: ["x.read", "y.read"] },
      { id: "b", name: "B", permissions: ["y.read", "x.read"] },
      { id: "c", name: "C", permissions: ["x.read"] }
    ]);
    assert.equal(twins.length, 1);
    assert.deepEqual(twins[0].roles.map((role) => role.id), ["a", "b"]);
    assert.equal(twins[0].permissionCount, 2);
    const templates = ROLE_TEMPLATE_KEYS.map((key) => ({ id: key, name: key, permissions: ROLE_PERMISSION_MAP[key] }));
    assert.deepEqual(identicalRoles(templates), [], "no two catalogue templates are identical");
  });
});

describe("users-rbac · rows of the screen", () => {
  it("picks the widest scope as the primary assignment, then the highest rank", () => {
    const rows = [
      assignment({ id: "1", templateKey: "receptionist", level: "operative", scopeType: "property" }),
      assignment({ id: "2", templateKey: "accountant", level: "central_admin", scopeType: "legal_entity", propertyId: null, legalEntityId: "le" }),
      assignment({ id: "3", templateKey: "front_office_manager", level: "supervisor", scopeType: "property", revokedAt: "2026-09-18T10:00:00.000Z" })
    ];
    assert.equal(primaryAssignment(rows)?.id, "2");
    assert.equal(primaryAssignment([rows[0], rows[2]])?.id, "1", "revoked rows never win");
    assert.equal(primaryAssignment([]), null);
    assert.deepEqual(assignmentsCovering(rows, "p1").map((row) => row.id), ["1", "2"]);
    assert.deepEqual(hotelsOf(rows, new Map([["p1", "Los Tilos"]])), ["Los Tilos", "Sociedad"]);
  });

  it("labels templates in Spanish, custom roles by name, and never lets a user manage their own row", () => {
    assert.equal(templateLabel("receptionist"), "Recepción");
    assert.equal(templateLabel("admin"), "Administración de sistema");
    assert.equal(templateLabel(null, "Local Super Admin"), "Local Super Admin");
    assert.equal(templateLabel(null, " "), "Rol personalizado");
    assert.ok(canManageRow("u2", "u1"));
    assert.ok(!canManageRow("u1", "u1"));
    assert.ok(!canManageRow("u1", null));
  });
});
