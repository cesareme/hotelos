// Esquemas zod de las rutas de importación contable desde Sage 200 (Tanda 7c · L3):
// `POST /accounting/ledger-imports/preview`, `POST /accounting/ledger-imports`,
// `GET /accounting/ledger-imports`, `GET /accounting/ledger-imports/template`,
// `GET|PUT /accounting/ledger-imports/account-map`, `GET|PUT /accounting/ledger-imports/analytics-map`,
// `POST|GET /accounting/ledger-imports/reconciliation`, `GET …/reconciliation/:id[/csv]`,
// `GET /accounting/ledger-imports/:id`, `POST …/:id/post` y `POST …/:id/reverse`.
//
// Todos los cuerpos y consultas son `.strict()` con mensajes en español: una
// clave desconocida es un 400 VALIDATION_ERROR que nombra la clave (parseOr400
// de modules/rate-manager/rate-grid.schemas.ts), nunca se descarta en silencio.
// `STRICT_BODY` se redeclara aquí (patrón payroll-cost.schemas.ts); `BASE64_PATTERN`
// y `CONTENT_XOR_MESSAGE` se reutilizan de reservation-import.schemas.ts. Los tipos
// wire y los límites viven en @hotelos/shared (ledger-import-types.ts); estos
// esquemas los validan en la frontera HTTP y exportan sus `z.infer` para las rutas
// y el CLI `sage200:import` (que valida con ellos el `--mapping <ruta.json>`).
//
// Reglas que quedan en el servicio (modules/accounting/import/*.service.ts), no aquí:
// tamaño real del fichero tras base64 (20 MiB → LEDGER_IMPORT_TOO_LARGE), filas y
// asientos máximos, formato no reconocido, cuentas sin mapear, analítica sin centro,
// cuadre, duplicado por hash, solapes, periodos cerrados, existencia y postabilidad de
// la cuenta destino (LEDGER_IMPORT_ACCOUNT_CODE_INVALID / LEDGER_IMPORT_MAP_INVALID),
// tenencia y ámbito (R11). Aquí solo se garantiza la forma: exactamente uno de
// `content` (texto: CLI y tests) o `contentBase64` (bytes: siempre desde el
// navegador), `contentBase64` ≤ 28 MiB de caracteres, `content` ≤ 20 MiB, `kind`
// de LEDGER_IMPORT_KINDS, `format` de LEDGER_IMPORT_FORMATS, `reason` 3..500,
// `limit` 1..200 y los mapas con la forma de sus DTO.
//
// `options.allowClosed` NO se admite por HTTP (solo el CLI con `--allow-closed`,
// auditado): el `.strict()` de `options` lo rechaza con 400 VALIDATION_ERROR.

import { z } from "zod";
import {
  LEDGER_ACCOUNT_MAP_ACTIONS,
  LEDGER_ANALYTICS_DIMENSIONS,
  LEDGER_IMPORT_FORMATS,
  LEDGER_IMPORT_KINDS,
  LEDGER_IMPORT_DETAIL_DEFAULT_LIMIT,
  LEDGER_IMPORT_DETAIL_MAX_LIMIT,
  LEDGER_IMPORT_LIST_DEFAULT_LIMIT,
  LEDGER_IMPORT_LIST_MAX_LIMIT,
  LEDGER_IMPORT_MAX_BASE64_CHARS,
  LEDGER_IMPORT_MAX_BYTES,
  LEDGER_IMPORT_MAX_FILE_NAME,
  LEDGER_IMPORT_MAX_SHEET_NAME,
  LEDGER_IMPORT_REVERSAL_REASON_MAX,
  LEDGER_IMPORT_REVERSAL_REASON_MIN,
  LEDGER_IMPORT_STATUSES,
  LEDGER_IMPORT_SYSTEMS,
  LEDGER_NUMBERING_DIMENSIONS,
  LEDGER_USALI_COST_CENTRE_CODES,
  isLedgerUnassignedPolicy,
  type LedgerUnassignedPolicy
} from "@hotelos/shared";
import { LEDGER_ACCOUNT_CODE_PATTERN } from "../modules/accounting/import/ledger-import.mapping.js";
import { USALI_DEPARTMENTS, USALI_LINES, type UsaliDepartment, type UsaliLine } from "../modules/accounting/chart-of-accounts.service.js";
import { BASE64_PATTERN, CONTENT_XOR_MESSAGE } from "./reservation-import.schemas.js";

const STRICT_BODY = { message: "Campo no admitido en el cuerpo de la petición." };

/** Mes contable "YYYY-MM" (01..12). */
export const PERIOD_CODE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Ejercicio = año natural (diseño §4.6: nunca un `code` distinto de "YYYY"). */
export const FISCAL_YEAR_CODE = /^\d{4}$/;

/** Máximo de filas del mapa de cuentas enviado con la preview / el lote o con PUT account-map. */
export const LEDGER_ACCOUNT_MAP_MAX_ENTRIES = 20_000;
/** Máximo de filas del mapa analítico. */
export const LEDGER_ANALYTICS_MAP_MAX_ENTRIES = 5_000;
/** Longitud máxima de un código Sage (cuenta o código analítico). */
export const LEDGER_SOURCE_CODE_MAX = 32;
/** Longitud máxima de `notes` del lote (patrón del lote de nómina). */
export const LEDGER_IMPORT_NOTES_MAX = 2000;

/** Claves del catálogo USALI (chart-of-accounts.service.ts) admitidas en `usaliDepartment` / `usaliLine` de una fila `create`. */
export const USALI_DEPARTMENT_KEYS = Object.keys(USALI_DEPARTMENTS) as [UsaliDepartment, ...UsaliDepartment[]];
export const USALI_LINE_KEYS = Object.keys(USALI_LINES) as [UsaliLine, ...UsaliLine[]];

/** "1.234.567" sin depender de ICU (mensajes de límite). */
function groupEs(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function flag(name: string) {
  return z.boolean({ invalid_type_error: `${name} debe ser true o false.` });
}

function isoDay(label: string) {
  return z
    .string({ required_error: `${label} es obligatoria.`, invalid_type_error: `${label} debe ser una fecha YYYY-MM-DD.` })
    .trim()
    .regex(ISO_DAY, { message: `${label} debe ser una fecha YYYY-MM-DD.` })
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, { message: `${label} no es una fecha válida.` });
}

function periodCode(label: string) {
  return z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un mes YYYY-MM.` })
    .trim()
    .regex(PERIOD_CODE, { message: `${label} debe ser un mes YYYY-MM.` });
}

const optionalId = (label: string) =>
  z
    .string({ invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} no puede estar vacío.` })
    .max(64, { message: `${label} no puede superar 64 caracteres.` })
    .optional();

const sourceCode = (label: string) =>
  z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} no puede estar vacío.` })
    .max(LEDGER_SOURCE_CODE_MAX, { message: `${label} no puede superar ${LEDGER_SOURCE_CODE_MAX} caracteres.` });

const sourceName = z
  .string({ invalid_type_error: "sourceName debe ser un texto." })
  .trim()
  .max(200, { message: "sourceName no puede superar 200 caracteres." })
  .nullable()
  .optional();

const limit = z.coerce
  .number({ invalid_type_error: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_LIST_MAX_LIMIT}.` })
  .int({ message: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_LIST_MAX_LIMIT}.` })
  .min(1, { message: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_LIST_MAX_LIMIT}.` })
  .max(LEDGER_IMPORT_LIST_MAX_LIMIT, { message: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_LIST_MAX_LIMIT}.` })
  .default(LEDGER_IMPORT_LIST_DEFAULT_LIMIT);

const kind = z.enum(LEDGER_IMPORT_KINDS, { errorMap: () => ({ message: `kind debe ser uno de: ${LEDGER_IMPORT_KINDS.join(", ")}.` }) });
const format = z.enum(LEDGER_IMPORT_FORMATS, { errorMap: () => ({ message: `format debe ser uno de: ${LEDGER_IMPORT_FORMATS.join(", ")}.` }) });
const system = z.enum(LEDGER_IMPORT_SYSTEMS, { errorMap: () => ({ message: `system debe ser uno de: ${LEDGER_IMPORT_SYSTEMS.join(", ")}.` }) });
const dimension = z.enum(LEDGER_ANALYTICS_DIMENSIONS, { errorMap: () => ({ message: `dimension debe ser una de: ${LEDGER_ANALYTICS_DIMENSIONS.join(", ")}.` }) });

/** `block` · `office` · `property:<propertyId>` (isLedgerUnassignedPolicy de @hotelos/shared). */
export const UnassignedPolicySchema = z
  .string({ invalid_type_error: "unassignedPolicy debe ser block, office o property:<propertyId>." })
  .trim()
  .max(80, { message: "unassignedPolicy no puede superar 80 caracteres." })
  .refine((value): value is LedgerUnassignedPolicy => isLedgerUnassignedPolicy(value), { message: "unassignedPolicy debe ser block, office o property:<propertyId>." });

const fileName = z
  .string({ invalid_type_error: "fileName debe ser un texto." })
  .trim()
  .min(1, { message: "fileName no puede estar vacío." })
  .max(LEDGER_IMPORT_MAX_FILE_NAME, { message: `fileName no puede superar ${LEDGER_IMPORT_MAX_FILE_NAME} caracteres.` });

const sheetName = z
  .string({ invalid_type_error: "sheetName debe ser un texto." })
  .trim()
  .min(1, { message: "sheetName no puede estar vacío." })
  .max(LEDGER_IMPORT_MAX_SHEET_NAME, { message: `sheetName no puede superar ${LEDGER_IMPORT_MAX_SHEET_NAME} caracteres.` });

const content = z
  .string({ invalid_type_error: "content debe ser el texto del fichero." })
  .min(1, { message: "content no puede estar vacío." })
  .max(LEDGER_IMPORT_MAX_BYTES, { message: `content no puede superar ${groupEs(LEDGER_IMPORT_MAX_BYTES)} caracteres (20 MB): usa contentBase64, trocea por meses o usa el CLI sage200:import.` });

const contentBase64 = z
  .string({ invalid_type_error: "contentBase64 debe ser el fichero en base64." })
  .min(1, { message: "contentBase64 no puede estar vacío." })
  .max(LEDGER_IMPORT_MAX_BASE64_CHARS, { message: `contentBase64 no puede superar ${groupEs(LEDGER_IMPORT_MAX_BASE64_CHARS)} caracteres (fichero de 20 MB): trocea por meses o usa el CLI sage200:import.` })
  .regex(BASE64_PATTERN, { message: "contentBase64 debe ser base64 (A-Z, a-z, 0-9, +, /, =)." });

const contentXor = (value: { content?: string | undefined; contentBase64?: string | undefined }): boolean => (value.content !== undefined) !== (value.contentBase64 !== undefined);

// ── Mapa de cuentas (filas LedgerAccountMapDto) ─────────────────────────────

export const AccountMapEntrySchema = z
  .object({
    sourceAccount: sourceCode("sourceAccount"),
    sourceName,
    action: z.enum(LEDGER_ACCOUNT_MAP_ACTIONS, { errorMap: () => ({ message: `action debe ser una de: ${LEDGER_ACCOUNT_MAP_ACTIONS.join(", ")}.` }) }),
    accountCode: z
      .string({ required_error: "accountCode es obligatorio (null solo en block).", invalid_type_error: "accountCode debe ser un texto o null." })
      .trim()
      .regex(LEDGER_ACCOUNT_CODE_PATTERN, { message: "accountCode debe ser una cuenta PGC: 1 a 8 dígitos sin cero inicial y sufijo opcional .ddd (por ejemplo 477.21)." })
      .nullable(),
    usaliDepartment: z.enum(USALI_DEPARTMENT_KEYS, { errorMap: () => ({ message: `usaliDepartment debe ser un departamento USALI (${USALI_DEPARTMENT_KEYS.join(", ")}).` }) }).nullable().optional(),
    usaliLine: z.enum(USALI_LINE_KEYS, { errorMap: () => ({ message: `usaliLine debe ser una línea USALI (${USALI_LINE_KEYS.join(", ")}).` }) }).nullable().optional(),
    carryCounterparty: flag("carryCounterparty").default(false),
    suggested: flag("suggested").optional(),
    lineCount: z.number({ invalid_type_error: "lineCount debe ser un entero." }).int({ message: "lineCount debe ser un entero." }).min(0, { message: "lineCount no puede ser negativo." }).optional()
  })
  .strict(STRICT_BODY);
export type AccountMapEntryInput = z.infer<typeof AccountMapEntrySchema>;

const accountMapEntries = z
  .array(AccountMapEntrySchema, { invalid_type_error: "entries debe ser una lista de filas del mapa de cuentas." })
  .max(LEDGER_ACCOUNT_MAP_MAX_ENTRIES, { message: `entries no puede tener más de ${groupEs(LEDGER_ACCOUNT_MAP_MAX_ENTRIES)} filas.` });

// ── Mapa analítico (filas LedgerAnalyticsMapDto + configuración) ────────────

export const AnalyticsMapEntrySchema = z
  .object({
    dimension,
    sourceCode: sourceCode("sourceCode"),
    sourceName,
    propertyId: z.string({ invalid_type_error: "propertyId debe ser un texto o null." }).trim().min(1, { message: "propertyId no puede estar vacío." }).max(64, { message: "propertyId no puede superar 64 caracteres." }).nullable(),
    costCentreCode: z.enum(LEDGER_USALI_COST_CENTRE_CODES, { errorMap: () => ({ message: `costCentreCode debe ser uno de: ${LEDGER_USALI_COST_CENTRE_CODES.join(", ")}.` }) }).nullable(),
    suggested: flag("suggested").optional()
  })
  .strict(STRICT_BODY);
export type AnalyticsMapEntryInput = z.infer<typeof AnalyticsMapEntrySchema>;

const analyticsMapEntries = z
  .array(AnalyticsMapEntrySchema, { invalid_type_error: "entries debe ser una lista de filas del mapa analítico." })
  .max(LEDGER_ANALYTICS_MAP_MAX_ENTRIES, { message: `entries no puede tener más de ${groupEs(LEDGER_ANALYTICS_MAP_MAX_ENTRIES)} filas.` });

const analyticsShape = {
  centreDimension: dimension,
  costCentreDimension: dimension.nullable().optional(),
  unassignedPolicy: UnassignedPolicySchema,
  entries: analyticsMapEntries
};

/** `mapping.analytics` de la preview / el lote (LedgerAnalyticsMappingInput). */
export const AnalyticsMappingSchema = z.object(analyticsShape).strict(STRICT_BODY);
export type AnalyticsMappingInput = z.infer<typeof AnalyticsMappingSchema>;

/** `mapping` de la preview / el lote (LedgerImportMappingInput): lo que falte se toma del mapa persistido. */
export const LedgerImportMappingSchema = z
  .object({
    accounts: accountMapEntries.optional(),
    analytics: AnalyticsMappingSchema.optional()
  })
  .strict(STRICT_BODY);
export type LedgerImportMappingInputParsed = z.infer<typeof LedgerImportMappingSchema>;

// ── Opciones del lote (LedgerImportOptions sin allowClosed) ─────────────────

export const LedgerImportOptionsSchema = z
  .object({
    fiscalYearCode: z
      .string({ invalid_type_error: "fiscalYearCode debe ser el año natural (YYYY)." })
      .trim()
      .regex(FISCAL_YEAR_CODE, { message: "fiscalYearCode debe ser el año natural (por ejemplo 2026)." })
      .optional(),
    unassignedPolicy: UnassignedPolicySchema.optional(),
    replace: flag("replace").optional(),
    createSuppliers: flag("createSuppliers").optional(),
    reconcile: flag("reconcile").optional(),
    numberingDimension: z.enum(LEDGER_NUMBERING_DIMENSIONS, { errorMap: () => ({ message: `numberingDimension debe ser ${LEDGER_NUMBERING_DIMENSIONS.join(" o ")} (o null).` }) }).nullable().optional()
  })
  .strict({ message: "Campo no admitido en options (allowClosed solo se admite en el CLI con --allow-closed)." });
export type LedgerImportOptionsInput = z.infer<typeof LedgerImportOptionsSchema>;

// ── POST /accounting/ledger-imports/preview ─────────────────────────────────

const previewShape = {
  kind,
  format: format.optional(),
  fileName: fileName.optional(),
  contentBase64: contentBase64.optional(),
  content: content.optional(),
  sheetName: sheetName.optional(),
  mapping: LedgerImportMappingSchema.optional(),
  options: LedgerImportOptionsSchema.optional()
};

export const PreviewSchema = z
  .object(previewShape)
  .strict(STRICT_BODY)
  .refine(contentXor, { message: CONTENT_XOR_MESSAGE, path: ["content"] });
export type PreviewInput = z.infer<typeof PreviewSchema>;

// ── POST /accounting/ledger-imports ─────────────────────────────────────────

export const CreateSchema = z
  .object({
    ...previewShape,
    post: flag("post").default(true),
    notes: z
      .string({ invalid_type_error: "notes debe ser un texto." })
      .trim()
      .max(LEDGER_IMPORT_NOTES_MAX, { message: `notes no puede superar ${groupEs(LEDGER_IMPORT_NOTES_MAX)} caracteres.` })
      .optional()
  })
  .strict(STRICT_BODY)
  .refine(contentXor, { message: CONTENT_XOR_MESSAGE, path: ["content"] })
  // `replace` revierte los lotes anteriores en la misma transacción; con `post: false` el nuevo quedaría en
  // borrador y el diario sin los asientos. El servicio repite la guarda (CLI y tests lo llaman sin HTTP).
  .refine((body) => !(body.options?.replace === true && body.post === false), { path: ["options", "replace"], message: "replace exige post: true: un lote en borrador no sustituye lotes contabilizados; contabiliza el borrador con POST /accounting/ledger-imports/:id/post { replace: true }." });
export type CreateInput = z.infer<typeof CreateSchema>;

// ── POST /accounting/ledger-imports/:id/post ────────────────────────────────

export const PostSchema = z
  .object({
    replace: flag("replace").optional()
  })
  .strict(STRICT_BODY);
export type PostInput = z.infer<typeof PostSchema>;

// ── POST /accounting/ledger-imports/:id/reverse ─────────────────────────────

export const ReverseSchema = z
  .object({
    reason: z
      .string({ required_error: "reason es obligatorio: indica el motivo del reverso.", invalid_type_error: "reason debe ser un texto." })
      .trim()
      .min(LEDGER_IMPORT_REVERSAL_REASON_MIN, { message: `reason debe tener al menos ${LEDGER_IMPORT_REVERSAL_REASON_MIN} caracteres.` })
      .max(LEDGER_IMPORT_REVERSAL_REASON_MAX, { message: `reason no puede superar ${LEDGER_IMPORT_REVERSAL_REASON_MAX} caracteres.` })
  })
  .strict(STRICT_BODY);
export type ReverseInput = z.infer<typeof ReverseSchema>;

// ── GET /accounting/ledger-imports ──────────────────────────────────────────

export const ListQuerySchema = z
  .object({
    kind: kind.optional(),
    status: z.enum(LEDGER_IMPORT_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${LEDGER_IMPORT_STATUSES.join(", ")}.` }) }).optional(),
    from: periodCode("from").optional(),
    to: periodCode("to").optional(),
    limit
  })
  .strict(STRICT_BODY)
  .superRefine((query, ctx) => {
    if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to debe ser igual o posterior a from." });
    }
  });
export type ListQueryInput = z.infer<typeof ListQuerySchema>;

// ── GET /accounting/ledger-imports/:id (página de entradas) ─────────────────

export const DetailQuerySchema = z
  .object({
    offset: z.coerce
      .number({ invalid_type_error: "offset debe ser un entero ≥ 0." })
      .int({ message: "offset debe ser un entero ≥ 0." })
      .min(0, { message: "offset debe ser un entero ≥ 0." })
      .default(0),
    limit: z.coerce
      .number({ invalid_type_error: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_DETAIL_MAX_LIMIT}.` })
      .int({ message: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_DETAIL_MAX_LIMIT}.` })
      .min(1, { message: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_DETAIL_MAX_LIMIT}.` })
      .max(LEDGER_IMPORT_DETAIL_MAX_LIMIT, { message: `limit debe ser un entero entre 1 y ${LEDGER_IMPORT_DETAIL_MAX_LIMIT}.` })
      .default(LEDGER_IMPORT_DETAIL_DEFAULT_LIMIT)
  })
  .strict(STRICT_BODY);
export type DetailQueryInput = z.infer<typeof DetailQuerySchema>;

// ── PUT /accounting/ledger-imports/account-map ──────────────────────────────

export const AccountMapPutSchema = z
  .object({
    system: system.optional(),
    entries: accountMapEntries
  })
  .strict(STRICT_BODY);
export type AccountMapPutInput = z.infer<typeof AccountMapPutSchema>;

// ── PUT /accounting/ledger-imports/analytics-map ────────────────────────────

export const AnalyticsMapPutSchema = z
  .object({
    system: system.optional(),
    ...analyticsShape
  })
  .strict(STRICT_BODY);
export type AnalyticsMapPutInput = z.infer<typeof AnalyticsMapPutSchema>;

// ── POST /accounting/ledger-imports/reconciliation ──────────────────────────

export const ReconciliationBodySchema = z
  .object({
    from: isoDay("from"),
    to: isoDay("to"),
    propertyId: optionalId("propertyId"),
    format: format.optional(),
    contentBase64: contentBase64.optional(),
    content: content.optional(),
    sheetName: sheetName.optional(),
    importId: optionalId("importId")
  })
  .strict(STRICT_BODY)
  .refine(contentXor, { message: CONTENT_XOR_MESSAGE, path: ["content"] })
  .refine((body) => body.from <= body.to, { path: ["to"], message: "to debe ser igual o posterior a from." });
export type ReconciliationBodyInput = z.infer<typeof ReconciliationBodySchema>;

// ── GET /accounting/ledger-imports/reconciliation ───────────────────────────

export const ReconciliationListQuerySchema = z
  .object({
    from: isoDay("from").optional(),
    to: isoDay("to").optional(),
    propertyId: optionalId("propertyId"),
    limit
  })
  .strict(STRICT_BODY)
  .superRefine((query, ctx) => {
    if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to debe ser igual o posterior a from." });
    }
  });
export type ReconciliationListQueryInput = z.infer<typeof ReconciliationListQuerySchema>;

// ── GET /accounting/ledger-imports/template ─────────────────────────────────

export const TemplateQuerySchema = z
  .object({
    kind,
    format: z.literal("csv", { errorMap: () => ({ message: "format solo admite csv (la plantilla canónica es un CSV)." }) }).default("csv")
  })
  .strict(STRICT_BODY);
export type TemplateQueryInput = z.infer<typeof TemplateQuerySchema>;
