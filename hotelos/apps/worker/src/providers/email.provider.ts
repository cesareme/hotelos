// Email provider (stub) — worker copy, mirrors apps/api equivalent.
//
// Real implementation would call Postmark / SendGrid / SES. The recipient
// suffix `@fail.test` simulates a hard bounce so we can exercise the failure
// path during demos.

import type { ProviderSendInput, ProviderSendResult } from "./types.js";

export async function send(input: ProviderSendInput): Promise<ProviderSendResult> {
  const recipient = input.recipient.trim().toLowerCase();
  if (!recipient) {
    return { status: "failed", error: "Email recipient is empty." };
  }
  if (!recipient.includes("@")) {
    return { status: "failed", error: `Invalid email address: ${input.recipient}` };
  }
  if (recipient.endsWith("@fail.test")) {
    return { status: "failed", error: "Simulated provider rejection (recipient ends in @fail.test)." };
  }

  const providerMessageId = `eml_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return { status: "sent", providerMessageId };
}
