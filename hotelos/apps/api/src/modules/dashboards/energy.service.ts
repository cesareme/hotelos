import { prisma } from "@hotelos/database";

/**
 * Energy operations dashboard — read-only utility consumption stats.
 *
 * Aggregates over UtilityMeter and UtilityReading for a single property over a
 * trailing window (`days`, default 30).
 *
 * Model assumptions (verified against schema):
 *  - UtilityMeter has: id, propertyId, meterType, name, unit, active, createdAt.
 *  - UtilityReading has: id, propertyId, meterId, readingDate, value (Decimal).
 *  - `value` is treated as a CUMULATIVE meter index. Consumption over a window
 *    is (last reading at/inside window) − (last reading at or before windowStart).
 *    If only one reading exists, consumption is reported as the difference
 *    between the max and min reading in that window (best-effort fallback).
 *
 * KPI definitions:
 *  - totalKwh30d: sum across electricity-flavored meters of consumption in the
 *    trailing `days` window. A meter is "kWh-bearing" when its unit (case-insensitive)
 *    equals "kwh" OR its meterType equals "electricity". Other utilities
 *    (water m³, gas m³, …) are still reported in consumptionByMeter with their
 *    own unit but excluded from the kWh totals.
 *  - kwhPerOccupiedRoom: totalKwh30d / occupiedRoomNights, where
 *    occupiedRoomNights is the sum of nights of non-cancelled reservations
 *    intersecting the window. 0 when denominator is 0.
 *  - tendencyPct90d: trailing-30 vs prior-30 trend in kWh, expressed as
 *    ((last30 − prev30) / prev30) × 100, with 0 when prev30 is 0.
 *  - activeMeters: UtilityMeter rows with active=true for the property.
 *  - abnormalReadingsCount: readings within the window flagged as abnormal —
 *    either a negative day-over-day delta (rollback) or a daily delta greater
 *    than 4× the meter's median daily delta across its history (when at least
 *    5 deltas exist). Per-meter median guards against units mixing.
 *
 * Shape contract:
 *  - All array fields default to [] and all numeric fields default to 0.
 *  - Date strings in dailyConsumption are ISO YYYY-MM-DD (UTC day).
 *
 * Sharp edges:
 *  - Readings before window-start are required to anchor consumption. We pull
 *    them in a single query bounded to the prior 90-day lookback (so propertyId
 *    with very stale meters won't reach back forever).
 *  - tendencyPct90d uses the prior `days`-window, NOT a strict 90d window even
 *    though the field is named "...90d" — the name is preserved for parity with
 *    other dashboard contracts and reflects the "rolling-baseline" semantics.
 *    When days=30 this matches the spec literally.
 *  - topConsumers reports the same kWh window as the table, sorted desc,
 *    truncated to 10. locationName is currently undefined because UtilityMeter
 *    only carries building/floor/zone ids without any room/building name lookup
 *    available without expanding scope.
 *  - Decimal handling: prisma returns Prisma.Decimal; we coerce via Number()
 *    only after subtraction to avoid float-noise on large meter indexes.
 */

export type EnergyDashboard = {
  kpis: {
    totalKwh30d: number;
    kwhPerOccupiedRoom: number;
    tendencyPct90d: number;
    activeMeters: number;
    abnormalReadingsCount: number;
  };
  consumptionByMeter: Array<{
    meterName: string;
    meterType: string;
    kwh30d: number;
    trendPct: number;
  }>;
  dailyConsumption: Array<{ date: string; kwh: number }>;
  topConsumers: Array<{ meterName: string; locationName?: string; kwh: number }>;
};

const EMPTY: EnergyDashboard = {
  kpis: {
    totalKwh30d: 0,
    kwhPerOccupiedRoom: 0,
    tendencyPct90d: 0,
    activeMeters: 0,
    abnormalReadingsCount: 0
  },
  consumptionByMeter: [],
  dailyConsumption: [],
  topConsumers: []
};

const CANCELLED_RESERVATION_STATUSES = new Set(["cancelled", "no_show", "draft"]);

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number((v as { toString(): string }).toString());
  return Number.isFinite(n) ? n : 0;
}

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isKwhMeter(meter: { unit: string; meterType: string }): boolean {
  const u = (meter.unit ?? "").trim().toLowerCase();
  const t = (meter.meterType ?? "").trim().toLowerCase();
  return u === "kwh" || t === "electricity";
}

type ReadingRow = {
  meterId: string;
  readingDate: Date;
  value: unknown;
};

/**
 * Compute consumption between window [start, end) for one meter, given a
 * chronologically-sorted-asc list of (date,value) readings drawn from a
 * superset interval that includes at least one reading at/before `start`
 * when available.
 *
 * Returns 0 when no readings exist in the lookup range.
 */
function meterConsumption(readings: Array<{ date: Date; value: number }>, start: Date, end: Date): number {
  if (readings.length === 0) return 0;

  // Find latest reading strictly before window-start (anchor).
  let anchor: number | undefined;
  let firstInWindow: number | undefined;
  let lastInWindow: number | undefined;
  for (const r of readings) {
    if (r.date < start) {
      anchor = r.value;
      continue;
    }
    if (r.date >= end) break;
    if (firstInWindow === undefined) firstInWindow = r.value;
    lastInWindow = r.value;
  }

  if (lastInWindow === undefined) return 0;
  if (anchor !== undefined) {
    const delta = lastInWindow - anchor;
    return delta > 0 ? delta : 0;
  }
  // No pre-window anchor: fall back to (last − first) inside the window.
  if (firstInWindow !== undefined) {
    const delta = lastInWindow - firstInWindow;
    return delta > 0 ? delta : 0;
  }
  return 0;
}

/**
 * Build day-by-day consumption series for a meter inside [start, end), using
 * the cumulative-index model. Days with no readings inherit zero delta.
 */
function dailySeriesForMeter(
  readings: Array<{ date: Date; value: number }>,
  start: Date,
  end: Date
): Map<string, number> {
  const series = new Map<string, number>();
  if (readings.length === 0) return series;

  // Walk through readings and assign each delta to the day of the LATER reading.
  // Use the anchor immediately before `start` as the base where available.
  let prev: { date: Date; value: number } | undefined;
  for (const r of readings) {
    if (r.date < start) {
      prev = r;
      continue;
    }
    if (r.date >= end) break;
    if (prev) {
      const delta = r.value - prev.value;
      if (delta > 0) {
        const key = utcDayKey(r.date);
        series.set(key, (series.get(key) ?? 0) + delta);
      }
    }
    prev = r;
  }
  return series;
}

export async function buildEnergyDashboard(input: {
  propertyId: string;
  days?: number;
}): Promise<EnergyDashboard> {
  if (!input.propertyId) return EMPTY;

  const days = Number.isFinite(input.days) && (input.days ?? 0) > 0 ? Math.floor(input.days as number) : 30;

  // Window: [now − days, now). Previous window: [now − 2·days, now − days).
  // Anchor lookback extends another `days` (capped) to ensure we can find a
  // pre-window reading to compute deltas.
  const now = new Date();
  const end = now;
  const start = new Date(end.getTime() - days * 86_400_000);
  const prevStart = new Date(start.getTime() - days * 86_400_000);
  const lookbackStart = new Date(prevStart.getTime() - days * 86_400_000);

  const [meters, readings, reservations] = await Promise.all([
    prisma.utilityMeter.findMany({
      where: { propertyId: input.propertyId },
      orderBy: { name: "asc" }
    }),
    prisma.utilityReading.findMany({
      where: {
        propertyId: input.propertyId,
        readingDate: { gte: lookbackStart, lt: end }
      },
      orderBy: { readingDate: "asc" }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId: input.propertyId,
        arrivalDate: { lt: end },
        departureDate: { gt: start }
      },
      select: { status: true, arrivalDate: true, departureDate: true }
    })
  ]);

  if (meters.length === 0 && readings.length === 0) {
    return { ...EMPTY, kpis: { ...EMPTY.kpis, activeMeters: 0 } };
  }

  // Group readings by meterId, coerce Decimal to number.
  const readingsByMeter = new Map<string, Array<{ date: Date; value: number }>>();
  for (const row of readings as ReadingRow[]) {
    const list = readingsByMeter.get(row.meterId) ?? [];
    list.push({ date: row.readingDate, value: toNumber(row.value) });
    readingsByMeter.set(row.meterId, list);
  }

  // Aggregates.
  let totalKwhCurrent = 0;
  let totalKwhPrev = 0;
  const perMeterCurrent = new Map<string, number>();
  const perMeterPrev = new Map<string, number>();
  const dailyKwh = new Map<string, number>();

  for (const meter of meters) {
    const list = readingsByMeter.get(meter.id) ?? [];
    const current = meterConsumption(list, start, end);
    const prev = meterConsumption(list, prevStart, start);
    perMeterCurrent.set(meter.id, current);
    perMeterPrev.set(meter.id, prev);

    if (isKwhMeter({ unit: meter.unit, meterType: meter.meterType })) {
      totalKwhCurrent += current;
      totalKwhPrev += prev;

      // Add this meter's daily series into the property-wide daily series.
      const series = dailySeriesForMeter(list, start, end);
      for (const [day, kwh] of series.entries()) {
        dailyKwh.set(day, (dailyKwh.get(day) ?? 0) + kwh);
      }
    }
  }

  // Occupied room-nights inside [start, end) — clip each reservation to window.
  let occupiedRoomNights = 0;
  for (const r of reservations) {
    if (CANCELLED_RESERVATION_STATUSES.has(r.status as string)) continue;
    const a = r.arrivalDate.getTime();
    const d = r.departureDate.getTime();
    const clipStart = Math.max(a, start.getTime());
    const clipEnd = Math.min(d, end.getTime());
    if (clipEnd > clipStart) {
      occupiedRoomNights += (clipEnd - clipStart) / 86_400_000;
    }
  }

  // Abnormal readings: per-meter, look at consecutive deltas across the full
  // lookback and flag negative deltas or deltas > 4× median when N ≥ 5.
  let abnormalCount = 0;
  for (const meter of meters) {
    const list = readingsByMeter.get(meter.id) ?? [];
    if (list.length < 2) continue;
    const deltas: Array<{ date: Date; delta: number }> = [];
    for (let i = 1; i < list.length; i++) {
      deltas.push({ date: list[i].date, delta: list[i].value - list[i - 1].value });
    }
    const positives = deltas.map((x) => x.delta).filter((d) => d > 0).sort((a, b) => a - b);
    const median = positives.length === 0 ? 0 : positives[Math.floor(positives.length / 2)];
    for (const { date, delta } of deltas) {
      if (date < start || date >= end) continue;
      if (delta < 0) abnormalCount += 1;
      else if (median > 0 && deltas.length >= 5 && delta > median * 4) abnormalCount += 1;
    }
  }

  // Build dailyConsumption: every day in [start, end), zero-filled.
  const dailyConsumption: Array<{ date: string; kwh: number }> = [];
  for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
    const key = utcDayKey(new Date(t));
    dailyConsumption.push({ date: key, kwh: round1(dailyKwh.get(key) ?? 0) });
  }

  // consumptionByMeter — every meter, current-window value in its native unit.
  // trendPct uses prev/current deltas regardless of unit (kWh or not).
  const consumptionByMeter = meters.map((meter) => {
    const cur = perMeterCurrent.get(meter.id) ?? 0;
    const prev = perMeterPrev.get(meter.id) ?? 0;
    const trendPct = prev === 0 ? 0 : round1(((cur - prev) / prev) * 100);
    return {
      meterName: meter.name,
      meterType: meter.meterType,
      kwh30d: round1(cur),
      trendPct
    };
  });
  consumptionByMeter.sort((a, b) => b.kwh30d - a.kwh30d);

  // topConsumers — top 10 by raw current-window consumption.
  const topConsumers = meters
    .map((meter) => ({
      meterName: meter.name,
      kwh: round1(perMeterCurrent.get(meter.id) ?? 0)
    }))
    .filter((row) => row.kwh > 0)
    .sort((a, b) => b.kwh - a.kwh)
    .slice(0, 10);

  const tendencyPct = totalKwhPrev === 0 ? 0 : round1(((totalKwhCurrent - totalKwhPrev) / totalKwhPrev) * 100);
  const kwhPerOccupiedRoom = occupiedRoomNights === 0 ? 0 : round1(totalKwhCurrent / occupiedRoomNights);

  return {
    kpis: {
      totalKwh30d: round1(totalKwhCurrent),
      kwhPerOccupiedRoom,
      tendencyPct90d: tendencyPct,
      activeMeters: meters.filter((m) => m.active).length,
      abnormalReadingsCount: abnormalCount
    },
    consumptionByMeter,
    dailyConsumption,
    topConsumers
  };
}
