// Unit tests for the period-metrics aggregation (Comparison tool). Pure core
// only — no database. Run from apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/comparison.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregatePeriodMetrics } from "../comparison.service.js";
import { dayUtc, realizeDays, type SnapshotRow } from "../actuals.js";

const TOTAL_ROOMS = 92;

function snap(date: string, totalOcc: number, houseUse: number, revenue: number): SnapshotRow {
  const paid = totalOcc - houseUse;
  return {
    snapshotDate: dayUtc(date),
    totalOcc,
    houseUseRooms: houseUse,
    arrivalRooms: 0,
    departureRooms: 0,
    noShowRooms: 0,
    oooRooms: 0,
    roomRevenue: revenue,
    totalRevenue: revenue,
    adr: paid > 0 ? revenue / paid : null, // the PMS's own ADR (paid-room base)
    revpar: revenue / TOTAL_ROOMS,
    occupancyPercent: (totalOcc / TOTAL_ROOMS) * 100,
    goppar: null
  };
}

describe("aggregatePeriodMetrics — ADR on paid rooms, roomsSold on totalOcc (R4)", () => {
  it("reproduces the PMS August-2026 figures: 1728 occ / 80 house use / 172 338,23 € → ADR 104,57 on 1648 paid rooms", () => {
    // 31 closes whose sums equal the imported Faranda Los Tilos month
    // (revenue_daily_snapshots top-level, Aug-2026): 30 × (56 occ, 2 HU,
    // 5 560,00 €) + 1 × (48 occ, 20 HU, 5 538,23 €).
    const snapshots: SnapshotRow[] = [];
    for (let d = 1; d <= 30; d++) snapshots.push(snap(`2026-08-${String(d).padStart(2, "0")}`, 56, 2, 5560));
    snapshots.push(snap("2026-08-31", 48, 20, 5538.23)); // 1680+48 = 1728 occ; 60+20 = 80 HU; 166 800 + 5 538,23 = 172 338,23
    const win = realizeDays({ from: dayUtc("2026-08-01"), to: dayUtc("2026-08-31"), today: dayUtc("2026-09-14"), totalRooms: TOTAL_ROOMS, snapshots, reservations: [] });
    const m = aggregatePeriodMetrics(win.days.values());
    assert.equal(m.roomsSold, 1728);
    assert.equal(m.houseUseRooms, 80);
    assert.equal(m.paidRooms, 1648);
    assert.equal(m.roomRevenue, 172338.23);
    assert.equal(m.adr, 104.57); // 172 338,23 / 1648 — NOT 99,73 (÷ totalOcc)
  });

  it("keeps ADR = revenue / rooms on reservation-fallback days (no house use known) and 0 without paid rooms", () => {
    const win = realizeDays({
      from: dayUtc("2026-09-10"),
      to: dayUtc("2026-09-11"),
      today: dayUtc("2026-09-14"),
      totalRooms: TOTAL_ROOMS,
      snapshots: [],
      reservations: [
        { arrivalDate: dayUtc("2026-09-10"), departureDate: dayUtc("2026-09-12"), roomsCount: 2, totalAmount: 400, adults: 2, children: 0, status: "checked_out" }
      ]
    });
    const m = aggregatePeriodMetrics(win.days.values());
    assert.equal(m.roomsSold, 4);
    assert.equal(m.paidRooms, 4);
    assert.equal(m.houseUseRooms, 0);
    assert.equal(m.adr, 100);
    const empty = aggregatePeriodMetrics([]);
    assert.equal(empty.adr, 0);
    assert.equal(empty.paidRooms, 0);
    const onlyHouseUse = aggregatePeriodMetrics(realizeDays({ from: dayUtc("2026-09-10"), to: dayUtc("2026-09-10"), today: dayUtc("2026-09-14"), totalRooms: TOTAL_ROOMS, snapshots: [snap("2026-09-10", 3, 3, 0)], reservations: [] }).days.values());
    assert.equal(onlyHouseUse.roomsSold, 3);
    assert.equal(onlyHouseUse.paidRooms, 0);
    assert.equal(onlyHouseUse.adr, 0); // no paying room → 0, never Infinity/NaN
  });
});
