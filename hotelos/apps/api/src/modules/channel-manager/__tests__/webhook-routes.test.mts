// Public routes of the module on a bare Fastify instance (no database: the
// webhook's channel lookup and the pull are injected through the route deps).
//
//   webhook: the secret is verified in `preParsing`, BEFORE any body parser —
//            a malformed body with a bad signature is a 401 (never a 400
//            oracle), a valid HMAC over a malformed body still triggers the
//            pull (202), an oversize body is a 413, and the pull is the only
//            side effect.
//   _sandbox: the loopback answers the simulator's verdict with the
//            X-Anfitorio-Simulator header and knows only the three providers.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildRateAmountNotifXml } from "../adapters/booking/xml.js";
import { WEBHOOK_MAX_BYTES, registerChannelManagerRoutes, webhookChannelIdFromUrl } from "../channel-manager.routes.js";

const SECRET = "outbox-unit-secret";
const CHANNEL_ID = "ch_webhook_1";
const URL_OK = `/channel-manager/webhooks/booking/${CHANNEL_ID}`;

describe("channel-manager routes — webhook and simulator loopback (bare Fastify)", () => {
  let app: FastifyInstance;
  const pulls: string[] = [];

  before(async () => {
    app = Fastify();
    // server.ts registers a raw-string parser for the XML content types the
    // adapters use (the loopback receives OTA bodies as text/xml): mirrored here.
    for (const contentType of ["text/xml", "application/xml"]) {
      app.addContentTypeParser(contentType, { parseAs: "string" }, (_req, body, done) => {
        done(null, body);
      });
    }
    registerChannelManagerRoutes(app, {
      loadWebhookChannel: async (id) => (id === CHANNEL_ID ? { id, credentialsEncrypted: JSON.stringify({ webhookSecret: SECRET }), configurationJson: {} } : null),
      pullReservations: async (id) => {
        pulls.push(id);
        return { ok: true, imported: 0 };
      }
    });
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  it("extracts the channel id from the webhook URL only", () => {
    assert.equal(webhookChannelIdFromUrl(`${URL_OK}?x=1`), CHANNEL_ID);
    assert.equal(webhookChannelIdFromUrl("/channel-manager/webhooks/booking"), null);
    assert.equal(webhookChannelIdFromUrl("/channel-manager/channels"), null);
  });

  it("answers 401 to a malformed body with a bad signature (verified before the JSON parser), and to no header / unknown channel", async () => {
    pulls.length = 0;
    const malformed = await app.inject({ method: "POST", url: URL_OK, headers: { "content-type": "application/json", "x-anfitorio-signature": "sha256=0000" }, payload: "{not json" });
    assert.equal(malformed.statusCode, 401, malformed.body);
    const noHeader = await app.inject({ method: "POST", url: URL_OK, headers: { "content-type": "application/json" }, payload: JSON.stringify({ event: "ping" }) });
    assert.equal(noHeader.statusCode, 401);
    const unknown = await app.inject({ method: "POST", url: "/channel-manager/webhooks/booking/ch_nope", headers: { "content-type": "application/json", "x-anfitorio-webhook-secret": SECRET }, payload: JSON.stringify({ event: "ping" }) });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(pulls, [], "nothing is pulled for an unauthenticated webhook");
  });

  it("a valid HMAC over the ORIGINAL bytes triggers the pull even when the body is not JSON; the plain secret header works too", async () => {
    pulls.length = 0;
    const raw = "{not json but signed";
    const signature = `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
    const signed = await app.inject({ method: "POST", url: URL_OK, headers: { "content-type": "application/json", "x-anfitorio-signature": signature }, payload: raw });
    assert.equal(signed.statusCode, 202, signed.body);
    assert.deepEqual(JSON.parse(signed.body), { accepted: true, imported: 0, ok: true });
    const xml = await app.inject({ method: "POST", url: URL_OK, headers: { "content-type": "text/xml", "x-anfitorio-webhook-secret": SECRET }, payload: "<ping/>" });
    assert.equal(xml.statusCode, 202, xml.body);
    assert.deepEqual(pulls, [CHANNEL_ID, CHANNEL_ID]);
    // A signature over a re-serialised body must not verify.
    const canonical = `sha256=${createHmac("sha256", SECRET).update(JSON.stringify({ a: 1 }), "utf8").digest("hex")}`;
    const mismatched = await app.inject({ method: "POST", url: URL_OK, headers: { "content-type": "application/json", "x-anfitorio-signature": canonical }, payload: '{"a": 1}' });
    assert.equal(mismatched.statusCode, 401);
  });

  it("refuses a body above WEBHOOK_MAX_BYTES with 413 before verifying anything", async () => {
    const big = await app.inject({ method: "POST", url: URL_OK, headers: { "content-type": "application/json", "x-anfitorio-webhook-secret": SECRET }, payload: "x".repeat(WEBHOOK_MAX_BYTES + 1) });
    assert.equal(big.statusCode, 413, big.body.slice(0, 200));
  });

  it("_sandbox loopback: validates an OTA body in-process, reports the verdict in a header and rejects unknown providers", async () => {
    const xml = buildRateAmountNotifXml({
      hotelCode: "1",
      items: [{ date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "per_day", amount: 120 }]
    });
    const booking = await app.inject({ method: "POST", url: "/channel-manager/_sandbox/booking", headers: { "content-type": "text/xml" }, payload: xml });
    assert.equal(booking.statusCode, 200, booking.body);
    assert.ok(booking.body.includes("<Success/>"));
    assert.deepEqual(JSON.parse(String(booking.headers["x-anfitorio-simulator"])), { accepted: 1, rejected: 0, warnings: 0 });
    const channex = await app.inject({ method: "POST", url: "/channel-manager/_sandbox/channex?endpoint=restrictions", headers: { "content-type": "application/json" }, payload: { values: [{ property_id: "p", rate_plan_id: "r", date: "2026-06-01", rate: 10 }] } });
    assert.equal(channex.statusCode, 200, channex.body);
    assert.deepEqual(JSON.parse(String(channex.headers["x-anfitorio-simulator"])), { accepted: 1, rejected: 0, warnings: 0 });
    const unknown = await app.inject({ method: "POST", url: "/channel-manager/_sandbox/foo", headers: { "content-type": "application/json" }, payload: {} });
    assert.equal(unknown.statusCode, 400);
  });
});
