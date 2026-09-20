// Unit tests · Tanda T9 · lote T9-06a — respaldo por reglas del puerto de IA de
// documentos (documents-ai.rules.ts). Sin base de datos, sin red, sin modelo.
// Fixtures FICTICIAS (fixtures.ts). Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/documents-ai-rules.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RulesDocumentsAi,
  classifyByKeywords,
  eInvoiceToFields,
  extractFieldsFromText,
  extractInvoiceFieldsFromText,
  findDates,
  findValidNifs,
  normalizeForRules,
  parseAmount
} from "../documents-ai.rules.js";
import { getDocumentsAiPort, resetDocumentsAiPort, setDocumentsAiPort } from "../documents-ai.port.js";
import { parseEInvoice } from "../einvoice-parser.js";
import { extractPdfText } from "../pdf-text.js";
import { DEMO_CUSTOMER_TAX_ID, DEMO_SUPPLIER_NAME, DEMO_SUPPLIER_TAX_ID, cifFor, demoInvoicePdf, facturaeXml, foreignXml } from "./fixtures.ts";

const ctx = { organizationId: "org_test", propertyId: "prop_test", correlationId: "corr_test" };
const invoiceText = (): string => extractPdfText(demoInvoicePdf({ retentionRate: 15 })).pages[0]!.text;

describe("clasificación por palabras", () => {
  it("FACTURA / INVOICE → invoice; ALBARÁN / delivery note → delivery_note; TICKET / RECIBO → receipt", () => {
    assert.equal(classifyByKeywords({ text: "FACTURA\nNº factura: F-1\nBase imponible 10,00 €" }).kind, "invoice");
    assert.equal(classifyByKeywords({ text: "INVOICE no. 22\nTotal amount 10.00" }).kind, "invoice");
    assert.equal(classifyByKeywords({ text: "ALBARÁN Nº A-77\nFecha 10/09/2026" }).kind, "delivery_note");
    assert.equal(classifyByKeywords({ text: "Albaran de entrega 12" }).kind, "delivery_note");
    assert.equal(classifyByKeywords({ text: "DELIVERY NOTE 12" }).kind, "delivery_note");
    assert.equal(classifyByKeywords({ text: "TICKET 0001 · Total 3,50 €" }).kind, "receipt");
    assert.equal(classifyByKeywords({ text: "RECIBO de alquiler" }).kind, "receipt");
  });

  it("NOTIFICACIÓN / REQUERIMIENTO / AGENCIA TRIBUTARIA / DGT → administrative_notice; CONTRATO → contract", () => {
    assert.equal(classifyByKeywords({ text: "NOTIFICACIÓN de resolución" }).kind, "administrative_notice");
    assert.equal(classifyByKeywords({ text: "REQUERIMIENTO de información" }).kind, "administrative_notice");
    assert.equal(classifyByKeywords({ text: "Agencia Tributaria · Delegación" }).kind, "administrative_notice");
    assert.equal(classifyByKeywords({ text: "DGT · expediente sancionador" }).kind, "administrative_notice");
    assert.equal(classifyByKeywords({ text: "CONTRATO de mantenimiento · cláusulas" }).kind, "contract");
  });

  it("sin texto → unknown con confianza 0 (o el kindHint del capturador con confianza baja); la confianza queda en 0-1", () => {
    assert.deepEqual(classifyByKeywords({ text: "" }), { kind: "unknown", confidence: 0, source: "rules", note: "no_text" });
    assert.deepEqual(classifyByKeywords({ text: null }), { kind: "unknown", confidence: 0, source: "rules", note: "no_text" });
    assert.equal(classifyByKeywords({ text: "   ", kindHint: "letter" }).kind, "letter");
    assert.equal(classifyByKeywords({ text: "texto sin ninguna palabra clave" }).kind, "unknown");
    assert.equal(classifyByKeywords({ text: "texto sin ninguna palabra clave", kindHint: "contract" }).kind, "contract");
    const strong = classifyByKeywords({ text: invoiceText() });
    assert.equal(strong.kind, "invoice");
    assert.ok(strong.confidence > 0.6 && strong.confidence <= 0.95);
    assert.equal(strong.source, "rules");
  });

  it("el nombre del fichero es una pista débil y la normalización quita acentos y mayúsculas", () => {
    assert.equal(normalizeForRules("ALBARÁN Nº 3"), "albaran no 3");
    assert.equal(classifyByKeywords({ text: "Documento sin palabras clave", fileName: "factura-2026-01.pdf" }).kind, "invoice");
  });
});

describe("NIF, fechas e importes", () => {
  it("findValidNifs devuelve solo NIF/CIF válidos (dígito de control) en orden y sin repetidos", () => {
    const invalidCif = "B76543210";
    const text = `NIF: ${DEMO_SUPPLIER_TAX_ID} · cliente NIF ${DEMO_CUSTOMER_TAX_ID} · malo ${invalidCif} · repetido ${DEMO_SUPPLIER_TAX_ID} · dni 12345678Z · con prefijo ES-${cifFor("A", "0000001")}`;
    const hits = findValidNifs(text).map((hit) => hit.value);
    assert.deepEqual(hits, [DEMO_SUPPLIER_TAX_ID, DEMO_CUSTOMER_TAX_ID, "12345678Z", cifFor("A", "0000001")]);
    assert.equal(hits.includes(invalidCif), false);
    assert.deepEqual(findValidNifs("sin nif 99999999"), []);
  });

  it("findDates admite dd/mm/aaaa, dd-mm-aaaa, dd.mm.aaaa y aaaa-mm-dd y descarta fechas imposibles", () => {
    assert.deepEqual(findDates("Fecha: 10/09/2026 · 2026-09-11 · 31/02/2026 · 5.1.2026 · 01-12-2025"), ["2026-09-10", "2026-09-11", "2026-01-05", "2025-12-01"]);
  });

  it("parseAmount normaliza el formato español e internacional a cadena decimal", () => {
    assert.equal(parseAmount("1.234,56 €"), "1234.56");
    assert.equal(parseAmount("1,234.56"), "1234.56");
    assert.equal(parseAmount("180,20 €"), "180.20");
    assert.equal(parseAmount("150.00"), "150.00");
    assert.equal(parseAmount("-25,50 €"), "-25.50");
    assert.equal(parseAmount("1234"), "1234.00");
    assert.equal(parseAmount("abc"), null);
    assert.equal(parseAmount(""), null);
  });
});

describe("extracción por reglas (text_rules)", () => {
  it("factura demo: NIF del emisor, número, fecha, base, IVA 21 %, retención, total y líneas", () => {
    const { fields, warnings } = extractInvoiceFieldsFromText(invoiceText());
    assert.equal(fields.supplierTaxId?.value, DEMO_SUPPLIER_TAX_ID);
    assert.equal(fields.supplierTaxId?.confidence, 0.9);
    assert.equal(fields.customerTaxId?.value, DEMO_CUSTOMER_TAX_ID);
    assert.equal(fields.supplierName?.value, DEMO_SUPPLIER_NAME);
    assert.equal(fields.invoiceNumber?.value, "F-2026-0042");
    assert.equal(fields.issueDate?.value, "2026-09-10");
    assert.equal(fields.base?.value, "170.00");
    assert.equal(fields.tax?.value, "35.70");
    assert.deepEqual(fields.taxBreakdown?.value, [{ rate: 21, base: null, quota: "35.70" }]);
    assert.equal(fields.retentionRate?.value, 15);
    assert.equal(fields.retention?.value, "25.50");
    assert.equal(fields.total?.value, "180.20");
    assert.equal(fields.currency?.value, "EUR");
    const lines = fields.lines?.value as Array<Record<string, unknown>>;
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { description: "Lavado y planchado de sábanas (kg)", quantity: 120, unitPrice: "1.25", base: "150.00", taxRate: 21, quota: "31.50", deliveryNoteRef: null });
    assert.deepEqual(warnings, []);
    for (const entry of Object.values(fields)) {
      assert.ok(entry.confidence >= 0 && entry.confidence <= 1);
      assert.equal(entry.page, 1);
    }
  });

  it("NIF etiquetado con dígito de control incorrecto → supplierTaxId con confianza 0,3 y aviso nif_invalid (la validación lo marca fail); sin NIF → nif_not_found; sin total → total_not_found", () => {
    const { fields, warnings } = extractInvoiceFieldsFromText("FACTURA\nProveedor Demo SL\nNIF: B76543210\nNº factura: X-1\nFecha: 01/02/2026");
    assert.deepEqual(fields.supplierTaxId, { value: "B76543210", confidence: 0.3, page: 1 });
    assert.ok(warnings.includes("nif_invalid"));
    assert.ok(warnings.includes("total_not_found"));
    assert.equal(fields.invoiceNumber?.value, "X-1");
    const none = extractInvoiceFieldsFromText("FACTURA\nProveedor Demo SL\nNº factura: X-2");
    assert.equal(none.fields.supplierTaxId, undefined);
    assert.ok(none.warnings.includes("nif_not_found"));
  });

  it("el NIF del bloque «Cliente:» nunca se toma como emisor aunque el del emisor sea inválido", () => {
    const { fields } = extractInvoiceFieldsFromText(`FACTURA\nProveedor Demo SL\nNIF: B76543210\nCliente:\nHotel Demo SL · NIF ${DEMO_CUSTOMER_TAX_ID}\nTOTAL 10,00 €`);
    assert.equal(fields.supplierTaxId?.value, "B76543210");
    assert.equal(fields.supplierTaxId?.confidence, 0.3);
    assert.equal(fields.customerTaxId?.value, DEMO_CUSTOMER_TAX_ID);
    const swapped = extractInvoiceFieldsFromText(`FACTURA\nCliente: Hotel Demo SL NIF ${DEMO_CUSTOMER_TAX_ID}\nEmisor Demo SL NIF ${DEMO_SUPPLIER_TAX_ID}\nTOTAL 10,00 €`);
    assert.equal(swapped.fields.supplierTaxId, undefined, "sin NIF antes del bloque del cliente no se adivina el emisor");
    assert.equal(swapped.fields.customerTaxId?.value, DEMO_CUSTOMER_TAX_ID);
  });

  it("albarán, ticket y carta usan su esquema (número de albarán, total del ticket, referencia y plazo)", () => {
    const delivery = extractFieldsFromText("delivery_note", `ALBARÁN Nº A-77\nProveedor Demo SL\nNIF: ${DEMO_SUPPLIER_TAX_ID}\nFecha: 10/09/2026\nPedido nº P-12\nToallas 40 0,50 € 20,00 €`);
    assert.equal(delivery.fields.deliveryNoteNumber?.value, "A-77");
    assert.equal(delivery.fields.deliveryDate?.value, "2026-09-10");
    assert.equal(delivery.fields.purchaseOrderRef?.value, "P-12");
    assert.equal((delivery.fields.lines?.value as unknown[]).length, 1);

    const receipt = extractFieldsFromText("receipt", `Cafetería Demo\nNIF ${DEMO_SUPPLIER_TAX_ID}\nTICKET 0001\n10/09/2026\nIVA 10 % 0,32 €\nTOTAL 3,50 €\nPagado con tarjeta`);
    assert.equal(receipt.fields.receiptNumber?.value, "0001");
    assert.equal(receipt.fields.total?.value, "3.50");
    assert.equal(receipt.fields.taxRate?.value, 10);
    assert.equal(receipt.fields.paidWith?.value, "card");

    const notice = extractFieldsFromText("administrative_notice", "AGENCIA TRIBUTARIA\nRequerimiento\nExpediente: 2026-AB-77\nFecha: 01/09/2026\nPlazo: antes del 15/09/2026\nImporte: 300,00 €");
    assert.equal(notice.fields.reference?.value, "2026-AB-77");
    assert.equal(notice.fields.noticeDate?.value, "2026-09-01");
    assert.equal(notice.fields.deadlineDate?.value, "2026-09-15");
    assert.equal(notice.fields.amount?.value, "300.00");
  });
});

describe("e-factura y puerto por reglas", () => {
  it("XML Facturae → classify invoice con confianza 1 y extract source e_invoice con todos los campos a confianza 1", async () => {
    const port = new RulesDocumentsAi();
    const xml = facturaeXml({ retentionRate: 15 });
    const classified = await port.classify({ text: xml, mimeType: "application/xml", fileName: "factura.xml" }, ctx);
    assert.equal(classified.kind, "invoice");
    assert.equal(classified.confidence, 1);
    assert.equal(classified.source, "rules");
    const extracted = await port.extract({ kind: "invoice", xml, pageCount: 1, sha256: "a".repeat(64) }, ctx);
    assert.equal(extracted.source, "e_invoice");
    assert.equal(extracted.provider, null);
    assert.equal(extracted.fields.total?.value, "180.20");
    assert.equal(extracted.fields.supplierTaxId?.value, DEMO_SUPPLIER_TAX_ID);
    assert.equal(extracted.fields.retentionRate?.value, 15);
    assert.equal((extracted.fields.lines?.value as unknown[]).length, 2);
    for (const entry of Object.values(extracted.fields)) assert.equal(entry.confidence, 1);
    assert.deepEqual(extracted.warnings, []);
    const direct = eInvoiceToFields(parseEInvoice(xml));
    assert.deepEqual(direct.taxBreakdown?.value, [{ rate: 21, base: "170.00", quota: "35.70" }]);
  });

  it("XML que no es e-factura → other / text_rules con aviso xml_not_e_invoice", async () => {
    const port = new RulesDocumentsAi();
    const xml = foreignXml();
    assert.equal((await port.classify({ text: xml, mimeType: "application/xml" }, ctx)).kind, "other");
    const extracted = await port.extract({ kind: "other", xml, pageCount: 1, sha256: "b".repeat(64) }, ctx);
    assert.equal(extracted.source, "text_rules");
    assert.ok(extracted.warnings.includes("xml_not_e_invoice"));
  });

  it("sin texto (imagen sin OCR) → unknown 0 y extracción vacía con aviso honesto; describe() es configured:false / none", async () => {
    const port = new RulesDocumentsAi();
    assert.deepEqual(port.describe(), { configured: false, provider: "none" });
    const classified = await port.classify({ text: null, mimeType: "image/jpeg", fileName: "foto.jpg" }, ctx);
    assert.equal(classified.kind, "unknown");
    assert.equal(classified.confidence, 0);
    const extracted = await port.extract({ kind: "invoice", text: null, pages: [{ mediaType: "image/jpeg", base64: "AAAA" }], pageCount: 1, sha256: "c".repeat(64) }, ctx);
    assert.equal(extracted.source, "text_rules");
    assert.deepEqual(extracted.fields, {});
    assert.deepEqual(extracted.warnings, ["image_without_provider"]);
    const pdf = await port.extract({ kind: "invoice", text: invoiceText(), pageCount: 1, sha256: "d".repeat(64) }, ctx);
    assert.equal(pdf.source, "text_rules");
    assert.equal(pdf.warnings[0], "text_rules_limited_coverage");
    assert.equal(pdf.schemaVersion, 1);
  });

  it("el singleton del puerto devuelve RulesDocumentsAi por defecto y admite sustitución y reinicio", () => {
    resetDocumentsAiPort();
    assert.ok(getDocumentsAiPort() instanceof RulesDocumentsAi);
    const custom = new RulesDocumentsAi();
    setDocumentsAiPort(custom);
    assert.equal(getDocumentsAiPort(), custom);
    setDocumentsAiPort(null);
    assert.notEqual(getDocumentsAiPort(), custom);
    resetDocumentsAiPort();
  });
});
