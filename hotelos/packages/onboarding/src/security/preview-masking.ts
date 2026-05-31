const SENSITIVE_FIELD_PATTERNS = [
  /document/i,
  /passport/i,
  /dni/i,
  /identity/i,
  /email/i,
  /phone/i,
  /mobile/i,
  /payment/i,
  /card/i,
  /holder/i,
  /address/i,
  /birth/i
] as const;

function isSensitiveKey(key: string) {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

function maskValue(value: unknown) {
  if (typeof value !== "string") return "***";
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function maskOnboardingPreview<T>(input: T, canViewSensitive: boolean): T {
  if (canViewSensitive) return input;
  if (Array.isArray(input)) {
    return input.map((item) => maskOnboardingPreview(item, canViewSensitive)) as T;
  }
  if (!input || typeof input !== "object") {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => {
      if (isSensitiveKey(key)) {
        return [key, maskValue(value)];
      }
      if (value && typeof value === "object") {
        return [key, maskOnboardingPreview(value, canViewSensitive)];
      }
      return [key, value];
    })
  ) as T;
}
