// Corrector 8a (SEC-8A-03): the RBAC report and the access log stay inside the
// caller's scope — a hotel supervisor with audit.read never reads the security
// events of other hotels nor the organisation-level ones. No database (fake
// Prisma). From apps/api:
//   node --import tsx --test src/modules/rbac/__tests__/report.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import type { RbacDeps } from "../assignments.service.js";
import { accessLog, rbacReport } from "../report.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "./fake-prisma.mts";

const ORG = "org_rep";
const A = "prop_a";
const B = "prop_b";
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;
const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;

function setup() {
  const now = new Date("2026-09-18T10:00:00Z");
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    property: [
      { id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) },
      { id: B, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 2) }
    ],
    user: [],
    userPropertyRole: [],
    userRoleAssignment: [],
    roleThreshold: [],
    auditEvent: [
      { id: "ev_a", organizationId: ORG, action: "ACCESS_DENIED", actorUserId: "u_rec", propertyId: A, entityType: "route", entityId: "GET /finanzas", afterJson: null, ipAddress: "10.0.0.1", deviceId: "d1", correlationId: null, createdAt: now },
      { id: "ev_b", organizationId: ORG, action: "LOGIN_FAILED", actorUserId: "u_dg", propertyId: B, entityType: "user", entityId: "u_dg", afterJson: null, ipAddress: "10.9.9.9", deviceId: "dg-phone", correlationId: null, createdAt: now },
      { id: "ev_org", organizationId: ORG, action: "BREAK_GLASS_OPENED", actorUserId: "u_dg", propertyId: null, entityType: "break_glass_session", entityId: "bg_1", afterJson: null, ipAddress: null, deviceId: null, correlationId: "bg_bg_1", createdAt: now }
    ]
  };
  const roles = seedRoles(tables, ORG, { housekeeping_manager: ROLE_PERMISSION_MAP.housekeeping_manager, auditor: ROLE_PERMISSION_MAP.auditor });
  const live = (id: string, userId: string, roleId: string, scope: { scopeType: string; propertyId?: string }) =>
    tables.userRoleAssignment!.push({ id, userId, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: now });
  live("ura_gob", "u_gob", roles.housekeeping_manager.id, { scopeType: "property", propertyId: A });
  live("ura_aud", "u_aud", roles.auditor.id, { scopeType: "organization" });
  const db = fakePrisma(tables);
  const trail = audits();
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => now };
  const ctx = (userId: string, permissions: readonly PermissionKey[], extra: Partial<UserContext> = {}): UserContext => ({ organizationId: ORG, propertyId: A, userId, fullName: userId, deviceId: "dev", permissions: [...permissions], ...extra });
  const gobernanta = ctx("u_gob", ROLE_PERMISSION_MAP.housekeeping_manager);
  const auditor = ctx("u_aud", ROLE_PERMISSION_MAP.auditor, { orgScope: true });
  return { deps, gobernanta, auditor };
}

describe("corrector 8a · SEC-8A-03 · report.service inside the caller's scope", () => {
  it("the access log of a property supervisor holds only the events of its hotels (never B, never the organisation-level rows); the auditor reads everything", async () => {
    const { deps, gobernanta, auditor } = setup();
    assert.ok(ROLE_PERMISSION_MAP.housekeeping_manager.includes("audit.read"), "the gobernanta template holds audit.read (property scope)");
    const own = await accessLog({ context: gobernanta }, deps);
    assert.deepEqual(own.items.map((item) => item.id), ["ev_a"]);
    assert.equal(own.total, 1);
    const all = await accessLog({ context: auditor }, deps);
    assert.deepEqual(all.items.map((item) => item.id).sort(), ["ev_a", "ev_b", "ev_org"]);
    const platform = await accessLog({ context: { ...gobernanta, isPlatformAdmin: true } }, deps);
    assert.equal(platform.total, 3);
  });

  it("the roles report is organisation-wide: a property supervisor gets 403 RBAC_SCOPE_EXCEEDED, the auditor gets the roles", async () => {
    const { deps, gobernanta, auditor } = setup();
    await assert.rejects(rbacReport({ context: gobernanta }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_SCOPE_EXCEEDED");
    const report = await rbacReport({ context: auditor }, deps);
    assert.equal(report.roles.length, 2);
    await assert.rejects(rbacReport({ context: { ...gobernanta, permissions: [] } }, deps), (error: unknown) => status(error) === 403, "audit.read stays mandatory");
  });
});
