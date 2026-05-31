// Zod schemas for folio / payment / invoice mutations.
//
// These endpoints write to the financial ledger and feed VeriFactu + TBai
// + SES Hospedajes. Strict validation here is the cheapest line of defence
// against malformed amounts and missing required fiscal fields.

import { z } from "zod";

// POST /folios/:id/lines — accept the "lines" wire shape AND the simplified
// charge body documented in the task spec. We treat the line-item form as
// canonical.
export const CreateFolioLineSchema = z.object({
  type: z.string().min(1, "required"),
  description: z.string().min(1, "required").max(500),
  quantity: z.number().positive("must be > 0"),
  unitPrice: z.number().nonnegative("must be >= 0"),
  taxCode: z.string().optional()
});

export type CreateFolioLineInput = z.infer<typeof CreateFolioLineSchema>;

// Alias matching the operator-friendly name in the task spec. We expose both
// names because the wire path is /folios/:id/lines but conceptually it is
// "create a charge on the folio".
export const CreateChargeSchema = z.object({
  folioId: z.string().min(1).optional(),
  description: z.string().min(1).max(500),
  amount: z.number().positive("amount must be > 0").optional(),
  quantity: z.number().positive().optional(),
  unitPrice: z.number().nonnegative().optional(),
  taxId: z.string().optional(),
  taxCode: z.string().optional(),
  productCategoryId: z.string().optional()
});

export type CreateChargeInput = z.infer<typeof CreateChargeSchema>;

// POST /folios/:id/payments — captured payments (cash, card token, etc.)
export const ApplyPaymentSchema = z.object({
  folioId: z.string().min(1).optional(),
  amount: z.number().positive("amount must be > 0"),
  currency: z.string().length(3).optional(),
  method: z.string().min(1),
  reference: z.string().max(120).optional(),
  pspReference: z.string().max(120).optional(),
  tokenRef: z.string().max(200).optional()
});

export type ApplyPaymentInput = z.infer<typeof ApplyPaymentSchema>;

// POST /payments/:id/refund
export const RefundPaymentSchema = z
  .object({
    reason: z.string().max(500).optional(),
    amount: z.number().positive().optional()
  })
  .partial();

export type RefundPaymentInput = z.infer<typeof RefundPaymentSchema>;

// POST /folios/:id/invoice — converts the folio into a fiscal invoice.
// customerType drives the tax/VAT treatment downstream.
export const IssueInvoiceSchema = z.object({
  folioId: z.string().min(1).optional(),
  customerType: z.enum(["guest", "company", "agency"]).optional(),
  customerName: z.string().max(500).optional(),
  customerTaxId: z.string().max(40).optional(),
  invoiceType: z.enum(["F1", "F2"]).optional(),
  currency: z.string().length(3).optional(),
  currencyCode: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        amount: z.number(),
        quantity: z.number().positive().optional(),
        taxCode: z.string().optional()
      })
    )
    .optional()
});

export type IssueInvoiceInput = z.infer<typeof IssueInvoiceSchema>;

// POST /folios/:id/close
export const CloseFolioSchema = z
  .object({
    reason: z.string().max(500).optional()
  })
  .partial();

export type CloseFolioInput = z.infer<typeof CloseFolioSchema>;

// POST /invoices/:id/cancel
export const CancelInvoiceSchema = z
  .object({
    reason: z.string().max(500).optional()
  })
  .partial();

export type CancelInvoiceInput = z.infer<typeof CancelInvoiceSchema>;
