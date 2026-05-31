import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type RatePlanMappingTarget = {
  code: string | null;
  name: string | null;
  ratePlanType: string | null;
  parentRatePlanCode?: string | null;
  derivation?: Record<string, unknown> | null;
  restrictions?: Record<string, unknown> | null;
};

export type RatePlanMappingSuggestion = OnboardingStructuredSuggestion<RatePlanMappingTarget>;
