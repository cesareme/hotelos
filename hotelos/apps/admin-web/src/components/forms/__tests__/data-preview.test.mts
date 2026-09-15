import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataPreview, RECORDS_TABLE_MAX_COLUMNS, columnsForRecords, isTechnicalKey } from "../FormComponents.tsx";
import { booleanLabel, dataKeyLabel } from "../../../content/data-labels.ts";

// browser-roles#9: Propiedad › Perfil and Habitaciones painted raw keys («HAS
// BAR», «TAX REGION RAW», «SORT ORDER») and «Yes/No», and dumped 92 room
// records in full.
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
    assert.match(html, /92 registros/);
    assert.match(html, />Número</);
    assert.match(html, />Código de habitación</);
    assert.match(html, />Ocupación máxima</);
    assert.doesNotMatch(html, /ROOM CODE|Room Code|Sort Order|Yes|No data/);
    assert.equal((html.match(/<tr/g) ?? []).length, 93, "header + 92 rows");
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
    assert.doesNotMatch(html, /Has Bar|Provisioned|Yes/);
  });
});
