// Tanda 8a (RBAC · L1): maker/checker approvals — request with the request
// key, decide with the approve key and enough tier, never self, second
// approval above T4, expiry, executor, and the gate L2 services call
// (assertApprovedOrAuthorized). No database (fake Prisma). From apps/api:
//   node --import tsx --test src/modules/rbac/__tests__/approvals.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword } from "@hotelos/database";
import { ROLE_LEVEL_RANK, ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import { APPROVAL_TTL_DAYS, assertApprovedOrAuthorized, decideApproval, expireApprovals, listApprovals, registerApprovalDecisionPolicy, registerApprovalExecutor, requestApproval, resetApprovalDecisionPoliciesForTests, resetApprovalExecutorsForTests } from "../approvals.service.js";
import type { RbacDeps } from "../assignments.service.js";
import { authorize } from "../supervisor.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "./fake-prisma.mts";

const ORG = "org_apr";
const A = "prop_a";
const B = "prop_b";
const PIN = "2468";
const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;

function setup() {
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    property: [
      { id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) },
      { id: B, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 2) }
    ],
    user: [
      { id: "u_rec", organizationId: ORG, email: "recepcion@faranda.test", fullName: "Recepción", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_fom", organizationId: ORG, email: "jefatura@faranda.test", fullName: "Jefatura", status: "active", passwordHash: hashPassword("x"), pinHash: hashPassword(PIN), pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_dirh", organizationId: ORG, email: "direccion@faranda.test", fullName: "Dirección", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_dg", organizationId: ORG, email: "dg@faranda.test", fullName: "DG", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_owner", organizationId: ORG, email: "propiedad@faranda.test", fullName: "Propiedad", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_dirfin", organizationId: ORG, email: "dirfin@faranda.test", fullName: "Dirección financiera", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_dg2", organizationId: ORG, email: "dg2@faranda.test", fullName: "DG 2", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_clerk", organizationId: ORG, email: "administracion@faranda.test", fullName: "Administrativa", status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null }
    ],
    userPropertyRole: [],
    userRoleAssignment: [],
    approvalRequest: [],
    roleThreshold: []
  };
  const roles = seedRoles(tables, ORG, {
    receptionist: ROLE_PERMISSION_MAP.receptionist,
    front_office_manager: ROLE_PERMISSION_MAP.front_office_manager,
    manager: ROLE_PERMISSION_MAP.manager,
    general_manager: ROLE_PERMISSION_MAP.general_manager,
    owner: ROLE_PERMISSION_MAP.owner,
    controller: ROLE_PERMISSION_MAP.controller,
    admin_clerk: ROLE_PERMISSION_MAP.admin_clerk
  });
  const live = (id: string, userId: string, roleId: string, scope: { scopeType: string; propertyId?: string }) =>
    tables.userRoleAssignment!.push({ id, userId, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  live("ura_rec", "u_rec", roles.receptionist.id, { scopeType: "property", propertyId: A });
  live("ura_fom", "u_fom", roles.front_office_manager.id, { scopeType: "property", propertyId: A });
  live("ura_dirh", "u_dirh", roles.manager.id, { scopeType: "property", propertyId: A });
  live("ura_dg", "u_dg", roles.general_manager.id, { scopeType: "organization" });
  live("ura_owner", "u_owner", roles.owner.id, { scopeType: "organization" });
  live("ura_dirfin", "u_dirfin", roles.controller.id, { scopeType: "organization" });
  live("ura_dg2", "u_dg2", roles.general_manager.id, { scopeType: "organization" });
  live("ura_clerk", "u_clerk", roles.admin_clerk.id, { scopeType: "property", propertyId: A });
  const db = fakePrisma(tables);
  const trail = audits();
  let clock = new Date("2026-09-18T10:00:00Z");
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => clock };
  const ctx = (userId: string, permissions: readonly PermissionKey[], extra: Partial<UserContext> = {}): UserContext => ({ organizationId: ORG, propertyId: A, userId, fullName: userId, deviceId: "dev", permissions: [...permissions], ...extra });
  const rec = ctx("u_rec", ROLE_PERMISSION_MAP.receptionist);
  const fom = ctx("u_fom", ROLE_PERMISSION_MAP.front_office_manager);
  const dirh = ctx("u_dirh", ROLE_PERMISSION_MAP.manager);
  const dg = ctx("u_dg", ROLE_PERMISSION_MAP.general_manager, { orgScope: true });
  const owner = ctx("u_owner", ROLE_PERMISSION_MAP.owner, { orgScope: true });
  const dirfin = ctx("u_dirfin", ROLE_PERMISSION_MAP.controller, { orgScope: true });
  const dg2 = ctx("u_dg2", ROLE_PERMISSION_MAP.general_manager, { orgScope: true });
  const clerk = ctx("u_clerk", ROLE_PERMISSION_MAP.admin_clerk);
  const refund = (amount: string, entityId = "pay_1") => ({ kind: "refund" as const, entityType: "payment", entityId, propertyId: A, amount, reasonCode: "guest_complaint" });
  return { db, deps, trail, roles, rec, fom, dirh, dg, owner, dirfin, dg2, clerk, refund, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe("requestApproval · the maker opens a request with the request key of the kind", () => {
  it("a receptionist requests a 400 € refund in A: pending, tier T3 (50/300/3000/15000), 7-day expiry, APPROVAL_REQUESTED; idempotent while pending", async () => {
    const { deps, trail, rec, refund } = setup();
    const created = await requestApproval({ context: rec, ...refund("400.00") }, deps);
    assert.equal(created.status, "pending");
    assert.equal(created.kind, "refund");
    assert.equal(created.thresholdTier, "T3");
    assert.equal(created.requiresSecondApproval, false);
    assert.equal(created.amount, "400.00");
    assert.equal(new Date(created.expiresAt).getTime() - deps.now().getTime(), APPROVAL_TTL_DAYS * 24 * 60 * 60 * 1000);
    assert.ok(trail.events.some((event) => event.action === "APPROVAL_REQUESTED"));
    const again = await requestApproval({ context: rec, ...refund("400.00") }, deps);
    assert.equal(again.id, created.id);
  });

  it("without the request key in that property → 403; a property outside the scope → opaque 404", async () => {
    const { deps, rec, refund } = setup();
    // A receptionist holds payments.refund_request but not payables.create.
    await assert.rejects(requestApproval({ context: rec, ...refund("10.00"), kind: "supplier_bill" }, deps), (error: unknown) => status(error) === 403);
    await assert.rejects(requestApproval({ context: rec, ...refund("10.00"), propertyId: B }, deps), (error: unknown) => status(error) === 404 || status(error) === 403);
  });
});

describe("decideApproval · checker with the approve key, enough tier, never the requester", () => {
  it("the requester cannot approve (409 APPROVAL_SELF_DECISION); a supervisor (T2) cannot approve a T3 amount (403 RBAC_LEVEL_EXCEEDED); the hotel director approves and the executor runs", async () => {
    const { deps, trail, rec, fom, dirh, refund } = setup();
    resetApprovalExecutorsForTests();
    const executed: string[] = [];
    registerApprovalExecutor("refund", async (request) => {
      executed.push(request.id);
    });
    const created = await requestApproval({ context: rec, ...refund("400.00") }, deps);
    await assert.rejects(decideApproval({ context: rec, id: created.id, decision: "approve" }, deps), (error: unknown) => status(error) === 409 && code(error) === "APPROVAL_SELF_DECISION");
    await assert.rejects(decideApproval({ context: fom, id: created.id, decision: "approve" }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_LEVEL_EXCEEDED");
    const approved = await decideApproval({ context: dirh, id: created.id, decision: "approve", note: "ok" }, deps);
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedByUserId, "u_dirh");
    assert.deepEqual(executed, [created.id], "the registered executor ran once");
    assert.ok(trail.events.some((event) => event.action === "APPROVAL_DECIDED" && (event.afterJson as { decision: string }).decision === "approve"));
    await assert.rejects(decideApproval({ context: dirh, id: created.id, decision: "reject" }, deps), (error: unknown) => code(error) === "APPROVAL_ALREADY_DECIDED");
    resetApprovalExecutorsForTests();
  });

  it("a supervisor approves a T2 refund (≤ 300 €) but a user without the approve key in that property is refused (403)", async () => {
    const { deps, rec, fom, refund } = setup();
    const created = await requestApproval({ context: rec, ...refund("250.00", "pay_2") }, deps);
    assert.equal(created.thresholdTier, "T2");
    const other = { ...rec, userId: "u_nobody" };
    await assert.rejects(decideApproval({ context: other, id: created.id, decision: "approve" }, deps), (error: unknown) => status(error) === 403);
    const approved = await decideApproval({ context: fom, id: created.id, decision: "approve" }, deps);
    assert.equal(approved.status, "approved");
    const rejected = await requestApproval({ context: rec, ...refund("20.00", "pay_3") }, deps);
    const decided = await decideApproval({ context: fom, id: rejected.id, decision: "reject", note: "no procede" }, deps);
    assert.equal(decided.status, "rejected");
  });

  it("above T4 the first approval leaves the request pending; the second must be another person with rank ≥ general_management (ownership for big supplier bills)", async () => {
    const { deps, rec, dirh, dg, owner, dirfin, dg2, clerk, refund } = setup();
    // The receptionist may request a 20 000 € refund; the tier is what escalates (DG + dirección financiera, §4.7).
    const big = await requestApproval({ context: rec, ...refund("20000.00", "pay_big") }, deps);
    assert.equal(big.thresholdTier, "ABOVE_T4");
    assert.equal(big.requiresSecondApproval, true);
    await assert.rejects(decideApproval({ context: dirh, id: big.id, decision: "approve" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED", "a hotel director (T3) never approves above T4");
    const first = await decideApproval({ context: dg, id: big.id, decision: "approve" }, deps);
    assert.equal(first.status, "pending", "first of two approvals");
    assert.equal(first.decidedByUserId, "u_dg");
    await assert.rejects(decideApproval({ context: dg, id: big.id, decision: "approve" }, deps), (error: unknown) => code(error) === "APPROVAL_SELF_DECISION", "the second approval must be another person");
    await assert.rejects(decideApproval({ context: owner, id: big.id, decision: "approve" }, deps), (error: unknown) => status(error) === 403, "ownership does not hold payments.refund_approve");
    const second = await decideApproval({ context: dirfin, id: big.id, decision: "approve" }, deps);
    assert.equal(second.status, "approved");
    assert.equal(second.secondApproverUserId, "u_dirfin");
    // Supplier bill above secondApprovalAmount (60 000 €): the second approver must be ownership — general management is not enough.
    const bill = await requestApproval({ context: clerk, kind: "supplier_bill", entityType: "supplier_bill", entityId: "bill_1", propertyId: A, amount: "70000.00", reasonCode: "capex" }, deps);
    const firstBill = await decideApproval({ context: dg, id: bill.id, decision: "approve" }, deps);
    assert.equal(firstBill.status, "pending");
    await assert.rejects(decideApproval({ context: dg2, id: bill.id, decision: "approve" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED", "a second general manager is not ownership");
    const secondBill = await decideApproval({ context: owner, id: bill.id, decision: "approve" }, deps);
    assert.equal(secondBill.status, "approved");
    assert.equal(secondBill.secondApproverUserId, "u_owner");
  });

  it("expiry is lazy and idempotent: a request past expiresAt is expired on the next read/decision (409 APPROVAL_EXPIRED, APPROVAL_EXPIRED audited once)", async () => {
    const { deps, trail, rec, dirh, refund, advance } = setup();
    const created = await requestApproval({ context: rec, ...refund("100.00", "pay_old") }, deps);
    advance((APPROVAL_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    assert.equal(await expireApprovals(deps, ORG), 1);
    assert.equal(await expireApprovals(deps, ORG), 0);
    assert.equal(trail.events.filter((event) => event.action === "APPROVAL_EXPIRED").length, 1);
    await assert.rejects(decideApproval({ context: dirh, id: created.id, decision: "approve" }, deps), (error: unknown) => code(error) === "APPROVAL_EXPIRED");
    const listed = await listApprovals({ context: dirh }, deps);
    assert.equal(listed.find((row) => row.id === created.id)?.status, "expired");
  });
});

describe("listApprovals · scope and kinds the user may approve (plus its own requests)", () => {
  it("the receptionist sees its own request, the supervisor sees refunds of A, nobody sees another property, the general manager sees all", async () => {
    const { deps, rec, fom, dg, refund } = setup();
    const own = await requestApproval({ context: rec, ...refund("100.00") }, deps);
    const forRec = await listApprovals({ context: rec }, deps);
    assert.deepEqual(forRec.map((row) => row.id), [own.id]);
    const forFom = await listApprovals({ context: fom, status: "pending" }, deps);
    assert.deepEqual(forFom.map((row) => row.id), [own.id]);
    const otherProperty = { ...fom, userId: "u_stranger" };
    assert.deepEqual(await listApprovals({ context: otherProperty }, deps), [], "no assignment covering A → nothing");
    assert.equal((await listApprovals({ context: dg, kind: "refund" }, deps)).length, 1);
    assert.equal((await listApprovals({ context: dg, kind: "capex" }, deps)).length, 0);
  });
});

describe("assertApprovedOrAuthorized · the gate L2 services call before a sensitive mutation", () => {
  it("(5) nothing authorises a T3 refund for a receptionist → 409 APPROVAL_REQUIRED with the pending request id", async () => {
    const { deps, rec, refund } = setup();
    await assert.rejects(assertApprovedOrAuthorized({ context: rec, ...refund("400.00") }, deps), (error: unknown) => status(error) === 409 && code(error) === "APPROVAL_REQUIRED" && (error as { details?: { tier?: string } }).details?.tier === "T3");
    const pending = await requestApproval({ context: rec, ...refund("400.00") }, deps);
    await assert.rejects(assertApprovedOrAuthorized({ context: rec, ...refund("400.00") }, deps), (error: unknown) => (error as { details?: { requestId?: string } }).details?.requestId === pending.id);
  });

  it("(1) an approved request that matches is consumed once; a mismatch (amount above, other property) → 409 APPROVAL_MISMATCH; the requester and, for refunds, the decider cannot consume it", async () => {
    const { db, deps, rec, dirh, refund } = setup();
    const created = await requestApproval({ context: rec, ...refund("400.00") }, deps);
    await decideApproval({ context: dirh, id: created.id, decision: "approve" }, deps);
    const clerk = { ...rec, userId: "u_clerk", permissions: ["payment.refund"] as PermissionKey[] };
    await assert.rejects(assertApprovedOrAuthorized({ context: clerk, ...refund("401.00") }, deps), (error: unknown) => code(error) === "APPROVAL_MISMATCH");
    await assert.rejects(assertApprovedOrAuthorized({ context: rec, ...refund("400.00") }, deps), (error: unknown) => code(error) === "APPROVAL_MISMATCH", "the requester never executes its own approved request");
    await assert.rejects(assertApprovedOrAuthorized({ context: dirh, ...refund("400.00") }, deps), (error: unknown) => code(error) === "APPROVAL_MISMATCH", "for refunds the decider never executes either");
    const outcome = await assertApprovedOrAuthorized({ context: clerk, ...refund("399.00") }, deps);
    assert.equal(outcome.mode, "approved");
    assert.equal(outcome.requestId, created.id);
    assert.ok(db.$tables.approvalRequest.find((row) => row.id === created.id)!.consumedAt);
    await assert.rejects(assertApprovedOrAuthorized({ context: clerk, ...refund("399.00") }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "single use");
  });

  it("(2) implicit approval: the actor holds the approve key in the property with enough tier and is not the base author", async () => {
    const { deps, trail, fom, dirh, refund } = setup();
    const t2 = await assertApprovedOrAuthorized({ context: fom, ...refund("200.00", "pay_t2") }, deps);
    assert.equal(t2.mode, "implicit");
    assert.ok(trail.events.some((event) => event.action === "APPROVAL_DECIDED" && (event.afterJson as { implicit?: boolean }).implicit === true));
    await assert.rejects(assertApprovedOrAuthorized({ context: fom, ...refund("400.00", "pay_t3") }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "T3 is above a supervisor");
    await assert.rejects(assertApprovedOrAuthorized({ context: fom, ...refund("200.00", "pay_own"), baseAuthorUserId: "u_fom" }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "never over one's own operation");
    const t3 = await assertApprovedOrAuthorized({ context: dirh, ...refund("2999.00", "pay_t3b") }, deps);
    assert.equal(t3.mode, "implicit");
    await assert.rejects(assertApprovedOrAuthorized({ context: dirh, ...refund("20000.00", "pay_big") }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "ABOVE_T4 is never implicit");
  });

  it("(3) a platform admin and a break-glass session pass without threshold, audited as privileged", async () => {
    const { deps, trail, rec, refund } = setup();
    const platform = await assertApprovedOrAuthorized({ context: { ...rec, isPlatformAdmin: true }, ...refund("50000.00", "pay_plat") }, deps);
    assert.equal(platform.mode, "privileged");
    const emergency = await assertApprovedOrAuthorized({ context: { ...rec, breakGlassSessionId: "bg_1" }, ...refund("50000.00", "pay_bg") }, deps);
    assert.equal(emergency.mode, "privileged");
    const privileged = trail.events.filter((event) => event.action === "APPROVAL_DECIDED" && (event.afterJson as { privileged?: string }).privileged);
    assert.deepEqual(privileged.map((event) => (event.afterJson as { privileged: string }).privileged), ["platform_admin", "break_glass"]);
  });

  it("(4) a supervisor PIN authorisation (single use) equals an implicit approval with the AUTHORISER's tier", async () => {
    const { deps, rec, refund } = setup();
    const authorization = await authorize({ context: rec, authorizerEmail: "jefatura@faranda.test", pin: PIN, permissionKey: "payments.refund_approve", entityType: "payment", entityId: "pay_pin", propertyId: A, amount: "200.00", reasonCode: "guest" }, deps);
    const outcome = await assertApprovedOrAuthorized({ context: rec, ...refund("200.00", "pay_pin"), supervisorAuthorizationId: authorization.id }, deps);
    assert.equal(outcome.mode, "supervisor");
    assert.equal(outcome.supervisorAuthorizationId, authorization.id);
    await assert.rejects(assertApprovedOrAuthorized({ context: rec, ...refund("200.00", "pay_pin"), supervisorAuthorizationId: authorization.id }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "consumed");
    const tooBig = await authorize({ context: rec, authorizerEmail: "jefatura@faranda.test", pin: PIN, permissionKey: "payments.refund_approve", entityType: "payment", entityId: "pay_t3", propertyId: A, amount: "400.00", reasonCode: "guest" }, deps);
    await assert.rejects(assertApprovedOrAuthorized({ context: rec, ...refund("400.00", "pay_t3"), supervisorAuthorizationId: tooBig.id }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "the authoriser's tier (T2) does not reach T3");
  });
});

describe("corrector 8a · SEC-8A-01: a request without amount is never a blank cheque", () => {
  it("a money kind (refund, invoice_cancel, discount…) refuses a null amount with 400 at request time and at the gate", async () => {
    const { deps, rec, clerk } = setup();
    await assert.rejects(requestApproval({ context: rec, kind: "refund", entityType: "payment", entityId: "pay_null", propertyId: A, amount: null, reasonCode: "x" }, deps), (error: unknown) => status(error) === 400 && /importe/.test((error as Error).message));
    await assert.rejects(assertApprovedOrAuthorized({ context: clerk, kind: "refund", entityType: "payment", entityId: "pay_null", propertyId: A, amount: null }, deps), (error: unknown) => status(error) === 400);
    // Kinds without amount by nature (day reopen, rate change) still open without one.
    const reopen = await requestApproval({ context: clerk, kind: "day_reopen", entityType: "night_audit_run", entityId: "run_1", propertyId: A, amount: null, reasonCode: "audit_finding" }, deps);
    assert.equal(reopen.thresholdTier, "T1");
    assert.equal(reopen.requiresSecondApproval, false);
  });

  it("an approved request with a smaller amount never covers a bigger operation; an amount-less legacy row of a money kind is ABOVE_T4 and consumes only an amount-less operation", async () => {
    const { db, deps, rec, dirh, refund } = setup();
    const created = await requestApproval({ context: rec, ...refund("400.00", "pay_cap") }, deps);
    await decideApproval({ context: dirh, id: created.id, decision: "approve" }, deps);
    const clerk = { ...rec, userId: "u_clerk", permissions: ["payment.refund"] as PermissionKey[] };
    await assert.rejects(assertApprovedOrAuthorized({ context: clerk, ...refund("25000.00", "pay_cap") }, deps), (error: unknown) => code(error) === "APPROVAL_MISMATCH", "25 000 € is not covered by a 400 € approval");
    // A legacy row without amount (written before the rule) is the top tier: a supervisor cannot approve it and nobody consumes it for 25 000 €.
    db.$tables.approvalRequest.push({ id: "apr_legacy", organizationId: ORG, propertyId: A, kind: "refund", entityType: "payment", entityId: "pay_legacy", amount: null, currency: "EUR", reasonCode: "x", reasonText: null, payloadJson: null, requestedByUserId: "u_rec", status: "pending", decidedByUserId: null, decidedAt: null, decisionNote: null, secondApproverUserId: null, secondDecidedAt: null, consumedAt: null, consumedByUserId: null, expiresAt: new Date(deps.now().getTime() + 86400000), createdAt: deps.now() });
    const listed = await listApprovals({ context: dirh, kind: "refund" }, deps);
    assert.equal(listed.find((row) => row.id === "apr_legacy")?.thresholdTier, "ABOVE_T4");
    await assert.rejects(decideApproval({ context: dirh, id: "apr_legacy", decision: "approve" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED");
  });
});

describe("corrector 8a · FSOD-04: the role / level limits of role_thresholds cap the tier and the amount a role approves", () => {
  it("a manager capped at T2 / 300 € for refunds cannot approve 2 500 € (403 RBAC_LEVEL_EXCEEDED) nor consume it implicitly; other actions keep T3", async () => {
    const { db, deps, rec, dirh, roles, refund } = setup();
    db.$tables.roleThreshold.push({ id: "rt_mgr_refund", organizationId: ORG, roleId: roles.manager.id, level: null, action: "refund", tier: "T2", maxAmount: "300.00", maxPct: null, currency: "EUR", requiresSecondApproval: false });
    const created = await requestApproval({ context: rec, ...refund("2500.00", "pay_limit") }, deps);
    assert.equal(created.thresholdTier, "T3");
    await assert.rejects(decideApproval({ context: dirh, id: created.id, decision: "approve" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED" && (error as { details?: { maxTier?: string } }).details?.maxTier === "T2");
    await assert.rejects(assertApprovedOrAuthorized({ context: dirh, ...refund("2500.00", "pay_limit2") }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "no implicit approval above the role cap");
    // Within the cap (tier T2 AND ≤ 300 €) the manager still decides; 250 € is T2 but a 310 € request (also T3) is not.
    const small = await requestApproval({ context: rec, ...refund("250.00", "pay_small") }, deps);
    assert.equal((await decideApproval({ context: dirh, id: small.id, decision: "approve" }, deps)).status, "approved");
    // A different action (folio adjust) is not capped by the refund row: the manager keeps T3.
    const adjust = await assertApprovedOrAuthorized({ context: dirh, kind: "folio_adjust", entityType: "folio", entityId: "folio_1", propertyId: A, amount: "2500.00" }, deps);
    assert.equal(adjust.mode, "implicit");
  });

  it("a level limit (supervisor → T1 for discounts) caps every supervisor template; the amount cap alone refuses 280 € when maxAmount is 200 €", async () => {
    const { db, deps, rec, fom } = setup();
    db.$tables.roleThreshold.push({ id: "rt_sup_discount", organizationId: ORG, roleId: null, level: "supervisor", action: "discount", tier: "T1", maxAmount: null, maxPct: null, currency: "EUR", requiresSecondApproval: false });
    db.$tables.roleThreshold.push({ id: "rt_fom_refund", organizationId: ORG, roleId: null, level: "supervisor", action: "refund", tier: "T2", maxAmount: "200.00", maxPct: null, currency: "EUR", requiresSecondApproval: false });
    const discount = await requestApproval({ context: rec, kind: "discount", entityType: "reservation", entityId: "res_1", propertyId: A, amount: "120.00", reasonCode: "loyalty" }, deps);
    assert.equal(discount.thresholdTier, "T2");
    await assert.rejects(decideApproval({ context: fom, id: discount.id, decision: "approve" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED");
    await assert.rejects(assertApprovedOrAuthorized({ context: fom, kind: "refund", entityType: "payment", entityId: "pay_280", propertyId: A, amount: "280.00" }, deps), (error: unknown) => code(error) === "APPROVAL_REQUIRED", "280 € is T2 but above the 200 € amount cap");
    const ok = await assertApprovedOrAuthorized({ context: fom, kind: "refund", entityType: "payment", entityId: "pay_150", propertyId: A, amount: "150.00" }, deps);
    assert.equal(ok.mode, "implicit");
  });
});

describe("corrector 8a · FSOD-05: a kind may impose the rank of its decider (late day reopen → dirección financiera / general)", () => {
  it("with a registered policy the hotel director cannot approve, dirección financiera can, and the executor gate refuses a request decided by a lower rank", async () => {
    const { deps, dirh, dirfin, clerk } = setup();
    resetApprovalDecisionPoliciesForTests();
    registerApprovalDecisionPolicy("day_reopen", async () => ({ minDeciderRank: ROLE_LEVEL_RANK.general_management }));
    const late = await requestApproval({ context: clerk, kind: "day_reopen", entityType: "night_audit_run", entityId: "run_old", propertyId: A, amount: null, reasonCode: "audit_finding" }, deps);
    await assert.rejects(decideApproval({ context: dirh, id: late.id, decision: "approve" }, deps), (error: unknown) => code(error) === "RBAC_LEVEL_EXCEEDED" && (error as { details?: { requiredRank?: number } }).details?.requiredRank === ROLE_LEVEL_RANK.general_management);
    const approved = await decideApproval({ context: dirfin, id: late.id, decision: "approve" }, deps);
    assert.equal(approved.status, "approved");
    // The executor (the hotel director) consumes it only because the decider outranks the policy; the gate re-checks the decider's rank.
    const outcome = await assertApprovedOrAuthorized({ context: { ...dirh, permissions: [...dirh.permissions, "night_audit.reopen"] as PermissionKey[] }, kind: "day_reopen", entityType: "night_audit_run", entityId: "run_old", propertyId: A, amount: null, baseAuthorUserId: "u_dirh", minDeciderRank: ROLE_LEVEL_RANK.general_management }, deps);
    assert.equal(outcome.mode, "approved");
    resetApprovalDecisionPoliciesForTests();
    // Without the policy a hotel director decides a reopen; but a request HE decided never satisfies a gate that demands general management.
    const within = await requestApproval({ context: clerk, kind: "day_reopen", entityType: "night_audit_run", entityId: "run_recent", propertyId: A, amount: null, reasonCode: "audit_finding" }, deps);
    await decideApproval({ context: dirh, id: within.id, decision: "approve" }, deps);
    await assert.rejects(assertApprovedOrAuthorized({ context: { ...dirh, permissions: [...dirh.permissions, "night_audit.reopen"] as PermissionKey[] }, kind: "day_reopen", entityType: "night_audit_run", entityId: "run_recent", propertyId: A, amount: null, baseAuthorUserId: "u_dirh", minDeciderRank: ROLE_LEVEL_RANK.general_management }, deps), (error: unknown) => code(error) === "APPROVAL_MISMATCH");
  });
});

describe("corrector 8a · FSOD-11 / FX-11: the inbox lists only what the user decides IN THAT property, with display names", () => {
  it("a supervisor of A who is only reception in B never lists the refunds of B; the rows carry the names of requester, decider and hotel", async () => {
    const { db, deps, roles, rec, fom, dirh, refund } = setup();
    // u_fom also works in B as a receptionist: B's refunds are not for them to decide.
    db.$tables.userRoleAssignment.push({ id: "ura_fom_b", userId: "u_fom", roleId: roles.receptionist.id, scopeType: "property", propertyId: B, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    db.$tables.userRoleAssignment.push({ id: "ura_rec_b", userId: "u_rec", roleId: roles.receptionist.id, scopeType: "property", propertyId: B, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    const inA = await requestApproval({ context: rec, ...refund("100.00", "pay_a") }, deps);
    const inB = await requestApproval({ context: { ...rec, propertyId: B }, ...refund("100.00", "pay_b"), propertyId: B }, deps);
    await decideApproval({ context: dirh, id: inA.id, decision: "approve" }, deps);
    const forFom = await listApprovals({ context: fom }, deps);
    assert.deepEqual(forFom.map((row) => row.id), [inA.id], "the refund of B is not listed for a supervisor of A");
    assert.equal(forFom[0]!.requestedByName, "Recepción");
    assert.equal(forFom[0]!.decidedByName, "Dirección");
    assert.equal(forFom[0]!.propertyName ?? null, null, "the fake property has no name column: null, never a cuid");
    const forRec = await listApprovals({ context: rec }, deps);
    assert.deepEqual(forRec.map((row) => row.id).sort(), [inA.id, inB.id].sort(), "own requests are always listed");
  });
});
