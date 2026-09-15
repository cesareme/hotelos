// Environment variables of the channel-manager module (rate grid v2 · lote
// api-channel-outbox). Same format as ENV_CONTRACT in apps/api/src/lib/env.ts:
// the integrator merges CHANNEL_MANAGER_ENV_CONTRACT into the OTA section and
// scripts/env-census.mjs then finds every read below documented.
//
// Decisions:
//   · CHANNEL_MAX_MODE caps Channel.mode for EVERY channel of the instance.
//     Default "sandbox" in every environment: sandbox never leaves the box
//     (in-process simulator), so it is safe on the demo VPS and in production
//     until real credentials exist; "real" must be set explicitly and, in
//     production, is what allows HTTPS to a provider. Nothing reaches the
//     Internet without a channel in mode real AND CHANNEL_MAX_MODE=real.
//   · The v1 adapter variables — BOOKING_ADAPTER_MODE, BOOKING_SANDBOX_URL,
//     BOOKING_OAUTH_SCOPE, EXPEDIA_ADAPTER_MODE, EXPEDIA_OAUTH_URL,
//     AIRBNB_ADAPTER_MODE, AIRBNB_API_BASE_URL, AIRBNB_OAUTH_URL,
//     HOTELBEDS_ADAPTER_MODE, HOTELBEDS_API_BASE_URL, VRBO_ADAPTER_MODE,
//     VRBO_API_BASE_URL, VRBO_OAUTH_URL — were RETIRED from ENV_CONTRACT on
//     purpose (rate grid v2): Channel.mode + CHANNEL_MAX_MODE replace them and
//     no code reads them any more. They are deliberately NOT re-added as
//     `deprecated` entries: the census would then list variables nothing
//     reads. validate-env ignores keys it does not know, so a .env in the
//     field that still carries them keeps working silently — delete them by
//     hand (docs/booking-adapter.md lists them).
//   · BOOKING_API_BASE_URL, BOOKING_OAUTH_URL and EXPEDIA_API_BASE_URL keep
//     their meaning (BOOKING_OAUTH_URL points at the JWT exchange endpoint).
//   · CHANNEL_DELIVERY_RETENTION_DAYS bounds the outbox history: `superseded`
//     deliveries older than this are purged by the drain pass (they are the
//     only rows that grow without bound; every other status is live or the
//     last word on what a channel holds).

import type { EnvContract } from "../../lib/env.js";

export const CHANNEL_MODE_VALUES = ["stub", "sandbox", "real"] as const;

export const CHANNEL_MANAGER_ENV_CONTRACT: EnvContract = Object.freeze({
  CHANNEL_MAX_MODE: {
    section: "OTA",
    format: "enum",
    values: CHANNEL_MODE_VALUES,
    default: "sandbox",
    example: "sandbox",
    productionExample: "sandbox",
    doc: "Tope del modo de los canales (Channel.mode): stub (simulador, sin credenciales), sandbox (simulador local con validación estructural del payload; por defecto) o real (HTTPS al proveedor; exige credenciales reales). Nada sale a Internet sin real."
  },
  CHANNEX_BASE_URL: {
    section: "OTA",
    format: "url",
    default: "https://staging.channex.io",
    example: "https://staging.channex.io",
    productionExample: "https://app.channex.io",
    httpsInProduction: true,
    doc: "Base de la API de Channex (agregador). staging.channex.io para certificación; app.channex.io en producción. La api key va por canal (credenciales cifradas)."
  },
  CHANNEL_DRAIN_INTERVAL_MS: {
    section: "Schedulers",
    format: "int",
    min: 10_000,
    max: 86_400_000,
    default: "15000",
    doc: "Periodo (ms) del drenaje del outbox de canales (ChannelDelivery → adaptadores). Solo corre en el líder de schedulers (RUN_SCHEDULERS)."
  },
  CHANNEL_DRAIN_DISABLED: {
    section: "Schedulers",
    format: "bool",
    default: "false",
    doc: "true desactiva el drenaje automático del outbox de canales (las entregas quedan en cola; POST /channel-manager/deliveries/drain sigue disponible)."
  },
  CHANNEL_DRAIN_BATCH_LIMIT: {
    section: "Schedulers",
    format: "int",
    min: 10,
    max: 20_000,
    default: "2000",
    doc: "Máximo de entregas (ChannelDelivery) que toma cada pasada del drenaje."
  },
  CHANNEL_DELIVERY_RETENTION_DAYS: {
    section: "Schedulers",
    format: "int",
    min: 1,
    max: 3650,
    default: "30",
    doc: "Días que se conservan las entregas de canal sustituidas (ChannelDelivery status superseded); las más antiguas las purga la pasada de drenaje del líder (como máximo una vez por hora). El resto de estados nunca se purga."
  }
});

export type ChannelMaxMode = (typeof CHANNEL_MODE_VALUES)[number];

/** Local reader (the integrator merges the contract; readers stay in the module). */
export function readChannelEnv(): {
  maxMode: ChannelMaxMode;
  channexBaseUrl: string;
  drainIntervalMs: number;
  drainDisabled: boolean;
  drainBatchLimit: number;
  deliveryRetentionDays: number;
} {
  const rawMode = (process.env.CHANNEL_MAX_MODE ?? "").trim().toLowerCase();
  const maxMode: ChannelMaxMode = rawMode === "stub" || rawMode === "real" ? rawMode : "sandbox";
  const interval = Number(process.env.CHANNEL_DRAIN_INTERVAL_MS ?? "15000");
  const batch = Number(process.env.CHANNEL_DRAIN_BATCH_LIMIT ?? "2000");
  const retention = Number(process.env.CHANNEL_DELIVERY_RETENTION_DAYS ?? "30");
  return {
    maxMode,
    channexBaseUrl: process.env.CHANNEX_BASE_URL || "https://staging.channex.io",
    drainIntervalMs: Number.isFinite(interval) && interval >= 10_000 ? interval : 15_000,
    drainDisabled: process.env.CHANNEL_DRAIN_DISABLED === "true",
    drainBatchLimit: Number.isFinite(batch) && batch >= 10 ? Math.min(batch, 20_000) : 2000,
    deliveryRetentionDays: Number.isInteger(retention) && retention >= 1 ? Math.min(retention, 3650) : 30
  };
}
