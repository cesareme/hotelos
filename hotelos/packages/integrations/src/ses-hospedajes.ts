export type SesHospedajesClientConfig = {
  clientId: string;
  clientSecret: string;
  environment: "sandbox" | "production";
};

export type SesSubmissionResult = {
  status: "accepted" | "rejected" | "failed";
  externalReference?: string;
  errorMessage?: string;
};

export async function submitSesHospedajesRecord(
  _config: SesHospedajesClientConfig,
  payload: Record<string, unknown>
): Promise<SesSubmissionResult> {
  if (!payload.documentNumber) {
    return { status: "rejected", errorMessage: "Document number is required." };
  }

  return { status: "accepted", externalReference: "ses_demo_reference" };
}

