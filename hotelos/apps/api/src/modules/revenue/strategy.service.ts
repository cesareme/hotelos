// Fase D — Strategy: budget (vs forecast vs actual), market segments, group
// displacement analysis, and the revenue meeting pack. All REAL (Prisma + the
// pace/forecast/pricing services), rules-based and explainable.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";
import { getPace, getPickup } from "./pace.service.js";
import { getForecastAccuracy, listForecasts } from "./forecast.service.js";
import { listRecommendations } from "./pricing.service.js";
import {
  addDays,
  dayUtc,
  dec,
  decOrNull,
  getPublishedBar,
  getRealizedByDay,
  isoDate,
  MS_DAY,
  parseMonth,
  publishedBarFor,
  round2,
  sumRealized,
  type RealizedSourceLabel
} from "./actuals.js";

/** Live on-the-books statuses for today/future stay dates (displacement). */
const OTB_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
function monthOf(d: Date): string { return isoDate(d).slice(0, 7); }
function num(v: unknown): number | undefined { if (v === null || v === undefined || v === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function median(values: number[]): number { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// ---- Budget ---------------------------------------------------------------
export function listBudgets(propertyId: string) {
  return prisma.budget.findMany({ where: { propertyId }, orderBy: { periodMonth: "desc" }, take: 36 });
}
export async function upsertBudget(input: { context: UserContext; propertyId: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const periodMonth = typeof input.payload.periodMonth === "string" && /^\d{4}-\d{2}$/.test(input.payload.periodMonth) ? input.payload.periodMonth : "";
  if (!periodMonth) throw new BadRequestError("periodMonth (YYYY-MM) is required.");
  const data = {
    budgetedRoomsSold: num(input.payload.budgetedRoomsSold) ?? null,
    budgetedOccupancy: num(input.payload.budgetedOccupancy) ?? null,
    budgetedAdr: num(input.payload.budgetedAdr) ?? null,
    budgetedRoomRevenue: num(input.payload.budgetedRoomRevenue) ?? null
  };
  const row = await prisma.budget.upsert({
    where: { propertyId_periodMonth: { propertyId: input.propertyId, periodMonth } },
    create: { propertyId: input.propertyId, periodMonth, ...data },
    update: data
  });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user", action: "BUDGET_UPSERTED", entityType: "budget", entityId: row.id, afterJson: row as unknown as Prisma.InputJsonValue, correlationId: input.correlationId });
  return row;
}

export type BudgetVarianceBlock = {
  roomsSold: number;
  /** null when the forecast rows for the remaining days carry no ADR (no BAR, no LY close). */
  roomRevenue: number | null;
  adr: number | null;
  occupancyPct: number | null;
};

export type BudgetVariance = {
  propertyId: string;
  month: string;
  totalRooms: number;
  monthNights: number;
  /** Past days of the month (snapshot or reservations fallback). */
  realizedDays: number;
  snapshotDays: number;
  fallbackDays: number;
  /** Days from max(from, today) to month end (0 once the month is closed). */
  remainingDays: number;
  /** Distinct remaining days that have a RevenueForecast row. */
  forecastDays: number;
  forecastDaysWithoutAdr: number;
  monthClosed: boolean;
  budget: { roomsSold: number | null; roomRevenue: number | null; adr: number | null; occupancyPct: number | null } | null;
  /** Full-month projection = realized-to-date + forecast for the REMAINING days; null in a closed month or without forecast rows. */
  forecast: BudgetVarianceBlock | null;
  /** Realized-to-date (occupancy over the realized days, not the whole month). */
  actual: BudgetVarianceBlock;
  variance: { roomRevenueVsBudget: number | null; basis: "forecast" | "actual" } | null;
  sources: { actual: RealizedSourceLabel | null; forecast: string | null };
};

/**
 * Budget vs forecast vs actual for a month (REV-03).
 *   actual   → getRealizedByDay (audited snapshots first, reservations fallback, past days only)
 *   forecast → RevenueForecast rows from max(from, today) only, so realized days
 *              are never double counted; null in a closed month.
 */
export async function getBudgetVariance(input: { propertyId: string; month?: string; today?: Date }): Promise<BudgetVariance> {
  const today = dayUtc(input.today);
  // Explicit month → strict YYYY-MM (400 on '2024-13' / '2024-00', never a
  // silent fallback nor an Invalid Date reaching Prisma); absent → current month.
  const month = input.month || monthOf(today);
  const { from, to } = parseMonth(month);
  const monthNights = Math.round((to.getTime() - from.getTime()) / MS_DAY) + 1;
  const monthClosed = to.getTime() < today.getTime();

  const [budget, totalRooms] = await Promise.all([
    prisma.budget.findUnique({ where: { propertyId_periodMonth: { propertyId: input.propertyId, periodMonth: month } } }),
    prisma.room.count({ where: { propertyId: input.propertyId, sellable: true } })
  ]);

  // Actual realized: shared helper (snapshot-first, reservations fallback, < today).
  const realized = await getRealizedByDay(input.propertyId, from, to, { today, totalRooms });
  const actualSum = sumRealized(realized);

  // Forecast: ONLY the remaining days [max(from, today), to]. Closed month → none.
  const fcFrom = today.getTime() > from.getTime() ? today : from;
  const remainingDays = monthClosed ? 0 : Math.round((to.getTime() - fcFrom.getTime()) / MS_DAY) + 1;
  const forecasts = monthClosed ? [] : await listForecasts({ propertyId: input.propertyId, from: isoDate(fcFrom), to: isoDate(to) });
  const fcDates = new Set<string>();
  const fcDatesWithoutAdr = new Set<string>();
  let fcRooms = 0;
  let fcRevenue = 0;
  for (const f of forecasts) {
    fcDates.add(f.forecastDate);
    fcRooms += f.expectedRoomsSold;
    if (f.expectedRoomRevenue === null) fcDatesWithoutAdr.add(f.forecastDate);
    else fcRevenue += f.expectedRoomRevenue;
  }
  const forecastModelVersion = forecasts.find((f) => f.modelVersion)?.modelVersion ?? null;
  const hasForecast = fcDates.size > 0;
  const forecastRevenueKnown = hasForecast && fcDatesWithoutAdr.size === 0;

  const mk = (rooms: number, revenue: number | null, nights: number): BudgetVarianceBlock => ({
    roomsSold: Math.round(rooms),
    roomRevenue: revenue === null ? null : round2(revenue),
    adr: revenue !== null && rooms > 0 ? round2(revenue / rooms) : null,
    occupancyPct: totalRooms > 0 && nights > 0 ? round2((rooms / (totalRooms * nights)) * 100) : null
  });

  const actual = mk(actualSum.rooms, actualSum.roomRevenue, actualSum.days);
  const forecast = hasForecast
    ? mk(actualSum.rooms + fcRooms, forecastRevenueKnown ? actualSum.roomRevenue + fcRevenue : null, monthNights)
    : null;

  const budgetRevenue = budget ? decOrNull(budget.budgetedRoomRevenue) : null;
  const basis: "forecast" | "actual" = forecast && forecast.roomRevenue !== null ? "forecast" : "actual";
  const basisRevenue = basis === "forecast" ? (forecast as BudgetVarianceBlock).roomRevenue : actual.roomRevenue;

  return {
    propertyId: input.propertyId,
    month,
    totalRooms,
    monthNights,
    realizedDays: actualSum.days,
    snapshotDays: realized.snapshotDays,
    fallbackDays: realized.fallbackDays,
    remainingDays,
    forecastDays: fcDates.size,
    forecastDaysWithoutAdr: fcDatesWithoutAdr.size,
    monthClosed,
    budget: budget
      ? {
          roomsSold: budget.budgetedRoomsSold ?? null,
          roomRevenue: budgetRevenue,
          adr: decOrNull(budget.budgetedAdr),
          occupancyPct: decOrNull(budget.budgetedOccupancy)
        }
      : null,
    forecast,
    actual,
    variance: budget
      ? {
          roomRevenueVsBudget: budgetRevenue !== null && basisRevenue !== null ? round2(basisRevenue - budgetRevenue) : null,
          basis
        }
      : null,
    sources: { actual: realized.source, forecast: hasForecast ? forecastModelVersion : null }
  };
}

// ---- Market segments ------------------------------------------------------
export function listMarketSegments(propertyId: string) {
  // Hot-fix: cap defensively. Real properties have <50 segments; 200 is plenty.
  return prisma.marketSegment.findMany({ where: { propertyId }, orderBy: { sortOrder: "asc" }, take: 200 });
}
export async function createMarketSegment(input: { context: UserContext; propertyId: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const code = typeof input.payload.code === "string" ? input.payload.code.trim() : "";
  const name = typeof input.payload.name === "string" ? input.payload.name.trim() : "";
  if (!code || !name) throw new BadRequestError("code and name are required.");
  const row = await prisma.marketSegment.create({
    data: { propertyId: input.propertyId, code, name, category: typeof input.payload.category === "string" ? input.payload.category : undefined, sortOrder: num(input.payload.sortOrder) ?? 0 }
  });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user", action: "MARKET_SEGMENT_CREATED", entityType: "market_segment", entityId: row.id, afterJson: row as unknown as Prisma.InputJsonValue, correlationId: input.correlationId });
  return row;
}
/** Seed the catalog from distinct reservation market segments (idempotent). */
export async function seedMarketSegments(input: { context: UserContext; propertyId: string; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const rows = await prisma.reservation.groupBy({ by: ["marketSegment"], where: { propertyId: input.propertyId } });
  const codes = rows.map((r) => r.marketSegment).filter((s): s is string => !!s && s.trim().length > 0);
  let created = 0;
  for (const code of codes) {
    const existing = await prisma.marketSegment.findUnique({ where: { propertyId_code: { propertyId: input.propertyId, code } } });
    if (existing) continue;
    await prisma.marketSegment.create({ data: { propertyId: input.propertyId, code, name: code.charAt(0).toUpperCase() + code.slice(1), category: "transient" } });
    created++;
  }
  return { propertyId: input.propertyId, created, found: codes.length };
}

// ---- Group displacement analysis ------------------------------------------
export async function analyzeDisplacement(input: { propertyId: string; arrivalDate: string; departureDate: string; roomsPerNight: number; groupRate: number }) {
  const from = dayUtc(input.arrivalDate);
  const to = dayUtc(input.departureDate);
  if (!(to.getTime() > from.getTime())) throw new BadRequestError("departureDate must be after arrivalDate.");
  const groupRooms = Math.max(1, Math.round(input.roomsPerNight));
  const groupRate = input.groupRate;
  if (!Number.isFinite(groupRate) || groupRate <= 0) throw new BadRequestError("groupRate must be a positive number.");

  const totalRooms = await prisma.room.count({ where: { propertyId: input.propertyId, sellable: true } });

  // Current OTB rooms per night (transient + existing groups).
  const reservations = await prisma.reservation.findMany({
    where: { propertyId: input.propertyId, status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] }, departureDate: { gt: from }, arrivalDate: { lt: to } },
    select: { arrivalDate: true, departureDate: true, roomsCount: true }
  });
  const otb = new Map<string, number>();
  for (const r of reservations) {
    const a = dayUtc(isoDate(r.arrivalDate));
    const d = dayUtc(isoDate(r.departureDate));
    const n = Math.max(1, Math.round((d.getTime() - a.getTime()) / MS_DAY));
    for (let i = 0; i < n; i++) { const day = addDays(a, i); if (day < from || day >= to) continue; otb.set(isoDate(day), (otb.get(isoDate(day)) ?? 0) + r.roomsCount); }
  }

  // Forecast demand + ADR per night, and the published BAR as the ADR fallback.
  const lastNight = addDays(to, -1);
  const [forecasts, publishedBar] = await Promise.all([
    listForecasts({ propertyId: input.propertyId, from: isoDate(from), to: isoDate(lastNight) }),
    getPublishedBar(input.propertyId, from, lastNight)
  ]);
  const fcByDay = new Map<string, { rooms: number; revenue: number; revenueKnown: boolean }>();
  for (const f of forecasts) {
    const b = fcByDay.get(f.forecastDate) ?? { rooms: 0, revenue: 0, revenueKnown: true };
    b.rooms += f.expectedRoomsSold;
    if (f.expectedRoomRevenue === null) b.revenueKnown = false;
    else b.revenue += f.expectedRoomRevenue;
    fcByDay.set(f.forecastDate, b);
  }

  type DisplacementNight = {
    date: string;
    available: number;
    displacedRooms: number;
    /** Transient ADR the displaced rooms would have earned; null when neither forecast nor BAR exists. */
    transientAdr: number | null;
    adrSource: "forecast" | "bar" | "unknown";
    /** null when the night has displaced rooms but no ADR (excluded from the total, see warnings). */
    displacedRevenue: number | null;
    groupRevenue: number;
  };
  const nights: DisplacementNight[] = [];
  const warnings: string[] = [];
  let displacedRevenue = 0;
  let groupRevenue = 0;
  let nightsWithoutAdr = 0;
  let unreliable = false;
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const key = isoDate(d);
    const used = otb.get(key) ?? 0;
    const available = Math.max(0, totalRooms - used);
    const fc = fcByDay.get(key);
    // ADR chain: forecast ADR → published BAR → null (never a constant).
    let transientAdr: number | null = null;
    let adrSource: DisplacementNight["adrSource"] = "unknown";
    if (fc && fc.rooms > 0 && fc.revenueKnown) {
      transientAdr = round2(fc.revenue / fc.rooms);
      adrSource = "forecast";
    } else {
      const bar = publishedBarFor(publishedBar, key);
      if (bar !== null) {
        transientAdr = bar;
        adrSource = "bar";
      }
    }
    // Rooms the group takes beyond free inventory displace forecast transient demand.
    const overCapacity = Math.max(0, groupRooms - available);
    const unmetForecast = fc ? Math.max(0, Math.round(fc.rooms) - used) : 0;
    const displacedRooms = Math.min(overCapacity, Math.max(unmetForecast, overCapacity));
    const gr = round2(groupRooms * groupRate);
    groupRevenue += gr;
    let dr: number | null;
    if (transientAdr !== null) {
      dr = round2(displacedRooms * transientAdr);
      displacedRevenue += dr;
    } else if (displacedRooms === 0) {
      dr = 0; // nothing displaced: the ADR is irrelevant for this night
    } else {
      dr = null;
      nightsWithoutAdr++;
      unreliable = true;
      warnings.push(`${key}: sin previsión ni BAR publicado; ${displacedRooms} hab. desplazadas excluidas del cálculo.`);
    }
    nights.push({ date: key, available, displacedRooms, transientAdr, adrSource, displacedRevenue: dr, groupRevenue: gr });
  }

  const net = round2(groupRevenue - displacedRevenue);
  const recommendation: "accept" | "accept_with_caution" | "negotiate_or_decline" | "insufficient_data" = unreliable
    ? "insufficient_data"
    : net > 0
      ? displacedRevenue === 0
        ? "accept"
        : "accept_with_caution"
      : "negotiate_or_decline";
  return {
    propertyId: input.propertyId,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    roomsPerNight: groupRooms,
    groupRate,
    totalRooms,
    groupRevenue: round2(groupRevenue),
    /** Sum over nights with a known ADR only (see nightsWithoutAdr / warnings). */
    displacedRevenue: round2(displacedRevenue),
    netBenefit: net,
    recommendation,
    nights,
    nightsWithoutAdr,
    warnings,
    sources: { otb: "reservas", adr: "forecast → BAR publicado → sin dato", bar: publishedBar.source },
    source: "forecast+bar+otb"
  };
}

// ---- Revenue meeting pack -------------------------------------------------
/**
 * Meeting pack. `month` (YYYY-MM, optional) selects the budget-variance month
 * (defaults to the current month). Pending recommendations are limited to
 * today/future target dates — the same rule as the board's criticalDates.
 */
export async function getMeetingPack(propertyId: string, opts: { month?: string } = {}) {
  const today = dayUtc();
  const todayKey = isoDate(today);
  // Resolve + validate the month up front (400 on '2024-13') so a bad query
  // fails before the pace/pickup/forecast queries are fanned out.
  const month = opts.month || monthOf(today);
  parseMonth(month);
  const [pace, pickup, accuracy, recommendations, budgetVariance] = await Promise.all([
    getPace(propertyId),
    getPickup(propertyId),
    getForecastAccuracy({ propertyId, days: 30 }),
    listRecommendations(propertyId),
    getBudgetVariance({ propertyId, month, today })
  ]);
  const compRows = await prisma.competitorRateSnapshot.findMany({
    where: { propertyId, stayDate: { gte: today, lte: addDays(today, 14) }, price: { not: null } },
    select: { price: true }
  });
  const compPrices = compRows.map((r) => dec(r.price)).filter((p) => p > 0);
  const compSet = { samples: compPrices.length, median: compPrices.length ? round2(median(compPrices)) : null, min: compPrices.length ? Math.min(...compPrices) : null, max: compPrices.length ? Math.max(...compPrices) : null };

  // Pending + actionable (targetDate >= today); past pendings are stale, not "top".
  const pendingRecs = recommendations
    .filter((r): r is NonNullable<typeof r> => !!r && r.status === "pending" && r.targetDate >= todayKey)
    .slice(0, 6);

  return {
    propertyId,
    /** Budget/variance month of this pack (YYYY-MM; the export title reflects it). */
    month,
    generatedAt: new Date().toISOString(),
    pace,
    pickup,
    forecastAccuracy: accuracy.metrics,
    forecastAccuracySources: accuracy.sources,
    compSet,
    budgetVariance,
    topRecommendations: pendingRecs,
    source: "aggregate"
  };
}
