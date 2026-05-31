// Dual-mode coverage for the Expedia, Airbnb, Hotelbeds and Vrbo adapters.
//
// For each provider we assert:
//   * stub mode pushRates returns ok with the right item count;
//   * real mode testCredentials returns { ok: false } with NO network call when
//     credentials are missing (a real fetch would hang/blow up the test);
//   * the payload builder produces non-empty, structured output.
//
// We never set a real *_API_BASE_URL / OAuth URL, so even if a code path tried
// to reach the network it would fail fast rather than hit a real OTA.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChannelContext } from "../../adapter.types.js";

import { expediaAdapter } from "../expedia.adapter.js";
import { airbnbAdapter } from "../airbnb.adapter.js";
import { hotelbedsAdapter } from "../hotelbeds.adapter.js";
import { vrboAdapter } from "../vrbo.adapter.js";

import { clearTokenCache as clearExpediaToken } from "../expedia/auth.js";
import { clearTokenCache as clearAirbnbToken } from "../airbnb/auth.js";
import { clearTokenCache as clearVrboToken } from "../vrbo/auth.js";

import {
  buildAvailabilityPayload as expediaAvail,
  buildRatesPayload as expediaRates,
  buildRestrictionsPayload as expediaRestr
} from "../expedia/payload.js";
import {
  buildCalendarPayload as airbnbCalendar,
  buildPricingPayload as airbnbPricing,
  buildAvailabilityRulesPayload as airbnbRules
} from "../airbnb/payload.js";
import {
  buildInventoryPayload as hbInventory,
  buildRatesPayload as hbRates,
  buildRestrictionsPayload as hbRestr
} from "../hotelbeds/payload.js";
import {
  buildAvailabilityPayload as vrboAvail,
  buildRatesPayload as vrboRates,
  buildRestrictionsPayload as vrboRestr
} from "../vrbo/payload.js";
import { buildSignature } from "../hotelbeds/auth.js";

const MODE_ENV_KEYS = [
  "EXPEDIA_ADAPTER_MODE",
  "AIRBNB_ADAPTER_MODE",
  "HOTELBEDS_ADAPTER_MODE",
  "VRBO_ADAPTER_MODE"
] as const;

function clearModes(): void {
  for (const key of MODE_ENV_KEYS) delete process.env[key];
  clearExpediaToken();
  clearAirbnbToken();
  clearVrboToken();
}

function channel(provider: ChannelContext["providerCode"], creds: Record<string, unknown> | null): ChannelContext {
  return { id: `channel-${provider}`, propertyId: "prop-1", providerCode: provider, credentialsJson: creds };
}

const RATE_ITEMS = [
  { date: "2026-06-01", ratePlanId: "RP-BAR", amount: 129.5, currency: "EUR" },
  { date: "2026-06-02", ratePlanId: "RP-BAR", amount: 139, currency: "EUR" }
];
const AVAIL_ITEMS = [
  { date: "2026-06-01", roomTypeId: "ROOM-101", count: 5 },
  { date: "2026-06-02", roomTypeId: "ROOM-101", count: 0 }
];
const RESTR_ITEMS = [
  { date: "2026-06-01", roomTypeId: "ROOM-101", ratePlanId: "RP-BAR", minStay: 2, cta: true, closed: false }
];

const GOOD_CREDS: Record<string, unknown> = {
  client_id: "stub-client",
  client_secret: "stub-secret",
  apiKey: "stub-key",
  secret: "stub-secret",
  listingId: "ABNB-1",
  resortID: "EXP-1",
  propertyId: "VRBO-1"
};

beforeEach(clearModes);
afterEach(clearModes);

describe("multi-adapter — stub mode pushRates", () => {
  it("expedia stub pushRates returns ok with item count", async () => {
    const r = await expediaAdapter.pushRates({ channel: channel("expedia", GOOD_CREDS), items: RATE_ITEMS });
    assert.equal(r.ok, true);
    assert.equal(r.pushed, RATE_ITEMS.length);
    assert.ok(typeof r.latencyMs === "number" && r.latencyMs >= 0);
    assert.deepEqual(r.raw, { stub: true, provider: "expedia" });
  });

  it("airbnb stub pushRates returns ok with item count", async () => {
    const r = await airbnbAdapter.pushRates({ channel: channel("airbnb", GOOD_CREDS), items: RATE_ITEMS });
    assert.equal(r.ok, true);
    assert.equal(r.pushed, RATE_ITEMS.length);
    assert.deepEqual(r.raw, { stub: true, provider: "airbnb" });
  });

  it("hotelbeds stub pushRates returns ok with item count", async () => {
    const r = await hotelbedsAdapter.pushRates({ channel: channel("hotelbeds", GOOD_CREDS), items: RATE_ITEMS });
    assert.equal(r.ok, true);
    assert.equal(r.pushed, RATE_ITEMS.length);
    assert.deepEqual(r.raw, { stub: true, provider: "hotelbeds" });
  });

  it("vrbo stub pushRates returns ok with item count", async () => {
    const r = await vrboAdapter.pushRates({ channel: channel("vrbo", GOOD_CREDS), items: RATE_ITEMS });
    assert.equal(r.ok, true);
    assert.equal(r.pushed, RATE_ITEMS.length);
    assert.deepEqual(r.raw, { stub: true, provider: "vrbo" });
  });
});

describe("multi-adapter — real mode testCredentials without creds (no network)", () => {
  it("expedia real testCredentials returns ok=false when creds null", async () => {
    process.env.EXPEDIA_ADAPTER_MODE = "real";
    const r = await expediaAdapter.testCredentials({ channel: channel("expedia", null) });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length > 0);
  });

  it("airbnb real testCredentials returns ok=false when creds null", async () => {
    process.env.AIRBNB_ADAPTER_MODE = "real";
    const r = await airbnbAdapter.testCredentials({ channel: channel("airbnb", null) });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length > 0);
  });

  it("hotelbeds real testCredentials returns ok=false when creds null", async () => {
    process.env.HOTELBEDS_ADAPTER_MODE = "real";
    const r = await hotelbedsAdapter.testCredentials({ channel: channel("hotelbeds", null) });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length > 0);
  });

  it("vrbo real testCredentials returns ok=false when creds null", async () => {
    process.env.VRBO_ADAPTER_MODE = "real";
    const r = await vrboAdapter.testCredentials({ channel: channel("vrbo", null) });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length > 0);
  });

  it("hotelbeds real testCredentials returns ok=false with INVALID sentinel (no network)", async () => {
    process.env.HOTELBEDS_ADAPTER_MODE = "real";
    const r = await hotelbedsAdapter.testCredentials({
      channel: channel("hotelbeds", { apiKey: "INVALID", secret: "x" })
    });
    assert.equal(r.ok, false);
  });
});

describe("multi-adapter — payload builders produce structured output", () => {
  it("expedia builders emit non-empty AvailRateUpdate arrays", () => {
    const rates = expediaRates(RATE_ITEMS, "EXP-1");
    assert.equal(rates.AvailRateUpdate.length, RATE_ITEMS.length);
    assert.equal(rates.Authentication?.resortID, "EXP-1");
    const json = JSON.stringify(rates);
    assert.match(json, /RatePlanID/);
    assert.match(json, /129\.5/);

    const avail = expediaAvail(AVAIL_ITEMS);
    assert.equal(avail.AvailRateUpdate.length, AVAIL_ITEMS.length);
    assert.match(JSON.stringify(avail), /TotalInventoryAvailable/);

    const restr = expediaRestr(RESTR_ITEMS);
    assert.equal(restr.AvailRateUpdate.length, RESTR_ITEMS.length);
    assert.match(JSON.stringify(restr), /MinLOS/);
    assert.match(JSON.stringify(restr), /ClosedToArrival/);
  });

  it("airbnb builders emit daily_prices, calendar and availability_rules", () => {
    const pricing = airbnbPricing(RATE_ITEMS);
    assert.equal(pricing.daily_prices.length, RATE_ITEMS.length);
    assert.equal(pricing.daily_prices[0]!.native_price, 129.5);
    assert.equal(pricing.daily_prices[0]!.native_currency, "EUR");

    const cal = airbnbCalendar(AVAIL_ITEMS);
    assert.equal(cal.calendar.length, AVAIL_ITEMS.length);
    assert.equal(cal.calendar[0]!.available, true);
    assert.equal(cal.calendar[1]!.available, false); // count 0 → unavailable

    const rules = airbnbRules(RESTR_ITEMS);
    assert.equal(rules.availability_rules.length, RESTR_ITEMS.length);
    assert.match(JSON.stringify(rules), /min_nights/);
  });

  it("hotelbeds builders emit net rates, inventory and restrictions", () => {
    const rates = hbRates(RATE_ITEMS);
    assert.equal(rates.rates.length, RATE_ITEMS.length);
    assert.equal(rates.rates[0]!.net, 129.5);
    assert.equal(rates.rates[0]!.rateKey, "RP-BAR");

    const inv = hbInventory(AVAIL_ITEMS);
    assert.equal(inv.inventory.length, AVAIL_ITEMS.length);
    assert.equal(inv.inventory[0]!.allotment, 5);

    const restr = hbRestr(RESTR_ITEMS);
    assert.equal(restr.restrictions.length, RESTR_ITEMS.length);
    assert.match(JSON.stringify(restr), /minimumStay/);
    assert.match(JSON.stringify(restr), /closedToArrival/);
  });

  it("vrbo builders emit availRateUpdate arrays scoped to listing", () => {
    const rates = vrboRates(RATE_ITEMS, "VRBO-1");
    assert.equal(rates.listingId, "VRBO-1");
    assert.equal(rates.availRateUpdate.length, RATE_ITEMS.length);
    assert.match(JSON.stringify(rates), /nightlyAmount/);

    const avail = vrboAvail(AVAIL_ITEMS);
    assert.equal(avail.availRateUpdate.length, AVAIL_ITEMS.length);
    assert.match(JSON.stringify(avail), /available/);

    const restr = vrboRestr(RESTR_ITEMS);
    assert.equal(restr.availRateUpdate.length, RESTR_ITEMS.length);
    assert.match(JSON.stringify(restr), /minStay/);
  });
});

describe("hotelbeds signature — deterministic and time-bound", () => {
  it("buildSignature is SHA256(apiKey+secret+epochSeconds) and floors ms to seconds", () => {
    const ch = channel("hotelbeds", { apiKey: "K", secret: "S" });
    // Two calls in the same second produce the same signature.
    const a = buildSignature(ch, 1_700_000_000_123);
    const b = buildSignature(ch, 1_700_000_000_999);
    assert.equal(a.timestamp, 1_700_000_000);
    assert.equal(a.signature, b.signature);
    assert.equal(a.signature.length, 64); // hex SHA256
    // A different second yields a different signature (drift sensitivity).
    const c = buildSignature(ch, 1_700_000_001_000);
    assert.notEqual(a.signature, c.signature);
  });

  it("buildSignature throws when credentials are missing", () => {
    assert.throws(() => buildSignature(channel("hotelbeds", null)));
  });
});
