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

import type { PayrollExportFormat, PayrollExportResult, PayrollPeriodRecord } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActiveOrganizationId, getActivePropertyId } from "./activeProperty";
import { compactQuery, financeErrorMessage } from "./finance-contracts";

export type { PayrollExportFormat, PayrollExportResult, PayrollPeriodRecord } from "@hotelos/shared";

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

export function payrollErrorMessage(error: unknown, fallback = "No se pudo completar la operación de nóminas."): string {
  return financeErrorMessage(error, fallback);
}
