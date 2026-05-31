// SMS provider — real Twilio delivery, env-configured (P1.8).
//
// Configure with: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (E.164).
// Not configured: dev -> simulated send; production -> failure (no false delivery).

import type { ProviderSendInput, ProviderSendResult } from "./types.js";

export function isSmsConfigured(): boolean {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_FROM ?? "";
  return Boolean(sid && token && token !== "change-me" && from);
}

export async function send(input: ProviderSendInput): Promise<ProviderSendResult> {
  const recipient = input.recipient.trim();
  if (!recipient) return { status: "failed", error: "SMS recipient (E.164 phone) is empty." };
  if (!recipient.startsWith("+")) {
    return { status: "failed", error: `SMS recipient must be in E.164 format (got: ${input.recipient}).` };
  }
  if (recipient.toLowerCase().endsWith("@fail.test") || recipient === "+0000000000") {
    return { status: "failed", error: "Simulated SMS provider failure." };
  }

  if (!isSmsConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "SMS provider not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)." };
    }
    return { status: "sent", simulated: true, providerMessageId: `simulated_sms_${Date.now().toString(36)}` };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_FROM ?? "";
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const body = new URLSearchParams({ From: from, To: recipient, Body: input.body });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const json = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!response.ok) return { status: "failed", error: `Twilio HTTP ${response.status}: ${json.message ?? JSON.stringify(json).slice(0, 200)}` };
    return { status: "sent", providerMessageId: json.sid };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
