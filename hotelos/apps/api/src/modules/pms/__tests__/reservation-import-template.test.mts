// Unit tests · Tanda 7 · L2 — plantilla oficial: CSV con BOM, «;», CRLF y las 33
// cabeceras; XLSX legible por xlsx-lite (hoja «Reservas» con las mismas cabeceras
// y hoja «Instrucciones»); ambos formatos normalizan sin errores y con el MISMO
// hash de contenido. Huéspedes ficticios @example.com. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-template.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESERVATION_IMPORT_FIELDS, RESERVATION_IMPORT_HELP_ES, RESERVATION_IMPORT_TEMPLATE_FILE_NAMES } from "@hotelos/shared";
import { readXlsxTable } from "../../../lib/xlsx-lite.js";
import { type ReservationImportCatalogs, normalizeTable, reservationImportContentHash } from "../reservation-import.normalize.js";
import { parseCsvTable, parseReservationImportFile } from "../reservation-import.parser.js";
import {
  RESERVATION_IMPORT_TEMPLATE_HEADER,
  RESERVATION_IMPORT_TEMPLATE_HELP_SHEET,
  RESERVATION_IMPORT_TEMPLATE_SHEET,
  buildReservationImportHelpRows,
  buildReservationImportTemplate,
  buildReservationImportTemplateRows
} from "../reservation-import.template.js";

const NOW = new Date("2026-09-16T10:00:00Z");

const CATALOGS: ReservationImportCatalogs = {
  roomTypes: [{ id: "rt_dbl", code: "DBL", name: "Doble estándar", maxOccupancy: 3, active: true }],
  ratePlans: [{ id: "rp_bar", code: "BAR", name: "Best Available Rate", active: true }],
  rooms: [],
  defaultRatePlanId: "rp_bar",
  currency: "EUR",
  businessDate: "2026-09-16",
  today: "2026-09-16"
};

describe("cabecera y filas de ejemplo", () => {
  it("33 cabeceras en el orden canónico y 2 filas ficticias @example.com con 33 celdas", () => {
    assert.equal(RESERVATION_IMPORT_TEMPLATE_HEADER.length, 33);
    assert.deepEqual([...RESERVATION_IMPORT_TEMPLATE_HEADER], [...RESERVATION_IMPORT_FIELDS]);
    const rows = buildReservationImportTemplateRows(NOW);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.length, 33);
      assert.match(row[RESERVATION_IMPORT_FIELDS.indexOf("email")]!, /@example\.com$/);
    }
    assert.equal(rows[0]![RESERVATION_IMPORT_FIELDS.indexOf("llegada")], "2026-10-16", "hoy + 30 días en ISO");
    assert.equal(rows[0]![RESERVATION_IMPORT_FIELDS.indexOf("salida")], "2026-10-19");
    assert.equal(rows[1]![RESERVATION_IMPORT_FIELDS.indexOf("llegada")], "17/10/2026", "segunda fila en DD/MM/AAAA");
    assert.equal(rows[1]![RESERVATION_IMPORT_FIELDS.indexOf("noches")], "2");
    assert.equal(rows[0]![RESERVATION_IMPORT_FIELDS.indexOf("importe_total")], "250,00");
    assert.equal(rows[0]![RESERVATION_IMPORT_FIELDS.indexOf("moneda")], "EUR");
  });

  it("hoja «Instrucciones»: cabecera + 33 campos con su ayuda + notas", () => {
    const rows = buildReservationImportHelpRows();
    assert.deepEqual((rows[0] as Array<{ text: string }>).map((cell) => cell.text), ["Campo", "Etiqueta", "Obligatorio", "Formato y valores admitidos"]);
    for (const [index, field] of RESERVATION_IMPORT_FIELDS.entries()) {
      const row = rows[index + 1]!;
      assert.equal(row[0], field);
      assert.equal(row[3], RESERVATION_IMPORT_HELP_ES[field]);
    }
    assert.equal(rows[1 + RESERVATION_IMPORT_FIELDS.indexOf("llegada")]![2], "Sí");
    assert.equal(rows[1 + RESERVATION_IMPORT_FIELDS.indexOf("salida")]![2], "Sí, si no hay «noches»");
    assert.equal(rows[1 + RESERVATION_IMPORT_FIELDS.indexOf("apellidos")]![2], "Sí (salvo columna de nombre completo)");
    assert.equal(rows[1 + RESERVATION_IMPORT_FIELDS.indexOf("vip")]![2], "No");
    assert.ok(rows.length > 34, "notas generales tras los campos");
  });
});

describe("buildReservationImportTemplate · csv", () => {
  const file = buildReservationImportTemplate("csv", NOW);

  it("BOM UTF-8, separador «;», CRLF, 33 cabeceras y 2 filas de datos", () => {
    assert.equal(file.fileName, RESERVATION_IMPORT_TEMPLATE_FILE_NAMES.csv);
    assert.equal(file.contentType, "text/csv; charset=utf-8");
    assert.deepEqual([...file.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = file.buffer.toString("utf8");
    assert.ok(text.includes("\r\n"));
    assert.equal(text.slice(1).split("\r\n")[0], RESERVATION_IMPORT_FIELDS.join(";"));
    const table = parseCsvTable(file.buffer);
    assert.equal(table.delimiter, ";");
    assert.equal(table.bom, true);
    assert.equal(table.encoding, "utf-8");
    assert.deepEqual(table.header, [...RESERVATION_IMPORT_FIELDS]);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]!.cells.length, 33);
  });

  it("las dos filas de ejemplo normalizan sin errores contra un catálogo DBL/BAR", () => {
    const table = parseReservationImportFile({ contentBase64: file.buffer.toString("base64"), fileName: file.fileName });
    const result = normalizeTable(table, null, CATALOGS, { historico: false });
    assert.deepEqual(result.rows.map((row) => row.status), ["valid", "valid"]);
    assert.equal(result.rows[0]!.normalized?.guest.email, "lucia.ferreiro@example.com");
    assert.equal(result.rows[0]!.normalized?.nights, 3);
    assert.equal(result.rows[1]!.normalized?.nights, 2);
    assert.equal(result.rows[1]!.normalized?.boardType, "BB");
    assert.equal(result.rows[1]!.normalized?.channel, "booking_com");
    assert.equal(result.rows[1]!.normalized?.guest.documentType, "PASSPORT");
    assert.equal(result.rows[1]!.normalized?.guest.nationality, "POL");
    assert.equal(result.rows[0]!.normalized?.totalAmount, "250.00");
  });
});

describe("buildReservationImportTemplate · xlsx", () => {
  const file = buildReservationImportTemplate("xlsx", NOW);

  it("libro legible por xlsx-lite: hoja «Reservas» con las 33 cabeceras y 2 filas; hoja «Instrucciones» presente", () => {
    assert.equal(file.fileName, RESERVATION_IMPORT_TEMPLATE_FILE_NAMES.xlsx);
    assert.equal(file.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(file.buffer.subarray(0, 4).toString("latin1"), "PK");
    const data = readXlsxTable(file.buffer);
    assert.equal(data.sheetName, RESERVATION_IMPORT_TEMPLATE_SHEET);
    assert.equal(data.rows.length, 3);
    assert.deepEqual(
      data.rows[0]!.cells.map((cell) => cell.raw),
      [...RESERVATION_IMPORT_FIELDS]
    );
    assert.equal(data.rows[1]!.cells[RESERVATION_IMPORT_FIELDS.indexOf("llegada")]!.raw, "2026-10-16");
    assert.equal(data.rows[1]!.cells[RESERVATION_IMPORT_FIELDS.indexOf("llegada")]!.kind, "string", "las fechas van como texto");
    const help = readXlsxTable(file.buffer, { sheetName: RESERVATION_IMPORT_TEMPLATE_HELP_SHEET });
    assert.equal(help.sheetName, RESERVATION_IMPORT_TEMPLATE_HELP_SHEET);
    assert.equal(help.rows[0]!.cells[0]!.raw, "Campo");
    assert.ok(help.rows.length >= 34);
  });

  it("CSV y XLSX de la plantilla producen el MISMO hash de contenido", () => {
    const csv = buildReservationImportTemplate("csv", NOW);
    const fromCsv = normalizeTable(parseReservationImportFile({ contentBase64: csv.buffer.toString("base64"), fileName: csv.fileName }), null, CATALOGS, { historico: false });
    const fromXlsx = normalizeTable(parseReservationImportFile({ contentBase64: file.buffer.toString("base64"), fileName: file.fileName }), null, CATALOGS, { historico: false });
    assert.deepEqual(fromXlsx.rows.map((row) => row.status), ["valid", "valid"]);
    assert.equal(reservationImportContentHash(fromXlsx.rows), reservationImportContentHash(fromCsv.rows));
  });
});
