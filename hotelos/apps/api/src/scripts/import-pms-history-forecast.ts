// PMS "History & Forecast" import CLI (Faranda Los Tilos onboarding · reusable).
//
// A hotel migrating to Anfitorio arrives with its daily production history in
// the PMS it leaves behind (Opera's "History and Forecast" report): one row per
// stay date with room nights, arrivals, comps, house use, deduct / non-deduct
// splits, occupancy %, net room revenue and ADR, plus the same columns for the
// forecast horizon. Without that history the revenue module (H&F board,
// comparison, STLY, forecast, dashboards) has nothing to show for a property
// whose reservations were never in Anfitorio.
//
// This command loads that report (CSV, mapped by column NAME, any order) into:
//   · history  → one TOP-LEVEL RevenueDailySnapshot per day (all dimension
//                columns NULL), 1:1 with the report and with dataSource =
//                --source. Never upserted through the compound unique (NULL
//                dimensions are distinct in Postgres): find-then-write, as
//                hf-board.service.ts → writeDailySnapshot does.
//   · forecast → one top-level RevenueForecast per day with modelVersion =
//                --source and driversJson[adr_source] = "pms_forecast".
//   · --publish-bar <code> (optional) → a REFERENCE BAR in rate_days of the
//                property's rate plan with that code, for every active room
//                type, [today, today+365): derived from the PMS ADR (forecast
//                ADR → same-day-last-year ADR (d−364, d−371) → month average;
//                forecast and STLY candidates must be REPRESENTATIVE: at least
//                STLY_MIN_PAID_ROOMS paid rooms and inside STLY_BAND around the
//                month's revenue-weighted ADR, otherwise the chain moves on)
//                times a per-category multiplier. It exists so the revenue
//                module has a published BAR (quoteAvailability and the board
//                read it); it is NOT the hotel's real tariff. Rows are tagged
//                updatedBy = SYSTEM_USER_ID (RateDay has no other origin field).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/import-pms-history-forecast.ts \
//     --file <csv> --property <id> --rooms 92 [--source pms_import:opera_hf_2026-09-14] \
//     [--section history|forecast|both] [--from YYYY-MM-DD --to YYYY-MM-DD] \
//     [--publish-bar BAR] [--force] [--revert] [--dry-run | --apply --confirm <propertyId>] [--json]
//
//   --file <csv>        report exported from the PMS (header row required)
//   --property <id>     target property (must exist)
//   --rooms <n>         inventory the report was computed with (occ % / RevPAR base)
//   --source <s>        batch id, stored as snapshot.dataSource and forecast.modelVersion;
//                       normalised to the "pms_import:" namespace ("opera_hf_2026-09-14"
//                       and "pms_import:opera_hf_2026-09-14" are the same batch;
//                       default pms_import:opera_hf_<today>)
//   --section <s>       history · forecast · both (default both)
//   --from / --to       restrict the rows written to this inclusive range
//   --publish-bar <c>   also derive the reference BAR into rate_days of plan <c>
//   --force             overwrite snapshots of ANOTHER dataSource and delete
//                       forecasts of ANOTHER modelVersion in the range (listed);
//                       with --revert also delete the rate_days this tool wrote
//   --revert            delete what --source wrote (snapshots + forecasts; rate_days
//                       only with --force) instead of importing
//   --dry-run           (default) parse, validate, plan, write nothing
//   --apply             write; requires --confirm <propertyId> (exact id)
//   --json              machine-readable output
//   --help / -h         print this usage and exit 0
//
// Protection rules per history day (top-level row):
//   · no row                                   → create
//   · row with the same dataSource             → update (idempotent re-run)
//   · row night_audit with 0 rooms / 0 revenue → update with a warning ONLY when
//     the property has no reservation at all (the scheduler writes yesterday's
//     close for every property, also for one that has no operation yet → 0/0
//     artefact). A property WITH reservations may close a day at zero
//     legitimately (Rías Altas has 42 such closes): protected unless --force.
//   · row with any other dataSource            → skipped protected unless --force
// Forecast rows: deleteMany({propertyId, forecastDate in range, modelVersion =
// source, top-level}) + createMany in one transaction; other modelVersions are
// never touched without --force. Forecast rows dated before today are skipped
// (they are history by now).
//
// Exit codes: 0 ok · 1 failure (validation errors, property/plan missing, DB
// error) · 2 unknown flag / invalid argument / missing --confirm.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { parseDelimited } from "@hotelos/ai-tools";
import { addDays, dayUtc, isoDate, MS_DAY, round2, TOP_LEVEL_SNAPSHOT_WHERE } from "../modules/revenue/actuals.js";

export const SYSTEM_USER_ID = "usr_system_pms_import";
export const FORECAST_CONFIDENCE = 80;
export const BAR_CURRENCY = "EUR";
export const BAR_HORIZON_DAYS = 365;
/** Tolerances of the report formulas (the PMS rounds occ % to 2 decimals and ADR to cents). */
export const OCC_TOLERANCE_PP = 0.06;
export const ADR_TOLERANCE = 0.02;
const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;
const SNAPSHOT_CHUNK_DAYS = 100;

// ---- CSV contract -----------------------------------------------------------
export const REQUIRED_COLUMNS = [
  "date", "section", "totalOcc", "arrRooms", "compRooms", "houseUse", "deductIndiv", "nonDedIndiv", "deductGroup",
  "nonDedGroup", "occPct", "revenue", "adr", "depRooms", "dayUse", "noShow", "ooo", "adlChl"
] as const;
export const OPTIONAL_COLUMNS = ["dow"] as const;
const INTEGER_COLUMNS = [
  "totalOcc", "arrRooms", "compRooms", "houseUse", "deductIndiv", "nonDedIndiv", "deductGroup", "nonDedGroup",
  "depRooms", "dayUse", "noShow", "ooo", "adlChl"
] as const;
type IntegerColumn = (typeof INTEGER_COLUMNS)[number];

export type Section = "history" | "forecast";

export type ReportRow = {
  /** 1-based line number in the file (header = 1) for messages. */
  line: number;
  date: string;
  dow: string | null;
  section: Section;
  totalOcc: number;
  arrRooms: number;
  compRooms: number;
  houseUse: number;
  deductIndiv: number;
  nonDedIndiv: number;
  deductGroup: number;
  nonDedGroup: number;
  occPct: number;
  revenue: number;
  adr: number;
  depRooms: number;
  dayUse: number;
  noShow: number;
  ooo: number;
  adlChl: number;
};

export type RowIssue = { line: number; date: string | null; kind: string; message: string };

// ---- flags ------------------------------------------------------------------
export type ImportFlags = {
  file: string | null;
  propertyId: string;
  rooms: number;
  source: string;
  section: "history" | "forecast" | "both";
  from: string | null;
  to: string | null;
  publishBar: string | null;
  force: boolean;
  revert: boolean;
  apply: boolean;
  confirm: string[];
  json: boolean;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/import-pms-history-forecast.ts \\",
  "    --file <csv> --property <id> --rooms <n> [--source pms_import:opera_hf_YYYY-MM-DD] \\",
  "    [--section history|forecast|both] [--from YYYY-MM-DD --to YYYY-MM-DD] \\",
  "    [--publish-bar BAR] [--force] [--revert] [--dry-run | --apply --confirm <propertyId>] [--json]",
  "",
  "  --file <csv>        informe History & Forecast exportado del PMS (con cabecera)",
  "  --property <id>     propiedad destino (debe existir)",
  "  --rooms <n>         inventario con el que se calculó el informe (base de occ % / RevPAR)",
  "  --source <s>        id del lote; se guarda como snapshot.dataSource y forecast.modelVersion (namespace pms_import:)",
  "  --section <s>       history · forecast · both (por defecto both)",
  "  --from / --to       restringe las filas escritas a ese rango inclusivo",
  "  --publish-bar <c>   deriva además la BAR de referencia en rate_days del plan <c>",
  "  --force             sobrescribe snapshots de OTRO dataSource y borra forecasts de OTRO modelVersion; con --revert borra también los rate_days",
  "  --revert            borra lo que escribió --source (snapshots + forecasts; rate_days solo con --force) en vez de importar",
  "  --dry-run           (por defecto) parsea, valida, planifica, no escribe nada",
  "  --apply             escribe; exige --confirm <propertyId> (id exacto)",
  "  --json              salida legible por máquina",
  "  --help, -h          esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (errores de validación, propiedad/plan ausente, BD) · 2 flag desconocido / argumento inválido / falta --confirm."
].join("\n");

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SOURCE_PREFIX = "pms_import:";

/** Every batch of this tool lives in the "pms_import:" namespace so readers can tell imports from closes/seeds by prefix. */
export function normalizeSource(source: string): string {
  return source.startsWith(SOURCE_PREFIX) ? source : `${SOURCE_PREFIX}${source}`;
}

export function isRealIsoDate(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function parseFlags(argv: readonly string[], today: Date = dayUtc()): ImportFlags {
  const flags: ImportFlags = {
    file: null,
    propertyId: "",
    rooms: 0,
    source: `pms_import:opera_hf_${isoDate(dayUtc(today))}`,
    section: "both",
    from: null,
    to: null,
    publishBar: null,
    force: false,
    revert: false,
    apply: false,
    confirm: [],
    json: false,
    help: false
  };
  let sawDryRun = false;
  let sawRooms = false;
  const takeValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`Flag "${flag}" requires a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --help wins over everything else (also over missing --file/--property):
    // the operator asking for usage must never get a validation error instead.
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--revert") flags.revert = true;
    else if (arg === "--file") flags.file = takeValue(arg, i++);
    else if (arg === "--property") flags.propertyId = takeValue(arg, i++);
    else if (arg === "--source") flags.source = takeValue(arg, i++);
    else if (arg === "--publish-bar") flags.publishBar = takeValue(arg, i++);
    else if (arg === "--confirm") flags.confirm.push(takeValue(arg, i++));
    else if (arg === "--rooms") {
      const v = takeValue(arg, i++);
      if (!/^\d+$/.test(v) || Number(v) <= 0) throw new Error(`--rooms must be a positive integer (got "${v}").`);
      flags.rooms = Number(v);
      sawRooms = true;
    } else if (arg === "--section") {
      const v = takeValue(arg, i++);
      if (v !== "history" && v !== "forecast" && v !== "both") throw new Error(`--section must be history, forecast or both (got "${v}").`);
      flags.section = v;
    } else if (arg === "--from" || arg === "--to") {
      const v = takeValue(arg, i++);
      if (!isRealIsoDate(v)) throw new Error(`${arg} must be a real YYYY-MM-DD date (got "${v}").`);
      if (arg === "--from") flags.from = v;
      else flags.to = v;
    } else if (arg === "--") continue;
    else {
      throw new Error(
        `Unknown flag "${arg}". Known: --file, --property, --rooms, --source, --section, --from, --to, --publish-bar, --force, --revert, --dry-run, --apply, --confirm <propertyId>, --json, --help.`
      );
    }
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (!flags.propertyId) throw new Error("--property <id> is required.");
  if (!flags.revert && !flags.file) throw new Error("--file <csv> is required (except with --revert).");
  if (!flags.revert && !sawRooms) throw new Error("--rooms <n> is required (inventory the report was computed with).");
  if (flags.revert && flags.publishBar && !flags.force) {
    // Reverting rate_days needs --force by contract; --publish-bar without it would silently do nothing.
    throw new Error("--revert with --publish-bar needs --force to delete the derived BAR rows (rate_days are protected).");
  }
  if (flags.from && flags.to && flags.from > flags.to) throw new Error(`--from ${flags.from} is after --to ${flags.to}.`);
  if (flags.apply && flags.confirm.length === 0) throw new Error("--apply requires --confirm <propertyId> naming the target property.");
  if (flags.apply && !flags.confirm.includes(flags.propertyId)) {
    throw new Error(`--confirm must name the target property (${flags.propertyId}); got ${flags.confirm.join(", ")}.`);
  }
  if (flags.source.trim() === "" || /\s/.test(flags.source)) throw new Error("--source must be a non-empty identifier without whitespace.");
  flags.source = normalizeSource(flags.source);
  return flags;
}

// ---- parsing ----------------------------------------------------------------
function parseInteger(raw: string, column: string, line: number, errors: RowIssue[]): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    errors.push({ line, date: null, kind: "not_a_number", message: `fila ${line}: ${column} no es numérico ("${raw}")` });
    return 0;
  }
  if (!Number.isInteger(n)) {
    errors.push({ line, date: null, kind: "not_an_integer", message: `fila ${line}: ${column} debe ser entero ("${raw}")` });
    return 0;
  }
  return n;
}

function parseDecimal(raw: string, column: string, line: number, errors: RowIssue[]): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    errors.push({ line, date: null, kind: "not_a_number", message: `fila ${line}: ${column} no es numérico ("${raw}")` });
    return 0;
  }
  return n;
}

/**
 * Parses the report CSV by column name (any order). Unknown or missing columns
 * are errors: a renamed column would otherwise silently shift the meaning of
 * every counter. Numeric parsing errors are collected per row (never thrown
 * one at a time) so the operator sees the whole picture in one run.
 */
export function parseReportCsv(content: string): { rows: ReportRow[]; errors: RowIssue[] } {
  const table = parseDelimited(content);
  const errors: RowIssue[] = [];
  const header = table.header.map((h) => h.replace(/^\uFEFF/, "").trim());
  const known = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  const unknown = header.filter((h) => !known.has(h));
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  const duplicated = header.filter((h, i) => header.indexOf(h) !== i);
  if (unknown.length > 0) errors.push({ line: 1, date: null, kind: "unknown_column", message: `cabecera: columnas desconocidas ${unknown.join(", ")}` });
  if (missing.length > 0) errors.push({ line: 1, date: null, kind: "missing_column", message: `cabecera: faltan columnas ${missing.join(", ")}` });
  if (duplicated.length > 0) errors.push({ line: 1, date: null, kind: "duplicate_column", message: `cabecera: columnas repetidas ${duplicated.join(", ")}` });
  if (errors.length > 0) return { rows: [], errors };

  const index = new Map(header.map((h, i) => [h, i] as const));
  const col = (fields: string[], name: string): string => fields[index.get(name)!] ?? "";
  const rows: ReportRow[] = [];
  table.rows.forEach((fields, i) => {
    const line = i + 2;
    if (fields.length !== header.length) {
      errors.push({ line, date: null, kind: "field_count", message: `fila ${line}: ${fields.length} campos, la cabecera tiene ${header.length}` });
      return;
    }
    const before = errors.length;
    const sectionRaw = col(fields, "section").trim().toLowerCase();
    if (sectionRaw !== "history" && sectionRaw !== "forecast") {
      errors.push({ line, date: null, kind: "section", message: `fila ${line}: section debe ser history|forecast ("${col(fields, "section")}")` });
    }
    const ints = Object.fromEntries(INTEGER_COLUMNS.map((c) => [c, parseInteger(col(fields, c), c, line, errors)])) as Record<IntegerColumn, number>;
    const row: ReportRow = {
      line,
      date: col(fields, "date").trim(),
      dow: index.has("dow") ? col(fields, "dow").trim() || null : null,
      section: sectionRaw as Section,
      ...ints,
      occPct: parseDecimal(col(fields, "occPct"), "occPct", line, errors),
      revenue: parseDecimal(col(fields, "revenue"), "revenue", line, errors),
      adr: parseDecimal(col(fields, "adr"), "adr", line, errors)
    };
    if (!isRealIsoDate(row.date)) {
      errors.push({ line, date: row.date, kind: "date", message: `fila ${line}: fecha inválida "${row.date}" (se espera YYYY-MM-DD real)` });
    }
    for (let k = before; k < errors.length; k++) errors[k].date = row.date || null;
    if (errors.length === before) rows.push(row);
  });
  return { rows, errors };
}

// ---- formulas (shared by validation, BAR derivation and tests) ---------------
export function paidRooms(row: Pick<ReportRow, "totalOcc" | "houseUse">): number {
  return row.totalOcc - row.houseUse;
}
export function expectedOccPct(row: Pick<ReportRow, "totalOcc" | "houseUse" | "ooo">, rooms: number): number {
  const available = rooms - row.ooo;
  return available <= 0 ? 0 : (paidRooms(row) / available) * 100;
}
export function expectedAdr(row: Pick<ReportRow, "totalOcc" | "houseUse" | "revenue">): number {
  const paid = paidRooms(row);
  return paid === 0 ? 0 : row.revenue / paid;
}

/**
 * Pure validation over parsed rows: real contiguous dates, section monotonic
 * (history then forecast), deduct/non-deduct split summing to totalOcc
 * (errors) and the report's own formulas within tolerance, negative revenue
 * (adjustments) and comp ≠ house use days (warnings: worth seeing, not worth
 * rejecting the file).
 */
export function validateRows(rows: readonly ReportRow[], rooms: number): { errors: RowIssue[]; warnings: RowIssue[] } {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  if (rows.length === 0) {
    errors.push({ line: 1, date: null, kind: "empty", message: "el fichero no tiene filas de datos" });
    return { errors, warnings };
  }
  let seenForecast = false;
  // One history row after the forecast block makes EVERY later history row
  // "after a forecast": reporting each one buried the real defect under
  // hundreds of identical lines (406 in the adversarial run). Only the first
  // invalid transition is reported; the other rules keep running on every row.
  let sectionOrderReported = false;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const issue = (kind: string, message: string, list: RowIssue[]) => list.push({ line: row.line, date: row.date, kind, message: `fila ${row.line} (${row.date}): ${message}` });
    if (seen.has(row.date)) issue("duplicate_date", "fecha duplicada", errors);
    seen.add(row.date);
    if (i > 0) {
      const prev = rows[i - 1];
      const expected = isoDate(addDays(dayUtc(prev.date), 1));
      if (row.date !== expected) issue("gap", `fecha no contigua: tras ${prev.date} se esperaba ${expected}`, errors);
    }
    if (row.section === "forecast") seenForecast = true;
    else if (seenForecast && !sectionOrderReported) {
      sectionOrderReported = true;
      issue("section_order", "fila history después de una fila forecast (history debe ir antes; solo se informa la primera transición inválida)", errors);
    }

    const split = row.deductIndiv + row.nonDedIndiv + row.deductGroup + row.nonDedGroup;
    if (split !== row.totalOcc) issue("split_sum", `deductIndiv+nonDedIndiv+deductGroup+nonDedGroup = ${split} ≠ totalOcc ${row.totalOcc}`, errors);
    for (const c of INTEGER_COLUMNS) {
      if (row[c] < 0) issue("negative_counter", `${c} negativo (${row[c]})`, errors);
    }
    if (row.houseUse > row.totalOcc) issue("house_use_gt_total", `houseUse ${row.houseUse} > totalOcc ${row.totalOcc}`, errors);

    const occ = expectedOccPct(row, rooms);
    if (Math.abs(occ - row.occPct) > OCC_TOLERANCE_PP) {
      issue("formula_occ", `occPct ${row.occPct} ≠ (${row.totalOcc}−${row.houseUse})/(${rooms}−${row.ooo})·100 = ${occ.toFixed(2)}`, warnings);
    }
    const adr = expectedAdr(row);
    if (Math.abs(adr - row.adr) > ADR_TOLERANCE) {
      issue("formula_adr", `adr ${row.adr} ≠ ${row.revenue}/(${row.totalOcc}−${row.houseUse}) = ${adr.toFixed(2)}`, warnings);
    }
    if (row.revenue < 0) issue("negative_revenue", `revenue negativo (${row.revenue}; ajuste del PMS, se importa tal cual)`, warnings);
    // In this report comp rooms and house use move together (both are unpaid
    // rooms); a day where they differ is the PMS counting something else and
    // deserves a look, but the row is still imported as reported.
    if (row.compRooms !== row.houseUse) issue("comp_vs_house_use", `compRooms ${row.compRooms} ≠ houseUse ${row.houseUse} (revisar en el PMS; se importa tal cual)`, warnings);
  }
  return { errors, warnings };
}

// ---- mapping ----------------------------------------------------------------
export type SnapshotData = {
  totalOcc: number;
  arrivalRooms: number;
  departureRooms: number;
  compRooms: number;
  houseUseRooms: number;
  dayUseRooms: number;
  noShowRooms: number;
  oooRooms: number;
  deductIndividualRooms: number;
  nonDeductIndividualRooms: number;
  deductGroupRooms: number;
  nonDeductGroupRooms: number;
  adultsChildren: number;
  roomRevenue: number;
  totalRevenue: number;
  netRoomRevenue: number;
  grossOperatingProfit: null;
  adr: number;
  revpar: number | null;
  trevpar: null;
  goppar: null;
  occupancyPercent: number;
  dataSource: string;
};

/**
 * Report row → top-level snapshot columns. totalOcc is copied AS IS (it
 * includes house use, like the PMS report) so the board reproduces the
 * original figures; adr / occupancyPercent are the PMS's own (the readers
 * prefer them over recomputing). revenue is net room revenue → the three
 * revenue columns; F&B / GOP are unknown → NULL.
 */
export function mapRowToSnapshot(row: ReportRow, rooms: number, source: string): { snapshotDate: Date; data: SnapshotData } {
  return {
    snapshotDate: dayUtc(row.date),
    data: {
      totalOcc: row.totalOcc,
      arrivalRooms: row.arrRooms,
      departureRooms: row.depRooms,
      compRooms: row.compRooms,
      houseUseRooms: row.houseUse,
      dayUseRooms: row.dayUse,
      noShowRooms: row.noShow,
      oooRooms: row.ooo,
      deductIndividualRooms: row.deductIndiv,
      nonDeductIndividualRooms: row.nonDedIndiv,
      deductGroupRooms: row.deductGroup,
      nonDeductGroupRooms: row.nonDedGroup,
      adultsChildren: row.adlChl,
      roomRevenue: round2(row.revenue),
      totalRevenue: round2(row.revenue),
      netRoomRevenue: round2(row.revenue),
      grossOperatingProfit: null,
      adr: round2(row.adr),
      revpar: rooms > 0 ? round2(row.revenue / rooms) : null,
      trevpar: null,
      goppar: null,
      occupancyPercent: round2(row.occPct),
      dataSource: source
    }
  };
}

export type ForecastDriver = { driver: string; value: string };
export type ForecastData = {
  forecastDate: Date;
  roomTypeId: null;
  ratePlanId: null;
  channelId: null;
  segment: null;
  expectedOccupancy: number;
  expectedRoomsSold: number;
  expectedAdr: number;
  expectedRevpar: number | null;
  expectedTrevpar: null;
  expectedGoppar: null;
  expectedRoomRevenue: number;
  expectedTotalRevenue: number;
  expectedProfit: null;
  cancellationProbability: null;
  noShowProbability: null;
  confidence: number;
  modelVersion: string;
  driversJson: ForecastDriver[];
};

export function mapRowToForecast(row: ReportRow, rooms: number, source: string, reportRange: { from: string; to: string }): ForecastData {
  return {
    forecastDate: dayUtc(row.date),
    roomTypeId: null,
    ratePlanId: null,
    channelId: null,
    segment: null,
    expectedOccupancy: round2(row.occPct),
    expectedRoomsSold: row.totalOcc,
    expectedAdr: round2(row.adr),
    expectedRevpar: rooms > 0 ? round2(row.revenue / rooms) : null,
    expectedTrevpar: null,
    expectedGoppar: null,
    expectedRoomRevenue: round2(row.revenue),
    expectedTotalRevenue: round2(row.revenue),
    expectedProfit: null,
    cancellationProbability: null,
    noShowProbability: null,
    confidence: FORECAST_CONFIDENCE,
    modelVersion: source,
    driversJson: [
      { driver: "adr_source", value: "pms_forecast" },
      { driver: "import_batch", value: source },
      { driver: "report_range", value: `${reportRange.from}..${reportRange.to}` }
    ]
  };
}

// ---- summary ----------------------------------------------------------------
export type SectionSummary = {
  rows: number;
  from: string | null;
  to: string | null;
  roomNights: number;
  paidRoomNights: number;
  revenue: number;
  adr: number | null;
  avgOccPct: number | null;
};
export type ReportSummary = { history: SectionSummary; forecast: SectionSummary; total: SectionSummary };

/** Aggregate occupancy = Σ paid rooms / Σ (rooms − ooo): the figure the PMS prints in the report footer (not the mean of daily %). */
function summarizeSection(rows: readonly ReportRow[], rooms: number): SectionSummary {
  const roomNights = rows.reduce((a, r) => a + r.totalOcc, 0);
  const paidRoomNights = rows.reduce((a, r) => a + paidRooms(r), 0);
  const available = rows.reduce((a, r) => a + Math.max(0, rooms - r.ooo), 0);
  const revenue = round2(rows.reduce((a, r) => a + r.revenue, 0));
  return {
    rows: rows.length,
    from: rows[0]?.date ?? null,
    to: rows[rows.length - 1]?.date ?? null,
    roomNights,
    paidRoomNights,
    revenue,
    adr: paidRoomNights > 0 ? round2(revenue / paidRoomNights) : null,
    avgOccPct: available > 0 ? round2((paidRoomNights / available) * 100) : null
  };
}

export function summarize(rows: readonly ReportRow[], rooms: number): ReportSummary {
  return {
    history: summarizeSection(rows.filter((r) => r.section === "history"), rooms),
    forecast: summarizeSection(rows.filter((r) => r.section === "forecast"), rooms),
    total: summarizeSection(rows, rooms)
  };
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---- reference BAR derivation ----------------------------------------------
export type BarPriceSource = "forecast" | "stly_364" | "stly_371" | "month_avg" | "none";
export type DayAdr = { adr: number; paid: number };
export type BarContext = {
  /** date → { adr, paid } (rows of the forecast section; paid = totalOcc − houseUse). */
  forecastByDate: Map<string, DayAdr>;
  /** date → { adr, paid } (rows of the history section). */
  historyByDate: Map<string, DayAdr>;
  /** month (1-12) → revenue-weighted ADR over the history rows of that month. */
  monthAdr: Map<number, number>;
};

export function buildBarContext(rows: readonly ReportRow[]): BarContext {
  const forecastByDate = new Map<string, DayAdr>();
  const historyByDate = new Map<string, DayAdr>();
  const monthAcc = new Map<number, { revenue: number; paid: number }>();
  for (const r of rows) {
    if (r.section === "forecast") {
      forecastByDate.set(r.date, { adr: r.adr, paid: paidRooms(r) });
      continue;
    }
    historyByDate.set(r.date, { adr: r.adr, paid: paidRooms(r) });
    const month = Number(r.date.slice(5, 7));
    const acc = monthAcc.get(month) ?? { revenue: 0, paid: 0 };
    acc.revenue += r.revenue;
    acc.paid += paidRooms(r);
    monthAcc.set(month, acc);
  }
  const monthAdr = new Map<number, number>();
  for (const [month, acc] of monthAcc) if (acc.paid > 0) monthAdr.set(month, acc.revenue / acc.paid);
  return { forecastByDate, historyByDate, monthAdr };
}

/**
 * A daily ADR (forecast or same-day-last-year) is only a usable reference
 * when the day sold at least this many paid rooms: a day with 1-2 rooms
 * carries whatever those two guests paid (the Los Tilos dry-run surfaced
 * 2026-11-01 → 326,88 € from a single high-rate stay), which is noise, not a
 * tariff. Below the threshold the fallback chain moves on.
 */
export const STLY_MIN_PAID_ROOMS = 5;
/**
 * Band around the month's revenue-weighted ADR inside which a daily ADR is
 * accepted as a reference price. Outside it the day is treated as noise (a
 * single high-rate stay, a negative adjustment, a group block booked without
 * a rate — the Los Tilos forecast for 2026-10-25 carries 21 rooms at 213,64 €
 * = 10,68 € ADR) and the chain falls through. Applied only when the month
 * average exists.
 */
export const STLY_BAND: Readonly<{ min: number; max: number }> = { min: 0.6, max: 1.8 };

/**
 * True when a day's ADR can stand as a reference price: enough paid rooms
 * (STLY_MIN_PAID_ROOMS) and, when the month's revenue-weighted ADR exists,
 * inside STLY_BAND around it. A non-positive ADR (0-room day, negative
 * adjustment) is never representative.
 */
export function isRepresentativeAdr(day: DayAdr | undefined, monthAdr: number | undefined): day is DayAdr {
  const usable = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!day || day.paid < STLY_MIN_PAID_ROOMS || !usable(day.adr)) return false;
  if (usable(monthAdr)) return day.adr >= monthAdr * STLY_BAND.min && day.adr <= monthAdr * STLY_BAND.max;
  return true;
}

/**
 * Base (Standard, double occupancy) reference price for a stay date: the PMS
 * forecast ADR if the report forecasts that day AND it is representative;
 * else the representative ADR of the same weekday last year (d−364, then
 * d−371); else the revenue-weighted ADR of that calendar month in the
 * history. The same representativeness rule applies to forecast and STLY
 * candidates: a forecast day is as exposed to a rate-less group block or a
 * single stay as a history day is.
 */
export function deriveBarPrice(date: string, ctx: BarContext): { price: number | null; source: BarPriceSource } {
  const usable = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const month = ctx.monthAdr.get(Number(date.slice(5, 7)));
  const representative = (day: DayAdr | undefined): day is DayAdr => isRepresentativeAdr(day, month);
  const forecast = ctx.forecastByDate.get(date);
  if (representative(forecast)) return { price: round2(forecast.adr), source: "forecast" };
  const d = dayUtc(date);
  const y364 = ctx.historyByDate.get(isoDate(addDays(d, -364)));
  if (representative(y364)) return { price: round2(y364.adr), source: "stly_364" };
  const y371 = ctx.historyByDate.get(isoDate(addDays(d, -371)));
  if (representative(y371)) return { price: round2(y371.adr), source: "stly_371" };
  if (usable(month)) return { price: round2(month), source: "month_avg" };
  return { price: null, source: "none" };
}

/** Multiplier over the base price by room-type category; single rooms (baseCapacity 1) are priced below the double. */
export const RATE_CATEGORY_MULTIPLIERS: Readonly<Record<string, number>> = { standard: 1, suite: 1.5 };
export const SINGLE_ROOM_MULTIPLIER = 0.85;

export function roomTypeMultiplier(roomType: { defaultRateCategory: string | null; baseCapacity: number }): number {
  if (roomType.baseCapacity === 1) return SINGLE_ROOM_MULTIPLIER;
  const key = (roomType.defaultRateCategory ?? "standard").trim().toLowerCase();
  return RATE_CATEGORY_MULTIPLIERS[key] ?? 1;
}

export function barPriceForRoomType(base: number, roomType: { defaultRateCategory: string | null; baseCapacity: number }): number {
  return round2(base * roomTypeMultiplier(roomType));
}

// ---- planning ---------------------------------------------------------------
export type SnapshotAction = "create" | "update_same_source" | "update_night_audit_zero" | "skipped_protected" | "force_overwrite";
export type SnapshotPlanEntry = { date: string; action: SnapshotAction; existingDataSource: string | null };

export type ExistingSnapshot = { date: string; dataSource: string; totalOcc: number; roomRevenue: number };

/** A night_audit close with 0 rooms and 0 revenue: the scheduler's artefact on a property without operation, or a legitimately empty night. */
export function isNightAuditZero(existing: Pick<ExistingSnapshot, "dataSource" | "totalOcc" | "roomRevenue">): boolean {
  return existing.dataSource === "night_audit" && existing.totalOcc === 0 && existing.roomRevenue === 0;
}

/**
 * Pure decision per history day (see the protection rules in the header).
 * `propertyHasReservations` decides what a night_audit 0/0 row means: on a
 * property that has never had a reservation it can only be the scheduler's
 * artefact (overwritten with a warning); on a property with reservations a
 * zero close may be real (a closed night, a season stop) and is protected
 * like any other foreign source unless --force.
 */
export function planSnapshotAction(existing: ExistingSnapshot | undefined, source: string, force: boolean, propertyHasReservations: boolean): SnapshotAction {
  if (!existing) return "create";
  if (existing.dataSource === source) return "update_same_source";
  if (!propertyHasReservations && isNightAuditZero(existing)) return "update_night_audit_zero";
  return force ? "force_overwrite" : "skipped_protected";
}

export function selectRows(rows: readonly ReportRow[], flags: Pick<ImportFlags, "section" | "from" | "to">): ReportRow[] {
  return rows.filter((r) => {
    if (flags.section !== "both" && r.section !== flags.section) return false;
    if (flags.from && r.date < flags.from) return false;
    if (flags.to && r.date > flags.to) return false;
    return true;
  });
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- run --------------------------------------------------------------------
export type ImportSummary = {
  mode: "import" | "revert";
  dryRun: boolean;
  force: boolean;
  propertyId: string;
  propertyName: string | null;
  organizationId: string | null;
  source: string;
  batchId: string;
  file: string | null;
  sha256: string | null;
  rooms: number;
  sellableRoomsInDb: number | null;
  /** Reservations of the property (any status): 0 → night_audit 0/0 closes are scheduler artefacts; > 0 → they are protected. */
  reservationsInDb: number | null;
  section: ImportFlags["section"];
  range: { from: string | null; to: string | null };
  report: ReportSummary | null;
  errors: RowIssue[];
  warnings: RowIssue[];
  snapshots: {
    planned: number;
    create: number;
    updateSameSource: number;
    updateNightAuditZero: string[];
    /** night_audit 0/0 rows kept because the property has reservations (subset of skippedProtected). */
    nightAuditZeroProtected: string[];
    forceOverwrite: Array<{ date: string; dataSource: string }>;
    skippedProtected: Array<{ date: string; dataSource: string }>;
    written: number;
    reverted: number;
  };
  forecasts: {
    planned: number;
    skippedPast: string[];
    range: { from: string | null; to: string | null };
    deleteSameSource: number;
    otherModelVersions: Array<{ modelVersion: string | null; count: number }>;
    forceDelete: number;
    written: number;
    reverted: number;
  };
  bar: {
    requested: string | null;
    ratePlanId: string | null;
    roomTypes: Array<{ id: string; code: string; multiplier: number }>;
    horizon: { from: string; to: string } | null;
    daysWithPrice: number;
    daysWithoutPrice: string[];
    sourceCounts: Record<BarPriceSource, number>;
    /** Forecast days whose ADR failed the representativeness rule (threshold / band) and fell through to STLY / month average. */
    forecastNotRepresentative: string[];
    rateDaysPlanned: number;
    rateDaysWritten: number;
    rateDaysReverted: number;
    originMarker: string;
    sample: Array<{ date: string; base: number; source: BarPriceSource }>;
  };
  before: { snapshotsByDataSource: Record<string, number>; forecastsByModelVersion: Record<string, number> } | null;
  auditEventId: string | null;
  durationMs: number;
};

const emptyBar = (requested: string | null): ImportSummary["bar"] => ({
  requested,
  ratePlanId: null,
  roomTypes: [],
  horizon: null,
  daysWithPrice: 0,
  daysWithoutPrice: [],
  sourceCounts: { forecast: 0, stly_364: 0, stly_371: 0, month_avg: 0, none: 0 },
  forecastNotRepresentative: [],
  rateDaysPlanned: 0,
  rateDaysWritten: 0,
  rateDaysReverted: 0,
  originMarker: `rate_days.updated_by = ${SYSTEM_USER_ID}`,
  sample: []
});

async function countExisting(propertyId: string, from: Date | null, to: Date | null) {
  const dateFilter = from && to ? { gte: from, lte: to } : from ? { gte: from } : to ? { lte: to } : undefined;
  const [snapshots, forecasts] = await Promise.all([
    prisma.revenueDailySnapshot.groupBy({
      by: ["dataSource"],
      where: { propertyId, ...TOP_LEVEL_SNAPSHOT_WHERE, ...(dateFilter ? { snapshotDate: dateFilter } : {}) },
      _count: { _all: true }
    }),
    prisma.revenueForecast.groupBy({
      by: ["modelVersion"],
      where: { propertyId, roomTypeId: null, ratePlanId: null, channelId: null, segment: null, ...(dateFilter ? { forecastDate: dateFilter } : {}) },
      _count: { _all: true }
    })
  ]);
  return {
    snapshotsByDataSource: Object.fromEntries(snapshots.map((s) => [s.dataSource, s._count._all])),
    forecastsByModelVersion: Object.fromEntries(forecasts.map((f) => [f.modelVersion ?? "(null)", f._count._all]))
  };
}

export async function runImport(flags: ImportFlags, today: Date = dayUtc()): Promise<ImportSummary> {
  const start = Date.now();
  const summary: ImportSummary = {
    mode: flags.revert ? "revert" : "import",
    dryRun: !flags.apply,
    force: flags.force,
    propertyId: flags.propertyId,
    propertyName: null,
    organizationId: null,
    source: flags.source,
    batchId: flags.source,
    file: flags.file,
    sha256: null,
    rooms: flags.rooms,
    sellableRoomsInDb: null,
    reservationsInDb: null,
    section: flags.section,
    range: { from: flags.from, to: flags.to },
    report: null,
    errors: [],
    warnings: [],
    snapshots: { planned: 0, create: 0, updateSameSource: 0, updateNightAuditZero: [], nightAuditZeroProtected: [], forceOverwrite: [], skippedProtected: [], written: 0, reverted: 0 },
    forecasts: { planned: 0, skippedPast: [], range: { from: null, to: null }, deleteSameSource: 0, otherModelVersions: [], forceDelete: 0, written: 0, reverted: 0 },
    bar: emptyBar(flags.publishBar),
    before: null,
    auditEventId: null,
    durationMs: 0
  };

  const property = await prisma.property.findUnique({ where: { id: flags.propertyId }, select: { id: true, name: true, organizationId: true } });
  if (!property) throw new Error(`Propiedad ${flags.propertyId} no encontrada.`);
  summary.propertyName = property.name;
  summary.organizationId = property.organizationId;
  summary.sellableRoomsInDb = await prisma.room.count({ where: { propertyId: property.id, sellable: true } });
  summary.reservationsInDb = await prisma.reservation.count({ where: { propertyId: property.id } });
  const propertyHasReservations = summary.reservationsInDb > 0;

  // ---- parse + validate (both modes: a revert with --file restricts to the file's range) ----
  let rows: ReportRow[] = [];
  if (flags.file) {
    if (!existsSync(flags.file)) throw new Error(`Fichero no encontrado: ${flags.file}`);
    const buffer = readFileSync(flags.file);
    summary.sha256 = sha256Hex(buffer);
    const parsed = parseReportCsv(buffer.toString("utf8"));
    summary.errors.push(...parsed.errors);
    if (parsed.errors.length === 0) {
      const validated = validateRows(parsed.rows, flags.rooms);
      summary.errors.push(...validated.errors);
      summary.warnings.push(...validated.warnings);
      rows = parsed.rows;
      summary.report = summarize(rows, flags.rooms);
    }
    if (summary.errors.length > 0) {
      summary.durationMs = Date.now() - start;
      return summary;
    }
    if (!flags.revert && summary.sellableRoomsInDb !== flags.rooms) {
      summary.warnings.push({
        line: 0,
        date: null,
        kind: "rooms_mismatch",
        message: `--rooms ${flags.rooms} ≠ ${summary.sellableRoomsInDb} habitaciones vendibles en BD (${property.name}); el board usa la BD, el informe se importa con ${flags.rooms}`
      });
    }
  }

  const selected = selectRows(rows, flags);
  const historyRows = selected.filter((r) => r.section === "history");
  const forecastRowsAll = selected.filter((r) => r.section === "forecast");
  const forecastRows = forecastRowsAll.filter((r) => dayUtc(r.date).getTime() >= today.getTime());
  summary.forecasts.skippedPast = forecastRowsAll.filter((r) => dayUtc(r.date).getTime() < today.getTime()).map((r) => r.date);
  for (const date of summary.forecasts.skippedPast) {
    summary.warnings.push({ line: 0, date, kind: "forecast_in_past", message: `forecast ${date} anterior a hoy (${isoDate(today)}): ya es historia, se omite` });
  }
  const reportRange = { from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null };
  const rangeFrom = flags.from ?? reportRange.from;
  const rangeTo = flags.to ?? reportRange.to;
  summary.range = { from: rangeFrom, to: rangeTo };
  summary.before = await countExisting(property.id, rangeFrom ? dayUtc(rangeFrom) : null, rangeTo ? dayUtc(rangeTo) : null);

  const audit = flags.apply ? await import("../modules/audit/audit.service.js") : null;
  if (audit) await audit.hydrateAuditChainFromPostgres();

  // ---- REVERT ----------------------------------------------------------------
  if (flags.revert) {
    const dateFilter = rangeFrom && rangeTo ? { gte: dayUtc(rangeFrom), lte: dayUtc(rangeTo) } : undefined;
    const snapWhere = { propertyId: property.id, ...TOP_LEVEL_SNAPSHOT_WHERE, dataSource: flags.source, ...(dateFilter ? { snapshotDate: dateFilter } : {}) };
    const fcWhere = { propertyId: property.id, roomTypeId: null, ratePlanId: null, channelId: null, segment: null, modelVersion: flags.source, ...(dateFilter ? { forecastDate: dateFilter } : {}) };
    const wantSnapshots = flags.section !== "forecast";
    const wantForecasts = flags.section !== "history";
    summary.snapshots.planned = wantSnapshots ? await prisma.revenueDailySnapshot.count({ where: snapWhere }) : 0;
    summary.forecasts.planned = wantForecasts ? await prisma.revenueForecast.count({ where: fcWhere }) : 0;
    let barWhere: Prisma.RateDayWhereInput | null = null;
    if (flags.publishBar && flags.force) {
      const plan = await prisma.ratePlan.findUnique({ where: { propertyId_code: { propertyId: property.id, code: flags.publishBar } }, select: { id: true } });
      if (!plan) throw new Error(`Rate plan "${flags.publishBar}" no existe en ${property.name}.`);
      summary.bar.ratePlanId = plan.id;
      barWhere = { propertyId: property.id, ratePlanId: plan.id, updatedBy: SYSTEM_USER_ID };
      summary.bar.rateDaysPlanned = await prisma.rateDay.count({ where: barWhere });
    }
    if (flags.apply) {
      await prisma.$transaction(async (tx) => {
        if (wantSnapshots) summary.snapshots.reverted = (await tx.revenueDailySnapshot.deleteMany({ where: snapWhere })).count;
        if (wantForecasts) summary.forecasts.reverted = (await tx.revenueForecast.deleteMany({ where: fcWhere })).count;
        if (barWhere) summary.bar.rateDaysReverted = (await tx.rateDay.deleteMany({ where: barWhere })).count;
      }, TX_OPTIONS);
      const event = audit!.recordAuditEvent({
        organizationId: property.organizationId,
        propertyId: property.id,
        actorUserId: SYSTEM_USER_ID,
        actorType: "system",
        action: "PMS_HISTORY_FORECAST_REVERTED",
        entityType: "property",
        entityId: property.id,
        beforeJson: summary.before,
        afterJson: {
          source: flags.source,
          batchId: summary.batchId,
          sha256: summary.sha256,
          range: summary.range,
          snapshotsDeleted: summary.snapshots.reverted,
          forecastsDeleted: summary.forecasts.reverted,
          rateDaysDeleted: summary.bar.rateDaysReverted
        },
        correlationId: `corr_pms_import_${flags.source}`
      });
      summary.auditEventId = event.id;
      await audit!.flushAuditQueues();
    }
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // ---- IMPORT: plan history --------------------------------------------------
  const snapshotWrites: Array<{ date: string; existingId: string | null; data: SnapshotData; snapshotDate: Date }> = [];
  if (historyRows.length > 0) {
    const existing = await prisma.revenueDailySnapshot.findMany({
      where: { propertyId: property.id, ...TOP_LEVEL_SNAPSHOT_WHERE, snapshotDate: { gte: dayUtc(historyRows[0].date), lte: dayUtc(historyRows[historyRows.length - 1].date) } },
      select: { id: true, snapshotDate: true, dataSource: true, totalOcc: true, roomRevenue: true }
    });
    const byDate = new Map(existing.map((s) => [isoDate(dayUtc(s.snapshotDate)), s] as const));
    for (const row of historyRows) {
      const current = byDate.get(row.date);
      const existing = current ? { date: row.date, dataSource: current.dataSource, totalOcc: current.totalOcc, roomRevenue: Number(current.roomRevenue) } : undefined;
      const action = planSnapshotAction(existing, flags.source, flags.force, propertyHasReservations);
      if (action === "skipped_protected") {
        summary.snapshots.skippedProtected.push({ date: row.date, dataSource: current!.dataSource });
        if (existing && isNightAuditZero(existing)) summary.snapshots.nightAuditZeroProtected.push(row.date);
        continue;
      }
      if (action === "create") summary.snapshots.create++;
      else if (action === "update_same_source") summary.snapshots.updateSameSource++;
      else if (action === "update_night_audit_zero") {
        summary.snapshots.updateNightAuditZero.push(row.date);
        summary.warnings.push({ line: row.line, date: row.date, kind: "night_audit_zero_overwritten", message: `fila ${row.line} (${row.date}): cierre night_audit a 0 hab / 0 € (artefacto del scheduler) se sobrescribe con el PMS` });
      } else summary.snapshots.forceOverwrite.push({ date: row.date, dataSource: current!.dataSource });
      const mapped = mapRowToSnapshot(row, flags.rooms, flags.source);
      snapshotWrites.push({ date: row.date, existingId: current?.id ?? null, data: mapped.data, snapshotDate: mapped.snapshotDate });
    }
    summary.snapshots.planned = snapshotWrites.length;
    if (summary.snapshots.skippedProtected.length > 0 && !flags.force) {
      summary.warnings.push({
        line: 0,
        date: null,
        kind: "snapshots_protected",
        message: `${summary.snapshots.skippedProtected.length} días con snapshot de otro origen (${[...new Set(summary.snapshots.skippedProtected.map((s) => s.dataSource))].join(", ")}) no se tocan; usa --force para sobrescribirlos`
      });
    }
    if (summary.snapshots.nightAuditZeroProtected.length > 0) {
      summary.warnings.push({
        line: 0,
        date: null,
        kind: "night_audit_zero_protected",
        message: `${summary.snapshots.nightAuditZeroProtected.length} cierres night_audit a 0 hab / 0 € se conservan: la propiedad tiene ${summary.reservationsInDb} reservas y un cierre a cero puede ser legítimo (solo se sobrescriben automáticamente en propiedades sin ninguna reserva); usa --force para pisarlos`
      });
    }
  }

  // ---- IMPORT: plan forecast -------------------------------------------------
  let forecastData: Array<ForecastData & { propertyId: string }> = [];
  let forecastRange: { from: Date; to: Date } | null = null;
  if (forecastRows.length > 0) {
    forecastRange = { from: dayUtc(forecastRows[0].date), to: dayUtc(forecastRows[forecastRows.length - 1].date) };
    summary.forecasts.range = { from: forecastRows[0].date, to: forecastRows[forecastRows.length - 1].date };
    const grouped = await prisma.revenueForecast.groupBy({
      by: ["modelVersion"],
      where: { propertyId: property.id, roomTypeId: null, ratePlanId: null, channelId: null, segment: null, forecastDate: { gte: forecastRange.from, lte: forecastRange.to } },
      _count: { _all: true }
    });
    for (const g of grouped) {
      if (g.modelVersion === flags.source) summary.forecasts.deleteSameSource = g._count._all;
      else summary.forecasts.otherModelVersions.push({ modelVersion: g.modelVersion, count: g._count._all });
    }
    summary.forecasts.forceDelete = flags.force ? summary.forecasts.otherModelVersions.reduce((a, g) => a + g.count, 0) : 0;
    if (summary.forecasts.otherModelVersions.length > 0) {
      const list = summary.forecasts.otherModelVersions.map((g) => `${g.modelVersion ?? "(null)"}×${g.count}`).join(", ");
      summary.warnings.push({
        line: 0,
        date: null,
        kind: flags.force ? "forecasts_force_deleted" : "forecasts_other_model",
        message: flags.force
          ? `--force: se borran ${summary.forecasts.forceDelete} forecasts top-level de otros modelVersion en el rango (${list})`
          : `en el rango hay forecasts top-level de otros modelVersion que NO se tocan (${list}); el board prefiere la fila más reciente — usa --force para borrarlos`
      });
    }
    const range = { from: reportRange.from ?? forecastRows[0].date, to: reportRange.to ?? forecastRows[forecastRows.length - 1].date };
    forecastData = forecastRows.map((r) => ({ propertyId: property.id, ...mapRowToForecast(r, flags.rooms, flags.source, range) }));
    summary.forecasts.planned = forecastData.length;
  }

  // ---- IMPORT: plan reference BAR ------------------------------------------
  const rateDayWrites: Array<{ roomTypeId: string; date: Date; price: number }> = [];
  let barPlanId: string | null = null;
  if (flags.publishBar) {
    const plan = await prisma.ratePlan.findUnique({ where: { propertyId_code: { propertyId: property.id, code: flags.publishBar } }, select: { id: true, active: true } });
    if (!plan) {
      throw new Error(`Rate plan "${flags.publishBar}" no existe en ${property.name} (${property.id}): lo crea el provisionador de la propiedad; créalo antes de --publish-bar.`);
    }
    barPlanId = plan.id;
    summary.bar.ratePlanId = plan.id;
    const roomTypes = await prisma.roomType.findMany({
      where: { propertyId: property.id, active: true },
      select: { id: true, code: true, defaultRateCategory: true, baseCapacity: true },
      orderBy: { displayOrder: "asc" }
    });
    if (roomTypes.length === 0) throw new Error(`La propiedad ${property.name} no tiene room types activos: nada sobre lo que publicar la BAR.`);
    summary.bar.roomTypes = roomTypes.map((rt) => ({ id: rt.id, code: rt.code, multiplier: roomTypeMultiplier(rt) }));
    const ctx = buildBarContext(rows);
    const horizonFrom = today;
    const horizonTo = addDays(today, BAR_HORIZON_DAYS - 1);
    summary.bar.horizon = { from: isoDate(horizonFrom), to: isoDate(horizonTo) };
    for (let t = horizonFrom.getTime(); t <= horizonTo.getTime(); t += MS_DAY) {
      const date = isoDate(new Date(t));
      const derived = deriveBarPrice(date, ctx);
      summary.bar.sourceCounts[derived.source]++;
      // A forecast day that did not end up priced from the forecast failed
      // the representativeness rule: listed (and shown in the sample) so the
      // operator sees which PMS forecast days were discarded and why.
      const forecastRejected = ctx.forecastByDate.has(date) && derived.source !== "forecast";
      if (forecastRejected) summary.bar.forecastNotRepresentative.push(date);
      if (derived.price === null) {
        summary.bar.daysWithoutPrice.push(date);
        continue;
      }
      summary.bar.daysWithPrice++;
      if (summary.bar.sample.length < 5 || date.endsWith("-01") || forecastRejected) summary.bar.sample.push({ date, base: derived.price, source: derived.source });
      for (const rt of roomTypes) rateDayWrites.push({ roomTypeId: rt.id, date: new Date(t), price: barPriceForRoomType(derived.price, rt) });
    }
    summary.bar.rateDaysPlanned = rateDayWrites.length;
    if (summary.bar.daysWithoutPrice.length > 0) {
      summary.warnings.push({ line: 0, date: null, kind: "bar_days_without_price", message: `${summary.bar.daysWithoutPrice.length} días del horizonte sin ADR de referencia (sin forecast, STLY ni media mensual): sin BAR` });
    }
    if (summary.bar.forecastNotRepresentative.length > 0) {
      const detail = summary.bar.forecastNotRepresentative.map((d) => {
        const f = ctx.forecastByDate.get(d)!;
        return `${d} (${f.paid} hab. pagadas, ADR ${f.adr.toFixed(2)})`;
      });
      summary.warnings.push({
        line: 0,
        date: null,
        kind: "bar_forecast_not_representative",
        message: `${detail.length} días de forecast con ADR no representativo (< ${STLY_MIN_PAID_ROOMS} hab. pagadas o fuera de ${STLY_BAND.min}–${STLY_BAND.max}× la media del mes) → precio base por STLY / media mensual: ${detail.join(", ")}`
      });
    }
  }

  // ---- APPLY -----------------------------------------------------------------
  if (flags.apply) {
    for (const block of chunk(snapshotWrites, SNAPSHOT_CHUNK_DAYS)) {
      await prisma.$transaction(async (tx) => {
        for (const w of block) {
          if (w.existingId) await tx.revenueDailySnapshot.update({ where: { id: w.existingId }, data: w.data });
          else await tx.revenueDailySnapshot.create({ data: { propertyId: property.id, snapshotDate: w.snapshotDate, ...TOP_LEVEL_SNAPSHOT_WHERE, ...w.data } });
          summary.snapshots.written++;
        }
      }, TX_OPTIONS);
    }
    if (forecastRange && forecastData.length > 0) {
      const range = forecastRange;
      await prisma.$transaction(async (tx) => {
        await tx.revenueForecast.deleteMany({
          where: {
            propertyId: property.id,
            roomTypeId: null,
            ratePlanId: null,
            channelId: null,
            segment: null,
            forecastDate: { gte: range.from, lte: range.to },
            ...(flags.force ? {} : { modelVersion: flags.source })
          }
        });
        const created = await tx.revenueForecast.createMany({
          data: forecastData.map((f) => ({ ...f, driversJson: f.driversJson as unknown as Prisma.InputJsonValue }))
        });
        summary.forecasts.written = created.count;
      }, TX_OPTIONS);
    }
    if (barPlanId && rateDayWrites.length > 0) {
      const planId = barPlanId;
      for (const block of chunk(rateDayWrites, 200)) {
        await prisma.$transaction(async (tx) => {
          for (const w of block) {
            await tx.rateDay.upsert({
              where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: property.id, ratePlanId: planId, roomTypeId: w.roomTypeId, date: w.date } },
              create: { propertyId: property.id, ratePlanId: planId, roomTypeId: w.roomTypeId, date: w.date, price: w.price, currency: BAR_CURRENCY, manuallyOverridden: false, updatedBy: SYSTEM_USER_ID },
              update: { price: w.price, currency: BAR_CURRENCY, manuallyOverridden: false, updatedBy: SYSTEM_USER_ID }
            });
            summary.bar.rateDaysWritten++;
          }
        }, TX_OPTIONS);
      }
    }
    const event = audit!.recordAuditEvent({
      organizationId: property.organizationId,
      propertyId: property.id,
      actorUserId: SYSTEM_USER_ID,
      actorType: "system",
      action: "PMS_HISTORY_FORECAST_IMPORTED",
      entityType: "property",
      entityId: property.id,
      beforeJson: summary.before,
      afterJson: {
        report: summary.report,
        batchId: summary.batchId,
        sha256: summary.sha256,
        source: flags.source,
        rooms: flags.rooms,
        section: flags.section,
        range: summary.range,
        snapshots: {
          written: summary.snapshots.written,
          create: summary.snapshots.create,
          updateSameSource: summary.snapshots.updateSameSource,
          updateNightAuditZero: summary.snapshots.updateNightAuditZero.length,
          forceOverwrite: summary.snapshots.forceOverwrite.length,
          skippedProtected: summary.snapshots.skippedProtected.length
        },
        forecasts: { written: summary.forecasts.written, range: summary.forecasts.range, skippedPast: summary.forecasts.skippedPast.length, forceDelete: summary.forecasts.forceDelete },
        rateDays: { ratePlanId: summary.bar.ratePlanId, written: summary.bar.rateDaysWritten, horizon: summary.bar.horizon, sourceCounts: summary.bar.sourceCounts, originMarker: summary.bar.originMarker }
      },
      correlationId: `corr_pms_import_${flags.source}`
    });
    summary.auditEventId = event.id;
    await audit!.flushAuditQueues();
  }

  summary.durationMs = Date.now() - start;
  return summary;
}

// ---- output -----------------------------------------------------------------
const eur = (n: number | null) => (n === null ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €");

export function printHuman(summary: ImportSummary): void {
  const tag = "[pms:import-hf]";
  const lines: string[] = [];
  lines.push(`${tag} ${summary.mode === "revert" ? "REVERT" : "IMPORT"} · ${summary.dryRun ? "DRY-RUN (nada escrito)" : "APPLIED"}${summary.force ? " · --force" : ""} · ${summary.durationMs} ms`);
  lines.push(
    `  Propiedad: ${summary.propertyName ?? "?"} (${summary.propertyId}) · org ${summary.organizationId ?? "?"} · ${summary.sellableRoomsInDb ?? "?"} hab. vendibles en BD · ${summary.reservationsInDb ?? "?"} reservas en BD${summary.rooms > 0 ? ` · --rooms ${summary.rooms}` : ""}`
  );
  lines.push(`  Source/batch: ${summary.source} · sección ${summary.section} · rango ${summary.range.from ?? "—"} → ${summary.range.to ?? "—"}`);
  if (summary.file) lines.push(`  Fichero: ${summary.file} · sha256 ${summary.sha256}`);
  if (summary.errors.length > 0) {
    lines.push(`  ERRORES (${summary.errors.length}) — no se importa nada:`);
    for (const e of summary.errors.slice(0, 50)) lines.push(`    · ${e.message}`);
    if (summary.errors.length > 50) lines.push(`    · … y ${summary.errors.length - 50} más (usa --json)`);
  }
  if (summary.report) {
    const r = summary.report;
    const fmt = (label: string, s: SectionSummary) =>
      `    ${label.padEnd(9)} ${String(s.rows).padStart(4)} filas · ${s.from ?? "—"} → ${s.to ?? "—"} · ${s.roomNights} rn (${s.paidRoomNights} pagadas) · ${eur(s.revenue)} · ADR ${s.adr === null ? "—" : s.adr.toFixed(2)} · occ media ${s.avgOccPct === null ? "—" : s.avgOccPct.toFixed(2) + " %"}`;
    lines.push("  Informe:");
    lines.push(fmt("history", r.history));
    lines.push(fmt("forecast", r.forecast));
    lines.push(fmt("total", r.total));
  }
  if (summary.before) {
    const s = Object.entries(summary.before.snapshotsByDataSource).map(([k, v]) => `${k}×${v}`).join(", ") || "ninguno";
    const f = Object.entries(summary.before.forecastsByModelVersion).map(([k, v]) => `${k}×${v}`).join(", ") || "ninguno";
    lines.push(`  En BD (rango, top-level): snapshots ${s} · forecasts ${f}`);
  }
  if (summary.mode === "revert") {
    lines.push(`  Revert: ${summary.snapshots.planned} snapshots y ${summary.forecasts.planned} forecasts con source ${summary.source}${summary.bar.ratePlanId ? ` · ${summary.bar.rateDaysPlanned} rate_days (${summary.bar.originMarker})` : " · rate_days no se tocan (requiere --publish-bar --force)"}`);
    if (!summary.dryRun) lines.push(`  Borrados: ${summary.snapshots.reverted} snapshots · ${summary.forecasts.reverted} forecasts · ${summary.bar.rateDaysReverted} rate_days`);
  } else if (summary.errors.length === 0) {
    const sn = summary.snapshots;
    lines.push(`  Snapshots (history): ${sn.planned} a escribir → ${sn.create} create · ${sn.updateSameSource} update mismo source · ${sn.updateNightAuditZero.length} update night_audit 0/0 · ${sn.forceOverwrite.length} force · ${sn.skippedProtected.length} skipped protected${summary.dryRun ? "" : ` · escritos ${sn.written}`}`);
    if (sn.skippedProtected.length > 0) {
      const byDs = new Map<string, string[]>();
      for (const s of sn.skippedProtected) byDs.set(s.dataSource, [...(byDs.get(s.dataSource) ?? []), s.date]);
      for (const [ds, dates] of byDs) lines.push(`    skipped protected [${ds}] (${dates.length}): ${compressDates(dates)}`);
    }
    if (sn.nightAuditZeroProtected.length > 0) {
      lines.push(`    de ellos night_audit 0/0 protegidos por tener la propiedad ${summary.reservationsInDb} reservas (${sn.nightAuditZeroProtected.length}): ${compressDates(sn.nightAuditZeroProtected)}`);
    }
    if (sn.updateNightAuditZero.length > 0) lines.push(`    update night_audit 0/0 (${sn.updateNightAuditZero.length}): ${compressDates(sn.updateNightAuditZero)}`);
    if (sn.forceOverwrite.length > 0) lines.push(`    force overwrite (${sn.forceOverwrite.length}): ${compressDates(sn.forceOverwrite.map((s) => s.date))}`);
    const fc = summary.forecasts;
    lines.push(`  Forecasts: ${fc.planned} a escribir (${fc.range.from ?? "—"} → ${fc.range.to ?? "—"}) · borra ${fc.deleteSameSource} del mismo modelVersion${fc.forceDelete ? ` · --force borra ${fc.forceDelete} de otros` : ""} · ${fc.skippedPast.length} omitidos (pasado)${summary.dryRun ? "" : ` · escritos ${fc.written}`}`);
    if (fc.otherModelVersions.length > 0) lines.push(`    otros modelVersion en el rango: ${fc.otherModelVersions.map((g) => `${g.modelVersion ?? "(null)"}×${g.count}`).join(", ")}`);
    if (summary.bar.requested) {
      const b = summary.bar;
      lines.push(`  BAR de referencia (plan ${b.requested} ${b.ratePlanId}): ${b.rateDaysPlanned} rate_days = ${b.daysWithPrice} días × ${b.roomTypes.length} tipos (${b.roomTypes.map((rt) => `${rt.code}×${rt.multiplier}`).join(", ")}) · horizonte ${b.horizon?.from} → ${b.horizon?.to}`);
      lines.push(
        `    origen del precio base: forecast ${b.sourceCounts.forecast} (${b.forecastNotRepresentative.length} días de forecast no representativos → STLY/media) · STLY d−364 ${b.sourceCounts.stly_364} · d−371 ${b.sourceCounts.stly_371} · media mes ${b.sourceCounts.month_avg} · sin precio ${b.sourceCounts.none} · marca ${b.originMarker}`
      );
      lines.push(`    muestra: ${b.sample.map((s) => `${s.date}=${s.base.toFixed(2)} (${s.source})`).join(", ")}`);
      lines.push("    NOTA: BAR derivada del ADR del PMS para que el módulo revenue tenga una BAR publicada; NO es el tarifario real.");
      if (!summary.dryRun) lines.push(`    rate_days escritos: ${b.rateDaysWritten}`);
    }
  }
  if (summary.warnings.length > 0) {
    lines.push(`  AVISOS (${summary.warnings.length}):`);
    for (const w of summary.warnings.slice(0, 40)) lines.push(`    · ${w.message}`);
    if (summary.warnings.length > 40) lines.push(`    · … y ${summary.warnings.length - 40} más (usa --json)`);
  }
  if (summary.auditEventId) lines.push(`  Audit: ${summary.auditEventId} (corr_pms_import_${summary.source})`);
  if (summary.dryRun && summary.errors.length === 0) {
    lines.push(`  Nada escrito. Haz backup (bash scripts/backup-postgres.sh) y repite con --apply --confirm ${summary.propertyId}`);
  }
  if (!summary.dryRun) lines.push("  Los espejos in-memory del API no cambian: reinicia el API si la propiedad es nueva.");
  console.log(lines.join("\n"));
}

/** "2025-08-01, 2025-08-02, …" → "2025-08-01→2025-08-31, 2025-09-05" (contiguous runs collapsed). */
export function compressDates(dates: readonly string[]): string {
  const sorted = [...dates].sort();
  const runs: string[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const d of sorted) {
    if (start === null) {
      start = d;
      prev = d;
      continue;
    }
    if (isoDate(addDays(dayUtc(prev!), 1)) === d) {
      prev = d;
      continue;
    }
    runs.push(start === prev ? start : `${start}→${prev}`);
    start = d;
    prev = d;
  }
  if (start !== null) runs.push(start === prev ? start : `${start}→${prev}`);
  return runs.join(", ");
}

// ---- entrypoint -------------------------------------------------------------
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: ImportFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[pms:import-hf] ${(error as Error).message}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  runImport(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.errors.length;
    })
    .then((errors) => process.exit(errors > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[pms:import-hf] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
