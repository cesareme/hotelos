// Pure unit tests for the PMS History & Forecast importer. No database: flag
// parsing, CSV contract, validation, mapping, summary, BAR derivation and the
// per-day protection decision. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/import-pms-history-forecast.test.mts
// The real Los Tilos report is NOT in the repo: set PMS_HF_REAL_CSV=<path> to
// run the end-to-end totals check against it (skipped otherwise).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  barPriceForRoomType,
  buildBarContext,
  compressDates,
  deriveBarPrice,
  isRepresentativeAdr,
  STLY_BAND,
  STLY_MIN_PAID_ROOMS,
  mapRowToForecast,
  mapRowToSnapshot,
  parseFlags,
  parseReportCsv,
  planSnapshotAction,
  roomTypeMultiplier,
  selectRows,
  summarize,
  USAGE,
  validateRows,
  type BarContext,
  type ReportRow
} from "../import-pms-history-forecast.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "pms-history-forecast-sample.csv");
const TODAY = new Date("2026-09-14T00:00:00.000Z");
const ROOMS = 92;
const PROP = "prop_tilos";

function loadFixture(): ReportRow[] {
  const parsed = parseReportCsv(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(parsed.errors, []);
  return parsed.rows;
}

function clone(rows: readonly ReportRow[]): ReportRow[] {
  return rows.map((r) => ({ ...r }));
}

describe("parseFlags", () => {
  it("defaults: dry-run, section both, source derived from today", () => {
    const f = parseFlags(["--file", "x.csv", "--property", PROP, "--rooms", "92"], TODAY);
    assert.equal(f.apply, false);
    assert.equal(f.section, "both");
    assert.equal(f.rooms, 92);
    assert.equal(f.source, "pms_import:opera_hf_2026-09-14");
    assert.equal(f.publishBar, null);
    assert.equal(f.force, false);
    assert.equal(f.revert, false);
    assert.equal(f.help, false);
  });

  it("--help / -h short-circuit every other validation and USAGE names every flag", () => {
    assert.equal(parseFlags(["--help"], TODAY).help, true);
    assert.equal(parseFlags(["-h"], TODAY).help, true);
    assert.equal(parseFlags(["--apply", "--help"], TODAY).help, true, "no --file/--property/--confirm error when help is requested");
    for (const flag of ["--file", "--property", "--rooms", "--source", "--section", "--from", "--to", "--publish-bar", "--force", "--revert", "--dry-run", "--apply", "--confirm", "--json", "--help"]) {
      assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
    }
  });

  it("parses every flag", () => {
    const f = parseFlags(
      ["--file", "x.csv", "--property", PROP, "--rooms", "92", "--source", "pms_import:test", "--section", "forecast", "--from", "2026-01-01", "--to", "2026-02-01", "--publish-bar", "BAR", "--force", "--apply", "--confirm", PROP, "--json"],
      TODAY
    );
    assert.equal(f.source, "pms_import:test");
    assert.equal(parseFlags(["--property", PROP, "--revert", "--source", "opera_hf_2026-09-14"], TODAY).source, "pms_import:opera_hf_2026-09-14");
    assert.equal(f.section, "forecast");
    assert.equal(f.from, "2026-01-01");
    assert.equal(f.to, "2026-02-01");
    assert.equal(f.publishBar, "BAR");
    assert.equal(f.force, true);
    assert.equal(f.apply, true);
    assert.deepEqual(f.confirm, [PROP]);
    assert.equal(f.json, true);
  });

  it("rejects unknown flags, missing required values and unconfirmed --apply", () => {
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--bogus"], TODAY), /Unknown flag "--bogus"/);
    assert.throws(() => parseFlags(["--property", PROP, "--rooms", "92"], TODAY), /--file/);
    assert.throws(() => parseFlags(["--file", "x", "--rooms", "92"], TODAY), /--property/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP], TODAY), /--rooms/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "0"], TODAY), /--rooms must be a positive integer/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--section", "all"], TODAY), /--section/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--from", "2026-02-30"], TODAY), /--from must be a real/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--from", "2026-03-01", "--to", "2026-02-01"], TODAY), /is after/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--apply"], TODAY), /--apply requires --confirm/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--apply", "--confirm", "other"], TODAY), /--confirm must name the target property/);
    assert.throws(() => parseFlags(["--file", "x", "--property", PROP, "--rooms", "92", "--dry-run", "--apply", "--confirm", PROP], TODAY), /mutually exclusive/);
  });

  it("--revert needs neither --file nor --rooms, but rate_days need --force", () => {
    const f = parseFlags(["--property", PROP, "--revert", "--source", "pms_import:x"], TODAY);
    assert.equal(f.revert, true);
    assert.equal(f.file, null);
    assert.throws(() => parseFlags(["--property", PROP, "--revert", "--publish-bar", "BAR"], TODAY), /needs --force/);
  });
});

describe("parseReportCsv", () => {
  it("maps columns by name in any order and reads '9.0' counters as integers", () => {
    const rows = loadFixture();
    assert.equal(rows.length, 6);
    const first = rows[0]!;
    assert.equal(first.line, 2);
    assert.equal(first.date, "2026-09-10");
    assert.equal(first.dow, "Thu");
    assert.equal(first.section, "history");
    assert.equal(first.totalOcc, 9);
    assert.equal(first.arrRooms, 3);
    assert.equal(first.compRooms, 1);
    assert.equal(first.houseUse, 1);
    assert.equal(first.deductIndiv, 9);
    assert.equal(first.ooo, 18);
    assert.equal(first.adlChl, 16);
    assert.equal(first.occPct, 10.81);
    assert.equal(first.revenue, 1078.33);
    assert.equal(first.adr, 134.79);
    assert.equal(rows[4]!.section, "forecast");
    assert.equal(rows[5]!.line, 7);
  });

  it("rejects unknown and missing columns", () => {
    const content = readFileSync(FIXTURE, "utf8");
    const extra = parseReportCsv(content.replace("section,adr,date", "section,adr,date,foo"));
    assert.ok(extra.errors.some((e) => e.kind === "unknown_column" && e.message.includes("foo")));
    const withoutAdr = content
      .split("\n")
      .map((line) => line.split(",").filter((_, i) => i !== 1).join(","))
      .join("\n");
    const missing = parseReportCsv(withoutAdr);
    assert.equal(missing.rows.length, 0);
    assert.ok(missing.errors.some((e) => e.kind === "missing_column" && e.message.includes("adr")));
  });

  it("reports non-integer counters, bad sections and bad dates with the line number", () => {
    const content = readFileSync(FIXTURE, "utf8")
      .replace("history,134.79,2026-09-10,9.0", "history,134.79,2026-09-10,9.5")
      .replace("history,81.34,2026-09-11", "budget,81.34,2026-09-11")
      .replace("2026-09-12", "2026-13-12");
    const parsed = parseReportCsv(content);
    assert.equal(parsed.rows.length, 3);
    assert.deepEqual(
      parsed.errors.map((e) => [e.line, e.kind]),
      [
        [2, "not_an_integer"],
        [3, "section"],
        [4, "date"]
      ]
    );
  });
});

describe("validateRows", () => {
  it("accepts the fixture with only the negative-revenue warning", () => {
    const { errors, warnings } = validateRows(loadFixture(), ROOMS);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings.map((w) => [w.date, w.kind]), [["2026-09-13", "negative_revenue"]]);
  });

  it("flags gaps, duplicates and history after forecast", () => {
    const rows = loadFixture();
    const gap = clone(rows);
    gap.splice(2, 1);
    assert.ok(validateRows(gap, ROOMS).errors.some((e) => e.kind === "gap" && e.date === "2026-09-13"));
    const dup = clone(rows);
    dup[2]!.date = "2026-09-11";
    const dupErrors = validateRows(dup, ROOMS).errors.map((e) => e.kind);
    assert.ok(dupErrors.includes("duplicate_date"));
    const order = clone(rows);
    order[5]!.section = "history";
    assert.ok(validateRows(order, ROOMS).errors.some((e) => e.kind === "section_order" && e.date === "2026-09-15"));
    assert.ok(validateRows([], ROOMS).errors.some((e) => e.kind === "empty"));
  });

  it("reports only the FIRST history-after-forecast transition and keeps validating the other rules", () => {
    // One forecast row in the middle of the history block makes every later
    // history row "after a forecast": 406 cascading errors in the real report.
    const rows = clone(loadFixture());
    rows[1]!.section = "forecast"; // 2026-09-11 forecast → 2026-09-12 and 2026-09-13 (history) are both "after"
    rows[3]!.deductIndiv = 29; // and an independent defect on the last history row must still surface
    const { errors } = validateRows(rows, ROOMS);
    const sectionOrder = errors.filter((e) => e.kind === "section_order");
    assert.equal(sectionOrder.length, 1);
    assert.equal(sectionOrder[0]!.date, "2026-09-12");
    assert.match(sectionOrder[0]!.message, /solo se informa la primera/);
    assert.deepEqual(errors.filter((e) => e.kind === "split_sum").map((e) => e.date), ["2026-09-13"]);
    assert.equal(errors.length, 2);
  });

  it("requires the deduct/non-deduct split to sum to totalOcc", () => {
    const rows = clone(loadFixture());
    rows[0]!.deductIndiv = 8;
    const { errors } = validateRows(rows, ROOMS);
    assert.deepEqual(errors.map((e) => [e.date, e.kind]), [["2026-09-10", "split_sum"]]);
  });

  it("checks the occupancy and ADR formulas within tolerance (warnings, not errors)", () => {
    const rows = clone(loadFixture());
    rows[0]!.occPct = 10.86; // within 0.06 pp of 10.81
    rows[0]!.adr = 134.81; // within 0.02
    let out = validateRows(rows, ROOMS);
    assert.deepEqual(out.errors, []);
    assert.ok(!out.warnings.some((w) => w.kind === "formula_occ" || w.kind === "formula_adr"));
    rows[0]!.occPct = 10.88;
    rows[0]!.adr = 134.82;
    out = validateRows(rows, ROOMS);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(
      out.warnings.filter((w) => w.date === "2026-09-10").map((w) => w.kind),
      ["formula_occ", "formula_adr"]
    );
    // rooms − ooo ≤ 0 → expected occupancy 0
    const full = clone(loadFixture());
    full[0]!.ooo = 92;
    full[0]!.occPct = 0;
    assert.ok(!validateRows(full, ROOMS).warnings.some((w) => w.kind === "formula_occ" && w.date === "2026-09-10"));
  });
});

describe("mapRowToSnapshot / mapRowToForecast", () => {
  it("copies the report 1:1 into the top-level snapshot and rounds RevPAR", () => {
    const row = loadFixture()[0]!;
    const { snapshotDate, data } = mapRowToSnapshot(row, ROOMS, "pms_import:test");
    assert.equal(snapshotDate.toISOString(), "2026-09-10T00:00:00.000Z");
    assert.deepEqual(data, {
      totalOcc: 9,
      arrivalRooms: 3,
      departureRooms: 1,
      compRooms: 1,
      houseUseRooms: 1,
      dayUseRooms: 0,
      noShowRooms: 1,
      oooRooms: 18,
      deductIndividualRooms: 9,
      nonDeductIndividualRooms: 0,
      deductGroupRooms: 0,
      nonDeductGroupRooms: 0,
      adultsChildren: 16,
      roomRevenue: 1078.33,
      totalRevenue: 1078.33,
      netRoomRevenue: 1078.33,
      grossOperatingProfit: null,
      adr: 134.79,
      revpar: 11.72,
      trevpar: null,
      goppar: null,
      occupancyPercent: 10.81,
      dataSource: "pms_import:test"
    });
    assert.equal(mapRowToSnapshot(row, 0, "x").data.revpar, null);
  });

  it("builds a top-level forecast with the pms_forecast driver", () => {
    const row = loadFixture()[4]!;
    const f = mapRowToForecast(row, ROOMS, "pms_import:test", { from: "2026-09-10", to: "2026-09-15" });
    assert.equal(f.forecastDate.toISOString(), "2026-09-14T00:00:00.000Z");
    assert.equal(f.roomTypeId, null);
    assert.equal(f.ratePlanId, null);
    assert.equal(f.channelId, null);
    assert.equal(f.segment, null);
    assert.equal(f.expectedRoomsSold, 40);
    assert.equal(f.expectedOccupancy, 43.48);
    assert.equal(f.expectedAdr, 95.5);
    assert.equal(f.expectedRoomRevenue, 3820);
    assert.equal(f.expectedTotalRevenue, 3820);
    assert.equal(f.expectedRevpar, 41.52);
    assert.equal(f.expectedTrevpar, null);
    assert.equal(f.expectedProfit, null);
    assert.equal(f.confidence, 80);
    assert.equal(f.modelVersion, "pms_import:test");
    assert.deepEqual(f.driversJson, [
      { driver: "adr_source", value: "pms_forecast" },
      { driver: "import_batch", value: "pms_import:test" },
      { driver: "report_range", value: "2026-09-10..2026-09-15" }
    ]);
  });
});

describe("summarize / selectRows", () => {
  it("totals per section (rn include house use, ADR over paid rooms)", () => {
    const s = summarize(loadFixture(), ROOMS);
    assert.equal(s.history.rows, 4);
    assert.equal(s.history.from, "2026-09-10");
    assert.equal(s.history.to, "2026-09-13");
    assert.equal(s.history.roomNights, 53);
    assert.equal(s.history.paidRoomNights, 45);
    assert.equal(s.history.revenue, 1519.3);
    assert.equal(s.history.adr, 33.76);
    assert.equal(s.history.avgOccPct, 13.55); // 45 / (74+74+92+92)
    assert.equal(s.forecast.rows, 2);
    assert.equal(s.forecast.roomNights, 90);
    assert.equal(s.forecast.revenue, 9332.5);
    assert.equal(s.forecast.adr, 103.69);
    assert.equal(s.total.rows, 6);
    assert.equal(s.total.roomNights, 143);
    assert.equal(s.total.revenue, 10851.8);
    assert.equal(s.forecast.avgOccPct, 49.45); // 90 / (92+90)
    assert.equal(s.total.avgOccPct, 26.26);
  });

  it("filters by section and range", () => {
    const rows = loadFixture();
    assert.equal(selectRows(rows, { section: "history", from: null, to: null }).length, 4);
    assert.equal(selectRows(rows, { section: "forecast", from: null, to: null }).length, 2);
    assert.deepEqual(selectRows(rows, { section: "both", from: "2026-09-12", to: "2026-09-14" }).map((r) => r.date), ["2026-09-12", "2026-09-13", "2026-09-14"]);
  });
});

describe("buildBarContext", () => {
  it("keeps paid rooms next to the ADR for forecast days too (paid = totalOcc − houseUse)", () => {
    const ctx = buildBarContext(loadFixture());
    assert.deepEqual([...ctx.forecastByDate.entries()], [
      ["2026-09-14", { adr: 95.5, paid: 40 }],
      ["2026-09-15", { adr: 110.25, paid: 50 }]
    ]);
    assert.deepEqual(ctx.historyByDate.get("2026-09-10"), { adr: 134.79, paid: 8 });
    assert.equal(ctx.historyByDate.size, 4);
    assert.equal(Math.round(ctx.monthAdr.get(9)! * 100) / 100, 33.76); // 1519.30 / 45 paid rooms
  });
});

describe("deriveBarPrice", () => {
  it("prefers a representative forecast ADR, then d−364, then d−371, then the month average", () => {
    const ctx = buildBarContext(loadFixture());
    // The fixture's September average is 33,76 € (a 0-room day and a negative
    // adjustment drag it down), so the 95,50 € forecast of 2026-09-14 sits
    // outside the band (×1,8 = 60,77) and is NOT used: same rule as STLY.
    assert.deepEqual(deriveBarPrice("2026-09-14", ctx), { price: 33.76, source: "month_avg" });
    // Without that distorted month average the forecast is the first choice.
    const noMonth: BarContext = { ...ctx, monthAdr: new Map<number, number>() };
    assert.deepEqual(deriveBarPrice("2026-09-14", noMonth), { price: 95.5, source: "forecast" });
    // 2027-09-09 → d−364 = 2026-09-10 sold 8 rooms at 134,79 €, but 134,79 sits outside the STLY band
    // (×1,8 = 60,77): the chain falls through to the month average. The band is exercised with explicit contexts below.
    assert.deepEqual(deriveBarPrice("2027-09-09", ctx), { price: 33.76, source: "month_avg" });
    // 2027-09-11 → d−364 = 2026-09-12 sold 0 rooms, d−371 = 2026-09-05 absent → September average 1519.30 / 45
    assert.deepEqual(deriveBarPrice("2027-09-11", ctx), { price: 33.76, source: "month_avg" });
    assert.deepEqual(deriveBarPrice("2027-03-01", ctx), { price: null, source: "none" });
    const manual: BarContext = {
      forecastByDate: new Map(),
      historyByDate: new Map([
        ["2026-09-12", { adr: 0, paid: 0 }],
        ["2026-09-05", { adr: 88.126, paid: 5 }]
      ]),
      monthAdr: new Map<number, number>()
    };
    assert.deepEqual(deriveBarPrice("2027-09-11", manual), { price: 88.13, source: "stly_371" });
    // a negative-adjustment forecast day is not a usable price
    const neg: BarContext = { ...manual, forecastByDate: new Map([["2027-09-11", { adr: -1.52, paid: 30 }]]) };
    assert.deepEqual(deriveBarPrice("2027-09-11", neg), { price: 88.13, source: "stly_371" });
  });

  it("applies the representativeness rule (threshold + band) to the forecast ADR exactly as to STLY", () => {
    // Real Los Tilos forecast rows: 2026-10-25 carries 21 rooms for 213,64 € (ADR 10,68: a group block
    // booked without a rate) with an October average of ~82 €; 2026-09-14 carries 47 rooms at 78,83 €
    // with a September average of ~87 €.
    const october: BarContext = {
      forecastByDate: new Map([["2026-10-25", { adr: 10.68, paid: 20 }]]),
      historyByDate: new Map([["2025-10-26", { adr: 79.4, paid: 30 }]]),
      monthAdr: new Map([[10, 82]])
    };
    assert.deepEqual(deriveBarPrice("2026-10-25", october), { price: 79.4, source: "stly_364" });
    const octoberNoStly: BarContext = { ...october, historyByDate: new Map() };
    assert.deepEqual(deriveBarPrice("2026-10-25", octoberNoStly), { price: 82, source: "month_avg" });
    const september: BarContext = {
      forecastByDate: new Map([["2026-09-14", { adr: 78.83, paid: 47 }]]),
      historyByDate: new Map([["2025-09-15", { adr: 120, paid: 30 }]]),
      monthAdr: new Map([[9, 87]])
    };
    assert.deepEqual(deriveBarPrice("2026-09-14", september), { price: 78.83, source: "forecast" });
    // Too few paid rooms in the forecast → not representative even inside the band.
    const thinForecast: BarContext = { ...september, forecastByDate: new Map([["2026-09-14", { adr: 90, paid: STLY_MIN_PAID_ROOMS - 1 }]]) };
    assert.deepEqual(deriveBarPrice("2026-09-14", thinForecast), { price: 120, source: "stly_364" });
    // Exactly at the threshold and at the band edges → accepted.
    assert.equal(isRepresentativeAdr({ adr: 87 * STLY_BAND.min, paid: STLY_MIN_PAID_ROOMS }, 87), true);
    assert.equal(isRepresentativeAdr({ adr: 87 * STLY_BAND.max, paid: STLY_MIN_PAID_ROOMS }, 87), true);
    assert.equal(isRepresentativeAdr({ adr: 87 * STLY_BAND.max + 0.01, paid: 50 }, 87), false);
    assert.equal(isRepresentativeAdr({ adr: 10.68, paid: 20 }, 82), false);
    assert.equal(isRepresentativeAdr({ adr: 10.68, paid: 20 }, undefined), true, "no month average → threshold alone decides");
    assert.equal(isRepresentativeAdr(undefined, 82), false);
    assert.equal(isRepresentativeAdr({ adr: 0, paid: 40 }, undefined), false);
  });

  it("ignores a same-day-last-year ADR that rests on fewer than STLY_MIN_PAID_ROOMS paid rooms", () => {
    // 2026-11-01 sold 2 rooms at 326,88 € in the real report: noise, not a tariff.
    const thin: BarContext = {
      forecastByDate: new Map(),
      historyByDate: new Map([
        ["2026-11-01", { adr: 326.88, paid: 2 }],
        ["2026-10-25", { adr: 91.4, paid: 2 }]
      ]),
      // month_avg is keyed by the TARGET month (October), not by the STLY month
      monthAdr: new Map<number, number>([[10, 84.2]])
    };
    assert.equal(STLY_MIN_PAID_ROOMS, 5);
    assert.deepEqual(deriveBarPrice("2027-10-31", thin), { price: 84.2, source: "month_avg" });
    // Enough rooms but far outside the band around the month ADR (84,2 × 1,8 = 151,56) → still noise.
    const enoughButWild = { ...thin, historyByDate: new Map([["2026-11-01", { adr: 326.88, paid: 5 }]]) };
    assert.deepEqual(deriveBarPrice("2027-10-31", enoughButWild), { price: 84.2, source: "month_avg" });
    // Enough rooms and inside the band → accepted.
    const enough = { ...thin, historyByDate: new Map([["2026-11-01", { adr: 120.5, paid: 5 }]]) };
    assert.deepEqual(deriveBarPrice("2027-10-31", enough), { price: 120.5, source: "stly_364" });
    // Without a month average there is no band: paid-rooms threshold alone decides.
    const noMonth = { ...enoughButWild, monthAdr: new Map<number, number>() };
    assert.deepEqual(deriveBarPrice("2027-10-31", noMonth), { price: 326.88, source: "stly_364" });
  });

  it("applies the category multipliers", () => {
    assert.equal(roomTypeMultiplier({ defaultRateCategory: "Standard", baseCapacity: 2 }), 1);
    assert.equal(roomTypeMultiplier({ defaultRateCategory: "Suite", baseCapacity: 2 }), 1.5);
    assert.equal(roomTypeMultiplier({ defaultRateCategory: "Standard", baseCapacity: 1 }), 0.85);
    assert.equal(roomTypeMultiplier({ defaultRateCategory: null, baseCapacity: 2 }), 1);
    assert.equal(roomTypeMultiplier({ defaultRateCategory: "Superior", baseCapacity: 2 }), 1);
    assert.equal(barPriceForRoomType(95.5, { defaultRateCategory: "Suite", baseCapacity: 2 }), 143.25);
    assert.equal(barPriceForRoomType(95.5, { defaultRateCategory: "Standard", baseCapacity: 1 }), 81.18);
  });
});

describe("planSnapshotAction / compressDates", () => {
  it("protects other sources unless --force; overwrites 0/0 night_audit artefacts only on a property without reservations", () => {
    const src = "pms_import:test";
    const zeroClose = { date: "d", dataSource: "night_audit", totalOcc: 0, roomRevenue: 0 };
    for (const hasReservations of [false, true]) {
      assert.equal(planSnapshotAction(undefined, src, false, hasReservations), "create");
      assert.equal(planSnapshotAction({ date: "d", dataSource: src, totalOcc: 5, roomRevenue: 10 }, src, false, hasReservations), "update_same_source");
      assert.equal(planSnapshotAction({ date: "d", dataSource: "night_audit", totalOcc: 3, roomRevenue: 0 }, src, false, hasReservations), "skipped_protected");
      assert.equal(planSnapshotAction({ date: "d", dataSource: "demo", totalOcc: 0, roomRevenue: 0 }, src, false, hasReservations), "skipped_protected");
      assert.equal(planSnapshotAction({ date: "d", dataSource: "demo", totalOcc: 0, roomRevenue: 0 }, src, true, hasReservations), "force_overwrite");
    }
    // No reservation at all → the 0/0 close can only be the scheduler's artefact.
    assert.equal(planSnapshotAction(zeroClose, src, false, false), "update_night_audit_zero");
    // With reservations (Rías Altas: 42 such closes) a zero night may be real → protected unless --force.
    assert.equal(planSnapshotAction(zeroClose, src, false, true), "skipped_protected");
    assert.equal(planSnapshotAction(zeroClose, src, true, true), "force_overwrite");
  });

  it("collapses contiguous runs", () => {
    assert.equal(compressDates(["2026-01-03", "2026-01-01", "2026-01-02", "2026-01-05"]), "2026-01-01→2026-01-03, 2026-01-05");
    assert.equal(compressDates([]), "");
  });
});

describe("real Los Tilos report (PMS_HF_REAL_CSV)", () => {
  const path = process.env.PMS_HF_REAL_CSV;
  it("457 rows · 409/48 · 14 335 rn · 1 290 527,10 € · 0 errors · 2 comp≠houseUse deviations", (t) => {
    if (!path || !existsSync(path)) {
      t.skip("PMS_HF_REAL_CSV not set or file missing");
      return;
    }
    const parsed = parseReportCsv(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows.length, 457);
    const { errors, warnings } = validateRows(parsed.rows, ROOMS);
    assert.deepEqual(errors, []);
    // occ % and ADR formulas hold on every row; the two known deviations are comp ≠ house use
    assert.deepEqual(warnings.filter((w) => w.kind === "formula_occ" || w.kind === "formula_adr"), []);
    assert.deepEqual(warnings.filter((w) => w.kind === "comp_vs_house_use").map((w) => w.date), ["2026-01-14", "2026-07-22"]);
    assert.deepEqual(warnings.filter((w) => w.kind === "negative_revenue").map((w) => w.date), ["2025-08-11", "2025-09-30", "2025-10-22"]);
    assert.equal(warnings.length, 5);
    const s = summarize(parsed.rows, ROOMS);
    assert.equal(s.history.rows, 409);
    assert.equal(s.history.adr, 97.24);
    assert.equal(s.history.avgOccPct, 37.97);
    assert.equal(s.forecast.adr, 94.97);
    assert.equal(s.total.adr, 96.97);
    assert.equal(s.total.avgOccPct, 37.91);
    assert.equal(s.forecast.rows, 48);
    assert.equal(s.history.roomNights, 12698);
    assert.equal(s.forecast.roomNights, 1637);
    assert.equal(s.total.roomNights, 14335);
    assert.ok(Math.abs(s.total.revenue - 1290527.1) <= 0.05, `total revenue ${s.total.revenue}`);
    assert.ok(Math.abs(s.history.revenue - 1139904.2) <= 0.05, `history revenue ${s.history.revenue}`);
    assert.ok(Math.abs(s.forecast.revenue - 150622.89) <= 0.05, `forecast revenue ${s.forecast.revenue}`);
    assert.equal(s.history.from, "2025-08-01");
    assert.equal(s.history.to, "2026-09-13");
    assert.equal(s.forecast.from, "2026-09-14");
    assert.equal(s.forecast.to, "2026-10-31");
  });
});
