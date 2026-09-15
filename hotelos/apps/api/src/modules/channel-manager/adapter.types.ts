// Channel adapter contract v2 (rate grid v2 · lote api-channel-outbox).
//
// What changed versus v1 and why:
//   * Items arrive ALREADY TRANSLATED to the external codes of the channel
//     (`externalRoomCode` / `externalRateCode`, from ChannelProductMapping).
//     The adapter only serialises; it never looks up mappings. The internal
//     ids travel alongside so an adapter can echo them in `raw`/errors.
//   * `AdapterResult` is per item: `accepted` + `rejected[{itemIndex, code,
//     message}]` so the outbox (delivery.service / drain.service) can mark one
//     ChannelDelivery rejected while the rest of the batch is confirmed.
//     `requestHash` / `responseHash` are always present for the audit trail.
//   * `capabilities()` drives batching (`maxItemsPerRequest`) and the per
//     channel token bucket (`rateLimitPerMinute`) in drain.service.
//   * Credentials are DECRYPTED from Channel.credentialsEncrypted by
//     channels.service (never by an adapter, never returned by the API).
//   * The execution mode is per channel (Channel.mode, capped by
//     CHANNEL_MAX_MODE) — not a process-wide env var any more:
//       stub    → in-process simulator, no credentials needed;
//       sandbox → same builders as real mode, validated by the in-process
//                 simulator against the provider schema (credentials must be
//                 present, they are not verified against anybody);
//       real    → HTTPS to the provider (needs real credentials).
//
// Adapters are pure with respect to the database: everything they need is in
// `ChannelContext`. Factories accept `AdapterDeps` (fetch, clock) so tests
// inject a fake fetch instead of monkey-patching globalThis.

export type ChannelProviderCode =
  | "booking"
  | "booking_com"
  | "expedia"
  | "channex"
  | "airbnb"
  | "hotelbeds"
  | "vrbo";

export type ChannelMode = "stub" | "sandbox" | "real";

export type PricingModel = "per_day" | "obp" | "los";

export type DeliveryKind = "rates" | "availability" | "restrictions";

export type RatePushItem = {
  /** YYYY-MM-DD */
  date: string;
  externalRoomCode: string;
  externalRateCode: string;
  roomTypeId: string;
  ratePlanId: string;
  currency: string;
  pricingModel: PricingModel;
  /** Price per night (per_day / los). */
  amount?: number;
  /** Occupancy based prices: { "1": 80, "2": 95, "extraAdult": 20, "extraChild": 10 }. */
  occupancyPrices?: Record<string, number>;
};

export type RestrictionPushItem = {
  date: string;
  externalRoomCode: string;
  /** Absent for room-level restrictions (stop sell applies to every plan). */
  externalRateCode?: string;
  roomTypeId?: string;
  ratePlanId?: string;
  minStay?: number;
  minStayThrough?: number;
  maxStay?: number;
  cta: boolean;
  ctd: boolean;
  /** The rate plan is not bookable that night. */
  closed: boolean;
  /** The room type is pulled from sale that night. */
  stopSell: boolean;
  minAdvanceDays?: number;
  maxAdvanceDays?: number;
};

export type AvailabilityPushItem = {
  date: string;
  externalRoomCode: string;
  roomTypeId: string;
  count: number;
};

export type AdapterRejection = {
  /** Index in the `items` array the adapter received. */
  itemIndex: number;
  /** Provider error code (Booking OTA `Code`, Channex `code`, Expedia `code`…). */
  code: string;
  message: string;
};

export type AdapterResult = {
  /** True when the request was accepted by the provider (some items may still be rejected). */
  ok: boolean;
  accepted: number;
  rejected: AdapterRejection[];
  /** Request-level errors (auth, transport, schema) — empty when ok. */
  errors: string[];
  latencyMs: number;
  /** sha256 of the outgoing body (audit; never the body itself). */
  requestHash: string;
  /** sha256 of the response body. */
  responseHash: string;
  /** True when the provider did not answer in time (transport timeout). Retryable. */
  timedOut?: boolean;
  /** True on HTTP 429 / provider throttling. Retryable after backoff. */
  rateLimited?: boolean;
  /** Explicit retry hint; when absent drain.service derives it from timedOut/rateLimited/HTTP 5xx. */
  retryable?: boolean;
  /**
   * Non-blocking notices: provider warnings (Channex `meta.warnings`, OTA
   * `<Warning>`, EQC `<Warning>`) and fields the provider cannot take (an
   * advance-booking restriction on a channel without that field). Stored in
   * the sync job so an operator can read why something was not sent.
   */
  warnings?: string[];
  /** Wait the provider asked for before retrying (`Retry-After` on 429/503), in ms. */
  retryAfterMs?: number;
  raw?: unknown;
};

export type AdapterCapabilities = {
  rates: boolean;
  availability: boolean;
  restrictions: boolean;
  reservationsPull: boolean;
  occupancyPricing: boolean;
  derivedPricing: boolean;
  /** Upper bound of items per push request (drain.service chunks by this). */
  maxItemsPerRequest: number;
  /** Requests per minute per channel (token bucket in drain.service). */
  rateLimitPerMinute: number;
};

/** Simulator knobs stored in credentials.simulator (sandbox / stub only). */
export type SimulatorOptions = {
  /** Every N-th request answers HTTP 429 (rate limited). 0/undefined = never. */
  failEvery?: number;
  /** Artificial latency; when >= the adapter timeout the call times out. */
  latencyMs?: number;
};

export type ChannelContext = {
  id: string;
  propertyId: string;
  providerCode: ChannelProviderCode;
  /** Effective mode (Channel.mode capped by CHANNEL_MAX_MODE). */
  mode: ChannelMode;
  /** Decrypted credentials (JSON) or null when the channel has none. */
  credentials: Record<string, unknown> | null;
  /** Provider-side hotel id when known (credentials.hotelId / property_id). */
  externalPropertyCode: string | null;
  simulator?: SimulatorOptions;
  /**
   * Debt flag: credentials were read from the legacy
   * `configurationJson.credentials` (plaintext) because credentialsEncrypted is
   * empty. The seed moves them; readiness reports it.
   */
  legacyPlaintextCredentials?: boolean;
};

export type ExternalReservationDTO = {
  externalReference: string;
  status: string;
  payloadJson: Record<string, unknown>;
};

export type PullReservationsResult = {
  ok: boolean;
  reservations: ExternalReservationDTO[];
  /** Opaque cursor for the next pull (null = provider does not paginate / nothing more). */
  nextCursor: string | null;
  errors?: string[];
};

export type TestCredentialsResult = {
  ok: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
};

export interface ChannelAdapter {
  providerCode: ChannelProviderCode;
  capabilities(): AdapterCapabilities;
  testCredentials(input: { channel: ChannelContext }): Promise<TestCredentialsResult>;
  pushRates(input: { channel: ChannelContext; items: RatePushItem[] }): Promise<AdapterResult>;
  pushAvailability(input: { channel: ChannelContext; items: AvailabilityPushItem[] }): Promise<AdapterResult>;
  pushRestrictions(input: { channel: ChannelContext; items: RestrictionPushItem[] }): Promise<AdapterResult>;
  pullReservations(input: { channel: ChannelContext; since: Date; cursor?: string | null }): Promise<PullReservationsResult>;
  acknowledgeReservations?(input: { channel: ChannelContext; ids: string[] }): Promise<{ ok: boolean; errors?: string[] }>;
  fetchCompetitorRates?(input: {
    channel: ChannelContext;
    dateRange: { from: string; to: string };
  }): Promise<{
    ok: boolean;
    rates: { date: string; competitorHotel: string; price: number; currency: string }[];
  }>;
}

/** Injectable transport/clock so adapter tests never touch the network. */
export type AdapterDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;

/** Result helpers shared by every adapter so the shape stays uniform. */
export function failedResult(input: {
  errors: string[];
  latencyMs?: number;
  requestHash?: string;
  responseHash?: string;
  timedOut?: boolean;
  rateLimited?: boolean;
  retryable?: boolean;
  warnings?: string[];
  retryAfterMs?: number;
  raw?: unknown;
}): AdapterResult {
  return {
    ok: false,
    accepted: 0,
    rejected: [],
    errors: input.errors,
    latencyMs: input.latencyMs ?? 0,
    requestHash: input.requestHash ?? "",
    responseHash: input.responseHash ?? "",
    ...(input.timedOut !== undefined ? { timedOut: input.timedOut } : {}),
    ...(input.rateLimited !== undefined ? { rateLimited: input.rateLimited } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.warnings !== undefined ? { warnings: input.warnings } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {})
  };
}
