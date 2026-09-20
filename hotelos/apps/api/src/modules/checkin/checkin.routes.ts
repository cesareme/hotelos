// Check-in automatizado · Tanda CHK · lotes W2-A (base) y W3-A (captura, firma,
// pago, OTP, llegada y check-in completo) — superficie HTTP del módulo
// (apps/api/src/modules/checkin/checkin.routes.ts).
//
// Registro: `registerCheckinRoutes(app)` desde server.ts tras
// registerReputationRoutes(app). Permisos: route-permissions.partial.ts (29
// entradas, una por ruta; spread en security/route-permissions.ts).
//
// W3-A (diseño §7.1 restantes y §7.2 /reservations/:id/check-in/*):
//   · huésped: POST …/guests/:id/document (bodyLimit 8 MB; captureDocument W2-B
//     con el contexto de servicio; 400 DOCUMENT_UNREADABLE cuando ni MRZ ni
//     visión), POST …/guests/:id/signature (signGuest W2-B; ip/userAgent de la
//     petición; touch_kiosk si `x-kiosk-token` autentica un kiosco de la misma
//     propiedad, si no touch_portal), POST …/payment-link (folio de la reserva
//     con paymentLinkServiceContext; 409 PSP_NOT_CONFIGURED → { status:
//     "at_reception" } y paymentStatus at_reception), POST …/otp/request ·
//     …/otp/verify (otp.service.ts), POST …/arrive (completeCheckIn actor
//     guest|kiosk).
//   · personal: GET /reservations/:id/check-in (sesión + viajeros + capturas y
//     firmas sin PII), POST …/scan (captureDocument con el usuario), POST
//     …/signature (touch_reception), POST …/verify-identity
//     (markGuestRegisterIdentityVerified + marca del viajero), POST …/complete
//     (completeCheckIn actor user; roomId, allowEarlyCheckIn, overrideReason).
//     Las rutas por `:id` de reserva cruzan la tenencia con assertEntityAccess
//     ({ entity: "reservation" }), como server.ts. POST /reservations/:id/check-in
//     y /assign-room siguen en server.ts (pms-lifecycle.test.mjs).
//
// Rutas de huésped (/guest-portal/check-in*): `permissions: [], riskLevel
// "public"` en el manifiesto y prefijo "/guest-portal/check-in" en
// PUBLIC_PREFIXES (lib/auth-context.ts, R18): el hook de personal las deja
// pasar y el token opaco del portal ES la autenticación — por la cabecera
// `x-guest-token` o `?token=` (misma lectura que server.ts:3210-3218) —, nunca
// request.userContext. GuestPortalAuthError → 401 { message, details.code
// GUEST_SESSION_INVALID }. Las escrituras de dominio van con el contexto de
// servicio (service-context.ts).
//
// Rutas de personal (/properties/:propertyId/check-in/* y /properties/:propertyId/kiosks*):
// el preHandler global de server.ts ya resolvió `:propertyId` (404 opaco) y
// aplicó el manifiesto; las rutas con `:id` cruzan además la tenencia con
// assertEntityAccess({ entity: checkInSession | kioskDevice, propertyId })
// (lib/tenancy.ts) → 404 opaco si la fila cuelga de otra propiedad.
//
// Gate de módulo (mismo texto que advanced-modules.service.ts:426-431): las
// invitaciones y todas las rutas del huésped exigen `guest_self_service`
// activado en la propiedad; las de configuración (política, kioscos, llegadas)
// no, para que el Setup Center pueda prepararlo antes de activarlo.
//
// Todo cuerpo y consulta pasa por un esquema zod `.strict()` de
// checkin.schemas.ts con parseOr400 → 400 VALIDATION_ERROR; correlationId
// createId("corr") en cada escritura; orden de registro: literales antes que `:id`.
//
// W4-D: POST /guest-portal/chat (bot del huésped, diseño §5/§7.1): pública por
// token (prefijo "/guest-portal/chat" en PUBLIC_PREFIXES), 30 mensajes por
// minuto e IP, misma pila que el webhook de WhatsApp (guest-bot.service.ts).
// No abre sesión de check-in (no pasa por guestSession/ensureSession): el bot
// verifica el token y responde con los datos de SU reserva.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KioskDeviceDto } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { BadRequestError, ConflictError, ForbiddenError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { markGuestRegisterIdentityVerified } from "../compliance/compliance.service.js";
import { findReservationFolio } from "../folio/folio.service.js";
import { createPaymentLink } from "../payments/payments.service.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { GuestPortalAuthError } from "../guest-portal/guest-portal.service.js";
import { verifyGuestToken } from "../guest-portal/guest-portal-auth.service.js";
import { completeCheckIn, precheckCheckIn } from "./arrival.service.js";
import { GUEST_BOT_TEXT_MAX, handleGuestMessage } from "./guest-bot.service.js";
import { getPolicy, upsertPolicy } from "./checkin-policy.service.js";
import {
  CLOSED_SESSION_STATUSES,
  applyMrz,
  completePreArrival,
  ensureGuestRegisterRecordsForSession,
  getSessionById,
  getSessionForToken,
  inviteReservation,
  listArrivals,
  removeGuest,
  resolveHandoff,
  toGuestDto,
  toSessionView,
  updateGuestByStaff,
  updateSession,
  upsertGuest,
  type CheckInSessionView
} from "./checkin-session.service.js";
import {
  ArriveSchema,
  ArrivalsQuerySchema,
  CompleteCheckInSchema,
  DocumentCaptureSchema,
  GuestInputSchema,
  GuestSignatureSchema,
  KioskClaimSchema,
  KioskCreateSchema,
  KioskPatchSchema,
  MrzSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  PaymentLinkSchema,
  PolicyPutSchema,
  ResendSchema,
  ResolveHandoffSchema,
  SessionCreateSchema,
  SessionPatchSchema,
  StaffSignatureSchema,
  VerifyIdentitySchema
} from "./checkin.schemas.js";
import { captureDocument } from "./identity-capture.service.js";
import { authenticateKiosk, claimPairing, createDevice, listDevices, patchDevice, startPairing } from "./kiosk.service.js";
import { requestOtp, verifyOtp } from "./otp.service.js";
import { checkInServiceContext, paymentLinkServiceContext } from "./service-context.js";
import { signGuest } from "./signature.service.js";

type PropertyParams = { propertyId: string };
type EntityParams = { propertyId: string; id: string };
type IdParams = { id: string };

export const SELF_SERVICE_MODULE_CODE = "guest_self_service";

/** Claim de kiosco: público, 10 intentos por minuto por IP (@fastify/rate-limit, server.ts). */
const CLAIM_OPTIONS = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
/** Chat del huésped: público por token, 30 mensajes por minuto por IP. */
const CHAT_OPTIONS = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
const GuestChatSchema = z
  .object({
    text: z.string().trim().min(1).max(GUEST_BOT_TEXT_MAX),
    conversationId: z.string().trim().min(1).max(64).optional(),
    language: z.string().trim().min(2).max(10).optional()
  })
  .strict();

/**
 * Gate de módulo (mismo texto que advanced-modules.service.ts:426-431): espejo
 * hidratado primero y, si no dice nada de la propiedad, la fila property_modules
 * en Prisma — una instancia arrancada con TENANT_BOOTSTRAP_SKIP=true (tests y
 * carriles) no hidrata el espejo y respondía 403 con el módulo activado en BD.
 */
export async function requireSelfServiceModule(propertyId: string): Promise<void> {
  if (getEnabledModuleCodes(propertyId).includes(SELF_SERVICE_MODULE_CODE)) return;
  const module = await prisma.module.findFirst({ where: { code: SELF_SERVICE_MODULE_CODE }, select: { id: true } });
  const row = module ? await prisma.propertyModule.findUnique({ where: { propertyId_moduleId: { propertyId, moduleId: module.id } }, select: { status: true } }) : null;
  if (row?.status === "enabled") return;
  throw new ForbiddenError(`El módulo ${SELF_SERVICE_MODULE_CODE} no está activado en esta propiedad.`);
}

/**
 * Token del huésped: cabecera x-guest-token o, SOLO en GET, ?token= (el enlace
 * de la invitación abre la sesión; el portal pasa después a la cabecera). Las
 * escrituras no admiten el token en la query (corrector SEC-6: acababa en los
 * logs de peticiones); el CORS de server.ts admite `x-guest-token`.
 */
export function guestTokenFrom(request: { headers: Record<string, unknown>; query?: unknown; method?: string }): string {
  const header = request.headers["x-guest-token"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  if (Array.isArray(header) && typeof header[0] === "string") return header[0].trim();
  if (request.method && request.method.toUpperCase() !== "GET") return "";
  const query = (request.query ?? {}) as { token?: unknown };
  if (typeof query.token === "string") return query.token.trim();
  return "";
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

/** Sesión del huésped + gate de módulo sobre SU propiedad (nunca sobre un propertyId de la petición). */
async function guestSession(request: FastifyRequest) {
  const view = await getSessionForToken(guestTokenFrom(request));
  await requireSelfServiceModule(view.propertyId);
  return view;
}

/** Kiosco autenticado por `x-kiosk-token` y de la MISMA propiedad que la sesión; null en cualquier otro caso. */
export async function kioskFrom(request: { headers: Record<string, unknown> }, propertyId: string): Promise<KioskDeviceDto | null> {
  const header = request.headers["x-kiosk-token"];
  const token = typeof header === "string" ? header : Array.isArray(header) && typeof header[0] === "string" ? header[0] : "";
  if (!token.trim()) return null;
  const device = await authenticateKiosk(token);
  return device && device.propertyId === propertyId ? device : null;
}

function userAgentOf(request: { headers: Record<string, unknown> }): string | undefined {
  const value = request.headers["user-agent"];
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, 512) : undefined;
}

function assertSessionOpen(session: CheckInSessionView): void {
  if ((CLOSED_SESSION_STATUSES as readonly string[]).includes(session.status)) throw new ConflictError("La sesión de check-in ya no admite cambios desde el portal.");
}

function requireSessionGuest(session: CheckInSessionView, checkInGuestId: string): CheckInSessionView["guests"][number] {
  const guest = session.guests.find((row) => row.id === checkInGuestId);
  if (!guest) throw new NotFoundError("Viajero no encontrado.");
  return guest;
}

/** bodyLimit de la captura de documento (imagen base64 ≤ 8 MB en el cuerpo; el decodificado lo acota CHECKIN_DOCUMENT_MAX_BYTES). */
export const DOCUMENT_BODY_LIMIT = 8 * 1024 * 1024;
const DOCUMENT_OPTIONS = { bodyLimit: DOCUMENT_BODY_LIMIT };

type PaymentLinkOutcome = { status: "settled" | "no_folio"; paymentStatus: string } | { status: "at_reception"; paymentStatus: "at_reception"; reason: string; details: unknown } | { status: "link_sent"; paymentStatus: "link_sent"; link: Awaited<ReturnType<typeof createPaymentLink>> };

/** Vista de personal de una reserva: sesión + viajeros + capturas y firmas SIN PII (ni campos del documento ni trazo). */
async function reservationCheckInView(reservationId: string) {
  const header = await prisma.checkInSession.findUnique({ where: { reservationId } });
  if (!header) throw new NotFoundError("Sesión de check-in no encontrada.");
  // Viajeros por consulta de primer nivel (descifrados): los últimos 3 caracteres del documento son reales.
  const session = { ...header, guests: await prisma.checkInGuest.findMany({ where: { sessionId: header.id }, orderBy: { ordinal: "asc" } }) };
  const guestIds = session.guests.map((guest) => guest.id);
  const [captures, signatures] = await Promise.all([
    prisma.documentCapture.findMany({
      where: { checkInGuestId: { in: guestIds } },
      orderBy: { createdAt: "desc" },
      select: { id: true, checkInGuestId: true, source: true, mrzFormat: true, checksJson: true, needsReviewJson: true, imageStored: true, processingMs: true, purgeAt: true, createdAt: true }
    }),
    prisma.signature.findMany({
      where: { guestRegisterRecordId: { in: session.guests.map((guest) => guest.guestRegisterRecordId).filter((id): id is string => Boolean(id)) } },
      orderBy: { signedAt: "desc" },
      select: { id: true, checkInGuestId: true, guestRegisterRecordId: true, method: true, sha256: true, pdfSha256: true, signedAt: true, retentionUntil: true }
    })
  ]);
  const view = await toSessionView(session, session.guests);
  return {
    ...view,
    guests: session.guests.map((row) => ({
      ...toGuestDto(row),
      identityVerifiedBy: row.identityVerifiedBy ?? null,
      captures: captures.filter((capture) => capture.checkInGuestId === row.id).map((capture) => ({ ...capture, purgeAt: capture.purgeAt.toISOString(), createdAt: capture.createdAt.toISOString() })),
      signatures: signatures.filter((signature) => signature.checkInGuestId === row.id || (row.guestRegisterRecordId && signature.guestRegisterRecordId === row.guestRegisterRecordId)).map((signature) => ({ ...signature, signedAt: signature.signedAt.toISOString(), retentionUntil: signature.retentionUntil.toISOString() }))
    }))
  };
}

export function registerCheckinRoutes(app: FastifyInstance): void {
  // ── Huésped ────────────────────────────────────────────────────────────────
  app.get("/guest-portal/check-in", async (request, reply) => guestHandler(reply, () => guestSession(request)));

  app.patch("/guest-portal/check-in", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      const body = parseOr400(SessionPatchSchema, request.body ?? {}, "Cuerpo del pre-check-in");
      return updateSession({ token: guestTokenFrom(request), ...body, correlationId: createId("corr") });
    })
  );

  app.post("/guest-portal/check-in/guests", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      const body = parseOr400(GuestInputSchema, request.body ?? {}, "Viajero");
      const result = await upsertGuest({ token: guestTokenFrom(request), input: body, correlationId: createId("corr") });
      reply.code(201);
      return result;
    })
  );

  app.patch("/guest-portal/check-in/guests/:id", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      const body = parseOr400(GuestInputSchema, request.body ?? {}, "Viajero");
      return upsertGuest({ token: guestTokenFrom(request), checkInGuestId: (request.params as IdParams).id, input: body, correlationId: createId("corr") });
    })
  );

  app.delete("/guest-portal/check-in/guests/:id", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      return removeGuest({ token: guestTokenFrom(request), checkInGuestId: (request.params as IdParams).id, correlationId: createId("corr") });
    })
  );

  app.post("/guest-portal/check-in/guests/:id/mrz", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      const body = parseOr400(MrzSchema, request.body ?? {}, "MRZ");
      return applyMrz({ token: guestTokenFrom(request), checkInGuestId: (request.params as IdParams).id, lines: body.lines, correlationId: createId("corr") });
    })
  );

  app.post("/guest-portal/check-in/complete", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      return completePreArrival({ token: guestTokenFrom(request), correlationId: createId("corr") });
    })
  );

  // ── W3-A · captura, firma, pago, OTP y llegada del huésped ─────────────────
  app.post("/guest-portal/check-in/guests/:id/document", DOCUMENT_OPTIONS, async (request, reply) =>
    guestHandler(reply, async () => {
      const session = await guestSession(request);
      assertSessionOpen(session);
      const guest = requireSessionGuest(session, (request.params as IdParams).id);
      const body = parseOr400(DocumentCaptureSchema, request.body ?? {}, "Documento de identidad");
      const kiosk = await kioskFrom(request, session.propertyId);
      const context = await checkInServiceContext(session.propertyId, kiosk ? { kind: "kiosk", deviceId: kiosk.id } : { kind: "guest", sessionId: session.id });
      const result = await captureDocument({
        context,
        propertyId: session.propertyId,
        checkInGuestId: guest.id,
        ...(body.imageDataUrl ? { imageDataUrl: body.imageDataUrl } : {}),
        hints: { ...(body.documentType ? { documentType: body.documentType } : {}), ...(body.mrzLines ? { mrzLines: body.mrzLines } : {}) },
        correlationId: createId("corr")
      });
      if (result.source === "manual") {
        // Ni MRZ válida ni visión: la captura queda como métrica, el viajero no recibe datos.
        throw new HttpError(400, "No se ha podido leer el documento (ni MRZ válida ni visión): repite la captura con mejor luz o introduce los datos a mano.", true, {
          code: "DOCUMENT_UNREADABLE",
          captureId: result.captureId,
          needsReview: result.needsReview,
          warnings: result.warnings
        });
      }
      // Fila del viajero por consulta de primer nivel (descifrada): documentNumberLast3 real, no del envelope.
      const row = await prisma.checkInGuest.findUnique({ where: { id: guest.id } });
      const refreshed = await getSessionForToken(guestTokenFrom(request));
      return { capture: result, guest: row ? toGuestDto(row) : null, session: refreshed };
    })
  );

  app.post("/guest-portal/check-in/guests/:id/signature", async (request, reply) =>
    guestHandler(reply, async () => {
      const session = await guestSession(request);
      assertSessionOpen(session);
      const guest = requireSessionGuest(session, (request.params as IdParams).id);
      const body = parseOr400(GuestSignatureSchema, request.body ?? {}, "Firma");
      const kiosk = await kioskFrom(request, session.propertyId);
      const context = await checkInServiceContext(session.propertyId, kiosk ? { kind: "kiosk", deviceId: kiosk.id } : { kind: "guest", sessionId: session.id });
      const userAgent = userAgentOf(request);
      const result = await signGuest({
        context,
        checkInGuestId: guest.id,
        pngBase64: body.pngBase64,
        ...(body.svg ? { svg: body.svg } : {}),
        strokeMeta: body.strokeMeta,
        method: kiosk ? "touch_kiosk" : "touch_portal",
        ip: request.ip,
        ...(userAgent ? { userAgent } : {}),
        sessionId: session.id,
        correlationId: createId("corr")
      });
      // Corrector REV3-12: un viajero ya firmado devuelve su firma existente (200), nunca una segunda fila.
      reply.code(result.idempotent ? 200 : 201);
      return result;
    })
  );

  app.post("/guest-portal/check-in/payment-link", async (request, reply) =>
    guestHandler(reply, async (): Promise<PaymentLinkOutcome> => {
      const session = await guestSession(request);
      assertSessionOpen(session);
      const body = parseOr400(PaymentLinkSchema, request.body ?? {}, "Enlace de pago");
      const folio = await findReservationFolio(session.reservationId);
      const correlationId = createId("corr");
      const setPaymentStatus = async (paymentStatus: string, extra: Record<string, unknown>) => {
        if (session.paymentStatus === paymentStatus) return;
        await prisma.checkInSession.update({ where: { id: session.id }, data: { paymentStatus, ...(typeof extra.paymentIntentId === "string" ? { paymentIntentId: extra.paymentIntentId } : {}) } });
        const context = await checkInServiceContext(session.propertyId, { kind: "guest", sessionId: session.id });
        recordAuditEvent({ organizationId: context.organizationId, propertyId: session.propertyId, actorUserId: context.userId, actorType: "system", action: "CheckInPaymentStatusChanged", entityType: "checkin_session", entityId: session.id, beforeJson: { paymentStatus: session.paymentStatus }, afterJson: { paymentStatus, ...extra }, deviceId: context.deviceId, correlationId });
      };
      if (!folio) return { status: "no_folio", paymentStatus: session.paymentStatus };
      if (folio.reservationBalanceDue <= 0.005) {
        await setPaymentStatus("paid", { reason: "folio_settled", balanceDue: folio.reservationBalanceDue });
        return { status: "settled", paymentStatus: "paid" };
      }
      try {
        const link = await createPaymentLink({
          context: await paymentLinkServiceContext(session.propertyId, session.id),
          folioId: folio.folio.id,
          amount: folio.balanceDue,
          methodCode: "payment_link",
          clientRequestId: body.clientRequestId ?? `checkin:${session.id}:${folio.balanceDue.toFixed(2)}`,
          returnUrl: body.returnUrl ?? null,
          correlationId
        });
        await setPaymentStatus("link_sent", { paymentIntentId: link.intent.id, amount: folio.balanceDue });
        reply.code(link.idempotent ? 200 : 202);
        return { status: "link_sent", paymentStatus: "link_sent", link };
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 409 && (error.details as { code?: unknown } | undefined)?.code === "PSP_NOT_CONFIGURED") {
          await setPaymentStatus("at_reception", { reason: "PSP_NOT_CONFIGURED", balanceDue: folio.balanceDue });
          return { status: "at_reception", paymentStatus: "at_reception", reason: "PSP_NOT_CONFIGURED", details: error.details };
        }
        throw error;
      }
    })
  );

  app.post("/guest-portal/check-in/otp/request", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      const body = parseOr400(OtpRequestSchema, request.body ?? {}, "OTP");
      return requestOtp({ token: guestTokenFrom(request), channel: body.channel, correlationId: createId("corr") });
    })
  );

  app.post("/guest-portal/check-in/otp/verify", async (request, reply) =>
    guestHandler(reply, async () => {
      await guestSession(request);
      const body = parseOr400(OtpVerifySchema, request.body ?? {}, "OTP");
      return verifyOtp({ token: guestTokenFrom(request), code: body.code, correlationId: createId("corr") });
    })
  );

  app.post("/guest-portal/check-in/arrive", async (request, reply) =>
    guestHandler(reply, async () => {
      const session = await guestSession(request);
      const body = parseOr400(ArriveSchema, request.body ?? {}, "Llegada");
      const kiosk = await kioskFrom(request, session.propertyId);
      return completeCheckIn({
        actor: kiosk ? "kiosk" : "guest",
        token: guestTokenFrom(request),
        reservationId: session.reservationId,
        verification: { method: body.verification?.method ?? null, kioskDeviceId: kiosk?.id ?? null },
        correlationId: createId("corr")
      });
    })
  );

  // Kiosco: la tablet reclama el código de 8 dígitos y recibe su deviceToken (una sola vez).
  // Bot del huésped (W4-D): el token identifica la reserva; el propertyId sale de la sesión verificada, nunca del cuerpo.
  app.post("/guest-portal/chat", CHAT_OPTIONS, async (request, reply) =>
    guestHandler(reply, async () => {
      const body = parseOr400(GuestChatSchema, request.body ?? {}, "Mensaje del huésped");
      const token = guestTokenFrom(request);
      const verified = await verifyGuestToken(token);
      if (!verified || !verified.reservationId) throw new GuestPortalAuthError("Sesión del portal del huésped no válida o caducada.");
      await requireSelfServiceModule(verified.propertyId);
      return handleGuestMessage({ channel: "web", propertyId: verified.propertyId, token, text: body.text, ...(body.conversationId ? { conversationId: body.conversationId } : {}), ...(body.language ? { language: body.language } : {}), correlationId: createId("corr") });
    })
  );

  app.post("/guest-portal/check-in/kiosk/claim", CLAIM_OPTIONS, async (request) => {
    const body = parseOr400(KioskClaimSchema, request.body ?? {}, "Código de emparejamiento");
    // Corrector SEC-7: el gate de módulo se comprueba sobre el dispositivo resuelto ANTES de consumir el código
    // (antes el claim quemaba el código y dejaba el kiosco online con un token que nadie recibía).
    return claimPairing(body.code, new Date(), { gate: (device) => requireSelfServiceModule(device.propertyId) });
  });

  // ── Personal ───────────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/check-in/arrivals", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(ArrivalsQuerySchema, request.query ?? {}, "Consulta de llegadas");
    return listArrivals({ propertyId, ...(query.date ? { date: query.date } : {}) });
  });

  app.post("/properties/:propertyId/check-in/sessions", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    await requireSelfServiceModule(propertyId);
    const body = parseOr400(SessionCreateSchema, request.body ?? {}, "Invitación al check-in");
    await assertEntityAccess(request, { entity: "reservation", id: body.reservationId, propertyId });
    return inviteReservation({ reservationId: body.reservationId, channel: body.channel, context: request.userContext, correlationId: createId("corr") });
  });

  app.get("/properties/:propertyId/check-in/sessions/:id", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "checkInSession", id, propertyId });
    return getSessionById(id);
  });

  app.post("/properties/:propertyId/check-in/sessions/:id/resend", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await requireSelfServiceModule(propertyId);
    await assertEntityAccess(request, { entity: "checkInSession", id, propertyId });
    const body = parseOr400(ResendSchema, request.body ?? {}, "Reenvío de la invitación");
    const session = await getSessionById(id);
    const channel = body.channel ?? (session.channel === "email" || session.channel === "whatsapp" || session.channel === "sms" ? session.channel : "email");
    return inviteReservation({ reservationId: session.reservationId, channel, context: request.userContext, correlationId: createId("corr") });
  });

  app.get("/properties/:propertyId/check-in/policy", async (request) => getPolicy((request.params as PropertyParams).propertyId));

  app.put("/properties/:propertyId/check-in/policy", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const patch = parseOr400(PolicyPutSchema, request.body ?? {}, "Política de check-in");
    return upsertPolicy({ context: request.userContext, propertyId, patch, correlationId: createId("corr") });
  });

  app.get("/properties/:propertyId/kiosks", async (request) => listDevices((request.params as PropertyParams).propertyId));

  app.post("/properties/:propertyId/kiosks", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(KioskCreateSchema, request.body ?? {}, "Kiosco");
    const device = await createDevice({ context: request.userContext, propertyId, input: body, correlationId: createId("corr") });
    reply.code(201);
    return device;
  });

  app.patch("/properties/:propertyId/kiosks/:id", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "kioskDevice", id, propertyId });
    const patch = parseOr400(KioskPatchSchema, request.body ?? {}, "Kiosco");
    return patchDevice({ context: request.userContext, propertyId, deviceId: id, patch, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/kiosks/:id/pair", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "kioskDevice", id, propertyId });
    return startPairing({ context: request.userContext, propertyId, deviceId: id, correlationId: createId("corr") });
  });

  // ── W3-A · recepción sobre la reserva (/reservations/:id/check-in/*) ─────────
  app.get("/reservations/:id/check-in", async (request) => {
    const params = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    return reservationCheckInView(params.id);
  });

  app.post("/reservations/:id/check-in/scan", DOCUMENT_OPTIONS, async (request) => {
    const params = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: params.id }, select: { propertyId: true } });
    const body = parseOr400(DocumentCaptureSchema, request.body ?? {}, "Documento de identidad");
    if (body.checkInGuestId) {
      const guest = await prisma.checkInGuest.findUnique({ where: { id: body.checkInGuestId }, select: { session: { select: { reservationId: true } } } });
      if (!guest || guest.session.reservationId !== params.id) throw new NotFoundError("Viajero del check-in no encontrado.");
    }
    return captureDocument({
      context: request.userContext,
      propertyId: reservation.propertyId,
      ...(body.checkInGuestId ? { checkInGuestId: body.checkInGuestId } : {}),
      ...(body.imageDataUrl ? { imageDataUrl: body.imageDataUrl } : {}),
      hints: { ...(body.documentType ? { documentType: body.documentType } : {}), ...(body.mrzLines ? { mrzLines: body.mrzLines } : {}) },
      correlationId: createId("corr")
    });
  });

  app.post("/reservations/:id/check-in/signature", async (request, reply) => {
    const params = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const body = parseOr400(StaffSignatureSchema, request.body ?? {}, "Firma");
    if (!body.checkInGuestId && !body.guestRegisterRecordId) throw new BadRequestError("Se necesita checkInGuestId o guestRegisterRecordId.");
    const session = await prisma.checkInSession.findUnique({ where: { reservationId: params.id }, select: { id: true, guests: { select: { id: true, guestRegisterRecordId: true } } } });
    if (body.checkInGuestId && !session?.guests.some((guest) => guest.id === body.checkInGuestId)) throw new NotFoundError("Viajero del check-in no encontrado.");
    // Corrector REV3-04: el viajero firmado en el mostrador puede no tener parte todavía (sesión que el huésped no cerró):
    // se crea desde sus datos completos (409 CHECKIN_INCOMPLETE { missing } si faltan) antes de firmar.
    if (body.checkInGuestId && session && !session.guests.find((guest) => guest.id === body.checkInGuestId)?.guestRegisterRecordId) {
      const header = await prisma.checkInSession.findUniqueOrThrow({ where: { id: session.id } });
      const guests = await prisma.checkInGuest.findMany({ where: { sessionId: session.id }, orderBy: { ordinal: "asc" } });
      await ensureGuestRegisterRecordsForSession({ session: { ...header, guests }, context: request.userContext, correlationId: createId("corr"), onlyMissing: true });
    }
    if (body.guestRegisterRecordId) {
      const record = await prisma.guestRegisterRecord.findUnique({ where: { id: body.guestRegisterRecordId }, select: { reservationId: true } });
      if (!record || record.reservationId !== params.id) throw new NotFoundError("Parte de viajeros no encontrado.");
    }
    const userAgent = userAgentOf(request);
    const result = await signGuest({
      context: request.userContext,
      ...(body.checkInGuestId ? { checkInGuestId: body.checkInGuestId } : {}),
      ...(body.guestRegisterRecordId ? { guestRegisterRecordId: body.guestRegisterRecordId } : {}),
      pngBase64: body.pngBase64,
      ...(body.svg ? { svg: body.svg } : {}),
      strokeMeta: body.strokeMeta,
      method: "touch_reception",
      ip: request.ip,
      ...(userAgent ? { userAgent } : {}),
      ...(session ? { sessionId: session.id } : {}),
      correlationId: createId("corr")
    });
    reply.code(result.idempotent ? 200 : 201);
    return result;
  });

  app.post("/reservations/:id/check-in/verify-identity", async (request) => {
    const params = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const body = parseOr400(VerifyIdentitySchema, request.body ?? {}, "Verificación de identidad");
    const guest = await prisma.checkInGuest.findUnique({ where: { id: body.checkInGuestId }, include: { session: { select: { id: true, organizationId: true, propertyId: true, reservationId: true } } } });
    if (!guest || guest.session.reservationId !== params.id) throw new NotFoundError("Viajero del check-in no encontrado.");
    const correlationId = createId("corr");
    const context = request.userContext;
    const record = guest.guestRegisterRecordId ? await markGuestRegisterIdentityVerified({ context, recordId: guest.guestRegisterRecordId, method: body.method, correlationId }) : null;
    const now = new Date();
    const status = guest.status === "signed" || guest.status === "verified" ? "verified" : guest.status;
    const updated = await prisma.checkInGuest.update({
      where: { id: guest.id },
      data: { identityVerificationMethod: body.method, identityVerifiedAt: now, identityVerifiedBy: context.userId, status }
    });
    recordAuditEvent({
      organizationId: guest.session.organizationId,
      propertyId: guest.session.propertyId,
      actorUserId: context.userId,
      actorType: "user",
      action: "CHECKIN_IDENTITY_VERIFIED",
      entityType: "checkin_guest",
      entityId: guest.id,
      beforeJson: { method: guest.identityVerificationMethod, verifiedAt: guest.identityVerifiedAt?.toISOString() ?? null, status: guest.status },
      afterJson: { method: body.method, verifiedAt: now.toISOString(), status, guestRegisterRecordId: guest.guestRegisterRecordId ?? null },
      deviceId: context.deviceId,
      correlationId
    });
    return { guest: toGuestDto(updated), guestRegisterRecord: record ? { id: record.id, identityVerified: record.identityVerified ?? true, identityVerificationMethod: record.identityVerificationMethod ?? body.method, status: record.status } : null };
  });

  app.post("/reservations/:id/check-in/complete", async (request) => {
    const params = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const body = parseOr400(CompleteCheckInSchema, request.body ?? {}, "Check-in");
    const input = {
      actor: "user" as const,
      context: request.userContext,
      reservationId: params.id,
      roomId: body.roomId ?? null,
      verification: body.verification ? { method: body.verification.method ?? null } : null,
      ...(body.allowEarlyCheckIn ? { allowEarlyCheckIn: true, overrideReason: body.overrideReason } : {}),
      correlationId: createId("corr")
    };
    // Corrector REV3-03: `dryRun` comprueba las precondiciones sin asignar, cobrar ni alojar (el cajón lo llama antes del cobro).
    return body.dryRun ? precheckCheckIn(input) : completeCheckIn(input);
  });

  // Corrector REV3-04: recepción corrige viajeros (guest_register.edit) y resuelve derivaciones (pms.checkin.execute).
  app.patch("/reservations/:id/check-in/guests/:guestId", async (request) => {
    const params = request.params as { id: string; guestId: string };
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const body = parseOr400(GuestInputSchema, request.body ?? {}, "Viajero");
    return updateGuestByStaff({ context: request.userContext, reservationId: params.id, checkInGuestId: params.guestId, input: body, correlationId: createId("corr") });
  });

  app.post("/reservations/:id/check-in/resolve-handoff", async (request) => {
    const params = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const body = parseOr400(ResolveHandoffSchema, request.body ?? {}, "Derivación");
    return resolveHandoff({ context: request.userContext, reservationId: params.id, note: body.note ?? null, correlationId: createId("corr") });
  });
}
