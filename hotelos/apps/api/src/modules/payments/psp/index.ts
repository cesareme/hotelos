// PSP resolution for a property (finanzas · lote facturación-cobros).
//
// Order: an explicit PAYMENTS_PSP_PROVIDER, else a `connected`
// PaymentProviderConnection of the property (provider stripe | redsys; the
// credentials still come from the environment in this lote — the
// connection row only selects the provider per property), else the first
// provider with credentials in the environment (stripe, then redsys). A
// property may have NO PSP: `resolvePspAdapter` then returns null and the
// callers answer 409 PSP_NOT_CONFIGURED.

import { prisma } from "@hotelos/database";
import type { PspProviderCode, PspStatusWire } from "../../../../../../packages/shared/src/payments-types.js";
import type { PspAdapter } from "./psp.types.js";
import { RedsysAdapter, redsysConfigFromEnv } from "./redsys.adapter.js";
import { StripeAdapter, stripeConfigFromEnv } from "./stripe.adapter.js";

export type PspRegistry = { stripe: () => PspAdapter; redsys: () => PspAdapter };

const defaultRegistry: PspRegistry = {
  stripe: () => new StripeAdapter(stripeConfigFromEnv()),
  redsys: () => new RedsysAdapter(redsysConfigFromEnv())
};

let registry: PspRegistry = defaultRegistry;

/** Tests / integrator hook: swap the adapters (e.g. a fake Stripe that never calls the network). */
export function setPspRegistry(next: PspRegistry | null): void {
  registry = next ?? defaultRegistry;
}

export function pspAdapterFor(provider: PspProviderCode): PspAdapter {
  return registry[provider]();
}

/** Provider selected for a property, before checking whether it is configured. */
export async function selectPspProvider(propertyId: string, env: NodeJS.ProcessEnv = process.env): Promise<PspProviderCode | null> {
  const forced = (env.PAYMENTS_PSP_PROVIDER ?? "").trim().toLowerCase();
  if (forced === "stripe" || forced === "redsys") return forced;
  const connection = await prisma.paymentProviderConnection.findFirst({
    where: { propertyId, status: "connected", provider: { in: ["stripe", "redsys"] } },
    orderBy: { createdAt: "desc" },
    select: { provider: true }
  });
  if (connection?.provider === "stripe" || connection?.provider === "redsys") return connection.provider;
  if (registry.stripe().status().configured) return "stripe";
  if (registry.redsys().status().configured) return "redsys";
  return null;
}

/** Configured adapter of the property, or null (honest: no PSP). */
export async function resolvePspAdapter(propertyId: string): Promise<PspAdapter | null> {
  const provider = await selectPspProvider(propertyId);
  if (!provider) return null;
  const adapter = pspAdapterFor(provider);
  return adapter.status().configured ? adapter : null;
}

export async function pspStatusFor(propertyId: string): Promise<PspStatusWire> {
  const provider = await selectPspProvider(propertyId);
  if (!provider) {
    return {
      configured: false,
      provider: null,
      mode: null,
      webhookSecretConfigured: false,
      message: "Ningún PSP configurado: los cobros con tarjeta en línea y los enlaces de pago no están disponibles. Configura STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET o REDSYS_MERCHANT_CODE / REDSYS_TERMINAL / REDSYS_SECRET_KEY."
    };
  }
  const status = pspAdapterFor(provider).status();
  return { configured: status.configured, provider, mode: status.mode, webhookSecretConfigured: status.webhookSecretConfigured, message: status.message };
}
