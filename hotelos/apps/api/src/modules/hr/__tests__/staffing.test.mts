// Unit tests · Tanda RRHH · RRHH-3 — plantilla máxima aprobada (hr/staffing.service.ts):
// validación pura del plan, cobertura por temporada (con vuelta de año), SoD de la
// aprobación (409 APPROVAL_SELF_DECISION / HR_STAFFING_PLAN_ALREADY_APPROVED) y position
// control (aviso HR_STAFFING_EXCEEDED, nunca bloqueo). Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/staffing.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HR_ERROR_MESSAGES_ES } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { assertStaffingPlanApprovable, computeStaffingHeadroom, mapStaffingPlan, normaliseStaffingPlanInput, planCoversDate } from "../staffing.service.js";

const preparer = { userId: "usr_hr_rrhh" } as UserContext;
const director = { userId: "usr_hr_direccion" } as UserContext;

function expectHttp(fn: () => void, statusCode: number, code: string): Record<string, unknown> {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode);
    const details = (error.details ?? {}) as Record<string, unknown>;
    assert.equal(details.code, code);
    return details;
  }
  assert.fail(`expected ${statusCode} ${code}`);
}

describe("staffing · normaliseStaffingPlanInput", () => {
  it("normaliza año, temporada, meses y líneas (maxFte a 2 decimales, presupuesto opcional)", () => {
    const plan = normaliseStaffingPlanInput({ year: "2026", season: "high", fromMonth: 5, toMonth: "10", lines: [{ usaliDepartment: "rooms", maxFte: "7.5" }, { usaliDepartment: "fnb", maxFte: 9, maxHeadcount: "11", budgetMonthlyCost: "25000" }] });
    assert.deepEqual(plan, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: "7.50", maxHeadcount: null, budgetMonthlyCost: null }, { usaliDepartment: "fnb", maxFte: "9.00", maxHeadcount: 11, budgetMonthlyCost: "25000.00" }] });
  });

  it("400 VALIDATION_ERROR con el campo: temporada, mes, departamento repetido, maxFte fuera de rango, sin líneas", () => {
    assert.equal(expectHttp(() => normaliseStaffingPlanInput({ year: 2026, season: "summer", fromMonth: 1, toMonth: 2, lines: [{ usaliDepartment: "rooms", maxFte: 1 }] }), 400, "VALIDATION_ERROR").field, "season");
    assert.equal(expectHttp(() => normaliseStaffingPlanInput({ year: 2026, season: "low", fromMonth: 0, toMonth: 2, lines: [{ usaliDepartment: "rooms", maxFte: 1 }] }), 400, "VALIDATION_ERROR").field, "fromMonth");
    assert.equal(expectHttp(() => normaliseStaffingPlanInput({ year: 2026, season: "low", fromMonth: 1, toMonth: 2, lines: [{ usaliDepartment: "rooms", maxFte: 1 }, { usaliDepartment: "rooms", maxFte: 2 }] }), 400, "VALIDATION_ERROR").field, "lines[1].usaliDepartment");
    assert.equal(expectHttp(() => normaliseStaffingPlanInput({ year: 2026, season: "low", fromMonth: 1, toMonth: 2, lines: [{ usaliDepartment: "rooms", maxFte: -1 }] }), 400, "VALIDATION_ERROR").field, "lines[0].maxFte");
    assert.equal(expectHttp(() => normaliseStaffingPlanInput({ year: 2026, season: "low", fromMonth: 1, toMonth: 2, lines: [] }), 400, "VALIDATION_ERROR").field, "lines");
    assert.equal(expectHttp(() => normaliseStaffingPlanInput({ year: 1999, season: "low", fromMonth: 1, toMonth: 2, lines: [{ usaliDepartment: "rooms", maxFte: 1 }] }), 400, "VALIDATION_ERROR").field, "year");
  });
});

describe("staffing · planCoversDate y mapStaffingPlan", () => {
  it("temporada dentro del año y temporada que cruza el año (nov → feb)", () => {
    const high = { year: 2026, fromMonth: 5, toMonth: 10 };
    assert.equal(planCoversDate(high, "2026-05-01"), true);
    assert.equal(planCoversDate(high, "2026-10-31"), true);
    assert.equal(planCoversDate(high, "2026-11-01"), false);
    assert.equal(planCoversDate(high, "2027-06-01"), false);
    const low = { year: 2026, fromMonth: 11, toMonth: 2 };
    assert.equal(planCoversDate(low, "2026-12-15"), true);
    assert.equal(planCoversDate(low, "2027-01-15"), true);
    assert.equal(planCoversDate(low, "2027-02-28"), true);
    assert.equal(planCoversDate(low, "2027-03-01"), false);
    assert.equal(planCoversDate(low, "2026-02-01"), false);
  });

  it("mapStaffingPlan: líneas del plan ordenadas por departamento, totalMaxFte a 2 decimales, fechas ISO", () => {
    const plan = { id: "sp_1", propertyId: "prop_hr", year: 2026, season: "high", fromMonth: 5, toMonth: 10, status: "approved", createdBy: "usr_a", approvedBy: "usr_b", approvedAt: new Date("2026-09-20T10:00:00.000Z") };
    const dto = mapStaffingPlan(plan, [
      { planId: "sp_1", usaliDepartment: "rooms", maxFte: "7.00", maxHeadcount: 8, budgetMonthlyCost: null },
      { planId: "sp_1", usaliDepartment: "fnb", maxFte: 9, maxHeadcount: null, budgetMonthlyCost: "25000.00" },
      { planId: "sp_other", usaliDepartment: "pom", maxFte: 1, maxHeadcount: null, budgetMonthlyCost: null }
    ]);
    assert.equal(dto.lines.length, 2);
    assert.deepEqual(dto.lines.map((l) => l.usaliDepartment), ["fnb", "rooms"]);
    assert.equal(dto.totalMaxFte, "16.00");
    assert.equal(dto.approvedAt, "2026-09-20T10:00:00.000Z");
    assert.equal(dto.status, "approved");
  });
});

describe("staffing · SoD de la aprobación (assertStaffingPlanApprovable)", () => {
  const draft = { id: "sp_1", status: "draft", createdBy: "usr_hr_rrhh", approvedBy: null, approvedAt: null };

  it("quien preparó el plan no lo aprueba → 409 APPROVAL_SELF_DECISION con la regla y el autor", () => {
    const details = expectHttp(() => assertStaffingPlanApprovable(draft, preparer), 409, "APPROVAL_SELF_DECISION");
    assert.equal(details.rule, "preparer_ne_approver");
    assert.equal(details.authorUserId, "usr_hr_rrhh");
    assert.equal(details.planId, "sp_1");
  });

  it("otra persona sí; un plan sin autor (fila heredada) también", () => {
    assert.doesNotThrow(() => assertStaffingPlanApprovable(draft, director));
    assert.doesNotThrow(() => assertStaffingPlanApprovable({ ...draft, createdBy: null }, preparer));
  });

  it("ya aprobado → 409 HR_STAFFING_PLAN_ALREADY_APPROVED (antes que la SoD)", () => {
    const approved = { ...draft, status: "approved", approvedBy: "usr_hr_direccion", approvedAt: new Date("2026-09-20T10:00:00.000Z") };
    const details = expectHttp(() => assertStaffingPlanApprovable(approved, preparer), 409, "HR_STAFFING_PLAN_ALREADY_APPROVED");
    assert.equal(details.approvedBy, "usr_hr_direccion");
    assert.equal(details.approvedAt, "2026-09-20T10:00:00.000Z");
    // Sin excepción para plataforma: la regla es la misma que el CHECK de ausencias.
    expectHttp(() => assertStaffingPlanApprovable(draft, { ...preparer, isPlatformAdmin: true } as UserContext), 409, "APPROVAL_SELF_DECISION");
  });
});

describe("staffing · position control (computeStaffingHeadroom): aviso, nunca bloqueo", () => {
  const plan = { id: "sp_1", year: 2026, season: "high" as const, lines: [{ usaliDepartment: "rooms" as const, maxFte: "7.00", maxHeadcount: null, budgetMonthlyCost: null }] };

  it("activos + alta prevista por encima de maxFte → exceeded con aviso HR_STAFFING_EXCEEDED (mensaje en español con cifras)", () => {
    const out = computeStaffingHeadroom({ propertyId: "prop_hr", usaliDepartment: "rooms", date: "2026-07-01", activeFte: 6.5, extraFte: 1, plan });
    assert.equal(out.exceeded, true);
    assert.equal(out.approvedMaxFte, "7.00");
    assert.equal(out.activeFte, "6.50");
    assert.equal(out.projectedFte, "7.50");
    assert.equal(out.planId, "sp_1");
    assert.equal(out.warnings.length, 1);
    assert.ok(out.warnings[0]!.startsWith(HR_ERROR_MESSAGES_ES.HR_STAFFING_EXCEEDED));
    assert.match(out.warnings[0]!, /7,?\.50 FTE frente a 7,?\.00 aprobados, plan 2026 high/);
  });

  it("dentro del máximo (o justo en él) → sin aviso; sin plan aprobado o sin línea del departamento → sin aviso y máximo null", () => {
    assert.deepEqual(computeStaffingHeadroom({ propertyId: "prop_hr", usaliDepartment: "rooms", date: "2026-07-01", activeFte: 6, extraFte: 1, plan }).warnings, []);
    assert.equal(computeStaffingHeadroom({ propertyId: "prop_hr", usaliDepartment: "rooms", date: "2026-07-01", activeFte: 7, plan }).exceeded, false);
    const noPlan = computeStaffingHeadroom({ propertyId: "prop_hr", usaliDepartment: "rooms", date: "2026-07-01", activeFte: 40, extraFte: 5, plan: null });
    assert.equal(noPlan.exceeded, false);
    assert.equal(noPlan.approvedMaxFte, null);
    assert.equal(noPlan.planId, null);
    assert.deepEqual(noPlan.warnings, []);
    const noLine = computeStaffingHeadroom({ propertyId: "prop_hr", usaliDepartment: "fnb", date: "2026-07-01", activeFte: 40, plan });
    assert.equal(noLine.exceeded, false);
    assert.equal(noLine.approvedMaxFte, null);
  });

  it("extraFte negativo se ignora (nunca resta plantilla)", () => {
    const out = computeStaffingHeadroom({ propertyId: "prop_hr", usaliDepartment: "rooms", date: "2026-07-01", activeFte: 7.2, extraFte: -3, plan });
    assert.equal(out.projectedFte, "7.20");
    assert.equal(out.exceeded, true);
  });
});
