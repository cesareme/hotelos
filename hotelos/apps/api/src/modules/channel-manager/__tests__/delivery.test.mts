// Pure outbox planning (delivery.core.ts): idempotency keys, superseding,
// unmapped warnings, markup, availability per room and the worst-state sync map.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { round2 as gridRound2 } from "../../rate-manager/derivation.js";
import {
  applyMarkup,
  assertKnownChannelIds,
  buildCellSyncMap,
  cellKey,
  classifyJournalPushStatus,
  currentValueHashes,
  deliveryCellKey,
  filterByIds,
  idempotencyKey,
  listDates,
  mergeRestrictions,
  payloadHash,
  planDeliveries,
  productKey,
  round2,
  valueHash,
  worstStatus,
  type ExistingDelivery,
  type PlanChannel,
  type PlanInput,
  type SyncMapRow
} from "../delivery.core.js";

function channel(id: string, mappings: Array<[string, string, string, string]>, extra: Partial<PlanChannel> = {}): PlanChannel {
  return {
    id,
    providerCode: id,
    status: "active",
    mode: "sandbox",
    markupPercent: 0,
    mappings: new Map(mappings.map(([rt, rp, room, rate]) => [productKey(rt, rp), { roomTypeId: rt, ratePlanId: rp, externalRoomCode: room, externalRateCode: rate, pricingModel: "per_day" as const }])),
    ...extra
  };
}

function baseInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    channels: [channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"]])],
    roomTypes: [{ id: "rt1", code: "DBL" }],
    ratePlans: [{ id: "bar", code: "BAR" }],
    dates: ["2026-06-01", "2026-06-02"],
    kinds: ["rates", "restrictions", "availability"],
    rates: [
      { ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-01", price: 100, currency: "EUR", occupancyPrices: null },
      { ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-02", price: 120, currency: "EUR", occupancyPrices: { "1": 100, "2": 120 } }
    ],
    restrictions: [],
    availability: [{ roomTypeId: "rt1", date: "2026-06-01", count: 5 }],
    existing: [],
    ...overrides
  };
}

describe("delivery.core — hashing", () => {
  it("payloadHash is canonical (key order does not matter) and idempotencyKey is deterministic", () => {
    const a = payloadHash({ amount: 100, currency: "EUR", externalRoomCode: "BK-DBL" });
    const b = payloadHash({ externalRoomCode: "BK-DBL", currency: "EUR", amount: 100, ignored: undefined });
    assert.equal(a, b);
    assert.equal(a.length, 64);
    const k1 = idempotencyKey({ channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", payloadHash: a });
    const k2 = idempotencyKey({ channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", payloadHash: a });
    const k3 = idempotencyKey({ channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-02", payloadHash: a });
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
  });

  it("listDates is inclusive and applyMarkup rounds to 2 decimals", () => {
    assert.deepEqual(listDates("2026-06-01", "2026-06-03"), ["2026-06-01", "2026-06-02", "2026-06-03"]);
    assert.equal(applyMarkup(100, 15), 115);
    assert.equal(applyMarkup(99.99, 10), 109.99);
    assert.equal(cellKey("bar", "rt1", "2026-06-01"), "bar|rt1|2026-06-01");
  });
});

describe("delivery.core — planDeliveries", () => {
  it("creates one delivery per (kind, product, date) with translated codes and availability keyed by room ('*')", () => {
    const plan = planDeliveries(baseInput());
    const rates = plan.drafts.filter((d) => d.kind === "rates");
    const avail = plan.drafts.filter((d) => d.kind === "availability");
    assert.equal(rates.length, 2);
    assert.equal(avail.length, 1);
    assert.equal(avail[0]?.ratePlanId, "*");
    assert.deepEqual(rates[0]?.payload, { externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", pricingModel: "per_day", amount: 100, currency: "EUR" });
    assert.deepEqual((rates[1]?.payload as { occupancyPrices: unknown }).occupancyPrices, { "1": 100, "2": 120 });
    assert.equal(plan.byChannel.bk?.queued, 3);
    assert.equal(plan.byChannel.bk?.mode, "sandbox");
    assert.deepEqual(plan.warnings, []);
  });

  it("applies the channel markup to the amount and the occupancy prices", () => {
    const plan = planDeliveries(baseInput({ channels: [channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"]], { markupPercent: 10 })] }));
    const rates = plan.drafts.filter((d) => d.kind === "rates");
    assert.equal(rates[0]?.payload.amount, 110);
    assert.deepEqual((rates[1]?.payload as { occupancyPrices: Record<string, number> }).occupancyPrices, { "1": 110, "2": 132 });
  });

  it("warns per channel and product when a mapping is missing (never a silent skip)", () => {
    const plan = planDeliveries(
      baseInput({
        channels: [channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"]]), channel("ex", [])],
        roomTypes: [
          { id: "rt1", code: "DBL" },
          { id: "rt2", code: "SUI" }
        ]
      })
    );
    assert.equal(plan.byChannel.bk?.skippedUnmapped, 1);
    assert.equal(plan.byChannel.ex?.skippedUnmapped, 2);
    assert.equal(plan.byChannel.ex?.queued, 0);
    assert.ok(plan.warnings.includes("Canal bk: sin mapeo para SUI × BAR."));
    assert.ok(plan.warnings.includes("Canal ex: sin mapeo para DBL × BAR."));
    assert.ok(plan.warnings.includes("Canal ex: sin mapeo para SUI × BAR."));
  });

  it("skips an identical payload already queued/confirmed and re-queues a rejected one", () => {
    const first = planDeliveries(baseInput());
    const rate = first.drafts.find((d) => d.kind === "rates" && d.date === "2026-06-01")!;
    const existing: ExistingDelivery[] = [
      { id: "d1", channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", status: "confirmed", idempotencyKey: rate.idempotencyKey, payloadHash: rate.payloadHash, updatedAt: "2026-05-01T10:00:00.000Z" }
    ];
    const second = planDeliveries(baseInput({ existing }));
    assert.equal(second.skipped, 1);
    assert.equal(second.drafts.filter((d) => d.kind === "rates").length, 1);
    assert.equal(second.byChannel.bk?.queued, 2);

    const third = planDeliveries(baseInput({ existing: [{ ...existing[0]!, status: "rejected" }] }));
    assert.deepEqual(third.requeue, ["d1"]);
    assert.equal(third.skipped, 0);
    assert.equal(third.byChannel.bk?.queued, 3);
    assert.equal(third.drafts.filter((d) => d.kind === "rates" && d.date === "2026-06-01").length, 0);
  });

  it("supersedes a queued delivery of the same cell with a different payload", () => {
    const existing: ExistingDelivery[] = [
      { id: "old", channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", status: "queued", idempotencyKey: "other-key", payloadHash: "other-hash", updatedAt: "2026-05-01T10:00:00.000Z" },
      { id: "sent", channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-02", status: "confirmed", idempotencyKey: "older", payloadHash: "older", updatedAt: "2026-05-01T10:00:00.000Z" }
    ];
    const plan = planDeliveries(baseInput({ existing }));
    assert.deepEqual(plan.supersede, ["old"]);
    assert.equal(plan.drafts.filter((d) => d.kind === "rates").length, 2);
  });

  it("does not enqueue anything for an inactive channel", () => {
    const plan = planDeliveries(baseInput({ channels: [channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"]], { status: "inactive" })] }));
    assert.equal(plan.drafts.length, 0);
    assert.ok(plan.warnings[0]?.includes("inactivo"));
  });

  it("merges restrictions by specificity and ORs the flags", () => {
    const rows = [
      { roomTypeId: "rt1", ratePlanId: "*", channelId: "*", date: "2026-06-01", minStay: 2, maxStay: null, minStayThrough: null, closedToArrival: false, closedToDeparture: false, closed: false, stopSell: true, minAdvanceDays: null, maxAdvanceDays: null },
      { roomTypeId: "rt1", ratePlanId: "bar", channelId: "*", date: "2026-06-01", minStay: 3, maxStay: 7, minStayThrough: null, closedToArrival: true, closedToDeparture: false, closed: false, stopSell: false, minAdvanceDays: null, maxAdvanceDays: null },
      { roomTypeId: "rt1", ratePlanId: "bar", channelId: "bk", date: "2026-06-01", minStay: null, maxStay: null, minStayThrough: null, closedToArrival: false, closedToDeparture: false, closed: true, stopSell: false, minAdvanceDays: 1, maxAdvanceDays: null }
    ];
    const merged = mergeRestrictions(rows, "bk", "bar");
    assert.deepEqual(merged, { minStay: 3, maxStay: 7, cta: true, ctd: false, closed: true, stopSell: true, minAdvanceDays: 1 });
    // Another channel/plan only sees the (*, *) row; no row at all → null.
    assert.deepEqual(mergeRestrictions(rows, "ex", "nr"), { minStay: 2, cta: false, ctd: false, closed: false, stopSell: true });
    assert.equal(mergeRestrictions([], "ex", "nr"), null);
    const plan = planDeliveries(baseInput({ restrictions: rows, kinds: ["restrictions"] }));
    assert.equal(plan.drafts.length, 1);
    assert.equal(plan.drafts[0]?.payload.closed, true);
    assert.equal(plan.drafts[0]?.payload.externalRateCode, "RP-BAR");
  });
});

describe("delivery.core — revert and overtake rules (outbox-drain#1)", () => {
  const T0 = "2026-05-01T10:00:00.000Z";
  const T1 = "2026-05-01T10:05:00.000Z";
  const keys = (price: number) => {
    const h = payloadHash({ externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", pricingModel: "per_day", amount: price, currency: "EUR" });
    return { h, k: idempotencyKey({ channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", payloadHash: h }) };
  };
  const row = (id: string, price: number, status: ExistingDelivery["status"], updatedAt: string): ExistingDelivery => ({
    id,
    channelId: "bk",
    kind: "rates",
    roomTypeId: "rt1",
    ratePlanId: "bar",
    date: "2026-06-01",
    status,
    idempotencyKey: keys(price).k,
    payloadHash: keys(price).h,
    updatedAt
  });
  const grid97 = (existing: ExistingDelivery[]): PlanInput =>
    baseInput({ kinds: ["rates"], dates: ["2026-06-01"], rates: [{ ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-01", price: 97, currency: "EUR", occupancyPrices: null }], existing });

  it("revert to an already confirmed payload supersedes the pending intermediate delivery (nothing to resend)", () => {
    const plan = planDeliveries(grid97([row("A97", 97, "confirmed", T0), row("B130", 130, "queued", T1)]));
    assert.deepEqual(plan.supersede, ["B130"]);
    assert.deepEqual(plan.requeue, []);
    assert.equal(plan.drafts.length, 0);
    assert.equal(plan.skipped, 1);
    // A pending retry of the intermediate value is retired the same way.
    const retry = planDeliveries(grid97([row("A97", 97, "confirmed", T0), row("B130", 130, "timeout", T1)]));
    assert.deepEqual(retry.supersede, ["B130"]);
    assert.equal(retry.skipped, 1);
  });

  it("re-queues the confirmed row when a newer delivery of the cell carried another payload after it (in flight or confirmed)", () => {
    for (const status of ["sending", "sent", "confirmed"] as const) {
      const plan = planDeliveries(grid97([row("A97", 97, "confirmed", T0), row("B130", 130, status, T1)]));
      assert.deepEqual(plan.requeue, ["A97"], status);
      assert.deepEqual(plan.supersede, [], status);
      assert.equal(plan.byChannel.bk?.queued, 1, status);
      assert.equal(plan.skipped, 0, status);
    }
  });

  it("does not re-queue when the other confirmed delivery is OLDER, rejected, or superseded", () => {
    const older = planDeliveries(grid97([row("A97", 97, "confirmed", T1), row("B130", 130, "confirmed", T0)]));
    assert.deepEqual(older.requeue, []);
    assert.equal(older.skipped, 1);
    const rejected = planDeliveries(grid97([row("A97", 97, "confirmed", T0), row("B130", 130, "rejected", T1)]));
    assert.deepEqual(rejected.requeue, []);
    assert.equal(rejected.skipped, 1);
    const superseded = planDeliveries(grid97([row("A97", 97, "confirmed", T0), row("B130", 130, "superseded", T1)]));
    assert.equal(superseded.skipped, 1);
  });

  it("the current payload already queued or in flight is skipped, but other pending rows of the cell are still superseded", () => {
    const plan = planDeliveries(grid97([row("A97", 97, "sending", T1), row("B130", 130, "queued", T0)]));
    assert.equal(plan.skipped, 1);
    assert.deepEqual(plan.supersede, ["B130"]);
    assert.deepEqual(plan.requeue, []);
  });
});

describe("delivery.core — data guards", () => {
  it("does not queue a rate in another currency than the property's, and says so once per product", () => {
    const plan = planDeliveries(
      baseInput({
        kinds: ["rates"],
        propertyCurrency: "EUR",
        rates: [
          { ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-01", price: 100, currency: "USD", occupancyPrices: null },
          { ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-02", price: 120, currency: "USD", occupancyPrices: null }
        ]
      })
    );
    assert.equal(plan.drafts.length, 0);
    assert.equal(plan.byChannel.bk?.queued, 0);
    assert.equal(plan.warnings.length, 1);
    assert.ok(plan.warnings[0]?.includes("2 día(s) en USD"), plan.warnings[0]);
    // Without a property currency (older callers) nothing changes.
    assert.equal(planDeliveries(baseInput({ kinds: ["rates"] })).drafts.length, 2);
  });

  it("does not queue an obp mapping without occupancy prices (a per-room price would reach an occupancy-priced plan)", () => {
    const obp = channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"]]);
    obp.mappings.get(productKey("rt1", "bar"))!.pricingModel = "obp";
    const plan = planDeliveries(baseInput({ kinds: ["rates"], channels: [obp] }));
    // 2026-06-01 has no occupancy prices → warned; 2026-06-02 has {1, 2} → queued.
    assert.equal(plan.drafts.length, 1);
    assert.equal(plan.drafts[0]?.date, "2026-06-02");
    assert.ok(plan.warnings[0]?.includes("obp"), plan.warnings[0]);
  });

  it("a room-level stop sell forces the sent availability to 0, even on an availability-only push", () => {
    const stop = { roomTypeId: "rt1", ratePlanId: "*", channelId: "*", date: "2026-06-01", minStay: null, maxStay: null, minStayThrough: null, closedToArrival: false, closedToDeparture: false, closed: false, stopSell: true, minAdvanceDays: null, maxAdvanceDays: null };
    const plan = planDeliveries(baseInput({ kinds: ["availability"], restrictions: [stop] }));
    assert.equal(plan.drafts.length, 1);
    assert.equal(plan.drafts[0]?.payload.count, 0);
    // A plan-level closure is not a room stop sell: the real count goes out.
    const planLevel = planDeliveries(baseInput({ kinds: ["availability"], restrictions: [{ ...stop, ratePlanId: "bar", stopSell: false, closed: true }] }));
    assert.equal(planLevel.drafts[0]?.payload.count, 5);
  });

  it("assertKnownChannelIds answers the rate-grid 400 UNKNOWN_IDS for a channel of another property", () => {
    assert.doesNotThrow(() => assertKnownChannelIds(undefined, ["a"]));
    assert.doesNotThrow(() => assertKnownChannelIds(["a"], ["a", "b"]));
    assert.throws(
      () => assertKnownChannelIds(["a", "zzz"], ["a"]),
      (err: unknown) => {
        const e = err as { statusCode: number; details?: { code: string; channelIds: string[] } };
        return e.statusCode === 400 && e.details?.code === "UNKNOWN_IDS" && e.details.channelIds.join() === "zzz";
      }
    );
  });
});

describe("delivery.core — cell sync map", () => {
  it("worstStatus ranks rejected > timeout > queued > sending > superseded > sent > confirmed > never", () => {
    assert.equal(worstStatus("confirmed", "rejected"), "rejected");
    assert.equal(worstStatus("queued", "sent"), "queued");
    assert.equal(worstStatus("never", "confirmed"), "confirmed");
    assert.equal(worstStatus("timeout", "queued"), "timeout");
  });

  it("takes the latest rates delivery per cell and folds room-level availability as the worst state", () => {
    const map = buildCellSyncMap(
      [
        { id: "r-old", channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", status: "rejected", lastError: "402", updatedAt: "2026-05-01T10:00:00.000Z" },
        { id: "r-new", channelId: "bk", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", status: "confirmed", lastError: null, updatedAt: "2026-05-02T10:00:00.000Z" },
        { id: "a", channelId: "bk", kind: "availability", roomTypeId: "rt1", ratePlanId: "*", date: "2026-06-01", status: "timeout", lastError: "Timeout", updatedAt: "2026-05-02T09:00:00.000Z" },
        { id: "x", channelId: "ex", kind: "rates", roomTypeId: "rt1", ratePlanId: "bar", date: "2026-06-01", status: "queued", lastError: null, updatedAt: "2026-05-02T09:00:00.000Z" }
      ],
      ["bar", "nr"]
    );
    const cell = map.get("bar|rt1|2026-06-01")!;
    assert.equal(cell.bk?.status, "timeout");
    assert.equal(cell.bk?.deliveryId, "a");
    assert.equal(cell.ex?.status, "queued");
    // The room-level availability also paints the other plan of the room type.
    assert.equal(map.get("nr|rt1|2026-06-01")?.bk?.status, "timeout");
  });
});

describe("delivery.core — cierre: rounding, value hash, scoping", () => {
  it("round2 is the grid's rounding (Number.EPSILON): the amount sent equals the effectivePrice shown", () => {
    assert.equal(round2, gridRound2);
    // 1.005 * 100 = 100.49999… without EPSILON → 1 (wrong); with EPSILON → 1.01.
    assert.equal(round2(1.005), 1.01);
    assert.equal(applyMarkup(1.005, 0), 1.01);
  });

  it("valueHash ignores the mapping codes and tracks every grid value", () => {
    const base = { externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", pricingModel: "per_day", amount: 100, currency: "EUR" };
    assert.equal(valueHash(base), valueHash({ ...base, externalRoomCode: "CX-DBL", externalRateCode: "RP-BAR-DBL" }));
    assert.notEqual(valueHash(base), valueHash({ ...base, amount: 101 }));
    assert.notEqual(valueHash(base), valueHash({ ...base, currency: "USD" }));
    assert.notEqual(valueHash({ externalRoomCode: "BK-DBL", count: 5 }), valueHash({ externalRoomCode: "BK-DBL", count: 4 }));
    assert.notEqual(valueHash({ externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", cta: false, stopSell: false }), valueHash({ externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", cta: true, stopSell: false }));
    assert.notEqual(valueHash(base), payloadHash(base));
  });

  it("filterByIds narrows to the requested ids and leaves the list alone without a filter", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(filterByIds(list, ["c", "a"]), [{ id: "a" }, { id: "c" }]);
    assert.deepEqual(filterByIds(list, undefined), list);
    assert.deepEqual(filterByIds(list, []), list);
    assert.deepEqual(filterByIds(list, ["zzz"]), []);
  });

  it("a scoped plan (one room type, one plan, kinds rates) queues one delivery per channel and date, not the whole window × products", () => {
    const full = planDeliveries(
      baseInput({
        channels: [channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"], ["rt2", "bar", "BK-SUI", "RP-BAR"]])],
        roomTypes: [{ id: "rt1", code: "DBL" }, { id: "rt2", code: "SUI" }],
        rates: [
          { ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-01", price: 100, currency: "EUR", occupancyPrices: null },
          { ratePlanId: "bar", roomTypeId: "rt2", date: "2026-06-01", price: 200, currency: "EUR", occupancyPrices: null }
        ],
        availability: [{ roomTypeId: "rt1", date: "2026-06-01", count: 5 }, { roomTypeId: "rt2", date: "2026-06-01", count: 2 }],
        dates: ["2026-06-01"]
      })
    );
    assert.equal(full.drafts.length, 4); // 2 rates + 2 availability
    const scoped = planDeliveries(
      baseInput({
        channels: [channel("bk", [["rt1", "bar", "BK-DBL", "RP-BAR"], ["rt2", "bar", "BK-SUI", "RP-BAR"]])],
        roomTypes: filterByIds([{ id: "rt1", code: "DBL" }, { id: "rt2", code: "SUI" }], ["rt1"]),
        kinds: ["rates"],
        rates: [{ ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-01", price: 100, currency: "EUR", occupancyPrices: null }],
        availability: [{ roomTypeId: "rt1", date: "2026-06-01", count: 5 }],
        dates: ["2026-06-01"]
      })
    );
    assert.equal(scoped.drafts.length, 1);
    assert.deepEqual(scoped.drafts.map((d) => [d.kind, d.roomTypeId]), [["rates", "rt1"]]);
    assert.deepEqual(scoped.warnings, []);
  });
});

describe("delivery.core — cierre: stale sync state", () => {
  const confirmedRate = (id: string, amount: number, updatedAt: string, channelId = "bk"): SyncMapRow => ({
    id,
    channelId,
    kind: "rates",
    roomTypeId: "rt1",
    ratePlanId: "bar",
    date: "2026-06-01",
    status: "confirmed",
    lastError: null,
    updatedAt,
    valueHash: valueHash({ externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", pricingModel: "per_day", amount, currency: "EUR" })
  });
  const current = (price: number, roomCode = "BK-DBL", rateCode = "RP-BAR") =>
    currentValueHashes(planDeliveries(baseInput({ channels: [channel("bk", [["rt1", "bar", roomCode, rateCode]])], kinds: ["rates"], rates: [{ ratePlanId: "bar", roomTypeId: "rt1", date: "2026-06-01", price, currency: "EUR", occupancyPrices: null }], dates: ["2026-06-01"] })));

  it("a confirmed delivery whose value no longer matches the grid (revert) is `stale`; an identical one stays confirmed", () => {
    const rows = [confirmedRate("d1", 100, "2026-05-02T10:00:00.000Z")];
    assert.equal(buildCellSyncMap(rows, ["bar"], current(100)).get("bar|rt1|2026-06-01")?.bk?.status, "confirmed");
    const stale = buildCellSyncMap(rows, ["bar"], current(97)).get("bar|rt1|2026-06-01")?.bk;
    assert.equal(stale?.status, "stale");
    assert.equal(stale?.deliveryId, "d1");
    assert.equal(stale?.at, "2026-05-02T10:00:00.000Z");
    // Without the current hashes (legacy call) nothing is stale.
    assert.equal(buildCellSyncMap(rows, ["bar"]).get("bar|rt1|2026-06-01")?.bk?.status, "confirmed");
  });

  it("only the NEWEST row of the cell is compared: a re-published value that is queued paints queued, and a remapped code is not stale", () => {
    const rows = [
      confirmedRate("old", 100, "2026-05-02T10:00:00.000Z"),
      { ...confirmedRate("new", 97, "2026-05-03T10:00:00.000Z"), status: "queued" as const, valueHash: null }
    ];
    assert.equal(buildCellSyncMap(rows, ["bar"], current(97)).get("bar|rt1|2026-06-01")?.bk?.status, "queued");
    // Same value, different external codes (product remapped): confirmed, not stale.
    assert.equal(buildCellSyncMap([confirmedRate("d1", 100, "2026-05-02T10:00:00.000Z")], ["bar"], current(100, "CX-DBL", "RP-BAR-DBL")).get("bar|rt1|2026-06-01")?.bk?.status, "confirmed");
    // No current value for the cell (rate deleted / unmapped): left confirmed, nothing to resend.
    assert.equal(buildCellSyncMap([confirmedRate("d1", 100, "2026-05-02T10:00:00.000Z")], ["bar"], new Map()).get("bar|rt1|2026-06-01")?.bk?.status, "confirmed");
    // Only rows with a value hash can be stale (rejected/timeout rows carry none and keep their own state).
    assert.equal(buildCellSyncMap([{ ...confirmedRate("r", 100, "2026-05-02T10:00:00.000Z"), status: "rejected", lastError: "402", valueHash: null }], ["bar"], current(97)).get("bar|rt1|2026-06-01")?.bk?.status, "rejected");
  });

  it("stale ranks worse than confirmed and better than a pending state; room-level availability stale paints every plan", () => {
    assert.equal(worstStatus("confirmed", "stale"), "stale");
    assert.equal(worstStatus("stale", "queued"), "queued");
    assert.equal(worstStatus("stale", "rejected"), "rejected");
    const avail: SyncMapRow = { id: "a", channelId: "bk", kind: "availability", roomTypeId: "rt1", ratePlanId: "*", date: "2026-06-01", status: "confirmed", lastError: null, updatedAt: "2026-05-02T10:00:00.000Z", valueHash: valueHash({ externalRoomCode: "BK-DBL", count: 5 }) };
    const cur = new Map([[deliveryCellKey("bk", "availability", "rt1", "*", "2026-06-01"), valueHash({ externalRoomCode: "BK-DBL", count: 4 })]]);
    const map = buildCellSyncMap([avail], ["bar", "nr"], cur);
    assert.equal(map.get("bar|rt1|2026-06-01")?.bk?.status, "stale");
    assert.equal(map.get("nr|rt1|2026-06-01")?.bk?.status, "stale");
  });
});

describe("delivery.core — cierre: journal pushStatus", () => {
  it("classifies the entry from its deliveries (superseded included)", () => {
    assert.equal(classifyJournalPushStatus({}), null);
    assert.equal(classifyJournalPushStatus({ queued: 3 }), "queued");
    assert.equal(classifyJournalPushStatus({ confirmed: 2, sending: 1 }), "queued");
    assert.equal(classifyJournalPushStatus({ confirmed: 2, timeout: 1, rejected: 1 }), "queued");
    assert.equal(classifyJournalPushStatus({ confirmed: 3 }), "pushed");
    assert.equal(classifyJournalPushStatus({ confirmed: 2, sent: 1 }), "pushed");
    assert.equal(classifyJournalPushStatus({ confirmed: 3, superseded: 2 }), "pushed");
    assert.equal(classifyJournalPushStatus({ confirmed: 2, rejected: 1 }), "partial");
    assert.equal(classifyJournalPushStatus({ rejected: 2 }), "failed");
    assert.equal(classifyJournalPushStatus({ rejected: 2, superseded: 1 }), "failed");
    assert.equal(classifyJournalPushStatus({ superseded: 4 }), "superseded");
  });
});
