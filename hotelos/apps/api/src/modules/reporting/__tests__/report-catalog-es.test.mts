// Unit tests · Tanda UX-2 · lote D6 (F-D6): the report catalogue is in Spanish,
// the UI language, and the export file names the range it covers. No database:
// `reportCatalogEntries` and `buildReportFilename` are pure.
// Desde apps/api:
//   node --import tsx --test src/modules/reporting/__tests__/report-catalog-es.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportFilename, reportCatalogEntries } from "../reporting.service.js";

const ENGLISH_TITLE = /\b(and|invoices|payments|arrivals|departures|history|forecast)\b|&/i;

describe("Catálogo de informes en español (F-D6)", () => {
  it("los tres informes llevan título en español y conservan código, permiso, endpoint, formatos e inputs", () => {
    const entries = reportCatalogEntries();
    assert.deepEqual(
      entries.map((entry) => [entry.code, entry.title]),
      [
        ["reservation_arrivals_departures", "Reservas: llegadas y salidas"],
        ["billing_invoice_payment", "Facturación, facturas y cobros"],
        ["revenue_history_forecast", "Revenue: histórico y previsión"]
      ]
    );
    for (const entry of entries) {
      assert.doesNotMatch(entry.title, ENGLISH_TITLE, `título en inglés: ${entry.title}`);
      assert.deepEqual(entry.formats, ["pdf", "csv", "xlsx", "json"]);
      assert.ok(entry.inputs.includes("fromDate") && entry.inputs.includes("toDate"), `${entry.code} acepta rango`);
    }
    assert.deepEqual(entries.map((entry) => entry.permission), ["analytics.read", "analytics.read", "revenue.history_forecast.read"]);
    assert.deepEqual(entries.map((entry) => entry.endpoint), [
      "/reports/properties/:propertyId/reservations",
      "/reports/properties/:propertyId/billing",
      "/revenue/properties/:propertyId/history-forecast"
    ]);
  });

  it("cada llamada devuelve un catálogo nuevo (mutar la respuesta no altera el siguiente)", () => {
    const first = reportCatalogEntries();
    first[0].title = "mutado";
    first[0].formats.push("json");
    const second = reportCatalogEntries();
    assert.equal(second[0].title, "Reservas: llegadas y salidas");
    assert.deepEqual(second[0].formats, ["pdf", "csv", "xlsx", "json"]);
  });
});

describe("Nombre del fichero exportado (D6: el mes real)", () => {
  it("con rango en la query, el nombre lleva desde_hasta y la extensión realmente entregada (pdf → html, xlsx → csv)", () => {
    assert.equal(
      buildReportFilename("prop_uxday_b", "reservation", "pdf", { fromDate: "2026-09-01", toDate: "2026-09-20" }),
      "informe-reservation-prop_uxday_b-2026-09-01_2026-09-20.html"
    );
    assert.equal(
      buildReportFilename("prop_uxday_b", "billing", "xlsx", { fromDate: "2026-08-01", toDate: "2026-08-31" }),
      "informe-billing-prop_uxday_b-2026-08-01_2026-08-31.csv"
    );
    assert.equal(buildReportFilename("prop_uxday_b", "billing", "json", { fromDate: "2026-08-01", toDate: "2026-08-31" }), "informe-billing-prop_uxday_b-2026-08-01_2026-08-31.json");
  });

  it("sin rango (o con fechas malformadas) conserva el día de generación como sello", () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(buildReportFilename("prop_123", "reservation", "csv"), `informe-reservation-prop_123-${today}.csv`);
    assert.equal(buildReportFilename("prop_123", "reservation", "csv", { fromDate: "mayo", toDate: "2026-05-31" }), `informe-reservation-prop_123-${today}.csv`);
    assert.equal(buildReportFilename("prop_123", "reservation", "csv", { fromDate: "2026-05-01" }), `informe-reservation-prop_123-${today}.csv`);
  });
});
