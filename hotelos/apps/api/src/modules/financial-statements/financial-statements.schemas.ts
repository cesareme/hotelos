// zod schemas (strict, Spanish messages) of the financial-statements routes.
// parseOr400 / zodErrorMapEs are the rate-manager helpers: same 400 body
// ({ code: "VALIDATION_ERROR", issues[] }) across modules.

import { z } from "zod";
import { USALI_DEPARTMENTS, USALI_LINES } from "../accounting/chart-of-accounts.service.js";
import { isIsoDate } from "../../lib/query-dates.js";

export { parseOr400 } from "../rate-manager/rate-grid.schemas.js";

const USALI_DEPARTMENT_KEYS = Object.keys(USALI_DEPARTMENTS) as [keyof typeof USALI_DEPARTMENTS, ...Array<keyof typeof USALI_DEPARTMENTS>];
const USALI_LINE_KEYS = Object.keys(USALI_LINES) as [keyof typeof USALI_LINES, ...Array<keyof typeof USALI_LINES>];

export const isoDateSchema = z.string().refine(isIsoDate, { message: "fecha no válida (formato YYYY-MM-DD)" });

/** Exact P&L code or prefix: "6", "62", "629.1", "705.10". Balance codes are rejected (USALI maps P&L only). */
export const accountPrefixSchema = z
  .string()
  .trim()
  .regex(/^[67][0-9]{0,7}(\.[0-9]{1,4})?$/, { message: "prefijo de cuenta PGC de los grupos 6 o 7 (p. ej. 62, 629.1, 705.1)" });

export const usaliMappingUpsertSchema = z
  .object({
    accountPrefix: accountPrefixSchema,
    usaliDepartment: z.enum(USALI_DEPARTMENT_KEYS),
    usaliLine: z.enum(USALI_LINE_KEYS),
    priority: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional()
  })
  .strict();

export const usaliMappingPatchSchema = z
  .object({
    mappings: z.array(usaliMappingUpsertSchema).min(1).max(500)
  })
  .strict();

export const periodQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    propertyId: z.string().min(1).optional()
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

export const optionalPeriodQuerySchema = z
  .object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional()
  })
  .strict()
  .refine((q) => (q.from === undefined) === (q.to === undefined), { message: "from y to van juntos", path: ["from"] })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

export const downloadFormatSchema = z.enum(["json", "pdf", "xlsx", "csv"]);

export const usaliPnlQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    propertyId: z.string().min(1).optional(),
    format: downloadFormatSchema.optional()
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

/** Reparto informativo de la oficina central (CorporateAllocationMethod, legal-structure-types.ts). */
export const corporateAllocationMethodSchema = z.enum(["none", "revenue", "rooms_available", "headcount", "manual"], {
  message: "allocation debe ser none, revenue, rooms_available, headcount o manual"
});

export const usaliCompareQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    /** Comma-separated property ids; omitted → every property of the organisation. */
    propertyIds: z.string().optional(),
    /** Tanda 6b: "1" → hotels in `properties`, office/other in `corporate`, society-level entries in `unassigned`, rollup and allocation. */
    includeCorporate: z.enum(["0", "1", "true", "false"]).optional(),
    /** Allocation key of this response (overrides the stored one); only meaningful with includeCorporate. */
    allocation: corporateAllocationMethodSchema.optional()
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

/** GET /accounting/pnl/by-property. */
export const pnlByPropertyQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    allocation: corporateAllocationMethodSchema.optional()
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

/** PUT /accounting/allocation. */
export const corporateAllocationPutSchema = z
  .object({
    method: corporateAllocationMethodSchema,
    weights: z
      .array(z.object({ propertyId: z.string().min(1), weight: z.number().finite({ message: "weight debe ser un número" }) }).strict())
      .max(200)
      .optional()
  })
  .strict();

/** "2026-01-01..2026-03-31,2025-01-01..2025-03-31" (2 to 6 periods, the first is the base). */
export const usaliPeriodsQuerySchema = z
  .object({
    periods: z.string().min(1),
    propertyId: z.string().min(1).optional()
  })
  .strict();

export function parsePeriodsParam(raw: string): Array<{ from: string; to: string }> {
  return raw.split(",").map((chunk) => {
    const [from, to] = chunk.trim().split("..");
    return { from: from ?? "", to: to ?? "" };
  });
}

export const periodsListSchema = z
  .array(
    z
      .object({ from: isoDateSchema, to: isoDateSchema })
      .refine((p) => p.from <= p.to, { message: "from no puede ser posterior a to", path: ["from"] })
  )
  .min(2, { message: "indica al menos dos periodos (el primero es la base)" })
  .max(6);

export const annualAccountsQuerySchema = z
  .object({
    fiscalYearId: z.string().min(1).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    propertyId: z.string().min(1).optional(),
    format: downloadFormatSchema.optional(),
    /** "1" adds the previous period of the same length as comparative column (balance / PyG). */
    comparative: z.enum(["0", "1", "true", "false"]).optional()
  })
  .strict()
  .refine((q) => q.fiscalYearId !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: "indica fiscalYearId o el par from/to",
    path: ["from"]
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

export const snapshotKindSchema = z.enum(["balance", "pyg", "ecpn", "memoria", "usali"]);

export const snapshotCreateSchema = z
  .object({
    kind: snapshotKindSchema,
    fiscalYearId: z.string().min(1).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    propertyId: z.string().min(1).optional(),
    label: z.string().trim().min(1).max(120).optional()
  })
  .strict()
  .refine((q) => q.fiscalYearId !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: "indica fiscalYearId o el par from/to",
    path: ["from"]
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

export const snapshotListQuerySchema = z
  .object({
    kind: snapshotKindSchema.optional(),
    fiscalYearId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();

export const snapshotDownloadQuerySchema = z.object({ format: downloadFormatSchema.optional() }).strict();

export const gestoriaFormatSchema = z.enum(["csv_universal", "contaplus_diario", "a3", "vat_books_csv"]);

export const gestoriaExportCreateSchema = z
  .object({
    format: gestoriaFormatSchema,
    from: isoDateSchema,
    to: isoDateSchema,
    propertyId: z.string().min(1).optional(),
    subaccountLength: z.number().int().min(4).max(12).optional()
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "from no puede ser posterior a to", path: ["from"] });

export const gestoriaExportListQuerySchema = z
  .object({
    format: gestoriaFormatSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();
