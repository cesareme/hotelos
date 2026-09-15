import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cashSummaryWindow, nextIsoDay } from "../pos-cash-window.ts";

// browser-roles#4: GET /pos/cash-summary rejects from >= to (400 «El parámetro
// from debe ser anterior a to.»); «desde hoy hasta hoy» must be one full day.
describe("Punto de venta · ventana del arqueo", () => {
  it("advances a calendar day, across month and year ends", () => {
    assert.equal(nextIsoDay("2026-09-15"), "2026-09-16");
    assert.equal(nextIsoDay("2026-09-30"), "2026-10-01");
    assert.equal(nextIsoDay("2026-12-31"), "2027-01-01");
    assert.equal(nextIsoDay("2028-02-28"), "2028-02-29");
    assert.equal(nextIsoDay("not-a-day"), "not-a-day");
  });

  it("sends an inclusive UI range as a half-open API window (to = following midnight)", () => {
    assert.deepEqual(cashSummaryWindow("2026-09-15", "2026-09-15"), { from: "2026-09-15", to: "2026-09-16" });
    assert.deepEqual(cashSummaryWindow("2026-09-01", "2026-09-15"), { from: "2026-09-01", to: "2026-09-16" });
    const { from, to } = cashSummaryWindow("2026-09-15", "2026-09-15");
    assert.ok(from < to, "from must be strictly before to for the API");
  });
});
