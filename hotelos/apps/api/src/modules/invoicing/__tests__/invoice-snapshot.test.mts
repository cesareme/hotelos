// Unit tests of the invoice snapshot / PGC journal helpers (finanzas · lote
// facturación-cobros). Pure: no database. Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/invoice-snapshot.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { computeInvoiceTotals, type TaxBreakdownGroup } from "@hotelos/compliance";
import {
  buildCashSaleJournalLines,
  buildInvoiceJournalLines,
  buildInvoiceSnapshot,
  buildVatBookRows,
  customerRequiredFor,
  folioLinesFingerprint,
  parseInvoiceSnapshot,
  revenueAccountForLine,
  simplifiedInvoiceLimit,
  splitGroupBaseByAccount,
  vatAccountForGroup
} from "../invoice-snapshot.js";
import { assertLedgerBalanced, type LedgerLineInput } from "../ledger.port.js";
import { vatPeriodFor } from "../vat-book.js";

const D = PrismaRuntime.Decimal;

type Line = { description: string; quantity: number; unitPrice: number; total: number; taxCode: string; taxRate: number; taxCategory: string | null; taxCalificacion: string; taxFigure: string };

function line(description: string, total: number, taxRate: number, taxCategory: string | null, calificacion: "S1" | "N1" = "S1"): Line {
  return { description, quantity: 1, unitPrice: total, total, taxCode: `ES_IVA_${calificacion === "N1" ? "N1" : taxRate}`, taxRate, taxCategory, taxCalificacion: calificacion, taxFigure: "IVA" };
}

function breakdownOf(lines: Line[]): TaxBreakdownGroup[] {
  return computeInvoiceTotals(lines.map((l) => ({ total: l.total, ratePercent: l.taxRate, figure: "IVA", impuesto: "01", calificacion: l.taxCalificacion as "S1" | "N1" }))).breakdown;
}

function sums(lines: LedgerLineInput[]): { debit: string; credit: string } {
  const debit = lines.reduce((s, l) => s.plus(new D(l.debit)), new D(0));
  const credit = lines.reduce((s, l) => s.plus(new D(l.credit)), new D(0));
  return { debit: debit.toFixed(2), credit: credit.toFixed(2) };
}

function snapshotOf(lines: Line[]) {
  const totals = computeInvoiceTotals(lines.map((l) => ({ total: l.total, ratePercent: l.taxRate, figure: "IVA", impuesto: "01", calificacion: l.taxCalificacion as "S1" | "N1" })));
  return buildInvoiceSnapshot({
    issuedAt: new Date("2026-09-15T10:00:00.000Z"),
    currencyCode: "EUR",
    lines,
    totals: { total: totals.total, taxTotal: totals.taxTotal },
    breakdown: totals.breakdown,
    folioLineIds: ["fl_1"],
    issuer: { taxId: "B12345674", legalName: "Grupo Hotelero Demo SL" },
    customer: { type: "guest", taxId: null, name: "María Pérez" }
  });
}

describe("revenueAccountForLine / vatAccountForGroup — PGC mapping", () => {
  it("maps fiscal categories to the hotel sub-accounts", () => {
    assert.equal(revenueAccountForLine({ taxCategory: "accommodation" }), "705.1");
    assert.equal(revenueAccountForLine({ taxCategory: "food_beverage" }), "705.2");
    assert.equal(revenueAccountForLine({ taxCategory: "general_services" }), "705.3");
    assert.equal(revenueAccountForLine({ taxCategory: "tourist_tax" }), "4759");
    assert.equal(revenueAccountForLine({ taxCategory: null }), "705");
  });

  it("maps rates to 477.xx and skips N1 / 0 %", () => {
    assert.equal(vatAccountForGroup({ calificacion: "S1", ratePercent: 21 }), "477.21");
    assert.equal(vatAccountForGroup({ calificacion: "S1", ratePercent: 10 }), "477.10");
    assert.equal(vatAccountForGroup({ calificacion: "S1", ratePercent: 4 }), "477.04");
    assert.equal(vatAccountForGroup({ calificacion: "S1", ratePercent: 7 }), "477.07");
    assert.equal(vatAccountForGroup({ calificacion: "N1", ratePercent: 0 }), null);
    assert.equal(vatAccountForGroup({ calificacion: "S1", ratePercent: 0 }), null);
    assert.equal(vatAccountForGroup({ calificacion: "S1", ratePercent: 0.5 }), "477");
  });
});

describe("buildInvoiceJournalLines — D 4300 / H 705.x / H 477.tipo, balanced to the cent", () => {
  it("FAC 215,50 €: 21 % base 34,71 + cuota 7,29; 10 % base 139,55 + cuota 13,95; N1 20,00 (the audited FAC-2026-000016 case)", () => {
    // 42,00 at 21 % (minibar F&B), 153,50 at 10 % (room), 20,00 not subject (penalty).
    const lines = [line("Minibar", 42, 21, "food_beverage"), line("Habitación", 153.5, 10, "accommodation"), line("Penalización no-show", 20, 0, "not_subject", "N1")];
    const snapshot = snapshotOf(lines);
    assert.equal(snapshot.totals.total, 215.5);
    assert.equal(snapshot.totals.taxTotal, 21.24);
    assert.equal(snapshot.totals.baseTotal, 194.26);
    const journal = buildInvoiceJournalLines(snapshot, "FAC-2026-000016");
    assert.equal(sums(journal).debit, "215.50");
    assert.equal(sums(journal).credit, "215.50");
    assert.doesNotThrow(() => assertLedgerBalanced(journal));
    const by = (code: string) => journal.filter((l) => l.accountCode === code);
    assert.equal(by("4300")[0]!.debit, "215.50");
    assert.equal(by("705.2")[0]!.credit, "34.71");
    assert.equal(by("477.21")[0]!.credit, "7.29");
    assert.equal(by("477.21")[0]!.taxBase, "34.71");
    assert.equal(by("477.21")[0]!.taxRateCode, "21");
    assert.equal(by("705.1")[0]!.credit, "139.55");
    assert.equal(by("477.10")[0]!.credit, "13.95");
    assert.equal(by("705.3")[0]!.credit, "20.00");
    assert.equal(by("705.3")[0]!.taxRateCode, "0");
    assert.equal(journal.filter((l) => l.accountCode.startsWith("477")).length, 2);
  });

  it("squares the department split to the group base when per-account rounding drifts a cent", () => {
    // Three accounts in the same 21 % group whose rounded bases do not add up to the group base.
    const lines = [line("A", 10.01, 21, "accommodation"), line("B", 10.01, 21, "food_beverage"), line("C", 10.01, 21, "general_services")];
    const group = breakdownOf(lines)[0]!;
    const split = splitGroupBaseByAccount(group, lines.map((l) => ({ total: l.total, revenueAccountCode: revenueAccountForLine(l) })));
    const assigned = Array.from(split.values()).reduce((s, v) => s.plus(v), new D(0));
    assert.equal(assigned.toFixed(2), new D(group.base).toFixed(2));
    const journal = buildInvoiceJournalLines(snapshotOf(lines), "FAC-X");
    assert.equal(sums(journal).debit, sums(journal).credit);
    assert.equal(sums(journal).debit, "30.03");
  });

  it("tourist tax lines credit 4759, never revenue", () => {
    const lines = [line("Habitación", 110, 10, "accommodation"), line("Tasa turística", 2.2, 10, "tourist_tax")];
    const journal = buildInvoiceJournalLines(snapshotOf(lines), "FAC-T");
    const tax = journal.find((l) => l.accountCode === "4759");
    assert.ok(tax);
    assert.equal(tax.credit, "2.00");
    assert.equal(sums(journal).debit, "112.20");
    assert.equal(sums(journal).credit, "112.20");
  });

  it("a credit rectificativa (negative totals) flips every line to the opposite side with positive amounts", () => {
    const lines = [line("Reversión: Habitación", -110, 10, "accommodation")];
    const snapshot = snapshotOf(lines);
    assert.equal(snapshot.totals.total, -110);
    assert.equal(snapshot.totals.taxTotal, -10);
    const journal = buildInvoiceJournalLines(snapshot, "REC-2026-000001");
    for (const l of journal) {
      assert.ok(new D(l.debit).greaterThanOrEqualTo(0) && new D(l.credit).greaterThanOrEqualTo(0), `line ${l.accountCode} must be positive`);
    }
    assert.equal(journal.find((l) => l.accountCode === "4300")!.credit, "110.00");
    assert.equal(journal.find((l) => l.accountCode === "705.1")!.debit, "100.00");
    assert.equal(journal.find((l) => l.accountCode === "477.10")!.debit, "10.00");
    assert.equal(sums(journal).debit, "110.00");
    assert.equal(sums(journal).credit, "110.00");
  });

  it("cash sale (TPV): D 570 / H 705.2 / H 477.10, no 4300", () => {
    const lines = [line("Café", 2.5, 10, "food_beverage"), line("Bocadillo", 6.6, 10, "food_beverage")];
    const journal = buildCashSaleJournalLines(snapshotOf(lines), "570", "SIM-2026-000001");
    assert.ok(!journal.some((l) => l.accountCode === "4300"));
    assert.equal(journal.find((l) => l.accountCode === "570")!.debit, "9.10");
    assert.equal(journal.find((l) => l.accountCode === "705.2")!.credit, "8.27");
    assert.equal(journal.find((l) => l.accountCode === "477.10")!.credit, "0.83");
    assert.equal(sums(journal).credit, "9.10");
  });
});

describe("buildVatBookRows — one row per rate, signs of the document", () => {
  it("merges N1 and 0 % into a single 0 % row and sorts rates descending", () => {
    const breakdown = breakdownOf([line("A", 121, 21, "accommodation"), line("B", 20, 0, "not_subject", "N1"), line("C", 55, 10, "food_beverage")]);
    const rows = buildVatBookRows(breakdown);
    assert.deepEqual(
      rows.map((r) => [r.rate, r.base, r.quota, r.total]),
      [
        [21, 100, 21, 121],
        [10, 50, 5, 55],
        [0, 20, 0, 20]
      ]
    );
  });

  it("keeps negative amounts on a credit rectificativa", () => {
    const rows = buildVatBookRows(breakdownOf([line("Reversión", -110, 10, "accommodation")]));
    assert.deepEqual(rows, [{ rate: 10, base: -100, quota: -10, total: -110, taxFigure: "IVA" }]);
  });
});

describe("assertLedgerBalanced", () => {
  it("rejects an unbalanced entry and negative lines", () => {
    assert.throws(() => assertLedgerBalanced([{ accountCode: "570", debit: "10.00", credit: "0.00" }, { accountCode: "4300", debit: "0.00", credit: "9.99" }]), /no cuadra/);
    assert.throws(() => assertLedgerBalanced([{ accountCode: "570", debit: "-10.00", credit: "0.00" }, { accountCode: "4300", debit: "0.00", credit: "-10.00" }]), /negativo/);
    assert.throws(() => assertLedgerBalanced([{ accountCode: "570", debit: "5.00", credit: "5.00" }, { accountCode: "4300", debit: "0.00", credit: "0.00" }]), /debe y haber/);
  });
});

describe("simplified invoice limits (art. 4 RD 1619/2012)", () => {
  it("400 € for a hotel folio, 3.000 € for pure F&B sales", () => {
    assert.equal(simplifiedInvoiceLimit([{ taxCategory: "accommodation" }]), 400);
    assert.equal(simplifiedInvoiceLimit([{ taxCategory: "food_beverage" }, { taxCategory: "food_beverage" }]), 3000);
    assert.equal(simplifiedInvoiceLimit([{ taxCategory: "food_beverage" }, { taxCategory: "accommodation" }]), 400);
    assert.equal(simplifiedInvoiceLimit([]), 400);
  });

  it("customerRequiredFor: F1 always, F2 above the limit", () => {
    assert.deepEqual(customerRequiredFor({ invoiceType: "F1", total: 10, lines: [] }), { required: true, limit: null });
    assert.deepEqual(customerRequiredFor({ invoiceType: "F2", total: 399.99, lines: [{ taxCategory: "accommodation" }] }), { required: false, limit: 400 });
    assert.deepEqual(customerRequiredFor({ invoiceType: "F2", total: 400.01, lines: [{ taxCategory: "accommodation" }] }), { required: true, limit: 400 });
    assert.deepEqual(customerRequiredFor({ invoiceType: "F2", total: 2999, lines: [{ taxCategory: "food_beverage" }] }), { required: false, limit: 3000 });
  });
});

describe("folioLinesFingerprint — freeze the folio at draft time", () => {
  const base = [
    { id: "b", description: "Habitación", quantity: 1, unitPrice: 110, total: 110, taxCategory: null, type: "room" },
    { id: "a", description: "Minibar", quantity: "2", unitPrice: "3.5", total: "7", taxCategory: "food_beverage", type: "minibar" }
  ];
  it("is order-independent and stable", () => {
    assert.equal(folioLinesFingerprint(base), folioLinesFingerprint([...base].reverse()));
    assert.equal(folioLinesFingerprint(base), folioLinesFingerprint(base.map((l) => ({ ...l, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), total: Number(l.total) }))));
  });
  it("changes when a line is added, removed or edited", () => {
    const fp = folioLinesFingerprint(base);
    assert.notEqual(fp, folioLinesFingerprint(base.slice(1)));
    assert.notEqual(fp, folioLinesFingerprint([...base, { id: "c", description: "Parking", quantity: 1, unitPrice: 12, total: 12 }]));
    assert.notEqual(fp, folioLinesFingerprint(base.map((l) => (l.id === "b" ? { ...l, total: 111 } : l))));
  });
});

describe("parseInvoiceSnapshot / vatPeriodFor", () => {
  it("accepts only issued v1 snapshots", () => {
    assert.equal(parseInvoiceSnapshot(null), null);
    assert.equal(parseInvoiceSnapshot({ version: 1, status: "draft", folioLineIds: [], folioFingerprint: "x" }), null);
    const snapshot = snapshotOf([line("A", 10, 21, "accommodation")]);
    assert.deepEqual(parseInvoiceSnapshot(JSON.parse(JSON.stringify(snapshot))), JSON.parse(JSON.stringify(snapshot)));
  });
  it("computes quarterly and monthly periods in Europe/Madrid", () => {
    assert.equal(vatPeriodFor(new Date("2026-09-15T10:00:00Z"), "quarterly"), "2026-Q3");
    assert.equal(vatPeriodFor(new Date("2026-12-31T23:30:00Z"), "quarterly"), "2027-Q1");
    assert.equal(vatPeriodFor(new Date("2026-04-01T05:00:00Z"), "monthly"), "2026-04");
  });
});
