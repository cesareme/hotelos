// Finanzas · Facturación y cobros (Cocoa 22 · lote 6-A) — pure helpers shared
// by PaymentDialog, RefundDialog and the billing screens:
//
//   · labels in Spanish for a payment method (canonical enum or legacy wire
//     label), a payment status and the capture / refund kind of a folio row;
//   · `refundableAmount` / `refundablePayments`: what can still be returned on
//     a captured payment (amount − refundedAmount; refund rows never);
//   · `paymentIntentPlan`: how the PSP hosted page opens from a 202 answer
//     (GET link or POST form) so the dialog can open it in a new tab and, when
//     the browser blocks the automatic open, offer a manual button;
//   · `parseAmount`: decimal typed by the operator ("12,50") → number | null.
//
// No React, no network, no import.meta: components/billing/__tests__ runs this
// module under `node --test`.

import {
  LEGACY_PAYMENT_METHOD_ALIASES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS_ES,
  PSP_PAYMENT_METHODS,
  type PaymentLinkResponse,
  type PaymentMethodCode
} from "@hotelos/shared";

export type PaymentKind = "capture" | "refund";

/** Minimal payment row the helpers read (folio balance, reservation folio, invoice payments). */
export type PaymentRowLike = {
  id: string;
  amount: number;
  currency?: string;
  method: string;
  methodCode?: PaymentMethodCode | null;
  status: string;
  pspReference?: string;
  kind?: PaymentKind;
  refundedAmount?: number;
  reversalOfId?: string | null;
  createdAt?: string;
  capturedAt?: string;
};

/** Canonical method of a row: `methodCode`, else the legacy label normalised, else null. */
export function resolveMethodCode(method: string | null | undefined, methodCode?: PaymentMethodCode | null): PaymentMethodCode | null {
  if (methodCode && (PAYMENT_METHODS as readonly string[]).includes(methodCode)) return methodCode;
  const raw = (method ?? "").trim().toLowerCase();
  if ((PAYMENT_METHODS as readonly string[]).includes(raw)) return raw as PaymentMethodCode;
  return LEGACY_PAYMENT_METHOD_ALIASES[raw] ?? null;
}

/** «Tarjeta (datáfono)», «Efectivo»…; an unknown legacy label is shown as typed. */
export function paymentMethodLabel(method: string | null | undefined, methodCode?: PaymentMethodCode | null): string {
  const code = resolveMethodCode(method, methodCode);
  if (code) return PAYMENT_METHOD_LABELS_ES[code];
  const raw = (method ?? "").trim();
  return raw || "Sin método";
}

/** Options of a method selector, in the canonical order; PSP methods flagged. */
export function paymentMethodOptions(options: { includePsp?: boolean } = {}): Array<{ value: PaymentMethodCode; label: string; psp: boolean }> {
  return PAYMENT_METHODS.filter((code) => options.includePsp !== false || !isPspMethod(code)).map((code) => ({
    value: code,
    label: PAYMENT_METHOD_LABELS_ES[code],
    psp: isPspMethod(code)
  }));
}

/** card_online · payment_link: the PSP must confirm before anything is «cobrado». */
export function isPspMethod(method: string | null | undefined): boolean {
  const code = resolveMethodCode(method);
  return code !== null && (PSP_PAYMENT_METHODS as readonly string[]).includes(code);
}

export const PAYMENT_STATUS_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  pending: "Pendiente",
  captured: "Cobrado",
  refunded: "Devuelto",
  failed: "Fallido",
  requires_action: "Pendiente de la pasarela",
  expired: "Caducado",
  cancelled: "Cancelado"
});

export function paymentStatusLabel(status: string | null | undefined): string {
  const raw = (status ?? "").trim().toLowerCase();
  return PAYMENT_STATUS_LABELS_ES[raw] ?? (raw || "Desconocido");
}

/** Semantic tone of a payment status (badge / row wash). */
export function paymentStatusTone(status: string | null | undefined, kind?: PaymentKind): "success" | "warning" | "danger" | "info" | "neutral" {
  if (kind === "refund") return "info";
  switch ((status ?? "").toLowerCase()) {
    case "captured":
      return "success";
    case "pending":
    case "requires_action":
      return "warning";
    case "failed":
    case "expired":
    case "cancelled":
      return "danger";
    case "refunded":
      return "info";
    default:
      return "neutral";
  }
}

/** Kind of a row: the API flag, else inferred from `reversalOfId`. */
export function paymentKind(row: Pick<PaymentRowLike, "kind" | "reversalOfId">): PaymentKind {
  if (row.kind) return row.kind;
  return row.reversalOfId ? "refund" : "capture";
}

export function paymentKindLabel(kind: PaymentKind): string {
  return kind === "refund" ? "Devolución" : "Cobro";
}

/** Amount still returnable on a row: captures only, net of what was already refunded; 0 for refund rows and non-captured statuses. */
export function refundableAmount(row: PaymentRowLike): number {
  if (paymentKind(row) === "refund") return 0;
  if ((row.status ?? "").toLowerCase() !== "captured") return 0;
  const refunded = Number.isFinite(row.refundedAmount) ? (row.refundedAmount as number) : 0;
  const remaining = Math.round((row.amount - refunded) * 100) / 100;
  return remaining > 0 ? remaining : 0;
}

/** Rows that can still be refunded (at least one cent left). */
export function refundablePayments<Row extends PaymentRowLike>(rows: readonly Row[]): Row[] {
  return rows.filter((row) => refundableAmount(row) > 0);
}

/**
 * "12,50" · "12.50" · "1.234,56" · "1,234.56" · " 12 " → number (2 decimals);
 * anything else → null. With both separators the LAST one is the decimal
 * mark and the other one is grouping (es-ES «1.234,56», en «1,234.56»).
 */
export function parseAmount(text: string): number | null {
  let normalised = text.trim().replace(/\s+/g, "");
  const lastComma = normalised.lastIndexOf(",");
  const lastDot = normalised.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    normalised = lastComma > lastDot ? normalised.replace(/\./g, "").replace(",", ".") : normalised.replace(/,/g, "");
  } else {
    normalised = normalised.replace(",", ".");
  }
  if (normalised === "" || !/^-?\d+(\.\d+)?$/.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** Number → text for a decimal input the operator edits («1234,50»: comma, no grouping). */
export function amountToInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return (Math.round(value * 100) / 100).toFixed(2).replace(".", ",");
}

export type PaymentIntentPlan =
  | { mode: "get"; url: string }
  | { mode: "post"; url: string; fields: Array<{ name: string; value: string }> };

/** How the hosted page of a 202 opens: a GET link (Stripe Checkout) or a POST form (Redsys SIS). */
export function paymentIntentPlan(response: Pick<PaymentLinkResponse, "redirect" | "intent">): PaymentIntentPlan {
  const redirect = response.redirect;
  if (redirect.method === "POST") {
    return { mode: "post", url: redirect.url, fields: Object.entries(redirect.fields).map(([name, value]) => ({ name, value })) };
  }
  return { mode: "get", url: redirect.url || response.intent.paymentLinkUrl || "" };
}

/** Human description of what happened after a 202 (never «cobrado»). */
export function paymentIntentSummary(response: Pick<PaymentLinkResponse, "intent" | "idempotent">): string {
  const status = response.intent.status;
  const provider = response.intent.provider === "stripe" ? "Stripe" : response.intent.provider === "redsys" ? "Redsys" : "la pasarela";
  const base = `Intento de cobro creado en ${provider}: el importe se registrará cuando ${provider} confirme el pago.`;
  if (status === "captured") return "La pasarela ya confirmó este intento: el cobro figura en el folio.";
  if (response.idempotent) return `${base} Este intento ya existía (misma clave de reintento).`;
  return base;
}

/** Message for 409 PSP_NOT_CONFIGURED: honest, with the way out. */
export const PSP_NOT_CONFIGURED_MESSAGE = "Pasarela de pago no configurada: registra el cobro por otro método (efectivo, datáfono, transferencia) o configúrala en Ajustes.";
