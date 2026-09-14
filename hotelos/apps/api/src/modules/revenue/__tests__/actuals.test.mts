// Unit tests for the shared revenue money-path resolvers (REV-03 / REV-04).
// Pure-core only: no database. Run from apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/actuals.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  dayUtc,
  leadRoomTypeIdsFor,
  parseMonth,
  publishedBarFor,
  realizeDays,
  realizedSourceLabel,
  sumRealized,
  typeDateKey,
  type PublishedBarWindow,
  type RealizedReservationRow,
  type SnapshotRow
} from "../actuals.js";
import { parseFlags as parseBackfillFlags } from "../../../scripts/backfill-snapshots.js";
import { BadRequestError } from "../../../lib/http-error.js";

const TODAY = dayUtc("2026-09-14");
const TOTAL_ROOMS = 120;

function snap(date: string, rooms: number, revenue: number, extra: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    snapshotDate: dayUtc(date),
    totalOcc: rooms,
    arrivalRooms: 0,
    departureRooms: 0,
    noShowRooms: 0,
    oooRooms: 0,
    roomRevenue: revenue,
    adr: rooms > 0 ? revenue / rooms : null,
    revpar: revenue / TOTAL_ROOMS,
    occupancyPercent: (rooms / TOTAL_ROOMS) * 100,
    ...extra
  };
}

function res(arrival: string, departure: string, total: number, status = "confirmed", roomsCount = 1): RealizedReservationRow {
  return { arrivalDate: dayUtc(arrival), departureDate: dayUtc(departure), roomsCount, totalAmount: total, adults: 2, children: 0, status };
}

describe("realizeDays — one definition of 'Real'", () => {
  it("prefers the audited snapshot over reservations on the same day (even a 0-room close)", () => {
    const win = realizeDays({
      from: dayUtc("2026-09-12"),
      to: dayUtc("2026-09-13"),
      today: TODAY,
      totalRooms: TOTAL_ROOMS,
      snapshots: [snap("2026-09-12", 0, 0, { adr: null, revpar: null, occupancyPercent: null }), snap("2026-09-13", 4, 216)],
      reservations: [res("2026-09-11", "2026-09-14", 300)] // would give 100 €/night on both days
    });
    assert.equal(win.snapshotDays, 2);
    assert.equal(win.fallbackDays, 0);
    assert.equal(win.source, "snapshots");
    const d12 = win.days.get("2026-09-12");
    const d13 = win.days.get("2026-09-13");
    assert.ok(d12 && d13);
    assert.equal(d12.source, "snapshot");
    assert.equal(d12.rooms, 0);
    assert.equal(d12.roomRevenue, 0);
    assert.equal(d12.adr, null); // no rooms → no ADR, never 0 invented
    assert.equal(d12.occPct, 0); // snapshot without occupancyPercent → derived from totalRooms
    assert.equal(d13.rooms, 4);
    assert.equal(d13.roomRevenue, 216);
    assert.equal(d13.adr, 54);
  });

  it("falls back to reservations per day when no snapshot exists, splitting revenue per night", () => {
    const win = realizeDays({
      from: dayUtc("2026-08-01"),
      to: dayUtc("2026-08-03"),
      today: TODAY,
      totalRooms: TOTAL_ROOMS,
      snapshots: [],
      reservations: [
        res("2026-08-01", "2026-08-03", 200, "checked_out"), // 100/night on 08-01, 08-02
        res("2026-08-02", "2026-08-04", 240, "confirmed", 2), // 120/night, 2 rooms on 08-02, 08-03
        res("2026-07-30", "2026-08-02", 90, "cancelled"), // ignored
        res("2026-08-03", "2026-08-04", 999, "no_show") // only the no-show counter on 08-03
      ]
    });
    assert.equal(win.snapshotDays, 0);
    assert.equal(win.fallbackDays, 3);
    assert.equal(win.source, "reservas");
    assert.deepEqual(
      [...win.days.values()].map((d) => [d.date, d.source, d.rooms, d.roomRevenue, d.arrivals, d.departures, d.noShows]),
      [
        ["2026-08-01", "reservations", 1, 100, 1, 0, 0],
        ["2026-08-02", "reservations", 3, 220, 2, 0, 0],
        ["2026-08-03", "reservations", 2, 120, 0, 1, 1] // checked_out departs 08-03; no-show arrival 08-03
      ]
    );
    const d02 = win.days.get("2026-08-02")!;
    assert.equal(d02.adr, 73.33);
    assert.equal(d02.occPct, 2.5);
    assert.equal(d02.revpar, 1.83);
    assert.equal(d02.goppar, null);
    assert.equal(d02.totalRevenue, 220); // fallback: total = room revenue (same rule as writeDailySnapshot)
  });

  it("mixes sources day by day and labels the window 'snapshots+reservas'", () => {
    const win = realizeDays({
      from: dayUtc("2026-07-15"),
      to: dayUtc("2026-07-18"),
      today: TODAY,
      totalRooms: TOTAL_ROOMS,
      snapshots: [snap("2026-07-16", 100, 12488)],
      reservations: [res("2026-07-15", "2026-07-19", 400)] // 100/night, 4 nights
    });
    assert.equal(win.snapshotDays, 1);
    assert.equal(win.fallbackDays, 3);
    assert.equal(win.source, "snapshots+reservas");
    assert.equal(win.days.get("2026-07-16")?.rooms, 100);
    assert.equal(win.days.get("2026-07-16")?.source, "snapshot");
    assert.equal(win.days.get("2026-07-17")?.rooms, 1);
    assert.equal(win.days.get("2026-07-17")?.source, "reservations");
    const sum = sumRealized(win);
    assert.deepEqual(sum, { rooms: 103, roomRevenue: 12788, days: 4 });
  });

  it("never returns today or the future (clips to yesterday) and is empty for a future window", () => {
    const win = realizeDays({
      from: dayUtc("2026-09-12"),
      to: dayUtc("2026-09-30"),
      today: TODAY,
      totalRooms: TOTAL_ROOMS,
      snapshots: [snap("2026-09-14", 50, 5000)], // "today" snapshot must be ignored
      reservations: [res("2026-09-13", "2026-09-16", 300)]
    });
    assert.equal(win.from, "2026-09-12");
    assert.equal(win.to, "2026-09-13");
    assert.deepEqual([...win.days.keys()], ["2026-09-12", "2026-09-13"]);
    assert.equal(win.days.get("2026-09-13")?.rooms, 1);

    const future = realizeDays({ from: dayUtc("2026-10-01"), to: dayUtc("2026-10-31"), today: TODAY, totalRooms: TOTAL_ROOMS, snapshots: [], reservations: [] });
    assert.equal(future.days.size, 0);
    assert.equal(future.source, null);
    assert.equal(future.from, null);
  });

  it("keeps a zero fallback day in the map so 'closed at 0' differs from 'outside the window'", () => {
    const win = realizeDays({ from: addDays(TODAY, -2), to: addDays(TODAY, -1), today: TODAY, totalRooms: TOTAL_ROOMS, snapshots: [], reservations: [] });
    assert.equal(win.days.size, 2);
    for (const d of win.days.values()) {
      assert.equal(d.source, "reservations");
      assert.equal(d.rooms, 0);
      assert.equal(d.adr, null);
      assert.equal(d.revpar, 0);
    }
  });

  it("realizedSourceLabel", () => {
    assert.equal(realizedSourceLabel(3, 0), "snapshots");
    assert.equal(realizedSourceLabel(3, 2), "snapshots+reservas");
    assert.equal(realizedSourceLabel(0, 2), "reservas");
    assert.equal(realizedSourceLabel(0, 0), null);
  });
});

describe("published BAR — never a default price", () => {
  const win: PublishedBarWindow = {
    ratePlan: { id: "rp_bar", code: "BAR", ratePlanType: "bar" },
    sellableRoomTypeIds: ["rt_dbl", "rt_dsv", "rt_ind"],
    byDate: new Map([["2026-09-20", 95]]),
    byTypeDate: new Map([
      [typeDateKey("rt_dbl", "2026-09-20"), 95],
      [typeDateKey("rt_dsv", "2026-09-20"), 125],
      [typeDateKey("rt_ind", "2026-09-20"), 95]
    ]),
    source: "rate_grid"
  };

  it("returns the lead BAR for a published date and null otherwise", () => {
    assert.equal(publishedBarFor(win, "2026-09-20"), 95);
    assert.equal(publishedBarFor(win, "2026-09-21"), null);
  });

  it("identifies the lead room type(s) that produced the minimum", () => {
    assert.deepEqual(leadRoomTypeIdsFor(win, "2026-09-20"), ["rt_dbl", "rt_ind"]);
    assert.deepEqual(leadRoomTypeIdsFor(win, "2026-09-21"), []);
  });
});

describe("parseMonth — strict YYYY-MM, never an Invalid Date", () => {
  const isBadMonth = (e: unknown) =>
    e instanceof BadRequestError && e.statusCode === 400 && /formato YYYY-MM válido/.test(e.message);

  it("returns the UTC calendar bounds of a valid month (leap February included)", () => {
    const feb = parseMonth("2024-02");
    assert.equal(feb.year, 2024);
    assert.equal(feb.month, 2);
    assert.equal(feb.from.toISOString(), "2024-02-01T00:00:00.000Z");
    assert.equal(feb.to.toISOString(), "2024-02-29T00:00:00.000Z");

    const dec = parseMonth("2026-12");
    assert.equal(dec.month, 12);
    assert.equal(dec.from.toISOString(), "2026-12-01T00:00:00.000Z");
    assert.equal(dec.to.toISOString(), "2026-12-31T00:00:00.000Z");
    assert.equal(parseMonth("2026-01").to.toISOString(), "2026-01-31T00:00:00.000Z");
  });

  it("rejects an out-of-range month of valid shape with a 400 (2024-13, 2024-00)", () => {
    assert.throws(() => parseMonth("2024-13"), isBadMonth);
    assert.throws(() => parseMonth("2024-00"), isBadMonth);
  });

  it("rejects a non-padded month and garbage with a 400", () => {
    assert.throws(() => parseMonth("2024-1"), isBadMonth);
    assert.throws(() => parseMonth("2024-05-01"), isBadMonth);
    assert.throws(() => parseMonth("basura"), isBadMonth);
    assert.throws(() => parseMonth(""), isBadMonth);
    assert.throws(() => parseMonth("2024-05\n"), isBadMonth);
    assert.throws(() => parseMonth(undefined as unknown as string), isBadMonth);
  });
});

describe("backfill-snapshots CLI flags", () => {
  it("parses a full invocation", () => {
    const flags = parseBackfillFlags(["--property", "p1", "--from", "2026-07-15", "--to", "2026-09-13", "--dry-run", "--force", "--json"]);
    assert.deepEqual(flags, { propertyId: "p1", from: "2026-07-15", to: "2026-09-13", dryRun: true, force: true, json: true });
  });
  it("rejects missing/invalid ranges and unknown flags", () => {
    assert.throws(() => parseBackfillFlags(["--from", "2026-07-15"]), /--to/);
    assert.throws(() => parseBackfillFlags(["--from", "2026-09-13", "--to", "2026-07-15"]), /on or after/);
    assert.throws(() => parseBackfillFlags(["--from", "2026-07-15", "--to", "2026-09-13", "--nope"]), /Unknown flag/);
    assert.throws(() => parseBackfillFlags(["--from", "2026-07-15", "--to"]), /requires a value/);
  });
});
