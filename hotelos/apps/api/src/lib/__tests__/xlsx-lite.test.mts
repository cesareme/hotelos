// Unit tests · Tanda 7 · L1 — lector XLSX-lite sin dependencias (ZIP + SpreadsheetML).
// Sin base de datos; libros sintéticos montados en el propio test. Desde apps/api:
//   node --import tsx --test src/lib/__tests__/xlsx-lite.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { writeXlsx, writeZip } from "../../modules/financial-statements/xlsx-writer.js";
import {
  XLSX_LITE_MAX_ENTRIES,
  MAX_SCIENTIFIC_DIGITS,
  XlsxLiteError,
  columnIndexFromRef,
  decodeXmlText,
  excelFractionToTime,
  excelSerialToIso,
  expandScientific,
  inflateZipEntry,
  isDateNumFmt,
  readXlsxTable,
  readZipCentralDirectory
} from "../xlsx-lite.js";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

type SheetSpec = { name: string; xml: string; hidden?: boolean; target?: string };

/** Libro sintético: partes XML a mano dentro de un ZIP de `writeZip`. */
function workbook(spec: { sheets: SheetSpec[]; sharedStrings?: string; styles?: string; date1904?: boolean }): Buffer {
  const sheetsXml = spec.sheets
    .map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}"${sheet.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`)
    .join("");
  const relsXml = spec.sheets
    .map((sheet, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="${sheet.target ?? `worksheets/sheet${i + 1}.xml`}"/>`)
    .join("");
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: "_rels/.rels", data: Buffer.from(`${XML}<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(`${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><workbookPr date1904="${spec.date1904 ? "1" : "0"}"/><sheets>${sheetsXml}</sheets></workbook>`)
    },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`${XML}<Relationships xmlns="${NS_REL}">${relsXml}<Relationship Id="rId99" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>`) },
    ...spec.sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(`${XML}<worksheet xmlns="${NS_MAIN}"><sheetData>${sheet.xml}</sheetData></worksheet>`) }))
  ];
  if (spec.sharedStrings !== undefined) entries.push({ name: "xl/sharedStrings.xml", data: Buffer.from(`${XML}<sst xmlns="${NS_MAIN}">${spec.sharedStrings}</sst>`) });
  if (spec.styles !== undefined) entries.push({ name: "xl/styles.xml", data: Buffer.from(`${XML}<styleSheet xmlns="${NS_MAIN}">${spec.styles}</styleSheet>`) });
  return writeZip(entries, new Date(Date.UTC(2026, 8, 16)));
}

type RawEntry = {
  name: string;
  data: Buffer;
  method?: number;
  flags?: number;
  declaredUncompressed?: number;
  localCompressed?: number;
};

/** ZIP a mano con tamaños y banderas manipulables (data descriptor, bombas, métodos raros). */
function buildZipRaw(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.localCompressed ?? compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.declaredUncompressed ?? entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const cdSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Aplica `patch` sobre la cabecera central de la entrada `name` (copia del buffer). */
function patchCentral(zip: Buffer, name: string, patch: (buf: Buffer, offset: number) => void): Buffer {
  const copy = Buffer.from(zip);
  const eocd = copy.length - 22;
  const count = copy.readUInt16LE(eocd + 10);
  let offset = copy.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const nameLength = copy.readUInt16LE(offset + 28);
    const extraLength = copy.readUInt16LE(offset + 30);
    const commentLength = copy.readUInt16LE(offset + 32);
    const entryName = copy.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (entryName === name) patch(copy, offset);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return copy;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof XlsxLiteError) return error.code;
    throw error;
  }
  return "(sin error)";
}

const raws = (buffer: Buffer, options?: Parameters<typeof readXlsxTable>[1]) => readXlsxTable(buffer, options).rows.map((row) => row.cells.map((cell) => cell.raw));

describe("xlsx-lite · helpers", () => {
  it("decodeXmlText: entidades y escapes _xHHHH_", () => {
    assert.equal(decodeXmlText("Tom &amp; Jerry &lt;3&gt; &quot;a&quot; &apos;b&apos; &#65;&#x42;"), "Tom & Jerry <3> \"a\" 'b' AB");
    assert.equal(decodeXmlText("foo_x000D_bar"), "foo\rbar");
    assert.equal(decodeXmlText("_x005F_x000D_"), "_x000D_", "escape del guion bajo literal");
    assert.equal(decodeXmlText(""), "");
    assert.equal(decodeXmlText("sin entidades"), "sin entidades");
  });

  it("columnIndexFromRef: A → 1, Z → 26, AA → 27, AB12 → 28", () => {
    assert.equal(columnIndexFromRef("A1"), 1);
    assert.equal(columnIndexFromRef("Z9"), 26);
    assert.equal(columnIndexFromRef("AA1"), 27);
    assert.equal(columnIndexFromRef("AB12"), 28);
    assert.equal(codeOf(() => columnIndexFromRef("12")), "XLSX_BAD_XML");
  });

  it("isDateNumFmt: ids incorporados y formatCode con d/m/y/h/s fuera de literales", () => {
    assert.equal(isDateNumFmt(14), true);
    assert.equal(isDateNumFmt(22), true);
    assert.equal(isDateNumFmt(0), false);
    assert.equal(isDateNumFmt(4), false);
    assert.equal(isDateNumFmt(164, "#,##0.00;[Red]-#,##0.00"), false, "el [Red] no cuenta");
    assert.equal(isDateNumFmt(165, "hh:mm"), true);
    assert.equal(isDateNumFmt(166, "dd/mm/yyyy"), true);
    assert.equal(isDateNumFmt(167, '#,##0 "hab"'), false, "literal entrecomillado");
    assert.equal(isDateNumFmt(168, "0.00\\h"), false, "escape");
    assert.equal(isDateNumFmt(169, "[$€-C0A] #,##0.00"), false);
    assert.equal(isDateNumFmt(170, "General"), false);
  });

  it("excelSerialToIso: época 1900 con el hueco del 29/02/1900 y época 1904", () => {
    assert.equal(excelSerialToIso(46000), "2025-12-09");
    assert.equal(excelSerialToIso(1), "1900-01-01");
    assert.equal(excelSerialToIso(59), "1900-02-28");
    assert.equal(excelSerialToIso(61), "1900-03-01");
    assert.equal(excelSerialToIso(2958465), "9999-12-31");
    assert.equal(excelSerialToIso(46000.75), "2025-12-09", "la hora se ignora");
    assert.equal(codeOf(() => excelSerialToIso(60)), "XLSX_BAD_DATE");
    assert.equal(codeOf(() => excelSerialToIso(0)), "XLSX_BAD_DATE");
    assert.equal(codeOf(() => excelSerialToIso(2958466)), "XLSX_BAD_DATE");
    assert.equal(excelSerialToIso(0, true), "1904-01-01");
    assert.equal(excelSerialToIso(44561, true), "2026-01-01", "1904 = 1900 + 1462 días");
    assert.equal(excelSerialToIso(2957003, true), "9999-12-31");
  });

  it("excelFractionToTime: 0.6875 → 16:30, 0 → 00:00, 0.99999 → 23:59", () => {
    assert.equal(excelFractionToTime(0.6875), "16:30");
    assert.equal(excelFractionToTime(0), "00:00");
    assert.equal(excelFractionToTime(0.5), "12:00");
    assert.equal(excelFractionToTime(0.99999), "23:59");
    assert.equal(codeOf(() => excelFractionToTime(1)), "XLSX_BAD_DATE");
  });

  it("expandScientific: enteros con BigInt, decimales exactos, aviso > 2^53", () => {
    assert.deepEqual(expandScientific("6.00123456E8"), { text: "600123456", unsafe: false });
    assert.deepEqual(expandScientific("1E3"), { text: "1000", unsafe: false });
    assert.deepEqual(expandScientific("-2.5E1"), { text: "-25", unsafe: false });
    assert.deepEqual(expandScientific("1.5E-3"), { text: "0.0015", unsafe: false });
    assert.deepEqual(expandScientific("1.2345E2"), { text: "123.45", unsafe: false });
    assert.deepEqual(expandScientific("9.007199254740993E15"), { text: "9007199254740993", unsafe: true });
    assert.deepEqual(expandScientific("312.5"), { text: "312.5", unsafe: false }, "sin exponente se devuelve tal cual");
  });

  it("SEC-T7-01: un exponente o una mantisa desmesurados no se expanden (ni BigInt ni String.repeat): texto tal cual, unsafe", () => {
    const started = Date.now();
    assert.deepEqual(expandScientific("9E900000000"), { text: "9E900000000", unsafe: true });
    assert.deepEqual(expandScientific("9E40000000"), { text: "9E40000000", unsafe: true });
    assert.deepEqual(expandScientific("1E-2000000000"), { text: "1E-2000000000", unsafe: true });
    assert.deepEqual(expandScientific(`1E${MAX_SCIENTIFIC_DIGITS + 1}`), { text: `1E${MAX_SCIENTIFIC_DIGITS + 1}`, unsafe: true });
    const longMantissa = `${"7".repeat(MAX_SCIENTIFIC_DIGITS + 1)}E1`;
    assert.deepEqual(expandScientific(longMantissa), { text: longMantissa, unsafe: true });
    const huge = `1${"0".repeat(5000)}E3`;
    assert.deepEqual(expandScientific(huge), { text: huge, unsafe: true }, "una celda de kilobytes ni se analiza");
    assert.ok(Date.now() - started < 200, "responde en milisegundos");
    // Justo en el tope sigue expandiéndose de forma exacta.
    assert.equal(expandScientific(`1E${MAX_SCIENTIFIC_DIGITS}`).text, `1${"0".repeat(MAX_SCIENTIFIC_DIGITS)}`);
    assert.equal(expandScientific("1E308").text.length, 309, "el máximo de Excel (1E308) se expande");
  });
});

describe("xlsx-lite · ZIP", () => {
  it("readZipCentralDirectory lee las entradas de writeZip", () => {
    const zip = writeZip([
      { name: "a.txt", data: Buffer.from("hola") },
      { name: "dir/b.txt", data: Buffer.from("adiós") }
    ]);
    const entries = readZipCentralDirectory(zip);
    assert.deepEqual(entries.map((entry) => entry.name), ["a.txt", "dir/b.txt"]);
    assert.equal(entries[0]!.method, 8);
    assert.equal(entries[0]!.uncompressedSize, 4);
    assert.equal(inflateZipEntry(zip, entries[0]!).toString("utf8"), "hola");
    assert.equal(inflateZipEntry(zip, entries[1]!).toString("utf8"), "adiós");
  });

  it("método 0 (almacenado) se copia; método raro → XLSX_COMPRESSION", () => {
    const stored = buildZipRaw([{ name: "s.txt", data: Buffer.from("stored"), method: 0 }]);
    const entries = readZipCentralDirectory(stored);
    assert.equal(inflateZipEntry(stored, entries[0]!).toString("utf8"), "stored");
    const weird = buildZipRaw([{ name: "w.txt", data: Buffer.from("x"), method: 12 }]);
    assert.equal(codeOf(() => inflateZipEntry(weird, readZipCentralDirectory(weird)[0]!)), "XLSX_COMPRESSION");
  });

  it("no-ZIP → XLSX_NOT_ZIP (texto, PK sin directorio, vacío)", () => {
    assert.equal(codeOf(() => readZipCentralDirectory(Buffer.from("llegada;salida\n2026-10-12;2026-10-15\n"))), "XLSX_NOT_ZIP");
    assert.equal(codeOf(() => readZipCentralDirectory(Buffer.from("PK" + "x".repeat(40)))), "XLSX_NOT_ZIP");
    assert.equal(codeOf(() => readZipCentralDirectory(Buffer.alloc(0))), "XLSX_NOT_ZIP");
    assert.equal(codeOf(() => readXlsxTable(Buffer.from("%PDF-1.4"))), "XLSX_NOT_ZIP");
  });

  it("ZIP64 (marcas 0xFFFFFFFF) → XLSX_ZIP64", () => {
    const zip = writeZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const patched = Buffer.from(zip);
    patched.writeUInt32LE(0xffffffff, patched.length - 22 + 16);
    assert.equal(codeOf(() => readZipCentralDirectory(patched)), "XLSX_ZIP64");
    const patchedEntry = patchCentral(zip, "a.txt", (buf, offset) => buf.writeUInt32LE(0xffffffff, offset + 24));
    assert.equal(codeOf(() => readZipCentralDirectory(patchedEntry)), "XLSX_ZIP64");
  });

  it("más de 2.000 entradas → XLSX_TOO_MANY_ENTRIES", () => {
    const zip = writeZip(Array.from({ length: XLSX_LITE_MAX_ENTRIES + 1 }, (_, i) => ({ name: `p${i}.txt`, data: Buffer.from("x") })));
    assert.equal(codeOf(() => readZipCentralDirectory(zip)), "XLSX_TOO_MANY_ENTRIES");
  });

  it("bomba: parte declarada > 32 MiB, suma > 64 MiB e inflado real por encima del tope → XLSX_BOMB", () => {
    const book = writeXlsx([{ name: "Reservas", rows: [["a"], ["1"]] }]);
    const bigPart = patchCentral(book, "xl/worksheets/sheet1.xml", (buf, offset) => buf.writeUInt32LE(40 * 1024 * 1024, offset + 24));
    assert.equal(codeOf(() => readZipCentralDirectory(bigPart)), "XLSX_BOMB");
    let sum = book;
    for (const name of ["xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
      sum = patchCentral(sum, name, (buf, offset) => buf.writeUInt32LE(30 * 1024 * 1024, offset + 24));
    }
    assert.equal(codeOf(() => readZipCentralDirectory(sum)), "XLSX_BOMB");
    // Tamaño declarado mentiroso (1.000 bytes) con 33 MiB reales: el inflado acotado lo corta.
    const lying = buildZipRaw([{ name: "xl/workbook.xml", data: Buffer.alloc(33 * 1024 * 1024), declaredUncompressed: 1000 }]);
    const entries = readZipCentralDirectory(lying);
    assert.equal(entries[0]!.uncompressedSize, 1000);
    assert.equal(codeOf(() => inflateZipEntry(lying, entries[0]!)), "XLSX_BOMB");
  });

  it("data descriptor simulado: cabecera local con compSize 0 y bit 3; se usan los tamaños del directorio central", () => {
    const book = writeXlsx([{ name: "Reservas", rows: [["llegada", "tipo_habitacion"], ["2026-10-12", "DBL"]] }]);
    const patched = Buffer.from(book);
    for (const entry of readZipCentralDirectory(book)) {
      const offset = entry.localHeaderOffset;
      patched.writeUInt16LE(patched.readUInt16LE(offset + 6) | 0x08, offset + 6);
      patched.writeUInt32LE(0, offset + 14);
      patched.writeUInt32LE(0, offset + 18);
      patched.writeUInt32LE(0, offset + 22);
    }
    assert.deepEqual(raws(patched), [
      ["llegada", "tipo_habitacion"],
      ["2026-10-12", "DBL"]
    ]);
  });
});

describe("xlsx-lite · libro de writeXlsx", () => {
  it("lee cabecera y filas idénticas (inlineStr, números crudos, importes)", () => {
    const buffer = writeXlsx([
      {
        name: "Reservas",
        rows: [
          ["llegada", "salida", "tipo_habitacion", "importe_total", "notas"],
          ["2026-10-12", "2026-10-15", "DBL", { amount: "312.00" }, "Cama de matrimonio"],
          ["2026-10-13", "", "IND", 296.5, ""],
          [{ text: "Negrita", bold: true }, 0, "x"]
        ]
      },
      { name: "Instrucciones", rows: [["campo", "ayuda"]] }
    ]);
    const table = readXlsxTable(buffer);
    assert.equal(table.sheetName, "Reservas");
    assert.equal(table.date1904, false);
    assert.equal(table.truncated, false);
    assert.deepEqual(table.warnings, []);
    assert.deepEqual(table.rows.map((row) => row.row), [1, 2, 3, 4]);
    assert.deepEqual(
      table.rows.map((row) => row.cells.map((cell) => cell.raw)),
      [
        ["llegada", "salida", "tipo_habitacion", "importe_total", "notas"],
        ["2026-10-12", "2026-10-15", "DBL", "312.00", "Cama de matrimonio"],
        ["2026-10-13", "", "IND", "296.5"],
        ["Negrita", "0", "x"]
      ]
    );
    assert.deepEqual(table.rows[1]!.cells.map((cell) => cell.kind), ["string", "string", "string", "number", "string"]);
    assert.deepEqual(table.rows[2]!.cells.map((cell) => cell.kind), ["string", "empty", "string", "number"]);
    assert.equal(table.rows[1]!.cells[3]!.dateStyle, false, "el formato de importe no es de fecha");
    assert.equal(readXlsxTable(buffer, { sheetName: "Instrucciones" }).rows[0]!.cells[1]!.raw, "ayuda");
  });
});

describe("xlsx-lite · libro sintético", () => {
  const SHARED =
    "<si><t>Llegada</t></si>" +
    '<si><r><rPr><b/></rPr><t>Tom&amp;</t></r><r><t xml:space="preserve"> Jerry &lt;3</t></r></si>' +
    "<si><t>foo_x000D_bar</t></si>" +
    '<si><t>Doble</t><rPh sb="0" eb="1"><t>IGNORADO</t></rPh></si>';
  const STYLES =
    '<numFmts count="1"><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts>' +
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0"><alignment horizontal="center"/></xf>' +
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="0"/></cellXfs>';
  const HIDDEN = '<row r="1"><c r="A1" t="inlineStr"><is><t>OCULTA</t></is></c></row>';
  const MAIN =
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Tipo</t></is></c><c r="D1" t="str"><v>Hora</v></c></row>' +
    '<row r="2"><c r="A2" s="1"><v>46000</v></c><c r="B2" s="1"><v>60</v></c><c r="C2" s="2"><v>0.6875</v></c><c r="D2"><v>6.00123456E8</v></c><c r="E2" s="3"><v>312.5</v></c></row>' +
    '<row><c t="b"><v>1</v></c><c t="e"><v>#N/A</v></c><c r="D3" s="3"/><c r="E3"><f>SUM(A1)</f><v>7</v></c><c r="F3" t="s"><v>2</v></c><c r="G3" t="s"><v>3</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t></t></is></c><c r="B4"/></row>' +
    '<row r="5"><c r="A5" t="d"><v>2026-10-12T00:00:00</v></c><c r="B5" t="n"><v>2</v></c><c r="C5"><f>A1</f></c></row>';
  const book = workbook({
    sheets: [
      { name: "Oculta", xml: HIDDEN, hidden: true },
      { name: "Reservas &amp; más", xml: MAIN, target: "/xl/worksheets/sheet2.xml" }
    ],
    sharedStrings: SHARED,
    styles: STYLES
  });

  it("salta la hoja oculta, resuelve el Target absoluto y decodifica el nombre", () => {
    const table = readXlsxTable(book);
    assert.equal(table.sheetName, "Reservas & más");
    assert.deepEqual(table.rows.map((row) => row.row), [1, 2, 3, 5], "la fila 4 vacía se descarta; la fila sin r es la 3");
  });

  it("sharedStrings con runs y entidades, inlineStr, str, seriales, fracción, exponente, 312.5, t=b, t=e, autocerrada, <f>+<v>, _x000D_, t=d", () => {
    const table = readXlsxTable(book);
    const [r1, r2, r3, r5] = table.rows;
    assert.deepEqual(r1!.cells.map((cell) => cell.raw), ["Llegada", "Tom& Jerry <3", "Tipo", "Hora"]);
    assert.deepEqual(r1!.cells.map((cell) => cell.kind), ["string", "string", "string", "string"]);

    assert.deepEqual(r2!.cells.map((cell) => cell.raw), ["2025-12-09", "", "16:30", "600123456", "312.5"]);
    assert.deepEqual(r2!.cells.map((cell) => cell.kind), ["date", "error", "time", "number", "number"]);
    assert.deepEqual(r2!.cells.map((cell) => cell.dateStyle), [true, true, true, false, false]);

    assert.deepEqual(r3!.cells.map((cell) => cell.raw), ["TRUE", "", "", "", "7", "foo\rbar", "Doble"]);
    assert.deepEqual(r3!.cells.map((cell) => cell.kind), ["bool", "error", "empty", "empty", "number", "string", "string"]);

    assert.deepEqual(r5!.cells.map((cell) => cell.raw), ["2026-10-12", "2"]);
    assert.deepEqual(r5!.cells.map((cell) => cell.kind), ["date", "number"]);

    assert.ok(table.warnings.some((w) => w.includes("B2") && w.includes("29/02/1900")), `aviso del serial 60: ${JSON.stringify(table.warnings)}`);
    assert.ok(table.warnings.some((w) => w.includes("fila 3, columna 2") && w.includes("error de fórmula")), "aviso de t=e");
    assert.ok(table.warnings.some((w) => w.includes("C5") && w.includes("fórmula sin valor")), "aviso de fórmula sin <v>");
  });

  it("hoja pedida por nombre (también oculta); inexistente → XLSX_NO_SHEET", () => {
    assert.deepEqual(raws(book, { sheetName: "oculta" }), [["OCULTA"]]);
    assert.equal(codeOf(() => readXlsxTable(book, { sheetName: "Nada" })), "XLSX_NO_SHEET");
  });

  it("época 1904", () => {
    const book1904 = workbook({
      sheets: [{ name: "H", xml: '<row r="1"><c r="A1" s="1"><v>44561</v></c><c r="B1" s="1"><v>0.5</v></c></row>' }],
      styles: STYLES,
      date1904: true
    });
    const table = readXlsxTable(book1904);
    assert.equal(table.date1904, true);
    assert.deepEqual(table.rows[0]!.cells.map((cell) => cell.raw), ["2026-01-01", "12:00"]);
  });

  it("sin workbook.xml → XLSX_NO_WORKBOOK; todas las hojas ocultas → XLSX_NO_SHEET; hoja sin XML → XLSX_BAD_XML", () => {
    assert.equal(codeOf(() => readXlsxTable(writeZip([{ name: "hola.txt", data: Buffer.from("x") }]))), "XLSX_NO_WORKBOOK");
    assert.equal(codeOf(() => readXlsxTable(workbook({ sheets: [{ name: "H", xml: HIDDEN, hidden: true }] }))), "XLSX_NO_SHEET");
    const broken = writeZip([
      { name: "xl/workbook.xml", data: Buffer.from(`${XML}<workbook xmlns="${NS_MAIN}"><sheets><sheet name="H" sheetId="1"/></sheets></workbook>`) },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from("esto no es XML") }
    ]);
    assert.equal(codeOf(() => readXlsxTable(broken)), "XLSX_BAD_XML");
  });

  it("sin rels ni sharedStrings: fallback a sheet<sheetId>.xml", () => {
    const minimal = writeZip([
      { name: "xl/workbook.xml", data: Buffer.from(`${XML}<workbook xmlns="${NS_MAIN}"><sheets><sheet name="Solo" sheetId="7"/></sheets></workbook>`) },
      { name: "xl/worksheets/sheet7.xml", data: Buffer.from(`${XML}<worksheet xmlns="${NS_MAIN}"><sheetData><row><c t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>`) }
    ]);
    assert.deepEqual(raws(minimal), [["ok"]]);
  });

  it("maxRows corta con truncated; maxCols descarta columnas; maxCellChars recorta", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `<row><c t="inlineStr"><is><t>fila ${i + 1}</t></is></c><c t="inlineStr"><is><t>${"x".repeat(30)}</t></is></c><c/><c/><c/><c t="inlineStr"><is><t>F</t></is></c></row>`).join("");
    const many = workbook({ sheets: [{ name: "H", xml: rows }] });
    const table = readXlsxTable(many, { maxRows: 4, maxCols: 3, maxCellChars: 10 });
    assert.equal(table.rows.length, 4);
    assert.equal(table.truncated, true);
    assert.ok(table.warnings.some((w) => w.includes("supera las 4 filas")));
    assert.ok(table.warnings.some((w) => w.includes("más de 3 columnas")));
    assert.deepEqual(table.rows[0]!.cells.map((cell) => cell.raw), ["fila 1", "xxxxxxxxxx"], "las celdas vacías finales se recortan");
    assert.ok(table.warnings.some((w) => w.includes("recortada a 10")));
    const full = readXlsxTable(many);
    assert.equal(full.rows.length, 10);
    assert.equal(full.truncated, false);
    assert.equal(full.rows[9]!.cells.length, 6);
  });

  it("SEC-T7-01: una celda numérica <v>9E900000000</v> (o 1E-2000000000) no cuelga el lector: texto tal cual con aviso", () => {
    const rows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>importe</t></is></c><c r="B1" t="inlineStr"><is><t>llegada</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>9E900000000</v></c><c r="B2" s="1"><v>1E-2000000000</v></c></row>' +
      '<row r="3"><c r="A3"><v>9E40000000</v></c><c r="B3"><v>1.5E-3</v></c></row>';
    const styles = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>';
    const bomb = workbook({ sheets: [{ name: "Bomba", xml: rows }], styles });
    const started = Date.now();
    const table = readXlsxTable(bomb, { maxCellChars: 2000 });
    assert.ok(Date.now() - started < 500, "el lector responde en milisegundos");
    assert.deepEqual(table.rows[1]!.cells.map((cell) => cell.raw), ["9E900000000", "1E-2000000000"]);
    assert.deepEqual(table.rows[2]!.cells.map((cell) => cell.raw), ["9E40000000", "0.0015"]);
    assert.ok(table.warnings.some((w) => /A2.*se conserva como texto/.test(w)), "aviso de la celda no expandida");
  });
});
