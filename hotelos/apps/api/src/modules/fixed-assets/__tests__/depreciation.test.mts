// Unit tests · fixed assets and depreciation (Finanzas 2026-09-15).
// No database: LIS coefficient tables, account defaults, the monthly amount
// rule (full month, first-month proration by days, last-cent adjustment,
// residual value), the no-gaps rule of the monthly chain (pending periods),
// run journal lines and disposal lines. Run from apps/api with
//   node --import tsx --test src/modules/fixed-assets/__tests__/depreciation.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLedgerLines } from "../../payables/ledger-port.js";
import { dec, money, utcDay } from "../../payables/money.js";
import { buildDepreciationLines, currentPeriod, depreciationForPeriod, nextPeriod, pendingPeriodsBefore, periodBounds, periodOf, previousPeriod } from "../depreciation.service.js";
import { assertCoefficient, assetDefaultsForAccount, buildDisposalLines, fullMonthQuota, LIS_MAX_COEFFICIENT_PCT, resolveAssetConfig } from "../fixed-assets.service.js";

const details = (error: unknown): { code?: string } => ((error as { details?: { code?: string } }).details ?? {}) as { code?: string };

describe("coefficients (tablas art. 12 LIS)", () => {
  it("caps by category: mobiliario 10, instalaciones 10, informática 25, construcciones 3, vehículos 16", () => {
    assert.equal(LIS_MAX_COEFFICIENT_PCT.mobiliario, "10");
    assert.equal(LIS_MAX_COEFFICIENT_PCT.instalaciones, "10");
    assert.equal(LIS_MAX_COEFFICIENT_PCT.informatica, "25");
    assert.equal(LIS_MAX_COEFFICIENT_PCT.construcciones, "3");
    assert.equal(LIS_MAX_COEFFICIENT_PCT.vehiculos, "16");
    assert.equal(assertCoefficient("mobiliario", dec(10)).toFixed(2), "10.00");
    assert.throws(() => assertCoefficient("mobiliario", dec("10.01")), (e: unknown) => details(e).code === "COEFFICIENT_ABOVE_MAX");
    assert.throws(() => assertCoefficient("construcciones", dec(4)), (e: unknown) => details(e).code === "COEFFICIENT_ABOVE_MAX");
  });

  it("derives category / accounts / coefficient from the asset account and vice versa", () => {
    assert.deepEqual(assetDefaultsForAccount("216"), { category: "mobiliario", coefficientPct: "10", depreciationAccountCode: "2816", expenseAccountCode: "681" });
    assert.equal(assetDefaultsForAccount("2170")?.category, "informatica");
    assert.equal(assetDefaultsForAccount("206")?.expenseAccountCode, "680");
    assert.equal(assetDefaultsForAccount("430"), null);
    const fromCategory = resolveAssetConfig({ category: "vehiculos" });
    assert.deepEqual(fromCategory, { category: "vehiculos", accountCode: "218", depreciationAccountCode: "2818", expenseAccountCode: "681", coefficientPct: dec(16) });
    const fromAccount = resolveAssetConfig({ accountCode: "211", coefficientPct: dec(2) });
    assert.equal(fromAccount.category, "construcciones");
    assert.equal(fromAccount.coefficientPct.toFixed(2), "2.00");
    assert.throws(() => resolveAssetConfig({}), (e: unknown) => details(e).code === "ASSET_CATEGORY_REQUIRED");
    assert.throws(() => resolveAssetConfig({ category: "otro" }), (e: unknown) => details(e).code === "COEFFICIENT_REQUIRED");
    assert.throws(() => resolveAssetConfig({ accountCode: "216", coefficientPct: dec(12) }), (e: unknown) => details(e).code === "COEFFICIENT_ABOVE_MAX");
  });
});

describe("monthly depreciation (prorrateo mensual)", () => {
  const base = { acquisitionCost: dec(12000), residualValue: dec(0), coefficientPct: dec(10), accumulatedDepreciation: dec(0), startDate: utcDay("2025-01-01") };

  it("12.000 € de mobiliario al 10 % → 100,00 € al mes; 12 meses → 1.200,00 €", () => {
    assert.equal(money(fullMonthQuota(dec(12000), dec(0), dec(10))), "100.00");
    let accumulated = dec(0);
    for (let month = 1; month <= 12; month += 1) {
      const bounds = periodBounds(`2025-${String(month).padStart(2, "0")}`);
      const result = depreciationForPeriod({ ...base, accumulatedDepreciation: accumulated }, bounds);
      assert.equal(money(result.amount), "100.00", bounds.period);
      accumulated = result.accumulatedAfter;
    }
    assert.equal(money(accumulated), "1200.00");
  });

  it("prorates the first month by days in service (start on the 16th of a 30-day month → 15/30)", () => {
    const result = depreciationForPeriod({ ...base, startDate: utcDay("2025-09-16") }, periodBounds("2025-09"));
    assert.equal(money(result.amount), "50.00");
    const next = depreciationForPeriod({ ...base, startDate: utcDay("2025-09-16"), accumulatedDepreciation: result.accumulatedAfter }, periodBounds("2025-10"));
    assert.equal(money(next.amount), "100.00");
    const before = depreciationForPeriod({ ...base, startDate: utcDay("2025-09-16") }, periodBounds("2025-08"));
    assert.equal(money(before.amount), "0.00");
    assert.match(before.reason ?? "", /funcionamiento/);
  });

  it("closes the element to the cent: 1.000 € al 25 % → 20,83 × 47 + 20,99 (acumulado + residual = coste)", () => {
    let accumulated = dec(0);
    let months = 0;
    let last = dec(0);
    for (let year = 2020; year < 2030 && accumulated.lt(dec(1000)); year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const result = depreciationForPeriod({ acquisitionCost: dec(1000), residualValue: dec(0), coefficientPct: dec(25), accumulatedDepreciation: accumulated, startDate: utcDay("2020-01-01") }, periodBounds(`${year}-${String(month).padStart(2, "0")}`));
        if (result.amount.isZero()) break;
        months += 1;
        last = result.amount;
        accumulated = result.accumulatedAfter;
      }
    }
    assert.equal(months, 48);
    assert.equal(money(last), "20.99");
    assert.equal(money(accumulated), "1000.00");
    const done = depreciationForPeriod({ acquisitionCost: dec(1000), residualValue: dec(0), coefficientPct: dec(25), accumulatedDepreciation: accumulated, startDate: utcDay("2020-01-01") }, periodBounds("2024-01"));
    assert.equal(money(done.amount), "0.00");
    assert.match(done.reason ?? "", /totalmente amortizado/);
  });

  it("respects the residual value and skips non-depreciable / disposed elements", () => {
    const withResidual = depreciationForPeriod({ ...base, residualValue: dec(2400) }, periodBounds("2025-01"));
    assert.equal(money(withResidual.amount), "80.00");
    assert.equal(money(withResidual.netBookValueAfter), "11920.00");
    const land = depreciationForPeriod({ ...base, coefficientPct: dec(0) }, periodBounds("2025-01"));
    assert.equal(money(land.amount), "0.00");
    const disposed = depreciationForPeriod({ ...base, disposedAt: utcDay("2024-12-31") }, periodBounds("2025-01"));
    assert.equal(money(disposed.amount), "0.00");
  });

  it("period helpers", () => {
    const feb = periodBounds("2028-02");
    assert.equal(feb.daysInMonth, 29);
    assert.equal(feb.end.toISOString().slice(0, 10), "2028-02-29");
    assert.equal(previousPeriod("2026-01"), "2025-12");
    assert.equal(nextPeriod("2025-12"), "2026-01");
    assert.equal(nextPeriod("2026-02"), "2026-03");
    assert.equal(periodOf(utcDay("2025-09-16")), "2025-09");
    assert.match(currentPeriod(new Date("2026-09-15T10:00:00Z")), /^2026-09$/);
    assert.throws(() => periodBounds("2026-13"), (e: unknown) => details(e).code === "PERIOD_INVALID");
    assert.throws(() => nextPeriod("2026-13"), (e: unknown) => details(e).code === "PERIOD_INVALID");
  });
});

describe("pending periods (corridas mes a mes, sin huecos · t6#12)", () => {
  // 12.000 € de mobiliario al 10 % en servicio desde 2025-01-01 (100,00 €/mes).
  const camas = { acquisitionCost: dec(12000), residualValue: dec(0), coefficientPct: dec(10), accumulatedDepreciation: dec(1200), startDate: utcDay("2025-01-01") };

  it("after 2025-01..12, 2026-03 needs 2026-01 and 2026-02 first (the repro of t6#12); 2026-01 needs nothing", () => {
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-03", latestPostedPeriod: "2025-12", elements: [camas] }), ["2026-01", "2026-02"]);
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-01", latestPostedPeriod: "2025-12", elements: [camas] }), []);
  });

  it("a reversed last run reopens the gap: latest posted 2025-11 → 2026-01 needs 2025-12", () => {
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-01", latestPostedPeriod: "2025-11", elements: [{ ...camas, accumulatedDepreciation: dec(1100) }] }), ["2025-12"]);
    assert.deepEqual(pendingPeriodsBefore({ period: "2025-12", latestPostedPeriod: "2025-11", elements: [{ ...camas, accumulatedDepreciation: dec(1100) }] }), []);
  });

  it("first run of the organisation: the chain starts at the earliest start date of the elements", () => {
    const fresh = { ...camas, accumulatedDepreciation: dec(0) };
    assert.deepEqual(pendingPeriodsBefore({ period: "2025-03", latestPostedPeriod: null, elements: [fresh] }), ["2025-01", "2025-02"]);
    assert.deepEqual(pendingPeriodsBefore({ period: "2025-01", latestPostedPeriod: null, elements: [fresh] }), []);
    const portatil = { acquisitionCost: dec(1000), residualValue: dec(0), coefficientPct: dec(25), accumulatedDepreciation: dec(0), startDate: utcDay("2024-11-15") };
    assert.deepEqual(pendingPeriodsBefore({ period: "2025-02", latestPostedPeriod: null, elements: [fresh, portatil] }), ["2024-11", "2024-12", "2025-01"]);
  });

  it("months in which no element would depreciate are not required (start mid-gap, fully depreciated, disposed, no coefficient)", () => {
    const portatil = { acquisitionCost: dec(1000), residualValue: dec(0), coefficientPct: dec(25), accumulatedDepreciation: dec(0), startDate: utcDay("2026-02-10") };
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-04", latestPostedPeriod: "2025-12", elements: [portatil] }), ["2026-02", "2026-03"]);
    const done = { ...camas, accumulatedDepreciation: dec(12000) };
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-03", latestPostedPeriod: "2025-12", elements: [done] }), []);
    const disposed = { ...camas, disposedAt: utcDay("2025-12-31") };
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-03", latestPostedPeriod: "2025-12", elements: [disposed] }), []);
    const terreno = { ...camas, coefficientPct: dec(0) };
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-03", latestPostedPeriod: "2025-12", elements: [terreno] }), []);
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-03", latestPostedPeriod: "2025-12", elements: [] }), []);
    assert.deepEqual(pendingPeriodsBefore({ period: "2026-03", latestPostedPeriod: null, elements: [] }), []);
  });

  it("a period at or before the chain anchor never has pending months and an invalid period is a 400", () => {
    assert.deepEqual(pendingPeriodsBefore({ period: "2025-06", latestPostedPeriod: "2025-12", elements: [camas] }), []);
    assert.throws(() => pendingPeriodsBefore({ period: "2026-13", latestPostedPeriod: null, elements: [camas] }), (e: unknown) => details(e).code === "PERIOD_INVALID");
  });
});

describe("journal lines", () => {
  it("a run posts D 681 / H 2816 per element and balances", () => {
    const lines = buildDepreciationLines(
      [
        { name: "Camas", expenseAccountCode: "681", depreciationAccountCode: "2816", amount: dec(100) },
        { name: "Servidor", expenseAccountCode: "681", depreciationAccountCode: "2817", amount: dec("20.83") }
      ],
      "2025-01"
    );
    const { totalDebit, totalCredit, lines: normalized } = normalizeLedgerLines(lines);
    assert.equal(money(totalDebit), "120.83");
    assert.equal(money(totalCredit), "120.83");
    assert.deepEqual(normalized.map((l) => l.accountCode), ["681", "2816", "681", "2817"]);
  });

  it("a disposal with a loss: D 2816 accumulated / D 671 loss / D 572 sale / H 216 cost", () => {
    const lines = buildDisposalLines({ name: "Camas", accountCode: "216", depreciationAccountCode: "2816", acquisitionCost: dec(12000), accumulatedDepreciation: dec(1100), saleAmount: dec(5000), counterAccountCode: "572" });
    const { totalDebit, totalCredit, lines: normalized } = normalizeLedgerLines(lines);
    assert.equal(money(totalDebit), "12000.00");
    assert.equal(money(totalCredit), "12000.00");
    const byCode = Object.fromEntries(normalized.map((l) => [l.accountCode, l]));
    assert.equal(money(byCode["2816"]!.debit), "1100.00");
    assert.equal(money(byCode["671"]!.debit), "5900.00");
    assert.equal(money(byCode["572"]!.debit), "5000.00");
    assert.equal(money(byCode["216"]!.credit), "12000.00");
  });

  it("a disposal with a gain credits 771 and a scrapping with full depreciation has no result line", () => {
    const gain = normalizeLedgerLines(buildDisposalLines({ name: "x", accountCode: "217", depreciationAccountCode: "2817", acquisitionCost: dec(1000), accumulatedDepreciation: dec(1000), saleAmount: dec(50), counterAccountCode: "570" }));
    assert.equal(money(gain.lines.find((l) => l.accountCode === "771")!.credit), "50.00");
    assert.equal(money(gain.totalDebit), "1050.00");
    const scrap = normalizeLedgerLines(buildDisposalLines({ name: "x", accountCode: "217", depreciationAccountCode: "2817", acquisitionCost: dec(1000), accumulatedDepreciation: dec(1000), saleAmount: dec(0), counterAccountCode: "572" }));
    assert.deepEqual(scrap.lines.map((l) => l.accountCode), ["2817", "217"]);
  });
});
