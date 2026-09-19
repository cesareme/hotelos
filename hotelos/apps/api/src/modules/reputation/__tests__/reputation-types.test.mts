// Unit tests · Tanda T8 · lote T8-A — tipos, constantes y funciones puras de
// reputación (reputation-types.ts) y PARIDAD con el espejo del navegador
// (apps/admin-web/src/services/reputation-contracts.ts). Sin base de datos,
// sin red. Todos los datos son ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-types.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANALYSIS_SOURCES,
  ANALYSIS_SOURCE_LABELS_ES,
  DEFAULT_SOURCE_CAPABILITIES,
  INDEX_GOOD,
  INDEX_MIN_REVIEWS,
  INDEX_WARN,
  INDEX_WINDOWS,
  REPUTATION_ERROR_CODES,
  REPUTATION_ERROR_MESSAGES_ES,
  REPUTATION_INDEX_STATUSES,
  REPUTATION_THRESHOLDS,
  RETENTION_DAYS_DEFAULT,
  RETENTION_DAYS_GOOGLE,
  REVIEW_CATEGORIES,
  REVIEW_CATEGORY_LABELS_ES,
  REVIEW_PROVIDERS,
  REVIEW_PROVIDER_LABELS_ES,
  REVIEW_PROVIDER_SCALES,
  REVIEW_SOURCE_MODES,
  REVIEW_SOURCE_MODE_LABELS_ES,
  REVIEW_SOURCE_STATUSES,
  REVIEW_SOURCE_STATUS_LABELS_ES,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS_ES,
  RUN_HISTORY_LIMIT,
  SCORE10_NEGATIVE,
  SCORE10_POSITIVE,
  SENTIMENTS,
  SENTIMENT_LABELS_ES,
  SLA_HOURS,
  SOURCE_WEIGHT_CAP,
  TREND_BAND,
  appendSourceRun,
  baseProvider,
  hasCredentialKeys,
  indexTone,
  isReviewOverdue,
  providerScaleMax,
  readReviewMeta,
  readSourceConfig,
  scoreTone,
  sentimentBucket,
  slaHoursFor,
  slaTargetFor,
  trendDirectionFor,
  writeReviewMeta,
  writeSourceConfig,
  type ReviewMeta,
  type ReviewSourceRunSummary
} from "../reputation-types.js";
import * as front from "../../../../../admin-web/src/services/reputation-contracts.ts";

const API_FILE = fileURLToPath(new URL("../reputation-types.ts", import.meta.url));
const FRONT_FILE = fileURLToPath(new URL("../../../../../admin-web/src/services/reputation-contracts.ts", import.meta.url));

function sharedBlock(source: string): string {
  const begin = source.indexOf("// ===== SHARED-BEGIN");
  const end = source.indexOf("// ===== SHARED-END =====");
  assert.ok(begin >= 0 && end > begin, "faltan los marcadores SHARED-BEGIN/SHARED-END");
  return source.slice(begin, end);
}

/** Recorre un valor y devuelve las rutas con `undefined` o instancias de Date. */
function nonPlainPaths(value: unknown, path = "$"): string[] {
  if (value === undefined) return [`${path}=undefined`];
  if (value instanceof Date) return [`${path}=Date`];
  if (Array.isArray(value)) return value.flatMap((entry, index) => nonPlainPaths(entry, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => nonPlainPaths(entry, `${path}.${key}`));
  }
  return [];
}

function run(overrides: Partial<ReviewSourceRunSummary> = {}): ReviewSourceRunSummary {
  return {
    id: "run_1",
    trigger: "scheduler",
    status: "completed",
    startedAt: "2026-09-18T06:00:00.000Z",
    finishedAt: "2026-09-18T06:00:05.000Z",
    fetched: 12,
    created: 3,
    updated: 1,
    unchanged: 8,
    purged: 0,
    correlationId: "corr_1",
    ...overrides
  };
}

describe("reputation-types · vocabularios y umbrales", () => {
  it("tiene las 12 categorías del diseño §4.5 y una etiqueta española por cada una", () => {
    assert.deepEqual(
      [...REVIEW_CATEGORIES],
      ["limpieza", "habitacion", "personal", "desayuno", "restauracion", "ubicacion", "precio_valor", "instalaciones", "ruido", "wifi", "recepcion_checkin", "mantenimiento"]
    );
    assert.equal(REVIEW_CATEGORIES.length, 12);
    for (const category of REVIEW_CATEGORIES) assert.ok(REVIEW_CATEGORY_LABELS_ES[category].trim().length > 0, category);
  });

  it("tiene los 8 proveedores con su escala (null = escala por fila)", () => {
    assert.deepEqual([...REVIEW_PROVIDERS], ["google", "booking", "expedia", "tripadvisor", "holidaycheck", "csv", "email", "demo"]);
    assert.deepEqual(REVIEW_PROVIDER_SCALES, { google: 5, tripadvisor: 5, expedia: 5, booking: 10, holidaycheck: 6, csv: null, email: null, demo: null });
    assert.equal(providerScaleMax("booking"), 10);
    assert.equal(providerScaleMax("csv"), null);
    assert.equal(providerScaleMax("desconocido"), null);
    for (const provider of REVIEW_PROVIDERS) assert.ok(REVIEW_PROVIDER_LABELS_ES[provider].trim().length > 0, provider);
  });

  it("vocabularios de modo, estado, sentimiento y análisis", () => {
    assert.deepEqual([...REVIEW_SOURCE_MODES], ["api", "email", "csv", "manual", "demo"]);
    assert.deepEqual([...REVIEW_SOURCE_STATUSES], ["pending", "connected", "degraded", "error", "disabled", "unavailable"]);
    assert.deepEqual([...REVIEW_STATUSES], ["new", "assigned", "drafted", "responded", "closed", "ignored"]);
    assert.deepEqual([...SENTIMENTS], ["positive", "neutral", "negative"]);
    assert.deepEqual([...ANALYSIS_SOURCES], ["llm", "dictionary", "portal_subscore", "none"]);
    assert.deepEqual([...REPUTATION_INDEX_STATUSES], ["ok", "insufficient", "no_reviews", "no_sources", "module_off"]);
    for (const dictionary of [REVIEW_SOURCE_MODE_LABELS_ES, REVIEW_SOURCE_STATUS_LABELS_ES, REVIEW_STATUS_LABELS_ES, SENTIMENT_LABELS_ES, ANALYSIS_SOURCE_LABELS_ES]) {
      for (const [code, label] of Object.entries(dictionary)) assert.ok(label.trim().length > 0, code);
    }
  });

  it("umbrales del recon §6 #6 (8,5/6,0 sobre 10; 85/70 sobre 100; mínimo 10; ventanas 30/90/365)", () => {
    assert.equal(SCORE10_POSITIVE, 8.5);
    assert.equal(SCORE10_NEGATIVE, 6.0);
    assert.equal(INDEX_GOOD, 85);
    assert.equal(INDEX_WARN, 70);
    assert.equal(INDEX_MIN_REVIEWS, 10);
    assert.deepEqual([...INDEX_WINDOWS], [30, 90, 365]);
    assert.equal(SOURCE_WEIGHT_CAP, 0.6);
    assert.equal(TREND_BAND, 1.0);
    assert.deepEqual(SLA_HOURS, { negative: 48, neutral: 72, positive: 96 });
    assert.equal(RETENTION_DAYS_DEFAULT, 730);
    assert.equal(RETENTION_DAYS_GOOGLE, 30);
    assert.equal(RUN_HISTORY_LIMIT, 20);
    assert.equal(REPUTATION_THRESHOLDS.SCORE10_POSITIVE, SCORE10_POSITIVE);
    assert.ok(Object.isFrozen(REPUTATION_THRESHOLDS));
  });

  it("códigos de error con frase en español", () => {
    assert.deepEqual(
      [...REPUTATION_ERROR_CODES],
      ["REVIEW_SOURCE_UNAVAILABLE", "REVIEW_SOURCE_NOT_AUTHORIZED", "REVIEW_NOT_REPLYABLE", "REVIEW_IMPORT_INVALID", "REVIEW_IMPORT_DUPLICATE", "REPUTATION_INSUFFICIENT_DATA", "REVIEW_ALREADY_RESPONDED", "INVALID_TRANSITION", "REPUTATION_SYNC_BUSY", "REVIEW_DRAFT_REJECTED"]
    );
    for (const code of REPUTATION_ERROR_CODES) assert.ok(REPUTATION_ERROR_MESSAGES_ES[code].endsWith("."), code);
    // Mismo texto que el 409 vigente del motor genérico (advanced-record-store.ts:848).
    assert.equal(REPUTATION_ERROR_MESSAGES_ES.REVIEW_ALREADY_RESPONDED, "La reseña ya tiene respuesta.");
  });
});

describe("reputation-types · helpers puros", () => {
  it("sentimentBucket por tramos 8,5 / 6,0", () => {
    assert.equal(sentimentBucket(10), "positive");
    assert.equal(sentimentBucket(8.5), "positive");
    assert.equal(sentimentBucket(8.49), "neutral");
    assert.equal(sentimentBucket(6), "neutral");
    assert.equal(sentimentBucket(5.99), "negative");
    assert.equal(sentimentBucket(0), "negative");
    assert.equal(sentimentBucket(null), null);
    assert.equal(sentimentBucket(undefined), null);
    assert.equal(sentimentBucket(Number.NaN), null);
  });

  it("slaHoursFor y slaTargetFor (48/72/96 h; sin tramo → 72 h)", () => {
    assert.equal(slaHoursFor("negative"), 48);
    assert.equal(slaHoursFor("neutral"), 72);
    assert.equal(slaHoursFor("positive"), 96);
    assert.equal(slaHoursFor(null), 72);
    assert.equal(slaTargetFor("2026-09-18T10:00:00.000Z", 4), "2026-09-20T10:00:00.000Z");
    assert.equal(slaTargetFor(new Date("2026-09-18T10:00:00.000Z"), 9.2), "2026-09-22T10:00:00.000Z");
    assert.equal(slaTargetFor("2026-09-18T10:00:00.000Z", null), "2026-09-21T10:00:00.000Z");
    assert.equal(slaTargetFor("no es fecha", 4), null);
  });

  it("indexTone y scoreTone", () => {
    assert.equal(indexTone(100), "success");
    assert.equal(indexTone(85), "success");
    assert.equal(indexTone(84.9), "warning");
    assert.equal(indexTone(70), "warning");
    assert.equal(indexTone(69.9), "danger");
    assert.equal(scoreTone(8.5), "success");
    assert.equal(scoreTone(6), "warning");
    assert.equal(scoreTone(5.9), "danger");
  });

  it("trendDirectionFor con banda ±1,0", () => {
    assert.equal(trendDirectionFor(1.1), "up");
    assert.equal(trendDirectionFor(1.0), "flat");
    assert.equal(trendDirectionFor(0), "flat");
    assert.equal(trendDirectionFor(-1.0), "flat");
    assert.equal(trendDirectionFor(-1.1), "down");
    assert.equal(trendDirectionFor(null), null);
  });

  it("isReviewOverdue solo con estados abiertos y plazo vencido", () => {
    const now = new Date("2026-09-19T12:00:00.000Z");
    assert.equal(isReviewOverdue({ status: "new", slaTargetAt: "2026-09-19T11:59:59.000Z" }, now), true);
    assert.equal(isReviewOverdue({ status: "drafted", slaTargetAt: "2026-09-19T12:00:01.000Z" }, now), false);
    assert.equal(isReviewOverdue({ status: "responded", slaTargetAt: "2026-09-01T00:00:00.000Z" }, now), false);
    assert.equal(isReviewOverdue({ status: "new", slaTargetAt: null }, now), false);
    assert.equal(isReviewOverdue({ status: "new", slaTargetAt: "basura" }, now), false);
  });

  it("baseProvider quita el sufijo _demo y rechaza códigos desconocidos", () => {
    assert.equal(baseProvider("google_demo"), "google");
    assert.equal(baseProvider(" Booking "), "booking");
    assert.equal(baseProvider("otro"), null);
  });
});

describe("reputation-types · readReviewMeta / writeReviewMeta", () => {
  const DEFAULTS: ReviewMeta = {
    v: 1,
    score10: null,
    ratingRaw: null,
    ratingScaleMax: null,
    contentHash: "",
    sourceMode: "manual",
    bodyComplete: true,
    status: "new",
    replyCapability: false,
    categories: [],
    analysis: { status: "pending", source: "none" }
  };

  it("{} / null / undefined / basura → defaults sin lanzar", () => {
    for (const input of [{}, null, undefined, "hola", 42, [], true, () => 1]) {
      assert.deepEqual(readReviewMeta(input), DEFAULTS, String(input));
    }
  });

  it("valores inválidos caen a los defaults y los válidos se normalizan", () => {
    const meta = readReviewMeta({
      v: 7,
      score10: "9,1",
      ratingRaw: "4.5",
      ratingScaleMax: -5,
      status: "banana",
      sourceMode: "api",
      categories: "no es una lista",
      analysis: 5,
      replyCapability: "sí",
      bodyComplete: false,
      slaTargetAt: new Date("2026-09-20T10:00:00.000Z"),
      authorDisplayName: "  Huésped ficticio  ",
      portalUrl: "",
      draft: { body: "" },
      response: { source: "api", externalState: "published" },
      overdue: true,
      isDemo: "no"
    });
    assert.equal(meta.v, 1);
    assert.equal(meta.score10, 9.1);
    assert.equal(meta.ratingRaw, 4.5);
    assert.equal(meta.ratingScaleMax, null);
    assert.equal(meta.status, "new");
    assert.equal(meta.sourceMode, "api");
    assert.deepEqual(meta.categories, []);
    assert.deepEqual(meta.analysis, { status: "pending", source: "none" });
    assert.equal(meta.replyCapability, false);
    assert.equal(meta.bodyComplete, false);
    assert.equal(meta.slaTargetAt, "2026-09-20T10:00:00.000Z");
    assert.equal(meta.authorDisplayName, "Huésped ficticio");
    assert.equal("portalUrl" in meta, false);
    assert.equal("draft" in meta, false);
    assert.deepEqual(meta.response, { source: "api", externalState: "published" });
    assert.equal(meta.overdue, true);
    assert.equal("isDemo" in meta, false);
    assert.equal(readReviewMeta({ score10: 12 }).score10, 10);
    assert.equal(readReviewMeta({ score10: -3 }).score10, 0);
  });

  it("menciones de categoría: descarta las inválidas, normaliza sentimiento y confianza, recorta el snippet", () => {
    const meta = readReviewMeta({
      categories: [
        { category: "limpieza", sentiment: -1, confidence: 0.9, snippet: "x".repeat(200), source: "dictionary" },
        { category: "otra", sentiment: 1, confidence: 1 },
        { category: "wifi", sentiment: "3", confidence: 7, source: "marciano" },
        "basura",
        null
      ],
      analysis: { status: "done", source: "llm", analyzedAt: "2026-09-18T07:00:00.000Z", summary: "s".repeat(300), note: "" }
    });
    assert.equal(meta.categories.length, 2);
    assert.deepEqual(meta.categories[0], { category: "limpieza", sentiment: -1, confidence: 0.9, snippet: "x".repeat(160), source: "dictionary" });
    assert.deepEqual(meta.categories[1], { category: "wifi", sentiment: 1, confidence: 1, source: "none" });
    assert.equal(meta.analysis.status, "done");
    assert.equal(meta.analysis.source, "llm");
    assert.equal(meta.analysis.summary?.length, 200);
    assert.equal("note" in meta.analysis, false);
  });

  it("writeReviewMeta devuelve JSON plano: sin undefined ni Date, idempotente al releer", () => {
    const written = writeReviewMeta({
      score10: 3.5,
      sourceMode: "email",
      status: "assigned",
      assignedUserId: undefined,
      slaTargetAt: new Date("2026-09-20T10:00:00.000Z"),
      bodyPurgedAt: null,
      categories: [{ category: "ruido", sentiment: -1, confidence: 0.8, source: "dictionary" }],
      analysis: { status: "done", source: "dictionary", analyzedAt: new Date("2026-09-18T07:00:00.000Z") },
      draft: { body: "Gracias por su comentario.", source: "rules", draftedAt: new Date("2026-09-18T08:00:00.000Z") }
    });
    assert.deepEqual(nonPlainPaths(written), []);
    assert.deepEqual(JSON.parse(JSON.stringify(written)), written);
    assert.equal(written.slaTargetAt, "2026-09-20T10:00:00.000Z");
    assert.equal((written.draft as { draftedAt: string }).draftedAt, "2026-09-18T08:00:00.000Z");
    assert.equal(written.status, "assigned");
    assert.deepEqual(readReviewMeta(written), readReviewMeta(readReviewMeta(written)));
    assert.deepEqual(writeReviewMeta(readReviewMeta(written)), written);
  });
});

describe("reputation-types · readSourceConfig / writeSourceConfig", () => {
  it("{} → defaults del proveedor (modo, nombre, capacidades, retención 30 en Google y 730 en el resto)", () => {
    const google = readSourceConfig({}, "google");
    assert.deepEqual(google, {
      v: 1,
      mode: "api",
      displayName: "Google",
      weight: 1,
      retentionDays: 30,
      capabilities: { fetch: true, reply: true, fullText: true, categories: false },
      runs: []
    });
    assert.equal(readSourceConfig(null, "booking").retentionDays, 730);
    assert.equal(readSourceConfig("basura", "tripadvisor").mode, "email");
    assert.deepEqual(readSourceConfig(undefined, "csv").capabilities, DEFAULT_SOURCE_CAPABILITIES.csv);
    const unknown = readSourceConfig([], "portal_x");
    assert.equal(unknown.mode, "manual");
    assert.equal(unknown.displayName, "portal_x");
    assert.deepEqual(unknown.capabilities, { fetch: false, reply: false, fullText: false, categories: false });
    assert.equal(unknown.retentionDays, 730);
  });

  it("acota el peso a 0,1-2 y la retención de Google a 30 días; marca isDemo por sufijo", () => {
    assert.equal(readSourceConfig({ weight: 5 }, "booking").weight, 2);
    assert.equal(readSourceConfig({ weight: 0.01 }, "booking").weight, 0.1);
    assert.equal(readSourceConfig({ weight: "0,8" }, "booking").weight, 0.8);
    assert.equal(readSourceConfig({ retentionDays: 900 }, "google").retentionDays, 30);
    assert.equal(readSourceConfig({ retentionDays: 900 }, "expedia").retentionDays, 900);
    assert.equal(readSourceConfig({ retentionDays: 0 }, "expedia").retentionDays, 730);
    const demo = readSourceConfig({}, "google_demo");
    assert.equal(demo.isDemo, true);
    assert.equal(demo.mode, "api");
    assert.equal(demo.displayName, "Google");
    assert.equal(readSourceConfig({ isDemo: false }, "google_demo").isDemo, undefined);
    assert.equal(readSourceConfig({}, "demo").isDemo, true);
  });

  it("nunca deja pasar credenciales: solo copia claves conocidas y limpia el cursor", () => {
    const json = {
      mode: "api",
      credentials: { clientSecret: "x" },
      accessToken: "abc",
      refresh_token: "def",
      cursor: { pageToken: "p1", refreshToken: "r" },
      externalLocationId: "locations/123"
    };
    assert.deepEqual(hasCredentialKeys(json).sort(), ["accessToken", "credentials", "cursor.refreshToken", "refresh_token"]);
    assert.deepEqual(hasCredentialKeys({ mode: "api", cursor: { since: "2026-09-01" } }), []);
    assert.deepEqual(hasCredentialKeys(null), []);
    const config = readSourceConfig(json, "google");
    assert.deepEqual(config.cursor, { pageToken: "p1" });
    assert.equal(config.externalLocationId, "locations/123");
    const written = writeSourceConfig(json, "google");
    assert.deepEqual(hasCredentialKeys(written), []);
    assert.equal(JSON.stringify(written).includes("abc"), false);
    assert.equal(JSON.stringify(written).includes("clientSecret"), false);
  });

  it("runs: descarta inválidas, ordena la más reciente primero y conserva ≤ 20", () => {
    const runs = Array.from({ length: 25 }, (_, index) =>
      run({ id: `run_${index}`, startedAt: `2026-08-${String(1 + index).padStart(2, "0")}T06:00:00.000Z`, finishedAt: `2026-08-${String(1 + index).padStart(2, "0")}T06:01:00.000Z` })
    );
    const config = readSourceConfig({ runs: [...runs, { trigger: "manual" }, "basura", { id: "sin_fecha" }] }, "booking");
    assert.equal(config.runs.length, RUN_HISTORY_LIMIT);
    assert.equal(config.runs[0]?.id, "run_24");
    assert.equal(config.runs[19]?.id, "run_5");
    const partial = readSourceConfig({ runs: [{ id: "r", startedAt: "2026-09-18T06:00:00.000Z", fetched: "7", created: -2, status: "raro", error: "x".repeat(600) }] }, "booking");
    assert.deepEqual(partial.runs[0], {
      id: "r",
      trigger: "manual",
      status: "completed",
      startedAt: "2026-09-18T06:00:00.000Z",
      finishedAt: "2026-09-18T06:00:00.000Z",
      fetched: 7,
      created: 0,
      updated: 0,
      unchanged: 0,
      purged: 0,
      error: "x".repeat(500),
      correlationId: ""
    });
  });

  it("writeSourceConfig devuelve JSON plano (fechas ISO, sin undefined)", () => {
    const written = writeSourceConfig(
      { mode: "csv", lastRunAt: new Date("2026-09-18T06:00:00.000Z"), lastSuccessAt: null, externalAccountId: undefined, runs: [run({ startedAt: new Date("2026-09-18T06:00:00.000Z") as unknown as string })] },
      "csv"
    );
    assert.deepEqual(nonPlainPaths(written), []);
    assert.equal(written.lastRunAt, "2026-09-18T06:00:00.000Z");
    assert.equal("lastSuccessAt" in written, false);
    assert.deepEqual(JSON.parse(JSON.stringify(written)), written);
  });

  it("appendSourceRun es pura, pone la ejecución primero y mantiene lastRunAt/lastSuccessAt/lastError", () => {
    const base = readSourceConfig({ lastError: "401 invalid_grant" }, "google");
    const failed = appendSourceRun(base, run({ id: "f1", status: "failed", error: "401 invalid_grant", finishedAt: "2026-09-18T06:00:05.000Z" }));
    assert.equal(base.runs.length, 0, "no muta");
    assert.equal(failed.runs.length, 1);
    assert.equal(failed.lastRunAt, "2026-09-18T06:00:05.000Z");
    assert.equal(failed.lastError, "401 invalid_grant");
    assert.equal("lastSuccessAt" in failed, false);
    const ok = appendSourceRun(failed, run({ id: "c1", finishedAt: "2026-09-19T06:00:05.000Z" }));
    assert.deepEqual(ok.runs.map((entry) => entry.id), ["c1", "f1"]);
    assert.equal(ok.lastSuccessAt, "2026-09-19T06:00:05.000Z");
    assert.equal("lastError" in ok, false);
    const skipped = appendSourceRun(ok, run({ id: "s1", status: "skipped", finishedAt: "2026-09-20T06:00:05.000Z" }));
    assert.equal(skipped.lastSuccessAt, "2026-09-19T06:00:05.000Z");
    // Lectura parcial (cuota a mitad de paginación): lastRunAt avanza, lastSuccessAt NO y lastError conserva el motivo.
    const partial = appendSourceRun(skipped, run({ id: "p1", status: "partial", error: "Google Business Profile API 429: rate limited", finishedAt: "2026-09-21T06:00:05.000Z" }));
    assert.equal(partial.lastRunAt, "2026-09-21T06:00:05.000Z");
    assert.equal(partial.lastSuccessAt, "2026-09-19T06:00:05.000Z");
    assert.equal(partial.lastError, "Google Business Profile API 429: rate limited");
    assert.equal(appendSourceRun(skipped, run({ id: "p2", status: "partial", finishedAt: "2026-09-21T06:00:05.000Z" })).lastError, "Lectura parcial de la fuente.");
    let config = ok;
    for (let index = 0; index < 30; index += 1) config = appendSourceRun(config, run({ id: `n${index}` }));
    assert.equal(config.runs.length, RUN_HISTORY_LIMIT);
    assert.equal(appendSourceRun(config, run({ id: "n29" })).runs.filter((entry) => entry.id === "n29").length, 1, "sin duplicar por id");
  });
});

describe("reputation-types · PARIDAD con apps/admin-web/src/services/reputation-contracts.ts", () => {
  it("vocabularios, etiquetas, escalas, umbrales y errores idénticos", () => {
    assert.deepEqual(front.REVIEW_CATEGORIES, REVIEW_CATEGORIES);
    assert.deepEqual(front.REVIEW_CATEGORY_LABELS_ES, REVIEW_CATEGORY_LABELS_ES);
    assert.deepEqual(front.REVIEW_PROVIDERS, REVIEW_PROVIDERS);
    assert.deepEqual(front.REVIEW_PROVIDER_LABELS_ES, REVIEW_PROVIDER_LABELS_ES);
    assert.deepEqual(front.REVIEW_PROVIDER_SCALES, REVIEW_PROVIDER_SCALES);
    assert.deepEqual(front.REVIEW_SOURCE_MODES, REVIEW_SOURCE_MODES);
    assert.deepEqual(front.REVIEW_SOURCE_STATUSES, REVIEW_SOURCE_STATUSES);
    assert.deepEqual(front.REVIEW_SOURCE_STATUS_LABELS_ES, REVIEW_SOURCE_STATUS_LABELS_ES);
    assert.deepEqual(front.REVIEW_STATUSES, REVIEW_STATUSES);
    assert.deepEqual(front.REVIEW_STATUS_LABELS_ES, REVIEW_STATUS_LABELS_ES);
    assert.deepEqual(front.SENTIMENTS, SENTIMENTS);
    assert.deepEqual(front.ANALYSIS_SOURCES, ANALYSIS_SOURCES);
    assert.deepEqual(front.REPUTATION_INDEX_STATUSES, REPUTATION_INDEX_STATUSES);
    assert.deepEqual(front.REPUTATION_ERROR_CODES, REPUTATION_ERROR_CODES);
    assert.deepEqual(front.REPUTATION_ERROR_MESSAGES_ES, REPUTATION_ERROR_MESSAGES_ES);
    assert.deepEqual(front.REPUTATION_THRESHOLDS, REPUTATION_THRESHOLDS);
    assert.deepEqual(front.SLA_HOURS, SLA_HOURS);
  });

  it("los helpers compartidos dan el mismo resultado en ambos ficheros", () => {
    for (const score of [null, 0, 5.99, 6, 8.49, 8.5, 10]) {
      assert.equal(front.sentimentBucket(score), sentimentBucket(score), String(score));
    }
    for (const value of [0, 69.9, 70, 84.9, 85, 100]) assert.equal(front.indexTone(value), indexTone(value), String(value));
    for (const value of [0, 5.9, 6, 8.4, 8.5, 10]) assert.equal(front.scoreTone(value), scoreTone(value), String(value));
    for (const delta of [null, -2, -1, 0, 1, 2]) assert.equal(front.trendDirectionFor(delta), trendDirectionFor(delta), String(delta));
  });

  it("el bloque SHARED-BEGIN…SHARED-END es byte a byte idéntico", () => {
    const api = readFileSync(API_FILE, "utf8");
    const web = readFileSync(FRONT_FILE, "utf8");
    assert.equal(sharedBlock(web), sharedBlock(api));
  });

  it("ninguno de los dos ficheros importa nada ni lee variables de entorno", () => {
    const envRead = new RegExp(`${["process", "env"].join("\\.")}|\\benv\\.`);
    for (const file of [API_FILE, FRONT_FILE]) {
      const source = readFileSync(file, "utf8");
      assert.equal(source.split("\n").filter((line) => /^import\s/.test(line)).length, 0, `${file}: líneas import`);
      assert.equal(envRead.test(source), false, `${file}: lectura de entorno`);
      assert.equal(/from "@hotelos\//.test(source), false, `${file}: dependencia de paquete`);
    }
  });
});
