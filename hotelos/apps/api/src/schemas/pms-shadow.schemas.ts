// Esquemas zod de las rutas del modo sombra OPERA Cloud (Tanda 7b · L3):
// `POST /integrations/pms-shadow/ingest` (público, clave de API) y
// `/properties/:propertyId/pms-shadow/*` (perfil, cortes, alertas, reconciliación
// e ingresos). Todos `.strict()` con mensajes en español (parseOr400 de
// modules/rate-manager/rate-grid.schemas.ts): una clave desconocida es un 400
// VALIDATION_ERROR que la nombra. Los tipos wire y los límites viven en
// @hotelos/shared (pms-shadow-types.ts); aquí solo se valida la forma.
//
// Reglas que quedan en el servicio (pms-shadow.service.ts, revenue-import.service.ts):
// tamaño real tras base64 (5 MiB → PMS_SHADOW_FILE_TOO_LARGE), clasificación del
// feed en `auto`, duplicados por hash, perfil ausente / en pausa, tenencia.

import { z } from "zod";
import {
  PMS_SHADOW_ALERT_CODES,
  PMS_SHADOW_FEEDS,
  PMS_SHADOW_MAX_BASE64_CHARS,
  PMS_SHADOW_PROFILE_STATUSES,
  PMS_SHADOW_REVENUE_SOURCES,
  PMS_SHADOW_REVENUE_STATUSES,
  PMS_SHADOW_RUN_STATUSES,
  PMS_SHADOW_TRX_KINDS,
  PMS_SHADOW_USALI_REVENUE_DEPARTMENTS,
  RESERVATION_IMPORT_MAX_CONTENT_CHARS,
  RESERVATION_IMPORT_MAX_FILE_NAME,
  RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS
} from "@hotelos/shared";
import { BASE64_PATTERN, CONTENT_XOR_MESSAGE } from "./reservation-import.schemas.js";

const STRICT = { message: "Campo no admitido en el cuerpo de la petición." };
const STRICT_QUERY = { message: "Parámetro no admitido en la consulta." };

/** Límites propios de estas rutas. */
export const PMS_SHADOW_MAX_OPERA_HOTEL_CODE = 20;
export const PMS_SHADOW_MAX_SFTP_FOLDER = 200;
export const PMS_SHADOW_MAX_NOTE = 500;
export const PMS_SHADOW_MAX_REASON = 500;
export const PMS_SHADOW_MAX_TRX_MAPPINGS = 500;
export const PMS_SHADOW_MAX_DICTIONARY_KEYS = 500;
export const PMS_SHADOW_MAX_SCHEDULE_FEEDS = 20;
export const PMS_SHADOW_LIST_DEFAULT_LIMIT = 50;
export const PMS_SHADOW_LIST_MAX_LIMIT = 200;

function groupEs(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const isoDate = (field: string) =>
  z
    .string({ invalid_type_error: `${field} debe ser una fecha AAAA-MM-DD.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: `${field} debe ser una fecha AAAA-MM-DD.` })
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { message: `${field} debe ser una fecha real (AAAA-MM-DD).` });

const flag = (name: string) => z.boolean({ invalid_type_error: `${name} debe ser true o false.` });

const limitQuery = z.coerce
  .number({ invalid_type_error: `limit debe ser un entero entre 1 y ${PMS_SHADOW_LIST_MAX_LIMIT}.` })
  .int({ message: `limit debe ser un entero entre 1 y ${PMS_SHADOW_LIST_MAX_LIMIT}.` })
  .min(1, { message: `limit debe ser un entero entre 1 y ${PMS_SHADOW_LIST_MAX_LIMIT}.` })
  .max(PMS_SHADOW_LIST_MAX_LIMIT, { message: `limit debe ser un entero entre 1 y ${PMS_SHADOW_LIST_MAX_LIMIT}.` })
  .default(PMS_SHADOW_LIST_DEFAULT_LIMIT);

const fileName = z
  .string({ invalid_type_error: "fileName debe ser un texto." })
  .trim()
  .min(1, { message: "fileName no puede estar vacío." })
  .max(RESERVATION_IMPORT_MAX_FILE_NAME, { message: `fileName no puede superar ${RESERVATION_IMPORT_MAX_FILE_NAME} caracteres.` });

const contentBase64 = z
  .string({ invalid_type_error: "contentBase64 debe ser el fichero en base64." })
  .min(1, { message: "contentBase64 no puede estar vacío." })
  .max(PMS_SHADOW_MAX_BASE64_CHARS, { message: `contentBase64 no puede superar ${groupEs(PMS_SHADOW_MAX_BASE64_CHARS)} caracteres (fichero de 5 MB): pártelo o usa el CLI pms-shadow:pull.` })
  .regex(BASE64_PATTERN, { message: "contentBase64 debe ser base64 (A-Z, a-z, 0-9, +, /, =)." });

const content = z
  .string({ invalid_type_error: "content debe ser el texto del fichero." })
  .min(1, { message: "content no puede estar vacío." })
  .max(RESERVATION_IMPORT_MAX_CONTENT_CHARS, { message: `content no puede superar ${groupEs(RESERVATION_IMPORT_MAX_CONTENT_CHARS)} caracteres: usa contentBase64 o el CLI.` });

// ── Métricas declaradas por OPERA (cuerpo `declared` del ingest / run manual) ──

/** Número como texto («1234.50», «12») o número JSON; el servicio lo normaliza (parseStatNumber). */
const statValue = z.union([z.string().trim().max(40, { message: "valor demasiado largo." }), z.number()]).nullable().optional();

/**
 * Claves camelCase de §5.4 y sus sinónimos snake_case (runbook §5.3). El servicio
 * las pliega con normalizeDeclaredStats; aquí solo se acota la forma.
 */
export const DeclaredStatsSchema = z
  .object({
    arrivalRooms: statValue,
    departureRooms: statValue,
    roomsOccupied: statValue,
    occupancyPct: statValue,
    noShowRooms: statValue,
    roomRevenue: statValue,
    totalRevenue: statValue,
    taxTotal: statValue,
    adr: statValue,
    revpar: statValue,
    transactionTotalToday: statValue,
    reservationsMadeToday: statValue,
    cancellationsMadeToday: statValue,
    arrivals: statValue,
    departures: statValue,
    rooms_occupied: statValue,
    occupancy_pct: statValue,
    no_shows: statValue,
    revenue_rooms: statValue,
    revenue_total: statValue,
    tax_total: statValue,
    reservations_made: statValue,
    cancellations: statValue,
    transaction_total_today: statValue
  })
  .strict({ message: "declared: métrica no admitida." });
export type DeclaredStatsInput = z.infer<typeof DeclaredStatsSchema>;

/** `reconciliation` del importador de ingresos (L2): Trial Balance / Manager Report del mismo día. */
export const RevenueReconciliationSchema = z
  .object({
    transactionTotalToday: z.string().trim().max(40).nullable().optional(),
    roomRevenue: z.string().trim().max(40).nullable().optional(),
    totalRevenue: z.string().trim().max(40).nullable().optional()
  })
  .strict({ message: "reconciliation: clave no admitida." });

// ── POST /integrations/pms-shadow/ingest ─────────────────────────────────────

export const PMS_SHADOW_INGEST_FEEDS = [...PMS_SHADOW_FEEDS, "auto"] as const;

const ingestShape = {
  feed: z.enum(PMS_SHADOW_INGEST_FEEDS, { errorMap: () => ({ message: `feed debe ser uno de: ${PMS_SHADOW_INGEST_FEEDS.join(", ")}.` }) }).default("auto"),
  businessDate: isoDate("businessDate").optional(),
  fileName,
  contentBase64,
  force: flag("force").default(false),
  horizonDays: z.coerce
    .number({ invalid_type_error: `horizonDays debe ser un entero entre 1 y ${RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS}.` })
    .int({ message: `horizonDays debe ser un entero entre 1 y ${RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS}.` })
    .min(1, { message: `horizonDays debe ser un entero entre 1 y ${RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS}.` })
    .max(RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS, { message: `horizonDays debe ser un entero entre 1 y ${RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS}.` })
    .optional(),
  declared: DeclaredStatsSchema.nullable().optional(),
  reconciliation: RevenueReconciliationSchema.nullable().optional()
};

export const IngestSchema = z
  .object({
    propertyId: z.string({ invalid_type_error: "propertyId debe ser un texto." }).trim().min(1, { message: "propertyId es obligatorio." }).max(64, { message: "propertyId no puede superar 64 caracteres." }),
    ...ingestShape
  })
  .strict(STRICT);
export type IngestInput = z.infer<typeof IngestSchema>;

/** `POST /properties/:propertyId/pms-shadow/runs`: el mismo cuerpo sin propertyId (va en la ruta). */
export const ManualRunSchema = z.object(ingestShape).strict(STRICT);
export type ManualRunInput = z.infer<typeof ManualRunSchema>;

// ── Perfil ───────────────────────────────────────────────────────────────────

const dictionary = (name: string) =>
  z
    .record(z.string().trim().min(1, { message: `${name}: la clave no puede estar vacía.` }).max(80, { message: `${name}: la clave no puede superar 80 caracteres.` }), z.string().trim().max(80, { message: `${name}: el valor no puede superar 80 caracteres.` }), {
      invalid_type_error: `${name} debe ser un objeto código OPERA → código Anfitorio.`
    })
    .refine((value) => Object.keys(value).length <= PMS_SHADOW_MAX_DICTIONARY_KEYS, { message: `${name} no puede tener más de ${PMS_SHADOW_MAX_DICTIONARY_KEYS} entradas.` });

export const PropertyMappingSchema = z
  .object({
    roomTypes: dictionary("roomTypes").optional(),
    rateCodes: dictionary("rateCodes").optional(),
    marketCodes: dictionary("marketCodes").optional(),
    sourceCodes: dictionary("sourceCodes").optional(),
    paymentTypes: dictionary("paymentTypes").optional(),
    pseudoRoomTypes: z.array(z.string().trim().min(1).max(20)).max(100, { message: "pseudoRoomTypes no puede tener más de 100 entradas." }).optional()
  })
  .strict({ message: "mappingJson: clave no admitida." });

export const TrxCodeMappingSchema = z
  .object({
    code: z.string({ invalid_type_error: "trxMappingJson: code debe ser un texto." }).trim().min(1, { message: "trxMappingJson: code es obligatorio." }).max(40, { message: "trxMappingJson: code no puede superar 40 caracteres." }),
    description: z.string().trim().max(200, { message: "trxMappingJson: description no puede superar 200 caracteres." }).optional(),
    transactionType: z.string().trim().max(40).optional(),
    kind: z.enum(PMS_SHADOW_TRX_KINDS, { errorMap: () => ({ message: `trxMappingJson: kind debe ser uno de: ${PMS_SHADOW_TRX_KINDS.join(", ")}.` }) }),
    accountCode: z.string().trim().max(20, { message: "trxMappingJson: accountCode no puede superar 20 caracteres." }).optional(),
    usaliDepartment: z.enum(PMS_SHADOW_USALI_REVENUE_DEPARTMENTS, { errorMap: () => ({ message: `trxMappingJson: usaliDepartment debe ser uno de: ${PMS_SHADOW_USALI_REVENUE_DEPARTMENTS.join(", ")}.` }) }).optional(),
    taxRateCode: z.string().trim().max(20).optional()
  })
  .strict({ message: "trxMappingJson: clave no admitida." });

export const ScheduleFeedSchema = z
  .object({
    feed: z.enum(PMS_SHADOW_FEEDS, { errorMap: () => ({ message: `scheduleJson: feed debe ser uno de: ${PMS_SHADOW_FEEDS.join(", ")}.` }) }),
    expectedTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "scheduleJson: expectedTime debe ser HH:mm (hora local del hotel)." }),
    businessDateOffset: z.union([z.literal(-1), z.literal(0)], { errorMap: () => ({ message: "scheduleJson: businessDateOffset debe ser -1 o 0." }) }),
    required: z.boolean({ invalid_type_error: "scheduleJson: required debe ser true o false." })
  })
  .strict({ message: "scheduleJson: clave no admitida en un feed." });

export const ScheduleSchema = z
  .object({
    feeds: z.array(ScheduleFeedSchema).max(PMS_SHADOW_MAX_SCHEDULE_FEEDS, { message: `scheduleJson no puede tener más de ${PMS_SHADOW_MAX_SCHEDULE_FEEDS} feeds.` })
  })
  .strict({ message: "scheduleJson: clave no admitida." });

export const ProfileUpsertSchema = z
  .object({
    operaHotelCode: z
      .string({ invalid_type_error: "operaHotelCode debe ser un texto." })
      .trim()
      .min(1, { message: "operaHotelCode es obligatorio (Hotel Code de OPERA)." })
      .max(PMS_SHADOW_MAX_OPERA_HOTEL_CODE, { message: `operaHotelCode no puede superar ${PMS_SHADOW_MAX_OPERA_HOTEL_CODE} caracteres.` }),
    status: z.enum(PMS_SHADOW_PROFILE_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${PMS_SHADOW_PROFILE_STATUSES.join(", ")}.` }) }).optional(),
    mappingJson: PropertyMappingSchema.optional(),
    trxMappingJson: z.array(TrxCodeMappingSchema).max(PMS_SHADOW_MAX_TRX_MAPPINGS, { message: `trxMappingJson no puede tener más de ${PMS_SHADOW_MAX_TRX_MAPPINGS} entradas.` }).optional(),
    scheduleJson: ScheduleSchema.optional(),
    inboxEmail: z.string().trim().email({ message: "inboxEmail debe ser una dirección de correo válida." }).max(200).nullable().optional(),
    sftpFolder: z.string().trim().max(PMS_SHADOW_MAX_SFTP_FOLDER, { message: `sftpFolder no puede superar ${PMS_SHADOW_MAX_SFTP_FOLDER} caracteres.` }).nullable().optional()
  })
  .strict(STRICT);
export type ProfileUpsertInput = z.infer<typeof ProfileUpsertSchema>;

// ── Consultas ────────────────────────────────────────────────────────────────

export const RunsQuerySchema = z
  .object({
    feed: z.enum(PMS_SHADOW_FEEDS, { errorMap: () => ({ message: `feed debe ser uno de: ${PMS_SHADOW_FEEDS.join(", ")}.` }) }).optional(),
    status: z.enum(PMS_SHADOW_RUN_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${PMS_SHADOW_RUN_STATUSES.join(", ")}.` }) }).optional(),
    businessDate: isoDate("businessDate").optional(),
    limit: limitQuery
  })
  .strict(STRICT_QUERY);
export type RunsQueryInput = z.infer<typeof RunsQuerySchema>;

const queryBoolean = (name: string) =>
  z
    .enum(["true", "false"], { errorMap: () => ({ message: `${name} debe ser true o false.` }) })
    .transform((value) => value === "true")
    .optional();

export const AlertsQuerySchema = z
  .object({
    open: queryBoolean("open"),
    code: z.enum(PMS_SHADOW_ALERT_CODES, { errorMap: () => ({ message: `code debe ser uno de: ${PMS_SHADOW_ALERT_CODES.join(", ")}.` }) }).optional(),
    businessDate: isoDate("businessDate").optional(),
    limit: limitQuery
  })
  .strict(STRICT_QUERY);
export type AlertsQueryInput = z.infer<typeof AlertsQuerySchema>;

export const ResolveAlertSchema = z
  .object({
    note: z
      .string({ invalid_type_error: "note debe ser un texto." })
      .trim()
      .min(1, { message: "note es obligatoria: indica el motivo de la resolución." })
      .max(PMS_SHADOW_MAX_NOTE, { message: `note no puede superar ${PMS_SHADOW_MAX_NOTE} caracteres.` })
  })
  .strict(STRICT);
export type ResolveAlertInput = z.infer<typeof ResolveAlertSchema>;

export const ReconciliationQuerySchema = z
  .object({
    businessDate: isoDate("businessDate")
  })
  .strict(STRICT_QUERY);
export type ReconciliationQueryInput = z.infer<typeof ReconciliationQuerySchema>;

// ── Ingresos diarios (cuerpos alineados con revenue-import.service.ts de L2) ──

export const PMS_SHADOW_REVENUE_SOURCE_INPUTS = [...PMS_SHADOW_REVENUE_SOURCES, "auto"] as const;

const revenueFileShape = {
  source: z.enum(PMS_SHADOW_REVENUE_SOURCE_INPUTS, { errorMap: () => ({ message: `source debe ser uno de: ${PMS_SHADOW_REVENUE_SOURCE_INPUTS.join(", ")}.` }) }).optional(),
  fileName: fileName.optional(),
  content: content.optional(),
  contentBase64: contentBase64.optional(),
  businessDate: isoDate("businessDate").nullable().optional(),
  includePayments: flag("includePayments").optional(),
  force: flag("force").optional(),
  mapping: z.array(TrxCodeMappingSchema).max(PMS_SHADOW_MAX_TRX_MAPPINGS, { message: `mapping no puede tener más de ${PMS_SHADOW_MAX_TRX_MAPPINGS} entradas.` }).nullable().optional(),
  reconciliation: RevenueReconciliationSchema.nullable().optional()
};

const contentXor = (value: { content?: string | undefined; contentBase64?: string | undefined }): boolean => (value.content !== undefined) !== (value.contentBase64 !== undefined);

export const RevenuePreviewSchema = z
  .object({ ...revenueFileShape, post: flag("post").optional(), replace: flag("replace").optional() })
  .strict(STRICT)
  .refine(contentXor, { message: CONTENT_XOR_MESSAGE, path: ["content"] });
export type RevenuePreviewInput = z.infer<typeof RevenuePreviewSchema>;

export const RevenueImportSchema = z
  .object({ ...revenueFileShape, post: flag("post").default(true), replace: flag("replace").default(false) })
  .strict(STRICT)
  .refine(contentXor, { message: CONTENT_XOR_MESSAGE, path: ["content"] });
export type RevenueImportInput = z.infer<typeof RevenueImportSchema>;

export const RevenueReverseSchema = z
  .object({
    reason: z
      .string({ invalid_type_error: "reason debe ser un texto." })
      .trim()
      .min(1, { message: "reason es obligatorio: indica el motivo del reverso." })
      .max(PMS_SHADOW_MAX_REASON, { message: `reason no puede superar ${PMS_SHADOW_MAX_REASON} caracteres.` }),
    entryDate: isoDate("entryDate").nullable().optional()
  })
  .strict(STRICT);
export type RevenueReverseInput = z.infer<typeof RevenueReverseSchema>;

export const RevenueListQuerySchema = z
  .object({
    businessDate: isoDate("businessDate").optional(),
    from: isoDate("from").optional(),
    to: isoDate("to").optional(),
    status: z.enum(PMS_SHADOW_REVENUE_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${PMS_SHADOW_REVENUE_STATUSES.join(", ")}.` }) }).optional(),
    limit: limitQuery
  })
  .strict(STRICT_QUERY);
export type RevenueListQueryInput = z.infer<typeof RevenueListQuerySchema>;
