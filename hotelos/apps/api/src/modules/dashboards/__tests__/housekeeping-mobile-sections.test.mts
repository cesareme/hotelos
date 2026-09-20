// Unit tests · Tanda UX-3 · P2 (F5) — sección de cada habitación en Mi turno
// (dashboards/housekeeping-mobile.service.ts). indexSections y sectionsWithCounts
// son puras; el fuente se lee para pinar que la sección sale de UNA consulta
// (join de las secciones activas con sus habitaciones) degradable con safe()
// y que el resultado expone sectionId/sectionName por habitación y sections[]
// (aditivo). Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/housekeeping-mobile-sections.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { indexSections, sectionsWithCounts, type HkSectionRow } from "../housekeeping-mobile.service.js";

const SOURCE = readFileSync(new URL("../housekeeping-mobile.service.ts", import.meta.url), "utf8");

const ROWS: HkSectionRow[] = [
  { sectionId: "sec_1", sectionName: "Planta 1", sectionCode: "P1", roomId: "room_101" },
  { sectionId: "sec_1", sectionName: "Planta 1", sectionCode: "P1", roomId: "room_102" },
  { sectionId: "sec_2", sectionName: "Planta 2", sectionCode: "P2", roomId: "room_201" },
  // Habitación repetida en otra sección: se queda con la primera del orden de la consulta.
  { sectionId: "sec_2", sectionName: "Planta 2", sectionCode: "P2", roomId: "room_101" },
  // Sección sin habitaciones (LEFT JOIN): aparece como chip, no aporta habitaciones.
  { sectionId: "sec_x", sectionName: "Zona común", sectionCode: null, roomId: null }
];

describe("indexSections (pura)", () => {
  it("secciones en el orden de la consulta, sin repetir, con code solo cuando existe", () => {
    const { sections } = indexSections(ROWS);
    assert.deepEqual(sections, [
      { id: "sec_1", name: "Planta 1", code: "P1" },
      { id: "sec_2", name: "Planta 2", code: "P2" },
      { id: "sec_x", name: "Zona común" }
    ]);
    assert.equal("code" in sections[2], false, "sin código no se emite la clave (aditivo, sin nulls)");
  });

  it("byRoom: cada habitación con su primera sección; una sección sin habitaciones no añade nada", () => {
    const { byRoom } = indexSections(ROWS);
    assert.deepEqual(
      [...byRoom.entries()],
      [
        ["room_101", { sectionId: "sec_1", sectionName: "Planta 1" }],
        ["room_102", { sectionId: "sec_1", sectionName: "Planta 1" }],
        ["room_201", { sectionId: "sec_2", sectionName: "Planta 2" }]
      ]
    );
  });

  it("sin filas → sin secciones ni habitaciones (degradado: Mi turno pinta la lista sin chips)", () => {
    const { sections, byRoom } = indexSections([]);
    assert.deepEqual(sections, []);
    assert.equal(byRoom.size, 0);
  });

  it("no muta las filas de entrada", () => {
    const copy = ROWS.map((row) => ({ ...row }));
    indexSections(ROWS);
    assert.deepEqual(ROWS, copy);
  });
});

describe("sectionsWithCounts (pura)", () => {
  const sections = indexSections(ROWS).sections;

  it("cuenta las habitaciones en cola por sección; sin pendientes → 0 (el chip sigue existiendo)", () => {
    const rooms = [{ sectionId: "sec_1" }, { sectionId: "sec_1" }, { sectionId: "sec_2" }];
    assert.deepEqual(sectionsWithCounts(sections, rooms), [
      { id: "sec_1", name: "Planta 1", code: "P1", total: 2 },
      { id: "sec_2", name: "Planta 2", code: "P2", total: 1 },
      { id: "sec_x", name: "Zona común", total: 0 }
    ]);
  });

  it("habitaciones sin sección (o de una sección inactiva) no cuentan en ninguna", () => {
    const rooms = [{ sectionId: undefined }, { sectionId: "sec_borrada" }, { sectionId: "sec_2" }];
    assert.deepEqual(
      sectionsWithCounts(sections, rooms).map((s) => [s.id, s.total]),
      [
        ["sec_1", 0],
        ["sec_2", 1],
        ["sec_x", 0]
      ]
    );
  });

  it("conserva el orden y los campos de la sección; sin secciones devuelve []", () => {
    assert.deepEqual(sectionsWithCounts([], [{ sectionId: "sec_1" }]), []);
    const out = sectionsWithCounts(sections, []);
    assert.deepEqual(
      out.map((s) => s.id),
      ["sec_1", "sec_2", "sec_x"]
    );
    assert.notEqual(out[0], sections[0], "devuelve objetos nuevos");
  });
});

describe("buildHousekeepingMobile · contrato de fuente (una consulta, degradable, aditivo)", () => {
  it("una sola consulta: join de housekeeping_sections activas de la propiedad con housekeeping_section_rooms, bajo safe()", () => {
    assert.match(SOURCE, /safe\(\s*"housekeeping_sections",\s*prisma\.\$queryRaw<HkSectionRow\[\]>`/);
    assert.match(
      SOURCE,
      /FROM housekeeping_sections s\s+LEFT JOIN housekeeping_section_rooms r ON r\.housekeeping_section_id = s\.id\s+WHERE s\.property_id = \$\{propertyId\} AND s\.active = true/
    );
    assert.equal((SOURCE.match(/housekeeping_section_rooms/g) ?? []).length, 1, "la tabla de habitaciones de sección solo aparece en el join");
    assert.doesNotMatch(SOURCE, /prisma\.housekeepingSection(?:Room)?\.findMany/, "sin consultas Prisma adicionales por secciones");
    assert.doesNotMatch(SOURCE, /\$queryRawUnsafe/, "consulta parametrizada (tagged template), nunca texto interpolado");
  });

  it("la consulta forma parte del Promise.all inicial (no una ida y vuelta extra)", () => {
    assert.match(SOURCE, /const \[rooms, roomTypes, arrivals, departures, inHouse, openTasks, workOrders, sectionRows\] = await Promise\.all\(\[/);
    assert.match(SOURCE, /indexSections\(sectionRows\)/);
  });

  it("cada habitación lleva sectionId/sectionName del índice y el resultado expone sections[] con recuentos", () => {
    assert.match(SOURCE, /sectionId\?: string;\s*sectionName\?: string;/);
    assert.match(SOURCE, /sectionId: sectionByRoom\.get\(room\.id\)\?\.sectionId,\s*sectionName: sectionByRoom\.get\(room\.id\)\?\.sectionName,/);
    assert.match(SOURCE, /sections: HkMobileSection\[\];/);
    assert.match(SOURCE, /sections: sectionsWithCounts\(sectionList, items\), degraded \}/);
  });
});
