// Frontend client for the back-office billing / accounting settings
// (Tanda 3 · lote front-fiscal). Every call goes through apiRequest (JWT).
//
//   GET/PATCH /backoffice/properties/:propertyId/billing-settings
//   GET       /backoffice/properties/:propertyId/accounting-settings
//   GET       /accounting/fiscal-periods?propertyId=
//   GET       /backoffice/properties/:propertyId/integrations
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type InvoiceSequence = {
  id: string;
  propertyId: string;
  sequenceCode: string;
  prefix?: string | null;
  nextNumber: number;
  padding: number;
  invoiceType: "full" | "simplified" | "rectifying" | "credit_note" | string;
  active: boolean;
  /** Tanda 3: InvoiceSequence.year (null for legacy rows without a fiscal year). */
  year?: number | null;
};

export type BillingSettings = {
  invoiceSequences: InvoiceSequence[];
  complianceBilling?: unknown;
};

export type InvoiceSequencePatch = {
  sequenceCode: string;
  invoiceType: InvoiceSequence["invoiceType"];
  prefix?: string;
  nextNumber?: number;
  padding?: number;
  active?: boolean;
  year?: number;
};

export function fetchBillingSettings(propertyId = getActivePropertyId()) {
  return apiRequest<BillingSettings>(`/backoffice/properties/${propertyId}/billing-settings`);
}

export function patchBillingSettings(propertyId: string, invoiceSequence: InvoiceSequencePatch) {
  return apiRequest<InvoiceSequence>(`/backoffice/properties/${propertyId}/billing-settings`, {
    method: "PATCH",
    body: { invoiceSequence }
  });
}

export type AccountingSettingsRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  chartTemplate?: string | null;
  fiscalYearStartMonth: number;
  configurationJson: Record<string, unknown>;
  updatedAt: string;
};

export type CostCenter = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
};

export type AccountingSettings = {
  settings?: AccountingSettingsRecord;
  costCenters: CostCenter[];
};

export function fetchAccountingSettings(propertyId = getActivePropertyId()) {
  return apiRequest<AccountingSettings>(`/backoffice/properties/${propertyId}/accounting-settings`);
}

export type FiscalPeriod = {
  id: string;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  periodType: "month" | "quarter" | "year";
  startDate: string;
  endDate: string;
  status: "open" | "closing" | "closed";
  closedAt?: string;
  closedBy?: string;
  closingNotes?: string;
  createdAt: string;
};

export function fetchFiscalPeriods(propertyId = getActivePropertyId()) {
  return apiRequest<FiscalPeriod[]>(`/accounting/fiscal-periods`, { query: { propertyId } });
}

export type PropertyIntegration = {
  id: string;
  propertyId: string;
  providerId: string;
  status: "connected" | "disconnected" | "error" | "testing";
  credentialsSecretRef?: string;
  configJson: Record<string, unknown>;
  lastSyncAt?: string;
  createdAt: string;
  provider?: {
    id: string;
    categoryId: string;
    code: string;
    name: string;
    authType: string;
    supportedRegions: string[];
    capabilitiesJson: Record<string, unknown>;
  };
};

export function fetchPropertyIntegrations(propertyId = getActivePropertyId()) {
  return apiRequest<PropertyIntegration[]>(`/backoffice/properties/${propertyId}/integrations`);
}

/** Payment-service-provider connections only (provider code or category mentions payments/psp). */
export function isPaymentIntegration(integration: PropertyIntegration): boolean {
  const code = `${integration.provider?.code ?? ""} ${integration.provider?.categoryId ?? ""} ${integration.provider?.name ?? ""}`.toLowerCase();
  return /payment|psp|pago|stripe|redsys|adyen|paypal/.test(code);
}

// --- Readiness (GET /backoffice/properties/:propertyId/readiness) -----------

export type ReadinessCheck = {
  id?: string;
  propertyId?: string;
  checkCode: string;
  status: "pass" | "fail" | "warning";
  severity: "info" | "warning" | "blocking";
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type PropertyReadiness = {
  propertyId: string;
  status: "ready" | "blocked";
  blockingCount: number;
  checks: ReadinessCheck[];
};

export function fetchPropertyReadiness(propertyId = getActivePropertyId()) {
  return apiRequest<PropertyReadiness>(`/backoffice/properties/${propertyId}/readiness`);
}

export function recalculatePropertyReadiness(propertyId = getActivePropertyId()) {
  return apiRequest<PropertyReadiness>(`/backoffice/properties/${propertyId}/readiness/recalculate`, { method: "POST", body: {} });
}
