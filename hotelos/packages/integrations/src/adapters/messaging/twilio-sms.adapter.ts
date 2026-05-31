// Twilio SMS adapter — fallback cuando WhatsApp falla o el huésped no lo tiene.
//
// SMS sigue siendo el canal universal en España para confirmaciones críticas
// (códigos OTP, cancelaciones). Twilio se elige porque cubre 200+ países y
// expone los webhooks de status callbacks que necesitamos.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingAdapter, SendMessageIntent, SendMessageResult } from "./types.js";

export type TwilioConfig = {
  mode: "stub" | "production";
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  webhookAuthToken?: string;
};

export class TwilioSmsAdapter implements MessagingAdapter {
  channel = "sms" as const;
  providerCode = "twilio" as const;

  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof config !== "object" || !config) return { ok: false, reason: "config must be object" };
    const c = config as Partial<TwilioConfig>;
    if (!c.mode || !["stub", "production"].includes(c.mode)) return { ok: false, reason: "mode must be stub|production" };
    if (c.mode === "production") {
      if (!c.accountSid) return { ok: false, reason: "accountSid required" };
      if (!c.authToken) return { ok: false, reason: "authToken required" };
      if (!c.fromNumber) return { ok: false, reason: "fromNumber required" };
    }
    return { ok: true };
  }

  async send(config: unknown, intent: SendMessageIntent): Promise<SendMessageResult> {
    const c = config as TwilioConfig;
    if (c.mode === "stub") {
      return {
        status: "sent",
        providerMessageId: `sm_stub_${intent.idempotencyKey.slice(0, 16)}`,
        sentAt: new Date().toISOString()
      };
    }
    const auth = "Basic " + Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");
    const body = new URLSearchParams({
      From: c.fromNumber ?? "",
      To: intent.recipient.to,
      Body: intent.body.slice(0, 1600)
    });
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const data = (await res.json()) as { sid?: string; message?: string; error_message?: string };
      if (!res.ok || !data.sid) {
        return { status: "failed", reason: data.error_message ?? `HTTP ${res.status}`, permanent: res.status === 400 };
      }
      return { status: "sent", providerMessageId: data.sid, sentAt: new Date().toISOString() };
    } catch (e) {
      return { status: "failed", reason: e instanceof Error ? e.message : "network error", permanent: false };
    }
  }

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    // Twilio's signature is X-Twilio-Signature: HMAC-SHA1 of full URL + sorted
    // POST params. We accept the body as the canonical sorted string for
    // simplicity here; production should reconstruct the URL.
    const sigHeader = headers["x-twilio-signature"] ?? headers["X-Twilio-Signature"];
    if (!sigHeader) return false;
    const expected = createHmac("sha1", secret).update(payload, "utf8").digest("base64");
    if (sigHeader.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  }
}

export const twilioSms = new TwilioSmsAdapter();
