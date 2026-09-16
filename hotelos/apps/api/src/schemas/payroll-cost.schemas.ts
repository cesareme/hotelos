// Esquemas zod de las rutas del coste de personal importado (Tanda 6c · L3):
// `POST /payroll/cost-imports/preview`, `POST /payroll/cost-imports`,
// `GET /payroll/cost-imports`, `POST /payroll/cost-imports/:id/post`,
// `POST /payroll/cost-imports/:id/reverse` y `GET /payroll/cost-report`.
//
// Todos los cuerpos y consultas son `.strict()` con mensajes en español: una
// clave desconocida es un 400 VALIDATION_ERROR que nombra la clave (parseOr400
// de modules/rate-manager/rate-grid.schemas.ts), nunca se descarta en silencio.
// `STRICT_BODY` se redeclara aquí porque payroll-commissions.schemas.ts no lo
// exporta (diseño §5). Los tipos wire viven en @hotelos/shared
// (payroll-cost-types.ts); estos esquemas los validan en la frontera HTTP y
// exportan sus `z.infer` para las rutas y el CLI.
//
// Reglas de negocio que quedan en el servicio (cost-import.service.ts), no aquí:
// etiquetas sin mapear, duplicados, solapes, departamento USALI que no admite la
// línea `labor` (400 USALI_LINE_NOT_ADMITTED: por eso `mapping.departments`
// admite CUALQUIER departamento del catálogo USALI y no solo los siete que
// admiten `labor`), tenencia y ámbito de los centros.

import { z } from "zod";
import { PAYROLL_COST_GROUPS, PAYROLL_COST_IMPORT_FORMATS, PAYROLL_COST_IMPORT_MAX_CONTENT, PAYROLL_COST_IMPORT_SOURCES, PAYROLL_COST_REPORT_MAX_MONTHS } from "@hotelos/shared";
import { USALI_DEPARTMENTS, type UsaliDepartment } from "../modules/accounting/chart-of-accounts.service.js";

const STRICT_BODY = { message: "Campo no admitido en el cuerpo de la petición." };

/** Mes contable "YYYY-MM" (01..12). */
export const PERIOD_CODE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Estados del lote (enum Prisma PayrollCostImportStatus) admitidos como filtro del listado. */
export const PAYROLL_COST_IMPORT_STATUSES = ["draft", "posted", "reversed"] as const;

/** Claves del catálogo USALI (chart-of-accounts.service.ts), destino de `mapping.departments`. */
export const USALI_DEPARTMENT_KEYS = Object.keys(USALI_DEPARTMENTS) as [UsaliDepartment, ...UsaliDepartment[]];

function periodCode(label: string) {
  return z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un mes YYYY-MM.` })
    .trim()
    .regex(PERIOD_CODE, { message: `${label} debe ser un mes YYYY-MM.` });
}

function isoDay(label: string) {
  return z
    .string({ required_error: `${label} es obligatoria.`, invalid_type_error: `${label} debe ser una fecha YYYY-MM-DD.` })
    .trim()
    .regex(ISO_DAY, { message: `${label} debe ser una fecha YYYY-MM-DD.` })
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { message: `${label} no es una fecha válida.` });
}

const optionalId = (label: string) =>
  z
    .string({ invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} no puede estar vacío.` })
    .max(64, { message: `${label} no puede superar 64 caracteres.` })
    .optional();

/** Nº de meses inclusivos entre dos "YYYY-MM" válidos (from ≤ to → ≥ 1; from > to → ≤ 0). */
export function monthsInRange(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

// ── Mapeo (centros, departamentos, grupos) ─────────────────────────────────

const labelKey = z.string({ invalid_type_error: "La etiqueta debe ser un texto." }).min(1, { message: "La etiqueta no puede estar vacía." }).max(200, { message: "La etiqueta no puede superar 200 caracteres." });

export const PayrollCostMappingSchema = z
  .object({
    centres: z
      .record(labelKey, z.string({ invalid_type_error: "centres: cada valor debe ser el id del centro." }).trim().min(1, { message: "centres: el id del centro no puede estar vacío." }).max(64, { message: "centres: el id del centro no puede superar 64 caracteres." }), {
        invalid_type_error: "centres debe ser un objeto etiqueta → id del centro."
      })
      .optional(),
    departments: z
      .record(labelKey, z.enum(USALI_DEPARTMENT_KEYS, { errorMap: () => ({ message: `departments: cada valor debe ser un departamento USALI (${USALI_DEPARTMENT_KEYS.join(", ")}).` }) }), {
        invalid_type_error: "departments debe ser un objeto etiqueta → departamento USALI."
      })
      .optional(),
    groups: z
      .record(labelKey, z.enum(PAYROLL_COST_GROUPS, { errorMap: () => ({ message: `groups: cada valor debe ser un grupo de coste (${PAYROLL_COST_GROUPS.join(", ")}).` }) }), {
        invalid_type_error: "groups debe ser un objeto etiqueta → grupo de coste."
      })
      .optional()
  })
  .strict(STRICT_BODY);
export type PayrollCostMappingInput = z.infer<typeof PayrollCostMappingSchema>;

// ── POST /payroll/cost-imports/preview ─────────────────────────────────────

const previewShape = {
  organizationId: optionalId("organizationId"),
  format: z.enum(PAYROLL_COST_IMPORT_FORMATS, { errorMap: () => ({ message: `format debe ser uno de: ${PAYROLL_COST_IMPORT_FORMATS.join(", ")}.` }) }),
  content: z
    .string({ required_error: "content es obligatorio.", invalid_type_error: "content debe ser el texto del fichero." })
    .min(1, { message: "content no puede estar vacío." })
    .max(PAYROLL_COST_IMPORT_MAX_CONTENT, { message: `content no puede superar ${PAYROLL_COST_IMPORT_MAX_CONTENT.toLocaleString("es-ES")} caracteres: usa el CLI payroll:import-cost.` }),
  mapping: PayrollCostMappingSchema.optional(),
  replace: z.boolean({ invalid_type_error: "replace debe ser true o false." }).optional()
};

export const PreviewPayrollCostImportSchema = z.object(previewShape).strict(STRICT_BODY);
export type PreviewPayrollCostImportInput = z.infer<typeof PreviewPayrollCostImportSchema>;

// ── POST /payroll/cost-imports ─────────────────────────────────────────────

export const CreatePayrollCostImportSchema = z
  .object({
    ...previewShape,
    fileName: z
      .string({ invalid_type_error: "fileName debe ser un texto." })
      .trim()
      .min(1, { message: "fileName no puede estar vacío." })
      .max(200, { message: "fileName no puede superar 200 caracteres." })
      .optional(),
    source: z.enum(PAYROLL_COST_IMPORT_SOURCES, { errorMap: () => ({ message: `source debe ser uno de: ${PAYROLL_COST_IMPORT_SOURCES.join(", ")}.` }) }).optional(),
    post: z.boolean({ invalid_type_error: "post debe ser true o false." }).default(true),
    notes: z
      .string({ invalid_type_error: "notes debe ser un texto." })
      .trim()
      .max(2000, { message: "notes no puede superar 2000 caracteres." })
      .optional()
  })
  .strict(STRICT_BODY)
  // contable-6C-01: `replace` revierte los lotes anteriores en la misma transacción; con `post: false` el nuevo
  // quedaría en borrador y el diario sin el coste. El servicio repite la guarda (CLI y tests lo llaman sin HTTP).
  .refine((body) => !(body.replace === true && body.post === false), { path: ["replace"], message: "replace exige post: true: un lote en borrador no sustituye lotes contabilizados; contabiliza el borrador con POST /payroll/cost-imports/:id/post { replace: true }." });
export type CreatePayrollCostImportInput = z.infer<typeof CreatePayrollCostImportSchema>;

// ── POST /payroll/cost-imports/:id/post ────────────────────────────────────

export const PostPayrollCostImportSchema = z
  .object({
    replace: z.boolean({ invalid_type_error: "replace debe ser true o false." }).optional()
  })
  .strict(STRICT_BODY);
export type PostPayrollCostImportInput = z.infer<typeof PostPayrollCostImportSchema>;

// ── POST /payroll/cost-imports/:id/reverse ─────────────────────────────────

export const ReversePayrollCostImportSchema = z
  .object({
    reason: z
      .string({ required_error: "reason es obligatorio: indica el motivo del reverso.", invalid_type_error: "reason debe ser un texto." })
      .trim()
      .min(3, { message: "reason debe tener al menos 3 caracteres." })
      .max(500, { message: "reason no puede superar 500 caracteres." }),
    entryDate: isoDay("entryDate").optional()
  })
  .strict(STRICT_BODY);
export type ReversePayrollCostImportInput = z.infer<typeof ReversePayrollCostImportSchema>;

// ── GET /payroll/cost-imports ──────────────────────────────────────────────

export const PayrollCostImportListQuerySchema = z
  .object({
    organizationId: optionalId("organizationId"),
    status: z.enum(PAYROLL_COST_IMPORT_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${PAYROLL_COST_IMPORT_STATUSES.join(", ")}.` }) }).optional(),
    from: periodCode("from").optional(),
    to: periodCode("to").optional(),
    limit: z.coerce
      .number({ invalid_type_error: "limit debe ser un entero entre 1 y 200." })
      .int({ message: "limit debe ser un entero entre 1 y 200." })
      .min(1, { message: "limit debe ser un entero entre 1 y 200." })
      .max(200, { message: "limit debe ser un entero entre 1 y 200." })
      .optional()
  })
  .strict(STRICT_BODY)
  .superRefine((query, ctx) => {
    if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to debe ser igual o posterior a from." });
    }
  });
export type PayrollCostImportListQueryInput = z.infer<typeof PayrollCostImportListQuerySchema>;

// ── GET /payroll/cost-report ───────────────────────────────────────────────

export const PayrollCostReportQuerySchema = z
  .object({
    from: periodCode("from"),
    to: periodCode("to"),
    propertyId: optionalId("propertyId"),
    group: z.enum(PAYROLL_COST_GROUPS, { errorMap: () => ({ message: `group debe ser uno de: ${PAYROLL_COST_GROUPS.join(", ")}.` }) }).optional()
  })
  .strict(STRICT_BODY)
  .superRefine((query, ctx) => {
    const months = monthsInRange(query.from, query.to);
    if (months < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to debe ser igual o posterior a from." });
    } else if (months > PAYROLL_COST_REPORT_MAX_MONTHS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: `El rango no puede superar ${PAYROLL_COST_REPORT_MAX_MONTHS} meses (${months} solicitados).` });
    }
  });
export type PayrollCostReportQueryInput = z.infer<typeof PayrollCostReportQuerySchema>;
