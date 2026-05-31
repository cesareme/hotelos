// Adapter registry. The aggregator looks up the correct adapter via
// `resolveAdapter(providerCode)` so the rest of the codebase never has to
// import a specific provider.

import type { ChannelAdapter, ChannelProviderCode } from "../adapter.types.js";
import { airbnbAdapter } from "./airbnb.adapter.js";
import { bookingAdapter } from "./booking.adapter.js";
import { expediaAdapter } from "./expedia.adapter.js";
import { hotelbedsAdapter } from "./hotelbeds.adapter.js";
import { vrboAdapter } from "./vrbo.adapter.js";

const ADAPTERS: Record<ChannelProviderCode, ChannelAdapter> = {
  booking: bookingAdapter,
  expedia: expediaAdapter,
  airbnb: airbnbAdapter,
  hotelbeds: hotelbedsAdapter,
  vrbo: vrboAdapter
};

export function resolveAdapter(providerCode: string): ChannelAdapter | null {
  const key = providerCode.toLowerCase() as ChannelProviderCode;
  return ADAPTERS[key] ?? null;
}

export function listProviderCodes(): ChannelProviderCode[] {
  return Object.keys(ADAPTERS) as ChannelProviderCode[];
}
