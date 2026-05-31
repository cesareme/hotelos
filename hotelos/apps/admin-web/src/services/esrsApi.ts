// Frontend client for the CSRD/ESRS endpoints (P2-2).
import { apiRequest } from "./api-client";

export type EsrsDisclosure = {
  standard: string;
  code: string;
  description: string;
  unit: string;
  required: boolean;
};

export type EsrsIndicator = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  fiscalYear: string;
  standardCode: string;
  disclosureCode: string;
  valueType: string;
  numericValue: number | string | null;
  textValue: string | null;
  unit: string | null;
  source: string;
  computedAt: string;
};

export type EsrsReportSummary = {
  organizationId: string;
  fiscalYear: string;
  totalIndicators: number;
  requiredDisclosures: number;
  reportedRequired: number;
  completenessPct: number;
  standards: Record<string, { reported: number; required: number; values: Array<{ code: string; value: unknown; unit: string | null }> }>;
  generatedAt: string;
};

export async function fetchCatalog(): Promise<EsrsDisclosure[]> {
  const r = await apiRequest<{ items: EsrsDisclosure[] }>("/esrs/catalog");
  return r.items;
}

export async function fetchIndicators(orgId: string, year: string): Promise<EsrsIndicator[]> {
  const r = await apiRequest<{ items: EsrsIndicator[] }>(`/organizations/${orgId}/esrs/${year}/indicators`);
  return r.items;
}

export function upsertIndicator(payload: {
  organizationId: string;
  propertyId?: string;
  fiscalYear: string;
  standardCode: string;
  disclosureCode: string;
  numericValue?: number;
  textValue?: string;
  unit?: string;
  source?: string;
}): Promise<EsrsIndicator> {
  return apiRequest<EsrsIndicator>("/esrs/indicators", { method: "POST", body: payload });
}

export function generateReport(orgId: string, year: string): Promise<{ report: unknown; summary: EsrsReportSummary }> {
  return apiRequest(`/organizations/${orgId}/esrs/${year}/generate`, { method: "POST" });
}
