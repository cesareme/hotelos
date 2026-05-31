// Email provider — real HTTP delivery, env-configured (P1.8).
//
// Configure with:
//   EMAIL_PROVIDER       = "postmark" | "sendgrid"
//   EMAIL_PROVIDER_KEY   = server token / API key
//   EMAIL_FROM           = verified sender address
//
// Behaviour:
//   - configured        -> real HTTP send; status from the provider response.
//   - not configured + dev        -> { sent, simulated:true } (demo keeps working).
//   - not configured + production -> { failed } (never claim a delivery we can't make).
//   - recipient @fail.test        -> simulated hard bounce (failure-path testing).

import type { ProviderSendInput, ProviderSendResult } from "./types.js";

export function isEmailConfigured(): boolean {
  const provider = (process.env.EMAIL_PROVIDER ?? "").toLowerCase();
  const key = process.env.EMAIL_PROVIDER_KEY ?? "";
  const from = process.env.EMAIL_FROM ?? "";
  return Boolean(provider && key && key !== "change-me" && from);
}

export async function send(input: ProviderSendInput): Promise<ProviderSendResult> {
  const recipient = input.recipient.trim();
  if (!recipient) return { status: "failed", error: "Email recipient is empty." };
  if (!recipient.includes("@")) return { status: "failed", error: `Invalid email address: ${input.recipient}` };
  if (recipient.toLowerCase().endsWith("@fail.test")) {
    return { status: "failed", error: "Simulated provider rejection (recipient ends in @fail.test)." };
  }

  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "Email provider not configured (set EMAIL_PROVIDER, EMAIL_PROVIDER_KEY, EMAIL_FROM)." };
    }
    return { status: "sent", simulated: true, providerMessageId: `simulated_eml_${Date.now().toString(36)}` };
  }

  const provider = (process.env.EMAIL_PROVIDER ?? "").toLowerCase();
  const key = process.env.EMAIL_PROVIDER_KEY ?? "";
  const from = process.env.EMAIL_FROM ?? "";
  try {
    if (provider === "postmark") {
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": key },
        body: JSON.stringify({ From: from, To: recipient, Subject: input.subject ?? "", TextBody: input.body })
      });
      const json = (await response.json().catch(() => ({}))) as { MessageID?: string };
      if (!response.ok) return { status: "failed", error: `Postmark HTTP ${response.status}: ${JSON.stringify(json).slice(0, 200)}` };
      return { status: "sent", providerMessageId: json.MessageID };
    }
    if (provider === "sendgrid") {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipient }] }],
          from: { email: from },
          subject: input.subject ?? "",
          content: [{ type: "text/plain", value: input.body }]
        })
      });
      if (!response.ok) return { status: "failed", error: `SendGrid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
      return { status: "sent", providerMessageId: response.headers.get("x-message-id") ?? undefined };
    }
    return { status: "failed", error: `Unknown EMAIL_PROVIDER "${provider}" (use postmark or sendgrid).` };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
