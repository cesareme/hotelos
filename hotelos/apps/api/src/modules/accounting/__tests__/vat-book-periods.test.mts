// FIX-1 · F3 (E-04 / B-2) — pure helpers of the VAT book periods and the opening
// compensation of the VAT settings (vat-books.service.ts). No database. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/vat-book-periods.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestPeriodOf, resolveOpeningCompensationPatch } from "../vat-books.service.js";

describe("latestPeriodOf (GET /fiscal/vat-books/periods)", () => {
  it("orders the periods newest first by the date of their newest row and names the latest", () => {
    const { periods, latest } = latestPeriodOf([
      { period: "2025-Q4", rows: 7979, lastDate: "2025-12-31" },
      { period: "2026-Q2", rows: 8406, lastDate: "2026-06-30" },
      { period: "2025-Q1", rows: 9347, lastDate: "2025-03-31" },
      { period: "2026-Q1", rows: 5592, lastDate: "2026-03-31" }
    ]);
    assert.deepEqual(periods.map((row) => row.period), ["2026-Q2", "2026-Q1", "2025-Q4", "2025-Q1"]);
    assert.equal(latest, "2026-Q2");
  });

  it("a quarterly and a monthly code of the same year sort by date, not by text; no rows → latest null", () => {
    const { periods, latest } = latestPeriodOf([
      { period: "2026-Q1", rows: 3, lastDate: "2026-03-31" },
      { period: "2026-04", rows: 1, lastDate: "2026-04-30" }
    ]);
    assert.deepEqual(periods.map((row) => row.period), ["2026-04", "2026-Q1"]);
    assert.equal(latest, "2026-04");
    assert.deepEqual(latestPeriodOf([]), { periods: [], latest: null });
    assert.equal(latestPeriodOf([{ period: "2026-Q3", rows: 0, lastDate: null }]).latest, "2026-Q3");
  });
});

describe("resolveOpeningCompensationPatch (PUT /fiscal/vat-settings)", () => {
  const current = { openingCompensation: 0, openingCompensationPeriod: null };
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return (error as { details?: { code?: string } }).details?.code;
    }
    return undefined;
  };

  it("keeps the stored values when the patch does not name them and normalises the period code", () => {
    assert.deepEqual(resolveOpeningCompensationPatch({}, { openingCompensation: 42024.02, openingCompensationPeriod: "2025-Q2" }), { openingCompensation: resolveOpeningCompensationPatch({}, { openingCompensation: 42024.02, openingCompensationPeriod: "2025-Q2" }).openingCompensation, openingCompensationPeriod: "2025-Q2" });
    const resolved = resolveOpeningCompensationPatch({ openingCompensation: 1184.07, openingCompensationPeriod: " 2025-q3 " }, current);
    assert.equal(resolved.openingCompensation.toFixed(2), "1184.07");
    assert.equal(resolved.openingCompensationPeriod, "2025-Q3");
    assert.equal(resolveOpeningCompensationPatch({ openingCompensation: 10, openingCompensationPeriod: "2025-02" }, current).openingCompensationPeriod, "2025-02");
    assert.equal(resolveOpeningCompensationPatch({ openingCompensation: 0, openingCompensationPeriod: "" }, { openingCompensation: 5, openingCompensationPeriod: "2025-Q1" }).openingCompensationPeriod, null, "an empty period clears it");
  });

  it("rejects a negative amount, an unreadable or annual period, and an amount without a period", () => {
    assert.equal(code(() => resolveOpeningCompensationPatch({ openingCompensation: -1 }, current)), "OPENING_COMPENSATION_INVALID");
    assert.equal(code(() => resolveOpeningCompensationPatch({ openingCompensation: 10, openingCompensationPeriod: "2025" }, current)), "INVALID_PERIOD", "a year is not a settlement period");
    assert.equal(code(() => resolveOpeningCompensationPatch({ openingCompensation: 10, openingCompensationPeriod: "garbage" }, current)), "INVALID_PERIOD");
    assert.equal(code(() => resolveOpeningCompensationPatch({ openingCompensation: 10 }, current)), "OPENING_COMPENSATION_PERIOD_REQUIRED");
    assert.equal(code(() => resolveOpeningCompensationPatch({ openingCompensationPeriod: null }, { openingCompensation: 10, openingCompensationPeriod: "2025-Q1" })), "OPENING_COMPENSATION_PERIOD_REQUIRED", "clearing the period of a live amount");
    assert.equal(code(() => resolveOpeningCompensationPatch({ openingCompensation: 0, openingCompensationPeriod: null }, { openingCompensation: 10, openingCompensationPeriod: "2025-Q1" })), undefined, "clearing both is fine");
  });
});
