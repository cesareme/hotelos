// Unit tests · «¿estaba alojada esa noche?» del cierre del día (Tanda L5 · integrador, INT-L5-01).
// Pure module: no Prisma, no clock. Run from apps/api with
//   node --import tsx --test src/modules/night-audit/__tests__/night-audit-in-house.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstChargeableNight, isInHouseOnNight, notYetInHouseDetail } from "../night-audit-in-house.js";

describe("firstChargeableNight", () => {
  it("without a check-in instant the booked arrival is the first night", () => {
    assert.equal(firstChargeableNight({ arrivalDay: "2026-09-17", checkInDay: null }), "2026-09-17");
  });

  it("a check-in on the arrival day changes nothing; a late check-in still pays from the arrival (room held)", () => {
    assert.equal(firstChargeableNight({ arrivalDay: "2026-09-17", checkInDay: "2026-09-17" }), "2026-09-17");
    assert.equal(firstChargeableNight({ arrivalDay: "2026-09-17", checkInDay: "2026-09-18" }), "2026-09-17");
  });

  it("an early check-in (allowEarlyCheckIn) pays from the night the guest actually slept there", () => {
    assert.equal(firstChargeableNight({ arrivalDay: "2026-09-17", checkInDay: "2026-09-16" }), "2026-09-16");
  });

  it("rejects days that are not ISO YYYY-MM-DD (fail loudly, never charge on a guess)", () => {
    assert.throws(() => firstChargeableNight({ arrivalDay: "17/09/2026", checkInDay: null }), /arrivalDay/);
    assert.throws(() => firstChargeableNight({ arrivalDay: "2026-09-17", checkInDay: "2026-9-16" }), /checkInDay/);
    assert.throws(() => isInHouseOnNight({ arrivalDay: "2026-09-17", checkInDay: null }, "2026-09-17T00:00:00.000Z"), /businessDate/);
  });
});

describe("isInHouseOnNight", () => {
  const arrives17 = { arrivalDay: "2026-09-17", checkInDay: "2026-09-17" };

  it("a retroactive close of a night BEFORE the arrival does not charge the reservation (the OPERA lag case)", () => {
    for (const night of ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]) {
      assert.equal(isInHouseOnNight(arrives17, night), false, night);
    }
  });

  it("the arrival night and every later night are chargeable, including an overstay after the departure", () => {
    assert.equal(isInHouseOnNight(arrives17, "2026-09-17"), true);
    assert.equal(isInHouseOnNight(arrives17, "2026-09-18"), true);
    assert.equal(isInHouseOnNight({ arrivalDay: "2026-09-13", checkInDay: "2026-09-13" }, "2026-09-25"), true, "overstay keeps paying");
  });

  it("an early check-in makes the previous night chargeable", () => {
    assert.equal(isInHouseOnNight({ arrivalDay: "2026-09-17", checkInDay: "2026-09-16" }, "2026-09-16"), true);
    assert.equal(isInHouseOnNight({ arrivalDay: "2026-09-17", checkInDay: "2026-09-16" }, "2026-09-15"), false);
  });

  it("year boundaries compare as dates, not as digits of the month", () => {
    assert.equal(isInHouseOnNight({ arrivalDay: "2026-12-31", checkInDay: null }, "2027-01-01"), true);
    assert.equal(isInHouseOnNight({ arrivalDay: "2027-01-01", checkInDay: null }, "2026-12-31"), false);
  });
});

describe("notYetInHouseDetail", () => {
  it("names the first night in es-ES day/month/year", () => {
    assert.equal(notYetInHouseDetail({ arrivalDay: "2026-09-17", checkInDay: null }), "Aún no alojada esa noche: su primera noche es el 17/09/2026.");
    assert.equal(notYetInHouseDetail({ arrivalDay: "2026-09-17", checkInDay: "2026-09-16" }), "Aún no alojada esa noche: su primera noche es el 16/09/2026.");
  });
});
