// Recorrido del huésped en recepción (Tanda L7 · lote L7-07, 2026-09-20).
//
// Servicio de `GET /reservations/:id/guest-journey` (recon §19.8): ensambla,
// para UNA reserva, lo que la pantalla Recepción › Reservas › Recorrido
// (apps/admin-web/src/screens/guestJourney) no podía leer hasta ahora:
//   · la sesión de check-in en línea (CheckInSessionView de
//     checkin-session.service.ts: sesión + política + pasos + viajeros sin PII);
//   · los avisos enviados al huésped (notification_deliveries por
//     notificationId: `checkin_invitation:<guestPortalSessionId>` y
//     `checkin_reminder:<guestPortalSessionId>` de TODAS las sesiones del portal
//     de la reserva —un reenvío revoca la anterior y crea otra—, `welcome:<reservationId>:<canal>`
//     de la bienvenida y `post_stay_survey:<reservationId>` de la encuesta);
//   · la llave móvil activa (GuestPortalAction actionType mobile_key,
//     wallet-pass.service.ts) con su serie, nunca el QR ni el hash del secreto;
//   · las peticiones (ServiceRequest) y la encuesta post-estancia (invitación +
//     SurveyResponse con puntuación);
//   · el recuento de sesiones activas del portal y la fecha de la última.
//
// Principios:
//   · Sin PII: el destinatario de cada aviso sale enmascarado con maskRecipient
//     (`a***@dominio` / `***123`); ni el asunto, ni el cuerpo, ni el payload de
//     la entrega viajan; los viajeros van con el DTO de recepción (nombre y 3
//     últimos caracteres del documento, contrato del módulo checkin).
//   · Honestidad: un envío SIMULADO (dispatcher sin proveedor, status `sent` +
//     errorMessage «SIMULADO…») se marca `simulated: true`; un envío fallido
//     conserva `status: "failed"` y su motivo; la llave dice si el pase está
//     firmado por Apple o es un QR de demo.
//   · Dependencias inyectables (GuestJourneyDeps) para los tests unitarios sin
//     base de datos (__tests__/guest-journey.test.mts); las reales viven en
//     defaultGuestJourneyDeps. Ninguna escritura.

import { prisma } from "@hotelos/database";
import { JOURNEY_NOTIFICATION_KINDS, type GuestJourneyKeyDto, type GuestJourneyNotificationDto, type GuestJourneyPortalSessionsDto, type GuestJourneyRequestDto, type GuestJourneySurveyDto, type GuestJourneyView as GuestJourneyWireView, type JourneyNotificationKind } from "@hotelos/shared";
import { NotFoundError } from "../../lib/http-error.js";
import { maskRecipient, toSessionView, type CheckInSessionView } from "../checkin/checkin-session.service.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** GuestPortalAction.actionType de la llave móvil (wallet-pass.service.ts MOBILE_KEY_ACTION_TYPE). */
export const JOURNEY_MOBILE_KEY_ACTION_TYPE = "mobile_key";
/** Marca del dispatcher cuando no hay proveedor (dispatcher.service.ts): el envío no salió de verdad. */
export const SIMULATED_DELIVERY_PREFIX = "SIMULADO";
/** Máximo de peticiones y de avisos que viajan en la vista. */
export const JOURNEY_LIST_LIMIT = 50;

export { JOURNEY_NOTIFICATION_KINDS };
export type { JourneyNotificationKind, GuestJourneyNotificationDto, GuestJourneyKeyDto, GuestJourneyRequestDto, GuestJourneySurveyDto, GuestJourneyPortalSessionsDto };

// ---------------------------------------------------------------------------
// Vista (wire en packages/shared/src/guest-portal-types.ts, corrector L7-REV-04;
// espejo en apps/admin-web/src/services/guestJourneyApi.ts). Aquí `checkIn` va
// con la vista precisa del módulo checkin (subtipo de GuestJourneyCheckInDto).
// ---------------------------------------------------------------------------

export type GuestJourneyView = Omit<GuestJourneyWireView, "checkIn"> & { checkIn: CheckInSessionView | null };

// ---------------------------------------------------------------------------
// Filas que reciben las funciones puras (subconjunto de los modelos Prisma)
// ---------------------------------------------------------------------------

export type JourneyDeliveryRow = {
  id: string;
  notificationId: string | null;
  templateCode: string | null;
  channel: string;
  status: string;
  recipient: string;
  errorMessage: string | null;
  sentAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
};

export type JourneyKeyRow = { id: string; status: string; payloadJson: unknown; createdAt: Date };
export type JourneyRequestRow = { id: string; requestType: string; status: string; assignedDepartment: string | null; createdAt: Date };
export type JourneyPortalSessionRow = { id: string; status: string; expiresAt: Date; createdAt: Date };
export type JourneySurveyResponseRow = { createdAt: Date; score: unknown; responsesJson: unknown };

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

/** notificationId EXACTO de la invitación a la encuesta (post-stay-survey.service.ts surveyNotificationId). */
export function surveyNotificationIdFor(reservationId: string): string {
  return `post_stay_survey:${reservationId}`;
}

/**
 * Prefijos e identificadores exactos de las entregas que pertenecen al recorrido
 * de la reserva. Corrector REV-L7-01: la encuesta va por IGUALDAD
 * (`post_stay_survey:<reservationId>`); solo la bienvenida es prefijo porque
 * lleva separador y canal (`welcome:<reservationId>:<canal>`). Con ids cortos
 * (seed, importaciones) `res_07` es prefijo de `res_07p` y el recorrido de una
 * reserva atribuía la invitación de la otra.
 */
export function journeyNotificationIds(reservationId: string, portalSessionIds: readonly string[]): { exact: string[]; prefixes: string[] } {
  return {
    exact: [...portalSessionIds.flatMap((id) => [`checkin_invitation:${id}`, `checkin_reminder:${id}`]), surveyNotificationIdFor(reservationId)],
    prefixes: [`welcome:${reservationId}:`]
  };
}

/** Tipo de aviso al que corresponde un notificationId; null si no es del recorrido de esta reserva. */
export function journeyNotificationKind(notificationId: string | null | undefined, reservationId: string, portalSessionIds: readonly string[]): JourneyNotificationKind | null {
  if (!notificationId) return null;
  const sessions = new Set(portalSessionIds);
  const [head, ...rest] = notificationId.split(":");
  const tail = rest.join(":");
  if (head === "checkin_invitation" && sessions.has(tail)) return "checkin_invitation";
  if (head === "checkin_reminder" && sessions.has(tail)) return "checkin_reminder";
  if (notificationId.startsWith(`welcome:${reservationId}:`)) return "welcome";
  if (notificationId === surveyNotificationIdFor(reservationId)) return "post_stay_survey";
  return null;
}

/** Un envío «sent» cuyo errorMessage empieza por SIMULADO no salió de verdad (dispatcher sin proveedor). */
export function isSimulatedDelivery(row: Pick<JourneyDeliveryRow, "status" | "errorMessage">): boolean {
  return row.status === "sent" && typeof row.errorMessage === "string" && row.errorMessage.startsWith(SIMULATED_DELIVERY_PREFIX);
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** DTO de un aviso: destinatario enmascarado, marca de simulación y motivo solo cuando falló. */
export function journeyNotificationFrom(row: JourneyDeliveryRow, kind: JourneyNotificationKind): GuestJourneyNotificationDto {
  return {
    id: row.id,
    kind,
    templateCode: row.templateCode ?? null,
    channel: row.channel,
    status: row.status,
    simulated: isSimulatedDelivery(row),
    recipient: maskRecipient(row.recipient),
    sentAt: iso(row.sentAt),
    failedAt: iso(row.failedAt),
    createdAt: row.createdAt.toISOString(),
    error: row.status === "failed" ? (row.errorMessage ?? null) : null
  };
}

/** Avisos del recorrido en orden cronológico; las filas ajenas a la reserva se descartan. */
export function journeyNotificationsFrom(rows: readonly JourneyDeliveryRow[], reservationId: string, portalSessionIds: readonly string[]): GuestJourneyNotificationDto[] {
  return [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .flatMap((row) => {
      const kind = journeyNotificationKind(row.notificationId, reservationId, portalSessionIds);
      return kind ? [journeyNotificationFrom(row, kind)] : [];
    });
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Llave móvil ACTIVA → serie, vigencia y honestidad del pase; cualquier otra fila (revocada, sin serie) → null. */
export function keyDtoFrom(row: JourneyKeyRow | null): GuestJourneyKeyDto | null {
  if (!row || row.status !== "active") return null;
  const payload = row.payloadJson && typeof row.payloadJson === "object" && !Array.isArray(row.payloadJson) ? (row.payloadJson as Record<string, unknown>) : {};
  const serial = payloadString(payload, "serialNumber") ?? (row.id.startsWith("mkey_") ? row.id.slice("mkey_".length) : null);
  if (!serial) return null;
  return {
    issued: true,
    serial,
    status: row.status,
    validFrom: payloadString(payload, "validFrom"),
    validUntil: payloadString(payload, "validUntil"),
    issuedAt: payloadString(payload, "issuedAt") ?? row.createdAt.toISOString(),
    signedByApple: payload.signedByApple === true
  };
}

export function requestDtoFrom(row: JourneyRequestRow): GuestJourneyRequestDto {
  return { id: row.id, kind: row.requestType, status: row.status, department: row.assignedDepartment ?? null, createdAt: row.createdAt.toISOString() };
}

function numericScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(typeof value === "object" ? String(value) : value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Puntuación de la respuesta: la columna score o, en su defecto, responsesJson.score | nps | rating (misma lectura que el NPS de dashboards). */
export function surveyScoreFrom(row: Pick<JourneySurveyResponseRow, "score" | "responsesJson">): number | null {
  const direct = numericScore(row.score);
  if (direct !== null) return direct;
  const answers = row.responsesJson && typeof row.responsesJson === "object" && !Array.isArray(row.responsesJson) ? (row.responsesJson as Record<string, unknown>) : {};
  for (const key of ["score", "nps", "rating"]) {
    const found = numericScore(answers[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Encuesta post-estancia: invitación (última entrega post_stay_survey) y respuesta con puntuación. */
export function surveyDtoFrom(notifications: readonly GuestJourneyNotificationDto[], response: JourneySurveyResponseRow | null): GuestJourneySurveyDto {
  const invitation = [...notifications].reverse().find((item) => item.kind === "post_stay_survey");
  return {
    invitedAt: invitation ? (invitation.sentAt ?? invitation.createdAt) : null,
    answeredAt: response ? response.createdAt.toISOString() : null,
    score: response ? surveyScoreFrom(response) : null
  };
}

/** Sesiones del portal vigentes (status active y no caducadas) y fecha de la última creada. */
export function portalSessionsDtoFrom(rows: readonly JourneyPortalSessionRow[], now: Date): GuestJourneyPortalSessionsDto {
  const active = rows.filter((row) => row.status === "active" && row.expiresAt.getTime() > now.getTime()).length;
  const last = rows.reduce<Date | null>((latest, row) => (!latest || row.createdAt.getTime() > latest.getTime() ? row.createdAt : latest), null);
  return { active, lastCreatedAt: iso(last) };
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

export type GuestJourneyDeps = {
  now: () => Date;
  /** Cabecera de la reserva (null si no existe o está borrada). */
  loadReservation: (reservationId: string) => Promise<{ id: string; propertyId: string } | null>;
  /** Vista de recepción de la sesión de check-in (sesión + política + pasos + viajeros sin PII); null sin sesión. */
  loadCheckIn: (reservationId: string) => Promise<CheckInSessionView | null>;
  loadPortalSessions: (reservationId: string) => Promise<JourneyPortalSessionRow[]>;
  loadDeliveries: (input: { reservationId: string; portalSessionIds: readonly string[] }) => Promise<JourneyDeliveryRow[]>;
  loadKey: (reservationId: string) => Promise<JourneyKeyRow | null>;
  loadRequests: (reservationId: string) => Promise<JourneyRequestRow[]>;
  loadSurveyResponse: (reservationId: string) => Promise<JourneySurveyResponseRow | null>;
};

export const defaultGuestJourneyDeps: GuestJourneyDeps = {
  now: () => new Date(),
  loadReservation: (reservationId) => prisma.reservation.findFirst({ where: { id: reservationId, deletedAt: null }, select: { id: true, propertyId: true } }),
  loadCheckIn: async (reservationId) => {
    const session = await prisma.checkInSession.findUnique({ where: { reservationId } });
    if (!session) return null;
    // Viajeros por consulta de primer nivel (descifrados), como reservationCheckInView de checkin.routes.ts.
    const guests = await prisma.checkInGuest.findMany({ where: { sessionId: session.id }, orderBy: { ordinal: "asc" } });
    return toSessionView(session, guests);
  },
  loadPortalSessions: (reservationId) =>
    prisma.guestPortalSession.findMany({ where: { reservationId }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, expiresAt: true, createdAt: true } }),
  loadDeliveries: async ({ reservationId, portalSessionIds }) => {
    const ids = journeyNotificationIds(reservationId, portalSessionIds);
    // `exact` nunca está vacío (lleva la encuesta); la bienvenida es el único prefijo (REV-L7-01).
    return prisma.notificationDelivery.findMany({
      where: {
        OR: [{ notificationId: { in: ids.exact } }, ...ids.prefixes.map((prefix) => ({ notificationId: { startsWith: prefix } }))]
      },
      orderBy: { createdAt: "asc" },
      take: JOURNEY_LIST_LIMIT,
      select: { id: true, notificationId: true, templateCode: true, channel: true, status: true, recipient: true, errorMessage: true, sentAt: true, failedAt: true, createdAt: true }
    });
  },
  loadKey: (reservationId) =>
    prisma.guestPortalAction.findFirst({
      where: { reservationId, actionType: JOURNEY_MOBILE_KEY_ACTION_TYPE, status: "active" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, payloadJson: true, createdAt: true }
    }),
  loadRequests: (reservationId) =>
    prisma.serviceRequest.findMany({
      where: { reservationId },
      orderBy: { createdAt: "desc" },
      take: JOURNEY_LIST_LIMIT,
      select: { id: true, requestType: true, status: true, assignedDepartment: true, createdAt: true }
    }),
  loadSurveyResponse: (reservationId) =>
    prisma.surveyResponse.findFirst({ where: { reservationId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, score: true, responsesJson: true } })
};

export function withGuestJourneyDeps(overrides?: Partial<GuestJourneyDeps>): GuestJourneyDeps {
  return overrides ? { ...defaultGuestJourneyDeps, ...overrides } : defaultGuestJourneyDeps;
}

// ---------------------------------------------------------------------------
// 19.8 · Vista del recorrido
// ---------------------------------------------------------------------------

/**
 * Recorrido completo de la reserva. La ruta ya cruzó la tenencia con
 * assertEntityAccess; aquí solo se lee. 404 si la reserva no existe (o está
 * borrada).
 */
export async function getGuestJourney(reservationId: string, overrides?: Partial<GuestJourneyDeps>): Promise<GuestJourneyView> {
  const deps = withGuestJourneyDeps(overrides);
  const reservation = await deps.loadReservation(reservationId);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const portalSessions = await deps.loadPortalSessions(reservation.id);
  const portalSessionIds = portalSessions.map((row) => row.id);
  const [checkIn, deliveries, key, requests, response] = await Promise.all([
    deps.loadCheckIn(reservation.id),
    deps.loadDeliveries({ reservationId: reservation.id, portalSessionIds }),
    deps.loadKey(reservation.id),
    deps.loadRequests(reservation.id),
    deps.loadSurveyResponse(reservation.id)
  ]);
  const notifications = journeyNotificationsFrom(deliveries, reservation.id, portalSessionIds);
  return {
    reservationId: reservation.id,
    checkIn,
    notifications,
    key: keyDtoFrom(key),
    requests: requests.map(requestDtoFrom),
    survey: surveyDtoFrom(notifications, response),
    portalSessions: portalSessionsDtoFrom(portalSessions, deps.now())
  };
}
