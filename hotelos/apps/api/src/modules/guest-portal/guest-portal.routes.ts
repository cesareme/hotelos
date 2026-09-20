// Portal del huésped · estancia y salida (Tanda L7 · lote L7-02, 2026-09-20) —
// superficie HTTP del módulo guest-portal (recon §19.1-19.5) + encuesta
// post-estancia (lote L7-04, recon §19.7).
//
// Registro: `registerGuestPortalRoutes(app)` desde server.ts tras
// registerCheckinRoutes(app). Permisos: route-permissions.partial.ts (6
// entradas públicas + 1 de personal; spread en security/route-permissions.ts). Prefijos
// "/guest-portal/stay", "/guest-portal/invoices" y "/guest-portal/survey" en
// PUBLIC_PREFIXES (lib/auth-context.ts): el hook de personal deja pasar la
// petición sin JWT y el token opaco de GuestPortalSession ES la autenticación
// (cabecera `x-guest-token`; `?token=` SOLO en GET /guest-portal/invoices/:id/pdf
// —el enlace de descarga no puede llevar cabeceras—, corrector L7-REV-09; el
// resto de rutas del módulo nunca lo leen de la query para que no acabe en el
// historial ni en los logs). Token inválido → 401 { message, details.code:
// "GUEST_SESSION_INVALID" }. Corrector L7-REV-01: la sesión `survey` (enlace de
// la encuesta, 30 d) SOLO abre GET|POST /guest-portal/survey.
//
//   GET  /guest-portal/stay                → GuestStayView (19.2): etapa por fecha
//        local de la propiedad, reserva sin PII de acompañantes, check-in y llave,
//        folio real, facturas emitidas, datos del hotel (faq), peticiones, encuesta.
//   GET  /guest-portal/invoices/:id/pdf    → application/pdf (19.3) solo si la
//        factura es de la reserva del token (y no es borrador); si no, 404.
//   POST /guest-portal/stay/requests       → 201 (19.4): ServiceRequest front_office
//        (express_checkout | late_checkout | invoice_email | luggage, según la etapa:
//        GUEST_STAY_REQUEST_KINDS_BY_STAGE) + evento GuestCheckoutRequested;
//        409 STAY_CLOSED (cancelada/no_show, o ya salida salvo invoice_email) ·
//        409 STAY_REQUEST_NOT_ALLOWED { stage, kind }.
//   POST /guest-portal/stay/payment-link   → (19.5) no_folio | no_charges (folio sin
//        líneas) | settled (cargos y saldo 0) | link_sent (202; 200 si idempotente)
//        | at_reception (sin PSP; se cobra en recepción).
//   GET  /guest-portal/survey              → GuestSurveyView (19.7 · L7-04): cuestionario
//        de la Survey post_stay activa (o el por defecto), answered/answeredAt,
//        available (solo en post_stay).
//   POST /guest-portal/survey              → 201 GuestSurveySubmitResult (una respuesta
//        por reserva: 409 SURVEY_ALREADY_ANSWERED; 409 SURVEY_NOT_AVAILABLE fuera de post_stay).
//   POST /reservations/:id/post-stay/survey-invite (PERSONAL, pms.reservation.modify)
//        → PostStaySurveyInviteResult: el mismo paso del tick con la reserva forzada
//        (ignora la ventana; 409 RESERVATION_NOT_CHECKED_OUT); `surveyUrl` solo si
//        el envío fue simulado.
//
// Las rutas legadas /guest-portal/session/:token* siguen en server.ts (19.6:
// GET …/:token ahora verifica el token). Todo cuerpo pasa por un esquema zod
// `.strict()` con parseOr400 → 400 VALIDATION_ERROR.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { GUEST_STAY_REQUEST_KINDS } from "@hotelos/shared";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { GUEST_PORTAL_ANY_PURPOSE, verifyGuestToken, type VerifiedGuestSession } from "./guest-portal-auth.service.js";
import type { GuestSessionPurpose } from "@hotelos/shared";
import { GuestPortalAuthError } from "./guest-portal.service.js";
import { createGuestStayPaymentLink, createGuestStayRequest, getGuestStayView, renderGuestInvoicePdf } from "./guest-stay.service.js";
import { SURVEY_ANSWER_MAX_KEYS, SURVEY_ANSWER_TEXT_MAX, getGuestSurveyView, invitePostStaySurvey, submitGuestSurvey } from "./post-stay-survey.service.js";

export const GUEST_SESSION_INVALID_MESSAGE = "Sesión del portal del huésped no válida o caducada.";

/** Cuerpo de POST /guest-portal/stay/requests (19.4). Estricto: una clave desconocida es un 400. */
export const StayRequestSchema = z
  .object({
    kind: z.enum(GUEST_STAY_REQUEST_KINDS),
    note: z.string().trim().min(1).max(500).optional(),
    preferredTime: z
      .string()
      .trim()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "hora «HH:MM»")
      .optional()
  })
  .strict();

/** URL de retorno del PSP: SOLO http(s) (corrector REV-L7-08: `z.url()` admitía `javascript:` / `data:`). */
export const HTTP_URL_PATTERN = /^https?:\/\//i;

/** Cuerpo de POST /guest-portal/stay/payment-link (19.5): misma forma que PaymentLinkSchema del check-in. */
export const StayPaymentLinkSchema = z
  .object({
    returnUrl: z.string().trim().url().regex(HTTP_URL_PATTERN, "URL http(s)").max(500).optional(),
    clientRequestId: z.string().trim().min(1).max(120).optional()
  })
  .strict();

/** Cuerpo de POST /guest-portal/survey (19.7): NPS entero 0-10 + respuestas por clave (≤ 20; texto ≤ 2000 o número). */
export const SurveySubmitSchema = z
  .object({
    score: z.number().int().min(0).max(10),
    answers: z
      .record(z.string().trim().min(1).max(60), z.union([z.string().trim().max(SURVEY_ANSWER_TEXT_MAX), z.number().finite()]))
      .refine((value) => Object.keys(value).length <= SURVEY_ANSWER_MAX_KEYS, `como mucho ${SURVEY_ANSWER_MAX_KEYS} respuestas`)
      .optional()
  })
  .strict();

export type GuestRequestLike = { headers: Record<string, unknown>; query?: unknown; method?: string };

export type GuestSessionOptions = {
  /** Ámbitos admitidos (por defecto solo sign_in + invitation; las rutas de la encuesta admiten también `survey`). */
  purposes?: readonly GuestSessionPurpose[];
  /** true SOLO en GET /guest-portal/invoices/:id/pdf: el enlace de descarga no puede llevar cabeceras (corrector L7-REV-09). */
  allowQueryToken?: boolean;
};

/**
 * Token del huésped: cabecera x-guest-token o, únicamente cuando la ruta lo
 * admite (`allowQueryToken`, solo el PDF de la factura y solo en GET), ?token=.
 * Antes cualquier GET del módulo aceptaba el token en la query (historial y
 * Referer del navegador); las escrituras nunca lo admiten (SEC-6).
 */
export function guestTokenFrom(request: GuestRequestLike, options: Pick<GuestSessionOptions, "allowQueryToken"> = {}): string {
  const header = request.headers["x-guest-token"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  if (Array.isArray(header) && typeof header[0] === "string") return header[0].trim();
  if (!options.allowQueryToken) return "";
  if (request.method && request.method.toUpperCase() !== "GET") return "";
  const query = (request.query ?? {}) as { token?: unknown };
  if (typeof query.token === "string") return query.token.trim();
  return "";
}

/** Sesión verificada del token de la petición; GuestPortalAuthError si no vale (o si su ámbito no abre esta ruta). */
export async function requireGuestSession(request: GuestRequestLike, options: GuestSessionOptions = {}): Promise<{ token: string; session: VerifiedGuestSession }> {
  const token = guestTokenFrom(request, options);
  const session = await verifyGuestToken(token, options.purposes ? { purposes: options.purposes } : {});
  if (!session || !session.reservationId) throw new GuestPortalAuthError(GUEST_SESSION_INVALID_MESSAGE);
  return { token, session };
}

/** Ejecuta un handler de huésped mapeando GuestPortalAuthError → 401 tipado. */
async function guestHandler<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | { message: string; details: { code: string } }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GuestPortalAuthError) {
      reply.code(error.statusCode);
      return { message: error.message, details: { code: "GUEST_SESSION_INVALID" } };
    }
    throw error;
  }
}

export function registerGuestPortalRoutes(app: FastifyInstance): void {
  app.get("/guest-portal/stay", async (request, reply) =>
    guestHandler(reply, async () => {
      const { token, session } = await requireGuestSession(request);
      return getGuestStayView({ token, session });
    })
  );

  app.post("/guest-portal/stay/requests", async (request, reply) =>
    guestHandler(reply, async () => {
      const { session } = await requireGuestSession(request);
      const body = parseOr400(StayRequestSchema, request.body ?? {}, "Petición de salida");
      const result = await createGuestStayRequest({ session, body, correlationId: createId("corr") });
      reply.code(201);
      return result;
    })
  );

  app.post("/guest-portal/stay/payment-link", async (request, reply) =>
    guestHandler(reply, async () => {
      const { session } = await requireGuestSession(request);
      const body = parseOr400(StayPaymentLinkSchema, request.body ?? {}, "Enlace de pago");
      const { statusCode, body: result } = await createGuestStayPaymentLink({ session, body, correlationId: createId("corr") });
      reply.code(statusCode);
      return result;
    })
  );

  app.get("/guest-portal/invoices/:id/pdf", async (request, reply) =>
    guestHandler(reply, async () => {
      const { session } = await requireGuestSession(request, { allowQueryToken: true });
      const { id } = request.params as { id: string };
      const { buffer, filename } = await renderGuestInvoicePdf({ session, invoiceId: id });
      const query = (request.query ?? {}) as { download?: string };
      const disposition = query.download === "1" || query.download === "true" ? "attachment" : "inline";
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `${disposition}; filename="${filename}"`);
      reply.header("Content-Length", String(buffer.length));
      reply.header("Cache-Control", "private, no-store");
      return reply.send(buffer);
    })
  );

  // ── Encuesta post-estancia (L7-04 · 19.7) ────────────────────────────────────
  // Únicas rutas que admiten la sesión `survey` del enlace de 30 días (corrector L7-REV-01).
  app.get("/guest-portal/survey", async (request, reply) =>
    guestHandler(reply, async () => {
      const { session } = await requireGuestSession(request, { purposes: GUEST_PORTAL_ANY_PURPOSE });
      return getGuestSurveyView(session);
    })
  );

  app.post("/guest-portal/survey", async (request, reply) =>
    guestHandler(reply, async () => {
      const { session } = await requireGuestSession(request, { purposes: GUEST_PORTAL_ANY_PURPOSE });
      const body = parseOr400(SurveySubmitSchema, request.body ?? {}, "Encuesta");
      const result = await submitGuestSurvey({ session, body, correlationId: createId("corr") });
      reply.code(201);
      return result;
    })
  );

  // Personal: invitación manual (misma lógica que el paso del tick, reserva forzada).
  app.post("/reservations/:id/post-stay/survey-invite", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    return invitePostStaySurvey({ reservationId: params.id, context: request.userContext });
  });
}
