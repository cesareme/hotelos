// GET /channel-manager/deliveries on a bare Fastify instance (no database:
// the tenant check and the listing are injected through the route deps, the
// session comes from an onRequest hook).
//
// The finding: an Owner of several properties (Carmen: Rías Altas in the
// token, Los Tilos too) asked for a Los Tilos channel without repeating
// `propertyId` and got 404 «Canal no encontrado.» although the tenant check
// had already granted the channel — the route compared the channel's property
// with the SESSION property. Now the granted channel scopes the listing to
// its own property; an explicit `propertyId` that contradicts the channel
// stays the neutral 404.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "../../../lib/http-error.js";
import type { UserContext } from "../../../lib/demo-store.js";
import { registerChannelManagerRoutes } from "../channel-manager.routes.js";

const SESSION_PROPERTY = "prop_rias_altas";
const TILOS = "prop_tilos";
const TILOS_CHANNEL = "ch_tilos_booking";

const carmen: UserContext = { organizationId: "org_faranda", propertyId: SESSION_PROPERTY, userId: "usr_carmen", fullName: "Carmen", deviceId: "dev", permissions: [] };

describe("channel-manager routes — GET /channel-manager/deliveries scope (bare Fastify)", () => {
  let app: FastifyInstance;
  const listed: Array<Record<string, unknown>> = [];
  const granted: string[] = [];

  before(async () => {
    app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.userContext = carmen;
    });
    registerChannelManagerRoutes(app, {
      channelAccess: async (_request, channelId) => {
        granted.push(channelId);
        if (channelId === TILOS_CHANNEL) return { propertyId: TILOS };
        throw new NotFoundError("Canal no encontrado.");
      },
      listDeliveries: async (input) => {
        listed.push(input);
        return { items: [], nextCursor: null };
      }
    });
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  it("channelId of another property of the same Owner, without propertyId → 200 scoped to the channel's property", async () => {
    listed.length = 0;
    granted.length = 0;
    const res = await app.inject({ method: "GET", url: `/channel-manager/deliveries?channelId=${TILOS_CHANNEL}&limit=2` });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(JSON.parse(res.body), { items: [], nextCursor: null });
    assert.deepEqual(granted, [TILOS_CHANNEL], "the tenant check ran on the channel");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.propertyId, TILOS);
    assert.equal(listed[0]?.channelId, TILOS_CHANNEL);
    assert.equal(listed[0]?.limit, 2, "limit=2 from the query string parses as a number");
  });

  it("channelId + its own propertyId → 200; channelId + a contradicting propertyId → 404 neutral", async () => {
    listed.length = 0;
    const ok = await app.inject({ method: "GET", url: `/channel-manager/deliveries?channelId=${TILOS_CHANNEL}&propertyId=${TILOS}` });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(listed[0]?.propertyId, TILOS);
    const mismatch = await app.inject({ method: "GET", url: `/channel-manager/deliveries?channelId=${TILOS_CHANNEL}&propertyId=${SESSION_PROPERTY}` });
    assert.equal(mismatch.statusCode, 404, mismatch.body);
    assert.equal(JSON.parse(mismatch.body).message, "Canal no encontrado.");
    assert.equal(listed.length, 1, "nothing is listed on a mismatch");
    const unknown = await app.inject({ method: "GET", url: "/channel-manager/deliveries?channelId=ch_nope" });
    assert.equal(unknown.statusCode, 404, unknown.body);
  });

  it("without channelId the session property is the scope (or the explicit propertyId); limit=abc is a Spanish 400", async () => {
    listed.length = 0;
    const session = await app.inject({ method: "GET", url: "/channel-manager/deliveries?status=queued" });
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(listed[0]?.propertyId, SESSION_PROPERTY);
    assert.equal(listed[0]?.status, "queued");
    const explicit = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${TILOS}` });
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(listed[1]?.propertyId, TILOS);
    const bad = await app.inject({ method: "GET", url: "/channel-manager/deliveries?limit=abc&status=foo" });
    assert.equal(bad.statusCode, 400, bad.body);
    const message = JSON.parse(bad.body).message as string;
    assert.ok(message.includes("limit: se esperaba número y se recibió un valor no numérico"), message);
    assert.equal(/\bnan\b/i.test(message), false, message);
    assert.equal(listed.length, 2, "a 400 lists nothing");
  });
});
