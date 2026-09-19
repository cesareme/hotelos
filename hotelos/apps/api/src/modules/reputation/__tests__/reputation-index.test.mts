// Unit tests · Tanda T8 · lote T8-B — Índice de Reputación (reputation-index.ts)
// según docs/design/REPUTACION-REVIEWS.md §5.1: tope 60 %, semivida W/2,
// mínimo 10, tendencia, impacto por categoría, tasa de respuesta,
// comparativa de organización. Sin base de datos, sin red. Datos ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-index.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INDEX_MIN_REVIEWS, SOURCE_WEIGHT_CAP, type ReviewCategory } from "../reputation-types.js";
import { applySourceCap, computeOrgComparison, computeReputationIndex, computeTrend, recencyWeight, resolveReviewWeight, reviewWeight, type IndexReviewInput } from "../reputation-index.js";

const NOW = new Date("2026-09-19T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function reviews(count: number, score10: number, source: string, ageDays = 0, extra: Partial<IndexReviewInput> = {}): IndexReviewInput[] {
  return Array.from({ length: count }, () => ({ score10, receivedAt: daysAgo(ageDays), source, ...extra }));
}

describe("computeReputationIndex · tabla del diseño", () => {
  it("tope 60 %: 9 booking @6,0 + 3 google @9,0 → k = 0,5 → índice 72,0 (67,5 sin tope)", () => {
    const out = computeReputationIndex({ reviews: [...reviews(9, 6, "booking"), ...reviews(3, 9, "google")], now: NOW, windowDays: 30 });
    assert.equal(out.status, "ok");
    assert.equal(out.index, 72);
    assert.equal(out.reviewCount, 12);
    const booking = out.bySource.find((entry) => entry.provider === "booking");
    const google = out.bySource.find((entry) => entry.provider === "google");
    assert.deepEqual(booking, { provider: "booking", count: 9, avg10: 6, weightShare: 0.6 });
    assert.deepEqual(google, { provider: "google", count: 3, avg10: 9, weightShare: 0.4 });
    assert.equal(out.windowDays, 30);
    assert.equal(out.computedAt, NOW.toISOString());
  });
  it("con una sola fuente no hay tope (share 100 %)", () => {
    const out = computeReputationIndex({ reviews: [...reviews(9, 6, "booking"), ...reviews(3, 9, "booking")], now: NOW, windowDays: 30 });
    assert.equal(out.index, 67.5);
    assert.equal(out.bySource[0]?.weightShare, 1);
  });
  it("fuente dominante justo en el 60 % no se recorta", () => {
    const out = computeReputationIndex({ reviews: [...reviews(6, 10, "booking"), ...reviews(4, 0, "google")], now: NOW, windowDays: 30 });
    assert.equal(out.index, 60);
    assert.equal(out.bySource.find((entry) => entry.provider === "booking")?.weightShare, 0.6);
  });
  it("applySourceCap reescala solo la dominante con k = (0,6·S_o)/(0,4·S_f)", () => {
    const items = [
      ...Array.from({ length: 9 }, () => ({ score10: 6, source: "booking", weight: 1, negativeCategories: new Set<ReviewCategory>(), allCategories: new Set<ReviewCategory>() })),
      ...Array.from({ length: 3 }, () => ({ score10: 9, source: "google", weight: 1, negativeCategories: new Set<ReviewCategory>(), allCategories: new Set<ReviewCategory>() }))
    ];
    const capped = applySourceCap(items);
    assert.equal(capped.cappedSource, "booking");
    assert.equal(capped.k, (SOURCE_WEIGHT_CAP * 3) / ((1 - SOURCE_WEIGHT_CAP) * 9));
    assert.equal(capped.items.filter((item) => item.source === "booking").every((item) => Math.abs(item.weight - 0.5) < 1e-9), true);
    assert.equal(capped.items.filter((item) => item.source === "google").every((item) => item.weight === 1), true);
  });

  it("semivida W/2: 5 de hoy @10 + 5 de hace 15 días @0 (W=30) → 66,7", () => {
    const out = computeReputationIndex({ reviews: [...reviews(5, 10, "google"), ...reviews(5, 0, "google", 15)], now: NOW, windowDays: 30 });
    assert.equal(out.index, 66.7);
    assert.equal(recencyWeight(15, 30), 0.5);
    assert.equal(recencyWeight(0, 30), 1);
    assert.equal(recencyWeight(45, 90), 0.5);
  });
  it("ventana (now − W, now]: 30 días exactos fuera, 29,9 dentro, futuro fuera", () => {
    const base = reviews(10, 8, "google");
    const boundary = { score10: 0, receivedAt: daysAgo(30), source: "google" };
    const inside = { score10: 0, receivedAt: daysAgo(29.9), source: "google" };
    const future = { score10: 0, receivedAt: daysAgo(-1), source: "google" };
    assert.equal(computeReputationIndex({ reviews: [...base, boundary, future], now: NOW, windowDays: 30 }).reviewCount, 10);
    assert.equal(computeReputationIndex({ reviews: [...base, inside], now: NOW, windowDays: 30 }).reviewCount, 11);
  });

  it(`mínimo ${INDEX_MIN_REVIEWS}: 9 reseñas → insufficient con reviewCount; 0 → no_reviews`, () => {
    const nine = computeReputationIndex({ reviews: reviews(9, 9, "google"), now: NOW, windowDays: 30 });
    assert.equal(nine.status, "insufficient");
    assert.equal(nine.reviewCount, 9);
    assert.equal(nine.index, undefined);
    assert.equal(nine.bySource[0]?.count, 9);
    const none = computeReputationIndex({ reviews: [], now: NOW, windowDays: 30 });
    assert.equal(none.status, "no_reviews");
    assert.equal(none.reviewCount, 0);
    const ten = computeReputationIndex({ reviews: reviews(10, 9, "google"), now: NOW, windowDays: 30 });
    assert.equal(ten.status, "ok");
    assert.equal(ten.index, 90);
  });
  it("las reseñas sin nota no entran en el índice", () => {
    const out = computeReputationIndex({ reviews: [...reviews(10, 9, "google"), ...reviews(5, 0, "google", 0, { score10: null })], now: NOW, windowDays: 30 });
    assert.equal(out.reviewCount, 10);
    assert.equal(out.index, 90);
  });

  it("impacto por categoría: index(sin negativas en c) − index", () => {
    const withCategories = [
      ...reviews(10, 9, "google"),
      ...reviews(2, 3, "google", 0, { categories: [{ category: "limpieza", sentiment: -1 }, { category: "ruido", sentiment: 1 }] })
    ];
    const out = computeReputationIndex({ reviews: withCategories, now: NOW, windowDays: 30 });
    assert.equal(out.index, 80);
    assert.deepEqual(out.categoryImpact, [
      { category: "limpieza", mentions: 2, negativeMentions: 2, impact: 10 },
      { category: "ruido", mentions: 2, negativeMentions: 0, impact: 0 }
    ]);
  });
  it("el impacto nunca es negativo", () => {
    const out = computeReputationIndex({
      reviews: [...reviews(10, 5, "google"), ...reviews(2, 10, "google", 0, { categories: [{ category: "wifi", sentiment: -1 }] })],
      now: NOW,
      windowDays: 30
    });
    assert.equal(out.categoryImpact[0]?.impact, 0);
  });

  it("tasa y mediana de respuesta sobre respondedAt − receivedAt; sin respondibles → undefined", () => {
    const responded = [24, 48, 72, 96].map((hours) => ({ score10: 8, receivedAt: daysAgo(5), source: "google", respondedAt: new Date(daysAgo(5).getTime() + hours * 3_600_000) }));
    const pending = reviews(6, 8, "google", 3);
    const notReplyable = reviews(4, 8, "csv", 2, { replyCapability: false });
    const out = computeReputationIndex({ reviews: [...responded, ...pending, ...notReplyable], now: NOW, windowDays: 30 });
    assert.equal(out.responseRatePct, 40);
    assert.equal(out.medianResponseHours, 60);
    const none = computeReputationIndex({ reviews: notReplyable, now: NOW, windowDays: 30 });
    assert.equal(none.responseRatePct, undefined);
    assert.equal(none.medianResponseHours, undefined);
  });

  it("pesos por fuente (0,1-2) y sin tope con tres fuentes equilibradas", () => {
    const set = [...reviews(10, 10, "google"), ...reviews(10, 0, "email"), ...reviews(10, 5, "csv")];
    assert.equal(computeReputationIndex({ reviews: set, now: NOW, windowDays: 30 }).index, 50);
    const weighted = computeReputationIndex({ reviews: set, sourceWeights: { google: 2, email: 1 }, now: NOW, windowDays: 30 });
    assert.equal(weighted.index, 62.5);
    const clamped = computeReputationIndex({ reviews: set, sourceWeights: { google: 99 }, now: NOW, windowDays: 30 });
    assert.equal(clamped.index, 62.5);
  });

  it("BD-02: el peso resuelto por fuente (`weight`) manda sobre sourceWeights; sin él, el código exacto y luego el proveedor base (`booking_demo` → booking)", () => {
    const set = [...reviews(10, 10, "google"), ...reviews(10, 0, "tripadvisor"), ...reviews(10, 5, "csv")];
    // tripadvisor llegó por una fuente genérica `email` con peso 2: sourceWeights no lo conoce por código, `weight` sí.
    const byWeight = computeReputationIndex({ reviews: set.map((review) => (review.source === "tripadvisor" ? { ...review, weight: 2 } : review)), sourceWeights: { email: 2 }, now: NOW, windowDays: 30 });
    assert.equal(byWeight.index, 37.5);
    assert.equal(computeReputationIndex({ reviews: set, sourceWeights: { email: 2 }, now: NOW, windowDays: 30 }).index, 50, "sin `weight` el peso de la fuente email no llega");
    assert.equal(reviewWeight({ source: "booking_demo" }, { booking: 1.5 }), 1.5);
    assert.equal(reviewWeight({ source: "booking_demo", weight: 0.5 }, { booking: 1.5 }), 0.5);
    assert.equal(reviewWeight({ source: "booking_demo", weight: 99 }, {}), 2, "acotado a 0,1-2");
    assert.equal(reviewWeight({ source: "desconocido" }, {}), 1);
  });

  it("BD-02: resolveReviewWeight resuelve por sourceId, luego por código, luego por proveedor base (la más ligera), y 1 por defecto", () => {
    const sources = [
      { id: "src_email", provider: "email", weight: 2 },
      { id: "src_g1", provider: "google", weight: 1.5 },
      { id: "src_g2", provider: "google", weight: 0.5 }
    ];
    assert.equal(resolveReviewWeight({ source: "tripadvisor", sourceId: "src_email" }, sources), 2);
    assert.equal(resolveReviewWeight({ source: "google", sourceId: "src_g2" }, sources), 0.5);
    assert.equal(resolveReviewWeight({ source: "google", sourceId: null }, sources), 1.5, "código exacto: la primera fuente del proveedor");
    assert.equal(resolveReviewWeight({ source: "google_demo" }, sources), 0.5, "proveedor base: la más ligera");
    assert.equal(resolveReviewWeight({ source: "tripadvisor" }, sources), 1);
  });
});

describe("computeTrend (banda ±1)", () => {
  it("up / flat / down / null", () => {
    assert.deepEqual(computeTrend(80, 78.5), { delta: 1.5, direction: "up" });
    assert.deepEqual(computeTrend(80, 79.5), { delta: 0.5, direction: "flat" });
    assert.deepEqual(computeTrend(80, 81), { delta: -1, direction: "flat" });
    assert.deepEqual(computeTrend(78, 80), { delta: -2, direction: "down" });
    assert.deepEqual(computeTrend(null, 80), { delta: null, direction: null });
    assert.deepEqual(computeTrend(80, undefined), { delta: null, direction: null });
  });
});

describe("computeOrgComparison", () => {
  it("media simple, ranking y relativeIndex solo con status ok y kind hotel", () => {
    const out = computeOrgComparison([
      { propertyId: "A", status: "ok", index: 90, kind: "hotel" },
      { propertyId: "B", status: "ok", index: 70, kind: "hotel" },
      { propertyId: "C", status: "insufficient", index: undefined, kind: "hotel" },
      { propertyId: "D", status: "ok", index: 100, kind: "office" }
    ]);
    assert.equal(out.orgAverage, 80);
    assert.equal(out.orgSize, 2);
    assert.deepEqual(out.entries, [
      { propertyId: "A", index: 90, rank: 1, relativeIndex: 112.5 },
      { propertyId: "B", index: 70, rank: 2, relativeIndex: 87.5 }
    ]);
  });
  it("empates comparten rango; sin elegibles → null", () => {
    const tie = computeOrgComparison([
      { propertyId: "A", status: "ok", index: 80 },
      { propertyId: "B", status: "ok", index: 80 },
      { propertyId: "C", status: "ok", index: 60 }
    ]);
    assert.deepEqual(tie.entries.map((entry) => entry.rank), [1, 1, 3]);
    assert.deepEqual(computeOrgComparison([{ propertyId: "X", status: "no_reviews" }]), { orgAverage: null, orgSize: 0, entries: [] });
  });
});
