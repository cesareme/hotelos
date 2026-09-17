import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataPreview, RECORDS_TABLE_MAX_COLUMNS, columnsForRecords, formatScalar, isTechnicalKey } from "../CocoaDataPreview.tsx";
import { booleanLabel, dataKeyLabel } from "../../../content/data-labels.ts";

// browser-roles#9: Propiedad › Perfil and Habitaciones painted raw keys («HAS
// BAR», «TAX REGION RAW», «SORT ORDER») and «Yes/No», and dumped 92 room
// records in full. Ola 11 · R2: the dump is Cocoa (CocoaTable, CocoaBadge and
// the cocoa-base utilities), without `.dp-*`, `.cm-table` or `.bo-*`.
const ROOM = {
  id: "cmu1mifd3000jfyo19a2amxwn",
  propertyId: "cmu1mifcp0000fyo1wzvq7txo",
  roomTypeId: "rt_61296113",
  number: "110",
  floor: "Planta 1",
  roomCode: "RM110",
  displayName: "Room 110",
  maxOccupancy: 2,
  standardOccupancy: 2,
  bedConfigurationJson: {},
  status: "clean",
  maintenanceStatus: "ok",
  sellable: true,
  active: true,
  sortOrder: 110
};

describe("DataPreview · etiquetas en español", () => {
  it("labels known keys in Spanish and humanises the rest", () => {
    assert.equal(dataKeyLabel("hasBar"), "Tiene bar");
    assert.equal(dataKeyLabel("taxRegionRaw"), "Región fiscal (código)");
    assert.equal(dataKeyLabel("sortOrder"), "Orden");
    assert.equal(dataKeyLabel("maintenanceStatus"), "Estado de mantenimiento");
    assert.equal(dataKeyLabel("createdAt"), "Creado");
    assert.equal(dataKeyLabel("someUnknownKey"), "Some unknown key");
    assert.equal(dataKeyLabel("roomNumber", { roomNumber: "Número de habitación" }), "Número de habitación");
  });

  it("says Sí / No, never Yes / No", () => {
    assert.equal(booleanLabel(true), "Sí");
    assert.equal(booleanLabel(false), "No");
  });
});

describe("DataPreview · lista de registros", () => {
  it("picks scalar columns without ids or JSON blobs, capped", () => {
    assert.equal(isTechnicalKey("id"), true);
    assert.equal(isTechnicalKey("roomTypeId"), true);
    assert.equal(isTechnicalKey("featuresJson"), true);
    assert.equal(isTechnicalKey("sortOrder"), false);
    const columns = columnsForRecords([ROOM, { ...ROOM, extra1: 1, extra2: 2, extra3: 3, extra4: 4 }]);
    assert.deepEqual(columns.slice(0, 4), ["number", "floor", "roomCode", "displayName"]);
    assert.ok(!columns.includes("id") && !columns.includes("propertyId") && !columns.includes("bedConfigurationJson"));
    assert.ok(columns.length <= RECORDS_TABLE_MAX_COLUMNS);
  });

  it("renders an array of records as one compact table with Spanish headers", () => {
    const rows = Array.from({ length: 92 }, (_, i) => ({ ...ROOM, id: `r${i}`, number: String(100 + i) }));
    const html = renderToStaticMarkup(createElement(DataPreview, { data: rows }));
    assert.match(html, /<table/);
    assert.match(html, /data-cocoa="table"/, "the records table is a CocoaTable");
    assert.match(html, /92 registros/);
    assert.match(html, />Número</);
    assert.match(html, />Código de habitación</);
    assert.match(html, />Ocupación máxima</);
    assert.doesNotMatch(html, /ROOM CODE|Room Code|Sort Order|Yes|No data/);
    assert.equal((html.match(/<tr/g) ?? []).length, 93, "header + 92 rows");
    assert.doesNotMatch(html, /class="[^"]*\b(dp-|cm-table|rev-report-wrap|bo-)/, "no legacy classes");
  });

  it("renders a nested object with dictionary labels and Sí/No", () => {
    const html = renderToStaticMarkup(
      createElement(DataPreview, {
        data: { compliance: { configurationJson: { pilotProfile: { hasBar: true, plazas: 176, starRating: 4 } }, provisioned: true, taxRegionRaw: "ES_PENINSULA_BALEARES" } }
      })
    );
    assert.match(html, /Tiene bar/);
    assert.match(html, /Plazas/);
    assert.match(html, /Aprovisionado/);
    assert.match(html, /Región fiscal \(código\)/);
    assert.match(html, />Sí</);
    assert.match(html, /c22-badge/, "Sí/No is a CocoaBadge");
    assert.match(html, /<details open=""/, "nested objects open by default");
    assert.match(html, /class="cocoa-caption"/, "keys are captions");
    assert.doesNotMatch(html, /Has Bar|Provisioned|Yes/);
    assert.doesNotMatch(html, /class="[^"]*\b(dp-|bo-)/, "no legacy classes");
  });

  it("paints ids and numbers in mono, dates localised and empty lists as a note", () => {
    assert.deepEqual(formatScalar(null), { display: "—" });
    assert.deepEqual(formatScalar(true), { display: "Sí", state: true });
    assert.deepEqual(formatScalar(176), { display: "176", mono: true });
    assert.deepEqual(formatScalar("rt_61296113"), { display: "rt_61296113", mono: true });
    assert.deepEqual(formatScalar("Planta 1"), { display: "Planta 1", mono: false });
    assert.notEqual(formatScalar("2026-09-16T10:00:00.000Z").display, "2026-09-16T10:00:00.000Z");
    const html = renderToStaticMarkup(createElement(DataPreview, { data: { tags: [], amenities: ["wifi", "spa"], nothing: null } }));
    assert.match(html, /cocoa-note[^>]*>vacío</);
    assert.match(html, /cocoa-cluster/);
    assert.match(html, />wifi<[\s\S]*>spa</);
    assert.match(html, />—</);
  });

  it("says the empty message when there is nothing to paint", () => {
    assert.match(renderToStaticMarkup(createElement(DataPreview, { data: {} })), /cocoa-note[^>]*>Sin datos\.</);
    assert.match(renderToStaticMarkup(createElement(DataPreview, { data: [], emptyMessage: "Aún no hay datos guardados." })), />Aún no hay datos guardados\.</);
  });
});
