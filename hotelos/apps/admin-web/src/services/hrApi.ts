// RRHH · plantilla (Tanda RRHH · lote RRHH-8). Typed client of the `/hr/*`
// routes of apps/api/src/modules/hr/hr.routes.ts (esquemas `.strict()` en
// schemas/hr.schemas.ts → 400 en español nombrando la clave; DTOs en
// packages/shared/src/hr-types.ts) y del alta de contrato de RRHH-2:
//
//   GET   /hr/employees?propertyId&legalEntityId&status&fixedDiscontinuous&search   listEmployees        hr.employee.read   (sin PII)
//   GET   /hr/employees/:id[?pii=1]                                                 getEmployee          hr.employee.read   (`pii=1` descifra
//                                                                                   solo `piiFields` y audita HR_PII_READ; «Mostrar» explícito)
//   POST  /hr/employees { legalEntityId, firstName, lastName, taxId, hiredAt, … }   createEmployee       hr.employee.manage (201; 409 HR_EMPLOYEE_TAXID_DUPLICATE)
//   PATCH /hr/employees/:id { ≥ 1 campo }                                           patchEmployee        hr.employee.manage
//   POST  /hr/employees/:id/terminate { terminatedAt?, reason? }                    terminateEmployee    hr.employee.manage (critical: cierra
//                                                                                   contratos, desactiva fichas y revoca accesos)
//   GET   /hr/agreements                                                            listAgreements       hr.employee.read
//   GET   /hr/agreements/:id/rules?asOf                                             listAgreementRules   hr.employee.read
//   POST  /payroll/contracts { staffProfileId, contractType, startDate, grossSalary,
//         agreementId?, weeklyHours?, partTimePct?, fixedDiscontinuous?, contributionGroup?, payCount? … }
//                                                                                   createEmployeeContract payroll.manage (RRHH-2; sin payCount → 12 + pagas extra del convenio)
//   GET   /payroll/staff-profiles?propertyId                                        listEmployeeStaffProfiles (fichas de centro que enlazan el expediente)
//
// Errors arrive as details.code ∈ HR_ERROR_CODES (HR_TAXID_INVALID ·
// HR_EMPLOYEE_TAXID_DUPLICATE · HR_EMPLOYEE_TERMINATED · HR_PII_KEY_MISSING …)
// mapped by hrErrorMessage (services/hr-contracts.ts). Never `fetch` here:
// everything goes through apiRequest (api-client).

import type {
  AgreementRuleDto,
  CollectiveAgreementDto,
  EmployeeDetailDto,
  EmployeeGender,
  EmployeeListQueryDto,
  EmployeeSummaryDto,
  HrEndReason,
  HrUsaliDepartment
} from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { agreementRulesQuery, employeeDetailQuery, employeeListQuery, hrErrorMessage } from "./hr-contracts";
import { listStaffProfiles, type StaffProfileRecord } from "./payrollApi";

export type { AgreementRuleDto, CollectiveAgreementDto, EmployeeDetailDto, EmployeeListQueryDto, EmployeeSummaryDto, StaffProfileRecord };
export { hrErrorMessage };

const enc = encodeURIComponent;

// ---- Expediente -------------------------------------------------------------------

/** Body of POST /hr/employees (CreateEmployeeSchema): the PII travels ONLY here and in the PATCH, never in a query. */
export type CreateEmployeeRequest = {
  legalEntityId: string;
  firstName: string;
  lastName: string;
  /** NIF / NIE with a valid control letter (400 HR_TAXID_INVALID otherwise; 409 HR_EMPLOYEE_TAXID_DUPLICATE per sociedad). */
  taxId: string;
  /** YYYY-MM-DD. */
  hiredAt: string;
  /** Omitted → the API numbers the file (EMP-0001 …). */
  employeeNumber?: string;
  userId?: string;
  socialSecurityNumber?: string;
  email?: string;
  phone?: string;
  iban?: string;
  gender?: EmployeeGender;
  primaryPropertyId?: string;
  usaliDepartment?: HrUsaliDepartment;
  jobTitle?: string;
  /** `active` (default) or `leave`; the termination goes through terminateEmployee. */
  status?: "active" | "leave";
};

/** Body of PATCH /hr/employees/:id: partial, at least one key; `null` clears an optional field. */
export type PatchEmployeeRequest = Partial<{
  employeeNumber: string | null;
  userId: string | null;
  firstName: string;
  lastName: string;
  taxId: string;
  socialSecurityNumber: string | null;
  email: string | null;
  phone: string | null;
  iban: string | null;
  gender: EmployeeGender | null;
  primaryPropertyId: string | null;
  usaliDepartment: HrUsaliDepartment | null;
  jobTitle: string | null;
  status: "active" | "leave" | null;
  hiredAt: string;
}>;

export type TerminateEmployeeRequest = {
  /** YYYY-MM-DD; default today; never before hiredAt. */
  terminatedAt?: string;
  reason?: HrEndReason;
};

export type TerminateEmployeeResult = {
  employee: EmployeeDetailDto;
  deactivatedStaffProfileIds: string[];
  deactivatedContractIds: string[];
  revokedAssignmentIds: string[];
};

/** Files of the sociedad (or of one centre), without PII; search by name, surname or employee number. */
export function listEmployees(query: EmployeeListQueryDto = {}): Promise<EmployeeSummaryDto[]> {
  return apiRequest<EmployeeSummaryDto[]>("/hr/employees", { query: employeeListQuery(query) });
}

/** One file; `pii: true` only from the explicit «Mostrar» of the drawer (the API audits HR_PII_READ per field). */
export function getEmployee(employeeId: string, options: { pii?: boolean } = {}): Promise<EmployeeDetailDto> {
  return apiRequest<EmployeeDetailDto>(`/hr/employees/${enc(employeeId)}`, { query: employeeDetailQuery(options.pii === true) });
}

/** Strict body: 201 with the detail (PII null). */
export function createEmployee(body: CreateEmployeeRequest): Promise<EmployeeDetailDto> {
  return apiRequest<EmployeeDetailDto>("/hr/employees", { method: "POST", body });
}

export function patchEmployee(employeeId: string, body: PatchEmployeeRequest): Promise<EmployeeDetailDto> {
  return apiRequest<EmployeeDetailDto>(`/hr/employees/${enc(employeeId)}`, { method: "PATCH", body });
}

/** Critical: closes the active contracts, deactivates the fichas and revokes the RBAC assignments of the linked user. 409 HR_EMPLOYEE_TERMINATED when already terminated. */
export function terminateEmployee(employeeId: string, body: TerminateEmployeeRequest = {}): Promise<TerminateEmployeeResult> {
  return apiRequest<TerminateEmployeeResult>(`/hr/employees/${enc(employeeId)}/terminate`, { method: "POST", body });
}

// ---- Convenios ------------------------------------------------------------------

export function listAgreements(): Promise<CollectiveAgreementDto[]> {
  return apiRequest<CollectiveAgreementDto[]>("/hr/agreements");
}

/** Rules in force on `asOf` (default today): one version per key. */
export function listAgreementRules(agreementId: string, asOf?: string | null): Promise<AgreementRuleDto[]> {
  return apiRequest<AgreementRuleDto[]>(`/hr/agreements/${enc(agreementId)}/rules`, { query: agreementRulesQuery(asOf) });
}

// ---- Contratos (POST /payroll/contracts · RRHH-2) ---------------------------------

export type CreateEmployeeContractRequest = {
  /** Ficha de centro (StaffProfile) enlazada al expediente (EmployeeSummaryDto.staffProfileIds). */
  staffProfileId: string;
  propertyId?: string;
  contractType: string;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate?: string;
  /** «1800.00». */
  grossSalary: string;
  /** 12-16; omitted → 12 + extra_pay_count del convenio. */
  payCount?: number;
  /** Prevails over the centre's agreement (404 HR_AGREEMENT_NOT_FOUND if foreign). */
  agreementId?: string;
  /** 0 < h ≤ 60, «40» / «25.5». */
  weeklyHours?: string;
  /** 0 < % ≤ 100 (100 = jornada completa). */
  partTimePct?: string;
  fixedDiscontinuous?: boolean;
  /** 1-11. */
  contributionGroup?: number;
};

export type EmployeeContractRecord = {
  id: string;
  staffProfileId: string;
  propertyId?: string;
  contractType: string;
  startDate: string;
  endDate?: string;
  grossSalary: number;
  payCount: number;
  agreementId?: string;
  weeklyHours?: number;
  partTimePct?: number;
  fixedDiscontinuous: boolean;
  contributionGroup?: number;
  active: boolean;
  /** Avisos del alta (nunca bloquean; RF-05 / RF-07): HR_STAFFING_EXCEEDED del position control, segundo contrato activo. */
  warnings?: string[];
};

/** Strict body (400 names the key); the centre defaults to the active property when the body carries none. */
export function createEmployeeContract(body: CreateEmployeeContractRequest): Promise<EmployeeContractRecord> {
  return apiRequest<EmployeeContractRecord>("/payroll/contracts", { method: "POST", body: { ...body, propertyId: body.propertyId ?? getActivePropertyId() } });
}

/** Fichas of a centre (or of every centre in scope with `null`), to label and pick the ficha of a new contract. */
export function listEmployeeStaffProfiles(propertyId: string | null | undefined): Promise<StaffProfileRecord[]> {
  return listStaffProfiles(propertyId ?? null);
}
