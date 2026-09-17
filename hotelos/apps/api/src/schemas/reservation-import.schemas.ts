// Esquemas zod de las rutas de importación masiva de reservas (Tanda 7 · L3):
// `POST /properties/:propertyId/reservations/imports/preview`,
// `POST /properties/:propertyId/reservations/imports`,
// `GET /properties/:propertyId/reservations/imports`,
// `GET /properties/:propertyId/reservations/imports/template`,
// `POST /properties/:propertyId/reservations/imports/:id/undo`.
//
// Todos los cuerpos y consultas son `.strict()` con mensajes en español: una
// clave desconocida es un 400 VALIDATION_ERROR que nombra la clave (parseOr400
// de modules/rate-manager/rate-grid.schemas.ts), nunca se descarta en silencio.
// Los tipos wire y los límites viven en @hotelos/shared
// (reservation-import-types.ts); estos esquemas los validan en la frontera HTTP
// y exportan sus `z.infer` para las rutas y el CLI.
//
// Reglas que quedan en el servicio (reservation-import.service.ts), no aquí:
// tamaño real del fichero tras base64 (5 MiB → RESERVATION_IMPORT_TOO_LARGE),
// filas (5.000 → TOO_MANY_ROWS), mapeo incompleto o en conflicto, duplicado por
// hash, validación por fila, disponibilidad y tenencia. Aquí solo se garantiza
// la forma: exactamente uno de `content` (texto: CLI y tests) o `contentBase64`
// (bytes: siempre desde el navegador), `commit` literal `true`, `limit` 1..200,
// `reason` ≤ 500 y un mapeo columna → campo canónico (o null = ignorar).

import { z } from "zod";
import {
  RESERVATION_IMPORT_FIELDS,
  RESERVATION_IMPORT_FORMATS,
  RESERVATION_IMPORT_LIST_DEFAULT_LIMIT,
  RESERVATION_IMPORT_LIST_MAX_LIMIT,
  RESERVATION_IMPORT_MAX_BASE64_CHARS,
  RESERVATION_IMPORT_MAX_CONTENT_CHARS,
  RESERVATION_IMPORT_MAX_FILE_NAME,
  RESERVATION_IMPORT_MAX_MAPPING_KEYS,
  RESERVATION_IMPORT_MAX_SAMPLE_SIZE,
  RESERVATION_IMPORT_MAX_SHEET_NAME,
  RESERVATION_IMPORT_MAX_UNDO_REASON,
  RESERVATION_IMPORT_STATUSES
} from "@hotelos/shared";

const STRICT_BODY = { message: "Campo no admitido en el cuerpo de la petición." };

/** base64 estándar (con `=` de relleno y saltos de línea tolerados). */
export const BASE64_PATTERN = /^[A-Za-z0-9+/=\r\n]+$/;

/** Mensaje del XOR content / contentBase64 (también cuando faltan los dos). */
export const CONTENT_XOR_MESSAGE = "Indica content (texto) o contentBase64 (fichero), no ambos.";

function flag(name: string) {
  return z.boolean({ invalid_type_error: `${name} debe ser true o false.` }).default(false);
}

/** "1.234.567" sin depender de ICU (mensajes de límite). */
function groupEs(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ── Mapeo columna del fichero → campo canónico (o null = «Ignorar columna») ──

const mappingKey = z
  .string({ invalid_type_error: "mapping: la clave debe ser el nombre de la columna del fichero." })
  .min(1, { message: "mapping: la columna no puede estar vacía." })
  .max(200, { message: "mapping: la columna no puede superar 200 caracteres." });

const mappingField = z
  .enum(RESERVATION_IMPORT_FIELDS, { errorMap: () => ({ message: `mapping: cada valor debe ser un campo de la plantilla (${RESERVATION_IMPORT_FIELDS.join(", ")}) o null para ignorar la columna.` }) })
  .nullable();

export const ReservationImportMappingSchema = z
  .record(mappingKey, mappingField, { invalid_type_error: "mapping debe ser un objeto columna del fichero → campo de la plantilla (o null para ignorar la columna)." })
  .refine((mapping) => Object.keys(mapping).length <= RESERVATION_IMPORT_MAX_MAPPING_KEYS, { message: `mapping no puede tener más de ${RESERVATION_IMPORT_MAX_MAPPING_KEYS} columnas.` });
export type ReservationImportMappingInput = z.infer<typeof ReservationImportMappingSchema>;

// ── POST /properties/:propertyId/reservations/imports/preview ───────────────

const previewShape = {
  fileName: z
    .string({ invalid_type_error: "fileName debe ser un texto." })
    .trim()
    .min(1, { message: "fileName no puede estar vacío." })
    .max(RESERVATION_IMPORT_MAX_FILE_NAME, { message: `fileName no puede superar ${RESERVATION_IMPORT_MAX_FILE_NAME} caracteres.` })
    .optional(),
  format: z.enum(RESERVATION_IMPORT_FORMATS, { errorMap: () => ({ message: `format debe ser uno de: ${RESERVATION_IMPORT_FORMATS.join(", ")}.` }) }).optional(),
  content: z
    .string({ invalid_type_error: "content debe ser el texto del fichero." })
    .min(1, { message: "content no puede estar vacío." })
    .max(RESERVATION_IMPORT_MAX_CONTENT_CHARS, { message: `content no puede superar ${groupEs(RESERVATION_IMPORT_MAX_CONTENT_CHARS)} caracteres: usa contentBase64 o el CLI reservations:import.` })
    .optional(),
  contentBase64: z
    .string({ invalid_type_error: "contentBase64 debe ser el fichero en base64." })
    .min(1, { message: "contentBase64 no puede estar vacío." })
    .max(RESERVATION_IMPORT_MAX_BASE64_CHARS, { message: `contentBase64 no puede superar ${groupEs(RESERVATION_IMPORT_MAX_BASE64_CHARS)} caracteres (fichero de 5 MB): pártelo o usa el CLI reservations:import.` })
    .regex(BASE64_PATTERN, { message: "contentBase64 debe ser base64 (A-Z, a-z, 0-9, +, /, =)." })
    .optional(),
  sheetName: z
    .string({ invalid_type_error: "sheetName debe ser un texto." })
    .trim()
    .min(1, { message: "sheetName no puede estar vacío." })
    .max(RESERVATION_IMPORT_MAX_SHEET_NAME, { message: `sheetName no puede superar ${RESERVATION_IMPORT_MAX_SHEET_NAME} caracteres.` })
    .optional(),
  mapping: ReservationImportMappingSchema.optional(),
  omitirInvalidas: flag("omitirInvalidas"),
  permitirOverbooking: flag("permitirOverbooking"),
  historico: flag("historico"),
  force: flag("force"),
  sampleSize: z.coerce
    .number({ invalid_type_error: `sampleSize debe ser un entero entre 1 y ${groupEs(RESERVATION_IMPORT_MAX_SAMPLE_SIZE)}.` })
    .int({ message: `sampleSize debe ser un entero entre 1 y ${groupEs(RESERVATION_IMPORT_MAX_SAMPLE_SIZE)}.` })
    .min(1, { message: `sampleSize debe ser un entero entre 1 y ${groupEs(RESERVATION_IMPORT_MAX_SAMPLE_SIZE)}.` })
    .max(RESERVATION_IMPORT_MAX_SAMPLE_SIZE, { message: `sampleSize debe ser un entero entre 1 y ${groupEs(RESERVATION_IMPORT_MAX_SAMPLE_SIZE)}.` })
    .optional()
};

/** Exactamente uno de `content` / `contentBase64` (ninguno o los dos → 400). */
function hasExactlyOneContent(body: { content?: string; contentBase64?: string }): boolean {
  return (body.content !== undefined) !== (body.contentBase64 !== undefined);
}

export const PreviewReservationImportSchema = z
  .object(previewShape)
  .strict(STRICT_BODY)
  .refine(hasExactlyOneContent, { path: ["content"], message: CONTENT_XOR_MESSAGE });
export type PreviewReservationImportInput = z.infer<typeof PreviewReservationImportSchema>;

// ── POST /properties/:propertyId/reservations/imports ───────────────────────

export const CreateReservationImportSchema = z
  .object({
    ...previewShape,
    commit: z.literal(true, { errorMap: () => ({ message: "commit debe ser true: confirma que quieres crear las reservas (la previsualización es POST …/imports/preview)." }) })
  })
  .strict(STRICT_BODY)
  .refine(hasExactlyOneContent, { path: ["content"], message: CONTENT_XOR_MESSAGE });
export type CreateReservationImportInput = z.infer<typeof CreateReservationImportSchema>;

// ── GET /properties/:propertyId/reservations/imports ────────────────────────

export const ListReservationImportsQuerySchema = z
  .object({
    status: z.enum(RESERVATION_IMPORT_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${RESERVATION_IMPORT_STATUSES.join(", ")}.` }) }).optional(),
    limit: z.coerce
      .number({ invalid_type_error: `limit debe ser un entero entre 1 y ${RESERVATION_IMPORT_LIST_MAX_LIMIT}.` })
      .int({ message: `limit debe ser un entero entre 1 y ${RESERVATION_IMPORT_LIST_MAX_LIMIT}.` })
      .min(1, { message: `limit debe ser un entero entre 1 y ${RESERVATION_IMPORT_LIST_MAX_LIMIT}.` })
      .max(RESERVATION_IMPORT_LIST_MAX_LIMIT, { message: `limit debe ser un entero entre 1 y ${RESERVATION_IMPORT_LIST_MAX_LIMIT}.` })
      .default(RESERVATION_IMPORT_LIST_DEFAULT_LIMIT)
  })
  .strict(STRICT_BODY);
export type ListReservationImportsQueryInput = z.infer<typeof ListReservationImportsQuerySchema>;

// ── GET /properties/:propertyId/reservations/imports/template ───────────────

export const ReservationImportTemplateQuerySchema = z
  .object({
    format: z.enum(RESERVATION_IMPORT_FORMATS, { errorMap: () => ({ message: `format debe ser uno de: ${RESERVATION_IMPORT_FORMATS.join(", ")}.` }) }).default("csv")
  })
  .strict(STRICT_BODY);
export type ReservationImportTemplateQueryInput = z.infer<typeof ReservationImportTemplateQuerySchema>;

// ── POST /properties/:propertyId/reservations/imports/:id/undo ──────────────

export const UndoReservationImportSchema = z
  .object({
    reason: z
      .string({ invalid_type_error: "reason debe ser un texto." })
      .trim()
      .max(RESERVATION_IMPORT_MAX_UNDO_REASON, { message: `reason no puede superar ${RESERVATION_IMPORT_MAX_UNDO_REASON} caracteres.` })
      .optional()
  })
  .strict(STRICT_BODY);
export type UndoReservationImportInput = z.infer<typeof UndoReservationImportSchema>;
