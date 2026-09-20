// Unit tests · payroll slip arithmetic (Decimal) and period helpers.
//   node --import tsx --test src/modules/payroll/__tests__/payroll-calc.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAYROLL_RATES_2026 } from "@hotelos/shared";
import { dec } from "../../treasury/money.js";
import { SS_EMPLOYEE_PCT, SS_EMPLOYEE_TEMPORARY_PCT, SS_EMPLOYER_PCT, SS_EMPLOYER_TEMPORARY_PCT, computeSlip, contractActiveDays, defaultIrpfRate, deriveMonthRange, ssRatesFor, sumSlips } from "../periods.service.js";

describe("computeSlip · identidad contable gross + ssEmployer = irpf + ss + neto (tipos 2026: 6,50 / 32,15)", () => {
  it("los tipos del cálculo son PAYROLL_RATES_2026 (Orden PJC/297/2026): trabajador 6,50 % · empresa 32,15 %", () => {
    assert.equal(SS_EMPLOYEE_PCT, "6.50");
    assert.equal(SS_EMPLOYER_PCT, "32.15");
    assert.equal(SS_EMPLOYEE_PCT, PAYROLL_RATES_2026.employeePct);
    assert.equal(SS_EMPLOYER_PCT, PAYROLL_RATES_2026.employerPct);
  });

  it("1.800,00 € brutos al 15 % IRPF: 270,00 IRPF · 117,00 SS trabajador · 578,70 SS empresa · 1.413,00 neto", () => {
    const slip = computeSlip({ fullGross: "1800.00", daysWorked: 31, daysInMonth: 31, irpfRatePct: 15 });
    assert.equal(slip.effectiveGross.toFixed(2), "1800.00");
    assert.equal(slip.irpfRetention.toFixed(2), "270.00");
    assert.equal(slip.ssEmployee.toFixed(2), "117.00");
    assert.equal(slip.ssEmployer.toFixed(2), "578.70");
    assert.equal(slip.netSalary.toFixed(2), "1413.00");
    // Journal identity: D 640 1800 + D 642 578,70 = H 4751 270 + H 476 695,70 + H 465 1413.
    const debit = slip.effectiveGross.plus(slip.ssEmployer);
    const credit = slip.irpfRetention.plus(slip.ssEmployee).plus(slip.ssEmployer).plus(slip.netSalary);
    assert.equal(debit.toFixed(2), "2378.70");
    assert.equal(credit.toFixed(2), "2378.70");
  });

  it("prorates by calendar days and still balances to the cent (1.234,56 € × 10/30)", () => {
    const slip = computeSlip({ fullGross: "1234.56", daysWorked: 10, daysInMonth: 30, irpfRatePct: "12.5" });
    assert.equal(slip.effectiveGross.toFixed(2), "411.52");
    assert.equal(slip.irpfRetention.toFixed(2), "51.44");
    assert.equal(slip.ssEmployee.toFixed(2), "26.75");
    assert.equal(slip.ssEmployer.toFixed(2), "132.30");
    assert.equal(slip.netSalary.toFixed(2), "333.33");
    const debit = slip.effectiveGross.plus(slip.ssEmployer);
    const credit = slip.irpfRetention.plus(slip.ssEmployee).plus(slip.ssEmployer).plus(slip.netSalary);
    assert.equal(debit.toFixed(2), credit.toFixed(2));
  });

  it("uses the annualised bracket table only when the contract has no rate", () => {
    assert.equal(defaultIrpfRate(900), 0);
    assert.equal(defaultIrpfRate(1500), 8);
    assert.equal(defaultIrpfRate(2000), 15);
    assert.equal(defaultIrpfRate(4000), 22);
    assert.equal(defaultIrpfRate(6000), 30);
    const slip = computeSlip({ fullGross: 2000, daysWorked: 30, daysInMonth: 30, irpfRatePct: null });
    assert.equal(slip.irpfRate.toString(), "15");
    const explicit = computeSlip({ fullGross: 2000, daysWorked: 30, daysInMonth: 30, irpfRatePct: dec("2") });
    assert.equal(explicit.irpfRate.toString(), "2");
  });

  it("clamps days worked into [0, daysInMonth]", () => {
    assert.equal(computeSlip({ fullGross: 3000, daysWorked: 45, daysInMonth: 30, irpfRatePct: 10 }).effectiveGross.toFixed(2), "3000.00");
    assert.equal(computeSlip({ fullGross: 3000, daysWorked: -3, daysInMonth: 30, irpfRatePct: 10 }).effectiveGross.toFixed(2), "0.00");
  });
});

describe("computeSlip · tipos de duración determinada y jornada parcial (corrector RRHH · RF-06, diseño §7.2)", () => {
  it("ssRatesFor: temporal y sustitucion → 6,55 / 33,35 (PAYROLL_RATES_2026 temporales); indefinido, fijo discontinuo, prácticas, formación y null → 6,50 / 32,15", () => {
    assert.equal(SS_EMPLOYEE_TEMPORARY_PCT, PAYROLL_RATES_2026.employeeTemporaryPct);
    assert.equal(SS_EMPLOYER_TEMPORARY_PCT, PAYROLL_RATES_2026.employerTemporaryPct);
    for (const type of ["temporal", "sustitucion", " temporal "]) assert.deepEqual(ssRatesFor(type), { employeePct: "6.55", employerPct: "33.35", temporary: true }, type);
    for (const type of ["indefinido", "fijo_discontinuo", "practicas", "formacion", null, undefined, ""]) assert.deepEqual(ssRatesFor(type), { employeePct: "6.50", employerPct: "32.15", temporary: false }, String(type));
  });

  it("1.600,00 € temporal al 10 % IRPF: 160,00 IRPF · 104,80 SS trabajador (6,55 %) · 533,60 SS empresa (33,35 %) · 1.335,20 neto; la identidad contable se mantiene", () => {
    const slip = computeSlip({ fullGross: "1600.00", daysWorked: 30, daysInMonth: 30, irpfRatePct: 10, contractType: "temporal" });
    assert.equal(slip.rates.temporary, true);
    assert.equal(slip.effectiveGross.toFixed(2), "1600.00");
    assert.equal(slip.irpfRetention.toFixed(2), "160.00");
    assert.equal(slip.ssEmployee.toFixed(2), "104.80");
    assert.equal(slip.ssEmployer.toFixed(2), "533.60");
    assert.equal(slip.netSalary.toFixed(2), "1335.20");
    assert.equal(slip.effectiveGross.plus(slip.ssEmployer).toFixed(2), slip.irpfRetention.plus(slip.ssEmployee).plus(slip.ssEmployer).plus(slip.netSalary).toFixed(2));
  });

  it("jornada parcial 62,50 % sobre 1.450,00 € de referencia: bruto y bases 906,25; el tramo de IRPF se lee del bruto contratado; 100 %, null y valores fuera de (0, 100) no prorratean", () => {
    const partial = computeSlip({ fullGross: "1450.00", daysWorked: 30, daysInMonth: 30, irpfRatePct: null, contractType: "fijo_discontinuo", partTimePct: "62.50" });
    assert.equal(partial.partTimePct.toString(), "62.5");
    assert.equal(partial.effectiveGross.toFixed(2), "906.25");
    assert.equal(partial.ssEmployee.toFixed(2), dec("906.25").mul(dec(SS_EMPLOYEE_PCT)).div(100).toDecimalPlaces(2).toFixed(2));
    assert.equal(partial.ssEmployer.toFixed(2), dec("906.25").mul(dec(SS_EMPLOYER_PCT)).div(100).toDecimalPlaces(2).toFixed(2));
    assert.equal(partial.irpfRate.toNumber(), defaultIrpfRate(906.25), "el tramo por defecto mira el bruto de la jornada contratada (906,25 × 12 ≤ 12.000 → 0 %)");
    assert.equal(computeSlip({ fullGross: "1450.00", daysWorked: 30, daysInMonth: 30, irpfRatePct: 15, partTimePct: 100 }).effectiveGross.toFixed(2), "1450.00");
    assert.equal(computeSlip({ fullGross: "1450.00", daysWorked: 30, daysInMonth: 30, irpfRatePct: 15, partTimePct: null }).effectiveGross.toFixed(2), "1450.00");
    assert.equal(computeSlip({ fullGross: "1450.00", daysWorked: 30, daysInMonth: 30, irpfRatePct: 15, partTimePct: 0 }).effectiveGross.toFixed(2), "1450.00");
    // Parcial y prorrateo por días se componen: 906,25 × 15/30 = 453,13.
    assert.equal(computeSlip({ fullGross: "1450.00", daysWorked: 15, daysInMonth: 30, irpfRatePct: 15, partTimePct: "62.50" }).effectiveGross.toFixed(2), "453.13");
  });
});

describe("period helpers", () => {
  it("deriveMonthRange gives UTC month bounds and refuses bad codes", () => {
    const feb = deriveMonthRange("2028-02");
    assert.equal(feb.startDate.toISOString(), "2028-02-01T00:00:00.000Z");
    assert.equal(feb.endDate.toISOString(), "2028-02-29T00:00:00.000Z");
    assert.throws(() => deriveMonthRange("2028-13"), /01 y 12/);
    assert.throws(() => deriveMonthRange("202802"), /YYYY-MM/);
  });

  it("contractActiveDays counts inclusive calendar days inside the period", () => {
    const period = deriveMonthRange("2026-08");
    assert.equal(contractActiveDays({ startDate: new Date("2026-01-01T00:00:00Z"), endDate: null }, period), 31);
    assert.equal(contractActiveDays({ startDate: new Date("2026-08-22T00:00:00Z"), endDate: null }, period), 10);
    assert.equal(contractActiveDays({ startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-08-05T00:00:00Z") }, period), 5);
    assert.equal(contractActiveDays({ startDate: new Date("2026-09-01T00:00:00Z"), endDate: null }, period), 0);
    assert.equal(contractActiveDays({ startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-07-31T00:00:00Z") }, period), 0);
  });

  it("sumSlips squares gross and net across slips with Decimal", () => {
    const totals = sumSlips([
      { grossSalary: 0.1, netSalary: 0.1 },
      { grossSalary: 0.2, netSalary: 0.2 }
    ]);
    assert.equal(totals.gross.toFixed(2), "0.30");
    assert.equal(totals.net.toFixed(2), "0.30");
  });
});
