// Unit tests · Tanda 6c · L1 — agregador puro del informe de coste de personal
// (centros × meses). Sin base de datos; cifras sintéticas. Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/cost-report.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../../../lib/http-error.js";
import { Prisma } from "@prisma/client";
import { aggregatePayrollCostReport, monthsBetween, salesSourceOf, type PayrollCostReportLineInput } from "../cost-report.service.js";

const CENTRES = [
  { propertyId: "prop_hd", code: "HD", name: "Hotel Demo", kind: "hotel" as const },
  { propertyId: "prop_oc", code: "OC", name: "Oficina central", kind: "office" as const }
];

function line(partial: Partial<PayrollCostReportLineInput> & { propertyId: string; periodCode: string; gross: string; employerSs: string; headcount: string }): PayrollCostReportLineInput {
  const total = (Number(partial.gross) + Number(partial.employerSs)).toFixed(2);
  return { importId: "imp_1", costGroup: "operaciones", usaliDepartment: "rooms", totalCost: total, reportedTotalCost: null, ...partial };
}

const LINES: PayrollCostReportLineInput[] = [
  line({ propertyId: "prop_hd", periodCode: "2026-01", costGroup: "operaciones", usaliDepartment: "rooms", gross: "10000.00", employerSs: "3000.00", headcount: "7.00" }),
  line({ propertyId: "prop_hd", periodCode: "2026-01", costGroup: "extras", usaliDepartment: "fnb", gross: "5000.00", employerSs: "1500.00", headcount: "5.00" }),
  line({ propertyId: "prop_hd", periodCode: "2026-02", costGroup: "operaciones", usaliDepartment: "rooms", gross: "8000.00", employerSs: "2000.00", headcount: "6.00", importId: "imp_2" }),
  line({ propertyId: "prop_oc", periodCode: "2026-01", costGroup: "estructura", usaliDepartment: "admin_general", gross: "3500.00", employerSs: "1050.00", headcount: "2.00" })
];

const REFERENCES = [
  { propertyId: "prop_hd", periodCode: "2026-01", employeesReported: "9.00", roomsAvailableReported: 40, netSalesReported: "42000.00", postedAt: "2026-09-01T00:00:00Z" },
  { propertyId: "prop_hd", periodCode: "2026-01", employeesReported: "99.00", roomsAvailableReported: 99, netSalesReported: "1.00", postedAt: "2026-08-01T00:00:00Z" },
  { propertyId: "prop_oc", periodCode: "2026-01", employeesReported: null, roomsAvailableReported: null, netSalesReported: null, postedAt: "2026-09-01T00:00:00Z" }
];

const LEDGER_SALES = [
  { propertyId: "prop_hd", periodCode: "2026-01", netSales: "50000.00" },
  { propertyId: "prop_hd", periodCode: "2026-02", netSales: "20000.00" }
];

function build(overrides: Partial<Parameters<typeof aggregatePayrollCostReport>[0]> = {}) {
  return aggregatePayrollCostReport({ lines: LINES, references: REFERENCES, ledgerSales: LEDGER_SALES, roomsInventory: { prop_hd: 45 }, months: ["2026-01", "2026-02", "2026-03"], centres: CENTRES, organizationId: "org_demo", legalEntityId: "le_demo", generatedAt: "2026-09-16T00:00:00.000Z", ...overrides });
}

describe("monthsBetween", () => {
  it("enumera meses inclusivos y valida forma, orden y tope de 24", () => {
    assert.deepEqual(monthsBetween("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
    assert.deepEqual(monthsBetween("2026-01", "2026-01"), ["2026-01"]);
    const isValidation = (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error.details as { code: string }).code === "VALIDATION_ERROR";
    assert.throws(() => monthsBetween("2026-1", "2026-02"), isValidation);
    assert.throws(() => monthsBetween("2026-03", "2026-02"), isValidation);
    assert.throws(() => monthsBetween("2026-01", "2028-02"), isValidation);
    assert.deepEqual(monthsBetween("2026-01", "2027-12").length, 24);
  });
});

describe("aggregatePayrollCostReport · celdas", () => {
  it("coste por empleado usa employeesReported (la referencia más reciente); sin referencia usa Σ headcount de las filas", () => {
    const report = build();
    const hd = report.centres.find((c) => c.propertyId === "prop_hd")!;
    const jan = hd.cells[0]!;
    assert.equal(jan.periodCode, "2026-01");
    assert.equal(jan.daysInMonth, 31);
    assert.equal(jan.lines, 2);
    assert.equal(jan.gross, "15000.00");
    assert.equal(jan.employerSs, "4500.00");
    assert.equal(jan.totalCost, "19500.00");
    assert.equal(jan.headcount, "12.00", "Σ de las filas (sobrecuenta)");
    assert.equal(jan.employeesReported, "9.00", "gana la referencia con postedAt más reciente");
    assert.equal(jan.headcountEffective, "9.00");
    assert.equal(jan.headcountSource, "reference");
    assert.equal(jan.costPerEmployee, "2166.67", "19.500 / 9");
    assert.deepEqual(jan.importIds, ["imp_1"]);
    const feb = hd.cells[1]!;
    assert.equal(feb.headcountEffective, "6.00");
    assert.equal(feb.headcountSource, "lines");
    assert.equal(feb.costPerEmployee, "1666.67", "10.000 / 6");
    assert.deepEqual(feb.importIds, ["imp_2"]);
  });

  it("% s/ ventas: libro (grupo 70) y referencia por separado; null con denominador 0", () => {
    const hd = build().centres[0]!;
    const jan = hd.cells[0]!;
    assert.equal(jan.ledgerNetSales, "50000.00");
    assert.equal(jan.netSalesReported, "42000.00");
    assert.equal(jan.laborPctLedger, "39.00", "100 × 19.500 / 50.000");
    assert.equal(jan.laborPctReference, "46.43", "100 × 19.500 / 42.000");
    const feb = hd.cells[1]!;
    assert.equal(feb.laborPctLedger, "50.00");
    assert.equal(feb.laborPctReference, null, "sin referencia en febrero");
    const mar = hd.cells[2]!;
    assert.equal(mar.totalCost, "0.00");
    assert.equal(mar.ledgerNetSales, "0.00");
    assert.equal(mar.laborPctLedger, null);
    assert.equal(mar.costPerEmployee, null);
    assert.equal(mar.headcountEffective, null);
    assert.equal(mar.headcountSource, null);
    assert.deepEqual(mar.importIds, []);
  });

  it("habitaciones disponibles = inventario (referencia si viene, si no el ERP) × días; oficina → 0 y null", () => {
    const report = build();
    const hd = report.centres[0]!;
    assert.equal(hd.cells[0]?.roomsInventory, 45);
    assert.equal(hd.cells[0]?.roomsInventoryReported, 40);
    assert.equal(hd.cells[0]?.roomsAvailable, 40 * 31, "la referencia manda");
    assert.equal(hd.cells[0]?.costPerAvailableRoom, "15.73", "19.500 / 1.240");
    assert.equal(hd.cells[1]?.roomsInventoryReported, null);
    assert.equal(hd.cells[1]?.roomsAvailable, 45 * 28, "inventario del ERP × 28 días");
    assert.equal(hd.cells[1]?.costPerAvailableRoom, "7.94", "10.000 / 1.260");
    const oc = report.centres[1]!;
    assert.equal(oc.cells[0]?.roomsInventory, 0);
    assert.equal(oc.cells[0]?.roomsAvailable, 0);
    assert.equal(oc.cells[0]?.costPerAvailableRoom, null);
    assert.equal(oc.cells[0]?.totalCost, "4550.00");
    assert.equal(oc.cells[0]?.headcountSource, "lines", "referencia sin empleados → filas");
  });

  it("byGroup / byDepartment por celda, centro y sociedad", () => {
    const report = build();
    const jan = report.centres[0]!.cells[0]!;
    assert.deepEqual(jan.byGroup.map((g) => [g.costGroup, g.totalCost, g.headcount]), [["extras", "6500.00", "5.00"], ["operaciones", "13000.00", "7.00"]]);
    assert.deepEqual(jan.byDepartment.map((d) => [d.usaliDepartment, d.gross, d.employerSs]), [["fnb", "5000.00", "1500.00"], ["rooms", "10000.00", "3000.00"]]);
    assert.deepEqual(report.centres[0]!.totals.byDepartment.map((d) => [d.usaliDepartment, d.totalCost]), [["fnb", "6500.00"], ["rooms", "23000.00"]]);
    assert.deepEqual(report.totals.byGroup.map((g) => [g.costGroup, g.totalCost]), [["estructura", "4550.00"], ["extras", "6500.00"], ["operaciones", "23000.00"]]);
    assert.deepEqual(report.totals.byDepartment.map((d) => d.usaliDepartment), ["admin_general", "fnb", "rooms"]);
  });
});

describe("aggregatePayrollCostReport · agregados", () => {
  it("totales por centro: importes Σ, headcount = media de los meses con dato, ventas Σ", () => {
    const hd = build().centres[0]!;
    assert.equal(hd.totals.totalCost, "29500.00");
    assert.equal(hd.totals.lines, 3);
    assert.equal(hd.totals.headcountEffective, "7.50", "(9 + 6) / 2 meses con dato");
    assert.equal(hd.totals.headcountSource, "reference");
    assert.equal(hd.totals.costPerEmployee, "3933.33", "29.500 / 7,5");
    assert.equal(hd.totals.ledgerNetSales, "70000.00");
    assert.equal(hd.totals.laborPctLedger, "42.14");
    assert.equal(hd.totals.netSalesReported, "42000.00");
    assert.equal(hd.totals.roomsAvailable, 40 * 31 + 45 * 28 + 45 * 31);
    assert.equal(hd.totals.employeesReported, "9.00");
  });

  it("byMonth suma centros; salesSource = libro si > 0, si no referencia, si no null", () => {
    const report = build();
    assert.deepEqual(report.byMonth.map((m) => m.periodCode), ["2026-01", "2026-02", "2026-03"]);
    const jan = report.byMonth[0]!;
    assert.equal(jan.totalCost, "24050.00");
    assert.equal(jan.headcountEffective, "11.00", "9 (referencia HD) + 2 (filas OC)");
    assert.equal(jan.headcountSource, "reference");
    assert.equal(jan.ledgerNetSales, "50000.00");
    assert.equal(jan.salesSource, "ledger");
    assert.equal(jan.laborPctLedger, "48.10");
    assert.equal(report.byMonth[1]?.salesSource, "ledger");
    assert.equal(report.byMonth[2]?.salesSource, null);
    const referenceOnly = build({ ledgerSales: [] });
    assert.equal(referenceOnly.byMonth[0]?.salesSource, "reference");
    assert.equal(referenceOnly.byMonth[0]?.laborPctLedger, null);
    assert.equal(referenceOnly.byMonth[1]?.salesSource, null);
  });

  it("salesSource por cobertura del libro (contable-6C-03): el libro solo manda cuando alcanza el 90 % de la referencia; celdas, centros y sociedad lo llevan", () => {
    const D = (v: string) => new Prisma.Decimal(v);
    assert.equal(salesSourceOf(D("0"), null), null);
    assert.equal(salesSourceOf(D("0"), D("42000")), "reference");
    assert.equal(salesSourceOf(D("100"), null), "ledger", "sin referencia el libro manda aunque sea pequeño");
    assert.equal(salesSourceOf(D("37800"), D("42000")), "ledger", "90 % justos");
    assert.equal(salesSourceOf(D("37799.99"), D("42000")), "reference");
    assert.equal(salesSourceOf(D("10.33"), D("837898.72")), "reference", "el caso de Faranda: 10,33 € en el libro frente a 837.898,72 de referencia");
    // Fixture: enero libro 50.000 ≥ 0,9 × 42.000 → ledger; con el libro a 10,33 → reference y el % útil es el de referencia.
    const report = build();
    assert.equal(report.centres[0]!.cells[0]!.salesSource, "ledger");
    assert.equal(report.centres[0]!.totals.salesSource, "ledger");
    assert.equal(report.totals.salesSource, "ledger");
    const tiny = build({ ledgerSales: [{ propertyId: "prop_hd", periodCode: "2026-01", netSales: "10.33" }] });
    const jan = tiny.centres[0]!.cells[0]!;
    assert.equal(jan.ledgerNetSales, "10.33");
    assert.equal(jan.laborPctLedger, "188770.57", "se sigue calculando (100 × 19.500 / 10,33)");
    assert.equal(jan.salesSource, "reference", "pero la fuente principal es la referencia");
    assert.equal(jan.laborPctReference, "46.43");
    assert.equal(tiny.byMonth[0]?.salesSource, "reference");
    assert.equal(tiny.centres[0]!.totals.salesSource, "reference");
    assert.equal(tiny.totals.salesSource, "reference");
    assert.equal(tiny.byMonth[2]?.salesSource, null, "sin ventas de ninguna fuente");
  });

  it("totales de sociedad: headcountAverage y costPerEmployeeAverage sobre los meses con dato", () => {
    const report = build();
    assert.equal(report.organizationId, "org_demo");
    assert.equal(report.legalEntityId, "le_demo");
    assert.deepEqual(report.period, { from: "2026-01", to: "2026-03" });
    assert.equal(report.propertyId, null);
    assert.equal(report.group, null);
    assert.equal(report.totals.totalCost, "34050.00");
    assert.equal(report.totals.headcountAverage, "8.50", "(11 + 6) / 2");
    assert.equal(report.totals.headcountEffective, "8.50");
    assert.equal(report.totals.costPerEmployeeAverage, "4005.88", "34.050 / 8,5");
    assert.equal(report.totals.costPerEmployee, "4005.88");
    assert.equal(report.totals.ledgerNetSales, "70000.00");
    assert.equal(report.totals.laborPctLedger, "48.64");
    assert.equal(report.generatedAt, "2026-09-16T00:00:00.000Z");
    assert.deepEqual(report.imports, []);
    assert.deepEqual(report.warnings, []);
  });

  it("el filtro de grupo recorta las líneas de coste pero NO las ventas ni la referencia; el headcount pasa a las filas del grupo", () => {
    const report = build({ group: "extras" });
    assert.equal(report.group, "extras");
    const jan = report.centres[0]!.cells[0]!;
    assert.equal(jan.totalCost, "6500.00");
    assert.equal(jan.lines, 1);
    assert.equal(jan.ledgerNetSales, "50000.00", "las ventas del libro no se filtran");
    assert.equal(jan.netSalesReported, "42000.00", "la referencia no se filtra");
    assert.equal(jan.laborPctLedger, "13.00");
    assert.equal(jan.employeesReported, "9.00");
    assert.equal(jan.headcountEffective, "5.00", "con grupo, el headcount son los empleados del grupo");
    assert.equal(jan.headcountSource, "lines");
    assert.equal(jan.costPerEmployee, "1300.00");
    assert.equal(report.centres[1]!.cells[0]?.totalCost, "0.00", "la oficina no tiene extras");
    assert.equal(report.totals.totalCost, "6500.00");
    assert.equal(report.totals.headcountAverage, "5.00");
  });

  it("líneas y referencias fuera del rango o de los centros presentados se ignoran; sin centros → informe vacío", () => {
    const report = build({ lines: [...LINES, line({ propertyId: "prop_zz", periodCode: "2026-01", gross: "1", employerSs: "1", headcount: "1" }), line({ propertyId: "prop_hd", periodCode: "2025-12", gross: "1", employerSs: "1", headcount: "1" })] });
    assert.equal(report.totals.totalCost, "34050.00");
    const empty = build({ centres: [] });
    assert.deepEqual(empty.centres, []);
    assert.equal(empty.totals.totalCost, "0.00");
    assert.equal(empty.totals.headcountAverage, null);
    assert.equal(empty.totals.costPerEmployeeAverage, null);
    assert.equal(empty.byMonth.length, 3);
  });
});
