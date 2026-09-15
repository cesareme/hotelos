// Channex-routed providers (rate grid v2): Airbnb, Hotelbeds and Vrbo.
//
// None of these three has a self-service connectivity API a small PMS can
// certify against (Airbnb and Vrbo only onboard established channel managers;
// Hotelbeds' inventory push is reserved to contracted wholesaler partners).
// Anfitorio reaches them THROUGH the Channex aggregator: the Channex property
// is connected to Airbnb/Vrbo/Hotelbeds on the Channex side and our ARI goes
// out once via channex.adapter.ts.
//
// This factory keeps a first-class adapter per provider so the editor can list
// the channel, map products and see states, but:
//   stub / sandbox → the ARI is validated by the Channex simulator (same JSON
//                    the aggregator would send for that OTA);
//   real           → refused with an explicit message: create a `channex`
//                    channel and connect the OTA there.

import type { AdapterCapabilities, AdapterDeps, ChannelAdapter, ChannelContext, ChannelProviderCode, TestCredentialsResult } from "../adapter.types.js";
import { failedResult } from "../adapter.types.js";
import { CHANNEX_CAPABILITIES, createChannexAdapter } from "./channex.adapter.js";
import { buildStubReservations } from "./stub-utils.js";

const VIA_CHANNEX_MESSAGE = "se distribuye a través de Channex: cree un canal «channex» y conecte esta OTA en Channex.";

export function createChannexRoutedAdapter(providerCode: Extract<ChannelProviderCode, "airbnb" | "hotelbeds" | "vrbo">, label: string, deps: AdapterDeps = {}): ChannelAdapter {
  const channex = createChannexAdapter(deps);
  const capabilities: AdapterCapabilities = { ...CHANNEX_CAPABILITIES, derivedPricing: false, occupancyPricing: providerCode !== "airbnb" };

  function viaSimulator(channel: ChannelContext): ChannelContext {
    // The Channex simulator needs a property id; stub/sandbox channels of these
    // providers rarely carry one, so fall back to a deterministic code.
    return { ...channel, providerCode: "channex", externalPropertyCode: channel.externalPropertyCode ?? `sbx-${providerCode}` };
  }

  function refuseReal() {
    return failedResult({ errors: [`${label} ${VIA_CHANNEX_MESSAGE}`], retryable: false });
  }

  return {
    providerCode,
    capabilities: () => capabilities,
    async pushRates(input) {
      if (input.channel.mode === "real") return refuseReal();
      return channex.pushRates({ channel: viaSimulator(input.channel), items: input.items });
    },
    async pushAvailability(input) {
      if (input.channel.mode === "real") return refuseReal();
      return channex.pushAvailability({ channel: viaSimulator(input.channel), items: input.items });
    },
    async pushRestrictions(input) {
      if (input.channel.mode === "real") return refuseReal();
      return channex.pushRestrictions({ channel: viaSimulator(input.channel), items: input.items });
    },
    async pullReservations({ channel, since }) {
      if (channel.mode === "real") return { ok: false, reservations: [], nextCursor: null, errors: [`${label} ${VIA_CHANNEX_MESSAGE}`] };
      return { ok: true, reservations: buildStubReservations(channel.id, since, providerCode), nextCursor: null };
    },
    async testCredentials({ channel }): Promise<TestCredentialsResult> {
      if (channel.mode === "real") return { ok: false, error: `${label} ${VIA_CHANNEX_MESSAGE}` };
      return { ok: true, metadata: { provider: providerCode, mode: channel.mode, routedVia: "channex", note: `${label} se simula localmente; en producción va vía Channex.` } };
    }
  };
}

export const airbnbAdapter: ChannelAdapter = createChannexRoutedAdapter("airbnb", "Airbnb");
export const hotelbedsAdapter: ChannelAdapter = createChannexRoutedAdapter("hotelbeds", "Hotelbeds");
export const vrboAdapter: ChannelAdapter = createChannexRoutedAdapter("vrbo", "Vrbo");
