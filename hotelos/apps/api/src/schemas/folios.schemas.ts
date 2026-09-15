// Zod schemas for folio / payment / invoice mutations.
//
// These endpoints write to the financial ledger and feed VeriFactu + TBai
// + SES Hospedajes. Strict validation here is the cheapest line of defence
// against malformed amounts and missing required fiscal fields.

import { z } from "zod";
import { LEGACY_PAYMENT_METHOD_ALIASES, PAYMENT_METHODS } from "../../../../packages/shared/src/payments-types.js";

// Finanzas (2026-09-16, t6#14): every money body is strict — an unknown key
// (a typo, a stale front-end field, an injected attribute) is a 400 instead
// of being silently dropped. Message in Spanish like the rest of the API.
export const STRICT_BODY_MESSAGE = "Campo no admitido en el cuerpo de la petición.";
const strictBody = { message: STRICT_BODY_MESSAGE };

// Fiscal categories of the indirect-tax catalogue (Tanda 3, contract A
// TaxCategory in packages/compliance/src/spain/indirect-tax.ts). A folio line
// may override the category its type implies (POS food & beverage, tourist
// tax, not-subject penalties); the service re-validates against the catalogue.
export const TAX_CATEGORY_VALUES = ["accommodation", "food_beverage", "general_services", "transport", "tourist_tax", "not_subject"] as const;
export type TaxCategoryValue = (typeof TAX_CATEGORY_VALUES)[number];

// POST /folios/:id/lines — accept the "lines" wire shape AND the simplified
// charge body documented in the task spec. We treat the line-item form as
// canonical.
export const CreateFolioLineSchema = z
  .object({
    type: z.string().min(1, "required"),
    description: z.string().min(1, "required").max(500),
    quantity: z.number().positive("must be > 0"),
    unitPrice: z.number().nonnegative("must be >= 0"),
    // Legacy free-text code (ignored by invoicing since Tanda 3; kept for callers).
    taxCode: z.string().optional(),
    // Optional fiscal-category override, validated against the catalogue.
    taxCategory: z.enum(TAX_CATEGORY_VALUES).optional()
  })
  .strict(strictBody);

export type CreateFolioLineInput = z.infer<typeof CreateFolioLineSchema>;

// Alias matching the operator-friendly name in the task spec. We expose both
// names because the wire path is /folios/:id/lines but conceptually it is
// "create a charge on the folio".
export const CreateChargeSchema = z
  .object({
    folioId: z.string().min(1).optional(),
    description: z.string().min(1).max(500),
    amount: z.number().positive("amount must be > 0").optional(),
    quantity: z.number().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
    taxId: z.string().optional(),
    taxCode: z.string().optional(),
    productCategoryId: z.string().optional()
  })
  .strict(strictBody);

export type CreateChargeInput = z.infer<typeof CreateChargeSchema>;

// Finanzas (2026-09-15): the payment method is the PaymentMethod enum; the
// legacy wire values ("card", "ota_virtual_card"…) are still accepted and
// normalised by the service. Money amounts are 2-decimal numbers.
export const PaymentMethodWireSchema = z.enum([...PAYMENT_METHODS, ...(Object.keys(LEGACY_PAYMENT_METHOD_ALIASES) as [string, ...string[]])] as [string, ...string[]], {
  errorMap: () => ({ message: `método de cobro no válido; valores: ${PAYMENT_METHODS.join(", ")}` })
});

const moneyAmount = z
  .number()
  .positive("el importe debe ser mayor que 0")
  .refine((value) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "el importe admite como máximo 2 decimales");

// POST /folios/:id/payments — captured payments (cash / terminal / transfer) or
// a payment intent (card_online / payment_link → PSP). Idempotent by clientRequestId.
export const ApplyPaymentSchema = z
  .object({
    folioId: z.string().min(1).optional(),
    amount: moneyAmount,
    currency: z.string().length(3).optional(),
    method: PaymentMethodWireSchema,
    /** Bank / terminal / PSP reference of the collection (stored encrypted). */
    reference: z.string().trim().min(1).max(120).optional(),
    /** @deprecated alias of `reference`. */
    pspReference: z.string().trim().min(1).max(120).optional(),
    /** Idempotency key of the client, unique per folio. */
    clientRequestId: z.string().trim().min(1).max(120).optional(),
    /** Link the capture to an issued invoice of this folio. */
    invoiceId: z.string().min(1).optional(),
    /** payment_link / card_online: where to send the customer afterwards. */
    returnUrl: z.string().url().max(2000).optional()
  })
  .strict();

export type ApplyPaymentInput = z.infer<typeof ApplyPaymentSchema>;

// POST /payments/:id/refund — idempotent by clientRequestId.
export const RefundPaymentSchema = z
  .object({
    reason: z.string().max(500).optional(),
    amount: moneyAmount.optional(),
    clientRequestId: z.string().trim().min(1).max(120).optional(),
    /** How the money goes back (default: the original method); cash / bank_transfer record a manual refund of an online payment. */
    refundMethod: PaymentMethodWireSchema.optional()
  })
  .strict();

export type RefundPaymentInput = z.infer<typeof RefundPaymentSchema>;

// POST /invoices/:id/mark-paid — «Marcar pagada» only with method + reference.
export const MarkInvoicePaidSchema = z
  .object({
    method: PaymentMethodWireSchema,
    reference: z.string().trim().min(1, "indica la referencia del cobro").max(120),
    /** @deprecated alias of `reference`. */
    pspReference: z.string().trim().min(1).max(120).optional(),
    amount: moneyAmount.optional()
  })
  .strict();

export type MarkInvoicePaidInput = z.infer<typeof MarkInvoicePaidSchema>;

// POST /invoices/:id/send-email
export const SendInvoiceEmailSchema = z
  .object({
    recipient: z.string().trim().email("recipient debe ser una dirección de correo válida").max(320),
    subject: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(2000).optional()
  })
  .strict();

export type SendInvoiceEmailInput = z.infer<typeof SendInvoiceEmailSchema>;

// POST /payment-tokens — only PSP-issued tokens; a PAN is refused (PCI scope).
export const PaymentTokenSchema = z
  .object({
    guestId: z.string().min(1).optional(),
    provider: z.enum(["stripe", "redsys"]),
    /** Token issued by the PSP front-end SDK (Stripe pm_… / Redsys DS_MERCHANT_IDENTIFIER). */
    token: z.string().trim().min(8).max(200),
    last4: z.string().regex(/^[0-9]{4}$/).optional(),
    brand: z.enum(["visa", "mastercard", "amex", "other"]).optional(),
    expiryMonth: z.number().int().min(1).max(12).optional(),
    expiryYear: z.number().int().min(2024).max(2100).optional(),
    isDefault: z.boolean().optional()
  })
  .strict();

export type PaymentTokenInput = z.infer<typeof PaymentTokenSchema>;

// POST /folios/:id/invoice — converts the folio into a fiscal invoice.
// customerType drives the tax/VAT treatment downstream.
export const IssueInvoiceSchema = z
  .object({
    folioId: z.string().min(1).optional(),
    customerType: z.enum(["guest", "company", "agency"]).optional(),
    customerName: z.string().max(500).optional(),
    customerTaxId: z.string().max(40).optional(),
    invoiceType: z.enum(["F1", "F2"]).optional(),
    currency: z.string().length(3).optional(),
    currencyCode: z.string().length(3).optional(),
    lines: z
      .array(
        z
          .object({
            description: z.string().min(1).max(500),
            amount: z.number(),
            quantity: z.number().positive().optional(),
            taxCode: z.string().optional()
          })
          .strict(strictBody)
      )
      .optional()
  })
  .strict(strictBody);

export type IssueInvoiceInput = z.infer<typeof IssueInvoiceSchema>;

// POST /folios/:id/close
export const CloseFolioSchema = z
  .object({
    reason: z.string().max(500).optional()
  })
  .partial()
  .strict(strictBody);

export type CloseFolioInput = z.infer<typeof CloseFolioSchema>;

// POST /invoices/:id/cancel — the linked payments are always unlinked from
// the cancelled invoice; `refundPayments` also refunds the captured ones.
export const CancelInvoiceSchema = z
  .object({
    reason: z.string().max(500).optional(),
    refundPayments: z.boolean().optional()
  })
  .partial()
  .strict(strictBody);

export type CancelInvoiceInput = z.infer<typeof CancelInvoiceSchema>;
