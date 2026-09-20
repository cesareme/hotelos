/**
 * Tanda ACT · lote L6 · exportación CSV (export.service.ts, escritor propio,
 * sin BD): BOM UTF-8, separador `;`, CRLF, escapado de `;`, comillas y saltos
 * de línea, coma decimal, cabeceras en español, una línea por centro sin
 * línea de totales (los totales del JSON cuadran con las filas exportadas),
 * calendario con una línea por evento, nombre del fichero y consulta.
 * También los cálculos puros de la vista de grupo (group.service.ts):
 * porcentajes, fila sin ficha, totales y alertas altas.
 *
 * Run: cd apps/api && node --import tsx --test src/modules/real-estate/__tests__/export.test.mts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealEstateAlert, RealEstateGroupOverview, RealEstateGroupRow } from "@hotelos/shared";
import { Prisma } from "@prisma/client";
import { buildCalendarYear, type RealEstateCalendarYear } from "../calendar.service.js";
import {
  CALENDAR_CSV_HEADER,
  calendarToCsv,
  CSV_BOM,
  CSV_CONTENT_TYPE,
  CSV_EOL,
  CSV_SEPARATOR,
  csvCell,
  csvMoney,
  csvPercent,
  exportFileName,
  GROUP_OVERVIEW_CSV_HEADER,
  groupOverviewToCsv,
  RealEstateExportQuerySchema,
  toCsv
} from "../export.service.js";
import { buildGroupRow, computeGroupTotals, documentsValidPctOf, highAlertsOf, inspectionsOnTimePctOf, percentOf, selectVisibleProperties } from "../group.service.js";

const TODAY = "2026-09-20";
const D = (value: string) => new Prisma.Decimal(value);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Líneas del CSV sin el BOM ni la línea vacía final. */
const linesOf = (csv: string) => csv.replace(/^\uFEFF/, "").split(CSV_EOL).filter((line) => line.length > 0);

/** Lector mínimo de una línea CSV `;` con comillas dobladas (solo para cotejar las cifras exportadas). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\"" && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === ";") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function overviewFixture(): RealEstateGroupOverview {
  const rows: RealEstateGroupRow[] = [
    { propertyId: "prop_a", propertyCode: "L2A", propertyName: "Hotel Norte; \"Playa\"", tenureKind: "propiedad", cadastralValueTotal: "3250000.00", lastValuationValue: "5100000.50", annualTaxBurden: "12000.00", documentsValidPct: "100.00", inspectionsOnTimePct: "50.00", openAlertsHigh: 1, openAlerts: 3 },
    { propertyId: "prop_b", propertyCode: null, propertyName: "Hotel Sur", tenureKind: "gestion", cadastralValueTotal: "1800000.00", lastValuationValue: null, annualTaxBurden: null, documentsValidPct: null, inspectionsOnTimePct: null, openAlertsHigh: 0, openAlerts: 2 },
    { propertyId: "prop_c", propertyCode: "OC", propertyName: "Oficina central", tenureKind: null, cadastralValueTotal: null, lastValuationValue: null, annualTaxBurden: null, documentsValidPct: null, inspectionsOnTimePct: null, openAlertsHigh: 0, openAlerts: 0 }
  ];
  return { rows, totals: computeGroupTotals(rows), alerts: [] };
}

describe("ACT-L6 · escritor CSV", () => {
  it("csvCell: vacío para null / undefined; entrecomilla `;`, comillas y saltos de línea doblando las comillas", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell("Hotel"), "Hotel");
    assert.equal(csvCell(12), "12");
    assert.equal(csvCell("a;b"), "\"a;b\"");
    assert.equal(csvCell("con \"comillas\""), "\"con \"\"comillas\"\"\"");
    assert.equal(csvCell("línea 1\nlínea 2"), "\"línea 1\nlínea 2\"");
    assert.equal(csvCell("cr\rlf"), "\"cr\rlf\"");
  });

  it("csvCell neutraliza celdas que una hoja de cálculo ejecutaría como fórmula (ACT-REV-05: =, +, -, @, tabulador, retorno) con apóstrofo y comillas", () => {
    assert.equal(csvCell("=1+1"), "\"'=1+1\"");
    assert.equal(csvCell("+cmd|' /C calc'!A0"), "\"'+cmd|' /C calc'!A0\"");
    assert.equal(csvCell("-2+3"), "\"'-2+3\"");
    assert.equal(csvCell("@SUM(A1)"), "\"'@SUM(A1)\"");
    assert.equal(csvCell("\t=HYPERLINK()"), "\"'\t=HYPERLINK()\"");
    assert.equal(csvCell("=a;b"), "\"'=a;b\"");
    assert.equal(csvCell("Póliza =RC-2026"), "Póliza =RC-2026", "solo al inicio de la celda");
    assert.equal(csvCell(-12), "-12", "los números no son texto libre");
  });

  it("csvMoney / csvPercent: coma decimal y vacío sin valor", () => {
    assert.equal(csvMoney("1234.56"), "1234,56");
    assert.equal(csvMoney(null), "");
    assert.equal(csvPercent("83.33"), "83,33");
    assert.equal(csvPercent(null), "");
  });

  it("toCsv: BOM al inicio, separador `;`, CRLF y CRLF final; la cabecera también se escapa", () => {
    const csv = toCsv(["Uno", "Dos; tres"], [["a", "b"], ["c", ""]]);
    assert.ok(csv.startsWith(CSV_BOM));
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.equal(csv, `\uFEFFUno;"Dos; tres"\r\na;b\r\nc;\r\n`);
    assert.equal(CSV_SEPARATOR, ";");
    assert.equal(CSV_CONTENT_TYPE, "text/csv; charset=utf-8");
  });
});

describe("ACT-L6 · vista de grupo → CSV", () => {
  it("cabecera en español + una línea por centro, sin línea de totales", () => {
    const overview = overviewFixture();
    const csv = groupOverviewToCsv(overview);
    const lines = linesOf(csv);
    assert.equal(lines.length, 1 + overview.rows.length, "cabecera + N centros");
    assert.equal(lines[0], GROUP_OVERVIEW_CSV_HEADER.join(";"));
    assert.equal(lines[0].split(";")[0], "Centro");
    assert.equal(lines[1], "\"Hotel Norte; \"\"Playa\"\"\";L2A;Propiedad;3250000,00;5100000,50;12000,00;100,00;50,00;1;3");
    assert.equal(lines[2], "Hotel Sur;;Contrato de gestión;1800000,00;;;;;0;2");
    assert.equal(lines[3], "Oficina central;OC;;;;;;;0;0");
    assert.ok(!/Total/i.test(csv), "sin línea de totales");
  });

  it("los totales del JSON cuadran con las filas exportadas (Σ importes y alertas)", () => {
    const overview = overviewFixture();
    const lines = linesOf(groupOverviewToCsv(overview)).slice(1);
    const parse = (cell: string) => (cell === "" ? 0 : Number(cell.replace(",", ".")));
    const column = (index: number) => lines.reduce((acc, line) => acc + parse(splitCsvLine(line)[index]), 0);
    assert.equal(overview.totals.properties, lines.length);
    assert.equal(column(3).toFixed(2), overview.totals.cadastralValueTotal);
    assert.equal(column(4).toFixed(2), overview.totals.lastValuationValue);
    assert.equal(column(5).toFixed(2), overview.totals.annualTaxBurden);
    assert.equal(column(8), overview.totals.openAlertsHigh);
    assert.equal(column(9), overview.totals.openAlerts);
    assert.deepEqual(overview.totals, { properties: 3, cadastralValueTotal: "5050000.00", lastValuationValue: "5100000.50", annualTaxBurden: "12000.00", openAlertsHigh: 1, openAlerts: 5 });
  });

  it("sin centros: solo la cabecera", () => {
    const csv = groupOverviewToCsv({ rows: [], totals: computeGroupTotals([]), alerts: [] });
    assert.deepEqual(linesOf(csv), [GROUP_OVERVIEW_CSV_HEADER.join(";")]);
  });
});

describe("ACT-L6 · calendario → CSV", () => {
  const calendar: RealEstateCalendarYear = buildCalendarYear({
    year: 2026,
    properties: [{ propertyId: "prop_a", propertyCode: "L2A", propertyName: "Hotel Norte" }, { propertyId: "prop_b", propertyCode: null, propertyName: "Hotel Sur" }],
    events: [
      { kind: "INSPECTION_DUE", dueAt: "2026-10-15", entityType: "real_estate_inspection", entityId: "insp_1", propertyId: "prop_a", label: "OCA del ascensor (RAE-0001) · próxima inspección el 15/10/2026" },
      { kind: "TAX_DUE", dueAt: "2026-09-01", entityType: "property_tax_receipt", entityId: "tax_1", propertyId: "prop_b", label: "Inicio del periodo voluntario previsto · IBI 2026 (sin recibo)" },
      { kind: "DOCUMENT_EXPIRING", dueAt: "2026-11-30", entityType: "real_estate_document", entityId: "doc_1", propertyId: "prop_a", label: "Documento «Licencia; \"actividad\"» caduca el 30/11/2026" }
    ]
  });

  it("una línea por evento en orden cronológico con mes, fecha, centro, tipo en español, clave, descripción escapada, entidad e id", () => {
    const lines = linesOf(calendarToCsv(calendar));
    assert.equal(lines.length, 1 + 3);
    assert.equal(lines[0], CALENDAR_CSV_HEADER.join(";"));
    assert.equal(lines[1], "9;2026-09-01;Hotel Sur;;Tributo local;TAX_DUE;Inicio del periodo voluntario previsto · IBI 2026 (sin recibo);property_tax_receipt;tax_1");
    assert.equal(lines[2], "10;2026-10-15;Hotel Norte;L2A;Inspección obligatoria;INSPECTION_DUE;OCA del ascensor (RAE-0001) · próxima inspección el 15/10/2026;real_estate_inspection;insp_1");
    assert.equal(lines[3], "11;2026-11-30;Hotel Norte;L2A;Vigencia de documento;DOCUMENT_EXPIRING;\"Documento «Licencia; \"\"actividad\"\"» caduca el 30/11/2026\";real_estate_document;doc_1");
  });

  it("un evento de un centro que no está en `properties` sale con su id como nombre", () => {
    const orphan = buildCalendarYear({ year: 2026, properties: [], events: [{ kind: "TAX_DUE", dueAt: "2026-05-05", entityType: "property_tax_receipt", entityId: "r", propertyId: "prop_x", label: "x" }] });
    assert.equal(linesOf(calendarToCsv(orphan))[1], "5;2026-05-05;prop_x;;Tributo local;TAX_DUE;x;property_tax_receipt;r");
  });
});

describe("ACT-L6 · nombre del fichero y consulta", () => {
  it("activo-inmobiliario-<what>-<año>.csv", () => {
    assert.equal(exportFileName("overview", 2026), "activo-inmobiliario-overview-2026.csv");
    assert.equal(exportFileName("calendar", 2027), "activo-inmobiliario-calendar-2027.csv");
  });

  it("consulta: what obligatorio (overview | calendar), format solo csv, year AAAA, sin claves desconocidas", () => {
    assert.deepEqual(RealEstateExportQuerySchema.parse({ what: "overview" }), { what: "overview" });
    assert.deepEqual(RealEstateExportQuerySchema.parse({ what: "calendar", format: "csv", year: "2026" }), { what: "calendar", format: "csv", year: 2026 });
    assert.equal(RealEstateExportQuerySchema.safeParse({}).success, false);
    assert.equal(RealEstateExportQuerySchema.safeParse({ what: "foo" }).success, false);
    assert.equal(RealEstateExportQuerySchema.safeParse({ what: "overview", format: "xlsx" }).success, false);
    assert.equal(RealEstateExportQuerySchema.safeParse({ what: "overview", year: "26" }).success, false);
    assert.equal(RealEstateExportQuerySchema.safeParse({ what: "overview", foo: 1 }).success, false);
  });
});

describe("ACT-L6 · cálculos puros de la vista de grupo", () => {
  it("percentOf: dos decimales; null sin población", () => {
    assert.equal(percentOf(1, 3), "33.33");
    assert.equal(percentOf(2, 3), "66.67");
    assert.equal(percentOf(0, 4), "0.00");
    assert.equal(percentOf(0, 0), null);
  });

  it("documentsValidPctOf: vigente y sin_fecha cuentan; caduca_pronto y caducado no (30 días; 90 en seguros e inspecciones)", () => {
    const pct = documentsValidPctOf(
      [
        { category: "licencias", validUntil: day("2026-12-31"), supersededById: null },
        { category: "legal", validUntil: null, supersededById: null },
        { category: "licencias", validUntil: day("2026-10-01"), supersededById: null },
        { category: "seguros", validUntil: day("2026-12-01"), supersededById: null },
        { category: "otros", validUntil: day("2026-01-01"), supersededById: null }
      ],
      TODAY
    );
    assert.equal(pct, "40.00", "2 válidos de 5: caduca_pronto (11 días), seguro a 72 días (< 90) y caducado no cuentan");
    assert.equal(documentsValidPctOf([], TODAY), null);
  });

  it("inspectionsOnTimePctOf: sobre las abiertas; sin fecha cuenta como en plazo; cerradas fuera", () => {
    const pct = inspectionsOnTimePctOf(
      [
        { status: "programada", scheduledAt: day("2026-10-15"), nextDueAt: null },
        { status: "realizada", scheduledAt: null, nextDueAt: day("2026-02-10") },
        { status: "programada", scheduledAt: null, nextDueAt: null },
        { status: "cerrada", scheduledAt: null, nextDueAt: day("2025-01-01") }
      ],
      TODAY
    );
    assert.equal(pct, "66.67", "2 en plazo de 3 abiertas");
    assert.equal(inspectionsOnTimePctOf([{ status: "cerrada", scheduledAt: null, nextDueAt: null }], TODAY), null);
  });

  it("buildGroupRow: ficha con datos; sin ficha todo null y las alertas se cuentan igual", () => {
    const alerts: RealEstateAlert[] = [
      { kind: "TAX_OVERDUE", severity: "alta", dueAt: "2026-01-01", entityType: "property_tax_receipt", entityId: "r", propertyId: "prop_a", message: "x" },
      { kind: "DOCUMENT_EXPIRING", severity: "baja", dueAt: "2026-12-01", entityType: "real_estate_document", entityId: "d", propertyId: "prop_a", message: "y" }
    ];
    const row = buildGroupRow({
      property: { propertyId: "prop_a", propertyCode: "L2A", propertyName: "Hotel Norte" },
      asset: { id: "asset_a", propertyId: "prop_a", cadastralValueTotal: null, lastValuationValue: D("5100000.5"), currentTenureKind: "propiedad", units: [{ cadastralValueLand: D("1000000"), cadastralValueBuilding: D("2250000") }, { cadastralValueLand: null, cadastralValueBuilding: null }] },
      taxes: [
        { status: "activo", taxpayer: "sociedad", expectedAnnualAmount: D("12000") },
        { status: "activo", taxpayer: "arrendatario", expectedAnnualAmount: D("1500") },
        { status: "baja", taxpayer: "sociedad", expectedAnnualAmount: D("900") }
      ],
      documents: [{ category: "licencias", validUntil: day("2026-12-31"), supersededById: null }],
      inspections: [{ status: "programada", scheduledAt: day("2026-10-15"), nextDueAt: null }],
      alerts,
      today: TODAY
    });
    assert.deepEqual(row, { propertyId: "prop_a", propertyCode: "L2A", propertyName: "Hotel Norte", tenureKind: "propiedad", cadastralValueTotal: "3250000.00", lastValuationValue: "5100000.50", annualTaxBurden: "12000.00", documentsValidPct: "100.00", inspectionsOnTimePct: "100.00", openAlertsHigh: 1, openAlerts: 2 });
    const empty = buildGroupRow({ property: { propertyId: "prop_b", propertyCode: null, propertyName: "Hotel Sur" }, asset: null, taxes: [], documents: [], inspections: [], alerts: [alerts[0]], today: TODAY });
    assert.deepEqual(empty, { propertyId: "prop_b", propertyCode: null, propertyName: "Hotel Sur", tenureKind: null, cadastralValueTotal: null, lastValuationValue: null, annualTaxBurden: null, documentsValidPct: null, inspectionsOnTimePct: null, openAlertsHigh: 1, openAlerts: 1 });
  });

  it("highAlertsOf: solo las altas, ordenadas por fecha, tipo e id", () => {
    const alerts: RealEstateAlert[] = [
      { kind: "TAX_OVERDUE", severity: "alta", dueAt: "2026-03-01", entityType: "property_tax_receipt", entityId: "r2", propertyId: "prop_b", message: "x" },
      { kind: "DOCUMENT_EXPIRING", severity: "media", dueAt: "2026-01-01", entityType: "real_estate_document", entityId: "d", propertyId: "prop_a", message: "y" },
      { kind: "DOCUMENT_EXPIRED", severity: "alta", dueAt: "2026-01-01", entityType: "real_estate_document", entityId: "d1", propertyId: "prop_a", message: "z" }
    ];
    assert.deepEqual(highAlertsOf(alerts).map((alert) => alert.entityId), ["d1", "r2"]);
  });

  it("selectVisibleProperties: ámbito de sociedad ve todo; asignación ve lo suyo; la oficina solo con ficha", () => {
    const rows = [{ id: "prop_a", kind: "hotel" }, { id: "prop_b", kind: "hotel" }, { id: "prop_office", kind: "office" }, { id: "prop_other", kind: "other" }];
    const withAsset = new Set(["prop_office"]);
    const owner = selectVisibleProperties({ permissions: [], assignedPropertyIds: ["prop_a"], orgScope: true }, rows, withAsset);
    assert.deepEqual(owner.map((row) => row.id), ["prop_a", "prop_b", "prop_office"], "la oficina entra por tener ficha; «other» sin ficha no");
    const entityReader = selectVisibleProperties({ permissions: ["accounting.entity.read"], assignedPropertyIds: ["prop_a"], orgScope: false }, rows, withAsset);
    assert.deepEqual(entityReader.map((row) => row.id), ["prop_a", "prop_b", "prop_office"]);
    const manager = selectVisibleProperties({ permissions: ["real_estate.read"], assignedPropertyIds: ["prop_a"], orgScope: false }, rows, withAsset);
    assert.deepEqual(manager.map((row) => row.id), ["prop_a"]);
    const nobody = selectVisibleProperties({ permissions: [], assignedPropertyIds: [], orgScope: false }, rows, withAsset);
    assert.deepEqual(nobody, []);
    const legacy = selectVisibleProperties({ permissions: [] }, rows, new Set());
    assert.deepEqual(legacy.map((row) => row.id), ["prop_a", "prop_b"], "sin lista de asignaciones se conserva la organización (como propertyWithinScope)");
  });
});
