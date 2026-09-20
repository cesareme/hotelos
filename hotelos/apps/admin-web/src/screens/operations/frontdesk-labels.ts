// Front-desk labels shared by the check-in / check-out drawers (Cocoa 22 ·
// ola 2 · fix:2-A). The API sends raw enums («checked_out», «dirty») and a
// floor that is "" (Rías Altas, 120/120 rooms) or already «Planta 1» (Los
// Tilos); the operator must never read them as-is. Pure and unit-tested
// (__tests__/frontdesk-labels.test.mts).
//
// Tanda UX-1 · lote U2: the labels come from content/status-dictionary.ts
// (one vocabulary for every screen, D5); this module only re-exports them
// and keeps the helpers the drawers already import.

import { RESERVATION_STATUS, ROOM_STATUS, reservationStatus, roomStatus, statusLabels } from "../../content/status-dictionary";

export { RESERVATION_STATUS, ROOM_STATUS, reservationStatus, roomStatus } from "../../content/status-dictionary";

/** Reservation status → Spanish label (D5 vocabulary, derived from the dictionary). */
export const RESERVATION_STATUS_LABELS: Record<string, string> = statusLabels(RESERVATION_STATUS);

/** Label of a reservation status; an unknown or absent status reads «Desconocido», never the raw enum (qa#8, P6). */
export function reservationStatusLabel(status: string | null | undefined): string {
  return reservationStatus(status).label;
}

/** Housekeeping status of a room → lowercase label for inline use («Hab. 119 · sucia»). */
export const HOUSEKEEPING_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(statusLabels(ROOM_STATUS)).map(([key, label]) => [key, label.toLowerCase()])
);

/** Lowercase label of a housekeeping status; unknown or absent → «desconocido», never the raw enum. */
export function housekeepingStatusLabel(status: string | null | undefined): string {
  return roomStatus(status).label.toLowerCase();
}

/**
 * «Hab. 119 · planta 2 · limpia»: the floor segment only when the API sends
 * one, and never «planta Planta 1» when the value already names it (qa#7).
 */
export function roomOptionLabel(room: { number: string; floor?: string | null }, state: string): string {
  const floor = (room.floor ?? "").trim();
  const floorLabel = !floor ? null : /^planta\b/i.test(floor) ? floor : `planta ${floor}`;
  return [`Hab. ${room.number}`, floorLabel, state].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// Tanda CHK · W4-B · check-in automatizado (diseño §8, filas «Recepción · /hoy»,
// «Cola de acciones» y «Ajustes»). Vocabulario del pre-check-in, la llave y el
// cajón de solo lectura (ArrivalPreCheckInDrawer). Las entradas de estado
// tienen la forma del diccionario común (`StatusEntry`) y se pintan con
// `CocoaStatusBadge`; el diccionario (content/status-dictionary.ts) no cambia
// porque no está en los ficheros del lote. Puro y testado en
// __tests__/frontdesk-checkin-columns.test.mts. Ningún literal de aquí
// transporta PII: son etiquetas de estados, canales, métodos y reglas.
// ---------------------------------------------------------------------------

import { UNKNOWN_STATUS, type StatusEntry } from "../../content/status-dictionary";

/** `FrontDeskPreCheckIn.status` (CheckInSession.status o `not_invited` sin sesión). */
export type PreCheckInStatusKey = "not_invited" | "invited" | "in_progress" | "ready_for_arrival" | "arrived" | "checked_in" | "handed_off" | "expired" | "cancelled";

export const PRECHECKIN_STATUS_KEYS: readonly PreCheckInStatusKey[] = ["not_invited", "invited", "in_progress", "ready_for_arrival", "arrived", "checked_in", "handed_off", "expired", "cancelled"];

/**
 * Columna «Pre-check-in» (diseño §8: invitado · en curso · listo · llegado ·
 * sin invitar; más los estados de cierre). Es el vocabulario de
 * `CheckInSession.status`, no el de la reserva: `checked_in` aquí significa
 * «el huésped completó su check-in en línea». Se construye desde entradas
 * (no como literal de objeto) porque tests/status-dictionary-contract.test.mjs
 * reserva los nombres del enum de reserva a content/status-dictionary.ts.
 */
const PRECHECKIN_STATUS_ENTRIES: ReadonlyArray<readonly [PreCheckInStatusKey, StatusEntry]> = [
  ["not_invited", { label: "Sin invitar", short: "Sin invitar", tone: "neutral", icon: "info-circle" }],
  ["invited", { label: "Invitado", short: "Invitado", tone: "info", icon: "clock" }],
  ["in_progress", { label: "En curso", short: "En curso", tone: "info", icon: "clock", emphasis: "tinted" }],
  ["ready_for_arrival", { label: "Listo", short: "Listo", tone: "success", icon: "check-circle" }],
  ["arrived", { label: "Llegado", short: "Llegado", tone: "success", icon: "arrow-in", emphasis: "tinted" }],
  ["checked_in", { label: "Check-in hecho", short: "Hecho", tone: "success", icon: "key" }],
  ["handed_off", { label: "En recepción", short: "Recepción", tone: "warning", icon: "exclamation-circle" }],
  ["expired", { label: "Caducado", short: "Caducado", tone: "neutral", icon: "x-circle" }],
  ["cancelled", { label: "Cancelado", short: "Cancelado", tone: "neutral", icon: "x-circle" }]
];

export const PRECHECKIN_STATUS: Readonly<Record<PreCheckInStatusKey, StatusEntry>> = Object.fromEntries(PRECHECKIN_STATUS_ENTRIES) as Record<PreCheckInStatusKey, StatusEntry>;

/** Estados que cuentan como «pre-check-in completado» (mismo criterio que `kpis.preCheckInCompleted` y `listArrivals`). */
export const PRECHECKIN_COMPLETED_KEYS: readonly PreCheckInStatusKey[] = ["ready_for_arrival", "arrived", "checked_in", "handed_off"];

export function isPreCheckInStatusKey(value: unknown): value is PreCheckInStatusKey {
  return typeof value === "string" && (PRECHECKIN_STATUS_KEYS as readonly string[]).includes(value);
}

/** Entrada de la columna; un estado desconocido o ausente lee «Desconocido», nunca el enum. */
export function preCheckInStatus(value: string | null | undefined): StatusEntry {
  return isPreCheckInStatusKey(value) ? PRECHECKIN_STATUS[value] : UNKNOWN_STATUS;
}

/** Columna «Llave» (`FrontDeskKeyStatus.status`): emitida · pendiente · recepción. */
export type KeyStatusKey = "issued" | "pending" | "reception";

export const KEY_STATUS: Record<KeyStatusKey, StatusEntry> = {
  issued: { label: "Emitida", short: "Emitida", tone: "success", icon: "key" },
  pending: { label: "Pendiente", short: "Pendiente", tone: "info", icon: "clock" },
  reception: { label: "Recepción", short: "Recepción", tone: "neutral", icon: "lock" }
};

export function keyStatus(value: string | null | undefined): StatusEntry {
  return value === "issued" || value === "pending" || value === "reception" ? KEY_STATUS[value] : UNKNOWN_STATUS;
}

/** `CheckInGuest.status` en el cajón. */
export const CHECKIN_GUEST_STATUS: Record<string, StatusEntry> = {
  pending: { label: "Pendiente", short: "Pendiente", tone: "neutral", icon: "clock" },
  document_captured: { label: "Documento leído", short: "Documento", tone: "info", icon: "eye" },
  data_complete: { label: "Datos completos", short: "Datos", tone: "info", icon: "check-circle", emphasis: "tinted" },
  signed: { label: "Firmado", short: "Firmado", tone: "success", icon: "check-circle" },
  verified: { label: "Verificado", short: "Verificado", tone: "success", icon: "check-circle", emphasis: "tinted" }
};

export function checkInGuestStatus(value: string | null | undefined): StatusEntry {
  return (value && CHECKIN_GUEST_STATUS[value]) || UNKNOWN_STATUS;
}

/** `CheckInSession.channel` en minúsculas para frases («invitado por correo»). */
export const CHECKIN_CHANNEL_LABELS: Readonly<Record<string, string>> = {
  email: "correo",
  whatsapp: "WhatsApp",
  sms: "SMS",
  kiosk: "kiosco",
  reception: "recepción",
  manual: "manual"
};

export function checkInChannelLabel(value: string | null | undefined): string {
  return (value && CHECKIN_CHANNEL_LABELS[value]) || "canal desconocido";
}

/** `DocumentCapture.source` («origen» del documento en el cajón). */
export const DOCUMENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  mrz_reader: "lector MRZ",
  mrz_ai: "MRZ leída por IA",
  ai_vision: "visión IA",
  manual: "manual"
};

export function documentSourceLabel(value: string | null | undefined): string {
  return (value && DOCUMENT_SOURCE_LABELS[value]) || "origen desconocido";
}

/** `Signature.method` («firmado en el portal el 19/09»). */
export const SIGNATURE_METHOD_LABELS: Readonly<Record<string, string>> = {
  touch_portal: "en el portal",
  touch_kiosk: "en el kiosco",
  touch_reception: "en recepción",
  paper_scanned: "en papel (escaneada)"
};

export function signatureMethodLabel(value: string | null | undefined): string {
  return (value && SIGNATURE_METHOD_LABELS[value]) || "método desconocido";
}

/** `CheckInSession.paymentStatus`. */
export const CHECKIN_PAYMENT_STATUS: Record<string, StatusEntry> = {
  none: { label: "Sin pago previo", short: "Sin pago", tone: "neutral", icon: "euro" },
  link_sent: { label: "Enlace enviado", short: "Enlace", tone: "info", icon: "euro" },
  paid: { label: "Pagado", short: "Pagado", tone: "success", icon: "euro" },
  authorized: { label: "Garantía autorizada", short: "Garantía", tone: "success", icon: "euro", emphasis: "tinted" },
  failed: { label: "Pago rechazado", short: "Rechazado", tone: "danger", icon: "euro" },
  at_reception: { label: "Se cobra en recepción", short: "Recepción", tone: "warning", icon: "euro" }
};

export function checkInPaymentStatus(value: string | null | undefined): StatusEntry {
  return (value && CHECKIN_PAYMENT_STATUS[value]) || UNKNOWN_STATUS;
}

/** `CheckInGuest.identityVerificationMethod` · `PropertyCheckInPolicy.allowedVerificationMethods`. */
export const IDENTITY_METHOD_LABELS: Readonly<Record<string, string>> = {
  visual_reception: "Cotejo visual en recepción",
  mrz_checksum: "Dígitos de control de la MRZ",
  otp_phone: "Código por SMS",
  otp_email: "Código por correo",
  payment_match: "Coincidencia con el medio de pago",
  midni_qr: "QR de MiDNI",
  reader_hardware: "Lector de documentos"
};

export function identityMethodLabel(value: string | null | undefined): string {
  return (value && IDENTITY_METHOD_LABELS[value]) || "sin verificar";
}

/** Vocabulario cerrado de preferencias (PREFERENCE_VOCABULARY de @hotelos/shared) en español. */
export const PREFERENCE_LABELS: Readonly<Record<string, string>> = {
  floor_high: "Planta alta",
  floor_low: "Planta baja",
  quiet: "Tranquila",
  near_elevator: "Cerca del ascensor",
  far_elevator: "Lejos del ascensor",
  view_sea: "Vistas al mar",
  view_city: "Vistas a la ciudad",
  bed_twin: "Camas separadas",
  bed_king: "Cama grande",
  accessible: "Accesible",
  connecting: "Comunicada",
  crib: "Cuna"
};

export function preferenceLabel(code: string): string {
  return PREFERENCE_LABELS[code] ?? code;
}

/** `CheckInSession.handoffKind` (motivo por el que pasó a recepción). */
export const HANDOFF_KIND_LABELS: Readonly<Record<string, string>> = {
  identity_review: "Revisión de identidad",
  identity_mismatch: "La identidad no coincide",
  minor_without_guardian: "Menor sin adulto",
  room_not_ready: "Habitación no lista",
  payment_failed: "Pago rechazado",
  group_arrival: "Llegada de grupo",
  walk_in: "Walk-in",
  expired_document: "Documento caducado"
};

export function handoffKindLabel(value: string | null | undefined): string {
  return (value && HANDOFF_KIND_LABELS[value]) || "Derivado a recepción";
}

/**
 * «3/4 controles» a partir de `DocumentCapture.checksJson` (MrzChecks: cada
 * dígito de control true/false/null = no aplicable). Sin controles aplicables
 * (visión o manual) → null.
 */
export function mrzChecksSummary(checks: unknown): { passed: number; total: number; label: string } | null {
  if (!checks || typeof checks !== "object") return null;
  const values = Object.values(checks as Record<string, unknown>).filter((value): value is boolean => typeof value === "boolean");
  if (values.length === 0) return null;
  const passed = values.filter(Boolean).length;
  return { passed, total: values.length, label: `${passed}/${values.length} controles` };
}
