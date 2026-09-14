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
import { addDays, dayUtc, dec, getPublishedBar, isoDate, publishedBarFor, round2 } from "./actuals.js";

/**
 * Deterministic provider parameters (explicit and labelled: every snapshot it
 * writes carries metadata.source "deterministic"). They shape the synthetic
 * spread around OUR published BAR — they never produce a price without one.
 */
const PROVIDER = {
  /** Stable per-competitor position: hash(id) % (2·spread+1) − spread → −12..+12 %. */
  spreadPct: 12,
  /** Comparable score that maps to a 0 % adjustment; each 0.1 above/below moves ±1 %. */
  referenceComparableScore: 0.85,
  /** Fri/Sat premium (%). */
  weekendPremiumPct: 6,
  /** Floor for any derived competitor price (EUR). */
  minPrice: 40,
  maxDaysAhead: 60
} as const;
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
 * from our published BAR (BAR plan, lead rate) and a stable per-competitor
 * offset, then upsert CompetitorRateSnapshot for today's shopDate. Dates with
 * no published BAR are skipped (reported as `datesWithoutBar`) — the provider
 * never anchors on an invented rate. Records a RateShopJob.
 */
export async function runRateShop(input: { context: UserContext; propertyId: string; payload?: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.recommend"]);
  const daysAhead = Math.min(PROVIDER.maxDaysAhead, Math.max(1, Number(input.payload?.daysAhead ?? 30)));
  const shopDate = dayUtc();
  const to = addDays(shopDate, daysAhead - 1);

  const [competitors, publishedBar] = await Promise.all([
    prisma.competitorHotel.findMany({ where: { propertyId: input.propertyId, active: true } }),
    getPublishedBar(input.propertyId, shopDate, to)
  ]);

  const data: Prisma.CompetitorRateSnapshotCreateManyInput[] = [];
  const datesWithoutBar: string[] = [];
  let datesShopped = 0;
  for (let i = 0; i < daysAhead; i++) {
    const stay = addDays(shopDate, i);
    const stayKey = isoDate(stay);
    const anchor = publishedBarFor(publishedBar, stayKey);
    if (anchor === null) {
      datesWithoutBar.push(stayKey);
      continue;
    }
    datesShopped++;
    const dow = stay.getUTCDay();
    const weekend = dow === 5 || dow === 6 ? PROVIDER.weekendPremiumPct : 0;
    for (const comp of competitors) {
      // Stable per-competitor position around our BAR, nudged by comparable score.
      const base = (hash(comp.id) % (2 * PROVIDER.spreadPct + 1)) - PROVIDER.spreadPct;
      const scoreAdj = comp.comparableScore ? (Number(comp.comparableScore) - PROVIDER.referenceComparableScore) * 10 : 0;
      const pct = (base + scoreAdj + weekend) / 100;
      const price = round2(Math.max(PROVIDER.minPrice, anchor * (1 + pct)));
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
        metadataJson: { source: "deterministic", anchorBar: anchor, anchorSource: "rate_grid" } as Prisma.InputJsonValue
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
    afterJson: { competitors: competitors.length, snapshots, daysAhead, datesShopped, datesWithoutBar: datesWithoutBar.length, barSource: publishedBar.source, source: "deterministic" },
    correlationId: input.correlationId
  });

  return {
    jobId: job.id,
    competitors: competitors.length,
    snapshots,
    daysAhead,
    datesShopped,
    datesWithoutBar,
    barSource: publishedBar.source,
    shopDate: isoDate(shopDate),
    source: "deterministic" as const
  };
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
