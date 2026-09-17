// Frontend client for the Email → AI → reservation module and, since Tanda 7b,
// for the mailboxes of the OPERA shadow mode (purpose `pms_shadow`: the
// attachments of the Report Scheduler go to the shadow ingest instead of the AI
// reservation extraction; schemas/email-connections.schemas.ts).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type EmailProviders = Record<string, { configured: boolean; note?: string }>;

/** `reservation_ai`: extract reservations with AI (human review) · `pms_shadow`: hand the attachments to the OPERA shadow ingest. */
export type EmailConnectionPurpose = "reservation_ai" | "pms_shadow";

export const EMAIL_CONNECTION_PURPOSES: readonly EmailConnectionPurpose[] = ["reservation_ai", "pms_shadow"];

/** `configJson` of the connection as the API returns it (never the password). */
export type EmailConnectionConfig = {
  /** Absent = reservation_ai (mailboxes created before Tanda 7b carry no purpose). */
  purpose?: EmailConnectionPurpose;
  /** pms_shadow only: sender domain filter («oracle.com»); without it every sender passes. */
  fromDomain?: string;
  /** pms_shadow only: subject filter (case-insensitive substring). */
  subjectContains?: string;
  host?: string;
  port?: number;
  username?: string;
};

export type EmailConnection = {
  id: string;
  provider: string;
  status: string;
  emailAddress: string | null;
  config: EmailConnectionConfig | null;
  lastSyncAt: string | null;
  lastError: string | null;
  needsOAuth?: boolean;
  authorizeAvailable?: boolean;
};

/** Body of `POST /properties/:propertyId/email/connections` (CreateEmailConnectionSchema, `.strict()`). */
export type CreateEmailConnectionPayload = {
  provider: string;
  emailAddress?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  /** Default reservation_ai on the API. */
  purpose?: EmailConnectionPurpose;
  fromDomain?: string;
  subjectContains?: string;
};

/** `config.purpose` of a connection; anything unknown or absent reads as reservation_ai, like the API. */
export function emailConnectionPurpose(connection: Pick<EmailConnection, "config">): EmailConnectionPurpose {
  return connection.config?.purpose === "pms_shadow" ? "pms_shadow" : "reservation_ai";
}
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
/** Creates a mailbox; `purpose` / `fromDomain` / `subjectContains` only matter for the OPERA shadow mode (Tanda 7b). */
export function createEmailConnection(payload: CreateEmailConnectionPayload, propertyId = getActivePropertyId()) {
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
