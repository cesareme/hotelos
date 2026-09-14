// Unit tests for computeInvoiceTotals (Tanda 3 · contract B).
//
// Run with Node 22.6+ from the repo root:
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/timestamp/__tests__/ts-loader.mjs \
//     --test packages/compliance/src/spain/__tests__/invoice-totals.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeInvoiceTotals, parseTaxBreakdown, roundMoney } from "../invoice-totals.ts";

const iva = (total, ratePercent, calificacion = "S1") => ({ total, ratePercent, figure: "IVA", impuesto: "01", calificacion });
const igic = (total, ratePercent, calificacion = "S1") => ({ total, ratePercent, figure: "IGIC", impuesto: "03", calificacion });
const ipsi = (total, ratePercent, calificacion = "S1") => ({ total, ratePercent, figure: "IPSI", impuesto: "02", calificacion });

/** taxTotal must equal Σ quota by construction, whatever the lines. */
function assertConsistent(result) {
  const sumQuota = roundMoney(result.breakdown.reduce((s, g) => s + g.quota, 0));
  assert.equal(result.taxTotal, sumQuota, "taxTotal == Σ quotas");
  const sumBasePlusQuota = roundMoney(result.breakdown.reduce((s, g) => s + g.base + g.quota, 0));
  assert.equal(sumBasePlusQuota, result.total, "Σ (base + quota) == total");
}

describe("computeInvoiceTotals — IVA 10 / 21 (Península y Baleares)", () => {
  test("one 10 % accommodation line: 110.00 gross → base 100.00, quota 10.00", () => {
    const r = computeInvoiceTotals([iva(110, 10)]);
    assert.equal(r.total, 110);
    assert.equal(r.taxTotal, 10);
    assert.deepEqual(r.breakdown, [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 100, quota: 10 }]);
    assertConsistent(r);
  });

  test("mixed 10 % and 21 % lines produce two groups ordered by rate desc", () => {
    const r = computeInvoiceTotals([iva(110, 10), iva(24.2, 21), iva(55, 10)]);
    assert.equal(r.total, 189.2);
    assert.deepEqual(r.breakdown, [
      { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 21, base: 20, quota: 4.2 },
      { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 150, quota: 15 }
    ]);
    assert.equal(r.taxTotal, 19.2);
    assertConsistent(r);
  });

  test("rounds per GROUP, not per line (three 0.10 € lines at 21 %)", () => {
    // Per line: 0.10 / 1.21 = 0.0826 → base 0.08, quota 0.02 each → Σ quota 0.06.
    // Per group: 0.30 / 1.21 = 0.2479 → base 0.25, quota 0.05. AEAT validates the group.
    const r = computeInvoiceTotals([iva(0.1, 21), iva(0.1, 21), iva(0.1, 21)]);
    assert.equal(r.total, 0.3);
    assert.equal(r.breakdown.length, 1);
    assert.equal(r.breakdown[0].base, 0.25);
    assert.equal(r.breakdown[0].quota, 0.05);
    assert.equal(r.taxTotal, 0.05);
    assertConsistent(r);
  });

  test("negative lines (full reversal) mirror the original exactly", () => {
    const original = computeInvoiceTotals([iva(110, 10), iva(24.2, 21)]);
    const reversal = computeInvoiceTotals([iva(-110, 10), iva(-24.2, 21)]);
    assert.equal(reversal.total, -original.total);
    assert.equal(reversal.taxTotal, -original.taxTotal);
    for (let i = 0; i < original.breakdown.length; i += 1) {
      assert.equal(reversal.breakdown[i].base, -original.breakdown[i].base);
      assert.equal(reversal.breakdown[i].quota, -original.breakdown[i].quota);
    }
    assertConsistent(reversal);
  });

  test("empty input yields zero totals and an empty breakdown", () => {
    assert.deepEqual(computeInvoiceTotals([]), { total: 0, taxTotal: 0, breakdown: [] });
  });
});

describe("computeInvoiceTotals — IGIC 7 (Canarias, Impuesto 03)", () => {
  test("107.00 gross at 7 % → base 100.00, quota 7.00", () => {
    const r = computeInvoiceTotals([igic(107, 7)]);
    assert.deepEqual(r.breakdown, [{ figure: "IGIC", impuesto: "03", calificacion: "S1", ratePercent: 7, base: 100, quota: 7 }]);
    assert.equal(r.taxTotal, 7);
    assertConsistent(r);
  });

  test("IGIC 7 % and 3 % (transport) stay separate groups", () => {
    const r = computeInvoiceTotals([igic(107, 7), igic(20.6, 3)]);
    assert.equal(r.breakdown.length, 2);
    assert.equal(r.breakdown[0].ratePercent, 7);
    assert.equal(r.breakdown[1].ratePercent, 3);
    assert.equal(r.breakdown[1].base, 20);
    assert.equal(r.breakdown[1].quota, 0.6);
    assertConsistent(r);
  });
});

describe("computeInvoiceTotals — IPSI 2 (Ceuta/Melilla, Impuesto 02)", () => {
  test("102.00 gross at 2 % → base 100.00, quota 2.00", () => {
    const r = computeInvoiceTotals([ipsi(102, 2)]);
    assert.deepEqual(r.breakdown, [{ figure: "IPSI", impuesto: "02", calificacion: "S1", ratePercent: 2, base: 100, quota: 2 }]);
    assert.equal(r.taxTotal, 2);
    assertConsistent(r);
  });

  test("IPSI 2 % hospitality plus 4 % services", () => {
    const r = computeInvoiceTotals([ipsi(102, 2), ipsi(52, 4)]);
    assert.equal(r.total, 154);
    assert.equal(r.taxTotal, 4);
    assert.equal(r.breakdown[0].ratePercent, 4);
    assert.equal(r.breakdown[1].ratePercent, 2);
    assertConsistent(r);
  });
});

describe("computeInvoiceTotals — S1 / N1 mix", () => {
  test("a no-show penalty (N1) contributes its gross to the base with no quota, after the S1 groups", () => {
    const r = computeInvoiceTotals([iva(110, 10), iva(50, 0, "N1")]);
    assert.equal(r.total, 160);
    assert.equal(r.taxTotal, 10);
    assert.deepEqual(r.breakdown, [
      { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 100, quota: 10 },
      { figure: "IVA", impuesto: "01", calificacion: "N1", ratePercent: 0, base: 50, quota: 0 }
    ]);
    assertConsistent(r);
  });

  test("N1 ignores any rate the caller passes (no TipoImpositivo on not-subject operations)", () => {
    const r = computeInvoiceTotals([iva(50, 10, "N1"), iva(25, 21, "N1")]);
    assert.deepEqual(r.breakdown, [{ figure: "IVA", impuesto: "01", calificacion: "N1", ratePercent: 0, base: 75, quota: 0 }]);
    assert.equal(r.taxTotal, 0);
  });

  test("a legacy S1 line at 0 % is kept as its own zero-quota group (blocked later by readiness)", () => {
    const r = computeInvoiceTotals([iva(100, 0), iva(110, 10)]);
    assert.equal(r.taxTotal, 10);
    assert.deepEqual(r.breakdown[1], { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 0, base: 100, quota: 0 });
  });

  test("different impuestos never merge even at the same rate", () => {
    const r = computeInvoiceTotals([iva(104, 4), ipsi(104, 4)]);
    assert.equal(r.breakdown.length, 2);
    assert.equal(r.breakdown[0].impuesto, "01");
    assert.equal(r.breakdown[1].impuesto, "02");
  });

  test("rejects non-finite amounts and negative rates", () => {
    assert.throws(() => computeInvoiceTotals([iva(Number.NaN, 10)]), /finite/);
    assert.throws(() => computeInvoiceTotals([iva(10, -1)]), /ratePercent/);
  });
});

describe("roundMoney", () => {
  test("half away from zero, symmetric, no negative zero", () => {
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(-1.005), -1.01);
    assert.equal(roundMoney(2.5 / 100), 0.03);
    assert.equal(roundMoney(-2.5 / 100), -0.03);
    assert.equal(Object.is(roundMoney(-0.001), 0), true);
  });
});

describe("parseTaxBreakdown", () => {
  test("round-trips a computed breakdown through JSON", () => {
    const r = computeInvoiceTotals([iva(110, 10), iva(50, 0, "N1")]);
    assert.deepEqual(parseTaxBreakdown(JSON.parse(JSON.stringify(r.breakdown))), r.breakdown);
  });

  test("returns [] for null / legacy / malformed values and drops bad groups", () => {
    assert.deepEqual(parseTaxBreakdown(null), []);
    assert.deepEqual(parseTaxBreakdown(undefined), []);
    assert.deepEqual(parseTaxBreakdown({ figure: "IVA" }), []);
    assert.deepEqual(parseTaxBreakdown([{ figure: "VAT", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 1, quota: 0.1 }]), []);
    assert.deepEqual(
      parseTaxBreakdown([{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 1, quota: 0.1 }, "junk"]),
      [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 1, quota: 0.1 }]
    );
  });
});
