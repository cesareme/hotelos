// Adapter registry (rate grid v2). Everything else in the codebase resolves an
// adapter through `resolveAdapter(providerCode)` and never imports a provider.
//
// Provider codes accepted (case-insensitive, with the aliases the demo data and
// the seed use): booking | booking_com | booking.com → booking; expedia;
// channex; airbnb; hotelbeds; vrbo. Unknown codes → null (the caller answers 400).

import type { ChannelAdapter, ChannelProviderCode } from "../adapter.types.js";
import { airbnbAdapter, hotelbedsAdapter, vrboAdapter } from "./via-channex.adapter.js";
import { bookingAdapter } from "./booking.adapter.js";
import { channexAdapter } from "./channex.adapter.js";
import { expediaAdapter } from "./expedia.adapter.js";

const ADAPTERS: Record<Exclude<ChannelProviderCode, "booking_com">, ChannelAdapter> = {
  booking: bookingAdapter,
  expedia: expediaAdapter,
  channex: channexAdapter,
  airbnb: airbnbAdapter,
  hotelbeds: hotelbedsAdapter,
  vrbo: vrboAdapter
};

const ALIASES: Record<string, keyof typeof ADAPTERS> = {
  booking: "booking",
  booking_com: "booking",
  "booking.com": "booking",
  bookingcom: "booking",
  expedia: "expedia",
  channex: "channex",
  airbnb: "airbnb",
  hotelbeds: "hotelbeds",
  vrbo: "vrbo"
};

export function normalizeProviderCode(providerCode: string): keyof typeof ADAPTERS | null {
  return ALIASES[providerCode.trim().toLowerCase()] ?? null;
}

export function resolveAdapter(providerCode: string): ChannelAdapter | null {
  const key = normalizeProviderCode(providerCode);
  return key ? ADAPTERS[key] : null;
}

export function listProviderCodes(): string[] {
  return ["booking_com", "expedia", "channex", "airbnb", "hotelbeds", "vrbo"];
}

/** Providers that run the OTA XML/JSON simulator: everything else is Channex-routed. */
export function isDirectProvider(providerCode: string): boolean {
  const key = normalizeProviderCode(providerCode);
  return key === "booking" || key === "expedia" || key === "channex";
}
