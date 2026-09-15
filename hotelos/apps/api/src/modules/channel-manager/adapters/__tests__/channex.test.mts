// Channex adapter v2: JSON bodies, user-api-key header, per-value 422
// rejections, 429 rate limiting, reservation feed — with an injected fetch.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChannelContext } from "../../adapter.types.js";
import { resetSimulatorCounters } from "../../sandbox/simulator.js";
import { buildRestrictionOnlyValues, buildRestrictionValues, createChannexAdapter, listChannexConnectedChannels, parseChannexPushResponse } from "../channex.adapter.js";

const RATE_ITEMS = [
  { date: "2026-06-01", externalRoomCode: "CX-DBL", externalRateCode: "rp-1", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "per_day" as const, amount: 129.5 },
  { date: "2026-06-02", externalRoomCode: "CX-DBL", externalRateCode: "rp-1", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "obp" as const, occupancyPrices: { "1": 110, "2": 139 } }
];

function channel(mode: ChannelContext["mode"], credentials: Record<string, unknown> | null = { apiKey: "key-1", propertyId: "cx-prop" }): ChannelContext {
  return { id: `cx-${mode}`, propertyId: "prop-1", providerCode: "channex", mode, credentials, externalPropertyCode: credentials && typeof credentials.propertyId === "string" ? credentials.propertyId : null };
}

type Captured = { url: string; init: RequestInit | undefined };
function fakeFetch(captured: Captured[], responder: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return responder(String(input), init);
  }) as typeof fetch;
}

beforeEach(() => {
  resetSimulatorCounters();
  delete process.env.CHANNEX_BASE_URL;
});
afterEach(() => delete process.env.CHANNEX_BASE_URL);

describe("channex adapter — value builders", () => {
  it("maps rates to /restrictions values (rate or rates[{occupancy, rate}]) and restrictions to the Channex keys", () => {
    const built = buildRestrictionValues("cx-prop", RATE_ITEMS);
    assert.deepEqual(built.rejected, []);
    assert.deepEqual(built.values[0], { property_id: "cx-prop", rate_plan_id: "rp-1", date: "2026-06-01", rate: 129.5 });
    assert.deepEqual(built.values[1], { property_id: "cx-prop", rate_plan_id: "rp-1", date: "2026-06-02", rates: [{ occupancy: 1, rate: 110 }, { occupancy: 2, rate: 139 }] });
    const restr = buildRestrictionOnlyValues("cx-prop", [
      { date: "2026-06-01", externalRoomCode: "CX-DBL", externalRateCode: "rp-1", minStay: 2, minStayThrough: 3, maxStay: 7, cta: true, ctd: false, closed: false, stopSell: true, minAdvanceDays: 1 },
      { date: "2026-06-01", externalRoomCode: "CX-DBL", cta: false, ctd: false, closed: false, stopSell: true }
    ]);
    // Channex has no advance-booking field: never sent, reported as a warning.
    assert.deepEqual(restr.values[0], { property_id: "cx-prop", rate_plan_id: "rp-1", date: "2026-06-01", closed_to_arrival: true, closed_to_departure: false, stop_sell: true, min_stay_arrival: 2, min_stay_through: 3, max_stay: 7 });
    assert.ok(restr.warnings[0]?.includes("antelación"), restr.warnings[0]);
    assert.equal(restr.rejected[0]?.itemIndex, 1);
    assert.equal(restr.rejected[0]?.code, "unmapped_rate_plan");
  });
});

describe("channex adapter — stub / sandbox via the simulator", () => {
  it("stub confirms without an api key; sandbox needs the key and validates", async () => {
    const adapter = createChannexAdapter();
    const stub = await adapter.pushRates({ channel: channel("stub", null), items: RATE_ITEMS });
    assert.equal(stub.ok, true);
    assert.equal(stub.accepted, 2);
    const noKey = await adapter.pushRates({ channel: channel("sandbox", { propertyId: "p" }), items: RATE_ITEMS });
    assert.equal(noKey.ok, false);
    assert.equal(noKey.retryable, false);
    const sandbox = await adapter.pushAvailability({ channel: channel("sandbox"), items: [{ date: "2026-06-01", externalRoomCode: "CX-DBL", roomTypeId: "rt1", count: 3 }] });
    assert.equal(sandbox.ok, true);
    assert.equal(sandbox.accepted, 1);
  });

  it("merges local rejections (unmapped plan) with the simulator's answer, keeping item indexes", async () => {
    const adapter = createChannexAdapter();
    const result = await adapter.pushRestrictions({
      channel: channel("sandbox"),
      items: [
        { date: "2026-06-01", externalRoomCode: "CX-DBL", cta: false, ctd: false, closed: false, stopSell: false },
        { date: "2026-06-02", externalRoomCode: "CX-DBL", externalRateCode: "rp-1", cta: false, ctd: false, closed: false, stopSell: false }
      ]
    });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, 1);
    assert.deepEqual(result.rejected.map((r) => r.itemIndex), [0]);
  });
});

describe("channex adapter — real mode with injected fetch", () => {
  it("POSTs /api/v1/restrictions with user-api-key against CHANNEX_BASE_URL", async () => {
    process.env.CHANNEX_BASE_URL = "https://staging.channex.io/";
    const captured: Captured[] = [];
    const adapter = createChannexAdapter({ fetchImpl: fakeFetch(captured, () => new Response(JSON.stringify({ data: { type: "restrictions_update" } }), { status: 200 })) });
    const result = await adapter.pushRates({ channel: channel("real"), items: RATE_ITEMS });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, 2);
    assert.equal(captured[0]?.url, "https://staging.channex.io/api/v1/restrictions");
    assert.equal((captured[0]?.init?.headers as Record<string, string>)["user-api-key"], "key-1");
    const body = JSON.parse(String(captured[0]?.init?.body)) as { values: unknown[] };
    assert.equal(body.values.length, 2);
  });

  it("a 200 with a warning object echoing a value marks THAT item rejected; a 4xx refuses the whole batch; 429 honours Retry-After", async () => {
    const answers = [
      new Response(
        JSON.stringify({
          data: [{ id: "task-1", type: "task" }],
          meta: { message: "Success", warnings: [{ property_id: "cx-prop", rate_plan_id: "rp-1", date: "2026-06-02", rates: [{ occupancy: 1, rate: 110 }], warning: { rates: ["occupancy 3 is not configured"] } }, "rate 129.5 verified"] }
        }),
        { status: 200 }
      ),
      new Response(JSON.stringify({ errors: { code: "bad_request", title: "Bad Request", details: ["values is required"] } }), { status: 400 }),
      new Response(JSON.stringify({ errors: { code: "too_many_requests", title: "Rate limit" } }), { status: 429, headers: { "Retry-After": "30" } })
    ];
    const adapter = createChannexAdapter({ fetchImpl: fakeFetch([], () => answers.shift()!) });
    const partial = await adapter.pushRates({ channel: channel("real"), items: RATE_ITEMS });
    assert.equal(partial.ok, true);
    assert.equal(partial.accepted, 1);
    assert.deepEqual(partial.rejected, [{ itemIndex: 1, code: "channex_warning", message: "Channex rechazó el value: rates: occupancy 3 is not configured" }]);
    assert.deepEqual(partial.warnings, ["rate 129.5 verified"]);
    const refused = await adapter.pushRates({ channel: channel("real"), items: RATE_ITEMS });
    assert.equal(refused.ok, false);
    assert.equal(refused.accepted, 0);
    assert.equal(refused.retryable, false);
    assert.ok(refused.errors[0]?.includes("bad_request") && refused.errors[0]?.includes("values is required"), refused.errors[0]);
    const limited = await adapter.pushRates({ channel: channel("real"), items: RATE_ITEMS });
    assert.equal(limited.rateLimited, true);
    assert.equal(limited.retryable, true);
    assert.equal(limited.retryAfterMs, 30_000);
    assert.equal(parseChannexPushResponse("not json", 1).ok, false);
    // A warning that names no sent value stays a request-level warning (nothing is rejected blindly).
    const orphan = parseChannexPushResponse(JSON.stringify({ meta: { warnings: [{ rate_plan_id: "other", date: "2026-06-01", warning: { rate: ["x"] } }] } }), 2, [{ rate_plan_id: "rp-1", date: "2026-06-01" }]);
    assert.equal(orphan.accepted, 2);
    assert.ok(orphan.warnings?.[0]?.includes("sin value identificable"));
  });

  it("sandbox: a value the simulator rejects comes back as a per-item rejection through the same 200 + warnings path", async () => {
    const adapter = createChannexAdapter();
    const result = await adapter.pushRates({ channel: channel("sandbox"), items: [RATE_ITEMS[0]!, { ...RATE_ITEMS[0]!, date: "2026-06-03", amount: -5 }] });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected[0]?.itemIndex, 1);
    assert.ok(result.rejected[0]?.message.includes("rate"));
  });

  it("pulls booking_revisions/feed, acks each revision and lists connected channels", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fakeFetch(captured, (url) => {
      if (url.includes("/booking_revisions/feed")) return new Response(JSON.stringify({ data: [{ id: "rev-1", attributes: { status: "new", ota_name: "BookingCom", arrival_date: "2026-06-01", departure_date: "2026-06-03", amount: "250.00", currency: "EUR", customer: { name: "Ana", surname: "García" } } }], meta: { next_page: 2 } }), { status: 200 });
      if (url.includes("/ack")) return new Response(JSON.stringify({ meta: { message: "Success" } }), { status: 200 });
      if (url.includes("/api/v1/channels")) return new Response(JSON.stringify({ data: [{ id: "ch-1", attributes: { channel: "BookingCom", title: "Booking.com", is_active: true } }] }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const adapter = createChannexAdapter({ fetchImpl });
    const pulled = await adapter.pullReservations({ channel: channel("real"), since: new Date("2026-05-01T00:00:00Z"), cursor: null });
    assert.equal(pulled.ok, true);
    assert.equal(pulled.reservations[0]?.externalReference, "rev-1");
    assert.equal(pulled.reservations[0]?.payloadJson.guestName, "Ana García");
    assert.equal(pulled.nextCursor, "2");
    assert.ok(captured[0]?.url.includes("filter%5Bproperty_id%5D=cx-prop"));
    const ack = await adapter.acknowledgeReservations!({ channel: channel("real"), ids: ["rev-1"] });
    assert.equal(ack.ok, true);
    assert.ok(captured[1]?.url.endsWith("/api/v1/booking_revisions/rev-1/ack"));
    const listed = await listChannexConnectedChannels(channel("real"), { fetchImpl });
    assert.equal(listed.channels[0]?.channel, "BookingCom");
    const test = await adapter.testCredentials({ channel: channel("real") });
    assert.equal(test.ok, true);
    assert.equal(test.metadata?.connectedChannels, 1);
  });
});
