// Tanda 8a (RBAC · L1): the single reader of a user's scope
// (user_property_roles ∪ user_role_assignments, expanded to properties) and
// the pure helpers over it. No database: the in-memory Prisma fake of the
// rbac tests. Run from apps/api with
//   node --import tsx --test src/lib/__tests__/rbac-scope.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORG_PERMISSION_KEYS, ROLE_PERMISSION_MAP } from "@hotelos/shared";
import { fakePrisma, seedRoles, type Tables } from "../../modules/rbac/__tests__/fake-prisma.mts";
import { assignmentsFor, bumpRbacVersion, coversProperty, loadUserScope, maxRankOf, permissionsFor, type RbacScopeDb } from "../rbac-scope.js";

const ORG = "org_rbac";
const A = "prop_a";
const B = "prop_b";
const EIGHT = ["ra", "lt", "pg", "mc", "as", "fn", "ll", "oc"].map((code) => `prop_${code}`);
const LEGAL_ENTITY = "le_celuisma";
const GROUP = "grp_galicia";

function baseTables(): Partial<Tables> {
  return {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    property: [
      ...EIGHT.map((id, index) => ({ id, organizationId: ORG, legalEntityId: LEGAL_ENTITY, createdAt: new Date(2026, 0, index + 1) })),
      { id: A, organizationId: ORG, legalEntityId: LEGAL_ENTITY, createdAt: new Date(2026, 1, 1) },
      { id: B, organizationId: ORG, legalEntityId: LEGAL_ENTITY, createdAt: new Date(2026, 1, 2) },
      { id: "prop_other_org", organizationId: "org_other", legalEntityId: null, createdAt: new Date(2026, 1, 3) }
    ],
    propertyGroup: [{ id: GROUP, organizationId: ORG, code: "GAL", name: "Galicia" }],
    propertyGroupMember: [
      { id: "m1", propertyGroupId: GROUP, propertyId: A },
      { id: "m2", propertyGroupId: GROUP, propertyId: B }
    ]
  };
}

/** 222 keys: the legacy Owner role of Faranda before the template narrowing of L0. */
const LEGACY_OWNER_KEYS = ORG_PERMISSION_KEYS.slice(0, 222);

function setup(extra: (tables: Partial<Tables>, roles: ReturnType<typeof seedRoles>) => void) {
  const tables = baseTables();
  const roles = seedRoles(tables, ORG, {
    receptionist: ROLE_PERMISSION_MAP.receptionist,
    accountant: ROLE_PERMISSION_MAP.accountant,
    manager: ROLE_PERMISSION_MAP.manager,
    owner: LEGACY_OWNER_KEYS,
    general_manager: ROLE_PERMISSION_MAP.general_manager
  }, { levelOf: () => null });
  // A custom role (no template) with an explicit level.
  tables.role!.push({ id: "role_custom", organizationId: ORG, name: "Custom", templateKey: null, level: "supervisor", department: null, managed: false, templateVersion: 0 });
  tables.rolePermission!.push({ id: "rp_custom", roleId: "role_custom", permissionId: "perm_pms.reservation.read" });
  // A role of ANOTHER organisation referenced by a legacy row: must be ignored.
  tables.role!.push({ id: "role_foreign", organizationId: "org_other", name: "Foreign", templateKey: "owner", level: null, department: null, managed: true, templateVersion: 2 });
  tables.rolePermission!.push({ id: "rp_foreign", roleId: "role_foreign", permissionId: "perm_pms.reservation.read" });
  tables.userPropertyRole ??= [];
  tables.userRoleAssignment ??= [];
  extra(tables, roles);
  const db = fakePrisma(tables) as unknown as RbacScopeDb;
  return { db, roles, tables };
}

describe("loadUserScope · dual read of legacy roles and scoped assignments", () => {
  it("Recepción en A + Contabilidad en B: keys per property, intersection for the organisation routes, no orgScope", async () => {
    const { db, roles } = setup((tables, roles) => {
      tables.userPropertyRole!.push({ id: "upr_1", userId: "u1", propertyId: A, roleId: roles.receptionist.id });
      tables.userRoleAssignment!.push({ id: "ura_1", userId: "u1", roleId: roles.accountant.id, scopeType: "property", propertyId: B, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    });
    const scope = await loadUserScope("u1", ORG, db);
    assert.deepEqual(scope.assignedPropertyIds, [A, B]);
    assert.equal(scope.orgScope, false);
    assert.deepEqual(scope.scopes, [{ scopeType: "property", ref: A, propertyIds: [A] }, { scopeType: "property", ref: B, propertyIds: [B] }]);
    const inA = permissionsFor(scope, A);
    const inB = permissionsFor(scope, B);
    assert.ok(inA.includes("pms.reservation.create"), "reception creates reservations in A");
    assert.equal(inA.includes("accounting.journal.post"), false, "no accounting posting in A");
    assert.ok(inB.includes("accounting.journal.post"), "accounting posts in B");
    assert.equal(inB.includes("pms.reservation.create"), false, "no reservation creation in B");
    const org = permissionsFor(scope, null);
    const expected = ROLE_PERMISSION_MAP.receptionist.filter((key) => ROLE_PERMISSION_MAP.accountant.includes(key)).sort();
    assert.deepEqual(org, expected, "organisation routes = intersection of the property sets");
    assert.equal(permissionsFor(scope, "prop_ra").length, 0, "a property nobody covers → nothing");
    assert.equal(coversProperty(scope, A), true);
    assert.equal(coversProperty(scope, "prop_ra"), false);
    assert.equal(assignmentsFor(scope, null).mode, "intersection");
  });

  it("Owner ×8 (legacy rows): every property covered, 222 keys on the organisation routes, still no orgScope", async () => {
    const { db, roles } = setup((tables, roles) => {
      EIGHT.forEach((propertyId, index) => tables.userPropertyRole!.push({ id: `upr_${index}`, userId: "carmen", propertyId, roleId: roles.owner.id }));
    });
    const scope = await loadUserScope("carmen", ORG, db);
    assert.deepEqual(scope.assignedPropertyIds, EIGHT);
    assert.equal(scope.orgScope, false, "eight property rows are not an organisation assignment");
    assert.equal(permissionsFor(scope, null).length, 222);
    assert.equal(permissionsFor(scope, "prop_lt").length, 222);
    assert.equal(maxRankOf(scope, null), 6, "ownership rank on the organisation routes (min over identical rows)");
  });

  it("an organization assignment covers every property of the organisation and sets orgScope; legal_entity covers the sociedad", async () => {
    const { db, roles } = setup((tables, roles) => {
      tables.userRoleAssignment!.push({ id: "ura_org", userId: "dg", roleId: roles.general_manager.id, scopeType: "organization", propertyId: null, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
      tables.userRoleAssignment!.push({ id: "ura_le", userId: "cont", roleId: roles.accountant.id, scopeType: "legal_entity", propertyId: null, propertyGroupId: null, legalEntityId: LEGAL_ENTITY, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    });
    const dg = await loadUserScope("dg", ORG, db);
    assert.equal(dg.orgScope, true);
    assert.deepEqual([...dg.assignedPropertyIds].sort(), [...EIGHT, A, B].sort(), "never the property of another organisation");
    assert.deepEqual(permissionsFor(dg, null), [...ROLE_PERMISSION_MAP.general_manager].sort());
    assert.deepEqual(permissionsFor(dg, "prop_oc"), [...ROLE_PERMISSION_MAP.general_manager].sort());
    assert.equal(maxRankOf(dg, null), 5);
    const cont = await loadUserScope("cont", ORG, db);
    assert.equal(cont.orgScope, true);
    assert.deepEqual(cont.scopes, [{ scopeType: "legal_entity", ref: LEGAL_ENTITY, propertyIds: [...EIGHT, A, B] }]);
  });

  it("a property_group expands to its members (of the organisation only) and stays a narrow scope", async () => {
    const { db, roles } = setup((tables, roles) => {
      tables.propertyGroupMember!.push({ id: "m3", propertyGroupId: GROUP, propertyId: "prop_other_org" });
      tables.userRoleAssignment!.push({ id: "ura_grp", userId: "ops", roleId: roles.manager.id, scopeType: "property_group", propertyId: null, propertyGroupId: GROUP, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    });
    const scope = await loadUserScope("ops", ORG, db);
    assert.deepEqual(scope.assignedPropertyIds, [A, B]);
    assert.equal(scope.orgScope, false);
    assert.equal(maxRankOf(scope, A), 3);
    assert.equal(maxRankOf(scope, null), 3, "single narrow assignment → its own rank");
  });

  it("revoked, expired and not-yet-valid assignments are out; a role of another organisation is ignored; no assignments → []", async () => {
    const { db, roles } = setup((tables, roles) => {
      const past = new Date(Date.now() - 60_000);
      tables.userRoleAssignment!.push({ id: "ura_rev", userId: "u2", roleId: roles.manager.id, scopeType: "property", propertyId: A, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: past, validTo: null, revokedAt: past, createdAt: past });
      tables.userRoleAssignment!.push({ id: "ura_exp", userId: "u2", roleId: roles.manager.id, scopeType: "property", propertyId: B, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: past, validTo: past, revokedAt: null, createdAt: past });
      tables.userRoleAssignment!.push({ id: "ura_future", userId: "u2", roleId: roles.manager.id, scopeType: "organization", propertyId: null, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() + 60_000), validTo: null, revokedAt: null, createdAt: past });
      tables.userPropertyRole!.push({ id: "upr_foreign", userId: "u2", propertyId: A, roleId: "role_foreign" });
    });
    const scope = await loadUserScope("u2", ORG, db);
    assert.deepEqual(scope.assignments, []);
    assert.deepEqual(scope.assignedPropertyIds, []);
    assert.equal(scope.orgScope, false);
    assert.deepEqual(permissionsFor(scope, A), []);
    assert.deepEqual(permissionsFor(scope, null), []);
    assert.equal(maxRankOf(scope, null), 0);
    const nobody = await loadUserScope("u_none", ORG, db);
    assert.deepEqual(nobody.allPermissions, []);
  });

  it("a custom role without template uses Role.level for the rank (and 1 without level)", async () => {
    const { db } = setup((tables, roles) => {
      tables.userRoleAssignment!.push({ id: "ura_custom", userId: "u3", roleId: "role_custom", scopeType: "property", propertyId: A, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    });
    const scope = await loadUserScope("u3", ORG, db);
    assert.equal(scope.assignments[0]?.templateKey, null);
    assert.equal(scope.assignments[0]?.level, "supervisor");
    assert.equal(maxRankOf(scope, A), 2);
    assert.deepEqual(permissionsFor(scope, A), ["pms.reservation.read"]);
  });

  it("bumpRbacVersion increments organizations.rbac_version (the memo of live sessions is keyed on it)", async () => {
    const { db } = setup(() => undefined);
    assert.equal(await bumpRbacVersion(ORG, db), 1);
    assert.equal(await bumpRbacVersion(ORG, db), 2);
    const scope = await loadUserScope("u_none", ORG, db);
    assert.equal(scope.rbacVersion, 2);
  });
});
