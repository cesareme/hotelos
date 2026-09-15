// Environment variables of the payments module (finanzas · lote
// facturación-cobros, 2026-09-15). Same format as ENV_CONTRACT in
// apps/api/src/lib/env.ts: env.ts spreads PAYMENTS_ENV_CONTRACT (section
// «Pagos») and scripts/env-census.mjs then finds every read documented.
//
// Decisions:
//   · Nothing leaves the box without credentials: with no STRIPE_SECRET_KEY /
//     REDSYS_SECRET_KEY the adapters report `configured: false` and the API
//     answers 409 PSP_NOT_CONFIGURED for card-online / payment-link cobros —
//     it never records a fictitious «captured».
//   · STRIPE_SECRET_KEY decides the mode by its prefix (sk_test_ sandbox,
//     sk_live_ producción); REDSYS_MODE is explicit (test → sis-t.redsys.es).
//   · PAYMENTS_PSP_PROVIDER forces the provider for every property; without
//     it the property's PaymentProviderConnection (status connected) picks it
//     and, failing that, the first configured provider (stripe, then redsys).
//   · PAYMENTS_PUBLIC_BASE_URL is where the PSP redirects the customer and
//     posts notifications (must be reachable from the Internet in
//     production); it defaults to API_PUBLIC_URL / GUEST_WEB_BASE_URL.

import type { EnvContract } from "../../lib/env.js";

export const PAYMENTS_ENV_CONTRACT: EnvContract = Object.freeze({
  PAYMENTS_PSP_PROVIDER: {
    section: "Pagos",
    format: "enum",
    values: ["stripe", "redsys"],
    doc: "Fuerza el PSP de todos los cobros en línea (stripe | redsys). Vacío = la conexión «connected» de la propiedad y, si no hay, el primer proveedor con credenciales (Stripe, luego Redsys)."
  },
  PAYMENTS_PUBLIC_BASE_URL: {
    section: "Pagos",
    format: "url",
    origin: true,
    httpsInProduction: true,
    doc: "Origen público al que el PSP redirige al cliente tras pagar y donde envía las notificaciones (/payments/webhooks/:provider). Vacío = API_PUBLIC_URL. Sin barra final."
  },
  STRIPE_SECRET_KEY: {
    section: "Pagos",
    format: "string",
    pattern: "^sk_(test|live)_[A-Za-z0-9]+$",
    tags: ["secret"],
    doc: "Clave secreta de Stripe. sk_test_… = sandbox real de Stripe (llamadas HTTPS a api.stripe.com en modo test); sk_live_… = producción. Vacío = Stripe no configurado (409 PSP_NOT_CONFIGURED)."
  },
  STRIPE_WEBHOOK_SECRET: {
    section: "Pagos",
    format: "string",
    pattern: "^whsec_[A-Za-z0-9]+$",
    required: { when: "STRIPE_SECRET_KEY" },
    tags: ["secret"],
    doc: "Secreto de firma del endpoint de webhooks de Stripe (whsec_…). Sin él ningún webhook de Stripe se acepta: un cobro en línea nunca pasa a «captured»."
  },
  REDSYS_MERCHANT_CODE: {
    section: "Pagos",
    format: "string",
    pattern: "^[0-9]{9}$",
    doc: "Código de comercio (FUC, 9 dígitos) del TPV Virtual de Redsys. Vacío = Redsys no configurado."
  },
  REDSYS_TERMINAL: {
    section: "Pagos",
    format: "string",
    default: "001",
    doc: "Número de terminal del TPV Virtual de Redsys (normalmente 001)."
  },
  REDSYS_SECRET_KEY: {
    section: "Pagos",
    format: "string",
    required: { when: "REDSYS_MERCHANT_CODE" },
    tags: ["secret"],
    doc: "Clave secreta (base64, 24 bytes) del comercio en Redsys: deriva la clave de cada operación con 3DES y firma HMAC-SHA256 (HMAC_SHA256_V1)."
  },
  REDSYS_MODE: {
    section: "Pagos",
    format: "enum",
    values: ["test", "live"],
    default: "test",
    productionExample: "live",
    doc: "Entorno del SIS de Redsys: test (sis-t.redsys.es, sin dinero real) o live (sis.redsys.es)."
  }
});
