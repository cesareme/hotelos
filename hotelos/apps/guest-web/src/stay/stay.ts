// Estancia y salida del portal del huésped (Tanda L7 · lote L7-06, 2026-09-20).
//
// Módulo PURO (sin React, sin DOM, sin fetch): etapa de la estancia → acción
// principal y secundaria, opciones de salida por etapa, formato del folio REAL
// (saldo, cargos, pagos), resultado honesto del enlace de pago y etiquetas de
// peticiones. Lo cubre __tests__/stay.test.mts con node --test (guest-web no
// tiene typecheck real: sin @types/react el typecheck del portal es SKIP).
//
// Tanda L7 · L7-08: bloque «Encuesta post-estancia» (19.7): tipos espejo de
// GuestSurveyView, estado honesto de la encuesta, validación y cuerpo del envío.
//
// Los tipos son un espejo estructural de packages/shared/src/guest-portal-types.ts
// (misma convención que api/client.ts con checkin-types.ts: el paquete no tiene
// dist y Vite no resuelve los paths del tsconfig). tests/guest-portal-ui-contract
// comprueba que STAY_STAGES y STAY_REQUEST_KINDS coinciden con el fichero wire.
//
// Honestidad (recon §18 D2/D3): el saldo es el del folio principal del API
// (nunca un 0 literal); «Pagar ahora» solo existe con un enlace real
// (`link_sent` con URL http/https); sin PSP «se cobra en recepción»; un folio
// sin líneas es «sin cargos todavía», nunca «todo pagado».

import { t } from "../checkin/wizard";
import type { CopyKey, Lang } from "../checkin/wizard";

// ---------------------------------------------------------------------------
// Tipos wire (espejo de guest-portal-types.ts)
// ---------------------------------------------------------------------------

export const STAY_STAGES = ["pre_arrival", "arrival_day", "in_house", "departure_day", "post_stay", "cancelled"] as const;
export type StayStage = (typeof STAY_STAGES)[number];

export const STAY_REQUEST_KINDS = ["express_checkout", "late_checkout", "invoice_email", "luggage"] as const;
export type StayRequestKind = (typeof STAY_REQUEST_KINDS)[number];

/** Espejo de GUEST_STAY_REQUEST_KINDS_BY_STAGE (guest-portal-types.ts): el API exige EXACTAMENTE estas listas (corrector L7-REV-02). */
export const STAY_REQUEST_KINDS_BY_STAGE: Readonly<Record<StayStage, readonly StayRequestKind[]>> = Object.freeze({
  pre_arrival: ["late_checkout", "luggage"],
  arrival_day: ["late_checkout", "luggage"],
  in_house: ["express_checkout", "late_checkout", "invoice_email", "luggage"],
  departure_day: ["express_checkout", "late_checkout", "invoice_email", "luggage"],
  post_stay: ["invoice_email"],
  cancelled: []
});

/** Estados de la reserva con estancia real (espejo de GUEST_STAYED_STATUSES): una `confirmed` con la salida pasada nunca se alojó. */
export const STAYED_STATUSES: readonly string[] = Object.freeze(["checked_in", "checked_out"]);

/** Ámbito de la sesión del portal (espejo de GuestSessionPurpose, corrector L7-REV-01). */
export const SESSION_PURPOSES = ["sign_in", "invitation", "survey"] as const;
export type SessionPurpose = (typeof SESSION_PURPOSES)[number];

export const STAY_FOLIO_STATUSES = ["no_folio", "settled", "balance_due"] as const;
export type StayFolioStatus = (typeof STAY_FOLIO_STATUSES)[number];

export type StayReservation = {
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
  eta: string | null;
  primaryGuest: { firstName: string; surname1Initial: string | null } | null;
  guestCount: number;
  balanceDue: number;
  currency: string;
};

export type StayCharge = { description: string; quantity: number; total: number; postedAt: string };
export type StayPayment = { amount: number; method: string; status: string; createdAt: string };

export type StayFolio = {
  status: StayFolioStatus;
  balanceDue: number;
  currency: string | null;
  charges: StayCharge[];
  payments: StayPayment[];
};

export type StayInvoice = { id: string; number: string | null; issuedAt: string | null; total: number; currency: string };

export type StayInfo = {
  wifiName: string | null;
  wifiPassword: string | null;
  breakfastHours: string | null;
  checkOutTime: string | null;
  receptionPhone: string | null;
  address: string | null;
};

export type StayCheckIn = { status: string; keyIssued: boolean };
export type StayRequest = { id: string; kind: string; status: string; createdAt: string };
export type StaySurvey = { invited: boolean; answered: boolean };

/** `GET /guest-portal/stay`. */
export type StayView = {
  stage: StayStage;
  today: string;
  reservation: StayReservation;
  checkIn: StayCheckIn | null;
  folio: StayFolio;
  invoices: StayInvoice[];
  info: StayInfo;
  requests: StayRequest[];
  survey: StaySurvey;
};

/** Cuerpo de `POST /guest-portal/stay/requests` (zod .strict() en el API). */
export type StayRequestInput = { kind: StayRequestKind; note?: string; preferredTime?: string };

/** 201 de `POST /guest-portal/stay/requests`. */
export type StayRequestResult = { id: string; ticketNumber: string; kind: StayRequestKind; status: "open" };

export type PaymentRedirect = { method: "GET"; url: string } | { method: "POST"; url: string; fields: Record<string, string> };

/** Misma forma que `PaymentLinkResponse` de api/client.ts y que `POST /guest-portal/stay/payment-link` (`no_charges` = folio sin líneas, corrector L7-REV-03). */
export type StayPaymentLinkResponse =
  | { status: "settled" | "no_folio" | "no_charges"; paymentStatus: string }
  | { status: "at_reception"; paymentStatus: "at_reception"; reason: string; details?: unknown }
  | { status: "link_sent"; paymentStatus: "link_sent"; link: { redirect: PaymentRedirect; idempotent: boolean; intent?: unknown } };

// ---------------------------------------------------------------------------
// Etapa
// ---------------------------------------------------------------------------

/** Reserva cerrada para el huésped (misma lista que STAY_CLOSED_STATUSES del API). */
const CLOSED_RESERVATION_STATUSES: readonly string[] = ["cancelled", "no_show"];

export function isStayStage(value: unknown): value is StayStage {
  return typeof value === "string" && (STAY_STAGES as readonly string[]).includes(value);
}

/**
 * Etapa por estado de la reserva y fecha local YYYY-MM-DD (misma regla que
 * stageOf del API, guest-stay.service.ts): sirve de respaldo cuando `stage`
 * no viene o no es una etapa conocida.
 */
export function deriveStage(reservation: Pick<StayReservation, "status" | "arrivalDate" | "departureDate">, today: string): StayStage {
  const arrival = reservation.arrivalDate.slice(0, 10);
  const departure = reservation.departureDate.slice(0, 10);
  if (CLOSED_RESERVATION_STATUSES.includes(reservation.status)) return "cancelled";
  if (reservation.status === "checked_out") return "post_stay";
  if (reservation.status === "checked_in") return today < departure ? "in_house" : "departure_day";
  if (today < arrival) return "pre_arrival";
  if (today < departure) return "arrival_day";
  return "post_stay";
}

/** Etapa de la vista: la del API si es válida; si no, derivada de la reserva y `today`. */
export function stageOf(view: Pick<StayView, "stage" | "reservation" | "today">): StayStage {
  if (isStayStage(view.stage)) return view.stage;
  return deriveStage(view.reservation, view.today || new Date().toISOString().slice(0, 10));
}

export const STAGE_LABEL_KEY: Record<StayStage, CopyKey> = {
  pre_arrival: "stagePreArrival",
  arrival_day: "stageArrivalDay",
  in_house: "stageInHouse",
  departure_day: "stageDepartureDay",
  post_stay: "stagePostStay",
  cancelled: "stageCancelled"
};

export const STAGE_HINT_KEY: Record<StayStage, CopyKey> = {
  pre_arrival: "stagePreArrivalHint",
  arrival_day: "stageArrivalDayHint",
  in_house: "stageInHouseHint",
  departure_day: "stageDepartureDayHint",
  post_stay: "stagePostStayHint",
  cancelled: "stageCancelledHint"
};

/** true si hubo estancia (alojada o ya salida). */
export function stayHappened(reservationStatus: string): boolean {
  return STAYED_STATUSES.includes(reservationStatus);
}

/**
 * Aviso de la etapa. Corrector REV-L7-02: en `post_stay` con una reserva que
 * nunca se alojó (confirmada con la salida pasada) no se dan las gracias por
 * una estancia que no hubo: «La fecha de salida ya pasó sin registrar tu llegada».
 */
export function stageHintKey(stage: StayStage, reservationStatus: string): CopyKey {
  if (stage === "post_stay" && !stayHappened(reservationStatus)) return "stagePostStayMissedHint";
  return STAGE_HINT_KEY[stage];
}

export type StageTone = "ok" | "warn" | "info" | "error";

export const STAGE_TONE: Record<StayStage, StageTone> = {
  pre_arrival: "ok",
  arrival_day: "warn",
  in_house: "info",
  departure_day: "warn",
  post_stay: "info",
  cancelled: "error"
};

/** Etiqueta del estado de la reserva (`Reservation.status`); un valor desconocido se muestra tal cual. */
export const RESERVATION_STATUS_KEY: Record<string, CopyKey> = {
  confirmed: "resConfirmed",
  checked_in: "statusCheckedIn",
  checked_out: "resCheckedOut",
  cancelled: "resCancelled",
  no_show: "resNoShow"
};

export function reservationStatusLabel(status: string, lang: Lang): string {
  const key = RESERVATION_STATUS_KEY[status];
  return key ? t(lang, key) : status;
}

// ---------------------------------------------------------------------------
// Acción principal por etapa (CTA)
// ---------------------------------------------------------------------------

export type StayDestination = "precheckin" | "checkin" | "service" | "checkout" | "info" | "survey";

export type StayAction = { destination: StayDestination; labelKey: CopyKey; hintKey: CopyKey | null };

export type StayActions = { primary: StayAction | null; secondary: StayAction | null };

/** Sesiones CHK con las que el asistente todavía admite al huésped. */
const OPEN_CHECKIN_STATUSES: readonly string[] = ["invited", "in_progress", "ready_for_arrival", "arrived"];

function checkInAction(checkIn: StayCheckIn | null, stage: "pre_arrival" | "arrival_day"): StayAction | null {
  if (!checkIn) return { destination: "precheckin", labelKey: "preCheckInBlock", hintKey: "preCheckInHint" };
  if (!OPEN_CHECKIN_STATUSES.includes(checkIn.status)) return null;
  if (checkIn.status === "invited") return { destination: "checkin", labelKey: "startPreCheckIn", hintKey: "preCheckInHint" };
  if (checkIn.status === "in_progress") return { destination: "checkin", labelKey: "continuePreCheckIn", hintKey: "preCheckInHint" };
  // ready_for_arrival | arrived
  if (stage === "arrival_day") return { destination: "checkin", labelKey: "ctaArrive", hintKey: "ctaArriveHint" };
  return { destination: "checkin", labelKey: "reviewPreCheckIn", hintKey: "preCheckInHint" };
}

/**
 * Acciones de la estancia (brief L7-06): pre-llegada «Pre-check-in», llegada
 * «Llegar», en casa «Servicios / Salida», salida «Salida exprés», post-estancia
 * «Encuesta» (solo si el portal tiene la página de encuesta: `surveyEnabled`,
 * lote L7-04) y cancelada sin acción.
 */
export function stayActions(stage: StayStage, checkIn: StayCheckIn | null, survey: StaySurvey, options: { surveyEnabled?: boolean; /** false = la reserva nunca se alojó (corrector REV-L7-02): sin encuesta. */ stayed?: boolean } = {}): StayActions {
  const services: StayAction = { destination: "service", labelKey: "requestService", hintKey: "requestServiceHint" };
  const checkout: StayAction = { destination: "checkout", labelKey: "ctaCheckOut", hintKey: "ctaCheckOutHint" };
  switch (stage) {
    case "pre_arrival":
    case "arrival_day":
      return { primary: checkInAction(checkIn, stage), secondary: services };
    case "in_house":
      return { primary: services, secondary: checkout };
    case "departure_day":
      return { primary: { destination: "checkout", labelKey: "ctaExpressCheckOut", hintKey: "ctaExpressCheckOutHint" }, secondary: services };
    case "post_stay": {
      // L7-08: con la página de encuesta, «Responder la encuesta» es la acción
      // principal si el hotel invitó y no hay respuesta; sin invitación (el
      // hotel no envía encuestas o el huésped entró con su código) sigue
      // disponible como acción secundaria: el API la admite en post_stay.
      // Corrector REV-L7-02: sin estancia real (`stayed: false`) el API la
      // rechaza (409 SURVEY_NOT_AVAILABLE) y aquí no se ofrece.
      const surveyOpen = Boolean(options.surveyEnabled) && !survey.answered && options.stayed !== false;
      const surveyAction: StayAction = { destination: "survey", labelKey: "ctaSurvey", hintKey: "ctaSurveyHint" };
      const invoices: StayAction = { destination: "checkout", labelKey: "ctaInvoices", hintKey: "ctaInvoicesHint" };
      if (surveyOpen && survey.invited) return { primary: surveyAction, secondary: invoices };
      return { primary: invoices, secondary: surveyOpen ? surveyAction : null };
    }
    case "cancelled":
    default:
      return { primary: null, secondary: null };
  }
}

/** Acción principal (atajo de stayActions). */
export function primaryAction(stage: StayStage, checkIn: StayCheckIn | null, survey: StaySurvey = { invited: false, answered: false }, options: { surveyEnabled?: boolean } = {}): StayAction | null {
  return stayActions(stage, checkIn, survey, options).primary;
}

/** true si el pre-check-in (asistente o formulario clásico) sigue teniendo sentido en esta etapa. */
export function preCheckInRelevant(stage: StayStage): boolean {
  return stage === "pre_arrival" || stage === "arrival_day";
}

/**
 * Botón de la tarjeta del folio (corrector REV-L7-03): «Salida y cuenta» durante
 * la estancia, «Cuenta y facturas» tras la salida y NINGUNO con la reserva
 * cancelada (runbook §2: `cancelled` sin acciones ni chat).
 */
export function folioActionKey(stage: StayStage): CopyKey | null {
  if (stage === "cancelled") return null;
  if (stage === "post_stay") return "ctaInvoices";
  return "ctaCheckOut";
}

export type CheckOutCopy = { eyebrowKey: CopyKey; titleKey: CopyKey; subtitleKey: CopyKey };

/** Cabecera de CheckOutPage por etapa: la cancelada tiene la suya («Reserva cancelada · cargos de cancelación»). */
export function checkOutCopy(stage: StayStage | null): CheckOutCopy {
  if (stage === "cancelled") return { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutCancelledTitle", subtitleKey: "checkOutCancelledSubtitle" };
  if (stage === "post_stay") return { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutTitle", subtitleKey: "checkOutPostStaySubtitle" };
  return { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutTitle", subtitleKey: "checkOutSubtitle" };
}

// ---------------------------------------------------------------------------
// Peticiones de salida (19.4)
// ---------------------------------------------------------------------------

/** Qué peticiones ofrece el portal en cada etapa: las mismas que exige el API (409 STAY_REQUEST_NOT_ALLOWED / STAY_CLOSED fuera de ellas). */
export function checkOutOptions(stage: StayStage): StayRequestKind[] {
  return [...(STAY_REQUEST_KINDS_BY_STAGE[stage] ?? [])];
}

export const REQUEST_KIND_KEY: Record<string, { label: CopyKey; hint: CopyKey | null }> = {
  express_checkout: { label: "kindExpressCheckout", hint: "kindExpressCheckoutHint" },
  late_checkout: { label: "kindLateCheckout", hint: "kindLateCheckoutHint" },
  invoice_email: { label: "kindInvoiceEmail", hint: "kindInvoiceEmailHint" },
  luggage: { label: "kindLuggage", hint: "kindLuggageHint" },
  // Peticiones clásicas del portal (POST /guest-portal/service-request) y del asistente.
  housekeeping: { label: "catHousekeeping", hint: "catHousekeepingHint" },
  food_beverage: { label: "catFood", hint: "catFoodHint" },
  concierge: { label: "catConcierge", hint: "catConciergeHint" },
  maintenance: { label: "catMaintenance", hint: "catMaintenanceHint" }
};

export function requestKindLabel(kind: string, lang: Lang): string {
  const entry = REQUEST_KIND_KEY[kind];
  return entry ? t(lang, entry.label) : t(lang, "kindOther");
}

export const REQUEST_STATUS_KEY: Record<string, { label: CopyKey; tone: StageTone }> = {
  open: { label: "reqStatusOpen", tone: "warn" },
  pending: { label: "reqStatusOpen", tone: "warn" },
  in_progress: { label: "statusInProgress", tone: "info" },
  resolved: { label: "reqStatusResolved", tone: "ok" },
  done: { label: "reqStatusResolved", tone: "ok" },
  completed: { label: "reqStatusResolved", tone: "ok" },
  closed: { label: "reqStatusClosed", tone: "ok" },
  cancelled: { label: "resCancelled", tone: "error" },
  rejected: { label: "reqStatusRejected", tone: "error" }
};

export function requestStatusView(status: string, lang: Lang): { label: string; tone: StageTone } {
  const entry = REQUEST_STATUS_KEY[status];
  return entry ? { label: t(lang, entry.label), tone: entry.tone } : { label: status, tone: "info" };
}

/** Solo la salida tardía lleva hora preferida («HH:MM», regex del API). */
export function requestNeedsTime(kind: StayRequestKind): boolean {
  return kind === "late_checkout";
}

/** Cuerpo listo para el API: sin claves vacías (zod .strict() rechaza desconocidas; note ≤ 500, hora HH:MM). */
export function buildStayRequest(kind: StayRequestKind, note: string, preferredTime: string): StayRequestInput {
  const trimmedNote = note.trim().slice(0, 500);
  const time = preferredTime.trim();
  return {
    kind,
    ...(trimmedNote ? { note: trimmedNote } : {}),
    ...(requestNeedsTime(kind) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? { preferredTime: time } : {})
  };
}

// ---------------------------------------------------------------------------
// Folio (formato)
// ---------------------------------------------------------------------------

const LOCALE: Record<Lang, string> = { es: "es-ES", en: "en-GB" };

export function formatMoney(amount: number, currency: string | null | undefined, lang: Lang): string {
  const code = (currency ?? "EUR").trim() || "EUR";
  try {
    return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

/** «22 sept 2026» / «22 Sept 2026» a partir de un ISO (fecha o fecha-hora); "" si no es válido. */
export function formatDay(iso: string | null | undefined, lang: Lang, timeZone?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { day: "numeric", month: "short", year: "numeric", ...(iso.length === 10 ? { timeZone: "UTC" } : timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

/** «22 de septiembre» / «22 September» (sin año) para los avisos de etapa. */
export function formatDayLong(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return "";
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { day: "numeric", month: "long", timeZone: "UTC" }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

export type FolioLineView = { description: string; quantity: number; total: string; date: string };
export type FolioPaymentView = { amount: string; method: string; status: string; date: string };

export type FolioView = {
  status: StayFolioStatus;
  /** Clave del mensaje de estado (sin cargos / sin saldo / pendiente). */
  messageKey: CopyKey;
  balance: string;
  balanceDue: number;
  currency: string;
  charges: FolioLineView[];
  payments: FolioPaymentView[];
  totalCharges: string;
  totalPaid: string;
};

const PAYMENT_STATUS_KEY: Record<string, CopyKey> = {
  captured: "payStatusCaptured",
  succeeded: "payStatusCaptured",
  paid: "payStatusCaptured",
  completed: "payStatusCaptured",
  pending: "payStatusPending",
  authorized: "payStatusAuthorized",
  failed: "payStatusFailed",
  refunded: "payStatusRefunded"
};

/** PaymentMethod del API (schema.prisma): cash · card_terminal · card_online · bank_transfer · payment_link · other (+ alias antiguos). */
const PAYMENT_METHOD_KEY: Record<string, CopyKey> = {
  card: "payMethodCard",
  card_present: "payMethodCard",
  card_terminal: "payMethodCard",
  card_online: "payMethodCard",
  cash: "payMethodCash",
  transfer: "payMethodTransfer",
  bank_transfer: "payMethodTransfer",
  payment_link: "payMethodLink",
  other: "payMethodOther"
};

export function paymentStatusLabel(status: string, lang: Lang): string {
  const key = PAYMENT_STATUS_KEY[status];
  return key ? t(lang, key) : status;
}

export function paymentMethodLabel(method: string, lang: Lang): string {
  const key = PAYMENT_METHOD_KEY[method];
  return key ? t(lang, key) : method;
}

/** Clave del estado del folio para el huésped: sin líneas nunca es «todo pagado». */
export function folioStatusKey(folio: Pick<StayFolio, "status" | "charges">): CopyKey {
  if (folio.status === "balance_due") return "folioBalanceDue";
  if (folio.status === "no_folio" || folio.charges.length === 0) return "folioNoCharges";
  return "folioSettled";
}

/** Folio formateado para pintar; la moneda de la reserva sirve de respaldo cuando el folio no tiene. */
export function formatFolio(folio: StayFolio, lang: Lang, fallbackCurrency = "EUR", timeZone?: string | null): FolioView {
  const currency = folio.currency ?? fallbackCurrency;
  const totalCharges = folio.charges.reduce((sum, line) => sum + line.total, 0);
  const totalPaid = folio.payments.filter((payment) => PAYMENT_STATUS_KEY[payment.status] === "payStatusCaptured").reduce((sum, payment) => sum + payment.amount, 0);
  return {
    status: folio.status,
    messageKey: folioStatusKey(folio),
    balance: formatMoney(folio.balanceDue, currency, lang),
    balanceDue: folio.balanceDue,
    currency,
    charges: folio.charges.map((line) => ({ description: line.description, quantity: line.quantity, total: formatMoney(line.total, currency, lang), date: formatDay(line.postedAt, lang, timeZone) })),
    payments: folio.payments.map((payment) => ({ amount: formatMoney(payment.amount, currency, lang), method: paymentMethodLabel(payment.method, lang), status: paymentStatusLabel(payment.status, lang), date: formatDay(payment.createdAt, lang, timeZone) })),
    totalCharges: formatMoney(totalCharges, currency, lang),
    totalPaid: formatMoney(totalPaid, currency, lang)
  };
}

/** Texto corto del saldo para la cabecera de la estancia (sin folio → «Sin cargos todavía»). */
export function balanceSummary(folio: Pick<StayFolio, "status" | "balanceDue" | "currency" | "charges">, lang: Lang, fallbackCurrency = "EUR"): string {
  if (folio.status === "no_folio" || (folio.charges.length === 0 && folio.balanceDue <= 0)) return t(lang, "folioNoChargesShort");
  return formatMoney(folio.balanceDue, folio.currency ?? fallbackCurrency, lang);
}

// ---------------------------------------------------------------------------
// Pago honesto (19.5)
// ---------------------------------------------------------------------------

export type PaymentOutcome =
  | { kind: "nothing_due"; messageKey: CopyKey; redirect: null }
  | { kind: "settled"; messageKey: CopyKey; redirect: null }
  | { kind: "at_reception"; messageKey: CopyKey; redirect: null }
  | { kind: "link"; messageKey: CopyKey; redirect: PaymentRedirect };

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
}

/** Redirección utilizable del enlace (GET con URL http(s) o POST con URL y campos); null si el enlace no sirve. */
export function paymentRedirectOf(response: StayPaymentLinkResponse): PaymentRedirect | null {
  if (response.status !== "link_sent") return null;
  const redirect = response.link?.redirect;
  if (!redirect || !isHttpUrl(redirect.url)) return null;
  if (redirect.method === "POST") return { method: "POST", url: redirect.url.trim(), fields: { ...(redirect.fields ?? {}) } };
  return { method: "GET", url: redirect.url.trim() };
}

/**
 * Qué pintar tras `POST /guest-portal/stay/payment-link`: «Pagar ahora» SOLO con
 * enlace real; sin PSP «se cobra en recepción»; `settled` sin cargos es «sin
 * cargos todavía» (la reserva nace con folio vacío), nunca «todo pagado».
 */
export function paymentOutcome(response: StayPaymentLinkResponse, folio: Pick<StayFolio, "charges">): PaymentOutcome {
  switch (response.status) {
    case "no_folio":
    case "no_charges":
      return { kind: "nothing_due", messageKey: "paymentNoChargesYet", redirect: null };
    case "settled":
      return folio.charges.length > 0 ? { kind: "settled", messageKey: "paymentSettled", redirect: null } : { kind: "nothing_due", messageKey: "paymentNoChargesYet", redirect: null };
    case "link_sent": {
      const redirect = paymentRedirectOf(response);
      return redirect ? { kind: "link", messageKey: "paymentLinkReady", redirect } : { kind: "at_reception", messageKey: "paymentAtReceptionStay", redirect: null };
    }
    case "at_reception":
    default:
      return { kind: "at_reception", messageKey: "paymentAtReceptionStay", redirect: null };
  }
}

/** true si tiene sentido ofrecer «Quiero pagar ahora» (saldo real pendiente); nunca con la reserva cancelada (corrector REV-L7-03: los cargos de cancelación se gestionan en recepción, D3). */
export function canOfferPayment(folio: Pick<StayFolio, "status" | "balanceDue">, stage?: StayStage | null): boolean {
  if (stage === "cancelled") return false;
  return folio.status === "balance_due" && folio.balanceDue > 0;
}

// ---------------------------------------------------------------------------
// Datos del hotel (19.2 info) y facturas
// ---------------------------------------------------------------------------

export type InfoRow = { key: keyof StayInfo; labelKey: CopyKey; value: string; kind: "text" | "secret" | "phone" };

const INFO_ROWS: ReadonlyArray<{ key: keyof StayInfo; labelKey: CopyKey; kind: InfoRow["kind"] }> = [
  { key: "wifiName", labelKey: "infoWifi", kind: "text" },
  { key: "wifiPassword", labelKey: "infoWifiPassword", kind: "secret" },
  { key: "breakfastHours", labelKey: "infoBreakfast", kind: "text" },
  { key: "checkOutTime", labelKey: "infoCheckOutTime", kind: "text" },
  { key: "receptionPhone", labelKey: "infoReceptionPhone", kind: "phone" },
  { key: "address", labelKey: "infoAddress", kind: "text" }
];

/** Solo las filas que el API devuelve con valor: lo no configurado no se inventa. */
export function infoRows(info: StayInfo): InfoRow[] {
  return INFO_ROWS.flatMap((row) => {
    const raw = info[row.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    return value ? [{ key: row.key, labelKey: row.labelKey, value, kind: row.kind }] : [];
  });
}

/** `tel:` solo con dígitos, «+», espacios, puntos, guiones y paréntesis (sin texto libre); null si no parece un teléfono. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s().-]/g, "");
  return /^\+?\d{6,15}$/.test(cleaned) ? `tel:${cleaned}` : null;
}

export function invoiceLabel(invoice: Pick<StayInvoice, "number">, lang: Lang): string {
  return invoice.number ? t(lang, "invoiceLabel", { number: invoice.number }) : t(lang, "invoiceNoNumber");
}

/** Nombre del fichero a partir de Content-Disposition (`filename="FAC-…pdf"`); respaldo `factura-<id>.pdf`. */
export function invoiceFilename(contentDisposition: string | null | undefined, invoiceId: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition ?? "");
  const name = match?.[1]?.trim();
  if (name && /\.pdf$/i.test(name) && !/[\\/]/.test(name)) return name;
  return `factura-${invoiceId}.pdf`;
}

// ---------------------------------------------------------------------------
// Encuesta post-estancia (19.7 · L7-08; espejo de GuestSurveyView y GuestSurveySubmitInput)
// ---------------------------------------------------------------------------

export const SURVEY_QUESTION_TYPES = ["nps", "text", "scale"] as const;
export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

/** Pregunta normalizada por el API (`Survey.questionsJson` del editor o el cuestionario por defecto). */
export type SurveyQuestion = { key: string; type: SurveyQuestionType; label: string; required: boolean };

/** `GET /guest-portal/survey`. */
export type SurveyView = {
  survey: { id: string | null; name: string; questions: SurveyQuestion[] };
  answered: boolean;
  answeredAt: string | null;
  /** true solo con la reserva checked_out en post_stay y sin respuesta previa. */
  available: boolean;
  stage: StayStage;
  /** `Reservation.status` (corrector REV-L7-02: confirmada con la salida pasada → sin encuesta). */
  reservationStatus: string;
  /** Cabecera mínima sin PII (la sesión `survey` del enlace no puede leer la reserva). */
  reservation: { reservationId: string; reservationCode: string; propertyId: string; propertyName: string };
  /** Ámbito de la sesión con la que se pidió (corrector L7-REV-01). */
  sessionPurpose: SessionPurpose;
};

/** Cuerpo de `POST /guest-portal/survey` (zod .strict(): score entero 0-10; answers ≤ 20 claves, texto ≤ 2000 o número). */
export type SurveySubmitInput = { score: number; answers?: Record<string, string | number> };

/** 201 de `POST /guest-portal/survey`. */
export type SurveySubmitResult = { responseId: string; surveyId: string; score: number; answeredAt: string };

/** NPS 0-10 (regla del API y de dashboards/surveys.service.ts). */
export const NPS_SCORES: readonly number[] = Object.freeze(Array.from({ length: 11 }, (_, index) => index));
/** Escala corta 1-5 de las preguntas `scale` del editor. */
export const SCALE_VALUES: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);
/** Límites del API (SURVEY_ANSWER_TEXT_MAX / SURVEY_ANSWER_MAX_KEYS de post-stay-survey.service.ts). */
export const SURVEY_TEXT_MAX = 2000;
export const SURVEY_MAX_ANSWERS = 20;

export type SurveyStatus = "form" | "answered" | "not_yet" | "closed";

/**
 * Qué pintar: formulario solo si el API la declara disponible; ya respondida
 * (con fecha); todavía no (antes de la salida); reserva cancelada —o que nunca
 * se alojó (confirmada con la salida pasada, corrector REV-L7-02)— sin encuesta.
 */
export function surveyStatus(view: Pick<SurveyView, "answered" | "available" | "stage"> & Partial<Pick<SurveyView, "reservationStatus">>): SurveyStatus {
  if (view.answered) return "answered";
  if (view.available) return "form";
  if (view.stage === "cancelled") return "closed";
  if (view.stage === "post_stay" && typeof view.reservationStatus === "string" && !stayHappened(view.reservationStatus)) return "closed";
  return "not_yet";
}

export const SURVEY_STATUS_KEY: Record<Exclude<SurveyStatus, "form">, CopyKey> = {
  answered: "surveyAlreadyAnswered",
  not_yet: "surveyNotYet",
  closed: "surveyClosed"
};

/** Entero 0-10. */
export function isNpsScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10;
}

/** La pregunta cuya respuesta viaja como `score`: la primera `nps` (el API la exige aunque el cuestionario del hotel no la tenga). */
export function scoreQuestion(questions: readonly SurveyQuestion[]): SurveyQuestion | null {
  return questions.find((question) => question.type === "nps") ?? null;
}

/** El resto del cuestionario (texto, escala y otras nps), en su orden. */
export function extraQuestions(questions: readonly SurveyQuestion[]): SurveyQuestion[] {
  const main = scoreQuestion(questions);
  return questions.filter((question) => question !== main);
}

/** Borrador del formulario: puntuación principal y respuestas por clave como texto (controles controlados). */
export type SurveyDraft = { score: number | null; answers: Record<string, string> };

export type SurveyErrors = { score: CopyKey | null; answers: Record<string, CopyKey> };

function allowedValues(question: SurveyQuestion): readonly number[] {
  return question.type === "nps" ? NPS_SCORES : SCALE_VALUES;
}

/** Validación en cliente (misma regla que el API: score 0-10 obligatorio; requeridas con texto; texto ≤ 2000; escalas dentro de rango). */
export function validateSurvey(questions: readonly SurveyQuestion[], draft: SurveyDraft): SurveyErrors {
  const errors: SurveyErrors = { score: isNpsScore(draft.score) ? null : "surveyScoreRequired", answers: {} };
  for (const question of extraQuestions(questions)) {
    const raw = (draft.answers[question.key] ?? "").trim();
    if (!raw) {
      if (question.required) errors.answers[question.key] = "surveyAnswerRequired";
      continue;
    }
    if (question.type === "text") {
      if (raw.length > SURVEY_TEXT_MAX) errors.answers[question.key] = "surveyAnswerTooLong";
      continue;
    }
    const value = Number(raw);
    if (!allowedValues(question).includes(value)) errors.answers[question.key] = "surveyAnswerRequired";
  }
  return errors;
}

export function surveyHasErrors(errors: SurveyErrors): boolean {
  return errors.score !== null || Object.keys(errors.answers).length > 0;
}

/**
 * Cuerpo listo para el API: `score` y solo las respuestas con valor (texto
 * recortado a 2000, escalas como número), ≤ 20 claves; sin `answers` si no hay ninguna.
 */
export function buildSurveySubmission(questions: readonly SurveyQuestion[], draft: SurveyDraft): SurveySubmitInput {
  const score = isNpsScore(draft.score) ? draft.score : 0;
  const answers: Record<string, string | number> = {};
  for (const question of extraQuestions(questions)) {
    if (Object.keys(answers).length >= SURVEY_MAX_ANSWERS) break;
    const raw = (draft.answers[question.key] ?? "").trim();
    if (!raw) continue;
    answers[question.key] = question.type === "text" ? raw.slice(0, SURVEY_TEXT_MAX) : Number(raw);
  }
  return Object.keys(answers).length > 0 ? { score, answers } : { score };
}

/** Clave del mensaje para un `details.code` del API al enviar (o al cargar) la encuesta. */
export function surveyErrorKey(code: string | null | undefined): CopyKey {
  switch (code) {
    case "SURVEY_ALREADY_ANSWERED":
      return "surveyAlreadyAnswered";
    case "SURVEY_NOT_AVAILABLE":
      return "surveyNotYet";
    case "GUEST_SESSION_INVALID":
      return "surveySessionExpired";
    default:
      return "surveySendError";
  }
}
