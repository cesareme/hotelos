// Tanda 8a (RBAC · L1): break glass (§4.8) — re-authentication, emergency
// account, organisation assignment with validTo, real session, audit,
// notification note, close / expire / review. No database (fake Prisma; the
// session and MFA collaborators are injected). From apps/api:
//   node --import tsx --test src/modules/rbac/__tests__/break-glass.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword } from "@hotelos/database";
import { ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import { closeBreakGlass, expireBreakGlass, listBreakGlass, openBreakGlass, reviewBreakGlass, type BreakGlassDeps } from "../break-glass.service.js";
import { audits, fakePrisma, nextId, seedRoles, type Tables } from "./fake-prisma.mts";

const ORG = "org_bg";
const A = "prop_a";
const PASSWORD = "Contraseña-DG-1";
const code = (error: unknown) => (error as { details?: { code?: string; detail?: string } }).details?.code;
const detail = (error: unknown) => (error as { details?: { detail?: string } }).details?.detail;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;

function setup(options: { mfa?: boolean; accounts?: number; templateMissing?: boolean } = {}) {
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    property: [{ id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) }],
    user: [
      { id: "u_dg", organizationId: ORG, email: "dg@faranda.test", fullName: "Dirección general", status: "active", passwordHash: hashPassword(PASSWORD), mfaEnabled: options.mfa === true, mustChangePassword: false, passwordChangedAt: null },
      { id: "u_aud", organizationId: ORG, email: "auditoria@faranda.test", fullName: "Auditoría", status: "active", passwordHash: hashPassword(PASSWORD), mfaEnabled: false, mustChangePassword: false, passwordChangedAt: null },
      { id: "u_rec", organizationId: ORG, email: "recepcion@faranda.test", fullName: "Recepción", status: "active", passwordHash: hashPassword(PASSWORD), mfaEnabled: false, mustChangePassword: false, passwordChangedAt: null }
    ],
    session: [],
    userPropertyRole: [],
    userRoleAssignment: [],
    breakGlassSession: []
  };
  for (let index = 1; index <= (options.accounts ?? 2); index += 1) {
    tables.user!.push({ id: `u_emergency_${index}`, organizationId: ORG, email: `emergencia-${index}@faranda.test`, fullName: `Emergencia ${index}`, status: "emergency", passwordHash: null, mfaEnabled: false, mustChangePassword: false, passwordChangedAt: null });
  }
  const roles = seedRoles(tables, ORG, { general_manager: ROLE_PERMISSION_MAP.general_manager, auditor: ROLE_PERMISSION_MAP.auditor, receptionist: ROLE_PERMISSION_MAP.receptionist, break_glass: ROLE_PERMISSION_MAP.break_glass });
  const live = (id: string, userId: string, roleId: string, scope: { scopeType: string; propertyId?: string }) =>
    tables.userRoleAssignment!.push({ id, userId, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  live("ura_dg", "u_dg", roles.general_manager.id, { scopeType: "organization" });
  live("ura_aud", "u_aud", roles.auditor.id, { scopeType: "organization" });
  live("ura_rec", "u_rec", roles.receptionist.id, { scopeType: "property", propertyId: A });
  const db = fakePrisma(tables);
  const trail = audits();
  let clock = new Date("2026-09-18T10:00:00Z");
  const sessions: Array<{ userId: string; deviceId: string; auditAction?: string }> = [];
  const notified: string[] = [];
  const deps: BreakGlassDeps = {
    db: db as unknown as RbacScopeDb,
    audit: trail.audit as unknown as BreakGlassDeps["audit"],
    now: () => clock,
    createSession: (async (input: { user: { id: string; organizationId: string; fullName: string }; deviceId: string; auditAction?: string }) => {
      sessions.push({ userId: input.user.id, deviceId: input.deviceId, auditAction: input.auditAction });
      const sessionId = nextId("ses");
      db.$tables.session.push({ id: sessionId, userId: input.user.id, deviceId: input.deviceId, status: "active", createdAt: clock, revokedAt: null });
      return { token: `jwt_${sessionId}`, sessionId, user: { organizationId: input.user.organizationId, propertyId: A, userId: input.user.id, fullName: input.user.fullName, deviceId: input.deviceId, permissions: [] } };
    }) as unknown as BreakGlassDeps["createSession"],
    verifyMfa: (async (input: { code: string }) => {
      if (input.code !== "123456") throw new Error("Invalid MFA code.");
      return {};
    }) as unknown as BreakGlassDeps["verifyMfa"],
    ensureRole: (async () => ({ id: roles.break_glass.id, name: "Emergencia", permissionsCount: ROLE_PERMISSION_MAP.break_glass.length, created: false })) as unknown as BreakGlassDeps["ensureRole"],
    notify: (async (input: { recipient: string }) => {
      if (options.templateMissing !== false) throw new Error("template_not_found");
      notified.push(input.recipient);
      return {} as never;
    }) as unknown as BreakGlassDeps["notify"]
  };
  const ctx = (userId: string, permissions: readonly PermissionKey[], extra: Partial<UserContext> = {}): UserContext => ({ organizationId: ORG, propertyId: A, userId, fullName: userId, deviceId: "dev", permissions: [...permissions], orgScope: true, ...extra });
  const dg = ctx("u_dg", ROLE_PERMISSION_MAP.general_manager);
  const aud = ctx("u_aud", ROLE_PERMISSION_MAP.auditor);
  const rec = ctx("u_rec", ROLE_PERMISSION_MAP.receptionist, { orgScope: false });
  const open = { context: dg, reason: "Caída del PMS en plena llegada", ticket: "INC-42", password: PASSWORD, confirmHighRisk: true as const };
  return { db, deps, trail, roles, sessions, notified, dg, aud, rec, open, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe("openBreakGlass · re-authentication, emergency account, 4 h session, audit and notification", () => {
  it("refuses without password / confirmHighRisk / TOTP (403 BREAK_GLASS_REAUTH_REQUIRED), without the key (403) and from another emergency session", async () => {
    const { deps, open, rec, dg } = setup({ mfa: true });
    await assert.rejects(openBreakGlass({ ...open, password: undefined }, deps), (error: unknown) => code(error) === "BREAK_GLASS_REAUTH_REQUIRED" && detail(error) === "password");
    await assert.rejects(openBreakGlass({ ...open, password: "wrong" }, deps), (error: unknown) => code(error) === "BREAK_GLASS_REAUTH_REQUIRED" && detail(error) === "password");
    await assert.rejects(openBreakGlass({ ...open, confirmHighRisk: false }, deps), (error: unknown) => code(error) === "BREAK_GLASS_REAUTH_REQUIRED" && detail(error) === "confirmHighRisk");
    await assert.rejects(openBreakGlass({ ...open }, deps), (error: unknown) => code(error) === "BREAK_GLASS_REAUTH_REQUIRED" && detail(error) === "mfa", "MFA enabled: the TOTP code is mandatory");
    await assert.rejects(openBreakGlass({ ...open, mfaChallengeId: "mfa_1", code: "000000" }, deps), (error: unknown) => detail(error) === "mfa");
    await assert.rejects(openBreakGlass({ ...open, context: rec }, deps), (error: unknown) => status(error) === 403 && code(error) === undefined, "security.break_glass missing → plain 403");
    await assert.rejects(openBreakGlass({ ...open, context: { ...dg, breakGlassSessionId: "bg_x" } }, deps), (error: unknown) => code(error) === "RBAC_BREAK_GLASS_FORBIDDEN");
    const opened = await openBreakGlass({ ...open, mfaChallengeId: "mfa_1", code: "123456" }, deps);
    assert.ok(opened.sessionId);
  });

  it("opens: organisation assignment with validTo = closesAt (+4 h), real session on the emergency account, break_glass_sessions row, BREAK_GLASS_OPENED, notification note when no template exists", async () => {
    const { db, deps, trail, roles, sessions, open } = setup();
    const opened = await openBreakGlass({ ...open, ipAddress: "10.0.0.9" }, deps);
    assert.equal(opened.session.openedByUserId, "u_dg");
    assert.equal(opened.session.accountUserId, "u_emergency_1");
    assert.equal(opened.session.reason, open.reason);
    assert.equal(opened.session.ticket, "INC-42");
    assert.equal(new Date(opened.session.closesAt).getTime() - deps.now().getTime(), 4 * 60 * 60 * 1000);
    assert.equal(opened.session.closedAt, null);
    assert.equal(opened.token, `jwt_${opened.sessionId}`);
    assert.deepEqual(sessions, [{ userId: "u_emergency_1", deviceId: sessions[0]?.deviceId, auditAction: "BREAK_GLASS_SESSION" }]);
    const assignment = db.$tables.userRoleAssignment.find((row) => row.userId === "u_emergency_1");
    assert.ok(assignment);
    assert.equal(assignment.roleId, roles.break_glass.id);
    assert.equal(assignment.scopeType, "organization");
    assert.equal((assignment.validTo as Date).toISOString(), opened.session.closesAt);
    assert.equal(assignment.grantedByUserId, "u_dg");
    const row = db.$tables.breakGlassSession.find((candidate) => candidate.id === opened.session.id)!;
    assert.equal(row.sessionId, opened.sessionId);
    const audit = trail.events.find((event) => event.action === "BREAK_GLASS_OPENED");
    assert.ok(audit && audit.actorUserId === "u_dg" && audit.ipAddress === "10.0.0.9" && audit.correlationId === `bg_${opened.session.id}`);
    assert.equal(opened.notification.attempted, 2, "dirección general + auditoría hold the notified templates");
    assert.equal(opened.notification.delivered, 0);
    assert.match(opened.notification.note ?? "", /sin plantilla de notificación «break_glass_opened»/);
    assert.equal(db.$tables.organization[0].rbacVersion, 1);
  });

  it("delivers the notification when the system template exists; the second account is used while the first is busy; a third opening is 409 BREAK_GLASS_ACCOUNT_MISSING", async () => {
    const { deps, notified, open } = setup({ templateMissing: false });
    const first = await openBreakGlass(open, deps);
    assert.deepEqual([...notified].sort(), ["auditoria@faranda.test", "dg@faranda.test"]);
    assert.equal(first.notification.delivered, 2);
    const second = await openBreakGlass(open, deps);
    assert.equal(second.session.accountUserId, "u_emergency_2");
    await assert.rejects(openBreakGlass(open, deps), (error: unknown) => status(error) === 409 && code(error) === "BREAK_GLASS_ACCOUNT_MISSING");
    const none = setup({ accounts: 0 });
    await assert.rejects(openBreakGlass(none.open, none.deps), (error: unknown) => code(error) === "BREAK_GLASS_ACCOUNT_MISSING");
  });
});

describe("closeBreakGlass / expireBreakGlass / reviewBreakGlass / listBreakGlass", () => {
  it("the opener closes: session revoked, assignment revoked, closedAt, BREAK_GLASS_CLOSED; idempotent; a receptionist gets an opaque 404; the session itself may close", async () => {
    const { db, deps, trail, open, rec, dg } = setup();
    const opened = await openBreakGlass(open, deps);
    await assert.rejects(closeBreakGlass({ context: rec, id: opened.session.id }, deps), (error: unknown) => status(error) === 404);
    const closed = await closeBreakGlass({ context: dg, id: opened.session.id }, deps);
    assert.ok(closed.closedAt);
    assert.equal(closed.closedByUserId, "u_dg");
    assert.equal(db.$tables.session.find((row) => row.id === opened.sessionId)!.status, "revoked");
    const assignment = db.$tables.userRoleAssignment.find((row) => row.userId === "u_emergency_1")!;
    assert.ok(assignment.revokedAt);
    assert.equal(assignment.reason, "break_glass_closed:manual");
    assert.ok(trail.events.some((event) => event.action === "BREAK_GLASS_CLOSED" && event.actorUserId === "u_dg"));
    const again = await closeBreakGlass({ context: dg, id: opened.session.id }, deps);
    assert.equal(again.closedAt, closed.closedAt);
    // The emergency session closes itself (the account has no other way out).
    const second = await openBreakGlass(open, deps);
    const self = { ...dg, userId: "u_emergency_1", breakGlassSessionId: second.session.id };
    const selfClosed = await closeBreakGlass({ context: self, id: second.session.id }, deps);
    assert.ok(selfClosed.closedAt);
  });

  it("expireBreakGlass closes every session past its window (system actor), idempotently; review stamps the auditor; list is audit.read only", async () => {
    const { deps, trail, open, aud, rec, advance } = setup();
    const opened = await openBreakGlass(open, deps);
    assert.equal(await expireBreakGlass(deps, ORG), 0);
    advance(4 * 60 * 60 * 1000 + 1);
    assert.equal(await expireBreakGlass(deps, ORG), 1);
    assert.equal(await expireBreakGlass(deps, ORG), 0);
    const closed = trail.events.find((event) => event.action === "BREAK_GLASS_CLOSED");
    assert.ok(closed && closed.actorType === "system" && (closed.afterJson as { reason: string }).reason === "expired");
    const reviewed = await reviewBreakGlass({ context: aud, id: opened.session.id }, deps);
    assert.equal(reviewed.reviewedByUserId, "u_aud");
    assert.ok(reviewed.reviewedAt);
    assert.ok(trail.events.some((event) => event.action === "BREAK_GLASS_REVIEWED"));
    await assert.rejects(reviewBreakGlass({ context: rec, id: opened.session.id }, deps), (error: unknown) => status(error) === 403);
    const listed = await listBreakGlass({ context: aud }, deps);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, opened.session.id);
    await assert.rejects(listBreakGlass({ context: rec }, deps), (error: unknown) => status(error) === 403);
  });
});

describe("corrector 8a · SEC-8A-04 / SEC-8A-03: the review and the listing are for dirección general, administración de sistema and auditoría — never the opener nor a hotel supervisor", () => {
  it("the opener cannot review its own session (403), a property supervisor with audit.read cannot review nor list (403), the auditor can", async () => {
    const { db, deps, roles, dg, aud, rec, open } = setup();
    const opened = await openBreakGlass(open, deps);
    await assert.rejects(reviewBreakGlass({ context: dg, id: opened.session.id }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_SCOPE_EXCEEDED", "the opener never reviews its own emergency");
    // A housekeeping manager of A holds audit.read (property template) but no organisation-wide assignment.
    db.$tables.userRoleAssignment.push({ id: "ura_gob", userId: "u_gob", roleId: roles.receptionist.id, scopeType: "property", propertyId: A, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
    const supervisor = { ...rec, userId: "u_gob", permissions: [...rec.permissions, "audit.read"] as PermissionKey[], orgScope: false };
    await assert.rejects(reviewBreakGlass({ context: supervisor, id: opened.session.id }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_SCOPE_EXCEEDED");
    await assert.rejects(listBreakGlass({ context: supervisor }, deps), (error: unknown) => status(error) === 403 && code(error) === "RBAC_SCOPE_EXCEEDED");
    assert.equal(db.$tables.breakGlassSession.find((row) => row.id === opened.session.id)!.reviewedAt ?? null, null, "nothing stamped by the refused reviewers");
    const reviewed = await reviewBreakGlass({ context: aud, id: opened.session.id }, deps);
    assert.equal(reviewed.reviewedByUserId, "u_aud");
    await assert.rejects(reviewBreakGlass({ context: { ...aud, breakGlassSessionId: opened.session.id }, id: opened.session.id }, deps), (error: unknown) => status(error) === 403, "an emergency session never reviews itself");
  });
});
