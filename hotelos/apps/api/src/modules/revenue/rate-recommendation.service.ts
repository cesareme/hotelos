// Rate grid v2 · RMS recommendations per (stay date × room type).
//
// Transparent, rules-based revenue management for the rate grid editor: every
// suggested price is derived from the PUBLISHED BAR of the room type and a
// short list of documented adjustments, each one surfaced as a `reason` with
// its weight so the revenue manager can read WHY. Nothing is invented:
//   · no published BAR for the type → action "no_data" (never a default price);
//   · a signal that is not available is listed in `missing` and lowers the
//     confidence; below `holdBelow` the action degrades to "hold";
//   · deterministic inputs (synthetic forecast / synthetic compset) are
//     accepted but penalised, and labelled as such in `sources`.
//
// Two layers:
//   1. `recommendForDay(signals, config)` — PURE (no I/O), unit-tested. Takes
//      the day's signals (OTB, forecast, STLY, pickup, compset, events) plus
//      the per-type base (BAR, min/max, ladder, DOW shape) and the property's
//      pricing rules / BAR ladder, and returns one recommendation per type.
//   2. `buildRecommendations({propertyId, from, to})` — loads every signal with
//      ONE query per source (no N+1), builds the signals and returns the wire
//      contract `RateRecommendationsResponse` (packages/shared).
//
// Configuration: `RMS_DEFAULTS` below, overridable per property through
// `PropertyAiSetting.configurationJson.rms` (partial object, deep-merged per
// section). Chosen over a new PricingRule flavour because it needs no schema
// change and the settings row already exists for every property.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type {
  RateGridCellRecommendation,
  RateGridDemandDay,
  RateRecommendationsResponse,
  RateRestrictions
} from "@hotelos/shared";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import {
  addDays,
  dayUtc,
  dec,
  decOrNull,
  getPublishedBar,
  isoDate,
  leadRoomTypeIdsFor,
  MS_DAY,
  parseRevenueWindow,
  round2,
  TOP_LEVEL_SNAPSHOT_WHERE,
  typeDateKey
} from "./actuals.js";
import { expand, type ResRow } from "./pace.service.js";
import { DETERMINISTIC_MODEL_VERSION, isImportedForecastModelVersion } from "./forecast.service.js";
import { compsetMedianByDate } from "./pricing.service.js";
import { listDemandEventsInWindow } from "./demand-calendar.service.js";

// ---- configuration ---------------------------------------------------------------
export type RmsConfig = {
  /** Forecast occupancy bands, evaluated top-down: the first band whose `minFcPct` ≤ forecast wins. */
  forecastBands: Array<{ minFcPct: number; adjPct: number }>;
  /** Pace vs STLY (occupancy points), only inside `maxDaysOut` and with a non-empty OTB. */
  pace: { maxDaysOut: number; thresholdPp: number; adjPct: number };
  /** Pickup over the last 7 days: strong (≥ share of total rooms) / stalled with demand forecast. */
  pickup: { strongSharePct: number; strongAdjPct: number; stalledMinFcPct: number; stalledAdjPct: number };
  /** Share of the gap toward the (ladder-adjusted) compset median that is closed. */
  compset: { weight: number; weightDeterministic: number };
  /** Learned day-of-week shape: damping of the deviation and cap (±%). */
  dow: { damping: number; maxAdjPct: number };
  /** Demand calendar events by expected impact (%). */
  events: { high: number; medium: number; low: number };
  /** Hard floor for any suggested price (property currency). */
  floorPrice: number;
  /** |Δ%| below this → hold. */
  minDeltaPct: number;
  /** |Δ%| above this → riskLevel "high" when persisted. */
  highRiskDeltaPct: number;
  restrictions: { minLosFcPct: number; minLosMaxDaysOut: number; minLos: number; ctaOccPct: number };
  confidence: {
    holdBelow: number;
    farOutDays: number;
    penalties: {
      noForecast: number;
      forecastDeterministic: number;
      otbEmpty: number;
      noStly: number;
      noCompset: number;
      compsetDeterministic: number;
      noEvents: number;
      farOut: number;
    };
  };
};

/**
 * Documented defaults (César's brief, 2026-09-14). Every figure is a
 * percentage unless stated; all of them are overridable per property.
 */
export const RMS_DEFAULTS: RmsConfig = {
  forecastBands: [
    { minFcPct: 92, adjPct: 10 },
    { minFcPct: 85, adjPct: 6 },
    { minFcPct: 70, adjPct: 0 },
    { minFcPct: 50, adjPct: -3 },
    { minFcPct: 0, adjPct: -6 } // 0 (not -Infinity): JSON-safe for the config endpoint; occupancy is never negative
  ],
  pace: { maxDaysOut: 30, thresholdPp: 15, adjPct: 4 },
  pickup: { strongSharePct: 5, strongAdjPct: 3, stalledMinFcPct: 70, stalledAdjPct: -2 },
  compset: { weight: 0.3, weightDeterministic: 0.1 },
  dow: { damping: 0.5, maxAdjPct: 5 },
  events: { high: 8, medium: 4, low: 0 },
  floorPrice: 40,
  minDeltaPct: 1,
  highRiskDeltaPct: 15,
  restrictions: { minLosFcPct: 92, minLosMaxDaysOut: 14, minLos: 2, ctaOccPct: 95 },
  confidence: {
    holdBelow: 40,
    farOutDays: 90,
    penalties: {
      noForecast: 30,
      forecastDeterministic: 15,
      otbEmpty: 25,
      noStly: 10,
      noCompset: 10,
      compsetDeterministic: 10,
      noEvents: 5,
      farOut: 10
    }
  }
};

/** Partial, per-section override stored in PropertyAiSetting.configurationJson.rms. */
export type RmsConfigOverride = {
  [K in keyof RmsConfig]?: RmsConfig[K] extends Array<unknown> ? RmsConfig[K] : Partial<RmsConfig[K]>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge (two levels) a stored override over the defaults; unknown/invalid keys are ignored. */
export function mergeRmsConfig(override: unknown, base: RmsConfig = RMS_DEFAULTS): RmsConfig {
  if (!isRecord(override)) return base;
  const out: RmsConfig = {
    ...base,
    pace: { ...base.pace },
    pickup: { ...base.pickup },
    compset: { ...base.compset },
    dow: { ...base.dow },
    events: { ...base.events },
    restrictions: { ...base.restrictions },
    confidence: { ...base.confidence, penalties: { ...base.confidence.penalties } }
  };
  const bands = override.forecastBands;
  if (Array.isArray(bands)) {
    const parsed = bands
      .filter((b): b is { minFcPct: number; adjPct: number } => isRecord(b) && typeof b.minFcPct === "number" && typeof b.adjPct === "number")
      .sort((a, b) => b.minFcPct - a.minFcPct);
    if (parsed.length) out.forecastBands = parsed;
  }
  for (const key of ["floorPrice", "minDeltaPct", "highRiskDeltaPct"] as const) {
    const v = override[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  const mergeSection = <T extends Record<string, number>>(target: T, src: unknown): T => {
    if (!isRecord(src)) return target;
    for (const k of Object.keys(target) as Array<keyof T>) {
      const v = src[k as string];
      if (typeof v === "number" && Number.isFinite(v)) target[k] = v as T[keyof T];
    }
    return target;
  };
  mergeSection(out.pace, override.pace);
  mergeSection(out.pickup, override.pickup);
  mergeSection(out.compset, override.compset);
  mergeSection(out.dow, override.dow);
  mergeSection(out.events, override.events);
  mergeSection(out.restrictions, override.restrictions);
  if (isRecord(override.confidence)) {
    const c = override.confidence;
    if (typeof c.holdBelow === "number") out.confidence.holdBelow = c.holdBelow;
    if (typeof c.farOutDays === "number") out.confidence.farOutDays = c.farOutDays;
    mergeSection(out.confidence.penalties, c.penalties);
  }
  return out;
}

/** Read the property's RMS override (PropertyAiSetting.configurationJson.rms) merged over the defaults. */
export async function loadRmsConfig(propertyId: string): Promise<{ config: RmsConfig; source: "property_ai_settings.rms" | "defaults" }> {
  const row = await prisma.propertyAiSetting.findUnique({ where: { propertyId }, select: { configurationJson: true } });
  const cfg = isRecord(row?.configurationJson) ? row.configurationJson.rms : undefined;
  if (!isRecord(cfg) || Object.keys(cfg).length === 0) return { config: RMS_DEFAULTS, source: "defaults" };
  return { config: mergeRmsConfig(cfg), source: "property_ai_settings.rms" };
}

/** Persist a partial override (replaces the stored `rms` key; the rest of configurationJson is kept). */
export async function saveRmsConfig(propertyId: string, override: RmsConfigOverride): Promise<RmsConfig> {
  const existing = await prisma.propertyAiSetting.findUnique({ where: { propertyId }, select: { configurationJson: true } });
  const current = isRecord(existing?.configurationJson) ? existing.configurationJson : {};
  const next = { ...current, rms: override } as Prisma.InputJsonObject;
  await prisma.propertyAiSetting.upsert({
    where: { propertyId },
    create: { propertyId, configurationJson: next, voiceLocales: [] },
    update: { configurationJson: next }
  });
  return mergeRmsConfig(override);
}

// ---- signals (input of the pure core) ---------------------------------------------
export type CompsetSource = "real" | "deterministic";

export type RoomTypeBase = {
  roomTypeId: string;
  /** Published BAR of the type for the date; null → no_data. */
  bar: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** BAR of the type / lead (minimum) BAR of the date — scales the compset median (shopped at lead level) to this type. */
  ladderFactor: number | null;
  /** Learned weekly shape of the type: mean BAR of this weekday / mean BAR of the week (null when unknown). */
  dowFactor: number | null;
  /** Mean BAR of the type over the calendar week (Mon–Sun) containing the date (null when unknown). */
  weekMeanBar: number | null;
};

export type PricingRuleSignal = {
  name: string;
  minOccupancy: number | null;
  maxOccupancy: number | null;
  adjustType: "percent" | "amount";
  adjustValue: number;
  minPrice: number | null;
  maxPrice: number | null;
};

export type DaySignals = {
  date: string;
  daysOut: number;
  /** 0 = Sunday … 6 = Saturday (UTC). */
  dow: number;
  totalRooms: number;
  otbRooms: number;
  occPct: number;
  /** True when the property has ZERO rooms on the books across the whole window (imported pilot without reservations). */
  propertyOtbEmpty: boolean;
  fcOccPct: number | null;
  fcSource: string | null;
  fcDeterministic: boolean;
  stlyOccPct: number | null;
  stlyAdr: number | null;
  pickup7: number | null;
  compsetMedian: number | null;
  compsetSource: CompsetSource | null;
  events: Array<{ name: string; impact: string | null }>;
  /** False when the property has no demand calendar at all (penalised: the engine is blind to local demand). */
  eventsAvailable: boolean;
  budgetGapPct: number | null;
  byRoomType: RoomTypeBase[];
  pricingRules: PricingRuleSignal[];
  barLevels: Array<{ name: string; price: number }>;
};

export type RoomTypeRecommendation = { roomTypeId: string } & RateGridCellRecommendation;

type Reason = RateGridCellRecommendation["reasons"][number];

const DOW_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MISSING_LABELS_ES: Record<string, string> = {
  bar: "sin BAR publicado",
  forecast: "sin previsión",
  stly: "sin STLY",
  compset: "sin compset",
  events: "sin eventos",
  otb_empty: "OTB vacía"
};
/** Spanish label of a `missing` code (used by the board and the editor tooltips). */
export function missingLabelEs(code: string): string {
  return MISSING_LABELS_ES[code] ?? code;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${round2(n).toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`;
}
/** Unsigned percentage with the es-ES decimal comma ("51,09 %"). */
function fmtPlainPct(n: number): string {
  return `${round2(n).toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Confidence for a day: 100 − documented penalties; the same for every room type of the day. */
export function dayConfidence(signals: DaySignals, config: RmsConfig): { confidence: number; missing: string[]; penalties: Array<{ code: string; label: string; points: number }> } {
  const p = config.confidence.penalties;
  const penalties: Array<{ code: string; label: string; points: number }> = [];
  const missing: string[] = [];
  if (signals.fcOccPct === null) {
    penalties.push({ code: "no_forecast", label: "sin previsión", points: p.noForecast });
    missing.push("forecast");
  } else if (signals.fcDeterministic) {
    penalties.push({ code: "forecast_deterministic", label: "previsión determinista", points: p.forecastDeterministic });
  }
  if (signals.propertyOtbEmpty) {
    penalties.push({ code: "otb_empty", label: "OTB vacía en toda la propiedad", points: p.otbEmpty });
    missing.push("otb_empty");
  }
  if (signals.stlyOccPct === null) {
    penalties.push({ code: "no_stly", label: "sin STLY", points: p.noStly });
    missing.push("stly");
  }
  if (signals.compsetMedian === null) {
    penalties.push({ code: "no_compset", label: "sin compset", points: p.noCompset });
    missing.push("compset");
  } else if (signals.compsetSource === "deterministic") {
    penalties.push({ code: "compset_deterministic", label: "compset determinista", points: p.compsetDeterministic });
  }
  if (!signals.eventsAvailable) {
    penalties.push({ code: "no_events", label: "sin calendario de eventos", points: p.noEvents });
    missing.push("events");
  }
  if (signals.daysOut > config.confidence.farOutDays) {
    penalties.push({ code: "far_out", label: `a más de ${config.confidence.farOutDays} días`, points: p.farOut });
  }
  const total = penalties.reduce((s, x) => s + x.points, 0);
  return { confidence: clamp(Math.round(100 - total), 0, 100), missing, penalties };
}

/** Restrictions suggested by the demand picture (null when nothing applies). */
export function suggestRestrictions(signals: DaySignals, config: RmsConfig): RateRestrictions | null {
  const out: RateRestrictions = {};
  const r = config.restrictions;
  const isFriSat = signals.dow === 5 || signals.dow === 6;
  if (signals.fcOccPct !== null && signals.fcOccPct >= r.minLosFcPct && signals.daysOut <= r.minLosMaxDaysOut && isFriSat) {
    out.minLos = r.minLos;
  }
  if (signals.occPct >= r.ctaOccPct) out.cta = true;
  return Object.keys(out).length ? out : null;
}

/**
 * PURE core: one recommendation per room type for a stay date. Order of the
 * adjustments (documented in the reasons, in this order):
 *   forecast band → pace vs STLY → pickup7 → events → compset tracking →
 *   learned DOW shape → PricingRule by occupancy band → BarLevel snapping →
 *   clamp to the cell's min/max and the global floor → material-delta gate.
 */
export function recommendForDay(signals: DaySignals, config: RmsConfig = RMS_DEFAULTS): RoomTypeRecommendation[] {
  const { confidence, missing, penalties } = dayConfidence(signals, config);
  const suggestedRestrictions = suggestRestrictions(signals, config);
  const confidenceReason: Reason = {
    code: "confidence",
    label: penalties.length ? `Confianza ${confidence} % (${penalties.map((x) => `${x.label} −${x.points}`).join(", ")})` : `Confianza ${confidence} %`,
    weight: 0,
    value: confidence
  };

  // Day-level percentage adjustments (identical for every type of the day).
  const dayReasons: Reason[] = [];
  let dayPct = 0;
  if (signals.fcOccPct !== null) {
    const band = config.forecastBands.find((b) => signals.fcOccPct! >= b.minFcPct) ?? config.forecastBands[config.forecastBands.length - 1];
    dayPct += band.adjPct;
    dayReasons.push({ code: "forecast", label: `Previsión ${fmtPlainPct(signals.fcOccPct)} de ocupación`, weight: band.adjPct, value: signals.fcOccPct });
  }
  if (signals.stlyOccPct !== null && !signals.propertyOtbEmpty && signals.daysOut <= config.pace.maxDaysOut) {
    const delta = signals.occPct - signals.stlyOccPct;
    if (delta <= -config.pace.thresholdPp) {
      dayPct -= config.pace.adjPct;
      dayReasons.push({ code: "pace", label: `Ritmo ${fmtPlainPct(delta).replace(" %", " pp")} por debajo de STLY`, weight: -config.pace.adjPct, value: round2(delta) });
    } else if (delta >= config.pace.thresholdPp) {
      dayPct += config.pace.adjPct;
      dayReasons.push({ code: "pace", label: `Ritmo +${fmtPlainPct(delta).replace(" %", " pp")} por encima de STLY`, weight: config.pace.adjPct, value: round2(delta) });
    }
  }
  if (signals.pickup7 !== null && !signals.propertyOtbEmpty && signals.totalRooms > 0) {
    const share = (signals.pickup7 / signals.totalRooms) * 100;
    if (share >= config.pickup.strongSharePct) {
      dayPct += config.pickup.strongAdjPct;
      dayReasons.push({ code: "pickup", label: `Pickup 7 días fuerte (+${signals.pickup7} hab.)`, weight: config.pickup.strongAdjPct, value: signals.pickup7 });
    } else if (signals.pickup7 <= 0 && signals.fcOccPct !== null && signals.fcOccPct >= config.pickup.stalledMinFcPct) {
      dayPct += config.pickup.stalledAdjPct;
      dayReasons.push({ code: "pickup", label: `Pickup estancado con previsión ${fmtPlainPct(signals.fcOccPct)}`, weight: config.pickup.stalledAdjPct, value: signals.pickup7 });
    }
  }
  if (signals.events.length) {
    const rank = (impact: string | null) => (impact === "high" ? 2 : impact === "medium" ? 1 : 0);
    const top = signals.events.reduce((best, e) => (rank(e.impact) > rank(best.impact) ? e : best));
    const adj = top.impact === "high" ? config.events.high : top.impact === "medium" ? config.events.medium : config.events.low;
    if (adj !== 0) {
      dayPct += adj;
      dayReasons.push({ code: "event", label: `Evento: ${top.name} (impacto ${top.impact === "high" ? "alto" : top.impact === "medium" ? "medio" : "bajo"})`, weight: adj, value: top.name });
    }
  }

  // Occupancy-band PricingRule (first match, rules are pre-sorted by priority).
  const rule = signals.pricingRules.find((r) => {
    const lo = r.minOccupancy === null ? -Infinity : r.minOccupancy;
    const hi = r.maxOccupancy === null ? Infinity : r.maxOccupancy;
    return signals.occPct >= lo && signals.occPct <= hi;
  });

  return signals.byRoomType.map((rt): RoomTypeRecommendation => {
    if (rt.bar === null || rt.bar <= 0) {
      return {
        roomTypeId: rt.roomTypeId,
        currentPrice: null,
        suggestedPrice: null,
        deltaPct: null,
        action: "no_data",
        confidence: 0,
        reasons: [{ code: "no_bar", label: "Sin BAR publicado para el tipo: no se recomienda precio", weight: 0 }],
        missing: ["bar", ...missing],
        suggestedRestrictions
      };
    }
    const reasons: Reason[] = [...dayReasons];
    let price = rt.bar * (1 + dayPct / 100);

    // Compset: close a share of the gap toward the median, scaled to this type's rung of the ladder.
    if (signals.compsetMedian !== null) {
      const target = signals.compsetMedian * (rt.ladderFactor ?? 1);
      const weight = signals.compsetSource === "deterministic" ? config.compset.weightDeterministic : config.compset.weight;
      const adj = weight * (target - price);
      const adjPct = price > 0 ? round2((adj / price) * 100) : 0;
      price += adj;
      reasons.push({
        code: "compset",
        label: `Compset mediana ${fmtMoney(round2(target))} € (${signals.compsetSource === "deterministic" ? "determinista" : "real"}, peso ${weight})`,
        weight: adjPct,
        value: round2(target)
      });
    }

    // Learned DOW shape: nudge toward the property's habitual weekday premium when this cell sits off it.
    if (rt.dowFactor !== null && rt.weekMeanBar !== null && rt.weekMeanBar > 0 && rt.dowFactor > 0) {
      const local = rt.bar / rt.weekMeanBar;
      const raw = local > 0 ? (rt.dowFactor / local - 1) * 100 * config.dow.damping : 0;
      const adjPct = round2(clamp(raw, -config.dow.maxAdjPct, config.dow.maxAdjPct));
      // Below 1 % the nudge is noise, not a signal: skip it (and its reason).
      if (Math.abs(adjPct) >= 1) {
        price *= 1 + adjPct / 100;
        reasons.push({ code: "dow", label: `Patrón semanal (${DOW_ES[signals.dow]} ×${round2(rt.dowFactor)})`, weight: adjPct, value: round2(rt.dowFactor) });
      }
    }

    if (rule) {
      const before = price;
      price = rule.adjustType === "amount" ? price + rule.adjustValue : price * (1 + rule.adjustValue / 100);
      if (rule.minPrice !== null) price = Math.max(price, rule.minPrice);
      if (rule.maxPrice !== null) price = Math.min(price, rule.maxPrice);
      reasons.push({ code: "rule", label: `Regla «${rule.name}» (ocupación ${fmtPlainPct(signals.occPct)})`, weight: before > 0 ? round2(((price - before) / before) * 100) : 0, value: rule.name });
    }

    if (signals.barLevels.length) {
      const nearest = signals.barLevels.reduce((best, l) => (Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best));
      const before = price;
      price = nearest.price;
      reasons.push({ code: "bar_level", label: `Ajustado al nivel BAR «${nearest.name}»`, weight: before > 0 ? round2(((price - before) / before) * 100) : 0, value: nearest.name });
    }

    // Clamp: cell min/max first, then the global floor.
    if (rt.minPrice !== null && price < rt.minPrice) {
      reasons.push({ code: "clamp_min", label: `Limitado al mínimo de la celda ${fmtMoney(rt.minPrice)} €`, weight: 0, value: rt.minPrice });
      price = rt.minPrice;
    }
    if (rt.maxPrice !== null && price > rt.maxPrice) {
      reasons.push({ code: "clamp_max", label: `Limitado al máximo de la celda ${fmtMoney(rt.maxPrice)} €`, weight: 0, value: rt.maxPrice });
      price = rt.maxPrice;
    }
    if (price < config.floorPrice) {
      reasons.push({ code: "floor", label: `Suelo global ${fmtMoney(config.floorPrice)} €`, weight: 0, value: config.floorPrice });
      price = config.floorPrice;
    }
    price = round2(price);
    const deltaPct = round2(((price - rt.bar) / rt.bar) * 100);

    let action: RateGridCellRecommendation["action"];
    if (confidence < config.confidence.holdBelow) {
      action = "hold";
      reasons.push({ code: "low_confidence", label: `Datos insuficientes (confianza ${confidence} % < ${config.confidence.holdBelow} %): mantener`, weight: 0, value: confidence });
    } else if (Math.abs(deltaPct) < config.minDeltaPct) {
      action = "hold";
      reasons.push({ code: "immaterial", label: `Variación ${fmtPct(deltaPct)} por debajo del umbral (${config.minDeltaPct} %): mantener`, weight: 0, value: deltaPct });
    } else {
      action = deltaPct > 0 ? "raise" : "lower";
    }
    reasons.push(confidenceReason);

    return {
      roomTypeId: rt.roomTypeId,
      currentPrice: round2(rt.bar),
      suggestedPrice: price,
      deltaPct,
      action,
      confidence,
      reasons,
      missing,
      suggestedRestrictions
    };
  });
}

// ---- DOW learning (pure) -----------------------------------------------------------
/**
 * Weekly shape per room type from a set of (roomTypeId, date, price) rows:
 * factor[dow] = mean price of that weekday / mean price over all rows. Needs
 * at least `minDates` distinct dates and every weekday represented; otherwise
 * null for that type (the caller falls back to the STLY shape).
 */
export function learnDowFactors(rows: Array<{ roomTypeId: string; date: string; price: number }>, minDates = 14): Map<string, number[]> {
  const byType = new Map<string, { sum: number[]; n: number[]; dates: Set<string> }>();
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    let acc = byType.get(r.roomTypeId);
    if (!acc) {
      acc = { sum: new Array(7).fill(0), n: new Array(7).fill(0), dates: new Set() };
      byType.set(r.roomTypeId, acc);
    }
    const dow = dayUtc(r.date).getUTCDay();
    acc.sum[dow] += r.price;
    acc.n[dow] += 1;
    acc.dates.add(r.date);
  }
  const out = new Map<string, number[]>();
  for (const [typeId, acc] of byType) {
    if (acc.dates.size < minDates || acc.n.some((n) => n === 0)) continue;
    const totalSum = acc.sum.reduce((s, v) => s + v, 0);
    const totalN = acc.n.reduce((s, v) => s + v, 0);
    const mean = totalSum / totalN;
    if (!(mean > 0)) continue;
    out.set(typeId, acc.sum.map((s, i) => round2(s / acc.n[i] / mean)));
  }
  return out;
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
function weekStartUtc(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(d, -dow);
}

// ---- forecast normalisation (pure) ---------------------------------------------------
export type ForecastRowLike = {
  forecastDate: Date;
  roomTypeId: string | null;
  ratePlanId: string | null;
  channelId: string | null;
  segment: string | null;
  expectedOccupancy: Prisma.Decimal | number | null;
  expectedRoomsSold: Prisma.Decimal | number | null;
  modelVersion: string | null;
};

/**
 * Forecast occupancy per day on the property's `totalRooms` base, clamped to
 * ≤ 100. Top-level rows win over per-type rows (aggregated per day). Imported
 * PMS rows (`pms_import:*`) carry their own occupancy base (available rooms −
 * OOO) so they are re-based on `expectedRoomsSold / totalRooms`.
 */
export function normalizeForecastOcc(rows: ForecastRowLike[], totalRooms: number): { byDate: Map<string, number>; modelVersion: string | null; deterministic: boolean } {
  const topLevel = rows.filter((f) => !f.roomTypeId && !f.ratePlanId && !f.channelId && !f.segment);
  const source = topLevel.length ? topLevel : rows;
  const acc = new Map<string, { rooms: number; roomsKnown: boolean; occ: number | null }>();
  for (const f of source) {
    const key = isoDate(dayUtc(f.forecastDate));
    let a = acc.get(key);
    if (!a) {
      a = { rooms: 0, roomsKnown: false, occ: null };
      acc.set(key, a);
    }
    const rooms = decOrNull(f.expectedRoomsSold);
    if (rooms !== null) {
      a.rooms += rooms;
      a.roomsKnown = true;
    }
    const occ = decOrNull(f.expectedOccupancy);
    if (occ !== null) a.occ = topLevel.length ? occ : (a.occ ?? 0) + occ; // per-type rows: not additive on the same base, rooms win below
  }
  const modelVersion = source.find((f) => f.modelVersion)?.modelVersion ?? null;
  const imported = isImportedForecastModelVersion(modelVersion);
  const byDate = new Map<string, number>();
  for (const [key, a] of acc) {
    let occ: number | null = null;
    if (imported || !topLevel.length) {
      // Re-base on the property's own room count (PMS import: available − OOO base; per-type rows: sum of rooms).
      occ = a.roomsKnown && totalRooms > 0 ? (a.rooms / totalRooms) * 100 : a.occ;
    } else {
      occ = a.occ !== null ? a.occ : a.roomsKnown && totalRooms > 0 ? (a.rooms / totalRooms) * 100 : null;
    }
    if (occ === null || !Number.isFinite(occ)) continue;
    byDate.set(key, round2(clamp(occ, 0, 100)));
  }
  const deterministic = modelVersion !== null && (modelVersion === DETERMINISTIC_MODEL_VERSION || modelVersion.startsWith("deterministic"));
  return { byDate, modelVersion, deterministic };
}

// ---- loader + response -----------------------------------------------------------------
const OTB_STATUSES = ["confirmed", "checked_in"] as const;
/** Longest recommendation window (inclusive days) accepted by the grid endpoint. */
export const RECOMMENDATION_MAX_DAYS = 120;
/** Rate days loaded around the window to learn the weekly shape (± days). */
const DOW_LEARNING_SPAN_DAYS = 182;
/** Explicit bounds of the window reads (Tanda L2 · L2-05): the window is ≤ RECOMMENDATION_MAX_DAYS, so these never cut a real hotel. */
const RECOMMENDATION_MAX_RESERVATION_ROWS = 50_000;
const RECOMMENDATION_MAX_FORECAST_ROWS = 50_000;

export type BuildRecommendationsInput = {
  propertyId: string;
  from: string;
  to: string;
  /** Must be the BAR plan (recommendations are computed on the published BAR); null/undefined → resolved. */
  ratePlanId?: string | null;
  roomTypeIds?: string[];
  /** Business date override (tests / board); defaults to today UTC. */
  today?: Date;
  /** Window cap; the grid route uses RECOMMENDATION_MAX_DAYS, the board may pass its own. */
  maxDays?: number;
};

/**
 * Filters must reference the property's own catalogue: 400 `UNKNOWN_IDS` with
 * the offending ids in `details` (same contract as `getRateGrid`), never a
 * silent 200 with empty `byRoomType`. `known` is the set of ACTIVE room types
 * of the property (the rate-grid catalogue); inactive or foreign ids are
 * unknown alike. Pure (no I/O) so it is unit-tested; ids are de-duplicated and
 * capped at 20 in `details` like the rate-grid engine does.
 */
export function assertRoomTypeIdsBelong(requested: readonly string[] | null | undefined, known: ReadonlySet<string>): void {
  if (!requested || requested.length === 0) return;
  const unknown = [...new Set(requested)].filter((id) => !known.has(id));
  if (unknown.length === 0) return;
  const error = new BadRequestError("roomTypeIds contienen ids que no pertenecen a la propiedad.");
  error.details = { code: "UNKNOWN_IDS", roomTypeIds: unknown.slice(0, 20) };
  throw error;
}

export type BuildRecommendationsResult = RateRecommendationsResponse & {
  /** Room type(s) whose BAR is the lead (minimum) rate of the day — the figure the board quotes. */
  leadRoomTypeIdByDate: Record<string, string | null>;
  currency: string;
  totalRooms: number;
  config: RmsConfig;
};

export async function buildRecommendations(input: BuildRecommendationsInput): Promise<BuildRecommendationsResult> {
  const today = dayUtc(input.today);
  const win = parseRevenueWindow({ from: input.from, to: input.to, maxDays: input.maxDays ?? RECOMMENDATION_MAX_DAYS, scope: "de recomendaciones" });
  const to = dayUtc(win.to);
  // Past dates are never recommended: the effective window starts today.
  const from = dayUtc(win.from).getTime() < today.getTime() ? today : dayUtc(win.from);
  const propertyId = input.propertyId;

  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, currency: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  const [{ config, source: configSource }, publishedBar, roomTypes, roomGroups] = await Promise.all([
    loadRmsConfig(propertyId),
    getPublishedBar(propertyId, from, to),
    // Every ACTIVE type (the rate-grid catalogue) so a requested id can be told
    // apart as "foreign/inactive" (400 UNKNOWN_IDS) vs "known but not sellable"
    // (silently absent from byRoomType, like a type without rooms).
    prisma.roomType.findMany({ where: { propertyId, active: true }, select: { id: true, displayOrder: true, sellable: true }, take: 500 }),
    prisma.room.groupBy({ by: ["roomTypeId"], where: { propertyId, sellable: true }, _count: { _all: true } })
  ]);
  assertRoomTypeIdsBelong(input.roomTypeIds, new Set(roomTypes.map((t) => t.id)));
  const roomsByType = new Map(roomGroups.map((g) => [g.roomTypeId, g._count._all]));
  const totalRooms = roomGroups.reduce((s, g) => s + g._count._all, 0);
  const requested = input.roomTypeIds?.length ? new Set(input.roomTypeIds) : null;
  const typeIds = roomTypes
    .filter((t) => t.sellable && (roomsByType.get(t.id) ?? 0) > 0)
    .filter((t) => !requested || requested.has(t.id))
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((t) => t.id);
  const ratePlan = publishedBar.ratePlan;
  if (input.ratePlanId && ratePlan && input.ratePlanId !== ratePlan.id) {
    throw new NotFoundError(`Las recomendaciones se calculan sobre el plan BAR (${ratePlan.code}); los planes derivados se rematerializan al aplicar.`);
  }

  const emptyDays = from.getTime() > to.getTime();
  const stlyFrom = addDays(from, -364);
  const stlyTo = addDays(to, -364);
  const captureDate = addDays(today, -7);
  const budgetMonths = new Set<string>();
  for (let t = from.getTime(); t <= to.getTime(); t += MS_DAY) budgetMonths.add(isoDate(new Date(t)).slice(0, 7));
  // Days of the effective window: the bound of the per-day reads (pace / STLY: one row a day; rate days: one per type and day of the DOW span).
  const windowDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / MS_DAY) + 1);

  const [reservations, paceRows, forecasts, stlySnapshots, compset, events, budgets, rules, levels, wideRateDays] = emptyDays
    ? [[], [], [], [], { byDate: new Map(), activeCompetitors: 0, source: null }, [], [], [], [], []]
    : await Promise.all([
        prisma.reservation.findMany({
          where: { propertyId, status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] }, departureDate: { gt: from }, arrivalDate: { lte: to } },
          select: { arrivalDate: true, departureDate: true, roomsCount: true, totalAmount: true, createdAt: true },
          take: RECOMMENDATION_MAX_RESERVATION_ROWS
        }),
        prisma.revenuePaceSnapshot.findMany({ where: { propertyId, captureDate, stayDate: { gte: from, lte: to } }, select: { stayDate: true, roomsOtb: true }, take: windowDays }),
        prisma.revenueForecast.findMany({
          where: { propertyId, forecastDate: { gte: from, lte: to } },
          select: { forecastDate: true, roomTypeId: true, ratePlanId: true, channelId: true, segment: true, expectedOccupancy: true, expectedRoomsSold: true, modelVersion: true },
          take: RECOMMENDATION_MAX_FORECAST_ROWS
        }),
        prisma.revenueDailySnapshot.findMany({
          where: { propertyId, ...TOP_LEVEL_SNAPSHOT_WHERE, snapshotDate: { gte: stlyFrom, lte: stlyTo } },
          select: { snapshotDate: true, totalOcc: true, occupancyPercent: true, adr: true, roomRevenue: true },
          take: windowDays
        }),
        compsetMedianByDate(propertyId, from, to),
        listDemandEventsInWindow(propertyId, isoDate(from), isoDate(to)),
        prisma.budget.findMany({ where: { propertyId, periodMonth: { in: [...budgetMonths] } }, select: { periodMonth: true, budgetedRoomRevenue: true }, take: Math.max(1, budgetMonths.size) }),
        prisma.pricingRule.findMany({ where: { propertyId, active: true }, orderBy: { priority: "asc" }, take: 200 }),
        prisma.barLevel.findMany({ where: { propertyId, active: true }, orderBy: { sortOrder: "asc" }, take: 100 }),
        ratePlan
          ? prisma.rateDay.findMany({
              where: { propertyId, ratePlanId: ratePlan.id, roomTypeId: { in: typeIds }, date: { gte: addDays(from, -DOW_LEARNING_SPAN_DAYS), lte: addDays(to, DOW_LEARNING_SPAN_DAYS) } },
              select: { roomTypeId: true, date: true, price: true, minPrice: true, maxPrice: true },
              take: Math.max(1, typeIds.length) * (windowDays + 2 * DOW_LEARNING_SPAN_DAYS)
            })
          : Promise.resolve([])
      ]);

  // OTB per day (live) and 7-day pickup (pace snapshot when captured, else reconstructed by createdAt).
  const otb = expand(reservations as ResRow[], from, addDays(to, 1));
  const paceByDate = new Map(paceRows.map((r) => [isoDate(dayUtc(r.stayDate)), r.roomsOtb]));
  const reconstructed = paceRows.length ? null : expand((reservations as ResRow[]).filter((r) => r.createdAt.getTime() < addDays(captureDate, 1).getTime()), from, addDays(to, 1));
  let propertyOtbRooms = 0;
  for (const b of otb.values()) propertyOtbRooms += b.rooms;
  const propertyOtbEmpty = propertyOtbRooms === 0;

  const forecast = normalizeForecastOcc(forecasts, totalRooms);
  const stlyByDate = new Map<string, { occPct: number | null; adr: number | null }>();
  for (const s of stlySnapshots) {
    const key = isoDate(addDays(dayUtc(s.snapshotDate), 364));
    const occ = decOrNull(s.occupancyPercent);
    const adr = decOrNull(s.adr);
    const rev = dec(s.roomRevenue);
    stlyByDate.set(key, {
      occPct: occ !== null ? round2(occ) : totalRooms > 0 ? round2((s.totalOcc / totalRooms) * 100) : null,
      adr: adr !== null ? round2(adr) : s.totalOcc > 0 ? round2(rev / s.totalOcc) : null
    });
  }
  const budgetByMonth = new Map<string, number>();
  for (const b of budgets) {
    const v = decOrNull(b.budgetedRoomRevenue);
    if (v !== null) budgetByMonth.set(b.periodMonth, v);
  }

  // Weekly shape: learned from the BAR grid (±182 days); STLY closes as fallback.
  const rateRows = wideRateDays.map((r) => ({ roomTypeId: r.roomTypeId, date: isoDate(dayUtc(r.date)), price: dec(r.price) }));
  let dowFactors = learnDowFactors(rateRows);
  let dowSource: "rate_days" | "stly_snapshots" | "none" = dowFactors.size ? "rate_days" : "none";
  if (!dowFactors.size && stlySnapshots.length) {
    const stlyRows = stlySnapshots
      .map((s) => ({ roomTypeId: "*", date: isoDate(dayUtc(s.snapshotDate)), price: decOrNull(s.adr) ?? 0 }))
      .filter((r) => r.price > 0);
    const shared = learnDowFactors(stlyRows, 7).get("*");
    if (shared) {
      dowFactors = new Map(typeIds.map((id) => [id, shared]));
      dowSource = "stly_snapshots";
    }
  }
  const barByTypeDate = new Map<string, { price: number; minPrice: number | null; maxPrice: number | null }>();
  for (const r of wideRateDays) {
    barByTypeDate.set(typeDateKey(r.roomTypeId, isoDate(dayUtc(r.date))), { price: dec(r.price), minPrice: decOrNull(r.minPrice), maxPrice: decOrNull(r.maxPrice) });
  }
  const weekMeanCache = new Map<string, number | null>();
  const weekMeanBar = (typeId: string, d: Date): number | null => {
    const start = weekStartUtc(d);
    const cacheKey = `${typeId}|${isoDate(start)}`;
    if (weekMeanCache.has(cacheKey)) return weekMeanCache.get(cacheKey) as number | null;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 7; i++) {
      const row = barByTypeDate.get(typeDateKey(typeId, isoDate(addDays(start, i))));
      if (row && row.price > 0) {
        sum += row.price;
        n++;
      }
    }
    const mean = n >= 4 ? round2(sum / n) : null; // a half-empty week is not a shape
    weekMeanCache.set(cacheKey, mean);
    return mean;
  };

  const pricingRules: PricingRuleSignal[] = rules.map((r) => ({
    name: r.name,
    minOccupancy: decOrNull(r.minOccupancy),
    maxOccupancy: decOrNull(r.maxOccupancy),
    adjustType: r.adjustType === "amount" ? "amount" : "percent",
    adjustValue: dec(r.adjustValue),
    minPrice: decOrNull(r.minPrice),
    maxPrice: decOrNull(r.maxPrice)
  }));
  const barLevels = levels.map((l) => ({ name: l.name, price: dec(l.price) }));
  const eventsAvailable = events.length > 0;

  const days: RateRecommendationsResponse["days"] = [];
  const leadRoomTypeIdByDate: Record<string, string | null> = {};
  for (let t = from.getTime(); t <= to.getTime(); t += MS_DAY) {
    const d = new Date(t);
    const key = isoDate(d);
    const daysOut = Math.round((t - today.getTime()) / MS_DAY);
    const bucket = otb.get(key);
    const otbRooms = bucket?.rooms ?? 0;
    const otbRevenue = bucket?.revenue ?? 0;
    const occPct = totalRooms > 0 ? round2((otbRooms / totalRooms) * 100) : 0;
    const prior = paceRows.length ? (paceByDate.get(key) ?? 0) : (reconstructed?.get(key)?.rooms ?? 0);
    const pickup7 = otbRooms - prior;
    const stly = stlyByDate.get(key);
    const comp = compset.byDate.get(key) ?? null;
    const dayEvents = events
      .filter((e) => e.startDate <= key && e.endDate >= key)
      .map((e) => ({ name: e.name, impact: e.expectedImpact ?? null }));
    const monthlyBudget = budgetByMonth.get(key.slice(0, 7));
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const budgetDay = monthlyBudget !== undefined ? monthlyBudget / daysInMonth : null;
    const budgetGapPct = budgetDay !== null && budgetDay > 0 ? round2(((otbRevenue - budgetDay) / budgetDay) * 100) : null;
    const leadBar = publishedBar.byDate.get(key) ?? null;
    const leadIds = leadRoomTypeIdsFor(publishedBar, key);
    leadRoomTypeIdByDate[key] = leadIds[0] ?? null;

    const byRoomType: RoomTypeBase[] = typeIds.map((typeId) => {
      const bar = publishedBar.byTypeDate.get(typeDateKey(typeId, key)) ?? null;
      const wide = barByTypeDate.get(typeDateKey(typeId, key));
      return {
        roomTypeId: typeId,
        bar,
        minPrice: wide?.minPrice ?? null,
        maxPrice: wide?.maxPrice ?? null,
        ladderFactor: bar !== null && leadBar !== null && leadBar > 0 ? round2(bar / leadBar) : null,
        dowFactor: dowFactors.get(typeId)?.[d.getUTCDay()] ?? null,
        weekMeanBar: weekMeanBar(typeId, d)
      };
    });

    const signals: DaySignals = {
      date: key,
      daysOut,
      dow: d.getUTCDay(),
      totalRooms,
      otbRooms,
      occPct,
      propertyOtbEmpty,
      fcOccPct: forecast.byDate.get(key) ?? null,
      fcSource: forecast.byDate.has(key) ? forecast.modelVersion : null,
      fcDeterministic: forecast.deterministic,
      stlyOccPct: stly?.occPct ?? null,
      stlyAdr: stly?.adr ?? null,
      pickup7,
      compsetMedian: comp?.median ?? null,
      compsetSource: comp?.source ?? null,
      events: dayEvents,
      eventsAvailable,
      budgetGapPct,
      byRoomType,
      pricingRules,
      barLevels
    };
    const demand: RateGridDemandDay & { budgetGapPct?: number | null } = {
      date: key,
      otbRooms,
      occPct,
      fcOccPct: signals.fcOccPct,
      fcSource: signals.fcSource,
      stlyOccPct: signals.stlyOccPct,
      stlyAdr: signals.stlyAdr,
      pickup7,
      compsetMedian: signals.compsetMedian,
      events: dayEvents,
      budgetGapPct
    };
    days.push({ date: key, daysOut, signals: demand, byRoomType: recommendForDay(signals, config) });
  }

  const sources: Record<string, string> = {
    bar: publishedBar.source,
    otb: propertyOtbEmpty ? "reservations (vacía)" : "reservations",
    forecast: forecast.modelVersion ?? "none",
    stly: stlySnapshots.length ? "snapshots (fecha−364)" : "none",
    pickup: paceRows.length ? "pace_snapshots" : "reconstruccion_createdAt",
    compset: compset.source ? `rate_shopper:${compset.source} (${compset.activeCompetitors} competidores activos)` : "none",
    events: eventsAvailable ? "demand_calendar" : "none",
    budget: budgetByMonth.size ? "budgets" : "none",
    dow: dowSource,
    rules: `pricing_rules:${pricingRules.length}, bar_levels:${barLevels.length}`,
    config: configSource
  };

  return {
    propertyId,
    ratePlanId: ratePlan?.id ?? "",
    from: isoDate(from),
    to: isoDate(to),
    generatedAt: new Date().toISOString(),
    sources,
    days,
    leadRoomTypeIdByDate,
    currency: property.currency,
    totalRooms,
    config
  };
}

// ---- board summary (one line per day for criticalDates) -------------------------------------
export type DayRecommendationSummary = {
  /** "BAR recomendada 112,00 € (actual 105,00 €) · Previsión 93 %" or "Mantener BAR 105,00 € (Δ −0,4 %)". */
  recommendation: string | null;
  /** Why there is no actionable recommendation ("sin BAR publicado", "datos insuficientes (sin previsión, sin compset)"). */
  recommendationMissing: string | null;
  compsetMedian: number | null;
  compsetMissing: string | null;
};

/** Pick the lead type (lowest current BAR) of a day and phrase its recommendation for the board. */
export function summarizeDayRecommendation(day: RateRecommendationsResponse["days"][number] | undefined, leadRoomTypeId?: string | null): DayRecommendationSummary {
  if (!day) {
    return { recommendation: null, recommendationMissing: "sin datos", compsetMedian: null, compsetMissing: "sin compset" };
  }
  const compsetMedian = day.signals.compsetMedian;
  const compsetMissing = compsetMedian === null ? "sin compset" : null;
  const withPrice = day.byRoomType.filter((r) => r.currentPrice !== null);
  const lead = (leadRoomTypeId && withPrice.find((r) => r.roomTypeId === leadRoomTypeId)) || withPrice.sort((a, b) => (a.currentPrice as number) - (b.currentPrice as number))[0];
  if (!lead || lead.currentPrice === null || lead.suggestedPrice === null) {
    return { recommendation: null, recommendationMissing: "sin BAR publicado", compsetMedian, compsetMissing };
  }
  const missingText = lead.missing.map(missingLabelEs).join(", ");
  if (lead.action === "hold" && lead.confidence < RMS_DEFAULTS.confidence.holdBelow) {
    return { recommendation: null, recommendationMissing: `datos insuficientes${missingText ? ` (${missingText})` : ""}`, compsetMedian, compsetMissing };
  }
  const topReason = lead.reasons.filter((r) => r.weight !== 0).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0];
  const why = topReason ? ` · ${topReason.label}` : "";
  if (lead.action === "hold") {
    return { recommendation: `Mantener BAR ${fmtMoney(lead.currentPrice)} € (Δ ${fmtPct(lead.deltaPct ?? 0)})`, recommendationMissing: null, compsetMedian, compsetMissing };
  }
  return {
    recommendation: `BAR recomendada ${fmtMoney(lead.suggestedPrice)} € (actual ${fmtMoney(lead.currentPrice)} €, ${fmtPct(lead.deltaPct ?? 0)})${why}`,
    recommendationMissing: null,
    compsetMedian,
    compsetMissing
  };
}
