// Unit tests · Tanda RRHH · PANEL-A — agregador puro del panel de costes de
// personal de dirección (payroll/labor-cost-panel.service.ts) y helpers puros
// del lector (labor-cost-panel.source.ts). Sin base de datos; cifras sintéticas;
// centros y personas inventados. Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/labor-cost-panel.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import type { LaborCostPanelDto } from "@hotelos/shared";
import {
  LABOR_PANEL_DEGRADED_CODES,
  aggregateLaborCostPanel,
  departmentOfCostCentre,
  departmentRevenueOf,
  previousMonthsOf,
  type AggregateLaborCostPanelInput,
  type LaborCostPanelCentreInput
} from "../labor-cost-panel.service.js";
import { monthRangeBounds, type LaborImportLine, type LaborImportReference, type LaborLedgerRow } from "../labor-cost-panel.source.js";

const D = (value: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(value);

const HOTEL: LaborCostPanelCentreInput = { propertyId: "prop_lp_hotel", code: "HD", name: "Hotel Demo", kind: "hotel", legalEntityId: "le_lp" };
const OFFICE: LaborCostPanelCentreInput = { propertyId: "prop_lp_office", code: "OC", name: "Oficina central", kind: "office", legalEntityId: "le_lp" };
const CENTRES = [HOTEL, OFFICE];
const MONTHS = ["2026-05", "2026-06", "2026-07"];
const ROOMS_CC = { type: "usali", code: "ROOMS" };
const FNB_CC = { type: "usali", code: "FNB" };

function ledger(partial: Partial<LaborLedgerRow> & { propertyId: string; periodCode: string; accountCode: string; debit?: Prisma.Decimal.Value; credit?: Prisma.Decimal.Value }): LaborLedgerRow {
  const kind = partial.accountCode.startsWith("7") ? "income" : "expense";
  return {
    accountName: `Cuenta ${partial.accountCode}`,
    accountKind: kind,
    isPostable: true,
    usaliDepartment: null,
    usaliLine: null,
    costCentre: null,
    fromPayrollImport: false,
    entries: 1,
    ...partial,
    debit: D(partial.debit ?? 0),
    credit: D(partial.credit ?? 0)
  };
}

function importLine(partial: Partial<LaborImportLine> & { propertyId: string; periodCode: string; usaliDepartment: string; totalCost: Prisma.Decimal.Value; headcount: Prisma.Decimal.Value }): LaborImportLine {
  const total = D(partial.totalCost);
  return {
    importId: "imp_lp_1",
    costGroup: "operaciones",
    gross: total.times("0.75"),
    employerSs: total.times("0.25"),
    ...partial,
    totalCost: total,
    headcount: D(partial.headcount)
  };
}

function reference(partial: Partial<LaborImportReference> & { propertyId: string; periodCode: string }): LaborImportReference {
  return { employeesReported: null, roomsAvailableReported: null, netSalesReported: null, postedAt: new Date("2026-09-01T00:00:00Z"), ...partial };
}

/**
 * Escenario base (hotel + oficina, mayo-julio 2026):
 *   · mayo: diario 64x SIN centro (640 30.000 + 642 9.000 = 39.000) y 641 con abono; 70x 100.000;
 *     RN 1.000 reales;
 *   · junio: solo lote contabilizado (rooms 20.000 · 10 personas, fnb 12.000 · 6) + referencia
 *     (22 empleados, ventas 80.000); el asiento del propio lote está en el diario marcado
 *     `fromPayrollImport` (no cuenta); 70x del diario 60.000 (< 90 % de la referencia);
 *   · julio: nada (ni diario ni lote) → sin datos;
 *   · oficina: mayo 64x sin centro 50.000, sin ventas ni RN; junio y julio nada.
 */
function baseInput(overrides: Partial<AggregateLaborCostPanelInput> = {}): AggregateLaborCostPanelInput {
  return {
    from: MONTHS[0]!,
    to: MONTHS[MONTHS.length - 1]!,
    months: MONTHS,
    previousMonths: previousMonthsOf(MONTHS),
    scope: "entity",
    legalEntityId: "le_lp",
    centres: CENTRES,
    ledgerRows: [
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "640", debit: "30000.00" }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "642", debit: "9000.00" }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "641", debit: "100.00", credit: "100.00" }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "705.1", credit: "100000.00" }),
      // Junio: el asiento del lote (640 con centro ROOMS) está en el diario pero es del lote → no se cuenta por el diario.
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-06", accountCode: "640", debit: "24000.00", costCentre: ROOMS_CC, fromPayrollImport: true }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-06", accountCode: "705.1", credit: "60000.00" }),
      ledger({ propertyId: OFFICE.propertyId, periodCode: "2026-05", accountCode: "640", debit: "50000.00" }),
      // Ventana anterior (feb-abr): coste del hotel para deltaPrevious.
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-04", accountCode: "640", debit: "20000.00" }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-03", accountCode: "640", debit: "20000.00" })
    ],
    importLines: [
      importLine({ propertyId: HOTEL.propertyId, periodCode: "2026-06", usaliDepartment: "rooms", totalCost: "20000.00", headcount: "10.00" }),
      importLine({ propertyId: HOTEL.propertyId, periodCode: "2026-06", usaliDepartment: "fnb", totalCost: "12000.00", headcount: "6.00" })
    ],
    references: [reference({ propertyId: HOTEL.propertyId, periodCode: "2026-06", employeesReported: D("22.00"), netSalesReported: D("80000.00") })],
    imports: [
      { importId: "imp_lp_1", fileName: "nomina-2026-06.json", periodFrom: "2026-06", periodTo: "2026-06", postedAt: "2026-09-01T00:00:00.000Z" },
      { importId: "imp_lp_other", fileName: null, periodFrom: "2025-01", periodTo: "2025-01", postedAt: null }
    ],
    roomNights: [
      { propertyId: HOTEL.propertyId, periodCode: "2026-05", roomNights: 1000, partial: false, source: "night_audit" },
      { propertyId: HOTEL.propertyId, periodCode: "2026-06", roomNights: null, partial: false, source: "degraded" },
      { propertyId: HOTEL.propertyId, periodCode: "2026-07", roomNights: null, partial: false, source: "degraded" },
      { propertyId: OFFICE.propertyId, periodCode: "2026-05", roomNights: null, partial: false, source: "degraded" }
    ],
    departmentRevenue: [
      { propertyId: HOTEL.propertyId, periodCode: "2026-06", usaliDepartment: "rooms", revenue: "50000.00" },
      { propertyId: HOTEL.propertyId, periodCode: "2026-06", usaliDepartment: "fnb", revenue: "10000.00" }
    ],
    ledgerEntries: 7,
    generatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides
  };
}

const hotelOf = (panel: LaborCostPanelDto) => panel.centres.find((centre) => centre.propertyId === HOTEL.propertyId)!;
const officeOf = (panel: LaborCostPanelDto) => panel.centres.find((centre) => centre.propertyId === OFFICE.propertyId)!;
const monthOf = (panel: LaborCostPanelDto, centre: LaborCostPanelCentreInput, periodCode: string) => panel.centres.find((c) => c.propertyId === centre.propertyId)!.months.find((m) => m.periodCode === periodCode)!;
const codesOf = (panel: LaborCostPanelDto, code: string, propertyId?: string) => panel.degraded.filter((entry) => entry.code === code && (propertyId === undefined || entry.propertyId === propertyId));

describe("PANEL-A · helpers puros", () => {
  it("previousMonthsOf devuelve la ventana anterior de la misma longitud, cruzando el año", () => {
    assert.deepEqual(previousMonthsOf(["2026-05", "2026-06", "2026-07"]), ["2026-02", "2026-03", "2026-04"]);
    assert.deepEqual(previousMonthsOf(["2026-01", "2026-02"]), ["2025-11", "2025-12"]);
    assert.deepEqual(previousMonthsOf([]), []);
  });

  it("monthRangeBounds cubre del día 1 del primer mes al último día del último (bisiesto incluido)", () => {
    assert.deepEqual(monthRangeBounds(["2026-01", "2026-02"]), { from: "2026-01-01", to: "2026-02-28" });
    assert.deepEqual(monthRangeBounds(["2028-02"]), { from: "2028-02-01", to: "2028-02-29" });
    assert.equal(monthRangeBounds([]), null);
  });

  it("departmentOfCostCentre: centro usali con código de departamento → departamento; sin centro → sin desglose; otro tipo o código → sin desglose y unmapped", () => {
    assert.deepEqual(departmentOfCostCentre({ type: "usali", code: "ROOMS" }), { department: "rooms", unmapped: false });
    assert.deepEqual(departmentOfCostCentre({ type: "usali", code: "admin_general" }), { department: "admin_general", unmapped: false });
    assert.deepEqual(departmentOfCostCentre(null), { department: "sin_desglose", unmapped: false });
    assert.deepEqual(departmentOfCostCentre({ type: "operating", code: "ROOMS" }), { department: "sin_desglose", unmapped: true });
    assert.deepEqual(departmentOfCostCentre({ type: "usali", code: "UTILITIES" }), { department: "sin_desglose", unmapped: true });
  });
});

describe("PANEL-A · aggregateLaborCostPanel (puro)", () => {
  it("mayo: 64x del diario sin centro → una sola fila «sin_desglose», source ledger, noBreakdown, 641 con abono neteado", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const may = monthOf(panel, HOTEL, "2026-05");
    assert.equal(may.laborCost, "39000.00");
    assert.equal(may.source, "ledger");
    assert.equal(may.overlap, false);
    assert.equal(may.noBreakdown, true);
    assert.deepEqual(may.departments.map((d) => [d.usaliDepartment, d.label, d.laborCost, d.revenue, d.source]), [["sin_desglose", "Sin desglose", "39000.00", null, "ledger"]]);
    // % del departamento sin desglose sobre las ventas del mes.
    assert.equal(may.departments[0]!.pctOfSales, "39.00");
  });

  it("junio: sin 64x propio en el diario → líneas del lote por departamento (source import); el asiento del lote en el diario NO se suma (cero doble cómputo)", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const june = monthOf(panel, HOTEL, "2026-06");
    assert.equal(june.source, "import");
    assert.equal(june.laborCost, "32000.00", "20.000 + 12.000 del lote, no 24.000 más del asiento del lote");
    assert.equal(june.overlap, false);
    assert.equal(june.noBreakdown, false);
    assert.deepEqual(
      june.departments.map((d) => [d.usaliDepartment, d.laborCost, d.headcount, d.costPerEmployee, d.revenue, d.pctOfSales]),
      [
        ["rooms", "20000.00", "10.00", "2000.00", "50000.00", "40.00"],
        ["fnb", "12000.00", "6.00", "2000.00", "10000.00", "120.00"]
      ]
    );
    assert.equal(codesOf(panel, LABOR_PANEL_DEGRADED_CODES.overlap).length, 0);
  });

  it("solapamiento: diario 64x y lote el mismo mes → prevalece el diario, overlap true, el lote solo aporta headcount y referencia; degraded LABOR_PANEL_OVERLAP", () => {
    const input = baseInput();
    const panel = aggregateLaborCostPanel({
      ...input,
      ledgerRows: [...input.ledgerRows, ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-06", accountCode: "640", debit: "31000.00", costCentre: ROOMS_CC }), ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-06", accountCode: "642", debit: "9000.00" })]
    });
    const june = monthOf(panel, HOTEL, "2026-06");
    assert.equal(june.source, "ledger");
    assert.equal(june.overlap, true);
    assert.equal(june.laborCost, "40000.00", "solo el diario: nunca diario + lote");
    assert.deepEqual(
      june.departments.map((d) => [d.usaliDepartment, d.laborCost, d.headcount]),
      [
        ["rooms", "31000.00", "10.00"],
        ["sin_desglose", "9000.00", null]
      ]
    );
    assert.equal(june.headcount, "22.00", "employees_reported de la referencia del lote");
    assert.equal(june.costPerEmployee, "1818.18");
    const overlap = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.overlap, HOTEL.propertyId);
    assert.equal(overlap.length, 1);
    assert.equal(overlap[0]!.periodCode, "2026-06");
    assert.match(overlap[0]!.message, /prevalece el diario/);
  });

  it("centro de coste que no es departamento USALI (operating / código desconocido) → sin desglose + LABOR_PANEL_COST_CENTRE_UNMAPPED", () => {
    const input = baseInput();
    const panel = aggregateLaborCostPanel({
      ...input,
      ledgerRows: [...input.ledgerRows, ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "640", debit: "1000.00", costCentre: { type: "operating", code: "ROOMS" } }), ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "640", debit: "500.00", costCentre: FNB_CC })]
    });
    const may = monthOf(panel, HOTEL, "2026-05");
    assert.equal(may.laborCost, "40500.00");
    assert.equal(may.noBreakdown, false);
    assert.deepEqual(
      may.departments.map((d) => [d.usaliDepartment, d.laborCost]),
      [
        ["fnb", "500.00"],
        ["sin_desglose", "40000.00"]
      ]
    );
    const unmapped = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.costCentreUnmapped, HOTEL.propertyId);
    assert.equal(unmapped.length, 1);
    assert.match(unmapped[0]!.message, /operating:ROOMS/);
  });

  it("salesSource: 70x del diario que cubre ≥ 90 % de la referencia → ledger; por debajo → reference; sin nada → null y LABOR_PANEL_SALES_MISSING", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const may = monthOf(panel, HOTEL, "2026-05");
    assert.deepEqual([may.sales, may.salesSource, may.pctOfSales], ["100000.00", "ledger", "39.00"]);
    const june = monthOf(panel, HOTEL, "2026-06");
    assert.deepEqual([june.sales, june.salesSource, june.pctOfSales], ["80000.00", "reference", "40.00"], "60.000 del diario < 90 % de 80.000 → referencia");
    const officeMay = monthOf(panel, OFFICE, "2026-05");
    assert.deepEqual([officeMay.sales, officeMay.salesSource, officeMay.pctOfSales], [null, null, null]);
    const missing = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.salesMissing, OFFICE.propertyId);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.periodCode, "2026-05");
    // Referencia alcanzada por el diario → ledger.
    const covered = aggregateLaborCostPanel(baseInput({ references: [reference({ propertyId: HOTEL.propertyId, periodCode: "2026-06", employeesReported: D("22.00"), netSalesReported: D("66000.00") })] }));
    assert.equal(monthOf(covered, HOTEL, "2026-06").salesSource, "ledger");
    assert.equal(monthOf(covered, HOTEL, "2026-06").sales, "60000.00");
  });

  it("RN: con habitaciones ocupadas reales el CPOR laboral se calcula; sin RN es null (nunca 0) y LABOR_PANEL_RN_MISSING; mes incompleto → LABOR_PANEL_RN_PARTIAL", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const may = monthOf(panel, HOTEL, "2026-05");
    assert.deepEqual([may.roomNights, may.laborCostPerOccupiedRoom], [1000, "39.00"]);
    const june = monthOf(panel, HOTEL, "2026-06");
    assert.deepEqual([june.roomNights, june.laborCostPerOccupiedRoom], [null, null]);
    const missing = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.rnMissing, HOTEL.propertyId);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.periodCode, "2026-06", "julio no tiene coste: no se avisa de RN de un mes sin datos");
    assert.equal(codesOf(panel, LABOR_PANEL_DEGRADED_CODES.rnMissing, OFFICE.propertyId).length, 1);
    assert.deepEqual(panel.sources.roomNights, [
      { propertyId: HOTEL.propertyId, source: "night_audit" },
      { propertyId: OFFICE.propertyId, source: "degraded" }
    ]);

    const partial = aggregateLaborCostPanel(baseInput({ roomNights: [{ propertyId: HOTEL.propertyId, periodCode: "2026-05", roomNights: 400, partial: true, source: "snapshot" }] }));
    assert.equal(monthOf(partial, HOTEL, "2026-05").laborCostPerOccupiedRoom, "97.50");
    assert.equal(codesOf(partial, LABOR_PANEL_DEGRADED_CODES.rnPartial, HOTEL.propertyId).length, 1);
    assert.equal(partial.sources.roomNights[0]!.source, "snapshot");

    const zero = aggregateLaborCostPanel(baseInput({ roomNights: [{ propertyId: HOTEL.propertyId, periodCode: "2026-05", roomNights: 0, partial: false, source: "reservations" }] }));
    assert.equal(monthOf(zero, HOTEL, "2026-05").laborCostPerOccupiedRoom, null, "0 habitaciones ocupadas no divide");
  });

  it("mes sin diario ni lote → source null, laborCost «0.00», sin departamentos y LABOR_PANEL_COST_MISSING con los meses", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const july = monthOf(panel, HOTEL, "2026-07");
    assert.deepEqual([july.source, july.laborCost, july.departments, july.overlap, july.noBreakdown], [null, "0.00", [], false, false]);
    assert.deepEqual([july.sales, july.pctOfSales, july.headcount, july.costPerEmployee, july.laborCostPerOccupiedRoom], [null, null, null, null, null]);
    const hotelMissing = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.costMissing, HOTEL.propertyId);
    assert.equal(hotelMissing.length, 1);
    assert.equal(hotelMissing[0]!.periodCode, "2026-07");
    const officeMissing = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.costMissing, OFFICE.propertyId);
    assert.equal(officeMissing.length, 1);
    assert.equal(officeMissing[0]!.periodCode, null, "varios meses → sin periodCode, meses en el mensaje");
    assert.match(officeMissing[0]!.message, /2026-06, 2026-07/);
    assert.match(officeMissing[0]!.message, /^OC: /);
  });

  it("headcount: referencia del lote gana sobre Σ líneas; sin lote → null + LABOR_PANEL_HEADCOUNT_MISSING; totales con media de los meses con dato", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const june = monthOf(panel, HOTEL, "2026-06");
    assert.deepEqual([june.headcount, june.costPerEmployee], ["22.00", "1454.55"]);
    assert.deepEqual([monthOf(panel, HOTEL, "2026-05").headcount, monthOf(panel, HOTEL, "2026-05").costPerEmployee], [null, null]);
    const missing = codesOf(panel, LABOR_PANEL_DEGRADED_CODES.headcountMissing, HOTEL.propertyId);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.periodCode, "2026-05");
    const hotel = hotelOf(panel);
    assert.deepEqual([hotel.totals.headcount, hotel.totals.costPerEmployee], ["22.00", "1454.55"], "coste de los meses con headcount / media de headcount");
    const noReference = aggregateLaborCostPanel(baseInput({ references: [] }));
    assert.equal(monthOf(noReference, HOTEL, "2026-06").headcount, "16.00", "Σ headcount de las líneas del lote");
  });

  it("totales del centro y de la sociedad: coste = Σ meses; ratios sobre los meses con denominador; sociedad = hoteles + oficina central", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    const hotel = hotelOf(panel);
    assert.equal(hotel.totals.laborCost, "71000.00");
    assert.equal(hotel.totals.sales, "180000.00");
    assert.equal(hotel.totals.pctOfSales, "39.44", "71.000 / 180.000 (ambos meses tienen ventas)");
    assert.equal(hotel.totals.roomNights, 1000);
    assert.equal(hotel.totals.laborCostPerOccupiedRoom, "39.00", "solo el coste de mayo (único mes con RN) / RN de mayo");
    const office = officeOf(panel);
    assert.deepEqual([office.totals.laborCost, office.totals.sales, office.totals.pctOfSales, office.totals.roomNights, office.totals.headcount], ["50000.00", null, null, null, null]);
    assert.equal(panel.totals.laborCost, "121000.00", "hotel 71.000 + oficina 50.000");
    assert.equal(panel.totals.sales, "180000.00");
    assert.equal(panel.totals.pctOfSales, "39.44", "la oficina no tiene ventas: su coste no entra en el %");
    assert.equal(panel.totals.roomNights, 1000);
    assert.equal(panel.totals.headcount, "22.00");
    assert.deepEqual(
      panel.totals.byDepartment.map((d) => [d.usaliDepartment, d.laborCost, d.revenue, d.pctOfSales]),
      [
        ["rooms", "20000.00", "50000.00", "40.00"],
        ["fnb", "12000.00", "10000.00", "120.00"],
        ["sin_desglose", "89000.00", null, "39.00"]
      ]
    );
    assert.equal(panel.scope, "entity");
    assert.equal(panel.legalEntityId, "le_lp");
  });

  it("deltaPrevious: Δ % del coste frente a la ventana anterior; null cuando aquella no tiene coste o no se pide", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    assert.equal(hotelOf(panel).totals.deltaPrevious, "77.50", "(71.000 − 40.000) / 40.000");
    assert.equal(officeOf(panel).totals.deltaPrevious, null, "la oficina no tiene coste en feb-abr");
    assert.equal(panel.totals.deltaPrevious, "202.50", "(121.000 − 40.000) / 40.000");
    const noPrevious = aggregateLaborCostPanel(baseInput({ previousMonths: [] }));
    assert.equal(hotelOf(noPrevious).totals.deltaPrevious, null);
    assert.equal(noPrevious.totals.deltaPrevious, null);
  });

  it("ranking solo con ámbito sociedad: por % s/ ventas descendente, sin ventas al final; con ámbito de centro queda vacío", () => {
    const panel = aggregateLaborCostPanel(baseInput());
    assert.deepEqual(
      panel.ranking.map((row) => [row.propertyCode, row.laborCost, row.pctOfSales]),
      [
        ["HD", "71000.00", "39.44"],
        ["OC", "50000.00", null]
      ]
    );
    const single = aggregateLaborCostPanel(baseInput({ scope: "property", centres: [HOTEL] }));
    assert.deepEqual(single.ranking, []);
    assert.equal(single.centres.length, 1);
    assert.equal(single.totals.laborCost, "71000.00");
  });

  it("ingreso por departamento: sin USALI (null) revenue y % del departamento operativo son null; los no distribuidos se miden sobre las ventas del mes", () => {
    const input = baseInput();
    const panel = aggregateLaborCostPanel({
      ...input,
      departmentRevenue: null,
      importLines: [...input.importLines, importLine({ propertyId: HOTEL.propertyId, periodCode: "2026-06", usaliDepartment: "admin_general", totalCost: "8000.00", headcount: "2.00" })],
      degraded: [{ code: LABOR_PANEL_DEGRADED_CODES.usaliForbidden, message: "Ingreso por departamento no disponible.", propertyId: null, periodCode: null }]
    });
    const june = monthOf(panel, HOTEL, "2026-06");
    assert.deepEqual(
      june.departments.map((d) => [d.usaliDepartment, d.revenue, d.pctOfSales]),
      [
        ["rooms", null, null],
        ["fnb", null, null],
        ["admin_general", null, "10.00"]
      ]
    );
    assert.equal(codesOf(panel, LABOR_PANEL_DEGRADED_CODES.usaliForbidden).length, 1, "las entradas de los lectores se conservan");
    assert.equal(panel.degraded[0]!.code, LABOR_PANEL_DEGRADED_CODES.usaliForbidden, "las entradas previas van primero");
  });

  it("sources: cuentas 64x/70x de la ventana (no de la ventana anterior ni del grupo 7 ajeno), lotes usados y asientos leídos", () => {
    const input = baseInput();
    const panel = aggregateLaborCostPanel({ ...input, ledgerRows: [...input.ledgerRows, ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "759", credit: "10.00" }), ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-02", accountCode: "649", debit: "10.00" })] });
    assert.deepEqual(panel.sources.ledger, { entries: 7, accounts: ["640", "641", "642", "705.1"] });
    assert.deepEqual(panel.sources.imports, [{ importId: "imp_lp_1", fileName: "nomina-2026-06.json", periodFrom: "2026-06", periodTo: "2026-06", postedAt: "2026-09-01T00:00:00.000Z" }]);
    assert.equal(panel.generatedAt, "2026-09-20T12:00:00.000Z");
    assert.deepEqual([panel.from, panel.to], ["2026-05", "2026-07"]);
  });

  it("nunca un 0 inventado: un centro sin ningún dato tiene todos los ratios null, coste «0.00» con source null y ranking al final", () => {
    const empty = aggregateLaborCostPanel(baseInput({ ledgerRows: [], importLines: [], references: [], roomNights: [], departmentRevenue: [] }));
    for (const centre of empty.centres) {
      for (const month of centre.months) {
        assert.equal(month.source, null);
        assert.equal(month.laborCost, "0.00");
        assert.deepEqual([month.sales, month.pctOfSales, month.roomNights, month.laborCostPerOccupiedRoom, month.headcount, month.costPerEmployee], [null, null, null, null, null, null]);
      }
      assert.deepEqual([centre.totals.pctOfSales, centre.totals.laborCostPerOccupiedRoom, centre.totals.costPerEmployee, centre.totals.deltaPrevious], [null, null, null, null]);
    }
    assert.equal(empty.degraded.filter((entry) => entry.code === LABOR_PANEL_DEGRADED_CODES.costMissing).length, 2);
    assert.equal(empty.degraded.some((entry) => entry.code === LABOR_PANEL_DEGRADED_CODES.rnMissing), false, "sin coste no se avisa de RN ni de ventas");
  });
});

describe("PANEL-A · departmentRevenueOf (USALI del mes sobre las filas del panel)", () => {
  it("enruta el ingreso 705.1 a Habitaciones y 705.2 a A&B por el mapeo de la cuenta, mes a mes y solo para los departamentos operativos", () => {
    const rows: LaborLedgerRow[] = [
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "705.1", credit: "1000.00", usaliDepartment: "rooms", usaliLine: "revenue" }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "705.2", credit: "300.00", usaliDepartment: "fnb", usaliLine: "revenue" }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-05", accountCode: "640", debit: "500.00", usaliDepartment: null, usaliLine: "labor", costCentre: ROOMS_CC }),
      ledger({ propertyId: HOTEL.propertyId, periodCode: "2026-06", accountCode: "705.1", credit: "2000.00", usaliDepartment: "rooms", usaliLine: "revenue" })
    ];
    const revenue = departmentRevenueOf({ organizationId: "org_lp", centres: [HOTEL, OFFICE], months: ["2026-05", "2026-06", "2026-07"], ledgerRows: rows, mappings: [] });
    const byKey = new Map(revenue.map((row) => [`${row.periodCode}|${row.usaliDepartment}`, String(row.revenue)]));
    assert.equal(byKey.get("2026-05|rooms"), "1000.00");
    assert.equal(byKey.get("2026-05|fnb"), "300.00");
    assert.equal(byKey.get("2026-06|rooms"), "2000.00");
    assert.equal(byKey.get("2026-06|fnb"), "0.00", "el mes tiene ingresos: un departamento sin ellos vale 0,00");
    assert.equal(revenue.some((row) => row.periodCode === "2026-07"), false, "mes sin filas → sin entrada");
    const onlyLabor = departmentRevenueOf({ organizationId: "org_lp", centres: [HOTEL], months: ["2026-05"], ledgerRows: [rows[2]!], mappings: [] });
    assert.deepEqual(onlyLabor, [], "mes con solo cuentas de gasto → sin entrada (revenue null, nunca 0,00)");
    assert.equal(revenue.some((row) => row.propertyId === OFFICE.propertyId), false);
    assert.equal(revenue.some((row) => !["rooms", "fnb", "other_operated"].includes(row.usaliDepartment)), false);
  });
});
