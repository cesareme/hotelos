// Unit tests · Tanda T9 · lote T9-03 — lista blanca MIME y magic bytes.
// Fixtures inventadas; sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/magic-bytes.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../../../lib/http-error.js";
import { ALLOWED_DOCUMENT_MIME_TYPES, assertContentMatches, canonicalDocumentMime, extensionForMime, sniffMime, xmlLooksLikeMarkup } from "../magic-bytes.js";
import { blankPagePdf, demoInvoicePdf, facturaeXml, htmlDisguisedAsPdf, jpegStub, svgDisguisedAsXml, tiffStub, tinyPng, ublXml, xmlWithBom } from "./fixtures.js";

function expectCode(fn: () => unknown, code: string): HttpError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, "HttpError esperado");
    assert.equal(error.statusCode, 400);
    assert.equal((error.details as { code?: string }).code, code);
    return error;
  }
  assert.fail(`se esperaba ${code}`);
}

describe("sniffMime · cada firma", () => {
  it("PDF (%PDF-), JPEG (FF D8 FF), PNG (89 50 4E 47), TIFF (II*\\0 y MM\\0*), XML (<?xml)", () => {
    assert.equal(sniffMime(demoInvoicePdf()), "application/pdf");
    assert.equal(sniffMime(blankPagePdf()), "application/pdf");
    assert.equal(sniffMime(jpegStub()), "image/jpeg");
    assert.equal(sniffMime(tinyPng()), "image/png");
    assert.equal(sniffMime(tiffStub("II")), "image/tiff");
    assert.equal(sniffMime(tiffStub("MM")), "image/tiff");
    assert.equal(sniffMime(Buffer.from(facturaeXml(), "utf8")), "application/xml");
    assert.equal(sniffMime(Buffer.from(ublXml(), "utf8")), "application/xml");
  });

  it("tolera BOM UTF-8 y UTF-16 (LE/BE) delante de <?xml", () => {
    const xml = facturaeXml();
    assert.equal(sniffMime(xmlWithBom(xml, "utf8")), "application/xml");
    assert.equal(sniffMime(xmlWithBom(xml, "utf16le")), "application/xml");
    assert.equal(sniffMime(xmlWithBom(xml, "utf16be")), "application/xml");
  });

  it("nunca HTML ni SVG (aunque lleven declaración XML), ni binarios ajenos, ni vacío", () => {
    assert.equal(sniffMime(htmlDisguisedAsPdf()), null);
    assert.equal(sniffMime(svgDisguisedAsXml()), null);
    assert.equal(xmlLooksLikeMarkup(svgDisguisedAsXml()), true);
    assert.equal(xmlLooksLikeMarkup(Buffer.from(facturaeXml())), false);
    assert.equal(sniffMime(Buffer.from('<?xml version="1.0"?><html><body>x</body></html>')), null);
    assert.equal(sniffMime(Buffer.from('<?xml version="1.0"?><r><script>x</script></r>')), null);
    assert.equal(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04])), null); // ZIP / docx
    assert.equal(sniffMime(Buffer.from("MZ")), null);
    assert.equal(sniffMime(Buffer.alloc(0)), null);
    assert.equal(sniffMime(Buffer.from("%PDF")), null, "firma incompleta");
  });
});

describe("assertContentMatches · códigos 400", () => {
  it("acepta cada pareja declarada/contenido de la lista blanca y devuelve el MIME canónico", () => {
    assert.equal(assertContentMatches("application/pdf", demoInvoicePdf()), "application/pdf");
    assert.equal(assertContentMatches("image/jpeg", jpegStub()), "image/jpeg");
    assert.equal(assertContentMatches("image/png", tinyPng()), "image/png");
    assert.equal(assertContentMatches("image/tiff", tiffStub("MM")), "image/tiff");
    assert.equal(assertContentMatches("application/xml", Buffer.from(ublXml())), "application/xml");
    assert.equal(assertContentMatches("text/xml", Buffer.from(facturaeXml())), "application/xml");
    assert.equal(assertContentMatches("Text/XML; charset=utf-8", xmlWithBom(facturaeXml(), "utf8")), "application/xml");
  });

  it("HTML declarado como PDF → 400 DOCUMENT_CONTENT_MISMATCH con details.sniffed null", () => {
    const error = expectCode(() => assertContentMatches("application/pdf", htmlDisguisedAsPdf()), "DOCUMENT_CONTENT_MISMATCH");
    assert.equal((error.details as { sniffed: unknown }).sniffed, null);
    assert.equal(error.expose, true);
  });

  it("SVG declarado como XML → DOCUMENT_CONTENT_MISMATCH; PNG declarado como JPEG → DOCUMENT_CONTENT_MISMATCH", () => {
    expectCode(() => assertContentMatches("application/xml", svgDisguisedAsXml()), "DOCUMENT_CONTENT_MISMATCH");
    const error = expectCode(() => assertContentMatches("image/jpeg", tinyPng()), "DOCUMENT_CONTENT_MISMATCH");
    assert.equal((error.details as { sniffed: unknown }).sniffed, "image/png");
  });

  it("tipos fuera de la lista blanca → DOCUMENT_MIME_NOT_ALLOWED (html, svg, zip, octet-stream, vacío)", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/zip", "application/octet-stream", "", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
      const error = expectCode(() => assertContentMatches(mime, tinyPng()), "DOCUMENT_MIME_NOT_ALLOWED");
      assert.deepEqual((error.details as { allowed: unknown }).allowed, ALLOWED_DOCUMENT_MIME_TYPES);
    }
  });

  it("helpers: MIME canónico y extensión de la clave de almacén", () => {
    assert.equal(canonicalDocumentMime("text/xml"), "application/xml");
    assert.equal(canonicalDocumentMime("text/html"), null);
    assert.equal(extensionForMime("application/pdf"), "pdf");
    assert.equal(extensionForMime("image/jpeg"), "jpg");
    assert.equal(extensionForMime("image/png"), "png");
    assert.equal(extensionForMime("image/tiff"), "tif");
    assert.equal(extensionForMime("text/xml"), "xml");
    assert.equal(extensionForMime("image/gif"), null);
  });
});
