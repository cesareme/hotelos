// Unit tests · Tanda RRHH · RRHH-6 — esquemas zod `.strict()` de las rutas /hr/*
// (schemas/hr.schemas.ts) y helpers puros de hr.routes.ts (redacción de PII de
// Employee y enmascarado de ausencias de salud). Sin base de datos; NIF y nombres
// INVENTADOS (nunca de una persona real). Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/hr-schemas.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HR_PII_FIELDS, type PermissionKey } from "@hotelos/shared";
import { BadRequestError } from "../../../lib/http-error.js";
import { parseOr400 } from "../../rate-manager/rate-grid.schemas.js";
import {
  AbsenceDecideSchema,
  AbsenceListQuerySchema,
  CreateAgreementSchema,
  CreateEmployeeSchema,
  CreateStaffingPlanSchema,
  EmployeeGetQuerySchema,
  EmployeeListQuerySchema,
  HrKpisQuerySchema,
  LaborForecastGenerateSchema,
  PatchEmployeeSchema,
  PayrollIncidencesQuerySchema,
  PutAgreementRulesSchema,
  PutStandardsSchema,
  TerminateEmployeeSchema
} from "../../../schemas/hr.schemas.js";
import { HR_PII_REDACTED, HR_PII_REDACT_KEYS, maskHealthAbsence, redactHrPii, redactHrPiiInUrl } from "../hr.routes.js";

type Issues = { code?: string; issues?: Array<{ path: string; message: string }> };

/**
 * parseOr400 lanza el 400 de la casa con `details.code = VALIDATION_ERROR` y las issues
 * (ruta + mensaje en español). La clave desconocida la nombra el mapa de errores de
 * rate-grid.schemas.ts («clave no admitida: '<clave>'»), que prevalece sobre el texto
 * de `.strict()`: es el mismo mensaje que reciben las fichas de personal.
 */
function expect400<S extends Parameters<typeof parseOr400>[0]>(schema: S, value: unknown, what: "body" | "query" = "body"): Issues {
  try {
    parseOr400(schema, value, what);
  } catch (error) {
    assert.ok(error instanceof BadRequestError, `expected BadRequestError, got ${String(error)}`);
    assert.equal(error.statusCode, 400);
    const details = error.details as Issues;
    assert.equal(details.code, "VALIDATION_ERROR");
    assert.ok(Array.isArray(details.issues) && details.issues.length > 0);
    return details;
  }
  assert.fail("expected a 400");
}

const VALID_EMPLOYEE = { legalEntityId: "le_test", firstName: "Nombre", lastName: "Apellido", taxId: "00000000T", hiredAt: "2026-09-01" };

describe("hr.schemas · una clave extra es un 400 VALIDATION_ERROR que la nombra (cuerpo y consulta)", () => {
  it("POST /hr/employees rechaza una clave desconocida y acepta el alta mínima", () => {
    const details = expect400(CreateEmployeeSchema, { ...VALID_EMPLOYEE, salario: 1200 });
    assert.match(details.issues![0]!.message, /clave no admitida: 'salario'/);
    const parsed = parseOr400(CreateEmployeeSchema, VALID_EMPLOYEE, "body");
    assert.equal(parsed.firstName, "Nombre");
    assert.equal(parsed.status, undefined);
  });

  it("GET /hr/employees rechaza un parámetro desconocido y coacciona fixedDiscontinuous", () => {
    const details = expect400(EmployeeListQuerySchema, { propertyId: "prop_a", nif: "x" }, "query");
    assert.match(details.issues![0]!.message, /clave no admitida: 'nif'/);
    assert.equal(parseOr400(EmployeeListQuerySchema, { fixedDiscontinuous: "1" }, "query").fixedDiscontinuous, true);
    assert.equal(parseOr400(EmployeeListQuerySchema, { fixedDiscontinuous: "false" }, "query").fixedDiscontinuous, false);
    expect400(EmployeeListQuerySchema, { status: "despedido" }, "query");
    // Nunca se busca por NIF: la consulta no admite taxId ni ninguna clave PII.
    for (const field of HR_PII_FIELDS) expect400(EmployeeListQuerySchema, { [field]: "x" }, "query");
    // SEC-15: un NIF, NIE o IBAN tecleado en el buscador se rechaza (no viaja en la URL ni queda en los logs).
    for (const search of ["12345678Z", "12.345.678-Z", "X1234567L", "ES9121000418450200051332", "ES91 2100 0418 4502 0005 1332"]) {
      const details = expect400(EmployeeListQuerySchema, { search }, "query");
      assert.match(details.issues![0]!.message, /no admite NIF, NIE ni IBAN/, search);
    }
    for (const search of ["García", "HR-004", "0001", "Pérez 12", "A87654323"]) assert.equal(parseOr400(EmployeeListQuerySchema, { search }, "query").search, search, search);
  });

  it("GET /hr/employees/:id: `pii` solo 1/0/true/false", () => {
    assert.equal(parseOr400(EmployeeGetQuerySchema, { pii: "1" }, "query").pii, true);
    assert.equal(parseOr400(EmployeeGetQuerySchema, {}, "query").pii, undefined);
    expect400(EmployeeGetQuerySchema, { pii: "yes" }, "query");
    expect400(EmployeeGetQuerySchema, { taxId: "00000000T" }, "query");
  });

  it("PATCH /hr/employees/:id exige al menos un campo y respeta los vocabularios", () => {
    const empty = expect400(PatchEmployeeSchema, {});
    assert.match(empty.issues![0]!.message, /al menos un campo/);
    expect400(PatchEmployeeSchema, { gender: "x" });
    expect400(PatchEmployeeSchema, { usaliDepartment: "spa" });
    expect400(PatchEmployeeSchema, { status: "inactive" });
    assert.deepEqual(parseOr400(PatchEmployeeSchema, { jobTitle: "Recepción", email: null }, "body"), { jobTitle: "Recepción", email: null });
  });

  it("POST …/terminate: causa tasada (HR_END_REASONS) y fecha YYYY-MM-DD", () => {
    assert.deepEqual(parseOr400(TerminateEmployeeSchema, { reason: "resignation", terminatedAt: "2026-09-30" }, "body"), { reason: "resignation", terminatedAt: "2026-09-30" });
    expect400(TerminateEmployeeSchema, { reason: "porque_si" });
    expect400(TerminateEmployeeSchema, { terminatedAt: "30/09/2026" });
    expect400(TerminateEmployeeSchema, { note: "x" });
  });

  it("POST /hr/agreements: `rules` solo admite las claves de HR_AGREEMENT_RULE_KEYS", () => {
    const ok = parseOr400(CreateAgreementSchema, { code: "es-15-host", name: "Convenio de prueba", validFrom: "2026-01-01", rules: { annual_hours: 1792 } }, "body");
    assert.equal(ok.code, "es-15-host");
    const details = expect400(CreateAgreementSchema, { code: "X", name: "Y", validFrom: "2026-01-01", rules: { horas_anuales: 1792 } });
    assert.match(details.issues![0]!.message, /clave no admitida: 'horas_anuales'/);
    assert.equal(details.issues![0]!.path, "rules");
    expect400(CreateAgreementSchema, { code: "X", name: "Y", validFrom: "2026-01-01", bonus: 1 });
  });

  it("PUT /hr/agreements/:id/rules: lista no vacía de { key, value, validFrom, validTo? }", () => {
    expect400(PutAgreementRulesSchema, { rules: [] });
    expect400(PutAgreementRulesSchema, { rules: [{ key: "vacation_days", value: 30, validFrom: "2026-01-01", extra: 1 }] });
    expect400(PutAgreementRulesSchema, { rules: [{ key: "dias_vacaciones", value: 30, validFrom: "2026-01-01" }] });
    const ok = parseOr400(PutAgreementRulesSchema, { rules: [{ key: "vacation_days", value: 30, validFrom: "2026-01-01" }] }, "body");
    assert.equal(ok.rules[0]!.key, "vacation_days");
  });

  it("PUT …/standards: driver / unit / departamento tasados, valor numérico o cadena decimal", () => {
    const ok = parseOr400(PutStandardsSchema, { standards: [{ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: "32,5", allowancePct: 12 }] }, "body");
    assert.equal(ok.standards[0]!.value, "32,5");
    expect400(PutStandardsSchema, { standards: [] });
    expect400(PutStandardsSchema, { standards: [{ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: "abc" }] });
    expect400(PutStandardsSchema, { standards: [{ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: 1, label: "x" }] });
    expect400(PutStandardsSchema, { standards: [{ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: 1 }], overwrite: true });
  });

  it("POST …/staffing-plans: año, temporada y meses acotados; una línea por departamento como máximo", () => {
    const ok = parseOr400(CreateStaffingPlanSchema, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: "12.5" }] }, "body");
    assert.equal(ok.lines.length, 1);
    expect400(CreateStaffingPlanSchema, { year: 2026, season: "summer", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: 1 }] });
    expect400(CreateStaffingPlanSchema, { year: 2026, season: "high", fromMonth: 13, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: 1 }] });
    expect400(CreateStaffingPlanSchema, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: 1, approved: true }] });
    expect400(CreateStaffingPlanSchema, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [] });
  });

  it("POST …/labor-forecast/generate y GET /hr/kpis: fechas y periodo con formato fijo", () => {
    assert.deepEqual(parseOr400(LaborForecastGenerateSchema, { from: "2026-09-01", to: "2026-09-14" }, "body"), { from: "2026-09-01", to: "2026-09-14" });
    expect400(LaborForecastGenerateSchema, { from: "2026-09-01" });
    expect400(LaborForecastGenerateSchema, { from: "2026-09-01", to: "2026-09-14", force: true });
    assert.equal(parseOr400(HrKpisQuerySchema, { period: "2026-09" }, "query").period, "2026-09");
    expect400(HrKpisQuerySchema, { period: "2026-13" }, "query");
    expect400(HrKpisQuerySchema, { period: "septiembre" }, "query");
  });

  it("GET /hr/absences exige propertyId y estado de la máquina; POST …/decide solo approved | rejected | cancelled", () => {
    expect400(AbsenceListQuerySchema, {}, "query");
    expect400(AbsenceListQuerySchema, { propertyId: "prop_a", status: "aprobada" }, "query");
    assert.equal(parseOr400(AbsenceListQuerySchema, { propertyId: "prop_a", status: "pending", limit: "20" }, "query").limit, 20);
    assert.equal(parseOr400(AbsenceDecideSchema, { status: "rejected", note: "Sin cobertura" }, "body").status, "rejected");
    expect400(AbsenceDecideSchema, { status: "pending" });
    expect400(AbsenceDecideSchema, { status: "approved", approvedBy: "usr_x" });
  });

  it("GET /payroll/incidences: period YYYY-MM obligatorio, format json | csv, nada más", () => {
    assert.deepEqual(parseOr400(PayrollIncidencesQuerySchema, { period: "2026-09", format: "csv" }, "query"), { period: "2026-09", format: "csv" });
    expect400(PayrollIncidencesQuerySchema, {}, "query");
    expect400(PayrollIncidencesQuerySchema, { period: "2026-9" }, "query");
    expect400(PayrollIncidencesQuerySchema, { period: "2026-09", format: "xlsx" }, "query");
    expect400(PayrollIncidencesQuerySchema, { period: "2026-09", taxId: "00000000T" }, "query");
  });
});

describe("hr.routes · redacción de PII de Employee y ausencias de salud (puros)", () => {
  it("redactHrPiiInUrl sustituye solo los parámetros PII y deja el resto de la URL", () => {
    assert.equal(redactHrPiiInUrl("/hr/employees?search=perez&taxId=00000000T&iban=ES1200000000000000000000&limit=5"), `/hr/employees?search=perez&taxId=${HR_PII_REDACTED}&iban=${HR_PII_REDACTED}&limit=5`);
    assert.equal(redactHrPiiInUrl("/hr/employees?EMAIL=a%40b.test#x"), `/hr/employees?EMAIL=${HR_PII_REDACTED}#x`);
    assert.equal(redactHrPiiInUrl("/hr/employees?search=x"), "/hr/employees?search=x");
    assert.equal(redactHrPiiInUrl(undefined), undefined);
    assert.deepEqual([...HR_PII_REDACT_KEYS], [...HR_PII_FIELDS, "taxIdLookupHash"]);
  });

  it("redactTokenInUrl de server.ts (serializador de `req`, cuerpo puro evaluado aislado por tests/cors-contract) cubre las mismas claves PII que HR_PII_REDACT_KEYS", () => {
    const code = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");
    const fn = /export function redactTokenInUrl\(url: string \| undefined\): string \| undefined \{([\s\S]*?)\n\}/.exec(code);
    assert.ok(fn, "redactTokenInUrl exportada en server.ts");
    const redact = new Function("url", fn![1]!) as (url: string | undefined) => string | undefined;
    for (const key of HR_PII_REDACT_KEYS) {
      assert.equal(redact(`/hr/employees?search=x&${key}=secreto&limit=1`), `/hr/employees?search=x&${key}=${HR_PII_REDACTED}&limit=1`, key);
      assert.equal(redact(`/hr/employees?${key.toUpperCase()}=secreto`), `/hr/employees?${key.toUpperCase()}=${HR_PII_REDACTED}`, `${key} en mayúsculas`);
    }
    assert.equal(redact("/guest-portal/check-in?token=abc&taxId=00000000T"), `/guest-portal/check-in?token=${HR_PII_REDACTED}&taxId=${HR_PII_REDACTED}`);
    assert.equal(redact("/hr/employees?search=perez"), "/hr/employees?search=perez");
    assert.match(code, /url: redactTokenInUrl\(request\.url\)/);
  });

  it("redactHrPii recorre objetos y listas, no distingue mayúsculas y conserva los null", () => {
    const input = { employee: { firstName: "Nombre", taxId: "00000000T", TaxIdLookupHash: "abc", contact: [{ phone: "600000000", email: null }] }, list: [{ iban: "ES12" }] };
    const out = redactHrPii(input);
    assert.deepEqual(out, { employee: { firstName: "Nombre", taxId: HR_PII_REDACTED, TaxIdLookupHash: HR_PII_REDACTED, contact: [{ phone: HR_PII_REDACTED, email: null }] }, list: [{ iban: HR_PII_REDACTED }] });
    // No muta la entrada.
    assert.equal(input.employee.taxId, "00000000T");
    assert.equal(redactHrPii("texto"), "texto");
  });

  it("maskHealthAbsence oculta tipo y motivo de IT / nacimiento sin hr.employee.read y deja el resto", () => {
    const it = { id: "abs_1", payload: { absenceType: "it_common", reason: "parte médico", status: "approved" } };
    const vacation = { id: "abs_2", payload: { absenceType: "vacation", reason: "verano", status: "approved" } };
    const reader: PermissionKey[] = ["workforce.read"];
    assert.deepEqual(maskHealthAbsence(it, reader).payload, { absenceType: null, reason: null, status: "approved", restricted: true });
    assert.deepEqual(maskHealthAbsence(vacation, reader).payload, vacation.payload);
    assert.deepEqual(maskHealthAbsence(it, ["workforce.read", "hr.employee.read"]).payload, it.payload);
    assert.deepEqual(maskHealthAbsence(it, ["hr.employee.manage"]).payload, it.payload);
  });
});
