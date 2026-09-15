// Invoicing routes added by the finanzas lote (2026-09-15). Registered from
// server.ts with `registerInvoicingRoutes(app, { assertInvoiceAccess })`;
// permissions in route-permissions.partial.ts (merged into the manifest by the
// integrator; the contract test reads the partial).
//
//   GET /invoices/:id/pdf — the fiscal document as application/pdf, rendered
//   from the issuance snapshot (drafts render as «BORRADOR»).

import type { FastifyInstance } from "fastify";
import { renderInvoicePdf } from "./invoice-pdf.service.js";

export type InvoicingRouteDeps = {
  /** Tenant guard of server.ts (assertEntityAccess for entity "invoice"). Optional so the routes can be mounted in tests. */
  assertInvoiceAccess?: (request: { userContext: unknown }, invoiceId: string) => Promise<void>;
};

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
}
