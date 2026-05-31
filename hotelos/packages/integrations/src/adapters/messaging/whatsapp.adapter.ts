// WhatsApp Business Cloud API adapter (Meta).
//
// Es el canal de mensajería preferido por el huésped europeo para comunicarse
// con el hotel (95% adopción en España). Meta exige:
//   - Plantillas pre-aprobadas para iniciar conversación fuera de la "service
//     window" de 24 horas.
//   - Verificación del business + número aprobado.
//   - Webhooks firmados con X-Hub-Signature-256 (HMAC-SHA256 del body).
//
// La adapter funciona en `stub`/`sandbox`/`production`. En stub no hace
// red — devuelve un id sintético para que el resto del pipeline arranque sin
// claves.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingAdapter, SendMessageIntent, SendMessageResult } from "./types.js";

export type WhatsAppConfig = {
  mode: "stub" | "sandbox" | "production";
  /** Phone number ID asignado en Meta Business Suite. */
  phoneNumberId?: string;
  /** Permanent access token (Meta). */
  accessToken?: string;
  /** Secret para verificar webhooks (configurado en App Settings → Webhooks). */
  webhookSecret?: string;
  apiVersion?: string;
};

const DEFAULT_API_VERSION = "v20.0";

export class WhatsAppAdapter implements MessagingAdapter {
  channel = "whatsapp" as const;
  providerCode = "whatsapp_cloud" as const;

  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof config !== "object" || !config) return { ok: false, reason: "config must be object" };
    const c = config as Partial<WhatsAppConfig>;
    if (!c.mode || !["stub", "sandbox", "production"].includes(c.mode)) {
      return { ok: false, reason: "mode must be stub|sandbox|production" };
    }
    if (c.mode !== "stub") {
      if (!c.phoneNumberId) return { ok: false, reason: "phoneNumberId required" };
      if (!c.accessToken) return { ok: false, reason: "accessToken required" };
    }
    return { ok: true };
  }

  async send(config: unknown, intent: SendMessageIntent): Promise<SendMessageResult> {
    const c = config as WhatsAppConfig;
    if (c.mode === "stub") {
      return {
        status: "sent",
        providerMessageId: `wamid_stub_${intent.idempotencyKey.slice(0, 16)}`,
        sentAt: new Date().toISOString()
      };
    }

    const apiVersion = c.apiVersion ?? DEFAULT_API_VERSION;
    const url = `https://graph.facebook.com/${apiVersion}/${c.phoneNumberId}/messages`;

    // Build the payload: prefer template if provided (required outside 24h
    // service window). Otherwise send a free-form text message.
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: intent.recipient.to,
      recipient_type: "individual"
    };
    if (intent.template) {
      payload.type = "template";
      payload.template = {
        name: intent.template.templateName,
        language: { code: intent.recipient.language ?? "es" },
        components:
          intent.template.variables.length > 0
            ? [
                {
                  type: "body",
                  parameters: intent.template.variables.map((v) => ({ type: "text", text: v }))
                }
              ]
            : []
      };
    } else {
      payload.type = "text";
      payload.text = { body: intent.body };
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const data = (await res.json()) as { messages?: Array<{ id: string }>; error?: { message: string } };
      if (!res.ok || !data.messages?.[0]?.id) {
        const reason = data.error?.message ?? `HTTP ${res.status}`;
        return { status: "failed", reason, permanent: res.status === 400 };
      }
      return {
        status: "sent",
        providerMessageId: data.messages[0].id,
        sentAt: new Date().toISOString()
      };
    } catch (e) {
      return { status: "failed", reason: e instanceof Error ? e.message : "network error", permanent: false };
    }
  }

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    const sigHeader = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"] ?? "";
    if (!sigHeader.startsWith("sha256=")) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    if (sigHeader.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  }
}

export const whatsapp = new WhatsAppAdapter();
