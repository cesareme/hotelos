// Frontend client for the Email → AI → reservation module.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type EmailProviders = Record<string, { configured: boolean; note?: string }>;
export type EmailConnection = {
  id: string;
  provider: string;
  status: string;
  emailAddress: string | null;
  config: unknown;
  lastSyncAt: string | null;
  lastError: string | null;
  needsOAuth?: boolean;
  authorizeAvailable?: boolean;
};
export type InboundEmail = {
  id: string;
  provider: string;
  from: string | null;
  subject: string | null;
  receivedAt: string | null;
  snippet: string | null;
  detectedSource: string | null;
  status: string;
  parseSource: string | null;
  confidence: number | null;
  draft: Record<string, unknown>;
  reservationId: string | null;
};

export function fetchEmailProviders() {
  return apiRequest<EmailProviders>("/integrations/email/providers");
}
export function fetchEmailConnections(propertyId = getActivePropertyId()) {
  return apiRequest<EmailConnection[]>(`/properties/${propertyId}/email/connections`);
}
export function createEmailConnection(payload: Record<string, unknown>, propertyId = getActivePropertyId()) {
  return apiRequest<EmailConnection>(`/properties/${propertyId}/email/connections`, { method: "POST", body: payload });
}
export function disconnectEmailConnection(id: string) {
  return apiRequest<EmailConnection>(`/email/connections/${id}`, { method: "DELETE" });
}
export function getEmailAuthorizeUrl(id: string) {
  return apiRequest<{ url: string }>(`/email/connections/${id}/authorize-url`);
}
export function pollEmailConnection(id: string) {
  return apiRequest<{ processed?: number; note?: string }>(`/email/connections/${id}/poll`, { method: "POST" });
}
export function ingestManualEmail(payload: { from?: string; subject?: string; body: string; connectionId?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<{ id: string }>(`/properties/${propertyId}/email/ingest`, { method: "POST", body: payload });
}
export function fetchInboundEmails(status?: string, propertyId = getActivePropertyId()) {
  return apiRequest<InboundEmail[]>(`/properties/${propertyId}/email/inbound`, { query: status ? { status } : undefined });
}
export function approveInboundEmail(id: string, overrides?: Record<string, unknown>) {
  return apiRequest<{ reservationId: string; code: string }>(`/email/inbound/${id}/approve`, { method: "POST", body: overrides ?? {} });
}
export function rejectInboundEmail(id: string, reason?: string) {
  return apiRequest<{ id: string; status: string }>(`/email/inbound/${id}/reject`, { method: "POST", body: { reason } });
}
