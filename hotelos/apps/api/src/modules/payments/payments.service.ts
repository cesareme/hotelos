// Payments service (finanzas · lote facturación-cobros, 2026-09-15).
//
// Owns every movement of money on a folio:
//   · postFolioPayment   — POST /folios/:id/payments. Idempotent by
//     clientRequestId (unique per folio: same request → same payment, another
//     body with the same key → 409 IDEMPOTENCY_CONFLICT), transactional (row
//     lock on the folio), method as the PaymentMethod enum. cash /
//     card_terminal / bank_transfer / other are captured in the act and post
//     D 570 | 5721 | 572 / H 4300 in the same transaction. card_online /
//     payment_link NEVER capture here: they need a PSP → 202 with a
//     PaymentIntent + hosted-page redirect, or 409 PSP_NOT_CONFIGURED.
//   · refundFolioPayment — POST /payments/:id/refund. Idempotent by
//     clientRequestId; a reversal Payment row (reversalOfId, positive amount,
//     status refunded) + the PaymentRefund ledger row the balance readers use
//     + the inverse entry (D 4300 / H 570|5721|572|5722). Online payments are
//     refunded through the PSP first (or recorded as a manual transfer when
//     the caller says so).
//   · createPaymentLink / getPaymentIntent / handlePspWebhook — the PSP flow:
//     the capture is recorded ONLY when the provider's signed notification
//     arrives (D 5722 / H 4300).
//
// Every entry goes through the invoicing ledger port (docs/runbooks/
// finanzas-contabilidad.md §1.3); amounts are Decimal, never float.

import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError, UnauthorizedError } from "../../lib/http-error.js";
import { grantPropertyAccess, type TenantRequest } from "../../lib/tenancy.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { CUSTOMER_ACCOUNT_CODE } from "../invoicing/invoice-snapshot.js";
import { getLedgerPort } from "../invoicing/ledger.port.js";
import { getFolioBalance, mirrorPaymentRecord, planRefund, syncInvoicePaidAfterRefund } from "../folio/folio.service.js";
import { legacyMethodLabel, methodCodeOfRow, methodRequiresPsp, normalizePaymentMethod } from "./payment-method.js";
import {
  PAYMENT_ERROR_CODES,
  PAYMENT_METHOD_ACCOUNT_CODES,
  PAYMENT_METHOD_LABELS_ES,
  type CapturedPaymentResponse,
  type PaymentIntentWire,
  type PaymentLinkResponse,
  type PaymentMethodCode,
  type PaymentWire,
  type PspProviderCode,
  type PspStatusWire,
  type RefundResponse
} from "../../../../../packages/shared/src/payments-types.js";
import { pspAdapterFor, pspStatusFor, resolvePspAdapter } from "./psp/index.js";
import { PspNotConfiguredError, type PspAdapter, type PspWebhookEvent } from "./psp/psp.types.js";
import { RedsysAdapter } from "./psp/redsys.adapter.js";
import { withReturnToken } from "./return-token.js";

const D = PrismaRuntime.Decimal;
type Dec = InstanceType<typeof PrismaRuntime.Decimal>;

function dec(value: Prisma.Decimal | number | string | null | undefined): Dec {
  if (value === null || value === undefined) return new D(0);
  return value instanceof D ? value : new D(value);
}

function toNumber(value: Dec): number {
  return Number(value.toFixed(2));
}

export { legacyMethodLabel, methodCodeOfRow, methodRequiresPsp, normalizePaymentMethod } from "./payment-method.js";

type PaymentRow = Prisma.PaymentGetPayload<Record<string, never>>;

export function mapPaymentWire(row: PaymentRow): PaymentWire {
  return {
    id: row.id,
    propertyId: row.propertyId,
    folioId: row.folioId,
    invoiceId: row.invoiceId ?? null,
    amount: toNumber(dec(row.amount)),
    currency: row.currency,
    method: row.method,
    methodCode: row.methodCode ?? null,
    pspReference: row.pspReference ?? undefined,
    status: row.status as PaymentWire["status"],
    createdAt: row.createdAt.toISOString(),
    reversalOfId: row.reversalOfId ?? null,
    journalEntryId: row.journalEntryId ?? null,
    clientRequestId: row.clientRequestId ?? null
  };
}

/** 409 for a replayed clientRequestId whose body differs (details.code = IDEMPOTENCY_CONFLICT). Pure. */
export function idempotencyConflictError(input: { clientRequestId: string; existingPaymentId: string; differences: string[] }): ConflictError {
  return new ConflictError(
    `Ya existe un cobro con clientRequestId «${input.clientRequestId}» en este folio con datos distintos (${input.differences.join(", ")}): usa otra clave para un cobro nuevo.`,
    { code: PAYMENT_ERROR_CODES.IDEMPOTENCY_CONFLICT, ...input }
  );
}

/** Fields that must match for a clientRequestId replay to be the same request. Pure. */
export function paymentRequestDifferences(existing: { amount: Dec | number | string; currency: string; methodCode: PaymentMethodCode | null; method: string; pspReference: string | null }, requested: { amount: Dec; currency: string; methodCode: PaymentMethodCode; reference: string | null }): string[] {
  const differences: string[] = [];
  if (!dec(existing.amount).equals(requested.amount)) differences.push(`importe ${dec(existing.amount).toFixed(2)} ≠ ${requested.amount.toFixed(2)}`);
  if (existing.currency !== requested.currency) differences.push(`moneda ${existing.currency} ≠ ${requested.currency}`);
  if (methodCodeOfRow(existing) !== requested.methodCode) differences.push(`método ${methodCodeOfRow(existing)} ≠ ${requested.methodCode}`);
  if ((existing.pspReference ?? null) !== (requested.reference ?? null)) differences.push("referencia distinta");
  return differences;
}

export function pspNotConfiguredError(status: PspStatusWire, methodCode?: PaymentMethodCode): ConflictError {
  const method = methodCode ? `${PAYMENT_METHOD_LABELS_ES[methodCode]} (${methodCode})` : "este cobro";
  return new ConflictError(
    `No se puede registrar ${method} como cobrado: no hay ninguna pasarela de pago (PSP) configurada. ${status.message} Registra el cobro con efectivo, datáfono o transferencia si el dinero ya se ha recibido por esos medios.`,
    { code: PAYMENT_ERROR_CODES.PSP_NOT_CONFIGURED, methodCode: methodCode ?? null, psp: status }
  );
}

async function resolveFolioContext(folioId: string): Promise<{ folio: Prisma.FolioGetPayload<Record<string, never>>; propertyId: string; organizationId: string; reservationCode: string; bookerEmail: string | null }> {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio || folio.deletedAt) throw new NotFoundError("El folio no existe.");
  const reservation = await prisma.reservation.findUnique({ where: { id: folio.reservationId }, select: { propertyId: true, code: true, bookerEmail: true } });
  if (!reservation) throw new NotFoundError("Reserva del folio no encontrada.");
  const property = await prisma.property.findUnique({ where: { id: reservation.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad del folio no encontrada.");
  return { folio, propertyId: reservation.propertyId, organizationId: property.organizationId, reservationCode: reservation.code, bookerEmail: reservation.bookerEmail ?? null };
}

// ── Capture ──────────────────────────────────────────────────────────────────

export type PostFolioPaymentInput = {
  context: UserContext;
  folioId: string;
  amount: number;
  currency?: string;
  method: string;
  /** PSP / bank / terminal reference (stored encrypted in Payment.pspReference). */
  reference?: string | null;
  /** Idempotency key of the client (unique per folio). */
  clientRequestId?: string | null;
  /** Link the capture to an issued invoice of the same folio. */
  invoiceId?: string | null;
  /** For payment links: where to send the customer afterwards (defaults to the API return page). */
  returnUrl?: string | null;
  correlationId: string;
};

export type PostFolioPaymentResult = CapturedPaymentResponse | PaymentLinkResponse;

export async function postFolioPayment(input: PostFolioPaymentInput): Promise<PostFolioPaymentResult> {
  requirePermissions(input.context, ["payment.capture"]);
  const { folio, propertyId, organizationId } = await resolveFolioContext(input.folioId);
  if (folio.status !== "open") throw new ConflictError("El folio está cerrado; no admite más cargos ni movimientos.");
  const amount = dec(input.amount).toDecimalPlaces(2, D.ROUND_HALF_UP);
  if (!Number.isFinite(input.amount) || amount.lessThanOrEqualTo(0)) throw new BadRequestError("El importe del cobro debe ser positivo.");
  const currency = (input.currency ?? folio.currency ?? "EUR").toUpperCase();
  const { methodCode, legacyMethod } = normalizePaymentMethod(input.method);
  const reference = input.reference?.trim() || null;
  const clientRequestId = input.clientRequestId?.trim() || null;

  if (methodCode === "card_online" || methodCode === "payment_link") {
    return createPaymentLink({
      context: input.context,
      folioId: input.folioId,
      amount: toNumber(amount),
      currency,
      methodCode,
      clientRequestId,
      returnUrl: input.returnUrl ?? null,
      correlationId: input.correlationId
    });
  }

  if (input.invoiceId) {
    const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId }, select: { folioId: true, status: true } });
    if (!invoice || invoice.folioId !== folio.id) throw new BadRequestError("invoiceId no pertenece a este folio.");
    if (invoice.status !== "issued") throw new ConflictError("Solo se pueden vincular cobros a facturas emitidas.", { code: PAYMENT_ERROR_CODES.INVOICE_NOT_ISSUED });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${folio.id} FOR UPDATE`;
    if (clientRequestId) {
      const existing = await tx.payment.findUnique({ where: { folioId_clientRequestId: { folioId: folio.id, clientRequestId } } });
      if (existing) {
        const differences = paymentRequestDifferences(existing, { amount, currency, methodCode, reference });
        if (differences.length > 0) throw idempotencyConflictError({ clientRequestId, existingPaymentId: existing.id, differences });
        return { row: existing, created: false as const };
      }
    }
    const row = await tx.payment.create({
      data: {
        propertyId,
        folioId: folio.id,
        invoiceId: input.invoiceId ?? null,
        amount: amount.toFixed(2),
        currency,
        method: legacyMethod,
        methodCode,
        pspReference: reference,
        status: "captured",
        clientRequestId
      }
    });
    const posted = await getLedgerPort().postJournalEntry(
      {
        organizationId,
        propertyId,
        sourceType: "payment",
        sourceId: row.id,
        entryDate: row.createdAt,
        description: `Cobro ${PAYMENT_METHOD_LABELS_ES[methodCode].toLowerCase()} folio ${folio.label}${reference ? ` · ref. ${reference}` : ""}`,
        reference: reference ?? row.id,
        createdBy: input.context.userId,
        currencyCode: currency,
        lines: [
          { accountCode: PAYMENT_METHOD_ACCOUNT_CODES[methodCode], debit: amount.toFixed(2), credit: "0.00", description: `Cobro ${PAYMENT_METHOD_LABELS_ES[methodCode].toLowerCase()}` },
          { accountCode: CUSTOMER_ACCOUNT_CODE, debit: "0.00", credit: amount.toFixed(2), description: "Cancela saldo de cliente" }
        ]
      },
      tx
    );
    const updated = await tx.payment.update({ where: { id: row.id }, data: { journalEntryId: posted.journalEntryId } });
    return { row: updated, created: true as const };
  });

  const wire = mapPaymentWire(outcome.row);
  if (!outcome.created) {
    recordAuditEvent({
      organizationId,
      propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "PAYMENT_CAPTURE_REPLAYED",
      entityType: "payment",
      entityId: wire.id,
      afterJson: { clientRequestId, amount: wire.amount, methodCode },
      correlationId: input.correlationId
    });
    return { ...wire, kind: "payment", idempotent: true };
  }
  mirrorPaymentRecord(outcome.row);
  recordAuditEvent({
    organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYMENT_CAPTURED",
    entityType: "payment",
    entityId: wire.id,
    afterJson: wire,
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId,
    propertyId,
    entityType: "payment",
    entityId: wire.id,
    eventType: "PaymentCaptured",
    payload: { folioId: folio.id, amount: wire.amount, method: wire.method, methodCode, journalEntryId: wire.journalEntryId, invoiceId: wire.invoiceId },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return { ...wire, kind: "payment", idempotent: false };
}

// ── Refund ───────────────────────────────────────────────────────────────────

export type RefundFolioPaymentInput = {
  context: UserContext;
  paymentId: string;
  reason: string;
  /** Partial refund amount; omitted → everything still pending on the payment. */
  amount?: number;
  clientRequestId?: string | null;
  /** How the money goes back (defaults to the original method); cash / bank_transfer allow a manual refund of an online payment. */
  refundMethod?: string | null;
  correlationId: string;
};

const PSP_REFUND_FAILED_CODE = "PSP_REFUND_FAILED";

export async function refundFolioPayment(input: RefundFolioPaymentInput): Promise<RefundResponse> {
  requirePermissions(input.context, ["payment.refund", "ai.high_risk.confirm"]);
  const original = await prisma.payment.findUnique({ where: { id: input.paymentId } });
  if (!original || original.deletedAt) throw new NotFoundError("Pago no encontrado.");
  if (original.reversalOfId) throw new ConflictError("Este registro ya es una devolución; no se puede devolver una devolución.");
  const clientRequestId = input.clientRequestId?.trim() || null;
  const originalMethod = methodCodeOfRow(original);
  const refundMethod = input.refundMethod ? normalizePaymentMethod(input.refundMethod).methodCode : originalMethod;
  const property = await prisma.property.findUnique({ where: { id: original.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad del cobro no encontrada.");
  const organizationId = property.organizationId;

  // Replay before touching the PSP: the same clientRequestId returns the same reversal.
  if (clientRequestId) {
    const replay = await prisma.payment.findUnique({ where: { folioId_clientRequestId: { folioId: original.folioId, clientRequestId } } });
    if (replay && replay.reversalOfId === original.id) return loadRefundResponse(original.id, replay.id, true);
    if (replay) throw idempotencyConflictError({ clientRequestId, existingPaymentId: replay.id, differences: ["la clave pertenece a otro movimiento del folio"] });
  }
  if (original.status !== "captured") {
    throw new ConflictError(original.status === "refunded" ? "El cobro ya está devuelto por completo." : "Solo se pueden devolver cobros capturados.");
  }
  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) throw new BadRequestError("El importe a devolver debe ser positivo.");

  // Online money goes back through the PSP unless the caller records a manual refund.
  let pspRefundReference: string | null = null;
  if (methodRequiresPsp(originalMethod) && (refundMethod === "card_online" || refundMethod === "payment_link")) {
    const adapter = await resolvePspAdapter(original.propertyId);
    if (!adapter) {
      const status = await pspStatusFor(original.propertyId);
      throw new ConflictError(
        `El cobro se hizo en línea (${PAYMENT_METHOD_LABELS_ES[originalMethod]}) y no hay PSP configurado para devolverlo: ${status.message} Si el dinero se devuelve por transferencia o en efectivo, indica refundMethod: "bank_transfer" | "cash".`,
        { code: PAYMENT_ERROR_CODES.PSP_NOT_CONFIGURED, methodCode: originalMethod, psp: status }
      );
    }
    if (!original.pspReference) throw new ConflictError("El cobro en línea no tiene referencia del PSP; regístralo como devolución manual (refundMethod).");
    const refundedBefore = (await sumCountedRefunds(prisma, original.id)).toNumber();
    const plan = planRefund({ paymentAmount: toNumber(dec(original.amount)), refundedBefore, requested: input.amount });
    const result = await adapter.refund({
      providerReference: original.pspReference,
      amount: new D(plan.amount).toFixed(2),
      currency: original.currency,
      reason: input.reason,
      idempotencyKey: clientRequestId ? `${original.id}:${clientRequestId}` : `${original.id}:${plan.amount.toFixed(2)}:${refundedBefore.toFixed(2)}`
    });
    if (result.status === "failed") {
      throw new HttpError(502, `La pasarela rechazó la devolución: ${result.error ?? "sin detalle"}.`, true, { code: PSP_REFUND_FAILED_CODE, provider: adapter.provider, error: result.error });
    }
    pspRefundReference = result.providerReference;
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${original.id} FOR UPDATE`;
    if (clientRequestId) {
      const replay = await tx.payment.findUnique({ where: { folioId_clientRequestId: { folioId: original.folioId, clientRequestId } } });
      if (replay && replay.reversalOfId === original.id) return { reversal: replay, created: false as const, plan: null, refundId: null };
    }
    const fresh = await tx.payment.findUnique({ where: { id: original.id }, select: { status: true } });
    if (!fresh || fresh.status !== "captured") throw new ConflictError("El cobro ya ha sido devuelto por otro usuario.");
    const refundedBefore = (await sumCountedRefunds(tx, original.id)).toNumber();
    const plan = planRefund({ paymentAmount: toNumber(dec(original.amount)), refundedBefore, requested: input.amount });
    const amount = new D(plan.amount);
    const refund = await tx.paymentRefund.create({
      data: { paymentId: original.id, amount: amount.toFixed(2), status: "completed", requiresApproval: false, approvedBy: input.context.userId, providerReference: pspRefundReference }
    });
    const reversal = await tx.payment.create({
      data: {
        propertyId: original.propertyId,
        folioId: original.folioId,
        invoiceId: null,
        amount: amount.toFixed(2),
        currency: original.currency,
        method: legacyMethodLabel(refundMethod),
        methodCode: refundMethod,
        pspReference: pspRefundReference,
        status: "refunded",
        reversalOfId: original.id,
        clientRequestId
      }
    });
    if (plan.full) {
      const flipped = await tx.payment.updateMany({ where: { id: original.id, status: "captured", deletedAt: null }, data: { status: "refunded" } });
      if (flipped.count === 0) throw new ConflictError("El cobro ya ha sido devuelto por otro usuario.");
    }
    // Keyed by the PaymentRefund row: the accounting projection materialises
    // PaymentRefunded with (payment_refund, refundId) and finds this entry.
    const posted = await getLedgerPort().postJournalEntry(
      {
        organizationId,
        propertyId: original.propertyId,
        sourceType: "payment_refund",
        sourceId: refund.id,
        entryDate: reversal.createdAt,
        description: `Devolución ${PAYMENT_METHOD_LABELS_ES[refundMethod].toLowerCase()} del cobro ${original.id} · ${input.reason}`,
        reference: pspRefundReference ?? original.pspReference ?? original.id,
        createdBy: input.context.userId,
        entryKind: "reversal",
        currencyCode: original.currency,
        lines: [
          { accountCode: CUSTOMER_ACCOUNT_CODE, debit: amount.toFixed(2), credit: "0.00", description: "Restituye saldo de cliente" },
          { accountCode: PAYMENT_METHOD_ACCOUNT_CODES[refundMethod], debit: "0.00", credit: amount.toFixed(2), description: `Devolución ${PAYMENT_METHOD_LABELS_ES[refundMethod].toLowerCase()}` }
        ]
      },
      tx
    );
    const linkedReversal = await tx.payment.update({ where: { id: reversal.id }, data: { journalEntryId: posted.journalEntryId } });
    if (original.invoiceId) await syncInvoicePaidAfterRefund(tx, original.invoiceId);
    return { reversal: linkedReversal, created: true as const, plan, refundId: refund.id };
  });

  const response = await loadRefundResponse(original.id, outcome.reversal.id, !outcome.created);
  if (!outcome.created) return response;
  const refundIdForEvent = outcome.refundId;
  mirrorPaymentRecord({ ...original, status: outcome.plan?.full ? "refunded" : original.status });
  recordAuditEvent({
    organizationId,
    propertyId: original.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYMENT_REFUNDED",
    entityType: "payment",
    entityId: original.id,
    beforeJson: mapPaymentWire(original),
    afterJson: { ...response, refundId: outcome.refundId, amount: outcome.plan?.amount, partial: outcome.plan ? !outcome.plan.full : null, reason: input.reason, refundMethod, pspRefundReference },
    correlationId: input.correlationId
  });
  // entityId = the reversal row so the legacy accounting projection (keyed by
  // sourceType payment_refund + entityId) finds the entry posted above and skips.
  recordDomainEvent({
    organizationId,
    propertyId: original.propertyId,
    entityType: "payment",
    entityId: outcome.reversal.id,
    eventType: "PaymentRefunded",
    payload: { folioId: original.folioId, paymentId: original.id, reversalPaymentId: outcome.reversal.id, refundId: refundIdForEvent, amount: outcome.plan?.amount, method: legacyMethodLabel(refundMethod), methodCode: refundMethod, partial: outcome.plan ? !outcome.plan.full : null, reason: input.reason },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return response;
}

const REFUND_FAILED_STATUSES = ["failed", "rejected", "cancelled"];

async function sumCountedRefunds(client: Pick<typeof prisma, "paymentRefund"> | Prisma.TransactionClient, paymentId: string): Promise<Dec> {
  const rows = await client.paymentRefund.findMany({ where: { paymentId, status: { notIn: REFUND_FAILED_STATUSES } }, select: { amount: true } });
  return rows.reduce((sum, row) => sum.plus(dec(row.amount)), new D(0));
}

async function loadRefundResponse(paymentId: string, reversalId: string, idempotent: boolean): Promise<RefundResponse> {
  const [row, reversal, refundRows] = await Promise.all([
    prisma.payment.findUnique({ where: { id: paymentId } }),
    prisma.payment.findUnique({ where: { id: reversalId } }),
    prisma.paymentRefund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } })
  ]);
  if (!row || !reversal) throw new NotFoundError("Pago no encontrado.");
  const refunds = refundRows.map((r) => ({ id: r.id, paymentId: r.paymentId, amount: toNumber(dec(r.amount)), status: r.status, requiresApproval: r.requiresApproval, approvedBy: r.approvedBy ?? null, providerReference: r.providerReference ?? null, createdAt: r.createdAt.toISOString() }));
  const counted = refunds.filter((r) => !REFUND_FAILED_STATUSES.includes(r.status)).reduce((sum, r) => sum.plus(new D(r.amount)), new D(0));
  const refundedAmount = row.status === "refunded" ? D.max(counted, dec(row.amount)) : counted;
  return { ...mapPaymentWire(row), refundedAmount: toNumber(refundedAmount), refunds, reversal: mapPaymentWire(reversal), idempotent };
}

// ── PSP: payment links, intents, webhooks ────────────────────────────────────

function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PAYMENTS_PUBLIC_BASE_URL ?? env.API_PUBLIC_URL ?? "http://localhost:3000").trim();
  return base.replace(/\/+$/, "");
}

/** Deterministic PaymentIntent id for (folio, clientRequestId) so a retry replays the same intent. Pure. */
export function paymentIntentIdFor(folioId: string, clientRequestId: string): string {
  return `pi_${createHash("sha256").update(`${folioId}:${clientRequestId}`, "utf8").digest("hex").slice(0, 24)}`;
}

type IntentRow = Prisma.PaymentIntentGetPayload<Record<string, never>>;

function mapIntentWire(row: IntentRow, paymentId: string | null): PaymentIntentWire {
  return {
    id: row.id,
    propertyId: row.propertyId,
    folioId: row.folioId ?? null,
    reservationId: row.reservationId ?? null,
    amount: toNumber(dec(row.amount)),
    currency: row.currency,
    status: row.status as PaymentIntentWire["status"],
    provider: (row.provider as PspProviderCode | null) ?? null,
    providerReference: row.providerReference ?? null,
    paymentLinkUrl: row.paymentLinkUrl ?? null,
    paymentId,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * URLs handed to the PSP. The API landing page (`/payments/return/:id`) is
 * public, so both the OK and the KO URL carry the signed return token
 * (return-token.ts, t6#15): without it the page shows nothing about the
 * intent. A caller-provided returnUrl is left untouched (it is the caller's
 * own site; the intent state is read through the authenticated
 * GET /payment-intents/:id).
 */
function intentUrls(intentId: string, provider: PspProviderCode, returnUrl: string | null): { returnUrl: string; cancelUrl: string; notifyUrl: string } {
  const base = publicBaseUrl();
  const ok = returnUrl ? `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}intent=${encodeURIComponent(intentId)}&resultado=ok` : withReturnToken(`${base}/payments/return/${encodeURIComponent(intentId)}?resultado=ok`, intentId);
  const ko = returnUrl ? `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}intent=${encodeURIComponent(intentId)}&resultado=ko` : withReturnToken(`${base}/payments/return/${encodeURIComponent(intentId)}?resultado=ko`, intentId);
  return { returnUrl: ok, cancelUrl: ko, notifyUrl: `${base}/payments/webhooks/${provider}` };
}

// ── Tenancy of PaymentIntent (t6#5) ──────────────────────────────────────────

export const PAYMENT_INTENT_NOT_FOUND = "Intento de pago no encontrado.";

/**
 * Tenant guard for routes addressed by a PaymentIntent id. Same semantics as
 * `assertEntityAccess` (lib/tenancy.ts): the intent hangs from its property;
 * a missing row, a row of another organisation the caller may not act in,
 * or a property the caller holds no role in → the same opaque 404 (never an
 * existence oracle). Platform admins are re-pointed to the row's organisation
 * by `grantPropertyAccess`. Lives here (not in the RESOLVERS table) so the
 * payments module owns its own guard; the integrator may alias it from
 * lib/tenancy.ts as entity "paymentIntent".
 */
export async function assertPaymentIntentAccess(request: TenantRequest, intentId: string): Promise<{ organizationId: string; propertyId: string }> {
  if (typeof intentId !== "string" || intentId.length === 0) throw new BadRequestError("Identificador inválido.");
  const row = await prisma.paymentIntent.findUnique({ where: { id: intentId }, select: { propertyId: true } });
  if (!row) throw new NotFoundError(PAYMENT_INTENT_NOT_FOUND);
  const organizationId = await grantPropertyAccess(request, row.propertyId, PAYMENT_INTENT_NOT_FOUND);
  return { organizationId, propertyId: row.propertyId };
}

async function redirectFor(adapter: PspAdapter, row: IntentRow, returnUrl: string | null): Promise<PaymentLinkResponse["redirect"]> {
  if (adapter.provider === "redsys" && adapter instanceof RedsysAdapter && row.providerReference) {
    const urls = intentUrls(row.id, "redsys", returnUrl);
    const form = adapter.buildPaymentForm({ intentId: row.id, amount: dec(row.amount).toFixed(2), currency: row.currency, description: `Pago folio`, reference: row.folioId ?? row.id, ...urls }, row.providerReference);
    return { method: "POST", url: form.url, fields: form.fields };
  }
  return { method: "GET", url: row.paymentLinkUrl ?? "" };
}

export type CreatePaymentLinkInput = {
  context: UserContext;
  folioId: string;
  /** Defaults to the folio balance due. */
  amount?: number | null;
  currency?: string | null;
  methodCode?: Extract<PaymentMethodCode, "card_online" | "payment_link">;
  clientRequestId?: string | null;
  returnUrl?: string | null;
  correlationId: string;
};

export async function createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResponse> {
  requirePermissions(input.context, ["payment.capture"]);
  const { folio, propertyId, organizationId, reservationCode, bookerEmail } = await resolveFolioContext(input.folioId);
  if (folio.status !== "open") throw new ConflictError("El folio está cerrado; no admite más cargos ni movimientos.");
  const methodCode = input.methodCode ?? "payment_link";
  const adapter = await resolvePspAdapter(propertyId);
  if (!adapter) throw pspNotConfiguredError(await pspStatusFor(propertyId), methodCode);
  const balance = await getFolioBalance(folio.id);
  const amount = dec(input.amount ?? balance.balanceDue).toDecimalPlaces(2, D.ROUND_HALF_UP);
  if (amount.lessThanOrEqualTo(0)) throw new BadRequestError(`El importe del enlace de pago debe ser positivo (saldo pendiente del folio: ${balance.balanceDue.toFixed(2)}).`);
  const currency = (input.currency ?? folio.currency ?? "EUR").toUpperCase();
  const clientRequestId = input.clientRequestId?.trim() || null;
  const intentId = clientRequestId ? paymentIntentIdFor(folio.id, clientRequestId) : undefined;

  if (intentId) {
    const existing = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (existing) {
      if (!dec(existing.amount).equals(amount) || existing.currency !== currency) {
        throw idempotencyConflictError({ clientRequestId: clientRequestId!, existingPaymentId: existing.id, differences: [`importe ${dec(existing.amount).toFixed(2)} ≠ ${amount.toFixed(2)}`] });
      }
      const payment = await prisma.payment.findFirst({ where: { folioId: folio.id, clientRequestId: `psp:${existing.id}` }, select: { id: true } });
      return { kind: "payment_intent", intent: mapIntentWire(existing, payment?.id ?? null), redirect: await redirectFor(adapter, existing, input.returnUrl ?? null), idempotent: true };
    }
  }

  const created = await prisma.paymentIntent.create({
    data: { ...(intentId ? { id: intentId } : {}), propertyId, reservationId: folio.reservationId, folioId: folio.id, amount: amount.toFixed(2), currency, status: "pending", provider: adapter.provider }
  });
  const urls = intentUrls(created.id, adapter.provider, input.returnUrl ?? null);
  let link;
  try {
    link = await adapter.createPaymentLink({ intentId: created.id, amount: amount.toFixed(2), currency, description: `Estancia ${reservationCode} · folio ${folio.label}`, reference: reservationCode, customerEmail: bookerEmail, ...urls });
  } catch (error) {
    await prisma.paymentIntent.update({ where: { id: created.id }, data: { status: "failed" } });
    if (error instanceof PspNotConfiguredError) throw pspNotConfiguredError(await pspStatusFor(propertyId), methodCode);
    throw new HttpError(502, `La pasarela no pudo crear el enlace de pago: ${error instanceof Error ? error.message : String(error)}`, true, { code: "PSP_LINK_FAILED", provider: adapter.provider });
  }
  const row = await prisma.paymentIntent.update({
    where: { id: created.id },
    data: { status: "requires_action", providerReference: link.providerReference, paymentLinkUrl: link.redirect.method === "GET" ? link.redirect.url : link.redirect.url }
  });
  recordAuditEvent({
    organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYMENT_LINK_CREATED",
    entityType: "payment_intent",
    entityId: row.id,
    afterJson: { folioId: folio.id, amount: toNumber(amount), currency, provider: adapter.provider, providerReference: link.providerReference, methodCode, clientRequestId },
    correlationId: input.correlationId
  });
  return { kind: "payment_intent", intent: mapIntentWire(row, null), redirect: link.redirect, idempotent: false };
}

export async function getPaymentIntent(intentId: string): Promise<PaymentLinkResponse> {
  const row = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
  if (!row) throw new NotFoundError("Intento de pago no encontrado.");
  const payment = row.folioId ? await prisma.payment.findFirst({ where: { folioId: row.folioId, clientRequestId: `psp:${row.id}` }, select: { id: true } }) : null;
  const adapter = row.provider === "stripe" || row.provider === "redsys" ? pspAdapterFor(row.provider) : null;
  const redirect: PaymentLinkResponse["redirect"] = adapter && adapter.status().configured ? await redirectFor(adapter, row, null) : { method: "GET", url: row.paymentLinkUrl ?? "" };
  return { kind: "payment_intent", intent: mapIntentWire(row, payment?.id ?? null), redirect, idempotent: true };
}

export type WebhookOutcome = { received: true; provider: PspProviderCode; action: "captured" | "already_captured" | "failed" | "refund_acknowledged" | "unmatched" | "ignored"; intentId: string | null; paymentId: string | null; note: string | null };

/**
 * PSP notification → captured Payment. The signature is verified over the
 * raw body; an invalid one is a 401 (PSP_WEBHOOK_REJECTED). Idempotent: the
 * Payment is keyed by clientRequestId `psp:<intentId>` on the folio.
 */
export async function handlePspWebhook(input: { provider: string; rawBody: string; headers: Record<string, string | string[] | undefined>; contentType: string | null; correlationId: string }): Promise<WebhookOutcome> {
  if (input.provider !== "stripe" && input.provider !== "redsys") throw new NotFoundError(`Proveedor de pago desconocido: ${input.provider}.`);
  const provider: PspProviderCode = input.provider;
  const adapter = pspAdapterFor(provider);
  const verification = adapter.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, contentType: input.contentType });
  if (!verification.ok) {
    throw new UnauthorizedError(`Notificación de ${provider} rechazada: ${verification.reason}`);
  }
  const event = verification.event;
  const base: Omit<WebhookOutcome, "action" | "intentId" | "paymentId" | "note"> = { received: true, provider };
  if (event.type === "ignored") return { ...base, action: "ignored", intentId: null, paymentId: null, note: event.reason };
  if (event.type === "refund.completed") {
    return { ...base, action: "refund_acknowledged", intentId: null, paymentId: null, note: `Devolución confirmada por ${provider} (${event.providerReference}).` };
  }
  const intent = await findIntentForEvent(event);
  if (!intent) return { ...base, action: "unmatched", intentId: null, paymentId: null, note: `Sin PaymentIntent para ${event.providerReference}.` };
  const property = await prisma.property.findUnique({ where: { id: intent.propertyId }, select: { organizationId: true } });
  const organizationId = property?.organizationId ?? intent.propertyId;

  if (event.type === "payment.failed") {
    if (intent.status === "pending" || intent.status === "requires_action") {
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "failed", providerReference: event.providerReference || intent.providerReference } });
    }
    recordAuditEvent({ organizationId, propertyId: intent.propertyId, actorType: "system", action: "PSP_PAYMENT_FAILED", entityType: "payment_intent", entityId: intent.id, afterJson: { provider, reason: event.reason }, correlationId: input.correlationId });
    return { ...base, action: "failed", intentId: intent.id, paymentId: null, note: event.reason };
  }

  if (!intent.folioId) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "captured", providerReference: event.providerReference || intent.providerReference } });
    recordAuditEvent({ organizationId, propertyId: intent.propertyId, actorType: "system", action: "PSP_PAYMENT_CAPTURED_WITHOUT_FOLIO", entityType: "payment_intent", entityId: intent.id, afterJson: { provider, providerReference: event.providerReference }, correlationId: input.correlationId });
    return { ...base, action: "captured", intentId: intent.id, paymentId: null, note: "El intento no tiene folio: registrado en el intento, sin Payment." };
  }
  const folioId = intent.folioId;
  const amount = dec(event.amount ?? intent.amount).toDecimalPlaces(2, D.ROUND_HALF_UP);
  const amountMismatch = !amount.equals(dec(intent.amount));
  const clientRequestId = `psp:${intent.id}`;
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${folioId} FOR UPDATE`;
    const existing = await tx.payment.findUnique({ where: { folioId_clientRequestId: { folioId, clientRequestId } } });
    if (existing) return { row: existing, created: false as const };
    const row = await tx.payment.create({
      data: {
        propertyId: intent.propertyId,
        folioId,
        amount: amount.toFixed(2),
        currency: (event.currency ?? intent.currency).toUpperCase(),
        method: "payment_link",
        methodCode: "payment_link",
        pspReference: event.providerReference || intent.providerReference,
        status: "captured",
        clientRequestId
      }
    });
    const posted = await getLedgerPort().postJournalEntry(
      {
        organizationId,
        propertyId: intent.propertyId,
        sourceType: "payment",
        sourceId: row.id,
        entryDate: row.createdAt,
        description: `Cobro por enlace de pago (${provider}) · ${event.providerReference}`,
        reference: event.providerReference || row.id,
        createdBy: null,
        currencyCode: row.currency,
        lines: [
          { accountCode: PAYMENT_METHOD_ACCOUNT_CODES.payment_link, debit: amount.toFixed(2), credit: "0.00", description: `Pasarela ${provider} pendiente de liquidar` },
          { accountCode: CUSTOMER_ACCOUNT_CODE, debit: "0.00", credit: amount.toFixed(2), description: "Cancela saldo de cliente" }
        ]
      },
      tx
    );
    const updated = await tx.payment.update({ where: { id: row.id }, data: { journalEntryId: posted.journalEntryId } });
    await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: "captured", providerReference: event.providerReference || intent.providerReference } });
    return { row: updated, created: true as const };
  });
  if (!outcome.created) return { ...base, action: "already_captured", intentId: intent.id, paymentId: outcome.row.id, note: null };
  const wire = mapPaymentWire(outcome.row);
  mirrorPaymentRecord(outcome.row);
  recordAuditEvent({
    organizationId,
    propertyId: intent.propertyId,
    actorType: "system",
    action: "PAYMENT_CAPTURED",
    entityType: "payment",
    entityId: wire.id,
    afterJson: { ...wire, provider, intentId: intent.id, amountMismatch: amountMismatch ? { intent: dec(intent.amount).toFixed(2), provider: amount.toFixed(2) } : null },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId,
    propertyId: intent.propertyId,
    entityType: "payment",
    entityId: wire.id,
    eventType: "PaymentCaptured",
    payload: { folioId, amount: wire.amount, method: wire.method, methodCode: "payment_link", provider, intentId: intent.id, journalEntryId: wire.journalEntryId },
    actorType: "system",
    correlationId: input.correlationId
  });
  return { ...base, action: "captured", intentId: intent.id, paymentId: wire.id, note: amountMismatch ? `Importe del PSP ${amount.toFixed(2)} ≠ intento ${dec(intent.amount).toFixed(2)} (registrado el del PSP, auditado).` : null };
}

async function findIntentForEvent(event: Extract<PspWebhookEvent, { type: "payment.captured" | "payment.failed" }>): Promise<IntentRow | null> {
  if (event.intentId) {
    const byId = await prisma.paymentIntent.findUnique({ where: { id: event.intentId } });
    if (byId) return byId;
  }
  if (event.providerReference) {
    const byRef = await prisma.paymentIntent.findFirst({ where: { providerReference: event.providerReference }, orderBy: { createdAt: "desc" } });
    if (byRef) return byRef;
  }
  return null;
}

export async function pspStatus(propertyId: string): Promise<PspStatusWire> {
  return pspStatusFor(propertyId);
}
