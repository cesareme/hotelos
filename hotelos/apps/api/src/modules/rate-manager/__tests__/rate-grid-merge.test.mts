// Unit tests · read-side merge helpers (pure). Run from apps/api with
//   node --import tsx --test src/modules/rate-manager/__tests__/rate-grid-merge.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_RESTRICTION_COLUMNS,
  columnsToRestrictions,
  effectivePrice,
  isEmptyRestrictionRow,
  mergeCellSync,
  mergeRestrictionPatch,
  resolveRestrictions,
  summarizeSync,
  type RestrictionColumns
} from "../rate-grid.merge.js";
import { cellKey } from "../bulk-ops.js";

const row = (partial: Partial<RestrictionColumns>): RestrictionColumns => ({ ...EMPTY_RESTRICTION_COLUMNS, ...partial });

describe("resolveRestrictions (precedence channel > plan > *)", () => {
  it("numeric: the most specific layer with a value wins", () => {
    const r = resolveRestrictions({
      star: row({ minStay: 1, maxStay: 10 }),
      plan: row({ minStay: 2 }),
      channel: row({ minStay: 3 })
    });
    assert.equal(r.minLos, 3);
    assert.equal(r.maxLos, 10); // only "*" carries it
  });
  it("numeric: a null on the channel row falls through to the plan row", () => {
    const r = resolveRestrictions({ plan: row({ minStay: 2 }), channel: row({ minStay: null, maxStay: 4 }) });
    assert.deepEqual(r, { minLos: 2, maxLos: 4 });
  });
  it("channel+* sits between channel+plan and plan", () => {
    const r = resolveRestrictions({ plan: row({ minAdvanceDays: 1 }), channelStar: row({ minAdvanceDays: 5 }) });
    assert.equal(r.minAdvanceDays, 5);
    const r2 = resolveRestrictions({ plan: row({ minAdvanceDays: 1 }), channelStar: row({ minAdvanceDays: 5 }), channel: row({ minAdvanceDays: 9 }) });
    assert.equal(r2.minAdvanceDays, 9);
  });
  it("flags combine with OR across layers (closed at plan level stays closed on the channel)", () => {
    const r = resolveRestrictions({ star: row({ stopSell: true }), plan: row({ closed: true }), channel: row({ closedToArrival: true }) });
    assert.deepEqual(r, { cta: true, closed: true, stopSell: true });
  });
  it("closed is distinct from stopSell", () => {
    assert.deepEqual(resolveRestrictions({ plan: row({ closed: true }) }), { closed: true });
    assert.deepEqual(resolveRestrictions({ star: row({ stopSell: true }) }), { stopSell: true });
  });
  it("no rows → empty object; cells without RateDay still get restrictions", () => {
    assert.deepEqual(resolveRestrictions({}), {});
  });
});

describe("mergeRestrictionPatch (tri-state)", () => {
  it("undefined keeps, null clears, value sets; reports changed keys", () => {
    const { next, changed } = mergeRestrictionPatch(row({ minStay: 2, closedToArrival: true, maxStay: 7 }), { minLos: null, cta: undefined, ctd: true, maxLos: 7 });
    assert.equal(next.minStay, null);
    assert.equal(next.closedToArrival, true);
    assert.equal(next.closedToDeparture, true);
    assert.deepEqual(changed, ["minLos", "ctd"]);
  });
  it("null on a flag clears it", () => {
    const { next, changed } = mergeRestrictionPatch(row({ closed: true }), { closed: null });
    assert.equal(next.closed, false);
    assert.deepEqual(changed, ["closed"]);
    assert.equal(isEmptyRestrictionRow(next), true);
  });
  it("columnsToRestrictions emits only set values", () => {
    assert.deepEqual(columnsToRestrictions(row({ minStay: 2, closed: false, minAdvanceDays: 0 })), { minLos: 2, minAdvanceDays: 0 });
  });
});

describe("effectivePrice", () => {
  it("base × (1 + markup/100) rounded to cents", () => {
    assert.equal(effectivePrice(100, 15), 115);
    assert.equal(effectivePrice(89.99, 12.5), 101.24);
    assert.equal(effectivePrice(100, 0), 100);
    assert.equal(effectivePrice(100, undefined), 100);
  });
  it("no RateDay → null (never 0)", () => {
    assert.equal(effectivePrice(null, 15), null);
  });
});

describe("mergeCellSync", () => {
  const base = { propertyId: "p", roomTypeId: "rt", ratePlanId: "bar", kind: "rates" };
  it("keeps the latest delivery per (channel, cell) and maps errors", () => {
    const map = mergeCellSync([
      { ...base, id: "d1", channelId: "ch1", date: "2026-10-05", status: "sent", updatedAt: "2026-10-01T10:00:00Z", lastError: null },
      { ...base, id: "d2", channelId: "ch1", date: "2026-10-05", status: "rejected", updatedAt: "2026-10-01T11:00:00Z", lastError: "Invalid rate" },
      { ...base, id: "d0", channelId: "ch1", date: "2026-10-05", status: "superseded", updatedAt: "2026-10-01T09:00:00Z", lastError: null },
      { ...base, id: "d3", channelId: "ch2", date: new Date("2026-10-05T00:00:00Z"), status: "confirmed", updatedAt: new Date("2026-10-01T12:00:00Z"), lastError: null }
    ]);
    const key = cellKey("bar", "rt", "2026-10-05");
    assert.deepEqual(map[key]!.ch1, { status: "rejected", at: "2026-10-01T11:00:00.000Z", error: "Invalid rate", deliveryId: "d2" });
    assert.equal(map[key]!.ch2.status, "confirmed");
    assert.equal(map[key]!.ch2.error, null);
  });
  it("ignores availability (room-level) rows and prefers rates over restrictions", () => {
    const map = mergeCellSync([
      { ...base, id: "a1", channelId: "ch1", ratePlanId: "*", kind: "availability", date: "2026-10-05", status: "queued", updatedAt: "2026-10-02T00:00:00Z" },
      { ...base, id: "r1", channelId: "ch1", kind: "restrictions", date: "2026-10-05", status: "queued", updatedAt: "2026-10-03T00:00:00Z" },
      { ...base, id: "p1", channelId: "ch1", kind: "rates", date: "2026-10-05", status: "sent", updatedAt: "2026-10-01T00:00:00Z" }
    ]);
    const key = cellKey("bar", "rt", "2026-10-05");
    assert.equal(map[key]!.ch1.deliveryId, "p1");
    assert.equal(Object.keys(map).length, 1);
  });
  it("unknown status → never; summary counts per channel and status", () => {
    const map = mergeCellSync([
      { ...base, id: "x", channelId: "ch1", date: "2026-10-05", status: "weird", updatedAt: "2026-10-01T00:00:00Z" },
      { ...base, id: "y", channelId: "ch1", date: "2026-10-06", status: "sent", updatedAt: "2026-10-01T00:00:00Z" },
      { ...base, id: "z", channelId: "ch1", date: "2026-10-07", status: "sent", updatedAt: "2026-10-01T00:00:00Z" }
    ]);
    assert.deepEqual(summarizeSync(map), { ch1: { never: 1, sent: 2 } });
  });
});
