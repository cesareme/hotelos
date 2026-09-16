// File writers (PDF, XLSX/ZIP, CSV), the statement renderer and the gestoría
// export builders. Run from apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/writers-and-export.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { csvDocument, csvLine } from "../csv.js";
import type { UserContext } from "../../../lib/demo-store.js";
import { assertGestoriaExportScope, buildContaplusDiario, buildCsvUniversal, buildVatBooksCsv, contaplusSubaccount, createGestoriaExport, csvUniversalRow, entryNumberLabel, exportFileName, GESTORIA_FORMATS, getGestoriaExport, listGestoriaExports } from "../gestoria-export.service.js";
import { D, decimalComma, money, pct, ratio, sameCents, spanishDate } from "../money.js";
import { PdfDocument, pdfFit, pdfTextWidth, renderPdfReport } from "../pdf-writer.js";
import { documentToCsv, documentToPdf, documentToXlsx, renderStatementFile, statementDocument } from "../statement-render.js";
import { computeUsaliPnl } from "../usali.service.js";
import { computeBalance } from "../annual-accounts.service.js";
import { addDays } from "../source.js";
import { columnLetter, readZipEntries, sanitizeSheetName, writeXlsx, writeZip } from "../xlsx-writer.js";
import { referenceLedger } from "./memory-source.mts";

describe("money helpers", () => {
  it("formats two decimals, never -0.00, and rounds half up", () => {
    assert.equal(money(D("1234.5")), "1234.50");
    assert.equal(money(D("-0.001")), "0.00");
    assert.equal(money(D("2.345")), "2.35");
    assert.equal(money(D("-2.345")), "-2.35");
    assert.equal(ratio(D("100"), 900), "0.11");
    assert.equal(ratio(D("1"), 0), null);
    assert.equal(pct(D("45"), 900), "5.00");
    assert.equal(sameCents(D("1.004"), D("1.00")), true);
    assert.equal(sameCents(D("1.01"), D("1.00")), false);
    assert.equal(decimalComma("1234.56"), "1234,56");
    assert.equal(spanishDate("2027-03-31"), "31/03/2027");
  });
});

describe("CSV", () => {
  it("quotes only what needs quoting and writes BOM + CRLF", () => {
    assert.equal(csvLine(["a", "b;c", "d\"e", null, 1]), "a;\"b;c\";\"d\"\"e\";;1");
    const doc = csvDocument(["x", "y"], [["1", "2"]]);
    assert.equal(doc.charCodeAt(0), 0xfeff);
    assert.equal(doc.slice(1), "x;y\r\n1;2\r\n");
  });
});

describe("PDF writer", () => {
  it("emits a structurally valid PDF 1.4 with a correct xref table", () => {
    const doc = new PdfDocument({ title: "Prueba ñ €" });
    const page = doc.addPage();
    doc.text(page, 40, 800, "Línea con acentos: áéíóú ñ € (paréntesis) \\ barra", "bold", 10);
    doc.textRight(page, 500, 780, "1234,56");
    doc.rule(page, 40, 770, 500, 770);
    doc.addPage();
    const bytes = doc.toBuffer();
    const text = bytes.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4\n"));
    assert.ok(text.trimEnd().endsWith("%%EOF"));
    assert.equal(doc.pageCount, 2);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    assert.equal(text.slice(startxref, startxref + 4), "xref");
    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)];
    assert.equal(entries.length, size - 1);
    for (const [index, entry] of entries.entries()) {
      const offset = Number(entry[1]);
      assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`);
    }
    assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
    assert.match(text, /\\\(par\\351ntesis\\\)/); // escaped parentheses and octal é
    assert.match(text, /\/Count 2/);
  });

  it("measures text with the standard font widths and truncates with an ellipsis", () => {
    assert.equal(pdfTextWidth("0", "regular", 10), 5.56);
    assert.equal(pdfTextWidth("0", "bold", 10), 5.56);
    assert.ok(pdfTextWidth("Habitaciones", "bold", 9) > pdfTextWidth("Habitaciones", "regular", 9));
    const fitted = pdfFit("Una descripción larguísima de la cuenta contable", "regular", 9, 60);
    assert.ok(fitted.endsWith("…"));
    assert.ok(pdfTextWidth(fitted, "regular", 9) <= 60);
  });

  it("paginates long tables and repeats the header", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ cells: [`Fila ${i}`, (i * 1.5).toFixed(2)] }));
    const bytes = renderPdfReport([{ title: "Tabla", columns: [{ label: "Concepto", width: 300, align: "left" }, { label: "Importe", width: 100, align: "right" }], rows }], { title: "Informe", subtitle: "sub" });
    const count = Number(/\/Count (\d+)/.exec(bytes.toString("latin1"))![1]);
    assert.ok(count >= 3, `expected ≥ 3 pages, got ${count}`);
  });
});

describe("XLSX writer", () => {
  it("writes a ZIP with the SpreadsheetML parts and inline strings / numeric cells", () => {
    const bytes = writeXlsx([
      { name: "Balance [2027]", widths: [40, 14], rows: [[{ text: "Epígrafe", bold: true }, { text: "Importe", bold: true }], ["Caja", { amount: "1234.56" }], ["Texto & <xml>", { amount: "—" }]] },
      { name: "Balance [2027]", rows: [] }
    ]);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    const entries = readZipEntries(bytes);
    assert.deepEqual([...entries.keys()], ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    const sheet = entries.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    assert.match(sheet, /<c r="B2" s="1"><v>1234.56<\/v><\/c>/);
    assert.match(sheet, /<c r="A1" t="inlineStr" s="2"><is><t xml:space="preserve">Epígrafe<\/t><\/is><\/c>/);
    assert.match(sheet, /Texto &amp; &lt;xml&gt;/);
    assert.match(sheet, /<c r="B3" t="inlineStr" s="0"><is><t>—<\/t><\/is><\/c>/);
    const workbook = entries.get("xl/workbook.xml")!.toString("utf8");
    assert.match(workbook, /<sheet name="Balance  2027" sheetId="1" r:id="rId1"\/>/);
    assert.match(workbook, /<sheet name="Balance  2027 \(2\)" sheetId="2" r:id="rId2"\/>/);
    const end = bytes.readUInt32LE(bytes.length - 22);
    assert.equal(end, 0x06054b50);
    assert.equal(bytes.readUInt16LE(bytes.length - 22 + 10), 7);
  });

  it("helpers: column letters, sheet names, raw zip round-trip", () => {
    assert.equal(columnLetter(0), "A");
    assert.equal(columnLetter(25), "Z");
    assert.equal(columnLetter(26), "AA");
    assert.equal(sanitizeSheetName("a/b:c*d?e[f]g\\h", new Set()), "a b c d e f g h");
    const zip = writeZip([{ name: "x.txt", data: Buffer.from("hola") }]);
    assert.equal(readZipEntries(zip).get("x.txt")!.toString(), "hola");
  });
});

describe("statement renderer", () => {
  it("renders the USALI statement and the balance into pdf / xlsx / csv", async () => {
    const source = referenceLedger();
    const period = { from: "2027-01-01", to: "2027-12-31" };
    const rows = await source.accountBalances({ organizationId: "org_t", mode: "movements", ...period, groups: [6, 7] });
    const pnl = computeUsaliPnl({ organizationId: "org_t", propertyId: "prop_t", propertyName: "Hotel Test", period, currency: "EUR", rows, mappings: [], occupancy: source.occupancyFacts });
    const doc = statementDocument(pnl, "Test Org SL");
    assert.equal(doc.tables.length, 2);
    const csv = documentToCsv(doc);
    assert.match(csv, /GOP · BENEFICIO OPERATIVO BRUTO;-1285,00;-0,35;-28,56/); // 365 nights × 10 rooms
    assert.match(csv, /SIN ASIGNAR \(cuentas sin mapeo USALI\);-7,00/);
    assert.match(csv, /645 · Retribuciones en especie \(expense\);7,00/); // account rows are cost-positive; the block net is −7,00
    const pdf = documentToPdf(doc);
    assert.ok(pdf.toString("latin1").startsWith("%PDF-1.4"));
    const xlsx = documentToXlsx(doc);
    const sheet = readZipEntries(xlsx).get("xl/worksheets/sheet1.xml")!.toString("utf8");
    assert.match(sheet, /<v>-1285.00<\/v>/);

    const [rowsAt, rowsBefore, rowsMovements] = await Promise.all([
      source.accountBalances({ organizationId: "org_t", mode: "balance_at", to: period.to }),
      source.accountBalances({ organizationId: "org_t", mode: "balance_at", to: addDays(period.from, -1) }),
      source.accountBalances({ organizationId: "org_t", mode: "movements", ...period })
    ]);
    const balance = computeBalance({ organizationId: "org_t", propertyId: null, period, rowsAt, rowsBefore, rowsMovements });
    const file = renderStatementFile(balance, "csv");
    assert.equal(file.contentType, "text/csv; charset=utf-8");
    assert.match(file.buffer.toString("utf8"), /TOTAL ACTIVO \(A \+ B\);60184,80/);
    assert.match(file.buffer.toString("utf8"), /TOTAL PATRIMONIO NETO Y PASIVO \(A \+ B \+ C\);60184,80/);
    assert.equal(renderStatementFile(balance, "pdf").extension, "pdf");
    assert.equal(renderStatementFile(balance, "xlsx").contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});

describe("gestoría export builders", () => {
  it("csv universal: one row per line, decimal comma, NIF and document resolved from the source document", async () => {
    const source = referenceLedger();
    const build = await buildCsvUniversal(source, { organizationId: "org_t", from: "2027-03-10", to: "2027-03-15" });
    const lines = build.content.slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines[0], "fecha;asiento;cuenta;concepto;debe;haber;documento;nif;base;iva");
    assert.equal(build.rowCount, 11);
    assert.equal(lines.length, 12);
    assert.equal(lines[1], "10/03/2027;3;4300;Factura alojamiento;121,00;0,00;FAC-2027-000001;12345678Z;;");
    assert.equal(lines[3], "10/03/2027;3;477.21;Factura alojamiento;0,00;21,00;FAC-2027-000001;12345678Z;100,00;21");
    assert.match(build.content, /15\/03\/2027;6;472\.10;Factura proveedor alimentos;4,00;0,00;PROV-77;B98765432;40,00;10/);
    assert.equal(build.unnumbered, 0);
    assert.equal(build.validateWithAdvisor, false);
  });

  it("csv universal keeps both halves of a reversal pair (libro diario completo) and still balances", async () => {
    const source = referenceLedger();
    const sale = source.entries.find((e) => e.sourceType === "invoice" && e.sourceId === "inv_1")!; // entry 3 of the reference ledger
    source.reverse(sale.id!, { date: "2027-03-14", sourceType: "invoice_cancellation", sourceId: "inv_1", description: "Anulación de la factura FAC-2027-000001" });
    const build = await buildCsvUniversal(source, { organizationId: "org_t", from: "2027-03-10", to: "2027-03-15" });
    const lines = build.content.slice(1).split("\r\n").filter(Boolean);
    assert.equal(build.rowCount, 14); // 11 reference rows + the 3 lines of the reversal (the 3 of the original were already there)
    assert.ok(lines.includes("14/03/2027;14;4300;Anulación de la factura FAC-2027-000001;0,00;121,00;FAC-2027-000001;12345678Z;;"));
    assert.ok(lines.includes("14/03/2027;14;705.1;Anulación de la factura FAC-2027-000001;100,00;0,00;FAC-2027-000001;12345678Z;;"));
    assert.ok(lines.includes("14/03/2027;14;477.21;Anulación de la factura FAC-2027-000001;21,00;0,00;FAC-2027-000001;12345678Z;100,00;21"));
    assert.ok(lines.includes("10/03/2027;3;4300;Factura alojamiento;121,00;0,00;FAC-2027-000001;12345678Z;;"), "the reversed original stays in the diario");
    const debe = lines.slice(1).reduce((sum, line) => sum + Number(line.split(";")[4]!.replace(",", ".")), 0);
    const haber = lines.slice(1).reduce((sum, line) => sum + Number(line.split(";")[5]!.replace(",", ".")), 0);
    assert.equal(debe.toFixed(2), haber.toFixed(2));
  });

  it("labels unnumbered entries as P-<id> and counts them", () => {
    assert.equal(entryNumberLabel({ entryNumber: 12, entryId: "x" }), "12");
    assert.equal(entryNumberLabel({ entryNumber: null, entryId: "abc" }), "P-abc");
    const row = csvUniversalRow(
      { entryId: "e1", entryDate: "2027-01-02", entryNumber: null, fiscalYearCode: "2027", sourceType: "manual", sourceId: null, description: null, reference: null, propertyId: null, lineId: "l1", accountCode: "572", accountName: "Bancos", lineDescription: null, debit: D("1"), credit: D(0), taxRateCode: null, taxBase: null },
      null
    );
    assert.deepEqual(row, ["02/01/2027", "P-e1", "572", "Asiento manual", "1,00", "0,00", "", "", "", ""]);
  });

  it("contaplus: sub-accounts padded to the company length, CONTRA on two-line entries, flagged validateWithAdvisor", async () => {
    assert.equal(contaplusSubaccount("705.1"), "70510000");
    assert.equal(contaplusSubaccount("4300"), "43000000");
    assert.equal(contaplusSubaccount("477.21", 10), "4772100000");
    assert.equal(contaplusSubaccount("123456789", 8), "12345678");
    const source = referenceLedger();
    const build = await buildContaplusDiario(source, { organizationId: "org_t", from: "2027-03-12", to: "2027-03-12" });
    const lines = build.content.slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines[0], "ASIEN;FECHA;SUBCTA;CONTRA;CONCEPTO;EURODEBE;EUROHABER;FACTURA;BASEEURO;IVA;DOCUMENTO");
    assert.equal(lines[1], "5;12/03/2027;57000000;43000000;Cobro en efectivo;176,00;0,00;;;;");
    assert.equal(lines[2], "5;12/03/2027;43000000;57000000;Cobro en efectivo;0,00;176,00;;;;");
    assert.equal(build.validateWithAdvisor, true);
  });

  it("vat books csv and format catalogue", async () => {
    const source = referenceLedger();
    source.vatRows = [
      { book: "emitidas", date: "2027-03-10", series: "FAC", number: "FAC-2027-000001", counterpartyNif: "12345678Z", counterpartyName: "Cliente Uno", base: D("100"), rate: D("21"), quota: D("21"), total: D("121"), retention: D(0), taxFigure: "IVA", surchargeRate: null, surchargeQuota: null, sourceType: "invoice", sourceId: "inv_1", period: "2027-Q1", deductible: true }
    ];
    const build = await buildVatBooksCsv(source, { organizationId: "org_t", from: "2027-01-01", to: "2027-12-31" });
    const lines = build.content.slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines[1], "emitidas;10/03/2027;FAC;FAC-2027-000001;12345678Z;Cliente Uno;100,00;21,00;21,00;121,00;0,00;IVA;;;2027-Q1;S;invoice;inv_1");
    assert.equal(exportFileName({ format: "csv_universal", periodFrom: "2027-01-01", periodTo: "2027-03-31", organizationId: "org_t" }), "asientos_org_t_2027-01-01_2027-03-31.csv");
    assert.deepEqual(GESTORIA_FORMATS.map((f) => [f.format, f.implemented, f.validateWithAdvisor]), [
      ["csv_universal", true, false],
      ["vat_books_csv", true, false],
      ["contaplus_diario", true, true],
      ["a3", false, true]
    ]);
  });
});

/**
 * Fix t6b#4 (R11): a stored export has no centre, so the whole family is a
 * whole-sociedad artefact. A centre-scoped user (roles in one hotel, no
 * accounting.entity.read) gets the opaque 404 BEFORE any database access; the
 * entity-scoped user and an organization-wide context pass.
 */
describe("gestoría exports · ámbito de toda la sociedad (t6b#4)", () => {
  const base = { organizationId: "org_t", propertyId: "prop_lt", userId: "usr_t", fullName: "Director", deviceId: "test" };
  const director: UserContext = { ...base, permissions: ["analytics.export"] as UserContext["permissions"], assignedPropertyIds: ["prop_lt"] };
  const directora: UserContext = { ...director, permissions: ["analytics.export", "accounting.entity.read"] as UserContext["permissions"] };
  const orgWide: UserContext = { ...director, assignedPropertyIds: undefined };
  const scopeDenied = (error: unknown): boolean => {
    const e = error as { statusCode?: number; details?: { code?: string }; message: string };
    return e.statusCode === 404 && e.details?.code === "ENTITY_SCOPE_REQUIRED" && !/prop_/.test(e.message);
  };

  it("list, get and create are an opaque 404 ENTITY_SCOPE_REQUIRED for the centre-scoped user, with or without a propertyId", async () => {
    await assert.rejects(listGestoriaExports({ context: director }), scopeDenied);
    await assert.rejects(getGestoriaExport({ context: director, exportId: "exp_x" }), scopeDenied);
    await assert.rejects(createGestoriaExport({ context: director, format: "csv_universal", from: "2031-02-01", to: "2031-02-28", correlationId: "t" }), scopeDenied);
    await assert.rejects(createGestoriaExport({ context: director, format: "csv_universal", from: "2031-02-01", to: "2031-02-28", propertyId: "prop_lt", correlationId: "t" }), scopeDenied);
    assert.throws(() => assertGestoriaExportScope(director), scopeDenied);
    assert.throws(() => assertGestoriaExportScope(director, "prop_lt"), scopeDenied);
  });

  it("the entity-scoped user and an organization-wide context pass; a sister centre is still «Propiedad no encontrada»", () => {
    assert.doesNotThrow(() => assertGestoriaExportScope(directora));
    assert.doesNotThrow(() => assertGestoriaExportScope(directora, "prop_lt"));
    assert.doesNotThrow(() => assertGestoriaExportScope(orgWide));
    assert.doesNotThrow(() => assertGestoriaExportScope(orgWide, "prop_ra"));
    assert.throws(() => assertGestoriaExportScope(directora, "prop_ra"), (error: unknown) => (error as { statusCode?: number }).statusCode === 404 && (error as Error).message === "Propiedad no encontrada.");
  });

  it("the permission check comes first: without analytics.export the answer is 403, not the scope 404", async () => {
    const noKey: UserContext = { ...director, permissions: [] as unknown as UserContext["permissions"] };
    await assert.rejects(listGestoriaExports({ context: noKey }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
  });
});
