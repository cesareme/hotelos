import type { IntegrationAuthType, IntegrationCapability } from "../adapters/base-adapter.js";
import type { IntegrationCategoryCode } from "./integration-categories.js";

// Tanda L8 (corrector, REV-02): every provider of this manifest is a demo
// adapter — `demo: true`, `mode: "sandbox"` and a name that says so, like the
// hub fixtures of apps/api/src/lib/demo-store.ts. No real adapter exists in
// this build, so a consumer (apps/mobile) must never paint one as connected.
export type IntegrationProviderManifest = {
  code: string;
  name: string;
  categoryCode: IntegrationCategoryCode;
  authType: IntegrationAuthType;
  supportedRegions: string[];
  capabilities: IntegrationCapability[];
  /** Demo adapter: never charges, syncs nor sends anything. */
  demo: boolean;
  /** Declared mode of the adapter (`sandbox` for every demo provider). */
  mode: "sandbox" | "real";
};

export const INTEGRATION_PROVIDERS: IntegrationProviderManifest[] = [
  {
    code: "mock_ota",
    name: "Demo OTA Adapter (demostración)",
    categoryCode: "otas",
    authType: "api_key",
    supportedRegions: ["EU"],
    capabilities: ["pull_reservations"],
    demo: true,
    mode: "sandbox"
  },
  {
    code: "mock_channel_manager",
    name: "Demo Channel Manager (demostración)",
    categoryCode: "channel_managers",
    authType: "oauth2",
    supportedRegions: ["EU"],
    capabilities: ["push_availability", "push_rates", "pull_reservations"],
    demo: true,
    mode: "sandbox"
  },
  {
    code: "mock_payments",
    name: "Demo Payment Gateway (demostración)",
    categoryCode: "payment_gateways",
    authType: "api_key",
    supportedRegions: ["EU"],
    capabilities: ["send_payment_link", "capture_payment"],
    demo: true,
    mode: "sandbox"
  },
  {
    code: "mock_guest_messaging",
    name: "Demo Guest Messaging (demostración)",
    categoryCode: "guest_messaging",
    authType: "webhook",
    supportedRegions: ["EU"],
    capabilities: ["send_message"],
    demo: true,
    mode: "sandbox"
  },
  {
    code: "mock_einvoice",
    name: "Demo E-invoicing Provider (demostración)",
    categoryCode: "einvoicing_providers",
    authType: "certificate",
    supportedRegions: ["ES"],
    capabilities: ["sync_invoice"],
    demo: true,
    mode: "sandbox"
  }
];
