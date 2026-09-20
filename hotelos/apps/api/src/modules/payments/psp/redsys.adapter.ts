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
//
// Preautorización (Tanda CHK · W5-A, diseño §2.4 «Pagos»): mismo patrón de
// firma que el pago (tipo 0) y la devolución (tipo 3):
//   · `authorize` = DS_MERCHANT_TRANSACTIONTYPE 1 (preautorización, 30 días
//     Visa/MC según Redsys; los manuales bancarios aún dicen 7 días: confirmar
//     con el adquirente). Con `paymentMethodRef` (Ds_Merchant_Identifier de
//     «pago por referencia») se envía por REST con DS_MERCHANT_DIRECTPAYMENT
//     y los campos COF; sin él, formulario alojado (realizarPago) con
//     DS_MERCHANT_IDENTIFIER=REQUIRED para que el SIS devuelva el token en la
//     notificación → `pending` + `redirect`.
//   · `captureAuthorization` = tipo 2 (confirmación de preautorización, REST,
//     Ds_Response 0900 = aceptada); `releaseAuthorization` = tipo 9 (anulación
//     de preautorización, REST, Ds_Response 0400 = aceptada). Ambas exigen el
//     importe original: se recuerda por instancia desde `authorize` o se pasa
//     como segundo argumento; sin él la respuesta es `failed` honesta.
//   · `tokenizeFromReference`: el SIS no tiene consulta; el token
//     (Ds_Merchant_Identifier), la caducidad (Ds_ExpiryDate YYMM), la marca
//     (Ds_Card_Brand) y el número ENMASCARADO (Ds_Card_Number, «454881******0004»)
//     llegan en la respuesta REST o en la notificación: se guardan por
//     instancia (cardTokenFromRedsysParams) y, si no se recibieron, null.
//     Nunca se persiste un PAN: looksLikePan descarta cualquier valor completo.
//   · Notificación tipo 1 aceptada → evento `ignored` (una preautorización NO
//     es un cobro); tipo 2 aceptada (0900) → `payment.captured`; tipo 9 → ignored.
//
// Sandbox (createRedsysSandbox): transporte REST en memoria que verifica la
// firma de la petición con la clave pública de pruebas del SIS y responde
// firmado y determinista (0000 / 0900 / 0400, token sandbox_redsys_<hash>,
// tarjeta ficticia ******NNNN). Solo se activa cuando el llamador lo construye.

import { createCipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma as PrismaRuntime } from "@prisma/client";
import {
  authorizationNotConfigured,
  headerValue,
  looksLikePan,
  PspNotConfiguredError,
  type PspAdapter,
  type PspAdapterStatus,
  type PspAuthorizationInput,
  type PspAuthorizationReleaseResult,
  type PspAuthorizationResult,
  type PspCaptureResult,
  type PspCardToken,
  type PspMode,
  type PspPaymentLinkInput,
  type PspPaymentLinkResult,
  type PspRefundInput,
  type PspRefundResult,
  type PspWebhookInput,
  type PspWebhookVerification
} from "./psp.types.js";

export const REDSYS_ENDPOINTS = Object.freeze({
  test: { form: "https://sis-t.redsys.es:25443/sis/realizarPago", rest: "https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST" },
  live: { form: "https://sis.redsys.es/sis/realizarPago", rest: "https://sis.redsys.es/sis/rest/trataPeticionREST" }
} as const);

export const REDSYS_SIGNATURE_VERSION = "HMAC_SHA256_V1";
/** ISO 4217 numeric codes accepted by the SIS. */
const CURRENCY_CODES: Record<string, string> = { EUR: "978", USD: "840", GBP: "826", CHF: "756" };

export type RedsysConfig = {
  merchantCode: string;
  terminal: string;
  secretKey: string;
  mode: PspMode;
  /** Solo lo pone createRedsysSandbox: transporte REST en memoria, sin red. Nunca desde el entorno. */
  sandbox?: true;
};

/** DS_MERCHANT_TRANSACTIONTYPE que usa el adaptador. */
export const REDSYS_TRANSACTION_TYPES = Object.freeze({ payment: "0", authorization: "1", confirmation: "2", refund: "3", release: "9" } as const);

/** Ds_Card_Brand → marca en minúsculas (guía del SIS). */
export const REDSYS_CARD_BRANDS: Readonly<Record<string, string>> = Object.freeze({ "1": "visa", "2": "mastercard", "6": "diners", "7": "privada", "8": "amex", "9": "jcb", "22": "upi" });

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

/**
 * Ds_Response codes 0000-0099 are authorisations (payments, type 0, and
 * pre-authorisations, type 1); 0900 is an accepted refund (3) or an accepted
 * confirmation of a pre-authorisation (2); 0400 is an accepted cancellation
 * of a pre-authorisation (9). Pure.
 */
export function redsysResponseAccepted(dsResponse: string | undefined, transactionType: string | undefined): boolean {
  const code = Number.parseInt(dsResponse ?? "", 10);
  if (!Number.isFinite(code)) return false;
  if (transactionType === "3" || transactionType === "2") return code === 900;
  if (transactionType === "9") return code === 400;
  return code >= 0 && code <= 99;
}

/**
 * Token de tarjeta de una respuesta/notificación del SIS con «pago por
 * referencia»: Ds_Merchant_Identifier (token), Ds_ExpiryDate (YYMM),
 * Ds_Card_Number enmascarado (solo se toman los 4 últimos dígitos) y
 * Ds_Card_Brand. null sin token o si algún valor parece un PAN completo. Pure.
 */
export function cardTokenFromRedsysParams(params: Record<string, string>): PspCardToken | null {
  const tokenRef = (params.Ds_Merchant_Identifier ?? params.DS_MERCHANT_IDENTIFIER ?? "").trim();
  if (!tokenRef || tokenRef.toUpperCase() === "REQUIRED" || looksLikePan(tokenRef)) return null;
  const expiry = (params.Ds_ExpiryDate ?? params.DS_EXPIRYDATE ?? "").trim();
  const expiryMatch = /^([0-9]{2})([0-9]{2})$/.exec(expiry);
  if (!expiryMatch) return null;
  const expiryYear = 2000 + Number.parseInt(expiryMatch[1]!, 10);
  const expiryMonth = Number.parseInt(expiryMatch[2]!, 10);
  if (expiryMonth < 1 || expiryMonth > 12) return null;
  const masked = (params.Ds_Card_Number ?? params.DS_CARD_NUMBER ?? "").trim();
  if (looksLikePan(masked)) return null;
  const last4Match = /([0-9]{4})$/.exec(masked);
  if (!last4Match) return null;
  return { tokenRef, last4: last4Match[1]!, brand: REDSYS_CARD_BRANDS[(params.Ds_Card_Brand ?? params.DS_CARD_BRAND ?? "").trim()] ?? "card", expiryMonth, expiryYear };
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

/**
 * Verify a merchant REQUEST (form or REST body: DS_MERCHANT_* fields, the
 * order in DS_MERCHANT_ORDER) against the merchant key — what the SIS does on
 * arrival; used by the sandbox transport and by tests. Pure.
 */
export function verifyRedsysRequest(secretKeyBase64: string, fields: { Ds_MerchantParameters?: string | null; Ds_Signature?: string | null; Ds_SignatureVersion?: string | null }): { ok: true; params: Record<string, string> } | { ok: false; reason: string } {
  if (fields.Ds_SignatureVersion && fields.Ds_SignatureVersion !== REDSYS_SIGNATURE_VERSION) return { ok: false, reason: `Ds_SignatureVersion no soportada: ${fields.Ds_SignatureVersion}` };
  const merchantParameters = fields.Ds_MerchantParameters?.trim();
  const signature = fields.Ds_Signature?.trim();
  if (!merchantParameters || !signature) return { ok: false, reason: "Faltan Ds_MerchantParameters o Ds_Signature." };
  const params = decodeMerchantParameters(merchantParameters);
  if (!params) return { ok: false, reason: "Ds_MerchantParameters no es base64/JSON válido." };
  const order = params.DS_MERCHANT_ORDER ?? params.Ds_Merchant_Order ?? "";
  if (!order) return { ok: false, reason: "La petición no lleva DS_MERCHANT_ORDER." };
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

type RedsysAuthorizationMemo = { amount: string; currency: string; card: PspCardToken | null };

export class RedsysAdapter implements PspAdapter {
  readonly provider = "redsys" as const;
  /** Importe/moneda/token de cada preautorización vista por ESTA instancia (el SIS no tiene consulta de estado). */
  private readonly authorizations = new Map<string, RedsysAuthorizationMemo>();

  constructor(
    private readonly config: RedsysConfig | null = redsysConfigFromEnv(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  status(): PspAdapterStatus {
    if (!this.config) {
      return { configured: false, provider: "redsys", mode: null, webhookSecretConfigured: false, message: "Redsys no está configurado: faltan REDSYS_MERCHANT_CODE / REDSYS_SECRET_KEY (y REDSYS_TERMINAL)." };
    }
    if (this.config.sandbox) {
      return { configured: true, provider: "redsys", mode: "test", webhookSecretConfigured: true, message: "Redsys en SANDBOX local (respuestas REST deterministas firmadas con la clave pública de pruebas, sin red): solo demos y tests; ninguna tarjeta real." };
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
      const response = await this.fetchImpl(REDSYS_ENDPOINTS[config.mode].rest, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

  // ── Preautorización (Tanda CHK · W5-A) ────────────────────────────────────

  /** Petición REST firmada (trataPeticionREST) y respuesta verificada; error textual cuando el SIS o la firma fallan. */
  private async rest(params: Record<string, string>): Promise<{ ok: true; params: Record<string, string> } | { ok: false; error: string }> {
    const config = this.require();
    const order = params.DS_MERCHANT_ORDER!;
    const merchantParameters = encodeMerchantParameters(params);
    const body = { Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: merchantParameters, Ds_Signature: redsysSign(config.secretKey, order, merchantParameters) };
    try {
      const response = await this.fetchImpl(REDSYS_ENDPOINTS[config.mode].rest, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: `Redsys REST HTTP ${response.status}: ${text.slice(0, 200)}` };
      const parsed = JSON.parse(text) as { Ds_MerchantParameters?: string; Ds_Signature?: string; errorCode?: string };
      if (parsed.errorCode) return { ok: false, error: `Redsys ${parsed.errorCode}` };
      const verified = verifyRedsysNotification(config.secretKey, { Ds_MerchantParameters: parsed.Ds_MerchantParameters, Ds_Signature: parsed.Ds_Signature, Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION });
      if (!verified.ok) return { ok: false, error: `Respuesta Redsys con firma inválida: ${verified.reason}` };
      return { ok: true, params: verified.params };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Formulario alojado de preautorización (tipo 1) que pide el token de «pago por referencia» al SIS. */
  buildAuthorizationForm(input: PspAuthorizationInput, order: string = redsysOrderFor(input.intentId ?? `${input.folioId}:${input.amount}:${input.currency}`)): { order: string; url: string; fields: Record<string, string> } {
    const config = this.require();
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: amountToMinorUnits(input.amount),
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: config.merchantCode,
      DS_MERCHANT_CURRENCY: CURRENCY_CODES[input.currency.toUpperCase()] ?? "978",
      DS_MERCHANT_TRANSACTIONTYPE: REDSYS_TRANSACTION_TYPES.authorization,
      DS_MERCHANT_TERMINAL: config.terminal,
      DS_MERCHANT_MERCHANTURL: input.notifyUrl ?? "",
      DS_MERCHANT_URLOK: input.returnUrl ?? "",
      DS_MERCHANT_URLKO: input.cancelUrl ?? input.returnUrl ?? "",
      DS_MERCHANT_PRODUCTDESCRIPTION: `${input.reservationCode} · ${input.description ?? "Garantía de la estancia"}`.slice(0, 125),
      DS_MERCHANT_MERCHANTDATA: input.intentId ?? input.folioId,
      DS_MERCHANT_IDENTIFIER: "REQUIRED"
    };
    const merchantParameters = encodeMerchantParameters(params);
    return { order, url: REDSYS_ENDPOINTS[config.mode].form, fields: { Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: merchantParameters, Ds_Signature: redsysSign(config.secretKey, order, merchantParameters) } };
  }

  async authorize(input: PspAuthorizationInput): Promise<PspAuthorizationResult> {
    if (!this.config) return authorizationNotConfigured("redsys", this.status().message);
    if (input.paymentMethodRef && looksLikePan(input.paymentMethodRef)) {
      return { status: "failed", providerReference: "", expiresAt: null, error: "paymentMethodRef parece un número de tarjeta: solo se acepta el Ds_Merchant_Identifier de Redsys.", redirect: null, card: null };
    }
    const currency = input.currency.toUpperCase();
    const order = redsysOrderFor(input.idempotencyKey ?? input.intentId ?? `${input.folioId}:${input.amount}:${currency}`);
    if (!input.paymentMethodRef) {
      let form;
      try {
        form = this.buildAuthorizationForm(input, order);
      } catch (error) {
        return { status: "failed", providerReference: "", expiresAt: null, error: error instanceof Error ? error.message : String(error), redirect: null, card: null };
      }
      this.authorizations.set(order, { amount: input.amount, currency, card: null });
      return { status: "pending", providerReference: order, expiresAt: null, error: null, redirect: { method: "POST", url: form.url, fields: form.fields }, card: null };
    }
    // Pago por referencia (token guardado): preautorización directa por REST con
    // credencial almacenada (COF). DS_MERCHANT_COF_TXNID (id de la operación
    // inicial) no se conoce aquí: el adquirente puede exigirlo → Ds_Response lo dirá.
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: amountToMinorUnits(input.amount),
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: this.config.merchantCode,
      DS_MERCHANT_CURRENCY: CURRENCY_CODES[currency] ?? "978",
      DS_MERCHANT_TRANSACTIONTYPE: REDSYS_TRANSACTION_TYPES.authorization,
      DS_MERCHANT_TERMINAL: this.config.terminal,
      DS_MERCHANT_IDENTIFIER: input.paymentMethodRef,
      DS_MERCHANT_DIRECTPAYMENT: "true",
      DS_MERCHANT_COF_INI: "N",
      DS_MERCHANT_COF_TYPE: "N",
      DS_MERCHANT_PRODUCTDESCRIPTION: `${input.reservationCode} · ${input.description ?? "Garantía de la estancia"}`.slice(0, 125),
      DS_MERCHANT_MERCHANTDATA: input.intentId ?? input.folioId
    };
    const result = await this.rest(params);
    if (!result.ok) return { status: "failed", providerReference: order, expiresAt: null, error: result.error, redirect: null, card: null };
    const card = cardTokenFromRedsysParams(result.params);
    if (!redsysResponseAccepted(result.params.Ds_Response, REDSYS_TRANSACTION_TYPES.authorization)) {
      return { status: "failed", providerReference: order, expiresAt: null, error: `Redsys Ds_Response ${result.params.Ds_Response ?? "?"}`, redirect: null, card };
    }
    this.authorizations.set(order, { amount: input.amount, currency, card });
    // El SIS no devuelve la caducidad de la preautorización (30 días documentados): null, honesto.
    return { status: "authorized", providerReference: order, expiresAt: null, error: null, redirect: null, card };
  }

  async captureAuthorization(providerReference: string, amount?: string | null): Promise<PspCaptureResult> {
    const config = this.require();
    const memo = this.authorizations.get(providerReference);
    const toCapture = amount ?? memo?.amount ?? null;
    if (!toCapture) return { status: "failed", providerReference, capturedAt: null, error: "Redsys exige el importe a confirmar (tipo 2) y esta instancia no conoce el de la preautorización: pásalo explícitamente." };
    const result = await this.rest({
      DS_MERCHANT_AMOUNT: amountToMinorUnits(toCapture),
      DS_MERCHANT_ORDER: providerReference,
      DS_MERCHANT_MERCHANTCODE: config.merchantCode,
      DS_MERCHANT_CURRENCY: CURRENCY_CODES[memo?.currency ?? "EUR"] ?? "978",
      DS_MERCHANT_TRANSACTIONTYPE: REDSYS_TRANSACTION_TYPES.confirmation,
      DS_MERCHANT_TERMINAL: config.terminal
    });
    if (!result.ok) return { status: "failed", providerReference, capturedAt: null, error: result.error };
    return redsysResponseAccepted(result.params.Ds_Response, REDSYS_TRANSACTION_TYPES.confirmation)
      ? { status: "captured", providerReference, capturedAt: new Date().toISOString(), error: null }
      : { status: "failed", providerReference, capturedAt: null, error: `Redsys Ds_Response ${result.params.Ds_Response ?? "?"}` };
  }

  async releaseAuthorization(providerReference: string, amount?: string | null): Promise<PspAuthorizationReleaseResult> {
    const config = this.require();
    const memo = this.authorizations.get(providerReference);
    const toRelease = amount ?? memo?.amount ?? null;
    if (!toRelease) return { status: "failed", providerReference, error: "Redsys exige el importe original para anular (tipo 9) y esta instancia no conoce el de la preautorización: pásalo explícitamente." };
    const result = await this.rest({
      DS_MERCHANT_AMOUNT: amountToMinorUnits(toRelease),
      DS_MERCHANT_ORDER: providerReference,
      DS_MERCHANT_MERCHANTCODE: config.merchantCode,
      DS_MERCHANT_CURRENCY: CURRENCY_CODES[memo?.currency ?? "EUR"] ?? "978",
      DS_MERCHANT_TRANSACTIONTYPE: REDSYS_TRANSACTION_TYPES.release,
      DS_MERCHANT_TERMINAL: config.terminal
    });
    if (!result.ok) return { status: "failed", providerReference, error: result.error };
    return redsysResponseAccepted(result.params.Ds_Response, REDSYS_TRANSACTION_TYPES.release)
      ? { status: "released", providerReference, error: null }
      : { status: "failed", providerReference, error: `Redsys Ds_Response ${result.params.Ds_Response ?? "?"}` };
  }

  /** Token recibido en la respuesta REST o en la notificación de ESTA instancia; null si el SIS no lo entregó (no hay consulta). */
  async tokenizeFromReference(providerReference: string): Promise<PspCardToken | null> {
    this.require();
    return this.authorizations.get(providerReference)?.card ?? null;
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
    if (type === REDSYS_TRANSACTION_TYPES.authorization) {
      // Preautorización: NO es un cobro. Se recuerda el token (pago por referencia) y se ignora como evento de pago.
      const accepted = redsysResponseAccepted(params.Ds_Response, type);
      if (accepted) this.authorizations.set(order, { amount: amount ?? this.authorizations.get(order)?.amount ?? "0.00", currency: currency ?? "EUR", card: cardTokenFromRedsysParams(params) });
      return { ok: true, event: accepted ? { type: "ignored", reason: `Preautorización ${order} aceptada (tipo 1): no es un cobro; se confirma con captureAuthorization.`, raw: params } : { type: "payment.failed", intentId, providerReference: order, reason: `Preautorización rechazada Ds_Response ${params.Ds_Response ?? "?"}`, raw: params } };
    }
    if (type === REDSYS_TRANSACTION_TYPES.release) {
      return { ok: true, event: { type: "ignored", reason: `Anulación de preautorización ${order} Ds_Response ${params.Ds_Response ?? "?"}`, raw: params } };
    }
    if (redsysResponseAccepted(params.Ds_Response, type)) {
      return { ok: true, event: { type: "payment.captured", intentId, providerReference: order, amount, currency, raw: params } };
    }
    return { ok: true, event: { type: "payment.failed", intentId, providerReference: order, reason: `Ds_Response ${params.Ds_Response ?? "?"}`, raw: params } };
  }
}

// ── Sandbox determinista (sin red) ───────────────────────────────────────────

/** Clave pública de PRUEBAS del SIS (guía de integración, entorno sis-t): sin comercio ni dinero real. */
export const REDSYS_SANDBOX_SECRET_KEY = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
/** Código de comercio de pruebas documentado por Redsys. */
export const REDSYS_SANDBOX_MERCHANT_CODE = "999008881";

type RedsysSandboxOperation = { order: string; amount: string; currency: string; status: "authorized" | "captured" | "released" | "paid" | "refunded" };

export type RedsysSandboxState = {
  operations: Map<string, RedsysSandboxOperation>;
  /** Peticiones REST recibidas (parámetros DS_MERCHANT_* ya decodificados). */
  calls: Array<Record<string, string>>;
};

/** Últimos 4 dígitos ficticios derivados de un hash (solo 4 dígitos, nunca un PAN). Pure. */
export function redsysSandboxLast4(seed: string): string {
  return String(Number.parseInt(createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 8), 16) % 10000).padStart(4, "0");
}

/**
 * Transporte REST del SIS en memoria: verifica la firma de la petición con la
 * clave de pruebas, aplica la máquina de estados de la preautorización
 * (1 → 2 | 9; 0 → 3) y responde firmado: 0000 (tipo 0/1), 0900 (2/3), 0400
 * (9); SIS0054 cuando la operación no existe o la transición no es válida.
 * Con DS_MERCHANT_IDENTIFIER (REQUIRED o token) devuelve el token de «pago
 * por referencia» sandbox_redsys_<hash>, Ds_ExpiryDate YYMM, Ds_Card_Number
 * enmascarado y Ds_Card_Brand 1 (visa). Pure salvo el estado del sandbox.
 */
export function createRedsysSandboxFetch(options: { secretKey?: string; now?: () => Date } = {}): { fetch: typeof fetch; state: RedsysSandboxState } {
  const secretKey = options.secretKey ?? REDSYS_SANDBOX_SECRET_KEY;
  const now = options.now ?? (() => new Date());
  const operations = new Map<string, RedsysSandboxOperation>();
  const calls: RedsysSandboxState["calls"] = [];
  const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const signed = (params: Record<string, string>): Response => {
    const merchantParameters = encodeMerchantParameters(params);
    return json(200, { Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: merchantParameters, Ds_Signature: redsysSign(secretKey, params.Ds_Order!, merchantParameters) });
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url instanceof Request ? url.url : url);
    if (!href.endsWith("/sis/rest/trataPeticionREST")) return json(404, { errorCode: "SIS_SANDBOX_ROUTE", message: `Ruta no soportada por el sandbox de Redsys: ${href}` });
    let request: { Ds_MerchantParameters?: string; Ds_Signature?: string; Ds_SignatureVersion?: string };
    try {
      request = JSON.parse(typeof init?.body === "string" ? init.body : String(init?.body ?? "{}")) as typeof request;
    } catch {
      return json(200, { errorCode: "SIS0042" });
    }
    const verified = verifyRedsysRequest(secretKey, request);
    if (!verified.ok) return json(200, { errorCode: "SIS0042" });
    const params = verified.params;
    calls.push(params);
    const order = params.DS_MERCHANT_ORDER ?? params.Ds_Order ?? "";
    const type = params.DS_MERCHANT_TRANSACTIONTYPE ?? "0";
    const amount = params.DS_MERCHANT_AMOUNT ?? "0";
    const currency = params.DS_MERCHANT_CURRENCY ?? "978";
    const at = now();
    const base: Record<string, string> = {
      Ds_Date: `${String(at.getUTCDate()).padStart(2, "0")}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${at.getUTCFullYear()}`,
      Ds_Hour: `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`,
      Ds_Amount: amount,
      Ds_Currency: currency,
      Ds_Order: order,
      Ds_MerchantCode: params.DS_MERCHANT_MERCHANTCODE ?? REDSYS_SANDBOX_MERCHANT_CODE,
      Ds_Terminal: params.DS_MERCHANT_TERMINAL ?? "001",
      Ds_TransactionType: type,
      Ds_SecurePayment: "0",
      Ds_AuthorisationCode: createHash("sha256").update(`${order}:${type}`, "utf8").digest("hex").slice(0, 6).toUpperCase(),
      Ds_MerchantData: params.DS_MERCHANT_MERCHANTDATA ?? ""
    };
    const withCard = (out: Record<string, string>): Record<string, string> => {
      const identifier = (params.DS_MERCHANT_IDENTIFIER ?? "").trim();
      if (!identifier) return out;
      const tokenRef = identifier.toUpperCase() === "REQUIRED" ? `sandbox_redsys_${createHash("sha256").update(order, "utf8").digest("hex").slice(0, 12)}` : identifier;
      return { ...out, Ds_Merchant_Identifier: tokenRef, Ds_ExpiryDate: `${String((at.getUTCFullYear() + 3) % 100).padStart(2, "0")}12`, Ds_Card_Number: `******${redsysSandboxLast4(tokenRef)}`, Ds_Card_Brand: "1", Ds_Card_Country: "724" };
    };
    const existing = operations.get(order);
    switch (type) {
      case REDSYS_TRANSACTION_TYPES.authorization: {
        if (existing) return json(200, { errorCode: "SIS0051" }); // pedido repetido
        operations.set(order, { order, amount, currency, status: "authorized" });
        return signed(withCard({ ...base, Ds_Response: "0000" }));
      }
      case REDSYS_TRANSACTION_TYPES.payment: {
        if (existing) return json(200, { errorCode: "SIS0051" });
        operations.set(order, { order, amount, currency, status: "paid" });
        return signed(withCard({ ...base, Ds_Response: "0000" }));
      }
      case REDSYS_TRANSACTION_TYPES.confirmation: {
        if (!existing || existing.status !== "authorized") return json(200, { errorCode: "SIS0054" });
        if (Number(amount) > Number(existing.amount)) return signed({ ...base, Ds_Response: "0190" });
        existing.status = "captured";
        return signed({ ...base, Ds_Response: "0900" });
      }
      case REDSYS_TRANSACTION_TYPES.release: {
        if (!existing || existing.status !== "authorized") return json(200, { errorCode: "SIS0054" });
        existing.status = "released";
        return signed({ ...base, Ds_Response: "0400" });
      }
      case REDSYS_TRANSACTION_TYPES.refund: {
        if (!existing || (existing.status !== "paid" && existing.status !== "captured")) return json(200, { errorCode: "SIS0054" });
        existing.status = "refunded";
        return signed({ ...base, Ds_Response: "0900" });
      }
      default:
        return json(200, { errorCode: "SIS0021" });
    }
  }) as typeof fetch;
  return { fetch: fetchImpl, state: { operations, calls } };
}

/** Adaptador de Redsys en sandbox local (demo/tests): configurado, determinista, sin red. */
export function createRedsysSandbox(options: { now?: () => Date } = {}): { adapter: RedsysAdapter; state: RedsysSandboxState } {
  const transport = createRedsysSandboxFetch(options);
  return { adapter: new RedsysAdapter({ merchantCode: REDSYS_SANDBOX_MERCHANT_CODE, terminal: "001", secretKey: REDSYS_SANDBOX_SECRET_KEY, mode: "test", sandbox: true }, transport.fetch), state: transport.state };
}
