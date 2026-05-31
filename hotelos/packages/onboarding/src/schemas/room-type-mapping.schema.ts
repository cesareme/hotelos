import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type RoomTypeMappingTarget = {
  code: string | null;
  name: string | null;
  sourceCode?: string | null;
  maxOccupancy?: number | null;
  defaultBedConfiguration?: Record<string, unknown> | null;
};

export type RoomTypeMappingSuggestion = OnboardingStructuredSuggestion<RoomTypeMappingTarget>;
