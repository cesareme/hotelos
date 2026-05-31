// Public entry point for payment adapters.
//
// Usage:
//   import { paymentAdapterFor } from "@hotelos/integrations/payments";
//   const adapter = paymentAdapterFor("redsys");
//   const result = await adapter.charge(connection.config, intent);

import { redsys } from "./redsys.adapter.js";
import { stripe } from "./stripe.adapter.js";

export type { PaymentAdapter, PaymentChargeIntent, PaymentChargeResult, PaymentRefundIntent, PaymentRefundResult } from "./types.js";
export type { RedsysConfig } from "./redsys.adapter.js";
export type { StripeConfig } from "./stripe.adapter.js";
export { redsys, stripe };

const ADAPTERS = { redsys, stripe } as const;
export type PaymentProviderCode = keyof typeof ADAPTERS;

export function paymentAdapterFor(code: PaymentProviderCode) {
  return ADAPTERS[code];
}
