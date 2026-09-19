// Diccionario de estados (Tanda UX-1 · lote U2 · UX-RECEPCION-FEEL §1.1 P6,
// §4 «Diccionario de estados con icono», §10 D5).
//
// Un solo sitio para la etiqueta, la forma corta, el tono y el icono de cada
// estado de reserva, de habitación y de «clase de barra» del Live Timeline.
// El enum crudo del API («checked_in», «dirty») nunca llega al operador: los
// helpers devuelven siempre una entrada en español y, si el valor no existe,
// la entrada «Desconocido». Sin React ni DOM (el motor del cronograma y los
// tests de node lo cargan tal cual): el icono es un nombre que resuelve
// `CocoaStatusBadge` contra `components/cocoa-icons`.
//
// Vocabulario D5 · reserva: «Confirmada · En el hotel · Salida hecha ·
// No-show · Cancelada · Borrador» («Llega hoy» y «Sale hoy» son clases de
// barra o pestaña, no estados); habitación: «Limpia · Inspeccionada · Sucia ·
// Ocupada · Bloqueada · Fuera de servicio».
//
// Tonos: los del motor del Live Timeline (timeline-engine.ts, ocho clases con
// leyenda) y del tablero (RoomRackScreen): Ocupada info, Llega hoy accent,
// En el hotel success, Sale hoy warning, Salida hecha neutral, Bloqueada y
// Fuera de servicio danger. Solo hay siete tonos: Sale hoy no puede ser accent
// porque en el cronograma se confundiría con Llega hoy (las barras vivas solo
// se distinguen por el tono; cocoa-22-timeline.css solo traza cancelada,
// borrador, salida y no-show).

import type { CocoaTone } from "../components/cocoa/cocoa-tones";
import { STATUS_LABELS } from "./actions";

// Copy genérico de estados de UI (Cargando…, Guardado, Desconocido…): se
// consume y reexporta, no se duplica (§4 «Copy de acciones y estados»).
export { STATUS_LABELS };

/** Nombres de icono que `CocoaStatusBadge` resuelve en `components/cocoa-icons/StatusIcons`. */
export type StatusIconName =
  | "key"
  | "broom"
  | "euro"
  | "arrow-in"
  | "arrow-out"
  | "user-slash"
  | "moon"
  | "check-circle"
  | "x-circle"
  | "exclamation-circle"
  | "info-circle"
  | "clock"
  | "lock"
  | "eye";

export const STATUS_ICON_NAMES: readonly StatusIconName[] = [
  "key",
  "broom",
  "euro",
  "arrow-in",
  "arrow-out",
  "user-slash",
  "moon",
  "check-circle",
  "x-circle",
  "exclamation-circle",
  "info-circle",
  "clock",
  "lock",
  "eye"
];

export type StatusEntry = {
  /** Etiqueta en español para tablas, fichas y cajones («En el hotel»). */
  label: string;
  /** Forma corta para tiles y chips estrechos («Hotel»). */
  short: string;
  tone: CocoaTone;
  icon: StatusIconName;
  /** Relleno del badge cuando el tono solo no basta (Inspeccionada frente a Limpia). */
  emphasis?: "tinted";
};

export type ReservationStatusKey = "draft" | "confirmed" | "checked_in" | "checked_out" | "no_show" | "cancelled";

export const RESERVATION_STATUS_KEYS: readonly ReservationStatusKey[] = ["draft", "confirmed", "checked_in", "checked_out", "no_show", "cancelled"];

export const RESERVATION_STATUS: Record<ReservationStatusKey, StatusEntry> = {
  draft: { label: STATUS_LABELS.draft, short: "Borr.", tone: "neutral", icon: "clock" },
  confirmed: { label: "Confirmada", short: "Conf.", tone: "info", icon: "check-circle" },
  checked_in: { label: "En el hotel", short: "Hotel", tone: "success", icon: "key" },
  checked_out: { label: "Salida hecha", short: "Salida", tone: "neutral", icon: "arrow-out" },
  no_show: { label: "No-show", short: "No-show", tone: "warning", icon: "user-slash" },
  cancelled: { label: "Cancelada", short: "Canc.", tone: "danger", icon: "x-circle" }
};

export type RoomStatusKey = "clean" | "inspected" | "dirty" | "occupied" | "blocked" | "out_of_order" | "ooo" | "out_of_service";

export const ROOM_STATUS_KEYS: readonly RoomStatusKey[] = ["clean", "inspected", "dirty", "occupied", "blocked", "out_of_order", "ooo", "out_of_service"];

const OUT_OF_SERVICE: StatusEntry = { label: "Fuera de servicio", short: "F. serv.", tone: "danger", icon: "x-circle" };

export const ROOM_STATUS: Record<RoomStatusKey, StatusEntry> = {
  clean: { label: "Limpia", short: "Limpia", tone: "success", icon: "check-circle" },
  inspected: { label: "Inspeccionada", short: "Insp.", tone: "success", icon: "eye", emphasis: "tinted" },
  dirty: { label: "Sucia", short: "Sucia", tone: "warning", icon: "broom" },
  occupied: { label: "Ocupada", short: "Ocupada", tone: "info", icon: "key" },
  blocked: { label: "Bloqueada", short: "Bloq.", tone: "danger", icon: "lock" },
  out_of_order: OUT_OF_SERVICE,
  ooo: OUT_OF_SERVICE,
  out_of_service: OUT_OF_SERVICE
};

/** Clases de barra del Live Timeline (orden de la leyenda). */
export type BarKindKey = "arrival_today" | "in_house" | "departure_today" | "confirmed" | "draft" | "checked_out" | "no_show" | "cancelled";

export const BAR_KIND_KEYS: readonly BarKindKey[] = ["arrival_today", "in_house", "departure_today", "confirmed", "draft", "checked_out", "no_show", "cancelled"];

export const BAR_KIND: Record<BarKindKey, StatusEntry> = {
  arrival_today: { label: "Llega hoy", short: "Llega", tone: "accent", icon: "arrow-in" },
  in_house: RESERVATION_STATUS.checked_in,
  departure_today: { label: "Sale hoy", short: "Sale", tone: "warning", icon: "arrow-out" },
  confirmed: RESERVATION_STATUS.confirmed,
  draft: RESERVATION_STATUS.draft,
  checked_out: RESERVATION_STATUS.checked_out,
  no_show: RESERVATION_STATUS.no_show,
  cancelled: RESERVATION_STATUS.cancelled
};

/** Origen / canal de una reserva (`bookingSource`, `sourceCode`, `channel`): etiqueta en español; un código desconocido se humaniza, nunca llega crudo (D5, L-14). */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  direct: "Directo",
  direct_web: "Web directa",
  web: "Web",
  phone: "Teléfono",
  email: "Correo",
  walk_in: "Walk-in",
  walkin: "Walk-in",
  ota: "OTA",
  booking: "Booking",
  expedia: "Expedia",
  agency: "Agencia",
  corporate: "Empresa",
  company: "Empresa",
  group: "Grupo",
  import: "Importación",
  opera: "OPERA",
  pms_shadow: "PMS sombra"
};

/** Etiqueta del origen: diccionario y, si no está, el código humanizado («late_night» → «Late night»). */
export function sourceLabel(value: string | null | undefined): string {
  const key = normalizeKey(value);
  if (!key) return STATUS_LABELS.unknown;
  if (Object.prototype.hasOwnProperty.call(SOURCE_LABELS, key)) return SOURCE_LABELS[key];
  const base = key.startsWith("import:") ? "import" : key;
  if (base !== key && Object.prototype.hasOwnProperty.call(SOURCE_LABELS, base)) return SOURCE_LABELS[base];
  const words = key.replace(/[_:-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Entrada para un valor que el diccionario no conoce: nunca el enum crudo. */
export const UNKNOWN_STATUS: StatusEntry = { label: STATUS_LABELS.unknown, short: STATUS_LABELS.unknown, tone: "neutral", icon: "info-circle" };

function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function lookup<K extends string>(dict: Record<K, StatusEntry>, value: unknown): StatusEntry {
  const key = normalizeKey(value);
  return key && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key as K] : UNKNOWN_STATUS;
}

/** Estado de reserva del API → entrada (mayúsculas, espacios y valores desconocidos tolerados). */
export function reservationStatus(value: string | null | undefined): StatusEntry {
  return lookup(RESERVATION_STATUS, value);
}

/** Estado de limpieza u ocupación de habitación del API → entrada. */
export function roomStatus(value: string | null | undefined): StatusEntry {
  return lookup(ROOM_STATUS, value);
}

/** Clase de barra del cronograma → entrada. */
export function barKindStatus(value: string | null | undefined): StatusEntry {
  return lookup(BAR_KIND, value);
}

export function isReservationStatusKey(value: unknown): value is ReservationStatusKey {
  return Object.prototype.hasOwnProperty.call(RESERVATION_STATUS, normalizeKey(value));
}

export function isRoomStatusKey(value: unknown): value is RoomStatusKey {
  return Object.prototype.hasOwnProperty.call(ROOM_STATUS, normalizeKey(value));
}

/** Proyección `clave → etiqueta` de un diccionario (mapas derivados del motor y de los CSV). */
export function statusLabels<K extends string>(dict: Record<K, StatusEntry>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(dict) as K[]) out[key] = dict[key].label;
  return out;
}

/** Proyección `clave → tono` de un diccionario. */
export function statusTones<K extends string>(dict: Record<K, StatusEntry>): Record<K, CocoaTone> {
  const out = {} as Record<K, CocoaTone>;
  for (const key of Object.keys(dict) as K[]) out[key] = dict[key].tone;
  return out;
}
