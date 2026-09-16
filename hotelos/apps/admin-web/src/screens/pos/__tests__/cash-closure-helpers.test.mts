import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCloseRequest,
  canDo,
  closureOutletLabel,
  closureStatusTone,
  denominationRows,
  differenceKind,
  differenceTone,
  emptyCounted,
  fromCents,
  methodPreview,
  parseCountedAmount,
  paymentMethodLabel,
  relevantMethods,
  sumDenominations,
  sumPreview,
  toCents
} from "../cash-closure-helpers.ts";

// Tanda 6 · lote 6-E: the closure figures travel as decimal strings; the form
// must never produce a body the API rejects (400 CASH_COUNT_MISMATCH) nor a
// float that drifts from what the cashier typed.
describe("Cierre de caja · céntimos", () => {
  it("round-trips decimal strings and typed amounts with a comma", () => {
    assert.equal(toCents("118.00"), 11800);
    assert.equal(toCents("0.20"), 20);
    assert.equal(toCents("118,50"), 11850);
    assert.equal(toCents(""), null);
    assert.equal(toCents("abc"), null);
    assert.equal(fromCents(11850), "118.50");
    assert.equal(fromCents(-350), "-3.50");
    assert.equal(fromCents(0), "0.00");
    assert.equal(fromCents(5), "0.05");
  });

  it("treats an empty count as 0 and rejects negatives and garbage", () => {
    assert.equal(parseCountedAmount(""), "0.00");
    assert.equal(parseCountedAmount("   "), "0.00");
    assert.equal(parseCountedAmount("118,5"), "118.50");
    assert.equal(parseCountedAmount("-1"), null);
    assert.equal(parseCountedAmount("doce"), null);
  });

  it("sums denominations exactly (0.10 × 3 is 0.30, never 0.30000000000000004)", () => {
    assert.equal(sumDenominations({ "0.10": 3 }), "0.30");
    assert.equal(sumDenominations({ "50": 2, "0.20": 1, "0.05": 3 }), "100.35");
    assert.equal(sumDenominations({}), "0.00");
    assert.equal(sumDenominations({ "50": 0, "20": -1, "10": 1.5 }), "0.00");
    assert.deepEqual(denominationRows({ "0.20": 1, "50": 2, "5": 0 }), [
      { denomination: "50", quantity: 2 },
      { denomination: "0.20", quantity: 1 }
    ]);
  });
});

describe("Cierre de caja · diferencias", () => {
  it("classifies the sign of a difference and tones it", () => {
    assert.equal(differenceKind("0.00"), "balanced");
    assert.equal(differenceKind("3.50"), "surplus");
    assert.equal(differenceKind("-0.01"), "shortage");
    assert.equal(differenceKind(null), "pending");
    assert.equal(differenceTone("0.00"), "success");
    assert.equal(differenceTone("3.50"), "warning");
    assert.equal(differenceTone("-3.50"), "danger");
    assert.equal(differenceTone(undefined), "neutral");
  });

  it("previews the typed count against the expected amounts of an open closure", () => {
    const closure = {
      status: "open" as const,
      byMethod: {
        cash: { expected: "118.00", counted: null, difference: null },
        card_terminal: { expected: "40.00", counted: null, difference: null },
        card_online: { expected: "0.00", counted: null, difference: null },
        bank_transfer: { expected: "0.00", counted: null, difference: null },
        payment_link: { expected: "0.00", counted: null, difference: null },
        other: { expected: "0.00", counted: null, difference: null }
      }
    };
    const typed = { ...emptyCounted(), cash: "115,50", card_terminal: "40", other: "x" };
    const rows = methodPreview(closure, typed);
    assert.deepEqual(rows[0], { method: "cash", expected: "118.00", counted: "115.50", difference: "-2.50" });
    assert.deepEqual(rows[1], { method: "card_terminal", expected: "40.00", counted: "40.00", difference: "0.00" });
    assert.deepEqual(rows[2], { method: "card_online", expected: "0.00", counted: "0.00", difference: "0.00" });
    assert.deepEqual(rows[5], { method: "other", expected: "0.00", counted: null, difference: null });
    assert.equal(sumPreview(rows, "expected"), "158.00");
    assert.equal(sumPreview(rows, "counted"), "155.50");
    assert.equal(sumPreview(rows, "difference"), "-2.50");
    // Compact table: cash always, plus the methods with money expected or counted.
    assert.deepEqual(
      relevantMethods(rows).map((r) => r.method),
      ["cash", "card_terminal"]
    );
  });

  it("paints the signed figures of a closed closure untouched", () => {
    const closure = {
      status: "closed" as const,
      byMethod: {
        cash: { expected: "118.00", counted: "118.00", difference: "0.00" },
        card_terminal: { expected: "40.00", counted: "35.00", difference: "-5.00" },
        card_online: { expected: "0.00", counted: "0.00", difference: "0.00" },
        bank_transfer: { expected: "0.00", counted: "0.00", difference: "0.00" },
        payment_link: { expected: "0.00", counted: "0.00", difference: "0.00" },
        other: { expected: "0.00", counted: "0.00", difference: "0.00" }
      }
    };
    const rows = methodPreview(closure, { ...emptyCounted(), cash: "999" });
    assert.equal(rows[0].counted, "118.00");
    assert.equal(rows[1].difference, "-5.00");
  });
});

describe("Cierre de caja · cuerpo del cierre", () => {
  it("sends only the counted methods as numbers and the denominations when the physical count is on", () => {
    const result = buildCloseRequest({
      counted: { ...emptyCounted(), cash: "1", card_terminal: "40,10" },
      useDenominations: true,
      quantities: { "50": 2, "0.20": 1 },
      notes: "  Turno de tarde  "
    });
    assert.ok(result.ok);
    if (result.ok) {
      // With denominations on, the cash counted IS the sum of the count (100.20), not the typed "1".
      assert.deepEqual(result.body.countedByMethod, { cash: 100.2, card_terminal: 40.1 });
      assert.deepEqual(result.body.counts, [
        { denomination: "50", quantity: 2 },
        { denomination: "0.20", quantity: 1 }
      ]);
      assert.equal(result.body.notes, "Turno de tarde");
    }
  });

  it("omits counts, notes and zero methods when they carry nothing", () => {
    const result = buildCloseRequest({ counted: { ...emptyCounted(), cash: "0" }, useDenominations: false, quantities: {}, notes: "" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.body, { countedByMethod: {} });
    }
  });

  it("refuses an amount that is not a non-negative number, naming the method", () => {
    const result = buildCloseRequest({ counted: { ...emptyCounted(), card_terminal: "-4" }, useDenominations: false, quantities: {}, notes: "" });
    assert.ok(!result.ok);
    if (!result.ok) assert.match(result.error, /Tarjeta \(datáfono\)/);
  });
});

describe("Cierre de caja · etiquetas y permisos", () => {
  it("names the reception cash and the outlets", () => {
    assert.equal(closureOutletLabel({ outletId: "*", outletName: null }), "Recepción");
    assert.equal(closureOutletLabel({ outletId: "out_bar", outletName: "Bar" }), "Bar");
    assert.equal(closureOutletLabel({ outletId: "out_bar", outletName: null }), "out_bar");
  });

  it("maps payment methods, legacy names included, and closure statuses to tones", () => {
    assert.equal(paymentMethodLabel("cash"), "Efectivo");
    assert.equal(paymentMethodLabel("card"), "Tarjeta (datáfono)");
    assert.equal(paymentMethodLabel("Transferencia"), "Transferencia");
    assert.equal(paymentMethodLabel("bizum"), "bizum");
    assert.equal(closureStatusTone("open"), "warning");
    assert.equal(closureStatusTone("closed"), "info");
    assert.equal(closureStatusTone("approved"), "success");
  });

  it("lets the API decide while the grants are unknown", () => {
    assert.equal(canDo(null, "accounting.journal.post"), true);
    assert.equal(canDo(["pos.read"], "accounting.journal.post"), false);
    assert.equal(canDo(["accounting.journal.post"], "accounting.journal.post"), true);
  });
});
