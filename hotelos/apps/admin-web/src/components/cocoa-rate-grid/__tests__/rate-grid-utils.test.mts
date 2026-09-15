import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateGridCell, RateGridResponse } from "@hotelos/shared";
import {
  buildBulkPreview,
  buildRows,
  countDraftCellsByChannel,
  diffDraft,
  expandBulkOp,
  extendFillRect,
  fillDirectionTargets,
  fillTargets,
  groupConsecutiveDates,
  groupDiffByTypeAndPlan,
  groupDiffRanges,
  pasteTargets,
  rowCellKey,
  sortRatePlans,
  summarizeDraft
} from "../rate-grid-utils.ts";
import { emptyDraft, draftReducer, initialDraftStore } from "../draft-store.ts";
import { indexCells, snapshotBefore, cellKey } from "../helpers.ts";

const DATES = ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"];

function mkCell(ratePlanId: string, roomTypeId: string, date: string, price: number | null, extra: Partial<RateGridCell> = {}): RateGridCell {
  return {
    ratePlanId,
    roomTypeId,
    date,
    basePrice: price,
    effectivePrice: price,
    currency: "EUR",
    restrictions: {},
    source: "manual",
    sync: { booking: { status: "confirmed" } },
    ...extra
  };
}

function fixture(): RateGridResponse {
  const cells: RateGridCell[] = [];
  for (const rt of ["dbl", "sup"]) {
    for (const d of DATES) {
      cells.push(mkCell("bar", rt, d, rt === "dbl" ? 120 : 150));
      cells.push(
        mkCell("nr", rt, d, rt === "dbl" ? 108 : 135, {
          source: d === "2026-03-12" && rt === "dbl" ? "manual" : "derived",
          derivedFrom: { ratePlanId: "bar", ratePlanCode: "BAR", derivation: { mode: "percent", value: -10 } }
        })
      );
    }
  }
  return {
    propertyId: "prop_123",
    from: DATES[0],
    to: DATES[DATES.length - 1],
    currency: "EUR",
    roomTypes: [
      { id: "sup", code: "SUP", name: "Superior", rooms: 10, sortOrder: 2 },
      { id: "dbl", code: "DBL", name: "Doble", rooms: 20, sortOrder: 1 }
    ],
    ratePlans: [
      { id: "nr", code: "BAR-NR", name: "No reembolsable", ratePlanType: "NR", parentRatePlanId: "bar", derivation: { mode: "percent", value: -10 }, active: true },
      { id: "bar", code: "BAR", name: "Best Available", ratePlanType: "BAR", derivation: { mode: "none", value: 0 }, active: true }
    ],
    channels: [
      { id: "booking", providerCode: "booking_com", name: "Booking.com", channelType: "ota", status: "active", mode: "sandbox", markupPercent: 15, mappedProducts: 4, readyToPush: true },
      { id: "airbnb", providerCode: "airbnb", name: "Airbnb", channelType: "ota", status: "inactive", mode: "stub", markupPercent: 0, mappedProducts: 0, readyToPush: false }
    ],
    cells,
    generatedAt: "2026-03-09T00:00:00Z"
  };
}

describe("rate-grid-utils · rows", () => {
  it("orders BAR first, derived under parent, room types by sortOrder; channel rows only in channels view", () => {
    const res = fixture();
    assert.deepEqual(sortRatePlans(res.ratePlans).map((p) => p.id), ["bar", "nr"]);
    const index = indexCells(res.cells);
    const rows = buildRows(res, { view: "rates", collapsed: new Set(), showAvailability: true, index, firstDate: DATES[0] });
    assert.deepEqual(rows.map((r) => r.id), ["group:dbl", "avail:dbl", "plan:dbl:bar", "plan:dbl:nr", "group:sup", "avail:sup", "plan:sup:bar", "plan:sup:nr"]);
    const collapsed = buildRows(res, { view: "rates", collapsed: new Set(["dbl"]), showAvailability: false, index, firstDate: DATES[0] });
    assert.deepEqual(collapsed.map((r) => r.id), ["group:dbl", "group:sup", "plan:sup:bar", "plan:sup:nr"]);
    const channels = buildRows(res, { view: "channels", collapsed: new Set(), showAvailability: false, index, firstDate: DATES[0] });
    assert.ok(channels.some((r) => r.id === "channel:dbl:bar:booking"));
    assert.ok(!channels.some((r) => r.id === "channel:dbl:bar:airbnb"));
    assert.equal(rowCellKey(rows[0], DATES[0]), null);
    assert.equal(rowCellKey(rows[1], DATES[0]), cellKey("*", "dbl", DATES[0]));
    assert.equal(rowCellKey(channels.find((r) => r.id === "channel:dbl:bar:booking")!, DATES[0]), "bar|dbl|2026-03-09|booking");
  });
});

describe("rate-grid-utils · geometry", () => {
  it("fills by tiling the source pattern", () => {
    const t = fillTargets({ r0: 0, r1: 0, c0: 0, c1: 1 }, { r0: 0, r1: 0, c0: 0, c1: 4 });
    assert.deepEqual(t.map((x) => [x.from.col, x.to.col]), [[0, 2], [1, 3], [0, 4]]);
    assert.deepEqual(extendFillRect({ r0: 1, r1: 1, c0: 2, c1: 2 }, { row: 1, col: 6 }), { r0: 1, r1: 1, c0: 2, c1: 6 });
    assert.deepEqual(extendFillRect({ r0: 1, r1: 1, c0: 2, c1: 2 }, { row: 4, col: 3 }), { r0: 1, r1: 4, c0: 2, c1: 2 });
  });
  it("fills right/down from the first column/row", () => {
    const right = fillDirectionTargets({ r0: 0, r1: 1, c0: 0, c1: 2 }, "right");
    assert.equal(right.length, 4);
    assert.ok(right.every((x) => x.from.col === 0));
    const down = fillDirectionTargets({ r0: 0, r1: 2, c0: 0, c1: 1 }, "down");
    assert.equal(down.length, 4);
    assert.ok(down.every((x) => x.from.row === 0));
  });
  it("pastes relatively and clips to bounds", () => {
    const t = pasteTargets([{ row: 3, col: 3 }, { row: 3, col: 4 }], { row: 0, col: 6 }, 10, 7);
    assert.deepEqual(t.map((x) => x.to), [{ row: 0, col: 6 }]);
  });
});

describe("rate-grid-utils · expandBulkOp", () => {
  it("expands scope × weekdays, re-materialises derived children and reports manual conflicts", () => {
    const res = fixture();
    const out = expandBulkOp({ scope: { from: DATES[0], to: DATES[6], weekdays: [5, 6], roomTypeIds: ["dbl"], ratePlanIds: ["bar"] }, price: { mode: "percent", value: 10 } }, res, null);
    // Fri 13 + Sat 14 on DBL BAR → 2 parent patches + 2 derived children.
    const parents = out.patches.filter((p) => !p.derived);
    const children = out.patches.filter((p) => p.derived);
    assert.equal(parents.length, 2);
    assert.equal(children.length, 2);
    assert.equal(parents[0].patch.price, 132);
    assert.equal(children[0].patch.price, 118.8);
    assert.equal(out.derivedRecalculated, 2);
    assert.deepEqual(out.conflicts, []);
  });
  it("skips manual overrides on derived plans unless overwriteManual", () => {
    const res = fixture();
    const op = { scope: { from: "2026-03-12", to: "2026-03-12", roomTypeIds: ["dbl"], ratePlanIds: ["bar"] }, price: { mode: "set" as const, value: 200 } };
    const respect = expandBulkOp(op, res, null);
    assert.deepEqual(respect.conflicts, ["nr|dbl|2026-03-12"]);
    assert.equal(respect.patches.length, 1);
    const overwrite = expandBulkOp(op, res, null, true);
    assert.equal(overwrite.conflicts.length, 0);
    assert.equal(overwrite.patches.length, 2);
  });
  it("applies floor / ceiling / copyFrom / restrictions and drops no-ops", () => {
    const res = fixture();
    const floor = expandBulkOp({ scope: { from: DATES[0], to: DATES[1], ratePlanIds: ["bar"] }, price: { mode: "floor", value: 130 } }, res, null);
    // DBL (120) rises to 130 on 2 days; SUP (150) untouched.
    assert.deepEqual(floor.patches.filter((p) => !p.derived).map((p) => [p.patch.roomTypeId, p.patch.price]), [["dbl", 130], ["dbl", 130]]);
    const ceiling = expandBulkOp({ scope: { from: DATES[0], to: DATES[0], ratePlanIds: ["bar"] }, price: { mode: "ceiling", value: 140 } }, res, null);
    assert.deepEqual(ceiling.patches.filter((p) => !p.derived).map((p) => [p.patch.roomTypeId, p.patch.price]), [["sup", 140]]);
    const restr = expandBulkOp({ scope: { from: DATES[0], to: DATES[0], ratePlanIds: ["bar"] }, restrictions: { minLos: 2, cta: true } }, res, null);
    assert.equal(restr.patches.length, 2);
    assert.deepEqual(restr.patches[0].patch.restrictions, { minLos: 2, cta: true });
    assert.equal(restr.derivedRecalculated, 0);
    const copy = expandBulkOp({ scope: { from: DATES[1], to: DATES[1], roomTypeIds: ["dbl"], ratePlanIds: ["bar"] }, price: { mode: "copyFrom", fromDate: DATES[0] } }, res, null);
    assert.equal(copy.patches.length, 0); // same price → no-op
  });
  it("builds a preview with headline and sample", () => {
    const res = fixture();
    const out = expandBulkOp({ scope: { from: DATES[0], to: DATES[2], ratePlanIds: ["bar"] }, price: { mode: "percent", value: 10 } }, res, null);
    const preview = buildBulkPreview(out, res, 5);
    assert.equal(preview.affectedCells, 6);
    assert.equal(preview.roomTypes, 2);
    assert.equal(preview.days, 3);
    assert.equal(preview.derivedRecalculated, 6);
    assert.equal(preview.sample.length, 5);
    assert.match(preview.headline ?? "", /^BAR 120 €→132 € \(\+10 %\)$/);
  });
});

describe("rate-grid-utils · diff & ranges", () => {
  it("groups consecutive dates", () => {
    assert.deepEqual(groupConsecutiveDates(["2026-03-12", "2026-03-10", "2026-03-11", "2026-03-14"]), [
      { from: "2026-03-10", to: "2026-03-12", count: 3 },
      { from: "2026-03-14", to: "2026-03-14", count: 1 }
    ]);
  });
  it("diffs a draft and groups by type › plan › consecutive range with same before→after", () => {
    const res = fixture();
    const index = indexCells(res.cells);
    let store = initialDraftStore(emptyDraft());
    for (const d of ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-13"]) {
      const key = cellKey("bar", "dbl", d);
      store = draftReducer(store, { type: "cell", patch: { ratePlanId: "bar", roomTypeId: "dbl", date: d, price: 130 }, before: snapshotBefore(index.get(key)), now: "2026-03-09T10:00:00Z" });
    }
    store = draftReducer(store, { type: "cell", patch: { ratePlanId: "bar", roomTypeId: "sup", date: "2026-03-09", restrictions: { minLos: 2 } }, before: snapshotBefore(index.get(cellKey("bar", "sup", "2026-03-09"))), now: "2026-03-09T10:00:00Z" });
    const items = diffDraft(store.present, "ana@hotel.es");
    assert.equal(items.length, 5);
    const ranges = groupDiffRanges(items);
    assert.equal(ranges.length, 3);
    const dbl = ranges.filter((r) => r.roomTypeId === "dbl");
    assert.deepEqual(dbl.map((r) => [r.from, r.to, r.count]), [["2026-03-09", "2026-03-11", 3], ["2026-03-13", "2026-03-13", 1]]);
    assert.equal(dbl[0].before, 120);
    assert.equal(dbl[0].after, 130);
    assert.equal(dbl[0].who, "ana@hotel.es");
    const groups = groupDiffByTypeAndPlan(items, res.roomTypes, res.ratePlans);
    assert.deepEqual(groups.map((g) => g.roomTypeName), ["Doble", "Superior"]);
    assert.equal(groups[0].plans[0].ratePlanCode, "BAR");
    assert.equal(groups[0].cellCount, 4);
    const summary = summarizeDraft(store.present);
    assert.deepEqual(summary, { cells: 5, roomTypes: 2, ratePlans: 1, days: 4, from: "2026-03-09", to: "2026-03-13" });
    const byChannel = countDraftCellsByChannel(store.present, res);
    assert.deepEqual(byChannel, { booking: 5, airbnb: 0 });
  });
});
