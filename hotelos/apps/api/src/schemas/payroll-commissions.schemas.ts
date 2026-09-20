// Zod schemas of the legacy payroll-contract and commission-rule writers
// (Finanzas 2026-09-16, fix t6#11 · integrador).
//
// POST /payroll/contracts and POST /commissions/rules took `request.body`
// at face value: `{ grossSalary: "abc" }` reached contracts.service, which
// threw a plain Error (500), `Number("abc")` fed a NaN to Prisma, unknown
// keys were silently dropped and a `staffProfileId` that does not exist was
// stored as an orphan contract. Every schema here is `.strict()` with Spanish
// messages so the caller learns which key was refused (400 through
// lib/validate.ts parse → BadRequestError), like the finance modules do.
//
// Money and percentages travel as a finite number or a numeric string with
// up to two decimals ("1800", "1800.50", "15,5"). The schemas keep the raw
// `number | string` (lib/validate.ts `parse<T>(schema: ZodSchema<T>)` unifies
// input and output types, so a transform there would widen T); the handler
// converts with `decimalInputToNumber` where the service wants a number
// (contracts.service) and passes the raw value where it accepts both
// (commission-rules.service parseRatePct).

import { z } from "zod";

const STRICT_BODY = { message: "Campo no admitido en el cuerpo de la petición." };

/** Spanish contract modalities (RDL 32/2021): the four the front offers plus fijo discontinuo and sustitución. */
export const PAYROLL_CONTRACT_TYPES = ["indefinido", "temporal", "fijo_discontinuo", "practicas", "formacion", "sustitucion"] as const;
export const PAYROLL_PAY_FREQUENCIES = ["monthly", "biweekly", "weekly"] as const;
export const COMMISSION_APPLIES_TO = ["gross_revenue", "net_revenue", "total"] as const;

const DECIMAL_STRING = /^-?\d+([.,]\d{1,2})?$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DAY_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const ACCOUNT_CODE = /^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/;

/** "1800,50" | "1800.50" | 1800.5 → 1800.5 (only for values that passed `decimalInput`). */
export function decimalInputToNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value.trim().replace(",", "."));
}

/** A finite number or a numeric string with up to two decimals (kept as received, see the header). */
function decimalInput(label: string) {
  return z.custom<number | string>(
    (value) =>
      (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && DECIMAL_STRING.test(value.trim())),
    { message: `${label} debe ser un número con hasta dos decimales.` }
  );
}

function isoDay(label: string) {
  return z
    .string({ required_error: `${label} es obligatoria.`, invalid_type_error: `${label} debe ser una fecha YYYY-MM-DD.` })
    .regex(ISO_DAY, { message: `${label} debe ser una fecha YYYY-MM-DD.` })
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { message: `${label} no es una fecha válida.` });
}

function isoDayOrDateTime(label: string) {
  return z
    .string({ invalid_type_error: `${label} debe ser una fecha ISO (YYYY-MM-DD).` })
    .regex(ISO_DAY_OR_DATETIME, { message: `${label} debe ser una fecha ISO (YYYY-MM-DD).` })
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: `${label} no es una fecha válida.` });
}

const requiredId = (label: string) =>
  z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} es obligatorio.` })
    .max(64, { message: `${label} no puede superar 64 caracteres.` });

const optionalId = (label: string) =>
  z
    .string({ invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} no puede estar vacío.` })
    .max(64, { message: `${label} no puede superar 64 caracteres.` })
    .optional();

// ── POST /payroll/contracts ─────────────────────────────────────────────────

export const CreatePayrollContractSchema = z
  .object({
    staffProfileId: requiredId("staffProfileId"),
    propertyId: optionalId("propertyId"),
    contractType: z.enum(PAYROLL_CONTRACT_TYPES, {
      errorMap: () => ({ message: `contractType debe ser uno de: ${PAYROLL_CONTRACT_TYPES.join(", ")}.` })
    }),
    startDate: isoDay("startDate"),
    endDate: isoDay("endDate").optional(),
    grossSalary: decimalInput("grossSalary").refine((value) => decimalInputToNumber(value) >= 0, {
      message: "grossSalary debe ser mayor o igual que 0."
    }),
    payFrequency: z
      .enum(PAYROLL_PAY_FREQUENCIES, { errorMap: () => ({ message: `payFrequency debe ser uno de: ${PAYROLL_PAY_FREQUENCIES.join(", ")}.` }) })
      .optional(),
    payCount: z
      .number({ invalid_type_error: "payCount debe ser un entero entre 12 y 16 (pagas anuales)." })
      .int({ message: "payCount debe ser un entero entre 12 y 16 (pagas anuales)." })
      .min(12, { message: "payCount debe ser un entero entre 12 y 16 (pagas anuales)." })
      .max(16, { message: "payCount debe ser un entero entre 12 y 16 (pagas anuales)." })
      .optional(),
    irpfRatePct: decimalInput("irpfRatePct")
      .refine(
        (value) => {
          const pct = decimalInputToNumber(value);
          return pct >= 0 && pct <= 100;
        },
        { message: "irpfRatePct debe estar entre 0 y 100." }
      )
      .optional(),
    socialSecurityCategory: z
      .string({ invalid_type_error: "socialSecurityCategory debe ser un texto." })
      .trim()
      .min(1, { message: "socialSecurityCategory no puede estar vacío." })
      .max(80, { message: "socialSecurityCategory no puede superar 80 caracteres." })
      .optional(),
    costCenterId: optionalId("costCenterId"),
    // Tanda RRHH (RRHH-2, design §4 «EmploymentContract»): convenio del contrato (prevalece
    // sobre el del centro), jornada semanal, % de jornada (100 = completa), fijo discontinuo
    // y grupo de cotización 1-11. `payCount` ausente → 12 + extra_pay_count del convenio.
    agreementId: optionalId("agreementId"),
    weeklyHours: decimalInput("weeklyHours")
      .refine(
        (value) => {
          const hours = decimalInputToNumber(value);
          return hours > 0 && hours <= 60;
        },
        { message: "weeklyHours debe estar entre 0 y 60 horas." }
      )
      .optional(),
    partTimePct: decimalInput("partTimePct")
      .refine(
        (value) => {
          const pct = decimalInputToNumber(value);
          return pct > 0 && pct <= 100;
        },
        { message: "partTimePct debe estar entre 0 y 100." }
      )
      .optional(),
    fixedDiscontinuous: z.boolean({ invalid_type_error: "fixedDiscontinuous debe ser verdadero o falso." }).optional(),
    contributionGroup: z
      .number({ invalid_type_error: "contributionGroup debe ser un entero entre 1 y 11 (grupo de cotización)." })
      .int({ message: "contributionGroup debe ser un entero entre 1 y 11 (grupo de cotización)." })
      .min(1, { message: "contributionGroup debe ser un entero entre 1 y 11 (grupo de cotización)." })
      .max(11, { message: "contributionGroup debe ser un entero entre 1 y 11 (grupo de cotización)." })
      .optional()
  })
  .strict(STRICT_BODY)
  .superRefine((body, ctx) => {
    if (body.endDate !== undefined && body.endDate < body.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "endDate debe ser igual o posterior a startDate." });
    }
  });

export type CreatePayrollContractInput = z.infer<typeof CreatePayrollContractSchema>;

/** GET /payroll/contracts and GET /payroll/periods: optional tenant filters (unknown query keys are ignored). */
export const PayrollListQuerySchema = z.object({
  organizationId: optionalId("organizationId"),
  propertyId: optionalId("propertyId")
});

// ── POST /commissions/rules ─────────────────────────────────────────────────

export const CreateCommissionRuleSchema = z
  .object({
    propertyId: requiredId("propertyId"),
    channelId: optionalId("channelId").nullable(),
    channelCode: z
      .string({ invalid_type_error: "channelCode debe ser un texto." })
      .trim()
      .min(1, { message: "channelCode no puede estar vacío." })
      .max(64, { message: "channelCode no puede superar 64 caracteres." })
      .regex(/^[a-z0-9][a-z0-9_.-]*$/i, { message: "channelCode solo admite letras, números, punto, guion y guion bajo." })
      .transform((value) => value.toLowerCase())
      .optional()
      .nullable(),
    ratePct: decimalInput("ratePct").refine(
      (value) => {
        const pct = decimalInputToNumber(value);
        return pct > 0 && pct <= 100;
      },
      { message: "ratePct debe estar entre 0 y 100." }
    ),
    appliesTo: z
      .enum(COMMISSION_APPLIES_TO, { errorMap: () => ({ message: "appliesTo debe ser gross_revenue, net_revenue o total." }) })
      .optional(),
    ledgerAccountCode: z
      .string({ invalid_type_error: "ledgerAccountCode debe ser un código de cuenta PGC." })
      .trim()
      .regex(ACCOUNT_CODE, { message: "ledgerAccountCode debe ser un código de cuenta PGC (p. ej. 629.1)." })
      .optional(),
    effectiveFrom: isoDayOrDateTime("effectiveFrom").optional().nullable(),
    effectiveTo: isoDayOrDateTime("effectiveTo").optional().nullable()
  })
  .strict(STRICT_BODY)
  .superRefine((body, ctx) => {
    if (!body.channelId && !body.channelCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["channelCode"], message: "Indica channelId o channelCode." });
    }
    if (body.effectiveFrom && body.effectiveTo && Date.parse(body.effectiveTo) < Date.parse(body.effectiveFrom)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo debe ser igual o posterior a effectiveFrom." });
    }
  });

export type CreateCommissionRuleInput = z.infer<typeof CreateCommissionRuleSchema>;
