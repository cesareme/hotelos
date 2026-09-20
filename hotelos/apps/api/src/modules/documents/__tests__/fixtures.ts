// Documents · INVENTED fixtures for the unit tests (Tanda T9 · lote T9-03).
// Everything here is fictitious: supplier and customer names carry "Demo",
// tax ids are computed CIFs with made-up digits, amounts are round numbers.
// Never paste a real Faranda / Sage document, name or NIF in this file.

import { deflateSync } from "node:zlib";
import { A4, PdfDocument, wrapText, type PdfPage } from "../../invoicing/pdf/pdf-writer.js";

// ---------------------------------------------------------------------------
// Tax ids
// ---------------------------------------------------------------------------

const CIF_CONTROL_LETTERS = "JABCDEFGHI";
const CIF_DIGIT_CONTROL_ONLY = "ABEH";
const CIF_LETTER_CONTROL_ONLY = "NPQRSW";

/** CIF with a valid control character (Orden EHA/451/2008 art. 4) for an invented 7-digit body. */
export function cifFor(organisationLetter: string, digits7: string): string {
  if (!/^\d{7}$/.test(digits7)) throw new Error("cifFor espera 7 dígitos");
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = Number(digits7[i]);
    if (i % 2 === 0) {
      const doubled = n * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else sum += n;
  }
  const control = (10 - (sum % 10)) % 10;
  const letter = organisationLetter.toUpperCase();
  // N/P/Q/R/S/W take a letter; A/B/E/H a digit; the rest accept either (digit here).
  const useLetter = CIF_LETTER_CONTROL_ONLY.includes(letter) && !CIF_DIGIT_CONTROL_ONLY.includes(letter);
  return `${letter}${digits7}${useLetter ? CIF_CONTROL_LETTERS[control] : String(control)}`;
}

export const DEMO_SUPPLIER_NAME = "Lavandería Cantábrica Demo SL";
export const DEMO_SUPPLIER_TAX_ID = cifFor("B", "7654321");
export const DEMO_CUSTOMER_NAME = "Hotel Costa Demo SL";
export const DEMO_CUSTOMER_TAX_ID = cifFor("B", "1122334");

// ---------------------------------------------------------------------------
// Invoice model shared by the PDF and the XML fixtures
// ---------------------------------------------------------------------------

export type DemoLine = { description: string; quantity: number; unitPrice: number; taxRate: number };

export type DemoInvoiceOptions = {
  supplierName?: string;
  taxId?: string;
  number?: string;
  issueDate?: string;
  lines?: DemoLine[];
  retentionRate?: number;
  signed?: boolean;
};

export const DEMO_LINES: DemoLine[] = [
  { description: "Lavado y planchado de sábanas (kg)", quantity: 120, unitPrice: 1.25, taxRate: 21 },
  { description: "Toallas de baño (unidad)", quantity: 40, unitPrice: 0.5, taxRate: 21 }
];

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type DemoTotals = { base: number; tax: number; retention: number; total: number; byRate: Array<{ rate: number; base: number; quota: number }> };

export function demoTotals(lines: DemoLine[], retentionRate = 0): DemoTotals {
  const byRateMap = new Map<number, { base: number; quota: number }>();
  for (const line of lines) {
    const base = round2(line.quantity * line.unitPrice);
    const entry = byRateMap.get(line.taxRate) ?? { base: 0, quota: 0 };
    entry.base = round2(entry.base + base);
    byRateMap.set(line.taxRate, entry);
  }
  const byRate = [...byRateMap.entries()].map(([rate, entry]) => ({ rate, base: entry.base, quota: round2((entry.base * rate) / 100) }));
  const base = round2(byRate.reduce((s, r) => s + r.base, 0));
  const tax = round2(byRate.reduce((s, r) => s + r.quota, 0));
  const retention = round2((base * retentionRate) / 100);
  return { base, tax, retention, total: round2(base + tax - retention), byRate };
}

function resolved(options: DemoInvoiceOptions) {
  return {
    supplierName: options.supplierName ?? DEMO_SUPPLIER_NAME,
    taxId: options.taxId ?? DEMO_SUPPLIER_TAX_ID,
    number: options.number ?? "F-2026-0042",
    issueDate: options.issueDate ?? "2026-09-10",
    lines: options.lines ?? DEMO_LINES,
    retentionRate: options.retentionRate ?? 0,
    signed: options.signed ?? false
  };
}

const eur = (n: number): string => `${n.toFixed(2).replace(".", ",")} €`;

/** A native (text-layer) invoice PDF rendered with the house pdf-writer. */
export function demoInvoicePdf(options: DemoInvoiceOptions = {}): Buffer {
  const inv = resolved(options);
  const doc = new PdfDocument({ title: `Factura ${inv.number} (demo)`, author: inv.supplierName, creationDate: new Date("2026-09-10T08:00:00Z") });
  drawInvoicePage(doc.addPage(), inv);
  return doc.render();
}

/** One invoice per page (a scanned batch): the split fixtures of RV-01 (each piece must read ONLY its page). */
export function multiInvoicePdf(pages: DemoInvoiceOptions[]): Buffer {
  const doc = new PdfDocument({ title: `Lote de ${pages.length} facturas (demo)`, creationDate: new Date("2026-09-10T08:00:00Z") });
  for (const options of pages) drawInvoicePage(doc.addPage(), resolved(options));
  return doc.render();
}

function drawInvoicePage(page: PdfPage, inv: ReturnType<typeof resolved>): void {
  const totals = demoTotals(inv.lines, inv.retentionRate);
  const left = 50;
  let y = 60;
  page.text(left, y, "FACTURA", { font: "bold", size: 20 });
  y += 30;
  page.text(left, y, inv.supplierName, { font: "bold", size: 11 });
  y += 14;
  page.text(left, y, `NIF: ${inv.taxId}`);
  y += 14;
  page.text(left, y, "Polígono Industrial Demo, nave 7 · 15000 A Coruña");
  y += 24;
  page.text(left, y, `Nº factura: ${inv.number}`, { font: "bold" });
  page.text(A4.width - 50, y, `Fecha: ${inv.issueDate}`, { align: "right" });
  y += 24;
  page.text(left, y, "Cliente:", { font: "bold" });
  y += 14;
  page.text(left, y, `${DEMO_CUSTOMER_NAME} · NIF ${DEMO_CUSTOMER_TAX_ID}`);
  y += 30;
  page.line(left, y, A4.width - 50, y);
  y += 14;
  page.text(left, y, "Concepto", { font: "bold" });
  page.text(340, y, "Cantidad", { font: "bold", align: "right" });
  page.text(420, y, "Precio", { font: "bold", align: "right" });
  page.text(A4.width - 50, y, "Importe", { font: "bold", align: "right" });
  y += 6;
  page.line(left, y, A4.width - 50, y);
  y += 14;
  for (const line of inv.lines) {
    const lines = wrapText(line.description, 240, 10);
    lines.forEach((text, index) => page.text(left, y + index * 12, text));
    page.text(340, y, String(line.quantity), { align: "right" });
    page.text(420, y, eur(line.unitPrice), { align: "right" });
    page.text(A4.width - 50, y, eur(round2(line.quantity * line.unitPrice)), { align: "right" });
    y += 12 * Math.max(1, lines.length) + 4;
  }
  y += 10;
  page.line(300, y, A4.width - 50, y);
  y += 16;
  page.text(300, y, "Base imponible");
  page.text(A4.width - 50, y, eur(totals.base), { align: "right" });
  for (const group of totals.byRate) {
    y += 14;
    page.text(300, y, `IVA ${group.rate} %`);
    page.text(A4.width - 50, y, eur(group.quota), { align: "right" });
  }
  if (inv.retentionRate > 0) {
    y += 14;
    page.text(300, y, `Retención IRPF ${inv.retentionRate} %`);
    page.text(A4.width - 50, y, `-${eur(totals.retention)}`, { align: "right" });
  }
  y += 18;
  page.text(300, y, "TOTAL", { font: "bold", size: 12 });
  page.text(A4.width - 50, y, eur(totals.total), { font: "bold", size: 12, align: "right" });
  y += 40;
  page.paragraph(left, y, "Documento ficticio generado para pruebas automáticas. No corresponde a ninguna empresa real.", A4.width - 100, { size: 8, gray: 0.4 });
}

/** One empty A4 page: no text layer at all. */
export function blankPagePdf(): Buffer {
  const doc = new PdfDocument({ title: "Página en blanco (demo)" });
  doc.addPage();
  return doc.render();
}

/** `n` pages, each with a short line of text. */
export function multiPagePdf(n: number): Buffer {
  const doc = new PdfDocument({ title: `Lote de ${n} páginas (demo)` });
  for (let i = 1; i <= n; i++) doc.addPage().text(50, 60, `Página ${i} de ${n} del lote demo`);
  return doc.render();
}

// ---------------------------------------------------------------------------
// Hand-assembled PDFs (exercise the parser paths the house writer does not use)
// ---------------------------------------------------------------------------

/** Minimal PDF 1.5 assembler: objects are 1-based, bodies may be strings (latin1) or Buffers; null = number reserved for an object stream. */
export function assemblePdf(bodies: Array<string | Buffer | null>, rootObj = 1): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets: Array<number | null> = [];
  let position = chunks[0]!.length;
  bodies.forEach((body, index) => {
    if (body === null) {
      offsets.push(null);
      return;
    }
    offsets.push(position);
    const head = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
    const data = typeof body === "string" ? Buffer.from(body, "latin1") : body;
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, data, tail);
    position += head.length + data.length + tail.length;
  });
  const xref = [`xref`, `0 ${bodies.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets) xref.push(offset === null ? "0000000000 65535 f " : `${String(offset).padStart(10, "0")} 00000 n `);
  chunks.push(Buffer.from(`${xref.join("\n")}\ntrailer\n<< /Size ${bodies.length + 1} /Root ${rootObj} 0 R >>\nstartxref\n${position}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

export function streamObject(dict: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
}

function pdfLiteral(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** Text drawn through a FlateDecode content stream with Tj, TJ (kerning) and the ' operator. */
export function compressedTextPdf(lines: string[] = ["Factura demo comprimida", "NIF: " + DEMO_SUPPLIER_TAX_ID]): Buffer {
  const ops = ["BT /F1 12 Tf 50 780 Td"];
  lines.forEach((line, index) => {
    if (index === 0) ops.push(`${pdfLiteral(line)} Tj`);
    else ops.push(`0 -16 Td ${pdfLiteral(line)} Tj`);
  });
  ops.push("0 -16 Td [(Total) -600 (121,00) -300 (EUR)] TJ");
  ops.push("14 TL (Segunda linea con apostrofe) '");
  ops.push("ET");
  const content = deflateSync(Buffer.from(ops.join("\n"), "latin1"));
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject("/Filter /FlateDecode", content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  ]);
}

/** A Type0 (Identity-H) font with a ToUnicode CMap: the text is only recoverable through the CMap. */
export function toUnicodePdf(text = "Albarán 77"): Buffer {
  const chars = [...new Set([...text])];
  const codeOf = new Map(chars.map((ch, index) => [ch, index + 1] as const));
  const hex = [...text].map((ch) => codeOf.get(ch)!.toString(16).padStart(4, "0")).join("");
  const bfchar = chars.map((ch) => `<${codeOf.get(ch)!.toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>`).join("\n");
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const content = Buffer.from(`BT /F1 12 Tf 50 780 Td <${hex}> Tj ET`, "latin1");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject("", content),
    "<< /Type /Font /Subtype /Type0 /BaseFont /DemoSans /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>",
    streamObject("", Buffer.from(cmap, "latin1")),
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DemoSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>"
  ]);
}

/** Page tree stored inside a compressed object stream (/Type /ObjStm), as modern generators do. */
export function objectStreamPdf(text = "Texto dentro de ObjStm"): Buffer {
  const embedded = [
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"]
  ] as const;
  let offset = 0;
  const header: string[] = [];
  const bodies: string[] = [];
  for (const [num, body] of embedded) {
    header.push(`${num} ${offset}`);
    bodies.push(body);
    offset += body.length + 1;
  }
  const headerText = `${header.join(" ")}\n`;
  const objStm = deflateSync(Buffer.from(headerText + bodies.join("\n") + "\n", "latin1"));
  const content = Buffer.from(`BT /F1 12 Tf 50 780 Td ${pdfLiteral(text)} Tj ET`, "latin1");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    null,
    null,
    streamObject("", content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamObject(`/Type /ObjStm /N ${embedded.length} /First ${headerText.length} /Filter /FlateDecode`, objStm)
  ]);
}

/** A page with only a 2×2 RGB image XObject: valid PDF, no text layer. */
export function imageOnlyPdf(): Buffer {
  const pixels = deflateSync(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
  const content = Buffer.from("q 200 0 0 200 100 500 cm /Im1 Do Q", "latin1");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject("", content),
    streamObject("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode", pixels)
  ]);
}

// ---------------------------------------------------------------------------
// Images and disguised content
// ---------------------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Valid 8×8 RGB PNG (filter 0 on every row, IDAT deflated). */
export function tinyPng(): Buffer {
  const width = 8;
  const height = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0); // filter type 0
    for (let x = 0; x < width; x++) rows.push((x * 32) & 255, (y * 32) & 255, 128);
  }
  const idat = deflateSync(Buffer.from(rows));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/** JPEG signature + JFIF marker + EOI (enough for the magic-byte checks). */
export function jpegStub(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9]);
}

/** TIFF header with an empty IFD, little- or big-endian. */
export function tiffStub(order: "II" | "MM" = "II"): Buffer {
  return order === "II" ? Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]) : Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00]);
}

export function htmlDisguisedAsPdf(): Buffer {
  return Buffer.from("<!DOCTYPE html><html><body><script>alert('demo')</script><p>%PDF-1.4 falso</p></body></html>", "utf8");
}

export function svgDisguisedAsXml(): Buffer {
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>demo</text></svg>', "utf8");
}

export function xmlWithBom(xml: string, encoding: "utf8" | "utf16le" | "utf16be"): Buffer {
  if (encoding === "utf8") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, "utf8")]);
  const le = Buffer.from(xml, "utf16le");
  if (encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1]!;
    be[i + 1] = le[i]!;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

// ---------------------------------------------------------------------------
// E-invoices (Facturae 3.2.2 and UBL 2.1), minimal but internally consistent
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fixed = (n: number): string => n.toFixed(2);

const DEMO_SIGNATURE =
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="Signature-demo"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI=""><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>ZGVtbw==</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>ZGVtbw==</ds:SignatureValue></ds:Signature>';

export function facturaeXml(options: DemoInvoiceOptions = {}): string {
  const inv = resolved(options);
  const totals = demoTotals(inv.lines, inv.retentionRate);
  const taxOutputs = totals.byRate
    .map((g) => `<Tax><TaxTypeCode>01</TaxTypeCode><TaxRate>${fixed(g.rate)}</TaxRate><TaxableBase><TotalAmount>${fixed(g.base)}</TotalAmount></TaxableBase><TaxAmount><TotalAmount>${fixed(g.quota)}</TotalAmount></TaxAmount></Tax>`)
    .join("");
  const withheld =
    inv.retentionRate > 0
      ? `<TaxesWithheld><Tax><TaxTypeCode>04</TaxTypeCode><TaxRate>${fixed(inv.retentionRate)}</TaxRate><TaxableBase><TotalAmount>${fixed(totals.base)}</TotalAmount></TaxableBase><TaxAmount><TotalAmount>${fixed(totals.retention)}</TotalAmount></TaxAmount></Tax></TaxesWithheld>`
      : "";
  const items = inv.lines
    .map((line) => {
      const base = round2(line.quantity * line.unitPrice);
      const quota = round2((base * line.taxRate) / 100);
      return `<InvoiceLine><ItemDescription>${esc(line.description)}</ItemDescription><Quantity>${line.quantity}</Quantity><UnitOfMeasure>01</UnitOfMeasure><UnitPriceWithoutTax>${line.unitPrice.toFixed(6)}</UnitPriceWithoutTax><TotalCost>${fixed(base)}</TotalCost><GrossAmount>${fixed(base)}</GrossAmount><TaxesOutputs><Tax><TaxTypeCode>01</TaxTypeCode><TaxRate>${fixed(line.taxRate)}</TaxRate><TaxableBase><TotalAmount>${fixed(base)}</TotalAmount></TaxableBase><TaxAmount><TotalAmount>${fixed(quota)}</TotalAmount></TaxAmount></Tax></TaxesOutputs></InvoiceLine>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<fe:Facturae xmlns:fe="http://www.facturae.gob.es/formato/Versiones/Facturaev3_2_2.xml" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
    `<FileHeader><SchemaVersion>3.2.2</SchemaVersion><Modality>I</Modality><InvoiceIssuerType>EM</InvoiceIssuerType><Batch><BatchIdentifier>${esc(inv.taxId)}${esc(inv.number)}</BatchIdentifier><InvoicesCount>1</InvoicesCount><TotalInvoicesAmount><TotalAmount>${fixed(totals.total)}</TotalAmount></TotalInvoicesAmount><TotalOutstandingAmount><TotalAmount>${fixed(totals.total)}</TotalAmount></TotalOutstandingAmount><TotalExecutableAmount><TotalAmount>${fixed(totals.total)}</TotalAmount></TotalExecutableAmount><InvoiceCurrencyCode>EUR</InvoiceCurrencyCode></Batch></FileHeader>` +
    `<Parties><SellerParty><TaxIdentification><PersonTypeCode>J</PersonTypeCode><ResidenceTypeCode>R</ResidenceTypeCode><TaxIdentificationNumber>${esc(inv.taxId)}</TaxIdentificationNumber></TaxIdentification><LegalEntity><CorporateName>${esc(inv.supplierName)}</CorporateName><AddressInSpain><Address>Polígono Industrial Demo, nave 7</Address><PostCode>15000</PostCode><Town>A Coruña</Town><Province>A Coruña</Province><CountryCode>ESP</CountryCode></AddressInSpain></LegalEntity></SellerParty>` +
    `<BuyerParty><TaxIdentification><PersonTypeCode>J</PersonTypeCode><ResidenceTypeCode>R</ResidenceTypeCode><TaxIdentificationNumber>${DEMO_CUSTOMER_TAX_ID}</TaxIdentificationNumber></TaxIdentification><LegalEntity><CorporateName>${esc(DEMO_CUSTOMER_NAME)}</CorporateName><AddressInSpain><Address>Paseo Marítimo Demo, 1</Address><PostCode>15001</PostCode><Town>A Coruña</Town><Province>A Coruña</Province><CountryCode>ESP</CountryCode></AddressInSpain></LegalEntity></BuyerParty></Parties>` +
    `<Invoices><Invoice><InvoiceHeader><InvoiceNumber>${esc(inv.number)}</InvoiceNumber><InvoiceDocumentType>FC</InvoiceDocumentType><InvoiceClass>OO</InvoiceClass></InvoiceHeader>` +
    `<InvoiceIssueData><IssueDate>${inv.issueDate}</IssueDate><InvoiceCurrencyCode>EUR</InvoiceCurrencyCode><TaxCurrencyCode>EUR</TaxCurrencyCode><LanguageName>es</LanguageName></InvoiceIssueData>` +
    `<TaxesOutputs>${taxOutputs}</TaxesOutputs>${withheld}` +
    `<InvoiceTotals><TotalGrossAmount>${fixed(totals.base)}</TotalGrossAmount><TotalGrossAmountBeforeTaxes>${fixed(totals.base)}</TotalGrossAmountBeforeTaxes><TotalTaxOutputs>${fixed(totals.tax)}</TotalTaxOutputs><TotalTaxesWithheld>${fixed(totals.retention)}</TotalTaxesWithheld><InvoiceTotal>${fixed(totals.total)}</InvoiceTotal><TotalOutstandingAmount>${fixed(totals.total)}</TotalOutstandingAmount><TotalExecutableAmount>${fixed(totals.total)}</TotalExecutableAmount></InvoiceTotals>` +
    `<Items>${items}</Items></Invoice></Invoices>` +
    (inv.signed ? DEMO_SIGNATURE : "") +
    `</fe:Facturae>`
  );
}

export function ublXml(options: DemoInvoiceOptions = {}): string {
  const inv = resolved(options);
  const totals = demoTotals(inv.lines, inv.retentionRate);
  const subtotals = totals.byRate
    .map((g) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${fixed(g.base)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${fixed(g.quota)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${g.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`)
    .join("");
  const withholding =
    inv.retentionRate > 0
      ? `<cac:WithholdingTaxTotal><cbc:TaxAmount currencyID="EUR">${fixed(totals.retention)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${fixed(totals.base)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${fixed(totals.retention)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${inv.retentionRate}</cbc:Percent><cac:TaxScheme><cbc:ID>IRPF</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:WithholdingTaxTotal>`
      : "";
  const lines = inv.lines
    .map((line, index) => {
      const base = round2(line.quantity * line.unitPrice);
      return `<cac:InvoiceLine><cbc:ID>${index + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">${line.quantity}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">${fixed(base)}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${esc(line.description)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${line.taxRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${line.unitPrice.toFixed(4)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
    (inv.signed ? `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>${DEMO_SIGNATURE}</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>` : "") +
    `<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID><cbc:ID>${esc(inv.number)}</cbc:ID><cbc:IssueDate>${inv.issueDate}</cbc:IssueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>` +
    `<cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>${esc(inv.supplierName)}</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>ES${esc(inv.taxId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${esc(inv.supplierName)}</cbc:RegistrationName><cbc:CompanyID>${esc(inv.taxId)}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>` +
    `<cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>${esc(DEMO_CUSTOMER_NAME)}</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>ES${DEMO_CUSTOMER_TAX_ID}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${esc(DEMO_CUSTOMER_NAME)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${fixed(totals.tax)}</cbc:TaxAmount>${subtotals}</cac:TaxTotal>${withholding}` +
    `<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${fixed(totals.base)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${fixed(totals.base)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${fixed(round2(totals.base + totals.tax))}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${fixed(totals.total)}</cbc:PayableAmount></cac:LegalMonetaryTotal>` +
    lines +
    `</Invoice>`
  );
}

/** A well-formed XML that is not an invoice at all. */
export function foreignXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><catalogo xmlns="urn:demo:catalogo"><producto id="1"><nombre>Toalla demo</nombre></producto></catalogo>`;
}
