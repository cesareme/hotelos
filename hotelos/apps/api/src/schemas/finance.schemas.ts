// Zod schemas for accounting + GDPR + invoice-rectify endpoints.
//
// These mutate the fiscal ledger (or PII state); validation at the boundary
// is critical to keep the books reconciled and the GDPR audit trail honest.

import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "must be YYYY-MM-DD");

// POST /invoices/:id/rectify — Spanish "factura rectificativa" (R1-R5).
export const RectifyInvoiceSchema = z.object({
  reasonCode: z.enum(["R1", "R2", "R3", "R4", "R5"], {
    errorMap: () => ({ message: "reasonCode must be R1, R2, R3, R4, or R5" })
  }),
  lineAdjustments: z
    .array(
      z.object({
        lineId: z.string().optional(),
        description: z.string().max(500).optional(),
        amountDelta: z.number().optional(),
        quantityDelta: z.number().optional()
      })
    )
    .optional(),
  fullReversal: z.boolean().optional()
});

export type RectifyInvoiceInput = z.infer<typeof RectifyInvoiceSchema>;

// POST /accounting/fiscal-years
export const CreateFiscalYearSchema = z.object({
  propertyId: z.string().optional(),
  code: z.string().min(1).max(40),
  startDate: isoDate,
  endDate: isoDate
});

export type CreateFiscalYearInput = z.infer<typeof CreateFiscalYearSchema>;

// POST /accounting/fiscal-years/:id/close
export const CloseFiscalYearSchema = z
  .object({
    createNextYear: z.boolean().optional()
  })
  .partial();

export type CloseFiscalYearInput = z.infer<typeof CloseFiscalYearSchema>;

// POST /accounting/fiscal-years/:id/reopen
export const ReopenFiscalYearSchema = z.object({
  reason: z.string().min(1).max(1000)
});

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
