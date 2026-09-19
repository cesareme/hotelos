// Reputación · Tanda T8 · lote T8-C — índice de reputación sobre las tablas
// existentes (apps/api/src/modules/reputation/reputation-score.service.ts).
//
// Carga las reseñas de los últimos 365 días (rating, receivedAt, source,
// respondedAt, topicsJson) y los pesos por fuente (ReviewSource.configJson.weight)
// y delega en computeReputationIndex (reputation-index.ts, puro). El peso de
// cada reseña se resuelve por `meta.sourceId` (la fuente que la trajo: una fuente
// genérica `email` guarda en GuestReview.source el portal real, p. ej.
// `tripadvisor`) y, si no, por el proveedor base de GuestReview.source; nunca
// se indexa solo por ReviewSource.provider (dos fuentes del mismo proveedor no
// se pisan). Hasta que se
// aplique el parche T8-L0 no existe la tabla reputation_daily_scores: el índice
// se calcula al vuelo con caché en memoria de 60 s por propiedad y `staleDays` es
// siempre 0. detectSchemaPatch() consulta to_regclass de las 3 tablas nuevas
// (caché 10 min) y lo expone como `schemaPatchApplied` (hoy false); el store de
// tabla se añade al aplicar el parche.
//
// Reglas:
//   · NUNCA lanza en un tenant vacío ni con el módulo apagado
//     (l2-robustez.test.mts:403-411 pina degraded=[] en el director): el módulo
//     se comprueba ANTES de cualquier consulta con getEnabledModuleCodes
//     (product-modules.service.ts:277, síncrono sobre el espejo) y cualquier
//     error de lectura se devuelve como snapshot degradado;
//   · `db` inyectable; `isModuleEnabled` inyectable (tests con stubs);
//   · sin variables de entorno; sin red.

import { prisma } from "@hotelos/database";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { REPUTATION_MODULE_CODE } from "./reputation-context.js";
import { computeReputationIndex, computeTrend, resolveReviewWeight, type IndexReviewInput } from "./reputation-index.js";
import { INDEX_WINDOWS, type ReputationIndexResult, type ReputationIndexStatus, type ReputationIndexWindow, type TrendDirection } from "./reputation-types.js";
import { getReviewMeta, listSourceConfigs, scoreOfRow, type ReputationDb, type SourceConfigEntry } from "./review-meta.store.js";

const MS_PER_DAY = 86_400_000;
export const REPUTATION_CACHE_TTL_MS = 60_000;
export const SCHEMA_PATCH_CACHE_TTL_MS = 600_000;
/** Ventana de carga: el índice a 365 días es la mayor de INDEX_WINDOWS. */
export const REPUTATION_LOAD_WINDOW_DAYS = 365;
/** Tope de filas cargadas por propiedad (hasta el índice [propertyId, receivedAt] de T8-L0). */
export const REPUTATION_LOAD_LIMIT = 5_000;

export type IndexInputs = {
  reviews: IndexReviewInput[];
  /** Peso por código de proveedor (respaldo cuando la reseña no apunta a una fuente por sourceId). */
  sourceWeights: Record<string, number>;
  sources: SourceConfigEntry[];
};


/** Reseñas de la propiedad (365 d) y pesos por fuente en la forma que espera computeReputationIndex. */
export async function loadIndexInputs(input: { db?: ReputationDb; propertyId: string; now: Date; sinceDays?: number }): Promise<IndexInputs> {
  const db = input.db ?? prisma;
  const sinceDays = input.sinceDays ?? REPUTATION_LOAD_WINDOW_DAYS;
  const since = new Date(input.now.getTime() - sinceDays * MS_PER_DAY);
  const [rows, sources] = await Promise.all([
    db.guestReview.findMany({
      where: { propertyId: input.propertyId, receivedAt: { gte: since } },
      select: { id: true, rating: true, receivedAt: true, source: true, respondedAt: true, topicsJson: true },
      orderBy: { receivedAt: "desc" },
      take: REPUTATION_LOAD_LIMIT
    }),
    listSourceConfigs({ db, propertyId: input.propertyId })
  ]);
  // Respaldo por código (la primera fuente de cada proveedor: dos fuentes del mismo proveedor no se pisan; el peso real va por sourceId).
  const sourceWeights: Record<string, number> = {};
  for (const entry of sources) if (!(entry.row.provider in sourceWeights)) sourceWeights[entry.row.provider] = entry.config.weight;
  const weightSources = sources.map((entry) => ({ id: entry.row.id, provider: entry.row.provider, weight: entry.config.weight }));
  const reviews: IndexReviewInput[] = [];
  for (const row of rows) {
    if (!row.receivedAt) continue;
    const meta = getReviewMeta(row);
    reviews.push({
      score10: scoreOfRow(row, meta),
      receivedAt: row.receivedAt,
      source: row.source,
      weight: resolveReviewWeight({ source: row.source, sourceId: meta.sourceId ?? null }, weightSources),
      categories: meta.categories,
      respondedAt: row.respondedAt,
      replyCapability: meta.replyCapability
    });
  }
  return { reviews, sourceWeights, sources };
}

/** Índice para una ventana (30/90/365) calculado al vuelo. */
export async function getReputationIndex(input: { db?: ReputationDb; propertyId: string; now: Date; windowDays: ReputationIndexWindow | number }): Promise<ReputationIndexResult> {
  const inputs = await loadIndexInputs({ ...(input.db ? { db: input.db } : {}), propertyId: input.propertyId, now: input.now });
  return computeReputationIndex({ reviews: inputs.reviews, sourceWeights: inputs.sourceWeights, now: input.now, windowDays: input.windowDays });
}

export type ReputationSnapshot = {
  propertyId: string;
  status: ReputationIndexStatus;
  index30: ReputationIndexResult;
  index90: ReputationIndexResult;
  index365: ReputationIndexResult;
  /** Índice 30 d hoy − índice 30 d hace 30 días (mismo conjunto de reseñas); `null` sin dato. */
  trendDelta: number | null;
  trendDirection: TrendDirection | null;
  sourcesConnected: number;
  /** Fuentes no desactivadas. */
  sourcesTotal: number;
  reviewCount365: number;
  /** 0 mientras el índice se calcule al vuelo (sin reputation_daily_scores). */
  staleDays: 0;
  schemaPatchApplied: boolean;
  computedAt: string;
  /** Lecturas que cayeron a su valor por defecto (`reputation.module`, `reputation.reviews`). */
  degraded: string[];
};

function emptyIndex(windowDays: number, now: Date, status: ReputationIndexStatus): ReputationIndexResult {
  return { status, windowDays, reviewCount: 0, bySource: [], categoryImpact: [], computedAt: now.toISOString() };
}

function emptySnapshot(propertyId: string, now: Date, status: ReputationIndexStatus, schemaPatchApplied: boolean, degraded: string[] = []): ReputationSnapshot {
  return {
    propertyId,
    status,
    index30: emptyIndex(30, now, status),
    index90: emptyIndex(90, now, status),
    index365: emptyIndex(365, now, status),
    trendDelta: null,
    trendDirection: null,
    sourcesConnected: 0,
    sourcesTotal: 0,
    reviewCount365: 0,
    staleDays: 0,
    schemaPatchApplied,
    computedAt: now.toISOString(),
    degraded
  };
}

// ---------------------------------------------------------------------------
// Caché en memoria (60 s por propiedad)
// ---------------------------------------------------------------------------

type CacheEntry = { expiresAt: number; snapshot: ReputationSnapshot };
const snapshotCache = new Map<string, CacheEntry>();

/** Invalida la caché de una propiedad (o de todas) tras un sync, una importación o una respuesta. */
export function invalidateReputationCache(propertyId?: string): void {
  if (propertyId) snapshotCache.delete(propertyId);
  else snapshotCache.clear();
}

function defaultIsModuleEnabled(propertyId: string): boolean {
  return (getEnabledModuleCodes(propertyId) as readonly string[]).includes(REPUTATION_MODULE_CODE);
}

export type GetReputationSnapshotInput = {
  db?: ReputationDb;
  propertyId: string;
  now?: Date;
  /** Por defecto getEnabledModuleCodes(propertyId) ∋ reputation_quality (espejo síncrono). */
  isModuleEnabled?: (propertyId: string) => boolean;
  skipCache?: boolean;
};

/**
 * Snapshot del índice para el director y el dashboard: `module_off` sin
 * consultar nada, `no_sources` con 0 fuentes activas, y si no el estado del
 * índice a 30 días (`ok` | `insufficient` | `no_reviews`). Nunca lanza.
 */
export async function getReputationSnapshot(input: GetReputationSnapshotInput): Promise<ReputationSnapshot> {
  const now = input.now ?? new Date();
  const propertyId = input.propertyId;
  const cached = input.skipCache ? undefined : snapshotCache.get(propertyId);
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;

  let moduleEnabled = false;
  const degraded: string[] = [];
  try {
    moduleEnabled = (input.isModuleEnabled ?? defaultIsModuleEnabled)(propertyId);
  } catch {
    degraded.push("reputation.module");
  }
  const schemaPatchApplied = await detectSchemaPatch({ ...(input.db ? { db: input.db } : {}) });
  if (!moduleEnabled) return emptySnapshot(propertyId, now, "module_off", schemaPatchApplied, degraded);

  let snapshot: ReputationSnapshot;
  try {
    const inputs = await loadIndexInputs({ ...(input.db ? { db: input.db } : {}), propertyId, now });
    const sourcesTotal = inputs.sources.length;
    const sourcesConnected = inputs.sources.filter((entry) => entry.status === "connected").length;
    if (sourcesTotal === 0) {
      snapshot = { ...emptySnapshot(propertyId, now, "no_sources", schemaPatchApplied, degraded), reviewCount365: inputs.reviews.length };
    } else {
      const compute = (windowDays: number, at: Date): ReputationIndexResult =>
        computeReputationIndex({ reviews: inputs.reviews, sourceWeights: inputs.sourceWeights, now: at, windowDays });
      const [w30, w90, w365] = INDEX_WINDOWS;
      const index30 = compute(w30, now);
      const index90 = compute(w90, now);
      const index365 = compute(w365, now);
      // Tendencia: el mismo conjunto de reseñas evaluado hace 30 días.
      const before = compute(w30, new Date(now.getTime() - w30 * MS_PER_DAY));
      const trend = computeTrend(index30.index, before.index);
      snapshot = {
        propertyId,
        status: index30.status,
        index30: { ...index30, ...(trend.delta !== null ? { trendDelta: trend.delta } : {}), ...(trend.direction ? { trendDirection: trend.direction } : {}) },
        index90,
        index365,
        trendDelta: trend.delta,
        trendDirection: trend.direction,
        sourcesConnected,
        sourcesTotal,
        reviewCount365: inputs.reviews.length,
        staleDays: 0,
        schemaPatchApplied,
        computedAt: now.toISOString(),
        degraded
      };
    }
  } catch {
    // Lectura fallida: el director sigue pintando (l2-robustez): snapshot vacío y etiqueta honesta.
    snapshot = emptySnapshot(propertyId, now, "no_reviews", schemaPatchApplied, [...degraded, "reputation.reviews"]);
  }
  snapshotCache.set(propertyId, { expiresAt: Date.now() + REPUTATION_CACHE_TTL_MS, snapshot });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Detección del parche de esquema (T8-L0)
// ---------------------------------------------------------------------------

export const SCHEMA_PATCH_TABLES = Object.freeze(["reputation_daily_scores", "review_source_runs", "review_category_mentions"] as const);

let schemaPatchCache: { expiresAt: number; applied: boolean } | null = null;

/** Olvida la detección (tests y tras aplicar la migración en caliente). */
export function resetSchemaPatchCacheForTests(): void {
  schemaPatchCache = null;
}

/**
 * `true` cuando existen las 3 tablas del parche T8-L0 (to_regclass); cacheado
 * 10 minutos; cualquier error → false (el código funciona sin ellas).
 */
export async function detectSchemaPatch(input: { db?: ReputationDb; now?: Date } = {}): Promise<boolean> {
  const nowMs = (input.now ?? new Date()).getTime();
  if (schemaPatchCache && schemaPatchCache.expiresAt > nowMs) return schemaPatchCache.applied;
  const db = input.db ?? prisma;
  let applied = false;
  try {
    const rows = await db.$queryRaw<Array<{ daily: string | null; runs: string | null; mentions: string | null }>>`
      SELECT to_regclass('public.reputation_daily_scores')::text AS daily,
             to_regclass('public.review_source_runs')::text AS runs,
             to_regclass('public.review_category_mentions')::text AS mentions`;
    const row = rows[0];
    applied = Boolean(row && row.daily && row.runs && row.mentions);
  } catch {
    applied = false;
  }
  schemaPatchCache = { expiresAt: nowMs + SCHEMA_PATCH_CACHE_TTL_MS, applied };
  return applied;
}
