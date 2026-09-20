// WhatsApp provider — real Meta Cloud API delivery, env-configured (P1.8).
//
// Configure with: WHATSAPP_PHONE_ID, WHATSAPP_PROVIDER_TOKEN (Bearer).
// Not configured: dev -> simulated send; production -> failure (no false delivery).
// NOTE: outside the 24h customer-service window Meta only allows pre-approved
// templates. Tanda CHK (W2-D): when the caller passes `input.template` the
// request is `type: "template"` (`{ name, language: { code }, components }`);
// otherwise a plain text body is sent (valid only inside the window).

import type { ProviderSendInput, ProviderSendResult } from "./types.js";

export const WHATSAPP_GRAPH_API_VERSION = "v19.0";

export function isWhatsappConfigured(): boolean {
  const phoneId = process.env.WHATSAPP_PHONE_ID ?? "";
  const token = process.env.WHATSAPP_PROVIDER_TOKEN ?? process.env.WHATSAPP_TOKEN ?? "";
  return Boolean(phoneId && token && token !== "change-me");
}

/**
 * Cuerpo JSON de la Cloud API para un envío: plantilla aprobada si el llamador
 * la indica (fuera de la ventana de 24 h), texto libre si no. Puro, sin I/O,
 * para que el test pueda comprobar la forma exacta que recibe Meta.
 */
export function buildWhatsappPayload(input: ProviderSendInput): Record<string, unknown> {
  const to = input.recipient.trim().replace(/^\+/, "");
  if (input.template) {
    const template: Record<string, unknown> = {
      name: input.template.name,
      language: { code: input.template.language }
    };
    if (Array.isArray(input.template.components) && input.template.components.length > 0) {
      template.components = input.template.components;
    }
    return { messaging_product: "whatsapp", to, type: "template", template };
  }
  return { messaging_product: "whatsapp", to, type: "text", text: { body: input.body } };
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
  if (input.template && !input.template.name.trim()) {
    return { status: "failed", error: "WhatsApp template name is empty." };
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
    const response = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildWhatsappPayload({ ...input, recipient }))
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
