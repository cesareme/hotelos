// ReservationQuickCreate — modo rápido de Nueva reserva (Tanda UX-1 · lote U9a ·
// docs/design/UX-RECEPCION-FEEL.md §5.10, F12, F33, §7.1 3.3.7, §2.1 filas 2 y 9).
//
// Una sola pantalla con lo mínimo del API (`arrivalDate`, `departureDate`,
// `roomTypeId`; reservations.schemas.ts) más nombre y apellido del huésped:
//   · estancia con «+1 noche / −1 noche» y aritmética del campo de fecha (U7),
//     adultos y tipo con precio en vivo («89,00 €/noche · 4 libres»: POST
//     /properties/:id/availability/quote con 300 ms de espera, sin botón);
//   · huésped (nombre y apellido; teléfono y correo opcionales) con sugerencia
//     de ficha existente (GET /guests?search) y prefijado por `?guestId=` (lo
//     enlazan la lista y la ficha de huéspedes, U8) → `primaryGuestId` en el
//     cuerpo: nunca se vuelve a teclear lo que ya está (3.3.7);
//   · origen, tarifa y total (manual o el de la cotización);
//   · empresa (razón social + NIF) para la factura a la empresa (T5): la
//     instrucción de cobro pasa a «Factura a empresa» y el NIF lo recuerda la
//     pantalla al crear para el diálogo de factura de la ficha (rememberTaxId, U7);
//   · CTA «Crear reserva» (Intro: el cuerpo es un <form>), «Crear y cobrar
//     depósito» (PaymentDialog con el folio recién abierto) y «Crear y hacer
//     check-in» (runner de U6 con la primera habitación limpia y libre del tipo).
//
// El formulario (`ReservationFormValues`, `defaultReservationForm`) y el cuerpo
// de POST /properties/:id/reservations (`buildCreateReservationPayload`) viven
// aquí y los comparten los dos modos de ReservationCreateScreen: el modo completo
// conserva sus seis pasos (grupos, acompañantes, identidad SES, pagos y
// solicitudes) y crea con el mismo cuerpo. Sin estilos en línea (contrato Cocoa
// 22). Las funciones puras se prueban en __tests__/reservation-quick-create.test.mts.

import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import { ApiError, apiRequest } from "../../services/api-client";
import { invalidateApi } from "../../hooks/useApiData";
import {
  fetchReservationFolio,
  fetchReservations,
  postFolioPayment,
  quoteAvailability,
  shiftIsoDate,
  todayIsoLocal,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type AvailabilityQuote
} from "../../services/pmsCommerceApi";
import { fetchGuests, type GuestProfile } from "../../services/guestsApi";
import { newClientRequestId } from "../../services/finance-contracts";
import { queueSesSubmissions, sesQueueOutcomeFromError, sesQueueOutcomeFromResponse } from "../../services/complianceApi";
import { listReservationGuestRegisterRecords, markGuestRegisterIdentityVerified } from "../../services/guestRegisterApi";
import { CheckinRunError, progressLabel, runCheckin, type CheckinProgress } from "../operations/checkinRunner";
import { pickWalkInRoom, walkInCandidateRooms, walkInNights } from "../operations/WalkInDrawer";
import { urlForScreen } from "../../navigation/nav-tree";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { DEFAULT_CURRENCY, money, plural } from "../../lib/format";
import { FIELD_LABELS, RESERVATION_CREATE_ACTIONS, RESERVATION_CREATE_NOTES, RESERVATION_CREATE_TOASTS } from "../../content/actions";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaSelect,
  CocoaSkeleton,
  CocoaStat,
  CocoaStepper,
  openTabPath,
  type CocoaSelectOption
} from "../../components/cocoa";

// =============================================================== formulario compartido

const FORM_TODAY = todayIsoLocal();

/**
 * Valores del formulario de Nueva reserva (los 70 campos del asistente más el
 * huésped enlazado y el NIF de la empresa). Todo cadena: el cuerpo del API se
 * construye en `buildCreateReservationPayload`.
 */
export const defaultReservationForm = {
  // ── Estancia ───────────────────────────────────────────────────────────
  arrivalDate: FORM_TODAY,
  departureDate: shiftIsoDate(FORM_TODAY, 1),
  eta: "",
  etd: "",
  estimatedArrivalTime: "",
  adults: "2",
  children: "0",
  infants: "0",
  childrenAges: "",
  roomsCount: "1",
  roomTypeId: "",
  assignedRoomId: "",
  // ── Tarifa ─────────────────────────────────────────────────────────────
  ratePlanId: "",
  boardType: "BB",
  totalAmount: "",
  // ── Origen (Channel / Source / Market) ─────────────────────────────────
  bookingSource: "direct",
  channel: "direct",
  marketSegment: "leisure",
  sourceCode: "direct_web",
  purposeOfStay: "leisure",
  externalReference: "",
  groupCode: "",
  companyName: "",
  /** NIF de la empresa (solo para recordarlo de cara a la factura, 3.3.7; el API de reservas no lo guarda). */
  companyTaxId: "",
  travelAgentName: "",
  bookerName: "",
  bookerEmail: "",
  // ── Pagos ──────────────────────────────────────────────────────────────
  paymentMethod: "credit_card",
  depositAmount: "",
  depositPaid: "",
  depositDueDate: "",
  guaranteeType: "card_guarantee",
  // Filled with the property's default policy once GET /cancellation-policies answers.
  cancellationPolicyCode: "",
  billingInstruction: "guest_pays_checkout",
  // ── Primary guest (titular) ────────────────────────────────────────────
  /** Ficha existente elegida o prefijada (`?guestId=`): viaja como `primaryGuestId` y el API no crea otra. */
  primaryGuestId: "",
  title: "",
  firstName: "",
  middleName: "",
  surname1: "",
  surname2: "",
  email: "",
  phone: "",
  mobilePhone: "",
  languagePreference: "es",
  guestCompany: "",
  vipCode: "",
  vipFlag: "",
  loyaltyProgram: "",
  loyaltyNumber: "",
  loyaltyTier: "",
  // Guest identity & residence — required by SES Hospedajes (RD 933/2021) for the
  // parte de viajeros. Optional at booking; can be completed by check-in (24h).
  documentType: "DNI",
  documentNumber: "",
  documentSupportNumber: "",
  documentIssueCountry: "",
  documentExpiryDate: "",
  dateOfBirth: "",
  nationality: "ESP",
  sex: "",
  residenceAddress: "",
  // ISO-3 (el API acota `residenceCountry` a 3 caracteres: «España» respondía 400).
  residenceCountry: "ESP",
  residenceProvince: "",
  residenceLocality: "",
  residencePostalCode: "",
  // ── Solicitudes & preferencias ─────────────────────────────────────────
  preferences: "",
  marketingConsent: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  specialRequests: "",
  accessibilityNeeds: "",
  dietaryRequirements: "",
  internalNotes: "",
  notes: ""
};

export type ReservationFormValues = typeof defaultReservationForm;

// =============================================================== modo (?modo=)

export type ReservationCreateMode = "rapida" | "completa";

export const RESERVATION_MODE_PARAM = "modo";

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

/** Modo de la URL (`?modo=completa`); cualquier otro valor o ninguno = rápida. */
export function reservationModeFromSearch(search: string): ReservationCreateMode {
  return paramsOf(search).get(RESERVATION_MODE_PARAM) === "completa" ? "completa" : "rapida";
}

/** La misma query con el modo cambiado (rápida = sin parámetro); conserva el prefijado del Live Timeline y `guestId`. */
export function searchWithReservationMode(search: string, mode: ReservationCreateMode): string {
  const params = paramsOf(search);
  if (mode === "rapida") params.delete(RESERVATION_MODE_PARAM);
  else params.set(RESERVATION_MODE_PARAM, mode);
  const out = params.toString();
  return out ? `?${out}` : "";
}

// =============================================================== huésped prefijado (3.3.7)

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `?guestId=` (lista y ficha de huéspedes, U8) con caracteres de identificador; null si no viene o no vale. */
export function guestIdFromSearch(search: string): string | null {
  const value = paramsOf(search).get("guestId") ?? "";
  return ID.test(value) ? value : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Nombre visible de una ficha («Nombre Apellido»). */
export function guestDisplayName(guest: Pick<GuestProfile, "fullName" | "firstName" | "surname1">): string {
  const full = textOf(guest.fullName);
  if (full) return full;
  return [textOf(guest.firstName), textOf(guest.surname1)].filter(Boolean).join(" ");
}

/**
 * Campos del formulario que rellena una ficha existente (solo los que tienen
 * valor: nunca pisa con vacíos lo ya tecleado) y el enlace `primaryGuestId`.
 */
export function guestPrefillValues(guest: GuestProfile): Partial<ReservationFormValues> {
  const out: Partial<ReservationFormValues> = { primaryGuestId: guest.id };
  const copy = (key: keyof ReservationFormValues, value: unknown) => {
    const text = textOf(value);
    if (text) out[key] = text;
  };
  copy("title", guest.title);
  copy("firstName", guest.firstName);
  copy("middleName", guest.middleName);
  copy("surname1", guest.surname1);
  copy("surname2", guest.surname2);
  copy("email", guest.email);
  copy("phone", guest.phone);
  copy("mobilePhone", guest.mobilePhone);
  copy("languagePreference", guest.languagePreference);
  copy("guestCompany", guest.company);
  copy("vipCode", guest.vipCode);
  copy("loyaltyProgram", guest.loyaltyProgram);
  copy("loyaltyNumber", guest.loyaltyNumber);
  copy("loyaltyTier", guest.loyaltyTier);
  copy("documentType", guest.documentType);
  copy("documentNumber", guest.documentNumber);
  copy("documentSupportNumber", guest.documentSupportNumber);
  copy("documentIssueCountry", guest.documentIssueCountry);
  copy("documentExpiryDate", textOf(guest.documentExpiryDate).slice(0, 10));
  copy("dateOfBirth", textOf(guest.dateOfBirth).slice(0, 10));
  copy("nationality", guest.nationality);
  copy("sex", guest.sex);
  copy("residenceAddress", guest.residenceAddress);
  copy("residenceLocality", guest.residenceLocality);
  copy("residenceProvince", guest.residenceProvince);
  copy("residencePostalCode", guest.residencePostalCode);
  copy("residenceCountry", guest.residenceCountry);
  copy("emergencyContactName", guest.emergencyContactName);
  copy("emergencyContactPhone", guest.emergencyContactPhone);
  if (guest.marketingConsent === true) out.marketingConsent = "yes";
  if (guest.vipCode) out.vipFlag = "yes";
  return out;
}

/**
 * Ficha sugerida para lo tecleado (pura): apellido contenido en el nombre
 * completo y, si hay nombre, que empiece igual; nunca una descartada.
 */
export function pickGuestSuggestion(guests: readonly GuestProfile[], typed: { firstName: string; surname1: string }, dismissed: ReadonlySet<string> = new Set()): GuestProfile | null {
  const surname = typed.surname1.trim().toLowerCase();
  const first = typed.firstName.trim().toLowerCase();
  if (surname.length < 3) return null;
  return (
    guests.find((guest) => {
      if (dismissed.has(guest.id)) return false;
      const full = guestDisplayName(guest).toLowerCase();
      if (!full.includes(surname)) return false;
      return first === "" || textOf(guest.firstName).toLowerCase().startsWith(first);
    }) ?? null
  );
}

// =============================================================== empresa (T5)

export const COMPANY_BILLING_INSTRUCTION = "company_invoice";

/** Razón social tecleada: con nombre, la instrucción de cobro pasa a «Factura a empresa»; al borrarlo vuelve al valor por defecto. */
export function applyCompany(form: ReservationFormValues, companyName: string): ReservationFormValues {
  const name = companyName;
  if (name.trim()) return { ...form, companyName: name, billingInstruction: COMPANY_BILLING_INSTRUCTION };
  return {
    ...form,
    companyName: name,
    billingInstruction: form.billingInstruction === COMPANY_BILLING_INSTRUCTION ? defaultReservationForm.billingInstruction : form.billingInstruction
  };
}

// =============================================================== obligatorios y precio

export type QuickMissing = "pastArrival" | "dates" | "roomType" | "price" | "guest";

export type QuickMissingContext = {
  /** Hoy (ISO local): una llegada anterior bloquea (corrector L-02; el API responde 400 PAST_ARRIVAL_DATE). */
  today?: string;
  /** Cotización recibida: un relleno (sin tarifa publicada) o un total 0 sin importe manual bloquea; sin cotización todavía no. */
  price?: QuickPrice | null;
  manualTotal?: number | null;
};

/** Qué falta para poder crear, en el orden de la vista ([] si todo está): los 3 del API/pantalla más la llegada y el precio (L-02). */
export function quickMissing(form: Pick<ReservationFormValues, "arrivalDate" | "departureDate" | "roomTypeId" | "firstName" | "surname1">, context: QuickMissingContext = {}): QuickMissing[] {
  const missing: QuickMissing[] = [];
  if (context.today && form.arrivalDate && form.arrivalDate < context.today) missing.push("pastArrival");
  if (walkInNights(form.arrivalDate, form.departureDate) < 1) missing.push("dates");
  if (!form.roomTypeId) missing.push("roomType");
  const manual = context.manualTotal ?? null;
  if (context.price && (manual === null || !Number.isFinite(manual)) && (context.price.filler || context.price.total <= 0)) missing.push("price");
  if (!form.firstName.trim() || !form.surname1.trim()) missing.push("guest");
  return missing;
}

/** Motivo por el que «Crear reserva» está deshabilitado (título nominal del botón); sin faltas, la ayuda de Intro. */
export function quickBlockingTitle(missing: readonly QuickMissing[]): string {
  switch (missing[0]) {
    case "pastArrival":
      return RESERVATION_CREATE_NOTES.pastArrival;
    case "dates":
      return "La salida debe ser posterior a la llegada.";
    case "roomType":
      return "Elige un tipo de habitación.";
    case "price":
      return RESERVATION_CREATE_NOTES.priceRequired;
    case "guest":
      return "Indica nombre y apellido del huésped.";
    default:
      return "Intro también crea la reserva";
  }
}

export const QUICK_QUOTE_DEBOUNCE_MS = 300;

export type QuickPrice = {
  /** Estancia completa por las habitaciones pedidas. */
  total: number;
  /** Por noche y habitación. */
  nightly: number;
  currency: string;
  available: number;
  /** Alguna noche sin tarifa publicada: relleno, nunca se convierte en el total. */
  filler: boolean;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Primera letra en minúscula para encadenar una nota tras «creada, pero …». */
function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** Precio en vivo del tipo elegido según la cotización (null sin cotización o sin importe). */
export function quickPrice(quotes: readonly AvailabilityQuote[], roomTypeId: string, nights: number, roomsCount = 1): QuickPrice | null {
  const quote = quotes.find((entry) => entry.roomTypeId === roomTypeId);
  if (!quote || typeof quote.totalAmount !== "number" || !Number.isFinite(quote.totalAmount)) return null;
  const rooms = Math.max(1, roomsCount);
  return {
    total: round2(quote.totalAmount * rooms),
    nightly: nights > 0 ? round2(quote.totalAmount / nights) : round2(quote.totalAmount),
    currency: quote.currency || DEFAULT_CURRENCY,
    available: quote.availableRooms,
    filler: quote.priceSource === "fallback"
  };
}

/** Total a mostrar: el manual si se tecleó; si no, el cotizado (nunca un relleno); null si no hay nada. */
export function quickTotal(price: QuickPrice | null, manualTotal: number | null): number | null {
  if (manualTotal !== null && Number.isFinite(manualTotal)) return manualTotal;
  if (price && !price.filler) return price.total;
  return null;
}

/** «Doble · 89,00 €/noche · 4 libres» (la etiqueta del tipo con el precio en vivo). */
export function quickRoomTypeLabel(type: Pick<AdminRoomType, "name">, price: QuickPrice | null, formatAmount: (amount: number, currency?: string) => string): string {
  if (!price) return type.name;
  return `${type.name} · ${RESERVATION_CREATE_NOTES.livePrice(formatAmount(price.nightly, price.currency), price.available)}`;
}

/** Tipo preseleccionado: el primero con disponibilidad según la cotización; sin cotización, el primero del catálogo. */
export function pickQuickRoomType(roomTypes: readonly AdminRoomType[], quotes: readonly AvailabilityQuote[]): string {
  const available = quotes.find((quote) => quote.availableRooms > 0 && roomTypes.some((type) => type.id === quote.roomTypeId));
  return available?.roomTypeId ?? roomTypes[0]?.id ?? "";
}

// =============================================================== habitación del check-in

/**
 * Habitaciones que OTRAS reservas vivas tienen asignadas en la ventana de la
 * estancia (el API responde 409 «ya está asignada a la reserva X» al asignarlas
 * aunque la habitación esté limpia y libre ahora mismo). Pura.
 */
export function heldRoomIds(reservations: ReadonlyArray<Pick<AdminReservation, "id" | "assignedRoomId" | "status">>, exceptId: string): Set<string> {
  const held = new Set<string>();
  for (const reservation of reservations) {
    if (reservation.id === exceptId || !reservation.assignedRoomId) continue;
    const status = (reservation.status ?? "").toLowerCase();
    if (status === "cancelled" || status === "no_show" || status === "checked_out") continue;
    held.add(reservation.assignedRoomId);
  }
  return held;
}

/** Primera habitación limpia, libre y sin otra reserva del tipo (por número), o null. Pura. */
export function pickQuickCheckinRoom(rooms: readonly AdminRoom[], roomTypeId: string, held: ReadonlySet<string>): AdminRoom | null {
  return pickWalkInRoom(rooms.filter((room) => !held.has(room.id)), roomTypeId);
}

// =============================================================== cuerpo del POST (compartido por los dos modos)

export type ReservationCompanionInput = {
  firstName: string;
  surname1: string;
  documentType: string;
  documentNumber: string;
  dateOfBirth: string;
  nationality: string;
  type: "adult" | "child" | "infant";
};

export type ReservationPayloadExtras = {
  nightsCount: number;
  /** Importe tecleado en «Precio total» o null (el API cotiza desde la parrilla). */
  manualTotal: number | null;
  companions?: readonly ReservationCompanionInput[];
};

/** Cadena sin espacios o undefined: el API responde 400 a un correo «» y guardaría teléfonos vacíos. */
function blank(value: string | null | undefined): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : undefined;
}

const COUNTRY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  españa: "ESP",
  espana: "ESP",
  spain: "ESP",
  portugal: "PRT",
  francia: "FRA",
  france: "FRA",
  alemania: "DEU",
  germany: "DEU",
  italia: "ITA",
  italy: "ITA",
  "reino unido": "GBR",
  "united kingdom": "GBR"
});

/** País en ISO-3 (lo que exige el API): un código de 3 letras tal cual, un nombre conocido traducido, cualquier otra cosa se omite. */
export function isoCountry(value: string | null | undefined): string | undefined {
  const text = blank(value);
  if (!text) return undefined;
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase();
  return COUNTRY_ALIASES[text.toLowerCase()];
}

function numberOrUndefined(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csvList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Cuerpo de POST /properties/:id/reservations a partir del formulario (puro):
 * el mismo de los seis pasos, con los obligatorios del API (`arrivalDate`,
 * `departureDate`, `roomTypeId`), sin cadenas vacías en correos, teléfonos y
 * notas (400 o basura), países en ISO-3, `totalAmount` solo si se tecleó (la
 * parrilla cotiza el resto) y `primaryGuestId` cuando el huésped ya tiene ficha.
 */
export function buildCreateReservationPayload(form: ReservationFormValues, extras: ReservationPayloadExtras): Record<string, unknown> {
  // Solo edades tecleadas: «» → [] (antes Number("") = 0 colaba `childrenAges: [0]` sin niños).
  const childrenAges = csvList(form.childrenAges)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const preferences = csvList(form.preferences);
  const accessibilityList = csvList(form.accessibilityNeeds);
  const dietaryList = csvList(form.dietaryRequirements);
  const companions = extras.companions ?? [];
  const vip = form.vipFlag === "yes";
  const manualTotal = extras.manualTotal !== null && Number.isFinite(extras.manualTotal) ? extras.manualTotal : undefined;
  return {
    // Estancia
    arrivalDate: form.arrivalDate,
    departureDate: form.departureDate,
    nightsCount: extras.nightsCount,
    eta: blank(form.eta),
    etd: blank(form.etd),
    estimatedArrivalTime: blank(form.estimatedArrivalTime) ?? blank(form.eta),
    adults: Number(form.adults) || 1,
    children: Number(form.children) || 0,
    infants: Number(form.infants) || 0,
    childrenAges: childrenAges.length ? childrenAges : undefined,
    roomsCount: Number(form.roomsCount) || 1,
    roomTypeId: form.roomTypeId || undefined,
    assignedRoomId: blank(form.assignedRoomId),
    // Tarifa · Tanda L3 (lote A): `totalAmount` solo si se tecleó (vacío → la
    // parrilla cotiza); el desglose de IVA es solo de pantalla.
    ratePlanId: blank(form.ratePlanId),
    boardType: blank(form.boardType),
    totalAmount: manualTotal,
    currency: DEFAULT_CURRENCY,
    // Origen (procedencia comercial)
    bookingSource: form.bookingSource,
    channel: form.channel,
    marketSegment: form.marketSegment,
    sourceCode: form.sourceCode,
    purposeOfStay: blank(form.purposeOfStay),
    externalReference: blank(form.externalReference),
    groupCode: blank(form.groupCode),
    companyName: blank(form.companyName),
    travelAgentName: blank(form.travelAgentName),
    bookerName: blank(form.bookerName),
    bookerEmail: blank(form.bookerEmail),
    // Pagos
    paymentMethod: form.paymentMethod,
    depositAmount: numberOrUndefined(form.depositAmount),
    depositPaid: numberOrUndefined(form.depositPaid),
    depositDueDate: blank(form.depositDueDate),
    guaranteeType: form.guaranteeType,
    cancellationPolicyCode: blank(form.cancellationPolicyCode),
    billingInstruction: form.billingInstruction,
    // Solicitudes y operativos
    specialRequests: blank(form.specialRequests),
    accessibilityNeeds: accessibilityList.length ? accessibilityList : undefined,
    dietaryRequirements: dietaryList.length ? dietaryList : undefined,
    vipFlag: vip,
    internalNotes: blank(form.internalNotes),
    notes: blank(form.notes),
    // Acompañantes y bebés
    companions: companions.length
      ? companions.map((companion) => ({
          firstName: companion.firstName,
          surname1: companion.surname1,
          documentType: companion.documentType,
          documentNumber: blank(companion.documentNumber),
          dateOfBirth: blank(companion.dateOfBirth),
          nationality: isoCountry(companion.nationality),
          type: companion.type
        }))
      : undefined,
    // Huésped principal: ficha existente (3.3.7) o alta con lo tecleado
    primaryGuestId: blank(form.primaryGuestId),
    primaryGuest: {
      title: blank(form.title),
      firstName: form.firstName.trim(),
      middleName: blank(form.middleName),
      surname1: form.surname1.trim(),
      surname2: blank(form.surname2),
      phone: blank(form.phone),
      mobilePhone: blank(form.mobilePhone),
      email: blank(form.email),
      languagePreference: blank(form.languagePreference),
      company: blank(form.guestCompany),
      vipCode: blank(form.vipCode),
      vipFlag: vip,
      loyaltyProgram: blank(form.loyaltyProgram),
      loyaltyNumber: blank(form.loyaltyNumber),
      loyaltyTier: blank(form.loyaltyTier),
      documentType: blank(form.documentType),
      documentNumber: blank(form.documentNumber),
      documentSupportNumber: blank(form.documentSupportNumber),
      documentIssueCountry: isoCountry(form.documentIssueCountry),
      documentExpiryDate: blank(form.documentExpiryDate),
      dateOfBirth: blank(form.dateOfBirth),
      nationality: isoCountry(form.nationality),
      sex: blank(form.sex),
      residenceAddress: blank(form.residenceAddress),
      residenceCountry: isoCountry(form.residenceCountry),
      residenceProvince: blank(form.residenceProvince),
      residenceLocality: blank(form.residenceLocality),
      residencePostalCode: blank(form.residencePostalCode),
      emergencyContactName: blank(form.emergencyContactName),
      emergencyContactPhone: blank(form.emergencyContactPhone),
      marketingConsent: form.marketingConsent === "yes",
      preferences: preferences.length ? preferences : undefined
    }
  };
}

// =============================================================== esqueletos espejo (F33)

/** Esqueleto del modo rápido: cuatro bloques (estancia, huésped, origen y tarifa, empresa) y la barra. */
export function ReservationQuickCreateSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={132} />
      <CocoaSkeleton variant="card" height={112} />
      <CocoaSkeleton variant="card" height={112} />
      <CocoaSkeleton variant="card" height={96} />
      <CocoaSkeleton variant="row" />
    </div>
  );
}

/** Esqueleto del modo completo: la columna de pasos y el primer paso. */
export function ReservationWizardSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton variant="card" height={320} />
      <CocoaSkeleton variant="row" />
    </div>
  );
}

// =============================================================== componente

export type ReservationQuickCreateErrors = {
  roomType?: string;
  firstName?: string;
  surname1?: string;
};

export type ReservationQuickCreateProps = {
  propertyId: string;
  form: ReservationFormValues;
  setForm: Dispatch<SetStateAction<ReservationFormValues>>;
  roomTypes: readonly AdminRoomType[];
  rooms: readonly AdminRoom[];
  ratePlanOptions: readonly CocoaSelectOption[];
  bookingSourceOptions: readonly CocoaSelectOption[];
  /** Mensaje de estado de la pantalla (errores del API, notas), pintado arriba. */
  status: string | null;
  /** Errores de obligatorios tras intentar crear (la pantalla enfoca el campo). */
  errors: ReservationQuickCreateErrors;
  /** Nota del prefijado del Live Timeline o null. */
  prefillNote: string | null;
  /** Nombre del huésped prefijado por `?guestId=` (3.3.7) o null. */
  prefilledGuestName: string | null;
  /** POST en curso en la pantalla. */
  creating: boolean;
  /** Valida y crea: la reserva, o null si faltan obligatorios (la pantalla ya lo dice y enfoca). */
  onCreate: () => Promise<AdminReservation | null>;
};

type QuickIntent = "open" | "deposit" | "checkin";

type PendingDeposit = { reservation: AdminReservation; folioId: string; currency: string; amount: number };

/** Ids compartidos con el modo completo: `focusField` de la pantalla enfoca el mismo campo en los dos modos. */
export const QUICK_FIELD_IDS = Object.freeze({ roomType: "rc-field-roomtype", firstName: "rc-field-firstname", surname1: "rc-field-surname1" });

function reservationUrl(reservationId: string): string {
  return urlForScreen("ReservationDetailWorkspace", { id: reservationId }) ?? "/recepcion/reservas";
}

export function ReservationQuickCreate({
  propertyId,
  form,
  setForm,
  roomTypes,
  rooms,
  ratePlanOptions,
  bookingSourceOptions,
  status,
  errors,
  prefillNote,
  prefilledGuestName,
  creating,
  onCreate
}: ReservationQuickCreateProps) {
  const { showToast } = useToast();
  // Hosted inside NuevaReservaTabs: the container paints the H1; the form's accessible name follows its label.
  const host = useTabHost();
  const formLabel = `${host?.title ?? "Nueva reserva"} rápida`;
  const formId = useId();
  const today = useMemo(() => todayIsoLocal(), []);

  const [quotes, setQuotes] = useState<AvailabilityQuote[]>([]);
  const [quoting, setQuoting] = useState(false);
  const [quotesReady, setQuotesReady] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quoteSeq = useRef(0);
  const typeTouched = useRef(Boolean(form.roomTypeId));

  const [suggestion, setSuggestion] = useState<GuestProfile | null>(null);
  const [dismissedGuests, setDismissedGuests] = useState<ReadonlySet<string>>(() => new Set());
  const suggestSeq = useRef(0);

  const [busy, setBusy] = useState<QuickIntent | null>(null);
  const [progress, setProgress] = useState<CheckinProgress | null>(null);
  const [pendingDeposit, setPendingDeposit] = useState<PendingDeposit | null>(null);

  const nights = walkInNights(form.arrivalDate, form.departureDate);
  const roomsCount = Number(form.roomsCount) || 1;

  // Precio en vivo: cotización de todos los tipos al cambiar fechas, ocupación o plan (300 ms).
  useEffect(() => {
    if (nights < 1) {
      setQuotes([]);
      setQuoteError(null);
      setQuoting(false);
      return undefined;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const timer = window.setTimeout(() => {
      quoteAvailability(propertyId, {
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        adults: Number(form.adults) || 1,
        children: Number(form.children) || 0,
        ...(form.ratePlanId ? { ratePlanId: form.ratePlanId } : {})
      })
        .then((response) => {
          if (seq !== quoteSeq.current) return;
          setQuotes(response);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (seq !== quoteSeq.current) return;
          setQuotes([]);
          setQuoteError(err instanceof Error ? err.message : "No se pudo consultar la disponibilidad.");
        })
        .finally(() => {
          if (seq !== quoteSeq.current) return;
          setQuoting(false);
          setQuotesReady(true);
        });
    }, QUICK_QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [propertyId, form.arrivalDate, form.departureDate, form.adults, form.children, form.ratePlanId, nights]);

  // Tipo preseleccionado (el primero con disponibilidad) hasta que el recepcionista toque el selector.
  useEffect(() => {
    if (typeTouched.current || form.roomTypeId || roomTypes.length === 0 || !quotesReady) return;
    const picked = pickQuickRoomType(roomTypes, quotes);
    if (picked) setForm((current) => (current.roomTypeId ? current : { ...current, roomTypeId: picked }));
  }, [form.roomTypeId, roomTypes, quotes, quotesReady, setForm]);

  // Sugerencia de ficha existente (3.3.7) al teclear el apellido; nunca con un huésped ya enlazado.
  const typedFirst = form.firstName;
  const typedSurname = form.surname1;
  const linkedGuest = form.primaryGuestId;
  useEffect(() => {
    if (linkedGuest || typedSurname.trim().length < 3) {
      setSuggestion(null);
      return undefined;
    }
    const seq = ++suggestSeq.current;
    const timer = window.setTimeout(() => {
      fetchGuests({ search: typedSurname.trim(), limit: 10 })
        .then((page) => {
          if (seq !== suggestSeq.current) return;
          setSuggestion(pickGuestSuggestion(page.items ?? [], { firstName: typedFirst, surname1: typedSurname }, dismissedGuests));
        })
        .catch(() => {
          if (seq === suggestSeq.current) setSuggestion(null);
        });
    }, QUICK_QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [linkedGuest, typedFirst, typedSurname, dismissedGuests]);

  const price = useMemo(() => quickPrice(quotes, form.roomTypeId, nights, roomsCount), [quotes, form.roomTypeId, nights, roomsCount]);
  const manualTotal = form.totalAmount.trim() === "" ? null : Number(form.totalAmount);
  const total = quickTotal(price, manualTotal);
  const currency = price?.currency ?? DEFAULT_CURRENCY;
  const missing = quickMissing(form, { today, price, manualTotal });
  const isBusy = busy !== null || creating;
  const canSubmit = missing.length === 0 && !isBusy;

  const roomTypeOptions = useMemo(
    () => roomTypes.map((type) => ({ value: type.id, label: quickRoomTypeLabel(type, quickPrice(quotes, type.id, nights, 1), (amount, code) => money(amount, code)) })),
    [roomTypes, quotes, nights]
  );

  // Habitación del check-in: la prefijada (Live Timeline) o, al confirmar, la primera limpia, libre y
  // sin otra reserva del tipo (las reservas vivas de la ventana se consultan justo antes de asignar).
  const prefilledRoom = useMemo(() => (form.assignedRoomId ? rooms.find((room) => room.id === form.assignedRoomId) ?? null : null), [rooms, form.assignedRoomId]);
  const candidateCount = useMemo(() => (form.roomTypeId ? walkInCandidateRooms(rooms, form.roomTypeId).length : 0), [rooms, form.roomTypeId]);
  const arrivesToday = form.arrivalDate === today;
  const checkinBlockedReason = !arrivesToday ? RESERVATION_CREATE_NOTES.checkInNeedsToday : !prefilledRoom && candidateCount === 0 ? RESERVATION_CREATE_NOTES.checkInNeedsRoom : null;

  const set = (key: keyof ReservationFormValues) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  function shiftDeparture(delta: number) {
    setForm((current) => {
      const next = Math.max(1, walkInNights(current.arrivalDate, current.departureDate) + delta);
      return { ...current, departureDate: shiftIsoDate(current.arrivalDate, next) };
    });
  }

  function applyGuest(guest: GuestProfile) {
    setForm((current) => ({ ...current, ...guestPrefillValues(guest) }));
    setSuggestion(null);
    showToast(RESERVATION_CREATE_TOASTS.guestApplied(guestDisplayName(guest)), { variant: "success" });
  }

  function dismissGuest(guest: GuestProfile) {
    setDismissedGuests((current) => new Set([...current, guest.id]));
    setSuggestion(null);
  }

  function goToReservation(reservation: AdminReservation) {
    openTabPath(reservationUrl(reservation.id));
  }

  async function submit(intent: QuickIntent) {
    if (isBusy) return;
    if (intent === "checkin" && checkinBlockedReason) {
      showToast(checkinBlockedReason, { variant: "warning" });
      return;
    }
    setBusy(intent);
    setProgress(null);
    let reservation: AdminReservation | null = null;
    try {
      reservation = await onCreate();
      if (!reservation) return;
      logBreadcrumb("reservation.quick.created", "mutation", { reservationId: reservation.id, intent, nights, guestLinked: Boolean(form.primaryGuestId) });
      if (intent === "open") {
        goToReservation(reservation);
        return;
      }
      if (intent === "deposit") {
        const folio = await fetchReservationFolio(reservation.id);
        const typedDeposit = numberOrUndefined(form.depositAmount);
        const amount = typedDeposit && typedDeposit > 0 ? typedDeposit : round2(Number(reservation.totalAmount) || 0);
        setPendingDeposit({ reservation, folioId: folio.folio.id, currency: folio.folio.currency || reservation.currency || currency, amount });
        return;
      }
      let room = prefilledRoom;
      if (!room) {
        // Solo las reservas vivas que se solapan con la estancia: las canceladas, no-show y salidas no retienen habitación.
        const overlapping = await fetchReservations(propertyId, { from: form.arrivalDate, to: form.departureDate, status: ["confirmed", "checked_in"], limit: 500 });
        room = pickQuickCheckinRoom(rooms, form.roomTypeId, heldRoomIds(overlapping.items ?? [], reservation.id));
      }
      if (!room) {
        showToast(`Reserva ${reservation.code} creada, pero ${lowerFirst(RESERVATION_CREATE_NOTES.checkInNeedsRoom)}`, { variant: "warning", duration: 9000 });
        goToReservation(reservation);
        return;
      }
      const roomId = room.id;
      const roomNumber = room.number;
      const result = await runCheckin(
        {
          reservationId: reservation.id,
          propertyId,
          assignedRoomId: reservation.assignedRoomId ?? null,
          roomId,
          currency: reservation.currency || currency,
          payment: null
        },
        {
          request: apiRequest,
          postPayment: (folioId, body) => postFolioPayment(folioId, body),
          listPartes: () => listReservationGuestRegisterRecords(reservation!.id, { retries: 0 }),
          markIdentity: (parteId) => markGuestRegisterIdentityVerified(parteId, "visual_document_check"),
          queueSes: (pid, rid) => queueSesSubmissions(pid, rid).then(sesQueueOutcomeFromResponse, sesQueueOutcomeFromError),
          newClientRequestId,
          isForbidden: (err) => err instanceof ApiError && err.status === 403,
          onProgress: setProgress
        }
      );
      invalidateApi("/dashboards/front-desk");
      showToast(RESERVATION_CREATE_TOASTS.createdAndCheckedIn(reservation.code, roomNumber), { variant: "success" });
      if (result.ses.kind !== "queued") {
        showToast("Parte de viajeros no encolado en SES: complétalo desde la ficha o la bandeja de cumplimiento.", { variant: "warning", duration: 8000 });
      }
      goToReservation(reservation);
    } catch (err) {
      const message = err instanceof CheckinRunError ? `Reserva ${reservation?.code ?? ""} creada, pero ${lowerFirst(err.message)}` : err instanceof Error ? err.message : "No se pudo completar la acción.";
      showToast(message, { variant: "error", duration: 9000 });
      if (reservation) goToReservation(reservation);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit("open");
  }

  const typeHelp = quoteError
    ? RESERVATION_CREATE_NOTES.quoteError(quoteError)
    : quoting && !price
      ? RESERVATION_CREATE_NOTES.quoting
      : price?.filler
        ? RESERVATION_CREATE_NOTES.fillerPrice
        : price && price.available === 0
          ? RESERVATION_CREATE_NOTES.noAvailability
          : RESERVATION_CREATE_NOTES.totalFromRate;

  const totalLabel = total !== null ? money(total, currency) : "—";
  const barStatus = `${FIELD_LABELS.total} ${totalLabel} · ${plural(nights, "noche", "noches")}${manualTotal !== null ? " · importe manual" : price && !price.filler ? " · tarifa publicada" : ""}`;

  return (
    <>
      <form id={formId} onSubmit={onSubmit} className="cocoa-stack" data-gap="4" aria-label={formLabel}>
        {status ? (
          <CocoaCallout tone="neutral" role="status">
            {status}
          </CocoaCallout>
        ) : null}
        {prefillNote ? (
          <CocoaCallout tone="info" role="note">
            {prefillNote}
            {prefilledRoom ? ` Habitación ${prefilledRoom.number}.` : ""}
          </CocoaCallout>
        ) : null}
        {progress ? (
          <CocoaCallout tone="info" role="status">
            {progressLabel(progress)}
          </CocoaCallout>
        ) : null}

        <CocoaFormSection
          title="Estancia"
          description={`${plural(nights, "noche", "noches")} · ${RESERVATION_CREATE_NOTES.fullModeHint}`}
          actions={
            <>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => shiftDeparture(-1)} disabled={isBusy || nights <= 1}>
                {RESERVATION_CREATE_ACTIONS.minusNight}
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => shiftDeparture(1)} disabled={isBusy}>
                {RESERVATION_CREATE_ACTIONS.plusNight}
              </CocoaButton>
            </>
          }
        >
          <CocoaFormRow columns={4} min={180}>
            <CocoaField label="Llegada" required help="Admite «+7», «hoy» o «mañana»." error={missing.includes("pastArrival") ? RESERVATION_CREATE_NOTES.pastArrival : undefined}>
              <CocoaDatePicker value={form.arrivalDate} onChange={set("arrivalDate")} min={today} arithmetic today={today} disabled={isBusy} />
            </CocoaField>
            <CocoaField label="Salida" required error={missing.includes("dates") ? "La salida debe ser posterior a la llegada." : undefined}>
              <CocoaDatePicker value={form.departureDate} onChange={set("departureDate")} min={form.arrivalDate} arithmetic today={form.arrivalDate} disabled={isBusy} />
            </CocoaField>
            <CocoaField label="Adultos">
              <CocoaStepper value={Number(form.adults) || 1} onChange={(n) => set("adults")(String(n))} min={1} disabled={isBusy} />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.roomType} required error={errors.roomType} help={typeHelp}>
              <CocoaSelect
                id={QUICK_FIELD_IDS.roomType}
                value={form.roomTypeId}
                onChange={(value) => {
                  typeTouched.current = true;
                  set("roomTypeId")(value);
                }}
                options={roomTypeOptions}
                placeholder="Selecciona un tipo…"
                disabled={isBusy || roomTypeOptions.length === 0}
              />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Huésped" description={prefilledGuestName ? RESERVATION_CREATE_NOTES.guestPrefilled(prefilledGuestName) : RESERVATION_CREATE_NOTES.requiredGuest}>
          {suggestion ? (
            <CocoaCallout
              tone="info"
              role="status"
              actions={
                <>
                  <CocoaButton variant="filled" tone="accent" size="small" onClick={() => applyGuest(suggestion)} disabled={isBusy}>
                    {RESERVATION_CREATE_ACTIONS.useGuest}
                  </CocoaButton>
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => dismissGuest(suggestion)} disabled={isBusy}>
                    {RESERVATION_CREATE_ACTIONS.dismissGuest}
                  </CocoaButton>
                </>
              }
            >
              {RESERVATION_CREATE_NOTES.guestSuggestion(guestDisplayName(suggestion))}
              {suggestion.phone || suggestion.email ? ` (${[suggestion.phone, suggestion.email].filter(Boolean).join(" · ")})` : ""}
            </CocoaCallout>
          ) : null}
          <CocoaFormRow columns={4} min={180}>
            <CocoaField label="Nombre" required error={errors.firstName}>
              <CocoaInput id={QUICK_FIELD_IDS.firstName} value={form.firstName} onChange={set("firstName")} autoComplete="off" disabled={isBusy} required />
            </CocoaField>
            <CocoaField label="Apellido" required error={errors.surname1}>
              <CocoaInput id={QUICK_FIELD_IDS.surname1} value={form.surname1} onChange={set("surname1")} autoComplete="off" disabled={isBusy} required />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.phone} hint="opcional">
              <CocoaInput value={form.phone} onChange={set("phone")} type="tel" autoComplete="off" disabled={isBusy} />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.email} hint="opcional">
              <CocoaInput value={form.email} onChange={set("email")} type="email" autoComplete="off" disabled={isBusy} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Origen y tarifa" description={RESERVATION_CREATE_NOTES.totalFromRate}>
          <CocoaFormRow columns={4} min={180}>
            <CocoaField label="Origen de la reserva">
              <CocoaSelect value={form.bookingSource} onChange={set("bookingSource")} options={[...bookingSourceOptions]} disabled={isBusy} />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.ratePlan}>
              <CocoaSelect value={form.ratePlanId} onChange={set("ratePlanId")} options={[...ratePlanOptions]} disabled={isBusy} />
            </CocoaField>
            <CocoaField label="Precio total (€)" hint="opcional" help={price && !price.filler ? `Cotizado: ${money(price.total, currency)}` : undefined} error={missing.includes("price") ? RESERVATION_CREATE_NOTES.priceRequired : undefined}>
              <CocoaInput
                value={form.totalAmount}
                onChange={set("totalAmount")}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder={price && !price.filler ? price.total.toFixed(2) : "Según tarifa"}
                disabled={isBusy}
              />
            </CocoaField>
            <CocoaStat label={FIELD_LABELS.total} value={totalLabel} tone="accent" hint={manualTotal !== null ? "importe manual" : price && !price.filler ? "tarifa publicada" : "se cotiza al crear"} />
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection
          title="Empresa"
          description={RESERVATION_CREATE_NOTES.companyInvoice}
          actions={form.companyName.trim() ? <CocoaBadge tone="accent" size="small" uppercase={false}>Factura a empresa</CocoaBadge> : undefined}
        >
          <CocoaFormRow columns={4} min={180}>
            <CocoaField label="Razón social" hint="opcional">
              <CocoaInput value={form.companyName} onChange={(value) => setForm((current) => applyCompany(current, value))} placeholder="Empresa que paga" autoComplete="off" disabled={isBusy} />
            </CocoaField>
            <CocoaField label="NIF" hint="opcional">
              <CocoaInput value={form.companyTaxId} onChange={set("companyTaxId")} placeholder="B12345674" autoComplete="off" disabled={isBusy} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
      </form>

      <CocoaActionBar
        aria-label="Crear la reserva"
        status={barStatus}
        extra={
          <>
            <CocoaButton variant="bordered" tone="neutral" size="small" accessKey="D" disabled={!canSubmit} loading={busy === "deposit"} onClick={() => void submit("deposit")} title={RESERVATION_CREATE_NOTES.depositDefault}>
              {RESERVATION_CREATE_ACTIONS.createAndDeposit}
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              size="small"
              accessKey="I"
              disabled={!canSubmit || checkinBlockedReason !== null}
              loading={busy === "checkin"}
              onClick={() => void submit("checkin")}
              title={checkinBlockedReason ?? (prefilledRoom ? `Check-in en la ${prefilledRoom.number}` : `Check-in en la primera limpia y libre del tipo (${plural(candidateCount, "candidata", "candidatas")})`)}
            >
              {RESERVATION_CREATE_ACTIONS.createAndCheckIn}
            </CocoaButton>
          </>
        }
        primary={{
          label: busy === "open" || creating ? "Creando…" : RESERVATION_CREATE_ACTIONS.create,
          type: "submit",
          form: formId,
          accessKey: "C",
          loading: busy === "open" || creating,
          disabled: !canSubmit,
          title: quickBlockingTitle(missing)
        }}
        publishToastOffset
      />

      {pendingDeposit ? (
        <PaymentDialog
          open
          onClose={() => {
            const reservation = pendingDeposit.reservation;
            setPendingDeposit(null);
            goToReservation(reservation);
          }}
          folioId={pendingDeposit.folioId}
          propertyId={propertyId}
          currency={pendingDeposit.currency}
          balanceDue={pendingDeposit.amount}
          subject={`Reserva ${pendingDeposit.reservation.code} · depósito`}
          onCaptured={(payment) => {
            const reservation = pendingDeposit.reservation;
            showToast(RESERVATION_CREATE_TOASTS.depositCollected(money(Number(payment.amount) || pendingDeposit.amount, pendingDeposit.currency), reservation.code), { variant: "success" });
            invalidateApi("/dashboards/front-desk");
            setPendingDeposit(null);
            goToReservation(reservation);
          }}
          onIntent={() => showToast("Intento de cobro creado: pendiente de la pasarela.", { variant: "info" })}
        />
      ) : null}
    </>
  );
}

export default ReservationQuickCreate;
