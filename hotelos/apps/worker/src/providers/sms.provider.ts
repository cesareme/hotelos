// SMS provider (stub) — worker copy, mirrors apps/api equivalent.
//
// Real implementation would call Twilio Messages create. `+0000000000` and
// `@fail.test`-suffixed recipients simulate failure for demos.

import type { ProviderSendInput, ProviderSendResult } from "./types.js";

export async function send(input: ProviderSendInput): Promise<ProviderSendResult> {
  const recipient = input.recipient.trim();
  if (!recipient) {
    return { status: "failed", error: "SMS recipient (E.164 phone) is empty." };
  }
  if (!recipient.startsWith("+")) {
    return { status: "failed", error: `SMS recipient must be in E.164 format (got: ${input.recipient}).` };
  }
  if (recipient.toLowerCase().endsWith("@fail.test") || recipient === "+0000000000") {
    return { status: "failed", error: "Simulated SMS provider failure." };
  }

  const providerMessageId = `sms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return { status: "sent", providerMessageId };
}
