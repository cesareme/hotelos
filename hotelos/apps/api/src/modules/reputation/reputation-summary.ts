// Reputación · Tanda T8 · lote T8-E — resumen PURO del dashboard de reputación
// (apps/api/src/modules/reputation/reputation-summary.ts).
//
// Recibe las filas de GuestReview (con `topicsJson` = ReviewMeta v1, leído con
// readReviewMeta) y las fuentes ya en forma de cable (ReviewSourceDto, sin
// credenciales) y devuelve TODO el contrato de `/dashboards/reputation`:
//
//   · bloque heredado (dashboards/reputation.service.ts:3-22 en 776782a):
//     kpis {avgRating sobre `rating` 1-5, reviewsLast7d/30d, pendingResponses,
//     sentimentScore}, ratingDistribution (estrellas), reviewsBySource y
//     recentReviews (ampliadas con score10/status/analysisSource);
//   · índice de reputación (computeReputationIndex, reputation-index.ts) a
//     30/90/365 días con tendencia (mismo conjunto evaluado hace 30 días);
//   · distribution10 sobre score10 (0-2 · 2-4 · 4-6 · 6-8 · 8-10);
//   · bySource: una entrada por código de fuente con estado honesto de la
//     ReviewSource (status/mode/lastRunAt/lastError) y su peso en el índice;
//   · categories: impacto por categoría (ventana `days`) o, sin índice, solo
//     menciones; responseRatePct y medianResponseHours de la ventana `days`;
//   · inbox: abiertas / fuera de plazo / con borrador / sin asignar (365 d);
//   · status global: no_sources | no_reviews | insufficient | ok.
//
// Fecha efectiva de una reseña: `receivedAt ?? createdAt` (las filas anteriores
// a T8-C no tienen receivedAt). La ventana `days` acota los KPI heredados,
// distribution10, bySource.count/avg10, categories, la tasa de respuesta y
// recentReviews; el índice usa sus propias ventanas (30/90/365) sobre todas las
// filas recibidas (el servicio carga 365 días).
//
// Función pura: sin Prisma, sin variables de entorno, sin red. La forma es un
// superconjunto de ReputationDashboardDto (reputation-types.ts) para que el
// front pueda leer cualquiera de los dos contratos.
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/reputation-summary.test.mts

import { computeReputationIndex, computeTrend, resolveReviewWeight, type IndexReviewInput } from "./reputation-index.js";
import {
  INDEX_WINDOWS,
  REVIEW_CATEGORY_LABELS_ES,
  REVIEW_OPEN_STATUSES,
  REVIEW_PROVIDER_LABELS_ES,
  baseProvider,
  isReviewOverdue,
  readReviewMeta,
  sentimentBucket,
  type AnalysisSource,
  type ReputationCategoryImpact,
  type ReputationDashboardLegacy,
  type ReputationIndexResult,
  type ReputationIndexStatus,
  type ReputationScoreDistribution,
  type ReviewCategory,
  type ReviewMeta,
  type ReviewSourceDto,
  type ReviewSourceMode,
  type ReviewSourceStatus,
  type ReviewStatus,
  type Sentiment,
  type TrendDirection
} from "./reputation-types.js";
import { round1, round2, score5ToScore10 } from "./review-normalize.js";

const MS_PER_DAY = 86_400_000;
export const SUMMARY_DEFAULT_DAYS = 30;
export const SUMMARY_RECENT_LIMIT = 10;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** Columnas de GuestReview que necesita el resumen (Date o ISO; Decimal, número o cadena en `rating`). */
export type SummaryReviewRow = {
  id: string;
  source: string;
  rating: unknown;
  title: string | null;
  body: string | null;
  topicsJson: unknown;
  createdAt: Date | string;
  receivedAt: Date | string | null;
  respondedAt: Date | string | null;
};

export type BuildReputationSummaryInput = {
  reviews: ReadonlyArray<SummaryReviewRow>;
  /** Fuentes de la propiedad en forma de cable (toReviewSourceDto); las `disabled` no cuentan para `no_sources`. */
  sources: ReadonlyArray<ReviewSourceDto>;
  now: Date;
  /** Ventana de los KPI heredados y del desglose (por defecto 30). */
  days?: number;
};

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/** Bloque `index`: el resultado a 30 días más los tres índices y la tendencia. */
export type ReputationIndexBlock = ReputationIndexResult & {
  index30?: number;
  index90?: number;
  index365?: number;
  reviewCount30: number;
  trendDelta?: number;
  trendDirection?: TrendDirection;
};

export type ReputationSummaryBySource = {
  /** Código guardado en GuestReview.source (`csv`, `booking_demo`…). */
  provider: string;
  sourceId: string | null;
  displayName: string;
  mode: ReviewSourceMode | null;
  /** Estado honesto de la ReviewSource; `null` si no hay fila para el código. */
  status: ReviewSourceStatus | null;
  weight: number | null;
  lastRunAt: string | null;
  lastError: string | null;
  /** Reseñas de la fuente en la ventana `days`. */
  count: number;
  /** Media simple de score10 en la ventana `days`. */
  avg10: number | null;
  /** Σw de la fuente / Σw total en el índice a 30 días (tras el tope del 60 %). */
  weightShare: number;
};

export type ReputationSummaryCategory = ReputationCategoryImpact & {
  label: string;
  /** Alias de negativeMentions. */
  negative: number;
};

export type ReputationSummaryRecentReview = ReputationDashboardLegacy["recentReviews"][number] & {
  provider: string;
  score10: number | null;
  sentiment: Sentiment | null;
  status: ReviewStatus;
  analysisSource: AnalysisSource;
  receivedAt: string;
  bodyPurged: boolean;
};

export type ReputationSummaryInbox = { open: number; overdue: number; drafted: number; unassigned: number };

export type ReputationSummary = Omit<ReputationDashboardLegacy, "recentReviews"> & {
  status: ReputationIndexStatus;
  windowDays: number;
  generatedAt: string;
  index: ReputationIndexBlock;
  /** Un resultado por ventana de INDEX_WINDOWS (30, 90, 365). */
  indexByWindow: ReputationIndexResult[];
  distribution10: ReputationScoreDistribution;
  /** Alias de distribution10 (nombre del DTO compartido). */
  scoreDistribution: ReputationScoreDistribution;
  bySource: ReputationSummaryBySource[];
  sources: ReviewSourceDto[];
  categories: ReputationSummaryCategory[];
  responseRatePct: number | null;
  medianResponseHours: number | null;
  inbox: ReputationSummaryInbox;
  recentReviews: ReputationSummaryRecentReview[];
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && "toNumber" in value && typeof (value as { toNumber: unknown }).toNumber === "function") {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Etiqueta de un código de fuente: displayName de su ReviewSource o el nombre del portal (+ «(demo)»). */
export function sourceLabelFor(code: string, sources: ReadonlyArray<Pick<ReviewSourceDto, "provider" | "displayName">>): string {
  const match = sources.find((source) => source.provider === code);
  if (match?.displayName) return match.displayName;
  const base = baseProvider(code);
  if (!base) return code;
  const label = REVIEW_PROVIDER_LABELS_ES[base];
  return base !== "demo" && code.trim().toLowerCase().endsWith("_demo") ? `${label} (demo)` : label;
}

/** Tramo de distribution10 para una nota sobre 10. */
export function distributionBucketFor(score10: number): keyof ReputationScoreDistribution {
  if (score10 < 2) return "b0_2";
  if (score10 < 4) return "b2_4";
  if (score10 < 6) return "b4_6";
  if (score10 < 8) return "b6_8";
  return "b8_10";
}

function emptyDistribution10(): ReputationScoreDistribution {
  return { b0_2: 0, b2_4: 0, b4_6: 0, b6_8: 0, b8_10: 0 };
}

function emptyIndex(windowDays: number, status: ReputationIndexStatus, computedAt: string): ReputationIndexResult {
  return { status, windowDays, reviewCount: 0, bySource: [], categoryImpact: [], computedAt };
}

type Enriched = {
  row: SummaryReviewRow;
  meta: ReviewMeta;
  rating: number | null;
  score10: number | null;
  receivedMs: number;
  respondedMs: number | null;
};

// ---------------------------------------------------------------------------
// Resumen vacío (sin propiedad o sin nada que contar)
// ---------------------------------------------------------------------------

/** Resumen con todos los contadores a 0, el `status` indicado y las fuentes dadas. */
export function emptyReputationSummary(input: { now: Date; days?: number; status: ReputationIndexStatus; sources?: ReadonlyArray<ReviewSourceDto> }): ReputationSummary {
  const days = normalizeDays(input.days);
  const computedAt = input.now.toISOString();
  const sources = [...(input.sources ?? [])];
  const distribution = emptyDistribution10();
  return {
    kpis: { avgRating: 0, reviewsLast7d: 0, reviewsLast30d: 0, pendingResponses: 0, sentimentScore: 0 },
    ratingDistribution: { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 },
    reviewsBySource: [],
    status: input.status,
    windowDays: days,
    generatedAt: computedAt,
    index: { ...emptyIndex(INDEX_WINDOWS[0], input.status, computedAt), reviewCount30: 0 },
    indexByWindow: INDEX_WINDOWS.map((windowDays) => emptyIndex(windowDays, input.status, computedAt)),
    distribution10: distribution,
    scoreDistribution: distribution,
    bySource: sources.map((source) => bySourceEntry(source.provider, source, undefined, 0)),
    sources,
    categories: [],
    responseRatePct: null,
    medianResponseHours: null,
    inbox: { open: 0, overdue: 0, drafted: 0, unassigned: 0 },
    recentReviews: []
  };
}

function normalizeDays(days: number | undefined): number {
  return typeof days === "number" && Number.isFinite(days) && days > 0 ? Math.floor(days) : SUMMARY_DEFAULT_DAYS;
}

function bySourceEntry(
  code: string,
  source: ReviewSourceDto | undefined,
  aggregate: { count: number; sum: number; scored: number } | undefined,
  weightShare: number
): ReputationSummaryBySource {
  return {
    provider: code,
    sourceId: source?.id ?? null,
    displayName: source?.displayName ?? sourceLabelFor(code, []),
    mode: source?.mode ?? null,
    status: source?.status ?? null,
    weight: source?.weight ?? null,
    lastRunAt: source?.lastRunAt ?? null,
    lastError: source?.lastError ?? null,
    count: aggregate?.count ?? 0,
    avg10: aggregate && aggregate.scored > 0 ? round2(aggregate.sum / aggregate.scored) : null,
    weightShare
  };
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

/** Construye el contrato completo de `/dashboards/reputation` (ver cabecera). */
export function buildReputationSummary(input: BuildReputationSummaryInput): ReputationSummary {
  const days = normalizeDays(input.days);
  const now = input.now;
  const nowMs = now.getTime();
  const computedAt = now.toISOString();
  const sinceMs = nowMs - days * MS_PER_DAY;
  const since7Ms = nowMs - 7 * MS_PER_DAY;
  const since30Ms = nowMs - 30 * MS_PER_DAY;
  const sources = [...input.sources];
  const activeSources = sources.filter((source) => source.status !== "disabled");

  // Filas enriquecidas (fecha efectiva receivedAt ?? createdAt), sin las futuras, más recientes primero.
  const rows: Enriched[] = [];
  for (const row of input.reviews) {
    const receivedMs = toTime(row.receivedAt) ?? toTime(row.createdAt);
    if (receivedMs === null || receivedMs > nowMs) continue;
    const meta = readReviewMeta(row.topicsJson);
    const rating = toNumber(row.rating);
    const score10 = typeof meta.score10 === "number" && Number.isFinite(meta.score10) ? meta.score10 : score5ToScore10(rating);
    rows.push({ row, meta, rating, score10, receivedMs, respondedMs: toTime(row.respondedAt) });
  }
  rows.sort((a, b) => b.receivedMs - a.receivedMs || a.row.id.localeCompare(b.row.id));

  // --- Índice 30/90/365 + tendencia (todas las filas; cada ventana filtra la suya).
  // Peso por la fuente que trajo la reseña (meta.sourceId) y, si no, por proveedor base (resolveReviewWeight, reputation-index.ts).
  const indexReviews: IndexReviewInput[] = rows.map((entry) => ({
    score10: entry.score10,
    receivedAt: new Date(entry.receivedMs),
    source: entry.row.source,
    weight: resolveReviewWeight({ source: entry.row.source, sourceId: entry.meta.sourceId ?? null }, activeSources),
    categories: entry.meta.categories,
    respondedAt: entry.respondedMs === null ? null : new Date(entry.respondedMs),
    replyCapability: entry.meta.replyCapability
  }));
  const sourceWeights: Record<string, number> = {};
  for (const source of activeSources) if (!(source.provider in sourceWeights)) sourceWeights[source.provider] = source.weight;
  // Sin fuentes activas el índice no se calcula (como getReputationSnapshot):
  // todas las ventanas quedan vacías con `no_sources` y los KPI heredados
  // siguen siendo honestos con lo que haya. Con fuentes, cada ventana filtra
  // la suya y la tendencia compara con el mismo conjunto hace 30 días.
  const noSources = activeSources.length === 0;
  const compute = (windowDays: number, at: Date): ReputationIndexResult =>
    noSources ? emptyIndex(windowDays, "no_sources", at.toISOString()) : computeReputationIndex({ reviews: indexReviews, sourceWeights, now: at, windowDays });
  const [w30, w90, w365] = INDEX_WINDOWS;
  const index30 = compute(w30, now);
  const index90 = compute(w90, now);
  const index365 = compute(w365, now);
  const before = compute(w30, new Date(nowMs - w30 * MS_PER_DAY));
  const trend = computeTrend(index30.index, before.index);
  const indexForDays = days === w30 ? index30 : days === w90 ? index90 : days === w365 ? index365 : compute(days, now);

  // Estado global: sin fuentes activas `no_sources`; si no, el de la ventana a 30 días.
  const status: ReputationIndexStatus = index30.status;

  // --- KPI heredados sobre la ventana `days`.
  const inWindow = rows.filter((entry) => entry.receivedMs > sinceMs);
  const ratings: number[] = [];
  const ratingDistribution = { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 };
  const distribution10 = emptyDistribution10();
  let pendingResponses = 0;
  const legacyBySource = new Map<string, { count: number; ratingSum: number; ratingCount: number }>();
  const windowBySource = new Map<string, { count: number; sum: number; scored: number }>();
  // Código sin fila ReviewSource propia (p. ej. `tripadvisor` traído por una fuente `email`): fuente que lo produjo, por sourceId.
  const producerByCode = new Map<string, ReviewSourceDto | null>();
  const categoryMentions = new Map<ReviewCategory, { mentions: number; negative: number }>();

  for (const entry of inWindow) {
    if (entry.rating !== null) {
      ratings.push(entry.rating);
      const star = Math.max(1, Math.min(5, Math.round(entry.rating)));
      if (star === 1) ratingDistribution.star1 += 1;
      else if (star === 2) ratingDistribution.star2 += 1;
      else if (star === 3) ratingDistribution.star3 += 1;
      else if (star === 4) ratingDistribution.star4 += 1;
      else ratingDistribution.star5 += 1;
      if (entry.respondedMs === null) pendingResponses += 1;
    }
    if (entry.score10 !== null) distribution10[distributionBucketFor(entry.score10)] += 1;

    const code = entry.row.source || "unknown";
    const legacy = legacyBySource.get(code) ?? { count: 0, ratingSum: 0, ratingCount: 0 };
    legacy.count += 1;
    if (entry.rating !== null) {
      legacy.ratingSum += entry.rating;
      legacy.ratingCount += 1;
    }
    legacyBySource.set(code, legacy);
    const window = windowBySource.get(code) ?? { count: 0, sum: 0, scored: 0 };
    window.count += 1;
    if (entry.score10 !== null) {
      window.sum += entry.score10;
      window.scored += 1;
    }
    windowBySource.set(code, window);
    if (!sources.some((source) => source.provider === code)) {
      const producer = entry.meta.sourceId ? (sources.find((source) => source.id === entry.meta.sourceId) ?? null) : null;
      const known = producerByCode.get(code);
      if (known === undefined) producerByCode.set(code, producer);
      else if (known !== null && known.id !== producer?.id) producerByCode.set(code, null);
    }

    // Menciones por categoría (una por reseña y categoría; negativa si alguna mención lo es).
    if (entry.score10 !== null) {
      const seen = new Set<ReviewCategory>();
      const negative = new Set<ReviewCategory>();
      for (const mention of entry.meta.categories) {
        seen.add(mention.category);
        if (mention.sentiment < 0) negative.add(mention.category);
      }
      for (const category of seen) {
        const bucket = categoryMentions.get(category) ?? { mentions: 0, negative: 0 };
        bucket.mentions += 1;
        if (negative.has(category)) bucket.negative += 1;
        categoryMentions.set(category, bucket);
      }
    }
  }

  const avgRating = ratings.length > 0 ? round1(ratings.reduce((total, value) => total + value, 0) / ratings.length) : 0;
  const sentimentScore = ratings.length > 0 ? round2((avgRating - 3) / 2) : 0;
  const reviewsLast7d = rows.filter((entry) => entry.receivedMs > since7Ms).length;
  const reviewsLast30d = rows.filter((entry) => entry.receivedMs > since30Ms).length;

  const reviewsBySource = [...legacyBySource.entries()]
    .map(([code, aggregate]) => ({
      sourceName: sourceLabelFor(code, sources),
      count: aggregate.count,
      avgRating: aggregate.ratingCount > 0 ? round1(aggregate.ratingSum / aggregate.ratingCount) : 0
    }))
    .sort((a, b) => b.count - a.count || a.sourceName.localeCompare(b.sourceName));

  // --- bySource: fuentes conocidas (en su orden) + códigos con reseñas sin fila de fuente.
  const shareByCode = new Map(index30.bySource.map((entry) => [entry.provider, entry.weightShare]));
  const seenCodes = new Set<string>();
  const bySource: ReputationSummaryBySource[] = [];
  for (const source of sources) {
    if (seenCodes.has(source.provider)) continue;
    seenCodes.add(source.provider);
    bySource.push(bySourceEntry(source.provider, source, windowBySource.get(source.provider), shareByCode.get(source.provider) ?? 0));
  }
  for (const code of windowBySource.keys()) {
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);
    // Sin fila propia: estado, modo, peso y última ejecución de la fuente que trajo TODAS sus reseñas (si es una sola); la etiqueta sigue siendo la del portal.
    const producer = producerByCode.get(code) ?? undefined;
    bySource.push(bySourceEntry(code, producer ? { ...producer, provider: code, displayName: sourceLabelFor(code, []) } : undefined, windowBySource.get(code), shareByCode.get(code) ?? 0));
  }

  // --- Categorías: impacto del índice de la ventana `days` si existe; si no, solo menciones.
  const categories: ReputationSummaryCategory[] =
    indexForDays.status === "ok"
      ? indexForDays.categoryImpact.map((impact) => ({ ...impact, label: REVIEW_CATEGORY_LABELS_ES[impact.category], negative: impact.negativeMentions }))
      : [...categoryMentions.entries()]
          .map(([category, bucket]) => ({ category, label: REVIEW_CATEGORY_LABELS_ES[category], mentions: bucket.mentions, negativeMentions: bucket.negative, negative: bucket.negative, impact: 0 }))
          .sort((a, b) => b.negative - a.negative || b.mentions - a.mentions || a.category.localeCompare(b.category));

  // --- Bandeja (todas las filas cargadas).
  const inbox: ReputationSummaryInbox = { open: 0, overdue: 0, drafted: 0, unassigned: 0 };
  for (const entry of rows) {
    const open = (REVIEW_OPEN_STATUSES as readonly string[]).includes(entry.meta.status);
    if (open) inbox.open += 1;
    if (isReviewOverdue(entry.meta, now)) inbox.overdue += 1;
    if (entry.meta.status === "drafted") inbox.drafted += 1;
    if (open && !entry.meta.assignedUserId) inbox.unassigned += 1;
  }

  const recentReviews: ReputationSummaryRecentReview[] = inWindow.slice(0, SUMMARY_RECENT_LIMIT).map((entry) => ({
    id: entry.row.id,
    sourceName: sourceLabelFor(entry.row.source || "unknown", sources),
    provider: entry.row.source,
    ratingValue: entry.rating ?? undefined,
    title: entry.row.title ?? undefined,
    body: entry.row.body ?? undefined,
    createdAt: iso(toTime(entry.row.createdAt) ?? entry.receivedMs),
    respondedAt: entry.respondedMs === null ? undefined : iso(entry.respondedMs),
    receivedAt: iso(entry.receivedMs),
    score10: entry.score10,
    sentiment: sentimentBucket(entry.score10),
    status: entry.meta.status,
    analysisSource: entry.meta.analysis.source,
    bodyPurged: Boolean(entry.meta.bodyPurgedAt)
  }));

  const index: ReputationIndexBlock = {
    ...index30,
    ...(trend.delta !== null ? { trendDelta: trend.delta } : {}),
    ...(trend.direction ? { trendDirection: trend.direction } : {}),
    ...(index30.index !== undefined ? { index30: index30.index } : {}),
    ...(index90.index !== undefined ? { index90: index90.index } : {}),
    ...(index365.index !== undefined ? { index365: index365.index } : {}),
    reviewCount30: index30.reviewCount
  };

  return {
    kpis: { avgRating, reviewsLast7d, reviewsLast30d, pendingResponses, sentimentScore },
    ratingDistribution,
    reviewsBySource,
    status,
    windowDays: days,
    generatedAt: computedAt,
    index,
    indexByWindow: [index30, index90, index365],
    distribution10,
    scoreDistribution: distribution10,
    bySource,
    sources,
    categories,
    responseRatePct: indexForDays.responseRatePct ?? null,
    medianResponseHours: indexForDays.medianResponseHours ?? null,
    inbox,
    recentReviews
  };
}
