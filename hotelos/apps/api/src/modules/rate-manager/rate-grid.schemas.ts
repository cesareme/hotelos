// Rate grid v2 · zod schemas of the wire bodies/queries (shared by the routes
// and the services, so a direct service call gets the same 400 as HTTP).
//
// Every 400 of the module is Spanish: `parseOr400` parses with `zodErrorMapEs`
// (zod's built-in messages — «Required», «Invalid input», «Unrecognized
// key(s)»… — never reach a user). Other modules can reuse the map:
// `schema.safeParse(value, { errorMap: zodErrorMapEs })`.

import { z } from "zod";
import { BadRequestError } from "../../lib/http-error.js";
import { isRealIsoDate } from "./bulk-ops.js";

export const MAX_GRID_DAYS = 366;
export const MAX_PRICE = 50_000;
export const MAX_CELLS = 5000;
export const MAX_OPS = 50;

const typeNameEs = (t: string): string => {
  switch (t) {
    case "string":
      return "texto";
    case "number":
      return "número";
    case "boolean":
      return "booleano";
    case "array":
      return "lista";
    case "object":
      return "objeto";
    case "undefined":
      return "ausente";
    case "null":
      return "nulo";
    case "nan":
      // z.coerce already converted the value: "abc" → NaN, so "texto" would lie.
      return "un valor no numérico";
    case "integer":
      return "número entero";
    case "float":
      return "número decimal";
    default:
      return t;
  }
};

/** Spanish error map for zod (v3): covers the issue codes the grid schemas can raise. */
export const zodErrorMapEs: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined") return { message: "obligatorio" };
      return { message: `se esperaba ${typeNameEs(issue.expected)} y se recibió ${typeNameEs(issue.received)}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `clave${issue.keys.length === 1 ? "" : "s"} no admitida${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.map((k) => `'${k}'`).join(", ")}` };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `valor no admitido '${String(issue.received)}'; valores válidos: ${issue.options.map(String).join(" | ")}` };
    case z.ZodIssueCode.invalid_literal:
      return { message: `valor no admitido; se esperaba ${JSON.stringify(issue.expected)}` };
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: `valor no admitido; valores válidos: ${issue.options.map(String).join(" | ")}` };
    case z.ZodIssueCode.too_small: {
      const min = Number(issue.minimum);
      if (issue.type === "string") return { message: issue.exact ? `debe tener exactamente ${min} caracteres` : `debe tener al menos ${min} caracteres` };
      if (issue.type === "array") return { message: issue.exact ? `debe contener exactamente ${min} elementos` : `debe contener al menos ${min} elementos` };
      if (issue.type === "number") return { message: issue.inclusive ? `debe ser mayor o igual que ${min}` : `debe ser mayor que ${min}` };
      return { message: `valor demasiado pequeño (mínimo ${min})` };
    }
    case z.ZodIssueCode.too_big: {
      const max = Number(issue.maximum);
      if (issue.type === "string") return { message: issue.exact ? `debe tener exactamente ${max} caracteres` : `no puede superar ${max} caracteres` };
      if (issue.type === "array") return { message: issue.exact ? `debe contener exactamente ${max} elementos` : `no puede contener más de ${max} elementos` };
      if (issue.type === "number") return { message: issue.inclusive ? `debe ser menor o igual que ${max}` : `debe ser menor que ${max}` };
      return { message: `valor demasiado grande (máximo ${max})` };
    }
    case z.ZodIssueCode.not_finite:
      return { message: "debe ser un número finito" };
    case z.ZodIssueCode.invalid_string:
      return { message: "texto con formato no válido" };
    case z.ZodIssueCode.invalid_union:
      return { message: "valor no admitido" };
    case z.ZodIssueCode.custom:
      return { message: issue.message ?? "valor no válido" };
    default:
      return { message: ctx.defaultError === "Invalid input" ? "valor no válido" : ctx.defaultError };
  }
};

export const isoDateSchema = z.string().refine(isRealIsoDate, { message: "fecha YYYY-MM-DD no válida" });

const nullableInt = z.number().int().min(0).max(365).nullable();
const priceSchema = z.number().finite().min(0).max(MAX_PRICE);

export const restrictionsPatchSchema = z
  .object({
    minLos: nullableInt.optional(),
    maxLos: nullableInt.optional(),
    minLosThrough: nullableInt.optional(),
    cta: z.boolean().nullable().optional(),
    ctd: z.boolean().nullable().optional(),
    closed: z.boolean().nullable().optional(),
    stopSell: z.boolean().nullable().optional(),
    minAdvanceDays: nullableInt.optional(),
    maxAdvanceDays: nullableInt.optional()
  })
  .strict()
  .superRefine((r, ctx) => {
    if (typeof r.minLos === "number" && typeof r.maxLos === "number" && r.minLos > r.maxLos) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minLos no puede ser mayor que maxLos", path: ["minLos"] });
    }
    if (typeof r.minAdvanceDays === "number" && typeof r.maxAdvanceDays === "number" && r.minAdvanceDays > r.maxAdvanceDays) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minAdvanceDays no puede ser mayor que maxAdvanceDays", path: ["minAdvanceDays"] });
    }
  });

const occupancyPricesSchema = z.record(z.string().min(1).max(20), priceSchema).nullable();

/**
 * Channel price overrides are NOT persisted (RateDay has no channel
 * dimension): a channel price is base × (1 + Channel.defaultMarkupPercent).
 * A patch/op that carries `channelId` (scope.channelIds) together with a
 * price field answers 400 with this message instead of silently dropping it.
 * Restrictions per channel ARE supported (RestrictionDay.channelId).
 */
export const CHANNEL_PRICE_OVERRIDE_MESSAGE =
  "los precios por canal se calculan con el markup del canal (defaultMarkupPercent); los overrides por celda y canal no están soportados todavía";

export const cellPatchSchema = z
  .object({
    ratePlanId: z.string().min(1),
    roomTypeId: z.string().min(1),
    date: isoDateSchema,
    channelId: z.string().min(1).nullable().optional(),
    price: priceSchema.nullable().optional(),
    occupancyPrices: occupancyPricesSchema.optional(),
    minPrice: priceSchema.nullable().optional(),
    maxPrice: priceSchema.nullable().optional(),
    restrictions: restrictionsPatchSchema.optional(),
    available: z.number().int().min(0).max(10_000).nullable().optional(),
    convertToManual: z.boolean().optional(),
    revertToDerived: z.boolean().optional(),
    respectManualOverrides: z.boolean().optional(),
    // Optimistic concurrency: what the editor saw (RateGridCellPatch.expected).
    expected: z
      .object({
        price: priceSchema.nullable().optional(),
        lastModifiedAt: z.string().datetime({ offset: true }).nullable().optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((c, ctx) => {
    if (typeof c.minPrice === "number" && typeof c.maxPrice === "number" && c.minPrice > c.maxPrice) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minPrice no puede ser mayor que maxPrice", path: ["minPrice"] });
    }
    if (c.convertToManual && c.revertToDerived) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "convertToManual y revertToDerived son excluyentes", path: ["convertToManual"] });
    }
    const hasPriceFields = c.price !== undefined || c.occupancyPrices !== undefined || c.minPrice !== undefined || c.maxPrice !== undefined;
    // "*" is the sentinel of the «Disponibles» row (room-level): restrictions and availability only.
    if (c.ratePlanId === "*" && (hasPriceFields || c.convertToManual || c.revertToDerived)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ratePlanId "*" solo admite restricciones y disponibilidad', path: ["ratePlanId"] });
    }
    if (c.channelId && hasPriceFields) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CHANNEL_PRICE_OVERRIDE_MESSAGE, path: ["channelId"] });
    }
  });

export const bulkScopeSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    roomTypeIds: z.array(z.string().min(1)).max(200).optional(),
    ratePlanIds: z.array(z.string().min(1)).max(200).optional(),
    channelIds: z.array(z.string().min(1)).max(50).optional()
  })
  .strict()
  .refine((s) => s.to >= s.from, { message: "to debe ser igual o posterior a from", path: ["to"] })
  // The same cap as the grid window: an op over several years would expand to
  // tens of thousands of row upserts inside one transaction.
  .refine((s) => !isRealIsoDate(s.from) || !isRealIsoDate(s.to) || spanDays(s.from, s.to) <= MAX_GRID_DAYS, {
    message: `el ámbito no puede superar ${MAX_GRID_DAYS} días`,
    path: ["to"]
  });

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Cap on the patches ONE bulk-update may carry once the ops are expanded
 * (ops × cells, plus `cells`): every patch is a row upsert inside the same
 * transaction (120 s), so an unbounded expansion ends in a timeout, not a
 * partial write. 400 with the count so the caller narrows the scope.
 */
export function assertPatchBudget(count: number, max = MAX_CELLS): void {
  if (count <= max) return;
  const error = new BadRequestError(`La petición afecta a ${count} celdas (ops expandidas + cells); el máximo por petición es ${max}: acota el ámbito (fechas, tipos o planes) o divide la operación.`);
  error.details = { code: "TOO_MANY_CELLS", count, max };
  throw error;
}

/** Body of POST …/rate-journal/:journalId/revert (RateJournalRevertRequest). */
export const revertBodySchema = z
  .object({
    force: z.boolean().optional(),
    reason: z.string().trim().max(500).optional()
  })
  .strict();

export const priceOpSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("set"), value: priceSchema }).strict(),
  z.object({ mode: z.literal("percent"), value: z.number().finite().min(-100).max(1000) }).strict(),
  z.object({ mode: z.literal("amount"), value: z.number().finite().min(-MAX_PRICE).max(MAX_PRICE) }).strict(),
  z.object({ mode: z.literal("copyFrom"), fromDate: isoDateSchema, value: z.undefined().optional() }).strict(),
  z.object({ mode: z.literal("floor"), value: priceSchema }).strict(),
  z.object({ mode: z.literal("ceiling"), value: priceSchema }).strict()
]);

export const bulkOpSchema = z
  .object({
    scope: bulkScopeSchema,
    price: priceOpSchema.optional(),
    restrictions: restrictionsPatchSchema.optional(),
    available: z.number().int().min(0).max(10_000).nullable().optional(),
    respectManualOverrides: z.boolean().optional()
  })
  .strict()
  .superRefine((op, ctx) => {
    if (op.price !== undefined && op.scope.channelIds && op.scope.channelIds.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CHANNEL_PRICE_OVERRIDE_MESSAGE, path: ["scope", "channelIds"] });
    }
  });

export const pushKindsSchema = z.array(z.enum(["rates", "availability", "restrictions"])).min(1).max(3);

export const bulkUpdateSchema = z
  .object({
    cells: z.array(cellPatchSchema).max(MAX_CELLS).optional(),
    ops: z.array(bulkOpSchema).max(MAX_OPS).optional(),
    reason: z.string().trim().min(3).max(500),
    publish: z.object({ channelIds: z.array(z.string().min(1)).min(1).max(50), kinds: pushKindsSchema.optional() }).strict().optional(),
    clientRequestId: z.string().min(8).max(128).optional()
  })
  .strict()
  .refine((b) => (b.cells?.length ?? 0) + (b.ops?.length ?? 0) > 0, { message: "cells u ops deben contener al menos un elemento", path: ["cells"] });

export const pushSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    channelIds: z.array(z.string().min(1)).min(1).max(50),
    ratePlanIds: z.array(z.string().min(1)).max(200).optional(),
    roomTypeIds: z.array(z.string().min(1)).max(200).optional(),
    kinds: pushKindsSchema.optional(),
    journalId: z.string().min(1).nullable().optional()
  })
  .strict();

const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v): string[] | undefined => {
    if (v === undefined) return undefined;
    const list = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  });

/** GET /rate-grid query (window validated separately with parseRevenueWindow). */
export const gridQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  ratePlanIds: csv,
  roomTypeIds: csv,
  channelId: z.string().min(1).optional(),
  demand: z.union([z.literal("0"), z.literal("1"), z.literal("true"), z.literal("false")]).optional()
});

export const syncStatusQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  channelIds: csv
});

export const rederiveQuerySchema = z.object({ from: z.string().optional(), to: z.string().optional() });

/** Parse or throw the repo's typed 400 with the zod issues in `details` (messages in Spanish, with the field path). */
export function parseOr400<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value, { errorMap: zodErrorMapEs });
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  const error = new BadRequestError(`${what} no válido: ${where}${first?.message ?? "error de validación"}`);
  error.details = {
    code: "VALIDATION_ERROR",
    issues: result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }))
  };
  throw error;
}
