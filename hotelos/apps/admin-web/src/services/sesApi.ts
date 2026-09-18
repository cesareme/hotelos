import { apiRequest } from "./api-client";

export type SesReportingSettings = {
  id: string;
  propertyId: string;
  country?: string;
  regionCode?: string;
  authorityType?: string;
  enabled?: boolean;
  professionalActivity?: boolean;
  establishmentCode?: string;
  landlordCode?: string;
  webServiceEnabled?: boolean;
  webServiceUsername?: string;
  webServiceSecretRef?: string;
  batchExportEnabled?: boolean;
  automaticSubmissionEnabled?: boolean;
  configurationJson?: Record<string, unknown>;
  updatedAt?: string;
};

export type SesSettings = {
  reporting?: SesReportingSettings;
  legalProfile?: Record<string, unknown>;
  routingRules?: unknown[];
  privacy?: Record<string, unknown>;
};

export type AuthoritySubmission = {
  id: string;
  propertyId: string;
  authorityType: string;
  submissionType: string;
  status: "queued" | "sent" | "accepted" | "rejected" | "failed" | "annulled";
  externalReference?: string;
  errorCode?: string;
  errorMessage?: string;
  submittedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SesBatch = {
  id: string;
  propertyId: string;
  status: string;
  fileFormat?: string;
  fileObjectKey?: string;
  recordCount: number;
  generatedAt?: string;
};

export type SesConnectionTest = { status: string; authorityType: string; message: string };

const propPath = (propertyId: string) => `/compliance/spain/properties/${propertyId}/guest-register/settings`;

export async function fetchSesSettings(propertyId: string): Promise<SesSettings> {
  return apiRequest<SesSettings>(propPath(propertyId));
}

export async function patchSesSettings(propertyId: string, patch: Record<string, unknown>): Promise<SesReportingSettings> {
  return apiRequest<SesReportingSettings>(propPath(propertyId), { method: "PATCH", body: patch });
}

// Tanda L2 (L2-02): fetchSesSubmissions / retrySesSubmission (familia de envíos
// a autoridad en memoria) se retiraron; el histórico SES canónico es
// fetchSesSubmissionsPage (complianceApi.ts → GET /properties/:id/ses/submissions)
// y el reintento POST /ses/submissions/:id/retry.

export async function generateSesBatch(propertyId: string): Promise<SesBatch> {
  return apiRequest<SesBatch>(`/compliance/ses-hospedajes/properties/${propertyId}/batches/generate`, { method: "POST" });
}

export async function testSesConnection(propertyId: string): Promise<SesConnectionTest> {
  return apiRequest<SesConnectionTest>(`/compliance/ses-hospedajes/properties/${propertyId}/test-connection`, { method: "POST" });
}
