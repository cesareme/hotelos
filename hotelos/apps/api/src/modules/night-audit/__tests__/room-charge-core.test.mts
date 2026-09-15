// Unit tests · nightly room-charge core (pure helpers of pms/room-charge.service).
// Run from apps/api with
//   node --import tsx --test src/modules/night-audit/__tests__/room-charge-core.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDayEs, nightsBetween, roomChargeDescription, roomChargeKeyPrefix, splitTotalAcrossNights } from "../../pms/room-charge.service.js";

describe("splitTotalAcrossNights", () => {
  it("3 nights at 100 € → 33,33 · 33,33 · 33,34 (last night takes the cent)", () => {
    assert.deepEqual(splitTotalAcrossNights(100, 3), ["33.33", "33.33", "33.34"]);
  });
  it("exact division and a single night", () => {
    assert.deepEqual(splitTotalAcrossNights("272.00", 2), ["136.00", "136.00"]);
    assert.deepEqual(splitTotalAcrossNights(89.99, 1), ["89.99"]);
  });
  it("never invents cents: Σ parts = total", () => {
    for (const [total, nights] of [[199.99, 7], [0.05, 4], [1234.56, 13]] as const) {
      const parts = splitTotalAcrossNights(total, nights);
      const sum = parts.reduce((s, p) => s + Math.round(Number(p) * 100), 0);
      assert.equal(sum, Math.round(total * 100));
    }
  });
  it("rejects a non-positive night count", () => {
    assert.throws(() => splitTotalAcrossNights(100, 0), /noches/);
  });
});

describe("dates and descriptions", () => {
  it("nightsBetween counts calendar nights (min 1)", () => {
    assert.equal(nightsBetween(new Date("2026-09-14T00:00:00Z"), new Date("2026-09-17T00:00:00Z")), 3);
    assert.equal(nightsBetween(new Date("2026-09-14T00:00:00Z"), new Date("2026-09-14T00:00:00Z")), 1);
  });
  it("Spanish description keyed by business day and reservation code", () => {
    assert.equal(formatDayEs("2026-09-14"), "14/09/2026");
    assert.equal(roomChargeKeyPrefix("2026-09-14", "RES-00034"), "Alojamiento 14/09/2026 · RES-00034");
    assert.equal(roomChargeDescription("2026-09-14", "RES-00034", "Doble Estándar"), "Alojamiento 14/09/2026 · RES-00034 · Doble Estándar");
    assert.ok(roomChargeDescription("2026-09-14", "RES-00034").startsWith(roomChargeKeyPrefix("2026-09-14", "RES-00034")));
  });
});
