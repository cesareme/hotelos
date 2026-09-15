// Unit tests · money helpers and the pure treasury forecast bucketing.
//   node --import tsx --test src/modules/treasury/__tests__/treasury-core.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateProportional, dayUtc, daysBetween, dec, fromCents, money, parseDecimal, percentOf, round2, sameAmount, sum, toCents } from "../money.js";
import { bucketFor, buildForecast } from "../treasury.service.js";

describe("money · Decimal helpers", () => {
  it("never accumulates float drift: 0.1 + 0.2 = 0.30 and 1.005 rounds HALF_UP to 1.01", () => {
    assert.equal(money(dec("0.1").plus(dec("0.2"))), "0.30");
    assert.equal(money(round2(dec("1.005"))), "1.01");
    assert.equal(money(sum([dec("10.10"), dec("20.20"), dec("0.03")])), "30.33");
    assert.equal(money(null), "0.00");
    assert.equal(money(dec(1e-9)), "0.00");
  });

  it("converts cents ↔ decimals exactly and compares to the cent", () => {
    assert.equal(fromCents(123_486).toFixed(2), "1234.86");
    assert.equal(toCents(dec("1234.86")), 123_486);
    assert.equal(sameAmount(dec("10.004"), dec("10")), true);
    assert.equal(sameAmount(dec("10.005"), dec("10")), false);
  });

  it("parses body amounts strictly (comma or dot) and refuses garbage", () => {
    assert.equal(parseDecimal("12,50").toFixed(2), "12.50");
    assert.equal(parseDecimal(7).toFixed(2), "7.00");
    assert.throws(() => parseDecimal("12.5.1"), TypeError);
    assert.throws(() => parseDecimal("abc"), TypeError);
    assert.equal(dec("abc").toFixed(2), "0.00", "lenient reader falls back to 0");
  });

  it("percentOf and allocateProportional square to the cent", () => {
    assert.equal(percentOf(dec("100"), dec("15")).toFixed(2), "15.00");
    assert.equal(percentOf(dec("33.33"), dec("21")).toFixed(2), "7.00");
    const shares = allocateProportional(dec("100.00"), [dec(1), dec(1), dec(1)]);
    assert.deepEqual(
      shares.map((s) => s.toFixed(2)),
      ["33.34", "33.33", "33.33"]
    );
    assert.equal(sum(shares).toFixed(2), "100.00");
    assert.deepEqual(allocateProportional(dec("10"), [dec(0), dec(0)]).map((s) => s.toFixed(2)), ["10.00", "0.00"]);
  });

  it("dayUtc / daysBetween work on calendar days regardless of the time part", () => {
    assert.equal(dayUtc("2026-09-15").toISOString(), "2026-09-15T00:00:00.000Z");
    assert.equal(dayUtc(new Date("2026-09-15T23:59:59Z")).toISOString(), "2026-09-15T00:00:00.000Z");
    assert.equal(daysBetween(new Date("2026-09-20T10:00:00Z"), new Date("2026-09-15T23:00:00Z")), 5);
    assert.throws(() => dayUtc("not a date"), TypeError);
  });
});

describe("forecast · buckets 0-30 / 31-60 / 61-90 / 90+ and overdue", () => {
  const asOf = dayUtc("2026-09-15");

  it("bucketFor places expected dates by distance from asOf", () => {
    assert.equal(bucketFor(asOf, dayUtc("2026-09-14")), "overdue");
    assert.equal(bucketFor(asOf, dayUtc("2026-09-15")), "0-30");
    assert.equal(bucketFor(asOf, dayUtc("2026-10-15")), "0-30");
    assert.equal(bucketFor(asOf, dayUtc("2026-10-16")), "31-60");
    assert.equal(bucketFor(asOf, dayUtc("2026-11-14")), "31-60");
    assert.equal(bucketFor(asOf, dayUtc("2026-11-15")), "61-90");
    assert.equal(bucketFor(asOf, dayUtc("2026-12-14")), "61-90");
    assert.equal(bucketFor(asOf, dayUtc("2026-12-15")), "90+");
  });

  it("projected balance per horizon = opening + inflows − outflows due by then (overdue included in every horizon)", () => {
    const { buckets, horizons } = buildForecast({
      asOf,
      opening: dec("11682.10"),
      inflows: [
        { expectedOn: dayUtc("2026-09-10"), amount: dec("574.00") }, // overdue invoice
        { expectedOn: dayUtc("2026-10-01"), amount: dec("2500.00") },
        { expectedOn: dayUtc("2026-11-20"), amount: dec("300.00") }
      ],
      outflows: [
        { expectedOn: dayUtc("2026-09-20"), amount: dec("1815.00") },
        { expectedOn: dayUtc("2026-10-20"), amount: dec("1573.00") },
        { expectedOn: dayUtc("2026-12-20"), amount: dec("99.99") }
      ]
    });
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b]));
    assert.deepEqual([byLabel.overdue!.inflows, byLabel.overdue!.outflows], ["574.00", "0.00"]);
    assert.deepEqual([byLabel["0-30"]!.inflows, byLabel["0-30"]!.outflows, byLabel["0-30"]!.net], ["2500.00", "1815.00", "685.00"]);
    assert.deepEqual([byLabel["31-60"]!.inflows, byLabel["31-60"]!.outflows], ["0.00", "1573.00"]);
    assert.deepEqual([byLabel["61-90"]!.inflows, byLabel["61-90"]!.outflows], ["300.00", "0.00"]);
    assert.deepEqual([byLabel["90+"]!.inflows, byLabel["90+"]!.outflows], ["0.00", "99.99"]);
    assert.deepEqual(
      horizons.map((h) => [h.days, h.inflows, h.outflows, h.projectedBalance]),
      [
        [30, "3074.00", "1815.00", "12941.10"],
        [60, "3074.00", "3388.00", "11368.10"],
        [90, "3374.00", "3388.00", "11668.10"]
      ]
    );
    assert.equal(byLabel["0-30"]!.from, "2026-09-15");
    assert.equal(byLabel["0-30"]!.to, "2026-10-15");
    assert.equal(byLabel["90+"]!.to, null);
  });
});
