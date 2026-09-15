// Booking adapter v2: stub/sandbox through the simulator, real mode with an
// injected fetch (token exchange + OTA POST), per-item rejections, no network.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChannelContext } from "../../adapter.types.js";
import { resetSimulatorCounters } from "../../sandbox/simulator.js";
import { BOOKING_MAX_EXCHANGES_PER_HOUR, DEFAULT_BOOKING_AUTH_URL, __peekBookingToken, clearBookingTokenCache, getBookingJwt } from "../booking/auth.js";
import { buildResNotifAckXml, buildRestrictionsNotif, parseResNotifXml } from "../booking/xml.js";
import { createBookingAdapter, isTransientAuthStatus, parseOtaPushResponse } from "../booking.adapter.js";

const RATE_ITEMS = [
  { date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "per_day" as const, amount: 129.5 },
  { date: "2026-06-02", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "per_day" as const, amount: 139 }
];

function channel(mode: ChannelContext["mode"], credentials: Record<string, unknown> | null = { client_id: "cid", client_secret: "sec", hotelId: "12345" }, extra: Partial<ChannelContext> = {}): ChannelContext {
  return { id: `bk-${mode}`, propertyId: "prop-1", providerCode: "booking", mode, credentials, externalPropertyCode: credentials && typeof credentials.hotelId === "string" ? credentials.hotelId : null, ...extra };
}

type Captured = { url: string; init: RequestInit | undefined };

function fakeFetch(captured: Captured[], responder: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return responder(String(input), init);
  }) as typeof fetch;
}

beforeEach(() => {
  clearBookingTokenCache();
  resetSimulatorCounters();
  delete process.env.BOOKING_API_BASE_URL;
  delete process.env.BOOKING_OAUTH_URL;
});
afterEach(() => clearBookingTokenCache());

describe("booking adapter — stub / sandbox via the simulator", () => {
  it("stub pushRates needs no credentials and confirms every item", async () => {
    const adapter = createBookingAdapter();
    const result = await adapter.pushRates({ channel: channel("stub", null), items: RATE_ITEMS });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, 2);
    assert.deepEqual(result.rejected, []);
    assert.equal(result.requestHash.length, 64);
    assert.equal((result.raw as { mode: string }).mode, "stub");
  });

  it("sandbox validates the OTA schema: a 3 EUR rate is rejected per item, the rest confirmed", async () => {
    const adapter = createBookingAdapter();
    const result = await adapter.pushRates({ channel: channel("sandbox"), items: [RATE_ITEMS[0]!, { ...RATE_ITEMS[1]!, amount: 3 }] });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected[0]?.itemIndex, 1);
    assert.equal(result.rejected[0]?.code, "402");
  });

  it("sandbox refuses to push without client credentials and testCredentials reports it", async () => {
    const adapter = createBookingAdapter();
    const result = await adapter.pushRates({ channel: channel("sandbox", { hotelId: "1" }), items: RATE_ITEMS });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    const test = await adapter.testCredentials({ channel: channel("sandbox", null) });
    assert.equal(test.ok, false);
    const ok = await adapter.testCredentials({ channel: channel("sandbox") });
    assert.equal(ok.ok, true);
    assert.equal(ok.metadata?.mode, "sandbox");
  });

  it("simulator options on the channel inject 429 (rateLimited, retryable) and timeouts", async () => {
    const adapter = createBookingAdapter();
    const ch = channel("sandbox", { client_id: "c", client_secret: "s", hotelId: "1" }, { simulator: { failEvery: 1 } });
    const limited = await adapter.pushAvailability({ channel: ch, items: [{ date: "2026-06-01", externalRoomCode: "BK-DBL", roomTypeId: "rt1", count: 2 }] });
    assert.equal(limited.ok, false);
    assert.equal(limited.rateLimited, true);
    assert.equal(limited.retryable, true);
    const slow = channel("sandbox", { client_id: "c", client_secret: "s", hotelId: "1" }, { id: "bk-slow", simulator: { latencyMs: 60_000 } });
    const timedOut = await createBookingAdapter({ timeoutMs: 50 }).pushRestrictions({ channel: slow, items: [{ date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", cta: false, ctd: false, closed: false, stopSell: false }] });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.retryable, true);
  });
});

describe("booking adapter — real mode with injected fetch", () => {
  it("exchanges client credentials for a JWT once, then POSTs OTA XML with the Bearer token", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fakeFetch(captured, (url) => {
      if (url === DEFAULT_BOOKING_AUTH_URL) return new Response(JSON.stringify({ jwt: "jwt-123" }), { status: 200 });
      return new Response('<?xml version="1.0"?><OTA_HotelRateAmountNotifRS Version="1.1"><Success/></OTA_HotelRateAmountNotifRS>', { status: 200, headers: { "Content-Type": "text/xml" } });
    });
    const adapter = createBookingAdapter({ fetchImpl });
    const ch = channel("real");
    const first = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    const second = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(first.ok, true);
    assert.equal(first.accepted, 2);
    assert.equal(second.ok, true);
    // 1 exchange + 2 pushes: the cached JWT is reused.
    assert.equal(captured.length, 3);
    assert.equal(captured[0]?.url, DEFAULT_BOOKING_AUTH_URL);
    assert.deepEqual(JSON.parse(String(captured[0]?.init?.body)), { client_id: "cid", client_secret: "sec" });
    assert.equal(captured[1]?.url, "https://supply-xml.booking.com/hotels/ota/OTA_HotelRateAmountNotif");
    assert.equal((captured[1]?.init?.headers as Record<string, string>).Authorization, "Bearer jwt-123");
    assert.ok(String(captured[1]?.init?.body).includes("<OTA_HotelRateAmountNotifRQ"));
    assert.equal(__peekBookingToken(ch.id)?.jwt, "jwt-123");
  });

  it("classifies provider answers: per-item Errors with RecordID, 401 not retryable, 503 retryable", async () => {
    const answers = [
      new Response('<OTA_HotelRateAmountNotifRS><Errors><Error Type="3" Code="402" RecordID="0" ShortText="bad price"/></Errors></OTA_HotelRateAmountNotifRS>', { status: 200 }),
      new Response("", { status: 401 }),
      new Response("", { status: 503 })
    ];
    const captured: Captured[] = [];
    const fetchImpl = fakeFetch(captured, (url) => (url === DEFAULT_BOOKING_AUTH_URL ? new Response(JSON.stringify({ jwt: "j" }), { status: 200 }) : answers.shift()!));
    const adapter = createBookingAdapter({ fetchImpl });
    const ch = channel("real");
    const partial = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(partial.ok, true);
    assert.equal(partial.accepted, 1);
    assert.deepEqual(partial.rejected, [{ itemIndex: 0, code: "402", message: "bad price" }]);
    const unauthorized = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.retryable, false);
    const unavailable = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.retryable, true);
  });

  it("fails fast without credentials (no fetch) and caps token exchanges at 30 per hour", async () => {
    const captured: Captured[] = [];
    const adapter = createBookingAdapter({ fetchImpl: fakeFetch(captured, () => new Response("{}", { status: 500 })) });
    const result = await adapter.pushRates({ channel: channel("real", null), items: RATE_ITEMS });
    assert.equal(result.ok, false);
    assert.equal(captured.length, 0);
    const test = await adapter.testCredentials({ channel: channel("real", { client_id: "x" }) });
    assert.equal(test.ok, false);

    const ch = channel("real", { client_id: "c", client_secret: "s" }, { id: "bk-quota" });
    const failing = createBookingAdapter({ fetchImpl: fakeFetch(captured, () => new Response("nope", { status: 500 })) });
    for (let i = 0; i < BOOKING_MAX_EXCHANGES_PER_HOUR; i++) {
      await assert.rejects(() => getBookingJwt(ch, { fetchImpl: fakeFetch(captured, () => new Response("nope", { status: 500 })) }));
    }
    await assert.rejects(() => getBookingJwt(ch, { fetchImpl: fakeFetch(captured, () => new Response(JSON.stringify({ jwt: "late" }), { status: 200 })) }), /30 intercambios/);
    void failing;
  });

  it("pulls OTA_HotelResNotif reservations and builds the ack", async () => {
    const feed = `<OTA_HotelResNotifRQ><HotelReservations><HotelReservation ResStatus="Commit"><UniqueID Type="14" ID="R-1"/><RoomStays><RoomStay><TimeSpan Start="2026-06-01" End="2026-06-03"/><Total AmountAfterTax="250.00" CurrencyCode="EUR"/></RoomStay></RoomStays><ResGuests><ResGuest><Profiles><Profile><Customer><PersonName><GivenName>Ana</GivenName><Surname>García</Surname></PersonName></Customer></Profile></Profiles></ResGuest></ResGuests></HotelReservation><HotelReservation ResStatus="Cancel"><UniqueID ID="R-2"/></HotelReservation></HotelReservations></OTA_HotelResNotifRQ>`;
    const parsed = parseResNotifXml(feed);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.externalReference, "R-1");
    assert.equal(parsed[0]?.guestName, "Ana García");
    assert.equal(parsed[0]?.totalAmount, 250);
    assert.equal(parsed[1]?.status, "cancel");
    const captured: Captured[] = [];
    const adapter = createBookingAdapter({ fetchImpl: fakeFetch(captured, (url) => (url === DEFAULT_BOOKING_AUTH_URL ? new Response(JSON.stringify({ jwt: "j" }), { status: 200 }) : new Response(feed, { status: 200 }))) });
    const pulled = await adapter.pullReservations({ channel: channel("real"), since: new Date("2026-05-01T00:00:00Z") });
    assert.equal(pulled.ok, true);
    assert.equal(pulled.reservations[1]?.status, "cancelled");
    // Reservations live on the secure host and take the documented plural `hotel_ids`.
    assert.equal(captured[1]?.url, "https://secure-supply-xml.booking.com/hotels/ota/OTA_HotelResNotif?hotel_ids=12345");
    assert.ok(buildResNotifAckXml(["R-1"]).includes('<UniqueID Type="14" ID="R-1"/>'));
  });

  it("token exchange 5xx / network / 429 are transient (backoff), 400/401/403 definitive", async () => {
    const outages = [new Response("upstream down", { status: 503 }), new Response("", { status: 401 })];
    const adapter = createBookingAdapter({ fetchImpl: fakeFetch([], () => outages.shift()!) });
    const ch = channel("real", { client_id: "c", client_secret: "s", hotelId: "1" }, { id: "bk-exchange" });
    const outage = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(outage.ok, false);
    assert.equal(outage.retryable, true, outage.errors.join());
    assert.ok(outage.errors[0]?.includes("503"));
    const denied = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(denied.retryable, false);
    const network = createBookingAdapter({ fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    const dropped = await network.pushRates({ channel: channel("real", { client_id: "c", client_secret: "s", hotelId: "1" }, { id: "bk-net" }), items: RATE_ITEMS });
    assert.equal(dropped.retryable, true);
    assert.equal(isTransientAuthStatus(0), true);
    assert.equal(isTransientAuthStatus(undefined), true);
    assert.equal(isTransientAuthStatus(429), true);
    assert.equal(isTransientAuthStatus(400), false);
  });

  it("refuses to push (sandbox and real) without a hotelId instead of sending a placeholder HotelCode", async () => {
    const captured: Captured[] = [];
    const adapter = createBookingAdapter({ fetchImpl: fakeFetch(captured, () => new Response(JSON.stringify({ jwt: "j" }), { status: 200 })) });
    const sandbox = await adapter.pushRates({ channel: channel("sandbox", { client_id: "c", client_secret: "s" }), items: RATE_ITEMS });
    assert.equal(sandbox.ok, false);
    assert.equal(sandbox.retryable, false);
    assert.ok(sandbox.errors[0]?.includes("hotelId"), sandbox.errors[0]);
    const real = await adapter.pushAvailability({ channel: channel("real", { client_id: "c", client_secret: "s" }), items: [{ date: "2026-06-01", externalRoomCode: "BK-DBL", roomTypeId: "rt1", count: 2 }] });
    assert.equal(real.ok, false);
    assert.equal(captured.length, 0, "no token exchange is spent on a channel that cannot be pushed");
    const test = await adapter.testCredentials({ channel: channel("sandbox", { client_id: "c", client_secret: "s" }) });
    assert.equal(test.ok, false);
    // The stub keeps working without any credentials (placeholder never leaves the box).
    assert.equal((await adapter.pushRates({ channel: channel("stub", null), items: RATE_ITEMS })).ok, true);
  });

  it("restrictions: one message per RestrictionStatus, RecordID mapped back to the item; out-of-range RecordID is request level", async () => {
    const items = [
      { date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", cta: true, ctd: false, closed: false, stopSell: false, minAdvanceDays: 3 },
      { date: "2026-06-02", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", cta: false, ctd: true, closed: true, stopSell: false }
    ];
    const notif = buildRestrictionsNotif({ hotelCode: "1", items });
    assert.deepEqual(notif.itemIndexByMessage, [0, 0, 0, 1, 1, 1]);
    assert.ok(notif.xml.includes('Restriction="Master" MinAdvancedBookingOffset="3D"/>'));
    const adapter = createBookingAdapter();
    const sandbox = await adapter.pushRestrictions({ channel: channel("sandbox"), items });
    assert.equal(sandbox.ok, true);
    assert.equal(sandbox.accepted, 2, "accepted counts items, not messages");
    // RecordID 4 is the second message of item 1 → item 1 rejected, item 0 confirmed.
    const rs = parseOtaPushResponse('<OTA_HotelAvailNotifRS><Errors><Error Code="402" RecordID="4" ShortText="bad"/></Errors></OTA_HotelAvailNotifRS>', 2, notif.itemIndexByMessage);
    assert.equal(rs.ok, true);
    assert.deepEqual(rs.rejected, [{ itemIndex: 1, code: "402", message: "bad" }]);
    assert.equal(rs.accepted, 1);
    const outOfRange = parseOtaPushResponse('<OTA_HotelAvailNotifRS><Errors><Error Code="402" RecordID="9" ShortText="bad"/></Errors></OTA_HotelAvailNotifRS>', 2, notif.itemIndexByMessage);
    assert.equal(outOfRange.ok, false);
    assert.ok(outOfRange.errors[0]?.includes("fuera de rango"));
    assert.equal(parseOtaPushResponse('<OTA_HotelRateAmountNotifRS><Errors><Error Code="402" RecordID="2" ShortText="bad"/></Errors></OTA_HotelRateAmountNotifRS>', 2).ok, false);
  });

  it("reports occupancy supplements Booking cannot carry as a warning instead of dropping them silently", async () => {
    const adapter = createBookingAdapter();
    const result = await adapter.pushRates({
      channel: channel("stub", null),
      items: [{ ...RATE_ITEMS[0]!, pricingModel: "obp", occupancyPrices: { "1": 100, "2": 120, extraAdult: 20, extraChild: 10 } }]
    });
    assert.equal(result.ok, true);
    assert.ok(result.warnings?.[0]?.includes("extraAdult, extraChild"), JSON.stringify(result.warnings));
  });

  it("parseOtaPushResponse treats request-level errors as not ok", () => {
    const rs = parseOtaPushResponse('<OTA_HotelAvailNotifRS><Errors><Error Code="450" ShortText="Exactly one HotelCode per request is allowed"/></Errors></OTA_HotelAvailNotifRS>', 3);
    assert.equal(rs.ok, false);
    assert.equal(rs.errors[0], "450: Exactly one HotelCode per request is allowed");
    assert.equal(parseOtaPushResponse("<OTA_HotelAvailNotifRS><Success/></OTA_HotelAvailNotifRS>", 3).accepted, 3);
  });
});
