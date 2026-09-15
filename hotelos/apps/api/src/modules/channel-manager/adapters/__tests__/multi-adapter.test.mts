// Expedia EQC adapter v2, the Channex-routed providers and the registry aliases.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ChannelContext } from "../../adapter.types.js";
import { resetSimulatorCounters } from "../../sandbox/simulator.js";
import { createExpediaAdapter, eqcAuthFor, parseEqcPushResponse } from "../expedia.adapter.js";
import { buildAvailRateUpdateAvailabilityXml, buildAvailRateUpdateRestrictionsXml } from "../expedia/xml.js";
import { isDirectProvider, listProviderCodes, normalizeProviderCode, resolveAdapter } from "../index.js";
import { airbnbAdapter, hotelbedsAdapter, vrboAdapter } from "../via-channex.adapter.js";

const RATE_ITEMS = [
  { date: "2026-06-01", externalRoomCode: "EX-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "per_day" as const, amount: 129.5 }
];

function channel(providerCode: ChannelContext["providerCode"], mode: ChannelContext["mode"], credentials: Record<string, unknown> | null): ChannelContext {
  return { id: `${providerCode}-${mode}`, propertyId: "prop-1", providerCode, mode, credentials, externalPropertyCode: null };
}

type Captured = { url: string; init: RequestInit | undefined };

beforeEach(() => resetSimulatorCounters());

describe("expedia adapter — EQC AR XML", () => {
  it("stub pushes without credentials; sandbox requires username/password; the body carries Authentication", async () => {
    const adapter = createExpediaAdapter();
    const stub = await adapter.pushRates({ channel: channel("expedia", "stub", null), items: RATE_ITEMS });
    assert.equal(stub.ok, true);
    assert.equal(stub.accepted, 1);
    const missing = await adapter.pushRates({ channel: channel("expedia", "sandbox", { hotelId: "1" }), items: RATE_ITEMS });
    assert.equal(missing.ok, false);
    assert.equal(missing.retryable, false);
    const sandbox = await adapter.pushRestrictions({
      channel: channel("expedia", "sandbox", { username: "EQC", password: "pw", hotelId: "555" }),
      items: [{ date: "2026-06-01", externalRoomCode: "EX-DBL", externalRateCode: "RP-BAR", minStay: 2, cta: true, ctd: false, closed: false, stopSell: false }]
    });
    assert.equal(sandbox.ok, true);
    assert.equal(eqcAuthFor(channel("expedia", "sandbox", { username: "u", password: "p", resortID: "77" }))?.hotelId, "77");
  });

  it("real mode POSTs /eqc/ar with text/xml and treats <Error> as a definitive failure", async () => {
    const captured: Captured[] = [];
    const answers = [
      new Response('<AvailRateUpdateRS xmlns="http://www.expediaconnect.com/EQC/AR/2007/02"><Success/></AvailRateUpdateRS>', { status: 200 }),
      new Response('<AvailRateUpdateRS xmlns="http://www.expediaconnect.com/EQC/AR/2007/02"><Error code="3202">Invalid rate</Error></AvailRateUpdateRS>', { status: 200 })
    ];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return answers.shift()!;
    }) as typeof fetch;
    const adapter = createExpediaAdapter({ fetchImpl });
    const ch = channel("expedia", "real", { username: "EQC", password: "pw", hotelId: "555" });
    const ok = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(ok.ok, true);
    assert.equal(captured[0]?.url, "https://services.expediapartnercentral.com/eqc/ar");
    assert.ok(String(captured[0]?.init?.body).includes('<Authentication username="EQC" password="pw"/>'));
    assert.ok(String(captured[0]?.init?.body).includes('<Hotel id="555"/>'));
    const failed = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(failed.ok, false);
    assert.equal(failed.retryable, false);
    assert.equal(failed.errors[0], "3202: Invalid rate");
  });
});

describe("expedia adapter — EQC answers and guards", () => {
  const ns = "http://www.expediaconnect.com/EQC/AR/2007/02";

  it("<Success> wrapping <Warning> children is a success with warnings; 4xxx errors are transient, 1xxx/3xxx definitive", () => {
    const applied = parseEqcPushResponse(`<AvailRateUpdateRS xmlns="${ns}"><Success><Warning code="3260">Rate verification</Warning></Success></AvailRateUpdateRS>`, 2);
    assert.equal(applied.ok, true);
    assert.equal(applied.accepted, 2);
    assert.deepEqual(applied.warnings, ["3260: Rate verification"]);
    const system = parseEqcPushResponse(`<AvailRateUpdateRS xmlns="${ns}"><Error code="4000">Internal system error, please retry</Error></AvailRateUpdateRS>`, 2);
    assert.equal(system.ok, false);
    assert.equal(system.retryable, true);
    const auth = parseEqcPushResponse(`<AvailRateUpdateRS xmlns="${ns}"><Error code="1001">Authentication failed</Error></AvailRateUpdateRS>`, 2);
    assert.equal(auth.retryable, false);
  });

  it("real mode: a 4000 system error goes to the backoff (retryable), a 3202 does not", async () => {
    const answers = [
      new Response(`<AvailRateUpdateRS xmlns="${ns}"><Error code="4000">Internal system error, please retry</Error></AvailRateUpdateRS>`, { status: 200 }),
      new Response(`<AvailRateUpdateRS xmlns="${ns}"><Success><Warning code="3260">x</Warning></Success></AvailRateUpdateRS>`, { status: 200 })
    ];
    const adapter = createExpediaAdapter({ fetchImpl: (async () => answers.shift()!) as unknown as typeof fetch });
    const ch = channel("expedia", "real", { username: "EQC", password: "pw", hotelId: "555" });
    const transient = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(transient.ok, false);
    assert.equal(transient.retryable, true);
    const warned = await adapter.pushRates({ channel: ch, items: RATE_ITEMS });
    assert.equal(warned.ok, true);
    assert.equal(warned.accepted, 1);
    assert.deepEqual(warned.warnings, ["3260: x"]);
  });

  it("the availability message never carries RoomType@closed (the restrictions message owns the closure)", () => {
    const auth = { username: "u", password: "p", hotelId: "1" };
    const availability = buildAvailRateUpdateAvailabilityXml(auth, [{ date: "2026-06-01", externalRoomCode: "EX-DBL", roomTypeId: "rt1", count: 5 }]);
    assert.ok(availability.includes('<RoomType id="EX-DBL"><Inventory totalInventoryAvailable="5"/></RoomType>'));
    assert.equal(/closed=/.test(availability), false);
    const restrictions = buildAvailRateUpdateRestrictionsXml(auth, [{ date: "2026-06-01", externalRoomCode: "EX-DBL", externalRateCode: "RP-BAR", cta: false, ctd: false, closed: false, stopSell: true }]);
    assert.ok(restrictions.includes('<RoomType id="EX-DBL" closed="true">'));
  });

  it("refuses to push without hotelId in sandbox/real and warns about advance-booking restrictions EQC cannot express", async () => {
    const adapter = createExpediaAdapter();
    const noHotel = await adapter.pushRates({ channel: channel("expedia", "sandbox", { username: "EQC", password: "pw" }), items: RATE_ITEMS });
    assert.equal(noHotel.ok, false);
    assert.equal(noHotel.retryable, false);
    assert.ok(noHotel.errors[0]?.includes("hotelId"));
    const withAdvance = await adapter.pushRestrictions({
      channel: channel("expedia", "sandbox", { username: "EQC", password: "pw", hotelId: "555" }),
      items: [{ date: "2026-06-01", externalRoomCode: "EX-DBL", externalRateCode: "RP-BAR", cta: false, ctd: false, closed: false, stopSell: false, minAdvanceDays: 2 }]
    });
    assert.equal(withAdvance.ok, true);
    assert.ok(withAdvance.warnings?.[0]?.includes("antelación"), JSON.stringify(withAdvance.warnings));
  });

  it("testCredentials in real mode is a READ (BookingRetrievalRQ on /eqc/br), never an AvailRateUpdateRQ", async () => {
    const captured: Captured[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(`<BookingRetrievalRS xmlns="http://www.expediaconnect.com/EQC/BR/2007/02"><Booking id="b-1" type="Book" status="pending"/></BookingRetrievalRS>`, { status: 200 });
    }) as typeof fetch;
    const adapter = createExpediaAdapter({ fetchImpl });
    const ok = await adapter.testCredentials({ channel: channel("expedia", "real", { username: "EQC", password: "pw", hotelId: "555" }) });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.metadata?.pendingBookings, 1);
    assert.equal(captured[0]?.url, "https://services.expediapartnercentral.com/eqc/br");
    assert.ok(String(captured[0]?.init?.body).includes("<BookingRetrievalRQ"));
    assert.equal(/AvailRateUpdateRQ|PROBE/.test(String(captured[0]?.init?.body)), false);
    const denied = createExpediaAdapter({ fetchImpl: (async () => new Response(`<BookingRetrievalRS xmlns="${ns}"><Error code="1001">Authentication failed</Error></BookingRetrievalRS>`, { status: 200 })) as unknown as typeof fetch });
    const failed = await denied.testCredentials({ channel: channel("expedia", "real", { username: "EQC", password: "bad", hotelId: "555" }) });
    assert.equal(failed.ok, false);
    assert.ok(failed.error?.startsWith("1001"));
  });
});

describe("channex-routed providers (airbnb / hotelbeds / vrbo)", () => {
  it("simulate locally in stub/sandbox and refuse real mode pointing at Channex", async () => {
    for (const [adapter, code] of [
      [airbnbAdapter, "airbnb"],
      [hotelbedsAdapter, "hotelbeds"],
      [vrboAdapter, "vrbo"]
    ] as const) {
      assert.equal(adapter.providerCode, code);
      const stub = await adapter.pushAvailability({ channel: channel(code, "stub", null), items: [{ date: "2026-06-01", externalRoomCode: "X", roomTypeId: "rt1", count: 1 }] });
      assert.equal(stub.ok, true);
      const real = await adapter.pushRates({ channel: channel(code, "real", { apiKey: "k" }), items: RATE_ITEMS });
      assert.equal(real.ok, false);
      assert.ok(real.errors[0]?.includes("Channex"));
      const test = await adapter.testCredentials({ channel: channel(code, "sandbox", null) });
      assert.equal(test.metadata?.routedVia, "channex");
      assert.equal(adapter.capabilities().rates, true);
    }
  });
});

describe("adapter registry", () => {
  it("resolves aliases (booking_com → booking), lists the public codes and flags direct providers", () => {
    assert.equal(resolveAdapter("booking_com")?.providerCode, "booking");
    assert.equal(resolveAdapter("Booking.com")?.providerCode, "booking");
    assert.equal(resolveAdapter("CHANNEX")?.providerCode, "channex");
    assert.equal(resolveAdapter("google_hotels_mock"), null);
    assert.equal(normalizeProviderCode("expedia"), "expedia");
    assert.deepEqual(listProviderCodes(), ["booking_com", "expedia", "channex", "airbnb", "hotelbeds", "vrbo"]);
    assert.equal(isDirectProvider("booking_com"), true);
    assert.equal(isDirectProvider("airbnb"), false);
  });
});
