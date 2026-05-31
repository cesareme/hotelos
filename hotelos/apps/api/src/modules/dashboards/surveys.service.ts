import { prisma } from "@hotelos/database";

export type SurveysDashboard = {
  kpis: {
    nps90d: number;
    responseRatePct: number;
    totalResponses90d: number;
    promoters: number;
    passives: number;
    detractors: number;
  };
  scoreDistribution: Array<{ score: number; count: number }>;
  recentResponses: Array<{
    id: string;
    surveyName: string;
    score?: number;
    sentiment?: string;
    comment?: string;
    submittedAt: string;
  }>;
  topThemes: Array<{ theme: string; count: number }>;
};

export type BuildSurveysDashboardInput = {
  propertyId: string;
  days?: number;
};

const DEFAULT_DAYS = 90;
const RECENT_LIMIT = 10;
const TOP_THEMES_LIMIT = 8;

function emptyDistribution(): Array<{ score: number; count: number }> {
  const rows: Array<{ score: number; count: number }> = [];
  for (let i = 0; i <= 10; i += 1) rows.push({ score: i, count: 0 });
  return rows;
}

function emptyDashboard(): SurveysDashboard {
  return {
    kpis: {
      nps90d: 0,
      responseRatePct: 0,
      totalResponses90d: 0,
      promoters: 0,
      passives: 0,
      detractors: 0
    },
    scoreDistribution: emptyDistribution(),
    recentResponses: [],
    topThemes: []
  };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const parsed = toNumber(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function collectThemes(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const themes: string[] = [];
  const candidates = [record.themes, record.tags, record.topics, record.categories];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string" && item.trim().length > 0) {
          themes.push(item.trim());
        } else if (item && typeof item === "object") {
          const themeRecord = item as Record<string, unknown>;
          const label = typeof themeRecord.theme === "string"
            ? themeRecord.theme
            : typeof themeRecord.name === "string"
              ? themeRecord.name
              : typeof themeRecord.label === "string"
                ? themeRecord.label
                : null;
          if (label && label.trim().length > 0) themes.push(label.trim());
        }
      }
    } else if (typeof candidate === "string" && candidate.trim().length > 0) {
      themes.push(candidate.trim());
    }
  }
  return themes;
}

export async function buildSurveysDashboard(
  input: BuildSurveysDashboardInput
): Promise<SurveysDashboard> {
  const { propertyId } = input;
  if (!propertyId) return emptyDashboard();

  const days = input.days && input.days > 0 ? Math.floor(input.days) : DEFAULT_DAYS;
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // SurveyResponse has no propertyId; we scope through Survey.
  const surveys = await prisma.survey.findMany({ where: { propertyId } });
  if (surveys.length === 0) return emptyDashboard();

  const surveyIdToName = new Map<string, string>();
  for (const survey of surveys) surveyIdToName.set(survey.id, survey.name);
  const surveyIds = Array.from(surveyIdToName.keys());

  const responses = await prisma.surveyResponse.findMany({
    where: { surveyId: { in: surveyIds }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" }
  });

  if (responses.length === 0) {
    // Still compute response rate vs reservations if any exist; fall back to empty otherwise.
    return emptyDashboard();
  }

  const distributionCounts = new Map<number, number>();
  for (let i = 0; i <= 10; i += 1) distributionCounts.set(i, 0);

  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  let scoredCount = 0;
  const themeCounts = new Map<string, number>();

  for (const response of responses) {
    const metadata = asRecord(response.responsesJson as unknown);
    // Prefer column score; fall back to nested score-like keys in JSON.
    let score = toNumber(response.score);
    if (score === null) {
      score = pickNumber(metadata, ["score", "nps", "npsScore", "rating"]);
    }

    if (score !== null) {
      const bucket = Math.max(0, Math.min(10, Math.round(score)));
      distributionCounts.set(bucket, (distributionCounts.get(bucket) ?? 0) + 1);
      scoredCount += 1;
      if (bucket >= 9) promoters += 1;
      else if (bucket <= 6) detractors += 1;
      else passives += 1;
    }

    for (const theme of collectThemes(metadata)) {
      const key = theme.toLowerCase();
      themeCounts.set(key, (themeCounts.get(key) ?? 0) + 1);
    }
  }

  const nps90d = scoredCount > 0
    ? round1(((promoters - detractors) / scoredCount) * 100)
    : 0;

  // Response rate: responses / checked-out reservations within the same window.
  // Falls back to 0 when there are no eligible reservations.
  let responseRatePct = 0;
  try {
    const eligibleReservations = await prisma.reservation.count({
      where: {
        propertyId,
        departureDate: { gte: since, lte: now }
      }
    });
    if (eligibleReservations > 0) {
      responseRatePct = round1((responses.length / eligibleReservations) * 100);
    }
  } catch {
    // If reservation shape differs, leave responseRatePct at 0 rather than failing.
    responseRatePct = 0;
  }

  const scoreDistribution = Array.from({ length: 11 }, (_, score) => ({
    score,
    count: distributionCounts.get(score) ?? 0
  }));

  const recentResponses = responses.slice(0, RECENT_LIMIT).map((response) => {
    const metadata = asRecord(response.responsesJson as unknown);
    const columnScore = toNumber(response.score);
    const score = columnScore !== null
      ? columnScore
      : pickNumber(metadata, ["score", "nps", "npsScore", "rating"]);
    const sentiment = pickString(metadata, ["sentiment", "sentimentLabel", "mood"]);
    const comment = pickString(metadata, ["comment", "comments", "feedback", "message", "verbatim"]);
    return {
      id: response.id,
      surveyName: surveyIdToName.get(response.surveyId) ?? response.surveyId,
      score: score ?? undefined,
      sentiment,
      comment,
      submittedAt: response.createdAt.toISOString()
    };
  });

  const topThemes = Array.from(themeCounts.entries())
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_THEMES_LIMIT);

  return {
    kpis: {
      nps90d,
      responseRatePct,
      totalResponses90d: responses.length,
      promoters,
      passives,
      detractors
    },
    scoreDistribution,
    recentResponses,
    topThemes
  };
}
