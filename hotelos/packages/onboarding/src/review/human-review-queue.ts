import type { OnboardingRiskLevel } from "../schemas/base-mapping.js";

export type OnboardingHumanReviewItem = {
  id: string;
  sourceEntityId?: string;
  targetEntityType: string;
  reason: "low_confidence" | "high_risk" | "missing_data" | "financial_or_compliance" | "pending_user_review";
  riskLevel: OnboardingRiskLevel;
  confidence: number;
  missingData: string[];
  warnings: string[];
  requiredDecision: "approve" | "reject" | "edit";
  status: "pending" | "approved" | "rejected" | "edited";
};

export type HumanReviewSuggestionInput = {
  id: string;
  sourceEntityId?: string;
  targetEntityType: string;
  confidence: number;
  riskLevel: OnboardingRiskLevel;
  missingDataJson?: string[];
  warningsJson?: string[];
  status: "pending" | "approved" | "rejected" | "edited" | "applied";
};

function reviewReason(input: HumanReviewSuggestionInput): OnboardingHumanReviewItem["reason"] {
  if (input.status === "pending") return "pending_user_review";
  if (input.confidence < 0.8) return "low_confidence";
  if (input.riskLevel === "high" || input.riskLevel === "critical") return "high_risk";
  if ((input.missingDataJson ?? []).length > 0) return "missing_data";
  if (["reservation", "revenue_daily_snapshot", "compliance_settings", "rate_plan"].includes(input.targetEntityType)) return "financial_or_compliance";
  return "pending_user_review";
}

export function buildHumanReviewQueue(suggestions: HumanReviewSuggestionInput[]): {
  items: OnboardingHumanReviewItem[];
  summary: {
    pending: number;
    lowConfidence: number;
    highRisk: number;
    missingData: number;
    financialOrCompliance: number;
  };
  applyBlockedUntilQueueCleared: boolean;
} {
  const items = suggestions
    .filter((suggestion) => {
      return (
        suggestion.status === "pending" ||
        suggestion.confidence < 0.8 ||
        suggestion.riskLevel === "high" ||
        suggestion.riskLevel === "critical" ||
        (suggestion.missingDataJson ?? []).length > 0 ||
        ["reservation", "revenue_daily_snapshot", "compliance_settings", "rate_plan"].includes(suggestion.targetEntityType)
      );
    })
    .map((suggestion) => ({
      id: suggestion.id,
      sourceEntityId: suggestion.sourceEntityId,
      targetEntityType: suggestion.targetEntityType,
      reason: reviewReason(suggestion),
      riskLevel: suggestion.riskLevel,
      confidence: suggestion.confidence,
      missingData: suggestion.missingDataJson ?? [],
      warnings: suggestion.warningsJson ?? [],
      requiredDecision: "approve",
      status: suggestion.status === "applied" ? "approved" : suggestion.status
    })) satisfies OnboardingHumanReviewItem[];

  return {
    items,
    summary: {
      pending: items.filter((item) => item.status === "pending").length,
      lowConfidence: items.filter((item) => item.reason === "low_confidence").length,
      highRisk: items.filter((item) => item.reason === "high_risk").length,
      missingData: items.filter((item) => item.reason === "missing_data").length,
      financialOrCompliance: items.filter((item) => item.reason === "financial_or_compliance").length
    },
    applyBlockedUntilQueueCleared: items.some((item) => item.status === "pending")
  };
}
