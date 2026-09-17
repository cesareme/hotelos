// Unit tests for the staff-invitation core (Tanda 3 · invitaciones).
// Pure-core only: no database, no live email provider. Run from apps/api with
//   node --import tsx --test src/modules/auth/__tests__/invitations.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  INVITATION_TTL_HOURS,
  REDACTED_TOKEN,
  appBaseUrl,
  buildInviteUrl,
  buildPasswordResetUrl,
  classifyDelivery,
  emailStatus,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationState
} from "../invitations.service.js";
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
    assert.deepEqual(codes, ["user_invitation:email:es", "password_reset:email:es"]);
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
