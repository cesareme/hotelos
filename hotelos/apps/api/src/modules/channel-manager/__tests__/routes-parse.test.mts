// Request parser of channel-manager.routes.ts: every validation 400 is
// Spanish (zod's built-in English messages are replaced by the shared
// `zodErrorMapEs`, completed by `channelErrorMapEs` for the coerced integers:
// never «se recibió nan» nor «expected integer, received float»), schema-level
// messages still win, and a valid body parses unchanged. Uses the real route
// schemas (exported for this test). Also covers `deliveriesScope`, the pure
// property-scope rule of GET /channel-manager/deliveries.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestError, NotFoundError } from "../../../lib/http-error.js";
import { deliveriesScope, drainSchema, enqueueSchema, listDeliveriesSchema, parseRequest } from "../channel-manager.routes.js";

const ENGLISH = /\b(Required|Invalid|Expected|received|Unrecognized|must be|Number|String|Array|nan|NaN|integer|float)\b/;

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BadRequestError, `expected BadRequestError, got ${String(error)}`);
    return error.message;
  }
  assert.fail("expected a 400");
}

describe("channel-manager.routes — parseRequest", () => {
  it("missing fields and wrong types are reported in Spanish with their path", () => {
    const msg = message(() => parseRequest(enqueueSchema, { propertyId: "p", channelIds: [] }));
    assert.ok(msg.startsWith("Petición inválida: "), msg);
    assert.ok(msg.includes("from: obligatorio"), msg);
    assert.ok(msg.includes("to: obligatorio"), msg);
    assert.ok(msg.includes("channelIds:"), msg);
    assert.equal(ENGLISH.test(msg), false, msg);
  });

  it("a wrong type in the query (cursor as array) and an out-of-range limit are Spanish too", () => {
    const wrong = message(() => parseRequest(listDeliveriesSchema, { cursor: ["a"], limit: 501 }));
    assert.ok(wrong.includes("cursor:"), wrong);
    assert.ok(wrong.includes("limit:"), wrong);
    assert.equal(ENGLISH.test(wrong), false, wrong);
    assert.ok(/500/.test(wrong), wrong);
  });

  it("limit=abc (query string) and limit:'x' (drain body) are «se recibió un valor no numérico», never «nan»; 2.5 is «debe ser un número entero»; numeric strings parse", () => {
    const query = message(() => parseRequest(listDeliveriesSchema, { limit: "abc", status: "foo" }));
    assert.ok(query.includes("status: valor no admitido 'foo'"), query);
    assert.ok(query.includes("limit: se esperaba número y se recibió un valor no numérico"), query);
    assert.equal(ENGLISH.test(query), false, query);
    const drain = message(() => parseRequest(drainSchema, { limit: "x" }));
    assert.ok(drain.includes("limit: se esperaba número y se recibió un valor no numérico"), drain);
    assert.equal(ENGLISH.test(drain), false, drain);
    const list = message(() => parseRequest(listDeliveriesSchema, { limit: ["1", "2"] }));
    assert.ok(list.includes("limit: se esperaba número y se recibió un valor no numérico"), list);
    const float = message(() => parseRequest(listDeliveriesSchema, { limit: "2.5" }));
    assert.ok(float.includes("limit: debe ser un número entero"), float);
    assert.equal(ENGLISH.test(float), false, float);
    assert.deepEqual(parseRequest(listDeliveriesSchema, { limit: "25" }), { limit: 25 });
    assert.deepEqual(parseRequest(drainSchema, { channelId: "c1", limit: 200 }), { channelId: "c1", limit: 200 });
    assert.deepEqual(parseRequest(drainSchema, {}), {});
  });

  it("keeps the schema-level enum message and parses a valid body unchanged", () => {
    const status = message(() => parseRequest(listDeliveriesSchema, { status: "lost" }));
    assert.ok(status.includes("status:"), status);
    assert.equal(ENGLISH.test(status), false, status);
    const body = { propertyId: "prop_123", from: "2027-03-10", to: "2027-03-12", channelIds: ["c1"], kinds: ["rates" as const], roomTypeIds: ["rt_double"] };
    assert.deepEqual(parseRequest(enqueueSchema, body), body);
    assert.deepEqual(parseRequest(listDeliveriesSchema, undefined), {});
  });
});

describe("channel-manager.routes — deliveriesScope", () => {
  it("a granted channelId scopes the listing to ITS property even when the session points elsewhere", () => {
    assert.equal(deliveriesScope({ queryPropertyId: undefined, sessionPropertyId: "prop_rias_altas", channelPropertyId: "prop_tilos" }), "prop_tilos");
    assert.equal(deliveriesScope({ queryPropertyId: "prop_tilos", sessionPropertyId: "prop_rias_altas", channelPropertyId: "prop_tilos" }), "prop_tilos");
  });

  it("an explicit propertyId that is not the channel's is the neutral 404; without channelId the query or the session property applies", () => {
    assert.throws(() => deliveriesScope({ queryPropertyId: "prop_rias_altas", sessionPropertyId: "prop_rias_altas", channelPropertyId: "prop_tilos" }), (e: unknown) => e instanceof NotFoundError && e.message === "Canal no encontrado.");
    assert.equal(deliveriesScope({ queryPropertyId: "prop_tilos", sessionPropertyId: "prop_rias_altas" }), "prop_tilos");
    assert.equal(deliveriesScope({ queryPropertyId: undefined, sessionPropertyId: "prop_rias_altas" }), "prop_rias_altas");
  });
});
