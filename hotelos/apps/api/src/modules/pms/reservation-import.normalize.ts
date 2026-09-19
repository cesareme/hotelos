// Importación masiva de reservas (Tanda 7 · L1) — normalización por fila, PURA.
//
// Convierte cada fila de la `ParsedTable` (parser) en una `NormalizedReservationRow`
// resuelta contra los CATÁLOGOS INYECTADOS de la propiedad (tipos de habitación,
// tarifas, habitaciones, moneda, fecha de negocio) sin tocar la base de datos:
//   · `normalizeRow` — fechas (12 formatos + celda de fecha Excel + serial con
//     aviso; calendario real), «salida o noches» y su coherencia, noches 1..365,
//     llegadas pasadas (`PAST_ARRIVAL` / histórico / `IN_HOUSE_PAST` según el
//     HOY de la propiedad —`catalogs.today`, la misma frontera que la guarda
//     `historical` de createReservation— y la opción `historico`), tipo de habitación (código →
//     nombre → contención / sinónimo con candidato único → desconocido con
//     sugerencias), tarifa (código → nombre → por defecto), habitación (número,
//     tipo, una sola unidad), pax y ocupación, régimen / canal / segmento /
//     estado / método de pago / vip / documento / nacionalidad (mapping.ts),
//     importes con `parseAmount` de nómina, moneda de la propiedad, longitudes
//     máximas con recorte y aviso, nombre completo partido (`splitName`);
//   · `normalizeTable` — todas las filas + duplicados DENTRO del fichero
//     (referencia repetida → omitida; habitación con noches solapadas → error;
//     mismo huésped + llegada + tipo → aviso) + veredicto por fila;
//   · `reservationImportContentHash` — sha256 del JSON canónico de las filas
//     normalizadas ordenadas: igual para CSV/XLSX, otro orden, espacios o BOM;
//     distinto al cambiar una celda. Solo depende del fichero (los importes
//     cotizados por el servicio no entran); `contentHashRowsOf` normaliza SIN
//     frontera temporal para que tampoco dependa de la opción «histórico» ni
//     del día de la importación;
//   · `stripRowValues` — red de seguridad GDPR: borra de un mensaje los valores
//     PERSONALES de la fila (`personalValuesOf`: nombre, apellidos, e-mail,
//     teléfono y documento como celda y como palabras ≥ 3 caracteres; peticiones
//     y notas solo como celda completa) como tokens completos, nunca un código
//     de catálogo, un trozo de palabra ni una palabra corriente de una nota.
//   · Tanda 7b · modo `sync` (OPERA en modo sombra, diseño §4.1, §5, §6.3):
//     `options.mode = "sync"` + `statusMap` del perfil: `estado` se resuelve con
//     `resolveSyncTargetStatus` → `normalized.targetStatus` (null → INVALID_STATUS;
//     `skip` = waitlist → omitida OPERA_WAITLIST_SKIPPED) y el `estado` canónico se
//     deriva (cancelled → «cancelada», resto → «confirmada»); la frontera temporal
//     sigue al destino: checked_out con salida ≤ hoy → histórica sin exigir
//     `historico`; checked_in / checked_out con llegada ≤ hoy → PERMITIDA
//     (`inHouse`, no IN_HOUSE_PAST: createReservation solo exige que una histórica
//     haya terminado); cancelled / no_show → sin frontera (se crean y transicionan);
//     confirmed con llegada pasada → PAST_ARRIVAL como siempre; una fila sin
//     `referencia_externa` → SYNC_REQUIRES_REFERENCE (sin clave de upsert).
//     `syncRowHash` es el hash de la fila SIN datos personales (fechas, tipo,
//     tarifa, habitación, pax, importe del fichero, segmento, canal, grupo,
//     empresa, agencia, estado destino) que `PmsShadowLink.rowHash` recuerda; el
//     hash de contenido del lote se SALA con (feed, businessDate) para que el mismo
//     snapshot en otro business date sea un lote nuevo y el mismo fichero el mismo
//     día siga siendo 409 (idempotencia por corte).
//
// Los mensajes citan columna («Llegada») y nº de fila, nunca valores del fichero.

import { createHash } from "node:crypto";
import { BRAND } from "../../lib/brand.js";
import {
  RESERVATION_IMPORT_AMOUNT_MAX,
  RESERVATION_IMPORT_FAR_FUTURE_DAYS,
  RESERVATION_IMPORT_FIELD_MAX_LENGTHS,
  RESERVATION_IMPORT_LABELS_ES,
  RESERVATION_IMPORT_LONG_STAY_NIGHTS,
  RESERVATION_IMPORT_MAX_NIGHTS,
  RESERVATION_IMPORT_PHONE_MAX_DIGITS,
  RESERVATION_IMPORT_PHONE_MIN_DIGITS,
  RESERVATION_IMPORT_ROW_CODE_SEVERITY,
  type IsoDate,
  type MoneyString,
  type NormalizedReservationRow,
  type PmsShadowReservationFeed,
  type PmsShadowStatusMap,
  type ReservationImportEstado,
  type ReservationImportField,
  type ReservationImportGuestFields,
  type ReservationImportIssue,
  type ReservationImportMapping,
  type ReservationImportMode,
  type ReservationImportRowCode,
  type ReservationImportRowResolved,
  type ReservationImportRowStatus,
  type ReservationImportTotalSource,
  type ReservationSyncTargetStatus
} from "@hotelos/shared";
import { excelFractionToTime, excelSerialToIso } from "../../lib/xlsx-lite.js";
import { foldLabel, parseAmount } from "../payroll/cost-import.parser.js";
import type { CellKind, ParsedRow, ParsedTable } from "./reservation-import.parser.js";
import {
  ROOM_TYPE_SYNONYMS,
  applyMapping,
  foldValue,
  normalizeBoard,
  normalizeChannel,
  normalizeDocumentType,
  normalizeEstado,
  normalizeNationality,
  normalizePaymentMethod,
  normalizeSegment,
  normalizeVip,
  resolveSyncTargetStatus
} from "./reservation-import.mapping.js";

// ---------------------------------------------------------------------------
// Catálogos inyectados y opciones
// ---------------------------------------------------------------------------

export type ImportRoomTypeCatalog = {
  id: string;
  code: string;
  name: string;
  maxOccupancy: number;
  active: boolean;
};

export type ImportRatePlanCatalog = {
  id: string;
  code: string;
  name: string;
  active: boolean;
};

export type ImportRoomCatalog = {
  id: string;
  number: string;
  roomTypeId: string;
};

export type ReservationImportCatalogs = {
  roomTypes: readonly ImportRoomTypeCatalog[];
  ratePlans: readonly ImportRatePlanCatalog[];
  rooms: readonly ImportRoomCatalog[];
  /** Plan BAR activo con menor código; null si la propiedad no tiene ninguno. */
  defaultRatePlanId: string | null;
  /** Moneda de la propiedad (EUR). */
  currency: string;
  /** Fecha de negocio de la propiedad (`business_dates`): informativa; puede ir por detrás del calendario si hay días sin cerrar. */
  businessDate: IsoDate;
  /** Hoy en la zona horaria de la propiedad: frontera de «llegada pasada», la misma que la guarda `historical` de createReservation (T7-FUN-01). */
  today: IsoDate;
  /** Zona horaria IANA de la propiedad (Tanda 7d: `Stay.checkinAt` de un check-in sombra = llegada 15:00 hora local). */
  timezone: string;
};

export type NormalizeRowOptions = {
  /** Llegadas anteriores a la fecha de negocio como estancia cerrada. */
  historico: boolean;
  /** La columna de `nombre` trae el nombre completo (`applyMapping`). */
  splitName: boolean;
  /** Tanda 7b: `sync` resuelve `estado` con `statusMap` y relaja la frontera temporal según el destino. Ausente = `create`. */
  mode?: ReservationImportMode;
  /** Diccionario literal OPERA plegado → estado destino (perfil); vacío en `sync` → todo estado es INVALID_STATUS. */
  statusMap?: PmsShadowStatusMap;
  /**
   * Tanda 7d (carga real OPERA): business date del corte. En `sync`, una fila con destino `confirmed`
   * cuya llegada cae en [cutBusinessDate, hoy) NO es «llegada pasada» (OPERA la tenía RESERVED en el corte;
   * el check-in lo registra recepción). Solo adelanta la frontera (cutBusinessDate < hoy); nunca la atrasa.
   */
  cutBusinessDate?: IsoDate;
};

/** Opciones de `normalizeTable` (las de fila menos `splitName`, que calcula `applyMapping`). */
export type NormalizeTableOptions = {
  historico: boolean;
  mode?: ReservationImportMode;
  statusMap?: PmsShadowStatusMap;
  cutBusinessDate?: IsoDate;
};

export type NormalizeRowResult = {
  normalized?: NormalizedReservationRow;
  resolved?: ReservationImportRowResolved;
  issues: ReservationImportIssue[];
};

export type NormalizedTableRow = ParsedRow & {
  status: ReservationImportRowStatus;
  issues: ReservationImportIssue[];
  normalized?: NormalizedReservationRow;
  resolved?: ReservationImportRowResolved;
};

export type NormalizeTableResult = {
  rows: NormalizedTableRow[];
  splitName: boolean;
  mappingByIndex: Array<ReservationImportField | null>;
};

// ---------------------------------------------------------------------------
// Utilidades de fechas, horas, números e importes (exportadas para los tests)
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, setiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12
});

function ymdToIso(year: number, month: number, day: number): IsoDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null; // 31/02 → inexistente
  return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" + n días. */
export function addDaysIso(iso: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Días entre dos fechas ISO (b − a). */
export function diffDaysIso(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export type ParsedImportDate = { iso: IsoDate; fromSerial: boolean };

/**
 * Fecha de una celda. Formatos: `YYYY-MM-DD` (hora opcional tras T o espacio),
 * `YYYY/MM/DD`, `YYYY.MM.DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY` (hora opcional),
 * `D/M/YY` · `D-M-YY` · `D.M.YY` (→ 20YY), `YYYYMMDD`, «12 de octubre de 2026» /
 * «12 oct 2026» / «Oct 12, 2026», celda de fecha Excel (`kind = date`) y serial
 * Excel 20000..80000 (`fromSerial = true`, aviso). Calendario real: 31/02 → null.
 */
export function parseImportDate(raw: string, kind: CellKind = "string"): ParsedImportDate | null {
  const text = raw.trim();
  if (text === "") return null;
  if (kind === "date") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (iso) {
      const value = ymdToIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
      return value ? { iso: value, fromSerial: false } : null;
    }
  }
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (match) {
    const value = ymdToIso(Number(match[1]), Number(match[2]), Number(match[3]));
    return value ? { iso: value, fromSerial: false } : null;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s].*)?$/.exec(text);
  if (match) {
    const value = ymdToIso(Number(match[3]), Number(match[2]), Number(match[1]));
    return value ? { iso: value, fromSerial: false } : null;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(text);
  if (match) {
    const value = ymdToIso(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
    return value ? { iso: value, fromSerial: false } : null;
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match && Number(match[1]) >= MIN_YEAR && Number(match[1]) <= MAX_YEAR) {
    const value = ymdToIso(Number(match[1]), Number(match[2]), Number(match[3]));
    return value ? { iso: value, fromSerial: false } : null;
  }
  match = /^(\d+)(?:\.0+)?$/.exec(text);
  if (match) {
    const serial = Number(match[1]);
    if (serial >= 20000 && serial <= 80000) {
      try {
        return { iso: excelSerialToIso(serial, false), fromSerial: true };
      } catch {
        return null;
      }
    }
    return null;
  }
  const folded = foldLabel(text).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  match = /^(\d{1,2})(?: de)? ([a-z]+)\.?(?: de|,)? (\d{4})$/.exec(folded);
  if (match) {
    const month = MONTHS[match[2]!];
    if (!month) return null;
    const value = ymdToIso(Number(match[3]), month, Number(match[1]));
    return value ? { iso: value, fromSerial: false } : null;
  }
  match = /^([a-z]+)\.? (\d{1,2}) (\d{4})$/.exec(folded);
  if (match) {
    const month = MONTHS[match[1]!];
    if (!month) return null;
    const value = ymdToIso(Number(match[3]), month, Number(match[2]));
    return value ? { iso: value, fromSerial: false } : null;
  }
  return null;
}

/** Hora estimada de llegada → "HH:MM": `H:MM`, `HH:MM[:SS]`, `HH.MM`, `HHhMM`, `HHh`, celda de hora Excel o fracción de día. */
export function parseImportTime(raw: string, kind: CellKind = "string"): string | null {
  const text = raw.trim();
  if (text === "") return null;
  if (kind === "time") return /^\d{2}:\d{2}$/.test(text) ? text : null;
  let match = /^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?\s*h?$/i.exec(text);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2] ?? "0");
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  match = /^0?\.\d+$/.exec(text);
  if (match) {
    try {
      return excelFractionToTime(Number(text));
    } catch {
      return null;
    }
  }
  return null;
}

/** Entero no negativo de una celda ("2", "2.0", "2,0"); null si no lo es. */
export function parseImportInteger(raw: string): number | null {
  const text = raw.trim();
  const match = /^(\d+)(?:[.,]0+)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** Importe → MoneyString (dos decimales) con `parseAmount` de nómina (0 ≤ x ≤ 999.999,99); null si no es válido. */
export function parseImportAmount(raw: string): MoneyString | null {
  try {
    return parseAmount(raw, "importe", RESERVATION_IMPORT_AMOUNT_MAX).toFixed(2);
  } catch {
    return null;
  }
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({ "€": "EUR", $: "USD", "£": "GBP", "¥": "JPY", "₣": "CHF" });

/** Moneda: «€» → EUR, código ISO en mayúsculas; vacío → null. */
export function parseImportCurrency(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  const symbol = CURRENCY_SYMBOLS[text];
  if (symbol) return symbol;
  const folded = foldLabel(text);
  if (folded === "euro" || folded === "euros" || folded === "eur") return "EUR";
  return text.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E-mail válido en minúsculas; null si el formato no vale. */
export function parseImportEmail(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (text === "" || text.length > 254 || !EMAIL_RE.test(text)) return null;
  return text;
}

/** Teléfono: dígitos, «+» inicial y separadores; 7..20 dígitos → «+34600111001»; null si no vale. */
export function parseImportPhone(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^[+()\d\s.\-/]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < RESERVATION_IMPORT_PHONE_MIN_DIGITS || digits.length > RESERVATION_IMPORT_PHONE_MAX_DIGITS) return null;
  return `${text.startsWith("+") ? "+" : ""}${digits}`;
}

/** «Apellidos, Nombre» o «Nombre Apellidos» → { firstName, surnames }. */
export function splitFullName(raw: string): { firstName: string; surnames: string } {
  const text = raw.trim().replace(/\s+/g, " ");
  const comma = text.indexOf(",");
  if (comma >= 0) {
    return { firstName: text.slice(comma + 1).trim(), surnames: text.slice(0, comma).trim() };
  }
  const tokens = text.split(" ");
  return { firstName: tokens[0] ?? "", surnames: tokens.slice(1).join(" ") };
}

// ---------------------------------------------------------------------------
// GDPR: mensajes sin valores
// ---------------------------------------------------------------------------

const STRIP_MIN_LENGTH = 3;
const STRIP_TOKEN = "[valor omitido]";

/**
 * Campos con datos personales del huésped: los ÚNICOS cuyos valores se buscan en
 * los mensajes (T7-FUN-02). Los códigos de catálogo (tipo, tarifa, estado,
 * régimen, canal, documento_tipo…) los citan legítimamente los propios mensajes
 * («Estado» tentativa, tipo DBL…) y nunca son personales.
 */
export const PERSONAL_FIELDS: ReadonlySet<ReservationImportField> = new Set<ReservationImportField>(["nombre", "apellidos", "email", "telefono", "documento_numero", "peticiones", "notas"]);

/**
 * Texto libre del huésped: se protege solo como celda completa. Sus palabras
 * sueltas («Confirmar antes del 20/10» → «confirmar», «del») no identifican a
 * nadie y, como token, mutilaban los mensajes de la propia fila («se crea
 * confirmada con la nota interna «[valor omitido] con el cliente»»; integración
 * de la Tanda 7). Un nombre o documento escrito dentro de una nota sigue
 * cubierto por las palabras de los campos de identidad.
 */
export const FREE_TEXT_FIELDS: ReadonlySet<ReservationImportField> = new Set<ReservationImportField>(["peticiones", "notas"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Valores personales de una fila (celdas mapeadas a `PERSONAL_FIELDS`, ≥ 3
 * caracteres): la celda completa y, en los campos de identidad, cada una de sus
 * palabras («Lucía Ferreiro» → «Lucía Ferreiro», «Lucía», «Ferreiro»), las más
 * largas primero; `peticiones` y `notas` (`FREE_TEXT_FIELDS`) solo la celda
 * completa. Es lo que `stripRowValues` borra de un mensaje de terceros.
 */
export function personalValuesOf(cells: readonly string[], mappingByIndex: ReadonlyArray<ReservationImportField | null>): string[] {
  const out = new Set<string>();
  mappingByIndex.forEach((field, index) => {
    if (!field || !PERSONAL_FIELDS.has(field)) return;
    const value = (cells[index] ?? "").trim();
    if (value.length < STRIP_MIN_LENGTH) return;
    out.add(value);
    if (FREE_TEXT_FIELDS.has(field)) return;
    for (const token of value.split(/\s+/).map(trimToken)) if (token.length >= STRIP_MIN_LENGTH) out.add(token);
  });
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Borra de `message` cualquiera de `values` (recortado, ≥ 3 caracteres, sin
 * distinguir mayúsculas) que aparezca como TOKEN COMPLETO (no dentro de otra
 * palabra: «Ana» no toca «Analizando», «Mar» no toca «marcaría»): red de
 * seguridad para mensajes de terceros (servicio, Prisma). Los mensajes propios
 * de este módulo no incluyen valores personales, así que normalmente no cambia
 * nada. Quien llama pasa los valores personales de la fila (`personalValuesOf`),
 * nunca todas las celdas.
 */
export function stripRowValues(message: string, values: readonly string[]): string {
  let out = message;
  for (const raw of values) {
    const value = raw.trim();
    if (value.length < STRIP_MIN_LENGTH) continue;
    if (!out.toLowerCase().includes(value.toLowerCase())) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "giu"), STRIP_TOKEN);
  }
  return out;
}

/** `stripRowValues` sobre todas las incidencias de una fila. */
export function stripIssueValues(issues: readonly ReservationImportIssue[], values: readonly string[]): ReservationImportIssue[] {
  return issues.map((issue) => {
    const message = stripRowValues(issue.message, values);
    return message === issue.message ? issue : { ...issue, message };
  });
}

// ---------------------------------------------------------------------------
// Resolución de catálogos
// ---------------------------------------------------------------------------

export type RoomTypeResolution =
  | { kind: "exact" | "fuzzy"; roomType: ImportRoomTypeCatalog }
  | { kind: "unknown"; suggestions: string[] };

/**
 * Tipo por código plegado → nombre plegado → contención de nombre (≥ 3 caracteres)
 * o grupo de `ROOM_TYPE_SYNONYMS` con candidato ÚNICO (`fuzzy`) → desconocido con
 * sugerencias (códigos del catálogo, hasta 5).
 */
export function resolveRoomType(raw: string, roomTypes: readonly ImportRoomTypeCatalog[]): RoomTypeResolution {
  const folded = foldValue(raw);
  const suggestions = roomTypes.filter((type) => type.active).slice(0, 5).map((type) => type.code);
  if (folded === "") return { kind: "unknown", suggestions };
  const byCode = roomTypes.find((type) => foldValue(type.code) === folded);
  if (byCode) return { kind: "exact", roomType: byCode };
  const byName = roomTypes.find((type) => foldValue(type.name) === folded);
  if (byName) return { kind: "exact", roomType: byName };
  if (folded.length >= 3) {
    const contained = roomTypes.filter((type) => {
      const name = foldValue(type.name);
      return name.includes(folded) || folded.includes(name);
    });
    if (contained.length === 1) return { kind: "fuzzy", roomType: contained[0]! };
    if (contained.length > 1) return { kind: "unknown", suggestions: contained.slice(0, 5).map((type) => type.code) };
  }
  const tokens = new Set(folded.split("_"));
  const groups = ROOM_TYPE_SYNONYMS.map((group) => group.map((term) => foldValue(term))).filter((group) => group.some((term) => tokens.has(term)));
  if (groups.length > 0) {
    const candidates = roomTypes.filter((type) => {
      const nameTokens = new Set(`${foldValue(type.name)}_${foldValue(type.code)}`.split("_"));
      return groups.every((group) => group.some((term) => nameTokens.has(term)));
    });
    if (candidates.length === 1) return { kind: "fuzzy", roomType: candidates[0]! };
    if (candidates.length > 1) return { kind: "unknown", suggestions: candidates.slice(0, 5).map((type) => type.code) };
  }
  return { kind: "unknown", suggestions };
}

/** Tarifa por código plegado → nombre plegado; null si no existe. */
export function resolveRatePlan(raw: string, ratePlans: readonly ImportRatePlanCatalog[]): ImportRatePlanCatalog | null {
  const folded = foldValue(raw);
  if (folded === "") return null;
  return ratePlans.find((plan) => foldValue(plan.code) === folded) ?? ratePlans.find((plan) => foldValue(plan.name) === folded) ?? null;
}

/** Habitación por número (plegado, sin ceros a la izquierda); null si no existe. */
export function resolveRoom(raw: string, rooms: readonly ImportRoomCatalog[]): ImportRoomCatalog | null {
  const folded = foldValue(raw);
  if (folded === "") return null;
  const exact = rooms.find((room) => foldValue(room.number) === folded);
  if (exact) return exact;
  const stripped = folded.replace(/^0+(?=\d)/, "");
  return rooms.find((room) => foldValue(room.number).replace(/^0+(?=\d)/, "") === stripped) ?? null;
}

// ---------------------------------------------------------------------------
// normalizeRow
// ---------------------------------------------------------------------------

type IssueList = ReservationImportIssue[];

function label(field: ReservationImportField): string {
  return `«${RESERVATION_IMPORT_LABELS_ES[field]}»`;
}

function pushIssue(issues: IssueList, rowNumber: number, code: ReservationImportRowCode, text: string, column?: ReservationImportField, details?: Record<string, unknown>): void {
  const issue: ReservationImportIssue = { code, message: `Fila ${rowNumber}: ${text}` };
  if (column) issue.column = column;
  if (details) issue.details = details;
  issues.push(issue);
}

/** Veredicto por incidencias: `error` > `skipped` > `warning` > `valid`. */
export function rowStatusFromIssues(issues: readonly ReservationImportIssue[]): ReservationImportRowStatus {
  let status: ReservationImportRowStatus = "valid";
  for (const issue of issues) {
    const severity = RESERVATION_IMPORT_ROW_CODE_SEVERITY[issue.code];
    if (severity === "error") return "error";
    if (severity === "skipped") status = "skipped";
    else if (status === "valid") status = "warning";
  }
  return status;
}

/** Resumen sin datos personales de una fila normalizada. */
export function resolvedOf(row: NormalizedReservationRow): ReservationImportRowResolved {
  return {
    externalReference: row.externalReference ?? null,
    arrivalDate: row.arrivalDate,
    departureDate: row.departureDate,
    nights: row.nights,
    roomTypeCode: row.roomTypeCode,
    ratePlanCode: row.ratePlanCode ?? null,
    roomNumber: row.roomNumber ?? null,
    roomsCount: row.roomsCount,
    estado: row.estado,
    historical: row.historical,
    totalAmount: row.totalAmount,
    totalSource: row.totalSource
  };
}

/**
 * Normaliza UNA fila contra los catálogos. `mappingByIndex[i]` es el campo de la
 * columna i (o null). Devuelve `normalized` solo si no hay ningún error; las
 * incidencias (errores, omisiones y avisos) van siempre en `issues`.
 */
export function normalizeRow(
  row: Pick<ParsedRow, "rowNumber" | "cells" | "kinds">,
  mappingByIndex: ReadonlyArray<ReservationImportField | null>,
  catalogs: ReservationImportCatalogs,
  options: NormalizeRowOptions
): NormalizeRowResult {
  const issues: IssueList = [];
  const n = row.rowNumber;
  const values = new Map<ReservationImportField, { raw: string; kind: CellKind }>();
  mappingByIndex.forEach((field, index) => {
    if (field === null || field === undefined || values.has(field)) return;
    values.set(field, { raw: (row.cells[index] ?? "").trim(), kind: row.kinds[index] ?? "string" });
  });
  const mapped = (field: ReservationImportField): boolean => values.has(field);
  const get = (field: ReservationImportField): string => values.get(field)?.raw ?? "";
  const kindOf = (field: ReservationImportField): CellKind => values.get(field)?.kind ?? "string";
  const err = (code: ReservationImportRowCode, text: string, column?: ReservationImportField, details?: Record<string, unknown>): void =>
    pushIssue(issues, n, code, text, column, details);

  /** Texto libre con longitud máxima del campo (recorte + aviso). */
  const text = (field: ReservationImportField): string | undefined => {
    const raw = get(field);
    if (raw === "") return undefined;
    const max = RESERVATION_IMPORT_FIELD_MAX_LENGTHS[field];
    if (max !== undefined && raw.length > max) {
      err("RESERVATION_IMPORT_ROW_CELL_TRUNCATED", `${label(field)} supera ${max} caracteres y se ha recortado.`, field, { max });
      return raw.slice(0, max);
    }
    return raw;
  };

  // ---- Fechas ----
  let arrivalDate: IsoDate | null = null;
  let departureDate: IsoDate | null = null;
  let nights: number | null = null;
  const arrivalRaw = get("llegada");
  if (arrivalRaw === "") {
    err("RESERVATION_IMPORT_ROW_MISSING_FIELD", `falta ${label("llegada")}.`, "llegada");
  } else {
    const parsed = parseImportDate(arrivalRaw, kindOf("llegada"));
    if (!parsed) err("RESERVATION_IMPORT_ROW_INVALID_DATE", `${label("llegada")} no es una fecha válida (usa AAAA-MM-DD).`, "llegada");
    else {
      arrivalDate = parsed.iso;
      if (parsed.fromSerial) err("RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL", `${label("llegada")} se ha leído de un serial numérico de Excel: comprueba la fecha.`, "llegada");
    }
  }
  const departureRaw = get("salida");
  if (departureRaw !== "") {
    const parsed = parseImportDate(departureRaw, kindOf("salida"));
    if (!parsed) err("RESERVATION_IMPORT_ROW_INVALID_DATE", `${label("salida")} no es una fecha válida (usa AAAA-MM-DD).`, "salida");
    else {
      departureDate = parsed.iso;
      if (parsed.fromSerial) err("RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL", `${label("salida")} se ha leído de un serial numérico de Excel: comprueba la fecha.`, "salida");
    }
  }
  const nightsRaw = get("noches");
  let nightsGiven: number | null = null;
  if (nightsRaw !== "") {
    nightsGiven = parseImportInteger(nightsRaw);
    if (nightsGiven === null) err("RESERVATION_IMPORT_ROW_INVALID_NUMBER", `${label("noches")} no es un número entero.`, "noches");
    else if (nightsGiven < 1 || nightsGiven > RESERVATION_IMPORT_MAX_NIGHTS) {
      err("RESERVATION_IMPORT_ROW_INVALID_NIGHTS", `${label("noches")} debe estar entre 1 y ${RESERVATION_IMPORT_MAX_NIGHTS}.`, "noches");
      nightsGiven = null;
    }
  }
  if (departureRaw === "" && nightsRaw === "") {
    err("RESERVATION_IMPORT_ROW_MISSING_FIELD", `falta ${label("salida")} o ${label("noches")}.`, "salida");
  }
  if (arrivalDate && departureDate) {
    const diff = diffDaysIso(arrivalDate, departureDate);
    if (diff <= 0) err("RESERVATION_IMPORT_ROW_DATE_ORDER", `${label("salida")} debe ser posterior a ${label("llegada")}.`, "salida");
    else {
      nights = diff;
      if (nightsGiven !== null && nightsGiven !== diff) {
        err("RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH", `${label("noches")} no coincide con la diferencia entre ${label("llegada")} y ${label("salida")}.`, "noches", {
          nightsFromDates: diff
        });
      }
    }
  } else if (arrivalDate && !departureDate && nightsGiven !== null && departureRaw === "") {
    nights = nightsGiven;
    departureDate = addDaysIso(arrivalDate, nightsGiven);
  }
  if (nights !== null && nights > RESERVATION_IMPORT_MAX_NIGHTS) {
    err("RESERVATION_IMPORT_ROW_INVALID_NIGHTS", `la estancia supera ${RESERVATION_IMPORT_MAX_NIGHTS} noches.`, "salida");
  } else if (nights !== null && nights > RESERVATION_IMPORT_LONG_STAY_NIGHTS) {
    err("RESERVATION_IMPORT_ROW_LONG_STAY", `la estancia supera ${RESERVATION_IMPORT_LONG_STAY_NIGHTS} noches: comprueba las fechas.`, "salida");
  }

  // ---- Tanda 7b · estado destino (modo `sync`) ----
  // Se resuelve ANTES de la frontera temporal porque el destino la decide: una
  // «Checked In» con llegada ayer es una estancia en curso legítima, no un error.
  const sync = options.mode === "sync";
  let targetStatus: ReservationSyncTargetStatus | undefined;
  if (sync) {
    const target = resolveSyncTargetStatus(get("estado"), options.statusMap ?? {});
    if (target === null) err("RESERVATION_IMPORT_ROW_INVALID_STATUS", `${label("estado")} no está en el diccionario de estados del perfil (Reserved, Checked In, Checked Out, Cancelled, No Show, Waitlist…).`, "estado");
    else {
      targetStatus = target;
      if (target === "skip") err("RESERVATION_IMPORT_ROW_OPERA_WAITLIST_SKIPPED", `${label("estado")} es lista de espera (waitlist): sin equivalente en ${BRAND.name}, se omite la fila.`, "estado");
    }
    if (get("referencia_externa") === "") {
      err("RESERVATION_IMPORT_ROW_SYNC_REQUIRES_REFERENCE", `falta ${label("referencia_externa")} (nº de confirmación del PMS): sin ella la fila no se puede sincronizar.`, "referencia_externa");
    }
  }

  // ---- Llegadas pasadas e histórico ----
  // Frontera: el HOY de la propiedad (`catalogs.today`, su zona horaria), la
  // misma que la guarda `historical` de createReservation. La fecha de negocio
  // NO sirve: si hay días sin cerrar va por detrás del calendario y dejaría
  // crear confirmadas llegadas ya pasadas (que la auditoría nocturna marcaría
  // no-show) y rechazaría como «en curso» estancias ya terminadas (T7-FUN-01).
  // Tanda 7b · `sync`: el destino manda. checked_out con salida ≤ hoy → histórica
  // sin exigir `historico`; checked_in / checked_out con llegada ≤ hoy → estancia
  // en curso PERMITIDA (`inHouse`: createReservation no rechaza llegadas pasadas
  // no históricas, y el commit hace el check-in con `allowEarlyCheckIn`);
  // cancelled / no_show → sin frontera (no consumen inventario: se crean y se
  // transicionan en el mismo lote); confirmed → la regla de siempre.
  let historical = false;
  let inHouse = false;
  const relaxedFrontier = sync && targetStatus !== undefined && targetStatus !== "confirmed" && targetStatus !== "skip";
  if (arrivalDate && departureDate && nights !== null && relaxedFrontier) {
    if (targetStatus === "checked_out" && departureDate <= catalogs.today) {
      historical = true;
      err("RESERVATION_IMPORT_ROW_HISTORICAL", "se creará como estancia cerrada (check-out hecho, folio cerrado, sin cargos).", "llegada");
    } else if ((targetStatus === "checked_in" || targetStatus === "checked_out") && arrivalDate <= catalogs.today) {
      inHouse = true;
    } else if (diffDaysIso(catalogs.today, arrivalDate) > RESERVATION_IMPORT_FAR_FUTURE_DAYS) {
      err("RESERVATION_IMPORT_ROW_FAR_FUTURE", `${label("llegada")} está a más de ${RESERVATION_IMPORT_FAR_FUTURE_DAYS} días de hoy: comprueba el año.`, "llegada");
    }
  } else if (arrivalDate && departureDate && nights !== null) {
    // Tanda 7d: en `sync` (destino confirmed) la frontera es min(business date del corte, hoy): las llegadas del
    // día del corte que OPERA aún tenía RESERVED se admiten confirmadas; en `create` la frontera sigue siendo hoy.
    const frontier = options.mode === "sync" && options.cutBusinessDate && options.cutBusinessDate < catalogs.today ? options.cutBusinessDate : catalogs.today;
    if (arrivalDate < frontier) {
      if (!options.historico) {
        err("RESERVATION_IMPORT_ROW_PAST_ARRIVAL", `${label("llegada")} es anterior a ${frontier === catalogs.today ? "hoy" : "la fecha del corte"} (${frontier}): la auditoría nocturna la marcaría no-show con cargo. Activa «histórico» para cargarla como estancia cerrada.`, "llegada", {
          today: catalogs.today,
          frontier
        });
      } else if (departureDate <= catalogs.today) {
        historical = true;
        err("RESERVATION_IMPORT_ROW_HISTORICAL", "se creará como estancia cerrada (check-out hecho, folio cerrado, sin cargos).", "llegada");
      } else {
        err("RESERVATION_IMPORT_ROW_IN_HOUSE_PAST", `la estancia está en curso (llegada pasada y salida posterior a hoy): créala por recepción y haz el check-in.`, "llegada", {
          today: catalogs.today
        });
      }
    } else if (diffDaysIso(catalogs.today, arrivalDate) > RESERVATION_IMPORT_FAR_FUTURE_DAYS) {
      err("RESERVATION_IMPORT_ROW_FAR_FUTURE", `${label("llegada")} está a más de ${RESERVATION_IMPORT_FAR_FUTURE_DAYS} días de hoy: comprueba el año.`, "llegada");
    }
  }

  // ---- Tipo de habitación ----
  let roomType: ImportRoomTypeCatalog | null = null;
  const roomTypeRaw = get("tipo_habitacion");
  if (roomTypeRaw === "") {
    err("RESERVATION_IMPORT_ROW_MISSING_FIELD", `falta ${label("tipo_habitacion")}.`, "tipo_habitacion");
  } else {
    const resolution = resolveRoomType(roomTypeRaw, catalogs.roomTypes);
    if (resolution.kind === "unknown") {
      // SC-03: en `sync` el código OPERA (no es un dato personal) viaja en `details.roomTypeCode` para la alerta OPERA_ROOM_TYPE_UNMAPPED.
      err("RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN", `${label("tipo_habitacion")} no coincide con ningún tipo de la propiedad (por código ni por nombre).`, "tipo_habitacion", {
        suggestions: resolution.suggestions,
        ...(sync ? { roomTypeCode: roomTypeRaw.slice(0, 40) } : {})
      });
    } else {
      roomType = resolution.roomType;
      if (resolution.kind === "fuzzy") {
        err("RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY", `${label("tipo_habitacion")} se ha resuelto por aproximación al tipo ${roomType.code}: compruébalo.`, "tipo_habitacion", {
          roomTypeCode: roomType.code
        });
      }
      if (!roomType.active) {
        err("RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE", `el tipo ${roomType.code} está desactivado.`, "tipo_habitacion", { roomTypeCode: roomType.code });
      }
    }
  }

  // ---- Tarifa ----
  let ratePlan: ImportRatePlanCatalog | null = null;
  const rateRaw = get("tarifa");
  if (rateRaw === "") {
    ratePlan = catalogs.defaultRatePlanId ? (catalogs.ratePlans.find((plan) => plan.id === catalogs.defaultRatePlanId) ?? null) : null;
    if (mapped("tarifa") && ratePlan) {
      err("RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED", `${label("tarifa")} vacía: se aplica la tarifa por defecto ${ratePlan.code}.`, "tarifa", { ratePlanCode: ratePlan.code });
    }
  } else {
    ratePlan = resolveRatePlan(rateRaw, catalogs.ratePlans);
    const fallback = !ratePlan && sync && catalogs.defaultRatePlanId ? (catalogs.ratePlans.find((plan) => plan.id === catalogs.defaultRatePlanId) ?? null) : null;
    if (!ratePlan && fallback) {
      // SC-03 (diseño §4.2, runbook §3): rate code de OPERA sin entrada en `rateCodes` ni en `RatePlan.code` → tarifa por
      // defecto (BAR) + aviso; el corte no se queda sin la reserva y el panel recibe OPERA_RATE_CODE_UNMAPPED con el código.
      ratePlan = fallback;
      err("RESERVATION_IMPORT_ROW_OPERA_RATE_CODE_UNMAPPED", `${label("tarifa")} «${rateRaw.slice(0, 40)}» no está mapeada en el perfil OPERA: se aplica la tarifa por defecto ${fallback.code}.`, "tarifa", { rateCode: rateRaw.slice(0, 40), ratePlanCode: fallback.code });
    } else if (!ratePlan) err("RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN", `${label("tarifa")} no coincide con ninguna tarifa de la propiedad (usa el código o déjala vacía).`, "tarifa");
    else if (!ratePlan.active) err("RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE", `la tarifa ${ratePlan.code} está desactivada.`, "tarifa", { ratePlanCode: ratePlan.code });
  }

  // ---- Unidades, pax y ocupación ----
  const integerField = (field: ReservationImportField, fallback: number): number => {
    const raw = get(field);
    if (raw === "") return fallback;
    const value = parseImportInteger(raw);
    if (value === null) {
      err("RESERVATION_IMPORT_ROW_INVALID_NUMBER", `${label(field)} no es un número entero.`, field);
      return fallback;
    }
    return value;
  };
  let roomsCount = integerField("habitaciones", 1);
  if (roomsCount < 1) {
    err("RESERVATION_IMPORT_ROW_INVALID_NUMBER", `${label("habitaciones")} debe ser 1 o más.`, "habitaciones");
    roomsCount = 1;
  }
  const adults = integerField("adultos", 1);
  const children = integerField("ninos", 0);
  const infants = integerField("bebes", 0);
  if (adults < 1) err("RESERVATION_IMPORT_ROW_ADULTS_REQUIRED", `${label("adultos")} debe ser al menos 1.`, "adultos");
  if (roomType && adults + children > roomType.maxOccupancy * roomsCount) {
    err("RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED", `adultos + niños supera la ocupación máxima del tipo ${roomType.code} (${roomType.maxOccupancy} × ${roomsCount}).`, "adultos", {
      maxOccupancy: roomType.maxOccupancy,
      roomsCount
    });
  }

  // ---- Habitación ----
  let room: ImportRoomCatalog | null = null;
  const roomRaw = get("habitacion");
  if (roomRaw !== "") {
    room = resolveRoom(roomRaw, catalogs.rooms);
    if (!room) err("RESERVATION_IMPORT_ROW_ROOM_UNKNOWN", `${label("habitacion")} no existe en la propiedad.`, "habitacion");
    else {
      if (roomType && room.roomTypeId !== roomType.id) {
        err("RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH", `la habitación indicada no es del tipo ${roomType.code}.`, "habitacion", { roomTypeCode: roomType.code });
      }
      if (roomsCount > 1) {
        err("RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS", `${label("habitacion")} fija solo admite ${label("habitaciones")} = 1 (una fila por habitación).`, "habitacion");
      }
    }
  }

  // ---- Catálogos de texto ----
  let boardType: NormalizedReservationRow["boardType"];
  const boardRaw = get("regimen");
  if (boardRaw !== "") {
    const board = normalizeBoard(boardRaw);
    if (board) boardType = board;
    else err("RESERVATION_IMPORT_ROW_BOARD_UNKNOWN", `${label("regimen")} no reconocido: se descarta (usa RO, BB, HB, FB o AI).`, "regimen");
  }
  const channelResult = normalizeChannel(get("canal"));
  if (!channelResult.known) err("RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN", `${label("canal")} no reconocido: se guarda tal cual.`, "canal");
  const sourceCode = get("canal") === "" ? undefined : get("canal").slice(0, 80);
  const segmentResult = normalizeSegment(get("segmento"));
  if (!segmentResult.known) err("RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN", `${label("segmento")} no reconocido: se guarda tal cual.`, "segmento");
  let estado: ReservationImportEstado = "confirmada";
  if (sync) {
    // Estado canónico derivado del destino (el INVALID_STATUS ya se emitió arriba).
    estado = targetStatus === "cancelled" ? "cancelada" : "confirmada";
  } else {
    const estadoParsed = normalizeEstado(get("estado"));
    if (estadoParsed === null) err("RESERVATION_IMPORT_ROW_INVALID_STATUS", `${label("estado")} no admitido (confirmada, tentativa o cancelada).`, "estado");
    else estado = estadoParsed;
  }
  if (historical && estado !== "confirmada") {
    err("RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL", `${label("estado")} se ignora en una fila histórica (se crea como estancia cerrada).`, "estado");
    estado = "confirmada";
  }
  const paymentResult = normalizePaymentMethod(get("metodo_pago"));
  if (!paymentResult.known) err("RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN", `${label("metodo_pago")} no reconocido: se guarda tal cual.`, "metodo_pago");
  const vipResult = normalizeVip(get("vip"));
  if (!vipResult.known) err("RESERVATION_IMPORT_ROW_VIP_UNKNOWN", `${label("vip")} no reconocido: se toma como «no».`, "vip");

  // ---- Huésped ----
  let firstName = "";
  let surnames = "";
  const nameRaw = get("nombre");
  const surnameRaw = get("apellidos");
  if (nameRaw === "") {
    err("RESERVATION_IMPORT_ROW_MISSING_FIELD", `falta ${label("nombre")}.`, "nombre");
  } else if (options.splitName && surnameRaw === "") {
    const split = splitFullName(nameRaw);
    firstName = split.firstName;
    surnames = split.surnames;
    if (surnames === "") err("RESERVATION_IMPORT_ROW_MISSING_FIELD", `${label("nombre")} solo trae una palabra: faltan los apellidos.`, "apellidos");
    else err("RESERVATION_IMPORT_ROW_NAME_SPLIT", `${label("nombre")} se ha repartido en nombre y apellidos: revisa el reparto.`, "nombre");
  } else {
    firstName = nameRaw;
    surnames = surnameRaw;
    if (surnames === "") err("RESERVATION_IMPORT_ROW_MISSING_FIELD", `falta ${label("apellidos")}.`, "apellidos");
  }
  const maxName = RESERVATION_IMPORT_FIELD_MAX_LENGTHS.nombre ?? 120;
  const maxSurname = RESERVATION_IMPORT_FIELD_MAX_LENGTHS.apellidos ?? 120;
  if (firstName.length > maxName) {
    err("RESERVATION_IMPORT_ROW_CELL_TRUNCATED", `${label("nombre")} supera ${maxName} caracteres y se ha recortado.`, "nombre", { max: maxName });
    firstName = firstName.slice(0, maxName);
  }
  if (surnames.length > maxSurname) {
    err("RESERVATION_IMPORT_ROW_CELL_TRUNCATED", `${label("apellidos")} supera ${maxSurname} caracteres y se ha recortado.`, "apellidos", { max: maxSurname });
    surnames = surnames.slice(0, maxSurname);
  }
  const surnameTokens = surnames.replace(/\s+/g, " ").trim().split(" ").filter((token) => token !== "");
  const surname1 = surnameTokens[0] ?? "";
  const surname2 = surnameTokens.length > 1 ? surnameTokens.slice(1).join(" ") : undefined;

  const guest: ReservationImportGuestFields = { firstName: firstName.trim(), surname1 };
  if (surname2) guest.surname2 = surname2;
  const emailRaw = get("email");
  if (emailRaw !== "") {
    const email = parseImportEmail(emailRaw);
    if (email) guest.email = email;
    else err("RESERVATION_IMPORT_ROW_EMAIL_DROPPED", `${label("email")} no tiene un formato válido: se descarta (complétalo en la ficha del huésped).`, "email");
  }
  const phoneRaw = get("telefono");
  if (phoneRaw !== "") {
    const phone = parseImportPhone(phoneRaw);
    if (phone) guest.phone = phone;
    else err("RESERVATION_IMPORT_ROW_PHONE_DROPPED", `${label("telefono")} no tiene entre ${RESERVATION_IMPORT_PHONE_MIN_DIGITS} y ${RESERVATION_IMPORT_PHONE_MAX_DIGITS} dígitos: se descarta.`, "telefono");
  }
  const nationalityRaw = get("nacionalidad");
  if (nationalityRaw !== "") {
    const nationality = normalizeNationality(nationalityRaw);
    if (nationality) guest.nationality = nationality;
    else err("RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED", `${label("nacionalidad")} no reconocida: se descarta (usa el código ISO alfa-3).`, "nacionalidad");
  }
  const documentTypeRaw = get("documento_tipo");
  if (documentTypeRaw !== "") {
    const documentType = normalizeDocumentType(documentTypeRaw);
    if (documentType.type) guest.documentType = documentType.type;
    if (!documentType.known) err("RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN", `${label("documento_tipo")} fuera de DNI / NIE / PASSPORT / TIE: se guarda en mayúsculas.`, "documento_tipo");
  }
  const documentNumberRaw = get("documento_numero");
  if (documentNumberRaw !== "") {
    let documentNumber = documentNumberRaw.toUpperCase().replace(/\s+/g, "");
    const maxDocument = RESERVATION_IMPORT_FIELD_MAX_LENGTHS.documento_numero ?? 60;
    if (documentNumber.length > maxDocument) {
      err("RESERVATION_IMPORT_ROW_CELL_TRUNCATED", `${label("documento_numero")} supera ${maxDocument} caracteres y se ha recortado.`, "documento_numero", { max: maxDocument });
      documentNumber = documentNumber.slice(0, maxDocument);
    }
    guest.documentNumber = documentNumber;
  }

  // ---- Importes y moneda ----
  let totalAmount: MoneyString = "0.00";
  let totalSource: ReservationImportTotalSource = "none";
  const totalRaw = get("importe_total");
  if (totalRaw !== "") {
    const amount = parseImportAmount(totalRaw);
    if (amount === null) err("RESERVATION_IMPORT_ROW_INVALID_AMOUNT", `${label("importe_total")} no es un importe válido (0 a 999.999,99).`, "importe_total");
    else {
      totalAmount = amount;
      totalSource = "file";
    }
  }
  let depositAmount: MoneyString | undefined;
  const depositRaw = get("deposito");
  if (depositRaw !== "") {
    const amount = parseImportAmount(depositRaw);
    if (amount === null) err("RESERVATION_IMPORT_ROW_INVALID_AMOUNT", `${label("deposito")} no es un importe válido (0 a 999.999,99).`, "deposito");
    else depositAmount = amount;
  }
  let currency = catalogs.currency;
  const currencyRaw = get("moneda");
  if (currencyRaw !== "") {
    const parsed = parseImportCurrency(currencyRaw);
    if (parsed !== catalogs.currency) {
      err("RESERVATION_IMPORT_ROW_INVALID_CURRENCY", `${label("moneda")} distinta de la de la propiedad (${catalogs.currency}): convierte el importe fuera o deja la celda vacía.`, "moneda", {
        propertyCurrency: catalogs.currency
      });
    } else currency = parsed;
  }

  // ---- Hora, textos libres ----
  let estimatedArrivalTime: string | undefined;
  const timeRaw = get("hora_llegada");
  if (timeRaw !== "") {
    // Sin código de aviso propio para una hora ilegible: se descarta en silencio (documentado en el runbook).
    estimatedArrivalTime = parseImportTime(timeRaw, kindOf("hora_llegada")) ?? undefined;
  }
  const externalReference = text("referencia_externa");
  const companyName = text("empresa");
  const travelAgentName = text("agencia");
  const groupCode = text("grupo");
  const specialRequests = text("peticiones");
  const notes = text("notas");

  // ---- Veredicto ----
  const status = rowStatusFromIssues(issues);
  if (status === "error" || !arrivalDate || !departureDate || nights === null || !roomType) {
    return { issues: stripIssueValues(issues, personalValuesOf(row.cells, mappingByIndex)) };
  }
  const normalized: NormalizedReservationRow = {
    arrivalDate,
    departureDate,
    nights,
    roomTypeId: roomType.id,
    roomTypeCode: roomType.code,
    roomsCount,
    adults,
    children,
    infants,
    channel: channelResult.channel,
    estado,
    historical,
    guest,
    totalAmount,
    totalSource,
    currency,
    vipFlag: vipResult.value
  };
  if (externalReference !== undefined) normalized.externalReference = externalReference;
  if (ratePlan) {
    normalized.ratePlanId = ratePlan.id;
    normalized.ratePlanCode = ratePlan.code;
  }
  if (room) {
    normalized.roomId = room.id;
    normalized.roomNumber = room.number;
  }
  if (boardType) normalized.boardType = boardType;
  if (sourceCode !== undefined) normalized.sourceCode = sourceCode;
  if (segmentResult.segment) normalized.marketSegment = segmentResult.segment;
  if (companyName !== undefined) normalized.companyName = companyName;
  if (travelAgentName !== undefined) normalized.travelAgentName = travelAgentName;
  if (groupCode !== undefined) normalized.groupCode = groupCode;
  if (depositAmount !== undefined) normalized.depositAmount = depositAmount;
  if (paymentResult.method) normalized.paymentMethod = paymentResult.method;
  if (estimatedArrivalTime) normalized.estimatedArrivalTime = estimatedArrivalTime;
  if (specialRequests !== undefined) normalized.specialRequests = specialRequests;
  if (notes !== undefined) normalized.notes = notes;
  if (targetStatus !== undefined) normalized.targetStatus = targetStatus;
  if (inHouse) normalized.inHouse = true;
  return { normalized, resolved: resolvedOf(normalized), issues: stripIssueValues(issues, personalValuesOf(row.cells, mappingByIndex)) };
}

// ---------------------------------------------------------------------------
// normalizeTable: filas + duplicados dentro del fichero
// ---------------------------------------------------------------------------

/** Clave de huésped para el aviso de posible duplicado: documento, e-mail o apellidos + nombre plegados. */
export function guestKeyOf(guest: ReservationImportGuestFields): string {
  if (guest.documentNumber) return `doc:${guest.documentNumber}`;
  if (guest.email) return `email:${guest.email}`;
  return `name:${foldValue(`${guest.surname1} ${guest.surname2 ?? ""} ${guest.firstName}`)}`;
}

function overlaps(aFrom: IsoDate, aTo: IsoDate, bFrom: IsoDate, bTo: IsoDate): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Normaliza toda la tabla con el mapeo efectivo (`applyMapping`) y detecta los
 * duplicados dentro del fichero: misma `referencia_externa` (la primera gana; la
 * repetida queda omitida), misma habitación con noches solapadas (error en la
 * fila posterior) y mismo huésped + llegada + tipo (aviso en la fila posterior).
 */
export function normalizeTable(
  parsed: Pick<ParsedTable, "header" | "rows">,
  mapping: ReservationImportMapping | null | undefined,
  catalogs: ReservationImportCatalogs,
  options: NormalizeTableOptions
): NormalizeTableResult {
  const applied = applyMapping(parsed.header, mapping);
  const rowOptions: NormalizeRowOptions = { historico: options.historico, splitName: applied.splitName };
  if (options.mode !== undefined) rowOptions.mode = options.mode;
  if (options.statusMap !== undefined) rowOptions.statusMap = options.statusMap;
  if (options.cutBusinessDate !== undefined) rowOptions.cutBusinessDate = options.cutBusinessDate;
  const seenReferences = new Map<string, number>();
  const seenRooms: Array<{ rowNumber: number; roomId: string; from: IsoDate; to: IsoDate; historical: boolean }> = [];
  const seenGuests = new Map<string, number>();

  const rows: NormalizedTableRow[] = parsed.rows.map((row) => {
    const result = normalizeRow(row, applied.mappingByIndex, catalogs, rowOptions);
    const issues = [...result.issues];
    const normalized = result.normalized;
    if (normalized) {
      const reference = normalized.externalReference?.trim();
      if (reference) {
        const key = reference.toLowerCase();
        const first = seenReferences.get(key);
        if (first !== undefined) {
          pushIssue(issues, row.rowNumber, "RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE", `${label("referencia_externa")} repetida en la fila ${first}: se omite esta fila.`, "referencia_externa", { firstRow: first });
        } else seenReferences.set(key, row.rowNumber);
      }
      if (normalized.roomId) {
        // Tanda 7d (FO-04): dos estancias CERRADAS que se solapan en la misma habitación son historia (cambio de
        // habitación a mitad de estancia en el PMS de origen), no un choque: solo cuenta el solape con una fila viva.
        const clash = seenRooms.find((entry) => entry.roomId === normalized.roomId && overlaps(entry.from, entry.to, normalized.arrivalDate, normalized.departureDate) && !(entry.historical && normalized.historical));
        if (clash) {
          pushIssue(issues, row.rowNumber, "RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE", `${label("habitacion")} ya asignada en la fila ${clash.rowNumber} con noches solapadas.`, "habitacion", { otherRow: clash.rowNumber });
        } else seenRooms.push({ rowNumber: row.rowNumber, roomId: normalized.roomId, from: normalized.arrivalDate, to: normalized.departureDate, historical: normalized.historical });
      }
      const guestKey = `${guestKeyOf(normalized.guest)}|${normalized.arrivalDate}|${normalized.roomTypeId}`;
      const firstGuest = seenGuests.get(guestKey);
      if (firstGuest !== undefined) {
        pushIssue(issues, row.rowNumber, "RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE", `mismo huésped, llegada y tipo que la fila ${firstGuest}: comprueba que no sea un duplicado.`, "nombre", { otherRow: firstGuest });
      } else seenGuests.set(guestKey, row.rowNumber);
    }
    const status = rowStatusFromIssues(issues);
    const out: NormalizedTableRow = { ...row, status, issues };
    if (normalized && status !== "error") {
      out.normalized = normalized;
      out.resolved = result.resolved;
    }
    return out;
  });

  return { rows, splitName: applied.splitName, mappingByIndex: applied.mappingByIndex };
}

// ---------------------------------------------------------------------------
// Hash de contenido
// ---------------------------------------------------------------------------

export type HashableRow = { normalized?: NormalizedReservationRow; cells?: readonly string[] };

function canonicalNormalized(row: NormalizedReservationRow): Record<string, unknown> {
  // Solo lo que depende del fichero: códigos en vez de ids, importe solo si viene del fichero, sin `historical` (opción).
  return {
    r: row.externalReference ?? null,
    a: row.arrivalDate,
    d: row.departureDate,
    t: row.roomTypeCode,
    p: row.ratePlanCode ?? null,
    h: row.roomNumber ?? null,
    n: row.roomsCount,
    ad: row.adults,
    ch: row.children,
    in: row.infants,
    b: row.boardType ?? null,
    c: row.channel,
    sc: row.sourceCode ?? null,
    s: row.marketSegment ?? null,
    e: row.estado,
    g: {
      f: row.guest.firstName,
      s1: row.guest.surname1,
      s2: row.guest.surname2 ?? null,
      em: row.guest.email ?? null,
      ph: row.guest.phone ?? null,
      na: row.guest.nationality ?? null,
      dt: row.guest.documentType ?? null,
      dn: row.guest.documentNumber ?? null
    },
    co: row.companyName ?? null,
    ag: row.travelAgentName ?? null,
    gr: row.groupCode ?? null,
    ta: row.totalSource === "file" ? row.totalAmount : null,
    cu: row.currency,
    dp: row.depositAmount ?? null,
    pm: row.paymentMethod ?? null,
    et: row.estimatedArrivalTime ?? null,
    sr: row.specialRequests ?? null,
    no: row.notes ?? null,
    v: row.vipFlag,
    // Tanda 7b: el estado destino solo entra en el hash en modo `sync` (una «Reserved»
    // y una «Checked In» del mismo día son cortes distintos); en `create` la clave no
    // existe y el hash de la Tanda 7 queda byte a byte igual.
    ...(row.targetStatus !== undefined ? { ts: row.targetStatus } : {})
  };
}

/**
 * Tanda 7b · hash de la fila que recuerda `PmsShadowLink.rowHash`: sha256 hex del
 * JSON canónico de fechas, noches, tipo, tarifa, habitación, unidades, pax,
 * importe (solo si viene del fichero: un importe cotizado con la parrilla
 * cambiaría de corte en corte sin que OPERA haya cambiado nada), segmento,
 * canal, source code, grupo, empresa, agencia y estado destino. NUNCA nombre,
 * e-mail, teléfono ni documento: el hash puede vivir en BD y en la auditoría.
 * Mismo hash → `unchanged`; distinto → diff de campos y actualización.
 */
export function syncRowHash(row: NormalizedReservationRow): string {
  const canonical = {
    a: row.arrivalDate,
    d: row.departureDate,
    n: row.nights,
    t: row.roomTypeCode,
    p: row.ratePlanCode ?? null,
    h: row.roomNumber ?? null,
    rc: row.roomsCount,
    ad: row.adults,
    ch: row.children,
    ta: row.totalSource === "file" ? row.totalAmount : null,
    s: row.marketSegment ?? null,
    c: row.channel,
    sc: row.sourceCode ?? null,
    gr: row.groupCode ?? null,
    co: row.companyName ?? null,
    ag: row.travelAgentName ?? null,
    ts: row.targetStatus ?? null
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sortKey(row: NormalizedReservationRow): string {
  const guest = row.guest.email ?? row.guest.documentNumber ?? foldValue(`${row.guest.surname1} ${row.guest.surname2 ?? ""} ${row.guest.firstName}`);
  return [row.externalReference ?? "", row.arrivalDate, row.departureDate, row.roomTypeCode, guest].join("");
}

/**
 * sha256 hex del JSON canónico de las filas: las normalizadas ordenadas por
 * (referencia, llegada, salida, tipo, e-mail | documento | apellidos+nombre) y,
 * detrás, las no normalizadas (con errores) por sus celdas recortadas. Mismo hash
 * para el CSV y el XLSX equivalentes, con otro orden de filas, espacios o BOM;
 * distinto al cambiar cualquier celda.
 */
export function reservationImportContentHash(rows: readonly HashableRow[]): string {
  const normalized = rows
    .filter((row): row is { normalized: NormalizedReservationRow } => row.normalized !== undefined)
    .map((row) => ({ key: sortKey(row.normalized), json: JSON.stringify(canonicalNormalized(row.normalized)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
    .map((entry) => entry.json);
  const invalid = rows
    .filter((row) => row.normalized === undefined && row.cells !== undefined)
    .map((row) => JSON.stringify((row.cells ?? []).map((cell) => cell.trim())))
    .sort();
  return createHash("sha256").update(JSON.stringify({ rows: normalized, invalid })).digest("hex");
}

/** «Hoy» remoto en el pasado: para el hash ninguna llegada es pasada ni está en curso. */
const HASH_TODAY: IsoDate = "1900-01-01";

/**
 * Filas para `reservationImportContentHash`: la tabla normalizada SIN frontera
 * temporal (`today` = 1900) y sin la opción «histórico», de modo que el hash no
 * cambia con esa opción, con el día en que se importa ni con el estado de una
 * estancia respecto a hoy (T7-FUN-03: el mismo fichero con `historico` y sin él
 * era un lote distinto). Solo depende del fichero, del mapeo y de los catálogos.
 */
export type ContentHashOptions = {
  mode?: ReservationImportMode;
  statusMap?: PmsShadowStatusMap;
  /** Tanda 7b · `sync`: sal del hash (fila sintética `sync:<feed>:<businessDate>`); con `mode` sync los dos son obligatorios. */
  feed?: PmsShadowReservationFeed;
  businessDate?: IsoDate;
};

/**
 * Tanda 7b: fila sintética que SALA el hash de contenido en modo `sync`. Va como
 * fila no normalizada (`cells`), así que entra en la lista `invalid` del JSON
 * canónico: el mismo snapshot con otro (feed, businessDate) es otro lote y el
 * mismo fichero el mismo día sigue siendo 409 RESERVATION_IMPORT_DUPLICATE.
 */
export function syncContentHashSalt(feed: PmsShadowReservationFeed, businessDate: IsoDate): HashableRow {
  return { cells: [`sync:${feed}:${businessDate}`] };
}

export function contentHashRowsOf(
  parsed: Pick<ParsedTable, "header" | "rows">,
  mapping: ReservationImportMapping | null | undefined,
  catalogs: ReservationImportCatalogs,
  options: ContentHashOptions = {}
): HashableRow[] {
  const tableOptions: NormalizeTableOptions = { historico: false };
  if (options.mode !== undefined) tableOptions.mode = options.mode;
  if (options.statusMap !== undefined) tableOptions.statusMap = options.statusMap;
  const rows: HashableRow[] = normalizeTable(parsed, mapping, { ...catalogs, today: HASH_TODAY }, tableOptions).rows;
  if (options.mode === "sync" && options.feed !== undefined && options.businessDate !== undefined) {
    rows.push(syncContentHashSalt(options.feed, options.businessDate));
  }
  return rows;
}
