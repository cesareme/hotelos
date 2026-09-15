// Redsys TPV Virtual (SIS) adapter — HMAC_SHA256_V1 as the SIS specifies it
// (Guía de integración del TPV Virtual, firma de la petición y de la
// notificación online):
//
//   1. key      = base64-decode(clave secreta del comercio)          (24 bytes)
//   2. keyOrder = 3DES-CBC(key, IV = 8 × 0x00, no padding) of DS_MERCHANT_ORDER
//                 zero-padded to a multiple of 8 bytes
//   3. Ds_MerchantParameters = base64(JSON of the DS_MERCHANT_* fields)
//   4. Ds_Signature = base64(HMAC-SHA256(keyOrder, Ds_MerchantParameters))
//
// The cardholder is sent with a POST form (Ds_SignatureVersion,
// Ds_MerchantParameters, Ds_Signature) to realizarPago; the SIS notifies the
// merchant URL with a form-encoded POST carrying the same three fields
// (Ds_Signature in base64url), which is verified by re-deriving the key from
// Ds_Order of the decoded parameters. Refunds use the REST endpoint
// (DS_MERCHANT_TRANSACTIONTYPE = 3) signed the same way. The previous
// adapter in packages/integrations derived the key with HMAC instead of
// 3DES, redirected with GET and read Ds_Signature from the headers — all
// three rejected by the SIS; this module replaces it for the API.
//
// Configuration (env, PAYMENTS_ENV_CONTRACT): REDSYS_MERCHANT_CODE (FUC),
// REDSYS_TERMINAL, REDSYS_SECRET_KEY, REDSYS_MODE (test | live). Nothing is
// called without them.

import { createCipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { headerValue, PspNotConfiguredError, type PspAdapter, type PspAdapterStatus, type PspCaptureResult, type PspMode, type PspPaymentLinkInput, type PspPaymentLinkResult, type PspRefundInput, type PspRefundResult, type PspWebhookInput, type PspWebhookVerification } from "./psp.types.js";

export const REDSYS_ENDPOINTS = Object.freeze({
  test: { form: "https://sis-t.redsys.es:25443/sis/realizarPago", rest: "https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST" },
  live: { form: "https://sis.redsys.es/sis/realizarPago", rest: "https://sis.redsys.es/sis/rest/trataPeticionREST" }
} as const);

export const REDSYS_SIGNATURE_VERSION = "HMAC_SHA256_V1";
/** ISO 4217 numeric codes accepted by the SIS. */
const CURRENCY_CODES: Record<string, string> = { EUR: "978", USD: "840", GBP: "826", CHF: "756" };

export type RedsysConfig = { merchantCode: string; terminal: string; secretKey: string; mode: PspMode };

/** Env-driven configuration; null when incomplete. Pure. */
export function redsysConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedsysConfig | null {
  const merchantCode = (env.REDSYS_MERCHANT_CODE ?? "").trim();
  const secretKey = (env.REDSYS_SECRET_KEY ?? "").trim();
  if (!merchantCode || !secretKey || secretKey === "change-me") return null;
  const mode: PspMode = (env.REDSYS_MODE ?? "test").trim().toLowerCase() === "live" ? "live" : "test";
  return { merchantCode, terminal: (env.REDSYS_TERMINAL ?? "001").trim() || "001", secretKey, mode };
}

/** Zero-pad to a multiple of 8 bytes (3DES block size). Pure. */
function zeroPad8(input: Buffer): Buffer {
  const remainder = input.length % 8;
  if (remainder === 0) return input;
  return Buffer.concat([input, Buffer.alloc(8 - remainder, 0)]);
}

/** Order-diversified key: 3DES-CBC (zero IV, no padding) of the order number with the merchant key. Pure. */
export function redsysDeriveOrderKey(secretKeyBase64: string, order: string): Buffer {
  const key = Buffer.from(secretKeyBase64, "base64");
  if (key.length !== 24) throw new Error(`Clave Redsys no válida: se esperan 24 bytes en base64 y se han decodificado ${key.length}.`);
  const cipher = createCipheriv("des-ede3-cbc", key, Buffer.alloc(8, 0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(zeroPad8(Buffer.from(order, "utf8"))), cipher.final()]);
}

/** Ds_Signature (standard base64) of a Ds_MerchantParameters string. Pure. */
export function redsysSign(secretKeyBase64: string, order: string, merchantParametersBase64: string): string {
  return createHmac("sha256", redsysDeriveOrderKey(secretKeyBase64, order)).update(merchantParametersBase64, "utf8").digest("base64");
}

/** base64 → base64url as the SIS sends signatures in notifications. Pure. */
export function toBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  return value.replace(/-/g, "+").replace(/_/g, "/");
}

/** Encode the DS_MERCHANT_* object as the SIS expects (base64 of the JSON). Pure. */
export function encodeMerchantParameters(params: Record<string, string>): string {
  return Buffer.from(JSON.stringify(params), "utf8").toString("base64");
}

/** Decode Ds_MerchantParameters (base64 or base64url) into an object; null when malformed. Pure. */
export function decodeMerchantParameters(encoded: string): Record<string, string> | null {
  try {
    const json = Buffer.from(fromBase64Url(encoded.trim()), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) out[key] = value === null || value === undefined ? "" : String(value);
    return out;
  } catch {
    return null;
  }
}

/**
 * DS_MERCHANT_ORDER for a payment intent: 12 characters, the first 4 numeric
 * (SIS rule), unique per merchant — 4 digits from the epoch seconds plus 8
 * characters of the intent id hash. Pure.
 */
export function redsysOrderFor(intentId: string, now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000) % 10000;
  const hash = createHash("sha256").update(intentId, "utf8").digest("hex").slice(0, 8).toUpperCase();
  return `${String(seconds).padStart(4, "0")}${hash}`;
}

/** Amount in minor units ("125.40" → "12540") with Decimal arithmetic. Pure. */
export function amountToMinorUnits(amount: string): string {
  return new PrismaRuntime.Decimal(amount).times(100).toDecimalPlaces(0, PrismaRuntime.Decimal.ROUND_HALF_UP).toFixed(0);
}

/** Ds_Response codes 0000-0099 are authorisations; 0900 is an accepted refund. Pure. */
export function redsysResponseAccepted(dsResponse: string | undefined, transactionType: string | undefined): boolean {
  const code = Number.parseInt(dsResponse ?? "", 10);
  if (!Number.isFinite(code)) return false;
  if (transactionType === "3") return code === 900;
  return code >= 0 && code <= 99;
}

/** Verify a SIS notification (form fields) against the merchant key. Pure. */
export function verifyRedsysNotification(secretKeyBase64: string, fields: { Ds_MerchantParameters?: string | null; Ds_Signature?: string | null; Ds_SignatureVersion?: string | null }): { ok: true; params: Record<string, string> } | { ok: false; reason: string } {
  if (fields.Ds_SignatureVersion && fields.Ds_SignatureVersion !== REDSYS_SIGNATURE_VERSION) return { ok: false, reason: `Ds_SignatureVersion no soportada: ${fields.Ds_SignatureVersion}` };
  const merchantParameters = fields.Ds_MerchantParameters?.trim();
  const signature = fields.Ds_Signature?.trim();
  if (!merchantParameters || !signature) return { ok: false, reason: "Faltan Ds_MerchantParameters o Ds_Signature." };
  const params = decodeMerchantParameters(merchantParameters);
  if (!params) return { ok: false, reason: "Ds_MerchantParameters no es base64/JSON válido." };
  const order = params.Ds_Order ?? params.DS_ORDER ?? "";
  if (!order) return { ok: false, reason: "La notificación no lleva Ds_Order." };
  let expected: string;
  try {
    expected = toBase64Url(redsysSign(secretKeyBase64, order, merchantParameters));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const received = toBase64Url(fromBase64Url(signature).replace(/=+$/, ""));
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "Ds_Signature no coincide con la firma calculada." };
  return { ok: true, params };
}

/** Parse the form-encoded (or JSON) body of a SIS notification into its three fields. Pure. */
export function parseRedsysNotificationBody(rawBody: string, contentType: string | null): { Ds_MerchantParameters?: string; Ds_Signature?: string; Ds_SignatureVersion?: string } {
  if ((contentType ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      return {
        Ds_MerchantParameters: typeof parsed.Ds_MerchantParameters === "string" ? parsed.Ds_MerchantParameters : undefined,
        Ds_Signature: typeof parsed.Ds_Signature === "string" ? parsed.Ds_Signature : undefined,
        Ds_SignatureVersion: typeof parsed.Ds_SignatureVersion === "string" ? parsed.Ds_SignatureVersion : undefined
      };
    } catch {
      return {};
    }
  }
  const form = new URLSearchParams(rawBody);
  return {
    Ds_MerchantParameters: form.get("Ds_MerchantParameters") ?? undefined,
    Ds_Signature: form.get("Ds_Signature") ?? undefined,
    Ds_SignatureVersion: form.get("Ds_SignatureVersion") ?? undefined
  };
}

export class RedsysAdapter implements PspAdapter {
  readonly provider = "redsys" as const;

  constructor(private readonly config: RedsysConfig | null = redsysConfigFromEnv()) {}

  status(): PspAdapterStatus {
    if (!this.config) {
      return { configured: false, provider: "redsys", mode: null, webhookSecretConfigured: false, message: "Redsys no está configurado: faltan REDSYS_MERCHANT_CODE / REDSYS_SECRET_KEY (y REDSYS_TERMINAL)." };
    }
    return { configured: true, provider: "redsys", mode: this.config.mode, webhookSecretConfigured: true, message: `Redsys configurado (${this.config.mode === "live" ? "producción" : "entorno de pruebas sis-t"}, comercio ${this.config.merchantCode}, terminal ${this.config.terminal}).` };
  }

  private require(): RedsysConfig {
    if (!this.config) throw new PspNotConfiguredError("redsys", this.status().message);
    return this.config;
  }

  /** Build the signed form for the hosted SIS page. */
  buildPaymentForm(input: PspPaymentLinkInput, order: string = redsysOrderFor(input.intentId)): { order: string; url: string; fields: Record<string, string> } {
    const config = this.require();
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: amountToMinorUnits(input.amount),
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: config.merchantCode,
      DS_MERCHANT_CURRENCY: CURRENCY_CODES[input.currency.toUpperCase()] ?? "978",
      DS_MERCHANT_TRANSACTIONTYPE: "0",
      DS_MERCHANT_TERMINAL: config.terminal,
      DS_MERCHANT_MERCHANTURL: input.notifyUrl,
      DS_MERCHANT_URLOK: input.returnUrl,
      DS_MERCHANT_URLKO: input.cancelUrl,
      DS_MERCHANT_PRODUCTDESCRIPTION: input.description.slice(0, 125),
      DS_MERCHANT_MERCHANTDATA: input.intentId
    };
    const merchantParameters = encodeMerchantParameters(params);
    return {
      order,
      url: REDSYS_ENDPOINTS[config.mode].form,
      fields: { Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: merchantParameters, Ds_Signature: redsysSign(config.secretKey, order, merchantParameters) }
    };
  }

  async createPaymentLink(input: PspPaymentLinkInput): Promise<PspPaymentLinkResult> {
    const form = this.buildPaymentForm(input);
    return { providerReference: form.order, redirect: { method: "POST", url: form.url, fields: form.fields }, expiresAt: null };
  }

  async capture(providerReference: string): Promise<PspCaptureResult> {
    this.require();
    // The basic SIS integration has no status query: the authorisation is
    // confirmed only by the notification online (verifyWebhook). Honest answer.
    return { status: "pending", providerReference, capturedAt: null, error: "Redsys confirma la operación por la notificación online; no hay consulta de estado en esta integración." };
  }

  async refund(input: PspRefundInput): Promise<PspRefundResult> {
    const config = this.require();
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: amountToMinorUnits(input.amount),
      DS_MERCHANT_ORDER: input.providerReference,
      DS_MERCHANT_MERCHANTCODE: config.merchantCode,
      DS_MERCHANT_CURRENCY: CURRENCY_CODES[input.currency.toUpperCase()] ?? "978",
      DS_MERCHANT_TRANSACTIONTYPE: "3",
      DS_MERCHANT_TERMINAL: config.terminal
    };
    const merchantParameters = encodeMerchantParameters(params);
    const body = { Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: merchantParameters, Ds_Signature: redsysSign(config.secretKey, input.providerReference, merchantParameters) };
    try {
      const response = await fetch(REDSYS_ENDPOINTS[config.mode].rest, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await response.text();
      if (!response.ok) return { status: "failed", providerReference: input.providerReference, error: `Redsys REST HTTP ${response.status}: ${text.slice(0, 200)}` };
      const parsed = JSON.parse(text) as { Ds_MerchantParameters?: string; Ds_Signature?: string; errorCode?: string };
      if (parsed.errorCode) return { status: "failed", providerReference: input.providerReference, error: `Redsys ${parsed.errorCode}` };
      const verified = verifyRedsysNotification(config.secretKey, { Ds_MerchantParameters: parsed.Ds_MerchantParameters, Ds_Signature: parsed.Ds_Signature, Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION });
      if (!verified.ok) return { status: "failed", providerReference: input.providerReference, error: `Respuesta Redsys con firma inválida: ${verified.reason}` };
      const accepted = redsysResponseAccepted(verified.params.Ds_Response, "3");
      return accepted
        ? { status: "refunded", providerReference: input.providerReference, error: null }
        : { status: "failed", providerReference: input.providerReference, error: `Redsys Ds_Response ${verified.params.Ds_Response ?? "?"}` };
    } catch (error) {
      return { status: "failed", providerReference: input.providerReference, error: error instanceof Error ? error.message : String(error) };
    }
  }

  verifyWebhook(input: PspWebhookInput): PspWebhookVerification {
    if (!this.config) return { ok: false, reason: this.status().message };
    const fields = parseRedsysNotificationBody(input.rawBody, input.contentType ?? headerValue(input.headers, "content-type"));
    const verified = verifyRedsysNotification(this.config.secretKey, fields);
    if (!verified.ok) return verified;
    const params = verified.params;
    const order = params.Ds_Order ?? "";
    const type = params.Ds_TransactionType ?? "0";
    const amount = params.Ds_Amount ? new PrismaRuntime.Decimal(params.Ds_Amount).div(100).toFixed(2) : null;
    const currency = Object.entries(CURRENCY_CODES).find(([, code]) => code === params.Ds_Currency)?.[0] ?? null;
    const intentId = params.Ds_MerchantData || null;
    if (type === "3") {
      return { ok: true, event: redsysResponseAccepted(params.Ds_Response, "3") ? { type: "refund.completed", providerReference: order, amount, raw: params } : { type: "ignored", reason: `Devolución rechazada Ds_Response ${params.Ds_Response}`, raw: params } };
    }
    if (redsysResponseAccepted(params.Ds_Response, type)) {
      return { ok: true, event: { type: "payment.captured", intentId, providerReference: order, amount, currency, raw: params } };
    }
    return { ok: true, event: { type: "payment.failed", intentId, providerReference: order, reason: `Ds_Response ${params.Ds_Response ?? "?"}`, raw: params } };
  }
}
