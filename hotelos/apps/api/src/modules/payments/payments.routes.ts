// Payments module · HTTP surface (finanzas · lote facturación-cobros,
// 2026-09-15). Registered from server.ts with
// `registerPaymentsRoutes(app, { assertFolioAccess })`; permissions in
// route-permissions.partial.ts (merged by the integrator; the contract test
// reads the partial). The webhook and return routes are public: add
// "/payments/webhooks" and "/payments/return" to PUBLIC_PREFIXES in
// lib/auth-context.ts (integrator).
//
//   GET  /properties/:propertyId/payments/psp-status — honest PSP state
//   POST /folios/:id/payment-links                   — PaymentIntent + hosted page (202)
//   GET  /payment-intents/:id                        — intent state (+ redirect); tenant-guarded (t6#5)
//   POST /payments/webhooks/:provider                — PSP notification (raw body, signed)
//   GET  /payments/return/:intentId?t=<token>        — landing page after the hosted page;
//                                                      neutral (no amount, no DB read) without
//                                                      a valid return token (t6#15)
//   POST /payments/:id/refund-requests               — Tanda 8a: approval request of a refund
//                                                      (payments.refund_request; tenant-guarded)
//   POST /folios/:id/adjustments                     — Tanda 8a: folio adjustment line
//                                                      (folio.adjust; ≤ T1 with reason, above it
//                                                      the folio_adjust approval)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { parse } from "../../lib/validate.js";
import {
  ADJUSTMENT_REASON_CODES,
  REFUND_REASON_CODES,
  adjustFolio,
  assertPaymentAccess,
  assertPaymentIntentAccess,
  createPaymentLink,
  getPaymentIntent,
  handlePspWebhook,
  pspStatus,
  requestRefund
} from "./payments.service.js";
import { RETURN_TOKEN_QUERY_PARAM, verifyReturnToken } from "./return-token.js";

type GuardedRequest = { userContext: unknown };

export type PaymentsRouteDeps = {
  /** Tenant guard of server.ts (assertEntityAccess for entity "folio"). Optional so the routes can be mounted in tests. */
  assertFolioAccess?: (request: GuardedRequest, folioId: string) => Promise<void>;
  /**
   * Tenant guard for `/payment-intents/:id`. Defaults to the module's own
   * `assertPaymentIntentAccess` (same semantics as assertEntityAccess: opaque
   * 404 for missing / foreign rows); server.ts may override it once the
   * integrator adds a `paymentIntent` resolver to lib/tenancy.ts.
   */
  assertPaymentIntentAccess?: (request: GuardedRequest, intentId: string) => Promise<void>;
  /** Tenant guard for `/payments/:id/refund-requests`. Defaults to the module's own `assertPaymentAccess` (opaque 404). */
  assertPaymentAccess?: (request: GuardedRequest, paymentId: string) => Promise<void>;
};

export const CreatePaymentLinkSchema = z
  .object({
    amount: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
    method: z.enum(["card_online", "payment_link"]).optional(),
    clientRequestId: z.string().min(1).max(120).optional(),
    returnUrl: z.string().url().max(2000).optional()
  })
  .strict();

const refundReasonCodes = Object.keys(REFUND_REASON_CODES) as [keyof typeof REFUND_REASON_CODES, ...Array<keyof typeof REFUND_REASON_CODES>];
const adjustmentReasonCodes = Object.keys(ADJUSTMENT_REASON_CODES) as [keyof typeof ADJUSTMENT_REASON_CODES, ...Array<keyof typeof ADJUSTMENT_REASON_CODES>];

/** Body of POST /payments/:id/refund-requests (Tanda 8a). Strict: an unknown key is a 400 on the money path. */
export const RefundRequestSchema = z
  .object({
    amount: z.number().positive().max(1_000_000).optional(),
    reasonCode: z.enum(refundReasonCodes),
    reasonText: z.string().trim().min(1).max(500).optional(),
    refundMethod: z.enum(["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"]).optional()
  })
  .strict();

/** Body of POST /folios/:id/adjustments (Tanda 8a). `amount` is signed (negative = rebate), never 0. */
export const FolioAdjustmentSchema = z
  .object({
    amount: z.number().finite().refine((value) => value !== 0, { message: "El importe del ajuste debe ser distinto de cero." }),
    reasonCode: z.enum(adjustmentReasonCodes),
    reasonText: z.string().trim().min(1).max(500).optional(),
    supervisorAuthorizationId: z.string().trim().min(1).max(64).optional()
  })
  .strict();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Landing page copy. The neutral variant is served to every request without a valid token (existing or not). */
type ReturnPage = { title: string; text: string };

const NEUTRAL_RETURN_PAGE: ReturnPage = {
  title: "Respuesta de la pasarela recibida",
  text: "Hemos recibido la respuesta de la pasarela de pago. El hotel confirmará el estado del cobro en cuanto la entidad lo comunique; si tienes dudas, contacta con el hotel."
};

function renderReturnPage(page: ReturnPage): string {
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(page.title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 16px;background:#f5f5f7;color:#1d1d1f}main{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;margin:0}</style></head>` +
    `<body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.text)}</p></main></body></html>`
  );
}

export function registerPaymentsRoutes(app: FastifyInstance, deps: PaymentsRouteDeps = {}): void {
  const guardIntent = deps.assertPaymentIntentAccess ?? (async (request: GuardedRequest, intentId: string) => {
    await assertPaymentIntentAccess(request as Parameters<typeof assertPaymentIntentAccess>[0], intentId);
  });
  const guardPayment = deps.assertPaymentAccess ?? (async (request: GuardedRequest, paymentId: string) => {
    await assertPaymentAccess(request as Parameters<typeof assertPaymentAccess>[0], paymentId);
  });

  app.get("/properties/:propertyId/payments/psp-status", async (request) => {
    const { propertyId } = request.params as { propertyId: string };
    return pspStatus(propertyId);
  });

  app.post("/folios/:id/payment-links", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(CreatePaymentLinkSchema, request.body ?? {});
    if (deps.assertFolioAccess) await deps.assertFolioAccess(request as unknown as GuardedRequest, id);
    const result = await createPaymentLink({
      context: request.userContext,
      folioId: id,
      amount: body.amount ?? null,
      currency: body.currency ?? null,
      methodCode: body.method,
      clientRequestId: body.clientRequestId ?? null,
      returnUrl: body.returnUrl ?? null,
      correlationId: createId("corr")
    });
    reply.code(result.idempotent ? 200 : 202);
    return result;
  });

  app.get("/payment-intents/:id", async (request) => {
    const { id } = request.params as { id: string };
    // t6#5: the intent hangs from its property; a foreign or missing id is the
    // same opaque 404 before anything about the row is read.
    await guardIntent(request as unknown as GuardedRequest, id);
    return getPaymentIntent(id);
  });

  // Tanda 8a · maker side of the refund: the request is opened by whoever
  // holds payments.refund_request in the property of the payment; the
  // approval and the execution are other people (rbac approvals + refund).
  app.post("/payments/:id/refund-requests", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(RefundRequestSchema, request.body ?? {});
    await guardPayment(request as unknown as GuardedRequest, id);
    const result = await requestRefund({
      context: request.userContext,
      paymentId: id,
      amount: body.amount,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      refundMethod: body.refundMethod ?? null,
      correlationId: createId("corr")
    });
    reply.code(201);
    return result;
  });

  // Tanda 8a · folio adjustment (rebate / correction) with a reason code:
  // ≤ T1 executes, above it the folio_adjust approval of the engine.
  app.post("/folios/:id/adjustments", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(FolioAdjustmentSchema, request.body ?? {});
    if (deps.assertFolioAccess) await deps.assertFolioAccess(request as unknown as GuardedRequest, id);
    const result = await adjustFolio({
      context: request.userContext,
      folioId: id,
      amount: body.amount,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
    reply.code(201);
    return result;
  });

  // Webhooks live in their own encapsulated context so every content type
  // (JSON from Stripe, form-urlencoded from Redsys) reaches the handler as the
  // raw string the signature was computed over. The callback parameter is
  // named `app` on purpose: the route-permissions contract test inventories
  // `app.<verb>(` calls.
  app.register(async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });
    app.post("/payments/webhooks/:provider", async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const rawBody = typeof request.body === "string" ? request.body : request.body === undefined || request.body === null ? "" : JSON.stringify(request.body);
      const outcome = await handlePspWebhook({
        provider,
        rawBody,
        headers: request.headers as Record<string, string | string[] | undefined>,
        contentType: (request.headers["content-type"] as string | undefined) ?? null,
        correlationId: createId("corr")
      });
      return reply.code(200).send(outcome);
    });
  });

  app.get("/payments/return/:intentId", async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const query = (request.query ?? {}) as { resultado?: string; [RETURN_TOKEN_QUERY_PARAM]?: string | string[] };
    // t6#15: the page is public. Only the browser that came back from the
    // hosted page carries the token we put in the PSP's return URLs; without
    // a valid one the response is identical for existing and unknown intents
    // and the database is not consulted.
    let page: ReturnPage = NEUTRAL_RETURN_PAGE;
    if (verifyReturnToken(intentId, query[RETURN_TOKEN_QUERY_PARAM]).ok) {
      try {
        const { intent } = await getPaymentIntent(intentId);
        if (intent.status === "captured") {
          page = { title: "Pago recibido", text: `Gracias. El pago de ${intent.amount.toFixed(2).replace(".", ",")} ${intent.currency} ha quedado registrado.` };
        } else if (query.resultado === "ko" || intent.status === "failed") {
          page = { title: "Pago no completado", text: "La operación no se ha completado. Puede volver a intentarlo desde el enlace de pago o contactar con el hotel." };
        } else {
          page = { title: "Pago en proceso", text: "Hemos recibido la respuesta de la pasarela. El hotel confirmará el cobro en cuanto la entidad lo comunique." };
        }
      } catch {
        page = { title: "Enlace de pago no encontrado", text: "Este enlace de pago no existe o ha caducado." };
      }
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "private, no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return reply.send(renderReturnPage(page));
  });
}
