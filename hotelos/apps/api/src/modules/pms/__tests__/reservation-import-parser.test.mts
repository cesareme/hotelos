// Unit tests · Tanda 7 · L1 — parser CSV (RFC 4180, codificación, separador) y
// entrada única de fichero (formato, límites). Sin base de datos; huéspedes ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-parser.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeXlsx } from "../../financial-statements/xlsx-writer.js";
import {
  ReservationImportParseError,
  decodeBytes,
  detectDelimiter,
  detectReservationImportFormat,
  parseCsvTable,
  parseReservationImportFile,
  parseXlsxTable,
  splitCsvRecords
} from "../reservation-import.parser.js";

function errorCode(fn: () => unknown): { code: string; details: Record<string, unknown> | undefined } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReservationImportParseError) return { code: error.code, details: error.details };
    throw error;
  }
  return { code: "(sin error)", details: undefined };
}

const HEADER = "llegada;salida;tipo_habitacion;nombre;apellidos";
const ROW_1 = "2026-10-12;2026-10-15;DBL;Lucía;Ferreiro Castro";
const ROW_2 = "2026-10-13;2026-10-14;IND;Marek;Nowak";

describe("decodeBytes · detectDelimiter", () => {
  it("BOM eliminado, UTF-8 estricto y latin1 (E9 F1 80 → é ñ €) como windows-1252", () => {
    const utf8 = decodeBytes(Buffer.from("\uFEFFRégimen;Día\n", "utf8"));
    assert.equal(utf8.bom, true);
    assert.equal(utf8.encoding, "utf-8");
    assert.equal(utf8.text, "Régimen;Día\n");
    const latin = decodeBytes(Buffer.from([0x63, 0x3b, 0x64, 0x0a, 0xe9, 0x3b, 0xf1, 0x80, 0x0a]));
    assert.equal(latin.encoding, "windows-1252");
    assert.equal(latin.bom, false);
    assert.equal(latin.text, "c;d\né;ñ€\n");
  });

  it("detectDelimiter: «;» «,» tab «|»; desempate «;» > tab > «,» > «|»; comillas ignoradas", () => {
    assert.equal(detectDelimiter("a;b;c\n1;2;3\n"), ";");
    assert.equal(detectDelimiter("a,b,c\n1,2,3\n"), ",");
    assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3\n"), "\t");
    assert.equal(detectDelimiter("a|b|c\n1|2|3\n"), "|");
    assert.equal(detectDelimiter("a;b\n\"1,5\";\"2,5\"\n"), ";", "las comas entre comillas no cuentan");
    assert.equal(detectDelimiter("a;b\n1,5;2,5\n3,5;4,5\n"), ";", "la cabecera manda: «,» no aparece en ella");
    assert.equal(detectDelimiter("a;b,c\n1;2,3\n"), ";", "empate → «;»");
    assert.equal(detectDelimiter("solo\nuna\n"), ";");
    assert.equal(detectDelimiter(""), ";");
  });
});

describe("splitCsvRecords · autómata RFC 4180", () => {
  it("comillas dobles «\"\"», saltos de línea dentro de campo y línea física por registro", () => {
    const text = 'nombre;notas\r\nLucía;"Dice ""hola""\r\ny adiós"\r\nMarek;x\r\n';
    const { records, unterminatedQuote } = splitCsvRecords(text, ";");
    assert.equal(unterminatedQuote, false);
    assert.deepEqual(records, [
      { line: 1, fields: ["nombre", "notas"] },
      { line: 2, fields: ["Lucía", 'Dice "hola"\r\ny adiós'] },
      { line: 4, fields: ["Marek", "x"] }
    ]);
  });

  it("CRLF, LF y CR producen los mismos registros; última línea sin salto", () => {
    for (const eol of ["\r\n", "\n", "\r"]) {
      const { records } = splitCsvRecords(`a;b${eol}1;2${eol}3;4`, ";");
      assert.deepEqual(records, [
        { line: 1, fields: ["a", "b"] },
        { line: 2, fields: ["1", "2"] },
        { line: 3, fields: ["3", "4"] }
      ]);
    }
  });

  it("delimitador final → campo vacío; comillas sin cerrar → tolerante con aviso", () => {
    assert.deepEqual(splitCsvRecords("a;b;\n", ";").records, [{ line: 1, fields: ["a", "b", ""] }]);
    const open = splitCsvRecords('a;"sin cerrar\nmás', ";");
    assert.equal(open.unterminatedQuote, true);
    assert.deepEqual(open.records, [{ line: 1, fields: ["a", "sin cerrar\nmás"] }]);
    assert.deepEqual(splitCsvRecords('a;"x"y;b\n', ";").records, [{ line: 1, fields: ["a", "xy", "b"] }], "texto tras la comilla de cierre se conserva");
  });
});

describe("parseCsvTable", () => {
  it("separadores «;» «,» tab «|» → misma tabla", () => {
    for (const delimiter of [";", ",", "\t", "|"]) {
      const text = [HEADER, ROW_1, ROW_2].map((line) => line.split(";").join(delimiter)).join("\n") + "\n";
      const table = parseCsvTable(text);
      assert.equal(table.format, "csv");
      assert.equal(table.delimiter, delimiter);
      assert.deepEqual(table.header, HEADER.split(";"));
      assert.deepEqual(table.rows.map((row) => row.cells), [ROW_1.split(";"), ROW_2.split(";")]);
      assert.deepEqual(table.rows.map((row) => [row.rowNumber, row.line]), [
        [1, 2],
        [2, 3]
      ]);
      assert.deepEqual(table.rows[0]!.kinds, ["string", "string", "string", "string", "string"]);
    }
  });

  it("bytes con BOM y UTF-8 con tildes; texto con BOM U+FEFF", () => {
    const table = parseCsvTable(Buffer.from(`\uFEFFRégimen;Día\nBB;lunes\n`, "utf8"));
    assert.equal(table.bom, true);
    assert.equal(table.encoding, "utf-8");
    assert.deepEqual(table.header, ["Régimen", "Día"]);
    const fromText = parseCsvTable("\uFEFFa;b\n1;2\n");
    assert.equal(fromText.bom, true);
    assert.deepEqual(fromText.header, ["a", "b"]);
  });

  it("latin1 (E9 F1 80) → é ñ € con encoding windows-1252 y aviso", () => {
    const bytes = Buffer.concat([Buffer.from("nombre;notas\n", "latin1"), Buffer.from([0xe9, 0x3b, 0xf1, 0x80, 0x0a])]);
    const table = parseCsvTable(bytes);
    assert.equal(table.encoding, "windows-1252");
    assert.deepEqual(table.rows[0]!.cells, ["é", "ñ€"]);
    assert.ok(table.warnings.some((w) => w.includes("Windows-1252")));
    const replaced = parseCsvTable("a;b\n\uFFFD;2\n");
    assert.ok(replaced.warnings.some((w) => w.includes("Codificación no reconocida")));
  });

  it("líneas vacías intermedias no cuentan como fila pero sí como línea física", () => {
    const table = parseCsvTable(`${HEADER}\n\n${ROW_1}\n   \n;;;;\n${ROW_2}\n\n`);
    assert.deepEqual(table.rows.map((row) => [row.rowNumber, row.line]), [
      [1, 3],
      [2, 6]
    ]);
  });

  it("fila corta rellenada con «» (kind empty) y fila larga con aviso", () => {
    const table = parseCsvTable(`${HEADER}\n2026-10-12;2026-10-15;DBL\n${ROW_2};extra;más\n`);
    assert.deepEqual(table.rows[0]!.cells, ["2026-10-12", "2026-10-15", "DBL", "", ""]);
    assert.deepEqual(table.rows[0]!.kinds, ["string", "string", "string", "empty", "empty"]);
    assert.deepEqual(table.rows[1]!.cells, ROW_2.split(";"));
    assert.ok(table.warnings.some((w) => w.includes("Fila 2 (línea 3)") && w.includes("2 columnas más")), JSON.stringify(table.warnings));
  });

  it("cabecera vacía → columna_n; repetida → sufijo; columnas vacías al final se descartan; celdas recortadas", () => {
    const table = parseCsvTable("llegada;;Notas;Notas;;\n2026-10-12;x;a;b;;\n");
    assert.deepEqual(table.header, ["llegada", "columna_2", "Notas", "Notas (2)"]);
    assert.ok(table.warnings.some((w) => w.includes("repite la columna 4")));
    const withData = parseCsvTable("a;;\n1;2;3\n");
    assert.deepEqual(withData.header, ["a", "columna_2", "columna_3"], "columnas vacías con datos se conservan");
    const spaced = parseCsvTable("  a ; b \n 1 ; 2 \n");
    assert.deepEqual(spaced.header, ["a", "b"]);
    assert.deepEqual(spaced.rows[0]!.cells, ["1", "2"]);
  });

  it("celdas de más de 2.000 caracteres se recortan con aviso (límite configurable)", () => {
    const table = parseCsvTable(`a;b\n${"x".repeat(2100)};1\n`);
    assert.equal(table.rows[0]!.cells[0]!.length, 2000);
    assert.ok(table.warnings.some((w) => w.includes("columna «a»") && w.includes("2000")));
    const small = parseCsvTable("a;b\nabcdef;1\n", { maxCellChars: 3 });
    assert.equal(small.rows[0]!.cells[0], "abc");
  });

  it("201 columnas → RESERVATION_IMPORT_UNREADABLE; 200 → ok", () => {
    const header201 = Array.from({ length: 201 }, (_, i) => `c${i + 1}`).join(";");
    const row201 = Array.from({ length: 201 }, (_, i) => String(i)).join(";");
    const failure = errorCode(() => parseCsvTable(`${header201}\n${row201}\n`));
    assert.equal(failure.code, "RESERVATION_IMPORT_UNREADABLE");
    assert.equal(failure.details?.columns, 201);
    assert.equal(failure.details?.max, 200);
    const header200 = Array.from({ length: 200 }, (_, i) => `c${i + 1}`).join(";");
    assert.equal(parseCsvTable(`${header200}\n${row201}\n`).header.length, 200, "la celda 201 de la fila se ignora con aviso");
  });

  it("más de 5.000 filas → RESERVATION_IMPORT_TOO_MANY_ROWS (5.000 exactas pasan)", () => {
    const lines = [HEADER];
    for (let i = 0; i < 5001; i += 1) lines.push(ROW_1);
    const failure = errorCode(() => parseCsvTable(lines.join("\n")));
    assert.equal(failure.code, "RESERVATION_IMPORT_TOO_MANY_ROWS");
    assert.equal(failure.details?.rows, 5001);
    assert.equal(failure.details?.max, 5000);
    assert.equal(parseCsvTable(lines.slice(0, 5001).join("\n")).rows.length, 5000);
  });

  it("más de 5 MiB → RESERVATION_IMPORT_TOO_LARGE (texto y bytes)", () => {
    const big = `a;b\n${"x".repeat(5 * 1024 * 1024)};1\n`;
    const failure = errorCode(() => parseCsvTable(big));
    assert.equal(failure.code, "RESERVATION_IMPORT_TOO_LARGE");
    assert.equal(failure.details?.max, 5 * 1024 * 1024);
    assert.equal(errorCode(() => parseCsvTable(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))).code, "RESERVATION_IMPORT_TOO_LARGE");
  });

  it("sin filas de datos o vacío → RESERVATION_IMPORT_EMPTY", () => {
    assert.equal(errorCode(() => parseCsvTable(`${HEADER}\n`)).code, "RESERVATION_IMPORT_EMPTY");
    assert.equal(errorCode(() => parseCsvTable("")).code, "RESERVATION_IMPORT_EMPTY");
    assert.equal(errorCode(() => parseCsvTable("\n\n   \n")).code, "RESERVATION_IMPORT_EMPTY");
    assert.equal(errorCode(() => parseCsvTable(`${HEADER}\n;;;;\n`)).code, "RESERVATION_IMPORT_EMPTY");
  });
});

describe("parseXlsxTable · parseReservationImportFile", () => {
  const book = writeXlsx([
    {
      name: "Reservas",
      rows: [
        ["llegada", "salida", "tipo_habitacion", "nombre", "apellidos", "importe_total"],
        [],
        ["2026-10-12", "2026-10-15", "DBL", "Lucía", "Ferreiro Castro", { amount: "312.00" }],
        ["2026-10-13", "2026-10-14", "IND", "Marek", "Nowak", 296.5]
      ]
    }
  ]);

  it("parseXlsxTable: primera hoja, cabecera en la primera fila con datos, línea = fila de la hoja, kinds", () => {
    const table = parseXlsxTable(book);
    assert.equal(table.format, "xlsx");
    assert.equal(table.sheetName, "Reservas");
    assert.equal(table.bom, false);
    assert.deepEqual(table.header, ["llegada", "salida", "tipo_habitacion", "nombre", "apellidos", "importe_total"]);
    assert.deepEqual(table.rows.map((row) => [row.rowNumber, row.line]), [
      [1, 3],
      [2, 4]
    ]);
    assert.deepEqual(table.rows[1]!.cells, ["2026-10-13", "2026-10-14", "IND", "Marek", "Nowak", "296.5"]);
    assert.equal(table.rows[1]!.kinds[5], "number");
    assert.equal(errorCode(() => parseXlsxTable(book, { sheetName: "Nada" })).code, "RESERVATION_IMPORT_UNREADABLE");
    assert.equal(errorCode(() => parseXlsxTable(Buffer.from("no es zip"))).code, "RESERVATION_IMPORT_UNREADABLE");
    assert.equal(errorCode(() => parseXlsxTable(Buffer.from("no es zip"))).details?.reason, "XLSX_NOT_ZIP");
  });

  it("firma PK → xlsx: por bytes, por base64 «UEsDB» y por extensión; format explícito gana", () => {
    assert.equal(detectReservationImportFormat({ bytes: book }), "xlsx");
    assert.equal(detectReservationImportFormat({ contentBase64: book.toString("base64") }), "xlsx");
    assert.equal(detectReservationImportFormat({ fileName: "reservas.XLSX" }), "xlsx");
    assert.equal(detectReservationImportFormat({ fileName: "reservas.xlsm" }), "xlsx");
    assert.equal(detectReservationImportFormat({ fileName: "reservas.csv", bytes: book }), "csv", "la extensión gana a la firma");
    assert.equal(detectReservationImportFormat({ format: "csv", fileName: "reservas.xlsx" }), "csv");
    assert.equal(detectReservationImportFormat({ content: "a;b\n" }), "csv");
    assert.equal(detectReservationImportFormat({ fileName: "reservas.tsv" }), "csv");
    assert.equal(detectReservationImportFormat({}), "csv");
  });

  it("parseReservationImportFile: contentBase64 xlsx, contentBase64 csv latin1, content texto", () => {
    const fromXlsx = parseReservationImportFile({ contentBase64: book.toString("base64"), fileName: "reservas.xlsx" });
    assert.equal(fromXlsx.format, "xlsx");
    assert.equal(fromXlsx.rows.length, 2);
    const signature = parseReservationImportFile({ contentBase64: book.toString("base64") });
    assert.equal(signature.format, "xlsx");
    const latin = Buffer.concat([Buffer.from("nombre;apellidos\n", "latin1"), Buffer.from("Lucía;Ferreiro\n", "latin1")]);
    const fromCsv = parseReservationImportFile({ contentBase64: latin.toString("base64"), fileName: "reservas.csv" });
    assert.equal(fromCsv.format, "csv");
    assert.equal(fromCsv.encoding, "windows-1252");
    assert.deepEqual(fromCsv.rows[0]!.cells, ["Lucía", "Ferreiro"]);
    const fromText = parseReservationImportFile({ content: `${HEADER}\n${ROW_1}\n` });
    assert.equal(fromText.format, "csv");
    assert.equal(fromText.delimiter, ";");
    assert.equal(fromText.rows[0]!.cells[3], "Lucía");
  });

  it("parseReservationImportFile: límites y errores de entrada", () => {
    assert.equal(errorCode(() => parseReservationImportFile({})).code, "RESERVATION_IMPORT_EMPTY");
    assert.equal(errorCode(() => parseReservationImportFile({ content: "a;b\n", format: "xlsx" })).code, "RESERVATION_IMPORT_UNREADABLE");
    assert.equal(errorCode(() => parseReservationImportFile({ content: "a;b\n", format: "xlsx" })).details?.reason, "xlsx_as_text");
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61).toString("base64");
    const failure = errorCode(() => parseReservationImportFile({ contentBase64: tooBig, fileName: "x.csv" }));
    assert.equal(failure.code, "RESERVATION_IMPORT_TOO_LARGE");
    assert.equal(failure.details?.bytes, 5 * 1024 * 1024 + 1);
  });
});
