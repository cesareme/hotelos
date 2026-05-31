import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { EventEnvelope } from "@hotelos/shared";
import type { DispatchInput, NotificationDeliveryRecord } from "../dispatcher.service.js";
import {
  buildMagicLinkUrl,
  dispatchGuestMagicLink,
  handleGuestPortalSignInRequested
} from "../event-hooks.service.js";

// Sprint 45 — magic-link email delivery for guest portal sign-in.
//
// We exercise the notification engine's `GuestPortalSignInRequested` handler in
// isolation by injecting a fake dispatcher. No database or live email provider
// is touched: the handler reads everything it needs from the event payload.

const TOKEN = "deadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00d";

function makeEvent(payloadOverrides: Record<string, unknown> = {}): EventEnvelope {
  return {
    eventId: "evt_magiclink_1",
    organizationId: "org_123",
    propertyId: "prop_123",
    entityType: "guest_portal_session",
    entityId: "res_18392",
    eventType: "GuestPortalSignInRequested",
    payload: {
      reservationId: "res_18392",
      propertyId: "prop_123",
      recipientEmail: "maria@example.com",
      email: "maria@example.com",
      reservationCode: "RES-18392",
      propertyName: "HotelOS Madrid Centro",
      token: TOKEN,
      ...payloadOverrides
    },
    actorType: "system",
    correlationId: "corr_test",
    hashAlgorithm: "sha256",
    currentHash: "test_hash",
    createdAt: new Date().toISOString()
  };
}

// Minimal stand-in for a persisted NotificationDelivery row.
function fakeDelivery(input: DispatchInput): NotificationDeliveryRecord {
  return {
    id: "del_1",
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? null,
    notificationId: input.notificationId ?? null,
    templateCode: input.templateCode,
    channel: input.channel,
    recipient: input.recipient,
    status: "sent",
    providerMessageId: "eml_test",
    subject: "Tu acceso al portal de huésped — HotelOS Madrid Centro",
    bodyRendered: "rendered body",
    payloadJson: { variables: input.variables },
    attempts: 1,
    errorMessage: null,
    scheduledFor: null,
    sentAt: new Date().toISOString(),
    failedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe("guest magic-link notification handler", () => {
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.GUEST_WEB_BASE_URL;
  });
  afterEach(() => {
    if (envBackup === undefined) delete process.env.GUEST_WEB_BASE_URL;
    else process.env.GUEST_WEB_BASE_URL = envBackup;
  });

  it("dispatches an email whose magicLinkUrl contains the token", async () => {
    delete process.env.GUEST_WEB_BASE_URL;
    const calls: DispatchInput[] = [];
    const result = await dispatchGuestMagicLink(makeEvent(), async (input) => {
      calls.push(input);
      return fakeDelivery(input);
    });

    assert.ok(result, "a delivery should be produced");
    assert.equal(calls.length, 1, "dispatch should be called exactly once");

    const call = calls[0]!;
    assert.equal(call.templateCode, "guest_magic_link");
    assert.equal(call.channel, "email");
    assert.equal(call.recipient, "maria@example.com");
    assert.equal(call.notificationId, "evt_magiclink_1", "idempotency keyed on eventId");
    assert.equal(call.organizationId, "org_123");
    assert.equal(call.propertyId, "prop_123");

    const magicLinkUrl = String(call.variables.magicLinkUrl);
    assert.ok(magicLinkUrl.includes(TOKEN), "magicLinkUrl must contain the raw token");
    assert.equal(magicLinkUrl, `http://localhost:5174/?token=${TOKEN}`);
    assert.equal(call.variables.reservationCode, "RES-18392");
    assert.equal(call.variables.propertyName, "HotelOS Madrid Centro");
    assert.equal(call.variables.expiryHours, 24);
  });

  it("honours GUEST_WEB_BASE_URL when building the link", async () => {
    process.env.GUEST_WEB_BASE_URL = "https://stay.example.com/";
    assert.equal(buildMagicLinkUrl("abc"), "https://stay.example.com/?token=abc");

    const calls: DispatchInput[] = [];
    await dispatchGuestMagicLink(makeEvent(), async (input) => {
      calls.push(input);
      return fakeDelivery(input);
    });
    assert.equal(calls[0]!.variables.magicLinkUrl, `https://stay.example.com/?token=${TOKEN}`);
  });

  it("falls back to the legacy `email` payload field for the recipient", async () => {
    const calls: DispatchInput[] = [];
    const event = makeEvent({ recipientEmail: undefined });
    await dispatchGuestMagicLink(event, async (input) => {
      calls.push(input);
      return fakeDelivery(input);
    });
    assert.equal(calls[0]!.recipient, "maria@example.com");
  });

  it("skips (returns null, no dispatch) when there is no recipient", async () => {
    let called = false;
    const event = makeEvent({ recipientEmail: undefined, email: undefined });
    const result = await dispatchGuestMagicLink(event, async (input) => {
      called = true;
      return fakeDelivery(input);
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });

  it("skips (returns null) when there is no token", async () => {
    let called = false;
    const result = await dispatchGuestMagicLink(makeEvent({ token: "" }), async (input) => {
      called = true;
      return fakeDelivery(input);
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });

  it("does NOT throw when the template is missing (handler swallows it)", async () => {
    // The dispatcher throws `template_not_found` when no template resolves.
    // The handler must keep the sign-in flow alive.
    await assert.doesNotReject(async () => {
      await handleGuestPortalSignInRequested(makeEvent(), async () => {
        throw new Error("template_not_found");
      });
    });
  });
});
