// Unit tests for the forecast generator's coexistence with forecasts IMPORTED
// from another PMS (modelVersion "pms_import:*", ADR source "pms_forecast").
// Pure helpers only — no database. Run from apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/forecast-protection.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adrSourceFromDrivers,
  DETERMINISTIC_MODEL_VERSION,
  emptyAdrSourceCounts,
  forecastAdrSourceLabel,
  forecastDeleteFilter,
  isImportedForecastModelVersion,
  parseReportWindow,
  PMS_IMPORT_MODEL_PREFIX,
  REPORT_MAX_DAYS
} from "../forecast.service.js";
import { dayUtc } from "../actuals.js";
import { BadRequestError } from "../../../lib/http-error.js";

describe("isImportedForecastModelVersion", () => {
  it("recognises only the pms_import: prefix", () => {
    assert.equal(isImportedForecastModelVersion("pms_import:opera-hf-2026-09-14"), true);
    assert.equal(isImportedForecastModelVersion(`${PMS_IMPORT_MODEL_PREFIX}x`), true);
    assert.equal(isImportedForecastModelVersion(DETERMINISTIC_MODEL_VERSION), false);
    assert.equal(isImportedForecastModelVersion("deterministic-v1-backtest"), false);
    assert.equal(isImportedForecastModelVersion("PMS_IMPORT:x"), false);
    assert.equal(isImportedForecastModelVersion(null), false);
    assert.equal(isImportedForecastModelVersion(undefined), false);
  });
});

describe("forecastDeleteFilter — the generator never deletes imported rows", () => {
  it("scopes by property + range and excludes pms_import:* while keeping legacy NULL modelVersion rows deletable", () => {
    const from = dayUtc("2026-09-14");
    const to = dayUtc("2026-10-31");
    const where = forecastDeleteFilter({ propertyId: "prop_tilos", from, to });
    assert.equal(where.propertyId, "prop_tilos");
    assert.deepEqual(where.forecastDate, { gte: from, lte: to });
    // NULL never matches NOT LIKE in Postgres: the NULL branch must be explicit.
    assert.deepEqual(where.OR, [{ modelVersion: null }, { NOT: { modelVersion: { startsWith: "pms_import:" } } }]);
    assert.equal("modelVersion" in where, false);
  });
});

describe("adrSourceFromDrivers — pms_forecast", () => {
  it("reads the adr_source driver, including the new pms_forecast value", () => {
    assert.equal(adrSourceFromDrivers([{ driver: "adr_source", value: "pms_forecast" }]), "pms_forecast");
    assert.equal(adrSourceFromDrivers([{ driver: "adr_source", value: "rate_grid" }]), "rate_grid");
    assert.equal(adrSourceFromDrivers([{ driver: "adr_source", value: "fallback" }]), "legacy_constant");
  });

  it("falls back to pms_forecast for an imported modelVersion without the driver, and stays null otherwise", () => {
    assert.equal(adrSourceFromDrivers([], "pms_import:opera-hf-2026-09-14"), "pms_forecast");
    assert.equal(adrSourceFromDrivers([{ driver: "source_report", value: "History and Forecast" }], "pms_import:opera"), "pms_forecast");
    assert.equal(adrSourceFromDrivers(null, "pms_import:opera"), "pms_forecast");
    assert.equal(adrSourceFromDrivers([], DETERMINISTIC_MODEL_VERSION), null);
    assert.equal(adrSourceFromDrivers([]), null);
    assert.equal(adrSourceFromDrivers("not-an-array"), null);
    // An explicit driver always wins over the modelVersion hint.
    assert.equal(adrSourceFromDrivers([{ driver: "adr_source", value: "rate_grid" }], "pms_import:opera"), "rate_grid");
  });
});

describe("forecastAdrSourceLabel — imported forecast is never 'sin previsión'", () => {
  it("labels pms_forecast rows in Spanish and keeps the empty label for no rows", () => {
    const counts = emptyAdrSourceCounts();
    assert.equal(counts.pms_forecast, 0);
    assert.equal(forecastAdrSourceLabel(counts), "sin previsión");
    counts.pms_forecast = 48;
    assert.equal(forecastAdrSourceLabel(counts), "previsión del PMS (importada)");
    counts.rate_grid = 3;
    assert.equal(forecastAdrSourceLabel(counts), "previsión del PMS (importada)+tarifario BAR");
  });
});

describe("parseReportWindow — the live report never truncates silently (R2)", () => {
  const today = dayUtc("2026-09-14");
  it("defaults to today .. today+30 and accepts up to REPORT_MAX_DAYS (120)", () => {
    assert.equal(REPORT_MAX_DAYS, 120);
    assert.deepEqual(parseReportWindow({ today }), { from: "2026-09-14", to: "2026-10-14", days: 31 });
    assert.deepEqual(parseReportWindow({ from: "2026-10-01", today }), { from: "2026-10-01", to: "2026-10-31", days: 31 });
    assert.equal(parseReportWindow({ from: "2026-01-01", to: "2026-04-30", today }).days, 120);
  });
  it("2026-01-01..2026-10-31 (304 days) is a 400 naming the limit, not 120 rows echoing the request", () => {
    assert.throws(
      () => parseReportWindow({ from: "2026-01-01", to: "2026-10-31", today }),
      (e: unknown) => e instanceof BadRequestError && e.message === "la ventana máxima del informe es 120 días (pedidos 304)"
    );
  });
  it("rejects malformed dates with a Spanish 400", () => {
    assert.throws(
      () => parseReportWindow({ from: "2026-13-01", to: "x", today }),
      (e: unknown) => e instanceof BadRequestError && e.message === "from debe ser una fecha YYYY-MM-DD válida"
    );
  });
});
