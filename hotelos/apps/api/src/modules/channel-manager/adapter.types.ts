// Shared types for OTA channel adapters. Each provider (Booking, Expedia, Airbnb,
// Hotelbeds, Vrbo) implements `ChannelAdapter` and is selected at runtime by
// `resolveAdapter(providerCode)` (see `adapters/index.ts`).
//
// Stub mode is the default in this codebase: adapters return deterministic
// success/failure responses and log a `ChannelSyncJob` row instead of talking
// to the real OTA APIs. The exact spot where a real network call would happen
// is marked with a `// REAL CALL:` comment block in each adapter so swapping in
// production credentials is a contained change.

export type ChannelProviderCode = "booking" | "expedia" | "airbnb" | "hotelbeds" | "vrbo";

export type RatePushItem = {
  date: string; // YYYY-MM-DD
  ratePlanId: string;
  amount: number;
  currency: string;
};

export type AvailabilityPushItem = {
  date: string;
  roomTypeId: string;
  count: number;
};

export type RestrictionPushItem = {
  date: string;
  roomTypeId: string;
  ratePlanId?: string;
  minStay?: number;
  maxStay?: number;
  cta?: boolean;
  ctd?: boolean;
  closed?: boolean;
};

export type AdapterResult = {
  ok: boolean;
  pushed?: number;
  errors?: string[];
  latencyMs?: number;
  raw?: unknown;
};

// Context passed to every adapter call so adapters don't need direct DB access.
// `credentialsJson` is hydrated from `Channel.configurationJson` for stub mode
// (in production it would come from a secret store keyed by
// `Channel.credentialsSecretRef`).
export type ChannelContext = {
  id: string;
  propertyId: string;
  providerCode: ChannelProviderCode;
  credentialsJson: Record<string, unknown> | null;
};

export type ExternalReservationDTO = {
  externalReference: string;
  status: string;
  payloadJson: Record<string, unknown>;
};

export interface ChannelAdapter {
  providerCode: ChannelProviderCode;
  pushRates(input: { channel: ChannelContext; items: RatePushItem[] }): Promise<AdapterResult>;
  pushAvailability(input: { channel: ChannelContext; items: AvailabilityPushItem[] }): Promise<AdapterResult>;
  pushRestrictions(input: { channel: ChannelContext; items: RestrictionPushItem[] }): Promise<AdapterResult>;
  fetchReservations(input: {
    channel: ChannelContext;
    since: Date;
  }): Promise<{ ok: boolean; reservations: ExternalReservationDTO[]; errors?: string[] }>;
  testCredentials(input: {
    channel: ChannelContext;
  }): Promise<{ ok: boolean; error?: string; metadata?: Record<string, unknown> }>;
  fetchCompetitorRates?(input: {
    channel: ChannelContext;
    dateRange: { from: string; to: string };
  }): Promise<{
    ok: boolean;
    rates: { date: string; competitorHotel: string; price: number; currency: string }[];
  }>;
}
