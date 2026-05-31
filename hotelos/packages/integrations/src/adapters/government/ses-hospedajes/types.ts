export type AuthorityType = "ses_hospedajes" | "mossos" | "ertzaintza" | "manual" | "other";

export type AuthoritySettingsValidation = {
  valid: boolean;
  missing: string[];
  warnings: string[];
};

export type BuildAuthorityPayloadInput = {
  propertyId: string;
  recordId: string;
  submissionType: "reservation" | "checkin" | "cancellation" | "correction" | "annulment";
  requiredPayloadJson: Record<string, unknown>;
};

export type AuthorityPayload = {
  authorityType: AuthorityType;
  format: "json_preview" | "official_file" | "api";
  payload: Record<string, unknown>;
  schemaVersion?: string;
};

export type GenerateAuthorityBatchFileInput = {
  propertyId: string;
  batchId: string;
  records: BuildAuthorityPayloadInput[];
  schemaTemplateConfigured: boolean;
};

export type GeneratedAuthorityFile = {
  fileName: string;
  mimeType: string;
  contents: string;
  productionReady: boolean;
  warnings: string[];
};

export type SubmitAuthorityBatchInput = {
  propertyId: string;
  batchId: string;
  payload: AuthorityPayload;
  idempotencyKey: string;
};

export type SubmitAuthoritySingleInput = {
  propertyId: string;
  recordId: string;
  payload: AuthorityPayload;
  idempotencyKey: string;
};

export type AnnulAuthorityCommunicationInput = {
  propertyId: string;
  externalReference: string;
  reason: string;
};

export type CheckAuthorityStatusInput = {
  propertyId: string;
  externalReference: string;
};

export type AuthoritySubmissionResult = {
  status: "accepted" | "rejected" | "failed";
  externalReference?: string;
  responsePayloadJson?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
};

export type AuthoritySubmissionStatusResult = AuthoritySubmissionResult & {
  checkedAt: string;
};

export interface GuestAuthorityAdapter {
  authorityType: AuthorityType;
  validateSettings(propertyId: string): Promise<AuthoritySettingsValidation>;
  buildPayload(input: BuildAuthorityPayloadInput): Promise<AuthorityPayload>;
  generateBatchFile(input: GenerateAuthorityBatchFileInput): Promise<GeneratedAuthorityFile>;
  submitBatch?(input: SubmitAuthorityBatchInput): Promise<AuthoritySubmissionResult>;
  submitSingle?(input: SubmitAuthoritySingleInput): Promise<AuthoritySubmissionResult>;
  annulCommunication?(input: AnnulAuthorityCommunicationInput): Promise<AuthoritySubmissionResult>;
  checkStatus?(input: CheckAuthorityStatusInput): Promise<AuthoritySubmissionStatusResult>;
}
