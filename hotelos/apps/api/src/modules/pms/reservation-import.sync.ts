// OPERA Cloud · modo sombra (Tanda 7b · L1) — piezas del modo `sync` del importador
// de reservas (docs/design/OPERA-CLOUD-MODO-SOMBRA.md §4, §5 y §6.3), PURAS salvo
// `resolveLinks` y `resolveLinksByStay` (las únicas que tocan Prisma):
//   · `applyHeaderOverride(parsed, headerOverride)` — el fichero NO trae fila de
//     cabecera («Delimited Data»): la cabecera que leyó el parser vuelve a ser la
//     PRIMERA fila de datos (nº de fila corrido) y la cabecera pasa a ser la del
//     perfil; nº de columnas distinto → RESERVATION_IMPORT_HEADER_MISMATCH;
//   · `applyProfileValueMaps(parsed, mapping, propertyMapping, definition?)` —
//     sustituye en las columnas mapeadas a tipo_habitacion / tarifa / segmento /
//     canal / metodo_pago el código OPERA por el código Anfitorio de los
//     diccionarios del `PmsShadowProfile` de la propiedad (por encima de los
//     ejemplos del perfil preinstalado); pseudo rooms → OPERA_PSEUDO_ROOM; la
//     columna `habitacion` se queda con la PRIMERA habitación («201, 202» → «201»);
//   · `estimateTotals(parsed, mapping)` — perfil `arrivals`: con columna `RATE`
//     (tarifa de la primera noche) y sin `importe_total`, AÑADE la columna
//     sintética `__importe_total_estimado` (= RATE × noches × habitaciones) a la
//     cabecera y a cada fila, la mapea a `importe_total` (`applyMapping` exige que
//     la clave exista en la cabecera) y avisa OPERA_TOTAL_ESTIMATED;
//   · `injectReferences(parsed, mapping, resolver)` — informes sin nº de
//     confirmación (`departure_all`): la columna sintética `__referencia_externa`
//     toma el nº de confirmación del enlace que casa por (habitación, llegada,
//     salida); sin enlace la celda queda vacía → SYNC_REQUIRES_REFERENCE;
//   · `resolveLinks(propertyId, references)` — enlaces `PmsShadowLink` + reserva
//     enlazada (sin PII) y reservas ACTIVAS sin enlace con esa referencia (conflicto
//     local: nunca se toca una reserva no OPERA); `resolveLinksByStay` para los
//     informes sin referencia;
//   · `decideSyncAction(…)` — veredicto por fila (§5.1, §5.3): create / update /
//     transition / unchanged / skip, diff de campos SIN valores, transición a
//     aplicar, reactivación (Cancelled → Reserved = reserva nueva) y avisos;
//   · `computeMissing(…)` — enlaces vivos cuya ventana (§5.2) contiene la reserva
//     y que no aparecen en el corte: alerta, nunca cancelación automática.
//
// GDPR: ningún mensaje cita valores del fichero; el diff solo lleva NOMBRES de campo.

import { prisma } from "@hotelos/database";
import {
  RESERVATION_IMPORT_AMOUNT_MAX,
  RESERVATION_IMPORT_LABELS_ES,
  RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN,
  RESERVATION_IMPORT_SYNC_TOTAL_COLUMN,
  type IsoDate,
  type MoneyString,
  type NormalizedReservationRow,
  type PmsShadowProfileDefinition,
  type PmsShadowPropertyMapping,
  type PmsShadowReservationFeed,
  type ReservationImportField,
  type ReservationImportIssue,
  type ReservationImportMapping,
  type ReservationImportRowCode,
  type ReservationStatus,
  type ReservationSyncAction,
  type ReservationSyncTargetStatus
} from "@hotelos/shared";
import { foldHeader, foldValue } from "./reservation-import.mapping.js";
import { addDaysIso, parseImportAmount, parseImportDate, parseImportInteger } from "./reservation-import.normalize.js";
import { ReservationImportParseError, type CellKind, type ParsedRow, type ParsedTable } from "./reservation-import.parser.js";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Incidencia de fila producida por las transformaciones previas a la normalización. */
export type SyncRowIssue = { rowNumber: number; issue: ReservationImportIssue };

/** Campos de `tipo_habitacion` / `tarifa` / `segmento` / `canal` / `metodo_pago` que traducen los diccionarios del perfil. */
const VALUE_MAP_FIELDS: readonly ReservationImportField[] = ["tipo_habitacion", "tarifa", "segmento", "canal", "metodo_pago"];

/** Transición de estado que el commit aplica tras crear o actualizar (§5.3). */
export type SyncTransition = "check_in" | "check_out" | "check_in_and_out" | "cancel" | "no_show";

/** Enlace + reserva enlazada tal como los lee `resolveLinks` (sin datos personales). */
export type SyncLinkedReservation = {
  link: {
    id: string;
    confirmationNo: string;
    reservationId: string;
    rowHash: string;
    lastStatus: string;
    missingStreak: number;
  };
  reservation: {
    id: string;
    code: string;
    status: ReservationStatus;
    arrivalDate: IsoDate;
    departureDate: IsoDate;
    roomTypeId: string | null;
    ratePlanId: string | null;
    adults: number;
    children: number;
    roomsCount: number;
    totalAmount: MoneyString;
    marketSegment: string | null;
    channel: string;
    sourceCode: string | null;
    groupCode: string | null;
    companyName: string | null;
    travelAgentName: string | null;
    assignedRoomId: string | null;
  };
};

/** Reserva ACTIVA de la propiedad con esa referencia externa y SIN enlace: creada en Anfitorio por otra vía. */
export type SyncLocalReservation = { id: string; code: string; status: ReservationStatus };

export type ResolveLinksResult = {
  /** Clave: nº de confirmación en minúsculas (como el chequeo de `annotateReferences`). */
  links: Map<string, SyncLinkedReservation>;
  activeUnlinked: Map<string, SyncLocalReservation>;
};

export type SyncDecision = {
  action: ReservationSyncAction;
  targetStatus: ReservationSyncTargetStatus;
  currentStatus?: ReservationStatus;
  /** Nombres de los campos de `Reservation` que cambian (nunca valores). */
  diff: string[];
  transition: SyncTransition | null;
  /** Reactivación (reserva enlazada cancelada / no-show y OPERA la trae viva): reserva NUEVA y el enlace pasa a apuntar a ella. */
  reactivate: boolean;
  /** Sin habitación válida para un destino checked_in / checked_out: permanece confirmada (aviso OPERA_CHECKIN_WITHOUT_ROOM). */
  checkInWithoutRoom: boolean;
  issues: ReservationImportIssue[];
};

export type MissingCandidate = {
  confirmationNo: string;
  reservationCode: string;
  status: ReservationStatus;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  missingStreak: number;
};

export type MissingReservation = {
  confirmationNo: string;
  reservationCode: string;
  arrivalDate: IsoDate;
  /** Racha ANTES de este corte (el servicio la incrementa al persistir). */
  missingStreak: number;
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function issueOf(rowNumber: number, code: ReservationImportRowCode, text: string, column?: ReservationImportField, details?: Record<string, unknown>): ReservationImportIssue {
  const issue: ReservationImportIssue = { code, message: `Fila ${rowNumber}: ${text}` };
  if (column) issue.column = column;
  if (details) issue.details = details;
  return issue;
}

function label(field: ReservationImportField): string {
  return `«${RESERVATION_IMPORT_LABELS_ES[field]}»`;
}

function kindsOf(cells: readonly string[]): CellKind[] {
  return cells.map((cell) => (cell === "" ? "empty" : "string"));
}

/** Índice de la columna mapeada a `field` (primera coincidencia) o -1. */
export function columnIndexOf(header: readonly string[], mapping: ReservationImportMapping, field: ReservationImportField): number {
  return header.findIndex((column) => mapping[column] === field);
}

function foldedDictionary(...sources: Array<Record<string, string> | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  // El primero manda: quien llama pasa primero el diccionario de la propiedad y después los ejemplos del perfil.
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      const folded = foldValue(key);
      if (folded !== "" && !out.has(folded)) out.set(folded, value);
    }
  }
  return out;
}

/** Importe en céntimos (entero) de un MoneyString "1234.56". */
function centsOf(amount: MoneyString): number {
  const [whole, fraction = ""] = amount.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function moneyOfCents(cents: number): MoneyString {
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

function isoOf(value: Date): IsoDate {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// applyHeaderOverride
// ---------------------------------------------------------------------------

/**
 * Deshace la desambiguación de `uniqueHeader` (parser) sobre la primera fila de
 * datos: `columna_<n>` (celda vacía) → «»; «X (k)» con k ≥ 2 → «X» cuando «X» ya
 * apareció antes en la fila (dos celdas iguales, p. ej. «2» adultos y «2» noches).
 */
export function restoreFirstRowCells(header: readonly string[]): string[] {
  const out: string[] = [];
  for (const cell of header) {
    if (/^columna_\d+$/.test(cell)) {
      out.push("");
      continue;
    }
    const match = /^(.*) \((\d+)\)$/.exec(cell);
    if (match && Number(match[2]) >= 2 && out.includes(match[1]!)) {
      out.push(match[1]!);
      continue;
    }
    out.push(cell);
  }
  return out;
}

/**
 * El fichero no trae fila de cabecera: lo que el parser tomó por cabecera es la
 * primera fila de datos. Se reinserta como fila 1 (las demás corren un puesto) y
 * la cabecera pasa a ser `headerOverride`; las celdas que el parser renombró
 * (`columna_<n>`, «X (2)») se restauran con `restoreFirstRowCells` y sus avisos
 * de cabecera repetida se retiran. Nº de columnas distinto → 400
 * RESERVATION_IMPORT_HEADER_MISMATCH { expected, receivedCount } (SEC-02: nunca las
 * celdas recibidas, que aquí son la primera fila de DATOS del huésped).
 */
export function applyHeaderOverride(parsed: ParsedTable, headerOverride: readonly string[]): ParsedTable {
  const expected = [...headerOverride];
  if (expected.length !== parsed.header.length) {
    throw new ReservationImportParseError(
      "RESERVATION_IMPORT_HEADER_MISMATCH",
      `El fichero tiene ${parsed.header.length} columna(s) y la cabecera del perfil ${expected.length}: revisa las columnas del informe.`,
      { expected, receivedCount: parsed.header.length }
    );
  }
  const firstCells = restoreFirstRowCells(parsed.header);
  const firstLine = Math.max(1, (parsed.rows[0]?.line ?? 2) - 1);
  const firstRow: ParsedRow = { rowNumber: 1, line: firstLine, cells: firstCells, kinds: kindsOf(firstCells) };
  return {
    ...parsed,
    header: expected,
    warnings: parsed.warnings.filter((warning) => !/^La cabecera repite la columna/.test(warning)),
    rows: [firstRow, ...parsed.rows.map((row) => ({ ...row, rowNumber: row.rowNumber + 1 }))]
  };
}

// ---------------------------------------------------------------------------
// applyProfileValueMaps
// ---------------------------------------------------------------------------

export type ApplyProfileValueMapsResult = {
  parsed: ParsedTable;
  issues: SyncRowIssue[];
  /** Cuántas celdas se tradujeron por diccionario (informativo). */
  replaced: number;
};

/**
 * Traduce los códigos OPERA de las columnas mapeadas a tipo_habitacion / tarifa /
 * segmento / canal / metodo_pago con los diccionarios de la propiedad
 * (`PmsShadowProfile.mappingJson`: roomTypes, rateCodes, marketCodes, sourceCodes,
 * paymentTypes) y, por debajo, los ejemplos del perfil preinstalado (channelMap,
 * marketSegmentMap, paymentMethodMap). Claves plegadas con `foldValue`. Una celda
 * sin entrada se deja tal cual (la normalización la resolverá o avisará). Un
 * room type de `pseudoRoomTypes` → fila omitida OPERA_PSEUDO_ROOM. La columna
 * `habitacion` se queda con la primera habitación de una lista «201, 202» [V].
 * No muta `parsed`: devuelve una tabla nueva.
 */
export function applyProfileValueMaps(
  parsed: ParsedTable,
  mapping: ReservationImportMapping,
  propertyMapping: PmsShadowPropertyMapping,
  definition?: Pick<PmsShadowProfileDefinition, "channelMap" | "marketSegmentMap" | "paymentMethodMap">
): ApplyProfileValueMapsResult {
  const dictionaries: Partial<Record<ReservationImportField, Map<string, string>>> = {
    tipo_habitacion: foldedDictionary(propertyMapping.roomTypes),
    tarifa: foldedDictionary(propertyMapping.rateCodes),
    segmento: foldedDictionary(propertyMapping.marketCodes, definition?.marketSegmentMap),
    canal: foldedDictionary(propertyMapping.sourceCodes, definition?.channelMap),
    metodo_pago: foldedDictionary(propertyMapping.paymentTypes, definition?.paymentMethodMap)
  };
  const pseudo = new Set((propertyMapping.pseudoRoomTypes ?? []).map((code) => foldValue(code)).filter((code) => code !== ""));
  const columns = VALUE_MAP_FIELDS.map((field) => ({ field, index: columnIndexOf(parsed.header, mapping, field) })).filter((entry) => entry.index >= 0);
  const roomIndex = columnIndexOf(parsed.header, mapping, "habitacion");
  const issues: SyncRowIssue[] = [];
  let replaced = 0;

  const rows = parsed.rows.map((row) => {
    const cells = [...row.cells];
    const kinds = [...row.kinds];
    for (const { field, index } of columns) {
      const raw = (cells[index] ?? "").trim();
      if (raw === "") continue;
      const folded = foldValue(raw);
      if (field === "tipo_habitacion" && pseudo.has(folded)) {
        issues.push({ rowNumber: row.rowNumber, issue: issueOf(row.rowNumber, "RESERVATION_IMPORT_ROW_OPERA_PSEUDO_ROOM", `${label("tipo_habitacion")} es una pseudo room de OPERA (no es inventario): se omite la fila.`, "tipo_habitacion") });
        continue;
      }
      const value = dictionaries[field]?.get(folded);
      if (value !== undefined && value !== raw) {
        cells[index] = value;
        kinds[index] = value === "" ? "empty" : "string";
        replaced += 1;
      }
    }
    if (roomIndex >= 0) {
      const raw = cells[roomIndex] ?? "";
      const first = raw.split(",")[0]?.trim() ?? "";
      if (first !== raw) {
        cells[roomIndex] = first;
        kinds[roomIndex] = first === "" ? "empty" : "string";
      }
    }
    return { ...row, cells, kinds };
  });
  return { parsed: { ...parsed, rows }, issues, replaced };
}

// ---------------------------------------------------------------------------
// estimateTotals
// ---------------------------------------------------------------------------

export type EstimateTotalsResult = {
  parsed: ParsedTable;
  mapping: ReservationImportMapping;
  issues: SyncRowIssue[];
  /** Por nº de fila: tarifa de la primera noche y total estimado (ambos MoneyString). */
  estimates: Map<number, { rateFirstNight: MoneyString; estimatedTotal: MoneyString | null }>;
  /** true cuando se añadió la columna sintética. */
  applied: boolean;
};

/** ¿La cabecera plegada es la columna `RATE` de Responsys (tarifa de la primera noche)? */
function isRateColumn(column: string, mapping: ReservationImportMapping): boolean {
  return foldHeader(column) === "rate" && (mapping[column] ?? null) === null;
}

/**
 * Perfil `arrivals` (Responsys): `RATE` es la tarifa de la PRIMERA noche [V], no el
 * total. Sin `importe_total` mapeado, se añade la columna sintética
 * `__importe_total_estimado` = RATE × noches × habitaciones (noches de la columna
 * `noches` o, si falta, de llegada / salida; habitaciones de `habitaciones` o 1)
 * mapeada a `importe_total`, con aviso OPERA_TOTAL_ESTIMATED por fila. Sin RATE
 * legible o sin noches la celda queda vacía (la fila se cotizará con la tarifa,
 * como en la Tanda 7). Un total por encima de RESERVATION_IMPORT_AMOUNT_MAX se
 * deja vacío también (mejor cotizar que rechazar la fila). No muta `parsed` ni
 * `mapping`.
 */
export function estimateTotals(parsed: ParsedTable, mapping: ReservationImportMapping): EstimateTotalsResult {
  const rateIndex = parsed.header.findIndex((column) => isRateColumn(column, mapping));
  const untouched: EstimateTotalsResult = { parsed, mapping, issues: [], estimates: new Map(), applied: false };
  if (rateIndex < 0) return untouched;
  if (columnIndexOf(parsed.header, mapping, "importe_total") >= 0) return untouched;
  if (parsed.header.includes(RESERVATION_IMPORT_SYNC_TOTAL_COLUMN)) return untouched;
  const nightsIndex = columnIndexOf(parsed.header, mapping, "noches");
  const roomsIndex = columnIndexOf(parsed.header, mapping, "habitaciones");
  const arrivalIndex = columnIndexOf(parsed.header, mapping, "llegada");
  const departureIndex = columnIndexOf(parsed.header, mapping, "salida");
  const maxCents = centsOf(RESERVATION_IMPORT_AMOUNT_MAX);
  const issues: SyncRowIssue[] = [];
  const estimates = new Map<number, { rateFirstNight: MoneyString; estimatedTotal: MoneyString | null }>();

  const nightsOf = (row: ParsedRow): number | null => {
    if (nightsIndex >= 0) {
      const value = parseImportInteger(row.cells[nightsIndex] ?? "");
      if (value !== null && value >= 1) return value;
    }
    if (arrivalIndex >= 0 && departureIndex >= 0) {
      const arrival = parseImportDate(row.cells[arrivalIndex] ?? "", row.kinds[arrivalIndex] ?? "string");
      const departure = parseImportDate(row.cells[departureIndex] ?? "", row.kinds[departureIndex] ?? "string");
      if (arrival && departure) {
        const nights = Math.round((Date.parse(`${departure.iso}T00:00:00Z`) - Date.parse(`${arrival.iso}T00:00:00Z`)) / 86400000);
        if (nights >= 1) return nights;
      }
    }
    return null;
  };

  const rows = parsed.rows.map((row) => {
    let total = "";
    const rate = parseImportAmount(row.cells[rateIndex] ?? "");
    if (rate !== null) {
      const nights = nightsOf(row);
      const roomsRaw = roomsIndex >= 0 ? parseImportInteger(row.cells[roomsIndex] ?? "") : null;
      const rooms = roomsRaw !== null && roomsRaw >= 1 ? roomsRaw : 1;
      let estimated: MoneyString | null = null;
      if (nights !== null) {
        const cents = centsOf(rate) * nights * rooms;
        if (Number.isSafeInteger(cents) && cents <= maxCents) {
          estimated = moneyOfCents(cents);
          total = estimated;
          issues.push({
            rowNumber: row.rowNumber,
            issue: issueOf(row.rowNumber, "RESERVATION_IMPORT_ROW_OPERA_TOTAL_ESTIMATED", `${label("importe_total")} estimado como tarifa de la primera noche × ${nights} noche(s) × ${rooms} habitación(es): se sustituirá por el importe real cuando llegue.`, "importe_total", { nights, rooms })
          });
        }
      }
      estimates.set(row.rowNumber, { rateFirstNight: rate, estimatedTotal: estimated });
    }
    return { ...row, cells: [...row.cells, total], kinds: [...row.kinds, total === "" ? "empty" : "string"] as CellKind[] };
  });
  return {
    parsed: { ...parsed, header: [...parsed.header, RESERVATION_IMPORT_SYNC_TOTAL_COLUMN], rows },
    mapping: { ...mapping, [RESERVATION_IMPORT_SYNC_TOTAL_COLUMN]: "importe_total" },
    issues,
    estimates,
    applied: true
  };
}

// ---------------------------------------------------------------------------
// injectReferences (informes sin nº de confirmación)
// ---------------------------------------------------------------------------

/** Clave de estancia para casar una fila sin referencia con un enlace: habitación plegada + llegada + salida. */
export function stayKeyOf(roomNumber: string, arrivalDate: IsoDate, departureDate: IsoDate): string {
  return `${foldValue(roomNumber).replace(/^0+(?=\d)/, "")}|${arrivalDate}|${departureDate}`;
}

export type StayKeyRow = { rowNumber: number; roomNumber: string; arrivalDate: IsoDate; departureDate: IsoDate };

/** Filas del fichero con habitación, llegada y salida legibles (para `resolveLinksByStay`). */
export function stayKeysOf(parsed: ParsedTable, mapping: ReservationImportMapping): StayKeyRow[] {
  const roomIndex = columnIndexOf(parsed.header, mapping, "habitacion");
  const arrivalIndex = columnIndexOf(parsed.header, mapping, "llegada");
  const departureIndex = columnIndexOf(parsed.header, mapping, "salida");
  if (roomIndex < 0 || arrivalIndex < 0 || departureIndex < 0) return [];
  const out: StayKeyRow[] = [];
  for (const row of parsed.rows) {
    const roomNumber = (row.cells[roomIndex] ?? "").split(",")[0]?.trim() ?? "";
    const arrival = parseImportDate(row.cells[arrivalIndex] ?? "", row.kinds[arrivalIndex] ?? "string");
    const departure = parseImportDate(row.cells[departureIndex] ?? "", row.kinds[departureIndex] ?? "string");
    if (roomNumber === "" || !arrival || !departure) continue;
    out.push({ rowNumber: row.rowNumber, roomNumber, arrivalDate: arrival.iso, departureDate: departure.iso });
  }
  return out;
}

export type InjectReferencesResult = { parsed: ParsedTable; mapping: ReservationImportMapping; resolved: number; applied: boolean };

/**
 * Añade la columna sintética `__referencia_externa` (mapeada a `referencia_externa`)
 * con el nº de confirmación que devuelva `resolver` para la estancia de la fila
 * (habitación, llegada, salida); vacía cuando no hay enlace (→ la normalización
 * emite SYNC_REQUIRES_REFERENCE). Solo actúa si el fichero NO tiene ya una columna
 * de referencia y sí tiene habitación, llegada y salida. No muta `parsed` ni `mapping`.
 */
export function injectReferences(parsed: ParsedTable, mapping: ReservationImportMapping, resolver: (stay: StayKeyRow) => string | null): InjectReferencesResult {
  const untouched: InjectReferencesResult = { parsed, mapping, resolved: 0, applied: false };
  if (columnIndexOf(parsed.header, mapping, "referencia_externa") >= 0) return untouched;
  if (parsed.header.includes(RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN)) return untouched;
  const keys = new Map(stayKeysOf(parsed, mapping).map((key) => [key.rowNumber, key] as const));
  if (keys.size === 0 && parsed.rows.length > 0) return untouched;
  let resolved = 0;
  const rows = parsed.rows.map((row) => {
    const key = keys.get(row.rowNumber);
    const reference = key ? (resolver(key) ?? "") : "";
    if (reference !== "") resolved += 1;
    return { ...row, cells: [...row.cells, reference], kinds: [...row.kinds, reference === "" ? "empty" : "string"] as CellKind[] };
  });
  return {
    parsed: { ...parsed, header: [...parsed.header, RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN], rows },
    mapping: { ...mapping, [RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN]: "referencia_externa" },
    resolved,
    applied: true
  };
}

// ---------------------------------------------------------------------------
// resolveLinks / resolveLinksByStay (Prisma)
// ---------------------------------------------------------------------------

const LINK_RESERVATION_SELECT = {
  id: true,
  code: true,
  status: true,
  arrivalDate: true,
  departureDate: true,
  roomTypeId: true,
  ratePlanId: true,
  adults: true,
  children: true,
  roomsCount: true,
  totalAmount: true,
  marketSegment: true,
  channel: true,
  sourceCode: true,
  groupCode: true,
  companyName: true,
  travelAgentName: true,
  assignedRoomId: true
} as const;

type LinkRow = {
  id: string;
  confirmationNo: string;
  reservationId: string;
  rowHash: string;
  lastStatus: string;
  missingStreak: number;
  reservation: {
    id: string;
    code: string;
    status: string;
    arrivalDate: Date;
    departureDate: Date;
    roomTypeId: string | null;
    ratePlanId: string | null;
    adults: number;
    children: number;
    roomsCount: number;
    totalAmount: { toFixed(digits: number): string };
    marketSegment: string | null;
    channel: string;
    sourceCode: string | null;
    groupCode: string | null;
    companyName: string | null;
    travelAgentName: string | null;
    assignedRoomId: string | null;
  };
};

function linkedOf(row: LinkRow): SyncLinkedReservation {
  const r = row.reservation;
  return {
    link: { id: row.id, confirmationNo: row.confirmationNo, reservationId: row.reservationId, rowHash: row.rowHash, lastStatus: row.lastStatus, missingStreak: row.missingStreak },
    reservation: {
      id: r.id,
      code: r.code,
      status: r.status as ReservationStatus,
      arrivalDate: isoOf(r.arrivalDate),
      departureDate: isoOf(r.departureDate),
      roomTypeId: r.roomTypeId,
      ratePlanId: r.ratePlanId,
      adults: r.adults,
      children: r.children,
      roomsCount: r.roomsCount,
      totalAmount: r.totalAmount.toFixed(2),
      marketSegment: r.marketSegment,
      channel: r.channel,
      sourceCode: r.sourceCode,
      groupCode: r.groupCode,
      companyName: r.companyName,
      travelAgentName: r.travelAgentName,
      assignedRoomId: r.assignedRoomId
    }
  };
}

/**
 * Enlaces de la propiedad para esos números de confirmación (sin distinguir
 * mayúsculas) con su reserva, y reservas ACTIVAS (ni cancelada ni no-show) con
 * esa `externalReference` que NO tienen enlace (conflicto local). La reserva no
 * tiene `updatedAt`: el diff se apoya en `link.rowHash` y en los campos leídos.
 */
export async function resolveLinks(propertyId: string, references: readonly string[]): Promise<ResolveLinksResult> {
  const links = new Map<string, SyncLinkedReservation>();
  const activeUnlinked = new Map<string, SyncLocalReservation>();
  const unique = Array.from(new Set(references.map((reference) => reference.trim()).filter((reference) => reference !== "")));
  if (unique.length === 0) return { links, activeUnlinked };
  const rows = await prisma.pmsShadowLink.findMany({
    where: { propertyId, confirmationNo: { in: unique, mode: "insensitive" } },
    select: { id: true, confirmationNo: true, reservationId: true, rowHash: true, lastStatus: true, missingStreak: true, reservation: { select: LINK_RESERVATION_SELECT } }
  });
  for (const row of rows) {
    const key = row.confirmationNo.trim().toLowerCase();
    if (!links.has(key)) links.set(key, linkedOf(row));
  }
  const linkedIds = new Set(rows.map((row) => row.reservationId));
  const local = await prisma.reservation.findMany({
    where: { propertyId, deletedAt: null, status: { notIn: ["cancelled", "no_show"] }, externalReference: { in: unique, mode: "insensitive" } },
    select: { id: true, code: true, status: true, externalReference: true },
    orderBy: [{ createdAt: "asc" }]
  });
  for (const reservation of local) {
    if (linkedIds.has(reservation.id)) continue;
    const key = (reservation.externalReference ?? "").trim().toLowerCase();
    if (key === "" || activeUnlinked.has(key)) continue;
    activeUnlinked.set(key, { id: reservation.id, code: reservation.code, status: reservation.status as ReservationStatus });
  }
  return { links, activeUnlinked };
}

/**
 * Informes sin nº de confirmación: enlaces vivos (reserva confirmada o alojada)
 * de la propiedad cuya estancia (habitación asignada, llegada, salida) coincide
 * con alguna fila. Devuelve `stayKey` → nº de confirmación.
 */
export async function resolveLinksByStay(propertyId: string, stays: readonly StayKeyRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (stays.length === 0) return out;
  const departures = Array.from(new Set(stays.map((stay) => stay.departureDate)));
  const rows = await prisma.pmsShadowLink.findMany({
    where: {
      propertyId,
      reservation: { status: { in: ["confirmed", "checked_in"] }, departureDate: { in: departures.map((iso) => new Date(`${iso}T00:00:00.000Z`)) }, assignedRoomId: { not: null } }
    },
    select: { confirmationNo: true, reservation: { select: { arrivalDate: true, departureDate: true, assignedRoomId: true } } }
  });
  if (rows.length === 0) return out;
  // `Reservation` no tiene relación `assignedRoom` (solo la columna): los números salen de `rooms`.
  const roomIds = Array.from(new Set(rows.map((row) => row.reservation.assignedRoomId).filter((id): id is string => id !== null)));
  const rooms = await prisma.room.findMany({ where: { id: { in: roomIds }, propertyId }, select: { id: true, number: true } });
  const numberById = new Map(rooms.map((room) => [room.id, room.number] as const));
  for (const row of rows) {
    const number = row.reservation.assignedRoomId ? numberById.get(row.reservation.assignedRoomId) : undefined;
    if (!number) continue;
    const key = stayKeyOf(number, isoOf(row.reservation.arrivalDate), isoOf(row.reservation.departureDate));
    if (!out.has(key)) out.set(key, row.confirmationNo);
  }
  return out;
}

// ---------------------------------------------------------------------------
// decideSyncAction
// ---------------------------------------------------------------------------

const DEAD_STATUSES: readonly ReservationStatus[] = ["cancelled", "no_show"];

/** Campos que una reserva alojada NO acepta (solo se mueve por recepción): quedan fuera del diff. */
const IN_HOUSE_FROZEN_FIELDS: ReadonlySet<string> = new Set(["arrivalDate", "roomTypeId", "assignedRoomId"]);

/**
 * Diff de campos entre la fila y la reserva enlazada: solo NOMBRES. Un campo que
 * el fichero no trae (undefined) no es una afirmación de OPERA y no cuenta; el
 * canal solo cuenta cuando la columna `canal` venía rellena (`sourceCode`); el
 * importe solo cuando viene del fichero (no cotizado).
 */
export function diffFields(normalized: NormalizedReservationRow, reservation: SyncLinkedReservation["reservation"]): string[] {
  const diff: string[] = [];
  if (normalized.arrivalDate !== reservation.arrivalDate) diff.push("arrivalDate");
  if (normalized.departureDate !== reservation.departureDate) diff.push("departureDate");
  if (normalized.roomTypeId !== (reservation.roomTypeId ?? "")) diff.push("roomTypeId");
  if (normalized.ratePlanId !== undefined && normalized.ratePlanId !== (reservation.ratePlanId ?? undefined)) diff.push("ratePlanId");
  if (normalized.adults !== reservation.adults) diff.push("adults");
  if (normalized.children !== reservation.children) diff.push("children");
  if (normalized.roomsCount !== reservation.roomsCount) diff.push("roomsCount");
  if (normalized.totalSource === "file" && centsOf(normalized.totalAmount) !== centsOf(reservation.totalAmount)) diff.push("totalAmount");
  if (normalized.marketSegment !== undefined && normalized.marketSegment !== (reservation.marketSegment ?? undefined)) diff.push("marketSegment");
  if (normalized.sourceCode !== undefined) {
    if (normalized.channel !== reservation.channel) diff.push("channel");
    if (normalized.sourceCode !== (reservation.sourceCode ?? undefined)) diff.push("sourceCode");
  }
  if (normalized.groupCode !== undefined && normalized.groupCode !== (reservation.groupCode ?? undefined)) diff.push("groupCode");
  if (normalized.companyName !== undefined && normalized.companyName !== (reservation.companyName ?? undefined)) diff.push("companyName");
  if (normalized.travelAgentName !== undefined && normalized.travelAgentName !== (reservation.travelAgentName ?? undefined)) diff.push("travelAgentName");
  if (normalized.roomId !== undefined && normalized.roomId !== (reservation.assignedRoomId ?? undefined)) diff.push("assignedRoomId");
  return diff;
}

/** Transición de §5.3 desde el estado actual hacia el destino; null = no hay (o no se aplica). */
function transitionFor(current: ReservationStatus, target: ReservationSyncTargetStatus): SyncTransition | null {
  if (target === "cancelled") return current === "draft" || current === "confirmed" ? "cancel" : null;
  if (target === "no_show") return current === "draft" || current === "confirmed" ? "no_show" : null;
  if (target === "checked_in") return current === "confirmed" ? "check_in" : null;
  if (target === "checked_out") return current === "confirmed" ? "check_in_and_out" : current === "checked_in" ? "check_out" : null;
  return null;
}

/**
 * Veredicto de una fila en modo `sync` (§5.1, §5.3):
 *   · sin enlace y sin reserva activa con esa referencia → `create`;
 *   · sin enlace y reserva activa ajena → `skip` OPERA_CONFLICT_LOCAL_RESERVATION;
 *   · enlace a una reserva cancelada / no-show y OPERA la trae viva → reactivación:
 *     `create` (reserva nueva, aviso REFERENCE_REUSED_CANCELLED) y el enlace se re-apunta;
 *   · enlace + destino cancelled / no_show sobre checked_in / checked_out →
 *     SYNC_CANCEL_AFTER_CHECKIN (aviso, sin cambio);
 *   · enlace + destino confirmed sobre checked_in / checked_out (o checked_in sobre
 *     checked_out) → SYNC_STATUS_REGRESSION (omitida);
 *   · enlace + mismo hash + estado ya igual al destino → `unchanged`;
 *   · enlace + diff de campos → `update` (+ transición si el destino difiere);
 *     sin diff pero con transición → `transition`; sin nada → `unchanged`.
 * Un destino checked_in / checked_out sin habitación (ni en la fila ni asignada)
 * → aviso OPERA_CHECKIN_WITHOUT_ROOM y la reserva permanece confirmada.
 */
export function decideSyncAction(input: {
  rowNumber: number;
  normalized: NormalizedReservationRow;
  rowHash: string;
  link?: SyncLinkedReservation | null;
  activeUnlinkedReservation?: SyncLocalReservation | null;
}): SyncDecision {
  const { rowNumber, normalized, rowHash } = input;
  const issues: ReservationImportIssue[] = [];
  const targetStatus = normalized.targetStatus ?? "confirmed";
  const base: SyncDecision = { action: "unchanged", targetStatus, diff: [], transition: null, reactivate: false, checkInWithoutRoom: false, issues };

  if (targetStatus === "skip") return { ...base, action: "skip" };

  const link = input.link ?? null;
  if (!link) {
    const local = input.activeUnlinkedReservation ?? null;
    if (local) {
      issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_OPERA_CONFLICT_LOCAL_RESERVATION", `${label("referencia_externa")} coincide con la reserva ${local.code}, creada en Anfitorio por otra vía: no se toca y se omite la fila.`, "referencia_externa", { reservationCode: local.code }));
      return { ...base, action: "skip", currentStatus: local.status };
    }
    return createDecision(base, normalized, rowNumber);
  }

  const reservation = link.reservation;
  const current = reservation.status;
  const withCurrent: SyncDecision = { ...base, currentStatus: current };

  if (DEAD_STATUSES.includes(current)) {
    if (targetStatus === "cancelled" || targetStatus === "no_show") return withCurrent;
    issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED", `${label("referencia_externa")} existía en la reserva cancelada o no-show ${reservation.code}: OPERA la trae viva, se crea una reserva nueva y el enlace pasa a apuntar a ella.`, "referencia_externa", { reservationCode: reservation.code }));
    return { ...createDecision(withCurrent, normalized, rowNumber), reactivate: true };
  }

  if ((targetStatus === "cancelled" || targetStatus === "no_show") && (current === "checked_in" || current === "checked_out")) {
    issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_SYNC_CANCEL_AFTER_CHECKIN", `OPERA la trae ${targetStatus === "cancelled" ? "cancelada" : "no-show"} pero la reserva ${reservation.code} ya está ${current === "checked_in" ? "alojada" : "con check-out"}: no se cancela.`, "estado", { reservationCode: reservation.code }));
    return withCurrent;
  }
  if ((targetStatus === "confirmed" && (current === "checked_in" || current === "checked_out")) || (targetStatus === "checked_in" && current === "checked_out")) {
    issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_SYNC_STATUS_REGRESSION", `OPERA la trae ${targetStatus === "confirmed" ? "confirmada" : "alojada"} pero la reserva ${reservation.code} ya está ${current === "checked_in" ? "alojada" : "con check-out"}: no se retrocede el estado, fila omitida.`, "estado", { reservationCode: reservation.code }));
    return { ...withCurrent, action: "skip" };
  }

  let transition = current === targetStatus ? null : transitionFor(current, targetStatus);
  let checkInWithoutRoom = false;
  if ((transition === "check_in" || transition === "check_in_and_out") && !normalized.roomId && !reservation.assignedRoomId) {
    checkInWithoutRoom = true;
    transition = null;
    issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM", `OPERA la tiene en casa pero la fila no trae una habitación válida: la reserva ${reservation.code} permanece confirmada (asigna la habitación y haz el check-in por recepción).`, "habitacion", { reservationCode: reservation.code }));
  }

  if (current === "checked_out") {
    // Estancia cerrada: no admite cambios de campos (409 en updateReservationShadow); solo cuenta la transición (ninguna posible aquí).
    return { ...withCurrent, transition, checkInWithoutRoom, action: transition ? "transition" : "unchanged" };
  }

  let diff: string[] = [];
  if (rowHash !== link.link.rowHash || transition) {
    diff = diffFields(normalized, reservation);
    if (current === "checked_in") {
      if (diff.includes("assignedRoomId")) {
        issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_SYNC_ROOM_MOVE_IGNORED", `OPERA cambia de habitación la reserva ${reservation.code}, que ya está alojada: el cambio no se aplica (muévela por recepción).`, "habitacion", { reservationCode: reservation.code }));
      }
      diff = diff.filter((field) => !IN_HOUSE_FROZEN_FIELDS.has(field));
    }
  }
  const action: ReservationSyncAction = diff.length > 0 ? "update" : transition ? "transition" : "unchanged";
  return { ...withCurrent, action, diff, transition, checkInWithoutRoom };
}

/** Veredicto `create`: transición posterior según el destino y aviso sin habitación (§5.3). */
function createDecision(base: SyncDecision, normalized: NormalizedReservationRow, rowNumber: number): SyncDecision {
  const target = base.targetStatus;
  let transition: SyncTransition | null = null;
  let checkInWithoutRoom = false;
  if (target === "cancelled") transition = "cancel";
  else if (target === "no_show") transition = "no_show";
  else if (target === "checked_in" || (target === "checked_out" && !normalized.historical)) {
    if (normalized.roomId) transition = target === "checked_in" ? "check_in" : "check_in_and_out";
    else {
      checkInWithoutRoom = true;
      base.issues.push(issueOf(rowNumber, "RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM", "OPERA la tiene en casa pero la fila no trae una habitación válida: se crea confirmada (asigna la habitación y haz el check-in por recepción).", "habitacion"));
    }
  }
  return { ...base, action: "create", transition, checkInWithoutRoom };
}

// ---------------------------------------------------------------------------
// computeMissing (§5.2)
// ---------------------------------------------------------------------------

/** ¿La ventana del feed para ese business date contiene la estancia? (`changes` no tiene ventana). */
export function syncWindowContains(feed: PmsShadowReservationFeed, businessDate: IsoDate, horizonDays: number, stay: { arrivalDate: IsoDate; departureDate: IsoDate }): boolean {
  switch (feed) {
    case "arrivals":
      return stay.arrivalDate >= businessDate && stay.arrivalDate <= addDaysIso(businessDate, horizonDays);
    case "inhouse":
      return stay.arrivalDate <= businessDate && businessDate < stay.departureDate;
    case "departures":
      return stay.departureDate === businessDate;
    case "changes":
      return false;
    default:
      return false;
  }
}

/**
 * Enlaces con reserva confirmada o alojada cuya estancia cae en la ventana del
 * feed y que NO aparecen en el corte (`seenConfirmationNos`, sin distinguir
 * mayúsculas): candidatos a OPERA_MISSING_IN_SNAPSHOT. Nunca se cancela nada aquí.
 */
export function computeMissing(input: {
  feed: PmsShadowReservationFeed;
  businessDate: IsoDate;
  horizonDays: number;
  links: readonly MissingCandidate[];
  seenConfirmationNos: Iterable<string>;
}): MissingReservation[] {
  const seen = new Set(Array.from(input.seenConfirmationNos, (value) => value.trim().toLowerCase()));
  const out: MissingReservation[] = [];
  for (const link of input.links) {
    if (link.status !== "confirmed" && link.status !== "checked_in") continue;
    if (seen.has(link.confirmationNo.trim().toLowerCase())) continue;
    if (!syncWindowContains(input.feed, input.businessDate, input.horizonDays, link)) continue;
    out.push({ confirmationNo: link.confirmationNo, reservationCode: link.reservationCode, arrivalDate: link.arrivalDate, missingStreak: link.missingStreak });
  }
  return out.sort((a, b) => (a.arrivalDate < b.arrivalDate ? -1 : a.arrivalDate > b.arrivalDate ? 1 : a.confirmationNo < b.confirmationNo ? -1 : 1));
}
