// Unit tests · Tanda RRHH · RRHH-3 — KPIs y alertas del panel RRHH (hr/kpis.service.ts):
// periodo y fecha de referencia, resumen puro de plantilla (contratos ponderados por
// partTimePct − ausencias aprobadas; vencimientos a 30 días; null sin fichas) y el
// contrato del servicio leído del fuente (degraded[] en vez de ceros; coste del mes solo
// con clave de nómina; alertas del motor puro). Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/kpis.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../../lib/http-error.js";
import { CONTRACT_EXPIRY_HORIZON_DAYS, HR_ALERT_HORIZON_DAYS, HR_KPIS_READ_KEYS, distinctPersons, parsePeriodCode, personKeyOf, referenceDateOf, summariseWorkforce } from "../kpis.service.js";

const SOURCE = readFileSync(new URL("../kpis.service.ts", import.meta.url), "utf8");
const TODAY = new Date("2026-09-20T12:00:00.000Z");

describe("kpis · periodo y fecha de referencia", () => {
  it("parsePeriodCode: vacío → mes de hoy; YYYY-MM válido; otro formato o mes 13 → 400 VALIDATION_ERROR", () => {
    assert.equal(parsePeriodCode(undefined, TODAY), "2026-09");
    assert.equal(parsePeriodCode("", TODAY), "2026-09");
    assert.equal(parsePeriodCode("2026-08", TODAY), "2026-08");
    for (const bad of ["2026-13", "2026/08", "202608", 42]) {
      assert.throws(() => parsePeriodCode(bad, TODAY), (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error.details as { code: string }).code === "VALIDATION_ERROR");
    }
  });

  it("referenceDateOf: hoy si cae en el mes; último día para meses pasados; primer día para meses futuros", () => {
    assert.equal(referenceDateOf("2026-09", TODAY), "2026-09-20");
    assert.equal(referenceDateOf("2026-08", TODAY), "2026-08-31");
    assert.equal(referenceDateOf("2026-02", TODAY), "2026-02-28");
    assert.equal(referenceDateOf("2026-11", TODAY), "2026-11-01");
  });
});

describe("kpis · summariseWorkforce (puro)", () => {
  const profiles = [{ id: "sp_1" }, { id: "sp_2" }, { id: "sp_3" }];
  const contracts = [
    { staffProfileId: "sp_1", partTimePct: "100.00", fixedDiscontinuous: false, endDate: null },
    { staffProfileId: "sp_2", partTimePct: "50.00", fixedDiscontinuous: true, endDate: new Date("2026-10-10T00:00:00.000Z") },
    { staffProfileId: "sp_3", partTimePct: null, fixedDiscontinuous: false, endDate: new Date("2026-12-31T00:00:00.000Z") }
  ];

  it("headcount 3, FTE 2,5 (50 % cuenta 0,5; null cuenta 1), 1 fijo discontinuo, 1 vencimiento en 30 días", () => {
    const s = summariseWorkforce({ profiles, contracts, absences: [] }, TODAY);
    assert.deepEqual(s, { activeHeadcount: 3, activeFte: 2.5, fixedDiscontinuousHeadcount: 1, availableFte: 2.5, contractsEndingIn30Days: 1 });
  });

  it("ausencias aprobadas del día restan el peso del contrato; nunca por debajo de 0", () => {
    const s = summariseWorkforce({ profiles, contracts, absences: [{ staffProfileId: "sp_2" }, { staffProfileId: "sp_1" }] }, TODAY);
    assert.equal(s.availableFte, 1);
    const all = summariseWorkforce({ profiles, contracts, absences: [{ staffProfileId: "sp_1" }, { staffProfileId: "sp_2" }, { staffProfileId: "sp_3" }, { staffProfileId: "sp_1" }] }, TODAY);
    assert.equal(all.availableFte, 0);
  });

  it("headcount = personas, no contratos (RF-07): dos contratos activos sobre la misma ficha cuentan 1 persona y suman 2 FTE; dos fichas del mismo expediente o usuario son 1 persona", () => {
    const twoContracts = summariseWorkforce({ profiles: [{ id: "sp_1", employeeId: "emp_1", userId: "usr_1" }], contracts: [
      { staffProfileId: "sp_1", partTimePct: "100.00", fixedDiscontinuous: false, endDate: null },
      { staffProfileId: "sp_1", partTimePct: "100.00", fixedDiscontinuous: false, endDate: null }
    ], absences: [] }, TODAY);
    assert.equal(twoContracts.activeHeadcount, 1);
    assert.equal(twoContracts.activeFte, 2);
    const sameEmployee = [{ id: "sp_a", employeeId: "emp_1", userId: "usr_1" }, { id: "sp_b", employeeId: "emp_1", userId: "usr_9" }, { id: "sp_c", employeeId: null, userId: "usr_1" }, { id: "sp_d", employeeId: null, userId: null }];
    const contractsOf = sameEmployee.map((profile) => ({ staffProfileId: profile.id, partTimePct: null, fixedDiscontinuous: false, endDate: null }));
    assert.equal(distinctPersons(sameEmployee, contractsOf), 3, "emp_1 (sp_a + sp_b) · usr_1 (sp_c) · la propia ficha (sp_d)");
    assert.equal(personKeyOf({ id: "sp_a", employeeId: "emp_1", userId: "usr_1" }), "emp:emp_1");
    assert.equal(personKeyOf({ id: "sp_c", employeeId: null, userId: "usr_1" }), "usr:usr_1");
    assert.equal(personKeyOf({ id: "sp_d", employeeId: null, userId: null }), "sp:sp_d");
    assert.equal(distinctPersons([], [{ staffProfileId: "sp_x" }]), 1, "un contrato de una ficha desconocida cuenta como una persona");
  });

  it("sin fichas → availableFte null (no calculable), nunca 0; vencimiento de hoy cuenta, de ayer no, a 31 días no", () => {
    assert.equal(summariseWorkforce({ profiles: [], contracts: [], absences: [] }, TODAY).availableFte, null);
    const edge = summariseWorkforce({ profiles, contracts: [
      { staffProfileId: "sp_1", partTimePct: null, fixedDiscontinuous: false, endDate: new Date("2026-09-20T00:00:00.000Z") },
      { staffProfileId: "sp_2", partTimePct: null, fixedDiscontinuous: false, endDate: new Date("2026-09-19T00:00:00.000Z") },
      { staffProfileId: "sp_3", partTimePct: null, fixedDiscontinuous: false, endDate: new Date("2026-10-21T00:00:00.000Z") }
    ], absences: [] }, TODAY);
    assert.equal(edge.contractsEndingIn30Days, 1);
    assert.equal(CONTRACT_EXPIRY_HORIZON_DAYS, 30);
  });
});

describe("kpis.service.ts · contrato (lectura del fuente)", () => {
  it("claves de lectura: workforce.labor_cost.view | workforce.read | payroll.read | hr.employee.read; horizonte de alertas 14 días", () => {
    assert.deepEqual([...HR_KPIS_READ_KEYS], ["workforce.labor_cost.view", "workforce.read", "payroll.read", "hr.employee.read"]);
    assert.equal(HR_ALERT_HORIZON_DAYS, 14);
  });

  it("cifras no disponibles → null + degraded[] (nunca 0): plantilla, plan, previsión, coste y ámbito de nómina", () => {
    for (const code of ["HR_WORKFORCE_MISSING", "HR_STAFFING_PLAN_MISSING", "HR_FORECAST_MISSING", "HR_LABOR_COST_MISSING", "HR_PAYROLL_SCOPE_MISSING", "HR_KPI_QUERY_FAILED"]) {
      assert.match(SOURCE, new RegExp(`degraded\\.push\\(\\{ code: "${code}"`), code);
    }
    assert.match(SOURCE, /const collector = createDegradedCollector\("hr\.kpis"/);
    assert.doesNotMatch(SOURCE, /monthLaborCost = "0\.00"/);
  });

  it("el coste del mes sale de buildPayrollCostReport SOLO con payroll.read / payroll.manage y con líneas > 0; sin lote, de la nómina calculada del mes (RF-09) con su origen", () => {
    assert.match(SOURCE, /if \(held\.has\("payroll\.read"\) \|\| held\.has\("payroll\.manage"\)\) \{\s*const report = await collector\.safe\("cost_report", buildPayrollCostReport\(/);
    assert.match(SOURCE, /if \(report && report\.totals\.lines > 0\)/);
    assert.match(SOURCE, /monthLaborCostSource = "import";/);
    assert.match(SOURCE, /const calculated = await collector\.safe\("payroll_calculated", loadCalculatedPayrollCost\(input\.context\.organizationId, propertyIds, input\.propertyId \?\? null, periodCode\), null\);/);
    assert.match(SOURCE, /monthLaborCostSource = "payroll";/);
    assert.match(SOURCE, /status: \{ in: \["calculated", "approved", "exported", "closed"\] \},\s*journalEntryIds: \{ isEmpty: false \}/, "solo periodos calculados con asientos");
    assert.match(SOURCE, /acc\.plus\(dec\(slip\.grossSalary\)\)\.plus\(dec\(slip\.ssEmployer\)\)/, "coste = bruto + SS empresa");
    assert.doesNotMatch(SOURCE, /monthLaborCostSource = "payroll";[\s\S]*?laborCostPctOfSales = /, "la nómina calculada no inventa un % s/ ventas");
  });

  it("las alertas de previsión salen del motor puro evaluateLaborAlerts sobre las filas de loadLaborForecastRows; vencimientos y umbral RD 901/2020 sin nombres", () => {
    assert.match(SOURCE, /const alerts = evaluateLaborAlerts\(alertRows\);/);
    assert.match(SOURCE, /loadLaborForecastRows\(\{ propertyId: property\.id, from, to, today \}\)/);
    assert.match(SOURCE, /kind: "contract_expiring"[\s\S]*?employeeId: profile\.employeeId/);
    assert.match(SOURCE, /activeInProperty >= HR_HEADCOUNT_THRESHOLD/);
    assert.doesNotMatch(SOURCE, /fullName|firstName|lastName|taxId/);
  });
});
