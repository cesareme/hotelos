/**
 * Tanda T8 · lote T8-C — sincronización de reseñas sobre las tablas existentes
 * (Postgres real, tenant aislado de helpers/l2-tenant.mts).
 *
 * Organización aislada con el módulo reputation_quality activado en el hotel A
 * (enableModules inserta property_modules sin pasar por la dependencia
 * ai_concierge): dos fuentes por review-sources.service (csv → connected,
 * booking → unavailable con motivo honesto) más una demo con colector ficticio
 * inyectado; 15 reseñas FICTICIAS importadas por upsertReviewFromNormalized
 * (idempotente); runReputationSync → contadores, análisis con etiqueta honesta
 * `dictionary`, un caso review_negative por reseña < 6, ReviewReceived en
 * audit_events de la organización tras flushAuditQueues(); segundo tick con 0
 * creadas y sin casos duplicados; purga por retención (1 día en la fuente csv)
 * que vacía el cuerpo y conserva la nota; getReputationSnapshot `ok` en A y
 * `module_off` en B (sin módulo); borrador HITL que nunca escribe
 * responseBody (ni al aprobar el ítem). Al terminar borra la organización;
 * las invariantes de Faranda son idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l8-reputation-sync.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type FarandaInvariants = Awaited<ReturnType<typeof farandaInvariants>>;

const { prisma } = await import("@hotelos/database");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { approveReview } = await import("../../apps/api/src/modules/ai-operations/human-review.service.js");
const { BOOKING_UNAVAILABLE_REASON, collectorFor: registryCollectorFor } = await import("../../apps/api/src/modules/reputation/collectors/index.js");
const { DEFAULT_SOURCE_CAPABILITIES, readReviewMeta, readSourceConfig, SCORE10_NEGATIVE } = await import("../../apps/api/src/modules/reputation/reputation-types.js");
const { createReviewSource, listReviewSources, updateReviewSource } = await import("../../apps/api/src/modules/reputation/review-sources.service.js");
const { purgeExpiredBodies, upsertReviewFromNormalized } = await import("../../apps/api/src/modules/reputation/review-meta.store.js");
const { runReputationSync } = await import("../../apps/api/src/modules/reputation/reputation-sync.service.js");
const { getReputationSnapshot, invalidateReputationCache, resetSchemaPatchCacheForTests } = await import("../../apps/api/src/modules/reputation/reputation-score.service.js");
const { createReviewDraft } = await import("../../apps/api/src/modules/reputation/review-draft.service.js");
const { listInbox, getReview } = await import("../../apps/api/src/modules/reputation/review-inbox.service.js");
const { parsePageQuery } = await import("../../apps/api/src/lib/pagination.js");

import type { NormalizedReview, ReviewCollector } from "../../apps/api/src/modules/reputation/collectors/types.js";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

const NOW = new Date();
const DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

/** 15 reseñas FICTICIAS para la fuente csv: notas sobre 5 (escala declarada por fila), 3 negativas (< 6/10). */
const CSV_FIXTURES: NormalizedReview[] = [
  { externalId: "csv-01", receivedAt: daysAgo(2), ratingRaw: 5, ratingScaleMax: 5, title: "Excelente", body: "Personal atento y habitación impecable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Uno", replyCapability: false },
  { externalId: "csv-02", receivedAt: daysAgo(3), ratingRaw: 4.5, ratingScaleMax: 5, title: "Muy bien", body: "Desayuno variado y buena ubicación.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Dos", replyCapability: false },
  { externalId: "csv-03", receivedAt: daysAgo(4), ratingRaw: 4, ratingScaleMax: 5, title: "Correcto", body: "Todo bien salvo el wifi, algo lento.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Tres", replyCapability: false },
  { externalId: "csv-04", receivedAt: daysAgo(5), ratingRaw: 1.5, ratingScaleMax: 5, title: "Muy mal", body: "La habitación estaba sucia y había ruido toda la noche.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Cuatro", replyCapability: false },
  { externalId: "csv-05", receivedAt: daysAgo(6), ratingRaw: 3.5, ratingScaleMax: 5, title: "Normal", body: "Estancia sin sorpresas.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Cinco", replyCapability: false },
  { externalId: "csv-06", receivedAt: daysAgo(7), ratingRaw: 5, ratingScaleMax: 5, title: "Great stay", body: "Lovely staff and a quiet room.", bodyComplete: true, language: "en", authorDisplayName: "Fictional Guest Six", replyCapability: false },
  { externalId: "csv-07", receivedAt: daysAgo(8), ratingRaw: 2.5, ratingScaleMax: 5, title: "Decepcionante", body: "El desayuno era escaso y la recepción lenta.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Siete", replyCapability: false },
  { externalId: "csv-08", receivedAt: daysAgo(9), ratingRaw: 4, ratingScaleMax: 5, title: "Bien", body: "Buena relación calidad-precio.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Ocho", replyCapability: false },
  { externalId: "csv-09", receivedAt: daysAgo(10), ratingRaw: 4.5, ratingScaleMax: 5, title: "Repetiremos", body: "Instalaciones cuidadas y personal amable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Nueve", replyCapability: false },
  { externalId: "csv-10", receivedAt: daysAgo(11), ratingRaw: 1, ratingScaleMax: 5, title: "Nunca más", body: "Mantenimiento deficiente: el aire acondicionado no funcionaba.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Diez", replyCapability: false },
  { externalId: "csv-11", receivedAt: daysAgo(12), ratingRaw: 4, ratingScaleMax: 5, title: "Agradable", body: "Ubicación céntrica y limpieza correcta.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Once", replyCapability: false },
  { externalId: "csv-12", receivedAt: daysAgo(13), ratingRaw: 3.5, ratingScaleMax: 5, title: "Aceptable", body: "Habitación pequeña pero limpia.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Doce", replyCapability: false },
  { externalId: "csv-13", receivedAt: daysAgo(14), ratingRaw: 5, ratingScaleMax: 5, title: "Perfecto", body: "Todo perfecto, gracias al equipo.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Trece", replyCapability: false },
  { externalId: "csv-14", receivedAt: daysAgo(15), ratingRaw: 4.5, ratingScaleMax: 5, title: "Sehr gut", body: "Sauberes Zimmer und freundliches Personal.", bodyComplete: true, language: "de", authorDisplayName: "Fiktiver Gast Vierzehn", replyCapability: false },
  { externalId: "csv-15", receivedAt: daysAgo(16), ratingRaw: 4, ratingScaleMax: 5, title: "Bien en general", body: "Buen desayuno; el parking es caro.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Quince", replyCapability: false }
];

/** 5 reseñas FICTICIAS que «trae» el colector demo inyectado (1 negativa). */
const DEMO_FIXTURES: NormalizedReview[] = [
  { externalId: "demo-01", receivedAt: daysAgo(1), ratingRaw: 9, ratingScaleMax: 10, title: "Genial", body: "Personal excelente.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Uno", replyCapability: false },
  { externalId: "demo-02", receivedAt: daysAgo(2), ratingRaw: 8, ratingScaleMax: 10, title: "Bien", body: "Buena ubicación.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Dos", replyCapability: false },
  { externalId: "demo-03", receivedAt: daysAgo(3), ratingRaw: 4, ratingScaleMax: 10, title: "Flojo", body: "Ruido y limpieza mejorable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Tres", replyCapability: false },
  { externalId: "demo-04", receivedAt: daysAgo(4), ratingRaw: 7, ratingScaleMax: 10, title: "Correcto", body: "Sin incidencias.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Cuatro", replyCapability: false },
  { externalId: "demo-05", receivedAt: daysAgo(5), ratingRaw: 10, ratingScaleMax: 10, title: "Volveremos", body: "Trato impecable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Demo Cinco", replyCapability: false }
];

const fakeDemoCollector: ReviewCollector = {
  provider: "demo",
  mode: "demo",
  capabilities: DEFAULT_SOURCE_CAPABILITIES.demo,
  describeState: () => ({ status: "connected" }),
  fetchSince: async () => ({ items: DEMO_FIXTURES, status: "connected" })
};
const collectorFor = (provider: string, mode: Parameters<typeof registryCollectorFor>[1]) => (provider === "demo" ? fakeDemoCollector : registryCollectorFor(provider, mode));

const NEGATIVE_CSV = CSV_FIXTURES.filter((item) => (item.ratingRaw as number) / 5 < SCORE10_NEGATIVE / 10).length;
const NEGATIVE_DEMO = DEMO_FIXTURES.filter((item) => (item.ratingRaw as number) < SCORE10_NEGATIVE).length;
const NEGATIVES = NEGATIVE_CSV + NEGATIVE_DEMO;

let tenant: IsolatedTenant;
let invariantsBefore: FarandaInvariants;
let csvSourceId = "";
let bookingSourceId = "";
let demoSourceId = "";
let draftedReviewId = "";
let reviewItemId = "";

function gmContext(permissions: string[]): UserContext {
  return {
    organizationId: tenant.organizationId,
    propertyId: tenant.propertyA,
    userId: tenant.users.generalManager.id,
    fullName: tenant.users.generalManager.fullName,
    deviceId: "l8-reputation-sync",
    permissions: permissions as never,
    isPlatformAdmin: false
  };
}

describe("L8 · reputación · sincronización sobre tablas existentes (tenant aislado)", () => {
  before(async () => {
    invariantsBefore = await farandaInvariants();
    tenant = await createIsolatedTenant(newRunId());
    await enableModules(tenant.propertyA, ["guest_experience", "ai_concierge", "reputation_quality"]);
    resetSchemaPatchCacheForTests();
    invalidateReputationCache();
  });

  after(async () => {
    if (tenant) await cleanupTenant(tenant.organizationId);
    invalidateReputationCache();
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "Faranda debe quedar idéntica");
    // Comprobación local a esta suite: las suites hermanas l8-* crean y borran sus propias organizaciones en paralelo
    // (node --test sin --test-concurrency=1), así que el recuento global de org_l2_* no es un invariante de esta suite.
    assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "la organización aislada de esta suite debe desaparecer");
  });

  it("snapshot: no_sources en A sin fuentes; module_off en B (sin módulo); schemaPatchApplied true (migración 20260919124000_reputacion)", async () => {
    const a = await getReputationSnapshot({ propertyId: tenant.propertyA, now: NOW, skipCache: true });
    assert.equal(a.status, "no_sources");
    assert.equal(a.sourcesTotal, 0);
    // T8-L0b: las 3 tablas que sondea detectSchemaPatch existen desde la migración 20260919124000_reputacion.
    assert.equal(a.schemaPatchApplied, true);
    assert.equal(a.staleDays, 0);
    const b = await getReputationSnapshot({ propertyId: tenant.propertyB, now: NOW, skipCache: true });
    assert.equal(b.status, "module_off");
    assert.deepEqual(b.degraded, []);
  });

  it("fuentes: csv → connected; booking → unavailable con lastError honesto; demo → connected; nunca credenciales", async () => {
    const actor = { organizationId: tenant.organizationId, userId: tenant.users.generalManager.id, correlationId: "corr_l8_sources" };
    const csv = await createReviewSource({ propertyId: tenant.propertyA, input: { provider: "csv", displayName: "Importación manual" }, actor });
    assert.equal(csv.status, "connected");
    assert.equal(csv.mode, "csv");
    assert.equal(csv.hasCredentials, false);
    csvSourceId = csv.id;
    const booking = await createReviewSource({ propertyId: tenant.propertyA, input: { provider: "booking" }, actor });
    assert.equal(booking.status, "unavailable");
    assert.equal(booking.lastError, BOOKING_UNAVAILABLE_REASON);
    bookingSourceId = booking.id;
    const demo = await createReviewSource({ propertyId: tenant.propertyA, input: { provider: "demo" }, actor });
    assert.equal(demo.status, "connected");
    assert.equal(demo.isDemo, true);
    demoSourceId = demo.id;
    await assert.rejects(createReviewSource({ propertyId: tenant.propertyA, input: { provider: "google", accessToken: "nunca" }, actor }), /credenciales/);
    const listed = await listReviewSources({ propertyId: tenant.propertyA });
    assert.deepEqual(listed.map((source) => source.provider).sort(), ["booking", "csv", "demo"]);
    const rows = await prisma.reviewSource.findMany({ where: { propertyId: tenant.propertyA } });
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(JSON.stringify(row.configJson).includes("nunca"), false);
  });

  it("importa 15 reseñas ficticias por upsertReviewFromNormalized; repetirlas devuelve unchanged", async () => {
    let created = 0;
    for (const item of CSV_FIXTURES) {
      const out = await upsertReviewFromNormalized({ propertyId: tenant.propertyA, source: "csv", sourceId: csvSourceId, sourceMode: "csv", item, now: NOW });
      if (out.outcome === "created") created += 1;
    }
    assert.equal(created, 15);
    let unchanged = 0;
    for (const item of CSV_FIXTURES) {
      const out = await upsertReviewFromNormalized({ propertyId: tenant.propertyA, source: "csv", sourceId: csvSourceId, sourceMode: "csv", item, now: NOW });
      if (out.outcome === "unchanged") unchanged += 1;
    }
    assert.equal(unchanged, 15);
    assert.equal(await prisma.guestReview.count({ where: { propertyId: tenant.propertyA } }), 15);
    const negative = await prisma.guestReview.findFirst({ where: { propertyId: tenant.propertyA, externalReference: "csv-04" } });
    assert.ok(negative);
    assert.equal(negative!.sentiment, "negative");
    assert.equal(Number(negative!.rating), 1.5);
    const meta = readReviewMeta(negative!.topicsJson);
    assert.equal(meta.score10, 3);
    assert.equal(meta.status, "new");
    assert.equal(meta.analysis.status, "pending");
    assert.equal(meta.authorDisplayName, "Huésped F.");
  });

  it("tick 1: la demo crea 5, booking queda en skipped, 20 análisis dictionary, un caso por reseña < 6 y ReviewReceived en audit_events", async () => {
    await withEnv(STRICT_ENV, async () => {
      const summary = await runReputationSync({ propertyIds: [tenant.propertyA], now: NOW, trigger: "manual", collectorFor });
      assert.equal(summary.properties, 1);
      assert.equal(summary.sources, 3);
      assert.equal(summary.fetched, 5);
      assert.equal(summary.created, 5);
      assert.equal(summary.updated, 0);
      assert.equal(summary.unchanged, 0);
      assert.equal(summary.analyzed, 20);
      assert.equal(summary.alerts, NEGATIVES);
      assert.equal(summary.purged, 0);
      assert.deepEqual(summary.errors, []);
      assert.deepEqual(summary.skipped, [{ sourceId: bookingSourceId, propertyId: tenant.propertyA, reason: BOOKING_UNAVAILABLE_REASON }]);
      assert.equal(summary.byProperty[0]!.casesOpened, NEGATIVES);
      assert.equal(summary.byProperty[0]!.runs.length, 3);
    });

    const reviews = await prisma.guestReview.findMany({ where: { propertyId: tenant.propertyA } });
    assert.equal(reviews.length, 20);
    for (const row of reviews) {
      const meta = readReviewMeta(row.topicsJson);
      assert.equal(meta.analysis.status, "done", row.externalReference ?? row.id);
      assert.equal(meta.analysis.source, "dictionary", row.externalReference ?? row.id);
      assert.equal(meta.analysis.note, "llm_not_configured");
      assert.ok(row.sentiment);
    }
    const cases = await prisma.qualityCase.findMany({ where: { propertyId: tenant.propertyA, caseType: "review_negative" } });
    assert.equal(cases.length, NEGATIVES);
    for (const qualityCase of cases) {
      assert.match(qualityCase.description ?? "", /^\[reseña:[^\]]+\]\n/);
      assert.ok(["urgent", "high"].includes(qualityCase.priority));
      assert.equal(qualityCase.status, "open");
      assert.equal(qualityCase.ownerUserId, null);
    }
    const linked = reviews.filter((row) => readReviewMeta(row.topicsJson).qualityCaseId);
    assert.equal(linked.length, NEGATIVES);
    for (const row of linked) assert.ok(cases.some((qualityCase) => qualityCase.id === readReviewMeta(row.topicsJson).qualityCaseId));

    await flushAuditQueues();
    const received = await prisma.auditEvent.count({ where: { organizationId: tenant.organizationId, action: "ReviewReceived", entityType: "guest_review" } });
    assert.equal(received, NEGATIVES);
    const events = await prisma.eventStream.count({ where: { organizationId: tenant.organizationId, eventType: "ReviewReceived" } });
    assert.equal(events, NEGATIVES);

    const sources = await listReviewSources({ propertyId: tenant.propertyA });
    const demo = sources.find((source) => source.id === demoSourceId)!;
    assert.equal(demo.runs.length, 1);
    assert.equal(demo.runs[0]!.created, 5);
    assert.equal(demo.runs[0]!.status, "completed");
    assert.ok(demo.lastSuccessAt);
    const booking = sources.find((source) => source.id === bookingSourceId)!;
    assert.equal(booking.status, "unavailable");
    assert.equal(booking.runs[0]!.status, "skipped");
  });

  it("tick 2: 0 creadas, 5 unchanged, 0 análisis, 0 alertas; los casos no se duplican", async () => {
    const summary = await runReputationSync({ propertyIds: [tenant.propertyA], now: new Date(NOW.getTime() + 3_600_000), trigger: "manual", collectorFor });
    assert.equal(summary.created, 0);
    assert.equal(summary.unchanged, 5);
    assert.equal(summary.analyzed, 0);
    assert.equal(summary.alerts, 0);
    assert.equal(await prisma.guestReview.count({ where: { propertyId: tenant.propertyA } }), 20);
    assert.equal(await prisma.qualityCase.count({ where: { propertyId: tenant.propertyA, caseType: "review_negative" } }), NEGATIVES);
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenant.organizationId, action: "ReviewReceived" } }), NEGATIVES);
  });

  it("bandeja: lista paginada con filtros en memoria y detalle con el análisis", async () => {
    const page = await listInbox({ propertyId: tenant.propertyA, query: { sentiment: "negative" }, page: parsePageQuery({ limit: "2" }, { limit: 25, max: 100 }), now: NOW });
    assert.equal(page.total, NEGATIVES);
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    const next = await listInbox({ propertyId: tenant.propertyA, query: { sentiment: "negative" }, page: parsePageQuery({ limit: "2", cursor: page.nextCursor }, { limit: 25, max: 100 }), now: NOW });
    assert.equal(next.items.length, NEGATIVES - 2);
    assert.equal(new Set([...page.items, ...next.items].map((item) => item.id)).size, NEGATIVES);
    const detail = await getReview({ id: page.items[0]!.id, propertyId: tenant.propertyA, now: NOW });
    assert.equal(detail.analysisSource, "dictionary");
    assert.ok(detail.qualityCaseId);
    await assert.rejects(getReview({ id: page.items[0]!.id, propertyId: tenant.propertyB, now: NOW }), /Reseña no encontrada/);
  });

  it("purga: retentionDays 1 en la fuente csv vacía los cuerpos de sus 15 reseñas y conserva nota, categorías y referencia", async () => {
    const actor = { organizationId: tenant.organizationId, userId: tenant.users.generalManager.id };
    const updated = await updateReviewSource({ id: csvSourceId, propertyId: tenant.propertyA, input: { retentionDays: 1 }, actor });
    assert.equal(updated.retentionDays, 1);
    const purge = await purgeExpiredBodies({ propertyId: tenant.propertyA, now: NOW });
    assert.equal(purge.purged, 15);
    const rows = await prisma.guestReview.findMany({ where: { propertyId: tenant.propertyA, source: "csv" } });
    assert.equal(rows.length, 15);
    for (const row of rows) {
      assert.equal(row.body, null);
      assert.equal(row.title, null);
      assert.equal(row.responseBody, null);
      const meta = readReviewMeta(row.topicsJson);
      assert.ok(meta.bodyPurgedAt);
      assert.equal(typeof meta.score10, "number");
      assert.equal(meta.contentHash.length, 40);
      assert.ok(row.externalReference?.startsWith("csv-"));
      for (const mention of meta.categories) assert.equal(mention.snippet, undefined);
    }
    const demoRows = await prisma.guestReview.findMany({ where: { propertyId: tenant.propertyA, source: "demo" } });
    assert.equal(demoRows.length, 5);
    for (const row of demoRows) assert.notEqual(row.body, null);
    const again = await purgeExpiredBodies({ propertyId: tenant.propertyA, now: NOW });
    assert.equal(again.purged, 0);
    const config = readSourceConfig((await prisma.reviewSource.findFirstOrThrow({ where: { id: csvSourceId } })).configJson, "csv");
    assert.equal(config.retentionDays, 1);
  });

  it("snapshot en A: status ok (20 reseñas en 30 d), 2 fuentes conectadas de 3, tendencia calculada; sigue module_off en B", async () => {
    invalidateReputationCache(tenant.propertyA);
    const a = await getReputationSnapshot({ propertyId: tenant.propertyA, now: NOW, skipCache: true });
    assert.equal(a.status, "ok");
    assert.equal(a.index30.reviewCount, 20);
    assert.equal(typeof a.index30.index, "number");
    assert.ok(a.index30.bySource.some((entry) => entry.provider === "csv" && entry.count === 15));
    assert.ok(a.index30.bySource.some((entry) => entry.provider === "demo" && entry.count === 5));
    assert.equal(a.sourcesConnected, 2);
    assert.equal(a.sourcesTotal, 3);
    assert.equal(a.reviewCount365, 20);
    assert.equal(a.index365.reviewCount, 20);
    assert.equal(a.schemaPatchApplied, true);
    assert.deepEqual(a.degraded, []);
    // Hace 30 días no había ninguna reseña: sin tendencia (null), nunca una excepción.
    assert.equal(a.trendDelta, null);
    const cached = await getReputationSnapshot({ propertyId: tenant.propertyA, now: NOW });
    assert.equal(cached.computedAt, a.computedAt);
    const b = await getReputationSnapshot({ propertyId: tenant.propertyB, now: NOW, skipCache: true });
    assert.equal(b.status, "module_off");
  });

  it("borrador HITL: reputation.respond basta con el respaldo por reglas; encola review_response; aprobar el ítem NUNCA escribe responseBody", async () => {
    const negative = await prisma.guestReview.findFirstOrThrow({ where: { propertyId: tenant.propertyA, externalReference: "demo-03" } });
    draftedReviewId = negative.id;
    const out = await createReviewDraft({ context: gmContext(["reputation.respond"]), reviewId: negative.id, propertyId: tenant.propertyA, correlationId: "corr_l8_draft", now: NOW });
    assert.equal(out.source, "rules");
    assert.equal(out.requiresHumanReview, true);
    assert.ok(out.reviewItemId);
    reviewItemId = out.reviewItemId!;
    const item = await prisma.aiHumanReviewItem.findUniqueOrThrow({ where: { id: reviewItemId } });
    assert.equal(item.reviewType, "review_response");
    assert.equal(item.organizationId, tenant.organizationId);
    assert.equal(item.relatedEntityType, "guest_review");
    assert.equal(item.relatedEntityId, negative.id);
    assert.equal(item.status, "pending");
    const afterDraft = await prisma.guestReview.findUniqueOrThrow({ where: { id: negative.id } });
    assert.equal(afterDraft.responseBody, null);
    assert.equal(afterDraft.respondedAt, null);
    const meta = readReviewMeta(afterDraft.topicsJson);
    assert.equal(meta.status, "drafted");
    assert.equal(meta.draft?.reviewItemId, reviewItemId);

    await approveReview({ context: gmContext(["reputation.respond", "ai.high_risk.confirm"]), id: reviewItemId, correlationId: "corr_l8_approve" });
    const afterApprove = await prisma.guestReview.findUniqueOrThrow({ where: { id: draftedReviewId } });
    assert.equal(afterApprove.responseBody, null, "aprobar en HITL no publica");
    assert.equal(afterApprove.respondedAt, null);
    assert.equal(readReviewMeta(afterApprove.topicsJson).status, "drafted");
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenant.organizationId, action: "ReviewResponseDrafted", entityId: negative.id } }), 1);
  });
});
