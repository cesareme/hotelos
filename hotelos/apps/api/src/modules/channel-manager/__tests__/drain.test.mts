// Pure drain logic (drain.core.ts): backoff schedule, token bucket, per-item
// rejection, timeout → retry, exhaustion and delivery → item translation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failedResult, type AdapterResult } from "../adapter.types.js";
import { parseRetryAfter } from "../adapters/transport.js";
import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  EXHAUSTED_MESSAGE,
  MAX_ATTEMPTS,
  PURGE_INTERVAL_MS,
  RETRY_BACKOFF_MS,
  TokenBucket,
  chunk,
  computeOutcomes,
  isPurgeDue,
  nextRetryDelayMs,
  purgeCutoff,
  summarizeOutcomes,
  toAvailabilityItem,
  toRateItem,
  toRestrictionItem,
  type DrainDelivery
} from "../drain.core.js";

function delivery(id: string, kind: DrainDelivery["kind"], attempts = 0, payload: Record<string, unknown> = {}): DrainDelivery {
  return { id, channelId: "bk", kind, roomTypeId: "rt1", ratePlanId: kind === "availability" ? "*" : "bar", date: "2026-06-01", payload, attempts };
}

const okResult = (accepted: number, rejected: AdapterResult["rejected"] = []): AdapterResult => ({
  ok: true,
  accepted,
  rejected,
  errors: [],
  latencyMs: 12,
  requestHash: "req",
  responseHash: "res"
});

describe("drain.core — backoff", () => {
  it("follows 1m, 5m, 30m, 2h and gives up on the 5th attempt", () => {
    assert.deepEqual(RETRY_BACKOFF_MS, [60_000, 300_000, 1_800_000, 7_200_000]);
    assert.equal(nextRetryDelayMs(1), 60_000);
    assert.equal(nextRetryDelayMs(2), 300_000);
    assert.equal(nextRetryDelayMs(3), 1_800_000);
    assert.equal(nextRetryDelayMs(4), 7_200_000);
    assert.equal(nextRetryDelayMs(MAX_ATTEMPTS), null);
    assert.equal(nextRetryDelayMs(9), null);
  });
});

describe("drain.core — token bucket", () => {
  it("allows perMinute requests, then refills continuously", () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(3, t0);
    assert.equal(bucket.take(t0), true);
    assert.equal(bucket.take(t0), true);
    assert.equal(bucket.take(t0), true);
    assert.equal(bucket.take(t0), false);
    assert.equal(bucket.msUntilNextToken(t0), 20_000);
    assert.equal(bucket.take(t0 + 19_000), false);
    assert.equal(bucket.take(t0 + 20_000), true);
    assert.equal(bucket.available(t0 + 20_000 + 60_000), 3); // capped at capacity
  });

  it("chunks by the adapter's max items per request", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 2), []);
    assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
  });
});

describe("drain.core — outcomes", () => {
  const now = new Date("2026-06-01T10:00:00.000Z");

  it("confirms accepted items and rejects the ones the provider named (final, no retry)", () => {
    const batch = [delivery("a", "rates"), delivery("b", "rates"), delivery("c", "rates")];
    const outcomes = computeOutcomes(batch, okResult(2, [{ itemIndex: 1, code: "402", message: "AmountAfterTax must be between 5 and 50000" }]), now);
    assert.equal(outcomes[0]?.status, "confirmed");
    assert.equal(outcomes[0]?.confirmed, true);
    assert.equal(outcomes[1]?.status, "rejected");
    assert.equal(outcomes[1]?.lastError, "402: AmountAfterTax must be between 5 and 50000");
    assert.equal(outcomes[1]?.nextRetryAt, null);
    assert.equal(outcomes[2]?.status, "confirmed");
    assert.deepEqual(summarizeOutcomes(outcomes), { queued: 0, sending: 0, sent: 0, confirmed: 2, rejected: 1, timeout: 0, superseded: 0 });
    assert.ok(outcomes.every((o) => o.attempts === 1));
  });

  it("timeout → status timeout with the backoff of the attempt, then exhausted → rejected", () => {
    const first = computeOutcomes([delivery("a", "rates", 0)], failedResult({ errors: ["Timeout tras 30000 ms"], timedOut: true }), now);
    assert.equal(first[0]?.status, "timeout");
    assert.equal(first[0]?.attempts, 1);
    assert.equal(first[0]?.nextRetryAt?.getTime(), now.getTime() + 60_000);
    const fourth = computeOutcomes([delivery("a", "rates", 3)], failedResult({ errors: ["HTTP 503"], retryable: true }), now);
    assert.equal(fourth[0]?.status, "timeout");
    assert.equal(fourth[0]?.nextRetryAt?.getTime(), now.getTime() + 7_200_000);
    const fifth = computeOutcomes([delivery("a", "rates", 4)], failedResult({ errors: ["Rate limited (429)"], rateLimited: true }), now);
    assert.equal(fifth[0]?.status, "rejected");
    assert.ok(fifth[0]?.lastError?.startsWith(EXHAUSTED_MESSAGE));
    assert.equal(fifth[0]?.nextRetryAt, null);
  });

  it("honours a Retry-After longer than the backoff step, never a shorter one", () => {
    const longer = computeOutcomes([delivery("a", "rates", 0)], failedResult({ errors: ["HTTP 429"], rateLimited: true, retryAfterMs: 120_000 }), now);
    assert.equal(longer[0]?.status, "timeout");
    assert.equal(longer[0]?.nextRetryAt?.getTime(), now.getTime() + 120_000);
    const shorter = computeOutcomes([delivery("a", "rates", 0)], failedResult({ errors: ["HTTP 429"], rateLimited: true, retryAfterMs: 5_000 }), now);
    assert.equal(shorter[0]?.nextRetryAt?.getTime(), now.getTime() + 60_000);
    assert.equal(parseRetryAfter("30", 0), 30_000);
    assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:27:00 GMT")), 60_000);
    assert.equal(parseRetryAfter("garbage", 0), undefined);
    assert.equal(parseRetryAfter(null, 0), undefined);
  });

  it("a definitive provider error rejects the whole batch at once", () => {
    const outcomes = computeOutcomes([delivery("a", "rates"), delivery("b", "rates")], failedResult({ errors: ["1001: Authentication failed"], retryable: false }), now);
    assert.ok(outcomes.every((o) => o.status === "rejected" && o.lastError === "1001: Authentication failed"));
  });
});

describe("drain.core — translation", () => {
  it("rebuilds v2 items from the stored payload", () => {
    const rate = toRateItem(delivery("a", "rates", 0, { externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", pricingModel: "obp", amount: 100, occupancyPrices: { "1": 90, "2": 100 } }), "EUR");
    assert.deepEqual(rate, { date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", currency: "EUR", pricingModel: "obp", amount: 100, occupancyPrices: { "1": 90, "2": 100 } });
    const restr = toRestrictionItem(delivery("b", "restrictions", 0, { externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", minStay: 2, cta: true, closed: false, stopSell: true }));
    assert.deepEqual(restr, { date: "2026-06-01", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", roomTypeId: "rt1", ratePlanId: "bar", minStay: 2, cta: true, ctd: false, closed: false, stopSell: true });
    const avail = toAvailabilityItem(delivery("c", "availability", 0, { externalRoomCode: "BK-DBL", count: 4.7 }));
    assert.deepEqual(avail, { date: "2026-06-01", externalRoomCode: "BK-DBL", roomTypeId: "rt1", count: 4 });
  });
});

describe("drain.core — retention purge (cierre)", () => {
  it("is due on the first pass of the process and then once per hour", () => {
    const t0 = new Date("2026-09-15T10:00:00.000Z");
    assert.equal(PURGE_INTERVAL_MS, 60 * 60_000);
    assert.equal(isPurgeDue(null, t0), true);
    assert.equal(isPurgeDue(t0, new Date(t0.getTime() + 15_000)), false);
    assert.equal(isPurgeDue(t0, new Date(t0.getTime() + PURGE_INTERVAL_MS - 1)), false);
    assert.equal(isPurgeDue(t0, new Date(t0.getTime() + PURGE_INTERVAL_MS)), true);
  });

  it("purgeCutoff is now − retention days, falling back to the 30-day default on bad input", () => {
    const now = new Date("2026-09-15T10:00:00.000Z");
    assert.equal(DEFAULT_DELIVERY_RETENTION_DAYS, 30);
    assert.equal(purgeCutoff(now, 30).toISOString(), "2026-08-16T10:00:00.000Z");
    assert.equal(purgeCutoff(now, 1).toISOString(), "2026-09-14T10:00:00.000Z");
    assert.equal(purgeCutoff(now, 7.9).toISOString(), "2026-09-08T10:00:00.000Z");
    assert.equal(purgeCutoff(now, 0).toISOString(), "2026-08-16T10:00:00.000Z");
    assert.equal(purgeCutoff(now, Number.NaN).toISOString(), "2026-08-16T10:00:00.000Z");
  });
});
