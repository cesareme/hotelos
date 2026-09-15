// Rate grid v2 · rutas del lote de recomendaciones (RMS por día × tipo de
// habitación) y del calendario de demanda (Prisma). Se registran desde
// server.ts con `registerRecommendationRoutes(app)`; las entradas de permisos
// viven en ./route-permissions.partial.ts (fusionadas en security/route-permissions.ts).
//
// Tenencia: todas las rutas cuelgan de `/properties/:propertyId` o de
// `/revenue/properties/:propertyId`, que el preHandler global valida (misma
// organización, o admin de plataforma reapuntado). Los ids de evento se
// comprueban además contra la propiedad del path en demand-calendar.service
// (404 opaco).
//
// Semántica de apply: POST …/recommendations/apply NUNCA escribe rate_days.
// Persiste las decisiones (RevenueRecommendation, status "applied" |
// "rejected") y devuelve `RateGridCellPatch[]` que un cliente directo puede
// enviar a POST /properties/:id/rate-grid/bulk-update, de modo que el cambio
// pasa por el journal, la materialización de planes derivados y el envío a
// canales como cualquier edición manual. Dos pasos a propósito: una sola
// pista de auditoría y un solo camino de escritura.
//
// Dos formas de cuerpo; el front puede usar cualquiera:
//   · forma ventana — `dates?` / `roomTypeIds?` eligen qué recomendaciones del
//     motor se aceptan (hold / no_data / confianza baja quedan en `skipped`);
//   · forma celdas — `cells: [{ roomTypeId, date, action: accept|adjust|reject,
//     currentPrice?, suggestedPrice?, appliedPrice?, reason? }]`: el usuario ya
//     decidió celda a celda. accept → parche con `appliedPrice` si viene, si no
//     con el `suggestedPrice` que vio el usuario, si no con la sugerencia del
//     motor; adjust → parche con `appliedPrice` (obligatorio); reject → fila
//     "rejected", sin parche. `minConfidence` no se aplica a celdas explícitas.
//
// ORDEN RECOMENDADO (contrato con admin-web, 2026-09-15): el editor hace
// PRIMERO el bulk-update (la escritura real, con el journal) y DESPUÉS llama a
// apply en forma celdas pasando `journalId` = asiento devuelto por bulk-update,
// `currentPrice` = precio base que veía el usuario ANTES del cambio y
// `suggestedPrice` = sugerencia que se le mostró. Así nunca quedan filas
// "applied" huérfanas si el bulk-update falla, y la traza guarda lo que el
// usuario vio, no lo que el motor recalcula después de la escritura (que ya ve
// el precio nuevo). Persistencia por celda:
//   · currentValueJson.price      = currentPrice si viene; si no, el precio
//                                   actual que ve el motor (enginePrice lo
//                                   conserva siempre; priceSource dice cuál fue);
//   · recommendedValueJson.price  = recálculo del motor en el momento del apply
//                                   (o la del cliente si el motor no tiene);
//   · recommendedValueJson.shownPrice = suggestedPrice enviado (null si no vino);
//   · recommendedValueJson.appliedPrice = precio final publicado (null en reject);
//   · reasonJson.journalId        = journalId (RevenueRecommendation no tiene columna).
// El parche devuelto lleva `expected: { price: currentPrice }` cuando el
// cliente lo envía, para que un bulk-update posterior detecte que la celda
// cambió desde que se decidió (409 ALL_CELLS_CONFLICT / conflicts[]).
//
// Validación (zod estricto, mensajes en español vía zodErrorMapEs):
// currentPrice y suggestedPrice son números > 0 y ≤ 50.000 (suggestedPrice
// admite null: el motor puede no tener sugerencia); appliedPrice ≥ 0 y
// ≤ 50.000 como el precio del grid. Un `journalId` que no pertenece a la
// propiedad → 400 `{ code: "UNKNOWN_IDS", journalIds }`. En ambas formas (y en
// el GET) `roomTypeIds` / el `roomTypeId` de las celdas deben pertenecer al
// catálogo activo de la propiedad: si no, 400 `{ code: "UNKNOWN_IDS",
// roomTypeIds }`, el mismo contrato que GET /rate-grid y bulk-update (nunca un
// 200 silencioso con byRoomType vacío).

import type { FastifyInstance } from "fastify";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { z } from "zod";
import type { RateGridCellPatch, RateRecommendationsResponse, RateRestrictions } from "@hotelos/shared";
import { createId } from "../../lib/ids.js";
import { BadRequestError } from "../../lib/http-error.js";
import { isIsoDate } from "../../lib/query-dates.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { dayUtc, isoDate, parseRevenueWindow, round2 } from "./actuals.js";
import {
  buildRecommendations,
  loadRmsConfig,
  RECOMMENDATION_MAX_DAYS,
  RMS_DEFAULTS,
  saveRmsConfig,
  type BuildRecommendationsResult,
  type RmsConfigOverride
} from "./rate-recommendation.service.js";
import { createDemandEvent, deleteDemandEvent, listDemandEvents, parseOrBadRequest, updateDemandEvent } from "./demand-calendar.service.js";

const isoDay = z.string().refine(isIsoDate, { message: "debe ser una fecha YYYY-MM-DD válida" });
const idList = z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
  if (v === undefined) return undefined;
  const parts = (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
});

const MAX_APPLY_PRICE = 50_000;

const RecommendationsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  ratePlanId: z.string().trim().min(1).optional(),
  roomTypeIds: idList
});

/** Precio del grid (mismo rango que rate-grid.schemas priceSchema): 0 admitido, tope 50.000. */
const priceValue = z.number().finite().min(0).max(MAX_APPLY_PRICE);
/** Precio que el usuario vio (base o sugerencia): un 0 o un negativo aquí es un error del cliente, no un dato. */
const positivePrice = z.number().finite().gt(0, "debe ser mayor que 0").max(MAX_APPLY_PRICE);

export const ApplyCellSchema = z
  .object({
    roomTypeId: z.string().trim().min(1),
    date: isoDay,
    /** Precio base que veía el usuario al decidir (se persiste como currentValueJson.price). */
    currentPrice: positivePrice.optional(),
    /** Sugerencia que mostró el editor (recommendedValueJson.shownPrice; fallback del parche cuando el motor no tiene). */
    suggestedPrice: positivePrice.nullable().optional(),
    /** Precio que el usuario publica de verdad (obligatorio en "adjust"). */
    appliedPrice: priceValue.nullable().optional(),
    action: z.enum(["accept", "adjust", "reject"]),
    reason: z.string().trim().max(200).nullable().optional()
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.action === "adjust" && typeof c.appliedPrice !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'action "adjust" exige appliedPrice', path: ["appliedPrice"] });
    }
  });

export type ApplyCell = z.infer<typeof ApplyCellSchema>;

export const ApplyBodySchema = z
  .object({
    from: isoDay,
    to: isoDay,
    ratePlanId: z.string().trim().min(1, "ratePlanId es obligatorio"),
    roomTypeIds: z.array(z.string().trim().min(1)).optional(),
    /** Subset of dates inside [from, to]; omitted = every day of the window. */
    dates: z.array(isoDay).optional(),
    /** Per-cell decisions (alternative to dates/roomTypeIds; see file header). */
    cells: z.array(ApplyCellSchema).max(5000).optional(),
    /** Journal entry created by the publish that carried these prices (traceability only). */
    journalId: z.string().trim().min(1).nullable().optional(),
    reason: z.string().trim().max(200).optional(),
    /** Also emit the suggested restrictions (minLos / cta) in the patches. Default false: prices only. */
    includeRestrictions: z.boolean().optional(),
    /** Accept recommendations below this confidence? Default: the engine's holdBelow (40). */
    minConfidence: z.number().min(0).max(100).optional()
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: "to debe ser igual o posterior a from", path: ["to"] })
  .refine((v) => !(v.cells && (v.dates || v.roomTypeIds)), { message: "cells es excluyente con dates/roomTypeIds", path: ["cells"] });

const RmsConfigBodySchema = z
  .object({
    forecastBands: z.array(z.object({ minFcPct: z.number(), adjPct: z.number() })).min(1).optional(),
    pace: z.object({ maxDaysOut: z.number().int().min(0), thresholdPp: z.number().min(0), adjPct: z.number() }).partial().optional(),
    pickup: z.object({ strongSharePct: z.number().min(0), strongAdjPct: z.number(), stalledMinFcPct: z.number().min(0).max(100), stalledAdjPct: z.number() }).partial().optional(),
    compset: z.object({ weight: z.number().min(0).max(1), weightDeterministic: z.number().min(0).max(1) }).partial().optional(),
    dow: z.object({ damping: z.number().min(0).max(1), maxAdjPct: z.number().min(0).max(50) }).partial().optional(),
    events: z.object({ high: z.number(), medium: z.number(), low: z.number() }).partial().optional(),
    floorPrice: z.number().min(0).optional(),
    minDeltaPct: z.number().min(0).max(50).optional(),
    highRiskDeltaPct: z.number().min(0).max(100).optional(),
    restrictions: z.object({ minLosFcPct: z.number().min(0).max(100), minLosMaxDaysOut: z.number().int().min(0), minLos: z.number().int().min(1).max(14), ctaOccPct: z.number().min(0).max(100) }).partial().optional(),
    confidence: z
      .object({
        holdBelow: z.number().min(0).max(100),
        farOutDays: z.number().int().min(0),
        penalties: z
          .object({
            noForecast: z.number().min(0).max(100),
            forecastDeterministic: z.number().min(0).max(100),
            otbEmpty: z.number().min(0).max(100),
            noStly: z.number().min(0).max(100),
            noCompset: z.number().min(0).max(100),
            compsetDeterministic: z.number().min(0).max(100),
            noEvents: z.number().min(0).max(100),
            farOut: z.number().min(0).max(100)
          })
          .partial()
          .optional()
      })
      .partial()
      .optional()
  })
  .strict();

export type ApplyRecommendationsResponse = {
  propertyId: string;
  ratePlanId: string;
  from: string;
  to: string;
  /** Recommendations persisted (status "applied") = patches returned. */
  applied: number;
  /** Cells persisted as "rejected" (cell form only). */
  rejected?: number;
  /** Alias of `applied` + `rejected` for the front's `{ recorded }` shape. */
  recorded?: number;
  journalId?: string | null;
  /** Cells not turned into a patch, with the reason (hold / no_data / low confidence / filtered). */
  skipped: Array<{ roomTypeId: string; date: string; reason: string }>;
  /** Send these to POST /properties/:id/rate-grid/bulk-update with `reason` (the editor owns the write). */
  patches: RateGridCellPatch[];
  /** Suggested `reason` for the bulk-update journal entry. */
  reason: string;
  recommendationIds: string[];
};

type RecommendationDay = RateRecommendationsResponse["days"][number];
type RecommendationCell = RecommendationDay["byRoomType"][number];

export type CellDecisionInput = {
  propertyId: string;
  ratePlanId: string;
  userId: string;
  now: Date;
  cell: ApplyCell;
  /** Recomendación del motor para (roomTypeId, date) en el momento del apply. */
  rec: RecommendationCell;
  day: RecommendationDay;
  sources: Record<string, string>;
  includeRestrictions: boolean;
  /** Umbral |Δ %| a partir del cual la fila se marca riskLevel "high" (config del motor). */
  highRiskDeltaPct: number;
  journalId: string | null;
};

export type CellDecision =
  | { kind: "skipped"; reason: string }
  | {
      kind: "decided";
      /** Parche para bulk-update; null cuando la decisión es reject. */
      patch: RateGridCellPatch | null;
      row: Prisma.RevenueRecommendationCreateManyInput;
    };

/**
 * Decisión por celda de la forma `cells` (pura, sin I/O; testeada en
 * __tests__/recommendations-apply.test.mts). Resuelve los precios con la
 * prioridad del contrato — lo que el usuario vio manda sobre lo que el motor
 * recalcula ahora — y construye el parche y la fila a persistir con la forma
 * documentada en la cabecera del fichero.
 */
export function buildCellDecision(input: CellDecisionInput): CellDecision {
  const { cell, rec, day } = input;
  const shownPrice = typeof cell.suggestedPrice === "number" ? cell.suggestedPrice : null;
  // Recálculo del motor en el momento del apply; la sugerencia del cliente solo como fallback.
  const suggested = rec.suggestedPrice ?? shownPrice;
  // Baseline: el precio que veía el usuario si lo envía (tras el bulk-update el motor ya ve el nuevo).
  const current = typeof cell.currentPrice === "number" ? cell.currentPrice : rec.currentPrice;
  const price =
    cell.action === "adjust" ? (cell.appliedPrice as number) : cell.action === "accept" ? (cell.appliedPrice ?? shownPrice ?? rec.suggestedPrice ?? null) : null;
  if (cell.action !== "reject" && price === null) {
    return { kind: "skipped", reason: "sin precio sugerido ni appliedPrice" };
  }
  const restrictions: RateRestrictions | null =
    input.includeRestrictions && cell.action !== "reject" && !!rec.suggestedRestrictions && Object.keys(rec.suggestedRestrictions).length > 0 ? { ...rec.suggestedRestrictions } : null;

  let patch: RateGridCellPatch | null = null;
  if (cell.action !== "reject") {
    patch = { ratePlanId: input.ratePlanId, roomTypeId: cell.roomTypeId, date: cell.date, price: round2(price as number) };
    if (restrictions) patch.restrictions = { ...restrictions };
    // Concurrencia optimista: si el cliente dijo qué precio veía, un bulk-update
    // posterior con este parche detecta que la celda cambió entre medias.
    if (typeof cell.currentPrice === "number") patch.expected = { price: cell.currentPrice };
  }

  // Δ % sobre el baseline que vio el usuario: precio final (accept/adjust) o
  // sugerencia mostrada (reject); sin baseline, el Δ del motor.
  const compared = price ?? (cell.action === "reject" ? shownPrice : null);
  const deltaPct = current !== null && current > 0 && compared !== null ? ((compared - current) / current) * 100 : (rec.deltaPct ?? 0);

  const row: Prisma.RevenueRecommendationCreateManyInput = {
    propertyId: input.propertyId,
    recommendationType: "rate_grid",
    targetDate: dayUtc(cell.date),
    roomTypeId: cell.roomTypeId,
    ratePlanId: input.ratePlanId,
    currentValueJson: {
      price: current,
      enginePrice: rec.currentPrice,
      priceSource: typeof cell.currentPrice === "number" ? "client" : "engine",
      barSource: "rate_grid",
      occupancyPct: day.signals.occPct,
      compsetMedian: day.signals.compsetMedian,
      fcOccPct: day.signals.fcOccPct
    } as Prisma.InputJsonValue,
    recommendedValueJson: {
      price: suggested,
      shownPrice,
      appliedPrice: cell.action === "reject" ? null : round2(price as number),
      action: rec.action,
      decision: cell.action,
      restrictions
    } as Prisma.InputJsonValue,
    expectedImpactJson: { direction: deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat", deltaPct: round2(deltaPct) } as Prisma.InputJsonValue,
    reasonJson: { reasons: rec.reasons, missing: rec.missing, sources: input.sources, userReason: cell.reason ?? null, journalId: input.journalId } as unknown as Prisma.InputJsonValue,
    confidence: rec.confidence,
    riskLevel: Math.abs(deltaPct) > input.highRiskDeltaPct ? "high" : "medium",
    status: cell.action === "reject" ? "rejected" : "applied",
    ...(cell.action === "reject" ? { rejectedBy: input.userId } : { approvedBy: input.userId, appliedAt: input.now })
  };
  return { kind: "decided", patch, row };
}

/** Strip the loader-only extras so the wire payload is exactly the shared contract. */
function toWire(result: BuildRecommendationsResult): RateRecommendationsResponse {
  const { leadRoomTypeIdByDate: _lead, currency: _currency, totalRooms: _total, config: _config, ...wire } = result;
  return wire;
}

export function registerRecommendationRoutes(app: FastifyInstance): void {
  // ---- RMS recommendations for the grid ---------------------------------------------
  app.get("/properties/:propertyId/rate-grid/recommendations", async (request) => {
    const params = request.params as { propertyId: string };
    requirePermissions(request.userContext, ["revenue.read"]);
    const q = parseOrBadRequest(RecommendationsQuerySchema, request.query, "query");
    const today = dayUtc();
    const win = parseRevenueWindow({
      from: q.from,
      to: q.to,
      maxDays: RECOMMENDATION_MAX_DAYS,
      defaultFrom: isoDate(today),
      defaultTo: (from) => isoDate(new Date(dayUtc(from).getTime() + 29 * 86_400_000)),
      scope: "de recomendaciones"
    });
    const result = await buildRecommendations({ propertyId: params.propertyId, from: win.from, to: win.to, ratePlanId: q.ratePlanId ?? null, roomTypeIds: q.roomTypeIds, today });
    return toWire(result);
  });

  app.post("/properties/:propertyId/rate-grid/recommendations/apply", async (request) => {
    const params = request.params as { propertyId: string };
    const ctx = request.userContext;
    requirePermissions(ctx, ["revenue.apply_recommendations"]);
    const body = parseOrBadRequest(ApplyBodySchema, request.body);
    const correlationId = createId("corr");
    const today = dayUtc();
    parseRevenueWindow({ from: body.from, to: body.to, maxDays: RECOMMENDATION_MAX_DAYS, scope: "de recomendaciones" });
    if (dayUtc(body.to).getTime() < today.getTime()) {
      throw new BadRequestError("No se pueden aplicar recomendaciones sobre fechas pasadas.");
    }
    const wanted = body.dates ? new Set(body.dates) : null;
    if (wanted) {
      for (const d of wanted) {
        if (d < body.from || d > body.to) throw new BadRequestError(`dates: ${d} está fuera de la ventana ${body.from}..${body.to}`);
      }
    }
    if (body.cells) {
      for (const c of body.cells) {
        if (c.date < body.from || c.date > body.to) throw new BadRequestError(`cells: ${c.date} está fuera de la ventana ${body.from}..${body.to}`);
      }
    }
    if (body.journalId) {
      const journal = await prisma.rateChangeJournal.findFirst({ where: { id: body.journalId, propertyId: params.propertyId }, select: { id: true } });
      if (!journal) {
        // Mismo contrato que los ids ajenos del grid: 400 con el id en details, nunca un enlace silencioso.
        const error = new BadRequestError("journalId no pertenece a la propiedad.");
        error.details = { code: "UNKNOWN_IDS", journalIds: [body.journalId] };
        throw error;
      }
    }
    const cellRoomTypeIds = body.cells ? [...new Set(body.cells.map((c) => c.roomTypeId))] : undefined;
    const result = await buildRecommendations({ propertyId: params.propertyId, from: body.from, to: body.to, ratePlanId: body.ratePlanId, roomTypeIds: body.roomTypeIds ?? cellRoomTypeIds, today });
    if (!result.ratePlanId) throw new BadRequestError("La propiedad no tiene un plan BAR activo; no hay nada que aplicar.");
    const minConfidence = body.minConfidence ?? result.config.confidence.holdBelow;

    const patches: RateGridCellPatch[] = [];
    const skipped: ApplyRecommendationsResponse["skipped"] = [];
    const rows: Prisma.RevenueRecommendationCreateManyInput[] = [];
    const now = new Date();
    let rejected = 0;

    if (body.cells) {
      // Cell form: the user already decided; the engine only provides context.
      const recByCell = new Map<string, { day: (typeof result.days)[number]; rec: (typeof result.days)[number]["byRoomType"][number] }>();
      for (const day of result.days) for (const rec of day.byRoomType) recByCell.set(`${rec.roomTypeId}|${day.date}`, { day, rec });
      const seen = new Set<string>();
      for (const cell of body.cells) {
        const key = `${cell.roomTypeId}|${cell.date}`;
        if (seen.has(key)) {
          skipped.push({ roomTypeId: cell.roomTypeId, date: cell.date, reason: "celda repetida en cells" });
          continue;
        }
        seen.add(key);
        const hit = recByCell.get(key);
        if (!hit) {
          // Foreign/inactive types are already a 400 (UNKNOWN_IDS) upstream; what is
          // left here is a known type without sellable inventory, or a past date
          // inside [from, to] (the engine's effective window starts today).
          skipped.push({ roomTypeId: cell.roomTypeId, date: cell.date, reason: "tipo sin inventario vendible o fecha anterior a hoy" });
          continue;
        }
        const decision = buildCellDecision({
          propertyId: params.propertyId,
          ratePlanId: result.ratePlanId,
          userId: ctx.userId,
          now,
          cell,
          rec: hit.rec,
          day: hit.day,
          sources: result.sources,
          includeRestrictions: body.includeRestrictions === true,
          highRiskDeltaPct: result.config.highRiskDeltaPct,
          journalId: body.journalId ?? null
        });
        if (decision.kind === "skipped") {
          skipped.push({ roomTypeId: cell.roomTypeId, date: cell.date, reason: decision.reason });
          continue;
        }
        if (decision.patch) patches.push(decision.patch);
        else rejected += 1;
        rows.push(decision.row);
      }
    }

    for (const day of body.cells ? [] : result.days) {
      if (wanted && !wanted.has(day.date)) continue;
      for (const rec of day.byRoomType) {
        if (rec.action === "no_data" || rec.currentPrice === null || rec.suggestedPrice === null) {
          skipped.push({ roomTypeId: rec.roomTypeId, date: day.date, reason: "sin BAR publicado" });
          continue;
        }
        if (rec.confidence < minConfidence) {
          skipped.push({ roomTypeId: rec.roomTypeId, date: day.date, reason: `confianza ${rec.confidence} % < ${minConfidence} %` });
          continue;
        }
        const hasRestrictions = body.includeRestrictions === true && !!rec.suggestedRestrictions && Object.keys(rec.suggestedRestrictions).length > 0;
        if (rec.action === "hold" && !hasRestrictions) {
          skipped.push({ roomTypeId: rec.roomTypeId, date: day.date, reason: "mantener (sin cambio material)" });
          continue;
        }
        const patch: RateGridCellPatch = { ratePlanId: result.ratePlanId, roomTypeId: rec.roomTypeId, date: day.date };
        if (rec.action !== "hold") patch.price = rec.suggestedPrice;
        if (hasRestrictions) patch.restrictions = { ...rec.suggestedRestrictions };
        patches.push(patch);
        const deltaPct = rec.deltaPct ?? 0;
        rows.push({
          propertyId: params.propertyId,
          recommendationType: "rate_grid",
          targetDate: dayUtc(day.date),
          roomTypeId: rec.roomTypeId,
          ratePlanId: result.ratePlanId,
          currentValueJson: { price: rec.currentPrice, barSource: "rate_grid", occupancyPct: day.signals.occPct, compsetMedian: day.signals.compsetMedian, fcOccPct: day.signals.fcOccPct } as Prisma.InputJsonValue,
          recommendedValueJson: { price: rec.action === "hold" ? rec.currentPrice : rec.suggestedPrice, action: rec.action, restrictions: hasRestrictions ? rec.suggestedRestrictions : null } as Prisma.InputJsonValue,
          expectedImpactJson: { direction: deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat", deltaPct: round2(deltaPct) } as Prisma.InputJsonValue,
          reasonJson: { reasons: rec.reasons, missing: rec.missing, sources: result.sources } as unknown as Prisma.InputJsonValue,
          confidence: rec.confidence,
          riskLevel: Math.abs(deltaPct) > result.config.highRiskDeltaPct ? "high" : "medium",
          status: "applied",
          approvedBy: ctx.userId,
          appliedAt: now
        });
      }
    }

    // Persist with ids we can return: createMany does not give them back, so
    // create inside one transaction (a window is ≤ 120 days × a handful of types).
    const recommendationIds = rows.length
      ? await prisma.$transaction(async (tx) => {
          const ids: string[] = [];
          for (const data of rows) {
            const created = await tx.revenueRecommendation.create({ data, select: { id: true } });
            ids.push(created.id);
          }
          return ids;
        })
      : [];
    const reason = body.reason?.trim() || `Recomendación RMS ${body.from}..${body.to}`;
    recordAuditEvent({
      organizationId: ctx.organizationId,
      propertyId: params.propertyId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "RATE_GRID_RECOMMENDATIONS_APPLIED",
      entityType: "revenue_recommendation",
      entityId: params.propertyId,
      afterJson: { from: body.from, to: body.to, ratePlanId: result.ratePlanId, applied: patches.length, rejected, skipped: skipped.length, reason, recommendationIds, journalId: body.journalId ?? null },
      correlationId
    });
    const response: ApplyRecommendationsResponse = {
      propertyId: params.propertyId,
      ratePlanId: result.ratePlanId,
      from: result.from,
      to: result.to,
      applied: patches.length,
      rejected,
      recorded: patches.length + rejected,
      journalId: body.journalId ?? null,
      skipped,
      patches,
      reason,
      recommendationIds
    };
    return response;
  });

  // ---- RMS configuration per property (defaults + stored override) ------------------------
  app.get("/properties/:propertyId/rate-grid/recommendations/config", async (request) => {
    const params = request.params as { propertyId: string };
    requirePermissions(request.userContext, ["revenue.read"]);
    const { config, source } = await loadRmsConfig(params.propertyId);
    return { propertyId: params.propertyId, source, config, defaults: RMS_DEFAULTS };
  });

  app.put("/properties/:propertyId/rate-grid/recommendations/config", async (request) => {
    const params = request.params as { propertyId: string };
    const ctx = request.userContext;
    requirePermissions(ctx, ["revenue.configure"]);
    const override = parseOrBadRequest(RmsConfigBodySchema, request.body) as RmsConfigOverride;
    const config = await saveRmsConfig(params.propertyId, override);
    recordAuditEvent({
      organizationId: ctx.organizationId,
      propertyId: params.propertyId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "RATE_GRID_RMS_CONFIG_UPDATED",
      entityType: "property_ai_setting",
      entityId: params.propertyId,
      afterJson: override,
      correlationId: createId("corr")
    });
    return { propertyId: params.propertyId, source: "property_ai_settings.rms", config, defaults: RMS_DEFAULTS };
  });

  // ---- Demand calendar (Prisma) -----------------------------------------------------------
  app.get("/revenue/properties/:propertyId/demand-calendar", async (request) => {
    const params = request.params as { propertyId: string };
    requirePermissions(request.userContext, ["revenue.read"]);
    return listDemandEvents({ propertyId: params.propertyId, query: request.query });
  });

  app.post("/revenue/properties/:propertyId/demand-calendar", async (request, reply) => {
    const params = request.params as { propertyId: string };
    const event = await createDemandEvent({ context: request.userContext, propertyId: params.propertyId, body: request.body, correlationId: createId("corr") });
    reply.code(201);
    return event;
  });

  app.patch("/revenue/properties/:propertyId/demand-calendar/:eventId", async (request) => {
    const params = request.params as { propertyId: string; eventId: string };
    return updateDemandEvent({ context: request.userContext, propertyId: params.propertyId, eventId: params.eventId, body: request.body, correlationId: createId("corr") });
  });

  app.delete("/revenue/properties/:propertyId/demand-calendar/:eventId", async (request) => {
    const params = request.params as { propertyId: string; eventId: string };
    return deleteDemandEvent({ context: request.userContext, propertyId: params.propertyId, eventId: params.eventId, correlationId: createId("corr") });
  });
}
