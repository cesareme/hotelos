import { prisma } from "@hotelos/database";

export type ReputationDashboard = {
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

export type BuildReputationDashboardInput = {
  propertyId: string;
  days?: number;
};

const DEFAULT_DAYS = 30;

function emptyDashboard(): ReputationDashboard {
  return {
    kpis: {
      avgRating: 0,
      reviewsLast7d: 0,
      reviewsLast30d: 0,
      pendingResponses: 0,
      sentimentScore: 0
    },
    ratingDistribution: { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 },
    reviewsBySource: [],
    recentReviews: []
  };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // Prisma Decimal exposes toNumber()
  const maybeDecimal = value as { toNumber?: () => number };
  if (typeof maybeDecimal.toNumber === "function") {
    const parsed = maybeDecimal.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function buildReputationDashboard(
  input: BuildReputationDashboardInput
): Promise<ReputationDashboard> {
  const { propertyId } = input;
  if (!propertyId) return emptyDashboard();

  const days = input.days && input.days > 0 ? Math.floor(input.days) : DEFAULT_DAYS;
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Fetch reviews within the configured window. We use createdAt as the
  // reference timestamp because receivedAt is optional on the model.
  const [reviews, sources] = await Promise.all([
    prisma.guestReview.findMany({
      where: { propertyId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.reviewSource.findMany({ where: { propertyId } })
  ]);

  if (reviews.length === 0) {
    return emptyDashboard();
  }

  // Build a lookup from source/provider key → display name. Provider strings
  // on ReviewSource match the `source` string on GuestReview.
  const sourceNameByKey = new Map<string, string>();
  for (const source of sources) {
    sourceNameByKey.set(source.provider, source.provider);
  }

  const ratings: number[] = [];
  const distribution = { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 };
  let reviewsLast7d = 0;
  let reviewsLast30d = 0;
  let pendingResponses = 0;

  const bySource = new Map<string, { count: number; ratingSum: number; ratingCount: number }>();

  for (const review of reviews) {
    const rating = toNumber(review.rating);
    if (rating !== null) {
      ratings.push(rating);
      const bucket = Math.max(1, Math.min(5, Math.round(rating)));
      if (bucket === 1) distribution.star1 += 1;
      else if (bucket === 2) distribution.star2 += 1;
      else if (bucket === 3) distribution.star3 += 1;
      else if (bucket === 4) distribution.star4 += 1;
      else distribution.star5 += 1;
    }

    if (review.createdAt >= sevenDaysAgo) reviewsLast7d += 1;
    if (review.createdAt >= thirtyDaysAgo) reviewsLast30d += 1;

    // Pending responses: any rated review still missing a respondedAt.
    if (review.respondedAt === null && rating !== null) {
      pendingResponses += 1;
    }

    const sourceKey = review.source || "unknown";
    const sourceName = sourceNameByKey.get(sourceKey) ?? sourceKey;
    const aggregate = bySource.get(sourceName) ?? { count: 0, ratingSum: 0, ratingCount: 0 };
    aggregate.count += 1;
    if (rating !== null) {
      aggregate.ratingSum += rating;
      aggregate.ratingCount += 1;
    }
    bySource.set(sourceName, aggregate);
  }

  const avgRating = ratings.length > 0
    ? round1(ratings.reduce((total, value) => total + value, 0) / ratings.length)
    : 0;

  // Sentiment from average rating mapped to -1..+1.
  const sentimentScore = ratings.length > 0 ? round2((avgRating - 3) / 2) : 0;

  const reviewsBySource = Array.from(bySource.entries())
    .map(([sourceName, aggregate]) => ({
      sourceName,
      count: aggregate.count,
      avgRating: aggregate.ratingCount > 0 ? round1(aggregate.ratingSum / aggregate.ratingCount) : 0
    }))
    .sort((a, b) => b.count - a.count);

  const recentReviews = reviews.slice(0, 10).map((review) => {
    const rating = toNumber(review.rating);
    const sourceKey = review.source || "unknown";
    const sourceName = sourceNameByKey.get(sourceKey) ?? sourceKey;
    return {
      id: review.id,
      sourceName,
      ratingValue: rating ?? undefined,
      title: review.title ?? undefined,
      body: review.body ?? undefined,
      createdAt: review.createdAt.toISOString(),
      respondedAt: review.respondedAt ? review.respondedAt.toISOString() : undefined
    };
  });

  return {
    kpis: {
      avgRating,
      reviewsLast7d,
      reviewsLast30d,
      pendingResponses,
      sentimentScore
    },
    ratingDistribution: distribution,
    reviewsBySource,
    recentReviews
  };
}
