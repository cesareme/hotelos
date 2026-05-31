// Pricing rules + BAR recommendation engine — REAL.
//
// Combines real OTB occupancy (from reservations) + published BAR (rateDay) +
// comp-set median (CompetitorRateSnapshot) + pricing rules to recommend a BAR per
// stay date, persisted to RevenueRecommendation. Approve/apply write back to
// RateDay. Rules-based and explainable (reasonJson carries the drivers).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";

const MS_DAY = 86_400_000;
const OTB_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
function dayUtc(v?: string): Date {
  const base = v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * MS_DAY); }
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function dec(v: Prisma.Decimal | number | null | undefined): number { return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v); }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function num(v: unknown): number | undefined { if (v === null || v === undefined || v === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function median(values: number[]): number { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// ---- Pricing rules CRUD ---------------------------------------------------
export function listPricingRules(propertyId: string) {
  // Hot-fix: cap defensively. A property rarely has more than 50 rules.
  return prisma.pricingRule.findMany({ where: { propertyId }, orderBy: { priority: "asc" }, take: 200 });
}
export async function createPricingRule(input: { context: UserContext; propertyId: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const name = typeof input.payload.name === "string" ? input.payload.name.trim() : "";
  if (!name) throw new BadRequestError("name is required.");
  const row = await prisma.pricingRule.create({
    data: {
      propertyId: input.propertyId,
      name,
      priority: num(input.payload.priority) ?? 100,
      minOccupancy: num(input.payload.minOccupancy),
      maxOccupancy: num(input.payload.maxOccupancy),
      adjustType: input.payload.adjustType === "amount" ? "amount" : "percent",
      adjustValue: num(input.payload.adjustValue) ?? 0,
      minPrice: num(input.payload.minPrice),
      maxPrice: num(input.payload.maxPrice),
      active: input.payload.active === undefined ? true : Boolean(input.payload.active)
    }
  });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user", action: "PRICING_RULE_CREATED", entityType: "pricing_rule", entityId: row.id, afterJson: row as unknown as Prisma.InputJsonValue, correlationId: input.correlationId });
  return row;
}
export async function updatePricingRule(input: { context: UserContext; id: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const data: Prisma.PricingRuleUpdateInput = {};
  const p = input.payload;
  if (p.name !== undefined) data.name = String(p.name);
  if (p.priority !== undefined) data.priority = num(p.priority);
  if (p.minOccupancy !== undefined) data.minOccupancy = num(p.minOccupancy);
  if (p.maxOccupancy !== undefined) data.maxOccupancy = num(p.maxOccupancy);
  if (p.adjustType !== undefined) data.adjustType = p.adjustType === "amount" ? "amount" : "percent";
  if (p.adjustValue !== undefined) data.adjustValue = num(p.adjustValue);
  if (p.minPrice !== undefined) data.minPrice = num(p.minPrice);
  if (p.maxPrice !== undefined) data.maxPrice = num(p.maxPrice);
  if (p.active !== undefined) data.active = Boolean(p.active);
  const row = await prisma.pricingRule.update({ where: { id: input.id }, data });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: row.propertyId, actorUserId: input.context.userId, actorType: "user", action: "PRICING_RULE_UPDATED", entityType: "pricing_rule", entityId: row.id, afterJson: row as unknown as Prisma.InputJsonValue, correlationId: input.correlationId });
  return row;
}

export function listBarLevels(propertyId: string) {
  // Hot-fix: cap defensively. A BAR ladder normally has 5–10 rungs.
  return prisma.barLevel.findMany({ where: { propertyId, active: true }, orderBy: { sortOrder: "asc" }, take: 100 });
}
export async function createBarLevel(input: { context: UserContext; propertyId: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["revenue.configure"]);
  const name = typeof input.payload.name === "string" ? input.payload.name.trim() : "";
  const price = num(input.payload.price);
  if (!name || price === undefined) throw new BadRequestError("name and price are required.");
  const row = await prisma.barLevel.create({ data: { propertyId: input.propertyId, name, price, sortOrder: num(input.payload.sortOrder) ?? 0 } });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user", action: "BAR_LEVEL_CREATED", entityType: "bar_level", entityId: row.id, afterJson: row as unknown as Prisma.InputJsonValue, correlationId: input.correlationId });
  return row;
}

// ---- Recommendation engine ------------------------------------------------
export async function generateRecommendations(input: { context: UserContext; propertyId: string; from?: string; to?: string; correlationId: string }) {
  requirePermissions(input.context, ["revenue.recommend"]);
  const propertyId = input.propertyId;
  const from = dayUtc(input.from);
  const days = Math.min(60, input.to ? Math.max(1, Math.round((dayUtc(input.to).getTime() - from.getTime()) / MS_DAY) + 1) : 30);
  const to = addDays(from, days - 1);

  const totalRooms = await prisma.room.count({ where: { propertyId, sellable: true } });
  if (totalRooms === 0) return { generated: 0, reason: "no_sellable_rooms" };

  // OTB rooms per stay date.
  const reservations = await prisma.reservation.findMany({
    where: { propertyId, status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] }, departureDate: { gt: from }, arrivalDate: { lt: addDays(to, 1) } },
    select: { arrivalDate: true, departureDate: true, roomsCount: true }
  });
  const otb = new Map<string, number>();
  for (const r of reservations) {
    const a = dayUtc(isoDate(r.arrivalDate));
    const d = dayUtc(isoDate(r.departureDate));
    const n = Math.max(1, Math.round((d.getTime() - a.getTime()) / MS_DAY));
    for (let i = 0; i < n; i++) {
      const day = addDays(a, i);
      if (day < from || day > to) continue;
      otb.set(isoDate(day), (otb.get(isoDate(day)) ?? 0) + r.roomsCount);
    }
  }

  // Current BAR (min rateDay) per day.
  const rateRows = await prisma.rateDay.findMany({ where: { propertyId, date: { gte: from, lte: to } }, select: { date: true, price: true } });
  const currentBar = new Map<string, number>();
  for (const r of rateRows) {
    const k = isoDate(r.date);
    const p = dec(r.price);
    if (!currentBar.has(k) || p < (currentBar.get(k) as number)) currentBar.set(k, p);
  }

  // Comp-set median per day from the latest shop.
  const compRows = await prisma.competitorRateSnapshot.findMany({ where: { propertyId, stayDate: { gte: from, lte: to }, price: { not: null } }, select: { stayDate: true, price: true } });
  const compByDay = new Map<string, number[]>();
  for (const r of compRows) { const k = isoDate(r.stayDate); const arr = compByDay.get(k) ?? []; arr.push(dec(r.price)); compByDay.set(k, arr); }

  const rules = await prisma.pricingRule.findMany({ where: { propertyId, active: true }, orderBy: { priority: "asc" } });

  const data: Prisma.RevenueRecommendationCreateManyInput[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const key = isoDate(date);
    const occ = totalRooms > 0 ? round2(((otb.get(key) ?? 0) / totalRooms) * 100) : 0;
    const baseBar = currentBar.get(key) ?? 130;
    const compMedian = compByDay.has(key) ? round2(median(compByDay.get(key) as number[])) : null;

    // First matching rule by occupancy band.
    const rule = rules.find((r) => {
      const lo = r.minOccupancy === null ? -Infinity : dec(r.minOccupancy);
      const hi = r.maxOccupancy === null ? Infinity : dec(r.maxOccupancy);
      return occ >= lo && occ <= hi;
    });

    let recommended = baseBar;
    const reasons: Array<{ driver: string; value: unknown }> = [{ driver: "occupancy_pct", value: occ }, { driver: "current_bar", value: baseBar }];
    if (compMedian !== null) reasons.push({ driver: "compset_median", value: compMedian });

    if (rule) {
      recommended = rule.adjustType === "amount" ? baseBar + dec(rule.adjustValue) : baseBar * (1 + dec(rule.adjustValue) / 100);
      if (rule.minPrice !== null) recommended = Math.max(recommended, dec(rule.minPrice));
      if (rule.maxPrice !== null) recommended = Math.min(recommended, dec(rule.maxPrice));
      reasons.push({ driver: "rule", value: rule.name });
    } else if (compMedian !== null) {
      // No rule: gently track comp-set (move 30% of the way toward median).
      recommended = baseBar + (compMedian - baseBar) * 0.3;
      reasons.push({ driver: "rule", value: "comp_set_tracking" });
    }

    // Snap to nearest BAR level if any.
    const levels = await prisma.barLevel.findMany({ where: { propertyId, active: true } });
    if (levels.length) {
      const nearest = levels.reduce((best, l) => (Math.abs(dec(l.price) - recommended) < Math.abs(dec(best.price) - recommended) ? l : best));
      recommended = dec(nearest.price);
      reasons.push({ driver: "snapped_to_level", value: nearest.name });
    }

    recommended = round2(Math.max(40, recommended));
    const deltaPct = baseBar > 0 ? Math.abs((recommended - baseBar) / baseBar) * 100 : 0;
    if (deltaPct < 1) continue; // no material change

    data.push({
      propertyId,
      recommendationType: "bar",
      targetDate: date,
      currentValueJson: { bar: baseBar, occupancyPct: occ, compsetMedian: compMedian } as Prisma.InputJsonValue,
      recommendedValueJson: { bar: recommended } as Prisma.InputJsonValue,
      expectedImpactJson: { direction: recommended > baseBar ? "up" : "down", deltaPct: round2((recommended - baseBar) / baseBar * 100) } as Prisma.InputJsonValue,
      reasonJson: reasons as unknown as Prisma.InputJsonValue,
      confidence: 60,
      riskLevel: deltaPct > 15 ? "high" : "medium",
      status: "pending"
    });
  }

  const generated = await prisma.$transaction(async (tx) => {
    await tx.revenueRecommendation.deleteMany({ where: { propertyId, recommendationType: "bar", status: "pending", targetDate: { gte: from, lte: to } } });
    if (data.length === 0) return 0;
    const created = await tx.revenueRecommendation.createMany({ data });
    return created.count;
  });

  recordAuditEvent({ organizationId: input.context.organizationId, propertyId, actorUserId: input.context.userId, actorType: "user", action: "REVENUE_RECOMMENDATIONS_GENERATED", entityType: "revenue_recommendation", entityId: propertyId, afterJson: { generated, from: isoDate(from), to: isoDate(to) }, correlationId: input.correlationId });
  return { generated };
}

function mapRecommendation(r: Awaited<ReturnType<typeof prisma.revenueRecommendation.findFirst>>) {
  if (!r) return null;
  return {
    id: r.id,
    recommendationType: r.recommendationType,
    targetDate: isoDate(r.targetDate),
    current: r.currentValueJson,
    recommended: r.recommendedValueJson,
    expectedImpact: r.expectedImpactJson,
    reasons: r.reasonJson,
    confidence: dec(r.confidence),
    riskLevel: r.riskLevel,
    status: r.status,
    appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null
  };
}

export async function listRecommendations(propertyId: string) {
  const rows = await prisma.revenueRecommendation.findMany({ where: { propertyId }, orderBy: [{ status: "asc" }, { targetDate: "asc" }], take: 400 });
  return rows.map(mapRecommendation);
}

export async function decideRecommendation(input: { context: UserContext; id: string; decision: "approved" | "rejected" | "applied"; correlationId: string }) {
  requirePermissions(input.context, ["revenue.apply_recommendations"]);
  const rec = await prisma.revenueRecommendation.findUnique({ where: { id: input.id } });
  if (!rec) throw new BadRequestError("Recommendation not found.");

  if (input.decision === "applied") {
    const recommended = num((rec.recommendedValueJson as { bar?: unknown })?.bar);
    if (recommended === undefined) throw new BadRequestError("Recommendation has no recommended BAR.");
    // Write the recommended BAR back to every rate day on the target date.
    await prisma.rateDay.updateMany({
      where: { propertyId: rec.propertyId, date: rec.targetDate },
      data: { price: recommended, manuallyOverridden: true, updatedBy: input.context.userId }
    });
    const updated = await prisma.revenueRecommendation.update({ where: { id: input.id }, data: { status: "applied", appliedAt: new Date(), approvedBy: input.context.userId } });
    recordAuditEvent({ organizationId: input.context.organizationId, propertyId: rec.propertyId, actorUserId: input.context.userId, actorType: "user", action: "REVENUE_RECOMMENDATION_APPLIED", entityType: "revenue_recommendation", entityId: rec.id, afterJson: { bar: recommended, targetDate: isoDate(rec.targetDate) }, correlationId: input.correlationId });
    return mapRecommendation(updated);
  }

  const updated = await prisma.revenueRecommendation.update({
    where: { id: input.id },
    data: input.decision === "approved" ? { status: "approved", approvedBy: input.context.userId } : { status: "rejected", rejectedBy: input.context.userId }
  });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: rec.propertyId, actorUserId: input.context.userId, actorType: "user", action: input.decision === "approved" ? "REVENUE_RECOMMENDATION_APPROVED" : "REVENUE_RECOMMENDATION_REJECTED", entityType: "revenue_recommendation", entityId: rec.id, afterJson: { status: updated.status }, correlationId: input.correlationId });
  return mapRecommendation(updated);
}
