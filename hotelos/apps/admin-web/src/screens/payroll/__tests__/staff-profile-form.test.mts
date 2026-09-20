import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StaffProfileRecord } from "../../../services/payrollApi";
import {
  EMPTY_STAFF_PROFILE_FORM,
  STAFF_EMPLOYEE_CODE_MAX,
  STAFF_EMPLOYMENT_TYPE_OPTIONS,
  departmentOptions,
  employeeLabel,
  isStaffProfileFormValid,
  parseHourlyCost,
  personOptions,
  staffProfileLabel,
  staffProfileLabelMap,
  staffProfileOptions,
  toStaffProfileBody,
  validateStaffProfileForm
} from "../staff-profile-form";

// FIX-1 · F10: reglas puras del cajón «Nueva ficha de personal» y de las
// etiquetas de ficha (nombres INVENTADOS). Desde apps/admin-web:
//   node --import ../api/node_modules/tsx/dist/loader.mjs --test src/screens/payroll/__tests__/staff-profile-form.test.mts

function profile(overrides: Partial<StaffProfileRecord>): StaffProfileRecord {
  return {
    id: "sp_1",
    propertyId: "prop_x",
    userId: "usr_x",
    employeeCode: null,
    departmentId: null,
    departmentName: null,
    employmentType: null,
    hourlyCost: null,
    active: true,
    createdAt: "2026-09-19T10:00:00.000Z",
    userFullName: null,
    userEmail: null,
    ...overrides
  };
}

describe("F10 · validateStaffProfileForm", () => {
  it("userId obligatorio; el formulario vacío no es válido y el mínimo (solo persona) sí", () => {
    const empty = validateStaffProfileForm(EMPTY_STAFF_PROFILE_FORM);
    assert.equal(empty.userId, "Elige la persona de la ficha.");
    assert.equal(isStaffProfileFormValid(empty), false);
    const minimal = validateStaffProfileForm({ ...EMPTY_STAFF_PROFILE_FORM, userId: "usr_1" });
    assert.deepEqual(minimal, {});
    assert.equal(isStaffProfileFormValid(minimal), true);
  });

  it("employeeCode ≤ 32 (el 33.º carácter falla; los espacios no cuentan)", () => {
    assert.equal(validateStaffProfileForm({ ...EMPTY_STAFF_PROFILE_FORM, userId: "u", employeeCode: "X".repeat(STAFF_EMPLOYEE_CODE_MAX) }).employeeCode, undefined);
    assert.equal(validateStaffProfileForm({ ...EMPTY_STAFF_PROFILE_FORM, userId: "u", employeeCode: ` ${"X".repeat(STAFF_EMPLOYEE_CODE_MAX)} ` }).employeeCode, undefined);
    assert.match(validateStaffProfileForm({ ...EMPTY_STAFF_PROFILE_FORM, userId: "u", employeeCode: "X".repeat(STAFF_EMPLOYEE_CODE_MAX + 1) }).employeeCode ?? "", /32 caracteres/);
  });

  it("hourlyCost numérico ≥ 0 con coma o punto y dos decimales; vacío vale", () => {
    for (const ok of ["", "0", "12", "12,5", "12.50", " 9,99 "]) assert.equal(validateStaffProfileForm({ ...EMPTY_STAFF_PROFILE_FORM, userId: "u", hourlyCost: ok }).hourlyCost, undefined, ok);
    for (const bad of ["-1", "abc", "12,345", "1e3", "12,", ",5"]) assert.match(validateStaffProfileForm({ ...EMPTY_STAFF_PROFILE_FORM, userId: "u", hourlyCost: bad }).hourlyCost ?? "", /mayor o igual que 0/, bad);
    assert.equal(parseHourlyCost("12,5"), 12.5);
    assert.equal(parseHourlyCost(""), null);
    assert.equal(parseHourlyCost("x"), null);
  });
});

describe("F10 · toStaffProfileBody", () => {
  it("omite los opcionales vacíos, recorta y envía el coste con punto", () => {
    assert.deepEqual(toStaffProfileBody({ ...EMPTY_STAFF_PROFILE_FORM, userId: " usr_1 " }, "prop_1"), { propertyId: "prop_1", userId: "usr_1", employmentType: "indefinido" });
    assert.deepEqual(toStaffProfileBody({ userId: "usr_1", employeeCode: " EMP-01 ", departmentId: "dep_1", employmentType: "temporal", hourlyCost: "12,50" }, "prop_1"), {
      propertyId: "prop_1",
      userId: "usr_1",
      employeeCode: "EMP-01",
      departmentId: "dep_1",
      employmentType: "temporal",
      hourlyCost: "12.50"
    });
    // Una modalidad fuera del catálogo nunca viaja (el cuerpo es .strict() en el API).
    assert.equal("employmentType" in toStaffProfileBody({ ...EMPTY_STAFF_PROFILE_FORM, userId: "u", employmentType: "becario" }, "prop_1"), false);
  });

  it("las modalidades del selector son las cinco del API con etiqueta en español", () => {
    assert.deepEqual(
      STAFF_EMPLOYMENT_TYPE_OPTIONS.map((option) => option.value),
      ["indefinido", "temporal", "fijo_discontinuo", "practicas", "otro"]
    );
    assert.deepEqual(
      STAFF_EMPLOYMENT_TYPE_OPTIONS.map((option) => option.label),
      ["Indefinido", "Temporal", "Fijo discontinuo", "Prácticas", "Otro"]
    );
  });
});

describe("F10 · etiquetas y opciones", () => {
  const rows = [
    profile({ id: "sp_b", employeeCode: "EMP-002", userFullName: "Persona Beta" }),
    profile({ id: "sp_a", employeeCode: null, userFullName: "Persona Alfa" }),
    profile({ id: "sp_c", employeeCode: "EMP-003", userFullName: null, active: false }),
    profile({ id: "sp_d", employeeCode: "  ", userFullName: "  " })
  ];

  it("staffProfileLabel = employeeCode ?? userFullName ?? id (vacíos y espacios no cuentan)", () => {
    assert.equal(staffProfileLabel(rows[0]!), "EMP-002");
    assert.equal(staffProfileLabel(rows[1]!), "Persona Alfa");
    assert.equal(staffProfileLabel(rows[2]!), "EMP-003");
    assert.equal(staffProfileLabel(rows[3]!), "sp_d");
    const labels = staffProfileLabelMap(rows);
    assert.equal(employeeLabel(labels, "sp_b"), "EMP-002");
    assert.equal(employeeLabel(labels, "sp_desconocida"), "sp_desconocida", "una fila sin ficha conocida conserva el id");
  });

  it("staffProfileOptions: activas primero, orden por etiqueta, nombre tras el código, «(inactiva)» al final", () => {
    assert.deepEqual(staffProfileOptions(rows), [
      { value: "sp_b", label: "EMP-002 · Persona Beta" },
      { value: "sp_a", label: "Persona Alfa" },
      { value: "sp_d", label: "sp_d" },
      { value: "sp_c", label: "EMP-003 (inactiva)" }
    ]);
  });

  it("personOptions = «fullName · email» ordenadas por nombre; departmentOptions = «Sin departamento» + activos por nombre", () => {
    assert.deepEqual(
      personOptions([
        { userId: "u2", fullName: "Zaira Prueba", email: "zaira@hotel.test" },
        { userId: "u1", fullName: "Ana Prueba", email: "ana@hotel.test" },
        { userId: "u3", fullName: "Sin Correo", email: "" }
      ]),
      [
        { value: "u1", label: "Ana Prueba · ana@hotel.test" },
        { value: "u3", label: "Sin Correo" },
        { value: "u2", label: "Zaira Prueba · zaira@hotel.test" }
      ]
    );
    assert.deepEqual(
      departmentOptions([
        { id: "d2", name: "Pisos", active: true },
        { id: "d1", name: "Cocina", active: true },
        { id: "d3", name: "Cerrado", active: false }
      ]),
      [
        { value: "", label: "Sin departamento" },
        { value: "d1", label: "Cocina" },
        { value: "d2", label: "Pisos" }
      ]
    );
  });
});
