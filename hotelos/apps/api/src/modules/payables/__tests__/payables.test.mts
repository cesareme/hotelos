// Unit tests · payables (Finanzas 2026-09-15, lote proveedores-activos).
// No database: pure helpers (NIF/IBAN, money, bill totals, accrual lines,
// expense lines, VAT period, aging buckets, ledger-line validation). Run from
// apps/api with
//   node --import tsx --test src/modules/payables/__tests__/payables.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calendarYearCode, normalizeLedgerLines } from "../ledger-port.js";
import { daysBetween, dec, isRealIsoDay, money, pct, round2, sum, utcDay } from "../money.js";
import { agingBucketOf, buildAccrualLines, computeBillTotals, defaultPayableAccount } from "../supplier-bills.service.js";
import { buildExpenseLines, computeExpense } from "../expenses.service.js";
import { defaultRetentionRowCode } from "../suppliers.service.js";
import { checkIban, checkSpanishNif, formatIban } from "../validators.js";
import { groupInputVatRows, inputVatAccountFor, taxRateCodeOf, vatPeriodFor } from "../vat-book.js";

const details = (error: unknown): { code?: string } => ((error as { details?: { code?: string } }).details ?? {}) as { code?: string };

describe("NIF / NIE / CIF", () => {
  it("accepts a DNI, a NIE, a K/L/M NIF and a CIF with correct control characters", () => {
    for (const [value, kind, isCompany] of [
      ["12345678Z", "DNI", false],
      ["X1234567L", "NIE", false],
      ["K1234567L", "NIF_SPECIAL", false],
      ["B12345674", "CIF", true],
      ["N1234567D", "CIF", true]
    ] as const) {
      const check = checkSpanishNif(value);
      assert.equal(check.ok, true, `${value}: ${check.ok ? "" : check.message}`);
      if (check.ok) {
        assert.equal(check.kind, kind);
        assert.equal(check.isCompany, isCompany);
      }
    }
  });

  it("normalises separators and the ES prefix", () => {
    const check = checkSpanishNif(" es-b 12.345.674 ");
    assert.equal(check.ok, true);
    if (check.ok) assert.equal(check.value, "B12345674");
  });

  it("rejects a wrong control letter / digit, a wrong CIF control kind, all zeros and garbage with a Spanish message", () => {
    for (const value of ["12345678A", "X1234567A", "B12345670", "B1234567E", "N12345674", "B00000000", "00000000T", "ABC", ""]) {
      const check = checkSpanishNif(value);
      assert.equal(check.ok, false, value);
      if (!check.ok) assert.match(check.message, /NIF|DNI|NIE|CIF|control|ceros|vacío|formato/);
    }
  });
});

describe("IBAN", () => {
  it("accepts a Spanish IBAN with spaces and returns the compact form", () => {
    const check = checkIban("ES91 2100 0418 4502 0005 1332");
    assert.equal(check.ok, true);
    if (check.ok) {
      assert.equal(check.value, "ES9121000418450200051332");
      assert.equal(check.countryCode, "ES");
      assert.equal(formatIban(check.value), "ES91 2100 0418 4502 0005 1332");
    }
  });

  it("rejects a wrong checksum, a wrong national length and a malformed value", () => {
    for (const value of ["ES9121000418450200051333", "ES912100041845020005133", "9121000418450200051332", ""]) {
      const check = checkIban(value);
      assert.equal(check.ok, false, value);
    }
    const short = checkIban("ES912100041845020005133");
    if (!short.ok) assert.match(short.message, /24 caracteres/);
  });
});

describe("money helpers", () => {
  it("rounds half-up to the cent and formats with 2 decimals", () => {
    assert.equal(money(round2("2.345")), "2.35");
    assert.equal(money(round2("2.344")), "2.34");
    assert.equal(money(0.1 + 0.2), "0.30");
    assert.equal(pct("1000", "21").toFixed(2), "210.00");
    assert.equal(pct("33.33", "21").toFixed(2), "7.00");
    assert.equal(sum(["0.10", "0.20", dec(0.3)]).toFixed(2), "0.60");
  });

  it("validates calendar days and counts whole days", () => {
    assert.equal(isRealIsoDay("2026-02-29"), false);
    assert.equal(isRealIsoDay("2028-02-29"), true);
    assert.equal(daysBetween(utcDay("2026-09-15"), utcDay("2026-10-20")), 35);
    assert.equal(calendarYearCode(utcDay("2026-12-31")), "2026");
  });
});

describe("supplier bill totals (per-line rounding, cent-exact totals)", () => {
  it("1.000 € at 21 % with 15 % retention → base 1000.00, IVA 210.00, retención 150.00, total 1060.00", () => {
    const totals = computeBillTotals([{ description: "Honorarios", expenseAccountCode: "623", base: dec(1000), taxRate: dec(21) }], dec(15));
    assert.equal(money(totals.baseTotal), "1000.00");
    assert.equal(money(totals.taxTotal), "210.00");
    assert.equal(money(totals.retentionAmount), "150.00");
    assert.equal(money(totals.total), "1060.00");
    assert.equal(totals.lines[0]!.rateCode, "21");
  });

  it("rounds each line separately (three lines of 33.33 → 7.00 each = 21.00) and sums the rounded quotas", () => {
    const lines = [1, 2, 3].map((n) => ({ description: `L${n}`, expenseAccountCode: "628", base: dec("33.33"), taxRate: dec(21) }));
    const totals = computeBillTotals(lines, null);
    assert.deepEqual(totals.lines.map((l) => money(l.quota)), ["7.00", "7.00", "7.00"]);
    assert.equal(money(totals.taxTotal), "21.00");
    assert.equal(money(totals.total), "120.99");
  });

  it("accepts the supplier's printed quota within ±0.01 and rejects a larger deviation (400 LINE_QUOTA_MISMATCH)", () => {
    const ok = computeBillTotals([{ description: "x", expenseAccountCode: "628", base: dec("10.05"), taxRate: dec(21), quota: dec("2.12") }], null);
    assert.equal(money(ok.taxTotal), "2.12");
    assert.throws(
      () => computeBillTotals([{ description: "x", expenseAccountCode: "628", base: dec("10.05"), taxRate: dec(21), quota: dec("2.50") }], null),
      (error: unknown) => details(error).code === "LINE_QUOTA_MISMATCH"
    );
  });

  it("cross-checks the printed total (400 TOTAL_MISMATCH) and refuses unsupported rates (400 UNSUPPORTED_TAX_RATE)", () => {
    assert.throws(
      () => computeBillTotals([{ description: "x", expenseAccountCode: "628", base: dec(100), taxRate: dec(21) }], null, dec(100)),
      (error: unknown) => details(error).code === "TOTAL_MISMATCH"
    );
    assert.throws(
      () => computeBillTotals([{ description: "x", expenseAccountCode: "628", base: dec(100), taxRate: dec(15) }], null),
      (error: unknown) => details(error).code === "UNSUPPORTED_TAX_RATE"
    );
  });

  it("builds a balanced accrual entry: D 623 / D 472.21 (taxBase) / H 4751 / H 410", () => {
    const totals = computeBillTotals(
      [
        { description: "Honorarios", expenseAccountCode: "623", base: dec(1000), taxRate: dec(21) },
        { description: "Dietas exentas", expenseAccountCode: "629", base: dec(50), taxRate: dec(0) }
      ],
      dec(15)
    );
    const lines = buildAccrualLines(totals, defaultPayableAccount(totals.lines), "Asesor");
    const { totalDebit, totalCredit, lines: normalized } = normalizeLedgerLines(lines);
    assert.equal(money(totalDebit), money(totalCredit));
    assert.equal(money(totalDebit), "1260.00");
    const byCode = Object.fromEntries(normalized.map((l) => [l.accountCode, l]));
    assert.equal(money(byCode["623"]!.debit), "1000.00");
    assert.equal(money(byCode["472.21"]!.debit), "210.00");
    assert.equal(money(byCode["472.21"]!.taxBase!), "1000.00");
    assert.equal(byCode["472.21"]!.taxRateCode, "21");
    assert.equal(money(byCode["4751"]!.credit), "157.50");
    assert.equal(money(byCode["410"]!.credit), "1102.50");
    assert.equal(normalized.some((l) => l.accountCode.startsWith("472.0")), false, "rate 0 produces no quota line");
  });

  it("uses 400 Proveedores when a line is a purchase (60x) and 410 otherwise", () => {
    assert.equal(defaultPayableAccount([{ expenseAccountCode: "601" }, { expenseAccountCode: "628" }]), "400");
    assert.equal(defaultPayableAccount([{ expenseAccountCode: "622" }]), "410");
  });

  it("derives the 111/115 row from the retention rate", () => {
    assert.equal(defaultRetentionRowCode(dec(15)), "02");
    assert.equal(defaultRetentionRowCode(dec(7)), "02");
    assert.equal(defaultRetentionRowCode(dec(19)), "L01");
    assert.equal(defaultRetentionRowCode(dec(0)), null);
  });
});

describe("expenses (tickets)", () => {
  it("a ticket without NIF is never deductible: the quota goes to the expense account", () => {
    const computed = computeExpense({ base: dec(10), taxRate: dec(21) });
    assert.equal(computed.vatDeductible, false);
    assert.equal(money(computed.total), "12.10");
    const lines = buildExpenseLines({ ...computed, accountCode: "629", counterAccountCode: "570", concept: "Taxi", costCenterId: null });
    const { lines: normalized, totalDebit } = normalizeLedgerLines(lines);
    assert.equal(normalized.length, 2);
    assert.equal(money(normalized[0]!.debit), "12.10");
    assert.equal(normalized[0]!.accountCode, "629");
    assert.equal(normalized[1]!.accountCode, "570");
    assert.equal(money(totalDebit), "12.10");
  });

  it("with a supplier NIF the quota is deductible → D 6xx base / D 472.21 quota / H 572 total", () => {
    const computed = computeExpense({ base: dec(100), taxRate: dec(21), supplierNif: "B12345674" });
    assert.equal(computed.vatDeductible, true);
    const lines = buildExpenseLines({ ...computed, accountCode: "628", counterAccountCode: "572", concept: "Material", costCenterId: null });
    const codes = lines.map((l) => l.accountCode);
    assert.deepEqual(codes, ["628", "472.21", "572"]);
    assert.equal(money(normalizeLedgerLines(lines).totalDebit), "121.00");
  });

  it("refuses deductibility without NIF and an invalid NIF", () => {
    assert.throws(() => computeExpense({ base: dec(10), taxRate: dec(21), vatDeductible: true }), (e: unknown) => details(e).code === "EXPENSE_VAT_NOT_DEDUCTIBLE_WITHOUT_NIF");
    assert.throws(() => computeExpense({ base: dec(10), taxRate: dec(21), supplierNif: "B12345670" }), (e: unknown) => details(e).code === "SUPPLIER_NIF_INVALID");
  });
});

describe("VAT book helpers", () => {
  it("maps supported rates to their 472 sub-account and computes the liquidation period", () => {
    assert.equal(taxRateCodeOf(dec(21)), "21");
    assert.equal(taxRateCodeOf(dec("21.00")), "21");
    assert.equal(taxRateCodeOf(dec(5)), null);
    assert.equal(inputVatAccountFor("21"), "472.21");
    assert.equal(inputVatAccountFor("4"), "472.04");
    assert.equal(inputVatAccountFor("7"), "472.07");
    assert.equal(inputVatAccountFor("0"), null);
    assert.equal(vatPeriodFor(utcDay("2026-09-15"), "quarterly"), "2026-Q3");
    assert.equal(vatPeriodFor(utcDay("2026-12-31"), "quarterly"), "2026-Q4");
    assert.equal(vatPeriodFor(utcDay("2026-09-15"), "monthly"), "2026-09");
  });

  it("groups document lines by book and rate summing the rounded amounts", () => {
    const rows = groupInputVatRows([
      { rateCode: "21", base: dec(100), quota: dec(21), retention: dec(15) },
      { rateCode: "21", base: dec(50), quota: dec("10.50"), retention: dec("7.50") },
      { rateCode: "10", base: dec(30), quota: dec(3), retention: dec(0) },
      { rateCode: "21", base: dec(1000), quota: dec(210), retention: dec(0), investmentGood: true }
    ]);
    assert.equal(rows.length, 3);
    const current21 = rows.find((r) => r.rateCode === "21" && !r.investmentGood)!;
    assert.equal(money(current21.base), "150.00");
    assert.equal(money(current21.quota), "31.50");
    assert.equal(money(current21.retention), "22.50");
    assert.equal(rows.find((r) => r.investmentGood)!.rateCode, "21");
  });
});

describe("ledger line validation", () => {
  it("refuses negative amounts, both-sided lines and unbalanced entries with typed 400s", () => {
    assert.throws(() => normalizeLedgerLines([{ accountCode: "600", debit: -1 }, { accountCode: "400", credit: -1 }]), (e: unknown) => details(e).code === "INVALID_LEDGER_LINE");
    assert.throws(() => normalizeLedgerLines([{ accountCode: "600", debit: 1, credit: 1 }, { accountCode: "400", credit: 1 }]), (e: unknown) => details(e).code === "INVALID_LEDGER_LINE");
    assert.throws(() => normalizeLedgerLines([{ accountCode: "600", debit: "10.00" }, { accountCode: "400", credit: "9.99" }]), (e: unknown) => details(e).code === "UNBALANCED_ENTRY");
    assert.throws(() => normalizeLedgerLines([{ accountCode: "600", debit: "10.00" }]), (e: unknown) => details(e).code === "INVALID_LEDGER_LINE");
  });
});

describe("aging buckets", () => {
  it("classifies days past due", () => {
    assert.equal(agingBucketOf(-5), "notDue");
    assert.equal(agingBucketOf(0), "notDue");
    assert.equal(agingBucketOf(1), "d1_30");
    assert.equal(agingBucketOf(30), "d1_30");
    assert.equal(agingBucketOf(31), "d31_60");
    assert.equal(agingBucketOf(60), "d31_60");
    assert.equal(agingBucketOf(61), "d61_90");
    assert.equal(agingBucketOf(90), "d61_90");
    assert.equal(agingBucketOf(91), "d90plus");
  });
});
