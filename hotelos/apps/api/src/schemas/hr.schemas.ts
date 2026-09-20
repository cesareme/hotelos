// RRHH · plantilla, convenio, estándares, previsión y ausencias (Tanda RRHH · RRHH-6).
//
// Esquemas zod `.strict()` con mensajes en español de las rutas `/hr/*`
// (modules/hr/hr.routes.ts) y de `GET /payroll/incidences`
// (modules/payroll/payroll.routes.ts). Patrón: staff-profiles.routes.ts +
// payroll-commissions.schemas.ts — una clave desconocida en el cuerpo o en la
// consulta es un 400 VALIDATION_ERROR que nombra la clave (parseOr400 de
// rate-grid.schemas.ts). Los vocabularios (departamentos USALI, causas de baja,
// drivers, unidades, temporadas, tipos de ausencia…) son los `as const` de
// packages/shared/src/hr-types.ts, así que el front y el API rechazan lo mismo.
//
// Los esquemas VALIDAN forma y vocabulario; las reglas de dominio (NIF con
// letra válida, convenio ajeno, plan ya aprobado, SoD…) las aplican los
// servicios de modules/hr y responden con `details.code` ∈ HR_ERROR_CODES.
// Ningún esquema admite NIF, NAF, correo, teléfono ni IBAN en la CONSULTA:
// la PII de Employee solo viaja en el cuerpo del alta / edición y en el
// detalle (`?pii=1`) auditado.

import { z } from "zod";
import {
  ABSENCE_STATUSES,
  EMPLOYEE_GENDERS,
  EMPLOYEE_STATUSES,
  HR_AGREEMENT_RULE_KEYS,
  HR_END_REASONS,
  HR_USALI_DEPARTMENTS,
  LABOR_STANDARD_DRIVERS,
  LABOR_STANDARD_SOURCES,
  LABOR_STANDARD_UNITS,
  STAFFING_SEASONS
} from "@hotelos/shared";

export const HR_STRICT_BODY = { message: "Campo no admitido en el cuerpo de la petición." };
export const HR_STRICT_QUERY = { message: "Parámetro de consulta no admitido." };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Importe, horas o porcentaje con coma o punto y hasta tres decimales («12,5», «13.067»). */
const DECIMAL_TEXT = /^-?\d{1,10}([.,]\d{1,3})?$/;

const enumOf = <T extends readonly [string, ...string[]]>(label: string, values: T) =>
  z.enum(values, { errorMap: () => ({ message: `${label} debe ser uno de: ${values.join(", ")}.` }) });

const id = (label: string) =>
  z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} es obligatorio.` })
    .max(64, { message: `${label} no puede superar 64 caracteres.` });

const text = (label: string, max: number) =>
  z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} es obligatorio.` })
    .max(max, { message: `${label} no puede superar ${max} caracteres.` });

const isoDay = (label: string) =>
  z
    .string({ required_error: `${label} es obligatoria.`, invalid_type_error: `${label} debe ser una fecha YYYY-MM-DD.` })
    .regex(ISO_DAY, { message: `${label} debe ser una fecha YYYY-MM-DD.` })
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { message: `${label} no es una fecha válida.` });

const periodCode = (label: string) =>
  z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe tener el formato YYYY-MM.` })
    .regex(PERIOD, { message: `${label} debe tener el formato YYYY-MM.` });

/** Número finito o cadena numérica con hasta tres decimales; se entrega tal cual (el servicio normaliza con Decimal). */
const decimalInput = (label: string) =>
  z.custom<number | string>(
    (value) => (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && DECIMAL_TEXT.test(value.trim())),
    { message: `${label} debe ser un número con hasta tres decimales.` }
  );

const intInput = (label: string, min: number, max: number) =>
  z
    .number({ invalid_type_error: `${label} debe ser un entero entre ${min} y ${max}.` })
    .int({ message: `${label} debe ser un entero entre ${min} y ${max}.` })
    .min(min, { message: `${label} debe ser un entero entre ${min} y ${max}.` })
    .max(max, { message: `${label} debe ser un entero entre ${min} y ${max}.` });

/** Booleano de consulta: `1` / `true` / `0` / `false` (los query strings llegan como texto). */
const queryBoolean = (label: string) =>
  z
    .union([z.boolean(), z.enum(["1", "0", "true", "false"])], { errorMap: () => ({ message: `${label} debe ser 1, 0, true o false.` }) })
    .transform((value) => value === true || value === "1" || value === "true");

/** NIF (8 dígitos + letra), NIE (X/Y/Z + 7 dígitos + letra) o IBAN (2 letras + 2 dígitos + ≥ 11 alfanuméricos), con o sin separadores. */
const PERSONAL_IDENTIFIER = /^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|[A-Z]{2}\d{2}[A-Z0-9]{11,30})$/;
export function looksLikePersonalIdentifier(value: string): boolean {
  const compact = value.replace(/[\s.\-_/]/g, "").toUpperCase();
  return PERSONAL_IDENTIFIER.test(compact);
}

// ── Expediente (Employee) ────────────────────────────────────────────────────

export const EmployeeListQuerySchema = z
  .object({
    propertyId: id("propertyId").optional(),
    legalEntityId: id("legalEntityId").optional(),
    status: enumOf("status", EMPLOYEE_STATUSES).optional(),
    fixedDiscontinuous: queryBoolean("fixedDiscontinuous").optional(),
    /** Búsqueda por nombre, apellidos o número de empleado (nunca por NIF): un NIF / NIE / IBAN tecleado se rechaza (400) para que no viaje en la URL ni quede en los logs (corrector SEC-15). */
    search: z
      .string({ invalid_type_error: "search debe ser un texto." })
      .trim()
      .max(120, { message: "search no puede superar 120 caracteres." })
      .refine((value) => !looksLikePersonalIdentifier(value), { message: "search no admite NIF, NIE ni IBAN: busca por nombre o número de empleado." })
      .optional()
  })
  .strict(HR_STRICT_QUERY);

export const EmployeeGetQuerySchema = z
  .object({
    /** `1` descifra los campos PII que el ámbito permite (auditoría HR_PII_READ). */
    pii: queryBoolean("pii").optional()
  })
  .strict(HR_STRICT_QUERY);

const employeeFields = {
  employeeNumber: text("employeeNumber", 32).optional().nullable(),
  userId: id("userId").optional().nullable(),
  firstName: text("firstName", 120),
  lastName: text("lastName", 120),
  taxId: text("taxId", 20),
  socialSecurityNumber: text("socialSecurityNumber", 20).optional().nullable(),
  email: z.string({ invalid_type_error: "email debe ser un texto." }).trim().max(160, { message: "email no puede superar 160 caracteres." }).optional().nullable(),
  phone: text("phone", 32).optional().nullable(),
  iban: text("iban", 34).optional().nullable(),
  gender: enumOf("gender", EMPLOYEE_GENDERS).optional().nullable(),
  primaryPropertyId: id("primaryPropertyId").optional().nullable(),
  usaliDepartment: enumOf("usaliDepartment", HR_USALI_DEPARTMENTS).optional().nullable(),
  jobTitle: text("jobTitle", 120).optional().nullable(),
  /** `active` (por defecto) o `leave`; la baja va por POST …/terminate. */
  status: enumOf("status", ["active", "leave"] as const).optional().nullable(),
  hiredAt: isoDay("hiredAt")
};

export const CreateEmployeeSchema = z
  .object({
    legalEntityId: id("legalEntityId"),
    ...employeeFields
  })
  .strict(HR_STRICT_BODY);

export type CreateEmployeeBody = z.infer<typeof CreateEmployeeSchema>;

export const PatchEmployeeSchema = z
  .object({
    employeeNumber: employeeFields.employeeNumber,
    userId: employeeFields.userId,
    firstName: employeeFields.firstName.optional(),
    lastName: employeeFields.lastName.optional(),
    taxId: employeeFields.taxId.optional(),
    socialSecurityNumber: employeeFields.socialSecurityNumber,
    email: employeeFields.email,
    phone: employeeFields.phone,
    iban: employeeFields.iban,
    gender: employeeFields.gender,
    primaryPropertyId: employeeFields.primaryPropertyId,
    usaliDepartment: employeeFields.usaliDepartment,
    jobTitle: employeeFields.jobTitle,
    status: employeeFields.status,
    hiredAt: employeeFields.hiredAt.optional()
  })
  .strict(HR_STRICT_BODY)
  .refine((body) => Object.keys(body).length > 0, { message: "Indica al menos un campo que modificar." });

export type PatchEmployeeBody = z.infer<typeof PatchEmployeeSchema>;

export const TerminateEmployeeSchema = z
  .object({
    /** Fecha de baja (por defecto hoy); nunca anterior a hiredAt. */
    terminatedAt: isoDay("terminatedAt").optional().nullable(),
    reason: enumOf("reason", HR_END_REASONS).optional().nullable()
  })
  .strict(HR_STRICT_BODY);

// ── Convenios y reglas ───────────────────────────────────────────────────────

/** Reglas iniciales del convenio: valor por clave (los valores los valida el servicio: HR_AGREEMENT_RULE_INVALID). */
const agreementRuleValues = z
  .object(Object.fromEntries(HR_AGREEMENT_RULE_KEYS.map((key) => [key, z.unknown().optional()])) as Record<(typeof HR_AGREEMENT_RULE_KEYS)[number], z.ZodOptional<z.ZodUnknown>>)
  .strict({ message: `rules solo admite las claves: ${HR_AGREEMENT_RULE_KEYS.join(", ")}.` });

export const CreateAgreementSchema = z
  .object({
    code: text("code", 32),
    name: text("name", 160),
    scope: text("scope", 64).optional().nullable(),
    publishedRef: text("publishedRef", 200).optional().nullable(),
    validFrom: isoDay("validFrom"),
    validTo: isoDay("validTo").optional().nullable(),
    ultraactivity: z.boolean({ invalid_type_error: "ultraactivity debe ser verdadero o falso." }).optional(),
    rules: agreementRuleValues.optional().nullable()
  })
  .strict(HR_STRICT_BODY);

export type CreateAgreementBody = z.infer<typeof CreateAgreementSchema>;

export const AgreementRulesQuerySchema = z
  .object({
    /** Fecha de vigencia (por defecto hoy): una versión por clave. */
    asOf: isoDay("asOf").optional()
  })
  .strict(HR_STRICT_QUERY);

const agreementRuleInput = z
  .object({
    key: enumOf("key", HR_AGREEMENT_RULE_KEYS),
    value: z.unknown(),
    validFrom: isoDay("validFrom"),
    validTo: isoDay("validTo").optional().nullable()
  })
  .strict(HR_STRICT_BODY);

export const PutAgreementRulesSchema = z
  .object({
    rules: z.array(agreementRuleInput, { invalid_type_error: "rules debe ser una lista de reglas." }).min(1, { message: "Indica al menos una regla." }).max(200, { message: "rules no puede superar 200 reglas por petición." })
  })
  .strict(HR_STRICT_BODY);

// ── Estándares de dotación ───────────────────────────────────────────────────

export const StandardsQuerySchema = z
  .object({
    /** Fecha de vigencia (por defecto hoy). */
    at: isoDay("at").optional()
  })
  .strict(HR_STRICT_QUERY);

const laborStandardBand = z
  .object({
    maxOccupiedRooms: z.number({ invalid_type_error: "maxOccupiedRooms debe ser un entero o null." }).int({ message: "maxOccupiedRooms debe ser un entero." }).min(0).nullable(),
    posts: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)], { errorMap: () => ({ message: "posts debe ser [mañana, tarde, noche]." }) })
  })
  .strict({ message: "Tramo con campo no admitido (maxOccupiedRooms, posts)." });

const laborStandardInput = z
  .object({
    usaliDepartment: enumOf("usaliDepartment", HR_USALI_DEPARTMENTS),
    driver: enumOf("driver", LABOR_STANDARD_DRIVERS),
    unit: enumOf("unit", LABOR_STANDARD_UNITS),
    value: decimalInput("value"),
    bands: z.array(laborStandardBand).max(12, { message: "bands no puede superar 12 tramos." }).optional().nullable(),
    allowancePct: decimalInput("allowancePct").optional().nullable(),
    coverageFactor: decimalInput("coverageFactor").optional().nullable(),
    source: enumOf("source", LABOR_STANDARD_SOURCES).optional().nullable()
  })
  .strict(HR_STRICT_BODY);

export const PutStandardsSchema = z
  .object({
    validFrom: isoDay("validFrom").optional(),
    standards: z.array(laborStandardInput, { invalid_type_error: "standards debe ser una lista de estándares." }).min(1, { message: "Indica al menos un estándar." }).max(60, { message: "standards no puede superar 60 estándares." })
  })
  .strict(HR_STRICT_BODY);

export const ResetStandardsSchema = z
  .object({
    validFrom: isoDay("validFrom").optional()
  })
  .strict(HR_STRICT_BODY);

// ── Plantilla máxima (StaffingPlan) ──────────────────────────────────────────

export const StaffingPlansQuerySchema = z
  .object({
    year: z.coerce.number({ invalid_type_error: "year debe ser un entero entre 2000 y 2100." }).int({ message: "year debe ser un entero entre 2000 y 2100." }).min(2000, { message: "year debe ser un entero entre 2000 y 2100." }).max(2100, { message: "year debe ser un entero entre 2000 y 2100." }).optional()
  })
  .strict(HR_STRICT_QUERY);

const staffingPlanLine = z
  .object({
    usaliDepartment: enumOf("usaliDepartment", HR_USALI_DEPARTMENTS),
    maxFte: decimalInput("maxFte"),
    maxHeadcount: intInput("maxHeadcount", 0, 100000).optional().nullable(),
    budgetMonthlyCost: decimalInput("budgetMonthlyCost").optional().nullable()
  })
  .strict(HR_STRICT_BODY);

export const CreateStaffingPlanSchema = z
  .object({
    year: intInput("year", 2000, 2100),
    season: enumOf("season", STAFFING_SEASONS),
    fromMonth: intInput("fromMonth", 1, 12),
    toMonth: intInput("toMonth", 1, 12),
    lines: z.array(staffingPlanLine, { invalid_type_error: "lines debe ser una lista de departamentos." }).min(1, { message: "Indica al menos un departamento." }).max(HR_USALI_DEPARTMENTS.length, { message: `lines no puede superar ${HR_USALI_DEPARTMENTS.length} departamentos.` })
  })
  .strict(HR_STRICT_BODY);

export type CreateStaffingPlanBody = z.infer<typeof CreateStaffingPlanSchema>;

// ── Previsión, KPIs y alertas ────────────────────────────────────────────────

const forecastWindow = {
  from: isoDay("from"),
  to: isoDay("to")
};

export const LaborForecastGenerateSchema = z.object(forecastWindow).strict(HR_STRICT_BODY);
export const LaborForecastQuerySchema = z.object(forecastWindow).strict(HR_STRICT_QUERY);

export const HrKpisQuerySchema = z
  .object({
    propertyId: id("propertyId").optional(),
    period: periodCode("period").optional()
  })
  .strict(HR_STRICT_QUERY);

export const HrAlertsQuerySchema = z
  .object({
    propertyId: id("propertyId")
  })
  .strict(HR_STRICT_QUERY);

// ── Ausencias ────────────────────────────────────────────────────────────────

export const AbsenceListQuerySchema = z
  .object({
    propertyId: id("propertyId"),
    status: enumOf("status", ABSENCE_STATUSES).optional(),
    limit: z.coerce.number({ invalid_type_error: "limit debe ser un entero positivo." }).int({ message: "limit debe ser un entero positivo." }).min(1, { message: "limit debe ser un entero positivo." }).optional(),
    cursor: z.string({ invalid_type_error: "cursor debe ser un texto." }).min(1, { message: "El cursor de paginación no es válido." }).optional()
  })
  .strict(HR_STRICT_QUERY);

export const AbsenceDecideSchema = z
  .object({
    status: enumOf("status", ["approved", "rejected", "cancelled"] as const),
    note: z.string({ invalid_type_error: "note debe ser un texto." }).trim().max(500, { message: "note no puede superar 500 caracteres." }).optional()
  })
  .strict(HR_STRICT_BODY);

// ── Nómina: incidencias del mes ──────────────────────────────────────────────

export const PAYROLL_INCIDENCE_FORMATS = ["json", "csv"] as const;

export const PayrollIncidencesQuerySchema = z
  .object({
    period: periodCode("period"),
    propertyId: id("propertyId").optional(),
    format: enumOf("format", PAYROLL_INCIDENCE_FORMATS).optional()
  })
  .strict(HR_STRICT_QUERY);

export type PayrollIncidencesQuery = z.infer<typeof PayrollIncidencesQuerySchema>;
