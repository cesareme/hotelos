// Pago o garantía del pre-check-in (Tanda CHK · lote W5-A; diseño §1.7,
// §2.4 «Pagos», §4a paso 7, §9 L8, D3).
//
//   · resolveGuestPayment({ session, policy, folio, reservation, adapter? })
//     → { mode: none | link | authorize | at_reception, amount, … }. El importe
//     sale de depositPolicy: `balance` = saldo del folio; `first_night` =
//     total / noches; `fixed` = depositAmount; `none` = nada exigido (si hay
//     saldo, el enlace es opcional). `authorize` SOLO cuando la política exige
//     depósito (≠ none) y el adaptador resuelto implementa la extensión de
//     preautorización con credenciales (pspSupportsAuthorization); si no,
//     `link` (POST /guest-portal/check-in/payment-link, W3-A); sin PSP →
//     `at_reception`, sin fingir. paid / authorized ya cumplidos → `none`.
//   · authorizeGuestPayment(...) crea el PaymentIntent propio (id determinista
//     por clientRequestId, como createPaymentLink), llama a adapter.authorize
//     con capture_method manual / tipo 1 (token guardado del titular →
//     off-session; si no, página alojada → pending + redirect) y deja la sesión
//     en paymentStatus authorized | link_sent | failed con auditoría
//     CheckInPaymentStatusChanged + PAYMENT_AUTHORIZATION_CREATED. Nunca
//     inventa una autorización: el estado es el que devuelve el adaptador.
//   · recordPaymentEvidence({ session, providerReference }) → PaymentToken
//     (organizationId, guestId del titular, provider, tokenRef — cifrado en
//     reposo por PII_FIELDS.PaymentToken —, last4, brand, caducidad) y
//     GuestRegisterRecord.payment* del parte del titular (paymentType card,
//     paymentMethodIdentifier «<marca> ****<últimos 4>», titular, caducidad,
//     fecha, referencia = id del PaymentIntent propio) por update directo
//     (correctGuestRegisterRecord solo admite GuestIdentityFields, sin
//     campos de pago). NUNCA el PAN: looksLikePan bloquea token, últimos 4 e
//     identificador antes de escribir (Anexo I A.4 · AEPD minimización).
//
// Sin lectura de variables de entorno (las URLs públicas del proveedor las
// pasa el llamador). Sin ruta HTTP propia: el lote que cablee la ruta usa
// authorizeGuestPayment desde checkin.routes.ts.

import type { DepositPolicy, PropertyCheckInPolicyDto, PspProviderCode } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { paymentIntentIdFor } from "../payments/payments.service.js";
import { resolvePspAdapter } from "../payments/psp/index.js";
import {
  clampCaptureWindowDays,
  looksLikePan,
  PSP_AUTHORIZATION_MIN_DAYS,
  pspSupportsAuthorization,
  type PspAdapter,
  type PspAuthorizationResult,
  type PspCardToken
} from "../payments/psp/psp.types.js";
import { checkInServiceContext } from "./service-context.js";

const DAY_MS = 86_400_000;
/** Mismo umbral que arrival.service / la ruta payment-link: medio céntimo. */
export const GUEST_PAYMENT_EPSILON = 0.005;
/** paymentStatus que ya cumplen la garantía: no se vuelve a pedir nada. */
export const GUEST_PAYMENT_SETTLED_STATUSES: readonly string[] = Object.freeze(["paid", "authorized"]);

export type GuestPaymentMode = "none" | "link" | "authorize" | "at_reception";

/** Sesión mínima que necesita el servicio (fila Prisma CheckInSession o un doble). */
export type GuestPaymentSession = {
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  paymentStatus: string;
  paymentIntentId: string | null;
  paymentTokenId: string | null;
};

/** Saldo del folio (forma de findReservationFolio: primary folio + reservationBalanceDue) o null sin folio. */
export type GuestPaymentFolio = {
  folio: { id: string; currency?: string | null };
  balanceDue: number;
  paymentsTotal: number;
  reservationBalanceDue?: number;
} | null;

export type GuestPaymentReservation = {
  code?: string | null;
  totalAmount: unknown;
  arrivalDate: Date | string;
  departureDate: Date | string;
  currency?: string | null;
  bookerEmail?: string | null;
} | null;

export type GuestPaymentBreakdown = {
  basis: DepositPolicy;
  /** Importe exigido por la política (saldo, primera noche o fijo) antes de descontar lo pagado. */
  required: number;
  /** Cobrado ya en el folio (Σ pagos − reembolsos). */
  paid: number;
  balanceDue: number;
  nights: number;
  /** Importe cobrable por enlace / en recepción: min(required − paid, saldo), nunca negativo. */
  collectable: number;
  /** Importe a garantizar por preautorización: required − paid (una garantía no exige cargos ya contabilizados), nunca negativo. */
  guarantee: number;
};

export type GuestPaymentResolution = {
  mode: GuestPaymentMode;
  /** Importe del modo elegido: garantía (authorize) o cobrable (link / at_reception); 0 con `none`. */
  amount: number;
  currency: string;
  /** true cuando depositPolicy ≠ none (el saldo bloquea el check-in autónomo, W3-A balanceVerdict). */
  required: boolean;
  provider: PspProviderCode | null;
  reason: "already_settled" | "nothing_due" | "deposit_policy" | "balance_due" | "psp_not_configured" | "psp_without_authorization";
  breakdown: GuestPaymentBreakdown;
};

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function toDay(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

/** Noches de la reserva (≥ 1), por días enteros UTC como arrival.service. Pure. */
export function reservationNights(reservation: Pick<NonNullable<GuestPaymentReservation>, "arrivalDate" | "departureDate">): number {
  const from = new Date(`${toDay(reservation.arrivalDate)}T00:00:00.000Z`).getTime();
  const to = new Date(`${toDay(reservation.departureDate)}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.round((to - from) / DAY_MS));
}

/**
 * Importes según depositPolicy (diseño §4a paso 7; misma aritmética que
 * balanceVerdict de arrival.service para que el portal pida exactamente lo que
 * la llegada exigirá). Pure.
 */
export function guestPaymentAmount(input: {
  policy: Pick<PropertyCheckInPolicyDto, "depositPolicy" | "depositAmount">;
  folio: GuestPaymentFolio;
  reservation: GuestPaymentReservation;
}): GuestPaymentBreakdown {
  const basis = input.policy.depositPolicy;
  const balanceDue = money(Math.max(0, input.folio?.balanceDue ?? 0));
  const paid = money(Math.max(0, input.folio?.paymentsTotal ?? 0));
  const nights = input.reservation ? reservationNights(input.reservation) : 1;
  let required: number;
  if (basis === "balance") required = balanceDue;
  else if (basis === "first_night") required = money((Number(input.reservation?.totalAmount ?? 0) || 0) / nights);
  else if (basis === "fixed") required = money(Number(input.policy.depositAmount ?? 0) || 0);
  else required = 0;
  const outstanding = basis === "balance" ? balanceDue : Math.max(0, money(required - paid));
  const collectable = basis === "none" ? balanceDue : money(Math.min(outstanding, balanceDue));
  const guarantee = basis === "none" ? 0 : money(outstanding);
  return { basis, required, paid, balanceDue, nights, collectable, guarantee };
}

/**
 * Modo de pago o garantía del pre-check-in. `adapter` undefined → se resuelve
 * el PSP de la propiedad (resolvePspAdapter); null → «sin PSP» explícito.
 */
export async function resolveGuestPayment(input: {
  session: Pick<GuestPaymentSession, "propertyId" | "paymentStatus">;
  policy: Pick<PropertyCheckInPolicyDto, "depositPolicy" | "depositAmount">;
  folio: GuestPaymentFolio;
  reservation?: GuestPaymentReservation;
  adapter?: PspAdapter | null;
}): Promise<GuestPaymentResolution> {
  const breakdown = guestPaymentAmount({ policy: input.policy, folio: input.folio, reservation: input.reservation ?? null });
  const currency = (input.folio?.folio.currency ?? input.reservation?.currency ?? "EUR").toUpperCase();
  const required = input.policy.depositPolicy !== "none";
  const none = (reason: GuestPaymentResolution["reason"], provider: PspProviderCode | null): GuestPaymentResolution => ({ mode: "none", amount: 0, currency, required, provider, reason, breakdown });
  if (GUEST_PAYMENT_SETTLED_STATUSES.includes(input.session.paymentStatus)) return none("already_settled", null);
  const adapter = input.adapter === undefined ? await resolvePspAdapter(input.session.propertyId) : input.adapter;
  const provider = adapter?.provider ?? null;
  if (!adapter) {
    if (breakdown.collectable <= GUEST_PAYMENT_EPSILON) return none("nothing_due", null);
    return { mode: "at_reception", amount: breakdown.collectable, currency, required, provider: null, reason: "psp_not_configured", breakdown };
  }
  if (required && pspSupportsAuthorization(adapter)) {
    if (breakdown.guarantee <= GUEST_PAYMENT_EPSILON) return none("nothing_due", provider);
    return { mode: "authorize", amount: breakdown.guarantee, currency, required, provider, reason: "deposit_policy", breakdown };
  }
  if (breakdown.collectable <= GUEST_PAYMENT_EPSILON) return none("nothing_due", provider);
  return { mode: "link", amount: breakdown.collectable, currency, required, provider, reason: required ? "psp_without_authorization" : "balance_due", breakdown };
}

// ── Preautorización ──────────────────────────────────────────────────────────

export type GuestAuthorizationOutcome =
  | { status: "not_applicable"; resolution: GuestPaymentResolution }
  | {
      status: "authorized" | "pending" | "failed";
      resolution: GuestPaymentResolution;
      intent: { id: string; status: string; amount: number; currency: string; provider: PspProviderCode; providerReference: string | null };
      /** Página alojada cuando `pending` (sin token guardado). */
      redirect: PspAuthorizationResult["redirect"];
      /** Límite de captura: el del proveedor o, si no lo comunica, la ventana pedida (`policy`). */
      expiresAt: string | null;
      expiresAtSource: "provider" | "policy" | null;
      captureWindowDays: number;
      /** True cuando la autorización reutilizó un token guardado del titular (off-session). */
      usedStoredToken: boolean;
      idempotent: boolean;
      error: string | null;
      evidence: PaymentEvidenceResult | null;
    };

/** Días de ventana de captura: hasta la salida + 1, acotados a [7, 30]. Pure. */
export function captureWindowDaysFor(reservation: GuestPaymentReservation, now: Date = new Date()): number {
  if (!reservation) return PSP_AUTHORIZATION_MIN_DAYS;
  const departure = new Date(`${toDay(reservation.departureDate)}T00:00:00.000Z`).getTime();
  return clampCaptureWindowDays((departure - now.getTime()) / DAY_MS + 1);
}

async function storedTokenFor(input: { organizationId: string; sessionId: string; provider: PspProviderCode }): Promise<{ id: string; tokenRef: string } | null> {
  const primary = await prisma.checkInGuest.findFirst({ where: { sessionId: input.sessionId, isPrimary: true }, select: { guestId: true } });
  if (!primary?.guestId) return null;
  const token = await prisma.paymentToken.findFirst({
    where: { organizationId: input.organizationId, guestId: primary.guestId, provider: input.provider, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    select: { id: true, tokenRef: true }
  });
  if (!token || looksLikePan(token.tokenRef)) return null;
  return token;
}

async function setSessionPaymentStatus(input: { context: UserContext; session: GuestPaymentSession; paymentStatus: string; paymentIntentId?: string | null; extra: Record<string, unknown>; correlationId: string }): Promise<void> {
  if (input.session.paymentStatus === input.paymentStatus && (input.paymentIntentId === undefined || input.session.paymentIntentId === input.paymentIntentId)) return;
  await prisma.checkInSession.update({
    where: { id: input.session.id },
    data: { paymentStatus: input.paymentStatus, ...(input.paymentIntentId !== undefined ? { paymentIntentId: input.paymentIntentId } : {}) }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.session.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "CheckInPaymentStatusChanged",
    entityType: "checkin_session",
    entityId: input.session.id,
    beforeJson: { paymentStatus: input.session.paymentStatus },
    afterJson: { paymentStatus: input.paymentStatus, ...input.extra },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  input.session.paymentStatus = input.paymentStatus;
  if (input.paymentIntentId !== undefined) input.session.paymentIntentId = input.paymentIntentId;
}

/**
 * Preautoriza la garantía del pre-check-in. Idempotente por clientRequestId
 * (por defecto `checkin-auth:<sessionId>:<importe>`): un PaymentIntent ya
 * autorizado o pendiente se devuelve tal cual; uno `failed` exige otro
 * clientRequestId (no se reintenta a ciegas contra el proveedor).
 */
export async function authorizeGuestPayment(input: {
  session: GuestPaymentSession;
  policy: Pick<PropertyCheckInPolicyDto, "depositPolicy" | "depositAmount">;
  folio: GuestPaymentFolio;
  reservation: GuestPaymentReservation;
  adapter?: PspAdapter | null;
  /** Token del PSP a usar (pm_… / Ds_Merchant_Identifier); por defecto el PaymentToken guardado del titular, si existe. */
  paymentMethodRef?: string | null;
  /** false → nunca reutiliza un token guardado (siempre página alojada). */
  useStoredToken?: boolean;
  urls?: { returnUrl?: string | null; cancelUrl?: string | null; notifyUrl?: string | null };
  clientRequestId?: string | null;
  correlationId?: string;
  now?: Date;
}): Promise<GuestAuthorizationOutcome> {
  const adapter = input.adapter === undefined ? await resolvePspAdapter(input.session.propertyId) : input.adapter;
  const resolution = await resolveGuestPayment({ session: input.session, policy: input.policy, folio: input.folio, reservation: input.reservation, adapter });
  if (resolution.mode !== "authorize" || !input.folio || !pspSupportsAuthorization(adapter)) return { status: "not_applicable", resolution };
  const correlationId = input.correlationId ?? createId("corr");
  const context = await checkInServiceContext(input.session.propertyId, { kind: "guest", sessionId: input.session.id });
  const amount = resolution.amount.toFixed(2);
  const currency = resolution.currency;
  const folioId = input.folio.folio.id;
  const clientRequestId = input.clientRequestId?.trim() || `checkin-auth:${input.session.id}:${amount}`;
  const intentId = paymentIntentIdFor(folioId, clientRequestId);
  const captureWindowDays = captureWindowDaysFor(input.reservation, input.now);

  const existing = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
  if (existing) {
    const intent = { id: existing.id, status: existing.status, amount: Number(existing.amount), currency: existing.currency, provider: adapter.provider, providerReference: existing.providerReference ?? null };
    const status: "authorized" | "pending" | "failed" = existing.status === "authorized" ? "authorized" : existing.status === "failed" || existing.status === "cancelled" ? "failed" : "pending";
    return {
      status,
      resolution,
      intent,
      redirect: status === "pending" && existing.paymentLinkUrl ? { method: "GET", url: existing.paymentLinkUrl } : null,
      expiresAt: null,
      expiresAtSource: null,
      captureWindowDays,
      usedStoredToken: false,
      idempotent: true,
      error: status === "failed" ? "El intento anterior con este clientRequestId falló: reintenta con otro clientRequestId." : null,
      evidence: null
    };
  }

  const stored = input.paymentMethodRef ? null : input.useStoredToken === false ? null : await storedTokenFor({ organizationId: input.session.organizationId, sessionId: input.session.id, provider: adapter.provider });
  const paymentMethodRef = input.paymentMethodRef ?? stored?.tokenRef ?? null;
  if (paymentMethodRef && looksLikePan(paymentMethodRef)) throw new Error("paymentMethodRef parece un número de tarjeta: solo se aceptan tokens del PSP.");

  const created = await prisma.paymentIntent.create({
    data: { id: intentId, propertyId: input.session.propertyId, reservationId: input.session.reservationId, folioId, amount, currency, status: "pending", provider: adapter.provider }
  });
  const result = await adapter.authorize({
    folioId,
    intentId: created.id,
    amount,
    currency,
    reservationCode: input.reservation?.code ?? input.session.reservationId,
    returnUrl: input.urls?.returnUrl ?? null,
    cancelUrl: input.urls?.cancelUrl ?? null,
    notifyUrl: input.urls?.notifyUrl ?? null,
    captureWindowDays,
    paymentMethodRef,
    customerEmail: input.reservation?.bookerEmail ?? null,
    description: "Garantía de la estancia",
    idempotencyKey: created.id
  });

  const intentStatus = result.status === "authorized" ? "authorized" : result.status === "pending" ? "requires_action" : "failed";
  const paymentLinkUrl = result.redirect ? result.redirect.url : null;
  const row = await prisma.paymentIntent.update({
    where: { id: created.id },
    data: { status: intentStatus, providerReference: result.providerReference || null, paymentLinkUrl }
  });
  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId: input.session.propertyId,
    actorUserId: context.userId,
    actorType: "system",
    action: "PAYMENT_AUTHORIZATION_CREATED",
    entityType: "payment_intent",
    entityId: row.id,
    afterJson: { folioId, amount: Number(amount), currency, provider: adapter.provider, status: result.status, providerReference: result.providerReference || null, captureWindowDays, expiresAt: result.expiresAt, usedStoredToken: Boolean(stored), depositPolicy: input.policy.depositPolicy, error: result.error },
    deviceId: context.deviceId,
    correlationId
  });
  const sessionStatus = result.status === "authorized" ? "authorized" : result.status === "pending" ? "link_sent" : "failed";
  await setSessionPaymentStatus({ context, session: input.session, paymentStatus: sessionStatus, paymentIntentId: row.id, extra: { paymentIntentId: row.id, amount: Number(amount), provider: adapter.provider, reason: result.status === "failed" ? (result.error ?? "authorization_failed") : "authorization" }, correlationId });

  let evidence: PaymentEvidenceResult | null = null;
  if (result.status === "authorized") {
    evidence = await recordPaymentEvidence({ session: input.session, providerReference: result.providerReference, adapter, card: result.card ?? undefined, correlationId, context });
  }
  const expiresAt = result.status === "authorized" ? (result.expiresAt ?? new Date((input.now ?? new Date()).getTime() + captureWindowDays * DAY_MS).toISOString()) : null;
  return {
    status: result.status,
    resolution,
    intent: { id: row.id, status: row.status, amount: Number(row.amount), currency: row.currency, provider: adapter.provider, providerReference: row.providerReference ?? null },
    redirect: result.redirect ?? null,
    expiresAt,
    expiresAtSource: result.status !== "authorized" ? null : result.expiresAt ? "provider" : "policy",
    captureWindowDays,
    usedStoredToken: Boolean(stored),
    idempotent: false,
    error: result.error,
    evidence
  };
}

// ── Evidencia del medio de pago (PaymentToken + parte del titular) ───────────

export type PaymentEvidenceResult =
  | { recorded: false; reason: "psp_not_configured" | "no_card_token"; paymentTokenId: string | null; guestRegisterRecordId: null }
  | { recorded: true; paymentTokenId: string; reused: boolean; guestRegisterRecordId: string | null; guestRegisterReason: "updated" | "no_primary_record"; paymentMethodIdentifier: string };

/** «visa ****4242» — Anexo I A.4 sin PAN. Pure. */
export function paymentMethodIdentifier(card: Pick<PspCardToken, "brand" | "last4">): string {
  return `${card.brand.toLowerCase()} ****${card.last4}`;
}

/** Nombre del titular para el parte (nombre + apellidos que ya lleva el parte o el viajero). Pure. */
export function paymentHolderName(fields: { firstName?: string | null; surname1?: string | null; surname2?: string | null }): string | null {
  const holder = [fields.firstName, fields.surname1, fields.surname2].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
  return holder || null;
}

/** Lanza si el token trae algo que parezca un PAN o unos últimos 4 que no sean 4 dígitos. Pure. */
export function assertCardTokenSafe(card: PspCardToken): void {
  if (looksLikePan(card.tokenRef) || looksLikePan(card.last4) || looksLikePan(card.brand)) throw new Error("El token de tarjeta contiene un número de tarjeta completo: no se persiste (PAN_NOT_ACCEPTED).");
  if (!/^[0-9]{4}$/.test(card.last4)) throw new Error("Los últimos 4 dígitos de la tarjeta deben ser exactamente 4 dígitos.");
  if (!card.tokenRef.trim()) throw new Error("El token de tarjeta está vacío.");
}

/**
 * Guarda la evidencia del medio de pago de una autorización/cobro:
 * PaymentToken del titular (tokenRef cifrado por PII_FIELDS) y payment* en el
 * parte de viajeros del titular. Idempotente: reutiliza session.paymentTokenId
 * o un token igual (org, huésped, proveedor, últimos 4, caducidad) no borrado.
 */
export async function recordPaymentEvidence(input: {
  session: GuestPaymentSession;
  providerReference: string;
  adapter?: PspAdapter | null;
  /** Tarjeta ya conocida (respuesta del proveedor); si falta se pide con tokenizeFromReference. */
  card?: PspCardToken | null;
  correlationId?: string;
  context?: UserContext;
  now?: Date;
}): Promise<PaymentEvidenceResult> {
  const adapter = input.adapter === undefined ? await resolvePspAdapter(input.session.propertyId) : input.adapter;
  if (!adapter) return { recorded: false, reason: "psp_not_configured", paymentTokenId: input.session.paymentTokenId, guestRegisterRecordId: null };
  let card = input.card ?? null;
  if (!card && typeof adapter.tokenizeFromReference === "function") {
    try {
      card = await adapter.tokenizeFromReference(input.providerReference);
    } catch {
      card = null;
    }
  }
  if (!card) return { recorded: false, reason: "no_card_token", paymentTokenId: input.session.paymentTokenId, guestRegisterRecordId: null };
  assertCardTokenSafe(card);
  const correlationId = input.correlationId ?? createId("corr");
  const context = input.context ?? (await checkInServiceContext(input.session.propertyId, { kind: "guest", sessionId: input.session.id }));
  const now = input.now ?? new Date();
  const primary = await prisma.checkInGuest.findFirst({ where: { sessionId: input.session.id, isPrimary: true }, select: { id: true, guestId: true, guestRegisterRecordId: true, firstName: true, surname1: true, surname2: true } });

  let tokenId = input.session.paymentTokenId;
  let reused = true;
  if (tokenId && !(await prisma.paymentToken.findFirst({ where: { id: tokenId, deletedAt: null }, select: { id: true } }))) tokenId = null;
  if (!tokenId) {
    const same = await prisma.paymentToken.findFirst({
      where: { organizationId: input.session.organizationId, guestId: primary?.guestId ?? null, provider: adapter.provider, last4: card.last4, expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, deletedAt: null },
      select: { id: true }
    });
    tokenId = same?.id ?? null;
  }
  if (!tokenId) {
    const created = await prisma.paymentToken.create({
      data: { organizationId: input.session.organizationId, guestId: primary?.guestId ?? null, provider: adapter.provider, tokenRef: card.tokenRef, last4: card.last4, brand: card.brand.toLowerCase(), expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, isDefault: false }
    });
    tokenId = created.id;
    reused = false;
    recordAuditEvent({
      organizationId: context.organizationId,
      propertyId: input.session.propertyId,
      actorUserId: context.userId,
      actorType: "system",
      action: "PAYMENT_TOKEN_STORED",
      entityType: "payment_token",
      entityId: created.id,
      afterJson: { provider: adapter.provider, brand: created.brand, last4: created.last4, expiryMonth: created.expiryMonth, expiryYear: created.expiryYear, guestId: created.guestId, source: "checkin_authorization" },
      deviceId: context.deviceId,
      correlationId
    });
  }
  if (input.session.paymentTokenId !== tokenId) {
    await prisma.checkInSession.update({ where: { id: input.session.id }, data: { paymentTokenId: tokenId } });
    input.session.paymentTokenId = tokenId;
  }

  const identifier = paymentMethodIdentifier(card);
  const recordId = primary?.guestRegisterRecordId ?? (await prisma.guestRegisterRecord.findFirst({ where: { reservationId: input.session.reservationId, isPrimaryGuest: true }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
  if (!recordId) {
    return { recorded: true, paymentTokenId: tokenId, reused, guestRegisterRecordId: null, guestRegisterReason: "no_primary_record", paymentMethodIdentifier: identifier };
  }
  const before = await prisma.guestRegisterRecord.findUnique({ where: { id: recordId }, select: { id: true, paymentType: true, paymentMethodIdentifier: true, firstName: true, surname1: true, surname2: true } });
  if (!before) {
    return { recorded: true, paymentTokenId: tokenId, reused, guestRegisterRecordId: null, guestRegisterReason: "no_primary_record", paymentMethodIdentifier: identifier };
  }
  const holder = paymentHolderName(before) ?? paymentHolderName(primary ?? {});
  await prisma.guestRegisterRecord.update({
    where: { id: recordId },
    data: {
      paymentType: "card",
      paymentMethodIdentifier: identifier,
      paymentHolder: holder,
      paymentCardExpiryMonth: card.expiryMonth,
      paymentCardExpiryYear: card.expiryYear,
      paymentDate: now,
      paymentReference: input.session.paymentIntentId ?? null,
      updatedBy: context.userId
    }
  });
  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId: input.session.propertyId,
    actorUserId: context.userId,
    actorType: "system",
    action: "GUEST_REGISTER_PAYMENT_RECORDED",
    entityType: "guest_register_record",
    entityId: recordId,
    beforeJson: { paymentType: before.paymentType, paymentMethodIdentifier: before.paymentMethodIdentifier },
    afterJson: { paymentType: "card", paymentMethodIdentifier: identifier, paymentCardExpiryMonth: card.expiryMonth, paymentCardExpiryYear: card.expiryYear, paymentTokenId: tokenId, paymentReference: input.session.paymentIntentId ?? null },
    deviceId: context.deviceId,
    correlationId
  });
  return { recorded: true, paymentTokenId: tokenId, reused, guestRegisterRecordId: recordId, guestRegisterReason: "updated", paymentMethodIdentifier: identifier };
}
