// Zod schemas for accounting + GDPR + invoice-rectify endpoints.
//
// These mutate the fiscal ledger (or PII state); validation at the boundary
// is critical to keep the books reconciled and the GDPR audit trail honest.

import { z } from "zod";
import { STRICT_BODY_MESSAGE } from "./folios.schemas.js";

// Finanzas (2026-09-16, fix t6#14 · integrador): every money body is strict —
// an unknown key is a 400 in Spanish, never silently dropped (a dropped key
// once made every rectificativa «I» answer «no produce ningún cambio neto»).
const strictBody = { message: STRICT_BODY_MESSAGE };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "must be YYYY-MM-DD");

// POST /invoices/:id/rectify — Spanish "factura rectificativa" (R1-R5).
const TAX_CATEGORY_VALUES = ["accommodation", "food_beverage", "general_services", "transport", "tourist_tax", "not_subject"] as const;

export const RectifyInvoiceSchema = z.object({
  reasonCode: z.enum(["R1", "R2", "R3", "R4", "R5"], {
    errorMap: () => ({ message: "reasonCode must be R1, R2, R3, R4, or R5" })
  }),
  /** VeriFactu TipoRectificativa: 'I' (diferencias, default) or 'S' (sustitución, requires substituteLines). */
  rectificationType: z.enum(["I", "S"]).optional(),
  substituteLines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive(),
        unitPrice: z.number().finite(),
        lineType: z.string().max(40).optional(),
        taxCategory: z.enum(TAX_CATEGORY_VALUES).optional()
      })
      .strict(strictBody)
    )
    .optional(),
  // Finanzas (2026-09-16): a rectificativa «I» (por diferencias) adjusts an
  // existing line to a new quantity and/or unit price — the shape
  // invoice.service buildDifferenceLines reads. The former
  // description/amountDelta/quantityDelta keys were dropped by zod, so every
  // «I» with adjustments answered 400 «no produce ningún cambio neto».
  lineAdjustments: z
    .array(
      z.object({
        lineId: z.string().min(1),
        quantity: z.number().positive().optional(),
        unitPrice: z.number().finite().optional()
      })
      .strict(strictBody)
    )
    .optional(),
  fullReversal: z.boolean().optional()
}).strict(strictBody);

export type RectifyInvoiceInput = z.infer<typeof RectifyInvoiceSchema>;

// POST /accounting/fiscal-years
export const CreateFiscalYearSchema = z.object({
  propertyId: z.string().optional(),
  code: z.string().min(1).max(40),
  startDate: isoDate,
  endDate: isoDate
}).strict(strictBody);

export type CreateFiscalYearInput = z.infer<typeof CreateFiscalYearSchema>;

// POST /accounting/fiscal-years/:id/close
export const CloseFiscalYearSchema = z
  .object({
    createNextYear: z.boolean().optional()
  })
  .partial()
  .strict(strictBody);

export type CloseFiscalYearInput = z.infer<typeof CloseFiscalYearSchema>;

// POST /accounting/fiscal-years/:id/reopen
export const ReopenFiscalYearSchema = z.object({
  reason: z.string().min(1).max(1000)
}).strict(strictBody);

export type ReopenFiscalYearInput = z.infer<typeof ReopenFiscalYearSchema>;

// POST /gdpr/requests — DSAR / right-to-erasure intake.
export const CreateGdprRequestSchema = z.object({
  requestType: z.string().min(1).max(40),
  subjectEmail: z.string().email("subjectEmail must be a valid email"),
  subjectId: z.string().optional(),
  requestorEmail: z.string().email("requestorEmail must be a valid email"),
  propertyId: z.string().optional(),
  payloadJson: z.record(z.unknown()).optional()
});

export type CreateGdprRequestInput = z.infer<typeof CreateGdprRequestSchema>;

// POST /gdpr/requests/:id/execute-erasure
export const ExecuteErasureSchema = z
  .object({
    confirmRetentionOverride: z.boolean().optional()
  })
  .partial();

export type ExecuteErasureInput = z.infer<typeof ExecuteErasureSchema>;

// POST /gdpr/requests/:id/reject
export const RejectGdprRequestSchema = z.object({
  reason: z.string().min(1).max(1000)
});

export type RejectGdprRequestInput = z.infer<typeof RejectGdprRequestSchema>;
