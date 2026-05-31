// Shared types for payment adapters (Redsys, Stripe, future Adyen).

export type PaymentChargeIntent = {
  /** Unique idempotency key — same key = same charge, retryable safely. */
  idempotencyKey: string;
  amount: number; // in major units (e.g. 12.50 = 12.50 EUR)
  currency: string; // "EUR", "USD"
  description: string;
  /** Reservation / folio reference shown on the cardholder statement. */
  reference: string;
  /** If true, the call must use PSD2 SCA (3DS challenge) when required. */
  enforceSca?: boolean;
  /** When set, the adapter tokenizes the card for future MIT (merchant initiated transactions). */
  saveCardForLater?: boolean;
  /** A previously-tokenized card to use without prompting the cardholder. */
  cardTokenRef?: string;
  customer?: {
    email?: string;
    fullName?: string;
    documentNumber?: string;
  };
  /** Where to redirect the cardholder after 3DS / Redsys redirect. */
  returnUrl?: string;
};

export type PaymentChargeResult =
  | {
      status: "succeeded";
      providerTransactionId: string;
      capturedAt: string;
      cardTokenRef?: string;
      receiptUrl?: string;
    }
  | {
      status: "requires_action";
      /** When status=requires_action: redirect the cardholder here (Redsys SIS, Stripe 3DS). */
      actionUrl: string;
      providerTransactionId: string;
    }
  | {
      status: "failed";
      reason: string;
      providerTransactionId?: string;
      // Whether the failure is permanent (do not retry) or transient.
      permanent: boolean;
    };

export type PaymentRefundIntent = {
  idempotencyKey: string;
  /** The provider transaction id of the original charge. */
  providerTransactionId: string;
  /** Partial refund amount, or null for full refund. */
  amount?: number;
  reason?: string;
};

export type PaymentRefundResult = {
  status: "succeeded" | "failed";
  providerTransactionId: string;
  refundedAmount?: number;
  reason?: string;
};

export interface PaymentAdapter {
  providerCode: "redsys" | "stripe" | "adyen";
  /** Settings shape this adapter expects (validated on connect). */
  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string };
  /** Initiate a charge. May return requires_action when 3DS / SCA challenge required. */
  charge(config: unknown, intent: PaymentChargeIntent): Promise<PaymentChargeResult>;
  /** Refund a previous charge. */
  refund(config: unknown, intent: PaymentRefundIntent): Promise<PaymentRefundResult>;
  /** Verify the signature of an incoming webhook from the provider. */
  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean;
}
