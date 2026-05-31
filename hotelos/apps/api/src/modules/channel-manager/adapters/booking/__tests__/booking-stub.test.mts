import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChannelContext } from "../../../adapter.types.js";
import { bookingAdapter, parseReservationsXml } from "../../booking.adapter.js";
import { clearTokenCache, getAccessToken } from "../oauth.js";
import {
  buildAvailabilityXml,
  buildRatesXml,
  buildRestrictionsXml,
  escapeXml
} from "../xml.js";

const STUB_CHANNEL: ChannelContext = {
  id: "channel-test-1",
  propertyId: "prop-1",
  providerCode: "booking",
  credentialsJson: {
    client_id: "stub-client",
    client_secret: "stub-secret",
    hotelId: "BKG-12345"
  }
};

function clearMode(): void {
  delete process.env.BOOKING_ADAPTER_MODE;
  delete process.env.BOOKING_API_BASE_URL;
  delete process.env.BOOKING_OAUTH_URL;
  clearTokenCache();
}

describe("bookingAdapter — stub mode", () => {
  beforeEach(clearMode);
  afterEach(clearMode);

  it("pushRates returns ok with the exact item count", async () => {
    const items = [
      { date: "2026-06-01", ratePlanId: "RP-FLEX", amount: 129, currency: "EUR" },
      { date: "2026-06-02", ratePlanId: "RP-FLEX", amount: 139, currency: "EUR" },
      { date: "2026-06-03", ratePlanId: "RP-FLEX", amount: 149, currency: "EUR" }
    ];
    const result = await bookingAdapter.pushRates({ channel: STUB_CHANNEL, items });
    assert.equal(result.ok, true);
    assert.equal(result.pushed, items.length);
    assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
  });

  it("pushRates returns ok deterministically across runs", async () => {
    const items = [{ date: "2026-06-01", ratePlanId: "RP-FLEX", amount: 129, currency: "EUR" }];
    const a = await bookingAdapter.pushRates({ channel: STUB_CHANNEL, items });
    const b = await bookingAdapter.pushRates({ channel: STUB_CHANNEL, items });
    assert.equal(a.ok, b.ok);
    assert.equal(a.pushed, b.pushed);
    assert.equal(a.latencyMs, b.latencyMs);
  });

  it("pushRestrictions exercise of the XML builder produces the expected structure", () => {
    const xml = buildRestrictionsXml([
      {
        date: "2026-07-04",
        roomTypeId: "ROOM-101",
        ratePlanId: "RP-FLEX",
        minStay: 2,
        maxStay: 14,
        cta: true,
        ctd: false,
        closed: false
      }
    ]);
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<restrictions>/);
    assert.match(xml, /<\/restrictions>/);
    assert.match(xml, /room_type_id="ROOM-101"/);
    assert.match(xml, /rate_plan_id="RP-FLEX"/);
    assert.match(xml, /date="2026-07-04"/);
    assert.match(xml, /min_stay="2"/);
    assert.match(xml, /max_stay="14"/);
    assert.match(xml, /cta="true"/);
    assert.match(xml, /ctd="false"/);
    assert.match(xml, /closed="false"/);
  });
});

describe("bookingAdapter — real mode without credentials", () => {
  beforeEach(() => {
    clearMode();
    process.env.BOOKING_ADAPTER_MODE = "real";
  });
  afterEach(clearMode);

  it("testCredentials returns ok=false when credentialsJson is null (no network call)", async () => {
    const channel: ChannelContext = { ...STUB_CHANNEL, credentialsJson: null };
    const result = await bookingAdapter.testCredentials({ channel });
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
  });

  it("testCredentials returns ok=false when client_id is missing (no network call)", async () => {
    const channel: ChannelContext = {
      ...STUB_CHANNEL,
      credentialsJson: { hotelId: "BKG-123" } // no client_id / client_secret
    };
    // No fetch override — if this triggers a real network call, the test
    // would either hang or fail. We assert ok=false synchronously through
    // the isInvalidCredentials guard.
    const result = await bookingAdapter.testCredentials({ channel });
    assert.equal(result.ok, false);
  });

  it("pushRates returns errors without crashing when OAuth has no client_id", async () => {
    const channel: ChannelContext = {
      ...STUB_CHANNEL,
      credentialsJson: { hotelId: "BKG-123" }
    };
    const result = await bookingAdapter.pushRates({
      channel,
      items: [{ date: "2026-06-01", ratePlanId: "RP-FLEX", amount: 129, currency: "EUR" }]
    });
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    assert.match(result.errors![0]!, /OAuth/);
  });
});

describe("getAccessToken — single-flight refresh mutex", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(clearMode);
  afterEach(() => {
    clearMode();
    globalThis.fetch = originalFetch;
  });

  it("coalesces concurrent refreshes into exactly ONE underlying fetch", async () => {
    let fetchCount = 0;
    // Slow mock token endpoint: resolves after a short delay so the second
    // getAccessToken call lands while the first refresh is still in flight.
    globalThis.fetch = (async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(
        JSON.stringify({ access_token: "tok-abc", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    // Two concurrent callers racing the first refresh after (cold) cache miss.
    const [a, b] = await Promise.all([
      getAccessToken(STUB_CHANNEL),
      getAccessToken(STUB_CHANNEL)
    ]);

    assert.equal(a, "tok-abc");
    assert.equal(b, "tok-abc");
    assert.equal(fetchCount, 1, "exactly one underlying token fetch for two concurrent calls");
  });

  it("allows a fresh fetch after the in-flight refresh settles", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ access_token: `tok-${fetchCount}`, token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    // First call populates the cache (1 fetch). Second call hits the cache
    // (still 1 fetch). After clearing the cache, a third call refreshes again.
    const first = await getAccessToken(STUB_CHANNEL);
    const cached = await getAccessToken(STUB_CHANNEL);
    assert.equal(first, "tok-1");
    assert.equal(cached, "tok-1", "second call served from cache, no new fetch");
    assert.equal(fetchCount, 1);

    clearTokenCache(STUB_CHANNEL.id);
    const refreshed = await getAccessToken(STUB_CHANNEL);
    assert.equal(refreshed, "tok-2");
    assert.equal(fetchCount, 2, "cache clear forces a new refresh");
  });
});

describe("XML builders — well-formed output", () => {
  it("buildAvailabilityXml emits one <room> per item with rooms_to_sell", () => {
    const xml = buildAvailabilityXml([
      { date: "2026-06-01", roomTypeId: "ROOM-101", count: 5 },
      { date: "2026-06-02", roomTypeId: "ROOM-202", count: 0 }
    ]);
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<availability>/);
    assert.match(xml, /<room id="ROOM-101">/);
    assert.match(xml, /rooms_to_sell="5"/);
    assert.match(xml, /<room id="ROOM-202">/);
    assert.match(xml, /rooms_to_sell="0"/);
    // Balanced tags.
    const openRooms = (xml.match(/<room\s/g) || []).length;
    const closeRooms = (xml.match(/<\/room>/g) || []).length;
    assert.equal(openRooms, closeRooms);
  });

  it("buildRatesXml emits price with 2-decimal precision and includes currency", () => {
    const xml = buildRatesXml([
      { date: "2026-06-01", ratePlanId: "RP-FLEX", amount: 129.5, currency: "EUR" }
    ]);
    assert.match(xml, /price="129.50"/);
    assert.match(xml, /currency="EUR"/);
    assert.match(xml, /rate_plan_id="RP-FLEX"/);
    assert.match(xml, /date="2026-06-01"/);
  });

  it("buildRestrictionsXml omits unset optional attributes", () => {
    const xml = buildRestrictionsXml([
      { date: "2026-07-04", roomTypeId: "ROOM-101", closed: true }
    ]);
    assert.match(xml, /closed="true"/);
    assert.ok(!/min_stay=/.test(xml));
    assert.ok(!/max_stay=/.test(xml));
    assert.ok(!/cta=/.test(xml));
    assert.ok(!/ctd=/.test(xml));
    assert.ok(!/rate_plan_id=/.test(xml));
  });

  it("escapeXml escapes the five reserved characters", () => {
    assert.equal(escapeXml(`A & B < C > D " E ' F`), "A &amp; B &lt; C &gt; D &quot; E &apos; F");
  });
});

describe("parseReservationsXml — coarse regex parser", () => {
  it("extracts externalReference and status from inline attributes", () => {
    const xml = `<?xml version="1.0"?>
<reservations>
  <reservation id="BKG-AAA-111" status="confirmed"><guest>Alice</guest></reservation>
  <reservation id="BKG-BBB-222" status="cancelled"><guest>Bob</guest></reservation>
</reservations>`;
    const list = parseReservationsXml(xml);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.externalReference, "BKG-AAA-111");
    assert.equal(list[0]!.status, "confirmed");
    assert.equal(list[1]!.externalReference, "BKG-BBB-222");
    assert.equal(list[1]!.status, "cancelled");
    // The raw XML is stashed so the aggregator can re-parse later.
    assert.match(String((list[0]!.payloadJson as Record<string, unknown>).rawXml), /BKG-AAA-111/);
  });

  it("extracts status from a nested <status> tag when there is no status attribute", () => {
    const xml = `<reservation booking_id="BKG-CCC-333"><status>modified</status></reservation>`;
    const list = parseReservationsXml(xml);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.externalReference, "BKG-CCC-333");
    assert.equal(list[0]!.status, "modified");
  });

  it("returns an empty array when the body has no <reservation> nodes", () => {
    assert.deepEqual(parseReservationsXml(""), []);
    assert.deepEqual(parseReservationsXml("<reservations></reservations>"), []);
  });
});
