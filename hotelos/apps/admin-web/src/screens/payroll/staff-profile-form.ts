// Fichas de personal · FIX-1 · F10 — reglas puras del cajón «Nueva ficha de
// personal» de Nóminas y de las etiquetas de ficha que usan el cajón «Nuevo
// contrato» y las tablas (sin React ni api-client, para node --test).
//
//   validateStaffProfileForm   userId obligatorio · employeeCode ≤ 32 · hourlyCost numérico ≥ 0
//   toStaffProfileBody         valores del formulario → cuerpo de POST /payroll/staff-profiles
//   staffProfileLabel          `employeeCode ?? userFullName ?? id` (lo que ve la persona en vez del id)
//   staffProfileLabelMap       Map staffProfileId → etiqueta para las columnas «Empleado»
//   staffProfileOptions        opciones del CocoaSelect de fichas (activas primero)
//   personOptions              opciones del CocoaSelect «Persona» (fullName · email)
//   departmentOptions          opciones del CocoaSelect «Departamento» (solo activos)
//   STAFF_EMPLOYMENT_TYPE_OPTIONS  modalidades con su etiqueta en español

import type { RbacUserRowDto } from "@hotelos/shared";
import type { CreateStaffProfileRequest, PropertyDepartmentRecord, StaffEmploymentType, StaffProfileRecord } from "../../services/payrollApi";

export const STAFF_EMPLOYEE_CODE_MAX = 32;

export const STAFF_EMPLOYMENT_TYPE_LABELS_ES: Readonly<Record<StaffEmploymentType, string>> = Object.freeze({
  indefinido: "Indefinido",
  temporal: "Temporal",
  fijo_discontinuo: "Fijo discontinuo",
  practicas: "Prácticas",
  otro: "Otro"
});

export const STAFF_EMPLOYMENT_TYPE_OPTIONS: ReadonlyArray<{ value: StaffEmploymentType; label: string }> = Object.freeze(
  (Object.keys(STAFF_EMPLOYMENT_TYPE_LABELS_ES) as StaffEmploymentType[]).map((value) => ({ value, label: STAFF_EMPLOYMENT_TYPE_LABELS_ES[value] }))
);

export type StaffProfileFormValues = {
  userId: string;
  employeeCode: string;
  departmentId: string;
  employmentType: string;
  hourlyCost: string;
};

export type StaffProfileFormErrors = {
  userId?: string;
  employeeCode?: string;
  hourlyCost?: string;
};

export const EMPTY_STAFF_PROFILE_FORM: StaffProfileFormValues = Object.freeze({ userId: "", employeeCode: "", departmentId: "", employmentType: "indefinido", hourlyCost: "" });

/** «12,50» / «12.5» / «12» → 12.5; null when empty or not a number. */
export function parseHourlyCost(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Validation of the drawer (mirrors the API rules): a message per field, none when the form is valid. */
export function validateStaffProfileForm(values: StaffProfileFormValues): StaffProfileFormErrors {
  const errors: StaffProfileFormErrors = {};
  if (values.userId.trim() === "") errors.userId = "Elige la persona de la ficha.";
  if (values.employeeCode.trim().length > STAFF_EMPLOYEE_CODE_MAX) errors.employeeCode = `El código de empleado no puede superar ${STAFF_EMPLOYEE_CODE_MAX} caracteres.`;
  const cost = values.hourlyCost.trim();
  if (cost !== "") {
    const parsed = parseHourlyCost(cost);
    if (parsed === null || parsed < 0) errors.hourlyCost = "El coste hora debe ser un importe mayor o igual que 0 con dos decimales como máximo.";
  }
  return errors;
}

export function isStaffProfileFormValid(errors: StaffProfileFormErrors): boolean {
  return Object.values(errors).every((error) => error === undefined);
}

/** Form values → strict body (empty optional fields are omitted, never sent as ""). */
export function toStaffProfileBody(values: StaffProfileFormValues, propertyId: string): CreateStaffProfileRequest {
  const body: CreateStaffProfileRequest = { propertyId, userId: values.userId.trim() };
  const employeeCode = values.employeeCode.trim();
  if (employeeCode) body.employeeCode = employeeCode;
  const departmentId = values.departmentId.trim();
  if (departmentId) body.departmentId = departmentId;
  const employmentType = values.employmentType.trim();
  if (employmentType && employmentType in STAFF_EMPLOYMENT_TYPE_LABELS_ES) body.employmentType = employmentType as StaffEmploymentType;
  const hourlyCost = values.hourlyCost.trim();
  if (hourlyCost) body.hourlyCost = hourlyCost.replace(",", ".");
  return body;
}

type LabelSource = Pick<StaffProfileRecord, "id" | "employeeCode" | "userFullName">;

/** What a person reads instead of the id: the employee code, else the full name, else the id itself. */
export function staffProfileLabel(profile: LabelSource): string {
  return profile.employeeCode?.trim() || profile.userFullName?.trim() || profile.id;
}

export function staffProfileLabelMap(profiles: readonly LabelSource[]): Map<string, string> {
  return new Map(profiles.map((profile) => [profile.id, staffProfileLabel(profile)]));
}

/** Label of a contract / slip row: the profile label when known, the raw id otherwise (legacy rows). */
export function employeeLabel(labels: ReadonlyMap<string, string>, staffProfileId: string): string {
  return labels.get(staffProfileId) ?? staffProfileId;
}

/** Options of the «Ficha de personal» select: active first, then by label; the name follows the code when both exist. */
export function staffProfileOptions(profiles: readonly Pick<StaffProfileRecord, "id" | "employeeCode" | "userFullName" | "active">[]): Array<{ value: string; label: string }> {
  return [...profiles]
    .sort((a, b) => Number(b.active) - Number(a.active) || staffProfileLabel(a).localeCompare(staffProfileLabel(b), "es"))
    .map((profile) => {
      const label = staffProfileLabel(profile);
      const name = profile.userFullName?.trim();
      const withName = profile.employeeCode?.trim() && name ? `${label} · ${name}` : label;
      return { value: profile.id, label: profile.active ? withName : `${withName} (inactiva)` };
    });
}

/** Options of the «Persona» select (fullName · email), sorted by name. */
export function personOptions(users: readonly Pick<RbacUserRowDto, "userId" | "fullName" | "email">[]): Array<{ value: string; label: string }> {
  return [...users]
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "es"))
    .map((user) => ({ value: user.userId, label: user.email ? `${user.fullName} · ${user.email}` : user.fullName }));
}

/** Options of the «Departamento» select: the real «none» choice first, then the active departments by name. */
export function departmentOptions(departments: readonly Pick<PropertyDepartmentRecord, "id" | "name" | "active">[]): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "Sin departamento" },
    ...[...departments]
      .filter((department) => department.active)
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .map((department) => ({ value: department.id, label: department.name }))
  ];
}
