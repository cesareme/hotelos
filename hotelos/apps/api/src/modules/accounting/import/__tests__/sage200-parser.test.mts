// Unit tests · Tanda 7c · L1 — lectores por cabecera de Sage 200: detección de formato,
// Excel del Diario con sinónimos (Debe/Haber frente a Cargo/Abono + Importe), CSV IME de
// 60 columnas, libro AEAT con cabecera en la fila 8 localizada por contenido, periodos,
// errores de fila y los lectores de saldos / plan / terceros. Puros, sin base de datos.
// Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/sage200-parser.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { readXlsxTable } from "../../../../lib/xlsx-lite.js";
import { writeXlsx } from "../../../financial-statements/xlsx-writer.js";
import { LedgerImportParseError, contentHashOf, normalizeRows, parseCanonicalCsv } from "../ledger-import.canonical.js";
import {
  SAGE_HEADER_SYNONYMS,
  SAGE_IME_COLUMNS,
  SAGE_IME_SIGNATURE_HEADERS,
  detectLedgerImportFormat,
  locateHeaderRow,
  parseLedgerImportFile,
  parseSageBalances,
  parseSageJournal,
  parseSagePlan,
  parseSageThirdParties,
  parseSageVatBook,
  readSageTable
} from "../sage200.parser.js";
import {
  BALANCES_2025,
  JOURNAL_2026_09,
  JOURNAL_OPENING_AND_JANUARY,
  JOURNAL_YEAR_END,
  NIF_LAVANDERIA,
  NIF_SUMINISTROS,
  NIF_VIAJES,
  aeatVatBookXlsx,
  balancesXlsx,
  journalCanonicalCsv,
  journalImeCsv,
  journalXlsxCargoAbono,
  journalXlsxDebeHaber,
  planXlsx,
  sageXmlZip,
  thirdPartiesXlsx
} from "./fixtures/sage200-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function errorOf(fn: () => unknown): LedgerImportParseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerImportParseError) return error;
    throw error;
  }
  throw new Error("no lanzó");
}

/** Filas normalizadas sin posición (line / orden) ni etiquetas informativas de Sage (diario / contrapartida), para comparar variantes del mismo diario. */
function comparable(rows: ReturnType<typeof parseSageJournal>["rows"]): unknown[] {
  return normalizeRows("journal", rows).map(({ line: _line, orden: _orden, diario: _diario, contrapartida: _contrapartida, ...rest }) => rest);
}

describe("detectLedgerImportFormat", () => {
  it("sage_ime_csv cuando la cabecera contiene las 7 columnas firma; el fixture guardado tiene las 60 columnas del §2.1 D", () => {
    const text = readFileSync(join(HERE, "fixtures", "diario-ime-2026-09.csv"), "utf8");
    assert.equal(text.split(/\r?\n/)[0], SAGE_IME_COLUMNS.join(";"));
    assert.equal(SAGE_IME_COLUMNS.length, 60);
    assert.ok(SAGE_IME_SIGNATURE_HEADERS.every((header) => SAGE_IME_COLUMNS.includes(header)));
    assert.equal(detectLedgerImportFormat({ content: text, kind: "journal" }), "sage_ime_csv");
    assert.equal(detectLedgerImportFormat({ bytes: Buffer.from(text, "utf8"), fileName: "diario.csv" }), "sage_ime_csv");
  });

  it("canonical_csv con la cabecera canónica, canonical_json con { rows }, sage_excel con sinónimos, sage_xml por extensión o firma", () => {
    assert.equal(detectLedgerImportFormat({ content: journalCanonicalCsv(), kind: "journal" }), "canonical_csv");
    assert.equal(detectLedgerImportFormat({ content: journalCanonicalCsv() }), "canonical_csv", "sin tipo: prueba todos");
    assert.equal(detectLedgerImportFormat({ content: JSON.stringify({ system: "sage200", company: "1", kind: "journal", rows: [] }) }), "canonical_json");
    assert.equal(detectLedgerImportFormat({ bytes: journalXlsxDebeHaber(), fileName: "diario.xlsx", kind: "journal" }), "sage_excel");
    assert.equal(detectLedgerImportFormat({ bytes: journalXlsxDebeHaber(JOURNAL_2026_09, { titleRows: 3 }), fileName: "diario.xlsx", kind: "journal" }), "sage_excel", "con filas de título");
    assert.equal(detectLedgerImportFormat({ bytes: aeatVatBookXlsx(), fileName: "libro-iva.xlsx", kind: "vat_books" }), "sage_excel");
    assert.equal(detectLedgerImportFormat({ fileName: "DatosContables.xml" }), "sage_xml");
    assert.equal(detectLedgerImportFormat({ bytes: sageXmlZip(), fileName: "Temporal.zip" }), "sage_xml");
    assert.equal(detectLedgerImportFormat({ bytes: journalXlsxDebeHaber(), fileName: "diario.zip" }), "sage_excel", "un ZIP con xl/ es un libro");
    assert.equal(detectLedgerImportFormat({ bytes: Buffer.from("<?xml version=\"1.0\"?><Datos/>", "utf8") }), "sage_xml");
  });

  it("desconocido → LEDGER_IMPORT_FORMAT_UNKNOWN con la cabecera leída", () => {
    const error = errorOf(() => detectLedgerImportFormat({ content: "col_a;col_b\n1;2\n", kind: "journal" }));
    assert.equal(error.code, "LEDGER_IMPORT_FORMAT_UNKNOWN");
    assert.deepEqual(error.details?.header, ["col_a", "col_b"]);
  });
});

describe("parseSageJournal · Excel con sinónimos", () => {
  it("Debe/Haber y Cargo/Abono + Importe dan las mismas filas canónicas y el mismo hash que el CSV IME y el canónico", () => {
    const debeHaber = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxDebeHaber(), fileName: "diario.xlsx" });
    const cargoAbono = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(), fileName: "diario.xlsx" });
    const ime = parseLedgerImportFile({ kind: "journal", content: journalImeCsv(), fileName: "diario.csv" });
    const canonical = parseCanonicalCsv("journal", journalCanonicalCsv());
    assert.equal(debeHaber.format, "sage_excel");
    assert.equal(cargoAbono.format, "sage_excel");
    assert.equal(ime.format, "sage_ime_csv");
    assert.equal(debeHaber.rows.length, JOURNAL_2026_09.length);
    assert.deepEqual(comparable(cargoAbono.rows), comparable(debeHaber.rows));
    assert.deepEqual(comparable(ime.rows), comparable(debeHaber.rows));
    assert.deepEqual(comparable(canonical.rows), comparable(debeHaber.rows));
    const hashes = new Set([debeHaber, cargoAbono, ime, canonical].map((result) => contentHashOf("journal", normalizeRows("journal", result.rows))));
    assert.equal(hashes.size, 1, "mismo hash para las cuatro variantes");
    assert.deepEqual(debeHaber.unknownHeaders, []);
    assert.deepEqual(ime.unknownHeaders, [], "las 60 columnas IME se conocen (usadas o ignoradas a sabiendas)");
    assert.deepEqual(debeHaber.warnings, []);
  });

  it("valores canónicos: fechas ISO, importes a 2 decimales, NIF en mayúsculas, tipo de IVA como entero, analítica", () => {
    const rows = normalizeRows("journal", parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(), fileName: "diario.xlsx" }).rows);
    const vat = rows.find((row) => row.cuenta === "4720021" && row.asiento === "1501");
    assert.ok(vat);
    assert.deepEqual([vat.fecha, vat.debe, vat.haber, vat.base_iva, vat.tipo_iva, vat.cuota_iva, vat.tipo_factura, vat.delegacion, vat.periodo, vat.ejercicio, vat.empresa], ["2026-09-03", "52.50", "0.00", "250.00", "21", "52.50", "R", "RA", "9", "2026", "1"]);
    const supplier = rows.find((row) => row.cuenta === "4000000042");
    assert.ok(supplier);
    assert.deepEqual([supplier.haber, supplier.nif, supplier.serie, supplier.factura, supplier.fecha_factura, supplier.documento], ["302.50", NIF_SUMINISTROS, "F", "778", "2026-09-03", "F-778"]);
    const expense = rows.find((row) => row.cuenta === "6280001");
    assert.deepEqual([expense?.departamento, expense?.diario, expense?.canal], ["MANT", "0", null]);
  });

  it("Cargo/Abono admite D/H, d/h, Cargo/Abono y Debe/Haber; el importe negativo cambia de lado", () => {
    const book = writeXlsx([
      {
        name: "Diario",
        rows: [
          ["Asiento", "FechaAsiento", "CodigoCuenta", "Comentario", "CargoAbono", "ImporteAsiento", "Ejercicio", "NumeroPeriodo"],
          ["7", "2026-09-01", "6280001", "a", "d", 10, "2026", "9"],
          ["7", "2026-09-01", "5720000", "a", "Abono", 10, "2026", "9"],
          ["8", "2026-09-02", "6280001", "b", "Cargo", -20, "2026", "9"],
          ["8", "2026-09-02", "5720000", "b", "Haber", -20, "2026", "9"]
        ]
      }
    ]);
    const result = parseLedgerImportFile({ kind: "journal", bytes: book, fileName: "d.xlsx" });
    assert.deepEqual(result.rows.map((row) => [row.asiento, row.cuenta, row.debe, row.haber]), [["7", "6280001", "10.00", "0.00"], ["7", "5720000", "0.00", "10.00"], ["8", "6280001", "0.00", "20.00"], ["8", "5720000", "20.00", "0.00"]]);
    assert.ok(result.warnings.some((warning) => /2 apuntes con importe negativo/.test(warning)));
    assert.ok(result.warnings.some((warning) => /no trae columna de empresa/.test(warning)));
  });

  it("decimales con coma o punto y separador de miles en CSV; fechas dd/mm/yyyy, yyyy-mm-dd y serial de Excel", () => {
    const csv = "Asiento;Fecha asiento;Cuenta;Concepto;Debe;Haber;Ejercicio;Periodo\n1;03/09/2026;6280001;a;1.250,50;;2026;9\n1;2026-09-03;5720000;a;;1.250,50;2026;9\n2;46273;6280001;b;3,25;;2026;9\n2;03/09/2026;5720000;b;;3,25;2026;9\n";
    const result = parseLedgerImportFile({ kind: "journal", content: csv, fileName: "d.csv" });
    assert.deepEqual(result.rows.map((row) => [row.fecha, row.debe, row.haber]), [["2026-09-03", "1250.50", "0.00"], ["2026-09-03", "0.00", "1250.50"], ["2026-09-08", "3.25", "0.00"], ["2026-09-03", "0.00", "3.25"]]);
    const english = parseLedgerImportFile({ kind: "journal", content: "Asiento;Fecha asiento;Cuenta;Debe;Haber;Ejercicio\n1;2026-09-03;6280001;1,250.50;;2026\n1;2026-09-03;5720000;;1,250.50;2026\n", fileName: "d.csv" });
    assert.deepEqual(english.rows.map((row) => row.debe), ["1250.50", "0.00"]);
  });

  it("NumeroPeriodo: 0..12, «Apertura», «Regul. y Ajustes», «Cierre ejercicio», «Cierre Contabilidad» y 13/14/15 se normalizan a un código", () => {
    const opening = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(JOURNAL_OPENING_AND_JANUARY), fileName: "d.xlsx" });
    assert.deepEqual(opening.rows.map((row) => `${row.asiento}/${row.periodo}`), ["1/0", "1/0", "1/1", "1/1"]);
    const yearEnd = parseLedgerImportFile({ kind: "journal", bytes: journalXlsxDebeHaber(JOURNAL_YEAR_END), fileName: "d.xlsx" });
    assert.deepEqual([...new Set(yearEnd.rows.map((row) => row.periodo))], ["regularizacion", "cierre"]);
    const numeric = parseLedgerImportFile({ kind: "journal", content: journalImeCsv([...JOURNAL_OPENING_AND_JANUARY, ...JOURNAL_YEAR_END]), fileName: "d.csv" });
    assert.deepEqual([...new Set(numeric.rows.map((row) => row.periodo))], ["0", "1", "regularizacion", "cierre"]);
    const adjustments = parseLedgerImportFile({ kind: "journal", content: "Asiento;Fecha;Cuenta;Debe;Haber;Ejercicio;Periodo\n5;31/12/2026;6280001;1;;2026;Regul. y Ajustes\n5;31/12/2026;5720000;;1;2026;Regul. y Ajustes\n", fileName: "d.csv" });
    assert.equal(adjustments.rows[0]!.periodo, "ajustes");
  });

  it("sin columna de periodo: mes de la fecha y 0 para la apertura (solo grupos 1-5 el primer día del ejercicio)", () => {
    const csv = "Asiento;Fecha;Cuenta;Concepto;Debe;Haber;Ejercicio\n1;01/01/2026;5720000;Apertura;15000;;2026\n1;01/01/2026;1000000;Apertura;;15000;2026\n2;15/03/2026;6280001;Luz;10;;2026\n2;15/03/2026;5720000;Luz;;10;2026\n3;01/01/2026;6280001;Gasto de año nuevo;5;;2026\n3;01/01/2026;5720000;Gasto de año nuevo;;5;2026\n";
    const result = parseLedgerImportFile({ kind: "journal", content: csv, fileName: "d.csv" });
    assert.deepEqual(result.rows.map((row) => `${row.asiento}/${row.periodo}`), ["1/0", "1/0", "2/3", "2/3", "3/1", "3/1"]);
    assert.ok(result.warnings.some((warning) => /no trae columna de periodo/.test(warning)));
  });

  it("fecha fuera del ejercicio declarado → error de fila con su línea; cabecera obligatoria ausente → LEDGER_IMPORT_INVALID en la línea 1", () => {
    const csv = "Asiento;Fecha;Cuenta;Debe;Haber;Ejercicio;Periodo\n1;03/09/2026;6280001;10;;2026;9\n1;03/09/2025;5720000;;10;2026;9\n";
    const error = errorOf(() => parseLedgerImportFile({ kind: "journal", content: csv, fileName: "d.csv" }));
    assert.equal(error.code, "LEDGER_IMPORT_INVALID");
    assert.deepEqual(error.details?.errors, [{ line: 3, message: "la fecha 2025-09-03 no pertenece al ejercicio 2026" }]);
    const missing = errorOf(() => parseLedgerImportFile({ kind: "journal", content: "Asiento;Fecha;Concepto;Debe;Haber\n1;03/09/2026;a;1;\n", fileName: "d.csv" }));
    assert.equal(missing.code, "LEDGER_IMPORT_INVALID");
    assert.deepEqual(missing.details?.errors, [{ line: 1, message: "faltan columnas obligatorias: cuenta" }]);
    const noAmounts = errorOf(() => parseLedgerImportFile({ kind: "journal", content: "Asiento;Fecha;Cuenta;Concepto\n1;03/09/2026;6280001;a\n", fileName: "d.csv" }));
    assert.match((noAmounts.details?.errors as Array<{ message: string }>)[0]!.message, /debe\/haber \(o cargo_abono \+ importe\)/);
  });

  it("cabecera desconocida → aviso (nunca error) y la columna aparece en unknownHeaders", () => {
    const csv = "Asiento;Fecha;Cuenta;Debe;Haber;Ejercicio;Periodo;ColumnaRara\n1;03/09/2026;6280001;10;;2026;9;x\n1;03/09/2026;5720000;;10;2026;9;y\n";
    const result = parseLedgerImportFile({ kind: "journal", content: csv, fileName: "d.csv" });
    assert.deepEqual(result.unknownHeaders, ["ColumnaRara"]);
    assert.ok(result.warnings.some((warning) => warning.includes("«ColumnaRara»")));
  });

  it("apunte con importe en Debe y Haber a la vez, importe no numérico y ejercicio no numérico → errores de fila", () => {
    const csv = "Asiento;Fecha;Cuenta;Debe;Haber;Ejercicio;Periodo\n1;03/09/2026;6280001;10;5;2026;9\n1;03/09/2026;5720000;;abc;2026;9\n2;03/09/2026;5720000;1;;26;9\n";
    const error = errorOf(() => parseLedgerImportFile({ kind: "journal", content: csv, fileName: "d.csv" }));
    assert.deepEqual((error.details?.errors as Array<{ line: number }>).map((item) => item.line), [2, 3, 4]);
    assert.equal(error.details?.errorCount, 3);
  });

  it("readSageTable localiza la cabecera por contenido cuando el listado lleva título encima", () => {
    const book = journalXlsxDebeHaber(JOURNAL_YEAR_END, { titleRows: 3 });
    const table = readSageTable({ bytes: book, fileName: "cierre.xlsx" }, "journal");
    assert.equal(table.header[0], "Empresa");
    assert.equal(table.rows.length, JOURNAL_YEAR_END.length);
    assert.equal(table.rows[0]!.line, 5, "línea = fila de la hoja");
    assert.ok(table.warnings.some((warning) => /cabecera de la hoja «Diario» está en la fila 4/.test(warning)));
    const parsed = parseLedgerImportFile({ kind: "journal", bytes: book, fileName: "cierre.xlsx" });
    assert.equal(parsed.rows.length, JOURNAL_YEAR_END.length);
  });

  it("SAGE_HEADER_SYNONYMS cubre los campos del diseño §4.3 en cada tipo", () => {
    for (const field of ["asiento", "fecha", "cuenta", "contrapartida", "concepto", "debe", "haber", "cargo_abono", "importe", "documento", "canal", "delegacion", "departamento", "seccion", "proyecto", "periodo", "ejercicio", "empresa", "diario", "serie", "factura", "su_factura_no", "fecha_factura", "nif", "nombre", "base_iva", "codigo_iva", "tipo_iva", "cuota_iva", "tipo_factura"]) {
      assert.ok(field in SAGE_HEADER_SYNONYMS.journal, `journal.${field}`);
    }
    for (const field of ["cuenta", "titulo", "saldo_apertura", "apertura_debe", "apertura_haber", "debe", "haber", "saldo", "saldo_deudor", "saldo_acreedor", "delegacion", "periodo"]) assert.ok(field in SAGE_HEADER_SYNONYMS.balances, `balances.${field}`);
    for (const field of ["cuenta", "titulo", "nif", "pais", "longitud"]) assert.ok(field in SAGE_HEADER_SYNONYMS.plan, `plan.${field}`);
    for (const field of ["codigo", "cuenta", "nif", "pais", "nombre", "rol"]) assert.ok(field in SAGE_HEADER_SYNONYMS.third_parties, `third_parties.${field}`);
    assert.ok(SAGE_HEADER_SYNONYMS.journal.cuenta.includes("codigo_cuenta") && SAGE_HEADER_SYNONYMS.journal.concepto.includes("comentario"));
    assert.ok(SAGE_HEADER_SYNONYMS.third_parties.codigo.includes("codigo_cliente") && SAGE_HEADER_SYNONYMS.third_parties.codigo.includes("codigo_proveedor"));
    assert.ok(SAGE_HEADER_SYNONYMS.plan.pais.includes("sigla_nacion"));
  });
});

describe("parseSageVatBook · libro AEAT (hojas EXPEDIDAS_INGRESOS / RECIBIDAS_GASTOS)", () => {
  it("localiza la cabecera de la fila 8 por contenido, prefija los campos genéricos con el grupo de la fila 7 y lee los dos libros", () => {
    const result = parseSageVatBook(aeatVatBookXlsx());
    assert.equal(result.rows.length, 5);
    assert.deepEqual(result.rows.map((row) => row.libro), ["emitidas", "emitidas", "emitidas", "recibidas", "recibidas"]);
    assert.ok(result.warnings.some((warning) => /EXPEDIDAS_INGRESOS».*fila 8/.test(warning)));
    assert.ok(result.warnings.some((warning) => /RECIBIDAS_GASTOS».*fila 8/.test(warning)));
    assert.deepEqual(result.unknownHeaders, [], "las columnas AEAT que no se usan se conocen");
    const first = result.rows[0]!;
    assert.deepEqual([first.fecha, first.serie, first.numero, first.nif, first.nombre, first.pais, first.base, first.tipo_iva, first.cuota, first.total, first.tipo_factura, first.rectificativa, first.ejercicio, first.line], ["2026-07-03", "FAC-2026", "000010", NIF_VIAJES, "VIAJES CANTABRICO SL", "ES", "1000.00", "10", "100.00", "1100.00", "F1", false, "2026", 9]);
    const rectification = result.rows[2]!;
    assert.deepEqual([rectification.serie, rectification.numero, rectification.base, rectification.rectificativa, rectification.tipo_factura], ["REC-2026", "000003", "-100.00", true, "R1"]);
    const received = result.rows[3]!;
    assert.deepEqual([received.serie, received.numero, received.nif, received.cuota, received.cuota_deducible, received.tipo_iva], ["F", "778", NIF_SUMINISTROS, "52.50", "52.50", "21"]);
    assert.equal(result.rows[4]!.nif, NIF_LAVANDERIA);
  });

  it("una sola hoja pedida; hoja inexistente; libro sin hojas AEAT → KIND_MISMATCH; CSV → INVALID", () => {
    const only = parseSageVatBook(aeatVatBookXlsx(), { sheetName: "RECIBIDAS_GASTOS" });
    assert.equal(only.rows.length, 2);
    assert.ok(only.rows.every((row) => row.libro === "recibidas"));
    assert.equal(errorOf(() => parseSageVatBook(aeatVatBookXlsx(), { sheetName: "OTRA" })).code, "LEDGER_IMPORT_INVALID");
    assert.equal(errorOf(() => parseSageVatBook(journalXlsxDebeHaber())).code, "LEDGER_IMPORT_KIND_MISMATCH");
    assert.equal(errorOf(() => parseSageVatBook(Buffer.from("libro;fecha\n", "utf8"))).code, "LEDGER_IMPORT_INVALID");
    const viaFile = parseLedgerImportFile({ kind: "vat_books", bytes: aeatVatBookXlsx(), fileName: "libro-iva-2026-3T.xlsx" });
    assert.equal(viaFile.rows.length, 5);
    assert.equal(viaFile.format, "sage_excel");
  });

  it("locateHeaderRow no depende del índice: con más filas de título sigue encontrando la cabecera", () => {
    const book = aeatVatBookXlsx();
    const raw = readXlsxTable(book, { sheetName: "EXPEDIDAS_INGRESOS" });
    const index = locateHeaderRow(raw.rows, SAGE_HEADER_SYNONYMS.vat_books, { minMatches: 3, anchors: ["fecha", "base"] });
    assert.equal(raw.rows[index]!.row, 8);
  });
});

describe("parseSageBalances · parseSagePlan · parseSageThirdParties", () => {
  it("sumas y saldos con «Sumas anteriores» / Deudor / Acreedor, filas de totales ignoradas, periodo y ejercicio del lote", () => {
    const result = parseLedgerImportFile({ kind: "balances", bytes: balancesXlsx(), fileName: "sumas-y-saldos-2025.xlsx", periodCode: "2025", fiscalYearCode: "2025" });
    assert.equal(result.rows.length, BALANCES_2025.length, "la fila TOTALES no cuenta");
    const bank = result.rows.find((row) => row.cuenta === "5720000")!;
    assert.deepEqual([bank.apertura_debe, bank.apertura_haber, bank.debe, bank.haber, bank.saldo_deudor, bank.saldo_acreedor, bank.periodo, bank.ejercicio, bank.delegacion], ["10000.00", "0.00", "8000.00", "3000.00", "15000.00", "0.00", "2025", "2025", null]);
    const revenue = result.rows.find((row) => row.cuenta === "7050001")!;
    assert.deepEqual([revenue.delegacion, revenue.saldo_acreedor, revenue.titulo], ["RA", "9000.00", "Alojamiento"]);
    assert.ok(result.warnings.some((warning) => /sin saldo informado/.test(warning)), "1290000 sin saldo: calculado");
    // Columna de periodo en el fichero: «9» + ejercicio → 2025-09; «3T» → 2025-Q3.
    const monthly = parseSageBalances(readSageTable({ bytes: balancesXlsx(BALANCES_2025, { periodo: "9", ejercicio: "2025" }), fileName: "s.xlsx" }, "balances"));
    assert.ok(monthly.rows.every((row) => row.periodo === "2025-09"));
    const quarterly = parseSageBalances(readSageTable({ bytes: balancesXlsx(BALANCES_2025, { periodo: "3T", ejercicio: "2025" }), fileName: "s.xlsx" }, "balances"));
    assert.ok(quarterly.rows.every((row) => row.periodo === "2025-Q3"));
    const noPeriod = errorOf(() => parseLedgerImportFile({ kind: "balances", bytes: balancesXlsx(), fileName: "s.xlsx" }));
    assert.equal(noPeriod.code, "LEDGER_IMPORT_INVALID");
  });

  it("saldo con signo (una sola columna «Saldo») → deudor / acreedor", () => {
    const csv = "Cuenta;Título;Debe;Haber;Saldo;Periodo;Ejercicio\n5720000;Bancos;100;40;60;2025-09;2025\n4000000;Proveedores;10;50;-40;2025-09;2025\n";
    const result = parseLedgerImportFile({ kind: "balances", content: csv, fileName: "s.csv" });
    assert.deepEqual(result.rows.map((row) => [row.saldo_deudor, row.saldo_acreedor]), [["60.00", "0.00"], ["0.00", "40.00"]]);
  });

  it("plan de cuentas: código, título, NIF, país y longitud; cuenta repetida → error", () => {
    const result = parseLedgerImportFile({ kind: "plan", bytes: planXlsx(), fileName: "plan-cuentas.xlsx" });
    assert.equal(result.rows.length, 7);
    const supplier = result.rows.find((row) => row.cuenta === "4000000042")!;
    assert.deepEqual([supplier.titulo, supplier.nif, supplier.pais, supplier.longitud], ["Suministros Eléctricos del Noroeste SL", NIF_SUMINISTROS, "ES", 10]);
    assert.deepEqual(result.rows.find((row) => row.cuenta === "1000000")?.nif, null);
    const duplicated = errorOf(() => parseSagePlan(readSageTable({ content: "Cuenta;Descripción\n1000000;Capital\n1000000;Capital bis\n", fileName: "p.csv" }, "plan")));
    assert.equal(duplicated.code, "LEDGER_IMPORT_INVALID");
    assert.match((duplicated.details?.errors as Array<{ message: string }>)[0]!.message, /repetida/);
  });

  it("terceros: hoja de proveedores y de clientes con cabeceras CodigoProveedor / CodigoCliente; rol por cabecera o por cuenta", () => {
    const suppliers = parseLedgerImportFile({ kind: "third_parties", bytes: thirdPartiesXlsx(), fileName: "terceros.xlsx", sheetName: "Proveedores" });
    assert.deepEqual(suppliers.rows.map((row) => [row.codigo, row.rol, row.cuenta, row.nif, row.pais]), [["42", "supplier", "4000000042", NIF_SUMINISTROS, "ES"], ["7", "supplier", "4100000007", NIF_LAVANDERIA, "ES"]]);
    const customers = parseLedgerImportFile({ kind: "third_parties", bytes: thirdPartiesXlsx(), fileName: "terceros.xlsx", sheetName: "Clientes" });
    assert.deepEqual(customers.rows.map((row) => [row.codigo, row.rol, row.nombre]), [["123", "customer", "Viajes Cantábrico SL"]]);
    const byAccount = parseSageThirdParties(readSageTable({ content: `Codigo;Cuenta;NIF;Nombre\n1;4300000001;${NIF_VIAJES};Cliente uno\n2;4000000002;${NIF_SUMINISTROS};Proveedor dos\n`, fileName: "t.csv" }, "third_parties"));
    assert.deepEqual(byAccount.rows.map((row) => row.rol), ["customer", "supplier"]);
    const undecidable = errorOf(() => parseSageThirdParties(readSageTable({ content: "Codigo;Nombre\n1;Alguien\n", fileName: "t.csv" }, "third_parties")));
    assert.equal(undecidable.code, "LEDGER_IMPORT_INVALID");
    const defaulted = parseSageThirdParties(readSageTable({ content: "Codigo;Nombre\n1;Alguien\n", fileName: "t.csv" }, "third_parties"), { defaultRole: "supplier" });
    assert.equal(defaulted.rows[0]!.rol, "supplier");
  });

  it("parseLedgerImportFile: vacío → LEDGER_IMPORT_EMPTY; JSON canónico de otro tipo → KIND_MISMATCH", () => {
    assert.equal(errorOf(() => parseLedgerImportFile({ kind: "journal", content: "" })).code, "LEDGER_IMPORT_EMPTY");
    assert.equal(errorOf(() => parseLedgerImportFile({ kind: "journal", content: "Asiento;Fecha;Cuenta;Debe;Haber\n", fileName: "d.csv" })).code, "LEDGER_IMPORT_EMPTY");
    const mismatch = errorOf(() => parseLedgerImportFile({ kind: "balances", content: JSON.stringify({ system: "sage200", company: "1", kind: "journal", rows: [{ asiento: "1" }] }), fileName: "d.json" }));
    assert.equal(mismatch.code, "LEDGER_IMPORT_KIND_MISMATCH");
  });
});
