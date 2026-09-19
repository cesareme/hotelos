/**
 * Tanda T8 · lote T8-E — dashboards de reputación sobre las tablas existentes
 * (Postgres real, app.inject, tenant aislado de helpers/l2-tenant.mts).
 *
 * Organización aislada con el módulo reputation_quality activado SOLO en el
 * hotel A (enableModules inserta property_modules sin pasar por la dependencia
 * ai_concierge). Recorrido:
 *   · sin fuentes → GET /dashboards/reputation status `no_sources`, degraded [];
 *   · 3 fuentes (csv connected, demo connected con colector ficticio inyectado,
 *     tripadvisor por correo sin buzón → skipped honesto) y 12 reseñas FICTICIAS
 *     (5 csv + 3 tripadvisor importadas por upsertReviewFromNormalized + 4 que
 *     «trae» el colector demo en runReputationSync, que además analiza con
 *     etiqueta `dictionary` y abre los casos review_negative);
 *   · GET /dashboards/reputation → status `ok`, index30 en 0-100, bySource con
 *     weightShare que suma 1, categorías con impacto, recentReviews con
 *     score10/status/analysisSource;
 *   · 1 encuesta con 5 respuestas → GET /dashboards/surveys degraded [] y NPS
 *     real (40) = npsFromSurveys(A, 30);
 *   · GET /dashboards/general-manager → reputationIndex.status `ok`,
 *     reputation.reviewsLast30 = 12 (bloque L2 intacto), reputation.npsLast30 y
 *     reputationIndex.npsLast30 = 40, degraded sin etiquetas de reputación;
 *   · hotel B (módulo apagado) → reputationIndex.status `module_off`,
 *     reputation undefined y degraded [] (l2-robustez);
 *   · GET /dashboards/quality → kpis.fromReviews = casos abiertos por las alertas
 *     y recentCases[].reviewId enlazado;
 *   · GET /dashboards/property-overview → guestExperience.reputationIndex30 en A
 *     (≈ índice del dashboard) y null en B, avgReviewRating/pendingReviews intactos.
 * Al terminar borra su organización (comprobación local: las suites hermanas
 * crean y borran las suyas en paralelo); las invariantes de Faranda son
 * idénticas antes y después. Nunca reseñas ni nombres reales.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l8-reputation-dashboards.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type FarandaInvariants = Awaited<ReturnType<typeof farandaInvariants>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { collectorFor: registryCollectorFor } = await import("../../apps/api/src/modules/reputation/collectors/index.js");
const { DEFAULT_SOURCE_CAPABILITIES, INDEX_MIN_REVIEWS, SCORE10_NEGATIVE } = await import("../../apps/api/src/modules/reputation/reputation-types.js");
const { createReviewSource } = await import("../../apps/api/src/modules/reputation/review-sources.service.js");
const { upsertReviewFromNormalized } = await import("../../apps/api/src/modules/reputation/review-meta.store.js");
const { runReputationSync } = await import("../../apps/api/src/modules/reputation/reputation-sync.service.js");
const { invalidateReputationCache, resetSchemaPatchCacheForTests } = await import("../../apps/api/src/modules/reputation/reputation-score.service.js");
const { npsFromSurveys } = await import("../../apps/api/src/modules/dashboards/surveys.service.js");
const { QUALITY_REVIEW_CASE_TYPE } = await import("../../apps/api/src/modules/dashboards/quality.service.js");

import type { NormalizedReview, ReviewCollector } from "../../apps/api/src/modules/reputation/collectors/types.js";
import type { ReputationDashboard } from "../../apps/api/src/modules/dashboards/reputation.service.js";
import type { GmDashboard } from "../../apps/api/src/modules/dashboards/general-manager.service.js";
import type { SurveysDashboard } from "../../apps/api/src/modules/dashboards/surveys.service.js";
import type { QualityDashboard } from "../../apps/api/src/modules/dashboards/quality.service.js";
import type { PropertyOverview } from "../../apps/api/src/modules/dashboards/property-overview.service.js";

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const NOW = new Date();
const DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

/** 5 reseñas FICTICIAS importadas como csv (escala 5): 1 negativa (< 6/10). */
const CSV_FIXTURES: NormalizedReview[] = [
  { externalId: "csv-01", receivedAt: daysAgo(1), ratingRaw: 5, ratingScaleMax: 5, title: "Excelente", body: "Personal atento y habitación impecable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Uno", replyCapability: false },
  { externalId: "csv-02", receivedAt: daysAgo(2), ratingRaw: 4.5, ratingScaleMax: 5, title: "Muy bien", body: "Desayuno variado y buena ubicación.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Dos", replyCapability: false },
  { externalId: "csv-03", receivedAt: daysAgo(3), ratingRaw: 4, ratingScaleMax: 5, title: "Correcto", body: "Todo bien salvo el wifi, algo lento.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Tres", replyCapability: false },
  { externalId: "csv-04", receivedAt: daysAgo(4), ratingRaw: 1.5, ratingScaleMax: 5, title: "Muy mal", body: "La habitación estaba sucia y había ruido toda la noche.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Cuatro", replyCapability: false },
  { externalId: "csv-05", receivedAt: daysAgo(5), ratingRaw: 3.5, ratingScaleMax: 5, title: "Normal", body: "Estancia sin sorpresas.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Cinco", replyCapability: false }
];

/** 3 reseñas FICTICIAS «recibidas por correo» de Tripadvisor (escala 5): 1 negativa. */
const TRIPADVISOR_FIXTURES: NormalizedReview[] = [
  { externalId: "ta-01", receivedAt: daysAgo(2), ratingRaw: 5, ratingScaleMax: 5, title: "Perfecto", body: "Todo perfecto, gracias al equipo.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Seis", replyCapability: false },
  { externalId: "ta-02", receivedAt: daysAgo(6), ratingRaw: 2, ratingScaleMax: 5, title: "Decepcionante", body: "El personal fue maleducado y el desayuno escaso.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Siete", replyCapability: false },
  { externalId: "ta-03", receivedAt: daysAgo(7), ratingRaw: 4, ratingScaleMax: 5, title: "Bien", body: "Buena relación calidad-precio.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Ocho", replyCapability: false }
];

/** 4 reseñas FICTICIAS que «trae» el colector demo inyectado (escala 10): 1 negativa. */
const DEMO_FIXTURES: NormalizedReview[] = [
  { externalId: "demo-01", receivedAt: daysAgo(1), ratingRaw: 9, ratingScaleMax: 10, title: "Genial", body: "Personal excelente.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Uno", replyCapability: false },
  { externalId: "demo-02", receivedAt: daysAgo(2), ratingRaw: 8, ratingScaleMax: 10, title: "Bien", body: "Buena ubicación.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Dos", replyCapability: false },
  { externalId: "demo-03", receivedAt: daysAgo(3), ratingRaw: 4, ratingScaleMax: 10, title: "Flojo", body: "Ruido y limpieza mejorable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Tres", replyCapability: false },
  { externalId: "demo-04", receivedAt: daysAgo(4), ratingRaw: 7, ratingScaleMax: 10, title: "Correcto", body: "Sin incidencias.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Cuatro", replyCapability: false }
];

const fakeDemoCollector: ReviewCollector = {
  provider: "demo",
  mode: "demo",
  capabilities: DEFAULT_SOURCE_CAPABILITIES.demo,
  describeState: () => ({ status: "connected" }),
  fetchSince: async () => ({ items: DEMO_FIXTURES, status: "connected" })
};
const collectorFor = (provider: string, mode: Parameters<typeof registryCollectorFor>[1]) => (provider === "demo" ? fakeDemoCollector : registryCollectorFor(provider, mode));

const NEGATIVES =
  CSV_FIXTURES.filter((item) => ((item.ratingRaw as number) / 5) * 10 < SCORE10_NEGATIVE).length +
  TRIPADVISOR_FIXTURES.filter((item) => ((item.ratingRaw as number) / 5) * 10 < SCORE10_NEGATIVE).length +
  DEMO_FIXTURES.filter((item) => (item.ratingRaw as number) < SCORE10_NEGATIVE).length;
const TOTAL_REVIEWS = CSV_FIXTURES.length + TRIPADVISOR_FIXTURES.length + DEMO_FIXTURES.length;

/** 5 respuestas FICTICIAS: 10, 9, 9 promotores · 7 pasivo · 3 detractor → NPS 40. */
const SURVEY_SCORES = [10, 9, 9, 7, 3] as const;
const EXPECTED_NPS = 40;

let app: ApiApp;
let tenant: IsolatedTenant;
let owner: Session;
let invariantsBefore: FarandaInvariants;
let dashboardIndex30: number | null = null;

async function getJson<T>(url: string, headers: Headers): Promise<{ status: number; body: T | null; text: string }> {
  return withEnv(STRICT_ENV, async () => {
    const res = await app.inject({ method: "GET", url, headers });
    let body: T | null = null;
    try {
      body = JSON.parse(res.body) as T;
    } catch {
      body = null;
    }
    return { status: res.statusCode, body, text: res.body };
  });
}

describe("L8 · dashboards de reputación sobre tablas existentes (tenant aislado, app.inject)", () => {
  before(async () => {
    assert.ok(TOTAL_REVIEWS >= INDEX_MIN_REVIEWS, "las fixtures deben alcanzar el mínimo del índice");
    invariantsBefore = await farandaInvariants();
    tenant = await createIsolatedTenant(newRunId());
    await enableModules(tenant.propertyA, ["guest_experience", "ai_concierge", "reputation_quality"]);
    resetSchemaPatchCacheForTests();
    invalidateReputationCache();
    app = await buildApiServer();
    await app.ready();
    await withEnv(STRICT_ENV, async () => {
      owner = await loginOrThrow(app, tenant.users.owner.email, tenant.password, "l8-dashboards-owner");
    });
  });

  after(async () => {
    try {
      await flushAuditQueues();
      if (tenant) await cleanupTenant(tenant.organizationId);
    } finally {
      if (app) await app.close();
    }
    invalidateReputationCache();
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "Faranda debe quedar idéntica");
    // Comprobación local a esta suite (las suites hermanas crean y borran sus propias organizaciones en paralelo).
    assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "la organización aislada debe desaparecer");
  });

  it("sin fuentes: /dashboards/reputation responde 200 con status no_sources, degraded [] y todo a cero", async () => {
    const res = await getJson<ReputationDashboard>(`/dashboards/reputation?propertyId=${tenant.propertyA}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const body = res.body!;
    assert.equal(body.status, "no_sources");
    assert.deepEqual(body.degraded, []);
    assert.deepEqual(body.sources, []);
    assert.deepEqual(body.bySource, []);
    assert.equal(body.index.status, "no_sources");
    assert.equal(body.index.reviewCount30, 0);
    assert.deepEqual(body.kpis, { avgRating: 0, reviewsLast7d: 0, reviewsLast30d: 0, pendingResponses: 0, sentimentScore: 0 });
    assert.deepEqual(body.recentReviews, []);
    assert.equal(body.windowDays, 30);
  });

  it("3 fuentes + 12 reseñas ficticias: el tick analiza con etiqueta dictionary y abre los casos review_negative", async () => {
    const actor = { organizationId: tenant.organizationId, userId: tenant.users.generalManager.id, correlationId: "corr_l8_dash_sources" };
    const csv = await createReviewSource({ propertyId: tenant.propertyA, input: { provider: "csv", displayName: "Importación manual" }, actor });
    assert.equal(csv.status, "connected");
    const demo = await createReviewSource({ propertyId: tenant.propertyA, input: { provider: "demo" }, actor });
    assert.equal(demo.status, "connected");
    const tripadvisor = await createReviewSource({ propertyId: tenant.propertyA, input: { provider: "tripadvisor" }, actor });
    assert.equal(tripadvisor.mode, "email");
    assert.notEqual(tripadvisor.status, "connected", "sin buzón conectado la fuente no puede decirse connected");

    for (const item of CSV_FIXTURES) {
      const out = await upsertReviewFromNormalized({ propertyId: tenant.propertyA, source: "csv", sourceId: csv.id, sourceMode: "csv", item, now: NOW });
      assert.equal(out.outcome, "created");
    }
    for (const item of TRIPADVISOR_FIXTURES) {
      const out = await upsertReviewFromNormalized({ propertyId: tenant.propertyA, source: "tripadvisor", sourceId: tripadvisor.id, sourceMode: "email", item, now: NOW });
      assert.equal(out.outcome, "created");
    }

    const summary = await withEnv(STRICT_ENV, () => runReputationSync({ propertyIds: [tenant.propertyA], now: NOW, trigger: "manual", collectorFor }));
    assert.equal(summary.properties, 1);
    assert.equal(summary.sources, 3);
    assert.equal(summary.created, DEMO_FIXTURES.length);
    assert.equal(summary.analyzed, TOTAL_REVIEWS);
    assert.equal(summary.alerts, NEGATIVES);
    assert.deepEqual(summary.errors, []);
    assert.equal(await prisma.guestReview.count({ where: { propertyId: tenant.propertyA } }), TOTAL_REVIEWS);
    assert.equal(await prisma.qualityCase.count({ where: { propertyId: tenant.propertyA, caseType: QUALITY_REVIEW_CASE_TYPE, status: "open" } }), NEGATIVES);
    invalidateReputationCache();
  });

  it("/dashboards/reputation con datos: status ok, index30 en 0-100, bySource suma weightShare 1, categorías con impacto", async () => {
    const res = await getJson<ReputationDashboard>(`/dashboards/reputation?propertyId=${tenant.propertyA}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const body = res.body!;
    assert.equal(body.status, "ok");
    assert.deepEqual(body.degraded, []);
    assert.equal(typeof body.index.index30, "number");
    assert.ok((body.index.index30 as number) >= 0 && (body.index.index30 as number) <= 100, `index30 ${body.index.index30}`);
    assert.equal(body.index.reviewCount30, TOTAL_REVIEWS);
    assert.equal(body.index.status, "ok");
    assert.deepEqual(body.indexByWindow.map((entry) => entry.windowDays), [30, 90, 365]);
    dashboardIndex30 = body.index.index30 as number;

    assert.equal(body.sources.length, 3);
    for (const source of body.sources) assert.equal(source.hasCredentials, false);
    assert.deepEqual(body.bySource.map((entry) => entry.provider).sort(), ["csv", "demo", "tripadvisor"]);
    const share = body.bySource.reduce((total, entry) => total + entry.weightShare, 0);
    assert.ok(Math.abs(share - 1) < 0.01, `weightShare suma ${share}`);
    const csv = body.bySource.find((entry) => entry.provider === "csv")!;
    assert.equal(csv.count, CSV_FIXTURES.length);
    assert.equal(csv.status, "connected");
    assert.equal(csv.displayName, "Importación manual");
    assert.equal(typeof csv.avg10, "number");
    const demo = body.bySource.find((entry) => entry.provider === "demo")!;
    assert.equal(demo.count, DEMO_FIXTURES.length);
    assert.ok(demo.lastRunAt, "la fuente demo registró su ejecución");
    const tripadvisor = body.bySource.find((entry) => entry.provider === "tripadvisor")!;
    assert.equal(tripadvisor.count, TRIPADVISOR_FIXTURES.length);
    assert.notEqual(tripadvisor.status, "connected");

    assert.ok(body.categories.length > 0, "el diccionario detecta categorías en las reseñas ficticias");
    assert.ok(body.categories.some((entry) => entry.impact > 0), `alguna categoría resta puntos: ${JSON.stringify(body.categories)}`);
    for (const entry of body.categories) {
      assert.equal(entry.negative, entry.negativeMentions);
      assert.equal(typeof entry.label, "string");
    }

    assert.deepEqual(body.distribution10, body.scoreDistribution);
    const buckets = Object.values(body.distribution10).reduce((total, value) => total + value, 0);
    assert.equal(buckets, TOTAL_REVIEWS);
    assert.equal(body.kpis.reviewsLast30d, TOTAL_REVIEWS);
    assert.equal(body.kpis.reviewsLast7d, TOTAL_REVIEWS - 1, "solo ta-03 (7 días) queda fuera de la ventana de 7 días");
    assert.equal(body.kpis.pendingResponses, TOTAL_REVIEWS);
    assert.ok(body.kpis.avgRating > 0 && body.kpis.avgRating <= 5);
    assert.equal(body.recentReviews.length, 10);
    for (const review of body.recentReviews) {
      assert.equal(typeof review.score10, "number");
      assert.equal(review.analysisSource, "dictionary");
      assert.ok(["new", "assigned"].includes(review.status), review.status);
      assert.equal(typeof review.receivedAt, "string");
      assert.equal(typeof review.createdAt, "string");
    }
    assert.equal(body.inbox.open, TOTAL_REVIEWS);
    assert.equal(body.responseRatePct, null, "todas las fuentes declaran replyCapability false: sin denominador");
    assert.equal(body.medianResponseHours, null);
  });

  it("encuestas: 1 encuesta con 5 respuestas → /dashboards/surveys degraded [] y NPS real; npsFromSurveys(A, 30) = 40, en B null", async () => {
    const survey = await prisma.survey.create({ data: { propertyId: tenant.propertyA, name: "Encuesta post-estancia (ficticia)", surveyType: "post_stay" } });
    await prisma.surveyResponse.createMany({
      data: SURVEY_SCORES.map((score, index) => ({ surveyId: survey.id, score, responsesJson: { comment: `Respuesta ficticia ${index + 1}` } }))
    });
    assert.equal(await npsFromSurveys(tenant.propertyA, 30), EXPECTED_NPS);
    assert.equal(await npsFromSurveys(tenant.propertyB, 30), null);
    const res = await getJson<SurveysDashboard>(`/dashboards/surveys?propertyId=${tenant.propertyA}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.deepEqual(res.body!.degraded, []);
    assert.equal(res.body!.kpis.nps90d, EXPECTED_NPS);
    assert.equal(res.body!.kpis.totalResponses90d, SURVEY_SCORES.length);
    assert.equal(res.body!.kpis.promoters, 3);
    assert.equal(res.body!.kpis.passives, 1);
    assert.equal(res.body!.kpis.detractors, 1);
  });

  it("director en A: reputationIndex.status ok, reputation.reviewsLast30 = 12 (bloque L2 intacto), npsLast30 real y degraded sin reputación", async () => {
    invalidateReputationCache(tenant.propertyA);
    const res = await getJson<GmDashboard>(`/dashboards/general-manager?propertyId=${tenant.propertyA}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const body = res.body!;
    assert.ok(body.reputationIndex, "reputationIndex presente");
    assert.equal(body.reputationIndex!.status, "ok");
    assert.equal(typeof body.reputationIndex!.index30, "number");
    assert.equal(body.reputationIndex!.reviewCount30, TOTAL_REVIEWS);
    assert.equal(body.reputationIndex!.sourcesConnected, 2);
    assert.equal(body.reputationIndex!.staleDays, 0);
    assert.equal(body.reputationIndex!.npsLast30, EXPECTED_NPS);
    assert.equal(body.reputationIndex!.trendDelta, undefined, "hace 30 días no había reseñas: sin tendencia");
    assert.ok(body.reputation, "bloque reputation (L2) presente");
    assert.equal(body.reputation!.reviewsLast30, TOTAL_REVIEWS);
    assert.equal(typeof body.reputation!.avgScore, "number");
    assert.equal(body.reputation!.npsLast30, EXPECTED_NPS);
    assert.deepEqual(body.degraded.filter((label) => label.startsWith("reputation.")), []);
    if (dashboardIndex30 !== null) {
      assert.ok(Math.abs((body.reputationIndex!.index30 as number) - dashboardIndex30) <= 0.2, `director ${body.reputationIndex!.index30} vs dashboard ${dashboardIndex30}`);
    }
  });

  it("director en B (módulo apagado): reputationIndex.status module_off, reputation undefined y degraded []", async () => {
    const res = await getJson<GmDashboard>(`/dashboards/general-manager?propertyId=${tenant.propertyB}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const body = res.body!;
    assert.deepEqual(body.reputationIndex, { status: "module_off", reviewCount30: 0, sourcesConnected: 0, staleDays: 0 });
    assert.equal(body.reputation, undefined);
    assert.deepEqual(body.degraded, []);
  });

  it("calidad: kpis.fromReviews = casos abiertos por las alertas y recentCases[].reviewId enlazado a una reseña", async () => {
    const res = await getJson<QualityDashboard>(`/dashboards/quality?propertyId=${tenant.propertyA}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const body = res.body!;
    assert.equal(body.kpis.fromReviews, NEGATIVES);
    assert.equal(body.kpis.openCases, NEGATIVES);
    assert.deepEqual(body.casesByType, [{ caseType: QUALITY_REVIEW_CASE_TYPE, count: NEGATIVES }]);
    const linked = body.recentCases.filter((entry) => typeof entry.reviewId === "string");
    assert.equal(linked.length, NEGATIVES);
    const reviewIds = new Set((await prisma.guestReview.findMany({ where: { propertyId: tenant.propertyA }, select: { id: true } })).map((row) => row.id));
    for (const entry of linked) assert.ok(reviewIds.has(entry.reviewId!), `reviewId ${entry.reviewId} pertenece al hotel A`);
    const resB = await getJson<QualityDashboard>(`/dashboards/quality?propertyId=${tenant.propertyB}`, owner.headers);
    assert.equal(resB.status, 200);
    assert.equal(resB.body!.kpis.fromReviews, 0);
  });

  it("panel de propiedad: guestExperience.reputationIndex30 en A (≈ índice del dashboard) y null en B; avgReviewRating/pendingReviews intactos", async () => {
    const resA = await getJson<PropertyOverview>(`/dashboards/property-overview?propertyId=${tenant.propertyA}`, owner.headers);
    assert.equal(resA.status, 200, resA.text.slice(0, 200));
    const a = resA.body!.guestExperience;
    assert.equal(typeof a.reputationIndex30, "number");
    if (dashboardIndex30 !== null) assert.ok(Math.abs((a.reputationIndex30 as number) - dashboardIndex30) <= 0.2, `overview ${a.reputationIndex30} vs dashboard ${dashboardIndex30}`);
    // Regla heredada (l2-paginacion :634-638): media de rating > 0 a 1 decimal y pendientes con nota sin respuesta.
    const reviews = await prisma.guestReview.findMany({ where: { propertyId: tenant.propertyA }, select: { rating: true, respondedAt: true } });
    const rated = reviews.map((row) => (row.rating === null ? null : Number(row.rating))).filter((value): value is number => value !== null && value > 0);
    const expectedAvg = rated.length ? Math.round((rated.reduce((sum, value) => sum + value, 0) / rated.length) * 10) / 10 : 0;
    assert.equal(a.avgReviewRating, expectedAvg);
    assert.equal(a.pendingReviews, reviews.filter((row) => row.rating !== null && Number(row.rating) > 0 && row.respondedAt === null).length);
    const resB = await getJson<PropertyOverview>(`/dashboards/property-overview?propertyId=${tenant.propertyB}`, owner.headers);
    assert.equal(resB.status, 200);
    assert.equal(resB.body!.guestExperience.reputationIndex30, null);
    assert.equal(resB.body!.guestExperience.pendingReviews, 0);
  });

  it("hotel B sin módulo: /dashboards/reputation sigue en 200 pero honesto: module_off, degraded [] y sin reseñas (HP-06: analytics.read no lee reseñas de un módulo apagado)", async () => {
    const res = await getJson<ReputationDashboard>(`/dashboards/reputation?propertyId=${tenant.propertyB}`, owner.headers);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(res.body!.status, "module_off");
    assert.deepEqual(res.body!.degraded, []);
    assert.deepEqual(res.body!.recentReviews, []);
    assert.deepEqual(res.body!.bySource, []);
  });
});
