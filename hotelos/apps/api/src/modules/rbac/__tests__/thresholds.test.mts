// Tanda 8a (RBAC · L1): thresholds T1-T4 per organisation and the max tier a
// context may approve (template of its assignments). No database (fake
// Prisma). From apps/api:
//   node --import tsx --test src/modules/rbac/__tests__/thresholds.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THRESHOLDS, ROLE_PERMISSION_MAP } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import type { RbacDeps } from "../assignments.service.js";
import { getThresholds, maxTierFor, maxTierOfScope, putThresholds, tierFor, tierWithin } from "../thresholds.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "./fake-prisma.mts";

const ORG = "org_thr";
const A = "prop_a";
const B = "prop_b";

function context(overrides: Partial<UserContext> = {}): UserContext {
  return { organizationId: ORG, propertyId: A, userId: "u_dirfin", fullName: "Dirección financiera", deviceId: "dev", permissions: ["accounting.configure", "ai.high_risk.confirm"], ...overrides };
}

function setup() {
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    property: [
      { id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) },
      { id: B, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 2) }
    ],
    userPropertyRole: [],
    userRoleAssignment: []
  };
  const roles = seedRoles(tables, ORG, { controller: ROLE_PERMISSION_MAP.controller, front_office_manager: ROLE_PERMISSION_MAP.front_office_manager, receptionist: ROLE_PERMISSION_MAP.receptionist });
  tables.userRoleAssignment!.push({ id: "ura_dirfin", userId: "u_dirfin", roleId: roles.controller.id, scopeType: "legal_entity", propertyId: null, propertyGroupId: null, legalEntityId: "le", organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  const db = fakePrisma(tables);
  const trail = audits();
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => new Date() };
  return { db, deps, trail, roles };
}

describe("getThresholds / tierFor · defaults until the organisation stores its own", () => {
  it("returns DEFAULT_THRESHOLDS with source defaults and every action falling back to the organisation limits", async () => {
    const { deps } = setup();
    const thresholds = await getThresholds(ORG, deps);
    assert.equal(thresholds.source, "defaults");
    assert.deepEqual(thresholds.limits, { T1: 50, T2: 300, T3: 3000, T4: 15000 });
    assert.equal(thresholds.secondApprovalAmount, DEFAULT_THRESHOLDS.secondApprovalAmount);
    assert.deepEqual(thresholds.perAction.refund, thresholds.limits);
    assert.equal(tierFor(50, thresholds), "T1");
    assert.equal(tierFor(50.01, thresholds), "T2");
    assert.equal(tierFor(400, thresholds, "refund"), "T3");
    assert.equal(tierFor(15000, thresholds), "T4");
    assert.equal(tierFor(15000.5, thresholds), "ABOVE_T4");
    assert.equal(tierFor(-1, thresholds), "ABOVE_T4", "a negative amount never lands in an operative tier");
    assert.equal(tierWithin("T2", "T3"), true);
    assert.equal(tierWithin("T4", "T3"), false);
  });
});

describe("putThresholds · validation, self-service guard and audit", () => {
  const body = { T1: "100.00", T2: "500.00", T3: "5000.00", T4: "20000.00", secondApprovalAmount: "80000.00", confirmHighRisk: true as const };

  it("writes the organisation rows (every action × tier), the pct rows and the second-approval row; reads them back", async () => {
    const { deps, trail } = setup();
    const after = await putThresholds({ context: context(), body: { ...body, discountPctT1: "5.00", discountPctT2: "20.00", rateBandPct: "10.00" } }, deps);
    assert.equal(after.source, "organization");
    assert.deepEqual(after.limits, { T1: 100, T2: 500, T3: 5000, T4: 20000 });
    assert.equal(after.secondApprovalAmount, 80000);
    assert.equal(after.discountPctT1, 5);
    assert.equal(after.discountPctT2, 20);
    assert.equal(after.rateBandPct, 10);
    assert.equal(after.perAction.supplier_bill.T3, 5000);
    assert.ok(after.rows.some((row) => row.action === "supplier_bill" && row.tier === "ABOVE_T4" && row.requiresSecondApproval && row.maxAmount === "80000.00"));
    assert.equal(tierFor(400, after, "refund"), "T2", "400 € is now a supervisor amount");
    assert.ok(trail.events.some((event) => event.action === "THRESHOLDS_UPDATED"));
    const reread = await getThresholds(ORG, deps);
    assert.deepEqual(reread.limits, after.limits);
    // 11 actions × 4 tiers + the second-approval row (the pct values ride on the discount / rate_change amount rows).
    assert.equal(after.rows.length, 45);
    // Idempotent rewrite: the rows are replaced, not accumulated.
    const again = await putThresholds({ context: context(), body }, deps);
    assert.equal(again.rows.length, 45);
    assert.equal(again.discountPctT1, DEFAULT_THRESHOLDS.discountPctT1, "omitted pct fields fall back to the defaults");
  });

  it("rejects an unordered ladder, a second-approval amount below T4, a non-true confirmHighRisk and double approval below ABOVE_T4", async () => {
    const { deps } = setup();
    await assert.rejects(putThresholds({ context: context(), body: { ...body, T3: "400.00" } }, deps), (error: unknown) => (error as { statusCode?: number }).statusCode === 400 && /T1 < T2 < T3 < T4/.test((error as Error).message));
    await assert.rejects(putThresholds({ context: context(), body: { ...body, secondApprovalAmount: "100.00" } }, deps), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
    await assert.rejects(putThresholds({ context: context(), body: { ...body, confirmHighRisk: false as unknown as true } }, deps), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
    await assert.rejects(putThresholds({ context: context(), body: { ...body, roleLimits: [{ level: "supervisor", action: "refund", tier: "T2", requiresSecondApproval: true }] } }, deps), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
    await assert.rejects(putThresholds({ context: context({ permissions: ["accounting.configure"] }), body }, deps), (error: unknown) => (error as { statusCode?: number }).statusCode === 403, "ai.high_risk.confirm is mandatory");
  });

  it("the caller cannot touch the thresholds of a role or level it holds (409 RBAC_SELF_ASSIGNMENT)", async () => {
    const { deps, roles } = setup();
    const byRole = putThresholds({ context: context(), body: { ...body, roleLimits: [{ roleId: roles.controller.id, action: "refund", tier: "T4", maxAmount: "99999.00" }] } }, deps);
    await assert.rejects(byRole, (error: unknown) => (error as { statusCode?: number; details?: { code?: string } }).statusCode === 409 && (error as { details?: { code?: string } }).details?.code === "RBAC_SELF_ASSIGNMENT");
    const byLevel = putThresholds({ context: context(), body: { ...body, roleLimits: [{ level: "general_management", action: "refund", tier: "T4", maxAmount: "1.00" }] } }, deps);
    await assert.rejects(byLevel, (error: unknown) => (error as { details?: { code?: string } }).details?.code === "RBAC_SELF_ASSIGNMENT");
    // A level the caller does NOT hold is fine.
    const ok = await putThresholds({ context: context(), body: { ...body, roleLimits: [{ level: "supervisor", action: "refund", tier: "T2", maxAmount: "250.00" }] } }, deps);
    assert.ok(ok.rows.some((row) => row.level === "supervisor" && row.maxAmount === "250.00"));
  });

  it("a break-glass session never changes the thresholds (403 RBAC_BREAK_GLASS_FORBIDDEN)", async () => {
    const { deps } = setup();
    await assert.rejects(putThresholds({ context: context({ breakGlassSessionId: "bg_1" }), body }, deps), (error: unknown) => (error as { details?: { code?: string } }).details?.code === "RBAC_BREAK_GLASS_FORBIDDEN");
  });
});

describe("maxTierFor · the tier a context may approve comes from the TEMPLATE of its assignments", () => {
  it("template tiers per property, the minimum over narrow assignments for the organisation routes, T1 without assignments", async () => {
    const { deps } = setup();
    const fom = context({ userId: "u_fom", assignments: [{ roleId: "r1", templateKey: "front_office_manager", level: "supervisor", scopeType: "property", propertyIds: [A] }, { roleId: "r2", templateKey: "receptionist", level: "operative", scopeType: "property", propertyIds: [B] }] });
    assert.equal(await maxTierFor(fom, A, deps), "T2");
    assert.equal(await maxTierFor(fom, B, deps), "T1");
    assert.equal(await maxTierFor(fom, "prop_c", deps), "T1", "no assignment covers it");
    assert.equal(await maxTierFor(fom, null, deps), "T1", "organisation routes: minimum of the narrow ones");
    const dirfin = context();
    assert.equal(await maxTierFor(dirfin, null, deps), "T4", "loaded from the fake db when the context carries no assignments");
    assert.equal(await maxTierFor(context({ userId: "nobody" }), A, deps), "T1");
  });

  it("custom roles use LEVEL_MAX_TIER of their level; platform admins and break glass are unlimited", async () => {
    const { deps } = setup();
    const custom = context({ assignments: [{ roleId: "custom", templateKey: null, level: "hotel_director", scopeType: "property", propertyIds: [A] }] });
    assert.equal(await maxTierFor(custom, A, deps), "T3");
    const noLevel = context({ assignments: [{ roleId: "custom", templateKey: null, level: null, scopeType: "property", propertyIds: [A] }] });
    assert.equal(await maxTierFor(noLevel, A, deps), "T1");
    assert.equal(await maxTierFor(context({ isPlatformAdmin: true, assignments: [] }), A, deps), "ABOVE_T4");
    assert.equal(await maxTierFor(context({ breakGlassSessionId: "bg", assignments: [] }), null, deps), "ABOVE_T4");
    assert.equal(maxTierOfScope({ assignments: [] }, A), "T1");
  });
});
