// OTP de verificación de identidad del huésped (Tanda CHK · lote W3-A; diseño
// §4c «Verificar identidad» móvil: `otp_email` / `otp_phone` si la política lo
// admite; §7.1 POST /guest-portal/check-in/otp/request · …/otp/verify; §7.3
// «OTP y códigos de emparejamiento como hash con TTL»).
//
//   · requestOtp({ token, channel }): sesión por token opaco → método otp_<canal>
//     admitido por allowedVerificationMethods (si no, 409 OTP_METHOD_NOT_ALLOWED)
//     → destinatario del titular (correo del viajero o bookerEmail; móvil del
//     viajero) → código de 6 dígitos (randomInt) del que SOLO se guarda el hash
//     sha256(sessionId:código) con caducidad CHECKIN_OTP_TTL_MS y el contador de
//     intentos en CheckInSession.consentJson.otp (Json existente; nunca en claro)
//     → envío por `dispatch` con la plantilla de sistema checkin_otp (email o
//     sms; sin proveedor el dispatcher lo marca SIMULADO y se dice). Un segundo
//     request antes de OTP_RESEND_COOLDOWN_MS responde 429 OTP_RATE_LIMITED.
//     Fuera de producción y SOLO con HOTELOS_ALLOW_DEMO_AUTH=true la respuesta
//     incluye `debugCode` (demos/tests sin proveedor).
//   · verifyOtp({ token, code }): sin OTP pendiente / caducado / distinto → 409
//     OTP_INVALID; al alcanzar CHECKIN_OTP_MAX_ATTEMPTS → 429 OTP_RATE_LIMITED
//     (el contador persiste hasta que se pide un código nuevo). Acierto → titular
//     identityVerificationMethod otp_<canal>, identityVerifiedAt, identityVerifiedBy
//     guest:<sessionId> y status `verified` SOLO si la política sigue admitiendo el
//     método; el parte (si existe) recibe markGuestRegisterIdentityVerified con el
//     contexto de servicio; el OTP se borra del Json.
//
// Dependencias inyectables (OtpDeps) para __tests__/otp.test.mts (TTL, intentos,
// hash) sin Prisma ni dispatcher.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { IdentityVerificationMethod } from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { markGuestRegisterIdentityVerified } from "../compliance/compliance.service.js";
import { verifyGuestToken } from "../guest-portal/guest-portal-auth.service.js";
import { GuestPortalAuthError } from "../guest-portal/guest-portal.service.js";
import { dispatch, type DispatchInput } from "../notifications/dispatcher.service.js";
import { readCheckInConfig, type CheckInConfig } from "./checkin-config.js";
import { getPolicy } from "./checkin-policy.service.js";
import { GUEST_SESSION_INVALID_MESSAGE, maskRecipient } from "./checkin-session.service.js";
import { checkInServiceContext } from "./service-context.js";

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

export const OTP_TEMPLATE_CODE = "checkin_otp";
export const OTP_LENGTH = 6;
/** Tiempo mínimo entre dos peticiones de código para la misma sesión. */
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_JSON_KEY = "otp";

export type OtpChannel = "email" | "phone";
export type OtpMethod = Extract<IdentityVerificationMethod, "otp_email" | "otp_phone">;

/** Estado persistido en CheckInSession.consentJson.otp (solo hash, nunca el código). */
export type OtpState = {
  channel: OtpChannel;
  hash: string;
  requestedAt: string;
  expiresAt: string;
  attempts: number;
  /** Destinatario enmascarado (respuestas y auditoría). */
  recipient: string;
};

export type OtpSessionRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  status: string;
  consentJson: unknown;
  guests: Array<{ id: string; isPrimary: boolean; guestRegisterRecordId: string | null; status: string; firstName: string | null; email: string | null; phoneMobile: string | null }>;
};

export type OtpDeps = {
  now: () => Date;
  createId: (prefix: string) => string;
  config: () => Pick<CheckInConfig, "otpTtlMs" | "otpMaxAttempts">;
  /** Código de 6 dígitos (inyectable en tests). */
  generateCode: () => string;
  env: () => { nodeEnv: string | undefined; allowDemoAuth: boolean };
  verifyGuestToken: (token: string | null | undefined) => Promise<{ reservationId: string; propertyId: string } | null>;
  loadSession: (reservationId: string) => Promise<OtpSessionRow | null>;
  loadReservationContact: (reservationId: string) => Promise<{ bookerEmail: string | null } | null>;
  loadPropertyName: (propertyId: string) => Promise<string | null>;
  loadAllowedMethods: (propertyId: string) => Promise<string[]>;
  serviceContext: (propertyId: string, sessionId: string) => Promise<UserContext>;
  saveOtpState: (sessionId: string, consentJson: Record<string, unknown>) => Promise<unknown>;
  dispatch: (input: DispatchInput) => Promise<{ id: string; status: string; errorMessage?: string | null }>;
  markGuestVerified: (checkInGuestId: string, data: { identityVerificationMethod: string; identityVerifiedAt: Date; identityVerifiedBy: string; status?: string }) => Promise<unknown>;
  markGuestRegisterIdentityVerified: typeof markGuestRegisterIdentityVerified;
  recordAuditEvent: typeof recordAuditEvent;
};

export type RequestOtpResult = {
  sessionId: string;
  channel: OtpChannel;
  method: OtpMethod;
  recipient: string;
  expiresAt: string;
  dispatched: boolean;
  simulated: boolean;
  deliveryId: string | null;
  reason: string | null;
  /** Solo fuera de producción con HOTELOS_ALLOW_DEMO_AUTH=true. */
  debugCode?: string;
};

export type VerifyOtpResult = {
  sessionId: string;
  checkInGuestId: string;
  method: OtpMethod;
  verifiedAt: string;
  /** false si la política dejó de admitir el método entre request y verify: queda el método y la fecha, no el estado verified. */
  policyAllowed: boolean;
  guestStatus: string;
  guestRegisterRecordId: string | null;
};

// ---------------------------------------------------------------------------
// Dependencias por defecto e inyección para tests
// ---------------------------------------------------------------------------

function defaultDeps(): OtpDeps {
  return {
    now: () => new Date(),
    createId,
    config: () => readCheckInConfig(),
    generateCode: generateOtpCode,
    env: () => ({ nodeEnv: process.env.NODE_ENV, allowDemoAuth: process.env.HOTELOS_ALLOW_DEMO_AUTH === "true" }),
    verifyGuestToken,
    // Viajeros por consulta DE PRIMER NIVEL: la extensión de cifrado solo descifra el
    // modelo consultado (email / phoneMobile llegarían cifrados por `select` anidado).
    loadSession: async (reservationId) => {
      const session = await prisma.checkInSession.findUnique({ where: { reservationId }, select: { id: true, organizationId: true, propertyId: true, reservationId: true, status: true, consentJson: true } });
      if (!session) return null;
      const guests = await prisma.checkInGuest.findMany({ where: { sessionId: session.id }, orderBy: { ordinal: "asc" }, select: { id: true, isPrimary: true, guestRegisterRecordId: true, status: true, firstName: true, email: true, phoneMobile: true } });
      return { ...session, guests };
    },
    loadReservationContact: (reservationId) => prisma.reservation.findUnique({ where: { id: reservationId }, select: { bookerEmail: true } }),
    loadPropertyName: async (propertyId) => (await prisma.property.findUnique({ where: { id: propertyId }, select: { name: true } }))?.name ?? null,
    loadAllowedMethods: async (propertyId) => (await getPolicy(propertyId)).allowedVerificationMethods,
    serviceContext: (propertyId, sessionId) => checkInServiceContext(propertyId, { kind: "guest", sessionId }),
    saveOtpState: (sessionId, consentJson) => prisma.checkInSession.update({ where: { id: sessionId }, data: { consentJson: consentJson as Prisma.InputJsonValue }, select: { id: true } }),
    dispatch,
    markGuestVerified: (checkInGuestId, data) => prisma.checkInGuest.update({ where: { id: checkInGuestId }, data, select: { id: true } }),
    markGuestRegisterIdentityVerified,
    recordAuditEvent
  };
}

let overrides: Partial<OtpDeps> | null = null;
function currentDeps(): OtpDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}
/** Sustituye dependencias (tests sin Prisma). Sin argumento restaura las reales. */
export function resetOtpServiceForTests(deps?: Partial<OtpDeps>): void {
  overrides = deps ?? null;
}

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los tests)
// ---------------------------------------------------------------------------

/** Código numérico de OTP_LENGTH dígitos con ceros a la izquierda. */
export function generateOtpCode(randomInteger: (exclusiveMax: number) => number = (max) => randomInt(0, max)): string {
  return String(randomInteger(10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

export function normalizeOtpCode(code: string): string {
  return code.replace(/\D/g, "");
}

/** sha256(sessionId:código): el hash queda ligado a la sesión (un mismo código no vale para otra). */
export function hashOtp(sessionId: string, code: string): string {
  return createHash("sha256").update(`${sessionId}:${normalizeOtpCode(code)}`, "utf8").digest("hex");
}

export function otpMethodFor(channel: OtpChannel): OtpMethod {
  return channel === "email" ? "otp_email" : "otp_phone";
}

export function otpStateFrom(consentJson: unknown): OtpState | null {
  const source = consentJson && typeof consentJson === "object" && !Array.isArray(consentJson) ? (consentJson as Record<string, unknown>) : {};
  const raw = source[OTP_JSON_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const otp = raw as Record<string, unknown>;
  if ((otp.channel !== "email" && otp.channel !== "phone") || typeof otp.hash !== "string" || typeof otp.expiresAt !== "string" || typeof otp.requestedAt !== "string") return null;
  return {
    channel: otp.channel,
    hash: otp.hash,
    requestedAt: otp.requestedAt,
    expiresAt: otp.expiresAt,
    attempts: typeof otp.attempts === "number" && Number.isFinite(otp.attempts) ? otp.attempts : 0,
    recipient: typeof otp.recipient === "string" ? otp.recipient : "***"
  };
}

/** consentJson con el OTP sustituido (o retirado con `state` null); no toca las demás claves. */
export function withOtpState(consentJson: unknown, state: OtpState | null): Record<string, unknown> {
  const source = consentJson && typeof consentJson === "object" && !Array.isArray(consentJson) ? { ...(consentJson as Record<string, unknown>) } : {};
  if (state) source[OTP_JSON_KEY] = state;
  else delete source[OTP_JSON_KEY];
  return source;
}

export function isOtpExpired(state: Pick<OtpState, "expiresAt">, now: Date): boolean {
  const expires = new Date(state.expiresAt).getTime();
  return Number.isNaN(expires) || expires <= now.getTime();
}

export type OtpVerdict = { ok: true } | { ok: false; reason: "not_requested" | "expired" | "rate_limited" | "mismatch"; attempts: number };

/**
 * Veredicto PURO de un intento: sin OTP → not_requested; caducado → expired;
 * intentos agotados → rate_limited (antes de comparar, para no dar oráculo);
 * hash distinto (comparación en tiempo constante) → mismatch con el contador ya
 * incrementado; igual → ok.
 */
export function evaluateOtp(input: { state: OtpState | null; sessionId: string; code: string; now: Date; maxAttempts: number }): OtpVerdict {
  if (!input.state) return { ok: false, reason: "not_requested", attempts: 0 };
  if (isOtpExpired(input.state, input.now)) return { ok: false, reason: "expired", attempts: input.state.attempts };
  if (input.state.attempts >= input.maxAttempts) return { ok: false, reason: "rate_limited", attempts: input.state.attempts };
  const expected = Buffer.from(input.state.hash, "hex");
  const actual = Buffer.from(hashOtp(input.sessionId, input.code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "mismatch", attempts: input.state.attempts + 1 };
  return { ok: true };
}

function normalizePhone(value: string | null | undefined): string {
  const compact = (value ?? "").replace(/[\s().-]/g, "");
  if (!compact) return "";
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

async function requireSession(deps: OtpDeps, token: string | null | undefined): Promise<OtpSessionRow> {
  const verified = await deps.verifyGuestToken(token);
  if (!verified || !verified.reservationId) throw new GuestPortalAuthError(GUEST_SESSION_INVALID_MESSAGE);
  const session = await deps.loadSession(verified.reservationId);
  if (!session || session.propertyId !== verified.propertyId) throw new GuestPortalAuthError(GUEST_SESSION_INVALID_MESSAGE);
  return session;
}

function primaryOf(session: OtpSessionRow): OtpSessionRow["guests"][number] {
  const primary = session.guests.find((guest) => guest.isPrimary) ?? session.guests[0];
  if (!primary) throw new NotFoundError("Viajero no encontrado.");
  return primary;
}

export async function requestOtp(input: { token: string | null | undefined; channel: OtpChannel; correlationId?: string }): Promise<RequestOtpResult> {
  const deps = currentDeps();
  const session = await requireSession(deps, input.token);
  if (session.status === "checked_in" || session.status === "expired" || session.status === "cancelled") {
    throw new ConflictError("La sesión de check-in ya no admite verificación por OTP.", { code: "OTP_INVALID", reason: "session_closed", status: session.status });
  }
  const method = otpMethodFor(input.channel);
  const allowed = await deps.loadAllowedMethods(session.propertyId);
  if (!allowed.includes(method)) {
    throw new ConflictError(`La propiedad no admite la verificación por ${input.channel === "email" ? "correo" : "móvil"} (${method}).`, { code: "OTP_METHOD_NOT_ALLOWED", method, allowedMethods: allowed });
  }
  const now = deps.now();
  const previous = otpStateFrom(session.consentJson);
  if (previous && !isOtpExpired(previous, now) && now.getTime() - new Date(previous.requestedAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new HttpError(429, "Ya se ha enviado un código hace menos de un minuto; espera antes de pedir otro.", true, { code: "OTP_RATE_LIMITED", retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - (now.getTime() - new Date(previous.requestedAt).getTime())) / 1000) });
  }

  const primary = primaryOf(session);
  let recipient = "";
  if (input.channel === "email") {
    recipient = (primary.email ?? "").trim() || ((await deps.loadReservationContact(session.reservationId))?.bookerEmail ?? "").trim();
  } else {
    recipient = normalizePhone(primary.phoneMobile);
  }
  if (!recipient) throw new BadRequestError(input.channel === "email" ? "El titular no tiene correo electrónico: usa otro método de verificación." : "El titular no tiene móvil: usa otro método de verificación.");

  const config = deps.config();
  const code = deps.generateCode();
  const expiresAt = new Date(now.getTime() + config.otpTtlMs);
  const state: OtpState = { channel: input.channel, hash: hashOtp(session.id, code), requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), attempts: 0, recipient: maskRecipient(recipient) };
  await deps.saveOtpState(session.id, withOtpState(session.consentJson, state));

  const correlationId = input.correlationId ?? deps.createId("corr");
  const context = await deps.serviceContext(session.propertyId, session.id);
  const propertyName = (await deps.loadPropertyName(session.propertyId)) ?? "";
  const result: RequestOtpResult = { sessionId: session.id, channel: input.channel, method, recipient: state.recipient, expiresAt: state.expiresAt, dispatched: false, simulated: false, deliveryId: null, reason: null };
  try {
    const delivery = await deps.dispatch({
      organizationId: session.organizationId,
      propertyId: session.propertyId,
      templateCode: OTP_TEMPLATE_CODE,
      channel: input.channel === "email" ? "email" : "sms",
      recipient,
      language: "es",
      notificationId: `checkin_otp:${session.id}:${now.getTime()}`,
      variables: { guestFirstName: primary.firstName ?? "", propertyName, otpCode: code },
      // Corrector SEC-1: el código solo viaja al proveedor; la fila de notification_deliveries queda sin él.
      redact: { variables: ["otpCode"], values: [code] }
    });
    result.dispatched = delivery.status === "sent";
    result.simulated = typeof delivery.errorMessage === "string" && delivery.errorMessage.startsWith("SIMULADO");
    result.deliveryId = delivery.id;
    if (!result.dispatched) result.reason = delivery.errorMessage ?? delivery.status;
  } catch (error) {
    if (error instanceof Error && error.message === "template_not_found") result.reason = "template_not_found";
    else throw error;
  }
  const env = deps.env();
  if (env.nodeEnv !== "production" && env.allowDemoAuth) result.debugCode = code;

  deps.recordAuditEvent({
    organizationId: session.organizationId,
    propertyId: session.propertyId,
    actorUserId: context.userId,
    actorType: "system",
    action: "CHECKIN_OTP_REQUESTED",
    entityType: "checkin_session",
    entityId: session.id,
    // Nunca el código ni el destinatario completo.
    afterJson: { channel: input.channel, method, recipient: state.recipient, expiresAt: state.expiresAt, dispatched: result.dispatched, simulated: result.simulated, reason: result.reason },
    deviceId: context.deviceId,
    correlationId
  });
  return result;
}

export async function verifyOtp(input: { token: string | null | undefined; code: string; correlationId?: string }): Promise<VerifyOtpResult> {
  const deps = currentDeps();
  const session = await requireSession(deps, input.token);
  const now = deps.now();
  const state = otpStateFrom(session.consentJson);
  const verdict = evaluateOtp({ state, sessionId: session.id, code: input.code, now, maxAttempts: deps.config().otpMaxAttempts });
  const correlationId = input.correlationId ?? deps.createId("corr");
  const context = await deps.serviceContext(session.propertyId, session.id);
  const audit = (action: string, afterJson: Record<string, unknown>) =>
    deps.recordAuditEvent({ organizationId: session.organizationId, propertyId: session.propertyId, actorUserId: context.userId, actorType: "system", action, entityType: "checkin_session", entityId: session.id, afterJson, deviceId: context.deviceId, correlationId });

  if (!verdict.ok) {
    if (verdict.reason === "mismatch" && state) await deps.saveOtpState(session.id, withOtpState(session.consentJson, { ...state, attempts: verdict.attempts }));
    const maxAttempts = deps.config().otpMaxAttempts;
    audit("CHECKIN_OTP_FAILED", { reason: verdict.reason, attempts: verdict.attempts, maxAttempts });
    if (verdict.reason === "rate_limited" || (verdict.reason === "mismatch" && verdict.attempts >= maxAttempts)) {
      throw new HttpError(429, "Demasiados intentos de código: pide uno nuevo o verifica tu identidad en recepción.", true, { code: "OTP_RATE_LIMITED", attempts: verdict.attempts, maxAttempts });
    }
    const message = verdict.reason === "not_requested" ? "No hay ningún código pendiente: pide uno primero." : verdict.reason === "expired" ? "El código ha caducado: pide uno nuevo." : "El código no es correcto.";
    throw new ConflictError(message, { code: "OTP_INVALID", reason: verdict.reason, attempts: verdict.attempts, attemptsLeft: Math.max(0, maxAttempts - verdict.attempts) });
  }

  const method = otpMethodFor(state!.channel);
  const allowed = await deps.loadAllowedMethods(session.propertyId);
  const policyAllowed = allowed.includes(method);
  const primary = primaryOf(session);
  const guestStatus = policyAllowed ? "verified" : primary.status;
  await deps.markGuestVerified(primary.id, { identityVerificationMethod: method, identityVerifiedAt: now, identityVerifiedBy: context.userId, ...(policyAllowed ? { status: "verified" } : {}) });
  if (primary.guestRegisterRecordId && policyAllowed) {
    await deps.markGuestRegisterIdentityVerified({ context, recordId: primary.guestRegisterRecordId, method, correlationId });
  }
  await deps.saveOtpState(session.id, withOtpState(session.consentJson, null));
  audit("CHECKIN_OTP_VERIFIED", { checkInGuestId: primary.id, method, policyAllowed, guestStatus, guestRegisterRecordId: primary.guestRegisterRecordId ?? null });
  return { sessionId: session.id, checkInGuestId: primary.id, method, verifiedAt: now.toISOString(), policyAllowed, guestStatus, guestRegisterRecordId: primary.guestRegisterRecordId ?? null };
}
