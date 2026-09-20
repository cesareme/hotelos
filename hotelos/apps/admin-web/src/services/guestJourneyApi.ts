// Recorrido del huésped en recepción · cliente del admin-web (Tanda L7 · lote
// L7-07, scratchpad/L7/recon-delta.md §19.8).
//
// Tipado con el contrato wire de @hotelos/shared (GuestJourneyView de
// guest-portal-types.ts, el mismo que sirve
// apps/api/src/modules/guest-portal/guest-journey.service.ts). Todo pasa por `apiRequest`
// (services/api-client.ts): sesión, `x-property-id` y 401 como el resto de
// servicios; los 4xx llegan como `ApiError`.
//
// Privacidad: ningún DTO de aquí lleva PII más allá del nombre del viajero y de
// los 3 últimos caracteres del documento (DTO de recepción del módulo checkin);
// los destinatarios de los avisos llegan enmascarados por el API (`a***@dominio`).
//
// Honestidad: un aviso `simulated: true` no salió de verdad (sin proveedor de
// correo/WhatsApp); una llave `signedByApple: false` es un QR de demo. La
// encuesta inmediata (`sendPostStaySurveyNow`) llama a la ruta del lote L7-04
// (POST /reservations/:id/post-stay/survey-invite); mientras esa ruta no esté
// desplegada el API responde 404 «Route … not found» y `isRouteUnavailable`
// lo distingue de una reserva inexistente.

import { JOURNEY_NOTIFICATION_KINDS } from "@hotelos/shared";
import type {
  GuestJourneyCheckInDto,
  GuestJourneyKeyDto,
  GuestJourneyNotificationDto,
  GuestJourneyPortalSessionsDto,
  GuestJourneyRequestDto,
  GuestJourneySurveyDto,
  GuestJourneyView,
  JourneyNotificationKind
} from "@hotelos/shared";
import { ApiError, apiRequest, type RequestOptions } from "./api-client";

// ---------------------------------------------------------------------------
// Formas de respuesta: el wire type vive en packages/shared/src/guest-portal-types.ts
// (GuestJourneyView, corrector L7-REV-04); aquí solo alias con los nombres que
// usan las pantallas.
// ---------------------------------------------------------------------------

export { JOURNEY_NOTIFICATION_KINDS };
export type { JourneyNotificationKind, GuestJourneyView };

export type JourneyCheckInStep = { key: string; status: string };

/** Sesión de check-in en línea tal y como la ve recepción (toSessionView): sesión + política + pasos. */
export type JourneyCheckIn = GuestJourneyCheckInDto;

export type GuestJourneyNotification = GuestJourneyNotificationDto;

export type GuestJourneyKey = GuestJourneyKeyDto;

export type GuestJourneyRequest = GuestJourneyRequestDto;

export type GuestJourneySurvey = GuestJourneySurveyDto;

export type GuestJourneyPortalSessions = GuestJourneyPortalSessionsDto;

/** POST /reservations/:id/post-stay/survey-invite (lote L7-04, recon §19.7). */
export type PostStaySurveyInviteResult = {
  dispatched: boolean;
  simulated: boolean;
  channel: string | null;
  /** Enmascarado por el API. */
  recipient: string | null;
  deliveryId: string | null;
  reason?: string | null;
};

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

function reservationPath(reservationId: string, suffix: string): string {
  return `/reservations/${encodeURIComponent(reservationId)}${suffix}`;
}

/** GET /reservations/:id/guest-journey (pms.reservation.read). */
export function getGuestJourney(reservationId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<GuestJourneyView> {
  return apiRequest<GuestJourneyView>(reservationPath(reservationId, "/guest-journey"), options);
}

/** POST /reservations/:id/post-stay/survey-invite (pms.reservation.modify; exige reserva checked_out). */
export function sendPostStaySurveyNow(reservationId: string): Promise<PostStaySurveyInviteResult> {
  return apiRequest<PostStaySurveyInviteResult>(reservationPath(reservationId, "/post-stay/survey-invite"), { method: "POST", body: {} });
}

/** 404 del setNotFoundHandler de Fastify («Route POST /… not found»): la ruta no está desplegada, no es una reserva inexistente. */
export function isRouteUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && /^Route\s+[A-Z]+\s/.test(error.message);
}
