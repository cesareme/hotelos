// Reputación · Tanda T8 · lote T8-B — Índice de Reputación ehotelOS (IRE)
// (apps/api/src/modules/reputation/reputation-index.ts).
//
// Metodología (docs/design/REPUTACION-REVIEWS.md §5.1, l.161-172):
//   · universo: reseñas con score10 ≠ null y receivedAt ∈ (now − W, now];
//   · peso w = 0,5^(edad_días / (W/2)) × p(fuente), p = 1 por defecto
//     (editable por fuente, 0,1-2). p se resuelve en este orden: `weight` ya
//     resuelto por el llamador (por ReviewSource.id de la meta), sourceWeights
//     por el código exacto de GuestReview.source, sourceWeights por el proveedor
//     base del código (`tripadvisor` para una reseña llegada por una fuente
//     genérica `email`: la fuente se apunta por sourceId, no por código) y, si
//     no, 1;
//   · tope por portal: si la fuente dominante supera el 60 % de Σw, sus
//     pesos se reescalan por k = (0,6·S_o) / (0,4·S_f); no aplica con una sola
//     fuente; se aplica una vez, a la dominante;
//   · index = round1(10 × Σ(w·score10) / Σw), escala 0-100;
//   · < INDEX_MIN_REVIEWS (10) reseñas → `insufficient` con reviewCount;
//     0 → `no_reviews`;
//   · bySource {provider, count, avg10 (media simple), weightShare tras tope};
//   · categoryImpact_c = index(sin reseñas con mención negativa en c) − index;
//   · responseRatePct y medianResponseHours sobre respondedAt − receivedAt;
//   · computeTrend: delta con banda ±TREND_BAND; computeOrgComparison: media,
//     ranking y relativeIndex (100 = fair share) solo con status ok.
//
// Función pura: sin Prisma, sin variables de entorno, sin red.
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/reputation-index.test.mts

import {
  INDEX_MIN_REVIEWS,
  REVIEW_CATEGORIES,
  SOURCE_WEIGHT_CAP,
  SOURCE_WEIGHT_DEFAULT,
  SOURCE_WEIGHT_MAX,
  SOURCE_WEIGHT_MIN,
  baseProvider,
  trendDirectionFor,
  type CategoryMention,
  type ReputationCategoryImpact,
  type ReputationIndexBySource,
  type ReputationIndexResult,
  type ReviewCategory,
  type TrendDirection
} from "./reputation-types.js";
import { round1, round2 } from "./review-normalize.js";

const MS_PER_DAY = 86_400_000;

export type IndexReviewInput = {
  score10: number | null | undefined;
  receivedAt: string | Date;
  /** Código de fuente (`google`, `booking_demo`…); agrupa el desglose y el tope. */
  source: string;
  /**
   * Peso de la fuente ya resuelto por el llamador (0,1-2; p. ej. por `meta.sourceId`
   * → ReviewSource.configJson.weight). Tiene prioridad sobre `sourceWeights`.
   */
  weight?: number;
  categories?: ReadonlyArray<Pick<CategoryMention, "category" | "sentiment">>;
  respondedAt?: string | Date | null;
  /** `false` excluye la reseña del denominador de la tasa de respuesta. */
  replyCapability?: boolean;
};

export type ComputeReputationIndexInput = {
  reviews: ReadonlyArray<IndexReviewInput>;
  /** Peso por fuente (0,1-2); ausente → 1. */
  sourceWeights?: Readonly<Record<string, number>>;
  now: Date;
  windowDays: number;
};

type Weighted = {
  score10: number;
  source: string;
  weight: number;
  negativeCategories: ReadonlySet<ReviewCategory>;
  allCategories: ReadonlySet<ReviewCategory>;
};

function toTime(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampWeight(raw: number): number {
  return Math.min(SOURCE_WEIGHT_MAX, Math.max(SOURCE_WEIGHT_MIN, raw));
}

/**
 * Peso de una reseña: `review.weight` (resuelto por sourceId) → sourceWeights[código]
 * → sourceWeights[proveedor base del código] → 1. Exportado para los tests.
 */
export function reviewWeight(review: Pick<IndexReviewInput, "source" | "weight">, weights: Readonly<Record<string, number>> | undefined): number {
  if (typeof review.weight === "number" && Number.isFinite(review.weight)) return clampWeight(review.weight);
  const exact = weights?.[review.source];
  if (typeof exact === "number" && Number.isFinite(exact)) return clampWeight(exact);
  const base = baseProvider(review.source);
  const byBase = base ? weights?.[base] : undefined;
  if (typeof byBase === "number" && Number.isFinite(byBase)) return clampWeight(byBase);
  return SOURCE_WEIGHT_DEFAULT;
}

/**
 * Peso de una reseña según la fuente que la trajo: por `sourceId` (ReviewSource.id)
 * y, si no hay fila, por el proveedor base de `source` (la fuente activa más
 * ligera si hay varias del mismo proveedor); 1 por defecto. Exportado para
 * reputation-score.service.ts, reputation-summary.ts y los tests.
 */
export function resolveReviewWeight(
  review: { source: string; sourceId?: string | null },
  sources: ReadonlyArray<{ id: string; provider: string; weight: number }>
): number {
  if (review.sourceId) {
    const own = sources.find((entry) => entry.id === review.sourceId);
    if (own) return own.weight;
  }
  const exact = sources.find((entry) => entry.provider === review.source);
  if (exact) return exact.weight;
  const base = baseProvider(review.source);
  const byBase = base ? sources.filter((entry) => baseProvider(entry.provider) === base) : [];
  if (byBase.length > 0) return Math.min(...byBase.map((entry) => entry.weight));
  return SOURCE_WEIGHT_DEFAULT;
}

/** Peso de recencia: semivida W/2 días. */
export function recencyWeight(ageDays: number, windowDays: number): number {
  return Math.pow(0.5, ageDays / (windowDays / 2));
}

/**
 * Aplica el tope del 60 % a la fuente dominante (solo con ≥ 2 fuentes).
 * Devuelve los pesos ya reescalados y el factor k aplicado (1 si no aplica).
 */
export function applySourceCap(items: ReadonlyArray<Weighted>): { items: Weighted[]; cappedSource: string | null; k: number } {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.source, (totals.get(item.source) ?? 0) + item.weight);
  if (totals.size < 2) return { items: [...items], cappedSource: null, k: 1 };
  let dominant: string | null = null;
  let dominantSum = 0;
  let total = 0;
  for (const [source, sum] of totals) {
    total += sum;
    if (sum > dominantSum) {
      dominant = source;
      dominantSum = sum;
    }
  }
  if (!dominant || total <= 0 || dominantSum / total <= SOURCE_WEIGHT_CAP) return { items: [...items], cappedSource: null, k: 1 };
  const others = total - dominantSum;
  const k = (SOURCE_WEIGHT_CAP * others) / ((1 - SOURCE_WEIGHT_CAP) * dominantSum);
  return {
    items: items.map((item) => (item.source === dominant ? { ...item, weight: item.weight * k } : item)),
    cappedSource: dominant,
    k
  };
}

/** Índice 0-100 a 1 decimal de un conjunto ya ponderado (con tope); `null` si Σw = 0. */
function weightedIndex(items: ReadonlyArray<Weighted>): number | null {
  const capped = applySourceCap(items).items;
  let sumWeights = 0;
  let sumScores = 0;
  for (const item of capped) {
    sumWeights += item.weight;
    sumScores += item.weight * item.score10;
  }
  if (sumWeights <= 0) return null;
  return round1((10 * sumScores) / sumWeights);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 : (sorted[middle] as number);
}

/** Calcula el IRE de una ventana según §5.1 (ver cabecera). */
export function computeReputationIndex(input: ComputeReputationIndexInput): ReputationIndexResult {
  const { reviews, sourceWeights, now, windowDays } = input;
  const nowMs = now.getTime();
  const windowMs = windowDays * MS_PER_DAY;
  const computedAt = now.toISOString();

  // Ventana: (now − W, now]. Se aplica a todas las reseñas (con o sin nota)
  // para la tasa de respuesta; el índice solo usa las que tienen score10.
  const inWindow: Array<{ review: IndexReviewInput; receivedMs: number }> = [];
  for (const review of reviews) {
    const receivedMs = toTime(review.receivedAt);
    if (receivedMs === null) continue;
    if (receivedMs > nowMs || receivedMs <= nowMs - windowMs) continue;
    inWindow.push({ review, receivedMs });
  }

  const weighted: Weighted[] = [];
  const perSource = new Map<string, { count: number; sum: number; rawWeight: number }>();
  for (const { review, receivedMs } of inWindow) {
    const score10 = review.score10;
    if (typeof score10 !== "number" || !Number.isFinite(score10)) continue;
    const ageDays = (nowMs - receivedMs) / MS_PER_DAY;
    const weight = recencyWeight(ageDays, windowDays) * reviewWeight(review, sourceWeights);
    const negativeCategories = new Set<ReviewCategory>();
    const allCategories = new Set<ReviewCategory>();
    for (const mention of review.categories ?? []) {
      allCategories.add(mention.category);
      if (mention.sentiment < 0) negativeCategories.add(mention.category);
    }
    weighted.push({ score10: Math.min(10, Math.max(0, score10)), source: review.source, weight, negativeCategories, allCategories });
    const bucket = perSource.get(review.source) ?? { count: 0, sum: 0, rawWeight: 0 };
    bucket.count += 1;
    bucket.sum += score10;
    bucket.rawWeight += weight;
    perSource.set(review.source, bucket);
  }

  // Respuesta: respondibles = replyCapability ≠ false; respondidas = respondedAt.
  const responseHours: number[] = [];
  let respondable = 0;
  let responded = 0;
  for (const { review, receivedMs } of inWindow) {
    if (review.replyCapability === false) continue;
    respondable += 1;
    const respondedMs = toTime(review.respondedAt);
    if (respondedMs === null) continue;
    responded += 1;
    responseHours.push(Math.max(0, (respondedMs - receivedMs) / 3_600_000));
  }
  const responseRatePct = respondable > 0 ? round1((100 * responded) / respondable) : undefined;
  const medianHours = median(responseHours);
  const medianResponseHours = medianHours === null ? undefined : round1(medianHours);

  const reviewCount = weighted.length;
  const cap = applySourceCap(weighted);
  const cappedTotal = cap.items.reduce((total, item) => total + item.weight, 0);
  const cappedBySource = new Map<string, number>();
  for (const item of cap.items) cappedBySource.set(item.source, (cappedBySource.get(item.source) ?? 0) + item.weight);
  const bySource: ReputationIndexBySource[] = [...perSource.entries()]
    .map(([provider, bucket]) => ({
      provider,
      count: bucket.count,
      avg10: bucket.count > 0 ? round2(bucket.sum / bucket.count) : null,
      weightShare: cappedTotal > 0 ? Math.round(((cappedBySource.get(provider) ?? 0) / cappedTotal) * 10_000) / 10_000 : 0
    }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));

  const base = {
    windowDays,
    reviewCount,
    bySource,
    ...(responseRatePct !== undefined ? { responseRatePct } : {}),
    ...(medianResponseHours !== undefined ? { medianResponseHours } : {}),
    computedAt
  };

  if (reviewCount === 0) return { status: "no_reviews", ...base, categoryImpact: [] };
  if (reviewCount < INDEX_MIN_REVIEWS) return { status: "insufficient", ...base, categoryImpact: [] };

  const index = weightedIndex(weighted);
  if (index === null) return { status: "insufficient", ...base, categoryImpact: [] };

  const categoryImpact: ReputationCategoryImpact[] = [];
  for (const category of REVIEW_CATEGORIES) {
    const mentions = weighted.filter((item) => item.allCategories.has(category)).length;
    if (mentions === 0) continue;
    const negativeMentions = weighted.filter((item) => item.negativeCategories.has(category)).length;
    let impact = 0;
    if (negativeMentions > 0) {
      const without = weighted.filter((item) => !item.negativeCategories.has(category));
      const indexWithout = weightedIndex(without);
      impact = indexWithout === null ? 0 : Math.max(0, round1(indexWithout - index));
    }
    categoryImpact.push({ category, mentions, negativeMentions, impact });
  }
  categoryImpact.sort((a, b) => b.impact - a.impact || b.negativeMentions - a.negativeMentions || a.category.localeCompare(b.category));

  return { status: "ok", ...base, index, categoryImpact };
}

export type TrendResult = {
  delta: number | null;
  direction: TrendDirection | null;
};

/** Tendencia entre dos índices (banda ±TREND_BAND → `flat`); `null` sin dato. */
export function computeTrend(indexNow: number | null | undefined, indexBefore: number | null | undefined): TrendResult {
  if (typeof indexNow !== "number" || !Number.isFinite(indexNow) || typeof indexBefore !== "number" || !Number.isFinite(indexBefore)) {
    return { delta: null, direction: null };
  }
  const delta = round1(indexNow - indexBefore);
  return { delta, direction: trendDirectionFor(delta) };
}

export type OrgComparisonInput = {
  propertyId: string;
  status: ReputationIndexResult["status"];
  index?: number | null;
  /** `hotel` | `office` | `other`; solo `hotel` entra (ausente → entra). */
  kind?: string | null;
};

export type OrgComparisonEntry = {
  propertyId: string;
  index: number;
  /** 1 = mejor índice. */
  rank: number;
  /** index / media × 100 (100 = fair share). */
  relativeIndex: number;
};

export type OrgComparisonResult = {
  orgAverage: number | null;
  /** Propiedades que entran en la comparativa (status ok y kind hotel). */
  orgSize: number;
  entries: OrgComparisonEntry[];
};

/** Comparativa de la organización: media simple, ranking y relativeIndex. */
export function computeOrgComparison(indices: ReadonlyArray<OrgComparisonInput>): OrgComparisonResult {
  const eligible = indices.filter(
    (entry): entry is OrgComparisonInput & { index: number } =>
      entry.status === "ok" && typeof entry.index === "number" && Number.isFinite(entry.index) && (entry.kind === undefined || entry.kind === null || entry.kind === "hotel")
  );
  if (eligible.length === 0) return { orgAverage: null, orgSize: 0, entries: [] };
  const orgAverage = round1(eligible.reduce((total, entry) => total + entry.index, 0) / eligible.length);
  const sorted = [...eligible].sort((a, b) => b.index - a.index || a.propertyId.localeCompare(b.propertyId));
  const entries: OrgComparisonEntry[] = [];
  let rank = 0;
  let previousIndex: number | null = null;
  sorted.forEach((entry, position) => {
    if (previousIndex === null || entry.index !== previousIndex) rank = position + 1;
    previousIndex = entry.index;
    entries.push({
      propertyId: entry.propertyId,
      index: entry.index,
      rank,
      relativeIndex: orgAverage > 0 ? round1((entry.index / orgAverage) * 100) : 0
    });
  });
  return { orgAverage, orgSize: eligible.length, entries };
}
