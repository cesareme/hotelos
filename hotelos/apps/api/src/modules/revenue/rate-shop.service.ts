// Rate shopper — REAL persistence into CompetitorHotel / CompetitorRateSnapshot.
//
// The shop "provider" is deterministic and HONEST about it: there is no live OTA
// scraper wired, so runRateShop derives competitor prices from our own published
// BAR plus a stable per-competitor offset, and labels every job + snapshot with
// source "deterministic". Swap in a real provider later without changing the API.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";

const MS_DAY = 86_400_000;
function dayUtc(v?: string): Date {
  const base = v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dec(v: Prisma.Decimal | number | null | undefined): number {
  return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function listCompetitors(propertyId: string) {
  return prisma.competitorHotel.findMany({ where: { propertyId }, orderBy: { createdAt: "asc" }, take: 100 });
}

export async function createCompetitor(input: { context: UserContext; propertyId: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const name = typeof input.payload.name === "string" ? input.payload.name.trim() : "";
  if (!name) throw new BadRequestError("name is required.");
  const row = await prisma.competitorHotel.create({
    data: {
      propertyId: input.propertyId,
      name,
      category: typeof input.payload.category === "string" ? input.payload.category : undefined,
      starRating: input.payload.starRating !== undefined ? Number(input.payload.starRating) : undefined,
      comparableScore: input.payload.comparableScore !== undefined ? Number(input.payload.comparableScore) : undefined,
      locationJson: (input.payload.location && typeof input.payload.location === "object" ? input.payload.location : {}) as Prisma.InputJsonValue,
      active: input.payload.active === undefined ? true : Boolean(input.payload.active)
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "COMPETITOR_HOTEL_CREATED",
    entityType: "competitor_hotel",
    entityId: row.id,
    afterJson: row as unknown as Prisma.InputJsonValue,
    correlationId: input.correlationId
  });
  return row;
}

export async function listCompetitorRates(input: { propertyId: string; from?: string; to?: string }) {
  const where: Prisma.CompetitorRateSnapshotWhereInput = { propertyId: input.propertyId };
  if (input.from || input.to) {
    where.stayDate = {};
    if (input.from) (where.stayDate as Prisma.DateTimeFilter).gte = dayUtc(input.from);
    if (input.to) (where.stayDate as Prisma.DateTimeFilter).lte = dayUtc(input.to);
  }
  const rows = await prisma.competitorRateSnapshot.findMany({ where, orderBy: [{ stayDate: "asc" }], take: 1000 });
  return rows.map((r) => ({
    id: r.id,
    competitorHotelId: r.competitorHotelId,
    sourceChannel: r.sourceChannel,
    shopDate: isoDate(r.shopDate),
    stayDate: isoDate(r.stayDate),
    price: dec(r.price),
    currency: r.currency,
    availabilityStatus: r.availabilityStatus
  }));
}

/**
 * Run a rate shop: for each active competitor × next N stay dates, derive a price
 * from our published BAR (rateDay min) and a stable per-competitor offset, then
 * upsert CompetitorRateSnapshot for today's shopDate. Records a RateShopJob.
 */
export async function runRateShop(input: { context: UserContext; propertyId: string; payload?: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.recommend"]);
  const daysAhead = Math.min(60, Math.max(1, Number(input.payload?.daysAhead ?? 30)));
  const shopDate = dayUtc();
  const to = addDays(shopDate, daysAhead - 1);

  const competitors = await prisma.competitorHotel.findMany({ where: { propertyId: input.propertyId, active: true } });
  // Our published min rate per day (the comparison anchor).
  const rateRows = await prisma.rateDay.findMany({
    where: { propertyId: input.propertyId, date: { gte: shopDate, lte: to } },
    select: { date: true, price: true }
  });
  const minRate = new Map<string, number>();
  for (const r of rateRows) {
    const k = isoDate(r.date);
    const p = dec(r.price);
    if (!minRate.has(k) || p < (minRate.get(k) as number)) minRate.set(k, p);
  }

  const data: Prisma.CompetitorRateSnapshotCreateManyInput[] = [];
  for (const comp of competitors) {
    // Stable per-competitor position: ±12% around our BAR, nudged by comparable score.
    const base = (hash(comp.id) % 25) - 12; // -12..+12 %
    const scoreAdj = comp.comparableScore ? (Number(comp.comparableScore) - 0.85) * 10 : 0;
    for (let i = 0; i < daysAhead; i++) {
      const stay = addDays(shopDate, i);
      const dow = stay.getUTCDay();
      const weekend = dow === 5 || dow === 6 ? 6 : 0;
      const anchor = minRate.get(isoDate(stay)) ?? 130;
      const pct = (base + scoreAdj + weekend) / 100;
      const price = round2(Math.max(40, anchor * (1 + pct)));
      data.push({
        propertyId: input.propertyId,
        competitorHotelId: comp.id,
        sourceChannel: "demo",
        shopDate,
        stayDate: stay,
        roomTypeLabel: "Doble estándar",
        ratePlanLabel: "BAR",
        price,
        currency: "EUR",
        availabilityStatus: "available",
        metadataJson: { source: "deterministic" } as Prisma.InputJsonValue
      });
    }
  }

  const snapshots = await prisma.$transaction(async (tx) => {
    await tx.competitorRateSnapshot.deleteMany({ where: { propertyId: input.propertyId, shopDate } });
    if (data.length === 0) return 0;
    const created = await tx.competitorRateSnapshot.createMany({ data });
    return created.count;
  });

  const job = await prisma.rateShopJob.create({
    data: {
      propertyId: input.propertyId,
      status: "completed",
      shopDate,
      daysAhead,
      competitors: competitors.length,
      snapshots,
      source: "deterministic",
      finishedAt: new Date()
    }
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "RATE_SHOP_RUN",
    entityType: "rate_shop_job",
    entityId: job.id,
    afterJson: { competitors: competitors.length, snapshots, daysAhead, source: "deterministic" },
    correlationId: input.correlationId
  });

  return { jobId: job.id, competitors: competitors.length, snapshots, daysAhead, shopDate: isoDate(shopDate), source: "deterministic" as const };
}

export async function listParityAlerts(propertyId: string) {
  const rows = await prisma.rateParityAlert.findMany({
    where: { propertyId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200
  });
  return rows.map((r) => ({
    id: r.id,
    alertType: r.alertType,
    severity: r.severity,
    stayDate: isoDate(r.stayDate),
    sourceChannel: r.sourceChannel,
    directRate: dec(r.directRate),
    channelRate: dec(r.channelRate),
    currency: r.currency,
    message: r.message,
    status: r.status
  }));
}
