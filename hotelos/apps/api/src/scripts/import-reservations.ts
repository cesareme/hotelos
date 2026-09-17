// CLI de importación masiva de reservas desde CSV o XLSX (Tanda 7 · L3 · diseño §8).
//
// Lee el fichero en bytes (el parser decide formato y codificación: CSV con
// `;` `,` tabulador o `|`, UTF-8 o Windows-1252, XLSX sin dependencias) y lo
// pasa por el MISMO servicio que las rutas HTTP
// (modules/pms/reservation-import.service.ts): este fichero solo decodifica,
// presenta y elige el código de salida, no re-implementa reglas.
//
//   · Dry-run (por defecto): previewReservationImport → cabecera (propiedad,
//     fichero, formato, codificación, hash), tabla de validación (fila · estado ·
//     referencia · llegada→salida · noches · tipo · tarifa · hab · huésped ·
//     importe · incidencias) limitada a --sample, resumen (válidas / avisos /
//     errores / omitidas / histórico / a crear), disponibilidad por tipo,
//     duplicados, mapeo efectivo y columnas sin mapear, blockers. Nada escrito.
//     Salida 0 solo si `canImport`.
//   · --apply: hydrateAuditChainFromPostgres, importReservations como usuario de
//     sistema (createdBy = SYSTEM_USER_ID "usr_system_reservation_import", source "cli"), flush de
//     auditoría y proyecciones antes de $disconnect; imprime id, estado,
//     contadores, rango de llegadas, total y filas creadas / omitidas / con error.
//     Salida 0 si `imported | partial`, 1 si `failed` o error de dominio.
//   · --undo <importId>: undoReservationImport → canceladas / conservadas /
//     alreadyUndone. Salida 0.
//   · --template csv|xlsx --out <ruta>: escribe la plantilla oficial (sin BD).
//   · --export-xlsx <ruta>: tras el dry-run, vuelca las filas del fichero como
//     .xlsx con la cabecera oficial (mismo contentHash al releerlo).
//
// Códigos de salida: 0 ok · 1 fallo (validación, mapeo, duplicado, BD) · 2 uso.
// Aviso operativo: ejecutar --apply y --undo con los API parados (cadena de
// auditoría in-memory, deuda 12(c)); el fichero nunca se guarda en la BD.
//
//   cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-reservations.ts \
//     --file <ruta.csv|.xlsx> --property <propertyId> [--apply] [--allow-overbooking] [--skip-invalid] [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import {
  RESERVATION_IMPORT_DEFAULT_SAMPLE_SIZE,
  RESERVATION_IMPORT_FIELDS,
  RESERVATION_IMPORT_FORMATS,
  RESERVATION_IMPORT_MAX_SAMPLE_SIZE,
  RESERVATION_IMPORT_ROW_OUTCOME_LABELS_ES,
  RESERVATION_IMPORT_ROW_STATUS_LABELS_ES,
  RESERVATION_IMPORT_STATUS_LABELS_ES,
  RESERVATION_IMPORT_UNDO_OUTCOME_LABELS_ES,
  type PermissionKey,
  type ReservationImportField,
  type ReservationImportFormat,
  type ReservationImportIssue,
  type ReservationImportMapping,
  type ReservationImportPreview,
  type ReservationImportPreviewBody,
  type ReservationImportPreviewRow,
  type ReservationImportResult,
  type ReservationImportUndoResult
} from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { HttpError } from "../lib/http-error.js";
import { flushAccountingProjection } from "../modules/accounting/projection.js";
import { flushExtraProjections } from "../modules/accounting/posting-rules/index.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres } from "../modules/audit/audit.service.js";
import { writeXlsx, type XlsxCell, type XlsxSheet } from "../modules/financial-statements/xlsx-writer.js";
import { parseReservationImportFile, type ParsedTable } from "../modules/pms/reservation-import.parser.js";
import { importReservations, previewReservationImport, undoReservationImport } from "../modules/pms/reservation-import.service.js";
import { RESERVATION_IMPORT_TEMPLATE_SHEET, buildReservationImportTemplate } from "../modules/pms/reservation-import.template.js";

// ---------------------------------------------------------------------------
// Constantes del usuario de sistema
// ---------------------------------------------------------------------------

export const SYSTEM_USER_ID = "usr_system_reservation_import";
/**
 * `createdBy` del lote: el MISMO SYSTEM_USER_ID, para que la pantalla lo
 * reconozca como actor de sistema («Sistema · importación masiva de reservas»,
 * screens/accounting/actor-label.ts) y nunca pinte una cadena cruda (FUX-02).
 * Los lotes anteriores a esta ronda llevan "cli:import-reservations" (DEVICE_ID)
 * y la pantalla los traduce igual.
 */
export const CREATED_BY = SYSTEM_USER_ID;
export const DEVICE_ID = "cli:import-reservations";
export const CORRELATION_ID = "corr_reservation_import";
export const SCRIPT_LABEL = "[reservations:import]";

/** Claves que el servicio exige: lectura (listar), creación (preview / commit) y modificación (assignRoom, cancelación, deshacer). */
export const CLI_PERMISSIONS: readonly PermissionKey[] = ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify"];

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type ImportFlags = {
  file: string | null;
  property: string | null;
  sheet: string | null;
  /** Ruta a un .json o JSON inline `{ "<columna>": "<campo>" | null }`. */
  mapping: string | null;
  apply: boolean;
  allowOverbooking: boolean;
  skipInvalid: boolean;
  historical: boolean;
  force: boolean;
  sample: number | null;
  json: boolean;
  exportXlsx: string | null;
  undo: string | null;
  reason: string | null;
  template: ReservationImportFormat | null;
  out: string | null;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/import-reservations.ts \\",
  "    --file <ruta.csv|.xlsx> --property <propertyId> [--sheet <hoja>] [--mapping <ruta.json | JSON inline>] \\",
  "    [--dry-run | --apply] [--allow-overbooking] [--skip-invalid] [--historical] [--force] [--sample <n>] [--json] [--export-xlsx <ruta.xlsx>]",
  "  node … src/scripts/import-reservations.ts --undo <importId> --property <propertyId> [--reason \"…\"] [--json]",
  "  node … src/scripts/import-reservations.ts --template <csv|xlsx> --out <ruta>",
  "  (equivalente: corepack pnpm --filter @hotelos/api reservations:import -- --file … --property …)",
  "",
  "  --file <ruta>            fichero de reservas en CSV (`;` `,` tabulador o `|`, UTF-8 o Windows-1252, BOM admitido) o XLSX",
  "                           (primera hoja no oculta o --sheet); formato por extensión o por la firma del fichero",
  "  --property <id>          propiedad destino (tipos, tarifas y habitaciones se resuelven contra su catálogo)",
  "  --sheet <hoja>           hoja del libro XLSX (por defecto la primera no oculta)",
  "  --mapping <json>         mapeo explícito columna del fichero → campo de la plantilla (o null para ignorar la columna);",
  "                           ruta a un .json o JSON inline; sin mapeo se usan las cabeceras y sus sinónimos ES/EN",
  "  --dry-run                (por defecto) previsualiza: tabla de validación, resumen, disponibilidad por tipo, duplicados,",
  "                           mapeo efectivo y blockers; no escribe nada; salida 0 solo si el fichero se puede importar",
  "  --apply                  crea las reservas válidas una a una (createReservation) dentro de un lote deshacible",
  "  --allow-overbooking      crea las filas por encima del cupo como aviso auditado (nunca por defecto)",
  "  --skip-invalid           crea las filas válidas aunque haya filas con errores (por defecto se exigen 0 errores)",
  "  --historical             llegadas anteriores a la fecha de negocio como estancia cerrada (checked_out, folio cerrado)",
  "  --force                  importa aunque exista un lote vivo con el mismo contenido (mismo hash)",
  `  --sample <n>             filas con detalle de huésped en la tabla del dry-run (1..${RESERVATION_IMPORT_MAX_SAMPLE_SIZE}, por defecto ${RESERVATION_IMPORT_DEFAULT_SAMPLE_SIZE})`,
  "  --export-xlsx <ruta>     tras el dry-run, vuelca las filas del fichero como .xlsx con la cabecera oficial (mismo hash)",
  "  --undo <importId>        deshace un lote: cancela sus reservas draft | confirmed y lo deja `undone` (idempotente)",
  "  --reason <texto>         motivo del deshacer (≤ 500 caracteres; por defecto «Importación deshecha»)",
  "  --template <csv|xlsx>    escribe la plantilla oficial (33 columnas + 2 filas de ejemplo ficticias) en --out",
  "  --out <ruta>             destino de --template",
  "  --json                   resultado legible por máquina (previsualización, lote creado o deshecho)",
  "  --help, -h               esta ayuda",
  "",
  `Usuario de sistema: ${SYSTEM_USER_ID} (también createdBy del lote; deviceId ${DEVICE_ID}, correlación ${CORRELATION_ID}).`,
  "Códigos de salida: 0 ok · 1 fallo (validación, mapeo, duplicado, BD) · 2 flag desconocido / uso.",
  "Aviso: ejecutar --apply y --undo con los API parados (cadena de auditoría in-memory). El fichero nunca se guarda en la BD."
].join("\n");

const VALUE_FLAGS = new Set(["--file", "--property", "--sheet", "--mapping", "--sample", "--export-xlsx", "--undo", "--reason", "--template", "--out"]);
const KNOWN_FLAGS = "--file <ruta>, --property <id>, --sheet <hoja>, --mapping <json>, --dry-run, --apply, --allow-overbooking, --skip-invalid, --historical, --force, --sample <n>, --json, --export-xlsx <ruta>, --undo <importId>, --reason <texto>, --template <csv|xlsx>, --out <ruta>, --help";

function isFormat(value: string): value is ReservationImportFormat {
  return (RESERVATION_IMPORT_FORMATS as readonly string[]).includes(value);
}

export function parseFlags(argv: readonly string[]): ImportFlags {
  const flags: ImportFlags = {
    file: null,
    property: null,
    sheet: null,
    mapping: null,
    apply: false,
    allowOverbooking: false,
    skipInvalid: false,
    historical: false,
    force: false,
    sample: null,
    json: false,
    exportXlsx: null,
    undo: null,
    reason: null,
    template: null,
    out: null,
    help: false
  };
  let sawDryRun = false;
  const once = (name: string, current: unknown): void => {
    if (current !== null) throw new Error(`${name} solo puede indicarse una vez.`);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--allow-overbooking") flags.allowOverbooking = true;
    else if (arg === "--skip-invalid") flags.skipInvalid = true;
    else if (arg === "--historical") flags.historical = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`El flag "${arg}" necesita un valor.`);
      const trimmed = value.trim();
      switch (arg) {
        case "--file":
          once(arg, flags.file);
          flags.file = trimmed;
          break;
        case "--property":
          once(arg, flags.property);
          flags.property = trimmed;
          break;
        case "--sheet":
          once(arg, flags.sheet);
          flags.sheet = trimmed;
          break;
        case "--mapping":
          once(arg, flags.mapping);
          flags.mapping = value;
          break;
        case "--sample": {
          once(arg, flags.sample);
          const sample = Number(trimmed);
          if (!Number.isInteger(sample) || sample < 1 || sample > RESERVATION_IMPORT_MAX_SAMPLE_SIZE) throw new Error(`--sample debe ser un entero entre 1 y ${RESERVATION_IMPORT_MAX_SAMPLE_SIZE}.`);
          flags.sample = sample;
          break;
        }
        case "--export-xlsx":
          once(arg, flags.exportXlsx);
          flags.exportXlsx = trimmed;
          break;
        case "--undo":
          once(arg, flags.undo);
          flags.undo = trimmed;
          break;
        case "--reason":
          once(arg, flags.reason);
          flags.reason = value.trim();
          break;
        case "--template":
          once(arg, flags.template);
          if (!isFormat(trimmed)) throw new Error(`--template debe ser csv o xlsx (recibido "${trimmed}").`);
          flags.template = trimmed;
          break;
        default:
          once(arg, flags.out);
          flags.out = trimmed;
      }
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Admitidos: ${KNOWN_FLAGS}.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run y --apply son excluyentes.");
  const modes = [flags.apply ? "--apply" : null, flags.undo !== null ? "--undo" : null, flags.template !== null ? "--template" : null].filter((m): m is string => m !== null);
  if (modes.length > 1) throw new Error(`${modes.join(" y ")} son excluyentes.`);
  if (flags.template !== null) {
    if (flags.out === null) throw new Error("--template exige --out <ruta>.");
    if (flags.file !== null || flags.exportXlsx !== null || flags.mapping !== null) throw new Error("--template no admite --file, --mapping ni --export-xlsx.");
    return flags;
  }
  if (flags.out !== null) throw new Error("--out solo tiene sentido con --template.");
  if (flags.property === null) throw new Error("--property <propertyId> es obligatorio.");
  if (flags.undo !== null) {
    if (flags.file !== null) throw new Error("--undo excluye --file (deshace un lote por su id).");
    if (flags.exportXlsx !== null || flags.mapping !== null) throw new Error("--undo no admite --mapping ni --export-xlsx.");
    return flags;
  }
  if (flags.reason !== null) throw new Error("--reason solo tiene sentido con --undo.");
  if (flags.file === null) throw new Error("--file <ruta.csv|.xlsx> es obligatorio.");
  if (flags.apply && flags.exportXlsx !== null) throw new Error("--export-xlsx solo se admite en el dry-run (sin --apply).");
  return flags;
}

// ---------------------------------------------------------------------------
// Entradas (puras)
// ---------------------------------------------------------------------------

/** Mapeo explícito: JSON inline (empieza por `{`) o ruta a un .json; valores = campo de la plantilla o null. */
export function readMapping(raw: string): ReservationImportMapping {
  const text = raw.trimStart().startsWith("{") ? raw : readFileSync(resolvePath(raw.trim()), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("--mapping no es JSON válido (esperado { \"<columna>\": \"<campo>\" | null }).");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--mapping debe ser un objeto columna → campo de la plantilla (o null).");
  const mapping: ReservationImportMapping = {};
  const invalid: string[] = [];
  for (const [column, field] of Object.entries(parsed as Record<string, unknown>)) {
    if (field === null) {
      mapping[column] = null;
    } else if (typeof field === "string" && (RESERVATION_IMPORT_FIELDS as readonly string[]).includes(field)) {
      mapping[column] = field as ReservationImportField;
    } else {
      invalid.push(column);
    }
  }
  if (invalid.length > 0) throw new Error(`--mapping: las columnas ${invalid.map((c) => `«${c}»`).join(", ")} no apuntan a un campo de la plantilla (${RESERVATION_IMPORT_FIELDS.join(", ")}) ni a null.`);
  return mapping;
}

export type LoadedFile = { fileName: string; bytes: Buffer; contentBase64: string };

/** Bytes tal cual: el parser decide formato (extensión, firma PK) y codificación. */
export function loadInputFile(path: string): LoadedFile {
  const bytes = readFileSync(resolvePath(path));
  return { fileName: basename(path), bytes, contentBase64: bytes.toString("base64") };
}

export function buildPreviewBody(flags: Pick<ImportFlags, "sheet" | "mapping" | "allowOverbooking" | "skipInvalid" | "historical" | "force" | "sample">, file: LoadedFile): ReservationImportPreviewBody {
  return {
    fileName: file.fileName,
    contentBase64: file.contentBase64,
    ...(flags.sheet !== null ? { sheetName: flags.sheet } : {}),
    ...(flags.mapping !== null ? { mapping: readMapping(flags.mapping) } : {}),
    omitirInvalidas: flags.skipInvalid,
    permitirOverbooking: flags.allowOverbooking,
    historico: flags.historical,
    force: flags.force,
    ...(flags.sample !== null ? { sampleSize: flags.sample } : {})
  };
}

// ---------------------------------------------------------------------------
// Presentación (pura)
// ---------------------------------------------------------------------------

/** "1234567.5" → "1.234.567,50" sin depender de ICU. */
export function formatEs(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  const sign = number < 0 ? "-" : "";
  const [integer, fraction = ""] = Math.abs(number).toFixed(decimals).split(".");
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped}${decimals > 0 ? `,${fraction}` : ""}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function table(header: string[], rows: string[][], rightAligned: ReadonlySet<number> = new Set()): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const cell = (value: string, i: number) => (rightAligned.has(i) ? value.padStart(widths[i]!) : value.padEnd(widths[i]!));
  const line = (cells: string[]) => `| ${cells.map((value, i) => cell(value ?? "", i)).join(" | ")} |`;
  return [line(header), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)];
}

/** Código de fila sin el prefijo común, para la columna de incidencias. */
export function shortRowCode(code: string): string {
  return code.replace(/^RESERVATION_IMPORT_ROW_/, "");
}

function guestOf(row: ReservationImportPreviewRow): string {
  const guest = row.normalized?.guest;
  if (!guest) return "—";
  return [guest.firstName, guest.surname1, guest.surname2].filter((part) => part && part.length > 0).join(" ");
}

/** Tabla de validación del dry-run (solo las primeras `sample` filas llevan huésped: la muestra de la preview). */
export function formatPreviewTable(rows: readonly ReservationImportPreviewRow[], sample: number): string[] {
  const shown = rows.slice(0, sample);
  const body = shown.map((row) => {
    const r = row.resolved;
    return [
      String(row.rowNumber),
      RESERVATION_IMPORT_ROW_STATUS_LABELS_ES[row.status] ?? row.status,
      r?.externalReference ?? "—",
      r ? `${r.arrivalDate}→${r.departureDate}` : "—",
      r ? String(r.nights) : "—",
      r?.roomTypeCode ?? "—",
      r?.ratePlanCode ?? "—",
      r?.roomNumber ?? "—",
      truncate(guestOf(row), 28),
      r ? formatEs(r.totalAmount) : "—",
      truncate(row.issues.map((issue) => shortRowCode(issue.code)).join(", "), 48) || "—"
    ];
  });
  return table(["Fila", "Estado", "Referencia", "Llegada→salida", "Noches", "Tipo", "Tarifa", "Hab.", "Huésped", "Importe", "Incidencias"], body, new Set([0, 4, 9]));
}

function issueLines(rows: readonly ReservationImportPreviewRow[], sample: number): string[] {
  const lines: string[] = [];
  for (const row of rows.slice(0, sample)) {
    for (const issue of row.issues) lines.push(`    · fila ${row.rowNumber} · ${issue.code}: ${issue.message}`);
  }
  return lines;
}

/** 0 si la preview se puede importar tal cual (`canImport`); 1 si no (errores sin --skip-invalid, mapeo incompleto, duplicado sin --force, 0 a crear). */
export function dryRunExitCode(preview: Pick<ReservationImportPreview, "canImport">): 0 | 1 {
  return preview.canImport ? 0 : 1;
}

/** 0 si el lote quedó `imported | partial`; 1 si `failed` (0 creadas). */
export function applyExitCode(result: Pick<ReservationImportResult, "status">): 0 | 1 {
  return result.status === "imported" || result.status === "partial" ? 0 : 1;
}

export type DryRunHeader = {
  propertyId: string;
  propertyName: string;
  organizationId: string;
  file: string;
  bytes: number;
};

export function formatDryRun(header: DryRunHeader, preview: ReservationImportPreview, sample: number): string[] {
  const lines: string[] = [];
  const s = preview.summary;
  lines.push(`${SCRIPT_LABEL} previsualización (dry-run) · propiedad ${header.propertyName} (${header.propertyId}) · organización ${header.organizationId}`);
  lines.push(`  Fichero: ${header.file} · ${preview.format} · ${preview.encoding}${preview.delimiter ? ` · separador «${preview.delimiter === "\t" ? "tab" : preview.delimiter}»` : ""}${preview.sheetName ? ` · hoja «${preview.sheetName}»` : ""} · ${formatEs(header.bytes, 0)} bytes · ${preview.rowCount} filas de datos · ${preview.header.length} columnas`);
  lines.push(
    `  Hash de contenido: ${preview.contentHash} · hoy (propiedad) ${preview.today} · fecha de negocio ${preview.businessDate}${preview.businessDate < preview.today ? " (por detrás del calendario)" : ""} · moneda ${preview.catalog.currency} · tarifa por defecto ${preview.catalog.defaultRatePlanCode ?? "— (ninguna)"}`
  );
  lines.push(`  Opciones: omitir inválidas ${preview.options.omitirInvalidas ? "sí" : "no"} · permitir overbooking ${preview.options.permitirOverbooking ? "sí" : "no"} · histórico ${preview.options.historico ? "sí" : "no"} · forzar ${preview.options.force ? "sí" : "no"}`);
  lines.push("");
  lines.push(`  Filas (${Math.min(sample, preview.rows.length)} de ${preview.rows.length}; huésped solo en la muestra):`);
  for (const line of formatPreviewTable(preview.rows, sample)) lines.push(`  ${line}`);
  const issues = issueLines(preview.rows, sample);
  if (issues.length > 0) {
    lines.push("");
    lines.push(`  Incidencias por fila (${issues.length}):`);
    lines.push(...issues);
  }
  lines.push("");
  lines.push(`  Resumen: válidas ${s.valid} · con avisos ${s.warning} · con errores ${s.error} · omitidas ${s.skipped} · histórico ${s.historical} · a crear ${s.toCreate}`);
  lines.push(`  Importes: del fichero ${formatEs(preview.totals.fromFile)} · cotizados ${formatEs(preview.totals.quoted)} ${preview.totals.currency}`);
  lines.push("");
  lines.push("  Disponibilidad por tipo (regla de rango del PMS: BD + filas anteriores del fichero):");
  if (preview.availability.byRoomType.length === 0) lines.push("    · ninguna fila entra en el planificador");
  for (const type of preview.availability.byRoomType) {
    lines.push(`    · ${type.code} (${type.name}): cupo ${type.totalRooms} · pedidas ${type.rowsRequested} · pico BD ${type.peakBookedDb} · pico fichero ${type.peakBookedFile}` +
      `${type.nightsExceeded.length > 0 ? ` · noches excedidas ${type.nightsExceeded.length} (${type.nightsExceeded.slice(0, 5).join(", ")}${type.nightsExceeded.length > 5 ? ", …" : ""})` : ""}` +
      `${type.rangeRuleRows.length > 0 ? ` · filas rechazadas por la regla de rango aunque quepan por noche: ${type.rangeRuleRows.join(", ")}` : ""}`);
  }
  if (preview.availability.overbookingRows.length > 0) lines.push(`    · filas por encima del cupo admitidas por --allow-overbooking: ${preview.availability.overbookingRows.join(", ")}`);
  const d = preview.duplicates;
  lines.push(`  Duplicados: referencia ya existente ${d.byReferenceRows.length} · repetida en el fichero ${d.inFileRows.length} · posibles ${d.possibleRows.length}` +
    `${d.ofImport ? ` · fichero ya importado en el lote ${d.ofImport.importId} (${RESERVATION_IMPORT_STATUS_LABELS_ES[d.ofImport.status] ?? d.ofImport.status}, ${d.ofImport.createdAt})${preview.options.force ? " → se importará igualmente por --force" : " → usa --force o deshaz el lote anterior"}` : ""}`);
  const mapped = Object.entries(preview.mapping).filter(([, field]) => field !== null);
  lines.push(`  Mapeo efectivo (${mapped.length} columnas): ${mapped.map(([column, field]) => `${column} → ${field}${preview.mappingSource[column] && preview.mappingSource[column] !== "explicit" ? ` (${preview.mappingSource[column]})` : ""}`).join(" · ") || "ninguna"}`);
  lines.push(`  Columnas sin mapear: ${preview.unmappedColumns.length === 0 ? "ninguna" : preview.unmappedColumns.join(", ")}`);
  if (preview.missingRequired.length > 0) lines.push(`  Campos obligatorios sin columna: ${preview.missingRequired.join(", ")}`);
  lines.push(`  Avisos de fichero: ${preview.warnings.length === 0 ? "ninguno" : preview.warnings.length}`);
  for (const warning of preview.warnings) lines.push(`    · ${warning}`);
  lines.push(`  Blockers: ${preview.blockers.length === 0 ? "ninguno" : preview.blockers.length}`);
  for (const blocker of preview.blockers) lines.push(`    · ${blocker.code}: ${blocker.message}`);
  lines.push(`  canImport: ${preview.canImport ? "sí" : "no"}`);
  lines.push("");
  lines.push("  Nada escrito (dry-run). Para importar: --apply (con los API parados).");
  return lines;
}

const MAX_RESULT_ROWS = 500;

function warningsOf(warnings: readonly ReservationImportIssue[]): string {
  return warnings.length === 0 ? "" : ` · avisos: ${warnings.map((w) => shortRowCode(w.code)).join(", ")}`;
}

export function formatApplyResult(result: ReservationImportResult): string[] {
  const lines: string[] = [];
  lines.push(`${SCRIPT_LABEL} lote ${result.id} · ${RESERVATION_IMPORT_STATUS_LABELS_ES[result.status] ?? result.status} (${result.status}) · ${result.fileName ?? "sin nombre"} · ${result.format} · propiedad ${result.propertyId}`);
  lines.push(`  Filas: ${result.rowCount} · creadas ${result.createdCount} · omitidas ${result.skippedCount} · con error ${result.errorCount} · con avisos ${result.warningCount}`);
  lines.push(`  Llegadas: ${result.arrivalFrom ?? "—"} → ${result.arrivalTo ?? "—"} · total ${formatEs(result.totalAmount)} ${result.currency} · createdBy ${result.createdBy ?? "—"} · hash ${result.contentHash}`);
  if (result.warnings.length > 0) {
    lines.push(`  Avisos de fichero (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`    · ${warning}`);
  }
  const shown = result.rows.slice(0, MAX_RESULT_ROWS);
  for (const row of shown) {
    const label = RESERVATION_IMPORT_ROW_OUTCOME_LABELS_ES[row.outcome] ?? row.outcome;
    if (row.outcome === "created") lines.push(`    · fila ${row.rowNumber} · ${label} · ${row.reservationCode ?? "—"} (${row.reservationId ?? "—"}) · ${row.arrivalDate ?? "—"}→${row.departureDate ?? "—"} · ${row.roomTypeCode ?? "—"}${warningsOf(row.warnings)}`);
    else lines.push(`    · fila ${row.rowNumber} · ${label} · ${row.errorCode ?? "—"}: ${row.errorMessage ?? ""}${warningsOf(row.warnings)}`);
  }
  if (result.rows.length > shown.length) lines.push(`    … y ${result.rows.length - shown.length} filas más (GET …/reservations/imports/${result.id}).`);
  lines.push(`  Para deshacer: --undo ${result.id} --property ${result.propertyId}`);
  return lines;
}

export function formatUndoResult(result: ReservationImportUndoResult): string[] {
  const lines: string[] = [];
  if (result.alreadyUndone) {
    lines.push(`${SCRIPT_LABEL} lote ${result.id} ya estaba deshecho (${result.undoneAt ?? "—"}, ${result.undoneBy ?? "—"}): nada escrito.`);
    return lines;
  }
  lines.push(`${SCRIPT_LABEL} lote ${result.id} deshecho · ${RESERVATION_IMPORT_STATUS_LABELS_ES[result.status] ?? result.status} (${result.status}) · motivo «${result.undoReason ?? "—"}»`);
  lines.push(`  Reservas ${RESERVATION_IMPORT_UNDO_OUTCOME_LABELS_ES.cancelled.toLowerCase()}: ${result.undoneCount} · ${RESERVATION_IMPORT_UNDO_OUTCOME_LABELS_ES.kept.toLowerCase()} (alojadas o históricas): ${result.undoKeptCount}`);
  lines.push(`  Ids cancelados: ${result.cancelledReservationIds.length === 0 ? "ninguno" : result.cancelledReservationIds.join(", ")}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Exportación XLSX con la cabecera oficial (ida y vuelta del lector)
// ---------------------------------------------------------------------------

/** Filas del fichero recolocadas en las 33 columnas canónicas según el mapeo efectivo (texto tal cual, fechas ISO como texto). */
export function buildExportRows(parsed: Pick<ParsedTable, "header" | "rows">, mapping: ReservationImportMapping): string[][] {
  const indexByField = new Map<ReservationImportField, number>();
  parsed.header.forEach((column, index) => {
    const field = mapping[column];
    if (field && !indexByField.has(field)) indexByField.set(field, index);
  });
  return parsed.rows.map((row) => RESERVATION_IMPORT_FIELDS.map((field) => {
    const index = indexByField.get(field);
    return index === undefined ? "" : (row.cells[index] ?? "");
  }));
}

export function buildExportWorkbook(parsed: Pick<ParsedTable, "header" | "rows">, mapping: ReservationImportMapping, now: Date = new Date()): Buffer {
  const sheet: XlsxSheet = {
    name: RESERVATION_IMPORT_TEMPLATE_SHEET,
    widths: RESERVATION_IMPORT_FIELDS.map((field) => Math.max(12, Math.min(40, field.length + 4))),
    rows: [RESERVATION_IMPORT_FIELDS.map((field): XlsxCell => ({ text: field, bold: true })), ...buildExportRows(parsed, mapping).map((cells): XlsxCell[] => cells.map((cell) => cell))]
  };
  return writeXlsx([sheet], now);
}

// ---------------------------------------------------------------------------
// Contexto de sistema y ejecución
// ---------------------------------------------------------------------------

export function systemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: SYSTEM_USER_ID,
    fullName: "Importación de reservas (CLI)",
    deviceId: DEVICE_ID,
    permissions: [...CLI_PERMISSIONS],
    isPlatformAdmin: false
  };
}

type PropertyRef = { id: string; organizationId: string; name: string };

async function resolveProperty(propertyId: string): Promise<PropertyRef> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, name: true } });
  if (!property) throw new Error(`Propiedad "${propertyId}" no encontrada. Nada escrito.`);
  return property;
}

function describeHttpError(error: HttpError): { code: string; lines: string[]; details: Record<string, unknown> } {
  const details = (error.details ?? {}) as Record<string, unknown>;
  const code = typeof details.code === "string" ? details.code : `HTTP_${error.statusCode}`;
  const lines = [`${SCRIPT_LABEL} ${code} (${error.statusCode}): ${error.message}`];
  if (typeof details.importId === "string") lines.push(`  Lote afectado: ${details.importId}${typeof details.status === "string" ? ` (${details.status})` : ""}${typeof details.createdAt === "string" ? ` · ${details.createdAt}` : ""}`);
  if (Array.isArray(details.missing)) lines.push(`  Campos obligatorios sin columna: ${(details.missing as unknown[]).map(String).join(", ")}`);
  if (typeof details.field === "string") lines.push(`  Campo en conflicto: ${details.field}${Array.isArray(details.columns) ? ` (columnas ${(details.columns as unknown[]).map(String).join(", ")})` : ""}`);
  if (typeof details.errorCount === "number") lines.push(`  Filas con errores: ${details.errorCount} (usa --skip-invalid para crear solo las válidas)`);
  if (Array.isArray(details.rows)) for (const item of details.rows as Array<{ rowNumber?: number; code?: string }>) lines.push(`    · fila ${item.rowNumber ?? "?"}: ${item.code ?? ""}`);
  if (typeof details.bytes === "number" && typeof details.max === "number") lines.push(`  Tamaño: ${formatEs(details.bytes, 0)} bytes (máximo ${formatEs(details.max, 0)})`);
  if (typeof details.rows === "number" && typeof details.max === "number") lines.push(`  Filas: ${details.rows} (máximo ${details.max})`);
  if (typeof details.reason === "string") lines.push(`  Motivo: ${details.reason}`);
  lines.push("  Nada escrito.");
  return { code, lines, details };
}

export type RunOutcome = { exitCode: 0 | 1; json: unknown; lines: string[] };

async function runTemplate(flags: ImportFlags): Promise<RunOutcome> {
  const format = flags.template!;
  const out = resolvePath(flags.out!);
  const file = buildReservationImportTemplate(format);
  writeFileSync(out, file.buffer);
  return {
    exitCode: 0,
    json: { mode: "template", format, out, fileName: file.fileName, bytes: file.buffer.length, columns: RESERVATION_IMPORT_FIELDS.length, exitCode: 0 },
    lines: [`${SCRIPT_LABEL} plantilla ${format} escrita en ${out} (${formatEs(file.buffer.length, 0)} bytes, ${RESERVATION_IMPORT_FIELDS.length} columnas, 2 filas de ejemplo ficticias @example.com).`]
  };
}

async function runUndo(flags: ImportFlags): Promise<RunOutcome> {
  const property = await resolveProperty(flags.property!);
  const context = systemContext(property.organizationId, property.id);
  await hydrateAuditChainFromPostgres();
  try {
    const result = await undoReservationImport({ context, propertyId: property.id, importId: flags.undo!, reason: flags.reason, correlationId: CORRELATION_ID });
    return { exitCode: 0, json: { mode: "undo", propertyId: property.id, result, exitCode: 0 }, lines: formatUndoResult(result) };
  } catch (error) {
    if (error instanceof HttpError) {
      const described = describeHttpError(error);
      return { exitCode: 1, json: { mode: "undo", propertyId: property.id, error: { statusCode: error.statusCode, code: described.code, message: error.message, details: described.details }, exitCode: 1 }, lines: described.lines };
    }
    throw error;
  } finally {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
  }
}

async function runFile(flags: ImportFlags): Promise<RunOutcome> {
  const file = loadInputFile(flags.file!);
  const property = await resolveProperty(flags.property!);
  const context = systemContext(property.organizationId, property.id);
  const body = buildPreviewBody(flags, file);
  const header: DryRunHeader = { propertyId: property.id, propertyName: property.name, organizationId: property.organizationId, file: file.fileName, bytes: file.bytes.length };
  const sample = flags.sample ?? RESERVATION_IMPORT_DEFAULT_SAMPLE_SIZE;

  if (!flags.apply) {
    const preview = await previewReservationImport({ context, propertyId: property.id, body });
    const lines = formatDryRun(header, preview, sample);
    let exported: { out: string; bytes: number; rows: number } | null = null;
    if (flags.exportXlsx !== null) {
      const parsed = parseReservationImportFile({ fileName: file.fileName, contentBase64: file.contentBase64, ...(flags.sheet !== null ? { sheetName: flags.sheet } : {}) });
      const workbook = buildExportWorkbook(parsed, preview.mapping);
      const out = resolvePath(flags.exportXlsx);
      writeFileSync(out, workbook);
      exported = { out, bytes: workbook.length, rows: parsed.rows.length };
      lines.push(`  Exportado a XLSX con la cabecera oficial: ${out} (${formatEs(workbook.length, 0)} bytes, ${parsed.rows.length} filas; releído debe dar el mismo hash ${preview.contentHash}).`);
    }
    const exitCode = dryRunExitCode(preview);
    return { exitCode, json: { mode: "dry-run", header, preview, exported, exitCode }, lines };
  }

  await hydrateAuditChainFromPostgres();
  try {
    const result = await importReservations({ context, propertyId: property.id, body, createdBy: CREATED_BY, correlationId: CORRELATION_ID, source: "cli" });
    const exitCode = applyExitCode(result);
    return { exitCode, json: { mode: "apply", header, result, exitCode }, lines: formatApplyResult(result) };
  } catch (error) {
    if (error instanceof HttpError) {
      const described = describeHttpError(error);
      return { exitCode: 1, json: { mode: "apply", header, error: { statusCode: error.statusCode, code: described.code, message: error.message, details: described.details }, exitCode: 1 }, lines: described.lines };
    }
    throw error;
  } finally {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
  }
}

export async function runImport(flags: ImportFlags): Promise<RunOutcome> {
  if (flags.template !== null) return runTemplate(flags);
  if (flags.undo !== null) return runUndo(flags);
  return runFile(flags);
}

/** Escribe en stdout y espera a que la tubería lo acepte: `process.exit` justo después de console.log truncaría un --json largo. */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: ImportFlags;
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
  runImport(flags)
    .then(async (outcome) => {
      await writeStdout(flags.json ? JSON.stringify(outcome.json, null, 2) : outcome.lines.join("\n"));
      await prisma.$disconnect();
      process.exit(outcome.exitCode);
    })
    .catch(async (error) => {
      console.error(`${SCRIPT_LABEL} fallo:`, error instanceof Error ? error.message : error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
