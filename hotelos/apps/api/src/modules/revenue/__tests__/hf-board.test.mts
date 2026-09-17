// Unit tests for the History & Forecast board's pure helpers (pilot
// verification R1/R3). No database. Run from apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/hf-board.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOARD_MAX_DAYS, parseBoardWindow, pmsForecastMetricNote, resolveForecastDayMetrics } from "../hf-board.service.js";
import { dayUtc } from "../actuals.js";
import { BadRequestError } from "../../../lib/http-error.js";

describe("resolveForecastDayMetrics — imported PMS forecast keeps its own ADR/occupancy bases (R3)", () => {
  it("exposes expectedAdr / expectedOccupancy of a top-level row as-is (Los Tilos 2026-09-14)", () => {
    // PMS row: 47 rooms, 3 547,56 €, ADR 78,83 (paid rooms), occ 51,14 % (92 − OOO).
    const m = resolveForecastDayMetrics({ rooms: 47, revenue: 3547.56, totalRooms: 92, topLevel: true, expectedAdr: 78.83, expectedOccupancy: 51.14 });
    assert.deepEqual(m, { fcAdr: 78.83, fcOccPct: 51.14, importedAdr: true, importedOcc: true });
    // Recomputing would have given 75,48 / 51,09 — the figures the verification flagged.
    assert.equal(Math.round((3547.56 / 47) * 100) / 100, 75.48);
    assert.equal(Math.round((47 / 92) * 10000) / 100, 51.09);
  });

  it("recomputes from rooms/revenue when the top-level row has NULL expectedAdr/expectedOccupancy", () => {
    const m = resolveForecastDayMetrics({ rooms: 47, revenue: 3547.56, totalRooms: 92, topLevel: true, expectedAdr: null, expectedOccupancy: null });
    assert.deepEqual(m, { fcAdr: 75.48, fcOccPct: 51.09, importedAdr: false, importedOcc: false });
  });

  it("recomputes for per-room-type aggregates even when the rows carry an ADR (their sum is not a day figure)", () => {
    const m = resolveForecastDayMetrics({ rooms: 60, revenue: 6000, totalRooms: 120, topLevel: false, expectedAdr: 95, expectedOccupancy: 80 });
    assert.deepEqual(m, { fcAdr: 100, fcOccPct: 50, importedAdr: false, importedOcc: false });
  });

  it("never invents an ADR when revenue is unknown or there are no rooms", () => {
    assert.equal(resolveForecastDayMetrics({ rooms: 10, revenue: null, totalRooms: 92, topLevel: false, expectedAdr: null, expectedOccupancy: null }).fcAdr, null);
    assert.equal(resolveForecastDayMetrics({ rooms: 0, revenue: 0, totalRooms: 92, topLevel: true, expectedAdr: null, expectedOccupancy: null }).fcAdr, null);
    assert.equal(resolveForecastDayMetrics({ rooms: 5, revenue: 500, totalRooms: 0, topLevel: false, expectedAdr: null, expectedOccupancy: null }).fcOccPct, null);
  });

  it("mixes: imported ADR with recomputed occupancy when only one field is present", () => {
    const m = resolveForecastDayMetrics({ rooms: 46, revenue: 3000, totalRooms: 92, topLevel: true, expectedAdr: 78.83, expectedOccupancy: null });
    assert.deepEqual(m, { fcAdr: 78.83, fcOccPct: 50, importedAdr: true, importedOcc: false });
  });
});

describe("pmsForecastMetricNote", () => {
  it("states both bases with the property's room count", () => {
    assert.equal(
      pmsForecastMetricNote(92),
      "Previsión importada del PMS: ADR sobre habitaciones pagadas y ocupación sobre habitaciones disponibles (92 − OOO); los subtotales de ehotelOS usan 92"
    );
  });
});

describe("parseBoardWindow — R1 at the board boundary", () => {
  const today = dayUtc("2026-09-14");
  it("defaults to today−7 .. today+90", () => {
    assert.deepEqual(parseBoardWindow({ today }), { from: "2026-09-07", to: "2026-12-13", days: 98 });
  });
  it("rejects 2026-13-99 / abc with a Spanish 400 instead of an Invalid Date 500", () => {
    assert.throws(
      () => parseBoardWindow({ from: "2026-13-99", to: "abc", today }),
      (e: unknown) => e instanceof BadRequestError && e.message === "from debe ser una fecha YYYY-MM-DD válida"
    );
  });
  it("caps the window at BOARD_MAX_DAYS (190)", () => {
    assert.equal(BOARD_MAX_DAYS, 190);
    assert.equal(parseBoardWindow({ from: "2026-03-01", to: "2026-09-06", today }).days, 190);
    assert.throws(
      () => parseBoardWindow({ from: "2026-03-01", to: "2026-09-07", today }),
      (e: unknown) => e instanceof BadRequestError && e.message === "la ventana máxima del board es 190 días (pedidos 191)"
    );
  });
});
