// WhatsApp Cloud API · webhook de entrada (Tanda CHK · lote W4-D; diseño §2.6,
// §5 «Bot del huésped», §7.2 última fila, R11).
//
//   GET  /webhooks/whatsapp  — verificación de la suscripción en Meta:
//        hub.mode=subscribe + hub.verify_token === WHATSAPP_VERIFY_TOKEN →
//        200 text/plain con hub.challenge; token distinto → 403; sin variable → 503.
//   POST /webhooks/whatsapp  — mensajes entrantes. Cuerpo CRUDO (parser propio,
//        como /payments/webhooks/:provider) porque la firma X-Hub-Signature-256
//        (HMAC-SHA256 con WHATSAPP_APP_SECRET) se calcula sobre los bytes tal
//        cual (misma verificación que packages/integrations whatsapp.adapter.ts
//        verifyWebhook, copiada aquí para no arrastrar el paquete). Firma
//        inválida → 401. Sin secreto: 503 honesto en producción; fuera de
//        producción se procesa como SIMULADO (respuesta `simulated: true`).
//        Tras verificar responde SIEMPRE 200 (Meta reintenta ante cualquier
//        otro código): cada mensaje de texto se entrega a handleGuestMessage
//        con la propiedad resuelta por `metadata.phone_number_id` →
//        PropertyAiSetting.configurationJson.whatsappPhoneId; deduplicación
//        por `message.id` dentro del bot (Message.metadataJson.externalId);
//        un fallo por mensaje se cuenta (`failed`) y no tumba el lote.
//
// Sin JWT: `permissions: [], riskLevel: "public"` en security/route-permissions.ts
// y prefijo "/webhooks/whatsapp" en PUBLIC_PREFIXES (lib/auth-context.ts).
// Nunca se registra el número en claro (el bot guarda solo su hash).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "@hotelos/database";
import { createId } from "../lib/ids.js";
import { handleGuestMessage, type GuestBotInput, type GuestBotResult } from "../modules/checkin/guest-bot.service.js";

export const WHATSAPP_SIGNATURE_HEADER = "x-hub-signature-256";
export const WHATSAPP_WEBHOOK_NOT_CONFIGURED = "WHATSAPP_WEBHOOK_NOT_CONFIGURED";
export const WHATSAPP_SIGNATURE_INVALID = "WHATSAPP_SIGNATURE_INVALID";
export const WHATSAPP_VERIFY_TOKEN_INVALID = "WHATSAPP_VERIFY_TOKEN_INVALID";

/** Firma `sha256=<hex>` de Meta sobre el cuerpo crudo (whatsapp.adapter.ts:111, copia local). */
export function verifyWhatsappSignature(rawBody: string, signatureHeader: string | string[] | undefined, secret: string): boolean {
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] ?? "" : signatureHeader ?? "";
  if (!header.startsWith("sha256=") || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Firma para las pruebas y para curl (`X-Hub-Signature-256: sha256=<hex>`). */
export function signWhatsappPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export type InboundWhatsappMessage = {
  phoneNumberId: string;
  messageId: string;
  /** wa_id del remitente (dígitos sin «+»). */
  from: string;
  type: string;
  text: string | null;
};

/** Mensajes de un cuerpo de webhook de la Cloud API (entry[].changes[].value.messages[]); los `statuses` se ignoran. */
export function parseWhatsappWebhook(payload: unknown): InboundWhatsappMessage[] {
  const out: InboundWhatsappMessage[] = [];
  if (!payload || typeof payload !== "object") return out;
  const entries = Array.isArray((payload as { entry?: unknown }).entry) ? ((payload as { entry: unknown[] }).entry) : [];
  for (const entry of entries) {
    const changes = entry && typeof entry === "object" && Array.isArray((entry as { changes?: unknown }).changes) ? ((entry as { changes: unknown[] }).changes) : [];
    for (const change of changes) {
      const value = change && typeof change === "object" ? (change as { value?: Record<string, unknown> }).value : undefined;
      if (!value || typeof value !== "object") continue;
      const metadata = value.metadata && typeof value.metadata === "object" ? (value.metadata as Record<string, unknown>) : {};
      const phoneNumberId = typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : "";
      const messages = Array.isArray(value.messages) ? (value.messages as unknown[]) : [];
      for (const raw of messages) {
        if (!raw || typeof raw !== "object") continue;
        const message = raw as Record<string, unknown>;
        const messageId = typeof message.id === "string" ? message.id : "";
        const from = typeof message.from === "string" ? message.from.replace(/\D/g, "") : "";
        const type = typeof message.type === "string" ? message.type : "unknown";
        const body = type === "text" && message.text && typeof message.text === "object" ? (message.text as { body?: unknown }).body : null;
        if (!messageId || !from) continue;
        out.push({ phoneNumberId, messageId, from, type, text: typeof body === "string" ? body : null });
      }
    }
  }
  return out;
}

export type WhatsappWebhookSummary = {
  ok: true;
  simulated: boolean;
  received: number;
  processed: number;
  duplicates: number;
  ignored: number;
  failed: number;
};

export type WhatsappWebhookDeps = {
  /** phone_number_id de Meta → propiedad (PropertyAiSetting.configurationJson.whatsappPhoneId). */
  resolveProperty: (phoneNumberId: string) => Promise<string | null>;
  handle: (input: GuestBotInput) => Promise<GuestBotResult>;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, message: string) => void;
};

/** Variable explícita (tag dangerous) que admite cuerpos SIN firma fuera de producción (demo/staging); nunca NODE_ENV a secas. */
export const WHATSAPP_ALLOW_UNSIGNED_ENV = "WHATSAPP_WEBHOOK_ALLOW_UNSIGNED";

/**
 * Corrector Tanda CHK (SEC-5): sin WHATSAPP_APP_SECRET el webhook solo procesa
 * cuerpos sin firma cuando lo pide una variable explícita Y no es producción;
 * en cualquier otro caso responde 503 (mismo criterio que el webhook de pagos,
 * que rechaza sin secreto en todos los entornos). Pura.
 */
export function unsignedWebhookMode(env: { NODE_ENV?: string; WHATSAPP_APP_SECRET?: string; WHATSAPP_WEBHOOK_ALLOW_UNSIGNED?: string }): "signed" | "simulated" | "refused" {
  if ((env.WHATSAPP_APP_SECRET ?? "").trim()) return "signed";
  const allow = (env.WHATSAPP_WEBHOOK_ALLOW_UNSIGNED ?? "").trim().toLowerCase();
  if (env.NODE_ENV !== "production" && (allow === "1" || allow === "true")) return "simulated";
  return "refused";
}

const defaultDeps: WhatsappWebhookDeps = {
  resolveProperty: async (phoneNumberId) => {
    if (!phoneNumberId) return null;
    // Corrector SEC-4: sin unicidad en configurationJson.whatsappPhoneId una colisión enrutaba a una
    // propiedad arbitraria; con más de una coincidencia el mensaje se ignora con aviso (nunca se elige).
    const rows = await prisma.propertyAiSetting.findMany({ where: { configurationJson: { path: ["whatsappPhoneId"], equals: phoneNumberId } }, select: { propertyId: true }, take: 2 });
    if (rows.length > 1) {
      console.warn(JSON.stringify({ level: "warn", phoneNumberId, propertyIds: rows.map((row) => row.propertyId), message: "[webhooks.whatsapp] phone_number_id reclamado por más de una propiedad: mensaje ignorado" }));
      return null;
    }
    return rows[0]?.propertyId ?? null;
  },
  handle: (input) => handleGuestMessage(input),
  log: (level, data, message) => {
    const line = JSON.stringify({ level, ...data, message });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  }
};

/** Procesa un cuerpo ya verificado; exportado para las pruebas y reutilizado por la ruta. */
export async function processWhatsappWebhook(payload: unknown, options: { simulated: boolean; correlationId: string }, deps: Partial<WhatsappWebhookDeps> = {}): Promise<WhatsappWebhookSummary> {
  const d: WhatsappWebhookDeps = { ...defaultDeps, ...deps };
  const messages = parseWhatsappWebhook(payload);
  const summary: WhatsappWebhookSummary = { ok: true, simulated: options.simulated, received: messages.length, processed: 0, duplicates: 0, ignored: 0, failed: 0 };
  const propertyByPhoneId = new Map<string, string | null>();
  for (const message of messages) {
    if (message.type !== "text" || !message.text || !message.text.trim()) {
      summary.ignored += 1;
      continue;
    }
    let propertyId = propertyByPhoneId.get(message.phoneNumberId);
    if (propertyId === undefined) {
      propertyId = await d.resolveProperty(message.phoneNumberId);
      propertyByPhoneId.set(message.phoneNumberId, propertyId);
    }
    if (!propertyId) {
      summary.ignored += 1;
      d.log("warn", { correlationId: options.correlationId, phoneNumberId: message.phoneNumberId }, "[webhooks.whatsapp] phone_number_id sin propiedad (configurationJson.whatsappPhoneId): mensaje ignorado");
      continue;
    }
    try {
      const result = await d.handle({ channel: "whatsapp", propertyId, phone: `+${message.from}`, text: message.text, externalMessageId: message.messageId, correlationId: options.correlationId });
      if (result.duplicate) summary.duplicates += 1;
      else summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      d.log("error", { correlationId: options.correlationId, propertyId, messageId: message.messageId, err: error instanceof Error ? error.message : String(error) }, "[webhooks.whatsapp] mensaje no procesado");
    }
  }
  return summary;
}

export function registerWhatsappWebhookRoutes(app: FastifyInstance, deps: Partial<WhatsappWebhookDeps> = {}): void {
  app.get("/webhooks/whatsapp", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const mode = typeof query["hub.mode"] === "string" ? query["hub.mode"] : "";
    const token = typeof query["hub.verify_token"] === "string" ? query["hub.verify_token"] : "";
    const challenge = typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : "";
    const expected = (process.env.WHATSAPP_VERIFY_TOKEN ?? "").trim();
    if (!expected) {
      reply.code(503);
      return { message: "Webhook de WhatsApp sin WHATSAPP_VERIFY_TOKEN: la verificación no está configurada.", details: { code: WHATSAPP_WEBHOOK_NOT_CONFIGURED } };
    }
    const matches = mode === "subscribe" && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!matches) {
      reply.code(403);
      return { message: "Verify token de WhatsApp no válido.", details: { code: WHATSAPP_VERIFY_TOKEN_INVALID } };
    }
    return reply.code(200).type("text/plain").send(challenge);
  });

  // Cuerpo crudo: la firma se calcula sobre los bytes recibidos (mismo patrón que /payments/webhooks/:provider).
  app.register(async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });
    app.post("/webhooks/whatsapp", async (request, reply) => {
      const rawBody = typeof request.body === "string" ? request.body : request.body === undefined || request.body === null ? "" : JSON.stringify(request.body);
      const secret = (process.env.WHATSAPP_APP_SECRET ?? "").trim();
      const correlationId = createId("corr");
      const mode = unsignedWebhookMode(process.env);
      let simulated = false;
      if (mode === "refused") {
        reply.code(503);
        return { message: `Webhook de WhatsApp sin WHATSAPP_APP_SECRET: no se acepta ningún mensaje sin verificar la firma (fuera de producción, ${WHATSAPP_ALLOW_UNSIGNED_ENV}=1 admite cuerpos sin firma como SIMULADO).`, details: { code: WHATSAPP_WEBHOOK_NOT_CONFIGURED } };
      } else if (mode === "simulated") {
        simulated = true;
      } else if (!verifyWhatsappSignature(rawBody, request.headers[WHATSAPP_SIGNATURE_HEADER], secret)) {
        reply.code(401);
        return { message: "Firma X-Hub-Signature-256 no válida.", details: { code: WHATSAPP_SIGNATURE_INVALID } };
      }
      let payload: unknown = null;
      try {
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        // Cuerpo no JSON tras una firma válida: se acusa recibo (200) sin procesar nada.
        return reply.code(200).send({ ok: true, simulated, received: 0, processed: 0, duplicates: 0, ignored: 0, failed: 0 } satisfies WhatsappWebhookSummary);
      }
      const summary = await processWhatsappWebhook(payload, { simulated, correlationId }, deps);
      return reply.code(200).send(summary);
    });
  });
}
