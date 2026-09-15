// The in-process provider simulator performs a STRUCTURAL validation of the
// provider payloads (Booking OTA 2003B, Channex JSON, Expedia EQC AR): no XSD
// and no certification — see the header of sandbox/simulator.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildAvailNotifXml, buildRateAmountNotifXml, buildRestrictionsNotifXml, parseOtaResponse } from "../../adapters/booking/xml.js";
import { buildAvailRateUpdateRatesXml } from "../../adapters/expedia/xml.js";
import { EQC_AR_NS, OTA_NS, resetSimulatorCounters, runSimulator, simulateBookingOta, simulateChannex, simulateExpediaEqc, xmlElements } from "../simulator.js";

const RATE_ITEMS = [
  { date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "per_day" as const, amount: 129.5 },
  { date: "2026-06-02", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "obp" as const, occupancyPrices: { "1": 110, "2": 139 } }
];

beforeEach(() => resetSimulatorCounters());

describe("simulator — Booking OTA 2003B", () => {
  it("a valid OTA_HotelRateAmountNotifRQ answers <Success/> with the real elements", () => {
    const xml = buildRateAmountNotifXml({ hotelCode: "12345", items: RATE_ITEMS });
    assert.ok(xml.includes(`xmlns="${OTA_NS}"`));
    assert.ok(xml.includes('<RateAmountMessages HotelCode="12345">'));
    assert.ok(xml.includes('<StatusApplicationControl Start="2026-06-01" End="2026-06-01" InvTypeCode="BK-DBL" RatePlanCode="RP-BAR"/>'));
    // CurrencyCode / DecimalPlaces sit on BaseByGuestAmt (never on <Rate>), as in the extranet's examples.
    assert.ok(xml.includes('<BaseByGuestAmt AmountAfterTax="129.50" DecimalPlaces="2" CurrencyCode="EUR"/>'));
    assert.ok(xml.includes('<BaseByGuestAmt NumberOfGuests="2" AmountAfterTax="139.00" DecimalPlaces="2" CurrencyCode="EUR"/>'));
    assert.ok(xml.includes("<Rates><Rate><BaseByGuestAmts>"));
    assert.equal(/<Rate [^>]*CurrencyCode/.test(xml), false);
    const rs = simulateBookingOta(xml);
    assert.equal(rs.status, 200);
    assert.ok(rs.body.includes("<OTA_HotelRateAmountNotifRS"));
    assert.ok(rs.body.includes("<Success/>"));
    assert.equal(rs.accepted, 2);
    assert.deepEqual(rs.rejected, []);
    assert.equal(parseOtaResponse(rs.body).success, true);
  });

  it("a price below 5 is rejected with an OTA Error code and RecordID of the message", () => {
    const xml = buildRateAmountNotifXml({ hotelCode: "12345", items: [RATE_ITEMS[0]!, { ...RATE_ITEMS[0]!, date: "2026-06-03", amount: 3 }] });
    const rs = simulateBookingOta(xml);
    assert.equal(rs.accepted, 1);
    assert.deepEqual(rs.rejected, [{ itemIndex: 1, code: "402", message: "AmountAfterTax must be between 5 and 50000" }]);
    assert.ok(rs.body.includes('<Errors><Error Type="3" Code="402" RecordID="1"'));
    const parsed = parseOtaResponse(rs.body);
    assert.equal(parsed.success, false);
    assert.equal(parsed.errors[0]?.recordId, 1);
  });

  it("rejects a request with two hotels, an unknown root or dates beyond 5 years", () => {
    const two = `<?xml version="1.0"?><OTA_HotelRateAmountNotifRQ xmlns="${OTA_NS}"><RateAmountMessages HotelCode="1"><RateAmountMessage><StatusApplicationControl Start="2026-06-01" End="2026-06-01" InvTypeCode="A" RatePlanCode="B"/><Rates><Rate><BaseByGuestAmts><BaseByGuestAmt AmountAfterTax="10"/></BaseByGuestAmts></Rate></Rates></RateAmountMessage></RateAmountMessages><RateAmountMessages HotelCode="2"></RateAmountMessages></OTA_HotelRateAmountNotifRQ>`;
    const rs = simulateBookingOta(two);
    assert.equal(rs.accepted, 0);
    assert.ok(rs.errors[0]?.includes("Exactly one HotelCode"));
    assert.ok(simulateBookingOta("<Foo/>").errors[0]?.includes("Unknown OTA request root"));
    const far = buildRateAmountNotifXml({ hotelCode: "1", items: [{ ...RATE_ITEMS[0]!, date: "2040-01-01" }] });
    const farRs = simulateBookingOta(far);
    assert.equal(farRs.rejected[0]?.code, "400");
  });

  it("validates OTA_HotelAvailNotifRQ with BookingLimit, LengthsOfStay and RestrictionStatus", () => {
    const avail = buildAvailNotifXml({ hotelCode: "12345", items: [{ date: "2026-06-01", externalRoomCode: "BK-DBL", roomTypeId: "rt1", count: 5 }] });
    assert.ok(avail.includes('<AvailStatusMessage BookingLimit="5">'));
    assert.equal(simulateBookingOta(avail).accepted, 1);
    const restr = buildRestrictionsNotifXml({
      hotelCode: "12345",
      items: [{ date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", minStay: 2, maxStay: 7, minStayThrough: 3, cta: true, ctd: false, closed: false, stopSell: true }]
    });
    assert.ok(restr.includes('<LengthOfStay MinMaxMessageType="SetMinLOS" Time="2"/>'));
    assert.ok(restr.includes('<LengthOfStay MinMaxMessageType="SetForwardMinStay" Time="3"/>'));
    assert.ok(restr.includes('<RestrictionStatus Status="Close" Restriction="Master"/>'));
    assert.ok(restr.includes('<RestrictionStatus Status="Close" Restriction="Arrival"/>'));
    assert.ok(restr.includes('<RestrictionStatus Status="Open" Restriction="Departure"/>'));
    // One RestrictionStatus per AvailStatusMessage: one item → three messages, each with its own StatusApplicationControl.
    const messages = xmlElements(restr, "AvailStatusMessage");
    assert.equal(messages.length, 3);
    for (const m of messages) {
      assert.equal(xmlElements(m.inner, "RestrictionStatus").length, 1);
      assert.equal(xmlElements(m.inner, "StatusApplicationControl").length, 1);
    }
    const rs = simulateBookingOta(restr);
    assert.equal(rs.accepted, 3);
    assert.ok(rs.body.includes("<OTA_HotelAvailNotifRS"));
    const bad = restr.replace('Status="Close" Restriction="Master"', 'Status="Closed" Restriction="Master"');
    assert.equal(simulateBookingOta(bad).rejected[0]?.code, "402");
  });

  it("refuses more than one RestrictionStatus per message (OTA 0..1) and malformed advance-booking offsets", () => {
    const one = buildRestrictionsNotifXml({ hotelCode: "1", items: [{ date: "2026-06-01", externalRoomCode: "A", externalRateCode: "B", cta: false, ctd: false, closed: false, stopSell: false, minAdvanceDays: 2, maxAdvanceDays: 90 }] });
    assert.ok(one.includes('MinAdvancedBookingOffset="2D" MaxAdvancedBookingOffset="90D"'));
    assert.equal(simulateBookingOta(one).accepted, 3);
    const two = one.replace('<RestrictionStatus Status="Open" Restriction="Arrival"/>', '<RestrictionStatus Status="Open" Restriction="Arrival"/><RestrictionStatus Status="Open" Restriction="Departure"/>');
    const rs = simulateBookingOta(two);
    assert.equal(rs.rejected.length, 1);
    assert.ok(rs.rejected[0]?.message.includes("Only one RestrictionStatus"));
    const badOffset = one.replace('MinAdvancedBookingOffset="2D"', 'MinAdvancedBookingOffset="P2D"');
    assert.ok(simulateBookingOta(badOffset).rejected[0]?.message.includes("MinAdvancedBookingOffset"));
  });
});

describe("simulator — Channex JSON", () => {
  it("accepts a valid restrictions payload and returns warnings without blocking", () => {
    const body = JSON.stringify({
      values: [
        { property_id: "p1", rate_plan_id: "RP-BAR", date: "2026-06-01", rate: 129.5, min_stay_arrival: 2, closed_to_arrival: false, stop_sell: false },
        { property_id: "p1", rate_plan_id: "RP-BAR", date_from: "2026-06-02", date_to: "2026-06-03", rate: 3, rates: [{ occupancy: 1, rate: 3 }] }
      ]
    });
    const rs = simulateChannex("restrictions", body);
    assert.equal(rs.status, 200);
    assert.equal(rs.accepted, 2);
    assert.equal(rs.warnings.length, 1);
    assert.ok(rs.warnings[0]?.includes("below 5"));
    const json = JSON.parse(rs.body) as { data: Array<{ type: string }>; meta: { message: string; warnings: unknown[] } };
    assert.equal(json.data[0]?.type, "task");
    assert.equal(json.meta.message, "Success");
    assert.equal(json.meta.warnings.length, 1);
  });

  it("like Channex, rejects a value with wrong data as a 200 warning object echoing the value (the rest is applied)", () => {
    const body = JSON.stringify({ values: [{ property_id: "p1", rate_plan_id: "RP-BAR", date: "2026-06-01", rate: 10 }, { property_id: "p1", date: "2026-06-01", rate: -1 }] });
    const rs = simulateChannex("/api/v1/restrictions", body);
    assert.equal(rs.status, 200);
    assert.equal(rs.accepted, 1);
    assert.equal(rs.rejected[0]?.itemIndex, 1);
    const json = JSON.parse(rs.body) as { meta: { warnings: Array<{ property_id?: string; date?: string; warning: Record<string, string[]> }> } };
    assert.equal(json.meta.warnings.length, 1);
    assert.equal(json.meta.warnings[0]?.property_id, "p1");
    assert.equal(json.meta.warnings[0]?.date, "2026-06-01");
    assert.deepEqual(Object.keys(json.meta.warnings[0]!.warning).sort(), ["rate", "rate_plan_id"]);
    // Unknown keys (e.g. a field Channex has no vocabulary for) are ignored with a notice, never a rejection.
    const unknown = simulateChannex("restrictions", JSON.stringify({ values: [{ property_id: "p1", rate_plan_id: "RP-BAR", date: "2026-06-01", rate: 10, min_advance_days: 2 }] }));
    assert.equal(unknown.accepted, 1);
    assert.ok(unknown.warnings[0]?.includes("min_advance_days"));
  });

  it("validates availability values; malformed JSON / a missing values array are 400 bad_request with string details", () => {
    assert.equal(simulateChannex("availability", JSON.stringify({ values: [{ property_id: "p1", room_type_id: "CX-DBL", date: "2026-06-01", availability: 4 }] })).accepted, 1);
    const negative = simulateChannex("availability", JSON.stringify({ values: [{ property_id: "p1", room_type_id: "CX-DBL", date: "2026-06-01", availability: -1 }] }));
    assert.equal(negative.status, 200);
    assert.equal(negative.accepted, 0);
    assert.equal(negative.rejected[0]?.itemIndex, 0);
    assert.equal(simulateChannex("restrictions", "{not json").status, 400);
    const noValues = simulateChannex("restrictions", "{}");
    assert.equal(noValues.status, 400);
    assert.deepEqual((JSON.parse(noValues.body) as { errors: { details: string[] } }).errors.details, ["values is required"]);
    assert.equal(simulateChannex("bookings", "{}").status, 404);
    assert.equal(simulateChannex("channels", "").status, 200);
  });
});

describe("simulator — Expedia EQC AR", () => {
  it("a valid AvailRateUpdateRQ with Authentication in the body answers <Success/>", () => {
    const xml = buildAvailRateUpdateRatesXml({ username: "EQC1", password: "pw", hotelId: "555" }, RATE_ITEMS);
    assert.ok(xml.includes(`xmlns="${EQC_AR_NS}"`));
    assert.ok(xml.includes('<Authentication username="EQC1" password="pw"/>'));
    assert.ok(xml.includes('<RoomType id="BK-DBL"><RatePlan id="RP-BAR"><Rate currency="EUR"><PerDay rate="129.50"/>'));
    assert.ok(xml.includes('<PerOccupancy rate="139.00" occupancy="2"/>'));
    const rs = simulateExpediaEqc(xml);
    assert.equal(rs.status, 200);
    assert.ok(rs.body.includes("<AvailRateUpdateRS") && rs.body.includes("<Success/>"));
    assert.equal(rs.accepted, 2);
  });

  it("is all-or-nothing: missing auth → 1001, bad rate → 3202", () => {
    const noAuth = `<AvailRateUpdateRQ xmlns="${EQC_AR_NS}"><Hotel id="1"/><AvailRateUpdate><DateRange from="2026-06-01" to="2026-06-01"/><RoomType id="A"/></AvailRateUpdate></AvailRateUpdateRQ>`;
    const rs = simulateExpediaEqc(noAuth);
    assert.equal(rs.accepted, 0);
    assert.ok(rs.body.includes('<Error code="1001">'));
    const badRate = buildAvailRateUpdateRatesXml({ username: "u", password: "p", hotelId: "1" }, [{ ...RATE_ITEMS[0]!, amount: 0 }]);
    assert.ok(simulateExpediaEqc(badRate).body.includes('<Error code="3202">'));
  });

  it("applies a suspiciously low rate with a <Warning> inside <Success> (EQC rate verification)", () => {
    const low = buildAvailRateUpdateRatesXml({ username: "u", password: "p", hotelId: "1" }, [{ ...RATE_ITEMS[0]!, amount: 3 }]);
    const rs = simulateExpediaEqc(low);
    assert.equal(rs.status, 200);
    assert.equal(rs.accepted, 1);
    assert.ok(rs.body.includes('<Success><Warning code="3260">'));
    assert.ok(rs.warnings[0]?.startsWith("3260:"));
  });
});

describe("simulator — failure injection", () => {
  it("failEvery answers 429 on the N-th request and latency >= timeout times out", async () => {
    const body = buildAvailNotifXml({ hotelCode: "1", items: [{ date: "2026-06-01", externalRoomCode: "A", roomTypeId: "rt1", count: 1 }] });
    const first = await runSimulator({ provider: "booking", endpoint: "OTA_HotelAvailNotif", body, channelId: "c1", options: { failEvery: 2 } });
    const second = await runSimulator({ provider: "booking", endpoint: "OTA_HotelAvailNotif", body, channelId: "c1", options: { failEvery: 2 } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    const slow = await runSimulator({ provider: "channex", endpoint: "availability", body: "{}", channelId: "c2", options: { latencyMs: 5000 }, timeoutMs: 100 });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.status, 0);
  });
});

describe("simulator — cierre: builder/simulator alignment", () => {
  it("Booking: a CurrencyCode on <Rate> (not on BaseByGuestAmt) rejects the message", () => {
    const good = buildRateAmountNotifXml({ hotelCode: "12345", items: [RATE_ITEMS[0]!] });
    const bad = good.replace("<Rate>", '<Rate CurrencyCode="EUR">');
    assert.notEqual(good, bad);
    const rs = simulateBookingOta(bad);
    assert.equal(rs.accepted, 0);
    assert.equal(rs.rejected.length, 1);
    assert.equal(rs.rejected[0]?.itemIndex, 0);
    assert.ok(rs.rejected[0]?.message.includes("CurrencyCode belongs on BaseByGuestAmt"));
    assert.ok(rs.body.includes('RecordID="0"'));
    // The builder never emits it: the same XML untouched is accepted.
    assert.equal(simulateBookingOta(good).accepted, 1);
  });

  it("Channex: min/max_advance_days are named as outside the vocabulary (ignored, value still applied)", () => {
    const body = JSON.stringify({ values: [{ property_id: "p", rate_plan_id: "rp", date: "2026-06-01", rate: 100, min_advance_days: 2, max_advance_days: 30, foo: 1 }] });
    const rs = simulateChannex("restrictions", body);
    assert.equal(rs.status, 200);
    assert.equal(rs.accepted, 1);
    assert.deepEqual(rs.rejected, []);
    assert.ok(rs.warnings.some((w) => w.includes("min_advance_days, max_advance_days outside the Channex restrictions vocabulary")));
    assert.ok(rs.warnings.some((w) => w === "values[0]: unknown keys ignored (foo)"));
  });
});
