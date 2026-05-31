import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type GuestMappingTarget = {
  firstName: string | null;
  surname1?: string | null;
  surname2?: string | null;
  email?: string | null;
  phone?: string | null;
  nationality?: string | null;
  duplicateCandidateIds?: string[];
};

export type GuestMappingSuggestion = OnboardingStructuredSuggestion<GuestMappingTarget>;
