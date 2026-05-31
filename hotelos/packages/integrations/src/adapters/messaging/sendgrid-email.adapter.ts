// SendGrid email adapter — canal por defecto para comunicaciones formales
// (confirmaciones, facturas, recibos). Usa API v3 con headers Authorization.

import type { MessagingAdapter, SendMessageIntent, SendMessageResult } from "./types.js";

export type SendGridConfig = {
  mode: "stub" | "production";
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  webhookPublicKey?: string;
};

export class SendGridEmailAdapter implements MessagingAdapter {
  channel = "email" as const;
  providerCode = "sendgrid" as const;

  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof config !== "object" || !config) return { ok: false, reason: "config must be object" };
    const c = config as Partial<SendGridConfig>;
    if (!c.mode || !["stub", "production"].includes(c.mode)) return { ok: false, reason: "mode must be stub|production" };
    if (c.mode === "production") {
      if (!c.apiKey) return { ok: false, reason: "apiKey required" };
      if (!c.fromEmail) return { ok: false, reason: "fromEmail required" };
    }
    return { ok: true };
  }

  async send(config: unknown, intent: SendMessageIntent): Promise<SendMessageResult> {
    const c = config as SendGridConfig;
    if (c.mode === "stub") {
      return {
        status: "sent",
        providerMessageId: `sg_stub_${intent.idempotencyKey.slice(0, 16)}`,
        sentAt: new Date().toISOString()
      };
    }
    const payload = {
      personalizations: [
        {
          to: [{ email: intent.recipient.to, name: intent.recipient.name }],
          subject: intent.subject ?? "Mensaje del hotel"
        }
      ],
      from: { email: c.fromEmail, name: c.fromName ?? "HotelOS" },
      content: [
        { type: "text/plain", value: intent.body },
        ...(intent.htmlBody ? [{ type: "text/html", value: intent.htmlBody }] : [])
      ],
      headers: { "X-HotelOS-Idempotency": intent.idempotencyKey }
    };
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text();
        return { status: "failed", reason: text.slice(0, 240), permanent: res.status === 400 };
      }
      // SendGrid returns x-message-id header on success.
      const id = res.headers.get("x-message-id") ?? `sg_${Date.now()}`;
      return { status: "sent", providerMessageId: id, sentAt: new Date().toISOString() };
    } catch (e) {
      return { status: "failed", reason: e instanceof Error ? e.message : "network error", permanent: false };
    }
  }

  verifyWebhook(_payload: string, _headers: Record<string, string>, _secret: string): boolean {
    // SendGrid uses ECDSA public-key verification (X-Twilio-Email-Event-Webhook-Signature).
    // Stub: accept everything. Wire properly when needed.
    return true;
  }
}

export const sendgridEmail = new SendGridEmailAdapter();
