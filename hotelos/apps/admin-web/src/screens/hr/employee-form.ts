// Plantilla · RRHH-8 — reglas puras del cajón de expediente (EmployeeDrawer.tsx):
// sin React ni api-client, para node --test (patrón screens/payroll/staff-profile-form.ts).
//
//   normaliseTaxId / isValidSpanishTaxId   NIF, NIE y K/L/M con letra de control (módulo 23; espejo de
//                                          apps/api/src/modules/hr/employees.service.ts) — el API rechaza
//                                          igual con 400 HR_TAXID_INVALID
//   validateEmployeeForm / toEmployeeBody   Datos: obligatorios (nombre, apellidos, NIF, fecha de alta),
//                                          topes de hr.schemas.ts y formatos de contacto; cuerpo estricto
//                                          de POST /hr/employees sin campos vacíos ("" nunca viaja)
//   toEmployeePatch                         solo lo que cambió frente al detalle; PII solo si se tecleó
//   validateContractForm / toContractBody   Contrato: ficha, modalidad, inicio, bruto; pagas 12-16, jornada
//                                          0-60 h, % 0-100, grupo 1-11 (payroll-commissions.schemas.ts)
//   applyAgreementRules                     el convenio rellena pagas (12 + extra) y jornada (40 h) si vacías
//   validateTerminateForm / toTerminateBody Baja: fecha ≥ alta, motivo ∈ HR_END_REASONS
//
// Ningún valor de persona real: los tests usan fichas INVENTADAS con NIF sintético.

import { EMPLOYEE_GENDERS, HR_END_REASONS, HR_USALI_DEPARTMENTS, type EmployeeDetailDto, type EmployeeGender, type HrAgreementRuleValues, type HrEndReason, type HrUsaliDepartment } from "@hotelos/shared";
import { HR_CONTRACT_TYPES, contractDefaultsFromRules } from "../../services/hr-contracts";
import type { CreateEmployeeContractRequest, CreateEmployeeRequest, PatchEmployeeRequest, TerminateEmployeeRequest } from "../../services/hrApi";

// ---------------------------------------------------------------------------
// NIF / NIE (letra de control)
// ---------------------------------------------------------------------------

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const NIE_PREFIX: Readonly<Record<string, string>> = Object.freeze({ X: "0", Y: "1", Z: "2" });

/** Mayúsculas y sin espacios, guiones ni puntos («12.345.678-z» → «12345678Z»). */
export function normaliseTaxId(raw: string): string {
  return raw.replace(/[\s\-.]/g, "").toUpperCase();
}

/**
 * NIF (8 dígitos + letra), NIE (X/Y/Z + 7 dígitos + letra) o NIF de persona
 * física sin DNI (K/L/M + 7 dígitos + letra) con la letra del módulo 23. Los CIF
 * de sociedades no son NIF de persona y se rechazan (mismo criterio que el API).
 */
export function isValidSpanishTaxId(raw: string): boolean {
  const value = normaliseTaxId(raw);
  const nif = /^(\d{8})([A-Z])$/.exec(value);
  if (nif) return NIF_LETTERS[Number(nif[1]) % 23] === nif[2];
  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(value);
  if (nie) return NIF_LETTERS[Number(`${NIE_PREFIX[nie[1]!]}${nie[2]}`) % 23] === nie[3];
  const special = /^([KLM])(\d{7})([A-Z])$/.exec(value);
  if (special) return NIF_LETTERS[Number(special[2]) % 23] === special[3];
  return false;
}

// ---------------------------------------------------------------------------
// Topes (espejo de apps/api/src/schemas/hr.schemas.ts employeeFields)
// ---------------------------------------------------------------------------

export const EMPLOYEE_NAME_MAX = 120;
export const EMPLOYEE_NUMBER_MAX = 32;
export const EMPLOYEE_JOB_TITLE_MAX = 120;
export const EMPLOYEE_EMAIL_MAX = 160;
export const EMPLOYEE_PHONE_MAX = 32;
export const EMPLOYEE_IBAN_MAX = 34;
export const EMPLOYEE_NAF_MAX = 20;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** IBAN: country + 2 check digits + 11-30 alphanumerics (ES = 24 characters), spaces ignored. */
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
/** NAF: 12 digits (2 province + 8 + 2 control), spaces, dashes and slashes ignored. */
const NAF = /^\d{12}$/;
/** «12,5» / «12.50» / «1800» — up to two decimals. */
const DECIMAL_2 = /^\d+([.,]\d{1,2})?$/;

export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  // Round trip: «2026-02-30» parses (V8 rolls it to March) but is not a calendar day.
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** «12,50» / «12.5» / «12» → 12.5; null when empty or not a number with ≤ 2 decimals. */
export function parseDecimal(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  if (!DECIMAL_2.test(text)) return null;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** «12,5» → «12.5» for a decimal body field (the API accepts a numeric string). */
export function decimalBody(raw: string): string {
  return raw.trim().replace(",", ".");
}

export function normaliseIban(raw: string): string {
  return raw.replace(/\s/g, "").toUpperCase();
}

export function normaliseNaf(raw: string): string {
  return raw.replace(/[\s\-/]/g, "");
}

// ---------------------------------------------------------------------------
// Datos del expediente
// ---------------------------------------------------------------------------

export type EmployeeFormValues = {
  firstName: string;
  lastName: string;
  /** Alta: obligatorio. Edición: vacío = sin cambio (el NIF cifrado no se muestra sin «Mostrar»). */
  taxId: string;
  employeeNumber: string;
  hiredAt: string;
  primaryPropertyId: string;
  usaliDepartment: string;
  jobTitle: string;
  gender: string;
  status: "active" | "leave";
  email: string;
  phone: string;
  socialSecurityNumber: string;
  iban: string;
};

export type EmployeeFormErrors = Partial<Record<keyof EmployeeFormValues, string>>;

export const EMPTY_EMPLOYEE_FORM: EmployeeFormValues = Object.freeze({
  firstName: "",
  lastName: "",
  taxId: "",
  employeeNumber: "",
  hiredAt: "",
  primaryPropertyId: "",
  usaliDepartment: "",
  jobTitle: "",
  gender: "",
  status: "active",
  email: "",
  phone: "",
  socialSecurityNumber: "",
  iban: ""
});

/** Form for the alta: today as hire date and the centre in scope preselected. */
export function newEmployeeForm(input: { today: string; propertyId?: string | null }): EmployeeFormValues {
  return { ...EMPTY_EMPLOYEE_FORM, hiredAt: input.today, primaryPropertyId: input.propertyId ?? "" };
}

/** Form of the detail: the clear columns of the file; the encrypted ones stay EMPTY (a typed value replaces them on save). */
export function employeeFormFromDetail(detail: Pick<EmployeeDetailDto, "firstName" | "lastName" | "employeeNumber" | "hiredAt" | "primaryPropertyId" | "usaliDepartment" | "jobTitle" | "gender" | "status">): EmployeeFormValues {
  return {
    ...EMPTY_EMPLOYEE_FORM,
    firstName: detail.firstName,
    lastName: detail.lastName,
    employeeNumber: detail.employeeNumber,
    hiredAt: detail.hiredAt,
    primaryPropertyId: detail.primaryPropertyId ?? "",
    usaliDepartment: detail.usaliDepartment ?? "",
    jobTitle: detail.jobTitle ?? "",
    gender: detail.gender ?? "",
    status: detail.status === "leave" ? "leave" : "active"
  };
}

/**
 * Validation of «Datos» (mirrors hr.schemas.ts): a message per field, none
 * when valid. `mode: "create"` requires the NIF; `"edit"` accepts an empty NIF
 * (unchanged) but validates a typed one.
 */
export function validateEmployeeForm(values: EmployeeFormValues, mode: "create" | "edit" = "create"): EmployeeFormErrors {
  const errors: EmployeeFormErrors = {};
  const firstName = values.firstName.trim();
  const lastName = values.lastName.trim();
  if (firstName === "") errors.firstName = "Indica el nombre.";
  else if (firstName.length > EMPLOYEE_NAME_MAX) errors.firstName = `El nombre no puede superar ${EMPLOYEE_NAME_MAX} caracteres.`;
  if (lastName === "") errors.lastName = "Indica los apellidos.";
  else if (lastName.length > EMPLOYEE_NAME_MAX) errors.lastName = `Los apellidos no pueden superar ${EMPLOYEE_NAME_MAX} caracteres.`;

  const taxId = values.taxId.trim();
  if (taxId === "") {
    if (mode === "create") errors.taxId = "Indica el NIF o NIE.";
  } else if (!isValidSpanishTaxId(taxId)) errors.taxId = "El NIF/NIE no es válido (letra de control incorrecta).";

  const hiredAt = values.hiredAt.trim();
  if (hiredAt === "") errors.hiredAt = "Indica la fecha de alta.";
  else if (!isIsoDay(hiredAt)) errors.hiredAt = "La fecha de alta debe ser una fecha válida (AAAA-MM-DD).";

  if (values.employeeNumber.trim().length > EMPLOYEE_NUMBER_MAX) errors.employeeNumber = `El número de empleado no puede superar ${EMPLOYEE_NUMBER_MAX} caracteres.`;
  if (values.jobTitle.trim().length > EMPLOYEE_JOB_TITLE_MAX) errors.jobTitle = `El puesto no puede superar ${EMPLOYEE_JOB_TITLE_MAX} caracteres.`;
  const department = values.usaliDepartment.trim();
  if (department !== "" && !(HR_USALI_DEPARTMENTS as readonly string[]).includes(department)) errors.usaliDepartment = "Elige un departamento USALI de la lista.";
  const gender = values.gender.trim();
  if (gender !== "" && !(EMPLOYEE_GENDERS as readonly string[]).includes(gender)) errors.gender = "Elige un valor de la lista.";

  const email = values.email.trim();
  if (email !== "") {
    if (email.length > EMPLOYEE_EMAIL_MAX) errors.email = `El correo no puede superar ${EMPLOYEE_EMAIL_MAX} caracteres.`;
    else if (!EMAIL.test(email)) errors.email = "El correo electrónico no tiene un formato válido.";
  }
  if (values.phone.trim().length > EMPLOYEE_PHONE_MAX) errors.phone = `El teléfono no puede superar ${EMPLOYEE_PHONE_MAX} caracteres.`;
  const naf = normaliseNaf(values.socialSecurityNumber);
  if (naf !== "" && !NAF.test(naf)) errors.socialSecurityNumber = "El número de afiliación debe tener 12 dígitos.";
  const iban = normaliseIban(values.iban);
  if (iban !== "" && (iban.length > EMPLOYEE_IBAN_MAX || !IBAN.test(iban))) errors.iban = "El IBAN no tiene un formato válido (país, dos dígitos de control y la cuenta).";
  return errors;
}

export function isFormValid(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).every((error) => error === undefined);
}

/** Form → strict body of POST /hr/employees: optional fields only when filled (never ""), NIF / IBAN / NAF normalised. */
export function toEmployeeBody(values: EmployeeFormValues, legalEntityId: string): CreateEmployeeRequest {
  const body: CreateEmployeeRequest = {
    legalEntityId,
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    taxId: normaliseTaxId(values.taxId),
    hiredAt: values.hiredAt.trim()
  };
  const employeeNumber = values.employeeNumber.trim();
  if (employeeNumber) body.employeeNumber = employeeNumber;
  const primaryPropertyId = values.primaryPropertyId.trim();
  if (primaryPropertyId) body.primaryPropertyId = primaryPropertyId;
  const department = values.usaliDepartment.trim();
  if (department && (HR_USALI_DEPARTMENTS as readonly string[]).includes(department)) body.usaliDepartment = department as HrUsaliDepartment;
  const jobTitle = values.jobTitle.trim();
  if (jobTitle) body.jobTitle = jobTitle;
  const gender = values.gender.trim();
  if (gender && (EMPLOYEE_GENDERS as readonly string[]).includes(gender)) body.gender = gender as EmployeeGender;
  if (values.status === "leave") body.status = "leave";
  const email = values.email.trim();
  if (email) body.email = email;
  const phone = values.phone.trim();
  if (phone) body.phone = phone;
  const naf = normaliseNaf(values.socialSecurityNumber);
  if (naf) body.socialSecurityNumber = naf;
  const iban = normaliseIban(values.iban);
  if (iban) body.iban = iban;
  return body;
}

type PatchSource = Pick<EmployeeDetailDto, "firstName" | "lastName" | "employeeNumber" | "hiredAt" | "primaryPropertyId" | "usaliDepartment" | "jobTitle" | "gender" | "status">;

/**
 * Form → body of PATCH /hr/employees/:id with ONLY what differs from the
 * detail; an emptied optional field travels as `null`; the encrypted fields
 * travel only when typed (the form never holds their current value). Returns
 * null when nothing changed (the API refuses an empty PATCH).
 */
export function toEmployeePatch(values: EmployeeFormValues, original: PatchSource): PatchEmployeeRequest | null {
  const body: PatchEmployeeRequest = {};
  const firstName = values.firstName.trim();
  if (firstName && firstName !== original.firstName) body.firstName = firstName;
  const lastName = values.lastName.trim();
  if (lastName && lastName !== original.lastName) body.lastName = lastName;
  const employeeNumber = values.employeeNumber.trim();
  if (employeeNumber && employeeNumber !== original.employeeNumber) body.employeeNumber = employeeNumber;
  const hiredAt = values.hiredAt.trim();
  if (hiredAt && hiredAt !== original.hiredAt) body.hiredAt = hiredAt;
  const primaryPropertyId = values.primaryPropertyId.trim() || null;
  if (primaryPropertyId !== (original.primaryPropertyId ?? null)) body.primaryPropertyId = primaryPropertyId;
  const department = values.usaliDepartment.trim() || null;
  if (department !== (original.usaliDepartment ?? null)) body.usaliDepartment = department as HrUsaliDepartment | null;
  const jobTitle = values.jobTitle.trim() || null;
  if (jobTitle !== (original.jobTitle ?? null)) body.jobTitle = jobTitle;
  const gender = values.gender.trim() || null;
  if (gender !== (original.gender ?? null)) body.gender = gender as EmployeeGender | null;
  const status = values.status === "leave" ? "leave" : "active";
  if (status !== original.status && original.status !== "inactive") body.status = status;
  const taxId = normaliseTaxId(values.taxId);
  if (taxId) body.taxId = taxId;
  const email = values.email.trim();
  if (email) body.email = email;
  const phone = values.phone.trim();
  if (phone) body.phone = phone;
  const naf = normaliseNaf(values.socialSecurityNumber);
  if (naf) body.socialSecurityNumber = naf;
  const iban = normaliseIban(values.iban);
  if (iban) body.iban = iban;
  return Object.keys(body).length > 0 ? body : null;
}

// ---------------------------------------------------------------------------
// Contrato (POST /payroll/contracts · RRHH-2)
// ---------------------------------------------------------------------------

export const CONTRACT_PAY_COUNT_MIN = 12;
export const CONTRACT_PAY_COUNT_MAX = 16;
export const CONTRACT_WEEKLY_HOURS_MAX = 60;
export const CONTRIBUTION_GROUP_MIN = 1;
export const CONTRIBUTION_GROUP_MAX = 11;

export type ContractFormValues = {
  staffProfileId: string;
  agreementId: string;
  contractType: string;
  startDate: string;
  endDate: string;
  grossSalary: string;
  /** 12-16 (CocoaStepper); "" = let the API derive it from the agreement. */
  payCount: string;
  weeklyHours: string;
  partTimePct: string;
  fixedDiscontinuous: boolean;
  /** 1-11 (CocoaStepper); "" = not informed. */
  contributionGroup: string;
};

export type ContractFormErrors = Partial<Record<keyof ContractFormValues, string>>;

export const EMPTY_CONTRACT_FORM: ContractFormValues = Object.freeze({
  staffProfileId: "",
  agreementId: "",
  contractType: "indefinido",
  startDate: "",
  endDate: "",
  grossSalary: "",
  payCount: "",
  weeklyHours: "",
  partTimePct: "100",
  fixedDiscontinuous: false,
  contributionGroup: ""
});

export function newContractForm(input: { today: string; staffProfileId?: string | null }): ContractFormValues {
  return { ...EMPTY_CONTRACT_FORM, startDate: input.today, staffProfileId: input.staffProfileId ?? "" };
}

export function validateContractForm(values: ContractFormValues): ContractFormErrors {
  const errors: ContractFormErrors = {};
  if (values.staffProfileId.trim() === "") errors.staffProfileId = "Elige la ficha de personal del centro.";
  if (!HR_CONTRACT_TYPES.includes(values.contractType)) errors.contractType = "Elige una modalidad de contrato.";
  const startDate = values.startDate.trim();
  if (startDate === "") errors.startDate = "Indica la fecha de inicio.";
  else if (!isIsoDay(startDate)) errors.startDate = "La fecha de inicio debe ser una fecha válida (AAAA-MM-DD).";
  const endDate = values.endDate.trim();
  if (endDate !== "") {
    if (!isIsoDay(endDate)) errors.endDate = "La fecha de fin debe ser una fecha válida (AAAA-MM-DD).";
    else if (startDate !== "" && endDate < startDate) errors.endDate = "La fecha de fin debe ser igual o posterior al inicio.";
  }
  const gross = parseDecimal(values.grossSalary);
  if (values.grossSalary.trim() === "") errors.grossSalary = "Indica el salario bruto mensual.";
  else if (gross === null || gross < 0) errors.grossSalary = "El bruto mensual debe ser un importe mayor o igual que 0 con dos decimales como máximo.";
  const payCount = values.payCount.trim();
  if (payCount !== "") {
    const n = Number(payCount);
    if (!Number.isInteger(n) || n < CONTRACT_PAY_COUNT_MIN || n > CONTRACT_PAY_COUNT_MAX) errors.payCount = `Las pagas anuales deben estar entre ${CONTRACT_PAY_COUNT_MIN} y ${CONTRACT_PAY_COUNT_MAX}.`;
  }
  const hours = values.weeklyHours.trim();
  if (hours !== "") {
    const h = parseDecimal(hours);
    if (h === null || h <= 0 || h > CONTRACT_WEEKLY_HOURS_MAX) errors.weeklyHours = `La jornada semanal debe estar entre 0 y ${CONTRACT_WEEKLY_HOURS_MAX} horas.`;
  }
  const pct = values.partTimePct.trim();
  if (pct !== "") {
    const p = parseDecimal(pct);
    if (p === null || p <= 0 || p > 100) errors.partTimePct = "El porcentaje de jornada debe estar entre 0 y 100.";
  }
  const group = values.contributionGroup.trim();
  if (group !== "") {
    const g = Number(group);
    if (!Number.isInteger(g) || g < CONTRIBUTION_GROUP_MIN || g > CONTRIBUTION_GROUP_MAX) errors.contributionGroup = `El grupo de cotización debe ser un entero entre ${CONTRIBUTION_GROUP_MIN} y ${CONTRIBUTION_GROUP_MAX}.`;
  }
  return errors;
}

/** Form → strict body of POST /payroll/contracts (RRHH-2 fields included); empty optionals are omitted. */
export function toContractBody(values: ContractFormValues, propertyId: string | null | undefined): CreateEmployeeContractRequest {
  const body: CreateEmployeeContractRequest = {
    staffProfileId: values.staffProfileId.trim(),
    contractType: values.contractType,
    startDate: values.startDate.trim(),
    grossSalary: decimalBody(values.grossSalary)
  };
  if (propertyId) body.propertyId = propertyId;
  const endDate = values.endDate.trim();
  if (endDate) body.endDate = endDate;
  const payCount = values.payCount.trim();
  if (payCount) body.payCount = Number(payCount);
  const agreementId = values.agreementId.trim();
  if (agreementId) body.agreementId = agreementId;
  const hours = values.weeklyHours.trim();
  if (hours) body.weeklyHours = decimalBody(hours);
  const pct = values.partTimePct.trim();
  if (pct) body.partTimePct = decimalBody(pct);
  if (values.fixedDiscontinuous || values.contractType === "fijo_discontinuo") body.fixedDiscontinuous = true;
  const group = values.contributionGroup.trim();
  if (group) body.contributionGroup = Number(group);
  return body;
}

/**
 * The agreement chosen fills what it fixes: pays (12 + extra pays) and the
 * full-time weekly hours — only over empty fields, never over what the person
 * typed. Without rules (no agreement) the form keeps its values.
 */
export function applyAgreementRules(values: ContractFormValues, rules: Partial<HrAgreementRuleValues> | null | undefined): ContractFormValues {
  if (!rules) return values;
  const defaults = contractDefaultsFromRules(rules);
  return {
    ...values,
    payCount: values.payCount.trim() === "" ? String(defaults.payCount) : values.payCount,
    weeklyHours: values.weeklyHours.trim() === "" ? String(defaults.weeklyHours) : values.weeklyHours
  };
}

// ---------------------------------------------------------------------------
// Baja (POST /hr/employees/:id/terminate)
// ---------------------------------------------------------------------------

export type TerminateFormValues = {
  terminatedAt: string;
  reason: string;
};

export type TerminateFormErrors = Partial<Record<keyof TerminateFormValues, string>>;

export function newTerminateForm(today: string): TerminateFormValues {
  return { terminatedAt: today, reason: "" };
}

export function validateTerminateForm(values: TerminateFormValues, hiredAt: string | null | undefined): TerminateFormErrors {
  const errors: TerminateFormErrors = {};
  const terminatedAt = values.terminatedAt.trim();
  if (terminatedAt === "") errors.terminatedAt = "Indica la fecha de baja.";
  else if (!isIsoDay(terminatedAt)) errors.terminatedAt = "La fecha de baja debe ser una fecha válida (AAAA-MM-DD).";
  else if (hiredAt && terminatedAt < hiredAt) errors.terminatedAt = "La fecha de baja no puede ser anterior a la fecha de alta.";
  const reason = values.reason.trim();
  if (reason !== "" && !(HR_END_REASONS as readonly string[]).includes(reason)) errors.reason = "Elige una causa de la lista.";
  return errors;
}

export function toTerminateBody(values: TerminateFormValues): TerminateEmployeeRequest {
  const body: TerminateEmployeeRequest = {};
  const terminatedAt = values.terminatedAt.trim();
  if (terminatedAt) body.terminatedAt = terminatedAt;
  const reason = values.reason.trim();
  if (reason && (HR_END_REASONS as readonly string[]).includes(reason)) body.reason = reason as HrEndReason;
  return body;
}
