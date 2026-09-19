// Unit tests · Tanda T8 · lote T8-E — resumen puro del dashboard de reputación
// (reputation-summary.ts). Tabla de fixtures FICTICIAS: sin base de datos, sin
// red, sin nombres reales. Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-summary.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INDEX_MIN_REVIEWS,
  slaTargetFor,
  writeReviewMeta,
  type ReputationDashboardDto,
  type ReputationDashboardLegacy,
  type ReviewCategory,
  type ReviewMetaInput,
  type ReviewSourceDto
} from "../reputation-types.js";
import {
  buildReputationSummary,
  distributionBucketFor,
  emptyReputationSummary,
  sourceLabelFor,
  type ReputationSummary,
  type SummaryReviewRow
} from "../reputation-summary.js";

const NOW = new Date("2026-09-19T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let seq = 0;

type ReviewFixture = {
  source: string;
  score10: number | null;
  ageDays: number;
  /** Nota sobre 5 en la columna `rating` (por defecto score10 / 2). */
  rating?: number | null;
  respondedAgeDays?: number | null;
  categories?: Array<{ category: ReviewCategory; sentiment: -1 | 0 | 1 }>;
  meta?: ReviewMetaInput;
  receivedAt?: null;
  title?: string;
  body?: string;
};

/** Fila ficticia de GuestReview con topicsJson = ReviewMeta v1. */
function review(fixture: ReviewFixture): SummaryReviewRow {
  seq += 1;
  const id = `rev_${String(seq).padStart(3, "0")}`;
  const rating = fixture.rating === undefined ? (fixture.score10 === null ? null : fixture.score10 / 2) : fixture.rating;
  const receivedAt = daysAgo(fixture.ageDays);
  const meta = writeReviewMeta({
    score10: fixture.score10,
    ratingRaw: rating,
    ratingScaleMax: 5,
    contentHash: `hash_${id}`,
    sourceMode: "csv",
    bodyComplete: true,
    status: "new",
    slaTargetAt: slaTargetFor(receivedAt, fixture.score10),
    replyCapability: true,
    categories: (fixture.categories ?? []).map((mention) => ({ ...mention, confidence: 0.9, source: "dictionary" as const })),
    analysis: { status: "done", source: "dictionary" },
    ...(fixture.meta ?? {})
  });
  return {
    id,
    source: fixture.source,
    rating,
    title: fixture.title ?? `Título ficticio ${seq}`,
    body: fixture.body ?? `Cuerpo ficticio ${seq}.`,
    topicsJson: meta,
    createdAt: new Date(receivedAt.getTime() + 3_600_000),
    receivedAt: fixture.receivedAt === null ? null : receivedAt,
    respondedAt: fixture.respondedAgeDays === undefined || fixture.respondedAgeDays === null ? null : daysAgo(fixture.respondedAgeDays)
  };
}

function source(partial: Partial<ReviewSourceDto> & Pick<ReviewSourceDto, "provider">): ReviewSourceDto {
  return {
    id: `src_${partial.provider}`,
    propertyId: "prop_ficticia",
    provider: partial.provider,
    mode: "csv",
    status: "connected",
    displayName: `Fuente ${partial.provider}`,
    weight: 1,
    retentionDays: 730,
    externalLocationId: null,
    externalAccountId: null,
    capabilities: { fetch: false, reply: false, fullText: true, categories: false },
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    hasCredentials: false,
    runs: [],
    isDemo: false,
    createdAt: NOW.toISOString(),
    ...partial
  };
}

const SOURCES = [
  source({ provider: "csv", displayName: "Importación manual" }),
  source({ provider: "booking_demo", mode: "demo", isDemo: true, lastRunAt: "2026-09-18T06:00:00Z" }),
  source({ provider: "google", mode: "api", status: "unavailable", lastError: "OAuth no autorizado" })
];

/** 12 reseñas ficticias en 3 fuentes, 3 negativas con menciones de limpieza/ruido. */
function twelveReviews(): SummaryReviewRow[] {
  return [
    review({ source: "csv", score10: 10, ageDays: 1, respondedAgeDays: 0 }),
    review({ source: "csv", score10: 9, ageDays: 2, categories: [{ category: "personal", sentiment: 1 }] }),
    review({ source: "csv", score10: 8, ageDays: 3 }),
    review({ source: "csv", score10: 3, ageDays: 4, categories: [{ category: "limpieza", sentiment: -1 }, { category: "ruido", sentiment: -1 }] }),
    review({ source: "csv", score10: 7, ageDays: 5, respondedAgeDays: 4 }),
    review({ source: "booking_demo", score10: 9, ageDays: 1 }),
    review({ source: "booking_demo", score10: 8, ageDays: 2 }),
    review({ source: "booking_demo", score10: 4, ageDays: 3, categories: [{ category: "limpieza", sentiment: -1 }] }),
    review({ source: "booking_demo", score10: 7, ageDays: 6 }),
    review({ source: "google", score10: 10, ageDays: 2 }),
    review({ source: "google", score10: 4, ageDays: 8, categories: [{ category: "personal", sentiment: -1 }] }),
    review({ source: "google", score10: 8, ageDays: 9, meta: { status: "drafted", assignedUserId: "usr_ficticio" } })
  ];
}

describe("buildReputationSummary · estados", () => {
  it("sin fuentes ni reseñas → no_sources con todo a cero y arrays vacíos", () => {
    const out = buildReputationSummary({ reviews: [], sources: [], now: NOW, days: 30 });
    assert.equal(out.status, "no_sources");
    assert.equal(out.index.status, "no_sources");
    assert.equal(out.index.reviewCount30, 0);
    assert.equal(out.index.index30, undefined);
    assert.deepEqual(out.indexByWindow.map((entry) => entry.status), ["no_sources", "no_sources", "no_sources"]);
    assert.deepEqual(out.kpis, { avgRating: 0, reviewsLast7d: 0, reviewsLast30d: 0, pendingResponses: 0, sentimentScore: 0 });
    assert.deepEqual(out.ratingDistribution, { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 });
    assert.deepEqual(out.distribution10, { b0_2: 0, b2_4: 0, b4_6: 0, b6_8: 0, b8_10: 0 });
    assert.deepEqual(out.bySource, []);
    assert.deepEqual(out.categories, []);
    assert.deepEqual(out.recentReviews, []);
    assert.equal(out.responseRatePct, null);
    assert.equal(out.medianResponseHours, null);
    assert.deepEqual(out.inbox, { open: 0, overdue: 0, drafted: 0, unassigned: 0 });
    assert.equal(out.windowDays, 30);
    assert.equal(out.generatedAt, NOW.toISOString());
  });

  it("fuentes sin reseñas → no_reviews con bySource rellenas (estado honesto de cada fuente)", () => {
    const out = buildReputationSummary({ reviews: [], sources: SOURCES, now: NOW });
    assert.equal(out.status, "no_reviews");
    assert.equal(out.sources.length, 3);
    assert.equal(out.bySource.length, 3);
    const google = out.bySource.find((entry) => entry.provider === "google");
    assert.deepEqual(google, {
      provider: "google",
      sourceId: "src_google",
      displayName: "Fuente google",
      mode: "api",
      status: "unavailable",
      weight: 1,
      lastRunAt: null,
      lastError: "OAuth no autorizado",
      count: 0,
      avg10: null,
      weightShare: 0
    });
    assert.equal(out.windowDays, 30);
  });

  it("solo fuentes disabled → no_sources aunque haya reseñas (el índice no se calcula)", () => {
    const out = buildReputationSummary({ reviews: twelveReviews(), sources: [source({ provider: "csv", status: "disabled" })], now: NOW });
    assert.equal(out.status, "no_sources");
    assert.equal(out.index.index30, undefined);
    // Los KPI heredados siguen siendo honestos con lo que hay.
    assert.equal(out.kpis.reviewsLast30d, 12);
  });

  it(`menos de ${INDEX_MIN_REVIEWS} reseñas → insufficient sin índice pero con categorías (solo menciones) y distribución`, () => {
    const reviews = twelveReviews().slice(0, 5);
    const out = buildReputationSummary({ reviews, sources: SOURCES, now: NOW });
    assert.equal(out.status, "insufficient");
    assert.equal(out.index.index30, undefined);
    assert.equal(out.index.reviewCount30, 5);
    const cleanliness = out.categories.find((entry) => entry.category === "limpieza");
    assert.deepEqual(cleanliness, { category: "limpieza", label: "Limpieza", mentions: 1, negativeMentions: 1, negative: 1, impact: 0 });
    assert.equal(out.distribution10.b8_10, 3);
    assert.equal(out.distribution10.b6_8, 1);
    assert.equal(out.distribution10.b2_4, 1);
  });
});

describe("buildReputationSummary · 12 reseñas ficticias en 3 fuentes", () => {
  const out = buildReputationSummary({ reviews: twelveReviews(), sources: SOURCES, now: NOW, days: 30 });

  it("status ok, índice 30 d en 0-100, tres ventanas y tendencia sin dato (hace 30 d no había reseñas)", () => {
    assert.equal(out.status, "ok");
    assert.equal(typeof out.index.index30, "number");
    assert.ok((out.index.index30 as number) >= 0 && (out.index.index30 as number) <= 100);
    assert.equal(out.index.index30, out.index.index);
    assert.equal(out.index.reviewCount30, 12);
    assert.equal(out.index.reviewCount, 12);
    assert.equal(out.index.windowDays, 30);
    // Cada ventana tiene su propia semivida (W/2): los tres índices existen y están en 0-100.
    for (const value of [out.index.index90, out.index.index365]) assert.ok(typeof value === "number" && value >= 0 && value <= 100);
    assert.equal(out.index.trendDelta, undefined);
    assert.equal(out.index.trendDirection, undefined);
    assert.deepEqual(out.indexByWindow.map((entry) => entry.windowDays), [30, 90, 365]);
    assert.deepEqual(out.indexByWindow.map((entry) => entry.status), ["ok", "ok", "ok"]);
  });

  it("bySource: una entrada por fuente con count/avg10 y weightShare que suma 1", () => {
    assert.deepEqual(out.bySource.map((entry) => entry.provider), ["csv", "booking_demo", "google"]);
    const csv = out.bySource.find((entry) => entry.provider === "csv")!;
    assert.equal(csv.count, 5);
    assert.equal(csv.avg10, 7.4);
    assert.equal(csv.status, "connected");
    assert.equal(csv.displayName, "Importación manual");
    const booking = out.bySource.find((entry) => entry.provider === "booking_demo")!;
    assert.equal(booking.count, 4);
    assert.equal(booking.avg10, 7);
    assert.equal(booking.mode, "demo");
    assert.equal(booking.lastRunAt, "2026-09-18T06:00:00Z");
    const google = out.bySource.find((entry) => entry.provider === "google")!;
    assert.equal(google.count, 3);
    assert.equal(google.status, "unavailable");
    assert.equal(google.lastError, "OAuth no autorizado");
    const totalShare = out.bySource.reduce((total, entry) => total + entry.weightShare, 0);
    assert.ok(Math.abs(totalShare - 1) < 0.001, `weightShare suma ${totalShare}`);
    for (const entry of out.bySource) assert.ok(entry.weightShare > 0 && entry.weightShare <= 0.6 + 1e-9, `${entry.provider} share ${entry.weightShare}`);
  });

  it("categories: impacto > 0 en limpieza (2 menciones negativas) y etiquetas en español", () => {
    const cleanliness = out.categories.find((entry) => entry.category === "limpieza")!;
    assert.equal(cleanliness.label, "Limpieza");
    assert.equal(cleanliness.mentions, 2);
    assert.equal(cleanliness.negativeMentions, 2);
    assert.equal(cleanliness.negative, 2);
    assert.ok(cleanliness.impact > 0);
    const staff = out.categories.find((entry) => entry.category === "personal")!;
    assert.equal(staff.mentions, 2);
    assert.equal(staff.negative, 1);
    assert.ok(staff.impact > 0);
    assert.equal(out.categories[0]!.impact, Math.max(...out.categories.map((entry) => entry.impact)));
  });

  it("KPI heredados: avgRating sobre 5, estrellas, pendientes, sentimiento y desglose por fuente", () => {
    // ratings = score10/2 de las 12: media 7,25/2 = 3,625 → 3,6
    assert.equal(out.kpis.avgRating, 3.6);
    assert.equal(out.kpis.reviewsLast7d, 10);
    assert.equal(out.kpis.reviewsLast30d, 12);
    assert.equal(out.kpis.pendingResponses, 10);
    assert.equal(out.kpis.sentimentScore, 0.3);
    assert.deepEqual(out.ratingDistribution, { star1: 0, star2: 3, star3: 0, star4: 5, star5: 4 });
    assert.deepEqual(
      out.reviewsBySource.map((entry) => [entry.sourceName, entry.count, entry.avgRating]),
      [["Importación manual", 5, 3.7], ["Fuente booking_demo", 4, 3.5], ["Fuente google", 3, 3.7]]
    );
  });

  it("distribution10 sobre score10 y scoreDistribution es su alias", () => {
    assert.deepEqual(out.distribution10, { b0_2: 0, b2_4: 1, b4_6: 2, b6_8: 2, b8_10: 7 });
    assert.deepEqual(out.scoreDistribution, out.distribution10);
  });

  it("tasa de respuesta y mediana de horas en la ventana", () => {
    // 2 respondidas de 12 respondibles → 16,7 %; horas: 24 y 24 → mediana 24.
    assert.equal(out.responseRatePct, 16.7);
    assert.equal(out.medianResponseHours, 24);
  });

  it("inbox: abiertas, fuera de plazo (SLA vencido), con borrador y sin asignar", () => {
    assert.equal(out.inbox.open, 12);
    assert.equal(out.inbox.drafted, 1);
    assert.equal(out.inbox.unassigned, 11);
    // SLA 48 h (negativas) · 72 h (neutras) · 96 h (positivas) desde receivedAt: vencen la negativa de 4 d,
    // la neutra de 5 d, la negativa de 3 d, la neutra de 6 d, la negativa de 8 d y la neutra (borrador) de 9 d.
    assert.equal(out.inbox.overdue, 6);
  });

  it("recentReviews: 10 más recientes con score10/status/analysisSource y campos heredados", () => {
    assert.equal(out.recentReviews.length, 10);
    const first = out.recentReviews[0]!;
    assert.equal(first.sourceName, "Importación manual");
    assert.equal(first.provider, "csv");
    assert.equal(first.score10, 10);
    assert.equal(first.ratingValue, 5);
    assert.equal(first.status, "new");
    assert.equal(first.analysisSource, "dictionary");
    assert.equal(first.sentiment, "positive");
    assert.equal(first.receivedAt, daysAgo(1).toISOString());
    assert.equal(typeof first.createdAt, "string");
    assert.equal(typeof first.respondedAt, "string");
    assert.equal(first.bodyPurged, false);
    const drafted = out.recentReviews.find((entry) => entry.status === "drafted");
    assert.equal(drafted, undefined, "la de hace 9 días queda fuera de las 10 más recientes");
    const dates = out.recentReviews.map((entry) => Date.parse(entry.receivedAt));
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  });

  it("es un superconjunto del contrato heredado y del DTO compartido (comprobación de tipos)", () => {
    const legacy: ReputationDashboardLegacy = out;
    const dto: ReputationDashboardDto = { ...out, degraded: [] };
    assert.equal(legacy.kpis.avgRating, out.kpis.avgRating);
    assert.equal(dto.index.status, "ok");
    assert.equal(dto.inbox.open, 12);
  });
});

describe("buildReputationSummary · ventanas y fechas", () => {
  it("`days` acota KPI, distribución, categorías y recientes; el índice 365 sigue viendo las antiguas", () => {
    const reviews = [
      ...twelveReviews(),
      review({ source: "csv", score10: 1.5, ageDays: 45, categories: [{ category: "limpieza", sentiment: -1 }] }),
      review({ source: "csv", score10: 1.5, ageDays: 60 })
    ];
    const out = buildReputationSummary({ reviews, sources: SOURCES, now: NOW, days: 30 });
    assert.equal(out.kpis.reviewsLast30d, 12);
    assert.equal(out.distribution10.b0_2, 0);
    assert.equal(out.index.reviewCount30, 12);
    assert.equal(out.indexByWindow[1]!.reviewCount, 14);
    assert.equal(out.indexByWindow[2]!.reviewCount, 14);
    assert.ok((out.index.index365 as number) < (out.index.index30 as number), "las dos antiguas de nota 1,5 bajan el índice largo");
    const wide = buildReputationSummary({ reviews, sources: SOURCES, now: NOW, days: 90 });
    assert.equal(wide.windowDays, 90);
    assert.equal(wide.distribution10.b0_2, 2);
    assert.equal(wide.recentReviews.length, 10);
    assert.equal(wide.categories.find((entry) => entry.category === "limpieza")?.mentions, 3);
  });

  it("receivedAt nulo cae a createdAt; las reseñas futuras se ignoran; `days` inválido → 30", () => {
    const legacyRow = review({ source: "csv", score10: 8, ageDays: 3, receivedAt: null });
    const future = review({ source: "csv", score10: 1, ageDays: -2 });
    const out = buildReputationSummary({ reviews: [legacyRow, future], sources: SOURCES, now: NOW, days: -5 });
    assert.equal(out.windowDays, 30);
    assert.equal(out.kpis.reviewsLast30d, 1);
    assert.equal(out.recentReviews.length, 1);
    assert.equal(out.recentReviews[0]!.id, legacyRow.id);
    assert.equal(out.recentReviews[0]!.receivedAt, new Date(legacyRow.createdAt).toISOString());
  });

  it("sin score10 en la meta se deriva de `rating` (sobre 5); sin nota no entra en el índice ni en distribution10", () => {
    const derived = review({ source: "csv", score10: null, ageDays: 1, rating: 4, meta: { score10: null } });
    const unrated = review({ source: "csv", score10: null, ageDays: 1, rating: null, meta: { score10: null } });
    const out = buildReputationSummary({ reviews: [derived, unrated], sources: SOURCES, now: NOW });
    assert.equal(out.recentReviews.find((entry) => entry.id === derived.id)?.score10, 8);
    assert.equal(out.recentReviews.find((entry) => entry.id === unrated.id)?.score10, null);
    assert.equal(out.index.reviewCount30, 1);
    assert.deepEqual(out.distribution10, { b0_2: 0, b2_4: 0, b4_6: 0, b6_8: 0, b8_10: 1 });
    assert.equal(out.kpis.pendingResponses, 1, "solo las que tienen nota cuentan como pendientes (regla heredada)");
  });

  it("reseñas con código de fuente sin fila ReviewSource aparecen en bySource con status null", () => {
    const out = buildReputationSummary({ reviews: [review({ source: "tripadvisor", score10: 9, ageDays: 1 })], sources: SOURCES, now: NOW });
    const extra = out.bySource.find((entry) => entry.provider === "tripadvisor");
    assert.ok(extra);
    assert.equal(extra!.status, null);
    assert.equal(extra!.sourceId, null);
    assert.equal(extra!.displayName, "Tripadvisor");
    assert.equal(extra!.count, 1);
    assert.equal(extra!.avg10, 9);
  });
});

describe("utilidades", () => {
  it("distributionBucketFor: tramos 0-2 · 2-4 · 4-6 · 6-8 · 8-10", () => {
    assert.equal(distributionBucketFor(0), "b0_2");
    assert.equal(distributionBucketFor(1.99), "b0_2");
    assert.equal(distributionBucketFor(2), "b2_4");
    assert.equal(distributionBucketFor(5.9), "b4_6");
    assert.equal(distributionBucketFor(6), "b6_8");
    assert.equal(distributionBucketFor(8), "b8_10");
    assert.equal(distributionBucketFor(10), "b8_10");
  });

  it("sourceLabelFor: displayName de la fuente, si no el nombre del portal (+ «(demo)»), si no el código", () => {
    assert.equal(sourceLabelFor("csv", SOURCES), "Importación manual");
    assert.equal(sourceLabelFor("booking_demo", []), "Booking.com (demo)");
    assert.equal(sourceLabelFor("demo", []), "Demo (datos ficticios)");
    assert.equal(sourceLabelFor("holidaycheck", []), "HolidayCheck");
    assert.equal(sourceLabelFor("portal_desconocido", []), "portal_desconocido");
  });

  it("emptyReputationSummary: status dado, fuentes dadas y todo a cero", () => {
    const out: ReputationSummary = emptyReputationSummary({ now: NOW, status: "no_reviews", sources: SOURCES, days: 7 });
    assert.equal(out.status, "no_reviews");
    assert.equal(out.windowDays, 7);
    assert.equal(out.sources.length, 3);
    assert.equal(out.bySource.length, 3);
    assert.equal(out.bySource[2]!.status, "unavailable");
    assert.equal(out.index.reviewCount30, 0);
    assert.deepEqual(out.recentReviews, []);
  });
});
