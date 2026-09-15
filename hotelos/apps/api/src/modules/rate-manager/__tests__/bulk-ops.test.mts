// Unit tests · bulk op expansion (pure). Run from apps/api with
//   node --import tsx --test src/modules/rate-manager/__tests__/bulk-ops.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateGridBulkOp } from "@hotelos/shared";
import { cellKey, computePriceOp, enumerateDates, expandBulkOps, isRealIsoDate, isoWeekday, type BulkGridSnapshot } from "../bulk-ops.js";

const BAR = "plan_bar";
const NR = "plan_nr";
const DBL = "rt_dbl";
const SUP = "rt_sup";

function grid(overrides: Partial<BulkGridSnapshot> = {}): BulkGridSnapshot {
  const cells = new Map<string, { basePrice: number | null; source: "manual" | "derived"; manuallyOverridden: boolean }>();
  // BAR/DBL priced Mon 2026-10-05 … Sun 2026-10-11 = 100..106; BAR/SUP only on 2026-10-05 (150).
  const dates = enumerateDates("2026-10-05", "2026-10-11");
  dates.forEach((d, i) => cells.set(cellKey(BAR, DBL, d), { basePrice: 100 + i, source: "manual", manuallyOverridden: false }));
  cells.set(cellKey(BAR, SUP, "2026-10-05"), { basePrice: 150, source: "manual", manuallyOverridden: false });
  return {
    roomTypeIds: [DBL, SUP],
    ratePlanIds: [BAR, NR],
    derivedPlanIds: new Set([NR]),
    channelIds: ["ch_booking"],
    cells,
    ...overrides
  };
}

describe("date helpers", () => {
  it("isRealIsoDate rejects 2026-13-99 and 2026-02-30", () => {
    assert.equal(isRealIsoDate("2026-13-99"), false);
    assert.equal(isRealIsoDate("2026-02-30"), false);
    assert.equal(isRealIsoDate("2026-02-28"), true);
    assert.equal(isRealIsoDate("2026-2-8"), false);
  });
  it("isoWeekday: 2026-10-05 is a Monday (1), 2026-10-11 a Sunday (7)", () => {
    assert.equal(isoWeekday("2026-10-05"), 1);
    assert.equal(isoWeekday("2026-10-11"), 7);
  });
});

describe("expandBulkOps", () => {
  it("range + weekdays + room types + plans → one patch per cell", () => {
    const ops: RateGridBulkOp[] = [
      { scope: { from: "2026-10-05", to: "2026-10-11", weekdays: [5, 6], roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "percent", value: 10 } }
    ];
    const out = expandBulkOps(ops, grid());
    assert.equal(out.patches.length, 2);
    assert.deepEqual(
      out.patches.map((p) => [p.date, p.price]),
      [
        ["2026-10-09", 114.4], // Fri: 104 × 1.1
        ["2026-10-10", 115.5] // Sat: 105 × 1.1
      ]
    );
    assert.equal(out.skipped.length, 0);
    assert.equal(out.warnings.length, 0);
  });

  it("percent on a cell without base price is skipped (never a 0 € rate)", () => {
    const out = expandBulkOps([{ scope: { from: "2026-10-06", to: "2026-10-06", roomTypeIds: [SUP], ratePlanIds: [BAR] }, price: { mode: "percent", value: 10 } }], grid());
    assert.equal(out.patches.length, 0);
    assert.deepEqual(out.skipped, [{ ratePlanId: BAR, roomTypeId: SUP, date: "2026-10-06", reason: "sin tarifa base" }]);
  });

  it("set + amount chain on the running value", () => {
    const out = expandBulkOps(
      [
        { scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "set", value: 200 } },
        { scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "amount", value: -20.5 } }
      ],
      grid()
    );
    assert.equal(out.patches.length, 1);
    assert.equal(out.patches[0]!.price, 179.5);
  });

  it("copyFrom copies the source day's price; missing source → skipped", () => {
    const out = expandBulkOps(
      [{ scope: { from: "2026-10-06", to: "2026-10-07", roomTypeIds: [DBL, SUP], ratePlanIds: [BAR] }, price: { mode: "copyFrom", fromDate: "2026-10-05" } }],
      grid()
    );
    const byKey = new Map(out.patches.map((p) => [cellKey(p.ratePlanId, p.roomTypeId, p.date), p.price]));
    assert.equal(byKey.get(cellKey(BAR, DBL, "2026-10-06")), 100);
    assert.equal(byKey.get(cellKey(BAR, DBL, "2026-10-07")), 100);
    assert.equal(byKey.get(cellKey(BAR, SUP, "2026-10-06")), 150);
    assert.equal(byKey.get(cellKey(BAR, SUP, "2026-10-07")), 150);
    const out2 = expandBulkOps([{ scope: { from: "2026-10-06", to: "2026-10-06", roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "copyFrom", fromDate: "2026-12-24" } }], grid());
    assert.equal(out2.patches.length, 0);
    assert.equal(out2.skipped[0]?.reason, "sin tarifa en 2026-12-24");
  });

  it("floor raises below the value, ceiling caps above it, both leave the rest untouched", () => {
    const floor = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-07", roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "floor", value: 101.5 } }], grid());
    assert.deepEqual(floor.patches.map((p) => p.price), [101.5, 101.5, 102]);
    const ceiling = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-07", roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "ceiling", value: 101 } }], grid());
    assert.deepEqual(ceiling.patches.map((p) => p.price), [100, 101, 101]);
  });

  it("restrictions tri-state: null clears, value sets, later op merges per key", () => {
    const out = expandBulkOps(
      [
        { scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [BAR] }, restrictions: { minLos: 2, cta: true } },
        { scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [BAR] }, restrictions: { minLos: null } }
      ],
      grid()
    );
    assert.equal(out.patches.length, 1);
    assert.deepEqual(out.patches[0]!.restrictions, { minLos: null, cta: true });
    assert.equal(out.patches[0]!.price, undefined);
  });

  it("channel scope: restrictions get a channelId patch; a channel price is reported, not written", () => {
    const out = expandBulkOps(
      [{ scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [BAR], channelIds: ["ch_booking"] }, price: { mode: "set", value: 99 }, restrictions: { closed: true } }],
      grid()
    );
    assert.equal(out.patches.length, 1);
    assert.equal(out.patches[0]!.channelId, "ch_booking");
    assert.deepEqual(out.patches[0]!.restrictions, { closed: true });
    assert.equal(out.patches[0]!.price, undefined);
    assert.match(out.skipped[0]!.reason, /precio por canal/);
  });

  it("available fans out per room type and date (channel-independent)", () => {
    const out = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-06", roomTypeIds: [SUP], ratePlanIds: [BAR] }, available: 3 }], grid());
    assert.deepEqual(out.patches.map((p) => [p.roomTypeId, p.date, p.available]), [[SUP, "2026-10-05", 3], [SUP, "2026-10-06", 3]]);
  });

  it("unknown ids are ignored with a warning; an empty op is ignored", () => {
    const out = expandBulkOps(
      [
        { scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: ["rt_ghost"], ratePlanIds: [BAR] }, price: { mode: "set", value: 1 } },
        { scope: { from: "2026-10-05", to: "2026-10-05" } }
      ],
      grid()
    );
    assert.equal(out.patches.length, 0);
    assert.equal(out.warnings.length, 2);
    assert.match(out.warnings[0]!, /rt_ghost/);
    assert.deepEqual(out.inactivePlanIds, []);
    assert.equal(out.allScopesInactive, false);
  });

  // api-live-final#2: a soft-deleted plan of the property is not «desconocido».
  describe("inactive plans in scope", () => {
    const OLD = "plan_old";
    const withInactive = () => grid({ inactivePlans: new Map([[OLD, "ALF-TMP"]]) });

    it("an op that names only an inactive plan expands to nothing, warns «plan tarifario inactivo <código>» and flags allScopesInactive", () => {
      const out = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [OLD] }, price: { mode: "set", value: 100 } }], withInactive());
      assert.equal(out.patches.length, 0);
      assert.deepEqual(out.warnings, ["op[0]: plan tarifario inactivo ALF-TMP: reactívalo para editar sus celdas"]);
      assert.deepEqual(out.inactivePlanIds, [OLD]);
      assert.equal(out.allScopesInactive, true);
    });

    it("next to an active plan the inactive one is a warning only: the active cells expand and allScopesInactive is false", () => {
      const out = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [OLD, BAR] }, price: { mode: "percent", value: 10 } }], withInactive());
      assert.deepEqual(out.patches.map((p) => [p.ratePlanId, p.price]), [[BAR, 110]]);
      assert.deepEqual(out.warnings, ["op[0]: plan tarifario inactivo ALF-TMP: reactívalo para editar sus celdas"]);
      assert.deepEqual(out.inactivePlanIds, [OLD]);
      assert.equal(out.allScopesInactive, false);
    });

    it("inactive + unknown in the same scope: two different warnings, allScopesInactive false (NO_CELLS stays the answer)", () => {
      const out = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [OLD, "plan_ghost"] }, price: { mode: "set", value: 100 } }], withInactive());
      assert.equal(out.patches.length, 0);
      assert.deepEqual(out.warnings, ["op[0]: plan tarifario inactivo ALF-TMP: reactívalo para editar sus celdas", "op[0]: plan tarifario desconocido plan_ghost"]);
      assert.deepEqual(out.inactivePlanIds, [OLD]);
      assert.equal(out.allScopesInactive, false);
    });

    it("several ops: allScopesInactive only when EVERY op names inactive plans explicitly; ids are listed once", () => {
      const onlyInactive = expandBulkOps(
        [
          { scope: { from: "2026-10-05", to: "2026-10-05", ratePlanIds: [OLD] }, price: { mode: "set", value: 100 } },
          { scope: { from: "2026-10-06", to: "2026-10-06", ratePlanIds: [OLD] }, restrictions: { minLos: 2 } }
        ],
        withInactive()
      );
      assert.equal(onlyInactive.allScopesInactive, true);
      assert.deepEqual(onlyInactive.inactivePlanIds, [OLD]);
      assert.equal(onlyInactive.warnings.length, 2);
      const mixed = expandBulkOps(
        [
          { scope: { from: "2026-10-05", to: "2026-10-05", ratePlanIds: [OLD] }, price: { mode: "set", value: 100 } },
          { scope: { from: "2026-10-06", to: "2026-10-06" }, price: { mode: "percent", value: 5 } }
        ],
        withInactive()
      );
      assert.equal(mixed.allScopesInactive, false, "a scope without ratePlanIds means every ACTIVE plan");
      assert.ok(mixed.patches.length > 0);
    });

    it("without an inactivePlans map the snapshot behaves as before: the id is «desconocido»", () => {
      const out = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-05", ratePlanIds: [OLD] }, price: { mode: "set", value: 100 } }], grid());
      assert.deepEqual(out.warnings, [`op[0]: plan tarifario desconocido ${OLD}`]);
      assert.deepEqual(out.inactivePlanIds, []);
      assert.equal(out.allScopesInactive, false);
    });
  });

  it("respectManualOverrides=false is carried on the patch", () => {
    const out = expandBulkOps([{ scope: { from: "2026-10-05", to: "2026-10-05", roomTypeIds: [DBL], ratePlanIds: [BAR] }, price: { mode: "set", value: 120 }, respectManualOverrides: false }], grid());
    assert.equal(out.patches[0]!.respectManualOverrides, false);
  });

  it("computePriceOp never returns a negative price", () => {
    assert.equal(computePriceOp({ mode: "amount", value: -500 }, 100, null), 0);
    assert.equal(computePriceOp({ mode: "set", value: -5 }, null, null), 0);
  });
});
