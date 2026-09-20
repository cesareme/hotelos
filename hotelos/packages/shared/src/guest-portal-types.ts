// Portal del huésped · estancia y salida (Tanda L7 · lote L7-02, 2026-09-20).
//
// Contrato wire compartido por el API (modules/guest-portal/guest-stay.service.ts
// y guest-portal.routes.ts), el portal apps/guest-web y el admin-web: etapa de
// la estancia, vista completa (`GET /guest-portal/stay`), peticiones de salida
// (`POST /guest-portal/stay/requests`), enlace de pago honesto
// (`POST /guest-portal/stay/payment-link`) y códigos de error. Recon L7
// §19.1-19.6 (scratchpad/L7/recon-delta.md).
//
// Privacidad: ninguna estructura de este fichero transporta datos de los
// acompañantes; el titular viaja reducido a nombre + inicial del primer
// apellido (`GuestReservationDto.primaryGuest`), como `GET /guest-portal/reservation`.
// Cada enumeración se declara como array `as const` + unión literal (misma
// convención que checkin-types.ts) para que los tests sin TypeScript lean los valores.

import type { CheckInSessionDto, PropertyCheckInPolicyDto } from "./checkin-types.js";
import type { PaymentLinkResponse } from "./payments-types.js";

// ---------------------------------------------------------------------------
// Sesión del portal (corrector L7-REV-01)
// ---------------------------------------------------------------------------

/**
 * `GuestPortalSession.purpose`: para qué se emitió la sesión.
 *   · sign_in     — código de reserva + correo (24 h): portal completo.
 *   · invitation  — enlace de la invitación al check-in en línea (hasta la salida + 1 d): portal completo.
 *   · survey      — enlace de la encuesta post-estancia (30 d): SOLO `GET|POST /guest-portal/survey`;
 *                   cualquier otra ruta del portal responde 401 GUEST_SESSION_INVALID.
 */
export const GUEST_SESSION_PURPOSES = ["sign_in", "invitation", "survey"] as const;
export type GuestSessionPurpose = (typeof GUEST_SESSION_PURPOSES)[number];
/** Ámbitos con acceso completo al portal (estancia, folio, facturas, peticiones, check-in, chat). */
export const GUEST_PORTAL_FULL_PURPOSES: readonly GuestSessionPurpose[] = Object.freeze(["sign_in", "invitation"]);

// ---------------------------------------------------------------------------
// Etapa de la estancia
// ---------------------------------------------------------------------------

/**
 * Etapa del recorrido según la fecha local de la propiedad (`Property.timezone`)
 * y el estado de la reserva:
 *   · pre_arrival    — confirmada y hoy < llegada
 *   · arrival_day    — confirmada, llegada ≤ hoy < salida y todavía sin check-in
 *   · in_house       — alojada (checked_in) y hoy < salida
 *   · departure_day  — alojada y hoy ≥ salida
 *   · post_stay      — checked_out, o confirmada con la salida ya pasada (sin check-in: la estancia
 *                      no ocurrió; el portal no da las gracias ni ofrece la encuesta —corrector L7-REV-02—)
 *   · cancelled      — cancelled | no_show
 */
export const GUEST_STAY_STAGES = ["pre_arrival", "arrival_day", "in_house", "departure_day", "post_stay", "cancelled"] as const;
export type GuestStayStage = (typeof GUEST_STAY_STAGES)[number];

/** Estados de la reserva con estancia real (alojada o ya salida); una `confirmed` con la salida pasada nunca se alojó. */
export const GUEST_STAYED_STATUSES = ["checked_in", "checked_out"] as const;

// ---------------------------------------------------------------------------
// Reserva (proyección del portal, espejo de GuestReservationView del API)
// ---------------------------------------------------------------------------

export type GuestReservationPrimaryGuestDto = {
  firstName: string;
  /** Inicial del primer apellido («G.»); null si no consta. */
  surname1Initial: string | null;
};

/** `GET /guest-portal/reservation` y `GuestStayView.reservation`. */
export type GuestReservationDto = {
  reservationId: string;
  reservationCode: string;
  propertyId: string;
  propertyName: string;
  propertyTimezone: string | null;
  status: string;
  /** YYYY-MM-DD */
  arrivalDate: string;
  /** YYYY-MM-DD */
  departureDate: string;
  roomType: string | null;
  assignedRoomNumber: string | null;
  /** «HH:MM» o null. */
  eta: string | null;
  primaryGuest: GuestReservationPrimaryGuestDto | null;
  guestCount: number;
  balanceDue: number;
  currency: string;
};

// ---------------------------------------------------------------------------
// Vista de la estancia (19.2)
// ---------------------------------------------------------------------------

export const GUEST_STAY_FOLIO_STATUSES = ["no_folio", "settled", "balance_due"] as const;
export type GuestStayFolioStatus = (typeof GUEST_STAY_FOLIO_STATUSES)[number];

export type GuestStayChargeDto = { description: string; quantity: number; total: number; postedAt: string };
export type GuestStayPaymentDto = { amount: number; method: string; status: string; createdAt: string };

/** Folio principal de la reserva visto por el huésped: saldo REAL, nunca un 0 literal. */
export type GuestStayFolioDto = {
  status: GuestStayFolioStatus;
  balanceDue: number;
  currency: string | null;
  charges: GuestStayChargeDto[];
  payments: GuestStayPaymentDto[];
};

/** Factura emitida de la reserva (`Invoice.reservationId`, status issued); el PDF se descarga por `GET /guest-portal/invoices/:id/pdf`. */
export type GuestStayInvoiceDto = {
  id: string;
  number: string | null;
  issuedAt: string | null;
  total: number;
  currency: string;
};

/**
 * Datos prácticos del hotel: `PropertyAiSetting.configurationJson.faq` (mismas
 * claves que lee el bot del huésped) + `Property.address`. Todo string|null:
 * lo que no está configurado no se inventa.
 */
export type GuestStayInfoDto = {
  wifiName: string | null;
  wifiPassword: string | null;
  breakfastHours: string | null;
  checkOutTime: string | null;
  receptionPhone: string | null;
  address: string | null;
};

export type GuestStayCheckInDto = {
  /** CheckInSession.status (invited | in_progress | ready_for_arrival | arrived | checked_in | handed_off | expired | cancelled). */
  status: string;
  /** true si la reserva tiene una llave móvil activa (GuestPortalAction mobile_key). */
  keyIssued: boolean;
};

/** Peticiones de la reserva (ServiceRequest): las de salida de 19.4 y las del asistente/portal. */
export type GuestStayRequestDto = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
};

export type GuestStaySurveyDto = {
  /** true si se envió la invitación a la encuesta post-estancia (notificationId `post_stay_survey:<reservationId>`). */
  invited: boolean;
  /** true si ya hay una respuesta (survey_responses.reservation_id). */
  answered: boolean;
};

/** `GET /guest-portal/stay` (token del portal). */
export type GuestStayView = {
  stage: GuestStayStage;
  /** Fecha local de la propiedad con la que se calculó `stage` (YYYY-MM-DD). */
  today: string;
  reservation: GuestReservationDto;
  checkIn: GuestStayCheckInDto | null;
  folio: GuestStayFolioDto;
  invoices: GuestStayInvoiceDto[];
  info: GuestStayInfoDto;
  requests: GuestStayRequestDto[];
  survey: GuestStaySurveyDto;
};

// ---------------------------------------------------------------------------
// Peticiones de salida (19.4)
// ---------------------------------------------------------------------------

export const GUEST_STAY_REQUEST_KINDS = ["express_checkout", "late_checkout", "invoice_email", "luggage"] as const;
export type GuestStayRequestKind = (typeof GUEST_STAY_REQUEST_KINDS)[number];

/**
 * Qué peticiones admite cada etapa (corrector L7-REV-02 / REV-L7-04): el API las
 * exige en `POST /guest-portal/stay/requests` (409 `STAY_REQUEST_NOT_ALLOWED
 * { stage, kind }`; tras la salida solo la factura por correo, 409 `STAY_CLOSED`
 * para el resto) y el portal ofrece exactamente las mismas (stay.ts checkOutOptions).
 */
export const GUEST_STAY_REQUEST_KINDS_BY_STAGE: Readonly<Record<GuestStayStage, readonly GuestStayRequestKind[]>> = Object.freeze({
  pre_arrival: ["late_checkout", "luggage"],
  arrival_day: ["late_checkout", "luggage"],
  in_house: ["express_checkout", "late_checkout", "invoice_email", "luggage"],
  departure_day: ["express_checkout", "late_checkout", "invoice_email", "luggage"],
  post_stay: ["invoice_email"],
  cancelled: []
});

/** Cuerpo de `POST /guest-portal/stay/requests` (zod .strict() en el API). */
export type GuestStayRequestInput = {
  kind: GuestStayRequestKind;
  /** ≤ 500 caracteres. */
  note?: string;
  /** «HH:MM». */
  preferredTime?: string;
};

/** 201 de `POST /guest-portal/stay/requests`. */
export type GuestStayRequestResult = {
  id: string;
  /** «SRQ-<8>» (mismo formato que el resto de peticiones del portal). */
  ticketNumber: string;
  kind: GuestStayRequestKind;
  status: "open";
};

// ---------------------------------------------------------------------------
// Enlace de pago honesto (19.5)
// ---------------------------------------------------------------------------

/**
 * `POST /guest-portal/stay/payment-link`: misma forma que `PaymentLinkResponse`
 * del portal (apps/guest-web client.ts) y que `POST /guest-portal/check-in/payment-link`.
 * `link` es el `PaymentLinkResponse` del PSP (payments-types.ts). Sin PSP →
 * `at_reception` (se cobra en recepción); nunca marca un pago como hecho.
 * Corrector L7-REV-03: `paid` SOLO con cargos y saldo 0; un folio sin líneas es
 * `no_charges` / `none` (una cuenta vacía no está «pagada»).
 */
export type GuestStayPaymentLinkResponse =
  | { status: "no_folio" | "no_charges"; paymentStatus: "none" }
  | { status: "settled"; paymentStatus: "paid" }
  | { status: "at_reception"; paymentStatus: "at_reception"; reason: string; details?: unknown }
  | { status: "link_sent"; paymentStatus: "link_sent"; link: PaymentLinkResponse };

// ---------------------------------------------------------------------------
// Legado verificado (19.6) y códigos de error
// ---------------------------------------------------------------------------

/** `GET /guest-portal/session/:token` tras verificar el token: nunca devuelve el token en claro. */
export type GuestSessionCheckDto = {
  token: "[redacted]";
  status: "active";
  reservationId: string;
};

export const GUEST_PORTAL_ERROR_CODES = [
  "GUEST_SESSION_INVALID",
  "STAY_CLOSED",
  // Corrector L7-REV-02 / REV-L7-04: la petición no corresponde a la etapa de la estancia.
  "STAY_REQUEST_NOT_ALLOWED",
  "PSP_NOT_CONFIGURED",
  "VALIDATION_ERROR",
  // Encuesta post-estancia (L7-04)
  "SURVEY_ALREADY_ANSWERED",
  "SURVEY_NOT_AVAILABLE",
  "RESERVATION_NOT_CHECKED_OUT"
] as const;
export type GuestPortalErrorCode = (typeof GUEST_PORTAL_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Encuesta post-estancia (19.7 · lote L7-04)
// ---------------------------------------------------------------------------

/** Tipos de pregunta que el portal sabe pintar: `nps` (0-10), `scale` (1-5) y `text` (libre). */
export const GUEST_SURVEY_QUESTION_TYPES = ["nps", "text", "scale"] as const;
export type GuestSurveyQuestionType = (typeof GUEST_SURVEY_QUESTION_TYPES)[number];

/**
 * Pregunta normalizada desde `Survey.questionsJson` (el editor del back office
 * guarda `{ id, text }`; el portal acepta también `{ key, type, label, required }`).
 */
export type GuestSurveyQuestion = {
  key: string;
  type: GuestSurveyQuestionType;
  label: string;
  required: boolean;
};

/** Cuestionario por defecto cuando la propiedad no tiene `Survey` post_stay activa (se crea al primer POST). */
export const DEFAULT_GUEST_SURVEY_NAME = "Encuesta post-estancia";
export const DEFAULT_GUEST_SURVEY_QUESTIONS: readonly GuestSurveyQuestion[] = Object.freeze([
  { key: "nps", type: "nps", label: "¿Recomendarías el hotel a un amigo o familiar? (0 = nada probable · 10 = seguro)", required: true },
  { key: "comment", type: "text", label: "¿Qué podríamos mejorar?", required: false }
]);

export type GuestSurveyDto = {
  /** `Survey.id`; null mientras la propiedad no tiene encuesta (cuestionario por defecto). */
  id: string | null;
  name: string;
  questions: GuestSurveyQuestion[];
};

/** `GET /guest-portal/survey` (token del portal; también con la sesión `survey` del enlace). */
export type GuestSurveyView = {
  survey: GuestSurveyDto;
  /** true si ya hay una `SurveyResponse` de la reserva (una sola por reserva). */
  answered: boolean;
  answeredAt: string | null;
  /** true solo con la reserva `checked_out` (etapa `post_stay`) y sin respuesta previa: el portal muestra el formulario; si no, el motivo. */
  available: boolean;
  stage: GuestStayStage;
  /** `Reservation.status`: una `confirmed` con la salida pasada nunca se alojó → sin encuesta (corrector L7-REV-02). */
  reservationStatus: string;
  /** Cabecera mínima para la sesión del enlace (sin PII): la sesión `survey` no puede leer `GET /guest-portal/reservation`. */
  reservation: { reservationId: string; reservationCode: string; propertyId: string; propertyName: string };
  /** Ámbito de la sesión que hizo la petición (corrector L7-REV-01). */
  sessionPurpose: GuestSessionPurpose;
};

/** Cuerpo de `POST /guest-portal/survey` (zod `.strict()` en el API). */
export type GuestSurveySubmitInput = {
  /** NPS 0-10 (entero). */
  score: number;
  /** Respuestas por clave de pregunta (texto ≤ 2000 o número); ≤ 20 claves. */
  answers?: Record<string, string | number>;
};

/** 201 de `POST /guest-portal/survey`. */
export type GuestSurveySubmitResult = {
  responseId: string;
  surveyId: string;
  score: number;
  answeredAt: string;
};

export const POST_STAY_SURVEY_INVITE_STATUSES = ["invited", "skipped", "failed"] as const;
export type PostStaySurveyInviteStatus = (typeof POST_STAY_SURVEY_INVITE_STATUSES)[number];

/**
 * `POST /reservations/:id/post-stay/survey-invite` (personal) y cada resultado
 * del paso del tick. `recipient` siempre enmascarado; `surveyUrl` SOLO cuando el
 * envío fue simulado (sin proveedor de correo): alguien tiene que hacer llegar
 * el enlace al huésped y el sistema no finge haberlo enviado.
 */
export type PostStaySurveyInviteResult = {
  reservationId: string;
  status: PostStaySurveyInviteStatus;
  /** already_invited · no_recipient · consent_refused · session_not_issued · template_not_found · <error del proveedor> · null */
  reason: string | null;
  dispatched: boolean;
  simulated: boolean;
  channel: "email" | null;
  recipient: string | null;
  deliveryId: string | null;
  surveyUrl?: string;
};

// ---------------------------------------------------------------------------
// Recorrido del huésped en recepción (`GET /reservations/:id/guest-journey` · lote L7-07;
// wire type movido aquí por el corrector L7-REV-04: espejo en
// apps/admin-web/src/services/guestJourneyApi.ts y origen en
// apps/api/src/modules/guest-portal/guest-journey.service.ts)
// ---------------------------------------------------------------------------

export const JOURNEY_NOTIFICATION_KINDS = ["checkin_invitation", "checkin_reminder", "welcome", "post_stay_survey"] as const;
export type JourneyNotificationKind = (typeof JOURNEY_NOTIFICATION_KINDS)[number];

/** Aviso enviado al huésped: destinatario ENMASCARADO (`a***@dominio` / `***123`); nunca asunto, cuerpo ni payload. */
export type GuestJourneyNotificationDto = {
  id: string;
  kind: JourneyNotificationKind;
  templateCode: string | null;
  channel: string;
  /** NotificationDelivery.status: pending | sent | failed. */
  status: string;
  /** true cuando el dispatcher no tenía proveedor y marcó el envío SIMULADO (status sent). */
  simulated: boolean;
  /** Destinatario enmascarado (maskRecipient); nunca el correo o el teléfono completos. */
  recipient: string;
  sentAt: string | null;
  failedAt: string | null;
  createdAt: string;
  /** Motivo del fallo (errorMessage) solo cuando status = failed; null en el resto. */
  error: string | null;
};

/** Llave móvil ACTIVA de la reserva: serie y vigencia; nunca el QR ni el hash del secreto. */
export type GuestJourneyKeyDto = {
  issued: true;
  serial: string;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  issuedAt: string | null;
  /** false = QR de demo sin certificado de Apple. */
  signedByApple: boolean;
};

export type GuestJourneyRequestDto = { id: string; kind: string; status: string; department: string | null; createdAt: string };

export type GuestJourneySurveyDto = {
  /** sentAt (o createdAt) de la invitación `post_stay_survey:<reservationId>` (igualdad exacta); null si no se envió. */
  invitedAt: string | null;
  /** createdAt de la última SurveyResponse de la reserva; null sin respuesta. */
  answeredAt: string | null;
  /** SurveyResponse.score o, en su defecto, responsesJson.score | nps | rating (0-10). */
  score: number | null;
};

export type GuestJourneyPortalSessionsDto = { active: number; lastCreatedAt: string | null };

/** Sesión de check-in en línea tal y como la ve recepción (toSessionView): sesión + política + pasos; viajeros sin PII. */
export type GuestJourneyCheckInDto = CheckInSessionDto & { policy: PropertyCheckInPolicyDto; steps: Array<{ key: string; status: string }> };

/** `GET /reservations/:id/guest-journey` (personal, `pms.reservation.read`). */
export type GuestJourneyView = {
  reservationId: string;
  checkIn: GuestJourneyCheckInDto | null;
  notifications: GuestJourneyNotificationDto[];
  key: GuestJourneyKeyDto | null;
  requests: GuestJourneyRequestDto[];
  survey: GuestJourneySurveyDto;
  portalSessions: GuestJourneyPortalSessionsDto;
};
