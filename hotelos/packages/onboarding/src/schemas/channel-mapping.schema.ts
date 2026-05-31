import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type ChannelMappingTarget = {
  channelProviderCode: string | null;
  internalRoomTypeCode: string | null;
  externalRoomCode: string | null;
  internalRatePlanCode: string | null;
  externalRateCode: string | null;
  mappingHealth: "valid" | "missing" | "duplicate" | "invalid" | null;
};

export type ChannelMappingSuggestion = OnboardingStructuredSuggestion<ChannelMappingTarget>;
