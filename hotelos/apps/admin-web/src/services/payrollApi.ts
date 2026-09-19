// Nóminas (Tanda 6 · lote nav-services). Typed client of the payroll routes:
// legacy list/create routes of server.ts plus the Tanda 6 routes of
// apps/api/src/modules/treasury/treasury.routes.ts (export that mutates, pay).
// Contracts: packages/shared/src/treasury-types.ts (PayrollPeriodRecord ·
// PayrollExportResult) and apps/api/src/schemas/payroll-commissions.schemas.ts
// (`contractType` ∈ 6 modalidades; strict bodies → 400 in Spanish naming the key).
//
//   GET  /payroll/contracts?propertyId · POST /payroll/contracts · POST /payroll/contracts/:id/deactivate
//   GET  /payroll/periods?organizationId&propertyId · POST /payroll/periods · POST /payroll/periods/:id/calculate
//   GET  /payroll/periods/:id · GET /payroll/periods/:id/slips
//   POST /payroll/periods/:id/export { format }   exportPayrollPeriod (audited, marks exported)   payroll.manage
//   GET  /payroll/periods/:id/export?format=       previewPayrollExport (read-only)
//   POST /payroll/periods/:id/pay { paidAt, bankLedgerCode, reference }   payPayrollPeriod (D 465 / H 572; crítico)
//
// Tanda 6c · coste de personal importado (apps/api/src/modules/payroll/cost-import.routes.ts;
// contract packages/shared/src/payroll-cost-types.ts; design docs/design/FINANZAS-COSTE-PERSONAL.md §5):
//   POST /payroll/cost-imports/preview { format, content, mapping?, replace? }   previewPayrollCostImport (never writes)   payroll.manage
//   POST /payroll/cost-imports { …preview, fileName?, source?, post?, notes? }    createPayrollCostImport (201; posts unless post=false)
//   GET  /payroll/cost-imports?status&from&to&limit                                listPayrollCostImports   payroll.read
//   GET  /payroll/cost-imports/:id                                                 getPayrollCostImport (líneas, referencias, asientos)
//   POST /payroll/cost-imports/:id/post { replace? }                               postPayrollCostImport (draft → posted)
//   POST /payroll/cost-imports/:id/reverse { reason, entryDate? }                  reversePayrollCostImport (crítico; idempotente)
//   GET  /payroll/cost-report?from&to[&propertyId][&group]                         getPayrollCostReport   payroll.read
// Errors arrive as details.code (PAYROLL_IMPORT_DUPLICATE · PAYROLL_IMPORT_OVERLAP ·
// PAYROLL_IMPORT_CENTRE_UNMAPPED …) mapped by payrollErrorMessage through finance-contracts.
//
// FIX-1 · F10 · fichas de personal (apps/api/src/modules/payroll/staff-profiles.routes.ts):
//   GET  /payroll/staff-profiles?propertyId=                                     listStaffProfiles   payroll.read
//   POST /payroll/staff-profiles { propertyId, userId, employeeCode?, departmentId?, employmentType?, hourlyCost? }
//                                                                                createStaffProfile (201; 409 STAFF_PROFILE_EXISTS,
//                                                                                400 STAFF_PROFILE_DEPARTMENT_MISMATCH, 404 «Usuario no encontrado.»)   payroll.manage
//   GET  /backoffice/properties/:id/departments                                  listPropertyDepartments   property.configure
// The «Persona» picker of the drawer reads GET /rbac/users through services/rbacApi (listUsersInScope).

import type {
  PayrollCostImportCreateBody,
  PayrollCostImportCreateResult,
  PayrollCostImportDetail,
  PayrollCostImportListQuery,
  PayrollCostImportPostBody,
  PayrollCostImportPreview,
  PayrollCostImportPreviewBody,
  PayrollCostImportRecord,
  PayrollCostImportReverseBody,
  PayrollCostReport,
  PayrollCostReportQuery,
  PayrollExportFormat,
  PayrollExportResult,
  PayrollPeriodRecord
} from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActiveOrganizationId, getActivePropertyId } from "./activeProperty";
import { compactQuery, financeErrorMessage, payrollCostImportListQuery, payrollCostReportQuery } from "./finance-contracts";

export type {
  PayrollCostImportCreateBody,
  PayrollCostImportCreateResult,
  PayrollCostImportDetail,
  PayrollCostImportListQuery,
  PayrollCostImportPostBody,
  PayrollCostImportPreview,
  PayrollCostImportPreviewBody,
  PayrollCostImportRecord,
  PayrollCostImportReverseBody,
  PayrollCostReport,
  PayrollCostReportQuery,
  PayrollExportFormat,
  PayrollExportResult,
  PayrollPeriodRecord
} from "@hotelos/shared";

const enc = encodeURIComponent;

export const PAYROLL_CONTRACT_TYPES = ["indefinido", "temporal", "fijo_discontinuo", "practicas", "formacion", "sustitucion"] as const;
export type PayrollContractType = (typeof PAYROLL_CONTRACT_TYPES)[number];

export const PAYROLL_CONTRACT_TYPE_LABELS_ES: Readonly<Record<PayrollContractType, string>> = Object.freeze({
  indefinido: "Indefinido",
  temporal: "Temporal",
  fijo_discontinuo: "Fijo discontinuo",
  practicas: "Prácticas",
  formacion: "Formación",
  sustitucion: "Sustitución"
});

export type PayrollPayFrequency = "monthly" | "biweekly" | "weekly";

export type PayrollContractRecord = {
  id: string;
  staffProfileId: string;
  propertyId?: string;
  organizationId: string;
  contractType: PayrollContractType | string;
  startDate: string;
  endDate?: string;
  grossSalary: number;
  payFrequency: PayrollPayFrequency | string;
  payCount: number;
  irpfRatePct?: number;
  socialSecurityCategory?: string;
  costCenterId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreatePayrollContractRequest = {
  staffProfileId: string;
  propertyId?: string;
  contractType: PayrollContractType;
  startDate: string;
  endDate?: string;
  grossSalary: number | string;
  payFrequency?: PayrollPayFrequency;
  /** 12-16 pagas anuales. */
  payCount?: number;
  irpfRatePct?: number | string;
  socialSecurityCategory?: string;
  costCenterId?: string;
};

export type PayrollSlipRecord = {
  id: string;
  periodId: string;
  staffProfileId: string;
  contractId?: string;
  grossSalary: number;
  irpfRetention: number;
  ssEmployee: number;
  ssEmployer: number;
  netSalary: number;
  daysWorked: number;
  documentObjectKey?: string;
  status: "draft" | "issued" | "paid";
  createdAt: string;
  lines: Array<{ id: string; slipId: string; lineType: "earning" | "deduction" | "employer_cost"; code: string; description?: string; amount: number }>;
};

// ---- Fichas de personal (FIX-1 · F10) ----------------------------------------------

export const STAFF_EMPLOYMENT_TYPES = ["indefinido", "temporal", "fijo_discontinuo", "practicas", "otro"] as const;
export type StaffEmploymentType = (typeof STAFF_EMPLOYMENT_TYPES)[number];

export type StaffProfileRecord = {
  id: string;
  propertyId: string;
  userId: string;
  employeeCode: string | null;
  departmentId: string | null;
  departmentName: string | null;
  employmentType: StaffEmploymentType | string | null;
  /** «12.50» (dos decimales) o null. */
  hourlyCost: string | null;
  active: boolean;
  createdAt: string;
  userFullName: string | null;
  userEmail: string | null;
};

export type CreateStaffProfileRequest = {
  propertyId: string;
  userId: string;
  employeeCode?: string;
  departmentId?: string;
  employmentType?: StaffEmploymentType;
  /** Número o texto con coma («12,50»); ≥ 0, dos decimales como máximo. */
  hourlyCost?: number | string;
};

export type PropertyDepartmentRecord = {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  description?: string;
  active: boolean;
};

/** Fichas del centre (or of every centre within scope when `propertyId` is empty), person and department resolved. */
export function listStaffProfiles(propertyId: string | null | undefined = getActivePropertyId()): Promise<StaffProfileRecord[]> {
  return apiRequest<StaffProfileRecord[]>("/payroll/staff-profiles", { query: compactQuery({ propertyId: propertyId ?? undefined }) });
}

/** Strict body: 201 with the profile; 409 STAFF_PROFILE_EXISTS for an active duplicate (userId, propertyId). */
export function createStaffProfile(body: CreateStaffProfileRequest): Promise<StaffProfileRecord> {
  return apiRequest<StaffProfileRecord>("/payroll/staff-profiles", { method: "POST", body });
}

/** Departments of a centre (property.configure): without the grant the drawer keeps the picker optional and empty. */
export function listPropertyDepartments(propertyId: string): Promise<PropertyDepartmentRecord[]> {
  return apiRequest<PropertyDepartmentRecord[]>(`/backoffice/properties/${enc(propertyId)}/departments`);
}

// ---- Contratos ------------------------------------------------------------------

export function listPayrollContracts(propertyId = getActivePropertyId()): Promise<PayrollContractRecord[]> {
  return apiRequest<PayrollContractRecord[]>("/payroll/contracts", { query: compactQuery({ propertyId }) });
}

/** Strict body: an unknown key or an off-list `contractType` is a 400 whose message names the key. */
export function createPayrollContract(body: CreatePayrollContractRequest): Promise<PayrollContractRecord> {
  return apiRequest<PayrollContractRecord>("/payroll/contracts", { method: "POST", body: { ...body, propertyId: body.propertyId ?? getActivePropertyId() } });
}

export function deactivatePayrollContract(contractId: string): Promise<PayrollContractRecord> {
  return apiRequest<PayrollContractRecord>(`/payroll/contracts/${enc(contractId)}/deactivate`, { method: "POST" });
}

// ---- Periodos ---------------------------------------------------------------------

export function listPayrollPeriods(input: { organizationId?: string; propertyId?: string } = {}): Promise<PayrollPeriodRecord[]> {
  return apiRequest<PayrollPeriodRecord[]>("/payroll/periods", {
    query: compactQuery({ organizationId: input.organizationId ?? getActiveOrganizationId(), propertyId: input.propertyId ?? getActivePropertyId() })
  });
}

export function createPayrollPeriod(body: { periodCode: string; organizationId?: string; propertyId?: string }): Promise<PayrollPeriodRecord> {
  return apiRequest<PayrollPeriodRecord>("/payroll/periods", {
    method: "POST",
    body: { organizationId: body.organizationId ?? getActiveOrganizationId(), propertyId: body.propertyId ?? getActivePropertyId(), periodCode: body.periodCode }
  });
}

/** Recalculates the slips; earlier accrual entries are reversed before posting again (never duplicated). */
export function calculatePayrollPeriod(periodId: string): Promise<PayrollPeriodRecord> {
  return apiRequest<PayrollPeriodRecord>(`/payroll/periods/${enc(periodId)}/calculate`, { method: "POST" });
}

export function getPayrollPeriod(periodId: string): Promise<PayrollPeriodRecord> {
  return apiRequest<PayrollPeriodRecord>(`/payroll/periods/${enc(periodId)}`);
}

export function listPayrollSlips(periodId: string): Promise<PayrollSlipRecord[]> {
  return apiRequest<PayrollSlipRecord[]>(`/payroll/periods/${enc(periodId)}/slips`);
}

// ---- Exportación y pago ---------------------------------------------------------------

/** Read-only preview of the export file (the legacy GET); does not mark the period. */
export function previewPayrollExport(periodId: string, format: PayrollExportFormat): Promise<PayrollExportResult> {
  return apiRequest<PayrollExportResult>(`/payroll/periods/${enc(periodId)}/export`, { query: { format } });
}

/** Audited export that marks the period `exported`; `validateWithAdvisor` flags layouts not yet checked with the gestoría. */
export function exportPayrollPeriod(periodId: string, format: PayrollExportFormat): Promise<PayrollExportResult> {
  return apiRequest<PayrollExportResult>(`/payroll/periods/${enc(periodId)}/export`, { method: "POST", body: { format } });
}

export type PayPayrollPeriodRequest = { paidAt?: string; bankLedgerCode?: string; reference?: string };

/** Payment entry D 465 / H 572 (or `bankLedgerCode`). Critical; PAYROLL_PERIOD_NOT_CALCULATED · PAYROLL_PERIOD_PAID · PAYROLL_NOTHING_TO_PAY. */
export function payPayrollPeriod(periodId: string, body: PayPayrollPeriodRequest = {}): Promise<PayrollPeriodRecord> {
  return apiRequest<PayrollPeriodRecord>(`/payroll/periods/${enc(periodId)}/pay`, { method: "POST", body });
}

// ---- Coste de personal importado (Tanda 6c) ------------------------------------------

/** Parses and maps the file without writing anything: rows, totals by centre × month, unmapped labels with suggestions, duplicate / overlaps, `canPost`. */
export function previewPayrollCostImport(body: PayrollCostImportPreviewBody): Promise<PayrollCostImportPreview> {
  return apiRequest<PayrollCostImportPreview>("/payroll/cost-imports/preview", { method: "POST", body: { ...body, organizationId: body.organizationId ?? getActiveOrganizationId() } });
}

/** Creates the lot and (unless `post: false`) posts one entry per centre × month in the same transaction; `replace: true` reverses the overlapping lots ENTIRELY first. 409 PAYROLL_IMPORT_DUPLICATE · PAYROLL_IMPORT_OVERLAP without `replace`. */
export function createPayrollCostImport(body: PayrollCostImportCreateBody): Promise<PayrollCostImportCreateResult> {
  return apiRequest<PayrollCostImportCreateResult>("/payroll/cost-imports", { method: "POST", body: { ...body, organizationId: body.organizationId ?? getActiveOrganizationId() } });
}

/** Lots whose centres are all within the caller's scope, newest first (no lines). */
export function listPayrollCostImports(query: PayrollCostImportListQuery = {}): Promise<PayrollCostImportRecord[]> {
  return apiRequest<PayrollCostImportRecord[]>("/payroll/cost-imports", { query: payrollCostImportListQuery({ ...query, organizationId: query.organizationId ?? getActiveOrganizationId() }) });
}

/** The lot with its aggregated lines, references, entries and reversals (opaque 404 outside the organisation or the scope). */
export function getPayrollCostImport(importId: string): Promise<PayrollCostImportDetail> {
  return apiRequest<PayrollCostImportDetail>(`/payroll/cost-imports/${enc(importId)}`);
}

/** Posts a draft lot (409 PAYROLL_IMPORT_ALREADY_POSTED · PAYROLL_IMPORT_REVERSED). */
export function postPayrollCostImport(importId: string, body: PayrollCostImportPostBody = {}): Promise<PayrollCostImportCreateResult> {
  return apiRequest<PayrollCostImportCreateResult>(`/payroll/cost-imports/${enc(importId)}/post`, { method: "POST", body });
}

/** Reverses every entry of the lot (only those; the rest of the journal is never touched). Critical; idempotent (`alreadyReversed`). */
export function reversePayrollCostImport(importId: string, body: PayrollCostImportReverseBody): Promise<PayrollCostImportRecord> {
  return apiRequest<PayrollCostImportRecord>(`/payroll/cost-imports/${enc(importId)}/reverse`, { method: "POST", body });
}

/** Centres × months report: gross, employer SS, total, headcount, cost per employee, labor % over ledger and reference sales, cost per available room, by group and USALI department. */
export function getPayrollCostReport(query: PayrollCostReportQuery): Promise<PayrollCostReport> {
  return apiRequest<PayrollCostReport>("/payroll/cost-report", { query: payrollCostReportQuery(query) });
}

export function payrollErrorMessage(error: unknown, fallback = "No se pudo completar la operación de nóminas."): string {
  return financeErrorMessage(error, fallback);
}
