// Unit tests · Tanda 7 · L3 — esquemas zod de las rutas de importación masiva de
// reservas (schemas/reservation-import.schemas.ts). Sin base de datos; huéspedes
// ficticios @example.com. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESERVATION_IMPORT_FIELDS,
  RESERVATION_IMPORT_LIST_DEFAULT_LIMIT,
  RESERVATION_IMPORT_LIST_MAX_LIMIT,
  RESERVATION_IMPORT_MAX_BASE64_CHARS,
  RESERVATION_IMPORT_MAX_FILE_NAME,
  RESERVATION_IMPORT_MAX_MAPPING_KEYS,
  RESERVATION_IMPORT_MAX_SAMPLE_SIZE,
  RESERVATION_IMPORT_MAX_SHEET_NAME,
  RESERVATION_IMPORT_MAX_UNDO_REASON,
  RESERVATION_IMPORT_STATUSES
} from "@hotelos/shared";
import {
  BASE64_PATTERN,
  CONTENT_XOR_MESSAGE,
  CreateReservationImportSchema,
  ListReservationImportsQuerySchema,
  PreviewReservationImportSchema,
  ReservationImportMappingSchema,
  ReservationImportTemplateQuerySchema,
  UndoReservationImportSchema
} from "../../../schemas/reservation-import.schemas.js";

type Issue = { path: PropertyKey[]; message: string; code?: string; keys?: string[] };
type ParseResult = { success: boolean; error?: { issues: Issue[] } };

/**
 * "ruta: mensaje"; una clave desconocida (`unrecognized_keys`) lleva la clave en
 * `issue.keys` con ruta vacía, así que se presenta como "clave: mensaje" (en HTTP,
 * parseOr400 la reescribe con zodErrorMapEs: «clave no admitida: 'x'»).
 */
function messagesOf(result: ParseResult): string[] {
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => `${issue.code === "unrecognized_keys" ? (issue.keys ?? []).join(",") : issue.path.join(".")}: ${issue.message}`);
}

const CSV = [
  "referencia_externa;llegada;salida;tipo_habitacion;nombre;apellidos;email",
  "IMP-T7-001;2026-11-10;2026-11-12;DBL;Lucía;Ferreiro Castro;lucia.ferreiro@example.com"
].join("\r\n") + "\r\n";
const BASE64 = Buffer.from(CSV, "utf8").toString("base64");
const PREVIEW = { fileName: "reservas.csv", content: CSV };

/** Todo mensaje de validación va en español: sin «Required», «Invalid», «Expected», «Unrecognized». */
function assertSpanish(messages: string[]): void {
  for (const message of messages) {
    assert.doesNotMatch(message, /Required|Invalid|Expected|Unrecognized|must be|should be/, `mensaje no traducido: ${message}`);
  }
}

describe("PreviewReservationImportSchema", () => {
  it("acepta content (texto) con los flags por defecto a false y sampleSize ausente", () => {
    const parsed = PreviewReservationImportSchema.parse(PREVIEW);
    assert.equal(parsed.fileName, "reservas.csv");
    assert.equal(parsed.content, CSV);
    assert.equal(parsed.contentBase64, undefined);
    assert.equal(parsed.omitirInvalidas, false);
    assert.equal(parsed.permitirOverbooking, false);
    assert.equal(parsed.historico, false);
    assert.equal(parsed.force, false);
    assert.equal(parsed.sampleSize, undefined);
    assert.equal(parsed.mapping, undefined);
  });

  it("acepta contentBase64 (fichero) con format, sheetName, mapping, flags y sampleSize (coerción de texto a entero)", () => {
    const parsed = PreviewReservationImportSchema.parse({
      fileName: "  reservas.xlsx ",
      format: "xlsx",
      contentBase64: BASE64,
      sheetName: " Reservas ",
      mapping: { "Check-in": "llegada", "Booking ID": "referencia_externa", Comentario: null },
      omitirInvalidas: true,
      permitirOverbooking: true,
      historico: true,
      force: true,
      sampleSize: "50"
    });
    assert.equal(parsed.fileName, "reservas.xlsx", "fileName se recorta");
    assert.equal(parsed.sheetName, "Reservas", "sheetName se recorta");
    assert.equal(parsed.format, "xlsx");
    assert.equal(parsed.sampleSize, 50);
    assert.deepEqual(parsed.mapping, { "Check-in": "llegada", "Booking ID": "referencia_externa", Comentario: null });
    assert.equal(parsed.omitirInvalidas, true);
    assert.equal(parsed.force, true);
  });

  it("strict: una clave desconocida → issue que nombra la clave con mensaje en español", () => {
    const result = PreviewReservationImportSchema.safeParse({ ...PREVIEW, fichero: "x" });
    assert.equal(result.success, false);
    const issue = result.success ? undefined : result.error.issues.find((i) => i.code === "unrecognized_keys");
    assert.ok(issue, "issue unrecognized_keys");
    assert.deepEqual((issue as { keys?: string[] }).keys, ["fichero"]);
    assert.equal(issue.message, "Campo no admitido en el cuerpo de la petición.");
    assert.ok(messagesOf(result).some((m) => m === "fichero: Campo no admitido en el cuerpo de la petición."), messagesOf(result).join(" | "));
    // Tampoco se cuela `commit` en la preview ni `propertyId` en el cuerpo.
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, commit: true })).join(), /^commit: Campo no admitido/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, propertyId: "prop_x" })).join(), /^propertyId: Campo no admitido/);
  });

  it("XOR content / contentBase64: ninguno → 400; los dos → 400; el mensaje va en `content`", () => {
    const none = PreviewReservationImportSchema.safeParse({ fileName: "reservas.csv" });
    assert.equal(none.success, false);
    assert.deepEqual(messagesOf(none), [`content: ${CONTENT_XOR_MESSAGE}`]);
    const both = PreviewReservationImportSchema.safeParse({ content: CSV, contentBase64: BASE64 });
    assert.equal(both.success, false);
    assert.deepEqual(messagesOf(both), [`content: ${CONTENT_XOR_MESSAGE}`]);
    assert.equal(PreviewReservationImportSchema.safeParse({}).success, false, "cuerpo vacío → falta el contenido");
    assert.equal(PreviewReservationImportSchema.safeParse({ contentBase64: BASE64 }).success, true);
  });

  it("mapping: campo inválido, clave vacía, valor no admitido, más de 200 claves y tipo incorrecto → mensajes en español", () => {
    const badField = PreviewReservationImportSchema.safeParse({ ...PREVIEW, mapping: { "Check-in": "fecha_llegada" } });
    assert.equal(badField.success, false);
    assert.match(messagesOf(badField).join(), /^mapping\.Check-in: mapping: cada valor debe ser un campo de la plantilla \(referencia_externa, llegada, .*\) o null para ignorar la columna\./);
    assert.match(messagesOf(ReservationImportMappingSchema.safeParse({ "": "llegada" })).join(), /mapping: la columna no puede estar vacía/);
    assert.match(messagesOf(ReservationImportMappingSchema.safeParse({ Col: 3 })).join(), /mapping: cada valor debe ser un campo de la plantilla/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, mapping: "llegada" })).join(), /mapping debe ser un objeto columna del fichero → campo de la plantilla/);
    const tooMany = Object.fromEntries(Array.from({ length: RESERVATION_IMPORT_MAX_MAPPING_KEYS + 1 }, (_, i) => [`col_${i}`, null]));
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, mapping: tooMany })).join(), new RegExp(`mapping no puede tener más de ${RESERVATION_IMPORT_MAX_MAPPING_KEYS} columnas`));
    const exact = Object.fromEntries(Array.from({ length: RESERVATION_IMPORT_MAX_MAPPING_KEYS }, (_, i) => [`col_${i}`, null]));
    assert.equal(PreviewReservationImportSchema.safeParse({ ...PREVIEW, mapping: exact }).success, true, "200 claves justas se admiten");
    for (const field of RESERVATION_IMPORT_FIELDS) assert.equal(ReservationImportMappingSchema.safeParse({ [`col ${field}`]: field }).success, true, field);
  });

  it("límites: fileName ≤ 200, sheetName ≤ 64, content no vacío, contentBase64 con alfabeto base64 y ≤ 7·1024·1024, sampleSize 1..1000 entero, format csv|xlsx, flags booleanos", () => {
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, fileName: "f".repeat(RESERVATION_IMPORT_MAX_FILE_NAME + 1) })).join(), /fileName no puede superar 200 caracteres/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, fileName: "   " })).join(), /fileName no puede estar vacío/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, sheetName: "h".repeat(RESERVATION_IMPORT_MAX_SHEET_NAME + 1) })).join(), /sheetName no puede superar 64 caracteres/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ content: "" })).join(), /content no puede estar vacío/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ contentBase64: "" })).join(), /contentBase64 no puede estar vacío/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ contentBase64: "no es base64 ñ" })).join(), /contentBase64 debe ser base64/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ contentBase64: "A".repeat(RESERVATION_IMPORT_MAX_BASE64_CHARS + 1) })).join(), /contentBase64 no puede superar 7\.340\.032 caracteres/);
    assert.equal(PreviewReservationImportSchema.safeParse({ contentBase64: "QUJD\r\nREVG==" }).success, true, "saltos de línea y relleno admitidos");
    assert.ok(BASE64_PATTERN.test(BASE64));
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, sampleSize: 0 })).join(), /sampleSize debe ser un entero entre 1 y 1\.000/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, sampleSize: RESERVATION_IMPORT_MAX_SAMPLE_SIZE + 1 })).join(), /sampleSize debe ser un entero entre 1 y 1\.000/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, sampleSize: 2.5 })).join(), /sampleSize debe ser un entero entre 1 y 1\.000/);
    assert.equal(PreviewReservationImportSchema.parse({ ...PREVIEW, sampleSize: RESERVATION_IMPORT_MAX_SAMPLE_SIZE }).sampleSize, 1000);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, format: "pdf" })).join(), /format debe ser uno de: csv, xlsx\./);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, omitirInvalidas: "sí" })).join(), /omitirInvalidas debe ser true o false/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, permitirOverbooking: 1 })).join(), /permitirOverbooking debe ser true o false/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, historico: "true" })).join(), /historico debe ser true o false/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, force: null })).join(), /force debe ser true o false/);
    assert.match(messagesOf(PreviewReservationImportSchema.safeParse({ ...PREVIEW, content: 7 })).join(), /content debe ser el texto del fichero/);
  });

  it("todos los mensajes de rechazo van en español", () => {
    const samples = [
      PreviewReservationImportSchema.safeParse({}),
      PreviewReservationImportSchema.safeParse({ ...PREVIEW, extra: 1, format: "pdf", sampleSize: "x", mapping: { a: "b" }, force: "no" }),
      PreviewReservationImportSchema.safeParse({ content: 1, contentBase64: 2, fileName: 3, sheetName: 4 })
    ];
    for (const sample of samples) {
      assert.equal(sample.success, false);
      assertSpanish(messagesOf(sample));
    }
  });
});

describe("CreateReservationImportSchema", () => {
  it("hereda la previsualización y exige commit: true literal", () => {
    const parsed = CreateReservationImportSchema.parse({ ...PREVIEW, commit: true, omitirInvalidas: true });
    assert.equal(parsed.commit, true);
    assert.equal(parsed.omitirInvalidas, true);
    assert.equal(parsed.content, CSV);
    const missing = CreateReservationImportSchema.safeParse(PREVIEW);
    assert.equal(missing.success, false);
    assert.match(messagesOf(missing).join(), /^commit: commit debe ser true: confirma que quieres crear las reservas/);
    for (const wrong of [false, "true", 1, null]) {
      const result = CreateReservationImportSchema.safeParse({ ...PREVIEW, commit: wrong });
      assert.equal(result.success, false, `commit ${String(wrong)}`);
      assert.match(messagesOf(result).join(), /^commit: commit debe ser true/);
    }
  });

  it("strict y XOR también en el commit: clave extra y content + contentBase64 → 400", () => {
    assert.match(messagesOf(CreateReservationImportSchema.safeParse({ ...PREVIEW, commit: true, dryRun: true })).join(), /^dryRun: Campo no admitido/);
    const both = CreateReservationImportSchema.safeParse({ commit: true, content: CSV, contentBase64: BASE64 });
    assert.equal(both.success, false);
    assert.deepEqual(messagesOf(both), [`content: ${CONTENT_XOR_MESSAGE}`]);
    const none = CreateReservationImportSchema.safeParse({ commit: true });
    assert.equal(none.success, false);
    assert.deepEqual(messagesOf(none), [`content: ${CONTENT_XOR_MESSAGE}`]);
    assertSpanish(messagesOf(CreateReservationImportSchema.safeParse({ commit: "yes", fichero: 1 })));
  });
});

describe("ListReservationImportsQuerySchema", () => {
  it("consulta vacía → limit 50 por defecto; status opcional del enum; limit 1..200 con coerción", () => {
    assert.deepEqual(ListReservationImportsQuerySchema.parse({}), { limit: RESERVATION_IMPORT_LIST_DEFAULT_LIMIT });
    assert.equal(ListReservationImportsQuerySchema.parse({ limit: "25" }).limit, 25);
    assert.equal(ListReservationImportsQuerySchema.parse({ limit: String(RESERVATION_IMPORT_LIST_MAX_LIMIT) }).limit, 200);
    for (const status of RESERVATION_IMPORT_STATUSES) assert.equal(ListReservationImportsQuerySchema.parse({ status }).status, status);
    assert.match(messagesOf(ListReservationImportsQuerySchema.safeParse({ limit: "0" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(ListReservationImportsQuerySchema.safeParse({ limit: "201" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(ListReservationImportsQuerySchema.safeParse({ limit: "1.5" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(ListReservationImportsQuerySchema.safeParse({ limit: "abc" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(ListReservationImportsQuerySchema.safeParse({ status: "done" })).join(), /status debe ser uno de: processing, imported, partial, failed, undone\./);
    assert.match(messagesOf(ListReservationImportsQuerySchema.safeParse({ estado: "undone" })).join(), /^estado: Campo no admitido/);
  });
});

describe("ReservationImportTemplateQuerySchema", () => {
  it("format csv por defecto, xlsx admitido, otro valor y clave extra rechazados", () => {
    assert.deepEqual(ReservationImportTemplateQuerySchema.parse({}), { format: "csv" });
    assert.equal(ReservationImportTemplateQuerySchema.parse({ format: "xlsx" }).format, "xlsx");
    assert.match(messagesOf(ReservationImportTemplateQuerySchema.safeParse({ format: "pdf" })).join(), /format debe ser uno de: csv, xlsx\./);
    assert.match(messagesOf(ReservationImportTemplateQuerySchema.safeParse({ formato: "csv" })).join(), /^formato: Campo no admitido/);
  });
});

describe("UndoReservationImportSchema", () => {
  it("cuerpo vacío válido; reason recortado y ≤ 500; clave extra rechazada", () => {
    assert.deepEqual(UndoReservationImportSchema.parse({}), {});
    assert.deepEqual(UndoReservationImportSchema.parse({ reason: "  Fichero equivocado " }), { reason: "Fichero equivocado" });
    assert.equal(UndoReservationImportSchema.parse({ reason: "r".repeat(RESERVATION_IMPORT_MAX_UNDO_REASON) }).reason?.length, 500);
    assert.match(messagesOf(UndoReservationImportSchema.safeParse({ reason: "r".repeat(RESERVATION_IMPORT_MAX_UNDO_REASON + 1) })).join(), /reason no puede superar 500 caracteres/);
    assert.match(messagesOf(UndoReservationImportSchema.safeParse({ reason: 42 })).join(), /reason debe ser un texto/);
    assert.match(messagesOf(UndoReservationImportSchema.safeParse({ motivo: "x" })).join(), /^motivo: Campo no admitido/);
    assertSpanish(messagesOf(UndoReservationImportSchema.safeParse({ reason: 42, motivo: "x" })));
  });
});
