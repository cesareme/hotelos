// Unit tests · Tanda 7c · L1 — formato canónico: CSV / JSON, normalización, hash estable
// (Excel ↔ CSV, independiente del orden y del mapa de cuentas), plantillas por tipo,
// agrupación en asientos Sage (clave con periodo) y normalizadores de celda. Puros, sin
// base de datos. Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/ledger-import-canonical.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEDGER_IMPORT_KINDS } from "@hotelos/shared";
import {
  CANONICAL_COLUMNS,
  LedgerImportParseError,
  balancePeriodEndDate,
  buildCanonicalTemplate,
  canonicalTemplateFileName,
  compactHeader,
  contentHashOf,
  detectNumberStyle,
  groupJournalRows,
  matchColumns,
  normalizeBalancePeriod,
  normalizeRows,
  normalizeSagePeriod,
  parseCanonicalCsv,
  parseCanonicalJson,
  parseRateCode,
  parseSignedAmount,
  readLedgerTable,
  sageEntryKeyString,
  type CanonicalJournalRow
} from "../ledger-import.canonical.js";
import { parseLedgerImportFile } from "../sage200.parser.js";
import { JOURNAL_2026_09, JOURNAL_OPENING_AND_JANUARY, journalCanonicalCsv, journalXlsxCargoAbono, journalXlsxDebeHaber } from "./fixtures/sage200-fixtures.mjs";

function errorOf(fn: () => unknown): LedgerImportParseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerImportParseError) return error;
    throw error;
  }
  throw new Error("no lanzó");
}

describe("parseCanonicalCsv · parseCanonicalJson", () => {
  it("CSV canónico de diario con BOM, «;» y coma decimal → filas canónicas", () => {
    const result = parseCanonicalCsv("journal", journalCanonicalCsv());
    assert.equal(result.format, "canonical_csv");
    assert.equal(result.rows.length, JOURNAL_2026_09.length);
    assert.deepEqual(result.unknownHeaders, []);
    const line = result.rows[0]!;
    assert.deepEqual([line.empresa, line.ejercicio, line.asiento, line.fecha, line.periodo, line.cuenta, line.debe, line.haber, line.delegacion, line.departamento], ["1", "2026", "1501", "2026-09-03", "9", "6280001", "250.00", "0.00", "RA", "MANT"]);
    const bytes = Buffer.from(journalCanonicalCsv(), "utf8");
    assert.equal(parseCanonicalCsv("journal", bytes).rows.length, JOURNAL_2026_09.length);
  });

  it("JSON canónico { system, company, kind, rows } → mismas filas; kind distinto → KIND_MISMATCH; JSON roto → INVALID", () => {
    const fromCsv = normalizeRows("journal", parseCanonicalCsv("journal", journalCanonicalCsv()).rows);
    const document = { system: "sage200", company: "1", kind: "journal", rows: fromCsv.map(({ line: _line, orden: _orden, ...rest }) => rest) };
    const fromJson = parseCanonicalJson("journal", JSON.stringify(document));
    assert.equal(fromJson.format, "canonical_json");
    assert.equal(fromJson.company, "1");
    assert.equal(contentHashOf("journal", normalizeRows("journal", fromJson.rows)), contentHashOf("journal", fromCsv));
    assert.equal(errorOf(() => parseCanonicalJson("balances", JSON.stringify(document))).code, "LEDGER_IMPORT_KIND_MISMATCH");
    assert.equal(errorOf(() => parseCanonicalJson("journal", "{no es json")).code, "LEDGER_IMPORT_INVALID");
    assert.equal(errorOf(() => parseCanonicalJson("journal", JSON.stringify({ rows: [] }))).code, "LEDGER_IMPORT_EMPTY");
    // Números JSON se leen como celdas numéricas (punto decimal) y booleanos como si / no.
    const numeric = parseCanonicalJson("journal", JSON.stringify({ kind: "journal", rows: [{ empresa: 1, ejercicio: 2026, asiento: 3, fecha: "2026-02-01", cuenta: 6280001, debe: 1.5, haber: 0 }, { empresa: 1, ejercicio: 2026, asiento: 3, fecha: "2026-02-01", cuenta: 5720000, debe: 0, haber: 1.5 }] }));
    assert.deepEqual(numeric.rows.map((row) => [row.cuenta, row.debe, row.haber, row.periodo]), [["6280001", "1.50", "0.00", "2"], ["5720000", "0.00", "1.50", "2"]]);
  });

  it("readLedgerTable: texto vacío → EMPTY; XLSX enviado como texto → INVALID; ZIP corrupto → INVALID", () => {
    assert.equal(errorOf(() => readLedgerTable({ content: "   " })).code, "LEDGER_IMPORT_EMPTY");
    assert.equal(errorOf(() => readLedgerTable({ content: "x", fileName: "libro.xlsx" })).code, "LEDGER_IMPORT_INVALID");
    const corrupt = errorOf(() => readLedgerTable({ bytes: Buffer.from("PK\u0003\u0004basura", "latin1"), fileName: "libro.xlsx" }));
    assert.equal(corrupt.code, "LEDGER_IMPORT_INVALID");
    assert.equal(corrupt.details?.reason, "XLSX_NOT_ZIP");
  });
});

describe("normalizeRows · contentHashOf", () => {
  const base = parseCanonicalCsv("journal", journalCanonicalCsv()).rows;

  it("ordena por (ejercicio, asiento, orden), redondea importes y recorta textos sin mutar la entrada", () => {
    const shuffled = [...base].reverse();
    const normalized = normalizeRows("journal", shuffled);
    assert.deepEqual(normalized.map((row) => row.asiento).slice(0, 4), ["1501", "1501", "1501", "1502"]);
    assert.equal(shuffled[0]!.asiento, "1506", "la entrada no se muta");
    const dirty: CanonicalJournalRow = { ...base[0]!, concepto: "  Luz  ", debe: "250.5", nif: "a-12 345674", asiento: "01501", ejercicio: "2026" };
    const clean = normalizeRows("journal", [dirty])[0]!;
    assert.deepEqual([clean.concepto, clean.debe, clean.nif, clean.asiento], ["Luz", "250.50", "A12345674", "1501"]);
  });

  it("hash estable: mismo Excel y CSV, independiente del orden de las filas y de line / orden / diario; cambia con el contenido", () => {
    const hashCsv = contentHashOf("journal", normalizeRows("journal", base));
    const hashReversed = contentHashOf("journal", normalizeRows("journal", [...base].reverse()));
    assert.equal(hashReversed, hashCsv);
    const excel = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxDebeHaber(), fileName: "d.xlsx" }).rows;
    assert.equal(contentHashOf("journal", normalizeRows("journal", excel)), hashCsv);
    const excel2 = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(), fileName: "d.xlsx" }).rows;
    assert.equal(contentHashOf("journal", normalizeRows("journal", excel2)), hashCsv);
    const relined = normalizeRows("journal", base.map((row, index) => ({ ...row, line: 1000 + index, orden: 500 + index })));
    assert.equal(contentHashOf("journal", relined), hashCsv, "line y orden no entran en el hash");
    const changed = normalizeRows("journal", base.map((row, index) => (index === 0 ? { ...row, debe: "250.01" } : row)));
    assert.notEqual(contentHashOf("journal", changed), hashCsv);
    assert.equal(contentHashOf("fiscal_years", normalizeRows("fiscal_years", base)), hashCsv, "fiscal_years comparte el canónico de diario");
    assert.match(hashCsv, /^[0-9a-f]{64}$/);
  });

  it("el hash se calcula ANTES del mapa de cuentas: las filas no cambian al mapear (la cuenta Sage literal es la que entra)", () => {
    // Un mapa distinto no toca las filas canónicas: el hash es una función solo de ellas.
    const rows = normalizeRows("journal", base);
    const mappedA = rows.map((row) => ({ row, mapping: { action: "map", accountCode: "628.1" } }));
    const mappedB = rows.map((row) => ({ row, mapping: { action: "create", accountCode: "628.9" } }));
    assert.equal(contentHashOf("journal", mappedA.map((item) => item.row)), contentHashOf("journal", mappedB.map((item) => item.row)));
  });
});

describe("buildCanonicalTemplate", () => {
  it("cada tipo: BOM, separador «;», cabecera = CANONICAL_COLUMNS y una fila de ejemplo que se vuelve a leer", () => {
    for (const kind of LEDGER_IMPORT_KINDS) {
      const template = buildCanonicalTemplate(kind);
      assert.ok(template.startsWith("\uFEFF"), `${kind}: BOM`);
      const [header, ...rows] = template.slice(1).split("\r\n").filter((line) => line !== "");
      assert.equal(header, CANONICAL_COLUMNS[kind].join(";"), `${kind}: cabecera`);
      assert.ok(rows.length >= 1, `${kind}: fila de ejemplo`);
      const parsed = parseCanonicalCsv(kind, template);
      assert.equal(parsed.rows.length, rows.length, `${kind}: la plantilla se lee con su propio tipo`);
      assert.match(canonicalTemplateFileName(kind), /^plantilla-sage200-[a-z-]+\.csv$/);
    }
    assert.equal(errorOf(() => buildCanonicalTemplate("otro" as never)).code, "VALIDATION_ERROR");
  });

  it("la plantilla de diario reproduce el ejemplo del diseño §4.3 (250,00 / 52,50 / 302,50) con NIF sintético", () => {
    const parsed = parseCanonicalCsv("journal", buildCanonicalTemplate("journal"));
    assert.deepEqual(parsed.rows.map((row) => [row.cuenta, row.debe, row.haber]), [["6280001", "250.00", "0.00"], ["4720021", "52.50", "0.00"], ["4000000042", "0.00", "302.50"]]);
    assert.equal(parsed.rows[2]!.nif, "A12345674");
  });
});

describe("groupJournalRows", () => {
  it("dos asientos nº 1 en los periodos 0 y 1 → claves distintas; las líneas conservan el orden", () => {
    const rows = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(JOURNAL_OPENING_AND_JANUARY), fileName: "d.xlsx" }).rows;
    const entries = groupJournalRows(rows);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => sageEntryKeyString(entry.key)), ["1:2026:0:1", "1:2026:1:1"]);
    assert.deepEqual(entries[0]!.lines.map((line) => line.cuenta), ["5720000", "1000000"]);
    assert.equal(entries[0]!.entryDate, "2026-01-01");
    assert.equal(entries[1]!.entryDate, "2026-01-02");
  });

  it("numeración por canal / delegación: la dimensión entra en la clave; fechas distintas dentro del asiento → aviso", () => {
    const rows = parseLedgerImportFile({ kind: "journal", content: journalCanonicalCsv(), fileName: "d.csv" }).rows;
    const byDelegacion = groupJournalRows(rows, { numberingDimension: "delegacion" });
    assert.ok(byDelegacion.some((entry) => sageEntryKeyString(entry.key) === "1:2026:9:1503:RA"));
    assert.ok(byDelegacion.some((entry) => sageEntryKeyString(entry.key) === "1:2026:9:1503:LT"));
    const mixed = groupJournalRows([{ ...rows[0]!, fecha: "2026-09-03" }, { ...rows[1]!, fecha: "2026-09-04" }]);
    assert.equal(mixed.length, 1);
    assert.match(mixed[0]!.warnings[0]!, /fechas distintas/);
  });
});

describe("normalizadores de celda", () => {
  it("matchColumns casa por forma compacta: «Fecha asiento» ≡ «FechaAsiento» ≡ «fecha_asiento»; repetida → aviso; desconocida → unknownHeaders", () => {
    const synonyms = { fecha: ["fecha_asiento"], cuenta: ["codigo_cuenta"] };
    for (const header of ["Fecha asiento", "FechaAsiento", "fecha_asiento", "FECHA DE ASIENTO"]) assert.equal(matchColumns([header], synonyms).index.get("fecha"), 0, header);
    assert.equal(compactHeader("Código de cuenta"), "codigocuenta");
    const match = matchColumns(["Fecha asiento", "FechaAsiento", "Rara"], synonyms);
    assert.equal(match.index.size, 1);
    assert.equal(match.warnings.length, 1);
    assert.deepEqual(match.unknownHeaders, ["Rara"]);
  });

  it("parseSignedAmount con estilos es / en / auto, paréntesis y signo final; detectNumberStyle", () => {
    assert.equal(parseSignedAmount("1.234,56", "es")?.toFixed(2), "1234.56");
    assert.equal(parseSignedAmount("1,234.56", "en")?.toFixed(2), "1234.56");
    assert.equal(parseSignedAmount("1.234", "es")?.toFixed(2), "1234.00");
    assert.equal(parseSignedAmount("1.234", "auto")?.toFixed(2), "1.23");
    assert.equal(parseSignedAmount("(12,50)")?.toFixed(2), "-12.50");
    assert.equal(parseSignedAmount("12,50-")?.toFixed(2), "-12.50");
    assert.equal(parseSignedAmount("-0,005")?.toFixed(2), "-0.01");
    assert.equal(parseSignedAmount("abc"), null);
    assert.equal(parseSignedAmount(""), null);
    assert.equal(detectNumberStyle(["1.234,56", "12,50"]), "es");
    assert.equal(detectNumberStyle(["1,234.56", "12.50"]), "en");
    assert.equal(detectNumberStyle(["12", "1234"]), "auto");
    assert.equal(parseRateCode("21"), "21");
    assert.equal(parseRateCode("21,00 %"), "21");
    assert.equal(parseRateCode("0.21"), "21");
    assert.equal(parseRateCode(""), null);
  });

  it("normalizeSagePeriod, normalizeBalancePeriod y balancePeriodEndDate", () => {
    // 98 / 99 = «Número periodo» real del Diario General de Sage 200 (regularización «Cierre Ejer.» / cierre «Cierre Conta»); 16-97 siguen sin reconocerse.
    assert.deepEqual(["0", "12", "Apertura", "Regul. y Ajustes", "Cierre ejercicio", "Cierre Contabilidad", "13", "14", "15", "Septiembre", "98", "99", "Cierre Ejer.", "Cierre Conta", "16", "97", "otra cosa"].map(normalizeSagePeriod), ["0", "12", "0", "ajustes", "regularizacion", "cierre", "ajustes", "regularizacion", "cierre", "9", "regularizacion", "cierre", "regularizacion", "cierre", null, null, null]);
    assert.equal(normalizeBalancePeriod("9", "2025"), "2025-09");
    assert.equal(normalizeBalancePeriod("09/2025", null), "2025-09");
    assert.equal(normalizeBalancePeriod("2025-03", null), "2025-03");
    assert.equal(normalizeBalancePeriod("3T", "2025"), "2025-Q3");
    assert.equal(normalizeBalancePeriod("2025-Q4", null), "2025-Q4");
    assert.equal(normalizeBalancePeriod("2025", null), "2025");
    assert.equal(normalizeBalancePeriod("anual", "2025"), "2025");
    assert.equal(normalizeBalancePeriod("Apertura", "2025"), "apertura");
    assert.equal(normalizeBalancePeriod("13", "2025"), null);
    assert.equal(balancePeriodEndDate("2025-02"), "2025-02-28");
    assert.equal(balancePeriodEndDate("2028-02"), "2028-02-29");
    assert.equal(balancePeriodEndDate("2025-Q3"), "2025-09-30");
    assert.equal(balancePeriodEndDate("2025"), "2025-12-31");
    assert.equal(balancePeriodEndDate("apertura"), null);
  });
});
