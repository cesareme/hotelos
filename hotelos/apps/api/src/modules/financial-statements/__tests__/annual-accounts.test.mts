// Cuentas anuales PGC Pymes over the reference ledger: balance identity,
// P&L model, ECPN reconciliation, memoria notes, and the closed-year case
// (regularization + closing + opening entries) that must NOT change the
// figures. Run from apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/annual-accounts.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { BALANCE_PREFIXES, PYG_PREFIXES, computeBalance, computeEcpn, computeMemoria, computePyg, matchPrefix, mergeBalanceRows, previousPeriodOf } from "../annual-accounts.service.js";
import { addDays, type AccountBalanceRow } from "../source.js";
import { MemorySource, closeReferenceYear, referenceLedger } from "./memory-source.mts";

const YEAR = { from: "2027-01-01", to: "2027-12-31" };

/** Mirror of annual-accounts.service.readLedgerSet: rowsBefore = balance_at(from − 1) + the openings dated inside the period without their closing. */
async function ledgerSet(source: MemorySource, period: { from: string; to: string }, propertyId: string | null = "prop_t") {
  const [rowsAt, before, openingInPeriod, rowsMovements] = await Promise.all([
    source.accountBalances({ organizationId: "org_t", propertyId, mode: "balance_at", to: period.to }),
    source.accountBalances({ organizationId: "org_t", propertyId, mode: "balance_at", to: addDays(period.from, -1) }),
    source.accountBalances({ organizationId: "org_t", propertyId, mode: "opening_in_period", ...period }),
    source.accountBalances({ organizationId: "org_t", propertyId, mode: "movements", ...period })
  ]);
  return { rowsAt, rowsBefore: mergeBalanceRows(before, openingInPeriod), rowsMovements };
}

const lineAmount = (lines: Array<{ id: string; amount: string }>, id: string): string => lines.find((l) => l.id === id)?.amount ?? "∅";

describe("prefix classification", () => {
  it("longest prefix wins and dotted sub-accounts follow their account", () => {
    assert.equal(matchPrefix("477.21", BALANCE_PREFIXES), "C_IV");
    assert.equal(matchPrefix("4700", BALANCE_PREFIXES), "B_II");
    assert.equal(matchPrefix("478", BALANCE_PREFIXES), "C_IV"); // HP por aplazamientos (plan de Sage): deuda aplazada con las AAPP, saldo acreedor (corrector FIX-1)
    assert.equal(matchPrefix("4780000", BALANCE_PREFIXES), "C_IV");
    assert.equal(matchPrefix("4750", BALANCE_PREFIXES), "C_IV");
    assert.equal(matchPrefix("438", BALANCE_PREFIXES), "C_IV"); // anticipos de clientes: liability, not «43 Clientes»
    assert.equal(matchPrefix("2816", BALANCE_PREFIXES), "A_II");
    assert.equal(matchPrefix("5721", BALANCE_PREFIXES), "B_VI");
    assert.equal(matchPrefix("557", BALANCE_PREFIXES), "E_VIII");
    assert.equal(matchPrefix("181", BALANCE_PREFIXES), "L_V");
    assert.equal(matchPrefix("999", BALANCE_PREFIXES), null);
    assert.equal(matchPrefix("705.1", PYG_PREFIXES), "P1");
    assert.equal(matchPrefix("746", PYG_PREFIXES), "P9");
    assert.equal(matchPrefix("768", PYG_PREFIXES), "P16");
    assert.equal(matchPrefix("630", PYG_PREFIXES), "P18");
    assert.equal(matchPrefix("645", PYG_PREFIXES), "P6");
  });

  it("previousPeriodOf keeps the length", () => {
    assert.deepEqual(previousPeriodOf("2027-01-01", "2027-12-31"), { from: "2026-01-01", to: "2026-12-31" });
    assert.deepEqual(previousPeriodOf("2027-03-01", "2027-03-31"), { from: "2027-01-29", to: "2027-02-28" });
  });
});

describe("balance de situación", () => {
  it("cuadra al céntimo with the reference figures (activo 60.184,80 = PN 58.098,00 + pasivo 2.086,80)", async () => {
    const source = referenceLedger();
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...(await ledgerSet(source, YEAR)) });
    assert.equal(balance.balanced, true);
    assert.equal(balance.totalAssets, "60184.80");
    assert.equal(balance.totalEquityAndLiabilities, "60184.80");
    assert.equal(lineAmount(balance.assets.nonCurrent, "A_II"), "11900.00"); // 216 12.000 − 2816 100
    assert.equal(lineAmount(balance.assets.current, "B_II"), "125.80"); // 472.10 4 + 472.21 121,80 (4300 saldada)
    assert.equal(lineAmount(balance.assets.current, "B_VI"), "48159.00"); // 570 176 + 572 47.983
    assert.equal(balance.assets.totalNonCurrent, "11900.00");
    assert.equal(balance.assets.totalCurrent, "48284.80");
    assert.equal(lineAmount(balance.equity.lines, "E_I"), "60000.00");
    assert.equal(lineAmount(balance.equity.lines, "E_VII"), "-1902.00");
    assert.equal(balance.equity.total, "58098.00");
    assert.equal(lineAmount(balance.liabilities.current, "C_IV"), "2086.80"); // 400 44 + 410 716,80 + 476 400 + 4751 150 + 465 750 + 477 26
    assert.equal(balance.liabilities.total, "2086.80");
    assert.equal(balance.periodResult, "-1902.00");
    assert.equal(balance.priorUnregularisedResult, "0.00");
    assert.deepEqual(balance.warnings, []);
    const contra = balance.assets.nonCurrent.find((l) => l.id === "A_II")!.accounts.find((a) => a.code === "2816");
    assert.equal(contra?.amount, "-100.00");
  });

  it("keeps the identity and the result after the year is closed, and carries 129 into the next year", async () => {
    const source = referenceLedger();
    closeReferenceYear(source);
    const closed = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...(await ledgerSet(source, YEAR)) });
    assert.equal(closed.balanced, true);
    assert.equal(closed.totalAssets, "60184.80");
    assert.equal(closed.periodResult, "-1902.00");
    assert.equal(lineAmount(closed.equity.lines, "E_VII"), "-1902.00");
    assert.equal(closed.equity.total, "58098.00");
    const next = { from: "2028-01-01", to: "2028-03-31" };
    const q1 = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: next, ...(await ledgerSet(source, next)) });
    assert.equal(q1.balanced, true);
    assert.equal(q1.totalAssets, "60184.80");
    assert.equal(q1.periodResult, "0.00");
    assert.equal(lineAmount(q1.equity.lines, "E_V"), "-1902.00"); // 129 carried, pending application
    assert.equal(lineAmount(q1.equity.lines, "E_VII"), "0.00");
    assert.equal(q1.priorUnregularisedResult, "0.00");
  });

  it("reports an unregularised prior year in its own equity line, still balanced", async () => {
    const source = referenceLedger();
    const next = { from: "2028-01-01", to: "2028-03-31" }; // 2027 never closed
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: next, ...(await ledgerSet(source, next)) });
    assert.equal(balance.balanced, true);
    assert.equal(balance.priorUnregularisedResult, "-1902.00");
    assert.equal(lineAmount(balance.equity.lines, "E_PR"), "-1902.00");
    assert.equal(balance.periodResult, "0.00");
    assert.match(balance.warnings.join(" "), /sin regularizar/);
  });

  it("presents an unknown code in a visible «sin clasificar» line instead of dropping it", async () => {
    const source = referenceLedger();
    source.account("999", { name: "Cuenta extraña", kind: "asset" });
    source.post({ date: "2027-06-01", propertyId: "prop_t", lines: [{ code: "999", debit: "1.00" }, { code: "572", credit: "1.00" }] });
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...(await ledgerSet(source, YEAR)) });
    assert.equal(balance.balanced, true);
    assert.equal(lineAmount(balance.assets.current, "B_X"), "1.00");
    assert.match(balance.warnings.join(" "), /999/);
  });

  it("fills the comparative column from the previous period", async () => {
    const source = referenceLedger();
    const rows2027 = await ledgerSet(source, YEAR);
    const previous = await ledgerSet(source, previousPeriodOf(YEAR.from, YEAR.to));
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...rows2027, previous });
    assert.equal(balance.equity.lines.find((l) => l.id === "E_I")?.previousAmount, "0.00");
    assert.equal(balance.equity.lines.find((l) => l.id === "E_I")?.amount, "60000.00");
  });
});

describe("asientos revertidos (hallazgo t6#2): la pareja original + reverso no altera los estados", () => {
  const pygOf = async (source: MemorySource, period = YEAR) => {
    const rowsMovements = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", ...period, groups: [6, 7] });
    return computePyg({ organizationId: "org_t", propertyId: "prop_t", period, rowsMovements });
  };
  const balanceOf = async (source: MemorySource, period = YEAR) => computeBalance({ organizationId: "org_t", propertyId: "prop_t", period, ...(await ledgerSet(source, period)) });

  it("an annulled invoice (issue entry reversed by invoice_cancellation, dated the day of the annulment) leaves PyG and balance exactly as without it", async () => {
    const source = referenceLedger();
    const before = { pyg: await pygOf(source), balance: await balanceOf(source) };
    const sale = source.post({
      date: "2027-06-10",
      propertyId: "prop_t",
      sourceType: "invoice",
      sourceId: "inv_9",
      reference: "FAC-2027-000009",
      description: "Factura alojamiento anulada después",
      lines: [{ code: "4300", debit: "242.00" }, { code: "705.1", credit: "200.00", taxRateCode: "21" }, { code: "477.21", credit: "42.00", taxRateCode: "21", taxBase: "200.00" }]
    });
    source.reverse(sale.id!, { date: "2027-06-12", sourceType: "invoice_cancellation", sourceId: "inv_9", description: "Anulación de la factura FAC-2027-000009" });
    const after = { pyg: await pygOf(source), balance: await balanceOf(source) };
    // Before the fix the reversal alone was counted: P1 150 − 200 = −50 and the result 200 lower.
    assert.equal(lineAmount(after.pyg.lines, "P1"), "150.00");
    assert.equal(after.pyg.netResult, "-1902.00");
    assert.deepEqual(after.pyg.lines, before.pyg.lines);
    assert.equal(after.balance.totalAssets, before.balance.totalAssets);
    assert.equal(after.balance.periodResult, "-1902.00");
    assert.equal(after.balance.balanced, true);
    assert.deepEqual(after.balance.warnings, []);
    assert.deepEqual(after.balance.assets, before.balance.assets);
    assert.deepEqual(after.balance.liabilities, before.balance.liabilities);
  });

  it("a recalculated payroll (slip reversed + new slip) counts the new slip only, never the reversal alone", async () => {
    const source = referenceLedger();
    const slip = source.post({
      date: "2027-04-30",
      propertyId: "prop_t",
      sourceType: "payroll_slip",
      sourceId: "slip_a",
      description: "Nómina abril (primer cálculo)",
      lines: [{ code: "640.1", debit: "2000.00" }, { code: "642.1", debit: "610.00" }, { code: "476", credit: "800.00" }, { code: "4751", credit: "300.00" }, { code: "465", credit: "1510.00" }]
    });
    source.reverse(slip.id!, { sourceType: "payroll_slip_reversal", sourceId: "slip_a" });
    source.post({
      date: "2027-04-30",
      propertyId: "prop_t",
      sourceType: "payroll_slip",
      sourceId: "slip_b",
      description: "Nómina abril (recalculada)",
      lines: [{ code: "640.1", debit: "1800.00" }, { code: "642.1", debit: "550.00" }, { code: "476", credit: "720.00" }, { code: "4751", credit: "270.00" }, { code: "465", credit: "1360.00" }]
    });
    const pyg = await pygOf(source);
    // 640.1 1.000 + 642.1 300 + 645 7 (reference) + 1.800 + 550 = 3.657; the buggy reader gave 3.657 − 2.610 = 1.047.
    assert.equal(lineAmount(pyg.lines, "P6"), "-3657.00");
    assert.equal(pyg.netResult, "-4252.00"); // −1.902 − 2.350
    const balance = await balanceOf(source);
    assert.equal(balance.balanced, true);
    assert.equal(balance.periodResult, "-4252.00");
    assert.deepEqual(balance.warnings, []);
    const liabilities = balance.liabilities.current.find((l) => l.id === "C_IV")!.accounts;
    assert.equal(liabilities.find((a) => a.code === "465")?.amount, "2110.00"); // 750 + 1.360
    assert.equal(liabilities.find((a) => a.code === "476")?.amount, "1120.00"); // 400 + 720
    assert.equal(liabilities.find((a) => a.code === "4751")?.amount, "420.00"); // 150 + 270
  });

  it("reopening the year (regularization, closing and opening reversed, never deleted) restores the pre-close figures and leaves the result pending regularization", async () => {
    const source = referenceLedger();
    const open = { pyg: await pygOf(source), balance: await balanceOf(source) };
    closeReferenceYear(source);
    for (const kind of ["regularization", "closing", "opening"] as const) {
      const entry = source.entries.find((e) => e.kind === kind)!;
      source.reverse(entry.id!, { sourceType: "reversal", sourceId: `year-reopen:2027:${kind}:${entry.id}` });
    }
    assert.equal(source.entries.filter((e) => e.kind === "reversal").length, 3);
    const reopened = { pyg: await pygOf(source), balance: await balanceOf(source) };
    assert.deepEqual(reopened.pyg.lines, open.pyg.lines);
    assert.equal(reopened.pyg.netResult, "-1902.00");
    assert.equal(reopened.balance.balanced, true);
    assert.equal(reopened.balance.totalAssets, "60184.80"); // the buggy reader gave the closing reversal on top: doubled balances
    assert.equal(reopened.balance.periodResult, "-1902.00");
    assert.equal(lineAmount(reopened.balance.equity.lines, "E_VII"), "-1902.00");
    assert.equal(lineAmount(reopened.balance.equity.lines, "E_V"), "0.00"); // 129 no longer carried: the regularization is undone
    assert.deepEqual(reopened.balance.warnings, []);
    // 2028 now sees an open 2027: its result is reported as pending regularization, still balanced.
    const next = await balanceOf(source, { from: "2028-01-01", to: "2028-03-31" });
    assert.equal(next.balanced, true);
    assert.equal(next.totalAssets, "60184.80");
    assert.equal(next.priorUnregularisedResult, "-1902.00");
    assert.match(next.warnings.join(" "), /sin regularizar/);
  });

  it("a reversal dated in a later period than its original: both halves leave the statements (same rule as the ledger regularization)", async () => {
    const source = referenceLedger();
    const sale = source.post({ date: "2027-03-20", propertyId: "prop_t", sourceType: "invoice", sourceId: "inv_q1", lines: [{ code: "4300", debit: "121.00" }, { code: "705.1", credit: "100.00" }, { code: "477.21", credit: "21.00" }] });
    source.reverse(sale.id!, { date: "2027-04-05", sourceType: "invoice_cancellation", sourceId: "inv_q1" });
    const q1 = await pygOf(source, { from: "2027-01-01", to: "2027-03-31" });
    const q2 = await pygOf(source, { from: "2027-04-01", to: "2027-06-30" });
    assert.equal(lineAmount(q1.lines, "P1"), "150.00");
    assert.equal(lineAmount(q2.lines, "P1"), "0.00");
    const at = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "balance_at", to: "2027-03-31" });
    assert.equal(at.find((r) => r.code === "4300")?.debit.toFixed(2), "176.00"); // the annulled 121 is not a receivable
  });
});

describe("apertura importada el primer día del ejercicio (A-01/E-01)", () => {
  /**
   * A ledger loaded from another system: its FIRST entry is the opening dated
   * `from` (society-level, like an imported Sage opening) — assets 5.000, 129
   * credit 1.000 (prior result pending application), capital 4.000 — then the
   * application of that result inside the year (129 → 113) and ordinary
   * purchases and sales.
   */
  function importedLedger(): MemorySource {
    const s = new MemorySource("org_t");
    s.post({ date: YEAR.from, kind: "opening", propertyId: null, description: "Apertura importada", lines: [{ code: "572", debit: "5000.00" }, { code: "129", credit: "1000.00" }, { code: "100", credit: "4000.00" }] });
    s.post({ date: "2027-03-10", propertyId: "prop_t", sourceType: "invoice", sourceId: "inv_1", lines: [{ code: "4300", debit: "121.00" }, { code: "705.1", credit: "100.00", taxRateCode: "21" }, { code: "477.21", credit: "21.00", taxRateCode: "21", taxBase: "100.00" }] });
    s.post({ date: "2027-03-15", propertyId: "prop_t", sourceType: "supplier_bill", sourceId: "sb_1", lines: [{ code: "601.1", debit: "40.00" }, { code: "472.10", debit: "4.00", taxRateCode: "10", taxBase: "40.00" }, { code: "400", credit: "44.00" }] });
    s.post({ date: "2027-06-30", propertyId: null, description: "Aplicación del resultado anterior a reservas", lines: [{ code: "129", debit: "1000.00" }, { code: "113", credit: "1000.00" }] });
    return s;
  }

  it("counts the opening dated `from` as opening balance: balance cuadrado, 129 aplicada, reservas dotadas", async () => {
    const source = importedLedger();
    const ledger = await ledgerSet(source, YEAR, null);
    assert.equal(ledger.rowsBefore.find((r) => r.code === "129")?.credit.toFixed(2), "1000.00");
    const balance = computeBalance({ organizationId: "org_t", propertyId: null, period: YEAR, ...ledger });
    assert.equal(balance.balanced, true, `${balance.totalAssets} vs ${balance.totalEquityAndLiabilities}`);
    assert.equal(balance.totalAssets, "5125.00"); // 572 5.000 + 4300 121 + 472.10 4
    assert.equal(balance.totalEquityAndLiabilities, "5125.00");
    assert.ok(["0.00", "∅"].includes(lineAmount(balance.equity.lines, "E_V")), "129 applied inside the year: nothing pending");
    assert.equal(lineAmount(balance.equity.lines, "E_III"), "1000.00");
    assert.equal(lineAmount(balance.equity.lines, "E_I"), "4000.00");
    assert.equal(lineAmount(balance.equity.lines, "E_VII"), "60.00");
    assert.equal(balance.periodResult, "60.00");
    assert.equal(balance.priorUnregularisedResult, "0.00");
    assert.deepEqual(balance.warnings, []);

    // Before the fix: the opening was neither in balance_at(from − 1) nor in movements, only its application was.
    const rowsBeforeWithoutOpening = await source.accountBalances({ organizationId: "org_t", propertyId: null, mode: "balance_at", to: addDays(YEAR.from, -1) });
    const buggy = computeBalance({ organizationId: "org_t", propertyId: null, period: YEAR, ...ledger, rowsBefore: rowsBeforeWithoutOpening });
    assert.equal(buggy.balanced, false);
    assert.equal(buggy.totalEquityAndLiabilities, "4125.00"); // off by the 129 of the opening

    const ecpn = computeEcpn({ organizationId: "org_t", propertyId: null, period: YEAR, ...ledger });
    assert.equal(ecpn.reconciled, true, ecpn.warnings.join("; "));
    const opening = ecpn.rows.find((r) => r.id === "A")!;
    assert.equal(opening.values.priorResults, "1000.00");
    assert.equal(opening.values.capital, "4000.00");
    assert.equal(opening.values.total, "5000.00");
    const closing = ecpn.rows.find((r) => r.id === "C")!;
    assert.equal(closing.values.reserves, "1000.00");
    assert.equal(closing.values.priorResults, "0.00");
    assert.equal(closing.values.periodResult, "60.00");
    assert.equal(closing.values.total, "5060.00");
  });

  it("does not add the opening of a year closed inside the period (periodo a caballo de dos ejercicios)", async () => {
    const source = referenceLedger();
    closeReferenceYear(source); // regularización + cierre 2027-12-31, apertura 2028-01-01
    const period = { from: "2027-07-01", to: "2028-06-30" };
    assert.deepEqual(await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "opening_in_period", ...period }), []);
    const ledger = await ledgerSet(source, period);
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period, ...ledger });
    assert.equal(balance.balanced, true, `${balance.totalAssets} vs ${balance.totalEquityAndLiabilities}`);
    assert.equal(balance.totalAssets, "60184.80"); // closing + opening inside the period net to zero, nothing doubled
    assert.equal(lineAmount(balance.equity.lines, "E_V"), "0.00"); // 129 not carried twice
    assert.equal(balance.periodResult, "0.00");
    assert.equal(balance.priorUnregularisedResult, "-1902.00"); // the 2027 result is booked before `from`
    const ecpn = computeEcpn({ organizationId: "org_t", propertyId: "prop_t", period, ...ledger });
    assert.equal(ecpn.reconciled, true, ecpn.warnings.join("; "));
    assert.equal(ecpn.rows.find((r) => r.id === "A")!.values.priorResults, "0.00");
  });

  it("mergeBalanceRows adds debit and credit by code and keeps the account descriptors", () => {
    const row = (code: string, debit: string, credit: string, name = code): AccountBalanceRow => ({ code, name, kind: "asset", isPostable: true, usaliDepartment: null, usaliLine: null, debit: new Prisma.Decimal(debit), credit: new Prisma.Decimal(credit) });
    const merged = mergeBalanceRows([row("572", "10.00", "0.00", "Bancos"), row("100", "0.00", "5.00")], [row("572", "2.50", "1.00"), row("129", "0.00", "3.00")]);
    assert.deepEqual(merged.map((r) => [r.code, r.name, r.debit.toFixed(2), r.credit.toFixed(2)]), [["100", "100", "0.00", "5.00"], ["129", "129", "0.00", "3.00"], ["572", "Bancos", "12.50", "1.00"]]);
    assert.deepEqual(mergeBalanceRows([], []), []);
  });
});

describe("cuenta de pérdidas y ganancias", () => {
  it("follows the PGC Pymes model and equals ingresos − gastos", async () => {
    const source = referenceLedger();
    const rowsMovements = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", ...YEAR, groups: [6, 7] });
    const pyg = computePyg({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, rowsMovements });
    assert.equal(lineAmount(pyg.lines, "P1"), "150.00");
    assert.equal(lineAmount(pyg.lines, "P4"), "-40.00");
    assert.equal(lineAmount(pyg.lines, "P6"), "-1307.00"); // 640.1 + 642.1 + 645
    assert.equal(lineAmount(pyg.lines, "P7"), "-595.00"); // 621 + 628.1 + 629.1
    assert.equal(lineAmount(pyg.lines, "P8"), "-100.00");
    assert.equal(pyg.operatingResult, "-1892.00");
    assert.equal(lineAmount(pyg.lines, "P14"), "-10.00");
    assert.equal(pyg.financialResult, "-10.00");
    assert.equal(pyg.resultBeforeTax, "-1902.00");
    assert.equal(pyg.incomeTax, "0.00");
    assert.equal(pyg.netResult, "-1902.00");
    assert.equal(pyg.revenueTotal, "150.00");
    assert.equal(pyg.expenseTotal, "2052.00");
    assert.deepEqual(pyg.warnings, []);
    assert.equal(pyg.lines.some((l) => l.id === "P19"), false);
  });

  it("includes the whole last day of the range (hallazgo 33: PyG excluía el último día)", async () => {
    const source = referenceLedger();
    const march = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", from: "2027-03-01", to: "2027-03-31", groups: [6, 7] });
    const pyg = computePyg({ organizationId: "org_t", propertyId: "prop_t", period: { from: "2027-03-01", to: "2027-03-31" }, rowsMovements: march });
    assert.equal(pyg.netResult, "-1902.00"); // every 2027 P&L entry is dated in March, several on the 31st
  });

  it("ignores the regularization entry of a closed year", async () => {
    const source = referenceLedger();
    closeReferenceYear(source);
    const rowsMovements = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", ...YEAR, groups: [6, 7] });
    const pyg = computePyg({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, rowsMovements });
    assert.equal(pyg.netResult, "-1902.00");
  });
});

describe("estado de cambios en el patrimonio neto", () => {
  it("reconciles opening + movements = closing per column", async () => {
    const source = referenceLedger();
    const ecpn = computeEcpn({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...(await ledgerSet(source, YEAR)) });
    assert.equal(ecpn.reconciled, true, ecpn.warnings.join("; "));
    const closing = ecpn.rows.find((r) => r.id === "C")!;
    assert.equal(closing.values.capital, "60000.00");
    assert.equal(closing.values.periodResult, "-1902.00");
    assert.equal(closing.values.total, "58098.00");
    assert.equal(ecpn.rows.find((r) => r.id === "B_II")!.values.capital, "60000.00");
    assert.equal(ecpn.rows.find((r) => r.id === "B_I")!.values.periodResult, "-1902.00");
    assert.equal(ecpn.recognisedIncomeAndExpense.total, "-1902.00");
  });

  it("carries the closed-year result into «resultados de ejercicios anteriores» of the next period", async () => {
    const source = referenceLedger();
    closeReferenceYear(source);
    const next = { from: "2028-01-01", to: "2028-03-31" };
    const ecpn = computeEcpn({ organizationId: "org_t", propertyId: "prop_t", period: next, ...(await ledgerSet(source, next)) });
    assert.equal(ecpn.reconciled, true, ecpn.warnings.join("; "));
    const opening = ecpn.rows.find((r) => r.id === "A")!;
    assert.equal(opening.values.priorResults, "-1902.00");
    assert.equal(opening.values.periodResult, "0.00");
    assert.equal(opening.values.total, "58098.00");
  });
});

describe("memoria", () => {
  it("generates the notes from the data and marks what the ledger cannot know", async () => {
    const source = referenceLedger();
    const ledger = await ledgerSet(source, YEAR);
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...ledger });
    const pyg = computePyg({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, rowsMovements: ledger.rowsMovements });
    const memoria = computeMemoria({
      organizationId: "org_t",
      propertyId: "prop_t",
      period: YEAR,
      identity: source.identity,
      properties: source.props,
      balance,
      pyg,
      ...ledger,
      fixedAssets: [],
      vatTotals: [],
      headcount: null
    });
    assert.equal(memoria.notes.length, 14);
    assert.equal(memoria.entity.taxId, "B12345674");
    const inmovilizado = memoria.notes.find((n) => n.number === 5)!;
    const groups = inmovilizado.figures.groups as Array<{ group: string; cost: { closing: string }; amortization: { charge: string }; netBookValue: string }>;
    const material = groups.find((g) => g.group === "material")!;
    assert.equal(material.cost.closing, "12000.00");
    assert.equal(material.amortization.charge, "100.00");
    assert.equal(material.netBookValue, "11900.00");
    const ingresos = memoria.notes.find((n) => n.number === 10)!;
    assert.equal((ingresos.figures.personnel as { total: string }).total, "1307.00");
    assert.equal(memoria.notes.find((n) => n.number === 3)!.status, "requires_input");
    assert.equal(memoria.notes.find((n) => n.number === 9)!.status, "auto");
    assert.match(memoria.notes.find((n) => n.number === 9)!.text, /Sin registros en los libros de IVA/);
    assert.deepEqual(memoria.warnings, []);
  });
});

describe("balance identity on arbitrary balanced ledgers", () => {
  it("holds for random balanced entries over template accounts", async () => {
    const source = referenceLedger();
    const codes = ["100", "216", "2816", "300", "4300", "400", "410", "4700", "4750", "472.21", "477.21", "570", "572", "5721", "621", "628.1", "705.1", "705.3", "762", "662", "13", "170", "520", "438"];
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 60; i++) {
      const a = codes[Math.floor(rnd() * codes.length)]!;
      const b = codes[Math.floor(rnd() * codes.length)]!;
      if (a === b) continue;
      const amount = (Math.floor(rnd() * 100000) / 100).toFixed(2);
      source.post({ date: `2027-0${1 + (i % 9)}-1${i % 9}`, propertyId: "prop_t", lines: [{ code: a, debit: amount }, { code: b, credit: amount }] });
    }
    const balance = computeBalance({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, ...(await ledgerSet(source, YEAR)) });
    assert.equal(balance.balanced, true, `${balance.totalAssets} vs ${balance.totalEquityAndLiabilities}`);
    const rows: AccountBalanceRow[] = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", ...YEAR, groups: [6, 7] });
    const pyg = computePyg({ organizationId: "org_t", propertyId: "prop_t", period: YEAR, rowsMovements: rows });
    assert.equal(pyg.netResult, balance.periodResult);
  });
});
