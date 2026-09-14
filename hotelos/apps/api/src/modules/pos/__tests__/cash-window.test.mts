// Unit tests for the POS cash-summary window resolvers (Tanda 2 · FISC-05).
// Pure-core only: no database. Run from apps/api with
//   node --import tsx --test src/modules/pos/__tests__/cash-window.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBound, resolveCashSummaryWindow } from "../pos-cash-closure.service.js";

const MADRID = "Europe/Madrid";

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** Asserts `fn` throws an HttpError with the given status and a message matching `message`. */
function assertHttpError(fn: () => unknown, statusCode: number, message: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error, "expected an Error");
    const status = (error as { statusCode?: unknown }).statusCode;
    assert.equal(status, statusCode, `expected status ${statusCode}, got ${String(status)}: ${error.message}`);
    assert.match(error.message, message);
    return true;
  });
}

describe("parseBound — one window bound", () => {
  it("treats absent / null / blank as 'not given'", () => {
    assert.equal(parseBound(undefined, "from", MADRID), null);
    assert.equal(parseBound(null, "to", MADRID), null);
    assert.equal(parseBound("", "from", MADRID), null);
    assert.equal(parseBound("   ", "to", MADRID), null);
  });

  it("maps a calendar day to the property-local midnight (CEST → 22:00Z, CET → 23:00Z)", () => {
    assert.equal(iso(parseBound("2026-09-14", "from", MADRID)), "2026-09-13T22:00:00.000Z");
    assert.equal(iso(parseBound(" 2026-01-10 ", "from", MADRID)), "2026-01-09T23:00:00.000Z");
    assert.equal(iso(parseBound("2026-09-14", "from", "UTC")), "2026-09-14T00:00:00.000Z");
  });

  it("passes an ISO-8601 instant through unchanged", () => {
    assert.equal(iso(parseBound("2026-09-14T10:30:00.000Z", "from", MADRID)), "2026-09-14T10:30:00.000Z");
    assert.equal(iso(parseBound("2026-09-14T12:00:00+02:00", "to", MADRID)), "2026-09-14T10:00:00.000Z");
  });

  it("rejects day-shaped values that are not real calendar days (Date.UTC would roll them over)", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-02-29", "2026-01-00", "2026-01-32"]) {
      assertHttpError(() => parseBound(bad, "from", MADRID), 400, /^Fecha no válida: /);
    }
    // The offending value is in the message and in the machine payload.
    assert.throws(
      () => parseBound("2026-02-30", "to", MADRID),
      (error: unknown) => {
        const e = error as { message: string; details?: unknown };
        assert.equal(e.message, "Fecha no válida: 2026-02-30");
        assert.deepEqual(e.details, { code: "INVALID_DATE", param: "to", value: "2026-02-30" });
        return true;
      }
    );
  });

  it("accepts a leap day on a leap year only", () => {
    assert.equal(iso(parseBound("2024-02-29", "from", "UTC")), "2024-02-29T00:00:00.000Z");
    assertHttpError(() => parseBound("2025-02-29", "from", "UTC"), 400, /Fecha no válida/);
  });

  it("rejects garbage and non-string values with 400", () => {
    assertHttpError(() => parseBound("ayer", "from", MADRID), 400, /ISO-8601/);
    assertHttpError(() => parseBound("2026-09-14T25:00:00Z", "to", MADRID), 400, /ISO-8601/);
    assertHttpError(() => parseBound("14/09/2026", "to", MADRID), 400, /ISO-8601/);
    assertHttpError(() => parseBound(["2026-09-14"], "from", MADRID), 400, /no es válido/);
    assertHttpError(() => parseBound(20260914, "from", MADRID), 400, /no es válido/);
  });

  it("passes an already-resolved Date through and rejects an Invalid Date", () => {
    const bound = new Date("2026-09-14T10:30:00.000Z");
    assert.equal(parseBound(bound, "from", MADRID), bound);
    assertHttpError(() => parseBound(new Date("nope"), "from", MADRID), 400, /no es válido/);
  });
});

describe("resolveCashSummaryWindow — date alias and from/to", () => {
  const NOW = new Date("2026-09-14T15:45:00.000Z");

  it("date=YYYY-MM-DD is one property-local business day [midnight, next midnight)", () => {
    const win = resolveCashSummaryWindow({ date: "2026-09-14" }, MADRID, NOW);
    assert.equal(iso(win.from), "2026-09-13T22:00:00.000Z");
    assert.equal(iso(win.to), "2026-09-14T22:00:00.000Z");
    assert.equal(win.date, "2026-09-14");
  });

  it("date yields the real 25h / 23h day across a DST switch (two midnights, not +24h)", () => {
    const fallBack = resolveCashSummaryWindow({ date: "2026-10-25" }, MADRID, NOW);
    assert.equal(iso(fallBack.from), "2026-10-24T22:00:00.000Z");
    assert.equal(iso(fallBack.to), "2026-10-25T23:00:00.000Z");
    assert.equal(fallBack.to.getTime() - fallBack.from.getTime(), 25 * 3_600_000);

    const springForward = resolveCashSummaryWindow({ date: "2026-03-29" }, MADRID, NOW);
    assert.equal(iso(springForward.from), "2026-03-28T23:00:00.000Z");
    assert.equal(iso(springForward.to), "2026-03-29T22:00:00.000Z");
    assert.equal(springForward.to.getTime() - springForward.from.getTime(), 23 * 3_600_000);
  });

  it("date rolls over month and year ends", () => {
    const win = resolveCashSummaryWindow({ date: "2026-12-31" }, "UTC", NOW);
    assert.equal(iso(win.from), "2026-12-31T00:00:00.000Z");
    assert.equal(iso(win.to), "2027-01-01T00:00:00.000Z");
    assert.equal(win.date, "2026-12-31");
  });

  it("rejects date combined with from or to (blank from/to do not count)", () => {
    assertHttpError(() => resolveCashSummaryWindow({ date: "2026-09-14", from: "2026-09-14" }, MADRID, NOW), 400, /date o from\/to/);
    assertHttpError(() => resolveCashSummaryWindow({ date: "2026-09-14", to: "2026-09-15" }, MADRID, NOW), 400, /date o from\/to/);
    const win = resolveCashSummaryWindow({ date: "2026-09-14", from: "", to: "  " }, MADRID, NOW);
    assert.equal(win.date, "2026-09-14");
  });

  it("date must be a calendar day: instants and invalid days are 400", () => {
    assertHttpError(() => resolveCashSummaryWindow({ date: "2026-09-14T00:00:00Z" }, MADRID, NOW), 400, /día YYYY-MM-DD/);
    assertHttpError(() => resolveCashSummaryWindow({ date: "2026-02-30" }, MADRID, NOW), 400, /Fecha no válida: 2026-02-30/);
    assertHttpError(() => resolveCashSummaryWindow({ date: "hoy" }, MADRID, NOW), 400, /día YYYY-MM-DD/);
    assertHttpError(() => resolveCashSummaryWindow({ date: ["2026-09-14"] as unknown as string }, MADRID, NOW), 400, /no es válido/);
  });

  it("is idempotent on its own output (route resolves once, service resolves again)", () => {
    const first = resolveCashSummaryWindow({ date: "2026-10-25" }, MADRID, NOW);
    const again = resolveCashSummaryWindow({ ...first }, MADRID, NOW);
    assert.deepEqual(again, first);
    // The echo is validated, not trusted.
    assertHttpError(() => resolveCashSummaryWindow({ ...first, date: "2026-02-30" }, MADRID, NOW), 400, /Fecha no válida: 2026-02-30/);
    // A from/to window carries `date: null` and round-trips unchanged too.
    const range = resolveCashSummaryWindow({ from: "2026-09-13", to: "2026-09-14T10:00:00Z" }, MADRID, NOW);
    assert.deepEqual(resolveCashSummaryWindow({ ...range }, MADRID, NOW), range);
    assert.equal(range.date, null);
  });

  it("without parameters the window is [start of today (local), now)", () => {
    const win = resolveCashSummaryWindow({}, MADRID, NOW);
    assert.equal(iso(win.from), "2026-09-13T22:00:00.000Z");
    assert.equal(iso(win.to), NOW.toISOString());
    assert.equal(win.date, null);
  });

  it("from/to accept day and instant bounds and require from < to", () => {
    const win = resolveCashSummaryWindow({ from: "2026-09-13", to: "2026-09-14T10:00:00Z" }, MADRID, NOW);
    assert.equal(iso(win.from), "2026-09-12T22:00:00.000Z");
    assert.equal(iso(win.to), "2026-09-14T10:00:00.000Z");
    assert.equal(win.date, null);
    assertHttpError(() => resolveCashSummaryWindow({ from: "2026-09-14", to: "2026-09-14" }, MADRID, NOW), 400, /anterior a to/);
    assertHttpError(() => resolveCashSummaryWindow({ from: "2026-09-15", to: "2026-09-14" }, MADRID, NOW), 400, /anterior a to/);
    assertHttpError(() => resolveCashSummaryWindow({ from: "2026-13-01", to: "2026-09-14" }, MADRID, NOW), 400, /Fecha no válida: 2026-13-01/);
  });
});
