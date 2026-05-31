import type {
  AuthorityPayload,
  AuthoritySettingsValidation,
  AuthoritySubmissionResult,
  BuildAuthorityPayloadInput,
  GenerateAuthorityBatchFileInput,
  GeneratedAuthorityFile,
  GuestAuthorityAdapter
} from "./types.js";

function validatePreviewSettings(propertyId: string): Promise<AuthoritySettingsValidation> {
  return Promise.resolve({
    valid: Boolean(propertyId),
    missing: propertyId ? [] : ["propertyId"],
    warnings: ["Production schema must be loaded from official SES.HOSPEDAJES service-web documentation before live submission."]
  });
}

async function buildJsonPreviewPayload(authorityType: GuestAuthorityAdapter["authorityType"], input: BuildAuthorityPayloadInput): Promise<AuthorityPayload> {
  return {
    authorityType,
    format: "json_preview",
    schemaVersion: "official_schema_not_configured",
    payload: {
      propertyId: input.propertyId,
      recordId: input.recordId,
      submissionType: input.submissionType,
      requiredPayloadJson: input.requiredPayloadJson,
      privacy: {
        idImageStored: false,
        minimisation: "Only legal register fields are transmitted. Document images are not included."
      }
    }
  };
}

async function generateJsonPreviewBatch(input: GenerateAuthorityBatchFileInput): Promise<GeneratedAuthorityFile> {
  const warnings = input.schemaTemplateConfigured
    ? []
    : ["Official SES.HOSPEDAJES XSD/template is not configured; this export is a non-production preview."];
  return {
    fileName: `${input.propertyId}-${input.batchId}-guest-register-preview.json`,
    mimeType: "application/json",
    contents: JSON.stringify({ batchId: input.batchId, records: input.records }, null, 2),
    productionReady: input.schemaTemplateConfigured,
    warnings
  };
}

async function acceptedMockResult(): Promise<AuthoritySubmissionResult> {
  return {
    status: "accepted",
    externalReference: "ses_mock_reference",
    responsePayloadJson: { receipt: "accepted_by_mock_adapter" }
  };
}

async function blockedPlaceholderResult(): Promise<AuthoritySubmissionResult> {
  return {
    status: "failed",
    errorCode: "official_schema_required",
    errorMessage: "Production web-service submission requires official SES.HOSPEDAJES schema, credentials and service-web documentation."
  };
}

export const ses_hospedajes_mock: GuestAuthorityAdapter = {
  authorityType: "ses_hospedajes",
  validateSettings: validatePreviewSettings,
  buildPayload: (input) => buildJsonPreviewPayload("ses_hospedajes", input),
  generateBatchFile: generateJsonPreviewBatch,
  submitBatch: acceptedMockResult,
  submitSingle: acceptedMockResult,
  annulCommunication: acceptedMockResult,
  checkStatus: async () => ({ ...(await acceptedMockResult()), checkedAt: new Date().toISOString() })
};

export const ses_hospedajes_file_export: GuestAuthorityAdapter = {
  authorityType: "ses_hospedajes",
  validateSettings: validatePreviewSettings,
  buildPayload: (input) => buildJsonPreviewPayload("ses_hospedajes", input),
  generateBatchFile: generateJsonPreviewBatch
};

export const ses_hospedajes_web_service_placeholder: GuestAuthorityAdapter = {
  authorityType: "ses_hospedajes",
  validateSettings: validatePreviewSettings,
  buildPayload: (input) => buildJsonPreviewPayload("ses_hospedajes", input),
  generateBatchFile: generateJsonPreviewBatch,
  submitBatch: blockedPlaceholderResult,
  submitSingle: blockedPlaceholderResult,
  annulCommunication: blockedPlaceholderResult
};

export const mossos_placeholder: GuestAuthorityAdapter = {
  authorityType: "mossos",
  validateSettings: validatePreviewSettings,
  buildPayload: (input) => buildJsonPreviewPayload("mossos", input),
  generateBatchFile: generateJsonPreviewBatch
};

export const ertzaintza_placeholder: GuestAuthorityAdapter = {
  authorityType: "ertzaintza",
  validateSettings: validatePreviewSettings,
  buildPayload: (input) => buildJsonPreviewPayload("ertzaintza", input),
  generateBatchFile: generateJsonPreviewBatch
};

export const manual_authority_export: GuestAuthorityAdapter = {
  authorityType: "manual",
  validateSettings: validatePreviewSettings,
  buildPayload: (input) => buildJsonPreviewPayload("manual", input),
  generateBatchFile: generateJsonPreviewBatch
};

export const GUEST_AUTHORITY_ADAPTERS: GuestAuthorityAdapter[] = [
  ses_hospedajes_mock,
  ses_hospedajes_file_export,
  ses_hospedajes_web_service_placeholder,
  mossos_placeholder,
  ertzaintza_placeholder,
  manual_authority_export
];
