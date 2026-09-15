// Unit tests · cash closure core (expected vs counted, differences, journal lines).
// Pure: no database. Run from apps/api with
//   node --import tsx --test src/modules/pos/__tests__/cash-closure-core.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCashExpectation, legacyMethodToCode, reconcileCashCount, settlementToMethod, sumDenominations } from "../pos-cash-core.js";
import { buildCashClosureDifferenceEntry } from "../../accounting/posting-rules.js";

describe("computeCashExpectation", () => {
  it("expected cash = fondo + cobros efectivo − devoluciones + ventas TPV efectivo − gastos de caja", () => {
    const out = computeCashExpectation({
      openingFloat: 100,
      payments: [
        { method: "cash", amount: "50.00" },
        { method: "card_terminal", amount: 80.5 },
        { method: "bank_transfer", amount: 200 }
      ],
      refunds: [{ method: "cash", amount: 10 }],
      posSales: [
        { method: "cash", amount: 18 },
        { method: "card_terminal", amount: 10.3 }
      ],
      cashExpenses: [12.4]
    });
    // 100 + 50 − 10 + 18 − 12,40 = 145,60
    assert.equal(out.expectedCash, "145.60");
    assert.equal(out.expectedByMethod.cash, "145.60");
    assert.equal(out.expectedByMethod.card_terminal, "90.80");
    assert.equal(out.expectedByMethod.bank_transfer, "200.00");
    assert.equal(out.expectedByMethod.other, "0.00");
    assert.equal(out.detail.openingFloat, "100.00");
    assert.equal(out.detail.cashExpenses, "12.40");
    assert.equal(out.detail.posSales.cash, "18.00");
  });
  it("refuses a negative float", () => {
    assert.throws(() => computeCashExpectation({ openingFloat: -1, payments: [], refunds: [], posSales: [], cashExpenses: [] }), /fondo/);
  });
});

describe("reconcileCashCount", () => {
  const expected = { cash: "145.60", card_terminal: "90.80", card_online: "0.00", bank_transfer: "200.00", payment_link: "0.00", other: "0.00" };
  it("faltante: counted 143,60 vs expected 145,60 → difference −2,00", () => {
    const r = reconcileCashCount(expected, { cash: 143.6, card_terminal: 90.8 });
    assert.equal(r.countedCash, "143.60");
    assert.equal(r.difference, "-2.00");
    assert.equal(r.byMethod.card_terminal.difference, "0.00");
    // A method not counted is 0 against its expectation.
    assert.equal(r.byMethod.bank_transfer.counted, "0.00");
    assert.equal(r.byMethod.bank_transfer.difference, "-200.00");
    assert.equal(r.countedTotal, "234.40");
    assert.equal(r.expectedTotal, "436.40");
  });
  it("sobrante: counted 146,10 → +0,50", () => {
    assert.equal(reconcileCashCount(expected, { cash: "146.10" }).difference, "0.50");
  });
  it("refuses a negative count", () => {
    assert.throws(() => reconcileCashCount(expected, { cash: -5 }), /negativo/);
  });
});

describe("cash difference → journal (rule of the ledger lote)", () => {
  it("faltante → D 659 / H 570, sobrante → D 570 / H 759, cuadrado → 400", () => {
    const faltante = buildCashClosureDifferenceEntry({ organizationId: "org_123", propertyId: "prop_123", closureId: "cc_1", entryDate: "2026-09-14", difference: "-2.00", outletLabel: "Bar" });
    assert.equal(faltante.sourceType, "cash_closure");
    assert.deepEqual(faltante.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["659", "2.00", "0.00"], ["570", "0.00", "2.00"]]);
    const sobrante = buildCashClosureDifferenceEntry({ organizationId: "org_123", propertyId: "prop_123", closureId: "cc_2", entryDate: "2026-09-14", difference: 0.5 });
    assert.deepEqual(sobrante.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["570", "0.50", "0.00"], ["759", "0.00", "0.50"]]);
    assert.throws(() => buildCashClosureDifferenceEntry({ organizationId: "org_123", propertyId: "prop_123", closureId: "cc_3", entryDate: "2026-09-14", difference: "0.00" }), /cuadra/);
  });
});

describe("helpers", () => {
  it("sums denominations to the cent and rejects bad rows", () => {
    const r = sumDenominations([
      { denomination: "50", quantity: 2 },
      { denomination: 0.2, quantity: 3 },
      { denomination: "0.05", quantity: 1 }
    ]);
    assert.equal(r.total, "100.65");
    assert.deepEqual(r.rows[1], { denomination: "0.2", quantity: 3, amount: "0.60" });
    assert.throws(() => sumDenominations([{ denomination: "0", quantity: 1 }]), /Denominación/);
    assert.throws(() => sumDenominations([{ denomination: "5", quantity: 1.5 }]), /Cantidad/);
  });
  it("maps legacy Payment.method and POS settlements to canonical methods", () => {
    assert.equal(legacyMethodToCode("cash"), "cash");
    assert.equal(legacyMethodToCode("card"), "card_terminal");
    assert.equal(legacyMethodToCode("bank_transfer"), "bank_transfer");
    assert.equal(legacyMethodToCode("ota_virtual_card"), "other");
    assert.equal(legacyMethodToCode(null), "other");
    assert.equal(settlementToMethod("cash"), "cash");
    assert.equal(settlementToMethod("card"), "card_terminal");
  });
});
