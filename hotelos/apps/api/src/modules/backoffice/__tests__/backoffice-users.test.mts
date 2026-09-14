// Unit tests for the users-list / invite closure rules of the backoffice service:
//   · the `pendingInvitation` projection of GET …/users never carries the token
//     (inviteUrl is a literal null, extra fields of the source row are dropped);
//   · `mfaEnabled` of an invitee is a strict boolean opt-in (mfaRequired === true).
// No database. Run from apps/api with
//   node --import tsx --test src/modules/backoffice/__tests__/backoffice-users.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inviteMfaEnabled, pendingInvitationView } from "../backoffice.service.js";
import type { PendingInvitationInfo } from "../../auth/invitations.service.js";

const pending: PendingInvitationInfo = {
  invitationId: "inv_1",
  expiresAt: "2026-09-17T10:00:00.000Z",
  expired: false,
  deliveryStatus: "sent",
  createdAt: "2026-09-14T10:00:00.000Z"
};

describe("pendingInvitationView — token-free projection for the users list", () => {
  it("returns null when the invited user has no pending invitation", () => {
    assert.equal(pendingInvitationView(undefined), null);
    assert.equal(pendingInvitationView(null), null);
  });

  it("exposes exactly expiresAt, deliveryStatus, expired and a literal null inviteUrl", () => {
    const view = pendingInvitationView(pending);
    assert.deepEqual(view, { expiresAt: pending.expiresAt, deliveryStatus: "sent", expired: false, inviteUrl: null });
    assert.deepEqual(Object.keys(view!).sort(), ["deliveryStatus", "expired", "expiresAt", "inviteUrl"]);
  });

  it("drops anything else from the source row (token, hash, url, ids) — the secret never travels", () => {
    const leaky = {
      ...pending,
      token: "raw-token-must-not-leak",
      tokenHash: "hash-must-not-leak",
      inviteUrl: "http://localhost:5173/accept-invite?token=raw-token-must-not-leak"
    } as PendingInvitationInfo & Record<string, unknown>;
    const view = pendingInvitationView(leaky) as unknown as Record<string, unknown>;
    assert.equal(view.inviteUrl, null);
    assert.ok(!("token" in view));
    assert.ok(!("tokenHash" in view));
    assert.ok(!("invitationId" in view));
    assert.ok(!JSON.stringify(view).includes("raw-token-must-not-leak"));
  });

  it("keeps an expired row (so the UI can offer a resend) and a null delivery status", () => {
    const view = pendingInvitationView({ ...pending, expired: true, deliveryStatus: null });
    assert.equal(view?.expired, true);
    assert.equal(view?.deliveryStatus, null);
  });
});

describe("inviteMfaEnabled — strict boolean opt-in", () => {
  it("is true only for the literal boolean true", () => {
    assert.equal(inviteMfaEnabled(true), true);
  });

  it("defaults to false for absent, false, null and truthy non-booleans", () => {
    for (const value of [undefined, false, null, "true", "yes", 1, {}, []]) {
      assert.equal(inviteMfaEnabled(value), false, `expected false for ${JSON.stringify(value)}`);
    }
  });
});
