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

const MS_DAY = 86_400_000;
const OTB_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
function dayUtc(v?: string): Date {
  const base = v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * MS_DAY); }
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function monthOf(d: Date): string { return isoDate(d).slice(0, 7); }
function dec(v: Prisma.Decimal | number | null | undefined): number { return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v); }
function num(v: unknown): number | undefined { if (v === null || v === undefined || v === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
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

/** Budget vs forecast vs actual for a month. Forecast from RevenueForecast; actual realized from reservations. */
export async function getBudgetVariance(input: { propertyId: string; month?: string }) {
  const month = input.month && /^\d{4}-\d{2}$/.test(input.month) ? input.month : monthOf(dayUtc());
  const from = dayUtc(`${month}-01`);
  const to = addDays(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)), -1);
  const today = dayUtc();

  const budget = await prisma.budget.findUnique({ where: { propertyId_periodMonth: { propertyId: input.propertyId, periodMonth: month } } });
  const totalRooms = await prisma.room.count({ where: { propertyId: input.propertyId, sellable: true } });

  // Forecast (sum room-type rows over the month).
  const forecasts = await listForecasts({ propertyId: input.propertyId, from: isoDate(from), to: isoDate(to) });
  const fcRooms = forecasts.reduce((s, f) => s + f.expectedRoomsSold, 0);
  const fcRevenue = forecasts.reduce((s, f) => s + f.expectedRoomRevenue, 0);

  // Actual realized (reservations OTB on past stay dates within the month).
  const reservations = await prisma.reservation.findMany({
    where: { propertyId: input.propertyId, status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] }, arrivalDate: { lt: addDays(to, 1) }, departureDate: { gt: from } },
    select: { arrivalDate: true, departureDate: true, roomsCount: true, totalAmount: true }
  });
  let actualRooms = 0;
  let actualRevenue = 0;
  for (const r of reservations) {
    const a = dayUtc(isoDate(r.arrivalDate));
    const d = dayUtc(isoDate(r.departureDate));
    const n = Math.max(1, Math.round((d.getTime() - a.getTime()) / MS_DAY));
    const revPerNight = dec(r.totalAmount) / n;
    for (let i = 0; i < n; i++) {
      const day = addDays(a, i);
      if (day < from || day > to || day >= today) continue; // realized = past only
      actualRooms += r.roomsCount;
      actualRevenue += revPerNight;
    }
  }

  const mk = (rooms: number, revenue: number, nights: number) => ({
    roomsSold: Math.round(rooms),
    roomRevenue: round2(revenue),
    adr: rooms > 0 ? round2(revenue / rooms) : 0,
    occupancyPct: totalRooms > 0 && nights > 0 ? round2((rooms / (totalRooms * nights)) * 100) : 0
  });
  const monthNights = Math.round((to.getTime() - from.getTime()) / MS_DAY) + 1;

  // Full-month projection = realized-to-date + forecast for the remaining days.
  const projRooms = actualRooms + fcRooms;
  const projRevenue = actualRevenue + fcRevenue;

  return {
    propertyId: input.propertyId,
    month,
    totalRooms,
    budget: budget
      ? { roomsSold: budget.budgetedRoomsSold ?? null, roomRevenue: dec(budget.budgetedRoomRevenue), adr: dec(budget.budgetedAdr), occupancyPct: dec(budget.budgetedOccupancy) }
      : null,
    forecast: mk(projRooms, projRevenue, monthNights),
    actual: mk(actualRooms, actualRevenue, monthNights),
    variance: budget ? { roomRevenueVsBudget: round2(projRevenue - dec(budget.budgetedRoomRevenue)) } : null,
    source: "forecast+reservations"
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

  // Forecast demand + ADR per night.
  const forecasts = await listForecasts({ propertyId: input.propertyId, from: isoDate(from), to: isoDate(addDays(to, -1)) });
  const fcByDay = new Map<string, { rooms: number; revenue: number }>();
  for (const f of forecasts) { const b = fcByDay.get(f.forecastDate) ?? { rooms: 0, revenue: 0 }; b.rooms += f.expectedRoomsSold; b.revenue += f.expectedRoomRevenue; fcByDay.set(f.forecastDate, b); }

  const nights: Array<{ date: string; available: number; displacedRooms: number; transientAdr: number; displacedRevenue: number; groupRevenue: number }> = [];
  let displacedRevenue = 0;
  let groupRevenue = 0;
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const key = isoDate(d);
    const used = otb.get(key) ?? 0;
    const available = Math.max(0, totalRooms - used);
    const fc = fcByDay.get(key);
    const transientAdr = fc && fc.rooms > 0 ? round2(fc.revenue / fc.rooms) : 130;
    // Rooms the group takes beyond free inventory displace forecast transient demand.
    const overCapacity = Math.max(0, groupRooms - available);
    const unmetForecast = fc ? Math.max(0, Math.round(fc.rooms) - used) : 0;
    const displacedRooms = Math.min(overCapacity, Math.max(unmetForecast, overCapacity));
    const dr = round2(displacedRooms * transientAdr);
    const gr = round2(groupRooms * groupRate);
    displacedRevenue += dr;
    groupRevenue += gr;
    nights.push({ date: key, available, displacedRooms, transientAdr, displacedRevenue: dr, groupRevenue: gr });
  }

  const net = round2(groupRevenue - displacedRevenue);
  const recommendation = net > 0 ? (displacedRevenue === 0 ? "accept" : "accept_with_caution") : "negotiate_or_decline";
  return {
    propertyId: input.propertyId,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    roomsPerNight: groupRooms,
    groupRate,
    totalRooms,
    groupRevenue: round2(groupRevenue),
    displacedRevenue: round2(displacedRevenue),
    netBenefit: net,
    recommendation,
    nights,
    source: "forecast+otb"
  };
}

// ---- Revenue meeting pack -------------------------------------------------
export async function getMeetingPack(propertyId: string) {
  const [pace, pickup, accuracy, recommendations, budgetVariance] = await Promise.all([
    getPace(propertyId),
    getPickup(propertyId),
    getForecastAccuracy({ propertyId, days: 30 }),
    listRecommendations(propertyId),
    getBudgetVariance({ propertyId })
  ]);

  const today = dayUtc();
  const compRows = await prisma.competitorRateSnapshot.findMany({
    where: { propertyId, stayDate: { gte: today, lte: addDays(today, 14) }, price: { not: null } },
    select: { price: true }
  });
  const compPrices = compRows.map((r) => dec(r.price)).filter((p) => p > 0);
  const compSet = { samples: compPrices.length, median: compPrices.length ? round2(median(compPrices)) : null, min: compPrices.length ? Math.min(...compPrices) : null, max: compPrices.length ? Math.max(...compPrices) : null };

  const pendingRecs = (recommendations.filter((r): r is NonNullable<typeof r> => !!r && r.status === "pending")).slice(0, 6);

  return {
    propertyId,
    generatedAt: new Date().toISOString(),
    pace,
    pickup,
    forecastAccuracy: accuracy.metrics,
    compSet,
    budgetVariance,
    topRecommendations: pendingRecs,
    source: "aggregate"
  };
}
