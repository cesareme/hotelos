// Zod schemas of the POS routes (tickets, cash summary, cash closures).
// Strict objects: an unknown key is a 400, never a silently ignored field on
// the money path. Messages in Spanish (they reach the client verbatim).
import { z } from "zod";

const isoDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "debe tener formato YYYY-MM-DD");
const isoDateOrDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "debe ser una fecha YYYY-MM-DD o fecha y hora ISO-8601");

export const PosTicketOpenSchema = z
  .object({
    propertyId: z.string().min(1).max(64).optional(),
    outletId: z.string().trim().min(1).max(60),
    roomNumber: z.string().trim().min(1).max(20).optional()
  })
  .strict();

export const PosLineSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(1).max(999).optional(),
    unitPrice: z.number().min(0).max(100000),
    /** Catalogue product (PosProduct.id) the line comes from; must belong to the property. */
    productId: z.string().trim().min(1).max(64).optional()
  })
  .strict();

export const PosCloseSchema = z.object({ settlement: z.enum(["room", "cash", "card"]) }).strict();

/** Tanda 8a (pos.order.void, design §4.6): catálogo de motivos de anulación de comanda (void_reason). */
export const POS_VOID_REASON_CODES = {
  order_error: "Error al tomar la comanda",
  wrong_room: "Cargo a habitación equivocada",
  duplicate: "Comanda duplicada",
  guest_complaint: "Reclamación del cliente",
  not_served: "Consumo no servido",
  other: "Otro motivo (indicar en el texto)"
} as const;
export type PosVoidReasonCode = keyof typeof POS_VOID_REASON_CODES;

const posVoidReasonCodes = Object.keys(POS_VOID_REASON_CODES) as [PosVoidReasonCode, ...PosVoidReasonCode[]];

/** Body of POST /pos/tickets/:id/void: reason code of the catalogue, optional text and supervisor PIN authorisation. */
export const PosVoidSchema = z
  .object({
    reasonCode: z.enum(posVoidReasonCodes),
    reasonText: z.string().trim().min(1).max(500).optional(),
    supervisorAuthorizationId: z.string().trim().min(1).max(64).optional()
  })
  .strict();

export const PosTicketsQuerySchema = z
  .object({
    status: z.enum(["open", "closed", "all"]).optional(),
    closedFrom: isoDateOrDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
  })
  .strict();

export const PosCashSummaryQuerySchema = z
  .object({
    from: isoDateOrDateTime.optional(),
    to: isoDateOrDateTime.optional(),
    date: isoDateOnly.optional(),
    outletId: z.string().trim().min(1).optional()
  })
  .strict();

export const CASH_METHOD_VALUES = ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"] as const;

export const CashClosureOpenSchema = z
  .object({
    /** "*" (default, recepción) or a board outlet id (`out_bar`) / Outlet row id. */
    outletId: z.string().trim().min(1).max(64).optional(),
    businessDate: isoDateOnly.optional(),
    openingFloat: z.number().min(0).max(1_000_000).optional(),
    notes: z.string().trim().max(2000).optional()
  })
  .strict();

const countedByMethodSchema = z
  .object({
    cash: z.number().min(0).max(10_000_000).optional(),
    card_terminal: z.number().min(0).max(10_000_000).optional(),
    card_online: z.number().min(0).max(10_000_000).optional(),
    bank_transfer: z.number().min(0).max(10_000_000).optional(),
    payment_link: z.number().min(0).max(10_000_000).optional(),
    other: z.number().min(0).max(10_000_000).optional()
  })
  .strict();

export const CashClosureCloseSchema = z
  .object({
    countedByMethod: countedByMethodSchema,
    counts: z
      .array(
        z
          .object({
            denomination: z.union([z.number().positive(), z.string().trim().min(1).max(12)]),
            quantity: z.number().int().min(0).max(100000)
          })
          .strict()
      )
      .max(200)
      .optional(),
    notes: z.string().trim().max(2000).optional()
  })
  .strict();

export const CashClosureApproveSchema = z.object({ notes: z.string().trim().max(2000).optional() }).strict();

export const CashClosureListQuerySchema = z
  .object({
    status: z.enum(["open", "closed", "approved"]).optional(),
    outletId: z.string().trim().min(1).max(64).optional(),
    from: isoDateOnly.optional(),
    to: isoDateOnly.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
  })
  .strict();

export type PosTicketOpenInput = z.infer<typeof PosTicketOpenSchema>;
export type PosLineInput = z.infer<typeof PosLineSchema>;
export type PosCloseInput = z.infer<typeof PosCloseSchema>;
export type PosVoidInput = z.infer<typeof PosVoidSchema>;
export type PosTicketsQuery = z.infer<typeof PosTicketsQuerySchema>;
export type CashClosureOpenInput = z.infer<typeof CashClosureOpenSchema>;
export type CashClosureCloseInput = z.infer<typeof CashClosureCloseSchema>;
export type CashClosureApproveInput = z.infer<typeof CashClosureApproveSchema>;
export type CashClosureListQuery = z.infer<typeof CashClosureListQuerySchema>;
