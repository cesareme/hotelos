// Unit tests · Tanda T9 · lote T9-03 — parser determinista EN16931 (Facturae
// 3.2.x y UBL 2.1) sin IA. Fixtures inventadas; sin base de datos, sin red.
//   node --import tsx --test src/modules/documents/__tests__/einvoice-parser.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidSpanishTaxId } from "@hotelos/compliance";
import { parseEInvoice, round2 } from "../einvoice-parser.js";
import { DEMO_CUSTOMER_NAME, DEMO_CUSTOMER_TAX_ID, DEMO_LINES, DEMO_SUPPLIER_NAME, DEMO_SUPPLIER_TAX_ID, demoTotals, facturaeXml, foreignXml, ublXml, xmlWithBom } from "./fixtures.js";

describe("fixtures", () => {
  it("los NIF inventados pasan el dígito de control (nunca datos reales)", () => {
    assert.equal(isValidSpanishTaxId(DEMO_SUPPLIER_TAX_ID), true, DEMO_SUPPLIER_TAX_ID);
    assert.equal(isValidSpanishTaxId(DEMO_CUSTOMER_TAX_ID), true, DEMO_CUSTOMER_TAX_ID);
    assert.match(DEMO_SUPPLIER_NAME, /Demo/);
  });
});

describe("parseEInvoice · Facturae 3.2.2", () => {
  it("cabecera, proveedor, líneas y totales cuadran; confidence 1; sin firma", () => {
    const parsed = parseEInvoice(Buffer.from(facturaeXml({ number: "F-2026-0042", issueDate: "2026-09-10" }), "utf8"));
    const expected = demoTotals(DEMO_LINES);
    assert.equal(parsed.format, "facturae");
    assert.equal(parsed.schemaVersion, "3.2.2");
    assert.equal(parsed.confidence, 1);
    assert.equal(parsed.signaturePresent, false);
    assert.deepEqual(parsed.supplier, { name: DEMO_SUPPLIER_NAME, taxId: DEMO_SUPPLIER_TAX_ID });
    assert.deepEqual(parsed.customer, { name: DEMO_CUSTOMER_NAME, taxId: DEMO_CUSTOMER_TAX_ID });
    assert.equal(parsed.invoiceNumber, "F-2026-0042");
    assert.equal(parsed.issueDate, "2026-09-10");
    assert.equal(parsed.currency, "EUR");
    assert.equal(parsed.lines.length, 2);
    assert.deepEqual(parsed.lines[0], { description: DEMO_LINES[0]!.description, quantity: 120, unitPrice: 1.25, base: 150, taxRate: 21, quota: 31.5 });
    assert.deepEqual(parsed.totals, { base: expected.base, tax: expected.tax, total: expected.total });
    assert.deepEqual(parsed.totals, { base: 170, tax: 35.7, total: 205.7 });
    assert.equal(parsed.retention, undefined);
    assert.equal(parsed.totalsConsistent, true);
    assert.equal(round2(parsed.lines.reduce((s, l) => s + l.base, 0)), parsed.totals.base);
    assert.equal(round2(parsed.lines.reduce((s, l) => s + l.quota, 0)), parsed.totals.tax);
    assert.deepEqual(parsed.warnings, []);
  });

  it("retención IRPF (TaxesWithheld) y firma ds:Signature detectada solo estructuralmente", () => {
    const parsed = parseEInvoice(facturaeXml({ retentionRate: 15, signed: true, lines: [{ description: "Asesoría demo", quantity: 1, unitPrice: 1000, taxRate: 21 }] }));
    assert.equal(parsed.signaturePresent, true);
    assert.deepEqual(parsed.retention, { rate: 15, amount: 150 });
    assert.deepEqual(parsed.totals, { base: 1000, tax: 210, total: 1060 });
    assert.equal(parsed.totalsConsistent, true);
  });

  it("varios tipos de IVA: un TaxesOutputs por tipo y la cuota por línea", () => {
    const lines = [
      { description: "Desayunos demo", quantity: 10, unitPrice: 5, taxRate: 10 },
      { description: "Mantenimiento demo", quantity: 2, unitPrice: 100, taxRate: 21 }
    ];
    const parsed = parseEInvoice(facturaeXml({ lines }));
    assert.deepEqual(
      parsed.lines.map((l) => [l.taxRate, l.quota]),
      [
        [10, 5],
        [21, 42]
      ]
    );
    assert.deepEqual(parsed.totals, { base: 250, tax: 47, total: 297 });
  });

  it("acepta BOM UTF-8 y texto ya decodificado", () => {
    assert.equal(parseEInvoice(xmlWithBom(facturaeXml(), "utf8")).format, "facturae");
    assert.equal(parseEInvoice(facturaeXml()).format, "facturae");
  });
});

describe("parseEInvoice · UBL 2.1 (EN16931)", () => {
  it("cbc:ID, IssueDate, proveedor por CompanyID sin prefijo ES, líneas, TaxTotal y LegalMonetaryTotal", () => {
    const parsed = parseEInvoice(Buffer.from(ublXml({ number: "2026-A-77", issueDate: "2026-09-12" }), "utf8"));
    assert.equal(parsed.format, "ubl");
    assert.equal(parsed.schemaVersion, "urn:cen.eu:en16931:2017");
    assert.equal(parsed.confidence, 1);
    assert.deepEqual(parsed.supplier, { name: DEMO_SUPPLIER_NAME, taxId: DEMO_SUPPLIER_TAX_ID });
    assert.equal(parsed.customer.taxId, DEMO_CUSTOMER_TAX_ID);
    assert.equal(parsed.invoiceNumber, "2026-A-77");
    assert.equal(parsed.issueDate, "2026-09-12");
    assert.equal(parsed.currency, "EUR");
    assert.deepEqual(parsed.lines[1], { description: DEMO_LINES[1]!.description, quantity: 40, unitPrice: 0.5, base: 20, taxRate: 21, quota: 4.2 });
    assert.deepEqual(parsed.totals, { base: 170, tax: 35.7, total: 205.7 });
    assert.equal(parsed.totalsConsistent, true);
    assert.equal(parsed.signaturePresent, false);
    assert.deepEqual(parsed.warnings, []);
  });

  it("WithholdingTaxTotal → retention y PayableAmount neto; firma dentro de UBLExtensions", () => {
    const parsed = parseEInvoice(ublXml({ retentionRate: 7, signed: true, lines: [{ description: "Formación demo", quantity: 1, unitPrice: 500, taxRate: 21 }] }));
    assert.deepEqual(parsed.retention, { rate: 7, amount: 35 });
    assert.deepEqual(parsed.totals, { base: 500, tax: 105, total: 570 });
    assert.equal(parsed.totalsConsistent, true);
    assert.equal(parsed.signaturePresent, true);
  });

  it("totales que no cuadran se marcan (totalsConsistent false + aviso), nunca se corrigen en silencio", () => {
    const xml = ublXml().replace(/<cbc:PayableAmount currencyID="EUR">[\d.]+<\/cbc:PayableAmount>/, '<cbc:PayableAmount currencyID="EUR">999.99</cbc:PayableAmount>');
    const parsed = parseEInvoice(xml);
    assert.equal(parsed.totals.total, 999.99);
    assert.equal(parsed.totalsConsistent, false);
    assert.ok(parsed.warnings.includes("TOTALES_NO_CUADRAN"));
  });
});

describe("parseEInvoice · XML ajeno o inválido", () => {
  it("XML bien formado que no es factura → unknown, confidence 0, sin lanzar", () => {
    const parsed = parseEInvoice(foreignXml());
    assert.equal(parsed.format, "unknown");
    assert.equal(parsed.confidence, 0);
    assert.deepEqual(parsed.lines, []);
    assert.deepEqual(parsed.totals, { base: 0, tax: 0, total: 0 });
    assert.deepEqual(parsed.warnings, ["XML_NO_RECONOCIDO:catalogo"]);
  });

  it("XML malformado, con DOCTYPE (XXE) o que no es XML → unknown con el código de xml-lite", () => {
    assert.deepEqual(parseEInvoice("<a><b></a>").warnings, ["XML_LITE_MALFORMED"]);
    assert.deepEqual(parseEInvoice('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "x">]><Invoice/>').warnings, ["XML_LITE_DOCTYPE_REJECTED"]);
    assert.equal(parseEInvoice(Buffer.from("%PDF-1.4 no soy xml")).format, "unknown");
  });

  it("un <Invoice> sin estructura UBL (raíz homónima) no se toma por UBL", () => {
    assert.equal(parseEInvoice("<Invoice><foo/></Invoice>").format, "unknown");
  });
});
