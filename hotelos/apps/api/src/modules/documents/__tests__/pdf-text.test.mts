// Unit tests · Tanda T9 · lote T9-03 — extractor de capa de texto de PDF sin
// dependencias (pdf-text.ts). Fixtures inventadas; sin base de datos, sin red.
//   node --import tsx --test src/modules/documents/__tests__/pdf-text.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDF_TEXT_MAX_BYTES, PDF_TEXT_MAX_PAGES, PdfTextError, countPdfPages, extractPdfText } from "../pdf-text.js";
import {
  DEMO_SUPPLIER_NAME,
  DEMO_SUPPLIER_TAX_ID,
  blankPagePdf,
  compressedTextPdf,
  demoInvoicePdf,
  htmlDisguisedAsPdf,
  imageOnlyPdf,
  multiPagePdf,
  objectStreamPdf,
  toUnicodePdf
} from "./fixtures.js";

describe("extractPdfText · PDF nativo del pdf-writer de la casa", () => {
  it("hasTextLayer y el NIF, el número y el proveedor aparecen en la página 1", () => {
    const pdf = demoInvoicePdf({ number: "F-2026-0042", issueDate: "2026-09-10" });
    const result = extractPdfText(pdf);
    assert.equal(result.pageCount, 1);
    assert.equal(result.hasTextLayer, true);
    assert.equal(result.truncated, false);
    const text = result.pages[0]!.text;
    assert.equal(result.pages[0]!.pageNo, 1);
    assert.ok(text.includes("FACTURA"), text);
    assert.ok(text.includes(`NIF: ${DEMO_SUPPLIER_TAX_ID}`), text);
    assert.ok(text.includes("F-2026-0042"), text);
    assert.ok(text.includes("2026-09-10"), text);
    assert.ok(text.includes(DEMO_SUPPLIER_NAME), "WinAnsi: acentos conservados · " + text);
    // 120 × 1,25 + 40 × 0,50 = 170,00 base; IVA 21 % = 35,70; total 205,70 (etiqueta e importe en la misma línea).
    assert.ok(/Base imponible 170,00 €/.test(text), text);
    assert.ok(/IVA 21 % 35,70 €/.test(text), text);
    assert.ok(/TOTAL 205,70 €/.test(text), text);
    assert.ok(text.split("\n").length >= 10, "una línea por Td/Tm con salto vertical");
  });

  it("varias páginas: una entrada por página en orden, texto propio", () => {
    const result = extractPdfText(multiPagePdf(3));
    assert.equal(result.pageCount, 3);
    assert.deepEqual(
      result.pages.map((p) => p.pageNo),
      [1, 2, 3]
    );
    assert.ok(result.pages[1]!.text.includes("Página 2 de 3"));
  });
});

describe("extractPdfText · sin capa de texto", () => {
  it("página en blanco → hasTextLayer false, pageCount 1", () => {
    const result = extractPdfText(blankPagePdf());
    assert.equal(result.hasTextLayer, false);
    assert.equal(result.pageCount, 1);
    assert.equal(result.pages[0]!.text, "");
  });

  it("PDF de solo imagen (XObject sin operadores de texto) → hasTextLayer false; no se intenta OCR", () => {
    const result = extractPdfText(imageOnlyPdf());
    assert.equal(result.hasTextLayer, false);
    assert.equal(result.pageCount, 1);
    assert.equal(result.pages[0]!.text, "");
  });
});

describe("extractPdfText · caminos del parser", () => {
  it("streams FlateDecode con Tj, TJ (kerning → espacio) y el operador '", () => {
    const result = extractPdfText(compressedTextPdf());
    assert.equal(result.hasTextLayer, true);
    const text = result.pages[0]!.text;
    assert.ok(text.includes("Factura demo comprimida"), text);
    assert.ok(text.includes(`NIF: ${DEMO_SUPPLIER_TAX_ID}`), text);
    assert.ok(text.includes("Total 121,00 EUR"), text);
    assert.ok(text.includes("Segunda linea con apostrofe"), text);
    assert.ok(text.indexOf("Total") < text.indexOf("Segunda"), "el operador ' salta de línea");
  });

  it("fuente Type0 Identity-H con /ToUnicode: el texto se recupera por el CMap", () => {
    const result = extractPdfText(toUnicodePdf("Albarán 77"));
    assert.equal(result.hasTextLayer, true);
    assert.equal(result.pages[0]!.text, "Albarán 77");
  });

  it("árbol de páginas dentro de un /ObjStm comprimido", () => {
    const result = extractPdfText(objectStreamPdf("Texto dentro de ObjStm"));
    assert.equal(result.pageCount, 1);
    assert.equal(result.pages[0]!.text, "Texto dentro de ObjStm");
    assert.equal(countPdfPages(objectStreamPdf()), 1);
  });
});

describe("extractPdfText · límites y errores tipados", () => {
  it("maxBytes → PDF_TEXT_TOO_LARGE; contenido que no es PDF → PDF_TEXT_NOT_PDF", () => {
    const pdf = demoInvoicePdf();
    assert.throws(() => extractPdfText(pdf, { maxBytes: pdf.length - 1 }), (error: unknown) => error instanceof PdfTextError && error.code === "PDF_TEXT_TOO_LARGE");
    assert.throws(() => extractPdfText(htmlDisguisedAsPdf()), (error: unknown) => error instanceof PdfTextError && error.code === "PDF_TEXT_NOT_PDF");
    assert.equal(PDF_TEXT_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(PDF_TEXT_MAX_PAGES, 200);
  });

  it("maxPages trunca la extracción pero pageCount conserva el total", () => {
    const result = extractPdfText(multiPagePdf(5), { maxPages: 2 });
    assert.equal(result.pageCount, 5);
    assert.equal(result.pages.length, 2);
    assert.equal(result.truncated, true);
    assert.ok(result.pages[1]!.text.includes("Página 2 de 5"));
  });

  it("un PDF truncado o corrupto no lanza: devuelve lo que pueda", () => {
    const pdf = demoInvoicePdf();
    const cut = pdf.subarray(0, Math.floor(pdf.length * 0.6));
    const result = extractPdfText(cut);
    assert.ok(result.pageCount >= 0);
    const garbage = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("1 0 obj << /Type /Page /Contents 9 0 R >> endobj\n2 0 obj << /Length 5 >> stream\n")]);
    assert.doesNotThrow(() => extractPdfText(garbage));
  });
});

describe("countPdfPages", () => {
  it("cuenta /Type /Page (no /Pages) y cae al /Count si no hay páginas directas", () => {
    assert.equal(countPdfPages(demoInvoicePdf()), 1);
    assert.equal(countPdfPages(multiPagePdf(7)), 7);
    assert.equal(countPdfPages(blankPagePdf()), 1);
    assert.equal(countPdfPages(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] /Count 12 >> endobj\n")), 12);
    assert.equal(countPdfPages(htmlDisguisedAsPdf()), 0);
  });
});
