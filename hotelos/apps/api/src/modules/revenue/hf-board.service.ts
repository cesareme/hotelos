// History & Forecast BOARD (contract frozen 2026-07-15).
//
// Canonical Opera-style board computed server-side from Prisma:
//   - Actual/OTB block: audited `RevenueDailySnapshot` (top-level roll-ups) for
//     past dates with a live reservations fallback; live OTB for today+future.
//   - Forecast block: `RevenueForecast`. Top-level rows (all dimensions null)
//     are preferred; when only per-room-type rows exist (deterministic-v1 writes
//     those) they are aggregated per day. NEVER invented — `forecastMissing`
//     flags the gap so the UI can offer the generate CTA.
//   - STLY block: audited snapshot at date−364 (same day of week last year).
//   - Budget: monthly `Budget.budgetedRoomRevenue` prorated per calendar day.
//   - Pickup: OTB_today − OTB_(today−K) for K ∈ {1,7,28}. Historical OTB comes
//     from `RevenuePaceSnapshot` when that capture date exists, otherwise it is
//     reconstructed from `reservation.createdAt` (same helper as pace.service).
//
// Performance contract: ONE query per source + in-memory maps (no N+1).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { NotFoundError } from "../../lib/http-error.js";
import { expand, type ResRow } from "./pace.service.js";
import { REALIZED_STATUSES, parseRevenueWindow, realizeDays } from "./actuals.js";
import { adrSourceFromDrivers, emptyAdrSourceCounts, forecastAdrSourceLabel } from "./forecast.service.js";
import { buildRecommendations, summarizeDayRecommendation } from "./rate-recommendation.service.js";

const MS_DAY = 86_400_000;
/** Longest board window (inclusive days); the route and the service both enforce it. */
export const BOARD_MAX_DAYS = 190;
/** Default window when the query omits from/to: today−7 .. today+90. */
export const BOARD_DEFAULT_PAST_DAYS = 7;
export const BOARD_DEFAULT_FUTURE_DAYS = 90;
/** Statuses that count as on-the-books for today/future stay dates. */
const OTB_STATUSES = ["confirmed", "checked_in"] as const;
/** Statuses loaded for the single reservations query (past + future + no-shows) — shared realized rule. */
const BOARD_STATUSES = REALIZED_STATUSES;

// ---- date + number helpers --------------------------------------------------
function dayUtc(value?: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const base = value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function endOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function dec(v: Prisma.Decimal | number | null | undefined): number {
  return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
}
function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  return v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
function isoWeekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon = 0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * MS_DAY));
}
const DOW_FMT = new Intl.DateTimeFormat("es-ES", { weekday: "short", timeZone: "UTC" });
const MONTH_FMT = new Intl.DateTimeFormat("es-ES", { month: "long", timeZone: "UTC" });
function dowEs(d: Date): string {
  return DOW_FMT.format(d);
}
function monthLabelEs(monthStart: Date): string {
  const name = MONTH_FMT.format(monthStart);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${monthStart.getUTCFullYear()}`;
}
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function fmtEs(n: number): string {
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- contract types (mirror of apps/admin-web/src/services/revenueApi.ts) ---
export type BoardRowType = "data" | "weekSubtotal" | "monthSubtotal" | "total";
export type BoardRow = {
  rowType: BoardRowType;
  label?: string;
  date?: string;
  dow?: string;
  isPast?: boolean;
  isToday?: boolean;
  roomsSold: number;
  occPct: number;
  adr: number | null;
  revpar: number | null;
  roomRevenue: number;
  arrivals: number;
  departures: number;
  noShows: number;
  ooo: number;
  fcRooms: number | null;
  fcOccPct: number | null;
  fcAdr: number | null;
  fcRevenue: number | null;
  fcConfidence: number | null;
  stlyRooms: number | null;
  stlyOccPct: number | null;
  stlyAdr: number | null;
  stlyRevenue: number | null;
  deltaRoomsVsStly: number | null;
  deltaRevVsStly: number | null;
  budgetRevenue: number | null;
  deltaRevVsBudget: number | null;
  pickup1: number | null;
  pickup7: number | null;
  pickup28: number | null;
  pickupAdr7: number | null;
};
export type MonthOutlook = {
  month: string;
  label: string;
  daysElapsed: number;
  daysTotal: number;
  actualRevenue: number;
  otbRevenue: number;
  forecastRevenue: number | null;
  projectedRevenue: number;
  projectedOccPct: number | null;
  projectedAdr: number | null;
  budgetRevenue: number | null;
  gapToBudget: number | null;
  gapPct: number | null;
  status: "ok" | "warn" | "risk" | "no_budget";
  lyRevenue: number | null;
  lyOccPct: number | null;
  lyAdr: number | null;
};
export type CriticalDate = {
  date: string;
  dow: string;
  daysOut: number;
  severity: "high" | "medium";
  reason: string;
  occPct: number;
  fcOccPct: number | null;
  stlyOccPct: number | null;
  pickup7: number | null;
  recommendation: string | null;
  /**
   * Why `recommendation` is null ("sin BAR publicado", "datos insuficientes
   * (sin previsión, sin compset)"…); null when a recommendation is present.
   * Additive (rate grid v2): the RMS engine explains instead of going quiet.
   */
  recommendationMissing: string | null;
  compsetMedian: number | null;
  /** "sin compset" when no active competitor was shopped for the night; null otherwise. */
  compsetMissing: string | null;
};
export type BoardKpiBlock = { roomsSold: number; occPct: number; adr: number | null; revenue: number };
export type BoardKpis = {
  next7: BoardKpiBlock & { pickup7: number | null };
  next30: BoardKpiBlock & { pickup7: number | null };
  mtd: BoardKpiBlock & { vsStlyRevenuePct: number | null };
  forecastConfidenceAvg: number | null;
};
export type HistoryForecastBoard = {
  propertyId: string;
  propertyName: string;
  businessDate: string;
  generatedAt: string;
  from: string;
  to: string;
  totalRooms: number;
  forecastMissing: boolean;
  budgetMissing: boolean;
  metricNotes: string[];
  sources: Record<string, string>;
  rows: BoardRow[];
  months: MonthOutlook[];
  criticalDates: CriticalDate[];
  kpis: BoardKpis;
};

/** Single metric dictionary (contract literal — do not reword). */
const METRIC_NOTES = [
  "Ocupación sobre habitaciones disponibles (sin descontar OOO)",
  "ADR = ingreso habitaciones / habitaciones vendidas (sin gratuidades)",
  "Ingresos de habitaciones netos sin desayuno ni extras",
  "Presupuesto prorrateado por día natural",
  "STLY = mismo día de la semana del año anterior (fecha−364), cierre auditado",
  "Pickup = variación de habitaciones OTB en la ventana indicada"
];

/**
 * Appended to `metricNotes` only when at least one day's forecast comes from
 * a top-level row imported from another PMS (pilot verification R3): that
 * ADR/occupancy keep the source system's bases, which differ from the board's
 * own subtotals.
 */
export function pmsForecastMetricNote(totalRooms: number): string {
  return `Previsión importada del PMS: ADR sobre habitaciones pagadas y ocupación sobre habitaciones disponibles (${totalRooms} − OOO); los subtotales de Anfitorio usan ${totalRooms}`;
}

/**
 * Decide the per-day forecast ADR / occupancy shown on the board. When the
 * day's forecast is a TOP-LEVEL row that carries the source system's own
 * `expectedAdr` / `expectedOccupancy` (imported PMS forecast), those values
 * are exposed as-is; otherwise both are recomputed from rooms and revenue
 * (revenue / rooms; rooms / totalRooms) as before. Pure, unit-tested.
 */
export function resolveForecastDayMetrics(input: {
  rooms: number;
  /** null when any row of the day had no ADR input. */
  revenue: number | null;
  totalRooms: number;
  topLevel: boolean;
  expectedAdr: number | null;
  expectedOccupancy: number | null;
}): { fcAdr: number | null; fcOccPct: number | null; importedAdr: boolean; importedOcc: boolean } {
  const importedAdr = input.topLevel && input.expectedAdr !== null;
  const importedOcc = input.topLevel && input.expectedOccupancy !== null;
  const fcAdr = importedAdr
    ? round2(input.expectedAdr as number)
    : input.revenue !== null && input.rooms > 0
      ? round2(input.revenue / input.rooms)
      : null;
  // Without a room count the row's own occupancy is the only honest figure
  // (previous behaviour, kept for per-type aggregates too).
  const fcOccPct = importedOcc
    ? round2(input.expectedOccupancy as number)
    : input.totalRooms > 0
      ? round2((input.rooms / input.totalRooms) * 100)
      : input.expectedOccupancy !== null
        ? round2(input.expectedOccupancy)
        : null;
  return { fcAdr, fcOccPct, importedAdr, importedOcc };
}

/** Internal per-day accumulator for the extended series. */
type DaySeries = {
  date: string;
  d: Date;
  isPast: boolean;
  isToday: boolean;
  roomsSold: number;
  occPct: number;
  adr: number | null;
  revpar: number | null;
  roomRevenue: number;
  arrivals: number;
  departures: number;
  noShows: number;
  ooo: number;
  fcRooms: number | null;
  fcOccPct: number | null;
  fcAdr: number | null;
  fcRevenue: number | null;
  fcConfidence: number | null;
  stlyRooms: number | null;
  stlyOccPct: number | null;
  stlyAdr: number | null;
  stlyRevenue: number | null;
  deltaRoomsVsStly: number | null;
  deltaRevVsStly: number | null;
  budgetRevenue: number | null;
  deltaRevVsBudget: number | null;
  pickup1: number | null;
  pickup7: number | null;
  pickup28: number | null;
  pickupAdr7: number | null;
};

type DayAcc = { rooms: number; revenue: number; arrivals: number; departures: number; noShows: number; pax: number };
function ensureAcc(map: Map<string, DayAcc>, key: string): DayAcc {
  let a = map.get(key);
  if (!a) {
    a = { rooms: 0, revenue: 0, arrivals: 0, departures: 0, noShows: 0, pax: 0 };
    map.set(key, a);
  }
  return a;
}

/** Route-level and service-level validation share this so a direct caller gets the same 400. */
export function parseBoardWindow(input: { from?: unknown; to?: unknown; today?: Date }) {
  const today = dayUtc(input.today);
  return parseRevenueWindow({
    from: input.from,
    to: input.to,
    maxDays: BOARD_MAX_DAYS,
    defaultFrom: isoDate(addDays(today, -BOARD_DEFAULT_PAST_DAYS)),
    defaultTo: isoDate(addDays(today, BOARD_DEFAULT_FUTURE_DAYS)),
    scope: "del board"
  });
}

export async function getHistoryForecastBoard(
  propertyId: string,
  opts: { from?: string; to?: string } = {}
): Promise<HistoryForecastBoard> {
  const today = dayUtc();
  const yesterday = addDays(today, -1);
  // Typed 400 for a malformed day, to < from or a window over the limit —
  // the same rule the route applies (pilot verification R1).
  const win = parseBoardWindow({ from: opts.from, to: opts.to, today });
  const from = dayUtc(win.from);
  const to = dayUtc(win.to);

  // Months outlook is ALWAYS current month + 3, independent of the window, so
  // the internal day series spans the union of both ranges.
  const monthsStart = startOfMonthUtc(today);
  const monthsEnd = endOfMonthUtc(addMonthsUtc(today, 3));
  const extFrom = from.getTime() < monthsStart.getTime() ? from : monthsStart;
  const extTo = to.getTime() > monthsEnd.getTime() ? to : monthsEnd;

  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, name: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const totalRooms = await prisma.room.count({ where: { propertyId, sellable: true } });

  const captureOffsets = [1, 7, 28] as const;
  const captureDates = captureOffsets.map((k) => addDays(today, -k));
  const budgetMonths: string[] = [];
  for (let m = startOfMonthUtc(extFrom); m.getTime() <= extTo.getTime(); m = addMonthsUtc(m, 1)) {
    budgetMonths.push(isoDate(m).slice(0, 7));
  }
  const lyMonthsFrom = addMonthsUtc(monthsStart, -12);
  const lyMonthsTo = endOfMonthUtc(addMonthsUtc(monthsStart, -9));

  // ---- ONE query per source -------------------------------------------------
  const [reservations, snapshots, forecasts, paceRows, budgets] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        propertyId,
        status: { in: BOARD_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] },
        arrivalDate: { lte: extTo },
        departureDate: { gte: extFrom }
      },
      select: {
        arrivalDate: true,
        departureDate: true,
        roomsCount: true,
        totalAmount: true,
        adults: true,
        children: true,
        status: true,
        createdAt: true
      }
    }),
    prisma.revenueDailySnapshot.findMany({
      where: {
        propertyId,
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null,
        OR: [
          { snapshotDate: { gte: extFrom, lte: yesterday } }, // past actuals
          { snapshotDate: { gte: addDays(extFrom, -364), lte: addDays(to, -364) } }, // STLY (date−364)
          { snapshotDate: { gte: lyMonthsFrom, lte: lyMonthsTo } } // LY calendar months (months outlook)
        ]
      },
      select: {
        snapshotDate: true,
        totalOcc: true,
        arrivalRooms: true,
        departureRooms: true,
        noShowRooms: true,
        oooRooms: true,
        houseUseRooms: true,
        roomRevenue: true,
        adr: true,
        revpar: true,
        occupancyPercent: true
      }
    }),
    prisma.revenueForecast.findMany({
      where: { propertyId, forecastDate: { gte: today, lte: extTo } },
      select: {
        forecastDate: true,
        roomTypeId: true,
        ratePlanId: true,
        channelId: true,
        segment: true,
        expectedOccupancy: true,
        expectedAdr: true,
        expectedRoomsSold: true,
        expectedRoomRevenue: true,
        expectedTotalRevenue: true,
        confidence: true,
        modelVersion: true,
        driversJson: true
      }
    }),
    prisma.revenuePaceSnapshot.findMany({
      where: { propertyId, captureDate: { in: captureDates }, stayDate: { gte: today, lte: extTo } },
      select: { captureDate: true, stayDate: true, roomsOtb: true, revenueOtb: true }
    }),
    prisma.budget.findMany({ where: { propertyId, periodMonth: { in: budgetMonths } } })
  ]);

  // ---- in-memory maps --------------------------------------------------------
  // Past actuals: the SHARED realized rule (audited snapshot first, reservations
  // fallback, < today) fed with the rows already loaded above — one
  // implementation for the board, budget variance, accuracy and period metrics.
  const realized = realizeDays({ from: extFrom, to: extTo, today, totalRooms, snapshots, reservations });

  // Reservations → live OTB (today/future).
  const otbAcc = new Map<string, DayAcc>();
  for (const r of reservations) {
    if (r.status !== "confirmed" && r.status !== "checked_in") continue;
    const arr = dayUtc(r.arrivalDate);
    const dep = dayUtc(r.departureDate);
    const arrKey = isoDate(arr);
    const depKey = isoDate(dep);
    const n = Math.max(1, Math.round((dep.getTime() - arr.getTime()) / MS_DAY));
    const revPerNight = dec(r.totalAmount) / n;
    if (arr.getTime() >= today.getTime() && arr.getTime() <= extTo.getTime()) ensureAcc(otbAcc, arrKey).arrivals += r.roomsCount;
    if (dep.getTime() >= today.getTime() && dep.getTime() <= extTo.getTime()) ensureAcc(otbAcc, depKey).departures += r.roomsCount;
    for (let i = 0; i < n; i++) {
      const d = addDays(arr, i);
      if (d.getTime() < today.getTime() || d.getTime() > extTo.getTime()) continue;
      const a = ensureAcc(otbAcc, isoDate(d));
      a.rooms += r.roomsCount;
      a.revenue += revPerNight;
      a.pax += r.adults + r.children;
    }
  }

  // Audited snapshots keyed by date (STLY range and LY months; the past window is served by `realized`).
  const snapByDate = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) snapByDate.set(isoDate(dayUtc(s.snapshotDate)), s);

  // Forecast: prefer top-level rows (all dimensions null); otherwise aggregate
  // the per-room-type rows per day (deterministic-v1 only writes those).
  const topLevelForecasts = forecasts.filter((f) => !f.roomTypeId && !f.ratePlanId && !f.channelId && !f.segment);
  const forecastSource = topLevelForecasts.length > 0 ? topLevelForecasts : forecasts;
  type FcAcc = {
    rooms: number;
    revenue: number;
    revenueMissingRows: number;
    confWeighted: number;
    confRooms: number;
    confPlain: number[];
    /** Source system's own occupancy / ADR (top-level rows only; imported PMS forecasts carry them). */
    occFromRow: number | null;
    adrFromRow: number | null;
  };
  const usingTopLevel = topLevelForecasts.length > 0;
  const fcByDate = new Map<string, FcAcc>();
  const fcAdrSources = emptyAdrSourceCounts();
  for (const f of forecastSource) {
    const key = isoDate(dayUtc(f.forecastDate));
    let b = fcByDate.get(key);
    if (!b) {
      b = { rooms: 0, revenue: 0, revenueMissingRows: 0, confWeighted: 0, confRooms: 0, confPlain: [], occFromRow: null, adrFromRow: null };
      fcByDate.set(key, b);
    }
    const rooms = dec(f.expectedRoomsSold);
    b.rooms += rooms;
    // Revenue is null when the model had no ADR input (no BAR, no LY close):
    // the day's forecast revenue is then unknown, never summed as 0.
    const rev = decOrNull(f.expectedRoomRevenue ?? f.expectedTotalRevenue);
    if (rev === null) b.revenueMissingRows++;
    else b.revenue += rev;
    const adrSrc = adrSourceFromDrivers(f.driversJson);
    if (adrSrc) fcAdrSources[adrSrc]++;
    const conf = decOrNull(f.confidence);
    if (conf !== null) {
      b.confPlain.push(conf);
      b.confWeighted += conf * rooms;
      b.confRooms += rooms;
    }
    const occ = decOrNull(f.expectedOccupancy);
    if (occ !== null) b.occFromRow = occ;
    const adrRow = decOrNull(f.expectedAdr);
    if (adrRow !== null) b.adrFromRow = adrRow;
  }
  let importedForecastDays = 0;
  const forecastModelVersion = forecastSource.find((f) => f.modelVersion)?.modelVersion ?? "deterministic-v1";
  const fcWindowStartKey = isoDate(today.getTime() > from.getTime() ? today : from);
  const toKey = isoDate(to);
  const forecastMissing =
    to.getTime() >= today.getTime() &&
    ![...fcByDate.keys()].some((k) => k >= fcWindowStartKey && k <= toKey);

  // Pace snapshots per capture date; fallback = reconstruction by createdAt.
  const paceByCapture = new Map<string, Map<string, { rooms: number; revenue: number }>>();
  for (const row of paceRows) {
    const cKey = isoDate(dayUtc(row.captureDate));
    let m = paceByCapture.get(cKey);
    if (!m) {
      m = new Map();
      paceByCapture.set(cKey, m);
    }
    m.set(isoDate(dayUtc(row.stayDate)), { rooms: row.roomsOtb, revenue: dec(row.revenueOtb) });
  }
  const otbReservations: ResRow[] = reservations.filter(
    (r) => r.status === "confirmed" || r.status === "checked_in"
  );
  let paceSnapshotHits = 0;
  let paceReconstructions = 0;
  const priorOtbByOffset = new Map<number, Map<string, { rooms: number; revenue: number }>>();
  for (const k of captureOffsets) {
    const captureDate = addDays(today, -k);
    const snap = paceByCapture.get(isoDate(captureDate));
    if (snap) {
      priorOtbByOffset.set(k, snap);
      paceSnapshotHits++;
    } else {
      const cutoff = addDays(captureDate, 1); // bookings created before end of capture day
      const reconstructed = expand(
        otbReservations.filter((r) => r.createdAt.getTime() < cutoff.getTime()),
        today,
        addDays(extTo, 1)
      );
      priorOtbByOffset.set(k, reconstructed);
      paceReconstructions++;
    }
  }

  // Critical dates' recommendation + compset come from the rate-grid RMS engine
  // (rate-recommendation.service): computed below, only for the dates flagged.

  // Budget per month (prorated per calendar day at row level).
  const budgetByMonth = new Map<string, number>();
  for (const b of budgets) {
    const rev = decOrNull(b.budgetedRoomRevenue);
    if (rev !== null) budgetByMonth.set(b.periodMonth, rev);
  }
  const windowMonths = new Set<string>();
  for (let m = startOfMonthUtc(from); m.getTime() <= to.getTime(); m = addMonthsUtc(m, 1)) {
    windowMonths.add(isoDate(m).slice(0, 7));
  }
  const budgetMissing = ![...windowMonths].some((m) => budgetByMonth.has(m));

  // ---- extended day series ----------------------------------------------------
  const snapshotDaysUsed = realized.snapshotDays;
  const fallbackDaysUsed = realized.fallbackDays;
  const series: DaySeries[] = [];
  for (let t = extFrom.getTime(); t <= extTo.getTime(); t += MS_DAY) {
    const d = new Date(t);
    const key = isoDate(d);
    const isPast = t < today.getTime();
    const isToday = t === today.getTime();

    // Actual (past, audited) / OTB (today+future) block.
    let roomsSold = 0;
    let roomRevenue = 0;
    let arrivals = 0;
    let departures = 0;
    let noShows = 0;
    let ooo = 0;
    let occPct = 0;
    let adr: number | null = null;
    let revpar: number | null = null;
    if (isPast) {
      // Shared realized rule (actuals.ts): snapshot day or reservations fallback day.
      const r = realized.days.get(key);
      if (r) {
        roomsSold = r.rooms;
        roomRevenue = r.roomRevenue;
        arrivals = r.arrivals;
        departures = r.departures;
        noShows = r.noShows;
        ooo = r.ooo;
        occPct = r.occPct;
        adr = r.adr;
        revpar = r.revpar;
      }
    } else {
      const a = otbAcc.get(key);
      roomsSold = a?.rooms ?? 0;
      roomRevenue = round2(a?.revenue ?? 0);
      arrivals = a?.arrivals ?? 0;
      departures = a?.departures ?? 0;
      occPct = totalRooms > 0 ? round2((roomsSold / totalRooms) * 100) : 0;
      adr = roomsSold > 0 ? round2(roomRevenue / roomsSold) : null;
      revpar = totalRooms > 0 ? round2(roomRevenue / totalRooms) : null;
    }

    // Forecast block (future only; never invented).
    let fcRooms: number | null = null;
    let fcOccPct: number | null = null;
    let fcAdr: number | null = null;
    let fcRevenue: number | null = null;
    let fcConfidence: number | null = null;
    if (!isPast) {
      const fc = fcByDate.get(key);
      if (fc) {
        fcRooms = Math.round(fc.rooms);
        // Revenue stays null when any row of the day had no ADR input.
        fcRevenue = fc.revenueMissingRows > 0 ? null : round2(fc.revenue);
        // Imported top-level rows expose the PMS's own ADR/occupancy (paid-room
        // and 92−OOO bases); otherwise recomputed from rooms/revenue.
        const metrics = resolveForecastDayMetrics({
          rooms: fc.rooms,
          revenue: fcRevenue,
          totalRooms,
          topLevel: usingTopLevel,
          expectedAdr: fc.adrFromRow,
          expectedOccupancy: fc.occFromRow
        });
        fcOccPct = metrics.fcOccPct;
        fcAdr = metrics.fcAdr;
        if (metrics.importedAdr || metrics.importedOcc) importedForecastDays++;
        fcConfidence =
          fc.confRooms > 0
            ? round2(fc.confWeighted / fc.confRooms)
            : fc.confPlain.length
              ? round2(fc.confPlain.reduce((s, c) => s + c, 0) / fc.confPlain.length)
              : null;
      }
    }

    // STLY block: audited close of date−364 (same day of week).
    const stlySnap = snapByDate.get(isoDate(addDays(d, -364)));
    let stlyRooms: number | null = null;
    let stlyOccPct: number | null = null;
    let stlyAdr: number | null = null;
    let stlyRevenue: number | null = null;
    let deltaRoomsVsStly: number | null = null;
    let deltaRevVsStly: number | null = null;
    if (stlySnap) {
      stlyRooms = stlySnap.totalOcc;
      stlyRevenue = round2(dec(stlySnap.roomRevenue));
      stlyOccPct = stlySnap.occupancyPercent !== null ? round2(dec(stlySnap.occupancyPercent)) : null;
      stlyAdr =
        stlySnap.adr !== null ? round2(dec(stlySnap.adr)) : stlyRooms > 0 ? round2(stlyRevenue / stlyRooms) : null;
      deltaRoomsVsStly = roomsSold - stlyRooms;
      deltaRevVsStly = round2(roomRevenue - stlyRevenue);
    }

    // Budget prorated per calendar day.
    const monthlyBudget = budgetByMonth.get(key.slice(0, 7));
    const daysInMonth = endOfMonthUtc(d).getUTCDate();
    const budgetRevenue = monthlyBudget !== undefined ? round2(monthlyBudget / daysInMonth) : null;
    const deltaRevVsBudget = budgetRevenue !== null ? round2(roomRevenue - budgetRevenue) : null;

    // Pickup (future only): OTB_today − OTB_(today−K).
    let pickup1: number | null = null;
    let pickup7: number | null = null;
    let pickup28: number | null = null;
    let pickupAdr7: number | null = null;
    if (!isPast) {
      const cur = otbAcc.get(key) ?? { rooms: 0, revenue: 0 };
      const deltas: Record<number, number> = {};
      for (const k of captureOffsets) {
        const prior = priorOtbByOffset.get(k)?.get(key) ?? { rooms: 0, revenue: 0 };
        deltas[k] = cur.rooms - prior.rooms;
        if (k === 7) {
          const curAdr = cur.rooms > 0 ? cur.revenue / cur.rooms : null;
          const priorAdr = prior.rooms > 0 ? prior.revenue / prior.rooms : null;
          pickupAdr7 = curAdr !== null && priorAdr !== null ? round2(curAdr - priorAdr) : null;
        }
      }
      pickup1 = deltas[1];
      pickup7 = deltas[7];
      pickup28 = deltas[28];
    }

    series.push({
      date: key,
      d,
      isPast,
      isToday,
      roomsSold,
      occPct,
      adr,
      revpar,
      roomRevenue,
      arrivals,
      departures,
      noShows,
      ooo,
      fcRooms,
      fcOccPct,
      fcAdr,
      fcRevenue,
      fcConfidence,
      stlyRooms,
      stlyOccPct,
      stlyAdr,
      stlyRevenue,
      deltaRoomsVsStly,
      deltaRevVsStly,
      budgetRevenue,
      deltaRevVsBudget,
      pickup1,
      pickup7,
      pickup28,
      pickupAdr7
    });
  }
  const byDate = new Map(series.map((s) => [s.date, s]));

  // ---- rows: data + ISO week/month subtotals + grand total ---------------------
  const windowSeries = series.filter((s) => s.d.getTime() >= from.getTime() && s.d.getTime() <= to.getTime());

  const sumNullable = (days: DaySeries[], pick: (s: DaySeries) => number | null): number | null => {
    const withValue = days.filter((s) => pick(s) !== null);
    if (!withValue.length) return null;
    return withValue.reduce((acc, s) => acc + (pick(s) as number), 0);
  };
  const subtotalRow = (rowType: BoardRowType, label: string, days: DaySeries[]): BoardRow => {
    const roomsSold = days.reduce((s, x) => s + x.roomsSold, 0);
    const roomRevenue = round2(days.reduce((s, x) => s + x.roomRevenue, 0));
    const capacity = totalRooms * days.length;
    const fcDays = days.filter((x) => x.fcRooms !== null);
    const fcRoomsSum = fcDays.reduce((s, x) => s + (x.fcRooms as number), 0);
    // A day with forecast rooms but unknown revenue (no ADR input) makes the
    // bucket's forecast revenue unknown too — never summed as 0.
    const fcRevenueKnown = fcDays.length > 0 && fcDays.every((x) => x.fcRevenue !== null);
    const fcRevSum = fcDays.reduce((s, x) => s + (x.fcRevenue ?? 0), 0);
    const fcConfDays = fcDays.filter((x) => x.fcConfidence !== null);
    const stlyDays = days.filter((x) => x.stlyRooms !== null);
    const stlyRoomsSum = stlyDays.reduce((s, x) => s + (x.stlyRooms as number), 0);
    const stlyRevSum = stlyDays.reduce((s, x) => s + (x.stlyRevenue ?? 0), 0);
    const stlyOccDays = stlyDays.filter((x) => x.stlyOccPct !== null);
    const budgetSum = sumNullable(days, (x) => x.budgetRevenue);
    return {
      rowType,
      label,
      roomsSold,
      occPct: capacity > 0 ? round2((roomsSold / capacity) * 100) : 0,
      adr: roomsSold > 0 ? round2(roomRevenue / roomsSold) : null,
      revpar: capacity > 0 ? round2(roomRevenue / capacity) : null,
      roomRevenue,
      arrivals: days.reduce((s, x) => s + x.arrivals, 0),
      departures: days.reduce((s, x) => s + x.departures, 0),
      noShows: days.reduce((s, x) => s + x.noShows, 0),
      ooo: days.reduce((s, x) => s + x.ooo, 0),
      fcRooms: fcDays.length ? fcRoomsSum : null,
      fcOccPct: fcDays.length && totalRooms > 0 ? round2((fcRoomsSum / (totalRooms * fcDays.length)) * 100) : null,
      fcAdr: fcRevenueKnown && fcRoomsSum > 0 ? round2(fcRevSum / fcRoomsSum) : null,
      fcRevenue: fcRevenueKnown ? round2(fcRevSum) : null,
      fcConfidence: fcConfDays.length
        ? round2(fcConfDays.reduce((s, x) => s + (x.fcConfidence as number), 0) / fcConfDays.length)
        : null,
      stlyRooms: stlyDays.length ? stlyRoomsSum : null,
      stlyOccPct: stlyOccDays.length
        ? round2(stlyOccDays.reduce((s, x) => s + (x.stlyOccPct as number), 0) / stlyOccDays.length)
        : null,
      stlyAdr: stlyRoomsSum > 0 ? round2(stlyRevSum / stlyRoomsSum) : null,
      stlyRevenue: stlyDays.length ? round2(stlyRevSum) : null,
      deltaRoomsVsStly: stlyDays.length ? stlyDays.reduce((s, x) => s + (x.deltaRoomsVsStly ?? 0), 0) : null,
      deltaRevVsStly: stlyDays.length ? round2(stlyDays.reduce((s, x) => s + (x.deltaRevVsStly ?? 0), 0)) : null,
      budgetRevenue: budgetSum !== null ? round2(budgetSum) : null,
      deltaRevVsBudget: budgetSum !== null ? round2(roomRevenue - budgetSum) : null,
      pickup1: sumNullable(days, (x) => x.pickup1),
      pickup7: sumNullable(days, (x) => x.pickup7),
      pickup28: sumNullable(days, (x) => x.pickup28),
      pickupAdr7: null
    };
  };
  const dataRow = (s: DaySeries): BoardRow => ({
    rowType: "data",
    date: s.date,
    dow: dowEs(s.d),
    isPast: s.isPast,
    isToday: s.isToday,
    roomsSold: s.roomsSold,
    occPct: s.occPct,
    adr: s.adr,
    revpar: s.revpar,
    roomRevenue: s.roomRevenue,
    arrivals: s.arrivals,
    departures: s.departures,
    noShows: s.noShows,
    ooo: s.ooo,
    fcRooms: s.fcRooms,
    fcOccPct: s.fcOccPct,
    fcAdr: s.fcAdr,
    fcRevenue: s.fcRevenue,
    fcConfidence: s.fcConfidence,
    stlyRooms: s.stlyRooms,
    stlyOccPct: s.stlyOccPct,
    stlyAdr: s.stlyAdr,
    stlyRevenue: s.stlyRevenue,
    deltaRoomsVsStly: s.deltaRoomsVsStly,
    deltaRevVsStly: s.deltaRevVsStly,
    budgetRevenue: s.budgetRevenue,
    deltaRevVsBudget: s.deltaRevVsBudget,
    pickup1: s.pickup1,
    pickup7: s.pickup7,
    pickup28: s.pickup28,
    pickupAdr7: s.pickupAdr7
  });

  const rows: BoardRow[] = [];
  let weekBucket: DaySeries[] = [];
  let monthBucket: DaySeries[] = [];
  for (const day of windowSeries) {
    rows.push(dataRow(day));
    weekBucket.push(day);
    monthBucket.push(day);
    if (day.d.getUTCDay() === 0) {
      // Sunday closes the ISO week (Mon–Sun).
      rows.push(subtotalRow("weekSubtotal", `Semana ${isoWeekNumber(day.d)}`, weekBucket));
      weekBucket = [];
    }
    if (day.date === isoDate(endOfMonthUtc(day.d))) {
      rows.push(subtotalRow("monthSubtotal", monthLabelEs(startOfMonthUtc(day.d)), monthBucket));
      monthBucket = [];
    }
  }
  if (windowSeries.length) rows.push(subtotalRow("total", "Total", windowSeries));

  // ---- months outlook (current month + 3, always) ------------------------------
  const months: MonthOutlook[] = [];
  for (let m = 0; m < 4; m++) {
    const mStart = addMonthsUtc(monthsStart, m);
    const mEnd = endOfMonthUtc(mStart);
    const key = isoDate(mStart).slice(0, 7);
    const daysTotal = mEnd.getUTCDate();
    const daysElapsed = Math.max(
      0,
      Math.min(Math.round((today.getTime() - mStart.getTime()) / MS_DAY), daysTotal)
    );
    const monthDays = series.filter((s) => s.d.getTime() >= mStart.getTime() && s.d.getTime() <= mEnd.getTime());
    const pastDays = monthDays.filter((s) => s.isPast);
    const futureDays = monthDays.filter((s) => !s.isPast);
    const actualRevenue = round2(pastDays.reduce((s, x) => s + x.roomRevenue, 0));
    const actualRooms = pastDays.reduce((s, x) => s + x.roomsSold, 0);
    const otbRevenue = round2(futureDays.reduce((s, x) => s + x.roomRevenue, 0));
    const otbRooms = futureDays.reduce((s, x) => s + x.roomsSold, 0);
    const fcDays = futureDays.filter((x) => x.fcRooms !== null);
    const monthHasFc = fcDays.length > 0;
    const fcRevenueKnown = monthHasFc && fcDays.every((x) => x.fcRevenue !== null);
    // Forecast revenue for the month is only reported when every forecast day
    // has an ADR input; the projection falls back to the day's live OTB
    // revenue for days without one (same policy as a month with no forecast).
    const fcRevSum = fcDays.reduce((s, x) => s + (x.fcRevenue ?? x.roomRevenue), 0);
    const fcRoomsSum = fcDays.reduce((s, x) => s + (x.fcRooms as number), 0);
    const projectedRevenue = round2(actualRevenue + (monthHasFc ? fcRevSum : otbRevenue));
    const projRooms = actualRooms + (monthHasFc ? fcRoomsSum : otbRooms);
    const budgetRevenue = budgetByMonth.get(key) ?? null;
    const gapToBudget = budgetRevenue !== null ? round2(projectedRevenue - budgetRevenue) : null;
    const gapPct = budgetRevenue !== null && budgetRevenue > 0 ? round2(((projectedRevenue - budgetRevenue) / budgetRevenue) * 100) : null;
    let status: MonthOutlook["status"];
    if (budgetRevenue === null) status = "no_budget";
    else if ((gapToBudget as number) >= -0.03 * budgetRevenue) status = "ok";
    else if ((gapToBudget as number) >= -0.08 * budgetRevenue) status = "warn";
    else status = "risk";
    // LY = audited close of the equivalent calendar month last year (labelled
    // "cierre LY" — NOT same-lead STLY; source honesty per contract).
    const lyStart = addMonthsUtc(mStart, -12);
    const lyEnd = endOfMonthUtc(lyStart);
    let lyRooms = 0;
    let lyRevenue = 0;
    let lyDaysFound = 0;
    const lyOccValues: number[] = [];
    for (let t = lyStart.getTime(); t <= lyEnd.getTime(); t += MS_DAY) {
      const snap = snapByDate.get(isoDate(new Date(t)));
      if (!snap) continue;
      lyDaysFound++;
      lyRooms += snap.totalOcc;
      lyRevenue += dec(snap.roomRevenue);
      if (snap.occupancyPercent !== null) lyOccValues.push(dec(snap.occupancyPercent));
    }
    months.push({
      month: key,
      label: monthLabelEs(mStart),
      daysElapsed,
      daysTotal,
      actualRevenue,
      otbRevenue,
      forecastRevenue: fcRevenueKnown ? round2(fcDays.reduce((s, x) => s + (x.fcRevenue as number), 0)) : null,
      projectedRevenue,
      projectedOccPct: totalRooms > 0 ? round2((projRooms / (totalRooms * daysTotal)) * 100) : null,
      projectedAdr: projRooms > 0 ? round2(projectedRevenue / projRooms) : null,
      budgetRevenue,
      gapToBudget,
      gapPct,
      status,
      lyRevenue: lyDaysFound > 0 ? round2(lyRevenue) : null,
      lyOccPct: lyOccValues.length ? round2(lyOccValues.reduce((s, v) => s + v, 0) / lyOccValues.length) : null,
      lyAdr: lyRooms > 0 ? round2(lyRevenue / lyRooms) : null
    });
  }

  // ---- critical dates (deterministic rules, top 10, future within window) -----
  const candidates: CriticalDate[] = [];
  for (const day of windowSeries) {
    if (day.isPast) continue;
    const daysOut = Math.round((day.d.getTime() - today.getTime()) / MS_DAY);
    let reason: string | null = null;
    let severity: "high" | "medium" = "medium";
    if (day.fcOccPct !== null && day.fcOccPct >= 85) {
      reason = "Alta demanda: revisar BAR/restricciones";
      severity = day.fcOccPct >= 92 ? "high" : "medium";
    } else if (day.stlyOccPct !== null && daysOut <= 30 && day.occPct < day.stlyOccPct - 15) {
      reason = "Ritmo por debajo de STLY";
    } else if (day.pickup7 !== null && day.pickup7 <= 0 && day.fcOccPct !== null && day.fcOccPct >= 70) {
      reason = "Pickup estancado con demanda prevista";
    }
    if (!reason) continue;
    candidates.push({
      date: day.date,
      dow: dowEs(day.d),
      daysOut,
      severity,
      reason,
      occPct: day.occPct,
      fcOccPct: day.fcOccPct,
      stlyOccPct: day.stlyOccPct,
      pickup7: day.pickup7,
      recommendation: null,
      recommendationMissing: "sin datos",
      compsetMedian: null,
      compsetMissing: "sin compset"
    });
  }
  candidates.sort((a, b) =>
    a.severity !== b.severity ? (a.severity === "high" ? -1 : 1) : a.daysOut - b.daysOut
  );
  const criticalDates = candidates.slice(0, 10);
  // RMS recommendation (lead room type, short reason) + comp-set median of the
  // latest shop for the flagged dates only. When the engine has no data it
  // says why (`recommendationMissing` / `compsetMissing`) instead of null.
  if (criticalDates.length > 0) {
    const recFrom = criticalDates.reduce((m, c) => (c.date < m ? c.date : m), criticalDates[0].date);
    const recTo = criticalDates.reduce((m, c) => (c.date > m ? c.date : m), criticalDates[0].date);
    const recs = await buildRecommendations({ propertyId, from: recFrom, to: recTo, today, maxDays: BOARD_MAX_DAYS });
    const recByDate = new Map(recs.days.map((d) => [d.date, d]));
    for (const c of criticalDates) {
      const summary = summarizeDayRecommendation(recByDate.get(c.date), recs.leadRoomTypeIdByDate[c.date]);
      c.recommendation = summary.recommendation;
      c.recommendationMissing = summary.recommendationMissing;
      c.compsetMedian = summary.compsetMedian;
      c.compsetMissing = summary.compsetMissing;
    }
  }

  // ---- KPIs --------------------------------------------------------------------
  const kpiBlock = (days: DaySeries[]): BoardKpiBlock => {
    const roomsSold = days.reduce((s, x) => s + x.roomsSold, 0);
    const revenue = round2(days.reduce((s, x) => s + x.roomRevenue, 0));
    const capacity = totalRooms * days.length;
    return {
      roomsSold,
      occPct: capacity > 0 ? round2((roomsSold / capacity) * 100) : 0,
      adr: roomsSold > 0 ? round2(revenue / roomsSold) : null,
      revenue
    };
  };
  const rangeDays = (start: Date, endExclusive: Date): DaySeries[] => {
    const out: DaySeries[] = [];
    for (let t = start.getTime(); t < endExclusive.getTime(); t += MS_DAY) {
      const s = byDate.get(isoDate(new Date(t)));
      if (s) out.push(s);
    }
    return out;
  };
  const next7Days = rangeDays(today, addDays(today, 7));
  const next30Days = rangeDays(today, addDays(today, 30));
  const mtdDays = rangeDays(monthsStart, today);
  const mtdStlyRevDays = mtdDays.filter((x) => x.stlyRevenue !== null);
  const mtdStlyRev = mtdStlyRevDays.reduce((s, x) => s + (x.stlyRevenue as number), 0);
  const mtdBlock = kpiBlock(mtdDays);
  const confDays = windowSeries.filter((x) => !x.isPast && x.fcConfidence !== null);
  const kpis: BoardKpis = {
    next7: { ...kpiBlock(next7Days), pickup7: sumNullable(next7Days, (x) => x.pickup7) },
    next30: { ...kpiBlock(next30Days), pickup7: sumNullable(next30Days, (x) => x.pickup7) },
    mtd: {
      ...mtdBlock,
      vsStlyRevenuePct:
        mtdStlyRevDays.length > 0 && mtdStlyRev > 0
          ? round2(((mtdBlock.revenue - mtdStlyRev) / mtdStlyRev) * 100)
          : null
    },
    forecastConfidenceAvg: confDays.length
      ? round2(confDays.reduce((s, x) => s + (x.fcConfidence as number), 0) / confDays.length)
      : null
  };

  // ---- honest source map ---------------------------------------------------------
  const sources: Record<string, string> = {
    history: realized.source ?? (snapshotDaysUsed + fallbackDaysUsed === 0 ? "sin días pasados en la ventana" : "reservas"),
    otb: "reservas en vivo",
    forecast: forecastModelVersion,
    forecastAdr: forecastAdrSourceLabel(fcAdrSources),
    stly: "snapshots (fecha−364)",
    budget: "presupuesto mensual prorrateado",
    pickup:
      paceSnapshotHits > 0 && paceReconstructions > 0
        ? "pace snapshots+reconstrucción por createdAt"
        : paceSnapshotHits > 0
          ? "pace snapshots"
          : "reconstrucción por createdAt"
  };

  return {
    propertyId,
    propertyName: property.name,
    businessDate: isoDate(yesterday),
    generatedAt: new Date().toISOString(),
    from: isoDate(from),
    to: isoDate(to),
    totalRooms,
    forecastMissing,
    budgetMissing,
    // Contract literal list, plus the PMS-bases note only when it applies.
    metricNotes: importedForecastDays > 0 ? [...METRIC_NOTES, pmsForecastMetricNote(totalRooms)] : METRIC_NOTES,
    sources,
    rows,
    months,
    criticalDates,
    kpis
  };
}

// -----------------------------------------------------------------------------
// Daily snapshot writer (contract §5) — closes the "seed-only" gap: the pace
// scheduler calls this after the nightly OTB capture so yesterday's top-level
// RevenueDailySnapshot is derived from real reservations (dataSource
// "night_audit"). Idempotent by manual find-then-write: the compound unique
// contains nullable dimension columns and Postgres treats NULLs as distinct,
// so a plain upsert on the unique would create duplicates.
//
// Two protections so the writer can coexist with history IMPORTED from another
// PMS (dataSource "pms_import:*", "migration_import", seeded "demo"…):
//   1. A property with NO reservation at all in Anfitorio has no night audit to
//      write: a 0-room close would overwrite the imported day and open a
//      "cliff" to zero right after the import. Nothing is written.
//   2. An existing top-level row whose dataSource is not "night_audit" is never
//      overwritten unless the caller passes { force: true } (same rule as
//      scripts/backfill-snapshots.ts --force).
// -----------------------------------------------------------------------------
export type SnapshotWriteDecision =
  | { action: "write" }
  | { action: "skipped"; reason: "no_reservations" }
  | { action: "skipped"; reason: "protected"; dataSource: string };

/** dataSource written by this closer; the only one it may overwrite without force. */
export const NIGHT_AUDIT_DATA_SOURCE = "night_audit";

/**
 * Pure decision: write, or skip and why. Order matters: a property without any
 * operation is skipped regardless of what the day's row says (there is nothing
 * real to derive), then the existing row's provenance is honoured.
 */
export function decideSnapshotWrite(input: {
  existing: { dataSource: string } | null;
  hasReservations: boolean;
  force?: boolean;
}): SnapshotWriteDecision {
  if (!input.hasReservations) return { action: "skipped", reason: "no_reservations" };
  if (input.existing && input.existing.dataSource !== NIGHT_AUDIT_DATA_SOURCE && !input.force) {
    return { action: "skipped", reason: "protected", dataSource: input.existing.dataSource };
  }
  return { action: "write" };
}

export type DailySnapshotWriteResult =
  | { propertyId: string; snapshotDate: string; action: "created" | "updated" }
  | { propertyId: string; snapshotDate: string; action: "skipped"; reason: "no_reservations" }
  | { propertyId: string; snapshotDate: string; action: "skipped"; reason: "protected"; dataSource: string };

export async function writeDailySnapshot(
  propertyId: string,
  dateIso?: string,
  opts: { force?: boolean } = {}
): Promise<DailySnapshotWriteResult> {
  const date = dateIso ? dayUtc(dateIso) : addDays(dayUtc(), -1);
  const snapshotDate = isoDate(date);

  // Decide BEFORE deriving anything: both lookups are cheap and the skip paths
  // must not touch the row.
  const [reservationCount, existing] = await Promise.all([
    prisma.reservation.count({ where: { propertyId } }), // any status: "has this property ever operated here?"
    prisma.revenueDailySnapshot.findFirst({
      where: {
        propertyId,
        snapshotDate: date,
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      select: { id: true, dataSource: true }
    })
  ]);
  const decision = decideSnapshotWrite({ existing, hasReservations: reservationCount > 0, force: opts.force });
  if (decision.action === "skipped") {
    return decision.reason === "protected"
      ? { propertyId, snapshotDate, action: "skipped", reason: "protected", dataSource: decision.dataSource }
      : { propertyId, snapshotDate, action: "skipped", reason: "no_reservations" };
  }

  const totalRooms = await prisma.room.count({ where: { propertyId, sellable: true } });
  const reservations = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: BOARD_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] },
      arrivalDate: { lte: date },
      departureDate: { gte: date }
    },
    select: {
      arrivalDate: true,
      departureDate: true,
      roomsCount: true,
      totalAmount: true,
      adults: true,
      children: true,
      status: true
    }
  });

  let rooms = 0;
  let revenue = 0;
  let arrivals = 0;
  let departures = 0;
  let noShows = 0;
  let pax = 0;
  for (const r of reservations) {
    const arr = dayUtc(r.arrivalDate);
    const dep = dayUtc(r.departureDate);
    if (r.status === "no_show") {
      if (arr.getTime() === date.getTime()) noShows += r.roomsCount;
      continue;
    }
    if (arr.getTime() === date.getTime()) arrivals += r.roomsCount;
    if (dep.getTime() === date.getTime()) departures += r.roomsCount;
    if (arr.getTime() <= date.getTime() && dep.getTime() > date.getTime()) {
      const n = Math.max(1, Math.round((dep.getTime() - arr.getTime()) / MS_DAY));
      rooms += r.roomsCount;
      revenue += dec(r.totalAmount) / n;
      pax += r.adults + r.children;
    }
  }
  const roomRevenue = round2(revenue);
  const data = {
    totalOcc: rooms,
    arrivalRooms: arrivals,
    departureRooms: departures,
    noShowRooms: noShows,
    adultsChildren: pax,
    roomRevenue,
    totalRevenue: roomRevenue,
    adr: rooms > 0 ? round2(roomRevenue / rooms) : null,
    revpar: totalRooms > 0 ? round2(roomRevenue / totalRooms) : null,
    occupancyPercent: totalRooms > 0 ? round2((rooms / totalRooms) * 100) : null,
    dataSource: NIGHT_AUDIT_DATA_SOURCE
  };

  if (existing) {
    await prisma.revenueDailySnapshot.update({ where: { id: existing.id }, data });
  } else {
    await prisma.revenueDailySnapshot.create({ data: { propertyId, snapshotDate: date, ...data } });
  }
  return { propertyId, snapshotDate, action: existing ? "updated" : "created" };
}

/**
 * Scheduler entry point: upsert yesterday's top-level snapshot for every
 * property. A failure on one property never blocks the others, but it is
 * never silent either (QC-06): logged per property and returned in `failed`.
 * Skips (no reservations / protected provenance) are counted and logged too,
 * so an operator can tell "nothing to close" from "close written".
 */
export async function writeYesterdayDailySnapshotsForAllProperties(): Promise<{
  properties: number;
  written: number;
  skipped: { noReservations: string[]; protected: Array<{ propertyId: string; dataSource: string }> };
  failed: Array<{ propertyId: string; error: string }>;
}> {
  const properties = await prisma.property.findMany({ select: { id: true } });
  let written = 0;
  const skipped: { noReservations: string[]; protected: Array<{ propertyId: string; dataSource: string }> } = {
    noReservations: [],
    protected: []
  };
  const failed: Array<{ propertyId: string; error: string }> = [];
  for (const p of properties) {
    try {
      const result = await writeDailySnapshot(p.id);
      if (result.action === "skipped") {
        if (result.reason === "protected") skipped.protected.push({ propertyId: p.id, dataSource: result.dataSource });
        else skipped.noReservations.push(p.id);
      } else {
        written++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ propertyId: p.id, error: message });
      console.error(`[revenue:daily-snapshot] property ${p.id}: ${message}`);
      // continue with the next property
    }
  }
  const skippedTotal = skipped.noReservations.length + skipped.protected.length;
  if (skippedTotal > 0) {
    const parts: string[] = [];
    if (skipped.noReservations.length > 0) {
      parts.push(`${skipped.noReservations.length} sin reservas (${skipped.noReservations.join(", ")})`);
    }
    if (skipped.protected.length > 0) {
      parts.push(
        `${skipped.protected.length} con cierre protegido (${skipped.protected.map((s) => `${s.propertyId}:${s.dataSource}`).join(", ")})`
      );
    }
    console.info(`[revenue:daily-snapshot] ${skippedTotal}/${properties.length} propiedades omitidas: ${parts.join(" · ")} (escritas: ${written}).`);
  }
  if (failed.length > 0) {
    console.error(`[revenue:daily-snapshot] ${failed.length}/${properties.length} properties failed (written: ${written}).`);
  }
  return { properties: properties.length, written, skipped, failed };
}
