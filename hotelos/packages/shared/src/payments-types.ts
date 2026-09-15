/**
 * Finanzas · facturación y cobros — shared wire contract between the API
 * (modules invoicing / folio / payments) and the front-ends.
 *
 * Design (lote «facturacion-cobros», 2026-09-15):
 *   · A payment method is one of PAYMENT_METHODS (Prisma enum PaymentMethod).
 *     Legacy free-text values ("card", "ota_virtual_card") are still accepted
 *     on the wire and normalised (LEGACY_PAYMENT_METHOD_ALIASES) — the API
 *     writes both `methodCode` (enum) and `method` (legacy label).
 *   · `card_online` and `payment_link` NEVER produce a captured payment by
 *     themselves: they need a PSP (Stripe / Redsys). Without one the API answers
 *     409 PSP_NOT_CONFIGURED; with one it answers 202 with a PaymentIntent and
 *     the hosted-page URL, and the capture is recorded when the PSP confirms
 *     (webhook). No "captured" is ever invented.
 *   · POST /folios/:id/payments is idempotent by `clientRequestId` (unique per
 *     folio): the same request replays the same payment; a different body with
 *     the same key is a 409 IDEMPOTENCY_CONFLICT.
 *   · Refunds are Payment rows with `reversalOfId` (positive amount, status
 *     "refunded") plus the PaymentRefund ledger the balance readers use; they
 *     are idempotent by `clientRequestId` too.
 *   · An issued invoice is frozen in `Invoice.snapshotJson` (InvoiceSnapshotV1):
 *     PDF, VeriFactu and the VAT books read the snapshot, never the live folio.
 *
 * Money on the wire is a plain number with 2 decimals in the folio currency;
 * the API computes with Decimal and rounds per line, squaring to the cent.
 */

export const PAYMENT_METHODS = ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number];

/** Legacy wire values still accepted by the API and how they normalise. */
export const LEGACY_PAYMENT_METHOD_ALIASES: Readonly<Record<string, PaymentMethodCode>> = Object.freeze({
  card: "card_terminal",
  ota_virtual_card: "card_terminal",
  transfer: "bank_transfer",
  link: "payment_link",
  online: "card_online"
});

/** Methods that require a PSP confirmation before a payment can be captured. */
export const PSP_PAYMENT_METHODS: readonly PaymentMethodCode[] = Object.freeze(["card_online", "payment_link"]);

export const PAYMENT_METHOD_LABELS_ES: Readonly<Record<PaymentMethodCode, string>> = Object.freeze({
  cash: "Efectivo",
  card_terminal: "Tarjeta (datáfono)",
  card_online: "Tarjeta en línea",
  bank_transfer: "Transferencia",
  payment_link: "Enlace de pago",
  other: "Otro"
});

/** PGC counterpart account of each method (canonical rule «Cobro»). */
export const PAYMENT_METHOD_ACCOUNT_CODES: Readonly<Record<PaymentMethodCode, string>> = Object.freeze({
  cash: "570",
  card_terminal: "5721",
  card_online: "5722",
  bank_transfer: "572",
  payment_link: "5722",
  other: "572"
});

export type PspProviderCode = "stripe" | "redsys";

/** Machine-readable `details.code` values of the money path. */
export const PAYMENT_ERROR_CODES = Object.freeze({
  PSP_NOT_CONFIGURED: "PSP_NOT_CONFIGURED",
  PAYMENT_REQUIRES_PSP: "PAYMENT_REQUIRES_PSP",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  PAN_NOT_ACCEPTED: "PAN_NOT_ACCEPTED",
  PSP_TOKEN_REQUIRED: "PSP_TOKEN_REQUIRED",
  FOLIO_CHANGED_SINCE_DRAFT: "FOLIO_CHANGED_SINCE_DRAFT",
  ISSUER_TAX_ID_SERIES_MISMATCH: "ISSUER_TAX_ID_SERIES_MISMATCH",
  SIMPLIFIED_LIMIT_EXCEEDED: "SIMPLIFIED_LIMIT_EXCEEDED",
  INVOICE_NOT_ISSUED: "INVOICE_NOT_ISSUED",
  EMAIL_DELIVERY_FAILED: "EMAIL_DELIVERY_FAILED",
  CHART_NOT_PROVISIONED: "CHART_NOT_PROVISIONED",
  PSP_WEBHOOK_REJECTED: "PSP_WEBHOOK_REJECTED"
} as const);

export type PaymentStatusWire = "pending" | "captured" | "refunded" | "failed";

export type PaymentWire = {
  id: string;
  propertyId: string;
  folioId: string;
  invoiceId: string | null;
  amount: number;
  currency: string;
  /** Legacy label kept for existing readers ("cash" | "card" | "bank_transfer" | "payment_link" | …). */
  method: string;
  /** Canonical method (null only on rows written before the column existed). */
  methodCode: PaymentMethodCode | null;
  pspReference?: string;
  status: PaymentStatusWire;
  createdAt: string;
  /** Payment this row reverses (refund rows); null on captures. */
  reversalOfId: string | null;
  journalEntryId: string | null;
  clientRequestId: string | null;
};

/** POST /folios/:id/payments — captured (cash / terminal / transfer) answer. */
export type CapturedPaymentResponse = PaymentWire & {
  kind: "payment";
  /** True when the request replayed an earlier one with the same clientRequestId. */
  idempotent: boolean;
};

export type PaymentIntentStatusWire = "pending" | "requires_action" | "captured" | "failed" | "expired" | "cancelled";

export type PaymentIntentWire = {
  id: string;
  propertyId: string;
  folioId: string | null;
  reservationId: string | null;
  amount: number;
  currency: string;
  status: PaymentIntentStatusWire;
  provider: PspProviderCode | null;
  providerReference: string | null;
  paymentLinkUrl: string | null;
  /** The Payment created when the PSP confirmed (null until then). */
  paymentId: string | null;
  createdAt: string;
};

/** POST /folios/:id/payments with a PSP method, or POST /folios/:id/payment-links — 202. */
export type PaymentLinkResponse = {
  kind: "payment_intent";
  intent: PaymentIntentWire;
  /** How the customer reaches the hosted page: a GET link (Stripe Checkout) or a POST form (Redsys SIS). */
  redirect: { method: "GET"; url: string } | { method: "POST"; url: string; fields: Record<string, string> };
  idempotent: boolean;
};

export type PspStatusWire = {
  configured: boolean;
  provider: PspProviderCode | null;
  /** "test" (sandbox credentials) | "live" | null when not configured. */
  mode: "test" | "live" | null;
  webhookSecretConfigured: boolean;
  /** Honest note in Spanish for the UI (why a card/link payment cannot be taken). */
  message: string;
};

export type RefundWire = {
  id: string;
  paymentId: string;
  amount: number;
  status: string;
  requiresApproval: boolean;
  approvedBy: string | null;
  providerReference: string | null;
  createdAt: string;
};

export type RefundResponse = PaymentWire & {
  refundedAmount: number;
  refunds: RefundWire[];
  /** The reversal Payment row created by this refund (or replayed). */
  reversal: PaymentWire;
  idempotent: boolean;
};

// ── Invoice snapshot (Invoice.snapshotJson) ──────────────────────────────────

export type InvoiceSnapshotLine = {
  /** FolioLine.id the line came from (null on manual drafts / substitute lines). */
  folioLineId: string | null;
  description: string;
  quantity: number;
  /** Gross unit price (tax included), folio convention. */
  unitPrice: number;
  /** Gross line total (tax included), rounded to the cent. */
  total: number;
  taxCode: string;
  taxRate: number;
  taxCategory: string | null;
  taxCalificacion: string | null;
  taxFigure: string | null;
  /** Informational per-line base / quota (the canonical desglose is taxBreakdown, per group). */
  base: number;
  quota: number;
  /** PGC revenue account the line posts to (705.1 accommodation, 705.2 F&B, 4759 tourist tax…). */
  revenueAccountCode: string;
};

export type InvoiceSnapshotTaxGroup = {
  figure: string;
  impuesto: string;
  calificacion: string;
  ratePercent: number;
  base: number;
  quota: number;
};

export type InvoiceSnapshotV1 = {
  version: 1;
  status: "issued";
  issuedAt: string;
  currencyCode: string;
  lines: InvoiceSnapshotLine[];
  totals: { total: number; taxTotal: number; baseTotal: number };
  taxBreakdown: InvoiceSnapshotTaxGroup[];
  folioLineIds: string[];
  issuer: { taxId: string; legalName: string };
  customer: { type: string; taxId: string | null; name: string | null };
};

/** Draft-time snapshot: the folio lines the draft was built from (checked again at issuance). */
export type InvoiceDraftSnapshot = {
  version: 1;
  status: "draft";
  folioLineIds: string[];
  /** Fingerprint of the folio lines at draft time; issuance refuses (409 FOLIO_CHANGED_SINCE_DRAFT) when it changed. */
  folioFingerprint: string;
};

export type InvoiceEmailResponse = {
  invoiceId: string;
  invoiceNumber: string;
  recipient: string;
  status: "sent" | "simulated";
  /** True when no email provider is configured: nothing left the box. */
  simulated: boolean;
  deliveryId: string;
  providerMessageId: string | null;
  attachment: { filename: string; contentType: "application/pdf"; bytes: number };
  sentAt: string;
};

export type InvoiceCancellationPayments = {
  /** Payments that were linked to the cancelled invoice and are now free on the folio. */
  unlinkedPaymentIds: string[];
  /** Reversal payments created because the caller asked `refundPayments: true`. */
  refundedPaymentIds: string[];
  folioId: string | null;
  folioBalanceDue: number | null;
};
