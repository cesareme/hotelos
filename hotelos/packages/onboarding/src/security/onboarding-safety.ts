export const ONBOARDING_PRIVACY_SECURITY_RULES = [
  "Encrypt uploaded onboarding files.",
  "Store source PMS credentials only as secret-manager references.",
  "Delete raw onboarding files after the configured retention period.",
  "Mask PII in previews unless onboarding.view_sensitive is granted.",
  "Audit every file download and sensitive-field view.",
  "Do not import raw payment card data.",
  "Do not import CVV.",
  "Do not store ID or passport images by default.",
  "Allow data minimization before applying migration.",
  "Require customer authorization before importing guest data."
] as const;

export type OnboardingPayloadSafetyIssue = {
  code: string;
  severity: "blocking" | "warning";
  detail: string;
};

export function inspectOnboardingPayloadForSensitiveData(input: Record<string, unknown>): {
  allowed: boolean;
  issues: OnboardingPayloadSafetyIssue[];
} {
  const serialized = JSON.stringify(input).toLowerCase();
  const issues: OnboardingPayloadSafetyIssue[] = [];

  if (serialized.includes("cvv") || serialized.includes("cvc")) {
    issues.push({
      code: "raw_card_verification_code_detected",
      severity: "blocking",
      detail: "CVV/CVC data must never be imported or stored."
    });
  }
  if (serialized.includes("pan") || serialized.includes("full_card_number")) {
    issues.push({
      code: "raw_payment_card_data_detected",
      severity: "blocking",
      detail: "Raw PAN/full card numbers must not be imported; use PSP token references only."
    });
  }
  if (serialized.includes("passport_image") || serialized.includes("dni_image") || serialized.includes("id_image")) {
    issues.push({
      code: "identity_document_image_detected",
      severity: "blocking",
      detail: "ID/passport/TIE images must not be imported or stored by default."
    });
  }

  return {
    allowed: !issues.some((issue) => issue.severity === "blocking"),
    issues
  };
}
