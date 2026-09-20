// Unit tests · Tanda T9 · lote T9-08 — hoja de remesa (§6.4): PDF de la casa
// con %PDF-, una página para pocos números, los números de registro, el
// centro, la fecha y el texto legal; paginación a partir de 40 filas; nombre
// del fichero y esquemas de la valija. Sin Postgres, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/dispatch-sheet.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countPdfPages } from "../pdf-text.js";
import {
  buildDispatchSheetPdf,
  DISPATCH_LEGAL_TEXT,
  dispatchLockKey,
  dispatchSheetFileName,
  dispatchSheetPageCount,
  DocumentDispatchBatchRequestSchema,
  DocumentDispatchReceiveRequestSchema,
  SHEET_ROWS_PER_PAGE,
  sheetDownloadPathOf
} from "../dispatch.service.js";

const NUMBERS = ["DOC-L2A-2026-000001", "DOC-L2A-2026-000002", "DOC-L2A-2026-000003"];

function sheet(count = NUMBERS.length): Buffer {
  const documents = Array.from({ length: count }, (_, index) => ({ registryNumber: NUMBERS[index] ?? `DOC-L2A-2026-${String(index + 1).padStart(6, "0")}`, title: `Factura demo ${index + 1}`, kind: "invoice" }));
  return buildDispatchSheetPdf({ batchNumber: 7, propertyName: "Hotel L2 Norte", propertyCode: "L2A", closedAt: new Date("2026-09-19T10:30:00.000Z"), closedByName: "Recepción L2", documents });
}

/** Texto plano de los streams (el escritor no comprime): suficiente para buscar literales. */
function pdfText(pdf: Buffer): string {
  return pdf.toString("latin1");
}

describe("buildDispatchSheetPdf", () => {
  it("es un PDF (%PDF-) de UNA página con los números de registro, el lote, el centro, la fecha y el texto legal", () => {
    const pdf = sheet();
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(countPdfPages(pdf), 1);
    assert.equal(dispatchSheetPageCount(NUMBERS.length), 1);
    const text = pdfText(pdf);
    for (const number of NUMBERS) assert.ok(text.includes(number), `contiene ${number}`);
    assert.ok(text.includes("Lote 7"));
    assert.ok(text.includes("Hotel L2 Norte"));
    assert.ok(text.includes("2026-09-19"));
    assert.ok(text.includes("Documentos: 3"));
    // El escritor codifica «(» y «)» escapados; se comprueba la cita legal por sus piezas.
    assert.ok(text.includes("Copia digital no certificada"));
    assert.ok(text.includes("art. 30 CCom"));
    assert.ok(text.includes("Orden EHA/962/2007 art. 7"));
    assert.ok(text.endsWith("%%EOF\n"));
  });

  it("texto legal exacto del diseño §6.4", () => {
    assert.equal(DISPATCH_LEGAL_TEXT, "Copia digital no certificada (Orden EHA/962/2007 art. 7): conservar el original 6 años (art. 30 CCom)");
  });

  it("pagina a partir de SHEET_ROWS_PER_PAGE filas (41 documentos → 2 páginas, todas numeradas)", () => {
    assert.equal(SHEET_ROWS_PER_PAGE, 40);
    assert.equal(dispatchSheetPageCount(0), 1);
    assert.equal(dispatchSheetPageCount(40), 1);
    assert.equal(dispatchSheetPageCount(41), 2);
    const pdf = sheet(41);
    assert.equal(countPdfPages(pdf), 2);
    const text = pdfText(pdf);
    assert.ok(text.includes("DOC-L2A-2026-000041"));
    assert.ok(text.includes("gina 1 de 2") && text.includes("gina 2 de 2"));
  });

  it("nombre del fichero, ruta de descarga y clave del advisory lock", () => {
    assert.equal(dispatchSheetFileName("L2A", 7), "remesa-l2a-0007.pdf");
    assert.equal(dispatchSheetFileName(null, 12), "remesa-centro-0012.pdf");
    assert.equal(dispatchSheetFileName("Ñ/..", 1), "remesa-centro-0001.pdf");
    assert.equal(sheetDownloadPathOf("prop_1", "ddb_1"), "/properties/prop_1/documents/dispatch-batches/ddb_1/sheet");
    assert.equal(dispatchLockKey("prop_1"), "documents.dispatch:prop_1");
  });
});

describe("esquemas de la valija (.strict())", () => {
  it("documentIds / receivedIds: lista no vacía de ids; clave desconocida → error", () => {
    assert.equal(DocumentDispatchBatchRequestSchema.safeParse({ documentIds: ["doc_1"] }).success, true);
    assert.equal(DocumentDispatchBatchRequestSchema.safeParse({ documentIds: [] }).success, false);
    assert.equal(DocumentDispatchBatchRequestSchema.safeParse({ documentIds: ["doc_1"], foo: 1 }).success, false);
    assert.equal(DocumentDispatchReceiveRequestSchema.safeParse({ receivedIds: ["doc_1", "doc_2"] }).success, true);
    assert.equal(DocumentDispatchReceiveRequestSchema.safeParse({}).success, false);
  });
});
