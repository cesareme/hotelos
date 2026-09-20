// Esquemas zod de las rutas de documentos (Tanda T9 · lote T9-05a, diseño §9).
// Convención de email-connections.schemas.ts: `.strict()` (clave desconocida →
// 400 VALIDATION_ERROR en español vía parseOr400 de rate-grid.schemas.ts). Los
// catálogos vienen de packages/shared/src/documents-types.ts (única fuente de
// los enums Prisma y de estos esquemas). Los bytes viajan en base64 dentro del
// JSON (bodyLimit por ruta, §4.2): aquí solo se valida la FORMA del base64; el
// tamaño real (413 DOCUMENT_TOO_LARGE), la lista blanca MIME y los magic bytes
// los comprueba el servicio (magic-bytes.ts) antes de decodificar del todo.

import { z } from "zod";
import {
  DOCUMENT_FILE_NAME_MAX_LENGTH,
  DOCUMENT_PHYSICAL_STATUSES,
  DOCUMENT_UPLOAD_MAX_FILES,
  INCOMING_DOCUMENT_KINDS,
  INCOMING_DOCUMENT_STATUSES,
  type IncomingDocumentStatus
} from "@hotelos/shared";

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

/** Alfabeto estándar (RFC 4648 §4), sin espacios ni prefijo `data:`; relleno `=` solo al final. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Forma válida: no vacío, longitud múltiplo de 4 y solo alfabeto base64 (sin saltos de línea ni `data:…;base64,`). */
export function isBase64(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length % 4 === 0 && BASE64_RE.test(raw);
}

/** Bytes que producirá la decodificación, sin decodificar (para el 413 antes de reservar memoria). */
export function base64DecodedSize(raw: string): number {
  if (raw.length === 0) return 0;
  let padding = 0;
  if (raw.endsWith("==")) padding = 2;
  else if (raw.endsWith("=")) padding = 1;
  return (raw.length / 4) * 3 - padding;
}

/** Decodifica un base64 ya validado con isBase64. */
export function decodeBase64(raw: string): Buffer {
  return Buffer.from(raw, "base64");
}

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------

export const DOCUMENT_NOTE_MAX_LENGTH = 2000;
export const DOCUMENT_QUERY_TEXT_MAX_LENGTH = 120;

/** Canales que un cliente puede declarar; `email` / `e_invoice` / `scanner` los fija el servidor (documents-types.ts). */
export const DOCUMENT_CLIENT_SOURCES = ["upload", "mobile", "api"] as const;
export type DocumentClientSource = (typeof DOCUMENT_CLIENT_SOURCES)[number];

/** Papeles que admite `POST …/documents/:id/files` (las imágenes de página, etiquetas y hojas de remesa las escribe el servidor). */
export const DOCUMENT_ADD_FILE_ROLES = ["original", "derived"] as const;

const fileNameSchema = z
  .string({ invalid_type_error: "fileName debe ser un texto." })
  .trim()
  .min(1, { message: "fileName no puede estar vacío." })
  .max(DOCUMENT_FILE_NAME_MAX_LENGTH, { message: `fileName no puede superar ${DOCUMENT_FILE_NAME_MAX_LENGTH} caracteres.` })
  // Sin separadores de ruta ni caracteres de control: el nombre solo se muestra y viaja en content-disposition.
  .regex(/^[^/\\\u0000-\u001f]+$/, { message: "fileName no puede contener barras ni caracteres de control." });

const mimeTypeSchema = z
  .string({ invalid_type_error: "mimeType debe ser un texto." })
  .trim()
  .min(1, { message: "mimeType no puede estar vacío." })
  .max(120, { message: "mimeType no puede superar 120 caracteres." });

const base64Schema = z
  .string({ invalid_type_error: "base64 debe ser un texto." })
  .min(1, { message: "base64 no puede estar vacío." })
  .refine(isBase64, { message: "base64 no válido: alfabeto estándar sin espacios ni prefijo data:, longitud múltiplo de 4." });

const noteSchema = z
  .string({ invalid_type_error: "note debe ser un texto." })
  .trim()
  .max(DOCUMENT_NOTE_MAX_LENGTH, { message: `note no puede superar ${DOCUMENT_NOTE_MAX_LENGTH} caracteres.` })
  .optional();

const kindSchema = z.enum(INCOMING_DOCUMENT_KINDS, { errorMap: () => ({ message: `kind debe ser uno de: ${INCOMING_DOCUMENT_KINDS.join(", ")}.` }) });

/** Día ISO real (AAAA-MM-DD; 2026-02-30 no vale). */
export const isoDaySchema = z
  .string({ invalid_type_error: "fecha AAAA-MM-DD." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "fecha AAAA-MM-DD." })
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, { message: "fecha no válida." });

/** `true|false|1|0` de la query string → boolean. */
export const boolQuerySchema = z.enum(["true", "false", "1", "0"], { errorMap: () => ({ message: "valor booleano: true, false, 1 o 0." }) }).transform((value) => value === "true" || value === "1");

const STATUS_SET = new Set<string>(INCOMING_DOCUMENT_STATUSES);

/** `status=a,b` o `status=a&status=b` → lista sin repetidos, cada valor del catálogo. */
const statusListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value, ctx) => {
    const raw = Array.isArray(value) ? value : [value];
    const out: IncomingDocumentStatus[] = [];
    for (const item of raw) {
      for (const piece of item.split(",")) {
        const status = piece.trim();
        if (!status) continue;
        if (!STATUS_SET.has(status)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `status debe ser uno de: ${INCOMING_DOCUMENT_STATUSES.join(", ")}.` });
          return z.NEVER;
        }
        if (!out.includes(status as IncomingDocumentStatus)) out.push(status as IncomingDocumentStatus);
      }
    }
    if (out.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "status no puede estar vacío." });
      return z.NEVER;
    }
    return out;
  });

// ---------------------------------------------------------------------------
// Cuerpos (§9)
// ---------------------------------------------------------------------------

/** Un fichero de la subida (`DocumentUploadFile`). */
export const DocumentUploadFileSchema = z.object({ fileName: fileNameSchema, mimeType: mimeTypeSchema, base64: base64Schema }).strict();
export type DocumentUploadFileInput = z.output<typeof DocumentUploadFileSchema>;

/** `POST /properties/:propertyId/documents` (`DocumentUploadRequest`): 1..20 ficheros. */
export const DocumentUploadRequestSchema = z
  .object({
    files: z
      .array(DocumentUploadFileSchema, { invalid_type_error: "files debe ser una lista de ficheros." })
      .min(1, { message: "files debe incluir al menos un fichero." })
      .max(DOCUMENT_UPLOAD_MAX_FILES, { message: `files no puede incluir más de ${DOCUMENT_UPLOAD_MAX_FILES} ficheros por envío.` }),
    kindHint: kindSchema.optional(),
    note: noteSchema,
    allowDuplicate: z.boolean({ invalid_type_error: "allowDuplicate debe ser true o false." }).optional(),
    source: z.enum(DOCUMENT_CLIENT_SOURCES, { errorMap: () => ({ message: `source debe ser uno de: ${DOCUMENT_CLIENT_SOURCES.join(", ")}.` }) }).optional(),
    splitPages: z.boolean({ invalid_type_error: "splitPages debe ser true o false." }).optional()
  })
  .strict();
export type DocumentUploadRequestInput = z.output<typeof DocumentUploadRequestSchema>;

/** `POST …/documents/:id/files` (`DocumentAddFileRequest`): reverso o anexo. */
export const DocumentAddFileRequestSchema = DocumentUploadFileSchema.extend({
  role: z.enum(DOCUMENT_ADD_FILE_ROLES, { errorMap: () => ({ message: `role debe ser uno de: ${DOCUMENT_ADD_FILE_ROLES.join(", ")}.` }) }).optional(),
  note: noteSchema
}).strict();
export type DocumentAddFileRequestInput = z.output<typeof DocumentAddFileRequestSchema>;

/** `POST …/documents/:id/recapture`: fichero nuevo, mismo registro. */
export const DocumentRecaptureRequestSchema = DocumentUploadFileSchema.extend({ note: noteSchema }).strict();
export type DocumentRecaptureRequestInput = z.output<typeof DocumentRecaptureRequestSchema>;

// ---------------------------------------------------------------------------
// Queries (§9; paginación de lib/pagination.ts: limit / cursor / envelope se leen aparte con parsePageQuery)
// ---------------------------------------------------------------------------

const pagePassthrough = {
  cursor: z.string().max(4096).optional(),
  limit: z.string().max(6).optional(),
  envelope: z.string().max(5).optional()
};

/** `GET /properties/:propertyId/documents` (`DocumentQueueFilters` sin propertyId). */
export const DocumentListQuerySchema = z
  .object({
    status: statusListSchema.optional(),
    kind: kindSchema.optional(),
    physicalStatus: z.enum(DOCUMENT_PHYSICAL_STATUSES, { errorMap: () => ({ message: `physicalStatus debe ser uno de: ${DOCUMENT_PHYSICAL_STATUSES.join(", ")}.` }) }).optional(),
    from: isoDaySchema.optional(),
    to: isoDaySchema.optional(),
    q: z.string().trim().max(DOCUMENT_QUERY_TEXT_MAX_LENGTH, { message: `q no puede superar ${DOCUMENT_QUERY_TEXT_MAX_LENGTH} caracteres.` }).optional(),
    assignedTo: z.string().trim().min(1).max(64).optional(),
    slaBreachedOnly: boolQuerySchema.optional(),
    ...pagePassthrough
  })
  .strict();
export type DocumentListQueryInput = z.output<typeof DocumentListQuerySchema>;

/** `GET /organizations/:organizationId/documents/queue`: los mismos filtros + `propertyId`. */
export const DocumentQueueQuerySchema = DocumentListQuerySchema.extend({
  propertyId: z.string().trim().min(1).max(64).optional()
}).strict();
export type DocumentQueueQueryInput = z.output<typeof DocumentQueueQuerySchema>;

/** `GET …/documents/:id/file` · `…/pages/:n/image`: `?inline=1` → content-disposition inline. */
export const DocumentFileQuerySchema = z.object({ inline: boolQuerySchema.optional() }).strict();

/** `:n` de `…/pages/:n/image` (1-based). */
export const DocumentPageNoSchema = z.coerce.number({ invalid_type_error: "n debe ser un entero positivo." }).int({ message: "n debe ser un entero positivo." }).min(1, { message: "n debe ser un entero positivo." }).max(100_000);
