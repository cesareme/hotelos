// Unit tests · Tanda T9 · lote T9-06b — cotejo a 2 vías (diseño §7.2).
// Sin base de datos, sin red; fixtures inventadas. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/matching.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MATCH_TOLERANCES,
  descriptionSimilarity,
  lineBase,
  matchBillToReceipts,
  matchStatusOf,
  matchedBaseTotal,
  normalizeDescription,
  normalizeReference,
  optDec,
  type BillLineLike,
  type GoodsReceiptLike
} from "../matching.js";

const receipt = (over: Partial<GoodsReceiptLike> = {}): GoodsReceiptLike => ({
  id: "gr_1",
  propertyId: "prop_demo",
  supplierTaxId: "B76543219",
  deliveryNoteNumber: "ALB-2026/0042",
  deliveryDate: "2026-09-08",
  status: "received",
  lines: [
    { id: "grl_1", lineNo: 1, description: "Lavado y planchado de sábanas (kg)", quantityReceived: "120.000", unitPrice: "1.2500" },
    { id: "grl_2", lineNo: 2, description: "Toallas de baño (unidad)", quantityReceived: "40.000", unitPrice: "0.5000" }
  ],
  ...over
});

const billLines: BillLineLike[] = [
  { description: "Lavado y planchado de sabanas KG", quantity: 120, unitPrice: "1.25", base: "150.00" },
  { description: "Toallas de baño", quantity: 40, unitPrice: "0.50", base: "20.00" }
];

describe("normalización", () => {
  it("descripción sin acentos, mayúsculas ni puntuación; referencia solo alfanumérica", () => {
    assert.equal(normalizeDescription("  Lavado y PLANCHADO de sábanas (kg) "), "lavado y planchado de sabanas kg");
    assert.equal(normalizeReference(" alb-2026/0042 "), "ALB20260042");
    assert.equal(normalizeReference(null), "");
  });

  it("similitud: 1 para iguales tras normalizar, Jaccard de tokens sin palabras vacías", () => {
    assert.equal(descriptionSimilarity("Lavado y planchado de sábanas (kg)", "LAVADO Y PLANCHADO DE SABANAS KG"), 1);
    assert.ok(descriptionSimilarity("Toallas de baño (unidad)", "toallas baño") >= 0.5);
    assert.ok(descriptionSimilarity("Toallas de baño", "Mantenimiento ascensor") < 0.5);
    assert.equal(descriptionSimilarity("", "x"), 0);
  });

  it("optDec y lineBase toleran valores vacíos o ilegibles", () => {
    assert.equal(optDec(""), null);
    assert.equal(optDec("abc"), null);
    assert.equal(optDec("1,25")?.toString(), "1.25");
    assert.equal(lineBase({ quantity: "3", unitPrice: "0.3333" })?.toFixed(2), "1.00");
    assert.equal(lineBase({ base: "10.005" })?.toFixed(2), "10.01");
    assert.equal(lineBase({ quantity: null, unitPrice: "1" }), null);
  });
});

describe("matchBillToReceipts", () => {
  it("full por número de albarán citado en la línea (referencia con separadores distintos)", () => {
    const lines: BillLineLike[] = billLines.map((l) => ({ ...l, deliveryNoteRef: "ALB 2026-0042" }));
    const result = matchBillToReceipts(lines, [receipt()], DEFAULT_MATCH_TOLERANCES);
    assert.equal(result.status, "full");
    assert.equal(result.matches.length, 2);
    assert.deepEqual(result.unmatchedBillLines, []);
    assert.deepEqual(
      result.matches.map((m) => [m.billLineNo, m.goodsReceiptLineId, m.matchedBy, m.withinTolerance, m.matchedQuantity, m.matchedBase, m.quantityVariance, m.priceVariance, m.status]),
      [
        [1, "grl_1", "reference", true, "120.000", "150.00", "0.000", "0.0000", "auto"],
        [2, "grl_2", "reference", true, "40.000", "20.00", "0.000", "0.0000", "auto"]
      ]
    );
    assert.equal(matchedBaseTotal(result.matches), "170.00");
  });

  it("full por referencia citada en el texto de la factura (citedReferences) y por descripción + cantidad + precio", () => {
    const byCited = matchBillToReceipts(billLines, [receipt()], DEFAULT_MATCH_TOLERANCES, { citedReferences: ["ALB-2026/0042"] });
    assert.equal(byCited.status, "full");
    assert.ok(byCited.matches.every((m) => m.matchedBy === "reference"));
    const byContent = matchBillToReceipts(billLines, [receipt()]);
    assert.equal(byContent.status, "full");
    assert.ok(byContent.matches.every((m) => m.matchedBy === "description"));
  });

  it("partial: una línea con albarán y otra sin él", () => {
    const lines: BillLineLike[] = [...billLines, { description: "Recargo transporte urgente", base: "12.00" }];
    const result = matchBillToReceipts(lines, [receipt()]);
    assert.equal(result.status, "partial");
    assert.equal(result.matches.length, 2);
    assert.deepEqual(result.unmatchedBillLines, [3]);
  });

  it("variance: precio un 3 % por encima del albarán (tolerancia 2 %)", () => {
    const lines: BillLineLike[] = [{ description: "Lavado y planchado de sábanas (kg)", quantity: 120, unitPrice: "1.2875", deliveryNoteRef: "ALB-2026/0042" }];
    const result = matchBillToReceipts(lines, [receipt()]);
    assert.equal(result.status, "variance");
    const [m] = result.matches;
    assert.ok(m);
    assert.equal(m.withinTolerance, false);
    assert.equal(m.priceVariance, "0.0375");
    assert.equal(m.quantityVariance, "0.000");
    assert.equal(m.matchedBase, "150.00");
    assert.equal(m.goodsReceiptLineId, "grl_1");
  });

  it("dentro de tolerancia: precio +1,6 % pasa; cantidad distinta con quantityTolerance 0 no pasa; tolerancias de la organización mandan", () => {
    const priceOk = matchBillToReceipts([{ description: "Toallas de baño (unidad)", quantity: 40, unitPrice: "0.508" }], [receipt()]);
    assert.equal(priceOk.status, "full");
    const qtyOff = matchBillToReceipts([{ description: "Toallas de baño (unidad)", quantity: 41, unitPrice: "0.50" }], [receipt()]);
    assert.equal(qtyOff.status, "variance");
    assert.equal(qtyOff.matches[0]?.quantityVariance, "1.000");
    const qtyTolerated = matchBillToReceipts([{ description: "Toallas de baño (unidad)", quantity: 41, unitPrice: "0.50" }], [receipt()], { priceTolerancePct: "2", quantityTolerance: "1", amountToleranceAbs: "1" });
    assert.equal(qtyTolerated.status, "full");
  });

  it("none: nada casa (descripciones e importes distintos)", () => {
    const result = matchBillToReceipts([{ description: "Mantenimiento ascensor trimestral", quantity: 1, unitPrice: "300.00" }], [receipt()]);
    assert.equal(result.status, "none");
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.unmatchedBillLines, [1]);
    assert.equal(matchBillToReceipts(billLines, []).status, "none");
    assert.equal(matchBillToReceipts([], [receipt()]).status, "none");
  });

  it("una línea de albarán solo se consume una vez; la misma descripción con cifras distintas no se pega", () => {
    const twice: BillLineLike[] = [
      { description: "Toallas de baño (unidad)", quantity: 40, unitPrice: "0.50" },
      { description: "Toallas de baño (unidad)", quantity: 40, unitPrice: "0.50" }
    ];
    const result = matchBillToReceipts(twice, [receipt()]);
    assert.equal(result.matches.length, 1);
    assert.equal(result.status, "partial");
    const unrelated = matchBillToReceipts([{ description: "Toallas de baño (unidad)", quantity: 7, unitPrice: "9.90" }], [receipt()]);
    assert.equal(unrelated.status, "none");
  });

  it("por importe cuando falta cantidad o precio en un lado (± 1,00 €)", () => {
    const rec = receipt({ lines: [{ id: "grl_9", description: "Servicio mensual", quantityReceived: "1.000", base: "250.00" }] });
    const ok = matchBillToReceipts([{ description: "Cuota mensual servicio", base: "250.60" }], [rec]);
    assert.equal(ok.status, "full");
    assert.equal(ok.matches[0]?.matchedBy, "description");
    const off = matchBillToReceipts([{ description: "Otra cosa distinta", base: "250.60" }], [rec]);
    assert.equal(off.status, "full", "sin descripción parecida, el importe ± 1,00 basta");
    assert.equal(off.matches[0]?.matchedBy, "amount");
    const far = matchBillToReceipts([{ description: "Otra cosa distinta", base: "252.00" }], [rec]);
    assert.equal(far.status, "none");
  });

  it("matchStatusOf resume el estado global", () => {
    assert.equal(matchStatusOf([], 2), "none");
    assert.equal(matchStatusOf([{ withinTolerance: true }], 2), "partial");
    assert.equal(matchStatusOf([{ withinTolerance: true }, { withinTolerance: true }], 2), "full");
    assert.equal(matchStatusOf([{ withinTolerance: true }, { withinTolerance: false }], 2), "variance");
  });

  it("conserva supplierBillLineId cuando la línea ya existe", () => {
    const result = matchBillToReceipts([{ id: "sbl_1", ...billLines[0]! }], [receipt()]);
    assert.equal(result.matches[0]?.supplierBillLineId, "sbl_1");
  });
});
