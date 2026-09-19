import { prisma } from "@hotelos/database";
import { createDegradedCollector } from "../../lib/degraded.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { REPUTATION_MODULE_CODE } from "../reputation/reputation-context.js";
import { REPUTATION_LOAD_LIMIT, REPUTATION_LOAD_WINDOW_DAYS } from "../reputation/reputation-score.service.js";
import { buildReputationSummary, emptyReputationSummary, type ReputationSummary } from "../reputation/reputation-summary.js";
import type { ReputationDashboardDto, ReputationDashboardLegacy } from "../reputation/reputation-types.js";
import { toReviewSourceDto } from "../reputation/review-sources.service.js";

// Contrato heredado de `/dashboards/reputation` (776782a, líneas 3-22): se
// conserva íntegro y se AMPLÍA de forma aditiva (Tanda T8 · lote T8-E) con el
// índice de reputación, la distribución sobre 10, el desglose por fuente con
// estado honesto, las categorías con impacto, la bandeja y `degraded[]`.
// Privacidad (corrección ronda 1, HP-06): la ruta solo exige analytics.read
// (24 plantillas) y server.ts es de otro dueño, así que aquí (a) con el módulo
// reputation_quality apagado se responde `module_off` sin leer reseñas y (b)
// `recentReviews[].body` es un extracto ≤ RECENT_BODY_EXCERPT caracteres (el
// texto completo solo lo sirve GET /reputation/reviews/:id con reputation.read).
export type ReputationDashboardLegacyShape = {
  kpis: {
    avgRating: number;
    reviewsLast7d: number;
    reviewsLast30d: number;
    pendingResponses: number;
    sentimentScore: number;
  };
  ratingDistribution: { star1: number; star2: number; star3: number; star4: number; star5: number };
  reviewsBySource: Array<{ sourceName: string; count: number; avgRating: number }>;
  recentReviews: Array<{
    id: string;
    sourceName: string;
    ratingValue?: number;
    title?: string;
    body?: string;
    createdAt: string;
    respondedAt?: string;
  }>;
};

/**
 * Dashboard de reputación: bloque heredado + resumen T8-E (reputation-summary.ts)
 * + `degraded` (etiquetas `reputation.reviews`, `reputation.sources`).
 */
export type ReputationDashboard = ReputationSummary & {
  /** Lecturas que cayeron a su valor por defecto en esta respuesta (QC-06). */
  degraded: string[];
};

type AssertExtends<T extends U, U> = T;
/** Garantías de tipo: el dashboard sigue siendo el contrato heredado y el DTO compartido de reputation-types.ts. */
export type ReputationDashboardIsLegacyCompatible = AssertExtends<ReputationDashboard, ReputationDashboardLegacyShape>;
export type ReputationDashboardIsSharedLegacyCompatible = AssertExtends<ReputationDashboard, ReputationDashboardLegacy>;
export type ReputationDashboardIsDtoCompatible = AssertExtends<ReputationDashboard, ReputationDashboardDto>;

export type BuildReputationDashboardInput = {
  propertyId: string;
  days?: number;
};

const DEFAULT_DAYS = 30;
const MS_PER_DAY = 86_400_000;
/** Longitud del extracto de `recentReviews[].body` (el detalle completo exige reputation.read). */
export const RECENT_BODY_EXCERPT = 160;

function emptyDashboard(now: Date, days: number, status: "no_sources" | "module_off" = "no_sources"): ReputationDashboard {
  return { ...emptyReputationSummary({ now, days, status }), degraded: [] };
}

function excerptOf(body: string | undefined): string | undefined {
  if (!body) return body;
  const text = body.trim();
  return text.length > RECENT_BODY_EXCERPT ? `${text.slice(0, RECENT_BODY_EXCERPT - 1)}…` : text;
}

/** Módulo activo según el espejo síncrono (product-modules.service.ts); un fallo de lectura cuenta como apagado, nunca lanza. */
function moduleEnabledFor(propertyId: string): boolean {
  try {
    return (getEnabledModuleCodes(propertyId) as readonly string[]).includes(REPUTATION_MODULE_CODE);
  } catch {
    return false;
  }
}

export async function buildReputationDashboard(
  input: BuildReputationDashboardInput
): Promise<ReputationDashboard> {
  const { propertyId } = input;
  const days = input.days && input.days > 0 ? Math.floor(input.days) : DEFAULT_DAYS;
  const now = new Date();
  if (!propertyId) return emptyDashboard(now, days);
  // Módulo apagado: panel honesto `module_off` sin leer una sola reseña.
  if (!moduleEnabledFor(propertyId)) return emptyDashboard(now, days, "module_off");

  // Ventana de carga: 365 días para el índice (la mayor de INDEX_WINDOWS) o la
  // pedida si es mayor; la fecha efectiva es receivedAt ?? createdAt (las filas
  // anteriores a T8-C no tienen receivedAt). Una lectura fallida no oculta el
  // panel: `safe` registra la etiqueta y el resumen se construye con lo que hay.
  const loadDays = Math.max(days, REPUTATION_LOAD_WINDOW_DAYS);
  const since = new Date(now.getTime() - loadDays * MS_PER_DAY);
  const { safe, degraded } = createDegradedCollector("dashboards.reputation", { propertyId, days });

  const [reviews, sourceRows] = await Promise.all([
    safe(
      "reputation.reviews",
      prisma.guestReview.findMany({
        where: {
          propertyId,
          OR: [{ receivedAt: { gte: since } }, { receivedAt: null, createdAt: { gte: since } }]
        },
        select: {
          id: true,
          source: true,
          rating: true,
          title: true,
          body: true,
          topicsJson: true,
          createdAt: true,
          receivedAt: true,
          respondedAt: true
        },
        orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
        take: REPUTATION_LOAD_LIMIT
      }),
      []
    ),
    safe(
      "reputation.sources",
      prisma.reviewSource.findMany({
        where: { propertyId, status: { not: "disabled" } },
        orderBy: { createdAt: "asc" }
      }),
      []
    )
  ]);

  // 0 reseñas ya no devuelve un panel vacío a ciegas: buildReputationSummary
  // responde `no_sources` (sin fuentes activas) o `no_reviews` con las fuentes
  // rellenas y su estado honesto.
  const sources = sourceRows.map(toReviewSourceDto);
  const summary = buildReputationSummary({ reviews, sources, now, days });
  return { ...summary, recentReviews: summary.recentReviews.map((review) => ({ ...review, ...(review.body !== undefined ? { body: excerptOf(review.body) } : {}) })), degraded };
}
