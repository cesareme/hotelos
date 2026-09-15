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
import {
  addDays,
  dayUtc,
  dec,
  getPublishedBar,
  isoDate,
  leadRoomTypeIdsFor,
  MS_DAY,
  publishedBarFor,
  resolveBarRatePlan,
  round2
} from "./actuals.js";

const OTB_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
/** Engine parameters (explicit, explainable — surfaced in reasonJson, never hidden literals). */
const ENGINE = {
  /** Without a matching rule, move this share of the way toward the comp-set median. */
  compsetTrackingWeight: 0.3,
  /** Hard floor for any recommended BAR (EUR). */
  minRecommendedBar: 40,
  /** Changes below this |Δ%| are not worth a recommendation. */
  materialDeltaPct: 1,
  /** |Δ%| above this is flagged riskLevel "high". */
  highRiskDeltaPct: 15,
  /** Rules-based engine: fixed confidence (there is no probabilistic model behind it). */
  confidence: 60,
  /** Max window per generation run (days). */
  maxDays: 60
} as const;
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

// ---- Comp-set median (shared by the BAR engine, the rate-grid RMS and the board) ----
export type CompsetDay = {
  median: number;
  /** "real" = shopped from a live provider; "deterministic" = synthetic spread around our own BAR (rate-shop.service). */
  source: "real" | "deterministic";
  /** Shop date the median comes from (latest shop that covers the stay date). */
  shopDate: string;
  samples: number;
};

export type CompsetWindow = {
  byDate: Map<string, CompsetDay>;
  activeCompetitors: number;
  /** Aggregate provenance: "deterministic" when every day is synthetic, "real" otherwise; null when no data. */
  source: "real" | "deterministic" | null;
};

/**
 * Comp-set median per stay date in [from, to] using ONLY active competitors
 * and, for each stay date, ONLY the snapshots of the LATEST shopDate that
 * covers it (older shops of the same night are stale and must not dilute the
 * median). Provenance is read from `metadataJson.source`: the deterministic
 * provider labels every row it writes; anything else counts as real.
 * Days with no shop are simply absent → consumers treat them as "sin compset".
 */
export async function compsetMedianByDate(propertyId: string, from: Date | string, to: Date | string): Promise<CompsetWindow> {
  const start = dayUtc(from);
  const end = dayUtc(to);
  const empty: CompsetWindow = { byDate: new Map(), activeCompetitors: 0, source: null };
  if (start.getTime() > end.getTime()) return empty;
  const competitors = await prisma.competitorHotel.findMany({ where: { propertyId, active: true }, select: { id: true }, take: 100 });
  if (competitors.length === 0) return empty;
  const rows = await prisma.competitorRateSnapshot.findMany({
    where: { propertyId, competitorHotelId: { in: competitors.map((c) => c.id) }, stayDate: { gte: start, lte: end }, price: { not: null } },
    select: { stayDate: true, shopDate: true, price: true, metadataJson: true },
    orderBy: [{ stayDate: "asc" }, { shopDate: "desc" }],
    take: 20000
  });
  const acc = new Map<string, { shopDate: string; prices: number[]; deterministic: number }>();
  for (const r of rows) {
    const price = dec(r.price);
    if (price <= 0) continue;
    const key = isoDate(r.stayDate);
    const shop = isoDate(r.shopDate);
    let a = acc.get(key);
    if (!a || shop > a.shopDate) {
      a = { shopDate: shop, prices: [], deterministic: 0 };
      acc.set(key, a);
    } else if (shop < a.shopDate) {
      continue; // older shop of a night already covered by a newer one
    }
    a.prices.push(price);
    const meta = r.metadataJson && typeof r.metadataJson === "object" && !Array.isArray(r.metadataJson) ? (r.metadataJson as Record<string, unknown>) : {};
    if (meta.source === "deterministic") a.deterministic++;
  }
  const byDate = new Map<string, CompsetDay>();
  let realDays = 0;
  for (const [key, a] of acc) {
    if (!a.prices.length) continue;
    const source = a.deterministic === a.prices.length ? "deterministic" : "real";
    if (source === "real") realDays++;
    byDate.set(key, { median: round2(median(a.prices)), source, shopDate: a.shopDate, samples: a.prices.length });
  }
  return { byDate, activeCompetitors: competitors.length, source: byDate.size === 0 ? null : realDays > 0 ? "real" : "deterministic" };
}

// ---- Recommendation engine ------------------------------------------------
export type GenerateRecommendationsResult = {
  generated: number;
  /** Days in the window with no published BAR → no recommendation row (never a default price). */
  skippedNoBar: number;
  /** Days whose recommended BAR differs from the current one by less than the material threshold. */
  skippedNoChange: number;
  /** Stale pending rows (targetDate < today) removed in the same transaction. */
  purgedPast: number;
  from: string;
  to: string;
  barSource: "rate_grid" | "no_bar_plan" | "no_sellable_room_types" | "no_rate_days";
  reason?: "no_sellable_rooms" | "no_published_bar" | "no_material_change";
};

/**
 * BAR recommendations per stay date (REV-04). `current.bar` is the published
 * BAR of the BAR plan (lead rate across sellable room types); days without a
 * published BAR are skipped and counted in `skippedNoBar`. The window starts
 * at max(from, today): recommendations for the past are meaningless, and
 * stale pending rows in the past are purged.
 */
export async function generateRecommendations(input: { context: UserContext; propertyId: string; from?: string; to?: string; correlationId: string }): Promise<GenerateRecommendationsResult> {
  requirePermissions(input.context, ["revenue.recommend"]);
  const propertyId = input.propertyId;
  const today = dayUtc();
  const requestedFrom = dayUtc(input.from);
  const from = requestedFrom.getTime() < today.getTime() ? today : requestedFrom;
  if (input.to && dayUtc(input.to).getTime() < today.getTime()) {
    throw new BadRequestError("No se pueden generar recomendaciones para fechas pasadas.");
  }
  const days = Math.min(ENGINE.maxDays, input.to ? Math.max(1, Math.round((dayUtc(input.to).getTime() - from.getTime()) / MS_DAY) + 1) : 30);
  const to = addDays(from, days - 1);

  const totalRooms = await prisma.room.count({ where: { propertyId, sellable: true } });
  const base = { skippedNoBar: 0, skippedNoChange: 0, purgedPast: 0, from: isoDate(from), to: isoDate(to) };
  if (totalRooms === 0) return { generated: 0, ...base, barSource: "no_sellable_room_types", reason: "no_sellable_rooms" };

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

  // Current BAR per day: published BAR of the BAR plan (lead rate), never a default.
  const publishedBar = await getPublishedBar(propertyId, from, to);

  // Comp-set median per day: active competitors, latest shop per stay date (shared resolver).
  const compset = await compsetMedianByDate(propertyId, from, to);

  // Rules + BAR ladder: loaded once for the whole window (no per-day queries).
  const [rules, levels] = await Promise.all([
    prisma.pricingRule.findMany({ where: { propertyId, active: true }, orderBy: { priority: "asc" } }),
    prisma.barLevel.findMany({ where: { propertyId, active: true } })
  ]);

  let skippedNoBar = 0;
  let skippedNoChange = 0;
  const data: Prisma.RevenueRecommendationCreateManyInput[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const key = isoDate(date);
    const occ = totalRooms > 0 ? round2(((otb.get(key) ?? 0) / totalRooms) * 100) : 0;
    const baseBar = publishedBarFor(publishedBar, key);
    if (baseBar === null) {
      skippedNoBar++;
      continue; // no published BAR → nothing to recommend against
    }
    const compDay = compset.byDate.get(key);
    const compMedian = compDay ? compDay.median : null;

    // First matching rule by occupancy band.
    const rule = rules.find((r) => {
      const lo = r.minOccupancy === null ? -Infinity : dec(r.minOccupancy);
      const hi = r.maxOccupancy === null ? Infinity : dec(r.maxOccupancy);
      return occ >= lo && occ <= hi;
    });

    let recommended = baseBar;
    const reasons: Array<{ driver: string; value: unknown }> = [
      { driver: "occupancy_pct", value: occ },
      { driver: "current_bar", value: baseBar },
      { driver: "current_bar_source", value: "rate_grid" }
    ];
    if (compDay) reasons.push({ driver: "compset_median", value: compDay.median }, { driver: "compset_source", value: compDay.source }, { driver: "compset_shop_date", value: compDay.shopDate });

    if (rule) {
      recommended = rule.adjustType === "amount" ? baseBar + dec(rule.adjustValue) : baseBar * (1 + dec(rule.adjustValue) / 100);
      if (rule.minPrice !== null) recommended = Math.max(recommended, dec(rule.minPrice));
      if (rule.maxPrice !== null) recommended = Math.min(recommended, dec(rule.maxPrice));
      reasons.push({ driver: "rule", value: rule.name });
    } else if (compMedian !== null) {
      // No rule: gently track the comp-set (move a fixed share of the way toward the median).
      recommended = baseBar + (compMedian - baseBar) * ENGINE.compsetTrackingWeight;
      reasons.push({ driver: "rule", value: "comp_set_tracking" }, { driver: "compset_tracking_weight", value: ENGINE.compsetTrackingWeight });
    }

    // Snap to nearest BAR level if any.
    if (levels.length) {
      const nearest = levels.reduce((best, l) => (Math.abs(dec(l.price) - recommended) < Math.abs(dec(best.price) - recommended) ? l : best));
      recommended = dec(nearest.price);
      reasons.push({ driver: "snapped_to_level", value: nearest.name });
    }

    recommended = round2(Math.max(ENGINE.minRecommendedBar, recommended));
    const deltaPct = baseBar > 0 ? Math.abs((recommended - baseBar) / baseBar) * 100 : 0;
    if (deltaPct < ENGINE.materialDeltaPct) {
      skippedNoChange++;
      continue; // no material change
    }

    data.push({
      propertyId,
      recommendationType: "bar",
      targetDate: date,
      ratePlanId: publishedBar.ratePlan?.id ?? null,
      currentValueJson: { bar: baseBar, barSource: "rate_grid", ratePlanId: publishedBar.ratePlan?.id ?? null, occupancyPct: occ, compsetMedian: compMedian } as Prisma.InputJsonValue,
      recommendedValueJson: { bar: recommended } as Prisma.InputJsonValue,
      expectedImpactJson: { direction: recommended > baseBar ? "up" : "down", deltaPct: round2((recommended - baseBar) / baseBar * 100) } as Prisma.InputJsonValue,
      reasonJson: reasons as unknown as Prisma.InputJsonValue,
      confidence: ENGINE.confidence,
      riskLevel: deltaPct > ENGINE.highRiskDeltaPct ? "high" : "medium",
      status: "pending"
    });
  }

  const { generated, purgedPast } = await prisma.$transaction(async (tx) => {
    // Stale pendings (past target dates) can never be acted upon: purge them.
    const purged = await tx.revenueRecommendation.deleteMany({ where: { propertyId, recommendationType: "bar", status: "pending", targetDate: { lt: today } } });
    await tx.revenueRecommendation.deleteMany({ where: { propertyId, recommendationType: "bar", status: "pending", targetDate: { gte: from, lte: to } } });
    if (data.length === 0) return { generated: 0, purgedPast: purged.count };
    const created = await tx.revenueRecommendation.createMany({ data });
    return { generated: created.count, purgedPast: purged.count };
  });

  const reason: GenerateRecommendationsResult["reason"] =
    generated > 0 ? undefined : skippedNoBar > 0 && skippedNoChange === 0 ? "no_published_bar" : skippedNoChange > 0 ? "no_material_change" : "no_published_bar";
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId, actorUserId: input.context.userId, actorType: "user", action: "REVENUE_RECOMMENDATIONS_GENERATED", entityType: "revenue_recommendation", entityId: propertyId, afterJson: { generated, skippedNoBar, skippedNoChange, purgedPast, from: isoDate(from), to: isoDate(to), barSource: publishedBar.source }, correlationId: input.correlationId });
  return { generated, skippedNoBar, skippedNoChange, purgedPast, from: isoDate(from), to: isoDate(to), barSource: publishedBar.source, ...(reason ? { reason } : {}) };
}

/**
 * `current.bar` solo se expone cuando la fila registra su procedencia
 * (`barSource: "rate_grid"`). La escriben dos motores con claves distintas:
 * este (`bar`, recomendaciones de BAR por día) y el RMS de la parrilla
 * (`price`, recommendations.routes apply: filas `recommendationType
 * "rate_grid"` con `currentValueJson.price`). Sin leer `price`, «Reglas y
 * recomendaciones de BAR» pintaba «sin tarifario» para toda decisión tomada
 * desde el editor (browser-ux#11). Filas antiguas sin procedencia → bar null,
 * barSource "unknown". Exportada para el test unitario.
 */
export function mapCurrentValue(json: unknown): Record<string, unknown> & { bar: number | null; barSource: string } {
  const current = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const barSource = typeof current.barSource === "string" ? current.barSource : "unknown";
  const bar = barSource === "rate_grid" ? num(current.bar) ?? num(current.price) ?? null : null;
  return { ...current, bar, barSource };
}

/**
 * Misma lectura para `recommended.bar`: el RMS de la parrilla guarda
 * `appliedPrice` (lo publicado) y `price` (la sugerencia del motor); la pantalla
 * de BAR muestra `bar`, así que se deriva de ellos solo cuando la fila viene de
 * la parrilla (`barSource "rate_grid"`); el resto del JSON se devuelve tal cual.
 * Sin `bar` derivable → null explícito (la UI pinta «—»).
 */
export function mapRecommendedValue(json: unknown, barSource: string): Record<string, unknown> & { bar: number | null } {
  const recommended = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const own = num(recommended.bar);
  const fromGrid = barSource === "rate_grid" ? num(recommended.appliedPrice) ?? num(recommended.price) : undefined;
  return { ...recommended, bar: own ?? fromGrid ?? null };
}

function mapRecommendation(r: Awaited<ReturnType<typeof prisma.revenueRecommendation.findFirst>>) {
  if (!r) return null;
  const current = mapCurrentValue(r.currentValueJson);
  return {
    id: r.id,
    recommendationType: r.recommendationType,
    targetDate: isoDate(r.targetDate),
    current,
    recommended: mapRecommendedValue(r.recommendedValueJson, current.barSource),
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
    if (recommended === undefined) throw new BadRequestError("La recomendación no tiene BAR recomendada.");
    if (rec.status === "applied") throw new BadRequestError("La recomendación ya está aplicada.");
    const targetDate = dayUtc(rec.targetDate);
    const targetKey = isoDate(targetDate);
    if (targetDate.getTime() < dayUtc().getTime()) {
      throw new BadRequestError(`No se puede aplicar una recomendación sobre una fecha pasada (${targetKey}).`);
    }
    // Apply ONLY to the BAR plan, and only to the room type(s) whose BAR is the
    // lead rate the recommendation was computed against (`current.bar` = min
    // across sellable types). Other plans (BAR-NR, packages) and the rest of
    // the room-type ladder are never overwritten.
    const ratePlan = await resolveBarRatePlan(rec.propertyId);
    if (!ratePlan) throw new BadRequestError("La propiedad no tiene un plan BAR activo; no se ha aplicado nada.");
    const published = await getPublishedBar(rec.propertyId, targetDate, targetDate);
    const previousBar = publishedBarFor(published, targetKey);
    const leadRoomTypeIds = leadRoomTypeIdsFor(published, targetKey);
    if (previousBar === null || leadRoomTypeIds.length === 0) {
      throw new BadRequestError(`No hay tarifario BAR publicado para ${targetKey}; no se ha aplicado nada.`);
    }
    const updated = await prisma.rateDay.updateMany({
      where: { propertyId: rec.propertyId, ratePlanId: ratePlan.id, roomTypeId: { in: leadRoomTypeIds }, date: targetDate },
      data: { price: recommended, manuallyOverridden: true, updatedBy: input.context.userId }
    });
    if (updated.count === 0) throw new BadRequestError(`No hay tarifario BAR publicado para ${targetKey}; no se ha aplicado nada.`);
    const updatedRec = await prisma.revenueRecommendation.update({ where: { id: input.id }, data: { status: "applied", appliedAt: new Date(), approvedBy: input.context.userId, ratePlanId: ratePlan.id } });
    const applied = { ratePlanId: ratePlan.id, ratePlanCode: ratePlan.code, roomTypeIds: leadRoomTypeIds, rateDaysUpdated: updated.count, previousBar, bar: recommended, targetDate: targetKey };
    recordAuditEvent({ organizationId: input.context.organizationId, propertyId: rec.propertyId, actorUserId: input.context.userId, actorType: "user", action: "REVENUE_RECOMMENDATION_APPLIED", entityType: "revenue_recommendation", entityId: rec.id, afterJson: applied, correlationId: input.correlationId });
    return { ...mapRecommendation(updatedRec), applied };
  }

  const updated = await prisma.revenueRecommendation.update({
    where: { id: input.id },
    data: input.decision === "approved" ? { status: "approved", approvedBy: input.context.userId } : { status: "rejected", rejectedBy: input.context.userId }
  });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: rec.propertyId, actorUserId: input.context.userId, actorType: "user", action: input.decision === "approved" ? "REVENUE_RECOMMENDATION_APPROVED" : "REVENUE_RECOMMENDATION_REJECTED", entityType: "revenue_recommendation", entityId: rec.id, afterJson: { status: updated.status }, correlationId: input.correlationId });
  return mapRecommendation(updated);
}
