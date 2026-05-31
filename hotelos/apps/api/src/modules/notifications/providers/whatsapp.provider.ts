// WhatsApp provider — real Meta Cloud API delivery, env-configured (P1.8).
//
// Configure with: WHATSAPP_PHONE_ID, WHATSAPP_PROVIDER_TOKEN (Bearer).
// Not configured: dev -> simulated send; production -> failure (no false delivery).
// NOTE: outside the 24h customer-service window Meta only allows pre-approved
// templates; this sends a plain text body (valid inside the window).

import type { ProviderSendInput, ProviderSendResult } from "./types.js";

export function isWhatsappConfigured(): boolean {
  const phoneId = process.env.WHATSAPP_PHONE_ID ?? "";
  const token = process.env.WHATSAPP_PROVIDER_TOKEN ?? process.env.WHATSAPP_TOKEN ?? "";
  return Boolean(phoneId && token && token !== "change-me");
}

export async function send(input: ProviderSendInput): Promise<ProviderSendResult> {
  const recipient = input.recipient.trim();
  if (!recipient) return { status: "failed", error: "WhatsApp recipient (E.164 phone) is empty." };
  if (!recipient.startsWith("+")) {
    return { status: "failed", error: `WhatsApp recipient must be in E.164 format (got: ${input.recipient}).` };
  }
  if (recipient.toLowerCase().endsWith("@fail.test") || recipient === "+0000000000") {
    return { status: "failed", error: "Simulated WhatsApp provider failure." };
  }

  if (!isWhatsappConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "WhatsApp provider not configured (set WHATSAPP_PHONE_ID, WHATSAPP_PROVIDER_TOKEN)." };
    }
    return { status: "sent", simulated: true, providerMessageId: `simulated_wa_${Date.now().toString(36)}` };
  }

  const phoneId = process.env.WHATSAPP_PHONE_ID ?? "";
  const token = process.env.WHATSAPP_PROVIDER_TOKEN ?? process.env.WHATSAPP_TOKEN ?? "";
  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient.replace(/^\+/, ""),
        type: "text",
        text: { body: input.body }
      })
    });
    const json = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) return { status: "failed", error: `WhatsApp HTTP ${response.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}` };
    return { status: "sent", providerMessageId: json.messages?.[0]?.id };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
