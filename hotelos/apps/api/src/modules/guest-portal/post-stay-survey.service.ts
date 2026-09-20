// Encuesta post-estancia (Tanda L7 · lote L7-04, 2026-09-20; recon §19.7,
// docs/design/REPUTACION-REVIEWS.md §6.4, audit T8 decisión 14).
//
// Tres piezas, todas con dependencias inyectables (tests sin base de datos en
// __tests__/post-stay-survey.test.mts):
//
//   1. runPostStaySurveyStep(deps, clock, options?) — paso INDEPENDIENTE del tick
//      del líder del check-in (checkin/checkin-jobs.ts · runTickWork, con su propio
//      try/catch y `summary.postStaySurvey`). Ámbito: propiedades con
//      `postStaySurveyEnabled` (property_checkin_policies) → reservas `checked_out`
//      no borradas con `departureDate` en la ventana [hoy − 3 d, día local de
//      (ahora − postStaySurveyDelayHours)] → titular (ReservationGuest isPrimary)
//      con correo (o bookerEmail) y consentimiento (consent.gdprAt de
//      CheckInSession.consentJson, o Guest.gdprConsentFlags.marketing /
//      Guest.marketingConsent no negados) → GuestPortalSession de 30 días
//      (issueGuestPortalSession) → dispatch de la plantilla `post_stay_survey`
//      por correo con notificationId `post_stay_survey:<reservationId>` y el token
//      REDACTADO en la fila (dispatcher `redact`). Idempotente: una entrega por
//      reserva (comprobación previa en notification_deliveries + idempotencia
//      del dispatcher por notificationId). Sin proveedor de correo la entrega
//      queda «SIMULADO» (status sent + errorMessage SIMULADO…): nunca un envío
//      ficticio. Con `options.reservationId` (POST /reservations/:id/post-stay/
//      survey-invite) se fuerza una reserva: ignora política y ventana, exige
//      checked_out (409 RESERVATION_NOT_CHECKED_OUT) y devuelve `surveyUrl` SOLO
//      si el envío fue simulado (alguien tiene que hacer llegar el enlace).
//   2. getGuestSurveyView(session)   — GET /guest-portal/survey: cuestionario de la
//      Survey `post_stay` activa de la propiedad (o el cuestionario por defecto),
//      answered/answeredAt y `available` (solo reserva checked_out en post_stay,
//      corrector REV-L7-02); la sesión `survey` del enlace solo abre esta ruta
//      (corrector L7-REV-01), por eso la vista lleva la cabecera de la reserva.
//   3. submitGuestSurvey({ session, body }) — POST /guest-portal/survey: crea la
//      Survey por defecto si no existe, una SurveyResponse por reserva (409
//      SURVEY_ALREADY_ANSWERED), `score` en columna (regla NPS de
//      dashboards/surveys.service.ts) y auditoría SurveyResponseReceived sin texto
//      libre. 409 SURVEY_NOT_AVAILABLE fuera de post_stay.
//
// Privacidad: el token nunca se persiste ni se audita; las auditorías llevan el
// destinatario enmascarado (maskRecipient) y las claves de las respuestas, no
// su contenido.

import { prisma, type Prisma } from "@hotelos/database";
import {
  DEFAULT_GUEST_SURVEY_NAME,
  DEFAULT_GUEST_SURVEY_QUESTIONS,
  GUEST_SURVEY_QUESTION_TYPES,
  type GuestSurveyDto,
  type GuestSurveyQuestion,
  type GuestSurveyQuestionType,
  type GuestSurveySubmitInput,
  type GuestSurveySubmitResult,
  type GuestStayStage,
  type GuestSurveyView,
  type PostStaySurveyInviteResult
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import type { LocalClock } from "../checkin/checkin-jobs.js";
import { consentFromJson, maskRecipient } from "../checkin/checkin-session.service.js";
import { CHECKIN_SERVICE_DEVICE_ID, serviceUserId } from "../checkin/service-context.js";
import { dispatch, type DispatchInput, type NotificationDeliveryRecord } from "../notifications/dispatcher.service.js";
import { POST_STAY_SURVEY_SESSION_TTL_MS, issueGuestPortalSession, type IssuedGuestPortalSession, type VerifiedGuestSession } from "./guest-portal-auth.service.js";
import { POST_STAY_SURVEY_NOTIFICATION_PREFIX, localDateIn, stageOf } from "./guest-stay.service.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Código de la plantilla de sistema (notifications/system-templates.ts). */
export const POST_STAY_SURVEY_TEMPLATE = "post_stay_survey";
/** `Survey.surveyType` de la encuesta post-estancia (mismo valor que el editor del back office). */
export const POST_STAY_SURVEY_TYPE = "post_stay";
/** Canal de la invitación automática: solo correo (D1: «solo huéspedes con correo»). */
export const POST_STAY_SURVEY_CHANNEL = "email";
/** Días hacia atrás desde hoy que el paso revisa (catch-up tras un tick perdido). */
export const POST_STAY_SURVEY_LOOKBACK_DAYS = 3;
/** Zona del tick del check-in (CHECKIN_JOBS_TIMEZONE; duplicada aquí para no importar checkin-jobs en runtime). */
export const POST_STAY_SURVEY_TIMEZONE = "Europe/Madrid";
/** Base del portal cuando GUEST_WEB_BASE_URL no está definida (misma que checkin-session.service.ts). */
export const DEFAULT_GUEST_WEB_BASE_URL = "http://localhost:5174";
/** Acción de auditoría de cada invitación (invitada, omitida o fallida). */
export const POST_STAY_SURVEY_AUDIT_ACTION = "PostStaySurveyInvited";
/** Acción de auditoría de una respuesta del portal (misma que POST /surveys/:id/responses). */
export const SURVEY_RESPONSE_AUDIT_ACTION = "SurveyResponseReceived";
/** Actor sintético del paso del tick: `system:checkin:post_stay_survey`. */
export const POST_STAY_SURVEY_ACTOR = { kind: "system", job: "post_stay_survey" } as const;
export const SURVEY_ANSWER_MAX_KEYS = 20;
export const SURVEY_ANSWER_TEXT_MAX = 2000;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

/** YYYY-MM-DD + n días (aritmética UTC sobre la fecha civil; igual que checkin-jobs.addDays). */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Fecha civil → instante que Prisma compara con columnas @db.Date. */
export function civilDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export type SurveyWindow = { from: string; to: string };

/**
 * Ventana de salidas que toca invitar: `to` = día local de (ahora − delayHours)
 * —la invitación sale cuando han pasado `delayHours` desde las 00:00 del día de
 * salida—, `from` = hoy − 3 días (catch-up). Con delay 24 h y tick a las 10:00
 * del día 20, `to` = día 19: se invita a quien salió ayer o antes (≤ 3 días).
 */
export function surveyWindowFor(now: Date, today: string, delayHours: number, timeZone: string): SurveyWindow {
  const delay = Number.isFinite(delayHours) ? Math.max(0, delayHours) : 24;
  return { from: shiftDay(today, -POST_STAY_SURVEY_LOOKBACK_DAYS), to: localDateIn(new Date(now.getTime() - delay * HOUR_MS), timeZone) };
}

/** true si el día de salida (YYYY-MM-DD) cae dentro de la ventana (inclusive). */
export function isDepartureDue(departureDay: string, window: SurveyWindow): boolean {
  return window.from <= departureDay && departureDay <= window.to;
}

export type SurveyConsentSource = {
  /** CheckInSession.consentJson (null sin sesión de check-in). */
  sessionConsentJson: unknown;
  /** Guest.gdprConsentFlags */
  guestFlags: unknown;
  /** Guest.marketingConsent */
  guestMarketingConsent: boolean | null | undefined;
};

export type SurveyConsent = { ok: boolean; basis: "gdpr_consent" | "not_refused" | "refused" };

/**
 * Consentimiento para invitar (recon §19.7): el consentimiento RGPD firmado en el
 * check-in (consentJson.gdprAt) basta; sin él, basta que el huésped no haya
 * negado el marketing (gdprConsentFlags.marketing !== false y marketingConsent !== false).
 */
export function surveyConsentOf(source: SurveyConsentSource): SurveyConsent {
  if (consentFromJson(source.sessionConsentJson).gdprAt) return { ok: true, basis: "gdpr_consent" };
  const flags = source.guestFlags && typeof source.guestFlags === "object" && !Array.isArray(source.guestFlags) ? (source.guestFlags as Record<string, unknown>) : {};
  if (flags.marketing === false || source.guestMarketingConsent === false) return { ok: false, basis: "refused" };
  return { ok: true, basis: "not_refused" };
}

/** `${base}/?survey=1&token=…&property=…` (el portal abre SurveyPage con `?survey=1`, como `wantsCheckInWizard`). */
export function buildSurveyUrl(baseUrl: string, token: string, propertyId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/?survey=1&token=${encodeURIComponent(token)}&property=${encodeURIComponent(propertyId)}`;
}

/** notificationId de la invitación: `post_stay_survey:<reservationId>` (mismo prefijo que lee GET /guest-portal/stay). */
export function surveyNotificationId(reservationId: string): string {
  return `${POST_STAY_SURVEY_NOTIFICATION_PREFIX}${reservationId}`;
}

function questionType(value: unknown, key: string): GuestSurveyQuestionType {
  if (typeof value === "string" && (GUEST_SURVEY_QUESTION_TYPES as readonly string[]).includes(value)) return value as GuestSurveyQuestionType;
  return key === "nps" ? "nps" : "text";
}

/**
 * `Survey.questionsJson` → preguntas del portal. Acepta `{ id, text }` (editor del
 * back office: SurveyEditorDrawer) y `{ key, type, label, required }`; descarta
 * entradas sin clave o sin enunciado; vacío o malformado → cuestionario por defecto.
 */
export function normalizeSurveyQuestions(value: unknown): GuestSurveyQuestion[] {
  if (!Array.isArray(value)) return DEFAULT_GUEST_SURVEY_QUESTIONS.map((question) => ({ ...question }));
  const seen = new Set<string>();
  const questions: GuestSurveyQuestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const key = typeof record.key === "string" && record.key.trim() ? record.key.trim() : typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : typeof record.text === "string" && record.text.trim() ? record.text.trim() : "";
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const type = questionType(record.type, key);
    questions.push({ key, type, label, required: typeof record.required === "boolean" ? record.required : type === "nps" });
  }
  return questions.length > 0 ? questions : DEFAULT_GUEST_SURVEY_QUESTIONS.map((question) => ({ ...question }));
}

/** true si la entrega fue simulada (dispatcher: errorMessage «SIMULADO…» con status sent). */
export function isSimulatedDelivery(delivery: Pick<NotificationDeliveryRecord, "errorMessage">): boolean {
  return typeof delivery.errorMessage === "string" && delivery.errorMessage.startsWith("SIMULADO");
}

// ---------------------------------------------------------------------------
// Paso del tick · dependencias
// ---------------------------------------------------------------------------

export type PostStaySurveyDb = Pick<typeof prisma, "propertyCheckInPolicy" | "reservation" | "reservationGuest" | "guest" | "checkInSession" | "notificationDelivery" | "property">;

export type PostStaySurveyDeps = {
  db: PostStaySurveyDb;
  now: () => Date;
  /** Zona del tick (día local de la ventana); las fechas de salida son civiles. */
  timeZone: string;
  createId: (prefix: string) => string;
  guestWebBaseUrl: () => string;
  issueSession: (input: { reservationId: string; ttlMs: number; purpose: "survey" }) => Promise<IssuedGuestPortalSession | null>;
  dispatch: (input: DispatchInput) => Promise<NotificationDeliveryRecord>;
  audit: typeof recordAuditEvent;
};

export function defaultPostStaySurveyDeps(): PostStaySurveyDeps {
  return {
    db: prisma as PostStaySurveyDb,
    now: () => new Date(),
    timeZone: POST_STAY_SURVEY_TIMEZONE,
    createId,
    guestWebBaseUrl: () => (process.env.GUEST_WEB_BASE_URL ?? DEFAULT_GUEST_WEB_BASE_URL).replace(/\/+$/, ""),
    issueSession: (input) => issueGuestPortalSession(input),
    dispatch,
    audit: recordAuditEvent
  };
}

export function withPostStaySurveyDeps(overrides?: Partial<PostStaySurveyDeps>): PostStaySurveyDeps {
  return { ...defaultPostStaySurveyDeps(), ...(overrides ?? {}) };
}

export type PostStaySurveyOutcome = PostStaySurveyInviteResult & { propertyId: string };

export type PostStaySurveyStepSummary = {
  invited: number;
  skipped: number;
  failed: number;
  /** Propiedades con la encuesta activa revisadas (1 en modo forzado). */
  properties: number;
  outcomes: PostStaySurveyOutcome[];
};

export type PostStaySurveyStepOptions = {
  /** Reserva forzada (ruta manual): ignora política y ventana; exige checked_out. */
  reservationId?: string;
  /** Actor de la auditoría en modo forzado (personal); sin él, el actor sintético del tick. */
  context?: UserContext;
  /** Devuelve `surveyUrl` en el resultado cuando el envío fue simulado (solo modo forzado). */
  includeSurveyUrl?: boolean;
};

type ReservationRow = { id: string; propertyId: string; status: string; bookerEmail: string | null; bookerName: string | null; departureDate: Date };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Paso del tick · una reserva
// ---------------------------------------------------------------------------

async function inviteReservation(d: PostStaySurveyDeps, reservation: ReservationRow, options: PostStaySurveyStepOptions): Promise<PostStaySurveyOutcome> {
  const base: PostStaySurveyOutcome = { propertyId: reservation.propertyId, reservationId: reservation.id, status: "skipped", reason: null, dispatched: false, simulated: false, channel: null, recipient: null, deliveryId: null };
  const notificationId = surveyNotificationId(reservation.id);
  const existing = await d.db.notificationDelivery.findFirst({ where: { notificationId }, select: { id: true, recipient: true, errorMessage: true } });
  if (existing) {
    return { ...base, reason: "already_invited", channel: POST_STAY_SURVEY_CHANNEL, recipient: maskRecipient(existing.recipient), simulated: isSimulatedDelivery(existing), deliveryId: existing.id };
  }
  const link =
    (await d.db.reservationGuest.findFirst({ where: { reservationId: reservation.id, isPrimary: true }, select: { guestId: true } })) ??
    (await d.db.reservationGuest.findFirst({ where: { reservationId: reservation.id }, orderBy: { id: "asc" }, select: { guestId: true } }));
  const guest = link
    ? await d.db.guest.findFirst({ where: { id: link.guestId, deletedAt: null }, select: { id: true, firstName: true, email: true, languagePreference: true, gdprConsentFlags: true, marketingConsent: true } })
    : null;
  const recipient = (guest?.email ?? reservation.bookerEmail ?? "").trim();
  if (!recipient) return { ...base, reason: "no_recipient" };
  const session = await d.db.checkInSession.findUnique({ where: { reservationId: reservation.id }, select: { consentJson: true } });
  const consent = surveyConsentOf({ sessionConsentJson: session?.consentJson ?? null, guestFlags: guest?.gdprConsentFlags ?? null, guestMarketingConsent: guest?.marketingConsent ?? null });
  if (!consent.ok) return { ...base, reason: "consent_refused", recipient: maskRecipient(recipient) };
  const property = await d.db.property.findUnique({ where: { id: reservation.propertyId }, select: { organizationId: true, name: true } });
  if (!property) return { ...base, status: "failed", reason: "property_not_found" };

  // Corrector L7-REV-01: sesión de 30 días con ámbito `survey` (solo abre GET|POST /guest-portal/survey).
  const issued = await d.issueSession({ reservationId: reservation.id, ttlMs: POST_STAY_SURVEY_SESSION_TTL_MS, purpose: "survey" });
  if (!issued) return { ...base, status: "failed", reason: "session_not_issued", recipient: maskRecipient(recipient) };
  const surveyUrl = buildSurveyUrl(d.guestWebBaseUrl(), issued.token, reservation.propertyId);
  const correlationId = d.createId("corr");
  const outcome: PostStaySurveyOutcome = { ...base, channel: POST_STAY_SURVEY_CHANNEL, recipient: maskRecipient(recipient) };
  try {
    const delivery = await d.dispatch({
      organizationId: property.organizationId,
      propertyId: reservation.propertyId,
      templateCode: POST_STAY_SURVEY_TEMPLATE,
      channel: POST_STAY_SURVEY_CHANNEL,
      recipient,
      language: guest?.languagePreference ?? "es",
      notificationId,
      variables: { guestFirstName: guest?.firstName ?? reservation.bookerName ?? "", propertyName: property.name, surveyUrl },
      // El token del enlace NUNCA se persiste en notification_deliveries (SEC-1, como checkin_invitation).
      redact: { variables: ["surveyUrl"], values: [issued.token] }
    });
    outcome.dispatched = delivery.status === "sent";
    outcome.simulated = isSimulatedDelivery(delivery);
    outcome.deliveryId = delivery.id;
    outcome.status = outcome.dispatched ? "invited" : "failed";
    outcome.reason = outcome.dispatched ? null : (delivery.errorMessage ?? delivery.status);
    if (options.includeSurveyUrl && outcome.simulated) outcome.surveyUrl = surveyUrl;
  } catch (error) {
    outcome.status = "failed";
    outcome.reason = error instanceof Error && error.message === "template_not_found" ? "template_not_found" : describeError(error);
  }
  d.audit({
    organizationId: property.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: options.context?.userId ?? serviceUserId(POST_STAY_SURVEY_ACTOR),
    actorType: options.context ? "user" : "system",
    action: POST_STAY_SURVEY_AUDIT_ACTION,
    entityType: "reservation",
    entityId: reservation.id,
    afterJson: {
      reservationId: reservation.id,
      channel: outcome.channel,
      recipient: outcome.recipient,
      dispatched: outcome.dispatched,
      simulated: outcome.simulated,
      reason: outcome.reason,
      deliveryId: outcome.deliveryId,
      guestPortalSessionId: issued.sessionId,
      consentBasis: consent.basis,
      forced: Boolean(options.reservationId)
    },
    deviceId: options.context?.deviceId ?? CHECKIN_SERVICE_DEVICE_ID,
    correlationId
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Paso del tick
// ---------------------------------------------------------------------------

/**
 * Una pasada. `clock.day` es el día local del tick (misma zona que el resto de
 * pasos); en modo forzado (`options.reservationId`) solo se invita esa reserva y
 * se lanza NotFoundError / ConflictError (RESERVATION_NOT_CHECKED_OUT) para la ruta.
 */
export async function runPostStaySurveyStep(deps: PostStaySurveyDeps, clock: LocalClock, options: PostStaySurveyStepOptions = {}): Promise<PostStaySurveyStepSummary> {
  const summary: PostStaySurveyStepSummary = { invited: 0, skipped: 0, failed: 0, properties: 0, outcomes: [] };
  const push = (outcome: PostStaySurveyOutcome): void => {
    summary.outcomes.push(outcome);
    summary[outcome.status] += 1;
  };

  if (options.reservationId) {
    const reservation = await deps.db.reservation.findFirst({
      where: { id: options.reservationId, deletedAt: null },
      select: { id: true, propertyId: true, status: true, bookerEmail: true, bookerName: true, departureDate: true }
    });
    if (!reservation) throw new NotFoundError("Reserva no encontrada.");
    if (reservation.status !== "checked_out") {
      throw new ConflictError("La reserva no tiene el check-out hecho: la encuesta post-estancia solo se envía tras la salida.", { code: "RESERVATION_NOT_CHECKED_OUT", status: reservation.status });
    }
    summary.properties = 1;
    push(await inviteReservation(deps, reservation, options));
    return summary;
  }

  const now = deps.now();
  const policies = await deps.db.propertyCheckInPolicy.findMany({
    where: { postStaySurveyEnabled: true },
    select: { propertyId: true, postStaySurveyDelayHours: true },
    orderBy: { propertyId: "asc" }
  });
  summary.properties = policies.length;
  for (const policy of policies) {
    try {
      const window = surveyWindowFor(now, clock.day, policy.postStaySurveyDelayHours, deps.timeZone);
      if (window.from > window.to) continue;
      const reservations = await deps.db.reservation.findMany({
        where: { propertyId: policy.propertyId, status: "checked_out", deletedAt: null, departureDate: { gte: civilDate(window.from), lte: civilDate(window.to) } },
        select: { id: true, propertyId: true, status: true, bookerEmail: true, bookerName: true, departureDate: true },
        orderBy: [{ departureDate: "asc" }, { code: "asc" }]
      });
      for (const reservation of reservations) {
        try {
          push(await inviteReservation(deps, reservation, options));
        } catch (error) {
          push({ propertyId: policy.propertyId, reservationId: reservation.id, status: "failed", reason: describeError(error), dispatched: false, simulated: false, channel: null, recipient: null, deliveryId: null });
        }
      }
    } catch (error) {
      push({ propertyId: policy.propertyId, reservationId: "", status: "failed", reason: describeError(error), dispatched: false, simulated: false, channel: null, recipient: null, deliveryId: null });
    }
  }
  return summary;
}

/**
 * POST /reservations/:id/post-stay/survey-invite: el mismo paso con la reserva
 * forzada (ignora la ventana y la política; exige checked_out) y el actor de
 * personal en la auditoría. `surveyUrl` solo cuando el envío fue simulado.
 */
export async function invitePostStaySurvey(input: { reservationId: string; context: UserContext }, overrides?: Partial<PostStaySurveyDeps>): Promise<PostStaySurveyInviteResult> {
  const deps = withPostStaySurveyDeps(overrides);
  const now = deps.now();
  const day = localDateIn(now, deps.timeZone);
  const summary = await runPostStaySurveyStep(deps, { day, time: "" }, { reservationId: input.reservationId, context: input.context, includeSurveyUrl: true });
  const outcome = summary.outcomes[0];
  if (!outcome) throw new NotFoundError("Reserva no encontrada.");
  const { propertyId: _propertyId, ...result } = outcome;
  return result;
}

// ---------------------------------------------------------------------------
// Portal · GET/POST /guest-portal/survey
// ---------------------------------------------------------------------------

export type GuestSurveyReservation = { id: string; code: string; propertyId: string; status: string; arrivalDate: string; departureDate: string };
export type SurveyRow = { id: string; name: string; questionsJson: unknown };

export type GuestSurveyDeps = {
  now: () => Date;
  loadReservation: (reservationId: string) => Promise<GuestSurveyReservation | null>;
  loadProperty: (propertyId: string) => Promise<{ organizationId: string; name: string; timezone: string | null } | null>;
  findSurvey: (propertyId: string) => Promise<SurveyRow | null>;
  createSurvey: (propertyId: string) => Promise<SurveyRow>;
  findResponse: (reservationId: string) => Promise<{ id: string; createdAt: Date } | null>;
  createResponse: (data: { surveyId: string; reservationId: string; guestId: string | null; score: number; responsesJson: Record<string, unknown> }) => Promise<{ id: string; createdAt: Date }>;
  audit: typeof recordAuditEvent;
};

export const defaultGuestSurveyDeps: GuestSurveyDeps = {
  now: () => new Date(),
  loadReservation: async (reservationId) => {
    const row = await prisma.reservation.findFirst({ where: { id: reservationId, deletedAt: null }, select: { id: true, code: true, propertyId: true, status: true, arrivalDate: true, departureDate: true } });
    return row ? { id: row.id, code: row.code, propertyId: row.propertyId, status: row.status, arrivalDate: row.arrivalDate.toISOString().slice(0, 10), departureDate: row.departureDate.toISOString().slice(0, 10) } : null;
  },
  loadProperty: (propertyId) => prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true, name: true, timezone: true } }),
  findSurvey: (propertyId) =>
    prisma.survey.findFirst({ where: { propertyId, surveyType: POST_STAY_SURVEY_TYPE, active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, questionsJson: true } }),
  createSurvey: (propertyId) =>
    prisma.survey.create({
      data: { propertyId, name: DEFAULT_GUEST_SURVEY_NAME, surveyType: POST_STAY_SURVEY_TYPE, questionsJson: DEFAULT_GUEST_SURVEY_QUESTIONS.map((question) => ({ ...question })) as Prisma.InputJsonValue, active: true },
      select: { id: true, name: true, questionsJson: true }
    }),
  findResponse: (reservationId) => prisma.surveyResponse.findFirst({ where: { reservationId }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true } }),
  createResponse: (data) => prisma.surveyResponse.create({ data: { ...data, responsesJson: data.responsesJson as Prisma.InputJsonValue }, select: { id: true, createdAt: true } }),
  audit: recordAuditEvent
};

export function withGuestSurveyDeps(overrides?: Partial<GuestSurveyDeps>): GuestSurveyDeps {
  return overrides ? { ...defaultGuestSurveyDeps, ...overrides } : defaultGuestSurveyDeps;
}

function surveyDto(row: SurveyRow | null): GuestSurveyDto {
  return { id: row?.id ?? null, name: row?.name ?? DEFAULT_GUEST_SURVEY_NAME, questions: normalizeSurveyQuestions(row?.questionsJson) };
}

/**
 * La encuesta solo se ofrece a quien se alojó y ya salió: reserva `checked_out`
 * (misma regla que invitePostStaySurvey, 409 RESERVATION_NOT_CHECKED_OUT). Una
 * `confirmed` con la salida pasada (no-show sin marcar) también es `post_stay`
 * por fecha, pero nunca hubo estancia: sus respuestas entraban en el NPS
 * (corrector REV-L7-02).
 */
export function surveyOpenFor(reservation: Pick<GuestSurveyReservation, "status">, stage: GuestStayStage): boolean {
  return stage === "post_stay" && reservation.status === "checked_out";
}

/** GET /guest-portal/survey: cuestionario, respuesta previa y disponibilidad (solo reserva checked_out en post_stay). */
export async function getGuestSurveyView(session: VerifiedGuestSession, overrides?: Partial<GuestSurveyDeps>): Promise<GuestSurveyView> {
  const deps = withGuestSurveyDeps(overrides);
  const reservation = await deps.loadReservation(session.reservationId);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const [property, survey, response] = await Promise.all([deps.loadProperty(reservation.propertyId), deps.findSurvey(reservation.propertyId), deps.findResponse(reservation.id)]);
  const stage = stageOf(reservation, localDateIn(deps.now(), property?.timezone ?? null));
  return {
    survey: surveyDto(survey),
    answered: response !== null,
    answeredAt: response ? response.createdAt.toISOString() : null,
    available: surveyOpenFor(reservation, stage) && response === null,
    stage,
    reservationStatus: reservation.status,
    reservation: { reservationId: reservation.id, reservationCode: reservation.code, propertyId: reservation.propertyId, propertyName: property?.name ?? "" },
    sessionPurpose: session.purpose
  };
}

/**
 * POST /guest-portal/survey → 201. Una respuesta por reserva (409
 * SURVEY_ALREADY_ANSWERED); solo con la reserva `checked_out` en post_stay (409
 * SURVEY_NOT_AVAILABLE { stage, status }). La Survey por defecto se crea al
 * primer envío si la propiedad no tiene ninguna `post_stay` activa.
 * responsesJson = { ...answers, score, source: "guest_portal" } (el dashboard
 * lee `comment` y `score`); auditoría sin texto libre.
 */
export async function submitGuestSurvey(input: { session: VerifiedGuestSession; body: GuestSurveySubmitInput; correlationId: string }, overrides?: Partial<GuestSurveyDeps>): Promise<GuestSurveySubmitResult> {
  const deps = withGuestSurveyDeps(overrides);
  const reservation = await deps.loadReservation(input.session.reservationId);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const property = await deps.loadProperty(reservation.propertyId);
  const stage = stageOf(reservation, localDateIn(deps.now(), property?.timezone ?? null));
  if (!surveyOpenFor(reservation, stage)) {
    throw new ConflictError(stage === "post_stay" ? "La encuesta es solo para estancias con salida registrada." : "La encuesta se responde después de la salida.", { code: "SURVEY_NOT_AVAILABLE", stage, status: reservation.status });
  }
  const existing = await deps.findResponse(reservation.id);
  if (existing) {
    throw new ConflictError("Esta reserva ya tiene una respuesta a la encuesta. ¡Gracias!", { code: "SURVEY_ALREADY_ANSWERED", responseId: existing.id, answeredAt: existing.createdAt.toISOString() });
  }
  const survey = (await deps.findSurvey(reservation.propertyId)) ?? (await deps.createSurvey(reservation.propertyId));
  const answers = input.body.answers ?? {};
  const score = Math.round(input.body.score);
  const created = await deps.createResponse({
    surveyId: survey.id,
    reservationId: reservation.id,
    guestId: input.session.guestId ?? null,
    score,
    responsesJson: { ...answers, score, source: "guest_portal" }
  });
  deps.audit({
    organizationId: property?.organizationId ?? reservation.propertyId,
    propertyId: reservation.propertyId,
    actorUserId: `guest:${reservation.id}`,
    actorType: "system",
    action: SURVEY_RESPONSE_AUDIT_ACTION,
    entityType: "survey_response",
    entityId: created.id,
    afterJson: { surveyId: survey.id, reservationId: reservation.id, score, answerKeys: Object.keys(answers), source: "guest_portal" },
    correlationId: input.correlationId
  });
  return { responseId: created.id, surveyId: survey.id, score, answeredAt: created.createdAt.toISOString() };
}
