// Unit tests · payroll slip arithmetic (Decimal) and period helpers.
//   node --import tsx --test src/modules/payroll/__tests__/payroll-calc.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dec } from "../../treasury/money.js";
import { computeSlip, contractActiveDays, defaultIrpfRate, deriveMonthRange, sumSlips } from "../periods.service.js";

describe("computeSlip · identidad contable gross + ssEmployer = irpf + ss + neto", () => {
  it("2.000,00 € brutos al 15 % IRPF: 300,00 IRPF · 127,00 SS trabajador · 610,00 SS empresa · 1.573,00 neto", () => {
    const slip = computeSlip({ fullGross: "2000.00", daysWorked: 31, daysInMonth: 31, irpfRatePct: 15 });
    assert.equal(slip.effectiveGross.toFixed(2), "2000.00");
    assert.equal(slip.irpfRetention.toFixed(2), "300.00");
    assert.equal(slip.ssEmployee.toFixed(2), "127.00");
    assert.equal(slip.ssEmployer.toFixed(2), "610.00");
    assert.equal(slip.netSalary.toFixed(2), "1573.00");
    // Journal identity: D 640 2000 + D 642 610 = H 4751 300 + H 476 737 + H 465 1573.
    const debit = slip.effectiveGross.plus(slip.ssEmployer);
    const credit = slip.irpfRetention.plus(slip.ssEmployee).plus(slip.ssEmployer).plus(slip.netSalary);
    assert.equal(debit.toFixed(2), "2610.00");
    assert.equal(credit.toFixed(2), "2610.00");
  });

  it("prorates by calendar days and still balances to the cent (1.234,56 € × 10/30)", () => {
    const slip = computeSlip({ fullGross: "1234.56", daysWorked: 10, daysInMonth: 30, irpfRatePct: "12.5" });
    assert.equal(slip.effectiveGross.toFixed(2), "411.52");
    assert.equal(slip.irpfRetention.toFixed(2), "51.44");
    assert.equal(slip.ssEmployee.toFixed(2), "26.13");
    assert.equal(slip.ssEmployer.toFixed(2), "125.51");
    assert.equal(slip.netSalary.toFixed(2), "333.95");
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
