// OPERA Cloud · modo sombra (Tanda 7b · L3) — reglas PURAS del servicio de
// cortes (pms-shadow.service.ts), del job del líder (pms-shadow.job.ts), del
// conector de correo con propósito `pms_shadow` y del CLI `pms-shadow:pull`.
// Sin base de datos ni red: todo lo que hay aquí se prueba en
// __tests__/pms-shadow-rules.test.mts sin levantar nada.
//
//   · classifyFeed: nombre de fichero y primeras líneas → feed (§6.5: «clasificación
//     del feed por nombre de fichero / cabecera»); null → OPERA_FEED_UNRECOGNIZED.
//   · systemContext: UserContext de sistema (usr_system_pms_shadow) con las claves que
//     exigen el modo `sync` del importador (4 claves pms.*) y el importador de
//     ingresos (accounting.journal.post); nunca integrations.connect.
//   · buildAlertsFromSyncResult: bloque `sync` del lote → alertas del run (§5.2, §5.3,
//     §5.5) citando nº de confirmación y código de reserva, nunca el nombre.
//   · computeLateFeeds: perfiles + runs del día → OPERA_FEED_LATE (§6.5): hora
//     esperada en la zona horaria de la propiedad + gracia, businessDateOffset.
//   · compareReconciliation: declarado por OPERA frente a calculado por Anfitorio con
//     las tolerancias de §5.4 → filas de la tabla del panel.
//   · parseDeclaredStats: JSON o XML (Manager Report / Trial Balance en formato «modelo
//     de datos» de BI Publisher) → métricas declaradas [S: nombres de elemento por
//     sinónimos plegados; se cierran con la muestra real de Faranda].
//   · mapRunSourceToImportSource: origen del run → `optionsJson.source` del lote.
//   · headerOverrideFor: un «Delimited Data» sin fila de cabecera recibe la cabecera
//     sintética del perfil (`feeds.<feed>.headerless`).

import { Prisma } from "@prisma/client";
import type {
  IsoDate,
  PermissionKey,
  PmsShadowAlertCode,
  PmsShadowFeed,
  PmsShadowReconciliationRow,
  PmsShadowReservationFeed,
  PmsShadowRunAlert,
  PmsShadowRunSource,
  PmsShadowSchedule,
  PmsShadowScheduleFeed,
  ReservationImportSource,
  ReservationImportSyncResult
} from "@hotelos/shared";
import {
  OPERA_CLOUD_PROFILE,
  PMS_SHADOW_ALERT_LABELS_ES,
  PMS_SHADOW_ALERT_SEVERITY,
  PMS_SHADOW_FEEDS,
  PMS_SHADOW_FEED_LATE_GRACE_MINUTES,
  PMS_SHADOW_RECON_TOLERANCES,
  PMS_SHADOW_RESERVATION_FEEDS,
  PMS_SHADOW_SYSTEM_USER_ID
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { parseXml, walkXml, type XmlNode } from "../../lib/xml-lite.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** `feed` que se guarda en el run cuando el fichero no encaja con ningún feed (modo `auto`); fuera de PMS_SHADOW_FEEDS a propósito. */
export const PMS_SHADOW_UNRECOGNIZED_FEED = "unknown";
export const PMS_SHADOW_SYSTEM_DEVICE_ID = "system:pms-shadow";
export const PMS_SHADOW_SYSTEM_FULL_NAME = "Modo sombra OPERA";
/** Claves del contexto de sistema: las que exige `importReservations` en modo `sync` y `importPmsShadowRevenue`; nunca `integrations.connect`. */
export const PMS_SHADOW_SYSTEM_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  "pms.reservation.read",
  "pms.reservation.create",
  "pms.reservation.modify",
  "pms.checkin.execute",
  "pms.checkout.execute",
  "integrations.read",
  "accounting.journal.post"
]);
/** Runs `processing` con `startedAt` más antiguo que esto → `failed` «interrumpido» (job del líder). */
export const PMS_SHADOW_STALE_RUN_MINUTES = 30;
/**
 * Programación por defecto de un perfil nuevo (§7.2: informes a las 06:00 tras el night audit; ingresos EOD).
 *
 * SC-07: `departures` con offset −1, no 0. El informe `departure_all` del business date EN CURSO a las
 * 06:30 lista las salidas todavía en casa («Due Out» → `checked_in`) y nunca «Checked Out»: el check-out
 * sombra (§5.3) no se producía. Programado con Date Option = business date − 1 tras el night audit trae las
 * salidas de ayer ya «Checked Out»; la ventana del diff (`syncWindowContains`: `departureDate === businessDate`)
 * y `OPERA_FEED_LATE` (hoy local − 1) casan con esa fecha.
 */
export const DEFAULT_PMS_SHADOW_SCHEDULE: PmsShadowSchedule = Object.freeze({
  feeds: [
    { feed: "arrivals", expectedTime: "06:30", businessDateOffset: 0, required: true },
    { feed: "departures", expectedTime: "06:30", businessDateOffset: -1, required: true },
    { feed: "changes", expectedTime: "06:30", businessDateOffset: -1, required: false },
    { feed: "revenue", expectedTime: "07:00", businessDateOffset: -1, required: true },
    { feed: "stats", expectedTime: "07:00", businessDateOffset: -1, required: false }
  ]
}) as PmsShadowSchedule;

const Decimal = Prisma.Decimal;
type Dec = Prisma.Decimal;

// ---------------------------------------------------------------------------
// Clasificación del feed
// ---------------------------------------------------------------------------

/** Patrones por nombre de fichero (plegado a minúsculas), en orden de prioridad. */
const FEED_NAME_PATTERNS: ReadonlyArray<readonly [RegExp, PmsShadowFeed]> = [
  [/responsys_resv|arrival|res_detail|arrchkinbyroom|llegadas/, "arrivals"],
  [/departure|salidas/, "departures"],
  [/gibyroom|inhouse|in_house|in-house|en_casa/, "inhouse"],
  [/rescancel|nanoshow|noshow|resreservyesterday|changes|cambios/, "changes"],
  [/gen_xmlbo_rev|findeptcodes|findept|responsys_trx|revenue|ingresos/, "revenue"],
  [/manager_report|trial_balance|gen_xmlbo_stat|statistics|stats|estadisticas/, "stats"]
];

function firstNonEmptyLine(head: string): string {
  return head.replace(/^\uFEFF/, "").split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
}

/**
 * Nombre de fichero → feed; si no, contenido: cabecera con RESERVATION_ID (Responsys)
 * → arrivals; `<revenue` (GEN_XMLBO_REVENUE) o «Trn. Code» / TRANSACTION_ID
 * (findeptcodes / RESPONSYS_TRX) → revenue; `<statistic_record` (GEN_XMLBO_STATISTICS)
 * → stats. null cuando nada encaja.
 */
export function classifyFeed(input: { fileName?: string | null; head?: string | null }): PmsShadowFeed | null {
  const name = (input.fileName ?? "").trim().toLowerCase();
  if (name) {
    for (const [pattern, feed] of FEED_NAME_PATTERNS) if (pattern.test(name)) return feed;
  }
  const head = (input.head ?? "").replace(/^\uFEFF/, "");
  if (!head.trim()) return null;
  const line = firstNonEmptyLine(head).toLowerCase();
  if (/\breservation_id\b/.test(line) && /arrival_date|departure_date/.test(line)) return "arrivals";
  if (/^\s*(<\?xml|<!--|<[a-z_])/i.test(head)) {
    if (/<(?:[a-z_][\w.-]*:)?revenue\b/i.test(head)) return "revenue";
    if (/<(?:[a-z_][\w.-]*:)?trn_code\b/i.test(head)) return "revenue";
    if (/<(?:[a-z_][\w.-]*:)?statistic_record\b/i.test(head)) return "stats";
    if (/arrival_rooms|rooms_occupied|transaction_total_today|room_revenue/i.test(head)) return "stats";
    return null;
  }
  if (/trn\.?\s*_?code/.test(line) && /day\s*_?net|day\s*_?gross/.test(line)) return "revenue";
  if (/transaction_id|revenue_types|revenue_amounts/.test(line)) return "revenue";
  return null;
}

export function isReservationFeed(feed: string): feed is PmsShadowReservationFeed {
  return (PMS_SHADOW_RESERVATION_FEEDS as readonly string[]).includes(feed);
}

export function isKnownFeed(feed: string): feed is PmsShadowFeed {
  return (PMS_SHADOW_FEEDS as readonly string[]).includes(feed);
}

// ---------------------------------------------------------------------------
// Cabecera sintética («Delimited Data» sin fila de cabecera)
// ---------------------------------------------------------------------------

/** `foldValue` de reservation-import.mapping.ts: minúsculas, sin diacríticos, `[^a-z0-9]+` → «_». */
export function foldLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitFirstLine(line: string): string[] {
  const candidates = [";", ",", "\t", "|"];
  let best = ";";
  let bestCount = -1;
  for (const delimiter of candidates) {
    const count = line.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return line.split(best).map((cell) => cell.replace(/^"|"$/g, "").trim());
}

/**
 * Perfil con `headerless` (hoy solo `departures`): si la primera línea del fichero
 * NO contiene al menos la mitad de las cabeceras literales del perfil, el fichero
 * viene sin cabecera y se devuelve la sintética (`headerOverride` del importador);
 * si la trae, undefined (el importador la lee tal cual).
 */
export function headerOverrideFor(feed: PmsShadowReservationFeed, head: string | null | undefined): string[] | undefined {
  const profile = OPERA_CLOUD_PROFILE.feeds[feed];
  if (!profile?.headerless || profile.headerless.length === 0) return undefined;
  const line = firstNonEmptyLine(head ?? "");
  if (!line) return [...profile.headerless];
  const cells = new Set(splitFirstLine(line).map(foldLabel));
  const expected = profile.headerless.map(foldLabel);
  const hits = expected.filter((column) => cells.has(column)).length;
  return hits * 2 >= expected.length ? undefined : [...profile.headerless];
}

// ---------------------------------------------------------------------------
// Contexto de sistema y orígenes
// ---------------------------------------------------------------------------

/** Contexto con el que el ingest por clave de API, el correo, el CLI y el job llaman a los importadores. */
export function systemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: PMS_SHADOW_SYSTEM_USER_ID,
    fullName: PMS_SHADOW_SYSTEM_FULL_NAME,
    deviceId: PMS_SHADOW_SYSTEM_DEVICE_ID,
    permissions: [...PMS_SHADOW_SYSTEM_PERMISSIONS],
    isPlatformAdmin: false
  };
}

/** `PmsShadowRun.source` → `ReservationImport.optionsJson.source` (RESERVATION_IMPORT_SOURCES). */
export function mapRunSourceToImportSource(source: PmsShadowRunSource): ReservationImportSource {
  switch (source) {
    case "email":
      return "email";
    case "api_key":
      return "api_key";
    case "cli":
      return "cli";
    case "manual":
      return "http";
    case "sftp":
    case "ohip":
      return "job";
  }
}

// ---------------------------------------------------------------------------
// Alertas del run a partir del bloque `sync` del lote
// ---------------------------------------------------------------------------

export type SyncRunRef = { id?: string | null; feed: string; businessDate: IsoDate | string | null };

function alert(code: PmsShadowAlertCode, message: string, extra: { confirmationNo?: string | null; details?: Record<string, unknown>; severity?: PmsShadowRunAlert["severity"] } = {}): PmsShadowRunAlert {
  return {
    code,
    severity: extra.severity ?? PMS_SHADOW_ALERT_SEVERITY[code],
    message,
    ...(extra.confirmationNo !== undefined ? { confirmationNo: extra.confirmationNo } : {}),
    ...(extra.details ? { details: extra.details } : {})
  };
}

/**
 * Reservas ausentes (warning en el primer corte, error a partir del segundo: §5.2
 * exige confirmación manual tras 2 cortes), conflictos con reservas locales y
 * check-ins sin habitación. Solo nº de confirmación y código de reserva.
 */
export function buildAlertsFromSyncResult(sync: ReservationImportSyncResult | undefined | null, run: SyncRunRef): PmsShadowRunAlert[] {
  if (!sync) return [];
  const businessDate = run.businessDate ?? sync.businessDate;
  const out: PmsShadowRunAlert[] = [];
  for (const missing of sync.missing) {
    const streak = missing.missingStreak;
    out.push(
      alert(
        "OPERA_MISSING_IN_SNAPSHOT",
        `La reserva ${missing.confirmationNo} (${missing.reservationCode}, llegada ${missing.arrivalDate}) no aparece en el corte ${run.feed} del ${businessDate}: ${streak} corte(s) consecutivo(s) ausente(s). No se cancela automáticamente${streak >= 2 ? "; confirma en OPERA y resuelve la alerta con motivo" : ""}.`,
        { confirmationNo: missing.confirmationNo, severity: streak >= 2 ? "error" : "warning", details: { reservationCode: missing.reservationCode, arrivalDate: missing.arrivalDate, missingStreak: streak, feed: run.feed, businessDate, ...(run.id ? { runId: run.id } : {}) } }
      )
    );
  }
  for (const conflict of sync.conflicts) {
    out.push(
      alert(
        "OPERA_CONFLICT_LOCAL_RESERVATION",
        `El nº de confirmación ${conflict.confirmationNo} coincide con la reserva ${conflict.reservationCode} creada en Anfitorio por otra vía (fila ${conflict.rowNumber}): fila omitida.`,
        { confirmationNo: conflict.confirmationNo, details: { reservationCode: conflict.reservationCode, rowNumber: conflict.rowNumber, feed: run.feed, businessDate } }
      )
    );
  }
  for (const item of sync.checkInWithoutRoom) {
    out.push(
      alert(
        "OPERA_CHECKIN_WITHOUT_ROOM",
        `OPERA tiene en casa la reserva ${item.confirmationNo} (${item.reservationCode}) pero el corte no trae una habitación válida: permanece confirmada.`,
        { confirmationNo: item.confirmationNo, details: { reservationCode: item.reservationCode, feed: run.feed, businessDate } }
      )
    );
  }
  // SC-03 (§4.2, §5.5): códigos maestros sin mapear, una alerta por corte con la lista de códigos (nunca datos del huésped).
  const rateCodes = sync.unmappedRateCodes ?? [];
  if (rateCodes.length > 0) {
    out.push(
      alert(
        "OPERA_RATE_CODE_UNMAPPED",
        `${rateCodes.length} rate code(s) de OPERA sin entrada en el perfil (${rateCodes.slice(0, 12).join(", ")}${rateCodes.length > 12 ? "…" : ""}): las filas se sincronizaron con la tarifa por defecto. Añade el mapeo en «Perfil de mapeo › Rate codes».`,
        { details: { codes: rateCodes, feed: run.feed, businessDate, ...(run.id ? { runId: run.id } : {}) } }
      )
    );
  }
  const roomTypes = sync.unmappedRoomTypes ?? [];
  if (roomTypes.length > 0) {
    out.push(
      alert(
        "OPERA_ROOM_TYPE_UNMAPPED",
        `${roomTypes.length} room type(s) de OPERA sin entrada en el perfil ni en los tipos de la propiedad (${roomTypes.slice(0, 12).join(", ")}${roomTypes.length > 12 ? "…" : ""}): sus filas quedaron en error. Añade el mapeo en «Perfil de mapeo › Room types» y vuelve a subir el corte.`,
        { details: { codes: roomTypes, feed: run.feed, businessDate, ...(run.id ? { runId: run.id } : {}) } }
      )
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fechas y zonas horarias
// ---------------------------------------------------------------------------

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDaysIso(iso: IsoDate, days: number): IsoDate {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Fecha y minuto del día LOCALES de `now` en `timezone` (UTC si la zona no es válida). */
export function localDateTime(now: Date, timezone: string): { date: IsoDate; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (isIsoDate(date) && Number.isFinite(hour) && Number.isFinite(minute)) return { date, minutes: hour * 60 + minute };
  } catch {
    // zona no válida → UTC
  }
  return { date: now.toISOString().slice(0, 10), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
}

/** Desfase (minutos) de `timezone` respecto a UTC en el instante `at`. */
function timezoneOffsetMinutes(at: Date, timezone: string): number {
  const local = localDateTime(at, timezone);
  const [y, m, d] = local.date.split("-").map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, Math.floor(local.minutes / 60), local.minutes % 60);
  const truncated = Math.floor(at.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** Ventana UTC [start, end) del día natural `date` en `timezone` (reservas creadas «hoy» en la zona del hotel). */
export function zonedDayWindowUtc(date: IsoDate, timezone: string): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const offset = timezoneOffsetMinutes(noon, timezone);
  const start = new Date(Date.UTC(y, m - 1, d) - offset * 60_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function parseExpectedTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** `scheduleJson` tal como está en la BD → feeds válidos (los malformados se ignoran). */
export function scheduleFeedsOf(raw: unknown): PmsShadowScheduleFeed[] {
  const feeds = (raw as { feeds?: unknown } | null | undefined)?.feeds;
  if (!Array.isArray(feeds)) return [];
  const out: PmsShadowScheduleFeed[] = [];
  for (const entry of feeds) {
    const item = entry as Partial<PmsShadowScheduleFeed> | null;
    if (!item || typeof item !== "object" || typeof item.feed !== "string" || !isKnownFeed(item.feed)) continue;
    if (parseExpectedTime(item.expectedTime) === null) continue;
    out.push({ feed: item.feed, expectedTime: String(item.expectedTime).trim(), businessDateOffset: item.businessDateOffset === -1 ? -1 : 0, required: item.required === true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OPERA_FEED_LATE (job del líder)
// ---------------------------------------------------------------------------

export type LateFeedProfile = { propertyId: string; timezone: string; schedule: unknown };
export type LateFeed = { propertyId: string; feed: PmsShadowFeed; businessDate: IsoDate; expectedTime: string; deliveryDate: IsoDate; minutesLate: number };

/** Clave del conjunto `runsByPropertyFeedDate`: hay un run (de cualquier estado) para ese feed y business date. */
export function lateFeedKey(propertyId: string, feed: string, businessDate: IsoDate): string {
  return `${propertyId}|${feed}|${businessDate}`;
}

/**
 * Para cada perfil activo y cada feed `required` de su programación: hora esperada
 * en la zona de la propiedad + gracia ya pasada hoy y ningún run con
 * businessDate = hoy local + businessDateOffset → OPERA_FEED_LATE. Solo el día
 * en curso (una alerta por feed y día; el dedupe lo hace createAlertIfOpen).
 */
export function computeLateFeeds(input: { profiles: readonly LateFeedProfile[]; runsByPropertyFeedDate: ReadonlySet<string>; now?: Date; graceMinutes?: number }): LateFeed[] {
  const now = input.now ?? new Date();
  const grace = input.graceMinutes ?? PMS_SHADOW_FEED_LATE_GRACE_MINUTES;
  const out: LateFeed[] = [];
  for (const profile of input.profiles) {
    const local = localDateTime(now, profile.timezone);
    for (const scheduled of scheduleFeedsOf(profile.schedule)) {
      if (!scheduled.required) continue;
      const expectedMinutes = parseExpectedTime(scheduled.expectedTime);
      if (expectedMinutes === null) continue;
      const deadline = expectedMinutes + grace;
      if (local.minutes < deadline) continue;
      const businessDate = addDaysIso(local.date, scheduled.businessDateOffset);
      if (input.runsByPropertyFeedDate.has(lateFeedKey(profile.propertyId, scheduled.feed, businessDate))) continue;
      out.push({ propertyId: profile.propertyId, feed: scheduled.feed, businessDate, expectedTime: scheduled.expectedTime, deliveryDate: local.date, minutesLate: local.minutes - expectedMinutes });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Métricas declaradas (Manager Report / Trial Balance) y reconciliación §5.4
// ---------------------------------------------------------------------------

/** Métricas de §5.4 (claves camelCase del cuerpo `declared`; los sinónimos snake_case del runbook se aceptan en normalizeDeclaredStats). */
export const PMS_SHADOW_DECLARED_KEYS = [
  "arrivalRooms",
  "departureRooms",
  "roomsOccupied",
  "occupancyPct",
  "noShowRooms",
  "roomRevenue",
  "totalRevenue",
  "taxTotal",
  "adr",
  "revpar",
  "transactionTotalToday",
  "reservationsMadeToday",
  "cancellationsMadeToday"
] as const;
export type PmsShadowDeclaredKey = (typeof PMS_SHADOW_DECLARED_KEYS)[number];
/** Valores como texto decimal («12», «1234.50»); null = no declarado. */
export type PmsShadowDeclaredStats = Partial<Record<PmsShadowDeclaredKey, string | null>>;
export type PmsShadowComputedStats = Record<PmsShadowDeclaredKey, string | null>;

type MetricKind = "count" | "money" | "pct";
type ToleranceKey = "rooms" | "revenueTotal" | "adr" | "occupancyPct";

export type ReconMetricSpec = { key: PmsShadowDeclaredKey; metric: string; kind: MetricKind; tolerance: ToleranceKey; group: "count" | "revenue" };

/** Métrica → nombre de fila del panel (`PmsShadowReconciliationRow.metric`), tipo y tolerancia. */
export const PMS_SHADOW_RECON_METRICS: readonly ReconMetricSpec[] = Object.freeze([
  { key: "arrivalRooms", metric: "arrivals", kind: "count", tolerance: "rooms", group: "count" },
  { key: "departureRooms", metric: "departures", kind: "count", tolerance: "rooms", group: "count" },
  { key: "roomsOccupied", metric: "rooms_occupied", kind: "count", tolerance: "rooms", group: "count" },
  { key: "occupancyPct", metric: "occupancy_pct", kind: "pct", tolerance: "occupancyPct", group: "count" },
  { key: "noShowRooms", metric: "no_shows", kind: "count", tolerance: "rooms", group: "count" },
  { key: "roomRevenue", metric: "revenue_rooms", kind: "money", tolerance: "revenueTotal", group: "revenue" },
  { key: "totalRevenue", metric: "revenue_total", kind: "money", tolerance: "revenueTotal", group: "revenue" },
  { key: "taxTotal", metric: "tax_total", kind: "money", tolerance: "revenueTotal", group: "revenue" },
  { key: "adr", metric: "adr", kind: "money", tolerance: "adr", group: "revenue" },
  { key: "revpar", metric: "revpar", kind: "money", tolerance: "adr", group: "revenue" },
  { key: "transactionTotalToday", metric: "transaction_total_today", kind: "money", tolerance: "revenueTotal", group: "revenue" },
  { key: "reservationsMadeToday", metric: "reservations_made", kind: "count", tolerance: "rooms", group: "count" },
  { key: "cancellationsMadeToday", metric: "cancellations", kind: "count", tolerance: "rooms", group: "count" }
]);

/** Sinónimos plegados (claves snake_case del runbook, etiquetas del Manager Report / Trial Balance de Oracle [V] y nombres de elemento BI Publisher [S]). */
const DECLARED_SYNONYMS: Readonly<Record<PmsShadowDeclaredKey, readonly string[]>> = Object.freeze({
  arrivalRooms: ["arrivalrooms", "arrival_rooms", "arrivals", "arr_rooms", "arrival_rooms_day"],
  departureRooms: ["departurerooms", "departure_rooms", "departures", "dep_rooms"],
  roomsOccupied: ["roomsoccupied", "rooms_occupied", "occupied_rooms", "rooms_sold", "occupied"],
  occupancyPct: ["occupancypct", "occupancy_pct", "rooms_occupied_pct", "pct_rooms_occupied", "percent_rooms_occupied", "occupancy", "occ_pct", "rooms_occupied_percent"],
  noShowRooms: ["noshowrooms", "no_show_rooms", "noshow_rooms", "no_shows", "noshows", "no_show"],
  roomRevenue: ["roomrevenue", "room_revenue", "revenue_rooms", "rooms_revenue", "lodging_revenue"],
  totalRevenue: ["totalrevenue", "total_revenue", "revenue_total"],
  taxTotal: ["taxtotal", "tax_total", "total_tax", "taxes"],
  adr: ["adr", "average_daily_rate", "average_room_rate", "avg_room_rate"],
  revpar: ["revpar", "revenue_per_available_room", "rev_par"],
  transactionTotalToday: ["transactiontotaltoday", "transaction_total_today", "transaction_total", "trx_total_today"],
  reservationsMadeToday: ["reservationsmadetoday", "reservations_made_today", "reservations_made", "reservations_made_yesterday", "res_made_today"],
  cancellationsMadeToday: ["cancellationsmadetoday", "cancellations_made_today", "cancellations_made", "cancellations", "cancellations_today"]
});

const SYNONYM_INDEX: ReadonlyMap<string, PmsShadowDeclaredKey> = (() => {
  const index = new Map<string, PmsShadowDeclaredKey>();
  for (const key of PMS_SHADOW_DECLARED_KEYS) {
    for (const synonym of DECLARED_SYNONYMS[key]) index.set(synonym, key);
  }
  return index;
})();

function declaredKeyOf(label: string): PmsShadowDeclaredKey | null {
  // «% Rooms Occupied» pliega igual que «Rooms Occupied»: el porcentaje se conserva como sufijo _pct.
  const folded = foldLabel(label) + (/%/.test(label) && !/pct|percent/i.test(label) ? "_pct" : "");
  if (!folded) return null;
  return SYNONYM_INDEX.get(folded) ?? SYNONYM_INDEX.get(folded.replace(/_/g, "")) ?? null;
}

/** «1.234,56» / «1,234.56» / «12 %» / «-5» → Decimal; null si no es un número. */
export function parseStatNumber(raw: unknown): Dec | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? new Decimal(raw.toString()) : null;
  if (typeof raw !== "string") return null;
  let text = raw.replace(/[%\s€$]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!text) return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Los dos separadores: el último es el decimal («1.234,56» / «1,234.56»).
    text = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Solo coma: decimal, salvo grupos de millares repetidos («1,234,567») [S].
    text = /^-?\d{1,3}(,\d{3}){2,}$/.test(text) ? text.replace(/,/g, "") : text.replace(",", ".");
  } else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3}){2,}$/.test(text)) {
    // Solo punto con grupos de millares repetidos («1.234.567») [S]; «1.234» se lee como decimal.
    text = text.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return new Decimal(text);
}

function formatStat(value: Dec, kind: MetricKind): string {
  return kind === "count" ? value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0) : value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Objeto libre (cuerpo `declared` con claves camelCase o snake_case, JSON de un
 * fichero stats) → métricas canónicas normalizadas; null si ninguna clave se reconoce.
 */
export function normalizeDeclaredStats(raw: unknown): PmsShadowDeclaredStats | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: PmsShadowDeclaredStats = {};
  let found = false;
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = declaredKeyOf(label);
    if (!key) continue;
    if (value === null || value === undefined || value === "") continue;
    const parsed = parseStatNumber(value);
    if (!parsed) continue;
    const spec = PMS_SHADOW_RECON_METRICS.find((metric) => metric.key === key)!;
    out[key] = formatStat(parsed, spec.kind);
    found = true;
  }
  return found ? out : null;
}

const DAY_CHILD_NAMES = new Set(["day", "today", "day_value", "value_day", "daily", "current_day", "d"]);
const LABEL_CHILD_NAMES = new Set(["description", "name", "label", "statistic", "stat", "stat_name", "metric", "item", "title"]);

function nodeText(node: XmlNode): string {
  return node.text.trim();
}

function childByFolded(node: XmlNode, names: ReadonlySet<string>): XmlNode | null {
  for (const child of node.children) if (names.has(foldLabel(child.name))) return child;
  return null;
}

/**
 * Manager Report / Trial Balance en XML (modelo de datos de BI Publisher) → métricas.
 * Dos formas [S]: (a) elemento cuyo NOMBRE plegado es un sinónimo (`<ARRIVAL_ROOMS>` con
 * texto o con hijo `<DAY>`); (b) fila con un hijo etiqueta (`<DESCRIPTION>Arrival
 * Rooms</DESCRIPTION>`) y un hijo `<DAY>` (columna Day del informe). También acepta
 * JSON con las claves de PMS_SHADOW_DECLARED_KEYS o sus sinónimos. null si nada.
 */
export function parseDeclaredStats(input: string | Uint8Array): PmsShadowDeclaredStats | null {
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      return normalizeDeclaredStats(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (!/^(<\?xml|<!--|<[a-z_])/i.test(trimmed)) return null;
  let root: XmlNode;
  try {
    root = parseXml(trimmed);
  } catch {
    return null;
  }
  const found: Record<string, unknown> = {};
  walkXml(root, (node) => {
    const byName = declaredKeyOf(node.name);
    if (byName) {
      const day = childByFolded(node, DAY_CHILD_NAMES);
      const value = day ? nodeText(day) : node.children.length === 0 ? nodeText(node) : "";
      if (value && !(byName in found)) found[byName] = value;
      return;
    }
    const label = childByFolded(node, LABEL_CHILD_NAMES);
    if (!label) return;
    const key = declaredKeyOf(nodeText(label));
    if (!key || key in found) return;
    const day = childByFolded(node, DAY_CHILD_NAMES);
    const value = day ? nodeText(day) : node.children.find((child) => child !== label && child.children.length === 0 && parseStatNumber(nodeText(child)))?.text.trim();
    if (value) found[key] = value;
  });
  return normalizeDeclaredStats(found);
}

export type ReconTolerances = { rooms: string; revenueTotal: string; adr: string; occupancyPct?: string };

const DEFAULT_TOLERANCES: ReconTolerances = { rooms: PMS_SHADOW_RECON_TOLERANCES.rooms, revenueTotal: PMS_SHADOW_RECON_TOLERANCES.revenueTotal, adr: PMS_SHADOW_RECON_TOLERANCES.adr, occupancyPct: "0.10" };

/**
 * Tabla de reconciliación (§5.4): una fila por métrica con lo declarado por OPERA,
 * lo calculado por Anfitorio, la diferencia (Anfitorio − OPERA) y el estado:
 * `missing` si falta cualquiera de los dos lados, `ok` si |delta| ≤ tolerancia,
 * `mismatch` si no.
 */
export function compareReconciliation(input: { declared: PmsShadowDeclaredStats | null | undefined; computed: Partial<PmsShadowComputedStats>; tolerances?: Partial<ReconTolerances> }): PmsShadowReconciliationRow[] {
  const tolerances = { ...DEFAULT_TOLERANCES, ...(input.tolerances ?? {}) };
  const rows: PmsShadowReconciliationRow[] = [];
  for (const spec of PMS_SHADOW_RECON_METRICS) {
    const declaredRaw = input.declared?.[spec.key] ?? null;
    const computedRaw = input.computed[spec.key] ?? null;
    const declared = declaredRaw === null ? null : parseStatNumber(declaredRaw);
    const computed = computedRaw === null ? null : parseStatNumber(computedRaw);
    const opera = declared ? formatStat(declared, spec.kind) : null;
    const anfitorio = computed ? formatStat(computed, spec.kind) : "—";
    if (!declared || !computed) {
      rows.push({ metric: spec.metric, opera, anfitorio, delta: null, status: "missing" });
      continue;
    }
    const delta = computed.minus(declared);
    const tolerance = new Decimal(tolerances[spec.tolerance] ?? "0");
    rows.push({ metric: spec.metric, opera, anfitorio, delta: formatStat(delta, spec.kind), status: delta.abs().lte(tolerance) ? "ok" : "mismatch" });
  }
  return rows;
}

/** Filas `mismatch` agrupadas por naturaleza (conteos → OPERA_RECON_COUNT_MISMATCH; importes → OPERA_RECON_REVENUE_MISMATCH). */
export function reconciliationMismatches(rows: readonly PmsShadowReconciliationRow[]): { count: PmsShadowReconciliationRow[]; revenue: PmsShadowReconciliationRow[] } {
  const groupOf = new Map(PMS_SHADOW_RECON_METRICS.map((spec) => [spec.metric, spec.group] as const));
  const count: PmsShadowReconciliationRow[] = [];
  const revenue: PmsShadowReconciliationRow[] = [];
  for (const row of rows) {
    if (row.status !== "mismatch") continue;
    (groupOf.get(row.metric) === "revenue" ? revenue : count).push(row);
  }
  return { count, revenue };
}

/** Mensaje en español de una alerta de reconciliación (sin datos personales: métricas e importes). */
export function reconciliationAlertMessage(code: "OPERA_RECON_COUNT_MISMATCH" | "OPERA_RECON_REVENUE_MISMATCH", businessDate: IsoDate, rows: readonly PmsShadowReconciliationRow[]): string {
  const detail = rows.map((row) => `${row.metric}: OPERA ${row.opera ?? "—"} · Anfitorio ${row.anfitorio} (Δ ${row.delta ?? "—"})`).join("; ");
  return `${PMS_SHADOW_ALERT_LABELS_ES[code]} (${businessDate}): ${detail}.`;
}

// ---------------------------------------------------------------------------
// Adjuntos de correo (conector con propósito pms_shadow)
// ---------------------------------------------------------------------------

/** Extensiones de adjunto que el buzón entrega al ingest (§6.5). */
export const PMS_SHADOW_ATTACHMENT_EXTENSIONS = ["csv", "txt", "xml", "xlsx"] as const;

export function attachmentExtension(fileName: string | null | undefined): string {
  const name = (fileName ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}
