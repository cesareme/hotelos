// Unit tests of the withholding models 111 / 115 / 180 (Finanzas · lote
// «iva-modelos»): Decimal sums, the L-row separation (hallazgo 100), unknown
// row codes, lessors of the 180 and the PDF summary writer. No database. Run
// from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/modelo-111.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import type { FiscalModelReport } from "@hotelos/shared/src/fiscal-types.js";
import { pdfLiteral, renderFiscalReportPdf } from "../fiscal.routes.js";
import { MODELO_111_ROWS, compute111, modelo111RowFor } from "../modelo-111.service.js";
import { compute115 } from "../modelo-115.service.js";
import { lessorsOf } from "../modelo-180.service.js";
import { parseFiscalPeriod } from "../vat-books.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);

const records = [
  { sourceType: "vendor_invoice", rowCode: "02", recipientNif: "12345678Z", recipientName: "Asesor", grossAmount: D("1000.00"), retentionAmount: D("150.00") },
  { sourceType: "vendor_invoice", rowCode: "02", recipientNif: "12345678z", recipientName: "Asesor", grossAmount: D("200.10"), retentionAmount: D("30.02") },
  { sourceType: "payroll_payment", rowCode: "01", recipientNif: "87654321X", recipientName: "Empleada", grossAmount: D("1500.00"), retentionAmount: D("225.00") },
  { sourceType: "payroll_payment", rowCode: "??", recipientNif: null, recipientName: null, grossAmount: D("100.00"), retentionAmount: D("2.00") },
  { sourceType: "vendor_invoice", rowCode: "L01", recipientNif: "B11111111", recipientName: "Arrendador", recipientAddress: "Calle Mayor 1", cadastralReference: "1234567AB", grossAmount: D("500.00"), retentionAmount: D("95.00") }
];

describe("compute111", () => {
  it("sums per row in Decimal, counts distinct perceptores and excludes the L rows", () => {
    const computation = compute111(records);
    const casilla = (code: string) => computation.casillas.find((box) => box.casilla === code)!.importe;
    assert.equal(casilla("07"), 1); // one professional (NIF case-insensitive)
    assert.equal(casilla("08"), 1200.1);
    assert.equal(casilla("09"), 180.02);
    assert.equal(casilla("01"), 2); // employee + unknown-row payroll record without NIF
    assert.equal(casilla("02"), 1600);
    assert.equal(casilla("03"), 227);
    assert.equal(casilla("28"), 407.02);
    assert.equal(casilla("29"), 0);
    assert.equal(casilla("30"), 407.02);
    assert.deepEqual([computation.perceptores, computation.registros], [3, 4]);
    assert.ok(computation.avisos.some((aviso) => /1 registro\(s\) de arrendamientos \(clave L\) excluidos/.test(aviso)));
    assert.ok(computation.avisos.some((aviso) => /clave desconocida/.test(aviso)));
    assert.equal(MODELO_111_ROWS.length, 9);
    assert.deepEqual(modelo111RowFor({ sourceType: "payroll_payment", rowCode: "zz" }), { code: "01", fallback: true });
    assert.deepEqual(modelo111RowFor({ sourceType: "vendor_invoice", rowCode: "zz" }), { code: "02", fallback: true });
  });

  it("answers zero with an aviso when the period has no records", () => {
    const computation = compute111([]);
    assert.equal(computation.casillas.find((box) => box.casilla === "28")!.importe, 0);
    assert.ok(computation.avisos.some((aviso) => /Sin registros de retención/.test(aviso)));
  });
});

describe("compute115 / lessorsOf", () => {
  it("takes only the L rows into 01-05 and lists the lessors for the 180", () => {
    const computation = compute115(records);
    const casilla = (code: string) => computation.casillas.find((box) => box.casilla === code)!.importe;
    assert.deepEqual([casilla("01"), casilla("02"), casilla("03"), casilla("04"), casilla("05")], [1, 500, 95, 0, 95]);
    assert.ok(computation.avisos.some((aviso) => /4 registro\(s\) sin clave L ignorados/.test(aviso)));
    const lessors = lessorsOf(records);
    assert.equal(lessors.length, 1);
    assert.deepEqual([lessors[0]!.nif, lessors[0]!.nombre, lessors[0]!.direccion, lessors[0]!.referenciaCatastral, lessors[0]!.importeIntegro.toString(), lessors[0]!.retencion.toString()], ["B11111111", "Arrendador", "Calle Mayor 1", "1234567AB", "500", "95"]);
  });
});

describe("renderFiscalReportPdf", () => {
  it("writes a parseable text-only PDF with WinAnsi escaping", () => {
    assert.equal(pdfLiteral("Liquidación (95 €) \\ ≠"), "Liquidación \\(95 \\) \\\\ ?");
    const report: FiscalModelReport = {
      modelo: "303",
      titulo: "Modelo 303 · prueba",
      organizationId: "org_t",
      propertyId: null,
      periodo: parseFiscalPeriod("2026-Q2"),
      declarante: { nif: "B12345674", nombre: "HotelOS Demo SL" },
      casillas: [
        { casilla: "04", clave: "DEV_BASE_10", descripcion: "Base imponible al 10 %", seccion: "IVA devengado", importe: 3050, tipo: "base" },
        { casilla: "71", clave: "RESULTADO_LIQUIDACION", descripcion: "Resultado de la liquidación", seccion: "Resultado", importe: 95, tipo: "resultado" }
      ],
      totales: { resultado: 95, registros: 4 },
      avisos: ["Aviso de prueba con acentos: liquidación, año, €."],
      fuentes: { origen: "libros" },
      detalle: Array.from({ length: 80 }, (_, index) => ({ nif: `B0000000${index}`, nombre: "Tercero", clave: "B", importeAnual: 3300.5, t1: 0, t2: 3300.5, t3: 0, t4: 0 })),
      presentacion: { modo: "manual", ficheroOficial: false, nota: "Presentación manual." },
      generatedAt: "2026-09-15T10:00:00.000Z"
    };
    const pdf = renderFiscalReportPdf(report);
    const text = pdf.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4\n"));
    assert.ok(text.endsWith("%%EOF\n"));
    assert.match(text, /\/Type \/Catalog/);
    assert.match(text, /\/BaseFont \/Helvetica-Bold/);
    assert.ok(text.includes("(Base imponible al 10 %) Tj"));
    // es-ES (CLDR) does not group four-digit numbers (3050,00; 13.050,50 above 9.999);
    // \u0080 is the WinAnsi byte of € in the latin1-decoded stream.
    assert.ok(text.includes("3050,00 \u0080"), "amount not rendered with the euro sign");
    const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
    assert.ok(pages >= 2, `expected the 80 detail rows to overflow to a second page, got ${pages}`);
    // xref offsets must point at "N 0 obj".
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    assert.ok(text.slice(startxref).startsWith("xref\n"));
    const firstOffset = Number(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/.exec(text)![1]);
    assert.ok(text.slice(firstOffset).startsWith("1 0 obj"));
  });
});
