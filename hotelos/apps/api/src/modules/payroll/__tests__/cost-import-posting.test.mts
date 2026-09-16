// Unit tests · Tanda 6c · L1 — regla contable del coste de personal importado
// (un asiento por centro × mes: D 640 / D 642 por departamento USALI con centro
// de coste, H 465 / H 476). Sin base de datos; cifras sintéticas. Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/cost-import-posting.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../../../lib/http-error.js";
import {
  PAYROLL_COST_CENTRE_TYPE,
  PAYROLL_COST_SOURCE_TYPE,
  buildPayrollCostEntries,
  buildPayrollCostEntry,
  daysInMonth,
  lastDayOfMonth,
  payrollCostSourceId,
  periodLabel,
  usaliCostCentreCode,
  usaliCostCentreName,
  type PayrollCostPostingCell
} from "../cost-import.posting.js";

const cell: PayrollCostPostingCell = {
  propertyId: "prop_hd",
  propertyCode: "HD",
  propertyName: "Hotel Demo",
  periodCode: "2026-02",
  departments: [
    { usaliDepartment: "rooms", costCenterId: "cc_hd_rooms", gross: "10000.00", employerSs: "3000.00" },
    { usaliDepartment: "fnb", costCenterId: "cc_hd_fnb", gross: 5000, employerSs: 1500 }
  ]
};

function triples(lines: ReadonlyArray<{ accountCode: string; debit: string; credit: string; costCenterId?: string | null; description?: string | null }>): Array<[string, string, string, string | null]> {
  return lines.map((line) => [line.accountCode, line.debit, line.credit, line.costCenterId ?? null]);
}

describe("fechas y claves", () => {
  it("lastDayOfMonth / daysInMonth: febrero bisiesto, meses de 30 y 31 días", () => {
    assert.equal(lastDayOfMonth("2026-02"), "2026-02-28");
    assert.equal(lastDayOfMonth("2028-02"), "2028-02-29");
    assert.equal(lastDayOfMonth("2026-04"), "2026-04-30");
    assert.equal(lastDayOfMonth("2026-12"), "2026-12-31");
    assert.equal(daysInMonth("2100-02"), 28, "2100 no es bisiesto");
    assert.equal(daysInMonth("2000-02"), 29);
    assert.throws(() => lastDayOfMonth("2026-13"), (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error.details as { code: string }).code === "PAYROLL_IMPORT_INVALID");
    assert.throws(() => lastDayOfMonth("202602"), HttpError);
  });

  it("sourceId, etiqueta del mes y códigos de centro de coste", () => {
    assert.equal(payrollCostSourceId("imp_1", "prop_hd", "2026-02"), "imp_1:prop_hd:2026-02");
    assert.equal(periodLabel("2026-02"), "02/2026");
    assert.equal(PAYROLL_COST_SOURCE_TYPE, "payroll_cost_import");
    assert.equal(PAYROLL_COST_CENTRE_TYPE, "usali");
    assert.equal(usaliCostCentreCode("rooms"), "ROOMS");
    assert.equal(usaliCostCentreCode("admin_general"), "ADMIN_GENERAL");
    assert.equal(usaliCostCentreName("fnb"), "Alimentos y bebidas");
    assert.equal(usaliCostCentreName("pom"), "Mantenimiento y operación de la propiedad");
  });
});

describe("buildPayrollCostEntry · ejemplo sintético del diseño §3.1 (HD · febrero 2026)", () => {
  it("líneas exactas: 640 por departamento, 642 por departamento, 465 Σ bruto, 476 Σ SS; cuadre 19.500,00", () => {
    const entry = buildPayrollCostEntry({ importId: "imp_1", cell })!;
    assert.ok(entry);
    assert.equal(entry.sourceType, "payroll_cost_import");
    assert.equal(entry.sourceId, "imp_1:prop_hd:2026-02");
    assert.equal(entry.entryDate, "2026-02-28");
    assert.equal(entry.description, "Coste de personal 02/2026 · HD (importado)");
    assert.equal(entry.reference, "2026-02");
    assert.equal(entry.entryKind, "normal");
    assert.equal(entry.propertyId, "prop_hd");
    assert.equal(entry.periodCode, "2026-02");
    assert.equal(entry.totalGross, "15000.00");
    assert.equal(entry.totalEmployerSs, "4500.00");
    assert.deepEqual(triples(entry.lines), [
      ["640", "5000.00", "0.00", "cc_hd_fnb"],
      ["640", "10000.00", "0.00", "cc_hd_rooms"],
      ["642", "1500.00", "0.00", "cc_hd_fnb"],
      ["642", "3000.00", "0.00", "cc_hd_rooms"],
      ["465", "0.00", "15000.00", null],
      ["476", "0.00", "4500.00", null]
    ]);
    assert.deepEqual(
      entry.lines.map((line) => line.description),
      ["Sueldos y salarios · Alimentos y bebidas", "Sueldos y salarios · Habitaciones", "Seguridad Social empresa · Alimentos y bebidas", "Seguridad Social empresa · Habitaciones", "Remuneraciones pendientes de pago · coste importado", "Seguridad Social acreedora · coste importado"]
    );
    let debit = 0;
    let credit = 0;
    for (const line of entry.lines) {
      debit += Number(line.debit);
      credit += Number(line.credit);
    }
    assert.equal(debit.toFixed(2), "19500.00");
    assert.equal(credit.toFixed(2), "19500.00");
    assert.deepEqual(entry.warnings, []);
  });

  it("usa el nombre del centro cuando no hay código y redondea a céntimos", () => {
    const entry = buildPayrollCostEntry({ importId: "imp_2", cell: { ...cell, propertyCode: null, periodCode: "2028-02", departments: [{ usaliDepartment: "pom", costCenterId: "cc_pom", gross: "1234.565", employerSs: "0.004" }] } })!;
    assert.equal(entry.description, "Coste de personal 02/2028 · Hotel Demo (importado)");
    assert.equal(entry.entryDate, "2028-02-29");
    assert.deepEqual(triples(entry.lines), [
      ["640", "1234.57", "0.00", "cc_pom"],
      ["465", "0.00", "1234.57", null]
    ], "una SS a 0,00 no genera línea 642 ni 476");
  });

  it("celda toda a 0 → null (sin asiento)", () => {
    assert.equal(buildPayrollCostEntry({ importId: "imp_3", cell: { ...cell, departments: [{ usaliDepartment: "rooms", costCenterId: "cc", gross: 0, employerSs: "0.00" }] } }), null);
    assert.equal(buildPayrollCostEntry({ importId: "imp_3", cell: { ...cell, departments: [] } }), null);
  });
});

describe("buildPayrollCostEntries · plan completo", () => {
  it("ordena por (mes, centro), omite celdas a 0 con aviso y numera un sourceId por celda", () => {
    const zero: PayrollCostPostingCell = { propertyId: "prop_oc", propertyCode: "OC", propertyName: "Oficina", periodCode: "2026-01", departments: [{ usaliDepartment: "admin_general", costCenterId: "cc_oc", gross: 0, employerSs: 0 }] };
    const office: PayrollCostPostingCell = { ...zero, periodCode: "2026-02", departments: [{ usaliDepartment: "admin_general", costCenterId: "cc_oc", gross: "3500.00", employerSs: "1050.00" }] };
    const january: PayrollCostPostingCell = { ...cell, periodCode: "2026-01" };
    const { entries, warnings } = buildPayrollCostEntries({ importId: "imp_4", cells: [office, cell, zero, january] });
    assert.deepEqual(entries.map((e) => e.sourceId), ["imp_4:prop_hd:2026-01", "imp_4:prop_hd:2026-02", "imp_4:prop_oc:2026-02"]);
    assert.deepEqual(entries.map((e) => e.entryDate), ["2026-01-31", "2026-02-28", "2026-02-28"]);
    assert.deepEqual(warnings, ["OC · 2026-01: todos los importes son 0; no se genera asiento"]);
    assert.deepEqual(triples(entries[2]!.lines), [
      ["640", "3500.00", "0.00", "cc_oc"],
      ["642", "1050.00", "0.00", "cc_oc"],
      ["465", "0.00", "3500.00", null],
      ["476", "0.00", "1050.00", null]
    ]);
  });

  it("plan vacío o todo a 0 → 400 PAYROLL_IMPORT_EMPTY", () => {
    const isEmpty = (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error.details as { code: string }).code === "PAYROLL_IMPORT_EMPTY";
    assert.throws(() => buildPayrollCostEntries({ importId: "imp_5", cells: [] }), isEmpty);
    assert.throws(() => buildPayrollCostEntries({ importId: "imp_5", cells: [{ ...cell, departments: [{ usaliDepartment: "rooms", costCenterId: "cc", gross: 0, employerSs: 0 }] }] }), isEmpty);
  });
});
