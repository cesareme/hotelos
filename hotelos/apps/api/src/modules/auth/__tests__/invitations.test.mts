// Unit tests for the staff-invitation core (Tanda 3 · invitaciones).
// Pure-core only: no database, no live email provider. Run from apps/api with
//   node --import tsx --test src/modules/auth/__tests__/invitations.test.mts
// Tanda 8a (L3): acceptInvitation runs against the fake Prisma of the rbac
// module (injected deps) and must write the grant in BOTH tables —
// user_property_roles (scope property) and user_role_assignments (real scope).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { INVITATION_MAX_DAYS, ROLE_PERMISSION_MAP } from "@hotelos/shared";
import {
  INVITATION_INVALID_CODE,
  INVITATION_MAX_TTL_HOURS,
  INVITATION_TTL_HOURS,
  REDACTED_TOKEN,
  acceptInvitation,
  appBaseUrl,
  buildInviteUrl,
  buildPasswordResetUrl,
  classifyDelivery,
  emailStatus,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationGrantScope,
  invitationRequiresMfa,
  invitationState,
  type AcceptInvitationDeps
} from "../invitations.service.js";
import type { LoginResult } from "../auth.service.js";
import { audits, fakePrisma, matchWhere, nextId, seedRoles, type Row, type Tables } from "../../rbac/__tests__/fake-prisma.mts";
import { deriveMustChangePassword } from "../auth.service.js";
import {
  PASSWORD_CHANGE_ALLOWLIST,
  PASSWORD_CHANGE_REQUIRED_CODE,
  isPasswordChangeAllowedRoute,
  isPublicRoute,
  passwordChangeRequiredError
} from "../../../lib/auth-context.js";
import { pickTemplate, type NotificationTemplateRow } from "../../notifications/templates.service.js";
import { SYSTEM_TEMPLATES, resolveSystemTemplate, systemTemplateToRecord } from "../../notifications/system-templates.js";
import { renderTemplate } from "../../notifications/template-renderer.service.js";
import type { NotificationDeliveryRecord } from "../../notifications/dispatcher.service.js";
import type { EmailStatus } from "../../notifications/providers/email.provider.js";

const NOW = new Date("2026-09-14T10:00:00.000Z");

function delivery(overrides: Partial<NotificationDeliveryRecord> = {}): NotificationDeliveryRecord {
  return {
    id: "dlv_1",
    organizationId: "org_1",
    propertyId: null,
    notificationId: "invite:inv_1",
    templateCode: "user_invitation",
    channel: "email",
    recipient: "ana@example.com",
    status: "sent",
    providerMessageId: null,
    subject: "x",
    bodyRendered: "y",
    payloadJson: null,
    attempts: 1,
    errorMessage: null,
    scheduledFor: null,
    sentAt: NOW.toISOString(),
    failedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides
  };
}

const REAL: EmailStatus = { configured: true, provider: "postmark", from: "no-reply@hotel.test", mode: "real" };
const SIMULATED: EmailStatus = { configured: false, provider: null, from: null, mode: "simulated" };
const DISABLED: EmailStatus = { configured: false, provider: null, from: null, mode: "disabled" };

describe("invitation token — generation, hashing, URL", () => {
  it("generates 32 random bytes as base64url (43 chars, URL-safe) and never repeats", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    assert.equal(a.length, 43);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(a, b);
  });

  it("persists only the sha256 hex of the token (deterministic, 64 chars)", () => {
    const token = "tok_" + "a".repeat(40);
    const expected = createHash("sha256").update(token, "utf8").digest("hex");
    assert.equal(hashInvitationToken(token), expected);
    assert.equal(hashInvitationToken(token).length, 64);
    assert.notEqual(hashInvitationToken(token), hashInvitationToken(token + "x"));
  });

  it("builds the accept-invite URL from APP_BASE_URL (default localhost:5173, trailing slash stripped, token encoded)", () => {
    assert.equal(appBaseUrl({}), "http://localhost:5173");
    assert.equal(appBaseUrl({ APP_BASE_URL: "https://app.hotel.test/" }), "https://app.hotel.test");
    assert.equal(buildInviteUrl("ab+c", {}), "http://localhost:5173/accept-invite?token=ab%2Bc");
    assert.equal(
      buildPasswordResetUrl("t0k", { APP_BASE_URL: "https://app.hotel.test//" }),
      "https://app.hotel.test/reset-password?token=t0k"
    );
  });

  it("expires 72 h after issue", () => {
    assert.equal(INVITATION_TTL_HOURS, 72);
    assert.equal(invitationExpiresAt(NOW).getTime() - NOW.getTime(), 72 * 60 * 60 * 1000);
  });

  it("Tanda 8a: never lives longer than INVITATION_MAX_DAYS (7 days), whatever TTL a caller asks for; a bogus TTL falls back to the default", () => {
    assert.equal(INVITATION_MAX_TTL_HOURS, INVITATION_MAX_DAYS * 24);
    assert.equal(invitationExpiresAt(NOW, 24 * 30).getTime() - NOW.getTime(), INVITATION_MAX_DAYS * 24 * 60 * 60 * 1000);
    assert.equal(invitationExpiresAt(NOW, 24).getTime() - NOW.getTime(), 24 * 60 * 60 * 1000);
    assert.equal(invitationExpiresAt(NOW, 0).getTime() - NOW.getTime(), 72 * 60 * 60 * 1000);
    assert.equal(invitationExpiresAt(NOW, Number.NaN).getTime() - NOW.getTime(), 72 * 60 * 60 * 1000);
    assert.ok(INVITATION_TTL_HOURS <= INVITATION_MAX_TTL_HOURS);
  });

  it("Tanda 8a (D8): templates of level N2+ require 2FA enrolment; N1, custom and unknown templates do not", () => {
    assert.equal(invitationRequiresMfa("front_office_manager"), true);
    assert.equal(invitationRequiresMfa("manager"), true);
    assert.equal(invitationRequiresMfa("general_manager"), true);
    assert.equal(invitationRequiresMfa("receptionist"), false);
    assert.equal(invitationRequiresMfa("housekeeper"), false);
    assert.equal(invitationRequiresMfa(null), false);
    assert.equal(invitationRequiresMfa("no-such-template"), false);
  });

  it("Tanda 8a: the grant scope of a row — explicit scope wins; a pre-Tanda-8a row (propertyId only) is scope property; no role → no grant", () => {
    assert.deepEqual(invitationGrantScope({ propertyId: "prop_1", roleId: "role_1" }), { roleId: "role_1", scopeType: "property", scopeRef: "prop_1" });
    assert.deepEqual(invitationGrantScope({ propertyId: "prop_1", roleId: "role_1", scopeType: "organization", scopeRef: "org_1" }), { roleId: "role_1", scopeType: "organization", scopeRef: "org_1" });
    assert.deepEqual(invitationGrantScope({ propertyId: null, roleId: "role_1", scopeType: "legal_entity", scopeRef: "le_1" }), { roleId: "role_1", scopeType: "legal_entity", scopeRef: "le_1" });
    assert.equal(invitationGrantScope({ propertyId: "prop_1", roleId: null }), null);
    assert.equal(invitationGrantScope({ propertyId: null, roleId: "role_1" }), null);
    assert.equal(invitationGrantScope({ propertyId: null, roleId: "role_1", scopeType: "property_group", scopeRef: null }), null);
  });
});

// ───────────────────────────────────────────── acceptInvitation · dual-write (fake Prisma)

/** Minimal delegate for the models the rbac fake does not ship (user_invitations, password_reset_tokens). */
function plainDelegate(tables: Tables, model: string) {
  const rows = (): Row[] => (tables[model] ??= []);
  const query = (where?: Record<string, unknown>): Row[] => rows().filter((row) => matchWhere(row, where));
  return {
    findUnique: async (args: { where?: Record<string, unknown> }) => {
      const hit = query(args.where)[0];
      return hit ? { ...hit } : null;
    },
    findFirst: async (args: { where?: Record<string, unknown> } = {}) => {
      const hit = query(args.where)[0];
      return hit ? { ...hit } : null;
    },
    findMany: async (args: { where?: Record<string, unknown> } = {}) => query(args.where).map((row) => ({ ...row })),
    create: async (args: { data: Record<string, unknown> }) => {
      const row: Row = { id: nextId(model), createdAt: new Date(), ...args.data };
      rows().push(row);
      return { ...row };
    },
    update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const index = rows().findIndex((row) => matchWhere(row, args.where));
      if (index < 0) throw new Error(`fake ${model}: row not found`);
      rows()[index] = { ...rows()[index], ...args.data };
      return { ...rows()[index] };
    },
    updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      const all = rows();
      for (let index = 0; index < all.length; index += 1) {
        if (!matchWhere(all[index], args.where)) continue;
        all[index] = { ...all[index], ...args.data };
        count += 1;
      }
      return { count };
    }
  };
}

const ACCEPT_ORG = "org_inv";
const ACCEPT_PROPERTY = "prop_lt";
const INVITEE = "u_invitee";
const INVITER = "u_inviter";
const ACCEPT_NOW = new Date("2026-09-18T12:00:00.000Z");
const STRONG_PASSWORD = "Recepcion-2026!";

type SeededRoleIds = Record<string, { id: string }>;

function acceptSetup(invitation: Partial<Row> | ((roles: SeededRoleIds) => Partial<Row>)) {
  const token = generateInvitationToken();
  const tables: Partial<Tables> = {
    organization: [{ id: ACCEPT_ORG, name: "Faranda", rbacVersion: 0 }],
    property: [
      { id: ACCEPT_PROPERTY, organizationId: ACCEPT_ORG, name: "Los Tilos", legalEntityId: "le_1", createdAt: new Date(2026, 0, 1) },
      { id: "prop_ra", organizationId: ACCEPT_ORG, name: "Rías Altas", legalEntityId: "le_1", createdAt: new Date(2026, 0, 2) }
    ],
    user: [
      { id: INVITEE, organizationId: ACCEPT_ORG, email: "nueva@faranda.test", fullName: "Nueva", status: "invited", mfaEnabled: false, passwordHash: null, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null },
      { id: INVITER, organizationId: ACCEPT_ORG, email: "direccion@faranda.test", fullName: "Dirección", status: "active", mfaEnabled: true, passwordHash: "x", mustChangePassword: false }
    ],
    session: [{ id: "sess_old", userId: INVITEE, deviceId: "dev_old", status: "active", revokedAt: null }],
    userPropertyRole: [],
    userRoleAssignment: []
  };
  const roles = seedRoles(tables, ACCEPT_ORG, { receptionist: ROLE_PERMISSION_MAP.receptionist, owner: ROLE_PERMISSION_MAP.owner, break_glass: ROLE_PERMISSION_MAP.break_glass });
  const overrides = typeof invitation === "function" ? invitation(roles) : invitation;
  const base = fakePrisma(tables);
  const extra = { userInvitation: plainDelegate(base.$tables, "userInvitation"), passwordResetToken: plainDelegate(base.$tables, "passwordResetToken") };
  base.$tables.userInvitation = [
    {
      id: "inv_1",
      userId: INVITEE,
      organizationId: ACCEPT_ORG,
      propertyId: ACCEPT_PROPERTY,
      roleId: roles.receptionist.id,
      scopeType: "property",
      scopeRef: ACCEPT_PROPERTY,
      invitedByUserId: INVITER,
      createdByUserId: INVITER,
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(ACCEPT_NOW.getTime() + 60 * 60 * 1000),
      usedAt: null,
      revokedAt: null,
      createdAt: ACCEPT_NOW,
      ...overrides
    },
    { id: "inv_other", userId: INVITEE, organizationId: ACCEPT_ORG, propertyId: null, roleId: null, tokenHash: "other", expiresAt: new Date(ACCEPT_NOW.getTime() + 60 * 60 * 1000), usedAt: null, revokedAt: null, createdAt: ACCEPT_NOW }
  ];
  base.$tables.passwordResetToken = [{ id: "prt_1", userId: INVITEE, usedAt: null }];
  const db = Object.assign(base, extra, { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db) });
  const trail = audits();
  const sessions: Array<{ userId: string; deviceId: string }> = [];
  const logins: string[] = [];
  const deps: AcceptInvitationDeps = {
    db: db as unknown as AcceptInvitationDeps["db"],
    now: () => ACCEPT_NOW,
    audit: trail.audit as unknown as AcceptInvitationDeps["audit"],
    recordLogin: async (userId: string) => {
      logins.push(userId);
    },
    openSession: (async (input: { user: { id: string }; deviceId: string }) => {
      sessions.push({ userId: input.user.id, deviceId: input.deviceId });
      return { token: "jwt", sessionId: "sess_new", user: { userId: input.user.id } } as unknown as LoginResult;
    }) as unknown as AcceptInvitationDeps["openSession"]
  };
  return { token, db, roles, trail, sessions, logins, deps };
}

describe("acceptInvitation — Tanda 8a dual-write (fake Prisma)", () => {
  it("a property invitation activates the user and creates the grant in BOTH tables: user_property_roles + user_role_assignments (scope property, granted by the inviter), audited as ROLE_ASSIGNED", async () => {
    const { token, db, roles, trail, sessions, logins, deps } = acceptSetup({});
    const result = await acceptInvitation({ token, password: STRONG_PASSWORD, deviceId: "dev_new" }, deps);
    assert.equal(result.sessionId, "sess_new");
    assert.deepEqual(sessions, [{ userId: INVITEE, deviceId: "dev_new" }]);
    assert.deepEqual(logins, [INVITEE]);

    const user = db.$tables.user.find((row) => row.id === INVITEE)!;
    assert.equal(user.status, "active");
    assert.equal(user.mustChangePassword, false);
    assert.ok(typeof user.passwordHash === "string" && (user.passwordHash as string).length > 20, "scrypt hash stored");
    assert.equal((user.passwordChangedAt as Date).getTime(), ACCEPT_NOW.getTime());

    const legacy = db.$tables.userPropertyRole;
    assert.equal(legacy.length, 1, "one user_property_roles row (dual-read until L6)");
    assert.deepEqual([legacy[0]!.userId, legacy[0]!.propertyId, legacy[0]!.roleId], [INVITEE, ACCEPT_PROPERTY, roles.receptionist.id]);

    const assignments = db.$tables.userRoleAssignment;
    assert.equal(assignments.length, 1, "one user_role_assignments row");
    const assignment = assignments[0]!;
    assert.equal(assignment.userId, INVITEE);
    assert.equal(assignment.roleId, roles.receptionist.id);
    assert.equal(assignment.scopeType, "property");
    assert.equal(assignment.propertyId, ACCEPT_PROPERTY);
    assert.equal(assignment.organizationId, ACCEPT_ORG);
    assert.equal(assignment.grantedByUserId, INVITER);
    assert.equal(assignment.reason, "invitación aceptada");
    assert.equal(assignment.revokedAt ?? null, null, "live (Prisma defaults revokedAt to NULL; the fake omits the column)");
    assert.equal((assignment.validFrom as Date).getTime(), ACCEPT_NOW.getTime());
    assert.equal(db.$tables.organization[0]!.rbacVersion, 1, "live sessions re-read their scope");

    const invitation = db.$tables.userInvitation.find((row) => row.id === "inv_1")!;
    assert.equal((invitation.usedAt as Date).getTime(), ACCEPT_NOW.getTime(), "single use");
    assert.equal((db.$tables.userInvitation.find((row) => row.id === "inv_other")!.revokedAt as Date).getTime(), ACCEPT_NOW.getTime(), "other pending links die");
    assert.equal((db.$tables.passwordResetToken[0]!.usedAt as Date).getTime(), ACCEPT_NOW.getTime());
    assert.equal(db.$tables.session.find((row) => row.id === "sess_old")!.status, "revoked");

    const actions = trail.events.map((event) => event.action);
    assert.deepEqual(actions, ["USER_INVITATION_ACCEPTED", "ROLE_ASSIGNED"]);
    const granted = trail.events.find((event) => event.action === "ROLE_ASSIGNED")!;
    assert.equal(granted.actorUserId, INVITER, "the grant was decided by the inviter, never by the invitee");
    assert.equal(granted.actorType, "user");
    assert.equal(granted.entityId, assignment.id);
    assert.deepEqual((granted.afterJson as { scopeType: string; propertyId: string; acceptedByUserId: string }).scopeType, "property");
    assert.equal((granted.afterJson as { acceptedByUserId: string }).acceptedByUserId, INVITEE);
    assert.equal((trail.events[0]!.afterJson as { assignmentId: string }).assignmentId, assignment.id);
  });

  it("an organisation-scope invitation creates the organization assignment and NO legacy row; accepting twice is a 404 and writes nothing more", async () => {
    const { token, db, roles, deps } = acceptSetup((seeded) => ({ propertyId: null, roleId: seeded.owner!.id, scopeType: "organization", scopeRef: ACCEPT_ORG }));
    await acceptInvitation({ token, password: STRONG_PASSWORD }, deps);
    assert.equal(db.$tables.userPropertyRole.length, 0, "organization scope has no per-property legacy row");
    assert.equal(db.$tables.userRoleAssignment.length, 1);
    assert.deepEqual([db.$tables.userRoleAssignment[0]!.scopeType, db.$tables.userRoleAssignment[0]!.propertyId, db.$tables.userRoleAssignment[0]!.roleId], ["organization", null, roles.owner.id]);
    await assert.rejects(acceptInvitation({ token, password: STRONG_PASSWORD }, deps), (error: unknown) => (error as { statusCode: number }).statusCode === 404 && (error as { details: { code: string } }).details.code === INVITATION_INVALID_CODE);
    assert.equal(db.$tables.userRoleAssignment.length, 1);
  });

  it("a pre-Tanda-8a row (propertyId + roleId, no scope columns) still grants scope property in both tables", async () => {
    const { token, db, deps } = acceptSetup({ scopeType: null, scopeRef: null, invitedByUserId: null });
    await acceptInvitation({ token, password: STRONG_PASSWORD }, deps);
    assert.equal(db.$tables.userPropertyRole.length, 1);
    assert.equal(db.$tables.userRoleAssignment.length, 1);
    assert.equal(db.$tables.userRoleAssignment[0]!.scopeType, "property");
    assert.equal(db.$tables.userRoleAssignment[0]!.grantedByUserId, INVITER, "falls back to createdByUserId");
  });

  it("an invitation whose role became the emergency template (or vanished) is an opaque 404 and activates nobody", async () => {
    const { token, db, roles, deps } = acceptSetup({});
    db.$tables.userInvitation[0]!.roleId = roles.break_glass.id;
    await assert.rejects(acceptInvitation({ token, password: STRONG_PASSWORD }, deps), (error: unknown) => (error as { statusCode: number }).statusCode === 404);
    assert.equal(db.$tables.userRoleAssignment.length, 0);
    assert.equal(db.$tables.userPropertyRole.length, 0);
    // The fake $transaction does not roll back: the honest check is that no grant exists and the session never opened.
  });

  it("a weak password is a 400 before any read; a short or unknown token is the generic 404", async () => {
    const { token, deps } = acceptSetup({});
    await assert.rejects(acceptInvitation({ token, password: "short" }, deps), (error: unknown) => (error as { statusCode: number }).statusCode === 400);
    await assert.rejects(acceptInvitation({ token: "abc", password: STRONG_PASSWORD }, deps), (error: unknown) => (error as { statusCode: number }).statusCode === 404);
    await assert.rejects(acceptInvitation({ token: `${token}x`, password: STRONG_PASSWORD }, deps), (error: unknown) => (error as { statusCode: number }).statusCode === 404);
  });
});

describe("invitation lifecycle — expiry, single use, revocation", () => {
  const fresh = () => ({ expiresAt: invitationExpiresAt(NOW), usedAt: null, revokedAt: null });

  it("a fresh invitation is valid until the exact expiry instant, then expired", () => {
    const row = fresh();
    assert.equal(invitationState(row, NOW), "valid");
    assert.equal(invitationState(row, new Date(row.expiresAt.getTime() - 1)), "valid");
    assert.equal(invitationState(row, row.expiresAt), "expired");
    assert.equal(invitationState(row, new Date(row.expiresAt.getTime() + 1)), "expired");
  });

  it("a used invitation is 'used' forever (single use), even before expiry", () => {
    const row = { ...fresh(), usedAt: new Date(NOW.getTime() + 60_000) };
    assert.equal(invitationState(row, new Date(NOW.getTime() + 120_000)), "used");
  });

  it("a revoked (re-issued / revoked) invitation is 'revoked' and stays so after expiry", () => {
    const row = { ...fresh(), revokedAt: NOW };
    assert.equal(invitationState(row, NOW), "revoked");
    assert.equal(invitationState(row, new Date(row.expiresAt.getTime() + 1)), "revoked");
  });

  it("used wins over revoked and expired (the audit trail keeps the strongest fact)", () => {
    const row = { expiresAt: new Date(NOW.getTime() - 1), usedAt: NOW, revokedAt: NOW };
    assert.equal(invitationState(row, NOW), "used");
  });
});

describe("delivery classification — honest sent | simulated | failed | disabled", () => {
  it("a real provider that accepted the message is 'sent' with the provider name", () => {
    assert.deepEqual(classifyDelivery(delivery(), null, REAL), { status: "sent", provider: "postmark", deliveryId: "dlv_1" });
  });

  it("a 'sent' delivery without a configured provider is 'simulated' (never claims a real send)", () => {
    const simulated = classifyDelivery(
      delivery({ errorMessage: "SIMULADO: proveedor no configurado; no se envió de verdad." }),
      null,
      SIMULATED
    );
    assert.equal(simulated.status, "simulated");
    assert.match(simulated.errorMessage ?? "", /SIMULADO/);
    // Even if the dispatcher forgot the note, the env decides: no provider → simulated.
    assert.equal(classifyDelivery(delivery(), null, SIMULATED).status, "simulated");
  });

  it("a provider rejection is 'failed' with the provider error; in production without provider it is 'disabled'", () => {
    const failed = classifyDelivery(delivery({ status: "failed", errorMessage: "Postmark HTTP 422" }), null, REAL);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorMessage, "Postmark HTTP 422");
    const disabled = classifyDelivery(
      delivery({ status: "failed", errorMessage: "Email provider not configured (set EMAIL_PROVIDER, EMAIL_PROVIDER_KEY, EMAIL_FROM)." }),
      null,
      DISABLED
    );
    assert.equal(disabled.status, "disabled");
  });

  it("a dispatcher exception (template_not_found, DB error) is 'failed' with the message — the invitation itself survives", () => {
    const outcome = classifyDelivery(null, "template_not_found", REAL);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorMessage, "template_not_found");
    assert.equal(outcome.deliveryId, undefined);
    assert.equal(classifyDelivery(null, "boom", DISABLED).status, "disabled");
  });

  it("emailStatus() reports real | simulated | disabled from the env and never the key", () => {
    assert.deepEqual(emailStatus({}), { configured: false, provider: null, from: null, mode: "simulated" });
    assert.deepEqual(emailStatus({ NODE_ENV: "production", EMAIL_PROVIDER_KEY: "change-me" }), {
      configured: false,
      provider: null,
      from: null,
      mode: "disabled"
    });
    const real = emailStatus({ EMAIL_PROVIDER: "Postmark", EMAIL_PROVIDER_KEY: "pm-secret", EMAIL_FROM: "no-reply@hotel.test" });
    assert.deepEqual(real, { configured: true, provider: "postmark", from: "no-reply@hotel.test", mode: "real" });
    assert.equal(JSON.stringify(real).includes("pm-secret"), false);
    // A placeholder key is "not configured" even with provider + from.
    assert.equal(emailStatus({ EMAIL_PROVIDER: "sendgrid", EMAIL_PROVIDER_KEY: "change-me", EMAIL_FROM: "a@b.c" }).configured, false);
  });

  it("REDACTED_TOKEN is a stable, recognisable placeholder", () => {
    assert.equal(REDACTED_TOKEN, "[token-oculto]");
  });
});

describe("mustChangePassword — forced rotation rule", () => {
  const base = { mustChangePassword: false, passwordHash: "scrypt$1$salt$hash", passwordChangedAt: NOW, status: "active" };

  it("an active user whose password was changed at some point is NOT forced", () => {
    assert.equal(deriveMustChangePassword(base), false);
  });

  it("the explicit User.mustChangePassword flag always wins", () => {
    assert.equal(deriveMustChangePassword({ ...base, mustChangePassword: true }), true);
    assert.equal(deriveMustChangePassword({ ...base, mustChangePassword: true, status: "invited", passwordHash: null }), true);
  });

  it("a never-rotated password alone does NOT force rotation (integration decision: only the explicit flag does, so seed/legacy users keep working)", () => {
    assert.equal(deriveMustChangePassword({ ...base, passwordChangedAt: null }), false);
  });

  it("an invited user without a password is not 'must change' (cannot log in at all until accepting)", () => {
    assert.equal(deriveMustChangePassword({ ...base, passwordHash: null, passwordChangedAt: null, status: "invited" }), false);
  });

  it("a disabled user with a never-rotated password is not flagged (disabled is stronger)", () => {
    assert.equal(deriveMustChangePassword({ ...base, passwordChangedAt: null, status: "disabled" }), false);
  });
});

describe("auth-context — public routes and the PASSWORD_CHANGE allowlist", () => {
  it("forgot/reset/password-policy/accept-invite/invitations are public (no bearer → handler runs)", () => {
    for (const url of [
      "/auth/forgot-password",
      "/auth/reset-password",
      "/auth/password-policy",
      "/auth/accept-invite",
      "/auth/invitations/abc123?x=1",
      "/auth/login"
    ]) {
      assert.equal(isPublicRoute(url), true, url);
    }
    for (const url of ["/auth/change-password", "/auth/invitationsX", "/users", "/backoffice/properties/p/users/invite"]) {
      assert.equal(isPublicRoute(url), false, url);
    }
  });

  it("the allowlist lets a must-change user reach only change-password, policy, login, sessions, users/me and health", () => {
    assert.deepEqual([...PASSWORD_CHANGE_ALLOWLIST], [
      "/auth/change-password",
      "/auth/password-policy",
      "/auth/login",
      "/auth/sessions",
      "/users/me",
      "/health"
    ]);
    for (const url of ["/auth/change-password", "/auth/sessions/abc", "/users/me?full=1", "/users/me/preferences", "/health/ready"]) {
      assert.equal(isPasswordChangeAllowedRoute(url), true, url);
    }
    for (const url of ["/users/me2", "/users", "/reservations", "/auth/logout", "/backoffice/properties/p/readiness"]) {
      assert.equal(isPasswordChangeAllowedRoute(url), false, url);
    }
  });

  it("the guard error is a 403 with details.code PASSWORD_CHANGE_REQUIRED and a Spanish message", () => {
    const error = passwordChangeRequiredError();
    assert.equal(error.statusCode, 403);
    assert.equal(error.expose, true);
    assert.deepEqual(error.details, { code: PASSWORD_CHANGE_REQUIRED_CODE, changePasswordPath: "/auth/change-password" });
    assert.match(error.message, /contraseña/);
  });
});

describe("notification templates — system fallback", () => {
  const row = (overrides: Partial<NotificationTemplateRow>): NotificationTemplateRow => ({
    id: "tpl_org",
    organizationId: "org_1",
    propertyId: null,
    code: "user_invitation",
    channel: "email",
    language: "es",
    subject: "Org subject",
    body: "Org body {{inviteUrl}}",
    variablesJson: null,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  });

  it("ships user_invitation and password_reset (email/es) as plain-text system templates", () => {
    const codes = SYSTEM_TEMPLATES.map((tpl) => `${tpl.code}:${tpl.channel}:${tpl.language}`);
    // Las plantillas del check-in automatizado (Tanda CHK, `checkin_*`) se fijan una a una en
    // notifications/__tests__/checkin-templates.test.mts; fuera de ellas solo existen estas dos.
    assert.deepEqual(codes.filter((key) => !key.startsWith("checkin_")), ["user_invitation:email:es", "password_reset:email:es"]);
    assert.ok(codes.some((key) => key.startsWith("checkin_")), "las plantillas checkin_* del check-in automatizado siguen presentes");
    const invite = resolveSystemTemplate({ code: "user_invitation", channel: "email" });
    assert.ok(invite);
    assert.match(invite.body, /\{\{inviteUrl\}\}/);
    assert.match(invite.body, /\{\{expiryHours\}\}/);
    assert.match(invite.subject, /\{\{organizationName\}\}/);
    assert.equal(invite.body.includes("<"), false); // plain text, no HTML
    const reset = resolveSystemTemplate({ code: "password_reset", channel: "email", language: "en" });
    assert.ok(reset); // falls back to "es" when the language is missing
    assert.equal(reset.language, "es");
    assert.match(reset.body, /\{\{resetUrl\}\}/);
    assert.equal(resolveSystemTemplate({ code: "user_invitation", channel: "sms" }), null);
    assert.equal(resolveSystemTemplate({ code: "guest_magic_link", channel: "email" }), null);
  });

  it("pickTemplate falls back to the system template when the org has none, and never for unknown codes", () => {
    const picked = pickTemplate([], { code: "user_invitation", channel: "email", language: "es" });
    assert.ok(picked);
    assert.equal(picked.organizationId, "system");
    assert.equal(picked.id, "system:user_invitation:email:es");
    assert.ok(picked.tokens.includes("inviteUrl"));
    assert.equal(pickTemplate([], { code: "guest_magic_link", channel: "email" }), null);
  });

  it("an organization's own row always wins over the system template; property-scoped over org-wide; exact language over 'es'", () => {
    const orgWide = row({});
    const picked = pickTemplate([orgWide], { code: "user_invitation", channel: "email", language: "es" });
    assert.equal(picked?.id, "tpl_org");

    const propertyScoped = row({ id: "tpl_prop", propertyId: "prop_1" });
    assert.equal(pickTemplate([orgWide, propertyScoped], { propertyId: "prop_1", code: "user_invitation", channel: "email" })?.id, "tpl_prop");
    // Another property's row must not leak in.
    assert.equal(pickTemplate([orgWide, propertyScoped], { propertyId: "prop_2", code: "user_invitation", channel: "email" })?.id, "tpl_org");

    const english = row({ id: "tpl_en", language: "en" });
    assert.equal(pickTemplate([orgWide, english], { code: "user_invitation", channel: "email", language: "en" })?.id, "tpl_en");
    assert.equal(pickTemplate([orgWide, english], { code: "user_invitation", channel: "email", language: "fr" })?.id, "tpl_org");
  });

  it("the system templates render with the dispatcher's variables (default filter for the inviter)", () => {
    const record = systemTemplateToRecord(resolveSystemTemplate({ code: "user_invitation", channel: "email" })!);
    const rendered = renderTemplate({
      template: { body: record.body, subject: record.subject },
      variables: {
        inviteUrl: "http://localhost:5173/accept-invite?token=abc",
        inviterName: "",
        organizationName: "Hotel Faranda",
        propertyName: "Faranda Rías Altas",
        propertyNameSuffix: " (Faranda Rías Altas)",
        expiryHours: 72
      }
    });
    assert.equal(rendered.subject, "Invitación a ehotelOS — Hotel Faranda");
    assert.match(rendered.body, /Un administrador te ha invitado a unirte a Hotel Faranda en ehotelOS \(Faranda Rías Altas\)\./);
    assert.match(rendered.body, /http:\/\/localhost:5173\/accept-invite\?token=abc/);
    assert.match(rendered.body, /caduca en 72 horas/);
    assert.equal(rendered.body.includes("{{"), false);
  });
});
