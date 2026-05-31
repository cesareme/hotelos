// Frontend client for the TicketBAI multi-jurisdicción endpoints (P1-8).
import { apiRequest } from "./api-client";

export type ForalTerritory = "bizkaia" | "gipuzkoa" | "araba" | "navarra";

export type TbaiTerritoryConfig = {
  name: string;
  isoCode: string;
  endpoints: { sandbox: string; production: string };
  submissionDeadlineMs: number;
  hacienda: string;
};

export type TbaiSubmission = {
  id: string;
  invoiceId: string;
  propertyId: string;
  territory: string;
  status: string;
  endpoint: string | null;
  tbaiCode: string | null;
  tbaiHash: string | null;
  previousTbaiHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
};

export async function fetchTerritories(): Promise<{ items: ForalTerritory[]; config: Record<ForalTerritory, TbaiTerritoryConfig> }> {
  return apiRequest("/tbai/territories");
}

export function submitInvoice(invoiceId: string, mode: "stub" | "sandbox" | "production" = "stub") {
  return apiRequest(`/invoices/${invoiceId}/tbai/submit`, { method: "POST", body: { mode } });
}

export function verifyChain(propertyId: string, territory: ForalTerritory) {
  return apiRequest<{ valid: boolean; inspected: number; brokenAt?: string }>(
    `/properties/${propertyId}/tbai/chain/${territory}/verify`
  );
}

export async function fetchSubmissions(propertyId: string, territory?: ForalTerritory): Promise<TbaiSubmission[]> {
  const qs = territory ? `?territory=${territory}` : "";
  const r = await apiRequest<{ items: TbaiSubmission[] }>(`/properties/${propertyId}/tbai/submissions${qs}`);
  return r.items;
}
