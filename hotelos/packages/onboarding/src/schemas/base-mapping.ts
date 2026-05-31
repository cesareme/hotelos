export type OnboardingRiskLevel = "low" | "medium" | "high" | "critical";

export type OnboardingSourceReference = {
  fileId?: string;
  sheetName?: string;
  rowNumber?: number;
  pageNumber?: number;
  cellRange?: string;
  excerpt?: string;
};

export type OnboardingStructuredSuggestion<TTarget> = {
  confidence: number;
  sourceReferences: OnboardingSourceReference[];
  missingFields: string[];
  warnings: string[];
  riskLevel: OnboardingRiskLevel;
  suggestedTargetObject: TTarget;
  requiresReview: boolean;
};

export const ONBOARDING_AI_OUTPUT_RULES = [
  "Output structured JSON only.",
  "Include confidence, sourceReferences, missingFields, warnings, riskLevel, suggestedTargetObject and requiresReview.",
  "Never invent missing values.",
  "Use null for unknown values and list them in missingFields.",
  "Create human review items for low-confidence or high-risk mappings."
];
