// Unit tests · Tanda T8 · lote T8-E — bloque `reputationIndex` del panel del
// director (dashboards/general-manager.service.ts) y helpers enlazados de
// quality/surveys. Lee el fuente para pinar los contratos ADITIVOS (el bloque
// `reputation.reviews30` de L2 sigue intacto; las 3 etiquetas nuevas existen;
// npsFromSurveys se importa de surveys.service) y prueba composeGmReputationIndex
// con fixtures ficticias. Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/general-manager-reputation.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REVIEW_ALERT_CASE_TYPE } from "../../reputation/review-alerts.service.js";
import { composeGmReputationIndex, type GmReputationSnapshotLike } from "../general-manager.service.js";
import { QUALITY_REVIEW_CASE_TYPE, reviewIdFromCaseDescription } from "../quality.service.js";
import { npsBucketFor, scoreOfSurveyResponse, tallyNps } from "../surveys.service.js";

const GM_SOURCE = readFileSync(new URL("../general-manager.service.ts", import.meta.url), "utf8");

function snapshot(partial: Partial<GmReputationSnapshotLike> & Pick<GmReputationSnapshotLike, "status">): GmReputationSnapshotLike {
  return {
    status: partial.status,
    index30: partial.index30 ?? { status: partial.status, windowDays: 30, reviewCount: 0, bySource: [], categoryImpact: [] },
    trendDelta: partial.trendDelta ?? null,
    sourcesConnected: partial.sourcesConnected ?? 0,
    staleDays: 0
  };
}

describe("general-manager.service.ts · contrato aditivo (lectura del fuente)", () => {
  it("el bloque `reputation.reviews30` de L2 sigue intacto (aggregate por createdAt, 30 días)", () => {
    assert.match(GM_SOURCE, /safe\(\s*"reputation\.reviews30",\s*prisma\.guestReview\.aggregate\(\{\s*where: \{ propertyId, createdAt: \{ gte: new Date\(today\.getTime\(\) - 30 \* 86400000\) \} \}/);
    assert.match(GM_SOURCE, /if \(reviews30 && reviews30\._count\._all > 0\) \{/);
    assert.match(GM_SOURCE, /avgScore: avg \? Math\.round\(avg \* 100\) \/ 100 : undefined,\s*reviewsLast30: reviews30\._count\._all/);
  });

  it("existen las tres etiquetas nuevas de degraded: reputation.index30 · reputation.sources · reputation.nps30", () => {
    assert.match(GM_SOURCE, /safe\("reputation\.index30", getReputationSnapshot\(\{ propertyId, now \}\), null\)/);
    assert.match(GM_SOURCE, /safe\("reputation\.sources", prisma\.reviewSource\.count\(\{ where: \{ propertyId, status: "connected" \} \}\), null\)/);
    assert.match(GM_SOURCE, /safe\("reputation\.nps30", npsFromSurveys\(propertyId, 30\), null\)/);
  });

  it("el módulo se comprueba en el espejo síncrono antes de consultar el índice y npsFromSurveys viene de surveys.service", () => {
    assert.match(GM_SOURCE, /import \{ npsFromSurveys \} from "\.\/surveys\.service\.js";/);
    assert.match(GM_SOURCE, /import \{ getEnabledModuleCodes \} from "\.\.\/product-modules\/product-modules\.service\.js";/);
    assert.match(GM_SOURCE, /import type \{ GmReputationIndex \} from "\.\.\/reputation\/reputation-types\.js";/);
    assert.match(GM_SOURCE, /const moduleEnabled = \(getEnabledModuleCodes\(propertyId\) as readonly string\[\]\)\.includes\(REPUTATION_MODULE_CODE\);/);
    assert.match(GM_SOURCE, /const snapshot = moduleEnabled \? await safe\("reputation\.index30"/);
    assert.match(GM_SOURCE, /reputationIndex\?: GmReputationIndex;/);
    assert.match(GM_SOURCE, /if \(reputation && nps30 !== null\) reputation = \{ \.\.\.reputation, npsLast30: nps30 \};/);
    assert.match(GM_SOURCE, /reputation,\s*reputationIndex,\s*degraded\s*\};/);
  });
});

describe("composeGmReputationIndex (puro)", () => {
  it("módulo apagado → module_off sin consultar el snapshot; fuentes y NPS se conservan", () => {
    const out = composeGmReputationIndex({ snapshot: null, sourcesConnected: 2, nps30: 40, moduleEnabled: false });
    assert.deepEqual(out, { status: "module_off", reviewCount30: 0, npsLast30: 40, sourcesConnected: 2, staleDays: 0 });
    const bare = composeGmReputationIndex({ snapshot: null, sourcesConnected: null, nps30: null, moduleEnabled: false });
    assert.deepEqual(bare, { status: "module_off", reviewCount30: 0, sourcesConnected: 0, staleDays: 0 });
  });

  it("no_sources: snapshot sin fuentes; también cuando el snapshot cayó al fallback y no hay fuentes conectadas", () => {
    const out = composeGmReputationIndex({ snapshot: snapshot({ status: "no_sources" }), sourcesConnected: 0, nps30: null, moduleEnabled: true });
    assert.deepEqual(out, { status: "no_sources", reviewCount30: 0, sourcesConnected: 0, staleDays: 0 });
    const fallback = composeGmReputationIndex({ snapshot: null, sourcesConnected: 0, nps30: null, moduleEnabled: true });
    assert.equal(fallback.status, "no_sources");
    const fallbackWithSources = composeGmReputationIndex({ snapshot: null, sourcesConnected: 3, nps30: null, moduleEnabled: true });
    assert.deepEqual(fallbackWithSources, { status: "no_reviews", reviewCount30: 0, sourcesConnected: 3, staleDays: 0 });
  });

  it("insufficient: reviewCount30 < 10 sin index30 ni tendencia; responseRatePct sí viaja", () => {
    const out = composeGmReputationIndex({
      snapshot: snapshot({ status: "insufficient", index30: { status: "insufficient", windowDays: 30, reviewCount: 4, bySource: [], categoryImpact: [], responseRatePct: 25 }, sourcesConnected: 1 }),
      sourcesConnected: null,
      nps30: null,
      moduleEnabled: true
    });
    assert.deepEqual(out, { status: "insufficient", reviewCount30: 4, responseRatePct: 25, sourcesConnected: 1, staleDays: 0 });
    assert.equal("index30" in out, false);
    assert.equal("trendDelta" in out, false);
  });

  it("ok: index30, tendencia, recuento, tasa de respuesta, NPS y fuentes conectadas (el recuento aparte manda)", () => {
    const out = composeGmReputationIndex({
      snapshot: snapshot({
        status: "ok",
        index30: { status: "ok", windowDays: 30, index: 82.4, reviewCount: 12, bySource: [], categoryImpact: [], responseRatePct: 16.7, medianResponseHours: 24 },
        trendDelta: -1.5,
        sourcesConnected: 1
      }),
      sourcesConnected: 2,
      nps30: 0,
      moduleEnabled: true
    });
    assert.deepEqual(out, { status: "ok", index30: 82.4, trendDelta: -1.5, reviewCount30: 12, responseRatePct: 16.7, npsLast30: 0, sourcesConnected: 2, staleDays: 0 });
  });

  it("no_reviews con fuentes: sin índice, con fuentes conectadas", () => {
    const out = composeGmReputationIndex({ snapshot: snapshot({ status: "no_reviews", sourcesConnected: 2 }), sourcesConnected: null, nps30: null, moduleEnabled: true });
    assert.deepEqual(out, { status: "no_reviews", reviewCount30: 0, sourcesConnected: 2, staleDays: 0 });
  });
});

describe("quality.service.ts · enlace con las reseñas", () => {
  it("el caseType de los casos de reseña coincide con review-alerts.service.ts", () => {
    assert.equal(QUALITY_REVIEW_CASE_TYPE, REVIEW_ALERT_CASE_TYPE);
    assert.equal(QUALITY_REVIEW_CASE_TYPE, "review_negative");
  });

  it("reviewIdFromCaseDescription lee el marcador «[reseña:<id>]» al inicio y nada más", () => {
    assert.equal(reviewIdFromCaseDescription("[reseña:rev_abc123]\nResumen enmascarado."), "rev_abc123");
    assert.equal(reviewIdFromCaseDescription("  [reseña:cmx0001]"), "cmx0001");
    assert.equal(reviewIdFromCaseDescription("Sin marcador [reseña:rev_x]"), null);
    assert.equal(reviewIdFromCaseDescription("[reseña:]"), null);
    assert.equal(reviewIdFromCaseDescription(null), null);
    assert.equal(reviewIdFromCaseDescription(undefined), null);
    assert.equal(reviewIdFromCaseDescription(""), null);
  });
});

describe("surveys.service.ts · regla NPS compartida", () => {
  it("scoreOfSurveyResponse: columna score primero; si falta, responsesJson.score|nps|npsScore|rating", () => {
    assert.equal(scoreOfSurveyResponse({ score: 9, responsesJson: { nps: 2 } }), 9);
    assert.equal(scoreOfSurveyResponse({ score: "7.5", responsesJson: null }), 7.5);
    assert.equal(scoreOfSurveyResponse({ score: null, responsesJson: { nps: 8 } }), 8);
    assert.equal(scoreOfSurveyResponse({ score: null, responsesJson: { npsScore: "6" } }), 6);
    assert.equal(scoreOfSurveyResponse({ score: null, responsesJson: { rating: 10 } }), 10);
    assert.equal(scoreOfSurveyResponse({ score: null, responsesJson: { comment: "sin nota" } }), null);
    assert.equal(scoreOfSurveyResponse({ score: undefined, responsesJson: [] }), null);
  });

  it("npsBucketFor: ≥ 9 promotor · ≤ 6 detractor · 7-8 pasivo (redondeo y recorte a 0-10)", () => {
    assert.equal(npsBucketFor(10), "promoter");
    assert.equal(npsBucketFor(8.6), "promoter");
    assert.equal(npsBucketFor(8.4), "passive");
    assert.equal(npsBucketFor(7), "passive");
    assert.equal(npsBucketFor(6.4), "detractor");
    assert.equal(npsBucketFor(0), "detractor");
    assert.equal(npsBucketFor(-3), "detractor");
    assert.equal(npsBucketFor(14), "promoter");
  });

  it("tallyNps: (promotores − detractores) / puntuadas × 100 a 1 decimal; null sin puntuadas", () => {
    assert.deepEqual(tallyNps([10, 9, 9, 7, 3]), { promoters: 3, passives: 1, detractors: 1, scored: 5, nps: 40 });
    assert.deepEqual(tallyNps([10, 3, null]), { promoters: 1, passives: 0, detractors: 1, scored: 2, nps: 0 });
    assert.deepEqual(tallyNps([8, 7, 7]), { promoters: 0, passives: 3, detractors: 0, scored: 3, nps: 0 });
    assert.deepEqual(tallyNps([9, 9, 6]), { promoters: 2, passives: 0, detractors: 1, scored: 3, nps: 33.3 });
    assert.deepEqual(tallyNps([null, null]), { promoters: 0, passives: 0, detractors: 0, scored: 0, nps: null });
    assert.deepEqual(tallyNps([]), { promoters: 0, passives: 0, detractors: 0, scored: 0, nps: null });
  });
});
