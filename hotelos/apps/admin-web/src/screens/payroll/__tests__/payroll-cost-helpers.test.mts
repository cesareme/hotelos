import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PayrollCostImportPreview, PayrollCostReport, PayrollCostReportMetrics } from "@hotelos/shared";
import {
  PAYROLL_COST_GROUPS,
  PAYROLL_COST_GROUP_LABELS_ES,
  USALI_LABOR_DEPARTMENTS,
  USALI_LABOR_DEPARTMENT_LABELS,
  addMonths,
  buildImportMapping,
  clampCostRange,
  costBars,
  costGroupOptions,
  costMatrixRows,
  defaultCostRange,
  detectImportFormat,
  entrySummaryLabel,
  formatHeadcount,
  formatLaborPct,
  formatLaborPctCell,
  importFileLabel,
  importResultTitle,
  importSourceOf,
  importStatusBadge,
  isMonthCode,
  laborPctOf,
  monthLabel,
  monthPickerOptions,
  monthRangeLabel,
  monthSpan,
  monthsBetween,
  payrollCostErrorMessage,
  postedEntriesSummary,
  previewBlockers,
  replacedImportsSummary,
  reverseReasonError,
  salesBars,
  suggestedCentreId,
  toggleExpanded,
  usaliLaborDepartmentOptions
} from "../payroll-cost-helpers.ts";

// Pure helpers only (no React, no api-client). Every figure is SYNTHETIC: the
// real aggregate of the pilot lives outside the repository and no test carries
// names or per-person data (design §1.4).

/** Intl separates figures from «%» and «€» with a no-break space; the assertions compare on a plain one. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");

const shared = readFileSync(new URL("../../../../../../packages/shared/src/payroll-cost-types.ts", import.meta.url), "utf8");

function sharedArray(name: string): string[] {
  const block = shared.match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(block, `${name} not found in payroll-cost-types.ts`);
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function sharedRecord(name: string): Record<string, string> {
  const block = shared.match(new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\};`));
  assert.ok(block, `${name} not found in payroll-cost-types.ts`);
  return Object.fromEntries([...block[1].matchAll(/^\s*([a-z_]+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
}

// ---------------------------------------------------------------- fixtures

function metrics(over: Partial<PayrollCostReportMetrics> = {}): PayrollCostReportMetrics {
  return {
    lines: 2,
    gross: "10000.00",
    employerSs: "3000.00",
    totalCost: "13000.00",
    reportedTotalCost: null,
    headcount: "5.00",
    employeesReported: "4.00",
    headcountEffective: "4.00",
    headcountSource: "reference",
    costPerEmployee: "3250.00",
    ledgerNetSales: "40000.00",
    netSalesReported: "42000.00",
    laborPctLedger: "0.3250",
    laborPctReference: "0.3095",
    roomsInventory: 40,
    roomsInventoryReported: 40,
    roomsAvailable: 1120,
    costPerAvailableRoom: "11.61",
    byGroup: [{ costGroup: "operaciones", lines: 2, gross: "10000.00", employerSs: "3000.00", totalCost: "13000.00", reportedTotalCost: null, headcount: "5.00" }],
    byDepartment: [
      { usaliDepartment: "fnb", lines: 1, gross: "4000.00", employerSs: "1200.00", totalCost: "5200.00", reportedTotalCost: null, headcount: "2.00" },
      { usaliDepartment: "rooms", lines: 1, gross: "6000.00", employerSs: "1800.00", totalCost: "7800.00", reportedTotalCost: null, headcount: "3.00" }
    ],
    ...over
  };
}

function report(over: Partial<PayrollCostReport> = {}): PayrollCostReport {
  const months = ["2026-02", "2026-03"];
  return {
    organizationId: "org_demo",
    legalEntityId: "le_demo",
    period: { from: "2026-02", to: "2026-03" },
    months,
    propertyId: null,
    group: null,
    centres: [
      {
        propertyId: "prop_hd",
        code: "HD",
        name: "Hotel Demo",
        kind: "hotel",
        cells: [
          { ...metrics(), propertyId: "prop_hd", periodCode: "2026-02", daysInMonth: 28, importIds: ["imp_1"] },
          { ...metrics({ totalCost: "14000.00", laborPctLedger: null }), propertyId: "prop_hd", periodCode: "2026-03", daysInMonth: 31, importIds: ["imp_1"] }
        ],
        totals: metrics({ totalCost: "27000.00", headcountEffective: "4.00", costPerEmployee: "3375.00" })
      },
      {
        propertyId: "prop_oc",
        code: "OC",
        name: "Oficina central",
        kind: "office",
        cells: [{ ...metrics({ byDepartment: [{ usaliDepartment: "admin_general", lines: 1, gross: "3500.00", employerSs: "1050.00", totalCost: "4550.00", reportedTotalCost: null, headcount: "2.00" }], totalCost: "4550.00", ledgerNetSales: "0.00", laborPctLedger: null, laborPctReference: null, roomsInventory: 0, roomsAvailable: 0, costPerAvailableRoom: null }), propertyId: "prop_oc", periodCode: "2026-02", daysInMonth: 28, importIds: ["imp_1"] }],
        totals: metrics({ byDepartment: [{ usaliDepartment: "admin_general", lines: 1, gross: "3500.00", employerSs: "1050.00", totalCost: "4550.00", reportedTotalCost: null, headcount: "2.00" }], totalCost: "4550.00", laborPctLedger: null, laborPctReference: null })
      }
    ],
    byMonth: [
      { ...metrics({ totalCost: "17550.00" }), periodCode: "2026-02", salesSource: "ledger" },
      { ...metrics({ totalCost: "14000.00", ledgerNetSales: "0.00", laborPctLedger: null }), periodCode: "2026-03", salesSource: "reference" }
    ],
    totals: { ...metrics({ totalCost: "31550.00" }), headcountAverage: "6.00", costPerEmployeeAverage: "2629.17" },
    imports: [{ importId: "imp_1", fileName: "nomina-demo.json", periodFrom: "2026-02", periodTo: "2026-03", postedAt: "2026-09-16T10:00:00.000Z" }],
    generatedAt: "2026-09-16T10:00:00.000Z",
    warnings: [],
    ...over
  };
}

function preview(over: Partial<PayrollCostImportPreview> = {}): PayrollCostImportPreview {
  return {
    organizationId: "org_demo",
    format: "csv",
    contentHash: "abc",
    periodFrom: "2026-02",
    periodTo: "2026-02",
    rowCount: 3,
    rows: [],
    totals: { lines: 3, gross: "15000.00", employerSs: "4500.00", totalCost: "19500.00", reportedTotalCost: "19500.00", headcount: "9.00", headcountAverage: "9.00" },
    byCentreMonth: [],
    byGroup: [],
    byDepartment: [],
    mapping: {},
    unmappedCentres: [],
    unmappedDepartments: [],
    unmappedGroups: [],
    duplicateOf: null,
    overlaps: [],
    payrollPeriodsPosted: [],
    replacedImportIds: [],
    errors: [],
    warnings: [],
    replace: false,
    canPost: true,
    ...over
  };
}

// ---------------------------------------------------------------- vocabularies

describe("coste de personal · vocabularios espejo del contrato compartido", () => {
  it("the groups and the labor departments mirror packages/shared (order included)", () => {
    assert.deepEqual([...PAYROLL_COST_GROUPS], sharedArray("PAYROLL_COST_GROUPS"));
    assert.deepEqual([...USALI_LABOR_DEPARTMENTS], sharedArray("PAYROLL_COST_USALI_DEPARTMENTS"));
    assert.deepEqual({ ...PAYROLL_COST_GROUP_LABELS_ES }, sharedRecord("PAYROLL_COST_GROUP_LABELS_ES"));
    assert.deepEqual({ ...USALI_LABOR_DEPARTMENT_LABELS }, sharedRecord("PAYROLL_COST_USALI_DEPARTMENT_LABELS_ES"));
  });

  it("the group filter offers «Todos los grupos» plus the five groups; the department picker the seven labor departments", () => {
    const groups = costGroupOptions();
    assert.equal(groups.length, 6);
    assert.deepEqual(groups[0], { value: "", label: "Todos los grupos" });
    assert.equal(groups[4].label, "Mantenimiento y obra");
    const departments = usaliLaborDepartmentOptions();
    assert.equal(departments.length, 7);
    assert.equal(departments[0].label, "Habitaciones");
    assert.ok(!departments.some((option) => option.value === "utilities"), "utilities never admits labor");
  });

  it("status badges speak Spanish and tolerate an unknown status", () => {
    assert.deepEqual(importStatusBadge("posted"), { label: "Contabilizado", tone: "success" });
    assert.deepEqual(importStatusBadge("draft"), { label: "Borrador", tone: "warning" });
    assert.deepEqual(importStatusBadge("reversed"), { label: "Revertido", tone: "neutral" });
    assert.deepEqual(importStatusBadge("otro"), { label: "otro", tone: "neutral" });
  });
});

// ---------------------------------------------------------------- months

describe("coste de personal · meses", () => {
  it("adds, spans and lists months across a year boundary", () => {
    assert.equal(addMonths("2026-01", 7), "2026-08");
    assert.equal(addMonths("2025-12", 1), "2026-01");
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(addMonths("no-mes", 3), "no-mes");
    assert.equal(monthSpan("2026-01", "2026-08"), 8);
    assert.equal(monthSpan("2026-08", "2026-01"), 0);
    assert.deepEqual(monthsBetween("2025-11", "2026-01"), ["2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(monthsBetween("2026-03", "2026-01"), []);
    assert.ok(isMonthCode("2026-09"));
    assert.ok(!isMonthCode("2026-13"));
    assert.ok(!isMonthCode(null));
  });

  it("labels a month in Spanish and a range with an en dash", () => {
    assert.match(monthLabel("2026-01"), /ene/i);
    assert.match(monthLabel("2026-01"), /2026/);
    assert.equal(monthLabel("libre"), "libre");
    assert.match(monthRangeLabel("2026-01", "2026-08"), / – /);
    assert.equal(monthRangeLabel("2026-01", "2026-01"), monthLabel("2026-01"));
  });

  it("defaults to January of the current year → the current month, and the picker lists the last N months in order", () => {
    assert.deepEqual(defaultCostRange(new Date(Date.UTC(2026, 8, 16))), { from: "2026-01", to: "2026-09" });
    const options = monthPickerOptions(new Date(Date.UTC(2026, 8, 16)), 3);
    assert.deepEqual(
      options.map((option) => option.value),
      ["2026-07", "2026-08", "2026-09"]
    );
    const withExtra = monthPickerOptions(new Date(Date.UTC(2026, 8, 16)), 2, ["2024-01", "nope"]);
    assert.deepEqual(
      withExtra.map((option) => option.value),
      ["2024-01", "2026-08", "2026-09"]
    );
  });

  it("clamps the range: the touched picker wins, never inverted, never wider than 24 months", () => {
    assert.deepEqual(clampCostRange("2026-01", "2026-08"), { from: "2026-01", to: "2026-08" });
    assert.deepEqual(clampCostRange("2026-10", "2026-08", "from"), { from: "2026-10", to: "2026-10" });
    assert.deepEqual(clampCostRange("2026-10", "2026-08", "to"), { from: "2026-08", to: "2026-08" });
    assert.deepEqual(clampCostRange("2023-01", "2026-08", "to"), { from: "2024-09", to: "2026-08" });
    assert.deepEqual(clampCostRange("2023-01", "2026-08", "from"), { from: "2023-01", to: "2024-12" });
    assert.deepEqual(clampCostRange("x", "2026-08"), { from: "x", to: "2026-08" });
  });
});

// ---------------------------------------------------------------- figures

describe("coste de personal · formato de cifras", () => {
  it("headcount keeps up to two decimals and paints a dash for null", () => {
    assert.equal(formatHeadcount("12.50"), "12,5");
    assert.equal(formatHeadcount("16.00"), "16");
    assert.equal(formatHeadcount(null), "—");
  });

  it("labor % reads a ratio string and marks the reference source", () => {
    assert.equal(plain(formatLaborPct("0.3512")), "35,1 %");
    assert.equal(formatLaborPct(null), "—");
    assert.deepEqual(laborPctOf({ laborPctLedger: "0.30", laborPctReference: "0.31" }), { value: "0.30", source: "ledger" }, "sin salesSource (API anterior): libro si lo hay");
    assert.deepEqual(laborPctOf({ laborPctLedger: null, laborPctReference: "0.31" }), { value: "0.31", source: "reference" });
    assert.deepEqual(laborPctOf({ laborPctLedger: null, laborPctReference: null }), { value: null, source: null });
    assert.equal(plain(formatLaborPctCell({ laborPctLedger: null, laborPctReference: "0.31" })), "31 % (ref.)");
    assert.equal(formatLaborPctCell({ laborPctLedger: null, laborPctReference: null }), "—");
  });

  it("labor % follows the API's primary sales source (contable-6C-03): a tiny ledger no longer paints millions of %", () => {
    assert.deepEqual(laborPctOf({ laborPctLedger: "236452.9681", laborPctReference: "0.5634", salesSource: "reference" }), { value: "0.5634", source: "reference" });
    assert.deepEqual(laborPctOf({ laborPctLedger: "0.30", laborPctReference: "0.31", salesSource: "ledger" }), { value: "0.30", source: "ledger" });
    assert.deepEqual(laborPctOf({ laborPctLedger: null, laborPctReference: null, salesSource: null }), { value: null, source: null });
    assert.equal(plain(formatLaborPctCell({ laborPctLedger: "236452.9681", laborPctReference: "0.5634", salesSource: "reference" })), "56,3 % (ref.)");
  });
});

// ---------------------------------------------------------------- matrix

describe("coste de personal · matriz centros × meses", () => {
  it("paints four rows per centre and four for the sociedad; the first row of a centre carries its label and departments", () => {
    const rows = costMatrixRows(report(), new Set());
    assert.equal(rows.length, 2 * 4 + 4);
    assert.equal(rows[0].centreLabel, "Hotel Demo (HD)");
    assert.deepEqual(rows[0].departments, ["rooms", "fnb"]);
    assert.equal(rows[0].label, "Empleados");
    assert.equal(rows[1].centreLabel, null);
    assert.equal(rows[1].label, "Coste");
    assert.ok(rows[1].emphasis);
    assert.equal(plain(rows[1].values["2026-02"]), "13.000,00 €");
    assert.equal(plain(rows[1].values["2026-03"]), "14.000,00 €");
    assert.equal(plain(rows[1].total), "27.000,00 €");
    assert.equal(rows[3].label, "% s/ ventas");
    assert.equal(plain(rows[3].values["2026-02"]), "32,5 %");
    assert.equal(plain(rows[3].values["2026-03"]), "31 % (ref.)");
    // The office has no cell in March: a dash, never a fake zero.
    const officeCost = rows.find((row) => row.key === "prop_oc:cost");
    assert.ok(officeCost);
    assert.equal(officeCost.values["2026-03"], "—");
    const society = rows.filter((row) => row.society);
    assert.equal(society.length, 4);
    assert.equal(society[0].centreLabel, "Sociedad");
    assert.equal(society[0].total, "6");
    assert.equal(plain(society[1].total), "31.550,00 €");
    // es-ES groups thousands only from five digits (minimumGroupingDigits 2, the RAE rule lib/format keeps).
    assert.equal(plain(society[2].total), "2629,17 €");
  });

  it("expanding a centre adds one indented row per USALI department present, with its cost per month", () => {
    const rows = costMatrixRows(report(), new Set(["prop_hd"]));
    assert.equal(rows.length, 2 * 4 + 2 + 4);
    const departments = rows.filter((row) => row.metric === "department");
    assert.deepEqual(
      departments.map((row) => row.label),
      ["· Habitaciones", "· Alimentos y bebidas"]
    );
    assert.ok(departments.every((row) => row.indent && row.propertyId === "prop_hd"));
    assert.equal(plain(departments[0].values["2026-02"]), "7800,00 €");
    assert.equal(plain(departments[1].total), "5200,00 €");
  });

  it("names the footer «Total del centro» when the report is filtered by centre", () => {
    const rows = costMatrixRows(report({ propertyId: "prop_hd" }), new Set());
    assert.equal(rows.find((row) => row.society)?.centreLabel, "Total del centro");
  });

  it("toggles a centre into a NEW set (React state)", () => {
    const initial = new Set<string>();
    const opened = toggleExpanded(initial, "prop_hd");
    assert.notEqual(opened, initial);
    assert.ok(opened.has("prop_hd"));
    assert.ok(!toggleExpanded(opened, "prop_hd").has("prop_hd"));
  });
});

// ---------------------------------------------------------------- charts

describe("coste de personal · gráficos", () => {
  it("cost bars: one per month with the total and a hint with gross and employer SS; no false «0 empleados» without headcount (FU-08)", () => {
    const bars = costBars(report());
    assert.equal(bars.length, 2);
    assert.equal(bars[0].value, 17550);
    assert.match(bars[0].hint ?? "", /bruto/);
    assert.match(bars[0].hint ?? "", /Seguridad Social/);
    assert.match(bars[0].hint ?? "", /empleados/);
    const none = costBars({ byMonth: [{ ...metrics({ headcountEffective: null, headcountSource: null }), periodCode: "2026-04", salesSource: null }] });
    assert.match(none[0].hint ?? "", /sin dato de empleados/);
    assert.doesNotMatch(none[0].hint ?? "", /0 empleados/);
  });

  it("sales bars: the ledger when it has sales, the reference otherwise, and the source in the hint", () => {
    const bars = salesBars(report());
    assert.equal(bars[0].value, 40000);
    assert.match(bars[0].hint ?? "", /ventas del libro/);
    assert.equal(bars[1].value, 42000);
    assert.match(bars[1].hint ?? "", /referencia/);
    const none = salesBars({ byMonth: [{ ...metrics({ ledgerNetSales: "0.00", netSalesReported: null, laborPctLedger: null, laborPctReference: null }), periodCode: "2026-04", salesSource: null }] });
    assert.equal(none[0].value, 0);
    assert.match(none[0].hint ?? "", /sin ventas/);
  });
});

// ---------------------------------------------------------------- drawer plumbing

describe("coste de personal · cajón de importación", () => {
  it("detects the format by extension, then by the first character (BOM tolerated)", () => {
    assert.equal(detectImportFormat("nomina.json", "centro;mes"), "json");
    assert.equal(detectImportFormat("nomina.CSV", "{}"), "csv");
    assert.equal(detectImportFormat(null, '  {"rows":[]}'), "json");
    assert.equal(detectImportFormat(null, "\uFEFFcentro;mes;grupo"), "csv");
    assert.equal(importSourceOf("json", '{"fuente":"Informe RRHH","lineas":[]}'), "informe_rrhh");
    assert.equal(importSourceOf("json", '{"rows":[]}'), "json");
    assert.equal(importSourceOf("csv", "centro;mes"), "csv");
  });

  it("builds the mapping body from the resolved labels only", () => {
    assert.deepEqual(buildImportMapping({ "HOTEL DEMO": "prop_hd", "OFICINA": "" }, { "5 COCINA": "fnb" }), { centres: { "HOTEL DEMO": "prop_hd" }, departments: { "5 COCINA": "fnb" } });
    assert.equal(buildImportMapping({ X: "" }, {}), undefined);
    assert.equal(suggestedCentreId({ label: "HOTEL DEMO", rows: 3, suggestions: [{ propertyId: "prop_hd", code: "HD", name: "Hotel Demo", kind: "hotel" }] }), "prop_hd");
    assert.equal(suggestedCentreId({ label: "OTRO", rows: 1, suggestions: [] }), "");
  });

  it("explains why «Contabilizar» is disabled, and lets `replace` lift the duplicate / overlap blockers", () => {
    assert.deepEqual(previewBlockers(null), ["Previsualiza el fichero antes de contabilizar."]);
    assert.deepEqual(previewBlockers(preview()), []);
    const blocked = previewBlockers(
      preview({
        canPost: false,
        errors: [{ line: 4, message: "importe negativo" }],
        unmappedCentres: [{ label: "OFICINA MADRID", rows: 2, suggestions: [] }],
        duplicateOf: { importId: "imp_0", status: "posted", fileName: "nomina.json", postedAt: null, periodFrom: "2026-02", periodTo: "2026-02" },
        overlaps: [{ importId: "imp_0", fileName: "nomina.json", periodFrom: "2026-02", periodTo: "2026-02", propertyId: "prop_hd", periodCode: "2026-02" }]
      })
    );
    assert.deepEqual(blocked, ["1 fila con error", "1 centro sin asignar", "el mismo informe ya está importado", "1 centro y mes ya contabilizado"]);
    const replaced = previewBlockers(preview({ replace: true, duplicateOf: { importId: "imp_0", status: "posted", fileName: null, postedAt: null, periodFrom: "2026-02", periodTo: "2026-02" } }));
    assert.deepEqual(replaced, []);
    assert.deepEqual(previewBlockers(preview({ rowCount: 0, canPost: false })), ["el fichero no tiene líneas de coste"]);
  });

  it("lists the lots `replace` would reverse ENTIRELY, once each, with their range", () => {
    const summary = replacedImportsSummary({
      duplicateOf: { importId: "imp_0", status: "posted", fileName: "nomina.json", postedAt: null, periodFrom: "2026-01", periodTo: "2026-08" },
      overlaps: [
        { importId: "imp_0", fileName: "nomina.json", periodFrom: "2026-01", periodTo: "2026-08", propertyId: "prop_hd", periodCode: "2026-02" },
        { importId: "imp_2", fileName: null, periodFrom: "2026-03", periodTo: "2026-03", propertyId: "prop_hd", periodCode: "2026-03" }
      ]
    });
    assert.equal(summary.length, 2);
    assert.match(summary[0], /^nomina\.json \(/);
    assert.match(summary[1], /^imp_2 \(/);
  });

  it("summarises the posted entries («nº X–Y, ejercicio Z») and labels one entry", () => {
    const entries = [
      { entryNumber: 62, fiscalYearCode: "2026" },
      { entryNumber: 64, fiscalYearCode: "2026" },
      { entryNumber: 63, fiscalYearCode: "2026" }
    ];
    assert.equal(postedEntriesSummary(entries), "3 asientos contabilizados (nº 62–64, ejercicio 2026)");
    assert.equal(postedEntriesSummary([{ entryNumber: 7, fiscalYearCode: null }]), "1 asiento contabilizado (nº 7)");
    assert.equal(postedEntriesSummary([]), "0 asientos contabilizados");
    assert.equal(importResultTitle({ entries, replacedImportIds: ["imp_0"] }), "3 asientos contabilizados (nº 62–64, ejercicio 2026) · 1 lote anterior revertido");
    const label = plain(entrySummaryLabel({ fiscalYearCode: "2026", entryNumber: 62, propertyCode: "HD", propertyId: "prop_hd", periodCode: "2026-01", totalDebit: "45123.00" }));
    assert.match(label, /^2026\/62 · HD · /);
    assert.match(label, /45\.123,00 €$/);
    assert.match(plain(entrySummaryLabel({ fiscalYearCode: null, entryNumber: null, propertyCode: null, propertyId: "prop_x", periodCode: "2026-01", totalDebit: "1.00" })), /^sin número · prop_x · /);
  });

  it("names a lot by its file, else by its documentary source, and validates the reversal reason", () => {
    assert.equal(importFileLabel({ fileName: " nomina.json ", source: "json" }), "nomina.json");
    assert.equal(importFileLabel({ fileName: null, source: "informe_rrhh" }), "Informe de RRHH");
    assert.ok(reverseReasonError("ab"));
    assert.equal(reverseReasonError("  informe corregido "), undefined);
    assert.ok(reverseReasonError("x".repeat(501)));
  });
});

// ---------------------------------------------------------------- errors

describe("coste de personal · mensajes de error", () => {
  it("appends the datum each code carries (labels, parse lines, lot, overlapping cells)", () => {
    assert.match(payrollCostErrorMessage({ status: 400, details: { code: "PAYROLL_IMPORT_CENTRE_UNMAPPED", labels: ["OFICINA MADRID", "REG. CORUÑA"], rows: 5 } }), /sin equivalencia en el ERP.*Etiquetas: OFICINA MADRID, REG\. CORUÑA\.$/);
    assert.match(payrollCostErrorMessage({ status: 400, details: { code: "PAYROLL_IMPORT_INVALID", errors: [{ line: 4, message: "importe negativo" }, { line: 9, message: "mes inválido" }, { line: 10, message: "a" }, { line: 11, message: "b" }] } }), /línea 4: importe negativo · línea 9: mes inválido · línea 10: a \(y 1 más\)\.$/);
    assert.match(payrollCostErrorMessage({ status: 409, details: { code: "PAYROLL_IMPORT_DUPLICATE", importId: "imp_0", fileName: "nomina.json", status: "posted" } }), /Lote: nomina\.json\.$/);
    assert.match(payrollCostErrorMessage({ status: 409, details: { code: "PAYROLL_IMPORT_DUPLICATE", importId: "imp_0", fileName: null } }), /Lote: imp_0\.$/);
    assert.match(payrollCostErrorMessage({ status: 409, details: { code: "PAYROLL_IMPORT_OVERLAP", overlaps: [{}, {}, {}] } }), /3 celdas afectadas\.$/);
  });

  it("falls back to the API message, then to the Spanish default", () => {
    assert.equal(payrollCostErrorMessage({ message: "texto del API", status: 500 }), "texto del API");
    assert.equal(payrollCostErrorMessage(null), "No se pudo completar la importación del coste de personal.");
    assert.equal(payrollCostErrorMessage(undefined, "Otro texto."), "Otro texto.");
  });
});
