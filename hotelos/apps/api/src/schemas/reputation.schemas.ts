// Esquemas zod de las rutas de reputación (Tanda T8 · lote T8-D):
// `/reputation/properties/:propertyId/{inbox,sources,runs,imports}` y
// `/reputation/reviews/:id{,/draft,/quality-case}` (modules/reputation/
// reputation.routes.ts). Todos `.strict()` con mensajes en español (parseOr400
// de modules/rate-manager/rate-grid.schemas.ts): una clave desconocida es un
// 400 VALIDATION_ERROR que la nombra. Patrón de schemas/pms-shadow.schemas.ts.
//
// Los vocabularios (estados, categorías, proveedores, modos) y los límites
// (INBOX_LIMIT_MAX, RUNS_LIMIT_MAX, pesos, retención) viven en
// modules/reputation/reputation-types.ts (bloque compartido con el navegador);
// aquí solo se valida la forma. Reglas que quedan en los servicios: máquina de
// estados de la reseña (409 INVALID_TRANSITION), publicación sin
// replyCapability (409 REVIEW_NOT_REPLYABLE), credenciales en la configuración
// de una fuente (400), tenencia (404 opaco).

import { z } from "zod";
import { CSV_MAX_ROWS } from "../modules/reputation/review-csv.parser.js";
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from "../modules/reputation/review-sources.service.js";
import {
  INBOX_LIMIT_MAX,
  REVIEW_CATEGORIES,
  REVIEW_PROVIDERS,
  REVIEW_SOURCE_MODES,
  REVIEW_STATUSES,
  RUNS_LIMIT_MAX,
  SENTIMENTS,
  SOURCE_WEIGHT_MAX,
  SOURCE_WEIGHT_MIN
} from "../modules/reputation/reputation-types.js";
import { BASE64_PATTERN } from "./reservation-import.schemas.js";

const STRICT = { message: "Campo no admitido en el cuerpo de la petición." };
const STRICT_QUERY = { message: "Parámetro no admitido en la consulta." };

/** Límites propios de estas rutas. */
export const REPUTATION_MAX_DISPLAY_NAME = 120;
export const REPUTATION_MAX_EXTERNAL_ID = 200;
export const REPUTATION_MAX_USER_ID = 100;
export const REPUTATION_MAX_CASE_TITLE = 200;
export const REPUTATION_MAX_LANGUAGE = 8;
export const REPUTATION_MAX_SOURCE_CODE = 60;
export const REPUTATION_MAX_RESPONSE_STATE = 100;
/**
 * `contentBase64` ≤ 2.800.000 caracteres (≈ 2 MiB decodificados), coherente
 * con el bodyLimit de 4 MiB de `POST …/imports` (IMPORT_OPTIONS en las rutas).
 */
export const IMPORT_MAX_BASE64_CHARS = 2_800_000;
/** `rows` ≤ 5.000 filas, el mismo tope que el parser CSV. */
export const IMPORT_MAX_ROWS = CSV_MAX_ROWS;
export const IMPORT_MAX_SCALE = 100;
export const IMPORT_ROW_MAX_DATE = 40;
export const IMPORT_ROW_MAX_TITLE = 200;
export const IMPORT_ROW_MAX_BODY = 8000;
export const IMPORT_ROW_MAX_AUTHOR = 120;
export const IMPORT_ROW_MAX_URL = 2000;
export const IMPORT_MAX_FILE_NAME = 200;

/** Tonos del borrador en el cable; la ruta los traduce a los del puerto de IA (formal | cercano). */
export const DRAFT_TONES = ["cordial", "formal", "breve"] as const;
export type DraftTone = (typeof DRAFT_TONES)[number];

/** Prioridades del caso de calidad (mismo vocabulario que el motor genérico: advanced-record-schemas.ts). */
export const QUALITY_CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type QualityCasePriority = (typeof QUALITY_CASE_PRIORITIES)[number];

function groupEs(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const enumOf = <T extends readonly [string, ...string[]]>(name: string, values: T) =>
  z.enum(values, { errorMap: () => ({ message: `${name} debe ser uno de: ${values.join(", ")}.` }) });

const text = (name: string, max: number, min = 1) =>
  z
    .string({ invalid_type_error: `${name} debe ser un texto.` })
    .trim()
    .min(min, { message: `${name} no puede estar vacío.` })
    .max(max, { message: `${name} no puede superar ${groupEs(max)} caracteres.` });

const isoDateTime = (name: string) =>
  z.string({ invalid_type_error: `${name} debe ser una fecha ISO 8601.` }).datetime({ offset: true, message: `${name} debe ser una fecha ISO 8601 (por ejemplo 2026-09-19T10:00:00Z).` });

const flag = (name: string) => z.boolean({ invalid_type_error: `${name} debe ser true o false.` });

/** Booleano de query: "1" | "0" (también true/false por compatibilidad). */
const queryFlag = (name: string) =>
  z
    .enum(["1", "0", "true", "false"], { errorMap: () => ({ message: `${name} debe ser 1 o 0.` }) })
    .transform((value) => value === "1" || value === "true");

const score10 = (name: string) =>
  z.coerce
    .number({ invalid_type_error: `${name} debe ser un número entre 0 y 10.` })
    .min(0, { message: `${name} debe ser un número entre 0 y 10.` })
    .max(10, { message: `${name} debe ser un número entre 0 y 10.` });

const limitQuery = (max: number, fallback: number) =>
  z.coerce
    .number({ invalid_type_error: `limit debe ser un entero entre 1 y ${max}.` })
    .int({ message: `limit debe ser un entero entre 1 y ${max}.` })
    .min(1, { message: `limit debe ser un entero entre 1 y ${max}.` })
    .max(max, { message: `limit debe ser un entero entre 1 y ${max}.` })
    .default(fallback);

const userId = (name: string) => text(name, REPUTATION_MAX_USER_ID);
const externalId = (name: string) => text(name, REPUTATION_MAX_EXTERNAL_ID);

// ── GET /reputation/properties/:propertyId/inbox ─────────────────────────────

/**
 * Filtros de la bandeja (en memoria, review-inbox.service.ts) + paginación por
 * cursor (`limit` 1-100, `cursor` opaco, `envelope` de lib/pagination.ts).
 */
export const InboxQuerySchema = z
  .object({
    status: enumOf("status", REVIEW_STATUSES).optional(),
    source: text("source", REPUTATION_MAX_SOURCE_CODE).optional(),
    minScore: score10("minScore").optional(),
    maxScore: score10("maxScore").optional(),
    category: enumOf("category", REVIEW_CATEGORIES).optional(),
    language: text("language", REPUTATION_MAX_LANGUAGE, 2).optional(),
    sentiment: enumOf("sentiment", SENTIMENTS).optional(),
    responded: queryFlag("responded").optional(),
    overdue: queryFlag("overdue").optional(),
    assignedUserId: userId("assignedUserId").optional(),
    limit: limitQuery(INBOX_LIMIT_MAX, 25).optional(),
    cursor: z.string({ invalid_type_error: "cursor debe ser un texto." }).max(4000, { message: "cursor no válido." }).optional(),
    envelope: z.enum(["1", "0", "true", "false"], { errorMap: () => ({ message: "envelope debe ser 1 o 0." }) }).optional()
  })
  .strict(STRICT_QUERY)
  .refine((value) => value.minScore === undefined || value.maxScore === undefined || value.minScore <= value.maxScore, {
    message: "minScore no puede ser mayor que maxScore.",
    path: ["minScore"]
  });
export type InboxQueryInput = z.infer<typeof InboxQuerySchema>;

// ── PATCH /reputation/reviews/:id ────────────────────────────────────────────

/** Estado / responsable / plazo / metadatos de la respuesta. Nunca responseBody (eso es POST …/respond). */
export const ReviewPatchSchema = z
  .object({
    status: enumOf("status", REVIEW_STATUSES).optional(),
    assignedUserId: userId("assignedUserId").nullable().optional(),
    slaTargetAt: isoDateTime("slaTargetAt").nullable().optional(),
    responseSource: enumOf("responseSource", ["api", "manual"]).optional(),
    responseExternalState: text("responseExternalState", REPUTATION_MAX_RESPONSE_STATE).optional(),
    publish: flag("publish").optional()
  })
  .strict(STRICT)
  .refine((value) => Object.keys(value).length > 0, { message: "El cuerpo no contiene ningún cambio." });
export type ReviewPatchInput = z.infer<typeof ReviewPatchSchema>;

// ── POST /reputation/reviews/:id/draft ───────────────────────────────────────

export const DraftSchema = z
  .object({
    tone: enumOf("tone", DRAFT_TONES).optional(),
    language: text("language", REPUTATION_MAX_LANGUAGE, 2).optional()
  })
  .strict(STRICT);
export type DraftInput = z.infer<typeof DraftSchema>;

// ── POST /reputation/reviews/:id/quality-case ────────────────────────────────

export const QualityCaseFromReviewSchema = z
  .object({
    priority: enumOf("priority", QUALITY_CASE_PRIORITIES).optional(),
    ownerUserId: userId("ownerUserId").optional(),
    slaTargetAt: isoDateTime("slaTargetAt").optional(),
    title: text("title", REPUTATION_MAX_CASE_TITLE).optional()
  })
  .strict(STRICT);
export type QualityCaseFromReviewInput = z.infer<typeof QualityCaseFromReviewSchema>;

// ── Fuentes ──────────────────────────────────────────────────────────────────

const weight = z
  .number({ invalid_type_error: `weight debe ser un número entre ${SOURCE_WEIGHT_MIN} y ${SOURCE_WEIGHT_MAX}.` })
  .min(SOURCE_WEIGHT_MIN, { message: `weight mínimo ${SOURCE_WEIGHT_MIN}.` })
  .max(SOURCE_WEIGHT_MAX, { message: `weight máximo ${SOURCE_WEIGHT_MAX}.` });

const retentionDays = z
  .number({ invalid_type_error: `retentionDays debe ser un entero entre ${RETENTION_DAYS_MIN} y ${RETENTION_DAYS_MAX}.` })
  .int({ message: `retentionDays debe ser un entero entre ${RETENTION_DAYS_MIN} y ${RETENTION_DAYS_MAX}.` })
  .min(RETENTION_DAYS_MIN, { message: `retentionDays mínimo ${RETENTION_DAYS_MIN}.` })
  .max(RETENTION_DAYS_MAX, { message: `retentionDays máximo ${groupEs(RETENTION_DAYS_MAX)}.` });

export const SourceCreateSchema = z
  .object({
    provider: enumOf("provider", REVIEW_PROVIDERS),
    mode: enumOf("mode", REVIEW_SOURCE_MODES).optional(),
    displayName: text("displayName", REPUTATION_MAX_DISPLAY_NAME).optional(),
    weight: weight.optional(),
    retentionDays: retentionDays.optional(),
    externalLocationId: externalId("externalLocationId").optional(),
    externalAccountId: externalId("externalAccountId").optional(),
    /** Fuente de demostración (reseñas ficticias, proveedor `<provider>_demo`). */
    isDemo: flag("isDemo").optional()
  })
  .strict(STRICT);
export type SourceCreateInput = z.infer<typeof SourceCreateSchema>;

export const SourceUpdateSchema = z
  .object({
    mode: enumOf("mode", REVIEW_SOURCE_MODES).optional(),
    displayName: text("displayName", REPUTATION_MAX_DISPLAY_NAME).optional(),
    weight: weight.optional(),
    retentionDays: retentionDays.optional(),
    externalLocationId: externalId("externalLocationId").nullable().optional(),
    externalAccountId: externalId("externalAccountId").nullable().optional(),
    /** Reactiva una fuente `disabled`. */
    enabled: flag("enabled").optional()
  })
  .strict(STRICT)
  .refine((value) => Object.keys(value).length > 0, { message: "El cuerpo no contiene ningún cambio." });
export type SourceUpdateInput = z.infer<typeof SourceUpdateSchema>;

export const SourcesQuerySchema = z
  .object({
    includeDisabled: queryFlag("includeDisabled").optional()
  })
  .strict(STRICT_QUERY);
export type SourcesQueryInput = z.infer<typeof SourcesQuerySchema>;

// ── GET /reputation/properties/:propertyId/runs ──────────────────────────────

export const RunsQuerySchema = z
  .object({
    limit: limitQuery(RUNS_LIMIT_MAX, RUNS_LIMIT_MAX),
    sourceId: userId("sourceId").optional()
  })
  .strict(STRICT_QUERY);
export type RunsQueryInput = z.infer<typeof RunsQuerySchema>;

// ── POST /reputation/properties/:propertyId/imports ──────────────────────────

/** Fila JSON de importación (mismas columnas canónicas que el CSV: review-csv.parser.ts). */
export const ImportRowSchema = z
  .object({
    externalId: externalId("externalId").optional(),
    date: text("date", IMPORT_ROW_MAX_DATE),
    rating: z.union([z.number(), z.string().trim().max(20)], { errorMap: () => ({ message: "rating debe ser un número (o su texto)." }) }).nullable().optional(),
    scaleMax: z.number({ invalid_type_error: "scaleMax debe ser un número." }).positive({ message: "scaleMax debe ser positivo." }).max(IMPORT_MAX_SCALE).optional(),
    title: z.string({ invalid_type_error: "title debe ser un texto." }).trim().max(IMPORT_ROW_MAX_TITLE, { message: `title no puede superar ${IMPORT_ROW_MAX_TITLE} caracteres.` }).optional(),
    body: z.string({ invalid_type_error: "body debe ser un texto." }).trim().max(IMPORT_ROW_MAX_BODY, { message: `body no puede superar ${groupEs(IMPORT_ROW_MAX_BODY)} caracteres.` }).optional(),
    language: z.string({ invalid_type_error: "language debe ser un texto." }).trim().max(10, { message: "language no puede superar 10 caracteres." }).optional(),
    author: z.string({ invalid_type_error: "author debe ser un texto." }).trim().max(IMPORT_ROW_MAX_AUTHOR, { message: `author no puede superar ${IMPORT_ROW_MAX_AUTHOR} caracteres.` }).optional(),
    country: z.string({ invalid_type_error: "country debe ser un texto." }).trim().max(2, { message: "country debe ser un código ISO de 2 letras." }).optional(),
    url: z.string({ invalid_type_error: "url debe ser un texto." }).trim().max(IMPORT_ROW_MAX_URL, { message: `url no puede superar ${groupEs(IMPORT_ROW_MAX_URL)} caracteres.` }).optional()
  })
  .strict({ message: "rows: columna no admitida." });
export type ImportRowInput = z.infer<typeof ImportRowSchema>;

const contentBase64 = z
  .string({ invalid_type_error: "contentBase64 debe ser el fichero CSV en base64." })
  .min(1, { message: "contentBase64 no puede estar vacío." })
  .max(IMPORT_MAX_BASE64_CHARS, { message: `contentBase64 no puede superar ${groupEs(IMPORT_MAX_BASE64_CHARS)} caracteres (≈ 2 MB decodificados): parte el fichero.` })
  .regex(BASE64_PATTERN, { message: "contentBase64 debe ser base64 (A-Z, a-z, 0-9, +, /, =)." });

export const IMPORT_CONTENT_XOR_MESSAGE = "Indica contentBase64 (fichero CSV) o rows (filas JSON), no ambos.";

export const ImportSchema = z
  .object({
    /** Portal de origen de las reseñas (fija la escala si el portal la publica). */
    source: enumOf("source", REVIEW_PROVIDERS),
    /** Escala por defecto cuando la fila no trae `scale_max` y el portal no la fija. */
    scaleMax: z.number({ invalid_type_error: "scaleMax debe ser un número." }).positive({ message: "scaleMax debe ser positivo." }).max(IMPORT_MAX_SCALE, { message: `scaleMax no puede superar ${IMPORT_MAX_SCALE}.` }).optional(),
    /** Fuente destino (ReviewSource de la propiedad); si falta, se usa o crea la fuente CSV del portal. */
    sourceId: userId("sourceId").optional(),
    fileName: text("fileName", IMPORT_MAX_FILE_NAME).optional(),
    contentBase64: contentBase64.optional(),
    rows: z.array(ImportRowSchema, { invalid_type_error: "rows debe ser una lista de filas." }).min(1, { message: "rows no puede estar vacía." }).max(IMPORT_MAX_ROWS, { message: `rows no puede superar ${groupEs(IMPORT_MAX_ROWS)} filas.` }).optional()
  })
  .strict(STRICT)
  .refine((value) => (value.contentBase64 !== undefined) !== (value.rows !== undefined), { message: IMPORT_CONTENT_XOR_MESSAGE, path: ["contentBase64"] });
export type ImportInput = z.infer<typeof ImportSchema>;
