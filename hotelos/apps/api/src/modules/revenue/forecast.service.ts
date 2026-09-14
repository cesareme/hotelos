// Revenue forecasts — REAL persistence (BIG-3 demo-store retirement).
//
// Reads/writes the canonical `RevenueForecast` table instead of the in-memory
// advanced-records store. The generator is DETERMINISTIC and explainable (a
// simple occupancy/ADR curve over the real rate grid), not a black box — it is
// honest about being rules-based, with `modelVersion: "deterministic-v1"`.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";
import {
  dayUtc,
  dec,
  decOrNull,
  getPublishedBar,
  getRealizedByDay,
  getStlySnapshotAdr,
  isoDate,
  parseRevenueWindow,
  publishedBarFor,
  typeDateKey
} from "./actuals.js";

/**
 * Where the model's ADR input came from (persisted in driversJson as
 * `adr_source`). `legacy_constant` = rows written by the previous generator
 * with its hard-coded fallback ADR (driver value "fallback"): they carry
 * revenue, but not from any real input — regenerate the forecast.
 * `pms_forecast` = rows IMPORTED from another PMS's History & Forecast report
 * (modelVersion "pms_import:*"): the ADR is the source system's own forecast.
 */
export type ForecastAdrSource = "rate_grid" | "stly_snapshot" | "none" | "no_rooms" | "legacy_constant" | "pms_forecast";

/** modelVersion prefix of forecast rows imported from another PMS (importer contract). */
export const PMS_IMPORT_MODEL_PREFIX = "pms_import:";
/** modelVersion written by this file's deterministic generator. */
export const DETERMINISTIC_MODEL_VERSION = "deterministic-v1";

export function isImportedForecastModelVersion(modelVersion: string | null | undefined): boolean {
  return typeof modelVersion === "string" && modelVersion.startsWith(PMS_IMPORT_MODEL_PREFIX);
}

export function emptyAdrSourceCounts(): Record<ForecastAdrSource, number> {
  return { rate_grid: 0, stly_snapshot: 0, none: 0, no_rooms: 0, legacy_constant: 0, pms_forecast: 0 };
}

/** Spanish label for a set of ADR sources (used by `sources` maps). */
export function forecastAdrSourceLabel(counts: Record<ForecastAdrSource, number>): string {
  const parts: string[] = [];
  if (counts.pms_forecast > 0) parts.push("previsión del PMS (importada)");
  if (counts.rate_grid > 0) parts.push("tarifario BAR");
  if (counts.stly_snapshot > 0) parts.push("snapshot LY (fecha−364)");
  if (counts.legacy_constant > 0) parts.push(`ADR constante heredado en ${counts.legacy_constant} filas (regenerar previsión)`);
  if (counts.none > 0) parts.push(`sin ADR (${counts.none} filas sin ingresos)`);
  return parts.length ? parts.join("+") : "sin previsión";
}

/**
 * ADR source of a persisted forecast row. The `adr_source` driver wins; a row
 * without it but with an imported modelVersion is still "pms_forecast" (the
 * importer may write drivers of its own), so an imported forecast never shows
 * as "sin previsión".
 */
export function adrSourceFromDrivers(drivers: unknown, modelVersion?: string | null): ForecastAdrSource | null {
  const hit = Array.isArray(drivers)
    ? (drivers.find((d) => d && typeof d === "object" && (d as { driver?: unknown }).driver === "adr_source") as { value?: unknown } | undefined)
    : undefined;
  const v = hit?.value;
  if (v === "rate_grid" || v === "stly_snapshot" || v === "none" || v === "no_rooms" || v === "legacy_constant" || v === "pms_forecast") return v;
  if (v === "fallback") return "legacy_constant";
  return isImportedForecastModelVersion(modelVersion) ? "pms_forecast" : null;
}

/**
 * Prisma filter for the rows the deterministic generator may delete when it
 * regenerates a window: every row of the property in the range EXCEPT those
 * imported from another PMS. `modelVersion` is nullable and Postgres never
 * matches NULL with NOT LIKE, so legacy NULL rows are listed explicitly.
 */
export function forecastDeleteFilter(input: { propertyId: string; from: Date; to: Date }): Prisma.RevenueForecastWhereInput {
  return {
    propertyId: input.propertyId,
    forecastDate: { gte: input.from, lte: input.to },
    OR: [{ modelVersion: null }, { NOT: { modelVersion: { startsWith: PMS_IMPORT_MODEL_PREFIX } } }]
  };
}

function mapForecast(r: {
  id: string; propertyId: string; forecastDate: Date; roomTypeId: string | null;
  expectedOccupancy: Prisma.Decimal | null; expectedRoomsSold: Prisma.Decimal | null;
  expectedAdr: Prisma.Decimal | null; expectedRevpar: Prisma.Decimal | null;
  expectedRoomRevenue: Prisma.Decimal | null; expectedTotalRevenue: Prisma.Decimal | null;
  confidence: Prisma.Decimal | null; modelVersion: string | null; driversJson: unknown;
}) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    forecastDate: isoDate(r.forecastDate),
    roomTypeId: r.roomTypeId ?? undefined,
    expectedOccupancy: dec(r.expectedOccupancy),
    expectedRoomsSold: dec(r.expectedRoomsSold),
    // ADR-derived figures are null when the model had no ADR input (no BAR
    // published, no LY close) — never a fabricated amount.
    expectedAdr: decOrNull(r.expectedAdr),
    expectedRevpar: decOrNull(r.expectedRevpar),
    expectedRoomRevenue: decOrNull(r.expectedRoomRevenue),
    expectedTotalRevenue: decOrNull(r.expectedTotalRevenue),
    confidence: dec(r.confidence),
    modelVersion: r.modelVersion ?? undefined,
    adrSource: adrSourceFromDrivers(r.driversJson, r.modelVersion),
    drivers: r.driversJson
  };
}

export async function listForecasts(input: { propertyId: string; from?: string; to?: string }) {
  const where: Prisma.RevenueForecastWhereInput = { propertyId: input.propertyId };
  if (input.from || input.to) {
    where.forecastDate = {};
    if (input.from) (where.forecastDate as Prisma.DateTimeFilter).gte = dayUtc(input.from);
    if (input.to) (where.forecastDate as Prisma.DateTimeFilter).lte = dayUtc(input.to);
  }
  const rows = await prisma.revenueForecast.findMany({ where, orderBy: { forecastDate: "asc" }, take: 400 });
  return rows.map(mapForecast);
}

/**
 * Deterministic forecast over a date window. Per day × room type:
 *   - occupancy: base 0.68 + weekend bump (Fri/Sat) − a small lead-time taper
 *   - ADR: published BAR (RateDay of the BAR plan) for that day/room type →
 *     audited ADR of the same day of week last year (snapshot at date−364) →
 *     null (revenue/ADR/RevPAR left null, `adr_source: "none"`). Never a constant.
 * Replaces any existing forecasts in the window for the property (idempotent),
 * EXCEPT rows imported from another PMS (modelVersion "pms_import:*"): those are
 * the hotel's real forecast, so the generator neither deletes them nor writes
 * its curve on the days they cover (a second row per day would double-count in
 * per-day aggregations). It reports them as `skippedImported`.
 */
export async function generateForecasts(input: {
  context: UserContext;
  propertyId: string;
  from?: string;
  to?: string;
  correlationId: string;
}) {
  requirePermissions(input.context, ["revenue.recommend"]);
  const from = dayUtc(input.from);
  const to = input.to ? dayUtc(input.to) : new Date(from.getTime() + 29 * 86_400_000);
  if (to.getTime() < from.getTime()) throw new BadRequestError("'to' must be on or after 'from'.");
  const days = Math.min(120, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);

  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId: input.propertyId, active: true },
    select: { id: true }
  });
  if (roomTypes.length === 0) return { generated: 0 };

  // Total sellable rooms per type (capacity for rooms-sold/RevPAR).
  const roomCounts = new Map<string, number>();
  for (const rt of roomTypes) {
    roomCounts.set(
      rt.id,
      await prisma.room.count({ where: { propertyId: input.propertyId, roomTypeId: rt.id, sellable: true } })
    );
  }
  // ADR inputs: published BAR per day/type (BAR plan only) and the LY close.
  const [publishedBar, stlyAdr] = await Promise.all([
    getPublishedBar(input.propertyId, from, to),
    getStlySnapshotAdr(input.propertyId, from, to)
  ]);

  // Imported PMS forecast in the window: preserved, and their days are not
  // regenerated. Counted before the loop so the result can say so.
  const importedRows = await prisma.revenueForecast.findMany({
    where: { propertyId: input.propertyId, forecastDate: { gte: from, lte: to }, modelVersion: { startsWith: PMS_IMPORT_MODEL_PREFIX } },
    select: { forecastDate: true }
  });
  const importedDays = new Set(importedRows.map((r) => isoDate(dayUtc(r.forecastDate))));
  const skippedImported = importedRows.length;

  const adrSources = emptyAdrSourceCounts();
  const data: Prisma.RevenueForecastCreateManyInput[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(from.getTime() + i * 86_400_000);
    const key = isoDate(date);
    if (importedDays.has(key)) continue;
    const dow = date.getUTCDay(); // 0 Sun .. 6 Sat
    const weekendBump = dow === 5 || dow === 6 ? 0.18 : dow === 0 ? 0.05 : 0;
    const occupancy = Math.max(0.2, Math.min(0.98, 0.68 + weekendBump));
    for (const rt of roomTypes) {
      const total = roomCounts.get(rt.id) ?? 0;
      const roomsSold = Math.round(total * occupancy);
      // ADR chain: BAR of this type → LY close ADR (property level) → null.
      let adr: number | null = publishedBar.byTypeDate.get(typeDateKey(rt.id, key)) ?? null;
      let adrSource: ForecastAdrSource = "rate_grid";
      if (adr === null) {
        const ly = stlyAdr.get(key);
        if (ly !== undefined) {
          adr = ly;
          adrSource = "stly_snapshot";
        } else {
          adrSource = total === 0 ? "no_rooms" : "none";
        }
      }
      adrSources[adrSource]++;
      // A type with no rooms sells nothing: revenue is 0 by definition, not unknown.
      const roomRevenue = adr !== null ? Math.round(roomsSold * adr * 100) / 100 : total === 0 ? 0 : null;
      const revpar = roomRevenue !== null && total > 0 ? Math.round((roomRevenue / total) * 100) / 100 : roomRevenue === 0 ? 0 : null;
      data.push({
        propertyId: input.propertyId,
        forecastDate: date,
        roomTypeId: rt.id,
        expectedOccupancy: Math.round(occupancy * 10000) / 100, // percent
        expectedRoomsSold: roomsSold,
        expectedAdr: adr,
        expectedRevpar: revpar,
        expectedRoomRevenue: roomRevenue,
        expectedTotalRevenue: roomRevenue,
        confidence: 60,
        modelVersion: DETERMINISTIC_MODEL_VERSION,
        driversJson: [
          { driver: "base_occupancy", value: 0.68 },
          { driver: "weekend_bump", value: weekendBump },
          { driver: "adr_source", value: adrSource }
        ] as unknown as Prisma.InputJsonValue
      });
    }
  }

  const generated = await prisma.$transaction(async (tx) => {
    // Never the imported rows (see forecastDeleteFilter).
    await tx.revenueForecast.deleteMany({ where: forecastDeleteFilter({ propertyId: input.propertyId, from, to }) });
    const created = data.length > 0 ? await tx.revenueForecast.createMany({ data }) : { count: 0 };
    return created.count;
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REVENUE_FORECAST_GENERATED",
    entityType: "revenue_forecast",
    entityId: input.propertyId,
    afterJson: {
      generated,
      skippedImported,
      skippedImportedDays: importedDays.size,
      from: isoDate(from),
      to: isoDate(to),
      modelVersion: DETERMINISTIC_MODEL_VERSION,
      adrSources,
      barSource: publishedBar.source
    },
    correlationId: input.correlationId
  });

  return {
    generated,
    skippedImported,
    skippedImportedDays: importedDays.size,
    adrSources,
    barSource: publishedBar.source,
    adrSourceLabel: forecastAdrSourceLabel(adrSources)
  };
}

// ---------------------------------------------------------------------------
// B2 — Forecast by segment (derived) + forecast accuracy (real backtest)
// ---------------------------------------------------------------------------
const OTB_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
const MS_DAY = 86_400_000;
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Real segment mix (share of room nights) from the property's reservations. */
async function segmentMix(propertyId: string): Promise<Array<{ segment: string; share: number }>> {
  const rows = await prisma.reservation.groupBy({
    by: ["marketSegment"],
    where: { propertyId, status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] } },
    _sum: { roomsCount: true }
  });
  const labelled = rows
    .map((r) => ({ segment: r.marketSegment ?? "Sin segmento", rooms: r._sum.roomsCount ?? 0 }))
    .filter((r) => r.rooms > 0);
  const total = labelled.reduce((s, r) => s + r.rooms, 0);
  if (total === 0) return [{ segment: "Sin segmento", share: 1 }];
  return labelled.map((r) => ({ segment: r.segment, share: r.rooms / total }));
}

/**
 * Forecast broken down by market segment. The per-day property forecast (summed
 * from the room-type rows) is allocated across the real segment mix. Honest about
 * being a derived split (source: "forecast×segment_mix").
 */
export async function getForecastBySegment(input: { propertyId: string; from?: string; to?: string }) {
  const forecasts = await listForecasts(input);
  const byDay = new Map<string, { rooms: number; revenue: number; revenueKnown: boolean }>();
  for (const r of forecasts) {
    const b = byDay.get(r.forecastDate) ?? { rooms: 0, revenue: 0, revenueKnown: true };
    b.rooms += r.expectedRoomsSold;
    if (r.expectedRoomRevenue === null) b.revenueKnown = false;
    else b.revenue += r.expectedRoomRevenue;
    byDay.set(r.forecastDate, b);
  }
  const mix = await segmentMix(input.propertyId);
  const rows: Array<{ forecastDate: string; segment: string; expectedRoomsSold: number; expectedRoomRevenue: number | null; expectedAdr: number | null; sharePercent: number }> = [];
  for (const [date, b] of [...byDay.entries()].sort(([a], [c]) => a.localeCompare(c))) {
    const adr = b.revenueKnown && b.rooms > 0 ? round2(b.revenue / b.rooms) : null;
    for (const m of mix) {
      rows.push({
        forecastDate: date,
        segment: m.segment,
        expectedRoomsSold: round2(b.rooms * m.share),
        expectedRoomRevenue: b.revenueKnown ? round2(b.revenue * m.share) : null,
        expectedAdr: adr,
        sharePercent: Math.round(m.share * 1000) / 10
      });
    }
  }
  return { propertyId: input.propertyId, segments: mix.map((m) => m.segment), rows, source: "forecast×segment_mix" as const };
}

type ReportRow = {
  rowType: "section" | "data" | "subtotal" | "total";
  label?: string;
  date?: string;
  totalOcc?: number;
  arrivalRooms?: number;
  departureRooms?: number;
  noShowRooms?: number;
  occPercent?: number;
  totalRevenue?: number;
  averageRate?: number;
  adultsChildren?: number;
};

/**
 * Live detailed history/forecast report. History rows (stay date < business date)
 * come from the shared realized helper (audited snapshots first, reservations
 * fallback); forecast rows come from RevenueForecast. Returns data rows with
 * History/Forecast sections, subtotals and a grand total — the same shape the
 * admin table renders.
 */
/** Longest window the live report serves; a longer request is a 400, never a silent truncation. */
export const REPORT_MAX_DAYS = 120;
/** Default report window when `to` is omitted: 31 calendar days from `from`. */
export const REPORT_DEFAULT_SPAN_DAYS = 30;

/** Route-level and service-level validation share this so a direct caller gets the same 400. */
export function parseReportWindow(input: { from?: unknown; to?: unknown; today?: Date }) {
  const todayIso = isoDate(dayUtc(input.today));
  return parseRevenueWindow({
    from: input.from,
    to: input.to,
    maxDays: REPORT_MAX_DAYS,
    defaultFrom: todayIso,
    defaultTo: (from) => isoDate(addDays(dayUtc(from), REPORT_DEFAULT_SPAN_DAYS)),
    scope: "del informe"
  });
}

export async function getLiveHistoryForecastReport(input: { propertyId: string; from?: string; to?: string }) {
  const propertyId = input.propertyId;
  const today = dayUtc();
  // The window used to be clipped to 120 rows with from/to echoing the request
  // (pilot verification R2): now the limit is enforced up front.
  const win = parseReportWindow({ from: input.from, to: input.to, today });
  const from = dayUtc(win.from);
  const to = dayUtc(win.to);
  const days = win.days;
  const totalRooms = await prisma.room.count({ where: { propertyId, sellable: true } });

  // History: shared "realized" rule (snapshot-first, reservations fallback, < today).
  const realized = await getRealizedByDay(propertyId, from, to, { today, totalRooms });

  // Forecast: RevenueForecast rows aggregated per day for [max(from,today), to].
  const fcFrom = today.getTime() > from.getTime() ? today : from;
  const forecasts = await listForecasts({ propertyId, from: isoDate(fcFrom), to: isoDate(to) });
  const fc = new Map<string, { rooms: number; revenue: number; revenueKnown: boolean }>();
  for (const f of forecasts) {
    const b = fc.get(f.forecastDate) ?? { rooms: 0, revenue: 0, revenueKnown: true };
    b.rooms += f.expectedRoomsSold;
    if (f.expectedRoomRevenue === null) b.revenueKnown = false;
    else b.revenue += f.expectedRoomRevenue;
    fc.set(f.forecastDate, b);
  }

  const rows: ReportRow[] = [];
  const histData: ReportRow[] = [];
  const fcData: ReportRow[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    const key = isoDate(d);
    if (d < today) {
      const a = realized.days.get(key);
      if (!a || (a.source === "reservations" && a.rooms === 0 && a.noShows === 0 && a.arrivals === 0 && a.departures === 0)) continue;
      histData.push({
        rowType: "data", date: key,
        totalOcc: a.rooms, arrivalRooms: a.arrivals, departureRooms: a.departures, noShowRooms: a.noShows,
        occPercent: a.occPct,
        totalRevenue: a.roomRevenue, averageRate: a.adr ?? 0, adultsChildren: a.pax
      });
    } else {
      const b = fc.get(key);
      if (!b) continue;
      const rooms = Math.round(b.rooms);
      fcData.push({
        rowType: "data", date: key,
        totalOcc: rooms, arrivalRooms: 0, departureRooms: 0, noShowRooms: 0,
        occPercent: totalRooms > 0 ? round2((rooms / totalRooms) * 100) : 0,
        totalRevenue: b.revenueKnown ? round2(b.revenue) : undefined,
        averageRate: b.revenueKnown && rooms > 0 ? round2(b.revenue / rooms) : undefined,
        adultsChildren: 0
      });
    }
  }

  const subtotal = (label: string, list: ReportRow[]): ReportRow => {
    const occ = list.reduce((s, r) => s + (r.totalOcc ?? 0), 0);
    const rev = list.reduce((s, r) => s + (r.totalRevenue ?? 0), 0);
    return {
      rowType: "subtotal", label,
      totalOcc: occ, arrivalRooms: list.reduce((s, r) => s + (r.arrivalRooms ?? 0), 0), departureRooms: list.reduce((s, r) => s + (r.departureRooms ?? 0), 0),
      noShowRooms: list.reduce((s, r) => s + (r.noShowRooms ?? 0), 0),
      occPercent: totalRooms > 0 && list.length ? round2((occ / (totalRooms * list.length)) * 100) : 0,
      totalRevenue: round2(rev), averageRate: occ > 0 ? round2(rev / occ) : 0, adultsChildren: list.reduce((s, r) => s + (r.adultsChildren ?? 0), 0)
    };
  };

  if (histData.length) { rows.push({ rowType: "section", label: "Histórico" }, ...histData, subtotal("Subtotal histórico", histData)); }
  if (fcData.length) { rows.push({ rowType: "section", label: "Previsión" }, ...fcData, subtotal("Subtotal previsión", fcData)); }
  const all = [...histData, ...fcData];
  if (all.length) { const t = subtotal("Total", all); t.rowType = "total"; rows.push(t); }

  const historySource = realized.source ?? "sin histórico";
  return {
    propertyId,
    from: isoDate(from),
    to: isoDate(to),
    businessDate: isoDate(addDays(today, -1)),
    totalRooms,
    rows,
    sources: { history: historySource, forecast: "RevenueForecast" },
    snapshotDays: realized.snapshotDays,
    fallbackDays: realized.fallbackDays,
    source: `${historySource}+forecast`
  };
}

/**
 * Forecast accuracy via BACKTEST: for each past stay date, what the deterministic
 * model would have predicted vs the realized actual (shared helper: audited
 * snapshots first, reservations fallback). The model's ADR input is the
 * published BAR of the day → LY close ADR → none (adr/revpar metrics are then
 * skipped for that day instead of being backtested against a constant).
 * Persists a ForecastAccuracy row per (date, metric) and returns a MAPE summary.
 * Honest: modelVersion "deterministic-v1-backtest".
 */
export async function getForecastAccuracy(input: { propertyId: string; days?: number }) {
  const propertyId = input.propertyId;
  const days = Math.min(120, Math.max(1, input.days ?? 30));
  const today = dayUtc();
  const from = addDays(today, -days);
  const last = addDays(today, -1);

  const totalRooms = await prisma.room.count({ where: { propertyId, sellable: true } });
  const emptySources = { actual: null, forecastAdr: "sin previsión", adrSources: emptyAdrSourceCounts() };
  if (totalRooms === 0) {
    return { propertyId, days, totalRooms: 0, metrics: [], rows: [], sources: emptySources, snapshotDays: 0, fallbackDays: 0, source: "deterministic-v1-backtest" as const };
  }

  // Actual realized per past stay date (ONE definition of "Real") + ADR inputs.
  const [realized, publishedBar, stlyAdr] = await Promise.all([
    getRealizedByDay(propertyId, from, last, { today, totalRooms }),
    getPublishedBar(propertyId, from, last),
    getStlySnapshotAdr(propertyId, from, last)
  ]);

  const metricRows: Array<{ stayDate: string; metric: string; forecast: number; actual: number; absError: number; pctError: number | null }> = [];
  const persist: Prisma.ForecastAccuracyCreateManyInput[] = [];
  const adrSources = emptyAdrSourceCounts();

  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const key = isoDate(date);
    const dow = date.getUTCDay();
    const weekendBump = dow === 5 || dow === 6 ? 0.18 : dow === 0 ? 0.05 : 0;
    const fOcc = Math.max(0.2, Math.min(0.98, 0.68 + weekendBump));
    const fRooms = Math.round(totalRooms * fOcc);
    let fAdr: number | null = publishedBarFor(publishedBar, key);
    if (fAdr !== null) adrSources.rate_grid++;
    else {
      const ly = stlyAdr.get(key);
      if (ly !== undefined) {
        fAdr = ly;
        adrSources.stly_snapshot++;
      } else adrSources.none++;
    }

    const realizedDay = realized.days.get(key);
    const actual = { rooms: realizedDay?.rooms ?? 0, revenue: realizedDay?.roomRevenue ?? 0 };
    const aOcc = totalRooms > 0 ? actual.rooms / totalRooms : 0;
    const aAdr = actual.rooms > 0 ? actual.revenue / actual.rooms : 0;
    const aRevpar = totalRooms > 0 ? actual.revenue / totalRooms : 0;

    const pairs: Array<[string, number, number]> = [
      ["occupancy", round2(fOcc * 100), round2(aOcc * 100)],
      ["rooms_sold", fRooms, actual.rooms]
    ];
    if (fAdr !== null) {
      const fRevpar = totalRooms > 0 ? (fRooms * fAdr) / totalRooms : 0;
      pairs.push(["adr", round2(fAdr), round2(aAdr)], ["revpar", round2(fRevpar), round2(aRevpar)]);
    }
    for (const [metric, forecast, actualVal] of pairs) {
      const absError = round2(Math.abs(forecast - actualVal));
      const pctError = actualVal !== 0 ? round2((absError / Math.abs(actualVal)) * 100) : null;
      metricRows.push({ stayDate: key, metric, forecast, actual: actualVal, absError, pctError });
      persist.push({
        propertyId,
        stayDate: date,
        metric,
        forecastValue: forecast,
        actualValue: actualVal,
        absError,
        pctError,
        modelVersion: "deterministic-v1-backtest"
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.forecastAccuracy.deleteMany({ where: { propertyId, stayDate: { gte: from, lt: today } } });
    if (persist.length) await tx.forecastAccuracy.createMany({ data: persist });
  });

  // MAPE per metric over days where actual > 0.
  const metricsSummary = ["occupancy", "adr", "revpar", "rooms_sold"].map((metric) => {
    const rows = metricRows.filter((r) => r.metric === metric && r.pctError !== null);
    const mape = rows.length ? round2(rows.reduce((s, r) => s + (r.pctError as number), 0) / rows.length) : null;
    const accuracy = mape === null ? null : round2(Math.max(0, 100 - mape));
    return { metric, mape, accuracy, samples: rows.length };
  });

  return {
    propertyId,
    days,
    totalRooms,
    metrics: metricsSummary,
    rows: metricRows,
    sources: { actual: realized.source, forecastAdr: forecastAdrSourceLabel(adrSources), adrSources },
    snapshotDays: realized.snapshotDays,
    fallbackDays: realized.fallbackDays,
    source: "deterministic-v1-backtest" as const
  };
}
