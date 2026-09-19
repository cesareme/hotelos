// Unit tests · Tanda T8 · lote T8-A — contratos de reputación del navegador
// (services/reputation-contracts.ts): builders de query, mensajes de error,
// etiquetas y copys en español. Sin red, sin React, sin api-client. Datos
// ficticios.
// Desde apps/api:
//   TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/services/__tests__/reputation-contracts.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANALYSIS_SOURCE_LABELS_ES,
  INBOX_LIMIT_MAX,
  INDEX_MIN_REVIEWS,
  REPUTATION_ERROR_CODES,
  REPUTATION_ERROR_FALLBACK_ES,
  REPUTATION_ERROR_MESSAGES_ES,
  REPUTATION_INDEX_STATUSES,
  REVIEW_CATEGORIES,
  REVIEW_CATEGORY_LABELS_ES,
  REVIEW_PROVIDERS,
  REVIEW_PROVIDER_LABELS_ES,
  REVIEW_SOURCE_MODE_LABELS_ES,
  REVIEW_SOURCE_STATUSES,
  REVIEW_SOURCE_STATUS_LABELS_ES,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS_ES,
  RUNS_LIMIT_MAX,
  SENTIMENT_LABELS_ES,
  TREND_DIRECTION_LABELS_ES,
  analysisSourceLabel,
  categoryLabel,
  compactReputationQuery,
  formatIndex,
  formatScore10,
  formatTrendDelta,
  hasReputationErrorCode,
  inboxQuery,
  indexStatusCopy,
  indexTone,
  providerLabel,
  reputationDashboardQuery,
  reputationErrorCode,
  reputationErrorMessage,
  reputationErrorStatus,
  reviewCountText,
  runsQuery,
  scoreTone,
  scoresQuery,
  sentimentLabel,
  sentimentTone,
  sourceModeLabel,
  sourceStatusLabel,
  sourceStatusTone,
  staleCopy,
  statusLabel,
  trendLabel
} from "../reputation-contracts.ts";

const SOURCE_FILE = fileURLToPath(new URL("../reputation-contracts.ts", import.meta.url));

class FakeApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

describe("reputation-contracts · query builders", () => {
  it("inboxQuery deja fuera los vacíos, serializa booleanos como 1/0 y acota limit a 1-100", () => {
    assert.deepEqual(inboxQuery(), {});
    assert.deepEqual(inboxQuery({ status: "", source: "  ", category: "", language: "", responded: null, cursor: null, limit: null }), {});
    assert.deepEqual(
      inboxQuery({ status: "new", source: "google", minScore: "8,5", maxScore: 12, category: "limpieza", language: " ES ", responded: false, cursor: "c_1", limit: 500 }),
      { status: "new", source: "google", minScore: 8.5, maxScore: 10, category: "limpieza", language: "es", responded: "0", cursor: "c_1", limit: INBOX_LIMIT_MAX }
    );
    assert.deepEqual(inboxQuery({ responded: true, limit: 0 }), { responded: "1", limit: 1 });
    assert.deepEqual(inboxQuery({ minScore: -4, maxScore: "no" }), { minScore: 0 });
    assert.deepEqual(inboxQuery({ limit: 25.4 }), { limit: 25 });
  });

  it("runsQuery, scoresQuery y reputationDashboardQuery", () => {
    assert.deepEqual(runsQuery(), {});
    assert.deepEqual(runsQuery({ limit: 999, sourceId: "src_1" }), { limit: RUNS_LIMIT_MAX, sourceId: "src_1" });
    assert.deepEqual(scoresQuery({ windowDays: 45 }), {});
    assert.deepEqual(scoresQuery({ windowDays: 90, from: "2026-08-01", to: "" }), { windowDays: 90, from: "2026-08-01" });
    assert.deepEqual(reputationDashboardQuery({ propertyId: "prop_ficticia", days: 400 }), { propertyId: "prop_ficticia", days: 365 });
  });

  it("compactReputationQuery recorta cadenas y descarta null/undefined/vacíos", () => {
    assert.deepEqual(compactReputationQuery({ a: " x ", b: "", c: null, d: undefined, e: 0, f: false }), { a: "x", e: 0, f: "0" });
  });
});

describe("reputation-contracts · reputationErrorMessage", () => {
  it("details.code → frase; luego message; luego fallback", () => {
    assert.equal(reputationErrorMessage(new FakeApiError("Not replyable", 409, { code: "REVIEW_NOT_REPLYABLE" })), REPUTATION_ERROR_MESSAGES_ES.REVIEW_NOT_REPLYABLE);
    assert.equal(reputationErrorMessage({ details: { code: "REVIEW_ALREADY_RESPONDED" } }), "La reseña ya tiene respuesta.");
    assert.equal(reputationErrorMessage(new FakeApiError("El módulo reputation_quality no está activado en esta propiedad.", 403, { code: "MODULE_DISABLED" })), "El módulo reputation_quality no está activado en esta propiedad.");
    assert.equal(reputationErrorMessage(new Error("  Fallo de red  ")), "Fallo de red");
    assert.equal(reputationErrorMessage("texto suelto"), "texto suelto");
    assert.equal(reputationErrorMessage(null), REPUTATION_ERROR_FALLBACK_ES);
    assert.equal(reputationErrorMessage(undefined, "Otro fallback"), "Otro fallback");
    assert.equal(reputationErrorMessage({ details: { code: "" }, message: "" }), REPUTATION_ERROR_FALLBACK_ES);
    assert.equal(REPUTATION_ERROR_FALLBACK_ES, "No se pudo completar la operación de reputación.");
  });

  it("REPUTATION_INSUFFICIENT_DATA añade el recuento cuando la API lo manda", () => {
    const base = REPUTATION_ERROR_MESSAGES_ES.REPUTATION_INSUFFICIENT_DATA;
    assert.equal(reputationErrorMessage({ details: { code: "REPUTATION_INSUFFICIENT_DATA", reviewCount: 4 } }), `${base} Hay 4 reseñas en la ventana.`);
    assert.equal(reputationErrorMessage({ details: { code: "REPUTATION_INSUFFICIENT_DATA", reviewCount: 1 } }), `${base} Hay 1 reseña en la ventana.`);
    assert.equal(reputationErrorMessage({ details: { code: "REPUTATION_INSUFFICIENT_DATA" } }), base);
  });

  it("reputationErrorCode / hasReputationErrorCode / reputationErrorStatus", () => {
    const error = new FakeApiError("x", 422, { code: "REVIEW_IMPORT_INVALID", invalid: [{ row: 3, reason: "nota fuera de escala" }] });
    assert.equal(reputationErrorCode(error), "REVIEW_IMPORT_INVALID");
    assert.equal(hasReputationErrorCode(error, "REVIEW_IMPORT_INVALID"), true);
    assert.equal(hasReputationErrorCode(error, "REVIEW_IMPORT_DUPLICATE"), false);
    assert.equal(reputationErrorStatus(error), 422);
    assert.equal(reputationErrorCode(new Error("sin details")), null);
    assert.equal(reputationErrorStatus("cadena"), null);
    for (const code of REPUTATION_ERROR_CODES) assert.equal(reputationErrorMessage({ details: { code } }), REPUTATION_ERROR_MESSAGES_ES[code]);
  });
});

describe("reputation-contracts · etiquetas y copys en español", () => {
  it("statusLabel / providerLabel / categoryLabel / sourceStatusLabel / sourceModeLabel", () => {
    assert.equal(statusLabel("new"), "Nueva");
    assert.equal(statusLabel("responded"), "Respondida");
    assert.equal(statusLabel("desconocido"), "desconocido");
    assert.equal(providerLabel("google"), "Google");
    assert.equal(providerLabel("google_demo"), "Google · demo");
    assert.equal(providerLabel(" Booking "), "Booking.com");
    assert.equal(providerLabel("portal_x"), "portal_x");
    assert.equal(categoryLabel("precio_valor"), "Relación calidad-precio");
    assert.equal(categoryLabel("recepcion_checkin"), "Recepción y llegada");
    assert.equal(sourceStatusLabel("unavailable"), "Sin conexión disponible");
    assert.equal(sourceStatusLabel("pending"), "Pendiente de autorizar");
    assert.equal(sourceModeLabel("csv"), "Importación CSV");
    assert.equal(sentimentLabel("negative"), "Negativa");
    assert.equal(sentimentLabel(null), "Sin nota");
    assert.equal(analysisSourceLabel("dictionary"), "Análisis por diccionario · IA no configurada");
    assert.equal(trendLabel("down"), "Empeora");
    assert.equal(trendLabel(undefined), "Sin tendencia");
    for (const status of REVIEW_STATUSES) assert.notEqual(statusLabel(status), status);
    for (const provider of REVIEW_PROVIDERS) assert.notEqual(providerLabel(provider), provider);
    for (const category of REVIEW_CATEGORIES) assert.notEqual(categoryLabel(category), category);
    for (const status of REVIEW_SOURCE_STATUSES) assert.notEqual(sourceStatusLabel(status), status);
  });

  it("indexStatusCopy: los cuatro estados sin cifra y null con ok", () => {
    assert.equal(indexStatusCopy({ status: "no_sources" }), "Sin fuentes configuradas");
    assert.equal(indexStatusCopy({ status: "no_reviews" }), "Sin reseñas en la ventana");
    assert.equal(indexStatusCopy({ status: "insufficient", reviewCount: 4 }), `4 reseñas · insuficiente (mínimo ${INDEX_MIN_REVIEWS})`);
    assert.equal(indexStatusCopy({ status: "insufficient", reviewCount: 1 }), "1 reseña · insuficiente (mínimo 10)");
    assert.equal(indexStatusCopy({ status: "insufficient" }), "0 reseñas · insuficiente (mínimo 10)");
    assert.equal(indexStatusCopy({ status: "module_off" }), "Módulo no activado");
    assert.equal(indexStatusCopy({ status: "ok", reviewCount: 40 }), null);
    assert.equal(INDEX_MIN_REVIEWS, 10);
  });

  it("formatos es-ES con coma y tonos", () => {
    assert.equal(formatScore10(8.66), "8,7");
    assert.equal(formatScore10(10), "10,0");
    assert.equal(formatScore10(null), "—");
    assert.equal(formatIndex(87.46), "87,5");
    assert.equal(formatIndex(undefined), "—");
    assert.equal(formatTrendDelta(2.3), "+2,3");
    assert.equal(formatTrendDelta(-1), "−1,0");
    assert.equal(formatTrendDelta(0), "0,0");
    assert.equal(formatTrendDelta(null), "—");
    assert.equal(reviewCountText(0), "0 reseñas");
    assert.equal(reviewCountText(1), "1 reseña");
    assert.equal(staleCopy(0), null);
    assert.equal(staleCopy(1), "datos de ayer");
    assert.equal(staleCopy(3.9), "datos de hace 3 días");
    assert.equal(indexTone(85), "success");
    assert.equal(indexTone(70), "warning");
    assert.equal(indexTone(69), "danger");
    assert.equal(scoreTone(8.5), "success");
    assert.equal(scoreTone(6), "warning");
    assert.equal(scoreTone(5), "danger");
    assert.equal(sentimentTone("positive"), "success");
    assert.equal(sentimentTone("neutral"), "warning");
    assert.equal(sentimentTone("negative"), "danger");
    assert.equal(sentimentTone(null), "neutral");
    assert.equal(sourceStatusTone("connected"), "success");
    assert.equal(sourceStatusTone("degraded"), "warning");
    assert.equal(sourceStatusTone("error"), "danger");
    assert.equal(sourceStatusTone("disabled"), "neutral");
  });

  it("ningún texto visible lleva «review» en inglés ni códigos crudos", () => {
    const visible: string[] = [
      ...Object.values(REVIEW_CATEGORY_LABELS_ES),
      ...Object.values(REVIEW_PROVIDER_LABELS_ES),
      ...Object.values(REVIEW_SOURCE_MODE_LABELS_ES),
      ...Object.values(REVIEW_SOURCE_STATUS_LABELS_ES),
      ...Object.values(REVIEW_STATUS_LABELS_ES),
      ...Object.values(SENTIMENT_LABELS_ES),
      ...Object.values(ANALYSIS_SOURCE_LABELS_ES),
      ...Object.values(TREND_DIRECTION_LABELS_ES),
      ...Object.values(REPUTATION_ERROR_MESSAGES_ES),
      REPUTATION_ERROR_FALLBACK_ES,
      ...REPUTATION_INDEX_STATUSES.map((status) => indexStatusCopy({ status, reviewCount: 3 }) ?? ""),
      staleCopy(1) ?? "",
      staleCopy(4) ?? "",
      sentimentLabel(null),
      trendLabel(null),
      reputationErrorMessage({ details: { code: "REPUTATION_INSUFFICIENT_DATA", reviewCount: 2 } })
    ];
    for (const text of visible) {
      assert.equal(/\breviews?\b/i.test(text), false, `texto en inglés: ${text}`);
      assert.equal(/\b(no_sources|no_reviews|module_off|insufficient|portal_subscore)\b/.test(text), false, `código crudo: ${text}`);
    }
  });
});

describe("reputation-contracts · el fichero es autocontenido", () => {
  it("no contiene la cadena `import ` ni lee variables de entorno", () => {
    const source = readFileSync(SOURCE_FILE, "utf8");
    assert.equal(source.includes("import "), false, "el espejo del navegador no puede tener sentencias de importación");
    assert.equal(source.split("\n").filter((line) => /^import\b/.test(line)).length, 0);
    const envRead = new RegExp(`${["process", "env"].join("\\.")}|\\benv\\.|\\bmeta\\.env\\b`);
    assert.equal(envRead.test(source), false);
    assert.equal(/from ["']react["']|fetch\(|XMLHttpRequest/.test(source), false, "sin red ni React");
  });
});
