// CLI de la carga REAL de los informes R&A de OPERA Cloud (Tanda 7d · 2026-09-19).
//
// Dos informes por hotel exportados a .xlsx (hoja «Hoja1», fechas en texto DD/MM/YY):
//   · Estancias «<Hotel> - 01.08.26 to 18.09.26.xlsx» (40 columnas; RESV_STATUS literal
//     CHECKED OUT / CHECKED IN / RESERVED / NO SHOW / CANCELLED; ROOM; SHARE_AMOUNT
//     = tarifa/noche y SHARE_AMOUNT_PER_STAY = total de la estancia).
//   · Llegadas «Llegadas - <Hotel> (18.09.26 to 31.12.28).xlsx» (108-119 columnas;
//     una fila por CONFIRMATION_NO y marcador |ROUT / |TRACE / |MEMB / FC → dedupe;
//     DISP_ROOM_NO preasignada; SHARE_AMOUNT = tarifa/noche).
//
// Subcomandos (dry-run por defecto; `--apply` escribe; `--json` salida legible por máquina):
//   prep         xlsx → CSV canónico de 33 campos por hotel y feed (estancias / llegadas),
//                omitidas.csv, inventario.json y RESUMEN.json. Sin BD. Nunca imprime celdas.
//   inventory    alinea tipos y habitaciones de una propiedad con OPERA (servicios de back office).
//   demo-retire  retira reservas de demo: cancelación (transitionReservation) y check-out sombra.
//   apply        carga un CSV del prep con importReservations en modo `sync` (feed arrivals | inhouse).
//   undo         deshace un lote (undoReservationImport: solo draft | confirmed).
//   backfill     corrección posterior a la carga (2026-09-19): garantía, origen del precio, depósito pagado y
//                habitación + Stay de las estancias cerradas que el prep blanqueó por solape histórico.
//   verify       compara la BD con los recuentos de RESUMEN.json y, con --in, con los xlsx BRUTOS de OPERA
//                (recuento por RESV_STATUS antes de excluir pseudo / day-use / > 365: tabla «OPERA bruto → cargado»).
//
// Reglas de datos (runbook reservas-importacion.md §19): pseudo rooms PI / PM y 9000-9500 fuera; day-use
// (NIGHTS = 0) y > 365 noches fuera; `referencia_externa` = RESV_NAME_ID en ambos informes (las RESERVED de
// estancias son las mismas reservas que las llegadas del día del corte); `habitacion` en blanco en canceladas
// y no-show y en la fila que solapa a otra VIVA en la misma habitación (dos estancias cerradas que se solapan
// —cambio de habitación a mitad de estancia— conservan las dos su habitación); `tipo_habitacion` = tipo físico
// de la habitación cuando la categoría reservada difiere; `tarifa` vacía (el apply la ignora); `nombre` y
// `apellidos` ya separados (regla de splitFullName); OUTPUT_DENYLIST: columnas que jamás llegan a la salida.
// Columnas EXTRA del CSV (tras los 33 campos canónicos; el importador las reconoce en modo sync):
// `garantia` (GUARANTEE_CODE real → reservations.guarantee_type), `importe_estimado` («si» cuando el total es
// tarifa × noches → price_source quoted y nunca pisa un total exacto) y `deposito_pagado` (DEPOSIT_PAID →
// reservations.deposit_paid).
//
// Códigos de salida: 0 ok · 1 fallo (validación, lote, BD, verificación con diferencias) · 2 uso.
//
//   cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-opera-reports.ts \
//     prep --in <dir xlsx> --out <dir prep> [--hotel all|AS|LT|MC|PG|RA] [--chunk 5000] [--json]
//     inventory --property <id> --plan <prep/<HOTEL>-inventario.json> [--apply] [--json]
//     demo-retire --property <id> [--cancel RES-1,RES-2] [--checkout RES-3] --reason "…" [--apply] [--json]
//     apply --property <id> --file <prep/<HOTEL>-<feed>.csv> --feed arrivals|inhouse --business-date YYYY-MM-DD [--apply] [--force] [--json]
//     undo --property <id> --import <importId> [--reason "…"] [--json]
//     backfill --property <id> --hotel <AS|LT|MC|PG|RA> --out <dir prep> [--apply] [--json]
//     verify --property <id> --hotel <AS|LT|MC|PG|RA> [--expected <prep/RESUMEN.json>] [--in <dir xlsx>] [--json]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import { RESERVATION_IMPORT_FIELDS, RESERVATION_IMPORT_MAX_ROWS, RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS, type IsoDate, type PermissionKey, type ReservationImportField, type ReservationImportPreview, type ReservationImportPreviewBody, type ReservationImportResult, type ReservationImportUndoResult } from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { HttpError } from "../lib/http-error.js";
import { flushAccountingProjection } from "../modules/accounting/projection.js";
import { flushExtraProjections } from "../modules/accounting/posting-rules/index.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres, recordAuditEvent } from "../modules/audit/audit.service.js";
import { bulkUpdateRooms, createBackOfficeRoomType, deactivateBackOfficeRoomType, patchBackOfficeRoomType } from "../modules/backoffice/backoffice.service.js";
import { systemContext } from "../modules/pms-shadow/pms-shadow.rules.js";
import { createRoom, transitionReservation } from "../modules/pms/pms.service.js";
import { parseCsvTable, parseXlsxTable, type ParsedTable } from "../modules/pms/reservation-import.parser.js";
import { arrivalCheckInAt, importReservations, previewReservationImport, shadowCheckOut, undoReservationImport } from "../modules/pms/reservation-import.service.js";

export const SCRIPT_LABEL = "[opera:reports]";
export const CORRELATION_ID = "corr_opera_reports";
export const SHEET_NAME = "Hoja1";
/** Fecha del corte de los informes reales (business date de OPERA el día de la exportación). */
export const DEFAULT_CUT_DATE: IsoDate = "2026-09-18";

// ---------------------------------------------------------------------------
// Hoteles, tipos OPERA y columnas
// ---------------------------------------------------------------------------

export type OperaHotelCode = "AS" | "LT" | "MC" | "PG" | "RA";

export type OperaHotel = { code: OperaHotelCode; name: string; resort: string };

/** Hotel → nombre tal como aparece en el nombre de fichero del informe y RESORT de OPERA. Sin ids de BD: `--property` siempre explícito. */
export const HOTELS: readonly OperaHotel[] = Object.freeze([
  { code: "AS", name: "Alisas", resort: "ES111" },
  { code: "LT", name: "Los Tilos", resort: "ES105" },
  { code: "MC", name: "Marsol", resort: "ES109" },
  { code: "PG", name: "Pathos", resort: "ES107" },
  { code: "RA", name: "Rías Altas", resort: "ES104" }
]);

export type RoomTypeProposal = { code: string; name: string; maxOccupancy: number; baseCapacity: number; pseudo: boolean };

/**
 * Categorías OPERA (ROOM_CATEGORY_LABEL) observadas en los 5 hoteles → tipo propuesto (nombre por
 * inferencia del código, PENDIENTE de confirmar con `cf_roomtypes`; maxOccupancy = máximo observado;
 * baseCapacity 2 salvo TND* 1). PI (uso de casa) y PM (paymaster) NO son tipos: sus filas se omiten.
 */
export const ROOM_TYPE_PROPOSALS: readonly RoomTypeProposal[] = Object.freeze([
  { code: "DND2", name: "Doble estándar", maxOccupancy: 3, baseCapacity: 2, pseudo: false },
  { code: "DND3", name: "Doble con supletoria / triple", maxOccupancy: 4, baseCapacity: 2, pseudo: false },
  { code: "DND4", name: "Doble superior", maxOccupancy: 4, baseCapacity: 2, pseudo: false },
  { code: "DSD3", name: "Doble superior vista, triple", maxOccupancy: 4, baseCapacity: 2, pseudo: false },
  { code: "DSD4", name: "Doble superior vista mar", maxOccupancy: 4, baseCapacity: 2, pseudo: false },
  { code: "DSD5", name: "Doble superior vista premium", maxOccupancy: 3, baseCapacity: 2, pseudo: false },
  { code: "KND1", name: "Doble cama king", maxOccupancy: 3, baseCapacity: 2, pseudo: false },
  { code: "KND2", name: "Doble king superior", maxOccupancy: 4, baseCapacity: 2, pseudo: false },
  { code: "KNE1", name: "King ejecutiva / familiar", maxOccupancy: 5, baseCapacity: 2, pseudo: false },
  { code: "TND1", name: "Individual", maxOccupancy: 2, baseCapacity: 1, pseudo: false },
  { code: "TND2", name: "Individual superior / doble uso individual", maxOccupancy: 2, baseCapacity: 1, pseudo: false },
  { code: "TND3", name: "Individual superior plus", maxOccupancy: 2, baseCapacity: 1, pseudo: false },
  { code: "PI", name: "Pseudo uso de casa (no es tipo)", maxOccupancy: 0, baseCapacity: 0, pseudo: true },
  { code: "PM", name: "Pseudo paymaster (no es tipo)", maxOccupancy: 0, baseCapacity: 0, pseudo: true }
]);

const PROPOSAL_BY_CODE = new Map(ROOM_TYPE_PROPOSALS.map((proposal) => [proposal.code, proposal] as const));

/** Ocupación máxima de un tipo OPERA; desconocido → 4 (no recorta). */
export function maxOccupancyOf(code: string): number {
  return PROPOSAL_BY_CODE.get(code.toUpperCase())?.maxOccupancy ?? 4;
}

/**
 * Columnas de los informes que JAMÁS llegan a la salida del prep, a los logs ni a las notas
 * (personal de OPERA, tarjetas, direcciones de facturación, acompañantes, fidelización, trazas,
 * cargos fijos, totales de informe). `INSERT_DATE` sí (solo como fecha en las notas).
 */
export const OUTPUT_DENYLIST: Readonly<{ exact: readonly string[]; prefixes: readonly string[] }> = Object.freeze({
  exact: ["INSERT_USER", "UPDATE_USER", "CREDIT_CARD_NUMBER", "EXP_DATE", "BILL_TO_ADDRESS", "SHARE_NAMES", "TRX_STRING", "TRACE_TEXT", "BILL_RESORT", "BILL_RESV", "GUEST_NAME_ID", "LOGO"],
  prefixes: ["ACCOMPANYING_", "MEMBERSHIP_", "FC_", "RC_", "RES_", "S_", "SUM"]
});

export function isDeniedColumn(column: string): boolean {
  const upper = column.trim().toUpperCase();
  if (OUTPUT_DENYLIST.exact.includes(upper)) return true;
  return OUTPUT_DENYLIST.prefixes.some((prefix) => upper.startsWith(prefix));
}

/** Columnas de cada informe que el prep LEE (todas fuera de la denylist; el resto del informe se ignora). */
export const STAY_COLUMNS = ["RESV_NAME_ID", "RESV_STATUS", "ROOM", "FULL_NAME", "ARRIVAL", "DEPARTURE", "NIGHTS", "PERSONS", "NO_OF_ROOMS", "ROOM_CATEGORY_LABEL", "RATE_CODE", "GUARANTEE_CODE", "GUARANTEE_CODE_DESC", "COMPANY_NAME", "TRAVEL_AGENT_NAME", "GROUP_NAME", "SHARE_AMOUNT", "SHARE_AMOUNT_PER_STAY", "COMP_HOUSE_YN", "INSERT_DATE"] as const;
export const ARRIVAL_COLUMNS = ["CONFIRMATION_NO", "RESV_NAME_ID", "EXTERNAL_REFERENCE", "ARRIVAL", "DEPARTURE", "ROOM_CATEGORY_LABEL", "DISP_ROOM_NO", "NO_OF_ROOMS", "ADULTS", "CHILDREN", "PERSONS", "MARKET_CODE", "RATE_CODE", "GUARANTEE_CODE", "COMPANY_NAME", "ORIGIN_OF_BOOKING", "GROUP_ID", "BLOCK_CODE", "VIP", "SHARE_AMOUNT", "CURRENCY_CODE", "DEPOSIT_PAID", "PAYMENT_METHOD", "PRODUCTS", "COMP_HOUSE", "FULL_NAME"] as const;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export const COMMANDS = ["prep", "inventory", "demo-retire", "apply", "undo", "backfill", "verify"] as const;
export type OperaCommand = (typeof COMMANDS)[number];

export type OperaFlags = {
  command: OperaCommand | null;
  in: string | null;
  out: string | null;
  hotel: OperaHotelCode | "all";
  chunk: number;
  property: string | null;
  plan: string | null;
  file: string | null;
  feed: "arrivals" | "inhouse" | null;
  businessDate: string | null;
  importId: string | null;
  reason: string | null;
  cancel: string[];
  checkout: string[];
  expected: string | null;
  apply: boolean;
  force: boolean;
  json: boolean;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env; `prep` no toca la BD):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/import-opera-reports.ts <subcomando> [flags]",
  "",
  "  prep --in <dir> --out <dir> [--hotel all|AS|LT|MC|PG|RA] [--chunk <n>]   xlsx → CSV canónico + omitidas + inventario.json + RESUMEN.json",
  "  inventory --property <id> --plan <inventario.json> [--apply]             tipos OPERA, re-tipado, altas y desactivaciones (dry-run por defecto)",
  "  demo-retire --property <id> [--cancel A,B] [--checkout C] --reason <t> [--apply]",
  "                                                                            cancela (draft|confirmed) y hace el check-out sombra (checked_in) de reservas de demo",
  "  apply --property <id> --file <csv> --feed arrivals|inhouse --business-date <YYYY-MM-DD> [--apply] [--force]",
  "                                                                            importReservations en modo sync (dry-run = previsualización con recuentos)",
  "  undo --property <id> --import <importId> [--reason <t>]                  deshace un lote (solo draft | confirmed)",
  "  backfill --property <id> --hotel <código> --out <dir prep> [--apply]     garantía, origen del precio, depósito pagado y habitación + Stay de las cerradas blanqueadas por solape",
  "  verify --property <id> --hotel <código> [--expected <RESUMEN.json>] [--in <dir xlsx>]",
  "                                                                            compara la BD con el prep y, con --in, con los xlsx brutos de OPERA (tabla OPERA bruto → cargado)",
  "  --json                                                                    salida legible por máquina (solo recuentos y códigos; nunca celdas)",
  "  --help, -h                                                                esta ayuda",
  "",
  "Contexto: usuario de sistema usr_system_pms_shadow (pms-shadow.rules.ts); `inventory` añade property.map.manage.",
  "Códigos de salida: 0 ok · 1 fallo (validación, lote, BD o verificación con diferencias) · 2 flag desconocido / uso."
].join("\n");

export const VALUE_FLAGS = new Set(["--in", "--out", "--hotel", "--chunk", "--property", "--plan", "--file", "--feed", "--business-date", "--import", "--reason", "--cancel", "--checkout", "--expected"]);
const KNOWN_FLAGS = [...VALUE_FLAGS].map((flag) => `${flag} <valor>`).concat(["--apply", "--dry-run", "--force", "--json", "--help"]).join(", ");

function isCommand(value: string): value is OperaCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function isHotelCode(value: string): value is OperaHotelCode {
  return HOTELS.some((hotel) => hotel.code === value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export function parseFlags(argv: readonly string[]): OperaFlags {
  const flags: OperaFlags = {
    command: null,
    in: null,
    out: null,
    hotel: "all",
    chunk: RESERVATION_IMPORT_MAX_ROWS,
    property: null,
    plan: null,
    file: null,
    feed: null,
    businessDate: null,
    importId: null,
    reason: null,
    cancel: [],
    checkout: [],
    expected: null,
    apply: false,
    force: false,
    json: false,
    help: false
  };
  let sawDryRun = false;
  const seen = new Set<string>();
  const once = (name: string): void => {
    if (seen.has(name)) throw new Error(`${name} solo puede indicarse una vez.`);
    seen.add(name);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      if (flags.command !== null) throw new Error(`Solo se admite un subcomando (recibido "${flags.command}" y "${arg}").`);
      if (!isCommand(arg)) throw new Error(`Subcomando desconocido "${arg}". Admitidos: ${COMMANDS.join(", ")}.`);
      flags.command = arg;
      continue;
    }
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`El flag "${arg}" necesita un valor.`);
      const trimmed = value.trim();
      once(arg);
      switch (arg) {
        case "--in":
          flags.in = trimmed;
          break;
        case "--out":
          flags.out = trimmed;
          break;
        case "--hotel":
          if (trimmed !== "all" && !isHotelCode(trimmed)) throw new Error(`--hotel debe ser all o uno de ${HOTELS.map((hotel) => hotel.code).join(", ")} (recibido "${trimmed}").`);
          flags.hotel = trimmed as OperaHotelCode | "all";
          break;
        case "--chunk": {
          const chunk = Number(trimmed);
          if (!Number.isInteger(chunk) || chunk < 1 || chunk > RESERVATION_IMPORT_MAX_ROWS) throw new Error(`--chunk debe ser un entero entre 1 y ${RESERVATION_IMPORT_MAX_ROWS}.`);
          flags.chunk = chunk;
          break;
        }
        case "--property":
          flags.property = trimmed;
          break;
        case "--plan":
          flags.plan = trimmed;
          break;
        case "--file":
          flags.file = trimmed;
          break;
        case "--feed":
          if (trimmed !== "arrivals" && trimmed !== "inhouse") throw new Error(`--feed debe ser arrivals o inhouse (recibido "${trimmed}").`);
          flags.feed = trimmed;
          break;
        case "--business-date":
          if (!isIsoDate(trimmed)) throw new Error(`--business-date debe ser una fecha real YYYY-MM-DD (recibido "${trimmed}").`);
          flags.businessDate = trimmed;
          break;
        case "--import":
          flags.importId = trimmed;
          break;
        case "--reason":
          flags.reason = value.trim();
          break;
        case "--cancel":
          flags.cancel = splitList(trimmed);
          break;
        case "--checkout":
          flags.checkout = splitList(trimmed);
          break;
        default:
          flags.expected = trimmed;
      }
      i++;
    } else throw new Error(`Flag desconocido "${arg}". Admitidos: ${KNOWN_FLAGS}.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run y --apply son excluyentes.");
  if (flags.command === null) throw new Error(`Falta el subcomando (${COMMANDS.join(" | ")}).`);
  switch (flags.command) {
    case "prep":
      if (flags.in === null || flags.out === null) throw new Error("prep exige --in <dir> y --out <dir>.");
      if (flags.apply || flags.force) throw new Error("prep no admite --apply ni --force (siempre escribe en --out y nunca toca la BD).");
      break;
    case "inventory":
      if (flags.property === null || flags.plan === null) throw new Error("inventory exige --property <id> y --plan <inventario.json>.");
      break;
    case "demo-retire":
      if (flags.property === null) throw new Error("demo-retire exige --property <id>.");
      if (flags.cancel.length === 0 && flags.checkout.length === 0) throw new Error("demo-retire exige --cancel y/o --checkout con códigos de reserva.");
      if (flags.apply && (flags.reason === null || flags.reason === "")) throw new Error("demo-retire --apply exige --reason.");
      break;
    case "apply":
      if (flags.property === null || flags.file === null || flags.feed === null || flags.businessDate === null) throw new Error("apply exige --property, --file, --feed (arrivals | inhouse) y --business-date.");
      break;
    case "undo":
      if (flags.property === null || flags.importId === null) throw new Error("undo exige --property <id> y --import <importId>.");
      break;
    case "backfill":
      if (flags.property === null || flags.out === null || flags.hotel === "all") throw new Error("backfill exige --property <id>, --hotel <código> y --out <dir prep>.");
      break;
    case "verify":
      if (flags.property === null || flags.hotel === "all" || (flags.expected === null && flags.in === null)) throw new Error("verify exige --property <id>, --hotel <código> y al menos uno de --expected <RESUMEN.json> o --in <dir xlsx>.");
      break;
    default:
      break;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = Object.freeze({ JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 });

function ymd(year: number, month: number, day: number): IsoDate | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** «DD/MM/YY» (ARRIVAL, DEPARTURE, INSERT_DATE) o «DD-MON-YY» (UPDATE_DATE) → ISO (siglo 20YY); inválida → null. */
export function parseOperaDate(raw: string): IsoDate | null {
  const text = raw.trim();
  let match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(text);
  if (match) return ymd(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{2})-([A-Za-z]{3})-(\d{2})$/.exec(text);
  if (match) {
    const month = MONTHS[match[2]!.toUpperCase()];
    return month ? ymd(2000 + Number(match[3]), month, Number(match[1])) : null;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return ymd(Number(match[1]), Number(match[2]), Number(match[3]));
  return null;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Pseudo room de OPERA: categoría PI / PM o habitación 9000-9500 (uso de casa, paymaster). */
export function isPseudoCategory(category: string, room: string): boolean {
  const code = category.trim().toUpperCase();
  if (code === "PI" || code === "PM") return true;
  const number = Number(room.trim());
  return Number.isInteger(number) && number >= 9000 && number <= 9500;
}

/** Importe OPERA (texto «238», «1931.5», «97,75») → «238,00» (dos decimales, coma); vacío o no numérico → «». */
export function formatAmount(raw: string): string {
  const text = raw.trim().replace(/\s/g, "");
  if (text === "") return "";
  const normalized = /^-?\d+,\d+$/.test(text) ? text.replace(",", ".") : text;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return "";
  return (Math.round(Math.abs(value) * 100) / 100).toFixed(2).replace(".", ",");
}

/** Importe × noches (para llegadas: SHARE_AMOUNT es tarifa/noche); vacío si no hay tarifa. */
export function formatAmountTimes(raw: string, factor: number): string {
  const text = raw.trim().replace(/\s/g, "");
  if (text === "") return "";
  const value = Number(/^-?\d+,\d+$/.test(text) ? text.replace(",", ".") : text);
  if (!Number.isFinite(value)) return "";
  return (Math.round(Math.abs(value) * factor * 100) / 100).toFixed(2).replace(".", ",");
}

export type SplitName = { firstName: string; surnames: string; kind: "comma" | "no_comma" | "single" };

/**
 * FULL_NAME de OPERA → nombre / apellidos con la MISMA regla que `splitFullName` del importador:
 * «Apellidos, Nombre» → apellidos = antes de la coma, nombre = después; sin coma → nombre = primer
 * token y apellidos = resto; un solo token → nombre = apellidos = token (ninguna fila cae en MISSING_FIELD).
 */
export function splitOperaName(raw: string): SplitName {
  const text = raw.replace(/\s+/g, " ").trim();
  const comma = text.indexOf(",");
  if (comma >= 0) {
    const surnames = text.slice(0, comma).trim();
    const firstName = text.slice(comma + 1).trim();
    if (surnames !== "" && firstName !== "") return { firstName, surnames, kind: "comma" };
    const single = (surnames || firstName).trim();
    return { firstName: single, surnames: single, kind: "single" };
  }
  const tokens = text.split(" ").filter((token) => token !== "");
  if (tokens.length <= 1) {
    const single = tokens[0] ?? "";
    return { firstName: single, surnames: single, kind: "single" };
  }
  return { firstName: tokens[0]!, surnames: tokens.slice(1).join(" "), kind: "no_comma" };
}

/** Planta derivada del número («001» → «0», «101» → «1», «1001» → «10»). */
export function floorOf(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length <= 2) return "0";
  return String(Number(digits.slice(0, -2)));
}

export function chunkRows<T>(rows: readonly T[], size: number = RESERVATION_IMPORT_MAX_ROWS): T[][] {
  const max = Math.max(1, Math.min(size, RESERVATION_IMPORT_MAX_ROWS));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max));
  return out.length === 0 ? [[]] : out;
}

export function csvCell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Columnas EXTRA del CSV canónico (tras los 33 campos; el importador las reconoce por nombre en modo sync
 * —`resolveExtraColumns` de reservation-import.service.ts— y no tienen campo canónico en RESERVATION_IMPORT_FIELDS):
 *   · `garantia`: GUARANTEE_CODE real (CC, 4P, 6P, DB, PD, DP, DP-REC, VC, DG, TG, PG, GM) → `guarantee_type`;
 *   · `importe_estimado`: «si» cuando `importe_total` es tarifa × noches (llegadas) → `price_source = quoted`
 *     y el importe NUNCA pisa el total exacto de una reserva enlazada;
 *   · `deposito_pagado`: DEPOSIT_PAID (ya cobrado en OPERA) → `deposit_paid` (además de `deposito`).
 */
export const OPERA_EXTRA_FIELDS = ["garantia", "importe_estimado", "deposito_pagado"] as const;
export type OperaExtraField = (typeof OPERA_EXTRA_FIELDS)[number];
export const CANONICAL_HEADER: readonly string[] = Object.freeze([...RESERVATION_IMPORT_FIELDS, ...OPERA_EXTRA_FIELDS]);

/** Literales de estado que OPERA escribe en GUARANTEE_CODE de las estancias alojadas / cerradas: no son garantía. */
const GUARANTEE_STATUS_LITERALS = new Set(["CHECKED IN", "CHECKED OUT", "RESERVED", "CANCELLED", "NO SHOW", "DUE OUT", "DUE IN"]);

/** Código de garantía real de la fila («» si OPERA puso un literal de estado o nada). */
export function guaranteeOf(code: string): string {
  const upper = code.trim().toUpperCase();
  if (upper === "" || GUARANTEE_STATUS_LITERALS.has(upper)) return "";
  return upper;
}

/** Fila del CSV canónico leída por el `backfill` (solo lo que necesita; nunca se imprime). */
export type CanonicalRow = { rowNumber: number; reference: string; estado: string; habitacion: string; notas: string; garantia: string; importeEstimado: boolean; depositoPagado: string };

/** Lee un CSV canónico escrito por `toCanonicalCsv` (33 campos + extras) e indexa por referencia externa (gana la primera). Puro. */
export function readCanonicalCsv(text: string): { rows: CanonicalRow[]; byReference: Map<string, CanonicalRow> } {
  const table = parseCsvTable(text);
  const index = indexColumns(table.header);
  const missing = ["referencia_externa", "estado", "habitacion", "notas"].filter((column) => !index.has(column.toUpperCase()));
  if (missing.length > 0) throw new Error(`CSV canónico sin las columnas ${missing.join(", ")}.`);
  const rows: CanonicalRow[] = [];
  const byReference = new Map<string, CanonicalRow>();
  for (const parsed of table.rows) {
    const get = (column: string): string => {
      const position = index.get(column.toUpperCase());
      return position === undefined ? "" : (parsed.cells[position] ?? "").trim();
    };
    const row: CanonicalRow = {
      rowNumber: parsed.rowNumber,
      reference: get("referencia_externa"),
      estado: get("estado").toUpperCase(),
      habitacion: get("habitacion"),
      notas: get("notas"),
      garantia: guaranteeOf(get("garantia")),
      importeEstimado: /^(si|sí|s|1|true|yes)$/i.test(get("importe_estimado")),
      depositoPagado: formatAmount(get("deposito_pagado"))
    };
    rows.push(row);
    if (row.reference !== "" && !byReference.has(row.reference)) byReference.set(row.reference, row);
  }
  return { rows, byReference };
}

/** CSV canónico: separador «;», UTF-8 con BOM, cabecera = los 33 campos en su orden + las 3 columnas extra. */
export function toCanonicalCsv(rows: readonly (readonly string[])[]): string {
  const lines = [CANONICAL_HEADER.join(";"), ...rows.map((row) => row.map(csvCell).join(";"))];
  return `\uFEFF${lines.join("\n")}\n`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Lectura de los informes (por NOMBRE de cabecera; la posición cambia entre hoteles)
// ---------------------------------------------------------------------------

export type ColumnIndex = Map<string, number>;

export function indexColumns(header: readonly string[]): ColumnIndex {
  const index: ColumnIndex = new Map();
  header.forEach((column, position) => {
    const key = column.trim().toUpperCase();
    if (key !== "" && !index.has(key)) index.set(key, position);
  });
  return index;
}

/** Celda por nombre de columna; una columna de la denylist nunca se lee (error de programación, no de datos). */
export function cellByName(cells: readonly string[], index: ColumnIndex, column: string): string {
  if (isDeniedColumn(column)) throw new Error(`La columna ${column} está en OUTPUT_DENYLIST y no se lee.`);
  const position = index.get(column.toUpperCase());
  return position === undefined ? "" : (cells[position] ?? "").trim();
}

export function requireColumns(index: ColumnIndex, columns: readonly string[], file: string): void {
  const missing = columns.filter((column) => !index.has(column));
  if (missing.length > 0) throw new Error(`${file}: faltan columnas ${missing.join(", ")}.`);
}

/** Fila intermedia común a estancias y llegadas (todo lo que escribe el CSV canónico; sin columnas de la denylist). */
export type OperaRow = {
  kind: "stay" | "arrival";
  rowNumber: number;
  reference: string;
  confirmationNo: string;
  externalReference: string;
  status: string;
  arrival: IsoDate;
  departure: IsoDate;
  nights: number;
  category: string;
  roomType: string;
  room: string;
  roomOpera: string;
  roomsCount: number;
  adults: number;
  children: number;
  personsOpera: number | null;
  fullName: string;
  company: string;
  agency: string;
  group: string;
  channel: string;
  segment: string;
  payment: string;
  vip: string;
  deposit: string;
  total: string;
  currency: string;
  rateCode: string;
  ratePerNight: string;
  guarantee: string;
  guaranteeDesc: string;
  market: string;
  origin: string;
  groupId: string;
  blockCode: string;
  products: string;
  vipLevel: string;
  compHouse: string;
  insertDate: string;
  paymentCode: string;
  estimatedTotal: boolean;
  enriched: boolean;
};

export type OmittedRow = { rowNumber: number; reference: string; reason: "pseudo" | "day_use" | "over_365" | "invalid_date" | "duplicate"; status: string; category: string; room: string };

function baseRow(kind: OperaRow["kind"], rowNumber: number): OperaRow {
  return {
    kind,
    rowNumber,
    reference: "",
    confirmationNo: "",
    externalReference: "",
    status: "",
    arrival: "",
    departure: "",
    nights: 0,
    category: "",
    roomType: "",
    room: "",
    roomOpera: "",
    roomsCount: 1,
    adults: 1,
    children: 0,
    personsOpera: null,
    fullName: "",
    company: "",
    agency: "",
    group: "",
    channel: "",
    segment: "",
    payment: "",
    vip: "",
    deposit: "",
    total: "",
    currency: "EUR",
    rateCode: "",
    ratePerNight: "",
    guarantee: "",
    guaranteeDesc: "",
    market: "",
    origin: "",
    groupId: "",
    blockCode: "",
    products: "",
    vipLevel: "",
    compHouse: "",
    insertDate: "",
    paymentCode: "",
    estimatedTotal: false,
    enriched: false
  };
}

function intOf(raw: string, fallback: number): number {
  const value = Number(raw.trim());
  return Number.isInteger(value) ? value : fallback;
}

/** Quita el prefijo «T- » / «C- » de COMPANY_NAME de llegadas. */
export function stripPartyPrefix(raw: string): { kind: "agency" | "company" | "none"; name: string } {
  const text = raw.trim();
  if (/^T-\s*/i.test(text)) return { kind: "agency", name: text.replace(/^T-\s*/i, "").trim() };
  if (/^C-\s*/i.test(text)) return { kind: "company", name: text.replace(/^C-\s*/i, "").trim() };
  return { kind: "none", name: text };
}

export type ReadResult = { rows: OperaRow[]; omitted: OmittedRow[] };

/** Estancias: una fila por reserva; pseudo, day-use, > 365 noches y fechas ilegibles → omitidas. */
export function readStayRows(table: Pick<ParsedTable, "header" | "rows">, file = "estancias"): ReadResult {
  const index = indexColumns(table.header);
  requireColumns(index, STAY_COLUMNS, file);
  const rows: OperaRow[] = [];
  const omitted: OmittedRow[] = [];
  for (const parsed of table.rows) {
    const get = (column: string): string => cellByName(parsed.cells, index, column);
    const reference = get("RESV_NAME_ID");
    const status = get("RESV_STATUS").toUpperCase();
    const category = get("ROOM_CATEGORY_LABEL").toUpperCase();
    const room = get("ROOM");
    const omit = (reason: OmittedRow["reason"]): void => {
      omitted.push({ rowNumber: parsed.rowNumber, reference, reason, status, category, room });
    };
    if (isPseudoCategory(category, room)) {
      omit("pseudo");
      continue;
    }
    const arrival = parseOperaDate(get("ARRIVAL"));
    const departure = parseOperaDate(get("DEPARTURE"));
    if (!arrival || !departure) {
      omit("invalid_date");
      continue;
    }
    const nights = intOf(get("NIGHTS"), daysBetween(arrival, departure));
    if (nights <= 0) {
      omit("day_use");
      continue;
    }
    if (nights > 365) {
      omit("over_365");
      continue;
    }
    const row = baseRow("stay", parsed.rowNumber);
    row.reference = reference;
    row.status = status;
    row.arrival = arrival;
    row.departure = departure;
    row.nights = nights;
    row.category = category;
    row.roomType = category;
    row.room = room;
    row.roomsCount = Math.max(1, intOf(get("NO_OF_ROOMS"), 1));
    row.adults = intOf(get("PERSONS"), 1);
    row.fullName = get("FULL_NAME");
    row.company = get("COMPANY_NAME");
    row.agency = get("TRAVEL_AGENT_NAME");
    row.group = get("GROUP_NAME");
    row.rateCode = get("RATE_CODE").toUpperCase();
    row.ratePerNight = formatAmount(get("SHARE_AMOUNT"));
    row.total = formatAmount(get("SHARE_AMOUNT_PER_STAY")) || "0,00";
    row.guarantee = get("GUARANTEE_CODE").toUpperCase();
    row.guaranteeDesc = get("GUARANTEE_CODE_DESC");
    row.compHouse = get("COMP_HOUSE_YN").toUpperCase();
    row.insertDate = parseOperaDate(get("INSERT_DATE")) ?? "";
    row.channel = deriveChannel(row);
    row.segment = deriveSegment(row);
    row.payment = mapGuarantee(row.guarantee);
    rows.push(row);
  }
  return { rows, omitted };
}

/** Llegadas: una fila por CONFIRMATION_NO (gana la primera; las repetidas son marcadores |ROUT / |TRACE / |MEMB / FC). */
export function dedupeArrivals<T extends { rowNumber: number; cells: readonly string[] }>(rows: readonly T[], index: ColumnIndex): { unique: T[]; duplicates: number[] } {
  const position = index.get("CONFIRMATION_NO");
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicates: number[] = [];
  for (const row of rows) {
    const key = position === undefined ? "" : (row.cells[position] ?? "").trim();
    if (key !== "" && seen.has(key)) {
      duplicates.push(row.rowNumber);
      continue;
    }
    if (key !== "") seen.add(key);
    unique.push(row);
  }
  return { unique, duplicates };
}

export function readArrivalRows(table: Pick<ParsedTable, "header" | "rows">, file = "llegadas"): ReadResult & { duplicates: number } {
  const index = indexColumns(table.header);
  requireColumns(index, ARRIVAL_COLUMNS, file);
  const { unique, duplicates } = dedupeArrivals(table.rows, index);
  const rows: OperaRow[] = [];
  const omitted: OmittedRow[] = duplicates.map((rowNumber) => ({ rowNumber, reference: "", reason: "duplicate" as const, status: "RESERVED", category: "", room: "" }));
  for (const parsed of unique) {
    const get = (column: string): string => cellByName(parsed.cells, index, column);
    const reference = get("RESV_NAME_ID");
    const category = get("ROOM_CATEGORY_LABEL").toUpperCase();
    const room = get("DISP_ROOM_NO");
    if (isPseudoCategory(category, room)) {
      omitted.push({ rowNumber: parsed.rowNumber, reference, reason: "pseudo", status: "RESERVED", category, room });
      continue;
    }
    const arrival = parseOperaDate(get("ARRIVAL"));
    const departure = parseOperaDate(get("DEPARTURE"));
    if (!arrival || !departure) {
      omitted.push({ rowNumber: parsed.rowNumber, reference, reason: "invalid_date", status: "RESERVED", category, room });
      continue;
    }
    const nights = daysBetween(arrival, departure);
    if (nights <= 0) {
      omitted.push({ rowNumber: parsed.rowNumber, reference, reason: "day_use", status: "RESERVED", category, room });
      continue;
    }
    if (nights > 365) {
      omitted.push({ rowNumber: parsed.rowNumber, reference, reason: "over_365", status: "RESERVED", category, room });
      continue;
    }
    const row = baseRow("arrival", parsed.rowNumber);
    row.reference = reference;
    row.confirmationNo = get("CONFIRMATION_NO");
    row.externalReference = get("EXTERNAL_REFERENCE");
    row.status = "RESERVED";
    row.arrival = arrival;
    row.departure = departure;
    row.nights = nights;
    row.category = category;
    row.roomType = category;
    row.room = room;
    row.roomsCount = Math.max(1, intOf(get("NO_OF_ROOMS"), 1));
    row.adults = intOf(get("ADULTS"), intOf(get("PERSONS"), 1));
    row.children = Math.max(0, intOf(get("CHILDREN"), 0));
    row.fullName = get("FULL_NAME");
    const party = stripPartyPrefix(get("COMPANY_NAME"));
    if (party.kind === "agency") row.agency = party.name;
    else if (party.kind === "company") row.company = party.name;
    else row.company = party.name;
    row.groupId = get("GROUP_ID");
    row.blockCode = get("BLOCK_CODE");
    row.group = row.blockCode;
    row.market = get("MARKET_CODE").toUpperCase();
    row.origin = get("ORIGIN_OF_BOOKING").toUpperCase();
    row.rateCode = get("RATE_CODE").toUpperCase();
    row.ratePerNight = formatAmount(get("SHARE_AMOUNT"));
    row.total = formatAmountTimes(get("SHARE_AMOUNT"), nights) || "0,00";
    row.estimatedTotal = true;
    row.currency = get("CURRENCY_CODE").toUpperCase() || "EUR";
    const deposit = formatAmount(get("DEPOSIT_PAID"));
    row.deposit = deposit !== "" && deposit !== "0,00" ? deposit : "";
    row.guarantee = get("GUARANTEE_CODE").toUpperCase();
    row.vipLevel = get("VIP");
    row.vip = row.vipLevel !== "" ? "si" : "";
    row.products = get("PRODUCTS");
    row.compHouse = get("COMP_HOUSE").toUpperCase();
    row.paymentCode = get("PAYMENT_METHOD").toUpperCase();
    row.channel = deriveChannel(row);
    row.segment = deriveSegment(row);
    row.payment = mapPayment(row.paymentCode) || mapGuarantee(row.guarantee);
    rows.push(row);
  }
  return { rows, omitted, duplicates: duplicates.length };
}

// ---------------------------------------------------------------------------
// Canal, segmento, pago y garantía
// ---------------------------------------------------------------------------

const AGENCY_CHANNELS: ReadonlyArray<{ channel: string; terms: readonly string[] }> = [
  { channel: "booking_com", terms: ["BOOKING"] },
  { channel: "expedia", terms: ["EXPEDIA", "TRAVELSCAPE"] },
  { channel: "hotels_com", terms: ["HOTELS.COM", "HOTELS COM"] },
  { channel: "ota", terms: ["AGODA", "TRIP.COM", "TRIP .COM", "ODIGEO", "EDREAMS", "OPODO"] },
  { channel: "wholesale", terms: ["WORLD 2 MEET", "WORLD2MEET", "JUMBONLINE", "JUMBO_WEB", "NTINCOMING", "HOTELBEDS", "WEBBEDS", "SERHS", "ROIBACK", "TRANSERNAGA", "NUEVO COLOR"] }
];

const COMP_RATE_CODES = new Set(["SZHOUS", "LHOUS", "LCOMPL", "SZCOMP"]);
const COMP_HOUSE_FLAGS = new Set(["C", "H", "HC"]);

/** Canal por nombre de agencia: diccionario de OTAs y mayoristas; otra agencia → agency; vacío → null. */
export function channelOfAgency(agency: string): string | null {
  const upper = agency.trim().toUpperCase();
  if (upper === "") return null;
  if (upper === "TIP") return "wholesale";
  for (const rule of AGENCY_CHANNELS) if (rule.terms.some((term) => upper.includes(term))) return rule.channel;
  return "agency";
}

const ORIGIN_CHANNELS: Readonly<Record<string, string>> = Object.freeze({ WEB: "direct", EML: "email", WLK: "walk_in", WKI: "walk_in", CRS: "gds", SAL: "corporate", SLC: "corporate", HTP: "phone", XX: "direct", GPI: "direct", HSE: "direct" });

export function isComplimentary(row: Pick<OperaRow, "rateCode" | "compHouse">): boolean {
  return COMP_RATE_CODES.has(row.rateCode) || COMP_HOUSE_FLAGS.has(row.compHouse);
}

/**
 * Canal canónico (14 valores de RESERVATION_IMPORT_CHANNELS). Estancias: agencia → diccionario; solo
 * empresa → corporate; grupo o tarifa LGRU* → group; cortesía / uso de casa → direct; resto → direct.
 * Llegadas: COMPANY_NAME («T- » agencia / «C- » empresa) con el mismo diccionario; si no, ORIGIN_OF_BOOKING
 * (WEB direct · EML email · WLK/WKI walk_in · CRS gds · SAL/SLC corporate · HTP phone · XX/GPI/HSE direct);
 * un origen no cubierto se escribe tal cual (el importador lo pliega y avisa CHANNEL_UNKNOWN).
 */
export function deriveChannel(row: Pick<OperaRow, "kind" | "agency" | "company" | "group" | "rateCode" | "compHouse" | "origin">): string {
  const byAgency = channelOfAgency(row.agency);
  if (byAgency) return byAgency;
  if (row.company.trim() !== "") return "corporate";
  if (row.kind === "stay") {
    if (row.group.trim() !== "" || row.rateCode.startsWith("LGRU")) return "group";
    return "direct";
  }
  const origin = row.origin.trim().toUpperCase();
  if (origin === "") return "direct";
  return ORIGIN_CHANNELS[origin] ?? origin;
}

const MARKET_SEGMENTS: Readonly<Record<string, string>> = Object.freeze({ CORP: "corporate", COMP: "complimentary", TACO: "wholesale", FLEX: "leisure", PKG: "leisure", OPBU: "leisure", PREP: "leisure", QUAL: "leisure", XXX: "leisure" });

/**
 * Segmento canónico. Llegadas: MARKET_CODE (GR_* group · CORP corporate · COMP complimentary · TACO wholesale ·
 * FLEX/PKG/OPBU/PREP/QUAL/XXX leisure; otro tal cual). Estancias: cortesía / uso de casa → complimentary;
 * empresa → corporate; GROUP_NAME → group; agencia mayorista → wholesale; resto → leisure.
 */
export function deriveSegment(row: Pick<OperaRow, "kind" | "market" | "company" | "group" | "agency" | "rateCode" | "compHouse">): string {
  if (row.kind === "arrival") {
    const market = row.market.trim().toUpperCase();
    if (market === "") return "leisure";
    if (market.startsWith("GR_")) return "group";
    return MARKET_SEGMENTS[market] ?? market;
  }
  if (isComplimentary(row)) return "complimentary";
  if (row.company.trim() !== "") return "corporate";
  if (row.group.trim() !== "" || row.rateCode.startsWith("LGRU")) return "group";
  if (channelOfAgency(row.agency) === "wholesale") return "wholesale";
  return "leisure";
}

const PAYMENT_METHODS: Readonly<Record<string, string>> = Object.freeze({ CA: "cash", EF: "cash", MC: "credit_card", VI: "credit_card", AX: "credit_card", DB: "company_invoice", TR: "bank_transfer", BOO: "online_prepaid", DEPFW: "online_prepaid", EXP: "online_prepaid" });

/** PAYMENT_METHOD de llegadas → metodo_pago canónico; desconocido o vacío → «». */
export function mapPayment(code: string): string {
  return PAYMENT_METHODS[code.trim().toUpperCase()] ?? "";
}

const GUARANTEE_PAYMENTS: Readonly<Record<string, string>> = Object.freeze({ CC: "credit_card", DB: "company_invoice", PD: "online_prepaid", DP: "bank_transfer", "DP-REC": "bank_transfer", "DP-R": "bank_transfer", VC: "voucher" });

/** GUARANTEE_CODE → metodo_pago cuando no hay PAYMENT_METHOD (4P/6P/DG/TG/PG/GM/CHECKED IN → «»). */
export function mapGuarantee(code: string): string {
  return GUARANTEE_PAYMENTS[code.trim().toUpperCase()] ?? "";
}

// ---------------------------------------------------------------------------
// Inventario físico, habitaciones en blanco, ocupación, enriquecimiento y orden
// ---------------------------------------------------------------------------

export type RoomCatalog = Map<string, { type: string; categories: Record<string, number> }>;

/** Habitación → categoría dominante (moda) a partir de las filas con habitación y categoría real. */
export function buildRoomCatalog(rows: readonly Pick<OperaRow, "room" | "category">[]): RoomCatalog {
  const counts = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const room = row.room.trim();
    const category = row.category.trim().toUpperCase();
    if (room === "" || category === "" || isPseudoCategory(category, room)) continue;
    const entry = counts.get(room) ?? {};
    entry[category] = (entry[category] ?? 0) + 1;
    counts.set(room, entry);
  }
  const catalog: RoomCatalog = new Map();
  for (const [room, categories] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "es", { numeric: true }))) {
    const dominant = Object.entries(categories).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    catalog.set(room, { type: dominant[0], categories });
  }
  return catalog;
}

/** Tipo físico de la habitación según el catálogo; null si la habitación no está. */
export function physicalTypeOf(room: string, catalog: RoomCatalog): string | null {
  return catalog.get(room.trim())?.type ?? null;
}

/** `tipo_habitacion` = tipo físico cuando difiere de la categoría reservada (evita ROOM_TYPE_MISMATCH); devuelve cuántas cambió. */
export function applyPhysicalTypes(rows: OperaRow[], catalog: RoomCatalog): number {
  let applied = 0;
  for (const row of rows) {
    if (row.room === "") continue;
    const physical = physicalTypeOf(row.room, catalog);
    if (physical && physical !== row.roomType) {
      row.roomType = physical;
      applied += 1;
    }
  }
  return applied;
}

const DEAD_STATUSES = new Set(["CANCELLED", "NO SHOW"]);

function overlaps(a: OperaRow, b: OperaRow): boolean {
  return a.arrival < b.departure && b.arrival < a.departure;
}

function blankRoom(row: OperaRow): void {
  if (row.room === "") return;
  row.roomOpera = row.room;
  row.room = "";
}

/** Estancia cerrada en OPERA: su habitación es historia (cambio de habitación a mitad de estancia = dos filas solapadas). */
function isClosedStay(row: Pick<OperaRow, "status">): boolean {
  return row.status === "CHECKED OUT";
}

/**
 * Habitación en blanco (el número va a las notas) en canceladas y no-show (no consumen inventario y el
 * importador no mira el estado al detectar solapes) y, en cada solape habitación-noche dentro del
 * fichero en el que al menos una fila está VIVA (CHECKED IN / RESERVED), en la fila que NO es CHECKED IN
 * (si ninguna lo es, la de llegada posterior). Dos CHECKED OUT que se solapan (cambio de habitación a
 * mitad de estancia: OPERA refleja la última en ROOM) CONSERVAN las dos su habitación: el importador crea
 * la estancia cerrada con su `Stay` sin validar cupo (corrección FO-04, 2026-09-19; antes se blanqueaba la
 * posterior y 26 estancias cerradas quedaron sin habitación ni `Stay`). Devuelve recuentos
 * (`historicalKept` = pares de cerradas solapadas que se conservan).
 */
export function blankOverlappingRooms(rows: OperaRow[]): { dead: number; overlap: number; historicalKept: number } {
  let dead = 0;
  let historicalKept = 0;
  for (const row of rows) {
    if (DEAD_STATUSES.has(row.status) && row.room !== "") {
      blankRoom(row);
      dead += 1;
    }
  }
  const byRoom = new Map<string, OperaRow[]>();
  for (const row of [...rows].sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : a.rowNumber - b.rowNumber))) {
    if (row.room === "") continue;
    const kept = byRoom.get(row.room) ?? [];
    byRoom.set(row.room, kept);
    const clashes = kept.filter((other) => overlaps(other, row));
    const liveClash = clashes.find((other) => !(isClosedStay(other) && isClosedStay(row)));
    if (clashes.length === 0 || !liveClash) {
      if (clashes.length > 0) historicalKept += clashes.length;
      kept.push(row);
      continue;
    }
    if (row.status === "CHECKED IN" && liveClash.status !== "CHECKED IN") {
      blankRoom(liveClash);
      kept.splice(kept.indexOf(liveClash), 1);
      kept.push(row);
    } else blankRoom(row);
  }
  const overlap = rows.filter((row) => row.roomOpera !== "" && !DEAD_STATUSES.has(row.status)).length;
  return { dead, overlap, historicalKept };
}

/** PERSONS 0 → 1; adultos + niños > máximo del tipo → recorte (nota «PERSONS OPERA n»). Devuelve cuántas recortó. */
export function clampOccupancy(rows: OperaRow[]): number {
  let clamped = 0;
  for (const row of rows) {
    const max = Math.max(1, maxOccupancyOf(row.roomType) * Math.max(1, row.roomsCount));
    const persons = row.adults + row.children;
    if (row.adults < 1) row.adults = 1;
    if (row.adults + row.children > max) {
      row.personsOpera = persons;
      row.children = Math.min(row.children, max - 1);
      row.adults = max - row.children;
      clamped += 1;
    }
  }
  return clamped;
}

/**
 * C9: las filas RESERVED de estancias son las llegadas del día del corte; toman de su fila de llegadas
 * (mismo RESV_NAME_ID) canal, segmento, método de pago, VIP, depósito, grupo / bloque, ocupación y los
 * datos de las notas, para que el segundo lote solo actualice `importe_total` (y el nombre completo de
 * agencia / empresa, que en llegadas viene truncado a 20 caracteres). Devuelve cuántas enriqueció.
 */
export function enrichReservedFromArrivals(stays: OperaRow[], arrivals: readonly OperaRow[]): number {
  const byReference = new Map(arrivals.map((row) => [row.reference, row] as const));
  let enriched = 0;
  for (const stay of stays) {
    if (stay.status !== "RESERVED") continue;
    const arrival = byReference.get(stay.reference);
    if (!arrival) continue;
    stay.channel = arrival.channel;
    stay.segment = arrival.segment;
    stay.payment = arrival.payment;
    stay.paymentCode = arrival.paymentCode;
    stay.vip = arrival.vip;
    stay.vipLevel = arrival.vipLevel;
    stay.deposit = arrival.deposit;
    stay.group = arrival.group;
    stay.groupId = arrival.groupId;
    stay.blockCode = arrival.blockCode;
    stay.adults = arrival.adults;
    stay.children = arrival.children;
    stay.confirmationNo = arrival.confirmationNo;
    stay.externalReference = arrival.externalReference;
    stay.market = arrival.market;
    stay.origin = arrival.origin;
    stay.products = arrival.products;
    if (stay.compHouse === "") stay.compHouse = arrival.compHouse;
    // La garantía real está en la llegada (SHORT_RESV_STATUS); la estancia puede traer un literal de estado.
    if (guaranteeOf(stay.guarantee) === "" && guaranteeOf(arrival.guarantee) !== "") {
      stay.guarantee = arrival.guarantee;
      stay.guaranteeDesc = arrival.guaranteeDesc;
    }
    stay.enriched = true;
    enriched += 1;
  }
  return enriched;
}

const STATUS_RANK: Readonly<Record<string, number>> = Object.freeze({ CANCELLED: 0, "NO SHOW": 1, "CHECKED OUT": 2, RESERVED: 3, "CHECKED IN": 4 });

/** Orden determinista de estancias: CANCELLED, NO SHOW, CHECKED OUT, RESERVED y CHECKED IN al final; dentro, por llegada y referencia. */
export function orderStayRows(rows: readonly OperaRow[]): OperaRow[] {
  return [...rows].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (rank !== 0) return rank;
    if (a.arrival !== b.arrival) return a.arrival < b.arrival ? -1 : 1;
    return a.reference.localeCompare(b.reference, "es", { numeric: true }) || a.rowNumber - b.rowNumber;
  });
}

// ---------------------------------------------------------------------------
// Notas y fila canónica
// ---------------------------------------------------------------------------

/** Notas con formato fijo (solo códigos, fechas e importes de OPERA; nunca usuarios de OPERA ni datos de tarjeta). */
export function buildNotes(row: OperaRow): string {
  const parts: string[] = ["OPERA"];
  const push = (label: string, value: string): void => {
    if (value.trim() !== "") parts.push(`${label} ${value.trim()}`);
  };
  push("conf", row.confirmationNo);
  push("ext", row.externalReference);
  if (row.guarantee !== "") parts.push(`garantía ${row.guarantee}${row.guaranteeDesc ? ` (${row.guaranteeDesc})` : ""}`);
  push("tarifa", row.rateCode);
  push("tarifa/noche", row.ratePerNight);
  push("pago", row.paymentCode);
  push("mercado", row.market);
  push("origen", row.origin);
  push("categoría", row.category);
  if (row.groupId !== "" || row.blockCode !== "") parts.push(`bloque ${row.groupId}/${row.blockCode}`);
  push("productos", row.products);
  push("VIP", row.vipLevel);
  push("comp", row.compHouse);
  push("creada", row.insertDate);
  push("hab. OPERA", row.roomOpera);
  if (row.personsOpera !== null) parts.push(`PERSONS OPERA ${row.personsOpera}`);
  if (row.estimatedTotal) parts.push("importe estimado tarifa×noches");
  return parts.join(" · ").slice(0, 2000);
}

/** Los 33 campos canónicos en el orden de RESERVATION_IMPORT_FIELDS; `tarifa`, `regimen`, contacto y documento vacíos. */
export function toCanonicalRow(row: OperaRow): string[] {
  const name = splitOperaName(row.fullName);
  const values: Record<ReservationImportField, string> = {
    referencia_externa: row.reference,
    llegada: row.arrival,
    salida: row.departure,
    noches: String(row.nights),
    tipo_habitacion: row.roomType,
    tarifa: "",
    habitacion: row.room,
    habitaciones: String(row.roomsCount),
    adultos: String(row.adults),
    ninos: String(row.children),
    bebes: "",
    regimen: "",
    canal: row.channel,
    segmento: row.segment,
    estado: row.status,
    nombre: name.firstName,
    apellidos: name.surnames,
    email: "",
    telefono: "",
    nacionalidad: "",
    documento_tipo: "",
    documento_numero: "",
    empresa: row.company.slice(0, 200),
    agencia: row.agency.slice(0, 200),
    grupo: row.group.slice(0, 80),
    importe_total: row.total,
    moneda: row.currency,
    deposito: row.deposit,
    metodo_pago: row.payment,
    hora_llegada: "",
    peticiones: "",
    notas: buildNotes(row),
    vip: row.vip
  };
  const extras: Record<OperaExtraField, string> = {
    garantia: guaranteeOf(row.guarantee),
    importe_estimado: row.estimatedTotal ? "si" : "",
    deposito_pagado: row.deposit
  };
  return [...RESERVATION_IMPORT_FIELDS.map((field) => values[field]), ...OPERA_EXTRA_FIELDS.map((field) => extras[field])];
}

// ---------------------------------------------------------------------------
// Plan de inventario (puro)
// ---------------------------------------------------------------------------

export type InventoryPlanInput = {
  operaRooms: readonly { number: string; type: string }[];
  dbRooms: readonly { id: string; number: string; roomTypeId: string; active: boolean; sellable: boolean }[];
  dbTypes: readonly { id: string; code: string; active: boolean; sellable?: boolean }[];
};

export type InventoryPlan = {
  typesToCreate: string[];
  roomsToRetype: Array<{ roomId: string; number: string; fromCode: string; toCode: string }>;
  roomsToCreate: Array<{ number: string; type: string; floor: string }>;
  roomsToDeactivate: Array<{ roomId: string; number: string; code: string }>;
  typesToDeactivate: string[];
  /** Tipos ya inactivos (o a desactivar) que siguen `sellable = true`: se marcan no vendibles (PII-05, 2026-09-19). */
  typesToUnsell: string[];
  unchangedRooms: number;
};

/**
 * Plan idempotente: tipos OPERA que faltan; habitaciones con el mismo número → re-tipado si el tipo
 * difiere; números que faltan → alta; habitaciones de la BD sin equivalente en OPERA → active = false y
 * sellable = false; tipos activos de la BD sin ninguna habitación OPERA → desactivar; tipos sin habitación
 * OPERA que sigan `sellable = true` (inactivos o a desactivar) → no vendibles. Nada se borra.
 */
export function buildInventoryPlan(input: InventoryPlanInput): InventoryPlan {
  const operaTypes = new Set(input.operaRooms.map((room) => room.type.toUpperCase()));
  const typeById = new Map(input.dbTypes.map((type) => [type.id, type] as const));
  const typeByCode = new Map(input.dbTypes.map((type) => [type.code.toUpperCase(), type] as const));
  const dbByNumber = new Map(input.dbRooms.map((room) => [room.number, room] as const));
  const plan: InventoryPlan = { typesToCreate: [], roomsToRetype: [], roomsToCreate: [], roomsToDeactivate: [], typesToDeactivate: [], typesToUnsell: [], unchangedRooms: 0 };
  for (const code of [...operaTypes].sort()) if (!typeByCode.has(code)) plan.typesToCreate.push(code);
  const operaNumbers = new Set<string>();
  for (const room of [...input.operaRooms].sort((a, b) => a.number.localeCompare(b.number, "es", { numeric: true }))) {
    const type = room.type.toUpperCase();
    operaNumbers.add(room.number);
    const existing = dbByNumber.get(room.number);
    if (!existing) {
      plan.roomsToCreate.push({ number: room.number, type, floor: floorOf(room.number) });
      continue;
    }
    const currentCode = typeById.get(existing.roomTypeId)?.code.toUpperCase() ?? "";
    if (currentCode !== type) plan.roomsToRetype.push({ roomId: existing.id, number: room.number, fromCode: currentCode, toCode: type });
    else plan.unchangedRooms += 1;
  }
  for (const room of [...input.dbRooms].sort((a, b) => a.number.localeCompare(b.number, "es", { numeric: true }))) {
    if (operaNumbers.has(room.number)) continue;
    if (room.active || room.sellable) plan.roomsToDeactivate.push({ roomId: room.id, number: room.number, code: typeById.get(room.roomTypeId)?.code ?? "" });
  }
  for (const type of [...input.dbTypes].sort((a, b) => a.code.localeCompare(b.code))) {
    if (operaTypes.has(type.code.toUpperCase())) continue;
    if (type.active) plan.typesToDeactivate.push(type.code);
    if (type.sellable === true) plan.typesToUnsell.push(type.code);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Resumen del prep (puro)
// ---------------------------------------------------------------------------

export type FeedSummary = {
  file: string;
  sha256In: string;
  rowsRead: number;
  rowsUnique: number;
  rowsWritten: number;
  omitted: Record<string, number>;
  byStatus: Record<string, number>;
  byTargetStatus: Record<string, number>;
  inHouseRooms: string[];
  arrivalsByDate: Record<string, number>;
  augustRoomNights: number;
  blankedRooms: { dead: number; overlap: number; historicalKept?: number };
  physicalTypeApplied: number;
  personsClamped: number;
  enriched: number;
  nameSplit: Record<string, number>;
  channels: Record<string, number>;
  segments: Record<string, number>;
  out: Array<{ file: string; sha256: string; rows: number }>;
};

export type HotelSummary = { name: string; resort: string; estancias: FeedSummary; llegadas: FeedSummary; inventario: { file: string; sha256: string; types: number; rooms: number; ambiguous: string[] } };

export type PrepSummary = { generatedAt: string; cutDate: IsoDate; inDir: string; outDir: string; hotels: Partial<Record<OperaHotelCode, HotelSummary>> };

const TARGET_BY_STATUS: Readonly<Record<string, string>> = Object.freeze({ "CHECKED OUT": "checked_out", "CHECKED IN": "checked_in", RESERVED: "confirmed", "NO SHOW": "no_show", CANCELLED: "cancelled" });

function count(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** Noches de [llegada, salida) dentro de agosto de 2026 (solo estancias reales ocupadas: CHECKED OUT + CHECKED IN). */
export function augustRoomNights(rows: readonly Pick<OperaRow, "status" | "arrival" | "departure">[], month: IsoDate = "2026-08-01"): number {
  const from = month;
  const to = addDays(month, 31);
  let nights = 0;
  for (const row of rows) {
    if (row.status !== "CHECKED OUT" && row.status !== "CHECKED IN") continue;
    const start = row.arrival > from ? row.arrival : from;
    const end = row.departure < to ? row.departure : to;
    if (end > start) nights += daysBetween(start, end);
  }
  return nights;
}

export function summarizeFeed(rows: readonly OperaRow[], omitted: readonly OmittedRow[], base: Pick<FeedSummary, "file" | "sha256In" | "rowsRead" | "rowsUnique" | "blankedRooms" | "physicalTypeApplied" | "personsClamped" | "enriched" | "out">): FeedSummary {
  const summary: FeedSummary = { ...base, rowsWritten: rows.length, omitted: {}, byStatus: {}, byTargetStatus: {}, inHouseRooms: [], arrivalsByDate: {}, augustRoomNights: augustRoomNights(rows), nameSplit: {}, channels: {}, segments: {} };
  for (const row of omitted) count(summary.omitted, row.reason);
  for (const row of rows) {
    count(summary.byStatus, row.status);
    count(summary.byTargetStatus, row.status === "CHECKED IN" && row.room === "" ? "confirmed (CHECKED IN sin habitación)" : (TARGET_BY_STATUS[row.status] ?? row.status));
    if (row.status === "CHECKED IN" && row.room !== "") summary.inHouseRooms.push(row.room);
    if (row.status === "RESERVED" || row.status === "CHECKED IN") count(summary.arrivalsByDate, row.arrival);
    count(summary.nameSplit, splitOperaName(row.fullName).kind);
    count(summary.channels, row.channel);
    count(summary.segments, row.segment);
  }
  summary.inHouseRooms.sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  return summary;
}

export function formatSummary(summary: PrepSummary): string[] {
  const lines: string[] = [`${SCRIPT_LABEL} prep · corte ${summary.cutDate} · entrada ${summary.inDir} · salida ${summary.outDir}`];
  for (const [code, hotel] of Object.entries(summary.hotels) as Array<[OperaHotelCode, HotelSummary]>) {
    const s = hotel.estancias;
    const a = hotel.llegadas;
    const omitted = (record: Record<string, number>): string => Object.entries(record).map(([reason, n]) => `${reason} ${n}`).join(", ") || "ninguna";
    lines.push(`  ${code} · ${hotel.name} (${hotel.resort})`);
    lines.push(`    estancias: leídas ${s.rowsRead} · escritas ${s.rowsWritten} · omitidas ${omitted(s.omitted)} · por estado ${Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(`      en casa (habitaciones) ${s.inHouseRooms.length} · RN agosto ${s.augustRoomNights} · hab. en blanco: canceladas/no-show ${s.blankedRooms.dead}, solapes ${s.blankedRooms.overlap} · tipo físico ${s.physicalTypeApplied} · PERSONS recortado ${s.personsClamped} · enriquecidas ${s.enriched}`);
    lines.push(`      nombres: ${Object.entries(s.nameSplit).map(([k, n]) => `${k} ${n}`).join(", ")} · canales: ${Object.entries(s.channels).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(`    llegadas: leídas ${a.rowsRead} · únicas ${a.rowsUnique} · escritas ${a.rowsWritten} · omitidas ${omitted(a.omitted)} · 18/09 ${a.arrivalsByDate["2026-09-18"] ?? 0} · 19/09 ${a.arrivalsByDate["2026-09-19"] ?? 0} · hab. en blanco por solape ${a.blankedRooms.overlap} · tipo físico ${a.physicalTypeApplied} · PERSONS recortado ${a.personsClamped}`);
    lines.push(`      canales: ${Object.entries(a.channels).map(([k, n]) => `${k} ${n}`).join(", ")} · segmentos: ${Object.entries(a.segments).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(`    inventario: ${hotel.inventario.types} tipos · ${hotel.inventario.rooms} habitaciones · ambiguas ${hotel.inventario.ambiguous.length === 0 ? "ninguna" : hotel.inventario.ambiguous.join(", ")}`);
    for (const out of [...s.out, ...a.out]) lines.push(`    → ${out.file} (${out.rows} filas, sha256 ${out.sha256.slice(0, 16)}…)`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// prep (sin BD)
// ---------------------------------------------------------------------------

function findReportFile(dir: string, hotel: OperaHotel, kind: "stay" | "arrival"): string {
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".xlsx"));
  const prefix = kind === "stay" ? `${hotel.name} - ` : `Llegadas - ${hotel.name}`;
  const match = files.filter((name) => name.normalize("NFC").startsWith(prefix.normalize("NFC"))).sort()[0];
  if (!match) throw new Error(`No se encuentra el informe de ${kind === "stay" ? "estancias" : "llegadas"} de ${hotel.name} en ${dir} (esperado «${prefix}…xlsx»).`);
  return join(dir, match);
}

function readReport(path: string): { table: ParsedTable; sha: string; bytes: number } {
  const bytes = readFileSync(path);
  const table = parseXlsxTable(new Uint8Array(bytes), { sheetName: SHEET_NAME });
  return { table, sha: sha256(bytes), bytes: bytes.length };
}

function writeCanonical(outDir: string, stem: string, rows: readonly OperaRow[], chunk: number): Array<{ file: string; sha256: string; rows: number }> {
  const chunks = chunkRows(rows.map(toCanonicalRow), chunk);
  return chunks.map((cells, index) => {
    const file = chunks.length === 1 ? `${stem}.csv` : `${stem}-${index + 1}.csv`;
    const text = toCanonicalCsv(cells);
    writeFileSync(join(outDir, file), text, "utf8");
    return { file, sha256: sha256(text), rows: cells.length };
  });
}

function writeOmitted(outDir: string, code: OperaHotelCode, feeds: Array<{ feed: string; omitted: readonly OmittedRow[] }>): string {
  const file = `${code}-omitidas.csv`;
  const lines = ["feed;fila;referencia;motivo;estado;categoria;habitacion"];
  for (const { feed, omitted } of feeds) for (const row of omitted) lines.push([feed, String(row.rowNumber), row.reference, row.reason, row.status, row.category, row.room].map(csvCell).join(";"));
  writeFileSync(join(outDir, file), `\uFEFF${lines.join("\n")}\n`, "utf8");
  return file;
}

export type InventoryFile = {
  hotel: OperaHotelCode;
  name: string;
  resort: string;
  cutDate: IsoDate;
  sources: string[];
  types: Array<{ code: string; name: string; maxOccupancy: number; baseCapacity: number; rooms: number }>;
  rooms: Array<{ number: string; type: string; floor: string; categories: Record<string, number> }>;
  ambiguous: Array<{ number: string; categories: Record<string, number> }>;
};

export function buildInventoryFile(hotel: OperaHotel, catalog: RoomCatalog, sources: string[]): InventoryFile {
  const rooms = [...catalog.entries()].map(([number, entry]) => ({ number, type: entry.type, floor: floorOf(number), categories: entry.categories }));
  const perType = new Map<string, number>();
  for (const room of rooms) perType.set(room.type, (perType.get(room.type) ?? 0) + 1);
  const types = [...perType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, n]) => {
      const proposal = PROPOSAL_BY_CODE.get(code);
      return { code, name: proposal?.name ?? code, maxOccupancy: proposal?.maxOccupancy ?? 2, baseCapacity: proposal?.baseCapacity ?? 2, rooms: n };
    });
  const ambiguous = rooms.filter((room) => Object.keys(room.categories).length > 1).map((room) => ({ number: room.number, categories: room.categories }));
  return { hotel: hotel.code, name: hotel.name, resort: hotel.resort, cutDate: DEFAULT_CUT_DATE, sources, types, rooms, ambiguous };
}

/** Los dos informes de un hotel leídos y transformados como en el prep (sin escribir nada): lo usan `prep` y `verify --in`. */
export type AnalyzedHotel = {
  hotel: OperaHotel;
  stayPath: string;
  arrivalPath: string;
  staySha: string;
  arrivalSha: string;
  stayRowsRead: number;
  arrivalRowsRead: number;
  stays: ReadResult;
  arrivals: ReadResult & { duplicates: number };
  catalog: RoomCatalog;
  orderedStays: OperaRow[];
  orderedArrivals: OperaRow[];
  stayBlanked: { dead: number; overlap: number; historicalKept: number };
  arrivalBlanked: { dead: number; overlap: number; historicalKept: number };
  stayPhysical: number;
  arrivalPhysical: number;
  stayClamped: number;
  arrivalClamped: number;
  enriched: number;
};

export function analyzeHotelReports(inDir: string, hotel: OperaHotel): AnalyzedHotel {
  const stayPath = findReportFile(inDir, hotel, "stay");
  const arrivalPath = findReportFile(inDir, hotel, "arrival");
  const stayReport = readReport(stayPath);
  const arrivalReport = readReport(arrivalPath);
  const stays = readStayRows(stayReport.table, basename(stayPath));
  const arrivals = readArrivalRows(arrivalReport.table, basename(arrivalPath));
  // Inventario físico: unión de las dos fuentes (habitación → categoría dominante).
  const catalog = buildRoomCatalog([...stays.rows, ...arrivals.rows]);
  // Llegadas: solapes de preasignación → en blanco la posterior; tipo físico; ocupación.
  const arrivalBlanked = blankOverlappingRooms(arrivals.rows);
  const arrivalPhysical = applyPhysicalTypes(arrivals.rows, catalog);
  const arrivalClamped = clampOccupancy(arrivals.rows);
  // Estancias: canceladas / no-show y solapes con filas vivas en blanco; tipo físico; ocupación; C9; orden.
  const stayBlanked = blankOverlappingRooms(stays.rows);
  const stayPhysical = applyPhysicalTypes(stays.rows, catalog);
  const stayClamped = clampOccupancy(stays.rows);
  const enriched = enrichReservedFromArrivals(stays.rows, arrivals.rows);
  const orderedStays = orderStayRows(stays.rows);
  const orderedArrivals = [...arrivals.rows].sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : a.rowNumber - b.rowNumber));
  return { hotel, stayPath, arrivalPath, staySha: stayReport.sha, arrivalSha: arrivalReport.sha, stayRowsRead: stayReport.table.rows.length, arrivalRowsRead: arrivalReport.table.rows.length, stays, arrivals, catalog, orderedStays, orderedArrivals, stayBlanked, arrivalBlanked, stayPhysical, arrivalPhysical, stayClamped, arrivalClamped, enriched };
}

/** Resumen de un hotel (como el de RESUMEN.json) a partir del análisis; `out` vacío cuando no se ha escrito nada. */
export function summarizeHotel(analyzed: AnalyzedHotel, out: { stays: FeedSummary["out"]; arrivals: FeedSummary["out"] }, inventory: HotelSummary["inventario"]): HotelSummary {
  const a = analyzed;
  return {
    name: a.hotel.name,
    resort: a.hotel.resort,
    estancias: summarizeFeed(a.orderedStays, a.stays.omitted, { file: basename(a.stayPath), sha256In: a.staySha, rowsRead: a.stayRowsRead, rowsUnique: a.stayRowsRead, blankedRooms: a.stayBlanked, physicalTypeApplied: a.stayPhysical, personsClamped: a.stayClamped, enriched: a.enriched, out: out.stays }),
    llegadas: summarizeFeed(a.orderedArrivals, a.arrivals.omitted, { file: basename(a.arrivalPath), sha256In: a.arrivalSha, rowsRead: a.arrivalRowsRead, rowsUnique: a.arrivalRowsRead - a.arrivals.duplicates, blankedRooms: a.arrivalBlanked, physicalTypeApplied: a.arrivalPhysical, personsClamped: a.arrivalClamped, enriched: 0, out: out.arrivals }),
    inventario: inventory
  };
}

export async function runPrep(flags: OperaFlags): Promise<RunOutcome> {
  const inDir = resolvePath(flags.in!);
  const outDir = resolvePath(flags.out!);
  if (!existsSync(inDir)) throw new Error(`--in ${inDir} no existe.`);
  mkdirSync(outDir, { recursive: true });
  const hotels = HOTELS.filter((hotel) => flags.hotel === "all" || hotel.code === flags.hotel);
  const summary: PrepSummary = { generatedAt: new Date().toISOString(), cutDate: DEFAULT_CUT_DATE, inDir, outDir, hotels: {} };
  for (const hotel of hotels) {
    const analyzed = analyzeHotelReports(inDir, hotel);
    const stayOut = writeCanonical(outDir, `${hotel.code}-estancias`, analyzed.orderedStays, flags.chunk);
    const arrivalOut = writeCanonical(outDir, `${hotel.code}-llegadas`, analyzed.orderedArrivals, flags.chunk);
    writeOmitted(outDir, hotel.code, [
      { feed: "estancias", omitted: analyzed.stays.omitted },
      { feed: "llegadas", omitted: analyzed.arrivals.omitted }
    ]);
    const inventory = buildInventoryFile(hotel, analyzed.catalog, [basename(analyzed.stayPath), basename(analyzed.arrivalPath)]);
    const inventoryText = `${JSON.stringify(inventory, null, 2)}\n`;
    const inventoryFile = `${hotel.code}-inventario.json`;
    writeFileSync(join(outDir, inventoryFile), inventoryText, "utf8");
    summary.hotels[hotel.code] = summarizeHotel(analyzed, { stays: stayOut, arrivals: arrivalOut }, { file: inventoryFile, sha256: sha256(inventoryText), types: inventory.types.length, rooms: inventory.rooms.length, ambiguous: inventory.ambiguous.map((room) => room.number) });
  }
  const resumenPath = join(outDir, "RESUMEN.json");
  let previous: PrepSummary | null = null;
  if (flags.hotel !== "all" && existsSync(resumenPath)) {
    try {
      previous = JSON.parse(readFileSync(resumenPath, "utf8")) as PrepSummary;
    } catch {
      previous = null;
    }
  }
  const merged: PrepSummary = previous ? { ...previous, generatedAt: summary.generatedAt, hotels: { ...previous.hotels, ...summary.hotels } } : summary;
  writeFileSync(resumenPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { exitCode: 0, json: { mode: "prep", summary: merged, exitCode: 0 }, lines: [...formatSummary(merged), `  RESUMEN.json escrito en ${resumenPath}. Nada escrito en la BD.`] };
}

// ---------------------------------------------------------------------------
// Contexto de sistema y propiedad
// ---------------------------------------------------------------------------

export type RunOutcome = { exitCode: 0 | 1; json: unknown; lines: string[] };

type PropertyRef = { id: string; organizationId: string; name: string; code: string | null; timezone: string };

async function resolveProperty(propertyId: string): Promise<PropertyRef> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, name: true, code: true, timezone: true } });
  if (!property) throw new Error(`Propiedad "${propertyId}" no encontrada. Nada escrito.`);
  return property;
}

/** Contexto de sistema del modo sombra (`usr_system_pms_shadow`); `inventory` añade property.map.manage. */
export function contextFor(property: PropertyRef, extra: readonly PermissionKey[] = []): UserContext {
  const context = systemContext(property.organizationId, property.id);
  return { ...context, permissions: [...context.permissions, ...extra] };
}

function describeHttpError(error: HttpError): { code: string; lines: string[]; details: Record<string, unknown> } {
  const details = (error.details ?? {}) as Record<string, unknown>;
  const code = typeof details.code === "string" ? details.code : `HTTP_${error.statusCode}`;
  const lines = [`${SCRIPT_LABEL} ${code} (${error.statusCode}): ${error.message}`];
  if (typeof details.importId === "string") lines.push(`  Lote afectado: ${details.importId}${typeof details.status === "string" ? ` (${details.status})` : ""}`);
  if (typeof details.errorCount === "number") lines.push(`  Filas con errores: ${details.errorCount}`);
  if (Array.isArray(details.rows)) for (const item of details.rows as Array<{ rowNumber?: number; code?: string }>) lines.push(`    · fila ${item.rowNumber ?? "?"}: ${item.code ?? ""}`);
  if (Array.isArray(details.missing)) lines.push(`  Campos obligatorios sin columna: ${(details.missing as unknown[]).map(String).join(", ")}`);
  lines.push("  Nada más escrito.");
  return { code, lines, details };
}

async function flushAll(): Promise<void> {
  await flushAuditQueues();
  await flushAccountingProjection();
  await flushExtraProjections();
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

export async function runInventory(flags: OperaFlags): Promise<RunOutcome> {
  const property = await resolveProperty(flags.property!);
  const plan = JSON.parse(readFileSync(resolvePath(flags.plan!), "utf8")) as InventoryFile;
  if (!Array.isArray(plan.rooms) || plan.rooms.length === 0) throw new Error("El plan no tiene habitaciones.");
  const [dbTypes, dbRooms] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId: property.id }, select: { id: true, code: true, active: true, sellable: true } }),
    prisma.room.findMany({ where: { propertyId: property.id }, select: { id: true, number: true, roomTypeId: true, active: true, sellable: true } })
  ]);
  const computed = buildInventoryPlan({ operaRooms: plan.rooms.map((room) => ({ number: room.number, type: room.type })), dbRooms, dbTypes });
  const header = [
    `${SCRIPT_LABEL} inventory · propiedad ${property.name} (${property.code ?? "—"}, ${property.id}) · plan ${plan.hotel} ${plan.name} (${plan.rooms.length} habitaciones OPERA, ${plan.types.length} tipos)`,
    `  BD antes: ${dbTypes.length} tipos (${dbTypes.filter((type) => type.active).length} activos, ${dbTypes.filter((type) => !type.active && type.sellable).length} inactivos aún vendibles) · ${dbRooms.length} habitaciones (${dbRooms.filter((room) => room.active && room.sellable).length} activas y vendibles)`,
    `  Plan: crear tipos ${computed.typesToCreate.join(", ") || "ninguno"} · re-tipar ${computed.roomsToRetype.length} · crear ${computed.roomsToCreate.length} · desactivar ${computed.roomsToDeactivate.length} · tipos a desactivar ${computed.typesToDeactivate.join(", ") || "ninguno"} · tipos a marcar no vendibles ${computed.typesToUnsell.join(", ") || "ninguno"} · sin cambios ${computed.unchangedRooms}`,
    `    re-tipar: ${computed.roomsToRetype.map((room) => `${room.number} ${room.fromCode}→${room.toCode}`).join(", ") || "ninguna"}`,
    `    crear: ${computed.roomsToCreate.map((room) => `${room.number} (${room.type}, planta ${room.floor})`).join(", ") || "ninguna"}`,
    `    desactivar: ${computed.roomsToDeactivate.map((room) => `${room.number} (${room.code})`).join(", ") || "ninguna"}`
  ];
  if (!flags.apply) {
    return { exitCode: 0, json: { mode: "inventory-dry-run", propertyId: property.id, plan: computed, exitCode: 0 }, lines: [...header, "  Nada escrito (dry-run). Para aplicar: --apply."] };
  }
  const context = contextFor(property, ["property.map.manage"]);
  await hydrateAuditChainFromPostgres();
  const done = { typesCreated: [] as string[], roomsRetyped: 0, roomsCreated: [] as string[], roomsDeactivated: 0, typesDeactivated: [] as string[], typesUnsold: [] as string[] };
  try {
    for (const code of computed.typesToCreate) {
      const proposal = PROPOSAL_BY_CODE.get(code);
      const fromPlan = plan.types.find((type) => type.code.toUpperCase() === code);
      await createBackOfficeRoomType({
        context,
        propertyId: property.id,
        correlationId: CORRELATION_ID,
        roomType: { code, name: fromPlan?.name ?? proposal?.name ?? code, maxOccupancy: proposal?.maxOccupancy ?? fromPlan?.maxOccupancy ?? 2, baseCapacity: proposal?.baseCapacity ?? fromPlan?.baseCapacity ?? 2, sellable: true, active: true }
      });
      done.typesCreated.push(code);
    }
    const types = await prisma.roomType.findMany({ where: { propertyId: property.id }, select: { id: true, code: true } });
    const typeIdByCode = new Map(types.map((type) => [type.code.toUpperCase(), type.id] as const));
    const groups = new Map<string, string[]>();
    for (const room of computed.roomsToRetype) {
      const ids = groups.get(room.toCode) ?? [];
      ids.push(room.roomId);
      groups.set(room.toCode, ids);
    }
    for (const [code, roomIds] of groups) {
      const roomTypeId = typeIdByCode.get(code);
      if (!roomTypeId) throw new Error(`Tipo ${code} no existe tras la creación.`);
      const result = await bulkUpdateRooms({ context, propertyId: property.id, correlationId: CORRELATION_ID, roomIds, patch: { roomTypeId } });
      done.roomsRetyped += result.updatedCount;
    }
    for (const room of computed.roomsToCreate) {
      const roomTypeId = typeIdByCode.get(room.type);
      if (!roomTypeId) throw new Error(`Tipo ${room.type} no existe tras la creación.`);
      await createRoom({ context, propertyId: property.id, roomTypeId, number: room.number, floor: room.floor, correlationId: CORRELATION_ID });
      done.roomsCreated.push(room.number);
    }
    if (computed.roomsToDeactivate.length > 0) {
      const result = await bulkUpdateRooms({ context, propertyId: property.id, correlationId: CORRELATION_ID, roomIds: computed.roomsToDeactivate.map((room) => room.roomId), patch: { active: false, sellable: false } });
      done.roomsDeactivated = result.updatedCount;
    }
    for (const code of computed.typesToDeactivate) {
      const type = dbTypes.find((candidate) => candidate.code === code);
      if (!type) continue;
      await deactivateBackOfficeRoomType({ context, propertyId: property.id, correlationId: CORRELATION_ID, roomTypeId: type.id });
      done.typesDeactivated.push(code);
    }
    // PII-05: un tipo sin habitación OPERA no se vende (deactivateBackOfficeRoomType solo pone active = false).
    for (const code of computed.typesToUnsell) {
      const type = dbTypes.find((candidate) => candidate.code === code);
      if (!type) continue;
      await patchBackOfficeRoomType({ context, propertyId: property.id, correlationId: CORRELATION_ID, roomTypeId: type.id, patch: { sellable: false } });
      done.typesUnsold.push(code);
    }
  } finally {
    await flushAll();
  }
  const after = await prisma.room.count({ where: { propertyId: property.id, active: true, sellable: true } });
  const lines = [...header, `  Aplicado: tipos creados ${done.typesCreated.join(", ") || "ninguno"} · re-tipadas ${done.roomsRetyped} · creadas ${done.roomsCreated.length} · desactivadas ${done.roomsDeactivated} · tipos desactivados ${done.typesDeactivated.join(", ") || "ninguno"} · tipos no vendibles ${done.typesUnsold.join(", ") || "ninguno"} · activas y vendibles ahora ${after}`];
  return { exitCode: 0, json: { mode: "inventory-apply", propertyId: property.id, plan: computed, done, activeSellableAfter: after, exitCode: 0 }, lines };
}

// ---------------------------------------------------------------------------
// demo-retire
// ---------------------------------------------------------------------------

type RetireAction = { code: string; status: string; action: "cancel" | "checkout" | "skip" | "rejected"; reason: string; reservationId: string | null };

export async function runDemoRetire(flags: OperaFlags): Promise<RunOutcome> {
  const property = await resolveProperty(flags.property!);
  const codes = [...new Set([...flags.cancel, ...flags.checkout])];
  const reservations = await prisma.reservation.findMany({ where: { propertyId: property.id, code: { in: codes }, deletedAt: null }, select: { id: true, code: true, status: true, externalReference: true } });
  const byCode = new Map(reservations.map((reservation) => [reservation.code, reservation] as const));
  const actions: RetireAction[] = [];
  for (const code of codes) {
    const reservation = byCode.get(code);
    if (!reservation) {
      actions.push({ code, status: "—", action: "rejected", reason: "no existe en la propiedad", reservationId: null });
      continue;
    }
    const [invoices, folios] = await Promise.all([prisma.invoice.count({ where: { reservationId: reservation.id } }), prisma.folio.findMany({ where: { reservationId: reservation.id }, select: { id: true } })]);
    const payments = folios.length === 0 ? 0 : await prisma.payment.count({ where: { folioId: { in: folios.map((folio) => folio.id) } } });
    if (invoices > 0 || payments > 0) {
      actions.push({ code, status: reservation.status, action: "rejected", reason: `tiene ${invoices} factura(s) y ${payments} pago(s): no se toca`, reservationId: reservation.id });
      continue;
    }
    if (/^\d{7,8}$/.test(reservation.externalReference ?? "")) {
      actions.push({ code, status: reservation.status, action: "rejected", reason: "referencia externa de OPERA (reserva real): no se toca", reservationId: reservation.id });
      continue;
    }
    const wanted = flags.checkout.includes(code) ? "checkout" : "cancel";
    if (wanted === "cancel") {
      if (reservation.status === "draft" || reservation.status === "confirmed") actions.push({ code, status: reservation.status, action: "cancel", reason: "transitionReservation → cancelled (sin política)", reservationId: reservation.id });
      else actions.push({ code, status: reservation.status, action: "skip", reason: `estado ${reservation.status}: no cancelable`, reservationId: reservation.id });
    } else if (reservation.status === "checked_in") actions.push({ code, status: reservation.status, action: "checkout", reason: "check-out sombra (saldo reconocido + cierre del folio)", reservationId: reservation.id });
    else actions.push({ code, status: reservation.status, action: "skip", reason: `estado ${reservation.status}: no está alojada`, reservationId: reservation.id });
  }
  const table = actions.map((action) => `    · ${action.code} · ${action.status} → ${action.action} · ${action.reason}`);
  const header = [`${SCRIPT_LABEL} demo-retire · propiedad ${property.name} (${property.code ?? "—"}, ${property.id}) · ${actions.length} códigos`, ...table];
  if (!flags.apply) return { exitCode: 0, json: { mode: "demo-retire-dry-run", propertyId: property.id, actions, exitCode: 0 }, lines: [...header, "  Nada escrito (dry-run). Para aplicar: --apply --reason \"…\"."] };
  const context = contextFor(property);
  const reason = flags.reason ?? "Retirada de la demo";
  const done = { cancelled: [] as string[], checkedOut: [] as string[], failed: [] as Array<{ code: string; message: string }> };
  await hydrateAuditChainFromPostgres();
  try {
    for (const action of actions) {
      if (!action.reservationId || (action.action !== "cancel" && action.action !== "checkout")) continue;
      try {
        if (action.action === "cancel") {
          await transitionReservation({ context, reservationId: action.reservationId, status: "cancelled", reason, correlationId: CORRELATION_ID });
          done.cancelled.push(action.code);
        } else {
          await shadowCheckOut({ context, reservationId: action.reservationId, correlationId: CORRELATION_ID });
          done.checkedOut.push(action.code);
        }
      } catch (error) {
        done.failed.push({ code: action.code, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await flushAll();
  }
  const lines = [...header, `  Aplicado: canceladas ${done.cancelled.length} (${done.cancelled.join(", ") || "—"}) · check-out ${done.checkedOut.length} (${done.checkedOut.join(", ") || "—"}) · fallidas ${done.failed.length}`];
  for (const failure of done.failed) lines.push(`    · ${failure.code}: ${failure.message}`);
  const exitCode: 0 | 1 = done.failed.length > 0 ? 1 : 0;
  return { exitCode, json: { mode: "demo-retire-apply", propertyId: property.id, actions, done, exitCode }, lines };
}

// ---------------------------------------------------------------------------
// apply (importReservations en modo sync) y undo
// ---------------------------------------------------------------------------

function histogram(values: Iterable<string | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) if (value) count(out, value);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function fmt(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length === 0 ? "ninguno" : entries.map(([key, n]) => `${key} ${n}`).join(", ");
}

/** Cuerpo del importador: modo sync, feed, business date, tarifa ignorada, omitir inválidas, permitir overbooking, horizonte 730 días. */
export function buildSyncBody(input: { fileName: string; contentBase64: string; feed: "arrivals" | "inhouse"; businessDate: string; force: boolean }): ReservationImportPreviewBody {
  return {
    fileName: input.fileName,
    contentBase64: input.contentBase64,
    mapping: { tarifa: null },
    omitirInvalidas: true,
    permitirOverbooking: true,
    historico: false,
    force: input.force,
    sampleSize: 1,
    mode: "sync",
    feed: input.feed,
    businessDate: input.businessDate,
    horizonDays: RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS
  };
}

const MAX_LISTED_ROWS = 300;

/** Previsualización → solo recuentos y códigos (jamás `rows`, `cells`, `normalized`, `personalValues` ni `resolved.guest`). */
export function summarizePreview(preview: ReservationImportPreview): Record<string, unknown> {
  const issueCodes = histogram(preview.rows.flatMap((row) => row.issues.map((issue) => issue.code)));
  const errorRows = preview.rows.filter((row) => row.status === "error").slice(0, MAX_LISTED_ROWS).map((row) => ({ rowNumber: row.rowNumber, codes: row.issues.map((issue) => issue.code) }));
  return {
    rowCount: preview.rowCount,
    header: preview.header.length,
    today: preview.today,
    businessDate: preview.businessDate,
    contentHash: preview.contentHash,
    summary: preview.summary,
    canImport: preview.canImport,
    blockers: preview.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
    warnings: preview.warnings,
    actions: histogram(preview.rows.map((row) => row.resolved?.sync?.action)),
    targetStatus: histogram(preview.rows.map((row) => row.resolved?.sync?.targetStatus)),
    estadoByTarget: histogram(preview.rows.map((row) => (row.resolved ? `${row.resolved.estado}/${row.resolved.sync?.targetStatus ?? "-"}` : undefined))),
    issuesByCode: issueCodes,
    errorRows,
    availability: preview.availability.byRoomType.map((type) => ({ code: type.code, totalRooms: type.totalRooms, rowsRequested: type.rowsRequested, peakBookedDb: type.peakBookedDb, peakBookedFile: type.peakBookedFile, nightsExceeded: type.nightsExceeded.length, rangeRuleRows: type.rangeRuleRows.length })),
    overbookingRows: preview.availability.overbookingRows.length,
    duplicates: { byReference: preview.duplicates.byReferenceRows.length, inFile: preview.duplicates.inFileRows.length, possible: preview.duplicates.possibleRows.length, ofImport: preview.duplicates.ofImport ? { importId: preview.duplicates.ofImport.importId, status: preview.duplicates.ofImport.status } : null },
    totals: preview.totals,
    unmappedColumns: preview.unmappedColumns,
    missingRequired: preview.missingRequired
  };
}

/** Lote aplicado → recuentos y códigos (sin datos personales). */
export function summarizeResult(result: ReservationImportResult): Record<string, unknown> {
  return {
    importId: result.id,
    status: result.status,
    rowCount: result.rowCount,
    createdCount: result.createdCount,
    skippedCount: result.skippedCount,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    arrivalFrom: result.arrivalFrom,
    arrivalTo: result.arrivalTo,
    totalAmount: result.totalAmount,
    durationMs: result.options.durationMs ?? null,
    outcomes: histogram(result.rows.map((row) => row.outcome)),
    errorCodes: histogram(result.rows.map((row) => row.errorCode)),
    warningCodes: histogram(result.rows.flatMap((row) => row.warnings.map((warning) => warning.code))),
    errorRows: result.rows.filter((row) => row.outcome === "error").slice(0, MAX_LISTED_ROWS).map((row) => ({ rowNumber: row.rowNumber, code: row.errorCode })),
    sync: result.sync
      ? { feed: result.sync.feed, businessDate: result.sync.businessDate, counts: result.sync.counts, missing: result.sync.missing.length, conflicts: result.sync.conflicts.length, checkInWithoutRoom: result.sync.checkInWithoutRoom.length, unmappedRateCodes: result.sync.unmappedRateCodes ?? [], unmappedRoomTypes: result.sync.unmappedRoomTypes ?? [] }
      : null,
    warnings: result.warnings
  };
}

export async function runApply(flags: OperaFlags): Promise<RunOutcome> {
  const path = resolvePath(flags.file!);
  const bytes = readFileSync(path);
  const property = await resolveProperty(flags.property!);
  const context = contextFor(property);
  const body = buildSyncBody({ fileName: basename(path), contentBase64: bytes.toString("base64"), feed: flags.feed!, businessDate: flags.businessDate!, force: flags.force });
  const head = `${SCRIPT_LABEL} ${flags.apply ? "apply" : "dry-run"} · propiedad ${property.name} (${property.code ?? "—"}, ${property.id}) · ${basename(path)} (${bytes.length} bytes) · feed ${flags.feed} · business date ${flags.businessDate} · horizonte ${RESERVATION_IMPORT_SYNC_MAX_HORIZON_DAYS} días · force ${flags.force ? "sí" : "no"}`;
  if (!flags.apply) {
    const preview = await previewReservationImport({ context, propertyId: property.id, body });
    const summary = summarizePreview(preview);
    const s = preview.summary;
    const lines = [
      head,
      `  hoy ${preview.today} · fecha de negocio ${preview.businessDate} · filas ${preview.rowCount} · hash ${preview.contentHash}`,
      `  Resumen: válidas ${s.valid} · avisos ${s.warning} · errores ${s.error} · omitidas ${s.skipped} · histórico ${s.historical} · a crear ${s.toCreate} · a actualizar ${s.toUpdate ?? 0} · sin cambios ${s.unchanged ?? 0} · transiciones ${s.toTransition ?? 0}`,
      `  Acciones: ${fmt(summary.actions as Record<string, number>)} · destino: ${fmt(summary.targetStatus as Record<string, number>)}`,
      `  Incidencias por código: ${fmt(summary.issuesByCode as Record<string, number>)}`,
      `  Cupo por tipo: ${(summary.availability as Array<{ code: string; totalRooms: number; rowsRequested: number; peakBookedDb: number; peakBookedFile: number; nightsExceeded: number }>).map((type) => `${type.code} cupo ${type.totalRooms} pedidas ${type.rowsRequested} pico BD ${type.peakBookedDb} pico fichero ${type.peakBookedFile} noches excedidas ${type.nightsExceeded}`).join(" · ") || "ninguno"}`,
      `  Duplicados: ${JSON.stringify(summary.duplicates)} · importes ${preview.totals.fromFile} del fichero / ${preview.totals.quoted} cotizados`,
      `  Avisos de fichero: ${preview.warnings.length === 0 ? "ninguno" : preview.warnings.join(" | ")}`,
      `  Blockers: ${preview.blockers.length === 0 ? "ninguno" : preview.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(" | ")}`,
      `  canImport: ${preview.canImport ? "sí" : "no"} · nada escrito (dry-run).`
    ];
    const errorRows = summary.errorRows as Array<{ rowNumber: number; codes: string[] }>;
    if (errorRows.length > 0) lines.push(`  Filas con error (${errorRows.length}${s.error > errorRows.length ? ` de ${s.error}` : ""}): ${errorRows.map((row) => `${row.rowNumber} [${row.codes.join(",")}]`).join(" · ")}`);
    const exitCode: 0 | 1 = preview.canImport ? 0 : 1;
    return { exitCode, json: { mode: "dry-run", propertyId: property.id, file: basename(path), feed: flags.feed, businessDate: flags.businessDate, preview: summary, exitCode }, lines };
  }
  await hydrateAuditChainFromPostgres();
  try {
    const result = await importReservations({ context, propertyId: property.id, body, createdBy: context.userId, correlationId: CORRELATION_ID, source: "cli" });
    const summary = summarizeResult(result);
    const exitCode: 0 | 1 = result.status === "imported" || result.status === "partial" ? 0 : 1;
    const lines = [
      head,
      `  Lote ${result.id} · ${result.status} · filas ${result.rowCount} · creadas ${result.createdCount} · omitidas ${result.skippedCount} · error ${result.errorCount} · avisos ${result.warningCount} · ${result.options.durationMs ?? "?"} ms`,
      `  Resultados: ${fmt(summary.outcomes as Record<string, number>)} · códigos de error: ${fmt(summary.errorCodes as Record<string, number>)} · avisos: ${fmt(summary.warningCodes as Record<string, number>)}`,
      `  Llegadas ${result.arrivalFrom ?? "—"} → ${result.arrivalTo ?? "—"} · total ${result.totalAmount} ${result.currency}`,
      result.sync ? `  Sync: ${JSON.stringify(summary.sync)}` : "  Sync: —",
      `  Para deshacer (solo draft | confirmed): undo --property ${property.id} --import ${result.id}`
    ];
    return { exitCode, json: { mode: "apply", propertyId: property.id, file: basename(path), feed: flags.feed, businessDate: flags.businessDate, result: summary, exitCode }, lines };
  } catch (error) {
    if (error instanceof HttpError) {
      const described = describeHttpError(error);
      return { exitCode: 1, json: { mode: "apply", propertyId: property.id, file: basename(path), error: { statusCode: error.statusCode, code: described.code, message: error.message, details: described.details }, exitCode: 1 }, lines: [head, ...described.lines] };
    }
    throw error;
  } finally {
    await flushAll();
  }
}

export async function runUndo(flags: OperaFlags): Promise<RunOutcome> {
  const property = await resolveProperty(flags.property!);
  const context = contextFor(property);
  await hydrateAuditChainFromPostgres();
  try {
    const result: ReservationImportUndoResult = await undoReservationImport({ context, propertyId: property.id, importId: flags.importId!, reason: flags.reason, correlationId: CORRELATION_ID });
    const lines = result.alreadyUndone
      ? [`${SCRIPT_LABEL} lote ${result.id} ya estaba deshecho (${result.undoneAt ?? "—"}): nada escrito.`]
      : [`${SCRIPT_LABEL} lote ${result.id} deshecho · ${result.status} · canceladas ${result.undoneCount} · conservadas (alojadas, históricas, canceladas o no-show) ${result.undoKeptCount} · motivo «${result.undoReason ?? "—"}»`];
    return { exitCode: 0, json: { mode: "undo", propertyId: property.id, importId: result.id, status: result.status, alreadyUndone: result.alreadyUndone, undoneCount: result.undoneCount, undoKeptCount: result.undoKeptCount, cancelledReservationIds: result.cancelledReservationIds.length, exitCode: 0 }, lines };
  } catch (error) {
    if (error instanceof HttpError) {
      const described = describeHttpError(error);
      return { exitCode: 1, json: { mode: "undo", propertyId: property.id, error: { statusCode: error.statusCode, code: described.code, message: error.message }, exitCode: 1 }, lines: described.lines };
    }
    throw error;
  } finally {
    await flushAll();
  }
}

// ---------------------------------------------------------------------------
// backfill (corrección posterior a la carga real del 2026-09-19: FO-02, FO-03, FO-04, FO-07)
// ---------------------------------------------------------------------------

export const ESTIMATED_NOTE = "importe estimado tarifa×noches";

/** Quita el fragmento «importe estimado tarifa×noches» de las notas (con su separador «·»). Puro. */
export function stripEstimatedNote(notes: string): string {
  return notes
    .split(" · ")
    .filter((part) => part.trim() !== ESTIMATED_NOTE)
    .join(" · ");
}

/** «123,45» → «123.45» (Decimal de Prisma); vacío → null. */
export function decimalOf(amount: string): string | null {
  const text = amount.trim();
  return text === "" ? null : text.replace(",", ".");
}

export type BackfillReservation = {
  id: string;
  code: string;
  status: string;
  externalReference: string;
  guaranteeType: string | null;
  priceSource: string | null;
  notes: string | null;
  depositPaid: string | null;
  assignedRoomId: string | null;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  stays: number;
};

export type BackfillPatch = {
  reservationId: string;
  code: string;
  reference: string;
  guaranteeType?: string;
  priceSource?: "quoted";
  notes?: string;
  depositPaid?: string;
  room?: { number: string; roomId: string };
  before: { guaranteeType: string | null; priceSource: string | null; depositPaid: string | null; assignedRoomId: string | null; notesHadEstimate: boolean };
};

export type BackfillPlan = { patches: BackfillPatch[]; counts: Record<string, number>; roomsMissing: string[] };

/**
 * Plan puro por reserva real (referencia numérica) a partir de las filas del prep:
 *  · `guarantee_type` ← `garantia` (fila de estancias si trae código real; si no, la de llegadas) cuando falta en BD;
 *  · `price_source = quoted` cuando el total sigue siendo el estimado de llegadas (sin fila de estancias) y está `file`;
 *  · notas sin «importe estimado…» cuando hay fila de estancias (el lote de estancias puso el total exacto) y la nota sigue;
 *  · `deposit_paid` ← `deposito_pagado` cuando falta;
 *  · habitación + `Stay` cerrada para `checked_out` sin habitación ni `Stay` cuando la fila de estancias trae habitación
 *    (las que el prep de t0 blanqueó por solape histórico; la habitación debe existir y estar activa).
 */
export function buildBackfillPlan(input: { reservations: readonly BackfillReservation[]; stays: ReadonlyMap<string, CanonicalRow>; arrivals: ReadonlyMap<string, CanonicalRow>; roomIdByNumber: ReadonlyMap<string, string> }): BackfillPlan {
  const counts: Record<string, number> = { reservations: 0, withoutRow: 0, guaranteeType: 0, priceSource: 0, notes: 0, depositPaid: 0, room: 0, unchanged: 0 };
  const patches: BackfillPatch[] = [];
  const roomsMissing = new Set<string>();
  for (const reservation of input.reservations) {
    counts.reservations = (counts.reservations ?? 0) + 1;
    const stay = input.stays.get(reservation.externalReference);
    const arrival = input.arrivals.get(reservation.externalReference);
    if (!stay && !arrival) {
      counts.withoutRow = (counts.withoutRow ?? 0) + 1;
      continue;
    }
    const patch: BackfillPatch = {
      reservationId: reservation.id,
      code: reservation.code,
      reference: reservation.externalReference,
      before: { guaranteeType: reservation.guaranteeType, priceSource: reservation.priceSource, depositPaid: reservation.depositPaid, assignedRoomId: reservation.assignedRoomId, notesHadEstimate: (reservation.notes ?? "").includes(ESTIMATED_NOTE) }
    };
    const guarantee = stay?.garantia || arrival?.garantia || "";
    if (guarantee !== "" && (reservation.guaranteeType ?? "") === "") {
      patch.guaranteeType = guarantee;
      counts.guaranteeType = (counts.guaranteeType ?? 0) + 1;
    }
    if (!stay && arrival?.importeEstimado && (reservation.priceSource ?? "file") === "file") {
      patch.priceSource = "quoted";
      counts.priceSource = (counts.priceSource ?? 0) + 1;
    }
    if (stay && patch.before.notesHadEstimate) {
      patch.notes = stripEstimatedNote(reservation.notes ?? "");
      counts.notes = (counts.notes ?? 0) + 1;
    }
    const deposit = decimalOf(stay?.depositoPagado || arrival?.depositoPagado || "");
    if (deposit !== null && Number(deposit) > 0 && reservation.depositPaid === null) {
      patch.depositPaid = deposit;
      counts.depositPaid = (counts.depositPaid ?? 0) + 1;
    }
    if (reservation.status === "checked_out" && reservation.assignedRoomId === null && reservation.stays === 0 && stay && stay.habitacion !== "") {
      const roomId = input.roomIdByNumber.get(stay.habitacion);
      if (roomId) {
        patch.room = { number: stay.habitacion, roomId };
        counts.room = (counts.room ?? 0) + 1;
      } else roomsMissing.add(stay.habitacion);
    }
    if (patch.guaranteeType === undefined && patch.priceSource === undefined && patch.notes === undefined && patch.depositPaid === undefined && patch.room === undefined) {
      counts.unchanged = (counts.unchanged ?? 0) + 1;
      continue;
    }
    patches.push(patch);
  }
  return { patches, counts, roomsMissing: [...roomsMissing].sort((a, b) => a.localeCompare(b, "es", { numeric: true })) };
}

const REAL_REFERENCE = /^\d{7,8}$/;

export async function runBackfill(flags: OperaFlags): Promise<RunOutcome> {
  const property = await resolveProperty(flags.property!);
  const outDir = resolvePath(flags.out!);
  const code = flags.hotel as OperaHotelCode;
  const stayFile = join(outDir, `${code}-estancias.csv`);
  const arrivalFile = join(outDir, `${code}-llegadas.csv`);
  for (const file of [stayFile, arrivalFile]) if (!existsSync(file)) throw new Error(`No existe ${file}: ejecuta antes prep (con las columnas extra).`);
  const stays = readCanonicalCsv(readFileSync(stayFile, "utf8"));
  const arrivals = readCanonicalCsv(readFileSync(arrivalFile, "utf8"));
  const iso = (value: Date): IsoDate => value.toISOString().slice(0, 10);
  const rows = await prisma.reservation.findMany({
    where: { propertyId: property.id, deletedAt: null, externalReference: { not: null } },
    select: { id: true, code: true, status: true, externalReference: true, guaranteeType: true, priceSource: true, notes: true, depositPaid: true, assignedRoomId: true, arrivalDate: true, departureDate: true, _count: { select: { stays: true } } }
  });
  const reservations: BackfillReservation[] = rows
    .filter((row) => REAL_REFERENCE.test(row.externalReference ?? ""))
    .map((row) => ({ id: row.id, code: row.code, status: row.status, externalReference: row.externalReference!, guaranteeType: row.guaranteeType, priceSource: row.priceSource, notes: row.notes, depositPaid: row.depositPaid === null ? null : row.depositPaid.toString(), assignedRoomId: row.assignedRoomId, arrivalDate: iso(row.arrivalDate), departureDate: iso(row.departureDate), stays: row._count.stays }));
  const activeRooms = await prisma.room.findMany({ where: { propertyId: property.id, active: true }, select: { id: true, number: true } });
  const roomIdByNumber = new Map(activeRooms.map((room) => [room.number, room.id] as const));
  const plan = buildBackfillPlan({ reservations, stays: stays.byReference, arrivals: arrivals.byReference, roomIdByNumber });
  const header = [
    `${SCRIPT_LABEL} backfill · propiedad ${property.name} (${property.code ?? "—"}, ${property.id}) · hotel ${code} · CSV ${basename(stayFile)} (${stays.rows.length} filas) + ${basename(arrivalFile)} (${arrivals.rows.length} filas)`,
    `  Reservas reales en BD ${plan.counts.reservations} · sin fila en el prep ${plan.counts.withoutRow} · sin cambios ${plan.counts.unchanged} · a corregir ${plan.patches.length}`,
    `  Campos: guarantee_type ${plan.counts.guaranteeType} · price_source → quoted ${plan.counts.priceSource} · nota «${ESTIMATED_NOTE}» retirada ${plan.counts.notes} · deposit_paid ${plan.counts.depositPaid} · habitación + Stay ${plan.counts.room}${plan.roomsMissing.length > 0 ? ` · habitaciones no encontradas o inactivas: ${plan.roomsMissing.join(", ")}` : ""}`,
    `    habitación + Stay: ${plan.patches.filter((patch) => patch.room).map((patch) => `${patch.code} → ${patch.room!.number}`).join(", ") || "ninguna"}`
  ];
  const jsonPlan = { counts: plan.counts, roomsMissing: plan.roomsMissing, patches: plan.patches.map((patch) => ({ reservationId: patch.reservationId, code: patch.code, reference: patch.reference, guaranteeType: patch.guaranteeType ?? null, priceSource: patch.priceSource ?? null, notesStripped: patch.notes !== undefined, depositPaid: patch.depositPaid ?? null, room: patch.room?.number ?? null, before: patch.before })) };
  if (!flags.apply) return { exitCode: 0, json: { mode: "backfill-dry-run", propertyId: property.id, hotel: code, plan: jsonPlan, exitCode: 0 }, lines: [...header, "  Nada escrito (dry-run). Para aplicar: --apply."] };
  const context = contextFor(property);
  await hydrateAuditChainFromPostgres();
  const done = { applied: 0, staysCreated: 0, failed: [] as Array<{ code: string; message: string }> };
  try {
    for (const patch of plan.patches) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.reservation.update({
            where: { id: patch.reservationId },
            data: {
              ...(patch.guaranteeType !== undefined ? { guaranteeType: patch.guaranteeType } : {}),
              ...(patch.priceSource !== undefined ? { priceSource: patch.priceSource } : {}),
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
              ...(patch.depositPaid !== undefined ? { depositPaid: patch.depositPaid } : {}),
              ...(patch.room !== undefined ? { assignedRoomId: patch.room.roomId } : {})
            }
          });
          if (patch.room) {
            const reservation = reservations.find((row) => row.id === patch.reservationId)!;
            // Misma regla que la estancia cerrada de una reserva histórica en createReservation: 15:00 → 11:00 hora local.
            const checkinAt = arrivalCheckInAt(reservation.arrivalDate, property.timezone);
            const checkoutAt = new Date(arrivalCheckInAt(reservation.departureDate, property.timezone).getTime() - 4 * 3_600_000);
            await tx.stay.create({ data: { reservationId: patch.reservationId, roomId: patch.room.roomId, checkinAt, checkoutAt, status: "checked_out" } });
            done.staysCreated += 1;
          }
        });
        done.applied += 1;
      } catch (error) {
        done.failed.push({ code: patch.code, message: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      }
    }
    // Un solo evento de auditoría por propiedad con recuentos e ids (sin datos personales).
    recordAuditEvent({
      organizationId: property.organizationId,
      propertyId: property.id,
      actorUserId: context.userId,
      actorType: "system",
      action: "RESERVATION_IMPORT_BACKFILLED",
      entityType: "property",
      entityId: property.id,
      afterJson: {
        hotel: code,
        counts: plan.counts,
        applied: done.applied,
        staysCreated: done.staysCreated,
        failed: done.failed.length,
        guaranteeTypeIds: plan.patches.filter((patch) => patch.guaranteeType !== undefined).map((patch) => patch.reservationId),
        priceSourceIds: plan.patches.filter((patch) => patch.priceSource !== undefined).map((patch) => patch.reservationId),
        notesIds: plan.patches.filter((patch) => patch.notes !== undefined).map((patch) => patch.reservationId),
        depositPaidIds: plan.patches.filter((patch) => patch.depositPaid !== undefined).map((patch) => patch.reservationId),
        roomIds: plan.patches.filter((patch) => patch.room !== undefined).map((patch) => ({ reservationId: patch.reservationId, roomId: patch.room!.roomId }))
      },
      correlationId: CORRELATION_ID
    });
  } finally {
    await flushAll();
  }
  const lines = [...header, `  Aplicado: reservas corregidas ${done.applied} · Stay creadas ${done.staysCreated} · fallidas ${done.failed.length}`];
  for (const failure of done.failed) lines.push(`    · ${failure.code}: ${failure.message}`);
  const exitCode: 0 | 1 = done.failed.length > 0 ? 1 : 0;
  return { exitCode, json: { mode: "backfill-apply", propertyId: property.id, hotel: code, plan: jsonPlan, done, exitCode }, lines };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export type VerifyCheck = { check: string; expected: string; actual: string; ok: boolean };

/** Recuento BRUTO de OPERA (todas las filas del xlsx) por RESV_STATUS frente a lo escrito por el prep. Puro. */
export type RawReconciliation = {
  stays: Record<string, { raw: number; omitted: Record<string, number>; written: number }>;
  arrivals: { raw: number; duplicates: number; omitted: Record<string, number>; written: number };
};

export function reconcileRaw(stays: ReadResult, arrivals: ReadResult & { duplicates: number }): RawReconciliation {
  const byStatus: RawReconciliation["stays"] = {};
  const entry = (status: string): { raw: number; omitted: Record<string, number>; written: number } => {
    const key = status || "(sin estado)";
    byStatus[key] ??= { raw: 0, omitted: {}, written: 0 };
    return byStatus[key];
  };
  for (const row of stays.rows) {
    const e = entry(row.status);
    e.raw += 1;
    e.written += 1;
  }
  for (const row of stays.omitted) {
    const e = entry(row.status);
    e.raw += 1;
    count(e.omitted, row.reason);
  }
  const arrivalOmitted: Record<string, number> = {};
  for (const row of arrivals.omitted) if (row.reason !== "duplicate") count(arrivalOmitted, row.reason);
  return {
    stays: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b))),
    arrivals: { raw: arrivals.rows.length + arrivals.omitted.length, duplicates: arrivals.duplicates, omitted: arrivalOmitted, written: arrivals.rows.length }
  };
}

/** Recuentos adicionales esperados en BD tras el `backfill` (garantía, origen del precio, depósito pagado, cerradas sin Stay). */
export function expectedExtras(analyzed: Pick<AnalyzedHotel, "orderedStays" | "orderedArrivals">): { guaranteeType: number; priceSourceQuoted: number; depositPaid: number; closedWithoutRoom: number } {
  const linked = new Set(analyzed.orderedStays.filter((row) => row.status === "RESERVED").map((row) => row.reference));
  const guaranteed = new Set<string>();
  const deposits = new Set<string>();
  for (const row of [...analyzed.orderedStays, ...analyzed.orderedArrivals]) {
    if (guaranteeOf(row.guarantee) !== "") guaranteed.add(row.reference);
    if (row.deposit !== "" && Number(row.deposit.replace(",", ".")) > 0) deposits.add(row.reference);
  }
  const priceSourceQuoted = analyzed.orderedArrivals.filter((row) => row.estimatedTotal && !linked.has(row.reference)).length;
  const closedWithoutRoom = analyzed.orderedStays.filter((row) => row.status === "CHECKED OUT" && row.room === "").length;
  return { guaranteeType: guaranteed.size, priceSourceQuoted, depositPaid: deposits.size, closedWithoutRoom };
}

/** Líneas de la tabla «OPERA bruto → cargado» (por estado de estancias; llegadas aparte). */
export function formatReconciliation(reconciliation: RawReconciliation): string[] {
  const omitted = (record: Record<string, number>): string => Object.entries(record).map(([reason, n]) => `${reason} ${n}`).join(", ") || "ninguna";
  const lines: string[] = ["    OPERA bruto → cargado (estancias por RESV_STATUS: bruto · omitidas · escritas)"];
  let raw = 0;
  let written = 0;
  for (const [status, e] of Object.entries(reconciliation.stays)) {
    raw += e.raw;
    written += e.written;
    lines.push(`      ${status.padEnd(12)} ${String(e.raw).padStart(6)} · ${omitted(e.omitted).padEnd(28)} · ${String(e.written).padStart(6)}`);
  }
  lines.push(`      ${"TOTAL".padEnd(12)} ${String(raw).padStart(6)} · ${String(raw - written).padStart(6)} omitidas${" ".repeat(19)} · ${String(written).padStart(6)}`);
  const a = reconciliation.arrivals;
  lines.push(`    llegadas: bruto ${a.raw} · filas repetidas (marcadores) ${a.duplicates} · omitidas ${omitted(a.omitted)} · escritas ${a.written}`);
  return lines;
}

/** Recuentos esperados tras cargar llegadas y estancias de un hotel a partir de su entrada en RESUMEN.json. */
export function expectedFromSummary(hotel: HotelSummary): { byStatus: Record<string, number>; inHouseRooms: string[]; arrivals: Record<string, number>; augustRoomNights: number } {
  const s = hotel.estancias;
  const a = hotel.llegadas;
  const checkInWithoutRoom = s.byTargetStatus["confirmed (CHECKED IN sin habitación)"] ?? 0;
  const byStatus: Record<string, number> = {
    confirmed: a.rowsWritten + checkInWithoutRoom,
    checked_in: s.inHouseRooms.length,
    checked_out: s.byStatus["CHECKED OUT"] ?? 0,
    no_show: s.byStatus["NO SHOW"] ?? 0,
    cancelled: s.byStatus.CANCELLED ?? 0
  };
  const arrivals: Record<string, number> = {};
  for (const date of ["2026-09-18", "2026-09-19"]) {
    const fromArrivals = a.arrivalsByDate[date] ?? 0;
    // Las CHECKED IN de estancias con llegada ese día ya están en casa; las RESERVED son las mismas que en llegadas.
    const inHouseSameDay = date === "2026-09-18" ? (s.arrivalsByDate[date] ?? 0) - (s.byStatus.RESERVED ?? 0) : 0;
    arrivals[date] = fromArrivals + Math.max(0, inHouseSameDay);
  }
  return { byStatus, inHouseRooms: s.inHouseRooms, arrivals, augustRoomNights: s.augustRoomNights };
}

/**
 * `verify`: la BD frente a (a) `RESUMEN.json` del prep (`--expected`) y/o (b) los xlsx BRUTOS de OPERA (`--in`): con
 * `--in` se releen los informes, se imprime la tabla «OPERA bruto → cargado» (recuento por RESV_STATUS antes de
 * excluir pseudo / day-use / > 365 / repetidas) y se añaden las comprobaciones posteriores al `backfill`
 * (garantía, origen del precio, depósito pagado, cerradas sin habitación ni Stay). Con los dos, manda `--in`.
 */
export async function runVerify(flags: OperaFlags): Promise<RunOutcome> {
  const property = await resolveProperty(flags.property!);
  const code = flags.hotel as OperaHotelCode;
  const hotelDef = HOTELS.find((hotel) => hotel.code === code)!;
  let hotel: HotelSummary | null = null;
  let analyzed: AnalyzedHotel | null = null;
  let reconciliation: RawReconciliation | null = null;
  if (flags.in !== null) {
    const inDir = resolvePath(flags.in);
    if (!existsSync(inDir)) throw new Error(`--in ${inDir} no existe.`);
    analyzed = analyzeHotelReports(inDir, hotelDef);
    reconciliation = reconcileRaw(analyzed.stays, analyzed.arrivals);
    hotel = summarizeHotel(analyzed, { stays: [], arrivals: [] }, { file: "", sha256: "", types: 0, rooms: analyzed.catalog.size, ambiguous: [] });
  } else {
    const summary = JSON.parse(readFileSync(resolvePath(flags.expected!), "utf8")) as PrepSummary;
    hotel = summary.hotels[code] ?? null;
    if (!hotel) throw new Error(`RESUMEN.json no tiene el hotel ${flags.hotel}.`);
  }
  const expected = expectedFromSummary(hotel);
  const rows = await prisma.reservation.findMany({
    where: { propertyId: property.id, deletedAt: null, externalReference: { not: null } },
    select: { status: true, externalReference: true, arrivalDate: true, departureDate: true, assignedRoomId: true, guaranteeType: true, priceSource: true, depositPaid: true, _count: { select: { stays: true } } }
  });
  const reservations = rows.filter((row) => REAL_REFERENCE.test(row.externalReference ?? ""));
  const iso = (value: Date): IsoDate => value.toISOString().slice(0, 10);
  const byStatus: Record<string, number> = {};
  for (const row of reservations) count(byStatus, row.status);
  const inHouseIds = reservations.filter((row) => row.status === "checked_in" && row.assignedRoomId).map((row) => row.assignedRoomId!);
  const rooms = inHouseIds.length === 0 ? [] : await prisma.room.findMany({ where: { id: { in: inHouseIds } }, select: { number: true } });
  const inHouseRooms = rooms.map((room) => room.number).sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  const arrivals: Record<string, number> = {};
  for (const date of ["2026-09-18", "2026-09-19"]) arrivals[date] = reservations.filter((row) => (row.status === "confirmed" || row.status === "checked_in") && iso(row.arrivalDate) === date).length;
  const rn = augustRoomNights(reservations.map((row) => ({ status: row.status === "checked_out" ? "CHECKED OUT" : row.status === "checked_in" ? "CHECKED IN" : row.status, arrival: iso(row.arrivalDate), departure: iso(row.departureDate) })));
  const checks: VerifyCheck[] = [];
  const push = (check: string, expectedValue: number | string, actualValue: number | string): void => {
    checks.push({ check, expected: String(expectedValue), actual: String(actualValue), ok: String(expectedValue) === String(actualValue) });
  };
  for (const status of ["confirmed", "checked_in", "checked_out", "no_show", "cancelled"]) push(`reservas ${status}`, expected.byStatus[status] ?? 0, byStatus[status] ?? 0);
  push("en casa por habitación", `${expected.inHouseRooms.length}: ${expected.inHouseRooms.join(" ")}`, `${inHouseRooms.length}: ${inHouseRooms.join(" ")}`);
  for (const date of ["2026-09-18", "2026-09-19"]) push(`llegadas ${date} (confirmed + checked_in)`, expected.arrivals[date] ?? 0, arrivals[date] ?? 0);
  push("RN agosto 2026 (checked_out + checked_in)", expected.augustRoomNights, rn);
  if (analyzed) {
    const extras = expectedExtras(analyzed);
    push("guarantee_type informado", extras.guaranteeType, reservations.filter((row) => (row.guaranteeType ?? "") !== "").length);
    push("price_source quoted (llegadas con importe estimado no enlazadas)", extras.priceSourceQuoted, reservations.filter((row) => row.priceSource === "quoted").length);
    push("deposit_paid informado", extras.depositPaid, reservations.filter((row) => row.depositPaid !== null && Number(row.depositPaid) > 0).length);
    push("checked_out sin habitación ni Stay", extras.closedWithoutRoom, reservations.filter((row) => row.status === "checked_out" && row.assignedRoomId === null && row._count.stays === 0).length);
  }
  const failed = checks.filter((check) => !check.ok);
  const lines = [`${SCRIPT_LABEL} verify · propiedad ${property.name} (${property.code ?? "—"}) · hotel ${flags.hotel} · reservas reales en BD ${reservations.length} · esperado desde ${analyzed ? `xlsx brutos (${basename(analyzed.stayPath)} · ${basename(analyzed.arrivalPath)})` : "RESUMEN.json"}`];
  if (reconciliation) lines.push(...formatReconciliation(reconciliation));
  lines.push(...checks.map((check) => `    ${check.ok ? "OK  " : "DIFF"} ${check.check}: esperado ${check.expected} · real ${check.actual}`), `  ${failed.length === 0 ? "Todo cuadra." : `${failed.length} diferencia(s).`}`);
  const exitCode: 0 | 1 = failed.length === 0 ? 0 : 1;
  return { exitCode, json: { mode: "verify", propertyId: property.id, hotel: flags.hotel, expectedFrom: analyzed ? "xlsx" : "resumen", reconciliation, checks, realReservations: reservations.length, exitCode }, lines };
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export async function run(flags: OperaFlags): Promise<RunOutcome> {
  switch (flags.command) {
    case "prep":
      return runPrep(flags);
    case "inventory":
      return runInventory(flags);
    case "demo-retire":
      return runDemoRetire(flags);
    case "apply":
      return runApply(flags);
    case "undo":
      return runUndo(flags);
    case "backfill":
      return runBackfill(flags);
    case "verify":
      return runVerify(flags);
    default:
      throw new Error("Subcomando no admitido.");
  }
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: OperaFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`${SCRIPT_LABEL} ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  run(flags)
    .then(async (outcome) => {
      await writeStdout(flags.json ? JSON.stringify(outcome.json, null, 2) : outcome.lines.join("\n"));
      await prisma.$disconnect().catch(() => undefined);
      process.exit(outcome.exitCode);
    })
    .catch(async (error) => {
      console.error(`${SCRIPT_LABEL} fallo:`, error instanceof Error ? error.message : error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
