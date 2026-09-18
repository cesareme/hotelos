// Unit tests of the PDF writer and the invoice PDF renderer (pure). Run from
// apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/invoice-pdf.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BREAKDOWN_FROM_LINES_NOTE, breakdownFromInvoiceLines, buildInvoicePdf, formatMoney, formatSpanishDate, invoicePdfFilename, resolvePdfBreakdown, type InvoicePdfModel } from "../invoice-pdf.service.js";
import { composeInvoiceEmail } from "../invoice-email.service.js";
import { A4, PdfDocument, encodePdfString, textWidth, wrapText } from "../pdf/pdf-writer.js";

function model(overrides: Partial<InvoicePdfModel> = {}): InvoicePdfModel {
  return {
    invoiceId: "inv_test",
    invoiceNumber: "FAC-2026-000016",
    invoiceType: "F1",
    status: "issued",
    issuedAt: "2026-09-15T10:00:00.000Z",
    cancelledAt: null,
    simplified: false,
    currencyCode: "EUR",
    issuer: { legalName: "Grupo Hotelero Demo SL", taxId: "B12345674", address: "Gran Vía 1, Madrid", propertyName: "Hotel Demo Madrid Centro", placeholder: false, legalFooter: "Inscrita en el Registro Mercantil de Madrid." },
    customer: { type: "guest", name: "María Pérez García", taxId: "12345678Z" },
    lines: [
      { description: "Habitación doble · 2 noches", quantity: 2, unitPrice: 76.75, taxRate: 10, calificacion: "S1", total: 153.5 },
      { description: "Minibar", quantity: 1, unitPrice: 42, taxRate: 21, calificacion: "S1", total: 42 },
      { description: "Penalización no-show", quantity: 1, unitPrice: 20, taxRate: 0, calificacion: "N1", total: 20 }
    ],
    breakdown: [
      { figure: "IVA", calificacion: "S1", ratePercent: 21, base: 34.71, quota: 7.29 },
      { figure: "IVA", calificacion: "S1", ratePercent: 10, base: 139.55, quota: 13.95 },
      { figure: "IVA", calificacion: "N1", ratePercent: 0, base: 20, quota: 0 }
    ],
    totals: { base: 194.26, tax: 21.24, total: 215.5 },
    rectification: null,
    payment: { paidTotal: 100, balanceDue: 115.5, status: "partial" },
    qrUrl: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=FAC-2026-000016&fecha=15-09-2026&importe=215.50",
    verifactuHash: "A".repeat(64),
    stay: { reservationCode: "RES-00041", arrivalDate: "2026-09-13T00:00:00.000Z", departureDate: "2026-09-15T00:00:00.000Z" },
    warnings: [],
    ...overrides
  };
}

function latin1(buffer: Buffer): string {
  return buffer.toString("latin1");
}

describe("pdf-writer", () => {
  it("encodes WinAnsi strings and escapes PDF delimiters", () => {
    assert.equal(encodePdfString("a(b)c\\").toString("latin1"), "a\\(b\\)c\\\\");
    assert.deepEqual(Array.from(encodePdfString("€ñ")), [0x80, 0xf1]);
    assert.deepEqual(Array.from(encodePdfString("漢")), [0x3f]);
  });
  it("measures Helvetica text (digits 556/1000 em)", () => {
    assert.equal(textWidth("0000", 10), 22.24);
    assert.ok(textWidth("Habitación", 10, "bold") > textWidth("Habitación", 10));
  });
  it("wraps text greedily by width", () => {
    const lines = wrapText("uno dos tres cuatro cinco seis", 60, 10);
    assert.ok(lines.length >= 2);
    for (const line of lines) assert.ok(textWidth(line, 10) <= 60 || !line.includes(" "));
  });
  it("renders a valid PDF skeleton with an xref table and the page count", () => {
    const doc = new PdfDocument({ title: "Prueba" });
    const page = doc.addPage();
    page.text(40, 60, "Hola", { font: "bold", size: 12 });
    doc.addPage();
    const out = latin1(doc.render());
    assert.ok(out.startsWith("%PDF-1.4\n"));
    assert.match(out, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2/);
    assert.match(out, /\/BaseFont \/Helvetica-Bold/);
    assert.match(out, /xref\n0 \d+\n0000000000 65535 f /);
    assert.match(out, /startxref\n\d+\n%%EOF\n$/);
    const startxref = Number(/startxref\n(\d+)\n/.exec(out)![1]);
    assert.equal(out.slice(startxref, startxref + 4), "xref");
    assert.equal(doc.pageCount, 2);
    assert.equal(A4.width, 595.28);
  });
});

describe("buildInvoicePdf", () => {
  it("renders header, recipient, lines, breakdown, totals, QR and legal texts", () => {
    const pdf = buildInvoicePdf(model());
    const out = latin1(pdf);
    assert.ok(pdf.subarray(0, 5).toString("latin1") === "%PDF-");
    for (const expected of ["FACTURA", "FAC-2026-000016", "NIF: B12345674", "Grupo Hotelero Demo SL", "Mar\\xeda P\\xe9rez Garc\\xeda".replace(/\\x([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "NIF: 12345678Z", "Habitaci\xf3n doble", "IVA 21 %", "IVA 10 %", "No sujeto", "Base imponible", "TOTAL", "215,50 \x80", "QR tributario", "VERI*FACTU", "Cobrado: 100,00", "Registro Mercantil"]) {
      assert.ok(out.includes(expected), `PDF must contain «${expected}»`);
    }
    // The QR is drawn as filled squares (many `re` operators) on the first page.
    assert.ok((out.match(/ re/g) ?? []).length > 300, "QR modules rendered");
    assert.ok(out.includes("/Producer (ehotelOS)"));
  });

  it("marks drafts, simplified, rectifying and cancelled documents", () => {
    const draft = latin1(buildInvoicePdf(model({ status: "draft", invoiceNumber: null, qrUrl: null, verifactuHash: null, payment: null })));
    assert.ok(draft.includes("BORRADOR"));
    assert.ok(!draft.includes("QR tributario"));
    const simplified = latin1(buildInvoicePdf(model({ invoiceType: "F2", simplified: true, customer: { type: "guest", name: null, taxId: null } })));
    assert.ok(simplified.includes("FACTURA SIMPLIFICADA"));
    assert.ok(simplified.includes("art. 4 RD 1619/2012"));
    assert.ok(simplified.includes("Cliente no identificado"));
    const rect = latin1(buildInvoicePdf(model({ invoiceType: "R1", rectification: { originalNumber: "FAC-2026-000002", reasonCode: "R1", reasonLabel: "R1 — Error fundado en derecho", type: "I" } })));
    assert.ok(rect.includes("FACTURA RECTIFICATIVA"));
    assert.ok(rect.includes("Rectifica la factura FAC-2026-000002"));
    assert.ok(rect.includes("por diferencias"));
    const cancelled = latin1(buildInvoicePdf(model({ status: "cancelled", cancelledAt: "2026-09-16T08:00:00.000Z" })));
    assert.ok(cancelled.includes("ANULADA el 16/09/2026"));
  });

  it("paginates long invoices and repeats the header", () => {
    const lines = Array.from({ length: 90 }, (_, i) => ({ description: `Cargo ${i + 1}`, quantity: 1, unitPrice: 1, taxRate: 10, calificacion: "S1", total: 1 }));
    const out = latin1(buildInvoicePdf(model({ lines })));
    assert.match(out, /\/Count [2-9]/);
    assert.ok(out.includes("P\xe1gina 2"));
  });

  it("formats money and dates the Spanish way", () => {
    assert.equal(formatMoney(1234.5), "1.234,50 €");
    assert.equal(formatMoney(-7), "-7,00 €");
    assert.equal(formatMoney(9.1, "USD"), "9,10 USD");
    assert.equal(formatSpanishDate("2026-12-31T23:30:00.000Z"), "01/01/2027");
    assert.equal(formatSpanishDate(null), "—");
    assert.equal(invoicePdfFilename({ invoiceNumber: "FAC-2026-000016", invoiceId: "x" }), "FAC-2026-000016.pdf");
    assert.equal(invoicePdfFilename({ invoiceNumber: null, invoiceId: "inv 1/2" }), "borrador-inv_1_2.pdf");
  });
});

describe("desglose heredado reconstruido desde las líneas (Tanda L3 · lote E)", () => {
  // Legacy lines as Faranda stores them (tax_breakdown_json NULL, taxCalificacion / taxFigure NULL, ES_UNKNOWN_0 at 0 %).
  const legacyLines = [
    { description: "Minibar hab. 502", quantity: 1, unitPrice: 12.5, taxCode: "ES_IVA_21", taxRate: 21, total: 12.5 },
    { description: "Habitación", quantity: 1, unitPrice: 110, taxCode: "ES_IVA_10", taxRate: 10, total: 110 },
    { description: "Cargo facturable sin tipo", quantity: 1, unitPrice: 12.1, taxCode: "ES_UNKNOWN_0", taxRate: 0, total: 12.1 },
    { description: "Penalización no-show", quantity: 1, unitPrice: 20, taxCode: "ES_IVA_0", taxRate: 0, total: 20, taxCalificacion: "N1" }
  ];
  const note = "Desglose reconstruido a partir de las l\xedneas";

  it("sin snapshot ni desglose persistido pero con líneas → grupos reconstruidos (redondeo por grupo de los libros) y nota en el PDF", () => {
    const resolved = resolvePdfBreakdown({ snapshot: null, stored: [], lines: legacyLines });
    assert.equal(resolved.breakdownSource, "lines");
    // 12,50 al 21 % → base 10,33 + cuota 2,17; 110,00 al 10 % → 100,00 + 10,00; 12,10 al 0 % sujeto → base 12,10 (sin tipo, no exenta); 20,00 N1 → base 20,00.
    assert.deepEqual(resolved.breakdown, [
      { figure: "IVA", calificacion: "S1", ratePercent: 21, base: 10.33, quota: 2.17 },
      { figure: "IVA", calificacion: "S1", ratePercent: 10, base: 100, quota: 10 },
      { figure: "IVA", calificacion: "S1", ratePercent: 0, base: 12.1, quota: 0 },
      { figure: "IVA", calificacion: "N1", ratePercent: 0, base: 20, quota: 0 }
    ]);
    assert.deepEqual(breakdownFromInvoiceLines([]), []);
    // IGIC lines group under their own figure (taxCode carries it when taxFigure is null).
    assert.deepEqual(breakdownFromInvoiceLines([{ taxCode: "ES_IGIC_7", taxRate: 7, total: 107 }]), [{ figure: "IGIC", calificacion: "S1", ratePercent: 7, base: 100, quota: 7 }]);

    const out = latin1(buildInvoicePdf(model({ breakdown: resolved.breakdown, breakdownSource: resolved.breakdownSource })));
    assert.ok(out.includes(note), "the PDF says the breakdown was rebuilt from the lines");
    assert.ok(out.includes(BREAKDOWN_FROM_LINES_NOTE.replace("í", "\xed")));
    // Corrector L3 (FC-5): a subject line at 0 % is a missing rate, not an exemption: «IVA 0 %» without «(exento)».
    for (const expected of ["IVA 21 %", "IVA 10 %", "IVA 0 %", "No sujeto", "10,33 \x80", "2,17 \x80", "100,00 \x80", "12,10 \x80"]) {
      assert.ok(out.includes(expected), `PDF must contain «${expected}»`);
    }
    assert.ok(!out.includes("exento"), "a 0 % subject line never prints «exento»");
    // The note is a table footnote, never a change of the fiscal texts: the document keeps its QR and title.
    assert.ok(out.includes("QR tributario"));
    assert.ok(!out.includes("BORRADOR"));
  });

  it("con snapshot (o desglose persistido) no reconstruye nada y el PDF no lleva nota; el borrador sigue siendo BORRADOR", () => {
    const frozen = [{ figure: "IVA", calificacion: "S1", ratePercent: 10, base: 90.91, quota: 9.09 }];
    const stored = [{ figure: "IVA", calificacion: "S1", ratePercent: 21, base: 10, quota: 2.1 }];
    const fromSnapshot = resolvePdfBreakdown({ snapshot: frozen, stored, lines: legacyLines });
    assert.equal(fromSnapshot.breakdownSource, "snapshot");
    assert.deepEqual(fromSnapshot.breakdown, frozen);
    assert.notEqual(fromSnapshot.breakdown, frozen, "the model owns a copy of the frozen groups");
    const fromStored = resolvePdfBreakdown({ snapshot: null, stored, lines: legacyLines });
    assert.equal(fromStored.breakdownSource, "stored");
    assert.deepEqual(fromStored.breakdown, stored);
    // An empty snapshot array is still a snapshot (frozen document without groups): never rebuilt from the lines.
    assert.deepEqual(resolvePdfBreakdown({ snapshot: [], stored, lines: legacyLines }), { breakdown: [], breakdownSource: "snapshot" });
    // Nothing at all → empty stored breakdown, no note.
    assert.deepEqual(resolvePdfBreakdown({ snapshot: null, stored: [], lines: [] }), { breakdown: [], breakdownSource: "stored" });

    for (const source of ["snapshot", "stored", undefined] as const) {
      const out = latin1(buildInvoicePdf(model(source ? { breakdownSource: source } : {})));
      assert.ok(!out.includes(note), `no note when breakdownSource = ${String(source)}`);
      assert.ok(out.includes("IVA 21 %") && out.includes("QR tributario"));
    }
    const draft = latin1(buildInvoicePdf(model({ status: "draft", invoiceNumber: null, qrUrl: null, verifactuHash: null, payment: null, breakdownSource: "stored" })));
    assert.ok(draft.includes("BORRADOR"));
    assert.ok(!draft.includes(note));
    assert.ok(!draft.includes("QR tributario"));
  });
});

describe("composeInvoiceEmail — Spanish system template", () => {
  it("fills subject and body from the invoice and keeps a caller subject", () => {
    const mail = composeInvoiceEmail({ invoiceNumber: "FAC-2026-000016", invoiceType: "F1", simplified: false, issuerLegalName: "Grupo Hotelero Demo SL", issuerTaxId: "B12345674", propertyName: "Hotel Demo Madrid Centro", issuedAt: "2026-09-15T10:00:00.000Z", total: 215.5, currencyCode: "EUR", customerName: "María", message: "Gracias por su estancia." });
    assert.equal(mail.subject, "Factura FAC-2026-000016 — Grupo Hotelero Demo SL");
    assert.ok(mail.body.startsWith("Hola María,"));
    assert.ok(mail.body.includes("factura FAC-2026-000016 de Grupo Hotelero Demo SL (NIF B12345674), expedida el 15/09/2026, por un importe total de 215,50 €"));
    assert.ok(mail.body.includes("Gracias por su estancia."));
    assert.ok(mail.body.includes("— Grupo Hotelero Demo SL · Hotel Demo Madrid Centro"));
    const custom = composeInvoiceEmail({ invoiceNumber: "REC-2026-000001", invoiceType: "R1", simplified: false, issuerLegalName: "X", issuerTaxId: null, propertyName: null, issuedAt: null, total: -10, currencyCode: "EUR", customerName: null, subject: "Su abono" });
    assert.equal(custom.subject, "Su abono");
    assert.ok(custom.body.startsWith("Hola,"));
    assert.ok(custom.body.includes("factura rectificativa REC-2026-000001"));
  });
});
