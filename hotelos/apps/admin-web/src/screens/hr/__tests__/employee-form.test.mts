import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmployeeDetailDto } from "@hotelos/shared";
import {
  CONTRACT_PAY_COUNT_MAX,
  CONTRACT_PAY_COUNT_MIN,
  EMPLOYEE_NAME_MAX,
  EMPLOYEE_NUMBER_MAX,
  EMPTY_CONTRACT_FORM,
  EMPTY_EMPLOYEE_FORM,
  applyAgreementRules,
  employeeFormFromDetail,
  isFormValid,
  isValidSpanishTaxId,
  newContractForm,
  newEmployeeForm,
  newTerminateForm,
  normaliseTaxId,
  parseDecimal,
  toContractBody,
  toEmployeeBody,
  toEmployeePatch,
  toTerminateBody,
  validateContractForm,
  validateEmployeeForm,
  validateTerminateForm
} from "../employee-form";
import { HR_FULL_TIME_WEEKLY_HOURS, contractDefaultsFromRules, contractExpiry, contractSummaryLabel, employeeListQuery, employeeSegmentQuery, hrErrorMessage, payCountFromRules, ruleValuesFrom } from "../../../services/hr-contracts";

// Tanda RRHH · RRHH-8: reglas puras del cajón de expediente (fichas INVENTADAS,
// NIF sintéticos). Desde apps/admin-web:
//   node --import ../api/node_modules/tsx/dist/loader.mjs --test src/screens/hr/__tests__/employee-form.test.mts

const TODAY = "2026-09-20";

function detail(overrides: Partial<EmployeeDetailDto> = {}): EmployeeDetailDto {
  return {
    id: "emp_test_1",
    employeeNumber: "EMP-0007",
    firstName: "Prueba",
    lastName: "Ficticia Uno",
    fullName: "Prueba Ficticia Uno",
    legalEntityId: "le_test",
    primaryPropertyId: "prop_test",
    propertyCode: "TST",
    propertyName: "Hotel de prueba",
    usaliDepartment: "rooms",
    jobTitle: "Camarera de pisos",
    status: "active",
    hiredAt: "2024-03-01",
    terminatedAt: null,
    userId: null,
    staffProfileIds: [],
    contract: null,
    contractEndsAt: null,
    gender: null,
    terminationReason: null,
    contracts: [],
    piiFields: [],
    pii: null,
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-20T08:00:00.000Z",
    ...overrides
  };
}

describe("RRHH-8 · NIF / NIE con letra de control", () => {
  it("normalisa mayúsculas, espacios, puntos y guiones", () => {
    assert.equal(normaliseTaxId(" 12.345.678-z "), "12345678Z");
    assert.equal(normaliseTaxId("x-1234567-l"), "X1234567L");
  });

  it("acepta NIF, NIE (X/Y/Z) y K/L/M con la letra del módulo 23", () => {
    for (const ok of ["12345678Z", "00000000T", "12.345.678-Z", "X1234567L", "Y0000000Z", "K1234567L"]) assert.equal(isValidSpanishTaxId(ok), true, ok);
  });

  it("rechaza letra incorrecta, longitud incorrecta y CIF de sociedad", () => {
    for (const bad of ["12345678A", "1234567Z", "123456789Z", "X1234567A", "A12345678", "B12345674", "", "ZZZZZZZZZ"]) assert.equal(isValidSpanishTaxId(bad), false, bad);
  });
});

describe("RRHH-8 · validateEmployeeForm (Datos)", () => {
  it("obligatorios del alta: nombre, apellidos, NIF y fecha de alta", () => {
    const errors = validateEmployeeForm(EMPTY_EMPLOYEE_FORM, "create");
    assert.equal(errors.firstName, "Indica el nombre.");
    assert.equal(errors.lastName, "Indica los apellidos.");
    assert.equal(errors.taxId, "Indica el NIF o NIE.");
    assert.equal(errors.hiredAt, "Indica la fecha de alta.");
    assert.equal(isFormValid(errors), false);
  });

  it("el mínimo válido pasa y el formulario nuevo trae hoy y el centro del ámbito", () => {
    const form = newEmployeeForm({ today: TODAY, propertyId: "prop_test" });
    assert.equal(form.hiredAt, TODAY);
    assert.equal(form.primaryPropertyId, "prop_test");
    const minimal = { ...form, firstName: "Prueba", lastName: "Ficticia", taxId: "12345678Z" };
    assert.deepEqual(validateEmployeeForm(minimal, "create"), {});
  });

  it("NIF inválido, correo mal formado, NAF sin 12 dígitos e IBAN sin formato se marcan; la edición admite NIF vacío", () => {
    const base = { ...EMPTY_EMPLOYEE_FORM, firstName: "P", lastName: "F", hiredAt: TODAY };
    assert.match(validateEmployeeForm({ ...base, taxId: "12345678A" }).taxId ?? "", /letra de control/);
    assert.match(validateEmployeeForm({ ...base, taxId: "12345678Z", email: "sin-arroba" }).email ?? "", /formato válido/);
    assert.match(validateEmployeeForm({ ...base, taxId: "12345678Z", socialSecurityNumber: "1234" }).socialSecurityNumber ?? "", /12 dígitos/);
    assert.match(validateEmployeeForm({ ...base, taxId: "12345678Z", iban: "1234" }).iban ?? "", /IBAN/);
    assert.equal(validateEmployeeForm({ ...base, taxId: "12345678Z", iban: "ES91 2100 0418 4502 0005 1332", socialSecurityNumber: "28 12345678 40" }).iban, undefined);
    assert.equal(validateEmployeeForm({ ...base, taxId: "" }, "edit").taxId, undefined);
    assert.match(validateEmployeeForm({ ...base, taxId: "12345678A" }, "edit").taxId ?? "", /letra de control/);
  });

  it("topes de hr.schemas.ts: nombre ≤ 120, número ≤ 32; fecha con formato AAAA-MM-DD; vocabularios cerrados", () => {
    const base = { ...EMPTY_EMPLOYEE_FORM, firstName: "P", lastName: "F", taxId: "12345678Z", hiredAt: TODAY };
    assert.match(validateEmployeeForm({ ...base, firstName: "X".repeat(EMPLOYEE_NAME_MAX + 1) }).firstName ?? "", /120/);
    assert.match(validateEmployeeForm({ ...base, employeeNumber: "X".repeat(EMPLOYEE_NUMBER_MAX + 1) }).employeeNumber ?? "", /32/);
    assert.match(validateEmployeeForm({ ...base, hiredAt: "20/09/2026" }).hiredAt ?? "", /AAAA-MM-DD/);
    assert.match(validateEmployeeForm({ ...base, hiredAt: "2026-02-30" }).hiredAt ?? "", /válida/);
    assert.match(validateEmployeeForm({ ...base, usaliDepartment: "spa" }).usaliDepartment ?? "", /USALI/);
    assert.match(validateEmployeeForm({ ...base, gender: "x" }).gender ?? "", /lista/);
  });
});

describe("RRHH-8 · toEmployeeBody / toEmployeePatch", () => {
  it("cuerpo estricto del alta: obligatorios + opcionales solo si hay valor, NIF / IBAN / NAF normalizados, nunca cadenas vacías", () => {
    const body = toEmployeeBody(
      { ...EMPTY_EMPLOYEE_FORM, firstName: " Prueba ", lastName: "Ficticia ", taxId: "12.345.678-z", hiredAt: TODAY, iban: "es91 2100 0418 4502 0005 1332", socialSecurityNumber: "28-12345678/40", status: "leave", usaliDepartment: "fnb", gender: "female" },
      "le_test"
    );
    assert.deepEqual(body, {
      legalEntityId: "le_test",
      firstName: "Prueba",
      lastName: "Ficticia",
      taxId: "12345678Z",
      hiredAt: TODAY,
      usaliDepartment: "fnb",
      gender: "female",
      status: "leave",
      socialSecurityNumber: "281234567840",
      iban: "ES9121000418450200051332"
    });
    assert.equal(Object.values(body).some((value) => value === ""), false);
    assert.equal("employeeNumber" in body, false);
    assert.equal("email" in body, false);
  });

  it("el PATCH lleva solo lo que cambió; un opcional vaciado viaja como null; la PII solo si se tecleó; null sin cambios", () => {
    const original = detail();
    const form = employeeFormFromDetail(original);
    assert.equal(form.taxId, "", "el formulario nunca precarga el NIF cifrado");
    assert.equal(form.iban, "");
    assert.equal(toEmployeePatch(form, original), null);
    const patch = toEmployeePatch({ ...form, jobTitle: "", usaliDepartment: "fnb", firstName: "Renombrada", email: "nuevo@example.test" }, original);
    assert.deepEqual(patch, { firstName: "Renombrada", usaliDepartment: "fnb", jobTitle: null, email: "nuevo@example.test" });
  });

  it("la situación (activo / excedencia) cambia por PATCH, pero nunca sobre un expediente ya de baja", () => {
    const original = detail();
    assert.deepEqual(toEmployeePatch({ ...employeeFormFromDetail(original), status: "leave" }, original), { status: "leave" });
    const terminated = detail({ status: "inactive", terminatedAt: "2026-08-31" });
    const form = employeeFormFromDetail(terminated);
    assert.equal(form.status, "active");
    assert.equal(toEmployeePatch(form, terminated), null);
  });
});

describe("RRHH-8 · contrato (POST /payroll/contracts · campos RRHH-2)", () => {
  it("parseDecimal: coma o punto, dos decimales; rechaza texto y tres decimales", () => {
    assert.equal(parseDecimal("1800,50"), 1800.5);
    assert.equal(parseDecimal("40"), 40);
    assert.equal(parseDecimal("12.345"), null);
    assert.equal(parseDecimal("abc"), null);
    assert.equal(parseDecimal(""), null);
  });

  it("obligatorios: ficha, modalidad, inicio y bruto; rangos de pagas 12-16, jornada ≤ 60, % ≤ 100, grupo 1-11, fin ≥ inicio", () => {
    const errors = validateContractForm(EMPTY_CONTRACT_FORM);
    assert.match(errors.staffProfileId ?? "", /ficha/);
    assert.match(errors.startDate ?? "", /inicio/);
    assert.match(errors.grossSalary ?? "", /bruto/);
    const base = { ...newContractForm({ today: TODAY, staffProfileId: "sp_1" }), grossSalary: "1800" };
    assert.deepEqual(validateContractForm(base), {});
    assert.match(validateContractForm({ ...base, payCount: String(CONTRACT_PAY_COUNT_MAX + 1) }).payCount ?? "", /12 y 16/);
    assert.match(validateContractForm({ ...base, payCount: String(CONTRACT_PAY_COUNT_MIN - 1) }).payCount ?? "", /12 y 16/);
    assert.match(validateContractForm({ ...base, weeklyHours: "61" }).weeklyHours ?? "", /60/);
    assert.match(validateContractForm({ ...base, partTimePct: "0" }).partTimePct ?? "", /100/);
    assert.match(validateContractForm({ ...base, contributionGroup: "12" }).contributionGroup ?? "", /1 y 11/);
    assert.match(validateContractForm({ ...base, endDate: "2026-09-01" }).endDate ?? "", /posterior/);
    assert.match(validateContractForm({ ...base, contractType: "becario" }).contractType ?? "", /modalidad/);
  });

  it("toContractBody: cuerpo estricto con agreementId, weeklyHours, partTimePct, fixedDiscontinuous y contributionGroup; vacíos omitidos", () => {
    const body = toContractBody({ ...newContractForm({ today: TODAY, staffProfileId: "sp_1" }), grossSalary: "1800,50", agreementId: "agr_1", payCount: "15", weeklyHours: "25,5", partTimePct: "62,5", contributionGroup: "10", endDate: "2027-03-31" }, "prop_test");
    assert.deepEqual(body, {
      staffProfileId: "sp_1",
      contractType: "indefinido",
      startDate: TODAY,
      grossSalary: "1800.50",
      propertyId: "prop_test",
      endDate: "2027-03-31",
      payCount: 15,
      agreementId: "agr_1",
      weeklyHours: "25.5",
      partTimePct: "62.5",
      contributionGroup: 10
    });
    const minimal = toContractBody({ ...newContractForm({ today: TODAY, staffProfileId: "sp_1" }), grossSalary: "1500", partTimePct: "" }, null);
    assert.deepEqual(minimal, { staffProfileId: "sp_1", contractType: "indefinido", startDate: TODAY, grossSalary: "1500" });
    const fd = toContractBody({ ...newContractForm({ today: TODAY, staffProfileId: "sp_1" }), grossSalary: "1500", contractType: "fijo_discontinuo" }, null);
    assert.equal(fd.fixedDiscontinuous, true);
  });

  it("applyAgreementRules rellena pagas (12 + extras) y jornada (40 h) solo sobre campos vacíos; sin reglas no toca nada", () => {
    const rules = ruleValuesFrom([
      { key: "extra_pay_count", value: 3 },
      { key: "annual_hours", value: 1792 },
      { key: "vacation_days", value: 30 }
    ]);
    assert.equal(payCountFromRules(rules), 15);
    assert.equal(payCountFromRules(null), 14);
    assert.deepEqual(contractDefaultsFromRules(rules), { payCount: 15, weeklyHours: HR_FULL_TIME_WEEKLY_HOURS, annualHours: 1792, vacationDays: 30 });
    const empty = newContractForm({ today: TODAY });
    const filled = applyAgreementRules(empty, rules);
    assert.equal(filled.payCount, "15");
    assert.equal(filled.weeklyHours, "40");
    const typed = applyAgreementRules({ ...empty, payCount: "14", weeklyHours: "30" }, rules);
    assert.equal(typed.payCount, "14");
    assert.equal(typed.weeklyHours, "30");
    assert.deepEqual(applyAgreementRules(empty, null), empty);
  });
});

describe("RRHH-8 · baja", () => {
  it("fecha obligatoria, válida y no anterior al alta; causa del vocabulario; el cuerpo omite lo vacío", () => {
    const form = newTerminateForm(TODAY);
    assert.deepEqual(validateTerminateForm(form, "2024-03-01"), {});
    assert.match(validateTerminateForm({ ...form, terminatedAt: "" }, "2024-03-01").terminatedAt ?? "", /fecha de baja/);
    assert.match(validateTerminateForm({ ...form, terminatedAt: "2024-02-01" }, "2024-03-01").terminatedAt ?? "", /anterior/);
    assert.match(validateTerminateForm({ ...form, reason: "inventada" }, null).reason ?? "", /causa/);
    assert.deepEqual(toTerminateBody({ terminatedAt: TODAY, reason: "" }), { terminatedAt: TODAY });
    assert.deepEqual(toTerminateBody({ terminatedAt: TODAY, reason: "end_of_term" }), { terminatedAt: TODAY, reason: "end_of_term" });
  });
});

describe("RRHH-8 · hr-contracts (consultas, etiquetas y mensajes)", () => {
  it("employeeListQuery nunca lleva NIF ni PII, recorta la búsqueda a 120 y serializa el booleano como 1/0", () => {
    const query = employeeListQuery({ propertyId: "prop_test", search: `  ${"a".repeat(130)} `, fixedDiscontinuous: true, status: "active" });
    assert.deepEqual(Object.keys(query).sort(), ["fixedDiscontinuous", "propertyId", "search", "status"]);
    assert.equal(String(query.search).length, 120);
    assert.equal(query.fixedDiscontinuous, "1");
    assert.deepEqual(employeeListQuery({ search: "   " }), {});
    assert.deepEqual(employeeSegmentQuery("leave"), { status: "leave" });
    assert.deepEqual(employeeSegmentQuery("inactive"), { status: "inactive" });
    assert.deepEqual(employeeSegmentQuery("fixed_discontinuous"), { fixedDiscontinuous: true });
  });

  it("contractSummaryLabel y contractExpiry describen contrato / jornada y vencimiento sin recalcular nada", () => {
    assert.equal(contractSummaryLabel(null), "Sin contrato");
    assert.equal(contractSummaryLabel({ contractType: "indefinido", weeklyHours: "40.00", partTimePct: "100.00", fixedDiscontinuous: false }), "Indefinido · 40 h");
    assert.equal(contractSummaryLabel({ contractType: "temporal", weeklyHours: "25.00", partTimePct: "62.50", fixedDiscontinuous: true }), "Temporal · 25 h · 62,5 % · FD");
    assert.equal(contractExpiry(null, TODAY), null);
    assert.deepEqual(contractExpiry("2026-09-20", TODAY), { days: 0, tone: "danger", label: "Vence hoy" });
    assert.deepEqual(contractExpiry("2026-10-05", TODAY), { days: 15, tone: "warning", label: "Vence en 15 días" });
    assert.equal(contractExpiry("2026-12-31", TODAY)?.tone, "neutral");
    assert.equal(contractExpiry("2026-09-01", TODAY)?.label, "Vencido");
  });

  it("hrErrorMessage: diccionario por details.code, mensaje del API para VALIDATION_ERROR, fallback en español", () => {
    assert.equal(hrErrorMessage({ message: "x", details: { code: "HR_EMPLOYEE_TAXID_DUPLICATE" } }), "Ya existe un expediente con ese NIF en la sociedad.");
    assert.equal(hrErrorMessage({ message: "Campo no admitido en el cuerpo de la petición.", details: { code: "VALIDATION_ERROR" } }), "Campo no admitido en el cuerpo de la petición.");
    assert.equal(hrErrorMessage({ message: "Quien solicita no puede aprobar.", details: { code: "APPROVAL_SELF_DECISION" } }), "Quien solicita no puede aprobar su propia solicitud.");
    assert.equal(hrErrorMessage(new Error("Fallo de red")), "Fallo de red");
    assert.equal(hrErrorMessage(undefined, "Nada"), "Nada");
  });
});
