import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type ComplianceSettingsMappingTarget = {
  country: string | null;
  regionCode?: string | null;
  authorityType?: "ses_hospedajes" | "mossos" | "ertzaintza" | "manual" | "other" | null;
  legalProfileComplete: boolean | null;
  sesHospedajesReady: boolean | null;
  retentionYears: number | null;
};

export type ComplianceSettingsMappingSuggestion = OnboardingStructuredSuggestion<ComplianceSettingsMappingTarget>;
