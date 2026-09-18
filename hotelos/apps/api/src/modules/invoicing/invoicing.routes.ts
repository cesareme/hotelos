// Invoicing routes added by the finanzas lote (2026-09-15). Registered from
// server.ts with `registerInvoicingRoutes(app, { assertInvoiceAccess })`;
// permissions in route-permissions.partial.ts (merged into the manifest by the
// integrator; the contract test reads the partial).
//
//   GET  /invoices/:id/pdf            — the fiscal document as application/pdf, rendered
//                                       from the issuance snapshot (drafts render as «BORRADOR»).
//   POST /invoices/:id/cancel-request — Tanda 8a (RBAC · L2): the maker side of the anulación
//                                       (invoice.cancel_request) opens the invoice_cancel
//                                       approval request; the execution stays in
//                                       POST /invoices/:id/cancel (server.ts, invoice.cancel +
//                                       the engine gate). Tenant-guarded like the PDF.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { parse } from "../../lib/validate.js";
import { renderInvoicePdf } from "./invoice-pdf.service.js";
import { CANCEL_REASON_CODES, requestInvoiceCancellation } from "./invoice.service.js";

export type InvoicingRouteDeps = {
  /** Tenant guard of server.ts (assertEntityAccess for entity "invoice"). Optional so the routes can be mounted in tests. */
  assertInvoiceAccess?: (request: { userContext: unknown }, invoiceId: string) => Promise<void>;
};

const cancelReasonCodes = Object.keys(CANCEL_REASON_CODES) as [keyof typeof CANCEL_REASON_CODES, ...Array<keyof typeof CANCEL_REASON_CODES>];

/** Body of POST /invoices/:id/cancel-request (Tanda 8a). Strict: an unknown key is a 400. */
export const InvoiceCancelRequestSchema = z
  .object({
    reasonCode: z.enum(cancelReasonCodes),
    reasonText: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export function registerInvoicingRoutes(app: FastifyInstance, deps: InvoicingRouteDeps = {}): void {
  app.get("/invoices/:id/pdf", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (deps.assertInvoiceAccess) await deps.assertInvoiceAccess(request as unknown as { userContext: unknown }, id);
    const { buffer, filename } = await renderInvoicePdf(id);
    const query = (request.query ?? {}) as { download?: string };
    const disposition = query.download === "1" || query.download === "true" ? "attachment" : "inline";
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `${disposition}; filename="${filename}"`);
    reply.header("Content-Length", String(buffer.length));
    reply.header("Cache-Control", "private, no-store");
    return reply.send(buffer);
  });

  app.post("/invoices/:id/cancel-request", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(InvoiceCancelRequestSchema, request.body ?? {});
    if (deps.assertInvoiceAccess) await deps.assertInvoiceAccess(request as unknown as { userContext: unknown }, id);
    const result = await requestInvoiceCancellation({
      context: request.userContext,
      invoiceId: id,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      correlationId: createId("corr")
    });
    reply.code(201);
    return result;
  });
}
