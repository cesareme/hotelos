import type { IntegrationAuthType, IntegrationCapability } from "../adapters/base-adapter.js";
import type { IntegrationCategoryCode } from "./integration-categories.js";

export type IntegrationProviderManifest = {
  code: string;
  name: string;
  categoryCode: IntegrationCategoryCode;
  authType: IntegrationAuthType;
  supportedRegions: string[];
  capabilities: IntegrationCapability[];
};

export const INTEGRATION_PROVIDERS: IntegrationProviderManifest[] = [
  {
    code: "mock_ota",
    name: "Demo OTA Adapter",
    categoryCode: "otas",
    authType: "api_key",
    supportedRegions: ["EU"],
    capabilities: ["pull_reservations"]
  },
  {
    code: "mock_channel_manager",
    name: "Demo Channel Manager",
    categoryCode: "channel_managers",
    authType: "oauth2",
    supportedRegions: ["EU"],
    capabilities: ["push_availability", "push_rates", "pull_reservations"]
  },
  {
    code: "mock_payments",
    name: "Demo Payment Gateway",
    categoryCode: "payment_gateways",
    authType: "api_key",
    supportedRegions: ["EU"],
    capabilities: ["send_payment_link", "capture_payment"]
  },
  {
    code: "mock_guest_messaging",
    name: "Demo Guest Messaging",
    categoryCode: "guest_messaging",
    authType: "webhook",
    supportedRegions: ["EU"],
    capabilities: ["send_message"]
  },
  {
    code: "mock_einvoice",
    name: "Demo E-invoicing Provider",
    categoryCode: "einvoicing_providers",
    authType: "certificate",
    supportedRegions: ["ES"],
    capabilities: ["sync_invoice"]
  }
];
