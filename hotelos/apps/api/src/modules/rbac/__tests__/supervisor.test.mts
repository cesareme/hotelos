// Tanda 8a (RBAC · L1): supervisor PIN (§5.6) — set own PIN with the password,
// authorise ONE action of another user with the PIN, lockout after 5 failures,
// single-use consumption. No database (fake Prisma). From apps/api:
//   node --import tsx --test src/modules/rbac/__tests__/supervisor.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword } from "@hotelos/database";
import { ROLE_PERMISSION_MAP } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import type { RbacDeps } from "../assignments.service.js";
import { PIN_MAX_FAILED_ATTEMPTS, authorize, consumeSupervisorAuthorization, setOwnPin } from "../supervisor.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "./fake-prisma.mts";

const ORG = "org_pin";
const A = "prop_a";
const B = "prop_b";
const PASSWORD = "Contraseña-segura-1";
const PIN = "4711";

function setup() {
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Test", rbacVersion: 0 }],
    property: [
      { id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) },
      { id: B, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 2) }
    ],
    user: [
      { id: "u_rec", organizationId: ORG, email: "recepcion@faranda.test", fullName: "Recepción", status: "active", passwordHash: hashPassword(PASSWORD), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_jefa", organizationId: ORG, email: "jefatura@faranda.test", fullName: "Jefa de recepción", status: "active", passwordHash: hashPassword(PASSWORD), pinHash: hashPassword(PIN), pinFailedAttempts: 0, pinLockedUntil: null },
      { id: "u_other_org", organizationId: "org_other", email: "jefatura@example.com", fullName: "Otra", status: "active", passwordHash: hashPassword(PASSWORD), pinHash: hashPassword(PIN), pinFailedAttempts: 0, pinLockedUntil: null }
    ],
    userPropertyRole: [],
    userRoleAssignment: []
  };
  const roles = seedRoles(tables, ORG, { front_office_manager: ROLE_PERMISSION_MAP.front_office_manager, receptionist: ROLE_PERMISSION_MAP.receptionist });
  tables.userRoleAssignment!.push({ id: "ura_jefa", userId: "u_jefa", roleId: roles.front_office_manager.id, scopeType: "property", propertyId: A, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  tables.userRoleAssignment!.push({ id: "ura_rec", userId: "u_rec", roleId: roles.receptionist.id, scopeType: "property", propertyId: A, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  const db = fakePrisma(tables);
  const trail = audits();
  let clock = new Date("2026-09-18T10:00:00Z");
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => clock };
  const actor: UserContext = { organizationId: ORG, propertyId: A, userId: "u_rec", fullName: "Recepción", deviceId: "dev_rec", permissions: ROLE_PERMISSION_MAP.receptionist };
  const base = { context: actor, authorizerEmail: "jefatura@faranda.test", pin: PIN, permissionKey: "pms.reservation.override", entityType: "reservation", entityId: "res_1", propertyId: A, amount: "120.00", reasonCode: "rate_override" };
  return { db, deps, trail, actor, base, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;

describe("setOwnPin · the user proves the password and gets a hashed PIN", () => {
  it("stores a scrypt hash, resets the lockout counters and audits; rejects a bad password or a malformed PIN", async () => {
    const { db, deps, trail, actor } = setup();
    const result = await setOwnPin({ context: actor, password: PASSWORD, pin: "123456" }, deps);
    assert.equal(result.userId, "u_rec");
    const row = db.$tables.user.find((user) => user.id === "u_rec")!;
    assert.ok(typeof row.pinHash === "string" && (row.pinHash as string).startsWith("scrypt$1$"));
    assert.notEqual(row.pinHash, "123456");
    assert.ok(trail.events.some((event) => event.action === "SUPERVISOR_PIN_SET"));
    await assert.rejects(setOwnPin({ context: actor, password: "wrong", pin: "123456" }, deps), (error: unknown) => status(error) === 403 && code(error) === "BREAK_GLASS_REAUTH_REQUIRED");
    await assert.rejects(setOwnPin({ context: actor, password: PASSWORD, pin: "12" }, deps), (error: unknown) => status(error) === 400);
    await assert.rejects(setOwnPin({ context: { ...actor, breakGlassSessionId: "bg" }, password: PASSWORD, pin: "1234" }, deps), (error: unknown) => code(error) === "RBAC_BREAK_GLASS_FORBIDDEN");
  });
});

describe("authorize · a present supervisor authorises one action with the PIN", () => {
  it("creates a 60 s single-use authorisation bound to actor, key and entity, and audits actor / authoriser / reason / amount / IP", async () => {
    const { deps, trail, base } = setup();
    const authorization = await authorize({ ...base, ipAddress: "10.0.0.7" }, deps);
    assert.equal(authorization.actorUserId, "u_rec");
    assert.equal(authorization.authorizerUserId, "u_jefa");
    assert.equal(authorization.permissionKey, "pms.reservation.override");
    assert.equal(authorization.amount, "120.00");
    assert.equal(authorization.usedAt, null);
    assert.equal(new Date(authorization.expiresAt).getTime() - deps.now().getTime(), 60_000);
    const event = trail.events.find((candidate) => candidate.action === "SUPERVISOR_AUTHORIZED");
    assert.ok(event);
    assert.equal(event.actorUserId, "u_rec");
    assert.equal(event.ipAddress, "10.0.0.7");
    assert.equal((event.afterJson as { authorizerUserId: string }).authorizerUserId, "u_jefa");
    assert.equal((event.afterJson as { reasonCode: string }).reasonCode, "rate_override");
  });

  it("every «who» failure is the same opaque SUPERVISOR_PIN_INVALID: self, other organisation, unknown email, no PIN, key not held in that property", async () => {
    const { deps, base, actor } = setup();
    const invalid = (error: unknown) => status(error) === 403 && code(error) === "SUPERVISOR_PIN_INVALID";
    await assert.rejects(authorize({ ...base, context: { ...actor, userId: "u_jefa" } }, deps), invalid, "actor ≠ authoriser");
    await assert.rejects(authorize({ ...base, authorizerEmail: "jefatura@example.com" }, deps), invalid, "other organisation");
    await assert.rejects(authorize({ ...base, authorizerEmail: "nadie@faranda.test" }, deps), invalid, "unknown email");
    await assert.rejects(authorize({ ...base, authorizerEmail: "recepcion@faranda.test", context: { ...actor, userId: "u_jefa" } }, deps), invalid, "authoriser without PIN");
    await assert.rejects(authorize({ ...base, propertyId: B }, deps), invalid, "the authoriser holds the key in A, not in B");
    await assert.rejects(authorize({ ...base, permissionKey: "payables.pay" }, deps), invalid, "a key the front office manager never holds");
    await assert.rejects(authorize({ ...base, permissionKey: "no.such.key" }, deps), (error: unknown) => status(error) === 400);
  });

  it("a wrong PIN increments the counter; the fifth failure locks 15 minutes (423 SUPERVISOR_PIN_LOCKED) and a valid PIN afterwards still waits", async () => {
    const { db, deps, base, trail, advance } = setup();
    for (let attempt = 1; attempt < PIN_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await assert.rejects(authorize({ ...base, pin: "0000" }, deps), (error: unknown) => code(error) === "SUPERVISOR_PIN_INVALID");
      assert.equal(db.$tables.user.find((user) => user.id === "u_jefa")!.pinFailedAttempts, attempt);
    }
    await assert.rejects(authorize({ ...base, pin: "0000" }, deps), (error: unknown) => status(error) === 423 && code(error) === "SUPERVISOR_PIN_LOCKED");
    const locked = db.$tables.user.find((user) => user.id === "u_jefa")!;
    assert.equal(locked.pinFailedAttempts, 0);
    assert.ok(locked.pinLockedUntil instanceof Date && (locked.pinLockedUntil as Date).getTime() === deps.now().getTime() + 15 * 60_000);
    assert.ok(trail.events.some((event) => event.action === "SUPERVISOR_PIN_LOCKED"));
    await assert.rejects(authorize(base, deps), (error: unknown) => status(error) === 423, "still locked with the right PIN");
    advance(16 * 60_000);
    const authorization = await authorize(base, deps);
    assert.equal(authorization.authorizerUserId, "u_jefa");
    assert.equal(db.$tables.user.find((user) => user.id === "u_jefa")!.pinLockedUntil, null, "a success clears the lock");
  });
});

describe("consumeSupervisorAuthorization · single use, every field must match, expiry", () => {
  it("consumes once; a second use, a different actor / key / entity or an expired authorisation return null", async () => {
    const { deps, base, advance } = setup();
    const authorization = await authorize(base, deps);
    const match = { actorUserId: "u_rec", permissionKey: "pms.reservation.override", entityType: "reservation", entityId: "res_1" };
    assert.equal(await consumeSupervisorAuthorization(authorization.id, { ...match, actorUserId: "u_jefa" }, deps), null, "another actor");
    assert.equal(await consumeSupervisorAuthorization(authorization.id, { ...match, permissionKey: "payments.refund_approve" }, deps), null, "another key");
    assert.equal(await consumeSupervisorAuthorization(authorization.id, { ...match, entityId: "res_2" }, deps), null, "another entity");
    const used = await consumeSupervisorAuthorization(authorization.id, match, deps);
    assert.ok(used && used.usedAt !== null);
    assert.equal(await consumeSupervisorAuthorization(authorization.id, match, deps), null, "single use");
    const second = await authorize({ ...base, entityId: "res_9" }, deps);
    advance(61_000);
    assert.equal(await consumeSupervisorAuthorization(second.id, { ...match, entityId: "res_9" }, deps), null, "expired after 60 s");
  });
});
