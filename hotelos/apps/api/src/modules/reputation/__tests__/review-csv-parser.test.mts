// Unit tests · Tanda T8 · lote T8-B — parser de CSV de reseñas
// (review-csv.parser.ts): válido, inválido y duplicado. Sin base de datos,
// sin red. Datos FICTICIOS.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-csv-parser.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CSV_MAX_ROWS, ReviewCsvParseError, detectSeparator, parseCsvDate, parseReviewCsv, readCsvRecords, countryCodeFor } from "../review-csv.parser.js";

const HEADER = "external_id,date,rating,scale_max,title,body,language,author,country,url";

describe("parseReviewCsv · fichero válido", () => {
  const csv = [
    HEADER,
    'r-001,2026-09-01T10:00:00Z,4,5,"Muy bien","Habitación limpia, personal amable. Dijo ""genial"".",es,Ana García,es,https://ejemplo.test/r/1',
    "r-002,15/08/2026,9,10,,Todo correcto.,en-US,Huésped Ficticio,PT,",
    ",2026-07-20,3,5,Regular,Ruido por la noche.,,,,"
  ].join("\n");

  it("devuelve 3 filas normalizadas sin inválidas", () => {
    const out = parseReviewCsv(csv, { source: "csv" });
    assert.equal(out.total, 3);
    assert.deepEqual(out.invalid, []);
    assert.deepEqual(out.duplicates, []);
    assert.equal(out.rows.length, 3);
    assert.equal(out.separator, ",");
    assert.deepEqual(out.headers, ["external_id", "date", "rating", "scale_max", "title", "body", "language", "author", "country", "url"]);
  });
  it("comillas, comas y comillas dobles escapadas dentro del cuerpo; autor minimizado; país en mayúsculas; idioma normalizado", () => {
    const [first, second, third] = parseReviewCsv(csv, { source: "csv" }).rows;
    assert.ok(first && second && third);
    assert.equal(first.externalId, "r-001");
    assert.equal(first.body, 'Habitación limpia, personal amable. Dijo "genial".');
    assert.equal(first.title, "Muy bien");
    assert.equal(first.ratingRaw, 4);
    assert.equal(first.ratingScaleMax, 5);
    assert.equal(first.language, "es");
    assert.equal(first.authorDisplayName, "Ana G.");
    assert.equal(first.authorCountry, "ES");
    assert.equal(first.portalUrl, "https://ejemplo.test/r/1");
    assert.equal(first.bodyComplete, true);
    assert.equal(first.replyCapability, false);
    assert.equal(second.receivedAt, "2026-08-15T00:00:00.000Z");
    assert.equal(second.language, "en");
    assert.equal(second.authorCountry, "PT");
    assert.equal(second.title, undefined);
    assert.equal(third.externalId, undefined);
    assert.equal(third.receivedAt, "2026-07-20T00:00:00.000Z");
  });
  it("BD-06: la columna country acepta ISO-2 o nombres de país (Booking «Reviewer country») y descarta el resto sin recortarlo", () => {
    const text = `date,rating,scale_max,body,country\n2026-09-01,4,5,Bien,Germany\n2026-09-02,4,5,Bien,Portugal\n2026-09-03,4,5,Bien,Spain\n2026-09-04,4,5,Bien,United Kingdom\n2026-09-05,4,5,Bien,Reino Unido\n2026-09-06,4,5,Bien,Atlántida\n2026-09-07,4,5,Bien,pt\n`;
    const out = parseReviewCsv(text, { source: "csv" });
    assert.deepEqual(out.rows.map((row) => row.authorCountry), ["DE", "PT", "ES", "GB", "GB", undefined, "PT"]);
    assert.equal(countryCodeFor("Alemania"), "DE");
    assert.equal(countryCodeFor("  Países Bajos "), "NL");
    assert.equal(countryCodeFor("Georgia del Sur"), undefined);
    assert.equal(countryCodeFor("GE"), "GE");
  });
  it("separador «;», BOM y CRLF; alias de cabeceras del diseño", () => {
    const semi = "﻿external_reference;received_at;rating;rating_scale_max;title;body;author_display_name;portal_url\r\nx-1;2026-09-02;8;10;Bien;Todo bien;Huésped A.;\r\n";
    const out = parseReviewCsv(semi, { source: "csv" });
    assert.equal(out.separator, ";");
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.externalId, "x-1");
    assert.equal(out.rows[0]?.ratingScaleMax, 10);
  });
  it("la escala la fija el proveedor cuando falta la columna", () => {
    const out = parseReviewCsv("date,rating,body\n2026-09-02,4,Bien", { source: "google" });
    assert.equal(out.rows[0]?.ratingScaleMax, 5);
    const withOption = parseReviewCsv("date,rating,body\n2026-09-02,8,Bien", { source: "csv", scaleMax: 10 });
    assert.equal(withOption.rows[0]?.ratingScaleMax, 10);
  });
  it("fila sin nota pero con texto → ratingRaw null", () => {
    const out = parseReviewCsv("date,rating,body\n2026-09-02,,Solo texto", { source: "csv" });
    assert.equal(out.rows[0]?.ratingRaw, null);
    assert.equal(out.rows[0]?.ratingScaleMax, null);
  });
});

describe("parseReviewCsv · filas inválidas (con motivo en español)", () => {
  it("fecha mala, nota fuera de rango, nota no numérica, sin escala, URL mala, fila vacía", () => {
    const csv = [
      "external_id,date,rating,scale_max,body,url",
      "a,31/02/2026,4,5,Fecha imposible,",
      "b,2026-09-01,6,5,Fuera de rango,",
      "c,2026-09-01,cuatro,5,No numérica,",
      "d,2026-09-01,4,,Sin escala,",
      "e,2026-09-01,4,5,URL mala,ftp://x",
      "f,2026-09-01,,,,",
      "g,2026-09-01,4,5,Correcta,"
    ].join("\n");
    const out = parseReviewCsv(csv, { source: "csv" });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.externalId, "g");
    assert.deepEqual(
      out.invalid.map((row) => row.row),
      [2, 3, 4, 5, 6, 7]
    );
    assert.match(out.invalid[0]!.reason, /Fecha no válida/);
    assert.match(out.invalid[1]!.reason, /fuera del rango 0-5/);
    assert.match(out.invalid[2]!.reason, /Nota no numérica/);
    assert.match(out.invalid[3]!.reason, /Sin escala/);
    assert.match(out.invalid[4]!.reason, /URL no válida/);
    assert.match(out.invalid[5]!.reason, /sin nota ni texto/i);
  });
});

describe("parseReviewCsv · duplicados dentro del fichero", () => {
  it("mismo external_id → duplicada de la primera", () => {
    const csv = ["external_id,date,rating,scale_max,body", "r-1,2026-09-01,4,5,Uno", "r-1,2026-09-02,5,5,Otro texto", "r-2,2026-09-03,3,5,Tres"].join("\n");
    const out = parseReviewCsv(csv, { source: "csv" });
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.duplicates, [{ row: 3, of: 2, reason: "external_id «r-1» repetido (fila 2)." }]);
  });
  it("mismo contenido sin id → duplicada por hash", () => {
    const csv = ["date,rating,scale_max,author,body", "2026-09-01,4,5,Huésped A.,Bien", "2026-09-01,4,5,Huésped A.,Bien", "2026-09-01,4,5,Huésped B.,Bien"].join("\n");
    const out = parseReviewCsv(csv, { source: "csv" });
    assert.equal(out.rows.length, 2);
    assert.equal(out.duplicates.length, 1);
    assert.equal(out.duplicates[0]?.of, 2);
    assert.match(out.duplicates[0]!.reason, /Contenido idéntico/);
  });
});

describe("parseReviewCsv · errores de fichero tipados", () => {
  const code = (fn: () => unknown, expected: string) => {
    assert.throws(fn, (error: unknown) => error instanceof ReviewCsvParseError && error.code === expected, expected);
  };
  it("vacío → EMPTY_FILE", () => code(() => parseReviewCsv("   \n", { source: "csv" }), "EMPTY_FILE"));
  it("sin date/rating → MISSING_HEADER", () => code(() => parseReviewCsv("nombre,valor\na,b", { source: "csv" }), "MISSING_HEADER"));
  it("comillas sin cerrar → UNTERMINATED_QUOTE", () => code(() => parseReviewCsv('date,rating,body\n2026-09-01,4,"abierta', { source: "csv" }), "UNTERMINATED_QUOTE"));
  it(`más de ${CSV_MAX_ROWS} filas → TOO_MANY_ROWS`, () => {
    const lines = ["date,rating,scale_max,body"];
    for (let index = 0; index <= CSV_MAX_ROWS; index += 1) lines.push(`2026-09-01,4,5,fila ${index}`);
    code(() => parseReviewCsv(lines.join("\n"), { source: "csv" }), "TOO_MANY_ROWS");
  });
  it(`exactamente ${CSV_MAX_ROWS} filas se aceptan`, () => {
    const lines = ["date,rating,scale_max,body"];
    for (let index = 0; index < CSV_MAX_ROWS; index += 1) lines.push(`2026-09-01,4,5,fila ${index}`);
    assert.equal(parseReviewCsv(lines.join("\n"), { source: "csv" }).rows.length, CSV_MAX_ROWS);
  });
});

describe("helpers", () => {
  it("detectSeparator", () => {
    assert.equal(detectSeparator("a,b,c"), ",");
    assert.equal(detectSeparator("a;b;c"), ";");
    assert.equal(detectSeparator("a"), ",");
  });
  it("readCsvRecords respeta saltos de línea dentro de comillas", () => {
    assert.deepEqual(readCsvRecords('a,"línea 1\nlínea 2",c\n', ","), [["a", "línea 1\nlínea 2", "c"]]);
  });
  it("parseCsvDate: ISO, dd/mm/aaaa, dd.mm.aaaa HH:MM, inválidas", () => {
    assert.equal(parseCsvDate("2026-09-01"), "2026-09-01T00:00:00.000Z");
    assert.equal(parseCsvDate("2026-09-01T10:30:00+02:00"), "2026-09-01T08:30:00.000Z");
    assert.equal(parseCsvDate("01/09/2026"), "2026-09-01T00:00:00.000Z");
    assert.equal(parseCsvDate("01.09.2026 18:45"), "2026-09-01T18:45:00.000Z");
    assert.equal(parseCsvDate("31/02/2026"), null);
    assert.equal(parseCsvDate("ayer"), null);
  });
});
