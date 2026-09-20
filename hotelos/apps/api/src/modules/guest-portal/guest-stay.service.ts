// Portal del huésped · estancia y salida (Tanda L7 · lote L7-02, 2026-09-20).
//
// Servicio de la vista de la estancia (`GET /guest-portal/stay`, recon §19.2),
// del PDF de factura por token (§19.3), de las peticiones de salida
// (§19.4) y del enlace de pago honesto (§19.5). Rutas en guest-portal.routes.ts.
//
// Principios:
//   · El token opaco de GuestPortalSession ES la autenticación: cada función
//     recibe la sesión ya verificada (VerifiedGuestSession) y nunca un
//     reservationId del cliente.
//   · Sin PII de acompañantes: la reserva viaja con la proyección de
//     getGuestReservationView (titular = nombre + inicial); las peticiones,
//     facturas y el folio no llevan nombres.
//   · Honestidad: el saldo es el REAL del folio principal (findReservationFolio);
//     sin PSP configurado el enlace de pago responde `at_reception` y nunca marca
//     nada como pagado; un folio sin líneas es `no_charges`, nunca `paid`; los datos del hotel salen de
//     PropertyAiSetting.configurationJson.faq (las mismas claves que el bot) y
//     lo que no está configurado es null.
//   · Dependencias inyectables (GuestStayDeps) para los tests unitarios sin
//     base de datos (__tests__/guest-stay.test.mts); las reales viven en
//     defaultGuestStayDeps.

import { prisma } from "@hotelos/database";
import { GUEST_STAY_REQUEST_KINDS_BY_STAGE } from "@hotelos/shared";
import type {
  GuestStayCheckInDto,
  GuestStayFolioDto,
  GuestStayInfoDto,
  GuestStayInvoiceDto,
  GuestStayPaymentLinkResponse,
  GuestStayRequestDto,
  GuestStayRequestInput,
  GuestStayRequestKind,
  GuestStayRequestResult,
  GuestStayStage,
  GuestStaySurveyDto,
  GuestStayView
} from "@hotelos/shared";
import { createId } from "../../lib/ids.js";
import { ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { getPropertyAiSettings } from "../ai-operations/property-ai.service.js";
import { recordDomainEvent } from "../audit/audit.service.js";
import { paymentLinkServiceContext } from "../checkin/service-context.js";
import { findReservationFolio, type ReservationFolioBalance } from "../folio/folio.service.js";
import { renderInvoicePdf } from "../invoicing/invoice-pdf.service.js";
import { extractWelcomeFaqDetails } from "../messaging/messaging.service.js";
import { createPaymentLink } from "../payments/payments.service.js";
import type { VerifiedGuestSession } from "./guest-portal-auth.service.js";
import { getGuestReservationView, type GuestReservationView } from "./guest-portal.service.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** GuestPortalAction.actionType de la llave móvil (wallet-pass.service.ts). */
export const MOBILE_KEY_ACTION_TYPE = "mobile_key";
/** Prefijo del notificationId de la invitación a la encuesta post-estancia (recon §19.7). */
export const POST_STAY_SURVEY_NOTIFICATION_PREFIX = "post_stay_survey:";
/** Departamento que recibe las peticiones de salida del portal. */
export const STAY_REQUEST_DEPARTMENT = "front_office";
/** Evento de dominio de una petición de salida (mismo patrón que GuestServiceRequested). */
export const STAY_REQUEST_EVENT = "GuestCheckoutRequested";
/** Estados de la reserva que cierran la estancia: no admiten peticiones (409 STAY_CLOSED). */
export const STAY_CLOSED_STATUSES: readonly string[] = Object.freeze(["cancelled", "no_show"]);
const CENT_TOLERANCE = 0.005;

/**
 * Peticiones admitidas por etapa (corrector L7-REV-02 / REV-L7-04): las MISMAS
 * listas que ofrece el portal (stay.ts checkOutOptions). Tras la salida
 * (`checked_out` → post_stay) solo la factura por correo: una salida exprés o
 * tardía de quien ya se fue entraba abierta en la cola de recepción.
 */
export function allowedStayRequestKinds(stage: GuestStayStage): readonly GuestStayRequestKind[] {
  return GUEST_STAY_REQUEST_KINDS_BY_STAGE[stage] ?? [];
}

// ---------------------------------------------------------------------------
// Funciones puras (etapa, folio, info del hotel)
// ---------------------------------------------------------------------------

/** Fecha local YYYY-MM-DD de `now` en la zona de la propiedad; UTC si la zona no es válida. */
export function localDateIn(now: Date, timeZone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Etapa de la estancia a partir del estado de la reserva y de la fecha local
 * (comparación lexicográfica de YYYY-MM-DD). Ver GUEST_STAY_STAGES.
 */
export function stageOf(reservation: { status: string; arrivalDate: string; departureDate: string }, today: string): GuestStayStage {
  const arrival = reservation.arrivalDate.slice(0, 10);
  const departure = reservation.departureDate.slice(0, 10);
  if (STAY_CLOSED_STATUSES.includes(reservation.status)) return "cancelled";
  if (reservation.status === "checked_out") return "post_stay";
  if (reservation.status === "checked_in") return today < departure ? "in_house" : "departure_day";
  if (today < arrival) return "pre_arrival";
  if (today < departure) return "arrival_day";
  return "post_stay";
}

/** Folio del huésped: saldo real del folio principal; sin folio → no_folio con listas vacías. */
export function folioDtoFrom(folio: ReservationFolioBalance | null): GuestStayFolioDto {
  if (!folio) return { status: "no_folio", balanceDue: 0, currency: null, charges: [], payments: [] };
  return {
    status: folio.balanceDue > CENT_TOLERANCE ? "balance_due" : "settled",
    balanceDue: folio.balanceDue,
    currency: folio.folio.currency,
    charges: folio.lines.map((line) => ({ description: line.description, quantity: line.quantity, total: line.total, postedAt: line.postedAt })),
    payments: folio.payments.map((payment) => ({ amount: payment.amount, method: payment.methodCode ?? payment.method, status: payment.status, createdAt: payment.createdAt }))
  };
}

function faqString(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * Primera clave con valor de texto en `faq` (objeto plano o anidado un nivel:
 * hours / schedule / time / info / text / answer / phone / number). Misma
 * lectura que `faqLookup` del bot del huésped (guest-bot.service.ts, no
 * exportada; L7 no toca ese fichero).
 */
export function faqLookup(faq: unknown, keys: readonly string[]): string {
  if (!faq || typeof faq !== "object" || Array.isArray(faq)) return "";
  const record = faq as Record<string, unknown>;
  for (const key of keys) {
    const direct = faqString(record[key]);
    if (direct) return direct;
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>;
      const found =
        faqString(inner.hours) || faqString(inner.schedule) || faqString(inner.time) || faqString(inner.info) || faqString(inner.text) || faqString(inner.answer) || faqString(inner.phone) || faqString(inner.number);
      if (found) return found;
    }
  }
  return "";
}

/** Claves de la FAQ que lee el bot para la hora de salida (guest-bot.service.ts FAQ_TOPICS). */
export const FAQ_CHECKOUT_KEYS = ["checkOutTime", "checkout_time", "checkOutHours", "checkout", "checkOut"] as const;
/** Claves de la FAQ para el teléfono de recepción (no existe columna en Property). */
export const FAQ_RECEPTION_PHONE_KEYS = ["receptionPhone", "reception_phone", "phone", "phoneNumber", "phone_number", "telefono", "teléfono", "reception"] as const;

function orNull(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

/** Datos prácticos del hotel: wifi y desayuno (extractWelcomeFaqDetails), hora de salida y teléfono (faqLookup), dirección postal. */
export function stayInfoFrom(faq: unknown, address: string | null): GuestStayInfoDto {
  const welcome = extractWelcomeFaqDetails(faq);
  return {
    wifiName: orNull(welcome.wifiName),
    wifiPassword: orNull(welcome.wifiPassword),
    breakfastHours: orNull(welcome.breakfastHours),
    checkOutTime: orNull(faqLookup(faq, FAQ_CHECKOUT_KEYS)),
    receptionPhone: orNull(faqLookup(faq, FAQ_RECEPTION_PHONE_KEYS)),
    address
  };
}

/** «Calle Real 1, 15001 A Coruña, A Coruña»; null si la propiedad no tiene dirección. */
export function formatPropertyAddress(property: { address: string | null; postalCode: string | null; municipality: string | null; province: string | null } | null): string | null {
  if (!property) return null;
  const locality = [property.postalCode, property.municipality].map((part) => part?.trim() ?? "").filter(Boolean).join(" ");
  const parts = [property.address?.trim() ?? "", locality, property.province?.trim() ?? ""].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** «SRQ-<8>»: mismo formato que submitServiceRequest (guest-portal.service.ts). */
export function ticketNumberFor(serviceRequestId: string): string {
  return `SRQ-${serviceRequestId.slice(-8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

export type GuestStayReservationHeader = {
  id: string;
  code: string;
  propertyId: string;
  status: string;
  /** YYYY-MM-DD (fechas civiles de la reserva) para calcular la etapa de la petición. */
  arrivalDate: string;
  departureDate: string;
  /** Property.timezone (null → UTC). */
  timezone: string | null;
};

export type GuestStayDeps = {
  now: () => Date;
  /** Proyección de la reserva del token (getGuestReservationView: verifica el token y nunca expone acompañantes). */
  loadReservation: (token: string) => Promise<GuestReservationView>;
  loadCheckIn: (reservationId: string) => Promise<{ status: string } | null>;
  loadKeyIssued: (reservationId: string) => Promise<boolean>;
  loadFolio: (reservationId: string) => Promise<ReservationFolioBalance | null>;
  loadInvoices: (reservationId: string, propertyId: string) => Promise<GuestStayInvoiceDto[]>;
  loadFaq: (propertyId: string) => Promise<unknown>;
  loadAddress: (propertyId: string) => Promise<string | null>;
  loadRequests: (reservationId: string) => Promise<GuestStayRequestDto[]>;
  loadSurvey: (reservationId: string) => Promise<GuestStaySurveyDto>;
  /** Cabecera de la reserva para las escrituras (peticiones): null si ya no existe. */
  loadReservationHeader: (reservationId: string) => Promise<GuestStayReservationHeader | null>;
  organizationIdForProperty: (propertyId: string) => Promise<string>;
  createServiceRequest: (data: { propertyId: string; reservationId: string; guestId: string | null; requestType: string }) => Promise<{ id: string; createdAt: Date }>;
  recordEvent: (input: Parameters<typeof recordDomainEvent>[0]) => void;
};

export const defaultGuestStayDeps: GuestStayDeps = {
  now: () => new Date(),
  loadReservation: (token) => getGuestReservationView(token),
  loadCheckIn: async (reservationId) => prisma.checkInSession.findUnique({ where: { reservationId }, select: { status: true } }),
  loadKeyIssued: async (reservationId) => (await prisma.guestPortalAction.count({ where: { reservationId, actionType: MOBILE_KEY_ACTION_TYPE, status: "active" } })) > 0,
  loadFolio: (reservationId) => findReservationFolio(reservationId),
  loadInvoices: async (reservationId, propertyId) => {
    const rows = await prisma.invoice.findMany({
      where: { reservationId, propertyId, status: "issued", deletedAt: null },
      orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, invoiceNumber: true, issuedAt: true, total: true, currencyCode: true }
    });
    return rows.map((row) => ({ id: row.id, number: row.invoiceNumber ?? null, issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null, total: Number(row.total), currency: row.currencyCode }));
  },
  loadFaq: async (propertyId) => (await getPropertyAiSettings(propertyId)).configurationJson.faq,
  loadAddress: async (propertyId) =>
    formatPropertyAddress(await prisma.property.findUnique({ where: { id: propertyId }, select: { address: true, postalCode: true, municipality: true, province: true } })),
  loadRequests: async (reservationId) => {
    const rows = await prisma.serviceRequest.findMany({ where: { reservationId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, requestType: true, status: true, createdAt: true } });
    return rows.map((row) => ({ id: row.id, kind: row.requestType, status: row.status, createdAt: row.createdAt.toISOString() }));
  },
  loadSurvey: async (reservationId) => {
    const [invited, answered] = await Promise.all([
      prisma.notificationDelivery.count({ where: { notificationId: `${POST_STAY_SURVEY_NOTIFICATION_PREFIX}${reservationId}` } }),
      prisma.surveyResponse.count({ where: { reservationId } })
    ]);
    return { invited: invited > 0, answered: answered > 0 };
  },
  loadReservationHeader: async (reservationId) => {
    const row = await prisma.reservation.findFirst({
      where: { id: reservationId, deletedAt: null },
      select: { id: true, code: true, propertyId: true, status: true, arrivalDate: true, departureDate: true }
    });
    if (!row) return null;
    // Reservation no tiene relación Prisma con Property: la zona se lee aparte (misma lectura que getGuestReservationView).
    const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { timezone: true } });
    return { id: row.id, code: row.code, propertyId: row.propertyId, status: row.status, arrivalDate: row.arrivalDate.toISOString().slice(0, 10), departureDate: row.departureDate.toISOString().slice(0, 10), timezone: property?.timezone ?? null };
  },
  organizationIdForProperty: async (propertyId) => (await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } }))?.organizationId ?? propertyId,
  createServiceRequest: (data) =>
    prisma.serviceRequest.create({ data: { ...data, status: "open", assignedDepartment: STAY_REQUEST_DEPARTMENT }, select: { id: true, createdAt: true } }),
  recordEvent: (input) => {
    recordDomainEvent(input);
  }
};

export function withGuestStayDeps(overrides?: Partial<GuestStayDeps>): GuestStayDeps {
  return overrides ? { ...defaultGuestStayDeps, ...overrides } : defaultGuestStayDeps;
}

// ---------------------------------------------------------------------------
// 19.2 · Vista de la estancia
// ---------------------------------------------------------------------------

/**
 * Vista completa de la estancia del token. `session` es la sesión ya verificada
 * por la ruta; `token` vuelve a pasar por getGuestReservationView (que verifica
 * de nuevo: una lectura más, cero duplicación de la proyección sin PII).
 */
export async function getGuestStayView(input: { token: string; session: VerifiedGuestSession }, overrides?: Partial<GuestStayDeps>): Promise<GuestStayView> {
  const deps = withGuestStayDeps(overrides);
  const reservation = await deps.loadReservation(input.token);
  const reservationId = reservation.reservationId;
  const [checkIn, keyIssued, folio, invoices, faq, address, requests, survey] = await Promise.all([
    deps.loadCheckIn(reservationId),
    deps.loadKeyIssued(reservationId),
    deps.loadFolio(reservationId),
    deps.loadInvoices(reservationId, reservation.propertyId),
    deps.loadFaq(reservation.propertyId),
    deps.loadAddress(reservation.propertyId),
    deps.loadRequests(reservationId),
    deps.loadSurvey(reservationId)
  ]);
  const today = localDateIn(deps.now(), reservation.propertyTimezone);
  const checkInDto: GuestStayCheckInDto | null = checkIn ? { status: checkIn.status, keyIssued } : null;
  return {
    stage: stageOf(reservation, today),
    today,
    reservation,
    checkIn: checkInDto,
    folio: folioDtoFrom(folio),
    invoices,
    info: stayInfoFrom(faq, address),
    requests,
    survey
  };
}

// ---------------------------------------------------------------------------
// 19.3 · PDF de factura por token
// ---------------------------------------------------------------------------

/**
 * PDF de una factura de la reserva de la sesión. 404 «Factura no encontrada.»
 * si el id no existe, es de otra reserva/propiedad o todavía es un borrador
 * (un borrador no es un documento fiscal: el huésped no lo ve en la lista).
 */
export async function renderGuestInvoicePdf(input: { session: VerifiedGuestSession; invoiceId: string }): Promise<{ buffer: Buffer; filename: string }> {
  const row = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, reservationId: input.session.reservationId, propertyId: input.session.propertyId, deletedAt: null, status: { not: "draft" } },
    select: { id: true }
  });
  if (!row) throw new NotFoundError("Factura no encontrada.");
  const { buffer, filename } = await renderInvoicePdf(row.id);
  return { buffer, filename };
}

// ---------------------------------------------------------------------------
// 19.4 · Peticiones de salida
// ---------------------------------------------------------------------------

/**
 * Crea una ServiceRequest (requestType = kind, front_office, open) para la
 * reserva de la sesión y emite `GuestCheckoutRequested` con la nota y la hora
 * preferida (ServiceRequest no tiene columna de descripción: la nota solo va al
 * evento, como GuestServiceRequested). 409 STAY_CLOSED si la reserva está
 * cancelada o no_show, y también si ya salió (`checked_out`) y la petición no
 * es la factura por correo; 409 STAY_REQUEST_NOT_ALLOWED { stage, kind } cuando
 * la clase no corresponde a la etapa (corrector L7-REV-02 / REV-L7-04).
 */
export async function createGuestStayRequest(
  input: { session: VerifiedGuestSession; body: GuestStayRequestInput; correlationId: string },
  overrides?: Partial<GuestStayDeps>
): Promise<GuestStayRequestResult> {
  const deps = withGuestStayDeps(overrides);
  const reservation = await deps.loadReservationHeader(input.session.reservationId);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  if (STAY_CLOSED_STATUSES.includes(reservation.status)) {
    throw new ConflictError("La reserva está cerrada: no admite peticiones desde el portal.", { code: "STAY_CLOSED", status: reservation.status });
  }
  const kind: GuestStayRequestKind = input.body.kind;
  const stage = stageOf(reservation, localDateIn(deps.now(), reservation.timezone));
  if (!allowedStayRequestKinds(stage).includes(kind)) {
    if (reservation.status === "checked_out") {
      throw new ConflictError("La estancia ya terminó: tras la salida solo se admite la factura por correo.", { code: "STAY_CLOSED", status: reservation.status, stage, kind });
    }
    throw new ConflictError("Esta petición no está disponible en esta etapa de la estancia.", { code: "STAY_REQUEST_NOT_ALLOWED", stage, kind, allowed: [...allowedStayRequestKinds(stage)] });
  }
  const created = await deps.createServiceRequest({ propertyId: reservation.propertyId, reservationId: reservation.id, guestId: input.session.guestId ?? null, requestType: kind });
  const ticketNumber = ticketNumberFor(created.id);
  const organizationId = await deps.organizationIdForProperty(reservation.propertyId);
  deps.recordEvent({
    organizationId,
    propertyId: reservation.propertyId,
    entityType: "service_request",
    entityId: created.id,
    eventType: STAY_REQUEST_EVENT,
    payload: {
      reservationId: reservation.id,
      reservationCode: reservation.code,
      ticketNumber,
      kind,
      note: input.body.note ?? null,
      preferredTime: input.body.preferredTime ?? null
    },
    actorType: "system",
    correlationId: input.correlationId
  });
  return { id: created.id, ticketNumber, kind, status: "open" };
}

// ---------------------------------------------------------------------------
// 19.5 · Enlace de pago honesto
// ---------------------------------------------------------------------------

/**
 * Enlace de pago del saldo del folio principal con el contexto de servicio de
 * SOLO payment.capture (paymentLinkServiceContext; el id del actor es la
 * reserva, nunca el token). Sin folio → no_folio; folio SIN líneas → no_charges
 * (corrector L7-REV-03: una cuenta vacía no está «pagada»); con cargos y saldo 0
 * → settled/paid; PSP no configurado → at_reception (se cobra en recepción).
 * Nunca registra un pago.
 */
export async function createGuestStayPaymentLink(
  input: { session: VerifiedGuestSession; body: { returnUrl?: string; clientRequestId?: string }; correlationId: string },
  overrides?: Partial<Pick<GuestStayDeps, "loadFolio">>
): Promise<{ statusCode: number; body: GuestStayPaymentLinkResponse }> {
  const loadFolio = overrides?.loadFolio ?? defaultGuestStayDeps.loadFolio;
  const folio = await loadFolio(input.session.reservationId);
  if (!folio) return { statusCode: 200, body: { status: "no_folio", paymentStatus: "none" } };
  if (folio.lines.length === 0 && folio.balanceDue <= CENT_TOLERANCE) return { statusCode: 200, body: { status: "no_charges", paymentStatus: "none" } };
  if (folio.balanceDue <= CENT_TOLERANCE) return { statusCode: 200, body: { status: "settled", paymentStatus: "paid" } };
  try {
    const link = await createPaymentLink({
      context: await paymentLinkServiceContext(input.session.propertyId, input.session.reservationId),
      folioId: folio.folio.id,
      amount: folio.balanceDue,
      methodCode: "payment_link",
      clientRequestId: input.body.clientRequestId ?? `guest-portal:${input.session.reservationId}:${folio.balanceDue.toFixed(2)}`,
      returnUrl: input.body.returnUrl ?? null,
      correlationId: input.correlationId
    });
    return { statusCode: link.idempotent ? 200 : 202, body: { status: "link_sent", paymentStatus: "link_sent", link } };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409 && (error.details as { code?: unknown } | undefined)?.code === "PSP_NOT_CONFIGURED") {
      return { statusCode: 200, body: { status: "at_reception", paymentStatus: "at_reception", reason: "PSP_NOT_CONFIGURED", details: error.details } };
    }
    throw error;
  }
}
