// Tanda 8a (RBAC · L1): assignments (scope ⊆ own, level ≤ own, never self,
// opaque 404 for foreign / platform / emergency roles, static SoD, break
// glass forbidden), revocation, roles and users in scope. No database (fake
// Prisma). From apps/api:
//   node --import tsx --test src/modules/rbac/__tests__/assignments.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import {
  createAssignment,
  createRoleFromTemplate,
  editRolePermissions,
  listAssignments,
  listRoles,
  listUsersInScope,
  revokeAssignment,
  sodConflictsAmong,
  updatePropertyGroup,
  createPropertyGroup,
  type RbacDeps
} from "../assignments.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "./fake-prisma.mts";

const ORG = "org_asg";
const A = "prop_a";
const B = "prop_b";
const LEGAL_ENTITY = "le_test";
const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;

function setup() {
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    legalEntity: [{ id: LEGAL_ENTITY, organizationId: ORG, isDefault: true, status: "active" }],
    property: [
      { id: A, organizationId: ORG, legalEntityId: LEGAL_ENTITY, createdAt: new Date(2026, 0, 1) },
      { id: B, organizationId: ORG, legalEntityId: LEGAL_ENTITY, createdAt: new Date(2026, 0, 2) },
      { id: "prop_foreign", organizationId: "org_other", legalEntityId: null, createdAt: new Date(2026, 0, 3) }
    ],
    user: [
      { id: "u_dirh", organizationId: ORG, email: "direccion@faranda.test", fullName: "Dirección de hotel", status: "active", mfaEnabled: false, lastLoginAt: null },
      { id: "u_rec", organizationId: ORG, email: "recepcion@faranda.test", fullName: "Recepción", status: "active", mfaEnabled: false, lastLoginAt: null },
      { id: "u_dg", organizationId: ORG, email: "dg@faranda.test", fullName: "Dirección general", status: "active", mfaEnabled: true, lastLoginAt: null },
      { id: "u_clerk", organizationId: ORG, email: "administracion@faranda.test", fullName: "Administrativa", status: "active", mfaEnabled: false, lastLoginAt: null },
      { id: "u_emergency", organizationId: ORG, email: "emergencia-1@faranda.test", fullName: "Emergencia 1", status: "emergency", mfaEnabled: false, lastLoginAt: null },
      { id: "u_new", organizationId: ORG, email: "nueva@faranda.test", fullName: "Sin asignaciones", status: "active", mfaEnabled: false, lastLoginAt: null },
      { id: "u_new2", organizationId: ORG, email: "nueva2@faranda.test", fullName: "Sin asignaciones 2", status: "active", mfaEnabled: false, lastLoginAt: null },
      { id: "u_foreign", organizationId: "org_other", email: "x@example.com", fullName: "Otra", status: "active", mfaEnabled: false, lastLoginAt: null }
    ],
    userPropertyRole: [],
    userRoleAssignment: [],
    propertyGroup: [],
    propertyGroupMember: []
  };
  const roles = seedRoles(tables, ORG, {
    receptionist: ROLE_PERMISSION_MAP.receptionist,
    front_office_manager: ROLE_PERMISSION_MAP.front_office_manager,
    manager: ROLE_PERMISSION_MAP.manager,
    operations_director: ROLE_PERMISSION_MAP.operations_director,
    admin_clerk: ROLE_PERMISSION_MAP.admin_clerk,
    controller: ROLE_PERMISSION_MAP.controller,
    general_manager: ROLE_PERMISSION_MAP.general_manager,
    owner: ROLE_PERMISSION_MAP.owner,
    break_glass: ROLE_PERMISSION_MAP.break_glass
  });
  // A platform role (admin.tenants.manage) and a role of another organisation: never assignable.
  tables.permission!.push({ id: "perm_admin.tenants.manage", key: "admin.tenants.manage", description: "platform" });
  tables.role!.push({ id: "role_platform", organizationId: ORG, name: "Local Super Admin", templateKey: null, level: null, department: null, managed: false, templateVersion: 0 });
  tables.rolePermission!.push({ id: "rp_platform", roleId: "role_platform", permissionId: "perm_admin.tenants.manage" });
  tables.role!.push({ id: "role_foreign", organizationId: "org_other", name: "Foreign", templateKey: "manager", level: null, department: null, managed: true, templateVersion: 2 });
  const live = (id: string, userId: string, roleId: string, scope: { scopeType: string; propertyId?: string; legalEntityId?: string }) =>
    tables.userRoleAssignment!.push({ id, userId, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, propertyGroupId: null, legalEntityId: scope.legalEntityId ?? null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, grantedByUserId: null, revokedByUserId: null, reason: null, createdAt: new Date() });
  live("ura_dirh", "u_dirh", roles.manager.id, { scopeType: "property", propertyId: A });
  live("ura_rec", "u_rec", roles.receptionist.id, { scopeType: "property", propertyId: A });
  live("ura_dg", "u_dg", roles.general_manager.id, { scopeType: "organization" });
  live("ura_clerk", "u_clerk", roles.admin_clerk.id, { scopeType: "property", propertyId: A });
  const db = fakePrisma(tables);
  const trail = audits();
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => new Date() };
  const ctx = (userId: string, permissions: readonly PermissionKey[], extra: Partial<UserContext> = {}): UserContext => ({ organizationId: ORG, propertyId: A, userId, fullName: userId, deviceId: "dev", permissions: [...permissions], ...extra });
  const fom = ctx("u_dirh", ROLE_PERMISSION_MAP.manager);
  const dg = ctx("u_dg", ROLE_PERMISSION_MAP.general_manager, { orgScope: true });
  return { db, deps, trail, roles, fom, dg, ctx };
}

describe("createAssignment · scope, level, self, SoD and opaque 404s", () => {
  it("a hotel director of A assigns receptionist in A: row written, ROLE_ASSIGNED audited, rbac_version bumped, idempotent", async () => {
    const { db, deps, trail, roles, fom } = setup();
    const created = await createAssignment({ context: fom, userId: "u_new", roleId: roles.receptionist.id, scopeType: "property", propertyId: A, reason: "refuerzo" }, deps);
    assert.equal(created.templateKey, "receptionist");
    assert.equal(created.level, "operative");
    assert.equal(created.scopeType, "property");
    assert.equal(created.propertyId, A);
    assert.equal(created.grantedByUserId, "u_dirh");
    assert.equal(created.revokedAt, null);
    const audit = trail.events.find((event) => event.action === "ROLE_ASSIGNED");
    assert.ok(audit && audit.actorUserId === "u_dirh");
    assert.equal(db.$tables.organization[0].rbacVersion, 1);
    const again = await createAssignment({ context: fom, userId: "u_new", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps);
    assert.equal(again.id, created.id, "the live tuple is returned, not duplicated");
    assert.equal(db.$tables.userRoleAssignment.filter((row) => row.userId === "u_new" && row.roleId === roles.receptionist.id).length, 1);
    const existing = await createAssignment({ context: fom, userId: "u_rec", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps);
    assert.equal(existing.id, "ura_rec", "a live row seeded before is returned untouched");
  });

  it("outside the caller's scope → 403 RBAC_SCOPE_EXCEEDED (before any existence check: no oracle)", async () => {
    const { deps, roles, fom } = setup();
    await assert.rejects(createAssignment({ context: fom, userId: "u_rec", roleId: roles.receptionist.id, scopeType: "property", propertyId: B }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_SCOPE_EXCEEDED");
    await assert.rejects(createAssignment({ context: fom, userId: "u_rec", roleId: roles.receptionist.id, scopeType: "property", propertyId: "prop_missing" }, deps), (error: unknown) => code(error) === "RBAC_SCOPE_EXCEEDED", "a missing property answers exactly like a foreign one");
    await assert.rejects(createAssignment({ context: fom, userId: "u_rec", roleId: roles.receptionist.id, scopeType: "organization" }, deps), (error: unknown) => code(error) === "RBAC_SCOPE_EXCEEDED");
    await assert.rejects(createAssignment({ context: fom, userId: "u_rec", roleId: roles.receptionist.id, scopeType: "legal_entity", legalEntityId: LEGAL_ENTITY }, deps), (error: unknown) => code(error) === "RBAC_SCOPE_EXCEEDED");
  });

  it("a level above the caller's → 403 RBAC_LEVEL_EXCEEDED; general_management only from rank ≥ 5, ownership only from ownership", async () => {
    const { deps, roles, fom, dg } = setup();
    await assert.rejects(createAssignment({ context: fom, userId: "u_new", roleId: roles.controller.id, scopeType: "property", propertyId: A }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_LEVEL_EXCEEDED");
    await assert.rejects(createAssignment({ context: fom, userId: "u_new", roleId: roles.operations_director.id, scopeType: "property", propertyId: A }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED", "rank 4 > rank 3");
    const sameLevel = await createAssignment({ context: fom, userId: "u_new", roleId: roles.manager.id, scopeType: "property", propertyId: A }, deps);
    assert.equal(sameLevel.level, "hotel_director", "equal level is allowed");
    // General management (rank 5) may assign a hotel director and a controller, but never ownership (rank 6).
    const manager = await createAssignment({ context: dg, userId: "u_rec", roleId: roles.manager.id, scopeType: "property", propertyId: B }, deps);
    assert.equal(manager.level, "hotel_director");
    const controller = await createAssignment({ context: dg, userId: "u_new2", roleId: roles.controller.id, scopeType: "legal_entity", legalEntityId: LEGAL_ENTITY }, deps);
    assert.equal(controller.scopeType, "legal_entity");
    await assert.rejects(createAssignment({ context: dg, userId: "u_rec", roleId: roles.owner.id, scopeType: "organization" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED");
  });

  it("nobody assigns to itself (403 RBAC_SELF_ASSIGNMENT) and a break-glass session never assigns (403 RBAC_BREAK_GLASS_FORBIDDEN)", async () => {
    const { deps, roles, fom } = setup();
    await assert.rejects(createAssignment({ context: fom, userId: "u_dirh", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps), (error: unknown) => code(error) === "RBAC_SELF_ASSIGNMENT");
    await assert.rejects(createAssignment({ context: { ...fom, breakGlassSessionId: "bg_1" }, userId: "u_rec", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps), (error: unknown) => code(error) === "RBAC_BREAK_GLASS_FORBIDDEN");
  });

  it("a role of another organisation, a platform role, the break_glass template, a foreign user or an emergency account → opaque 404", async () => {
    const { deps, roles, dg } = setup();
    const opaque = (message: string) => (error: unknown) => status(error) === 404 && (error as Error).message === message;
    await assert.rejects(createAssignment({ context: dg, userId: "u_rec", roleId: "role_foreign", scopeType: "property", propertyId: A }, deps), opaque("Rol no encontrado."));
    await assert.rejects(createAssignment({ context: dg, userId: "u_rec", roleId: "role_platform", scopeType: "organization" }, deps), opaque("Rol no encontrado."));
    await assert.rejects(createAssignment({ context: dg, userId: "u_rec", roleId: roles.break_glass.id, scopeType: "organization" }, deps), opaque("Rol no encontrado."));
    await assert.rejects(createAssignment({ context: dg, userId: "u_foreign", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps), opaque("Usuario no encontrado."));
    await assert.rejects(createAssignment({ context: dg, userId: "u_emergency", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps), opaque("Usuario no encontrado."));
  });

  it("static SoD: admin_clerk (payables.create) + controller (payables.approve) in the same property → 409 RBAC_SOD_CONFLICT with the pair", async () => {
    const { deps, roles, dg } = setup();
    await assert.rejects(
      createAssignment({ context: dg, userId: "u_clerk", roleId: roles.controller.id, scopeType: "property", propertyId: A }, deps),
      (error: unknown) => {
        const details = (error as { details?: { code?: string; pair?: { a: string; b: string }; templates?: string[]; conflicts?: Array<{ a: string; b: string }> } }).details;
        return (
          status(error) === 409 &&
          details?.code === "RBAC_SOD_CONFLICT" &&
          typeof details.pair?.a === "string" &&
          (details.conflicts ?? []).some((pair) => pair.a === "payables.create" && pair.b === "payables.approve") &&
          (details.templates ?? []).includes("admin_clerk") &&
          (details.templates ?? []).includes("controller")
        );
      }
    );
    // The same controller role in ANOTHER property does not overlap → allowed.
    const other = await createAssignment({ context: dg, userId: "u_clerk", roleId: roles.controller.id, scopeType: "property", propertyId: B }, deps);
    assert.equal(other.propertyId, B);
  });

  it("sodConflictsAmong shields a pair only when ONE excepted template holds both keys", () => {
    const controllerOnly = sodConflictsAmong([{ templateKey: "controller", permissions: ["payables.approve", "payables.pay"] }]);
    assert.deepEqual(controllerOnly, [], "controller pays what someone else approved (dynamic SoD)");
    const split = sodConflictsAmong([{ templateKey: "controller", permissions: ["payables.approve"] }, { templateKey: "accountant", permissions: ["payables.pay"] }]);
    assert.equal(split.length, 1);
    assert.equal(split[0].a, "payables.approve");
  });
});

describe("revokeAssignment · UPDATE with reason, level rule, legacy rows", () => {
  it("revokes within scope (ROLE_REVOKED audited, version bumped), is idempotent, refuses a higher level and a foreign id", async () => {
    const { db, deps, trail, roles, fom, dg } = setup();
    const created = await createAssignment({ context: fom, userId: "u_new", roleId: roles.receptionist.id, scopeType: "property", propertyId: A }, deps);
    const revoked = await revokeAssignment({ context: fom, id: created.id, reason: "baja" }, deps);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.reason, "baja");
    assert.ok(trail.events.some((event) => event.action === "ROLE_REVOKED"));
    assert.equal(db.$tables.organization[0].rbacVersion, 2);
    const again = await revokeAssignment({ context: fom, id: created.id }, deps);
    assert.equal(again.revokedAt, revoked.revokedAt);
    // An operations director's row (rank 4) cannot be revoked by a hotel director (rank 3).
    const ops = await createAssignment({ context: dg, userId: "u_new", roleId: roles.operations_director.id, scopeType: "property", propertyId: A }, deps);
    await assert.rejects(revokeAssignment({ context: fom, id: ops.id }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED");
    await assert.rejects(revokeAssignment({ context: fom, id: "ura_dg" }, deps), (error: unknown) => status(error) === 404, "an organisation assignment is outside a property caller's scope: opaque 404");
    await assert.rejects(revokeAssignment({ context: fom, id: "no_such" }, deps), (error: unknown) => status(error) === 404);
    await assert.rejects(revokeAssignment({ context: { ...fom, breakGlassSessionId: "bg" }, id: created.id }, deps), (error: unknown) => code(error) === "RBAC_BREAK_GLASS_FORBIDDEN");
  });

  it("a legacy user_property_roles row is listed as legacy:<id> and removed on revoke", async () => {
    const { db, deps, roles, fom } = setup();
    db.$tables.userPropertyRole.push({ id: "upr_1", userId: "u_rec", propertyId: A, roleId: roles.receptionist.id });
    const listed = await listAssignments({ context: fom, userId: "u_rec" }, deps);
    assert.ok(listed.some((row) => row.id === "legacy:upr_1" && row.templateKey === "receptionist"));
    const revoked = await revokeAssignment({ context: fom, id: "legacy:upr_1", reason: "migrado" }, deps);
    assert.equal(revoked.id, "legacy:upr_1");
    assert.equal(db.$tables.userPropertyRole.length, 0);
  });
});

describe("listAssignments / listUsersInScope · only inside the caller's scope", () => {
  it("a property caller sees the rows of its property, never the organisation-level ones; the general manager sees everything", async () => {
    const { deps, fom, dg } = setup();
    const forFom = await listAssignments({ context: fom }, deps);
    assert.deepEqual(forFom.map((row) => row.id).sort(), ["ura_clerk", "ura_dirh", "ura_rec"]);
    const forDg = await listAssignments({ context: dg }, deps);
    assert.ok(forDg.some((row) => row.id === "ura_dg"));
    const byProperty = await listAssignments({ context: dg, propertyId: B }, deps);
    assert.deepEqual(byProperty.map((row) => row.id), ["ura_dg"], "an organisation assignment covers B");
    const users = await listUsersInScope({ context: fom }, deps);
    assert.deepEqual(users.map((user) => user.userId).sort(), ["u_clerk", "u_dirh", "u_rec"]);
    assert.equal(users.some((user) => user.email.startsWith("emergencia-")), false);
    const withEmergency = await listUsersInScope({ context: { ...dg, permissions: [...dg.permissions, "audit.read"] } }, deps);
    assert.ok(withEmergency.some((user) => user.userId === "u_emergency"), "audit.read lists the emergency accounts");
    const inB = await listUsersInScope({ context: dg, scopeType: "property", ref: B }, deps);
    assert.deepEqual(inB.map((user) => user.userId), ["u_dg"], "only the organisation-wide user touches B");
  });
});

describe("roles · list, create from template, remove keys", () => {
  it("lists the organisation roles without the emergency and platform ones; creates from a template (never break_glass); removes keys and marks the role custom", async () => {
    const { db, deps, trail, roles, dg } = setup();
    const admin = { ...dg, permissions: ["roles.manage", "permissions.manage"] as PermissionKey[] };
    const listed = await listRoles({ context: admin }, deps);
    assert.equal(listed.some((role) => role.templateKey === "break_glass"), false);
    assert.equal(listed.some((role) => role.id === "role_platform"), false);
    assert.ok(listed.some((role) => role.id === roles.receptionist.id && role.permissionCount === ROLE_PERMISSION_MAP.receptionist.length));
    await assert.rejects(createRoleFromTemplate({ context: admin, name: "Emergencia bis", templateKey: "break_glass" }, deps), (error: unknown) => status(error) === 404);
    await assert.rejects(createRoleFromTemplate({ context: admin, name: "X", templateKey: "no_such_template" }, deps), (error: unknown) => status(error) === 404);
    await assert.rejects(createRoleFromTemplate({ context: { ...admin, breakGlassSessionId: "bg" }, name: "Recepción tarde", templateKey: "receptionist" }, deps), (error: unknown) => code(error) === "RBAC_BREAK_GLASS_FORBIDDEN");
    const created = await createRoleFromTemplate({ context: admin, name: "Recepción tarde", templateKey: "receptionist" }, deps);
    assert.equal(created.templateKey, "receptionist");
    assert.equal(created.permissionCount, ROLE_PERMISSION_MAP.receptionist.length);
    await assert.rejects(editRolePermissions({ context: admin, roleId: created.id, remove: ["no.such.key"] }, deps), (error: unknown) => status(error) === 400, "unknown catalogue keys are a 400");
    const edited = await editRolePermissions({ context: admin, roleId: created.id, remove: ["pms.reservation.create", "payables.pay"] }, deps);
    assert.equal(edited.managed, false);
    assert.equal(edited.permissions.includes("pms.reservation.create"), false);
    assert.equal(edited.permissionCount, ROLE_PERMISSION_MAP.receptionist.length - 1);
    assert.ok(trail.events.some((event) => event.action === "ROLE_PERMISSIONS_EDITED"));
    assert.equal(db.$tables.role.find((row) => row.id === created.id)!.managed, false);
    await assert.rejects(editRolePermissions({ context: admin, roleId: "role_platform", remove: ["admin.tenants.manage"] }, deps), (error: unknown) => status(error) === 404);
    await assert.rejects(editRolePermissions({ context: admin, roleId: roles.break_glass.id, remove: ["pms.reservation.read"] }, deps), (error: unknown) => status(error) === 404);
  });
});

describe("corrector 8a · FSOD-02: the «Sociedad» tab (scopeType=organization) lists every user with a live assignment in the organisation", () => {
  it("property, group, sociedad and organisation assignments all belong to the organisation; a user without assignments is not listed", async () => {
    const { db, deps, roles, dg } = setup();
    db.$tables.userRoleAssignment.push({ id: "ura_clerk_le", userId: "u_clerk", roleId: roles.controller.id, scopeType: "legal_entity", propertyId: null, propertyGroupId: null, legalEntityId: LEGAL_ENTITY, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, grantedByUserId: null, revokedByUserId: null, reason: null, createdAt: new Date() });
    const rows = await listUsersInScope({ context: dg, scopeType: "organization" }, deps);
    const ids = rows.map((row) => row.userId).sort();
    assert.ok(ids.includes("u_rec"), "a receptionist of A belongs to the organisation");
    assert.ok(ids.includes("u_dirh"), "the hotel director of A too");
    assert.ok(ids.includes("u_clerk"), "a sociedad-scoped controller too");
    assert.ok(ids.includes("u_dg"), "and the organisation-scoped general manager");
    assert.ok(!ids.includes("u_new"), "no assignment → not listed");
    // The property tab still lists only who touches that property.
    const inB = await listUsersInScope({ context: dg, scopeType: "property", ref: B }, deps);
    assert.ok(!inB.some((row) => row.userId === "u_rec"), "reception of A is not in B");
    assert.ok(inB.some((row) => row.userId === "u_dg"), "the organisation-wide user covers B");
  });
});

describe("corrector 8a · FSOD-08: an emergency session never recomposes the property groups (a permanent widening of every group assignment)", () => {
  it("createPropertyGroup and updatePropertyGroup answer 403 RBAC_BREAK_GLASS_FORBIDDEN from a break-glass context and write nothing", async () => {
    const { db, deps, dg, trail } = setup();
    const emergency = { ...dg, breakGlassSessionId: "bg_1", permissions: [...dg.permissions, "organization.structure.manage"] as PermissionKey[] };
    await assert.rejects(createPropertyGroup({ context: emergency, code: "GAL", name: "Galicia", propertyIds: [A, B] }, deps), (error: unknown) => (error as { statusCode?: number }).statusCode === 403 && (error as { details?: { code?: string } }).details?.code === "RBAC_BREAK_GLASS_FORBIDDEN");
    const group = await createPropertyGroup({ context: { ...dg, permissions: [...dg.permissions, "organization.structure.manage"] as PermissionKey[] }, code: "GAL", name: "Galicia", propertyIds: [A] }, deps);
    await assert.rejects(updatePropertyGroup({ context: emergency, id: group.id, propertyIds: [A, B] }, deps), (error: unknown) => (error as { details?: { code?: string } }).details?.code === "RBAC_BREAK_GLASS_FORBIDDEN");
    assert.deepEqual(db.$tables.propertyGroupMember.filter((row) => row.propertyGroupId === group.id).map((row) => row.propertyId), [A], "the membership did not change");
    assert.ok(!trail.events.some((event) => event.action === "PROPERTY_GROUP_UPDATED"), "no PROPERTY_GROUP_UPDATED written by the emergency session");
  });
});
