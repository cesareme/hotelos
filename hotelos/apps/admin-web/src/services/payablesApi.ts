// Proveedores, facturas recibidas y gastos (Tanda 6 · lote nav-services).
// Typed client of apps/api/src/modules/payables/payables.routes.ts on
// packages/shared/src/payables-types.ts (money as strings, dates AAAA-MM-DD,
// PayablesErrorCode on 4xx).
//
//   GET|POST  /organizations/:organizationId/payables/suppliers            listSuppliers · createSupplier     procurement.read · procurement.manage
//   GET|PATCH /organizations/:organizationId/payables/suppliers/:supplierId getSupplier · updateSupplier
//   GET|POST  /properties/:propertyId/payables/supplier-bills              listSupplierBills · createSupplierBill  accounting.reports.read · procurement.manage
//   GET|PATCH /properties/:propertyId/payables/supplier-bills/:billId      getSupplierBill · updateSupplierBill
//   POST      …/supplier-bills/:billId/approve|post|pay|cancel             approve · post · pay · cancel (post/pay/cancel: accounting.journal.post, crítico)
//   GET       …/supplier-bills/:billId/attachment                          getSupplierBillAttachment
//   GET       /properties/:propertyId/payables/aging?asOf=                 getPayablesAging
//   GET|POST  /properties/:propertyId/payables/expenses                    listExpenses · createExpense
//   GET       …/expenses/:expenseId · POST …/expenses/:expenseId/reverse   getExpense · reverseExpense
//
// Defaults: the active property / organisation (services/activeProperty.ts).

import type {
  AgingReportDto,
  CancelRequest,
  ExpenseDetailDto,
  ExpenseDto,
  ExpenseRequest,
  PaySupplierBillRequest,
  SupplierBillDetailDto,
  SupplierBillDto,
  SupplierBillRequest,
  SupplierDto,
  SupplierUpsertRequest
} from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActiveOrganizationId, getActivePropertyId } from "./activeProperty";
import { compactQuery, expenseListQuery, financeErrorMessage, supplierBillListQuery, supplierListQuery, type ExpenseListInput, type SupplierBillListInput, type SupplierListInput } from "./finance-contracts";

export type { AgingReportDto, ExpenseDetailDto, ExpenseDto, ExpenseRequest, SupplierBillDetailDto, SupplierBillDto, SupplierBillRequest, SupplierDto, SupplierUpsertRequest } from "@hotelos/shared";
export type { ExpenseListInput, SupplierBillListInput, SupplierListInput } from "./finance-contracts";

const enc = encodeURIComponent;

// ---- Proveedores (organización) --------------------------------------------

export function listSuppliers(input: SupplierListInput = {}, organizationId = getActiveOrganizationId()): Promise<SupplierDto[]> {
  return apiRequest<SupplierDto[]>(`/organizations/${enc(organizationId)}/payables/suppliers`, { query: supplierListQuery(input) });
}

/** 201. NIF/CIF (mod-23) and IBAN (mod-97) are validated by the server: SUPPLIER_NIF_INVALID · SUPPLIER_IBAN_INVALID · SUPPLIER_NIF_DUPLICATE. */
export function createSupplier(body: SupplierUpsertRequest, organizationId = getActiveOrganizationId()): Promise<SupplierDto> {
  return apiRequest<SupplierDto>(`/organizations/${enc(organizationId)}/payables/suppliers`, { method: "POST", body });
}

export function getSupplier(supplierId: string, organizationId = getActiveOrganizationId()): Promise<SupplierDto> {
  return apiRequest<SupplierDto>(`/organizations/${enc(organizationId)}/payables/suppliers/${enc(supplierId)}`);
}

export function updateSupplier(supplierId: string, body: Partial<SupplierUpsertRequest>, organizationId = getActiveOrganizationId()): Promise<SupplierDto> {
  return apiRequest<SupplierDto>(`/organizations/${enc(organizationId)}/payables/suppliers/${enc(supplierId)}`, { method: "PATCH", body });
}

// ---- Facturas recibidas (propiedad) -----------------------------------------

export function listSupplierBills(input: SupplierBillListInput = {}, propertyId = getActivePropertyId()): Promise<SupplierBillDto[]> {
  return apiRequest<SupplierBillDto[]>(`/properties/${enc(propertyId)}/payables/supplier-bills`, { query: supplierBillListQuery(input) });
}

/** 201 draft. Lines carry the 6xx (or 20x/21x) account, base, rate and optional printed quota; `expectedTotal` is checked (TOTAL_MISMATCH). */
export function createSupplierBill(body: SupplierBillRequest, propertyId = getActivePropertyId()): Promise<SupplierBillDto> {
  return apiRequest<SupplierBillDto>(`/properties/${enc(propertyId)}/payables/supplier-bills`, { method: "POST", body });
}

export function getSupplierBill(billId: string, propertyId = getActivePropertyId()): Promise<SupplierBillDetailDto> {
  return apiRequest<SupplierBillDetailDto>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}`);
}

/** Draft only (INVALID_STATUS_TRANSITION otherwise). */
export function updateSupplierBill(billId: string, body: Partial<SupplierBillRequest>, propertyId = getActivePropertyId()): Promise<SupplierBillDto> {
  return apiRequest<SupplierBillDto>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}`, { method: "PATCH", body });
}

export function approveSupplierBill(billId: string, propertyId = getActivePropertyId()): Promise<SupplierBillDto> {
  return apiRequest<SupplierBillDto>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}/approve`, { method: "POST", body: {} });
}

/** Posts the accrual entry (D 6xx / D 472 / H 400|410 / H 4751) and the VAT-book rows. Critical. */
export function postSupplierBill(billId: string, propertyId = getActivePropertyId()): Promise<SupplierBillDetailDto> {
  return apiRequest<SupplierBillDetailDto>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}/post`, { method: "POST", body: {} });
}

/** Payment entry (D 400|410 / H 572|570). Critical. */
export function paySupplierBill(billId: string, body: PaySupplierBillRequest, propertyId = getActivePropertyId()): Promise<SupplierBillDetailDto> {
  return apiRequest<SupplierBillDetailDto>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}/pay`, { method: "POST", body });
}

export function cancelSupplierBill(billId: string, body: CancelRequest, propertyId = getActivePropertyId()): Promise<SupplierBillDetailDto> {
  return apiRequest<SupplierBillDetailDto>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}/cancel`, { method: "POST", body });
}

export type SupplierBillAttachment = {
  inline: boolean;
  documentObjectKey: string | null;
  mimeType: string | null;
  fileName: string | null;
  /** Inline attachments (≤ 512 KiB) travel as base64; otherwise the object-store key is given. */
  base64?: string | null;
};

export function getSupplierBillAttachment(billId: string, propertyId = getActivePropertyId()): Promise<SupplierBillAttachment> {
  return apiRequest<SupplierBillAttachment>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}/attachment`);
}

/** Outstanding supplier debt by bucket (notDue · 1-30 · 31-60 · 61-90 · 90+) at `asOf` (default today). */
export function getPayablesAging(asOf?: string, propertyId = getActivePropertyId()): Promise<AgingReportDto> {
  return apiRequest<AgingReportDto>(`/properties/${enc(propertyId)}/payables/aging`, { query: compactQuery({ asOf }) });
}

// ---- Gastos menores -----------------------------------------------------------

export function listExpenses(input: ExpenseListInput = {}, propertyId = getActivePropertyId()): Promise<ExpenseDto[]> {
  return apiRequest<ExpenseDto[]>(`/properties/${enc(propertyId)}/payables/expenses`, { query: expenseListQuery(input) });
}

/** 201: posts the expense entry at once (D 6xx / D 472 / H 570|5721|572). Without supplier NIF the VAT is not deductible. */
export function createExpense(body: ExpenseRequest, propertyId = getActivePropertyId()): Promise<ExpenseDetailDto> {
  return apiRequest<ExpenseDetailDto>(`/properties/${enc(propertyId)}/payables/expenses`, { method: "POST", body });
}

export function getExpense(expenseId: string, propertyId = getActivePropertyId()): Promise<ExpenseDetailDto> {
  return apiRequest<ExpenseDetailDto>(`/properties/${enc(propertyId)}/payables/expenses/${enc(expenseId)}`);
}

export function reverseExpense(expenseId: string, body: CancelRequest, propertyId = getActivePropertyId()): Promise<ExpenseDetailDto> {
  return apiRequest<ExpenseDetailDto>(`/properties/${enc(propertyId)}/payables/expenses/${enc(expenseId)}/reverse`, { method: "POST", body });
}

// ---- Errores ------------------------------------------------------------------

export function payablesErrorMessage(error: unknown, fallback = "No se pudo guardar. Revisa los datos e inténtalo de nuevo."): string {
  return financeErrorMessage(error, fallback);
}
