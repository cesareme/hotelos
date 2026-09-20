// Tiny fetch wrapper for the guest portal.
//
// The guest portal speaks to the ehotelOS API on the same origin in
// production. During local dev the user can override the base URL via
// `VITE_GUEST_API_BASE`. When that env var is UNSET we fall back to typed
// stubs so the UI keeps working offline for demos. When it IS set we call the
// real Sprint 40 guest-portal endpoints:
//   POST /guest-portal/sign-in            (body: reservationCode, email, propertyId — config/guest-config.ts)
//   POST /guest-portal/sign-out
//   GET  /guest-portal/reservation        (x-guest-token header)
//   POST /guest-portal/pre-check-in       (x-guest-token header)
//   POST /guest-portal/service-request    (x-guest-token header)
// Tanda CHK · lote W4-C (asistente de 6 pasos, kiosco y bot; diseño §7.1):
//   GET/PATCH /guest-portal/check-in                          sesión (viajeros, pasos, política)
//   POST/PATCH/DELETE /guest-portal/check-in/guests[/:id]     alta / edición / baja de viajeros
//   POST /guest-portal/check-in/guests/:id/document           imagen data: URL y/o líneas MRZ
//   POST /guest-portal/check-in/guests/:id/mrz                líneas MRZ (lector o teclado)
//   POST /guest-portal/check-in/guests/:id/signature          PNG base64 + SVG + strokeMeta
//   POST /guest-portal/check-in/complete                      cierre del pre-check-in (crea los partes)
//   POST /guest-portal/check-in/payment-link                  enlace de pago o «en recepción»
//   POST /guest-portal/check-in/otp/request · …/otp/verify    verificación en línea
//   POST /guest-portal/check-in/arrive                        llegada → habitación + llave
//   POST /guest-portal/check-in/kiosk/claim                   código de emparejamiento → deviceToken
//   POST /guest-portal/chat                                   bot del huésped (W4-D)
// Tanda L7 · lote L7-06 (estancia y salida; tipos en stay/stay.ts, contrato L7-02):
//   GET  /guest-portal/stay                                   etapa, reserva, check-in, folio REAL, facturas, info, peticiones, encuesta
//   POST /guest-portal/stay/requests                          salida exprés · salida tardía · factura por correo · consigna → SRQ-<8>
//   POST /guest-portal/stay/payment-link                      enlace de pago honesto (link_sent | at_reception | settled | no_folio)
//   GET  /guest-portal/invoices/:id/pdf                       PDF de una factura emitida de la reserva (token por cabecera, nunca en la URL)
// Tanda L7 · lote L7-08 (encuesta post-estancia; tipos en stay/stay.ts, contrato L7-04 §19.7):
//   GET  /guest-portal/survey                                 cuestionario (Survey post_stay o por defecto), answered/answeredAt, available, stage
//   POST /guest-portal/survey                                 { score 0-10, answers? } → 201 { responseId, surveyId, score, answeredAt }; 409 SURVEY_ALREADY_ANSWERED | SURVEY_NOT_AVAILABLE
// Cabeceras: `x-guest-token` siempre que hay sesión; `x-kiosk-token` solo en modo
// kiosco (setKioskToken). Sin VITE_GUEST_API_BASE todo sigue con stubs en memoria.

import { resolveGuestPropertyId } from "../config/guest-config";
import { normalizeMrzText } from "../checkin/wizard";
import type { WizardGuest, WizardPolicy, WizardSession } from "../checkin/wizard";
import { invoiceFilename } from "../stay/stay";
import type { StayInvoice, StayPaymentLinkResponse, StayRequestInput, StayRequestResult, StayView, SurveySubmitInput, SurveySubmitResult, SurveyView } from "../stay/stay";

export type ReservationSummary = {
  id: string;
  reservationCode: string;
  propertyId: string;
  propertyName: string;
  guestName: string;
  roomType: string;
  roomNumber?: string;
  arrival: string; // ISO date
  departure: string; // ISO date
  guests: number;
  status: "confirmed" | "checked_in" | "checked_out" | "cancelled";
  balanceDue: number;
  currency: string;
  // Tanda CHK (L0): hora estimada de llegada «HH:MM» (Reservation.eta) si el huésped la indicó.
  eta?: string;
  /** Zona horaria IANA de la propiedad (corrector REV3-14): la validez de la llave se muestra en la hora del hotel. */
  propertyTimezone?: string;
};

export type PreCheckInPayload = {
  documentType: "passport" | "dni" | "nie" | "other";
  documentNumber: string;
  residenceAddress: string;
  country: string;
  arrivalEta: string; // ISO datetime
  specialRequests?: string;
};

export type ServiceRequestPayload = {
  category: "housekeeping" | "food_beverage" | "concierge" | "maintenance";
  description: string;
  preferredTime?: string;
};

export type SignInPayload = {
  reservationCode: string;
  email: string;
  // Tanda CHK (L0): el API exige el hotel (Reservation.code es único por
  // propiedad). Si no viene, se resuelve con resolveGuestPropertyId().
  propertyId?: string;
};

export type GuestSession = {
  reservationId: string;
  reservationCode: string;
  email: string;
  // Short-lived guest bearer token returned by the real API. Sent on every
  // subsequent request via the `x-guest-token` header.
  token?: string;
  /**
   * Corrector L7-REV-01: `survey` = sesión del enlace de la encuesta (30 días),
   * que el API SOLO admite en GET|POST /guest-portal/survey. El Router monta
   * únicamente SurveyPage y el resto del portal pide el código de reserva.
   */
  scope?: "survey";
};

const baseUrl = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GUEST_API_BASE ?? "").replace(/\/$/, "");

// In-memory guest token for the current portal session. We deliberately keep
// it in module state (not localStorage) so it lives only as long as the tab —
// the token is short-lived and sensitive.
let guestToken: string | null = null;

export function setGuestToken(token: string | null): void {
  guestToken = token;
}

export function getGuestToken(): string | null {
  return guestToken;
}

// Kiosk device token (Tanda CHK · W4-C). Only set in `?kiosk=1` mode; sent as
// `x-kiosk-token` next to the guest token so the API records the kiosk as the
// actor (touch_kiosk signatures, actor "kiosk" on arrive). Never a guest secret.
let kioskToken: string | null = null;

export function setKioskToken(token: string | null): void {
  kioskToken = token;
}

export function getKioskToken(): string | null {
  return kioskToken;
}

function guestHeaders(): Record<string, string> {
  return {
    ...(guestToken ? { "x-guest-token": guestToken } : {}),
    ...(kioskToken ? { "x-kiosk-token": kioskToken } : {})
  };
}

/**
 * Error tipado del API: `status` HTTP, `code` de `details.code` (p. ej.
 * ROOM_NOT_READY, CHECKIN_INCOMPLETE, KIOSK_PAIRING_INVALID) y `details`
 * completos para que el asistente decida el paso al que volver. Extiende Error
 * para que los `catch` existentes sigan leyendo `.message`.
 */
export class ApiError extends Error {
  status: number;
  code: string | null;
  details: Record<string, unknown> | null;

  constructor(message: string, status: number, details?: Record<string, unknown> | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details ?? null;
    this.code = typeof details?.code === "string" ? details.code : null;
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Tanda L7 · L7-06: `Content-Type: application/json` SOLO cuando hay cuerpo.
  // Con la cabecera y sin cuerpo (DELETE …/guests/:id, «Quitar» viajero) Fastify
  // respondía 400 «Body cannot be empty» antes de llegar a la ruta.
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined && init?.body !== null ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let details: Record<string, unknown> | null = null;
    try {
      const body = (await response.json()) as { message?: string; details?: Record<string, unknown> };
      if (body.message) message = body.message;
      if (body.details && typeof body.details === "object") details = body.details;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(message, response.status, details);
  }
  // Tolerate empty bodies (204).
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- Sign-in --------------------------------------------------------------
// Real endpoint: POST /guest-portal/sign-in (anti-enumeration — returns
// { ok: false } for both a bad code and a wrong email). On success the API
// returns a short-lived token which we store for subsequent requests.
export async function signIn(payload: SignInPayload): Promise<GuestSession> {
  const code = payload.reservationCode.trim();
  const email = payload.email.trim();
  const propertyId = (payload.propertyId ?? "").trim() || resolveGuestPropertyId();
  if (!code || !email) {
    throw new Error("We couldn't find a reservation matching that code and email. Try again or contact the hotel.");
  }

  if (!baseUrl) {
    // Offline demo fallback — accept any non-empty code+email.
    await new Promise((r) => setTimeout(r, 350));
    return { reservationId: "res_demo_001", reservationCode: code.toUpperCase(), email };
  }

  // Sin hotel el API contesta ok:false (anti-enumeración); lo decimos antes de
  // llamar para que el huésped sepa que le falta el enlace del hotel, no que
  // se equivocó de código.
  if (!propertyId) {
    throw new Error("This portal link is missing the hotel identifier. Open the link the hotel sent you or contact reception.");
  }

  const result = await request<
    { ok: true; token: string; reservationId: string } | { ok: false }
  >("/guest-portal/sign-in", {
    method: "POST",
    body: JSON.stringify({ reservationCode: code, email, propertyId })
  });

  if (!result.ok) {
    throw new Error("We couldn't find a reservation matching that code and email. Try again or contact the hotel.");
  }

  setGuestToken(result.token);
  return {
    reservationId: result.reservationId,
    reservationCode: code.toUpperCase(),
    email,
    token: result.token
  };
}

// ---- Magic-link token ------------------------------------------------------
// Sprint 45: the guest receives an email with a single-use `?token=` link.
// On app load we exchange that token for a session by setting it as the active
// guest token and verifying it against GET /guest-portal/reservation. A valid
// token yields a full GuestSession; an invalid/expired token returns null so
// the caller can show the sign-in form with a friendly "link expired" message.
export async function signInWithToken(token: string, options: { /** `survey`: enlace de la encuesta → se verifica contra GET /guest-portal/survey (la sesión `survey` no puede leer la reserva). */ scope?: "survey" } = {}): Promise<GuestSession | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  // Offline demo fallback — accept any non-empty token so the preview works
  // without a live API.
  if (!baseUrl) {
    setGuestToken(trimmed);
    const stub = stubReservation("res_demo_001");
    return {
      reservationId: stub.id,
      reservationCode: stub.reservationCode,
      email: "",
      token: trimmed
    };
  }

  setGuestToken(trimmed);
  try {
    if (options.scope === "survey") {
      // Corrector L7-REV-01: el enlace de la encuesta abre una sesión acotada; el API devuelve la
      // cabecera mínima de la reserva (código, hotel) y el ámbito real de la sesión.
      const view = await request<SurveyView>(SURVEY_PATH, { headers: guestHeaders() });
      return {
        reservationId: view.reservation.reservationId,
        reservationCode: view.reservation.reservationCode,
        email: "",
        token: trimmed,
        ...(view.sessionPurpose === "survey" ? { scope: "survey" as const } : {})
      };
    }
    const raw = await request<Record<string, unknown>>("/guest-portal/reservation", {
      headers: guestHeaders()
    });
    const reservation = normaliseReservation(raw, "");
    return {
      reservationId: reservation.id,
      reservationCode: reservation.reservationCode,
      email: "",
      token: trimmed
    };
  } catch {
    // Invalid or expired token — clear it so we don't keep sending a dead
    // header on subsequent requests.
    setGuestToken(null);
    return null;
  }
}

// ---- Sign-out -------------------------------------------------------------
export async function signOut(): Promise<void> {
  const token = guestToken;
  setGuestToken(null);
  if (!baseUrl || !token) return;
  try {
    await request<{ ok: true }>("/guest-portal/sign-out", {
      method: "POST",
      body: JSON.stringify({ token })
    });
  } catch {
    // Best-effort: local token is already cleared above.
  }
}

// ---- Reservation summary --------------------------------------------------
export async function getReservation(reservationId: string): Promise<ReservationSummary> {
  // Sin API configurada (demo pura sin backend) el stub es legítimo.
  if (!baseUrl) return stubReservation(reservationId);
  // Auditoría 2026-07: con API real, un error NO debe degradar a la reserva
  // falsa de demostración (Maria Lopez / RES-2026-00042) — el huésped vería
  // datos inventados como si fueran suyos. Propagar para que la UI muestre
  // "no pudimos cargar tu reserva" y permita reintentar.
  const raw = await request<Record<string, unknown>>("/guest-portal/reservation", {
    headers: guestHeaders()
  });
  return normaliseReservation(raw, reservationId);
}

function normaliseReservation(raw: Record<string, unknown>, id: string): ReservationSummary {
  // GET /guest-portal/reservation returns a safe projection (Tanda CHK · L0):
  //   { reservationId, reservationCode, propertyId, propertyName, status,
  //     arrivalDate, departureDate, roomType, assignedRoomNumber, eta,
  //     primaryGuest: { firstName, surname1Initial } | null,
  //     guestCount, balanceDue, currency }
  // primaryGuest is the booking holder only (never companions' data), reduced
  // to first name + initial of the first surname.
  const guest = (raw.primaryGuest as Record<string, unknown> | null | undefined) ?? {};
  const firstName = String(guest.firstName ?? "").trim();
  const surnameInitial = String(guest.surname1Initial ?? guest.lastName ?? "").trim();
  const composedName = `${firstName} ${surnameInitial}`.trim();
  const eta = typeof raw.eta === "string" && raw.eta.trim() !== "" ? raw.eta.trim() : undefined;
  return {
    id: String(raw.reservationId ?? raw.id ?? id),
    reservationCode: String(raw.reservationCode ?? raw.code ?? "RES"),
    propertyId: String(raw.propertyId ?? ""),
    propertyName: String(raw.propertyName ?? "Your hotel"),
    guestName: composedName || String(raw.guestName ?? "Guest"),
    roomType: String(raw.roomType ?? raw.roomTypeName ?? "Room"),
    roomNumber: raw.assignedRoomNumber ? String(raw.assignedRoomNumber) : undefined,
    arrival: String(raw.arrivalDate ?? raw.arrival ?? ""),
    departure: String(raw.departureDate ?? raw.departure ?? ""),
    guests: Number(raw.guestCount ?? raw.guests ?? 1),
    status: (String(raw.status ?? "confirmed") as ReservationSummary["status"]),
    balanceDue: Number(raw.balanceDue ?? 0),
    currency: String(raw.currency ?? "EUR"),
    ...(eta ? { eta } : {}),
    ...(typeof raw.propertyTimezone === "string" && raw.propertyTimezone.trim() ? { propertyTimezone: raw.propertyTimezone.trim() } : {})
  };
}

function stubReservation(id: string): ReservationSummary {
  return {
    id,
    reservationCode: "RES-2026-00042",
    propertyId: "prop_demo",
    propertyName: "Hotel Demo Madrid Centro",
    guestName: "Maria Lopez Garcia",
    roomType: "Deluxe King with city view",
    roomNumber: "432",
    arrival: "2026-05-22",
    departure: "2026-05-25",
    guests: 2,
    status: "confirmed",
    balanceDue: 0,
    currency: "EUR"
  };
}

// ---- Pre-check-in ---------------------------------------------------------
// Real endpoint: POST /guest-portal/pre-check-in (x-guest-token header).
export async function submitPreCheckIn(reservationId: string, payload: PreCheckInPayload): Promise<{ confirmationNumber: string }> {
  if (!baseUrl) {
    await new Promise((r) => setTimeout(r, 400));
    const id = reservationId.slice(-4).toUpperCase();
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    void payload;
    return { confirmationNumber: `PCI-${id}-${stamp}` };
  }
  return request<{ confirmationNumber: string }>("/guest-portal/pre-check-in", {
    method: "POST",
    headers: guestHeaders(),
    body: JSON.stringify(payload)
  });
}

// ---- Service request ------------------------------------------------------
// Real endpoint: POST /guest-portal/service-request (x-guest-token header).
export async function submitServiceRequest(reservationId: string, payload: ServiceRequestPayload): Promise<{ ticketNumber: string }> {
  if (!baseUrl) {
    await new Promise((r) => setTimeout(r, 350));
    void reservationId;
    void payload;
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    return { ticketNumber: `SRQ-${stamp}` };
  }
  return request<{ ticketNumber: string }>("/guest-portal/service-request", {
    method: "POST",
    headers: guestHeaders(),
    body: JSON.stringify(payload)
  });
}

// ===========================================================================
// Tanda L7 · L7-06 — estancia y salida (folio real, facturas, peticiones, pago honesto)
// ===========================================================================
//
// Contrato de L7-02 (docs/api-contracts.md «Portal del huésped · estancia y
// salida»; tipos espejo en stay/stay.ts). El antiguo `downloadInvoice` (un .txt
// generado en el navegador) se retira: la factura es el PDF real del API o no es.
// Sin API (`!baseUrl`) los stubs son de demostración y la UI lo dice (demoNoApi).

const STAY_PATH = "/guest-portal/stay";

export type { StayInvoice, StayPaymentLinkResponse, StayRequestInput, StayRequestResult, StayView } from "../stay/stay";

let stubStayState: StayView | null = null;

function ensureStubStay(): StayView {
  if (stubStayState) return stubStayState;
  const reservation = stubReservation("res_demo_001");
  const session = ensureStubSession();
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
  stubStayState = {
    stage: "in_house",
    today: new Date().toISOString().slice(0, 10),
    reservation: {
      reservationId: reservation.id,
      reservationCode: reservation.reservationCode,
      propertyId: reservation.propertyId,
      propertyName: reservation.propertyName,
      propertyTimezone: "Europe/Madrid",
      status: "checked_in",
      arrivalDate: day(-1).slice(0, 10),
      departureDate: day(2).slice(0, 10),
      roomType: reservation.roomType,
      assignedRoomNumber: reservation.roomNumber ?? null,
      eta: null,
      primaryGuest: { firstName: "Maria", surname1Initial: "L." },
      guestCount: reservation.guests,
      balanceDue: 186,
      currency: reservation.currency
    },
    checkIn: { status: session.status, keyIssued: false },
    folio: {
      status: "balance_due",
      balanceDue: 186,
      currency: "EUR",
      charges: [
        { description: "Alojamiento (demo)", quantity: 2, total: 240, postedAt: day(-1) },
        { description: "Desayuno (demo)", quantity: 2, total: 36, postedAt: day(0) }
      ],
      payments: [{ amount: 90, method: "card", status: "captured", createdAt: day(-1) }]
    },
    invoices: [],
    info: { wifiName: "HotelDemo-Huespedes", wifiPassword: "demo1234", breakfastHours: "07:30–10:30", checkOutTime: "12:00", receptionPhone: null, address: "Calle Demo 1, 28001 Madrid" },
    requests: [],
    survey: { invited: false, answered: false }
  };
  return stubStayState;
}

/** Vista completa de la estancia (GET /guest-portal/stay). Sin API: estancia de demostración en memoria. */
export async function getStay(): Promise<StayView> {
  if (!baseUrl) {
    await delay(200);
    return structuredClone(ensureStubStay());
  }
  return request<StayView>(STAY_PATH, { headers: guestHeaders() });
}

/** Petición de salida (POST /guest-portal/stay/requests → 201 { id, ticketNumber: "SRQ-<8>", kind, status: "open" }; 409 STAY_CLOSED). */
export async function requestStayAction(input: StayRequestInput): Promise<StayRequestResult> {
  if (!baseUrl) {
    await delay(300);
    const stay = ensureStubStay();
    const stamp = Date.now().toString(36).toUpperCase().slice(-8).padStart(8, "0");
    const id = `srq_demo_${stamp.toLowerCase()}`;
    stay.requests.unshift({ id, kind: input.kind, status: "open", createdAt: new Date().toISOString() });
    return { id, ticketNumber: `SRQ-${stamp}`, kind: input.kind, status: "open" };
  }
  return request<StayRequestResult>(`${STAY_PATH}/requests`, { method: "POST", headers: guestHeaders(), body: JSON.stringify(input) });
}

/**
 * Enlace de pago del saldo del folio (POST /guest-portal/stay/payment-link).
 * Misma forma que `requestPaymentLink` del pre-check-in; el API nunca marca un
 * pago como hecho. Sin API: «se cobra en recepción» (no hay PSP de demostración).
 */
export async function requestStayPaymentLink(input: { returnUrl?: string; clientRequestId?: string } = {}): Promise<StayPaymentLinkResponse> {
  if (!baseUrl) {
    await delay(300);
    const stay = ensureStubStay();
    if (stay.folio.status === "no_folio") return { status: "no_folio", paymentStatus: "none" };
    if (stay.folio.charges.length === 0) return { status: "no_charges", paymentStatus: "none" };
    if (stay.folio.balanceDue <= 0) return { status: "settled", paymentStatus: "paid" };
    return { status: "at_reception", paymentStatus: "at_reception", reason: "DEMO_SIN_API" };
  }
  return request<StayPaymentLinkResponse>(`${STAY_PATH}/payment-link`, { method: "POST", headers: guestHeaders(), body: JSON.stringify(input) });
}

/**
 * PDF de una factura emitida de la reserva (GET /guest-portal/invoices/:id/pdf).
 * El token viaja SOLO en la cabecera (el API admite `?token=` en GET, pero así no
 * acaba en el historial ni en los logs). 404 si la factura no es de la reserva.
 */
export async function invoicePdfBlob(invoiceId: string): Promise<{ blob: Blob; filename: string }> {
  if (!baseUrl) {
    await delay(200);
    throw new ApiError("Sin API no hay facturas que descargar (demostración).", 404, { code: "DEMO_NO_API" });
  }
  const response = await fetch(`${baseUrl}/guest-portal/invoices/${encodeURIComponent(invoiceId)}/pdf`, {
    headers: { Accept: "application/pdf", ...guestHeaders() }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let details: Record<string, unknown> | null = null;
    try {
      const body = (await response.json()) as { message?: string; details?: Record<string, unknown> };
      if (body.message) message = body.message;
      if (body.details && typeof body.details === "object") details = body.details;
    } catch {
      // cuerpo no JSON
    }
    throw new ApiError(message, response.status, details);
  }
  const blob = await response.blob();
  return { blob, filename: invoiceFilename(response.headers.get("content-disposition"), invoiceId) };
}

/** Descarga (o abre) el PDF de la factura en el navegador; devuelve el nombre del fichero. */
export async function saveInvoicePdf(invoice: Pick<StayInvoice, "id">): Promise<string> {
  const { blob, filename } = await invoicePdfBlob(invoice.id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return filename;
}

// ---- Encuesta post-estancia (Tanda L7 · L7-08) ----------------------------------
//
// Contrato de L7-04 (docs/api-contracts.md «Encuesta post-estancia»; tipos
// espejo en stay/stay.ts). El enlace del correo es `/?survey=1&token=…&property=…`
// (App.tsx wantsSurvey). Sin API: cuestionario por defecto en memoria, una sola
// respuesta (como el API) y la UI avisa de que es una demostración (demoNoApi).

const SURVEY_PATH = "/guest-portal/survey";

export type { SurveyQuestion, SurveySubmitInput, SurveySubmitResult, SurveyView } from "../stay/stay";

let stubSurveyState: SurveyView | null = null;

function ensureStubSurvey(): SurveyView {
  if (stubSurveyState) return stubSurveyState;
  stubSurveyState = {
    // Mismo cuestionario que DEFAULT_GUEST_SURVEY_QUESTIONS (guest-portal-types.ts); `id` null hasta el primer envío, como el API.
    survey: {
      id: null,
      name: "Encuesta post-estancia (demo)",
      questions: [
        { key: "nps", type: "nps", label: "¿Recomendarías el hotel a un amigo o familiar? (0 = nada probable · 10 = seguro)", required: true },
        { key: "comment", type: "text", label: "¿Qué podríamos mejorar?", required: false }
      ]
    },
    answered: false,
    answeredAt: null,
    available: true,
    stage: "post_stay",
    reservationStatus: "checked_out",
    reservation: { reservationId: "res_demo_001", reservationCode: "RES-2026-00042", propertyId: "prop_demo", propertyName: "Hotel de demostración" },
    sessionPurpose: "sign_in"
  };
  return stubSurveyState;
}

/** Cuestionario y estado de la encuesta (GET /guest-portal/survey). Sin API: demostración en memoria. */
export async function getSurvey(): Promise<SurveyView> {
  if (!baseUrl) {
    await delay(200);
    return structuredClone(ensureStubSurvey());
  }
  return request<SurveyView>(SURVEY_PATH, { headers: guestHeaders() });
}

/**
 * Envía la respuesta (POST /guest-portal/survey → 201). El API garantiza una
 * respuesta por reserva (409 SURVEY_ALREADY_ANSWERED) y solo en post_stay
 * (409 SURVEY_NOT_AVAILABLE); el token viaja SOLO en la cabecera.
 */
export async function submitSurvey(input: SurveySubmitInput): Promise<SurveySubmitResult> {
  if (!baseUrl) {
    await delay(300);
    const survey = ensureStubSurvey();
    if (survey.answered) throw new ApiError("Ya has respondido a esta encuesta.", 409, { code: "SURVEY_ALREADY_ANSWERED", answeredAt: survey.answeredAt });
    const answeredAt = new Date().toISOString();
    survey.answered = true;
    survey.answeredAt = answeredAt;
    survey.available = false;
    survey.survey.id = survey.survey.id ?? "survey_demo";
    return { responseId: "resp_demo", surveyId: survey.survey.id, score: input.score, answeredAt };
  }
  return request<SurveySubmitResult>(SURVEY_PATH, { method: "POST", headers: guestHeaders(), body: JSON.stringify(input) });
}

// ===========================================================================
// Tanda CHK · W4-C — pre-check-in de 6 pasos, kiosco y bot
// ===========================================================================
//
// Los tipos son un espejo estructural de packages/shared/src/checkin-types.ts
// (no se importa @hotelos/shared: el paquete no tiene dist y Vite no resuelve
// los paths del tsconfig). Ningún DTO transporta PII más allá del nombre y los
// 3 últimos caracteres del documento; los valores del documento SOLO viajan en
// memoria en `DocumentCaptureResponse.capture.fields` justo tras la captura.

export type CheckInSession = Omit<WizardSession, "guests"> & {
  guests: CheckInGuest[];
  channel: string;
  invitedAt: string | null;
  completedAt: string | null;
  arrivedAt: string | null;
  checkedInAt: string | null;
  handoffKind: string | null;
  handoffReason: string | null;
  kioskDeviceId: string | null;
  steps: Array<{ key: string; status: string }>;
  policy: WizardPolicy & { inviteDaysBefore?: number; reminderDaysBefore?: number; depositAmount?: string | null; guestConsentText?: string | null; aiDisclosureText?: string | null };
  createdAt: string;
  updatedAt: string;
};

export type CheckInGuest = WizardGuest & { sessionId: string; guestId: string | null; createdAt: string; updatedAt: string };

/** Alta/edición de un viajero (GuestInputSchema del API; todo opcional). */
export type GuestInput = {
  firstName?: string | null;
  surname1?: string | null;
  surname2?: string | null;
  sex?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  documentSupportNumber?: string | null;
  documentExpiryDate?: string | null;
  email?: string | null;
  phoneMobile?: string | null;
  residenceFullAddress?: string | null;
  residenceLocality?: string | null;
  residenceCountry?: string | null;
  kinship?: string | null;
  guardianTitle?: string | null;
  providedByCheckInGuestId?: string | null;
};

export type SessionPatch = {
  eta?: string | null;
  preferences?: string[] | { codes?: string[]; freeText?: string };
  consent?: { gdpr?: boolean; aiDisclosure?: boolean; marketing?: boolean; whatsappOptIn?: boolean };
};

export type DocumentCaptureFields = {
  documentType?: string;
  mrzFormat?: string;
  issuingCountry?: string;
  nationality?: string;
  sex?: string;
  dateOfBirth?: string;
  documentExpiryDate?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  firstName?: string;
  surname1?: string;
  surname2?: string;
};

export type DocumentCapture = {
  captureId: string;
  fields: DocumentCaptureFields;
  confidence: Partial<Record<keyof DocumentCaptureFields, number>>;
  checks: { document: boolean | null; birth: boolean | null; expiry: boolean | null; composite: boolean | null };
  source: "mrz_reader" | "mrz_ai" | "ai_vision" | "manual";
  mrzFormat: string | null;
  needsReview: string[];
  warnings: string[];
  persisted: boolean;
};

export type DocumentCaptureResponse = { capture: DocumentCapture; guest: CheckInGuest | null; session: CheckInSession };

export type MrzApplyResponse = {
  guest: CheckInGuest;
  missing: string[];
  capture: { id: string; source: "mrz_reader"; format: string | null; checks: DocumentCapture["checks"]; needsReview: string[]; fields: DocumentCaptureFields };
  /** Avisos (corrector REV3-05): con `identity_mismatch` en needsReview los datos NO se aplican al viajero. */
  warnings?: string[];
};

export type GuestUpsertResponse = { guest: CheckInGuest; missing: string[]; session: CheckInSession };

export type SignaturePayload = {
  pngBase64: string;
  svg?: string;
  strokeMeta: { points: number; durationMs: number; bbox: { x: number; y: number; width: number; height: number } };
};

export type SignatureResponse = {
  signatureId: string;
  guestRegisterRecordId: string;
  checkInGuestId: string | null;
  sha256: string;
  pdfSha256: string;
  signedAt: string;
  retentionUntil: string;
  method: string;
  guestRegisterStatus: string;
  checkInGuestStatus: string | null;
};

export type PaymentLinkResponse =
  | { status: "settled" | "no_folio" | "no_charges"; paymentStatus: string }
  | { status: "at_reception"; paymentStatus: "at_reception"; reason: string; details?: unknown }
  | { status: "link_sent"; paymentStatus: "link_sent"; link: { redirect: { method: "GET"; url: string } | { method: "POST"; url: string; fields: Record<string, string> }; idempotent: boolean; intent?: unknown } };

export type OtpRequestResponse = { sessionId: string; channel: "email" | "phone"; method: string; recipient: string; expiresAt: string; dispatched: boolean; simulated: boolean; reason: string | null; debugCode?: string };
export type OtpVerifyResponse = { sessionId: string; checkInGuestId: string; method: string; verifiedAt: string; policyAllowed: boolean; guestStatus: string; guestRegisterRecordId: string | null };

export type ArrivalKey = {
  serialNumber: string;
  qr: string;
  validFrom: string;
  validUntil: string;
  wallet: { apple: { signedByApple: boolean; pass: unknown }; google: unknown };
} | null;

export type ArriveResponse = {
  reservationId: string;
  sessionId: string;
  actor: "guest" | "kiosk" | "user";
  room: { id: string; number: string; floor: string | null };
  reassigned: boolean;
  key: ArrivalKey;
  ses: { status: string; submissions: unknown[]; warnings: string[] };
  welcome: { status?: string; channel?: string | null } | null;
  checkedInAt: string;
  warnings: string[];
};

export type KioskClaimResponse = {
  deviceToken: string;
  device: { id: string; propertyId: string; name: string; status: string; paired: boolean; capabilities: { mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean } };
  capabilities: { mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean };
};

/**
 * Respuesta de POST /guest-portal/chat (GuestBotResult de guest-bot.service.ts, W4-D). Corrector REV3-10:
 * `action` handoff/identify/pending_confirmation/disabled y `disclosureShown` (aviso de IA) se muestran tal cual.
 */
export type ChatResponse = {
  conversationId: string | null;
  messageId: string | null;
  reply: string;
  intent: string;
  confidence: number;
  mode: "rules" | "llm";
  action: "answered" | "updated" | "pending_confirmation" | "handoff" | "identify" | "duplicate" | "disabled";
  toolCallId: string | null;
  disclosureShown: boolean;
  identified: boolean;
  language: "es" | "en";
  duplicate: boolean;
};

// ---- Stub state (offline demo) ------------------------------------------------

const CHECKIN_PATH = "/guest-portal/check-in";

function stubGuest(id: string, ordinal: number, isPrimary: boolean, name: { firstName: string | null; surname1: string | null }): CheckInGuest {
  const now = new Date().toISOString();
  return {
    id,
    sessionId: "cis_demo_001",
    guestId: null,
    guestRegisterRecordId: null,
    isPrimary,
    ordinal,
    status: "pending",
    ageAtArrival: isPrimary ? 41 : null,
    isMinor: false,
    providedByCheckInGuestId: null,
    kinship: null,
    guardianTitle: null,
    identityVerificationMethod: null,
    identityVerifiedAt: null,
    firstName: name.firstName,
    surname1: name.surname1,
    surname2: null,
    nationality: isPrimary ? "ESP" : null,
    documentType: null,
    documentNumberLast3: null,
    hasEmail: isPrimary,
    hasPhoneMobile: false,
    createdAt: now,
    updatedAt: now
  };
}

let stubSession: CheckInSession | null = null;

function ensureStubSession(): CheckInSession {
  if (stubSession) return stubSession;
  const now = new Date().toISOString();
  stubSession = {
    id: "cis_demo_001",
    propertyId: "prop_demo",
    reservationId: "res_demo_001",
    status: "in_progress",
    channel: "email",
    invitedAt: now,
    completedAt: null,
    arrivedAt: null,
    checkedInAt: null,
    etaDeclared: null,
    preferences: [],
    consent: { gdprAt: null, aiDisclosureAt: null, marketing: false, whatsappOptInAt: null },
    paymentStatus: "none",
    handoffKind: null,
    handoffReason: null,
    kioskDeviceId: null,
    guests: [stubGuest("cig_demo_1", 0, true, { firstName: "Maria", surname1: "Lopez" }), stubGuest("cig_demo_2", 1, false, { firstName: null, surname1: null })],
    policy: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"], requireVisualCheckAtKiosk: false, depositPolicy: "none" },
    steps: [],
    balanceDue: 0,
    guestCapacity: 2,
    createdAt: now,
    updatedAt: now
  };
  return stubSession;
}

function stubTouch(guest: CheckInGuest): void {
  const hasName = Boolean(guest.firstName && guest.surname1);
  const complete = hasName && Boolean(guest.nationality && guest.documentType && guest.documentNumberLast3 && guest.ageAtArrival !== null && (guest.hasEmail || guest.hasPhoneMobile));
  if (guest.status === "signed" || guest.status === "verified") return;
  guest.status = complete ? "data_complete" : guest.documentNumberLast3 ? "document_captured" : "pending";
  guest.updatedAt = new Date().toISOString();
}

function stubMissing(guest: CheckInGuest): string[] {
  const missing: string[] = [];
  if (!guest.firstName) missing.push("firstName");
  if (!guest.surname1) missing.push("surname1");
  if (!guest.nationality) missing.push("nationality");
  if (guest.ageAtArrival === null) missing.push("dateOfBirth");
  if (!guest.documentNumberLast3) missing.push("documentNumber");
  if (!guest.hasEmail && !guest.hasPhoneMobile) missing.push("contact");
  return missing;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Session -------------------------------------------------------------------

export async function getCheckIn(): Promise<CheckInSession> {
  if (!baseUrl) {
    await delay(200);
    return structuredClone(ensureStubSession());
  }
  return request<CheckInSession>(CHECKIN_PATH, { headers: guestHeaders() });
}

export async function patchCheckIn(patch: SessionPatch): Promise<CheckInSession> {
  if (!baseUrl) {
    await delay(200);
    const session = ensureStubSession();
    if (patch.eta !== undefined) session.etaDeclared = patch.eta;
    if (patch.preferences !== undefined) session.preferences = Array.isArray(patch.preferences) ? [...patch.preferences] : [...(patch.preferences.codes ?? [])];
    if (patch.consent) {
      const now = new Date().toISOString();
      if (patch.consent.gdpr !== undefined) session.consent.gdprAt = patch.consent.gdpr ? (session.consent.gdprAt ?? now) : null;
      if (patch.consent.aiDisclosure !== undefined) session.consent.aiDisclosureAt = patch.consent.aiDisclosure ? (session.consent.aiDisclosureAt ?? now) : null;
      if (patch.consent.marketing !== undefined) session.consent.marketing = patch.consent.marketing;
      if (patch.consent.whatsappOptIn !== undefined) session.consent.whatsappOptInAt = patch.consent.whatsappOptIn ? (session.consent.whatsappOptInAt ?? now) : null;
    }
    return structuredClone(session);
  }
  return request<CheckInSession>(CHECKIN_PATH, { method: "PATCH", headers: guestHeaders(), body: JSON.stringify(patch) });
}

// ---- Travellers ----------------------------------------------------------------

function applyStubInput(guest: CheckInGuest, input: GuestInput): void {
  if (input.firstName !== undefined) guest.firstName = input.firstName;
  if (input.surname1 !== undefined) guest.surname1 = input.surname1;
  if (input.surname2 !== undefined) guest.surname2 = input.surname2;
  if (input.nationality !== undefined) guest.nationality = input.nationality;
  if (input.documentType !== undefined) guest.documentType = input.documentType;
  if (input.documentNumber) guest.documentNumberLast3 = input.documentNumber.slice(-3);
  if (input.dateOfBirth) guest.ageAtArrival = Math.max(0, new Date().getUTCFullYear() - Number(input.dateOfBirth.slice(0, 4)));
  if (input.email !== undefined) guest.hasEmail = Boolean(input.email);
  if (input.phoneMobile !== undefined) guest.hasPhoneMobile = Boolean(input.phoneMobile);
  if (input.kinship !== undefined) guest.kinship = input.kinship;
  if (input.guardianTitle !== undefined) guest.guardianTitle = input.guardianTitle;
  if (input.providedByCheckInGuestId !== undefined) guest.providedByCheckInGuestId = input.providedByCheckInGuestId;
  stubTouch(guest);
}

export async function addGuest(input: GuestInput): Promise<GuestUpsertResponse> {
  if (!baseUrl) {
    await delay(200);
    const session = ensureStubSession();
    let guest = session.guests.find((row) => row.status === "pending" && !row.firstName && !row.documentNumberLast3) ?? null;
    if (!guest) {
      if (session.guests.length >= (session.guestCapacity ?? 2)) throw new ApiError("La reserva ya tiene todos los viajeros declarados.", 409, { code: "CHECKIN_GUEST_LIMIT" });
      guest = stubGuest(`cig_demo_${session.guests.length + 1}`, session.guests.length, false, { firstName: null, surname1: null });
      session.guests.push(guest);
    }
    applyStubInput(guest, input);
    return { guest: structuredClone(guest), missing: stubMissing(guest), session: structuredClone(session) };
  }
  return request<GuestUpsertResponse>(`${CHECKIN_PATH}/guests`, { method: "POST", headers: guestHeaders(), body: JSON.stringify(input) });
}

export async function patchGuest(checkInGuestId: string, input: GuestInput): Promise<GuestUpsertResponse> {
  if (!baseUrl) {
    await delay(200);
    const session = ensureStubSession();
    const guest = session.guests.find((row) => row.id === checkInGuestId);
    if (!guest) throw new ApiError("Viajero no encontrado.", 404, null);
    applyStubInput(guest, input);
    return { guest: structuredClone(guest), missing: stubMissing(guest), session: structuredClone(session) };
  }
  return request<GuestUpsertResponse>(`${CHECKIN_PATH}/guests/${encodeURIComponent(checkInGuestId)}`, { method: "PATCH", headers: guestHeaders(), body: JSON.stringify(input) });
}

export async function removeGuest(checkInGuestId: string): Promise<{ removed: true; session: CheckInSession }> {
  if (!baseUrl) {
    await delay(150);
    const session = ensureStubSession();
    session.guests = session.guests.filter((row) => row.id !== checkInGuestId || row.isPrimary);
    return { removed: true, session: structuredClone(session) };
  }
  return request<{ removed: true; session: CheckInSession }>(`${CHECKIN_PATH}/guests/${encodeURIComponent(checkInGuestId)}`, { method: "DELETE", headers: guestHeaders() });
}

// ---- Identity document ---------------------------------------------------------

/**
 * Captura del documento: la imagen (data: URL, ≤ 6 MB) y/o las líneas MRZ ya
 * transcritas. El servidor lee la MRZ (dígitos de control) y, con proveedor de
 * visión, el resto; la imagen se descarta al terminar la petición (§7.3). El
 * llamador debe soltar su copia en cuanto esta promesa resuelve.
 */
export async function uploadDocument(checkInGuestId: string, dataUrl: string | null, options: { mrzLines?: string[] | string; documentType?: string } = {}): Promise<DocumentCaptureResponse> {
  if (!baseUrl) {
    await delay(500);
    const session = ensureStubSession();
    const guest = session.guests.find((row) => row.id === checkInGuestId);
    if (!guest) throw new ApiError("Viajero no encontrado.", 404, null);
    const lines = options.mrzLines ? normalizeMrzText(Array.isArray(options.mrzLines) ? options.mrzLines.join("\n") : options.mrzLines) : [];
    if (lines.length < 2) {
      throw new ApiError("No se ha podido leer el documento (ni MRZ válida ni visión): repite la captura con mejor luz o introduce los datos a mano.", 400, { code: "DOCUMENT_UNREADABLE", captureId: "cap_demo", needsReview: [], warnings: ["demo: sin proveedor de visión"] });
    }
    const fields = stubFieldsFromMrz(lines);
    applyStubInput(guest, { firstName: fields.firstName ?? null, surname1: fields.surname1 ?? null, nationality: fields.nationality ?? null, documentType: fields.documentType ?? null, documentNumber: fields.documentNumber ?? null, dateOfBirth: fields.dateOfBirth ?? null });
    guest.identityVerificationMethod = "mrz_checksum";
    const capture: DocumentCapture = { captureId: `cap_demo_${Date.now().toString(36)}`, fields, confidence: Object.fromEntries(Object.keys(fields).map((key) => [key, 1])), checks: { document: true, birth: true, expiry: true, composite: true }, source: "mrz_reader", mrzFormat: lines.length === 3 ? "TD1" : "TD3", needsReview: [], warnings: [], persisted: true };
    return { capture, guest: structuredClone(guest), session: structuredClone(session) };
  }
  void dataUrl;
  return request<DocumentCaptureResponse>(`${CHECKIN_PATH}/guests/${encodeURIComponent(checkInGuestId)}/document`, {
    method: "POST",
    headers: guestHeaders(),
    body: JSON.stringify({
      ...(dataUrl ? { imageDataUrl: dataUrl } : {}),
      ...(options.mrzLines ? { mrzLines: options.mrzLines } : {}),
      ...(options.documentType ? { documentType: options.documentType } : {})
    })
  });
}

/** Líneas MRZ de un lector hardware o tecleadas: parser determinista del servidor (400 MRZ_CHECKSUM_FAILED si no cuadra). */
export async function submitMrz(checkInGuestId: string, lines: string[] | string): Promise<MrzApplyResponse> {
  if (!baseUrl) {
    const result = await uploadDocument(checkInGuestId, null, { mrzLines: lines });
    return { guest: result.guest!, missing: stubMissing(result.guest!), capture: { id: result.capture.captureId, source: "mrz_reader", format: result.capture.mrzFormat, checks: result.capture.checks, needsReview: [], fields: { documentType: result.capture.fields.documentType, nationality: result.capture.fields.nationality, sex: result.capture.fields.sex, dateOfBirth: result.capture.fields.dateOfBirth } } };
  }
  return request<MrzApplyResponse>(`${CHECKIN_PATH}/guests/${encodeURIComponent(checkInGuestId)}/mrz`, { method: "POST", headers: guestHeaders(), body: JSON.stringify({ lines }) });
}

/** Lectura mínima de una MRZ TD3/TD1 para el stub (nombres y número; sin dígitos de control). */
function stubFieldsFromMrz(lines: string[]): DocumentCaptureFields {
  const names = (segment: string) => {
    const [surnames = "", given = ""] = segment.split("<<");
    return { surname1: surnames.replace(/</g, " ").trim() || undefined, firstName: given.replace(/</g, " ").trim() || undefined };
  };
  if (lines.length === 2 && lines[0]!.length === 44) {
    const second = lines[1]!;
    return { documentType: "PASSPORT", mrzFormat: "TD3", issuingCountry: lines[0]!.slice(2, 5), ...names(lines[0]!.slice(5)), documentNumber: second.slice(0, 9).replace(/</g, ""), nationality: second.slice(10, 13), dateOfBirth: `20${second.slice(13, 15)}-${second.slice(15, 17)}-${second.slice(17, 19)}`.replace(/^20(?=[5-9]\d)/, "19"), sex: second.slice(20, 21) === "F" ? "M" : "H", documentExpiryDate: `20${second.slice(21, 23)}-${second.slice(23, 25)}-${second.slice(25, 27)}` };
  }
  if (lines.length === 3 && lines[0]!.length === 30) {
    const second = lines[1]!;
    return { documentType: "DNI", mrzFormat: "TD1", issuingCountry: lines[0]!.slice(2, 5), documentNumber: lines[0]!.slice(5, 14).replace(/</g, ""), nationality: second.slice(15, 18), dateOfBirth: `19${second.slice(0, 2)}-${second.slice(2, 4)}-${second.slice(4, 6)}`, sex: second.slice(7, 8) === "F" ? "M" : "H", ...names(lines[2]!) };
  }
  return {};
}

// ---- Close pre-arrival and sign --------------------------------------------------

/** Cierra el pre-check-in (crea/actualiza los partes de viajeros; 409 CHECKIN_INCOMPLETE { missing } si falta algo). */
export async function completeCheckIn(): Promise<CheckInSession> {
  if (!baseUrl) {
    await delay(300);
    const session = ensureStubSession();
    const missing = session.guests.filter((guest) => stubMissing(guest).length > 0).map((guest) => ({ checkInGuestId: guest.id, ordinal: guest.ordinal, isPrimary: guest.isPrimary, fields: stubMissing(guest) }));
    if (missing.length > 0) throw new ApiError("Faltan datos de viajeros para cerrar el pre-check-in.", 409, { code: "CHECKIN_INCOMPLETE", missing });
    for (const guest of session.guests) guest.guestRegisterRecordId = guest.guestRegisterRecordId ?? `grr_demo_${guest.ordinal}`;
    session.status = "ready_for_arrival";
    session.completedAt = session.completedAt ?? new Date().toISOString();
    return structuredClone(session);
  }
  return request<CheckInSession>(`${CHECKIN_PATH}/complete`, { method: "POST", headers: guestHeaders(), body: "{}" });
}

export async function signGuest(checkInGuestId: string, payload: SignaturePayload): Promise<SignatureResponse> {
  if (!baseUrl) {
    await delay(300);
    const session = ensureStubSession();
    const guest = session.guests.find((row) => row.id === checkInGuestId);
    if (!guest) throw new ApiError("Viajero no encontrado.", 404, null);
    if (!guest.guestRegisterRecordId) throw new ApiError("El viajero no tiene parte de viajeros: complete los datos antes de firmar.", 409, { code: "GUEST_REGISTER_INCOMPLETE", missing: ["guestRegisterRecord"] });
    if (guest.isMinor) throw new ApiError("Los menores de 14 años no firman el parte.", 409, { code: "SIGNATURE_NOT_REQUIRED" });
    guest.status = "signed";
    const now = new Date().toISOString();
    return { signatureId: `sgn_demo_${guest.ordinal}`, guestRegisterRecordId: guest.guestRegisterRecordId, checkInGuestId: guest.id, sha256: "0".repeat(64), pdfSha256: "1".repeat(64), signedAt: now, retentionUntil: now, method: kioskToken ? "touch_kiosk" : "touch_portal", guestRegisterStatus: "signed", checkInGuestStatus: "signed" };
  }
  return request<SignatureResponse>(`${CHECKIN_PATH}/guests/${encodeURIComponent(checkInGuestId)}/signature`, { method: "POST", headers: guestHeaders(), body: JSON.stringify(payload) });
}

// ---- Payment ---------------------------------------------------------------------

export async function requestPaymentLink(input: { returnUrl?: string; clientRequestId?: string } = {}): Promise<PaymentLinkResponse> {
  if (!baseUrl) {
    await delay(300);
    const session = ensureStubSession();
    if ((session.balanceDue ?? 0) <= 0) return { status: "no_folio", paymentStatus: session.paymentStatus };
    session.paymentStatus = "at_reception";
    return { status: "at_reception", paymentStatus: "at_reception", reason: "PSP_NOT_CONFIGURED" };
  }
  return request<PaymentLinkResponse>(`${CHECKIN_PATH}/payment-link`, { method: "POST", headers: guestHeaders(), body: JSON.stringify(input) });
}

// ---- OTP ---------------------------------------------------------------------------

export async function requestOtp(channel: "email" | "phone"): Promise<OtpRequestResponse> {
  if (!baseUrl) {
    await delay(300);
    return { sessionId: "cis_demo_001", channel, method: channel === "email" ? "otp_email" : "otp_phone", recipient: channel === "email" ? "m***@example.com" : "+34 *** *** 042", expiresAt: new Date(Date.now() + 600_000).toISOString(), dispatched: false, simulated: true, reason: "demo", debugCode: "123456" };
  }
  return request<OtpRequestResponse>(`${CHECKIN_PATH}/otp/request`, { method: "POST", headers: guestHeaders(), body: JSON.stringify({ channel }) });
}

export async function verifyOtp(code: string): Promise<OtpVerifyResponse> {
  if (!baseUrl) {
    await delay(300);
    const session = ensureStubSession();
    if (code.replace(/\D/g, "") !== "123456") throw new ApiError("Código incorrecto.", 409, { code: "OTP_INVALID", attemptsLeft: 4 });
    const primary = session.guests.find((row) => row.isPrimary)!;
    primary.identityVerificationMethod = "otp_email";
    primary.identityVerifiedAt = new Date().toISOString();
    if (primary.status === "signed") primary.status = "verified";
    return { sessionId: session.id, checkInGuestId: primary.id, method: "otp_email", verifiedAt: primary.identityVerifiedAt, policyAllowed: true, guestStatus: primary.status, guestRegisterRecordId: primary.guestRegisterRecordId };
  }
  return request<OtpVerifyResponse>(`${CHECKIN_PATH}/otp/verify`, { method: "POST", headers: guestHeaders(), body: JSON.stringify({ code }) });
}

// ---- Arrival -----------------------------------------------------------------------

export async function arrive(method?: string | null): Promise<ArriveResponse> {
  if (!baseUrl) {
    await delay(600);
    const session = ensureStubSession();
    if (session.status === "checked_in") throw new ApiError("La reserva ya está alojada.", 409, { code: "CHECKIN_ALREADY_DONE" });
    if (session.status !== "ready_for_arrival") throw new ApiError("El pre-check-in no está cerrado.", 409, { code: "CHECKIN_INCOMPLETE" });
    session.status = "checked_in";
    session.checkedInAt = new Date().toISOString();
    session.arrivedAt = session.checkedInAt;
    return { reservationId: session.reservationId, sessionId: session.id, actor: kioskToken ? "kiosk" : "guest", room: { id: "room_demo_432", number: "432", floor: "4" }, reassigned: false, key: { serialNumber: "demo000000000000000000ff", qr: "hotelos://unlock?serial=demo", validFrom: session.checkedInAt, validUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(), wallet: { apple: { signedByApple: false, pass: null }, google: null } }, ses: { status: "queued", submissions: [], warnings: [] }, welcome: { status: "simulated", channel: "email" }, checkedInAt: session.checkedInAt, warnings: [] };
  }
  return request<ArriveResponse>(`${CHECKIN_PATH}/arrive`, { method: "POST", headers: guestHeaders(), body: JSON.stringify(method ? { verification: { method } } : {}) });
}

/** 200 de POST /guest-portal/check-in/handoff (corrector L7-REV-05): la sesión queda `handed_off` en el SERVIDOR y este es el ticket que lee recepción. */
export type HandoffResponse = { sessionId: string; reservationId: string; status: "handed_off"; handoffKind: string; ticket: string; kioskDeviceId: string | null; idempotent: boolean };

/**
 * «Firmar en recepción» (kiosco o móvil): deriva la sesión al mostrador en el
 * servidor. Sin API: derivación de demostración con un ticket fijo.
 */
export async function handoffCheckIn(kind: "signature" = "signature"): Promise<HandoffResponse> {
  if (!baseUrl) {
    await delay(300);
    const session = ensureStubSession();
    session.status = "handed_off";
    return { sessionId: session.id, reservationId: session.reservationId, status: "handed_off", handoffKind: "signature_pending", ticket: "K-0001", kioskDeviceId: kioskToken ? "kiosk_demo" : null, idempotent: false };
  }
  return request<HandoffResponse>(`${CHECKIN_PATH}/handoff`, { method: "POST", headers: guestHeaders(), body: JSON.stringify({ kind }) });
}

// ---- Kiosk -------------------------------------------------------------------------

/** La tablet reclama el código de 8 dígitos y recibe su deviceToken (una sola vez; 409 KIOSK_PAIRING_INVALID). */
export async function claimKiosk(code: string): Promise<KioskClaimResponse> {
  const digits = code.replace(/\D/g, "");
  if (!baseUrl) {
    await delay(300);
    if (digits.length !== 8) throw new ApiError("Código de emparejamiento no válido o caducado.", 409, { code: "KIOSK_PAIRING_INVALID" });
    const capabilities = { mrzReader: true, cardEncoder: false, paymentTerminal: false, printer: false };
    return { deviceToken: `demo-kiosk-${digits}`, device: { id: "kd_demo_1", propertyId: "prop_demo", name: "Tablet demo", status: "online", paired: true, capabilities }, capabilities };
  }
  return request<KioskClaimResponse>(`${CHECKIN_PATH}/kiosk/claim`, { method: "POST", body: JSON.stringify({ code: digits }) });
}

// ---- Chat (W4-D) -------------------------------------------------------------------

/**
 * Bot del huésped (POST /guest-portal/chat, misma pila que WhatsApp). El cuerpo es
 * `{ text, conversationId?, language? }` (GuestChatSchema estricto, checkin.routes.ts;
 * corrector REV3-10: antes se enviaba `message` y la ruta respondía 400). Sin API: respuesta fija.
 */
export async function chat(text: string, options: { conversationId?: string | null; language?: "es" | "en" } = {}): Promise<ChatResponse> {
  if (!baseUrl) {
    await delay(400);
    return {
      conversationId: options.conversationId ?? "conv_demo",
      messageId: "msg_demo",
      reply: options.language === "en" ? "Thanks for your message. A colleague at the front desk will answer shortly. (demo)" : "Gracias por tu mensaje. Un compañero de recepción te responderá en breve. (demo)",
      intent: "unknown",
      confidence: 0,
      mode: "rules",
      action: "handoff",
      toolCallId: null,
      disclosureShown: true,
      identified: true,
      language: options.language ?? "es",
      duplicate: false
    };
  }
  return request<ChatResponse>("/guest-portal/chat", {
    method: "POST",
    headers: guestHeaders(),
    body: JSON.stringify({ text, ...(options.conversationId ? { conversationId: options.conversationId } : {}), ...(options.language ? { language: options.language } : {}) })
  });
}
