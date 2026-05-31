import type { PermissionKey, RiskLevel } from "@hotelos/shared";
import type { HotelModuleCode } from "@hotelos/product";
import type { HotelOsToolName } from "./tool-names.js";

export type ToolDefinition = {
  name: HotelOsToolName;
  moduleCode: HotelModuleCode;
  description: string;
  riskLevel: RiskLevel;
  requiredPermissions: PermissionKey[];
  requiresConfirmation: boolean;
};

function advancedTool(
  name: HotelOsToolName,
  moduleCode: HotelModuleCode,
  permission: PermissionKey,
  riskLevel: RiskLevel = "medium",
  requiresConfirmation = false
): ToolDefinition {
  return {
    name,
    moduleCode,
    description: `${name} uses the ${moduleCode} typed backend tool contract and cannot execute when the module is disabled.`,
    riskLevel,
    requiredPermissions: [permission, "ai.tool.execute"],
    requiresConfirmation
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "matchGuestToReservation",
    moduleCode: "pms_core",
    description: "Find the most likely reservation for extracted guest identity fields.",
    riskLevel: "medium",
    requiredPermissions: ["pms.reservation.read", "ai.tool.execute"],
    requiresConfirmation: false
  },
  {
    name: "validateRoomAssignment",
    moduleCode: "pms_core",
    description: "Validate whether a room can be assigned for a reservation date range.",
    riskLevel: "medium",
    requiredPermissions: ["pms.reservation.read", "ai.tool.execute"],
    requiresConfirmation: false
  },
  {
    name: "checkInReservation",
    moduleCode: "ai_front_desk",
    description: "Execute check-in after confirmation and required signature.",
    riskLevel: "high",
    requiredPermissions: ["pms.checkin.execute", "ai.tool.execute"],
    requiresConfirmation: true
  },
  {
    name: "queueSesHospedajesSubmission",
    moduleCode: "compliance_hub",
    description: "Queue the guest register record for authority submission.",
    riskLevel: "high",
    requiredPermissions: ["compliance.ses.submit", "ai.tool.execute"],
    requiresConfirmation: false
  },
  advancedTool("extractGuestIdentityFieldsTemporary", "spain_guest_register_compliance", "guest_register.create", "medium", true),
  advancedTool("prepareGuestRegisterRecord", "spain_guest_register_compliance", "guest_register.create", "high", true),
  advancedTool("validateSpainGuestRegister", "spain_guest_register_compliance", "guest_register.read", "medium"),
  advancedTool("requestGuestRegisterSignature", "spain_guest_register_compliance", "guest_register.sign", "high", true),
  advancedTool("queueGuestAuthoritySubmission", "spain_guest_register_compliance", "guest_register.submit", "high", true),
  advancedTool("generateSesBatchFile", "spain_guest_register_compliance", "compliance.ses.export", "high", true),
  advancedTool("summarizeGuestRegisterComplianceIssues", "spain_guest_register_compliance", "guest_register.read", "low"),
  advancedTool("explainSubmissionRejection", "spain_guest_register_compliance", "guest_register.read", "low"),
  {
    name: "issueInvoice",
    moduleCode: "compliance_billing",
    description: "Issue an immutable invoice using the invoice compliance workflow.",
    riskLevel: "high",
    requiredPermissions: ["invoice.issue", "ai.high_risk.confirm"],
    requiresConfirmation: true
  },
  {
    name: "createSupplierBillDraft",
    moduleCode: "erp_accounting",
    description: "Create a supplier bill draft from OCR and coding suggestions.",
    riskLevel: "medium",
    requiredPermissions: ["ai.tool.execute"],
    requiresConfirmation: true
  },
  advancedTool("analyzePickup", "revenue_profit_engine", "revenue.read", "low"),
  advancedTool("analyzePace", "revenue_profit_engine", "revenue.read", "low"),
  advancedTool("generateRevenueForecast", "revenue_profit_engine", "revenue.recommend", "medium"),
  advancedTool("recommendRateChanges", "revenue_profit_engine", "revenue.recommend", "high", true),
  advancedTool("recommendRestrictions", "revenue_profit_engine", "revenue.recommend", "high", true),
  advancedTool("analyzeChannelProfitability", "revenue_profit_engine", "revenue.read", "low"),
  advancedTool("detectUnderpricedDates", "revenue_profit_engine", "revenue.read", "medium"),
  advancedTool("detectOverpricedDates", "revenue_profit_engine", "revenue.read", "medium"),
  advancedTool("simulateRevenueScenario", "revenue_profit_engine", "revenue.recommend", "medium"),
  advancedTool("evaluateGroupDisplacement", "revenue_profit_engine", "revenue.recommend", "medium"),
  advancedTool("analyzeRateParity", "revenue_profit_engine", "channel_manager.read", "medium"),
  advancedTool("recommendChannelCloseout", "revenue_profit_engine", "channel_manager.manage", "high", true),
  advancedTool("summarizeRevenueRisks", "revenue_profit_engine", "revenue.read", "low"),
  advancedTool("explainRevenueVariance", "revenue_profit_engine", "revenue.read", "low"),
  advancedTool("explainHistoryForecast", "revenue_profit_engine", "revenue.history_forecast.read", "low"),
  advancedTool("compareRevenuePeriods", "revenue_profit_engine", "revenue.comparison.read", "low"),
  advancedTool("explainForecastConfidence", "revenue_profit_engine", "revenue.forecast_confidence.read", "low"),
  advancedTool("createOwnerRevenueReport", "revenue_profit_engine", "revenue.history_forecast.export", "medium", true),
  advancedTool("detectHistoryForecastRisks", "revenue_profit_engine", "revenue.visual_alerts.read", "medium"),
  advancedTool("applyRevenueRecommendation", "revenue_profit_engine", "revenue.apply_recommendations", "critical", true),
  advancedTool("syncChannelRates", "revenue_profit_engine", "channel_manager.sync", "high", true),
  advancedTool("syncChannelAvailability", "revenue_profit_engine", "channel_manager.sync", "high", true),
  advancedTool("detectDuplicateGuests", "guest_data_crm_loyalty", "crm.read", "medium"),
  advancedTool("summarizeGuestProfile", "guest_data_crm_loyalty", "crm.read", "low"),
  advancedTool("recommendGuestSegment", "guest_data_crm_loyalty", "crm.read", "low"),
  advancedTool("createCampaignDraft", "guest_data_crm_loyalty", "crm.manage_campaigns", "medium", true),
  advancedTool("recommendGuestUpsells", "guest_data_crm_loyalty", "crm.read", "low"),
  advancedTool("calculateGuestLifetimeValue", "guest_data_crm_loyalty", "crm.read", "low"),
  advancedTool("createGroupProposalDraft", "groups_events_sales", "groups.manage", "medium", true),
  advancedTool("createRoomBlock", "groups_events_sales", "groups.block_inventory", "high", true),
  advancedTool("analyzeGroupPickup", "groups_events_sales", "groups.read", "low"),
  advancedTool("generateBEO", "groups_events_sales", "events.manage", "medium", true),
  advancedTool("recommendEventStaffing", "groups_events_sales", "events.read", "low"),
  advancedTool("forecastLaborNeeds", "workforce_labor", "workforce.read", "low"),
  advancedTool("createScheduleDraft", "workforce_labor", "workforce.schedule.manage", "high", true),
  advancedTool("detectOvertimeRisk", "workforce_labor", "workforce.labor_cost.view", "medium"),
  advancedTool("reassignTasksForAbsence", "workforce_labor", "workforce.schedule.manage", "high", true),
  advancedTool("recommendReorder", "procurement_inventory", "inventory.read", "low"),
  advancedTool("createPurchaseOrderDraft", "procurement_inventory", "purchase_orders.create", "medium", true),
  advancedTool("matchSupplierBillToPurchaseOrder", "procurement_inventory", "procurement.manage", "medium"),
  advancedTool("detectPriceVariance", "procurement_inventory", "procurement.read", "low"),
  advancedTool("prepareMobileCheckout", "guest_self_service", "guest_self_service.manage", "high", true),
  advancedTool("answerGuestPortalQuestion", "guest_self_service", "guest_self_service.read", "low"),
  advancedTool("issueDigitalKeyRequest", "guest_self_service", "digital_key.configure", "critical", true),
  advancedTool("analyzeReviewSentiment", "reputation_quality", "reputation.read", "low"),
  advancedTool("draftReviewResponse", "reputation_quality", "reputation.respond", "medium", true),
  advancedTool("detectQualityTrends", "reputation_quality", "quality_cases.read", "low"),
  advancedTool("createRecoveryCase", "reputation_quality", "quality_cases.manage", "medium", true),
  advancedTool("detectEnergyAnomalies", "energy_sustainability", "energy.read", "low"),
  advancedTool("explainUtilityVariance", "energy_sustainability", "energy.read", "low"),
  advancedTool("recommendSustainabilityActions", "energy_sustainability", "sustainability.report", "medium"),
  advancedTool("calculateEnergyCapexROI", "energy_sustainability", "sustainability.read", "medium"),
  advancedTool("classifyIncidentSeverity", "safety_incident_management", "incidents.read", "medium"),
  advancedTool("createIncidentReportDraft", "safety_incident_management", "incidents.manage", "medium", true),
  advancedTool("recommendIncidentEscalation", "safety_incident_management", "incidents.manage", "high", true),
  advancedTool("generateSafetyChecklist", "safety_incident_management", "safety_checks.manage", "medium", true),
  advancedTool("answerAnalyticsQuestion", "hotel_intelligence_platform", "analytics.ai_ask", "low"),
  advancedTool("explainMetricVariance", "hotel_intelligence_platform", "analytics.read", "low"),
  advancedTool("detectBusinessAnomalies", "hotel_intelligence_platform", "analytics.read", "medium"),
  advancedTool("generateOwnerReport", "hotel_intelligence_platform", "analytics.export", "medium", true),
  advancedTool("compareProperties", "hotel_intelligence_platform", "analytics.read", "low"),
  advancedTool("explainApiError", "developer_platform", "developer.view_api_logs", "low"),
  advancedTool("suggestWebhookRetry", "developer_platform", "developer.manage_webhooks", "medium", true),
  advancedTool("summarizeApiUsage", "developer_platform", "developer.view_api_logs", "low"),
  advancedTool("runAiSafetyEvaluation", "ai_governance", "ai_evals.manage", "high", true),
  advancedTool("detectAiPolicyViolation", "ai_governance", "ai_governance.read", "medium"),
  advancedTool("createAiIncident", "ai_governance", "ai_incidents.manage", "high", true),
  advancedTool("summarizeAiToolRisk", "ai_governance", "ai_governance.read", "low"),
  advancedTool("classifyOnboardingFile", "ai_onboarding_migration", "onboarding.ai_extract", "medium"),
  advancedTool("extractRoomListFromDocument", "ai_onboarding_migration", "onboarding.ai_extract", "medium", true),
  advancedTool("extractFloorPlanStructure", "ai_onboarding_migration", "onboarding.ai_extract", "medium", true),
  advancedTool("extractRatePlansFromSheet", "ai_onboarding_migration", "onboarding.ai_extract", "medium", true),
  advancedTool("extractReservationsFromExport", "ai_onboarding_migration", "onboarding.ai_extract", "high", true),
  advancedTool("extractGuestsFromExport", "ai_onboarding_migration", "onboarding.ai_extract", "high", true),
  advancedTool("extractChannelMappingsFromExport", "ai_onboarding_migration", "onboarding.ai_extract", "medium", true),
  advancedTool("extractRevenueHistoryFromReport", "ai_onboarding_migration", "onboarding.ai_extract", "medium", true),
  advancedTool("generatePropertyBlueprint", "ai_onboarding_migration", "onboarding.ai_map", "high", true),
  advancedTool("suggestRoomTypeMapping", "ai_onboarding_migration", "onboarding.ai_map", "medium", true),
  advancedTool("suggestRoomMapping", "ai_onboarding_migration", "onboarding.ai_map", "medium", true),
  advancedTool("suggestRatePlanMapping", "ai_onboarding_migration", "onboarding.ai_map", "high", true),
  advancedTool("suggestChannelMapping", "ai_onboarding_migration", "onboarding.ai_map", "high", true),
  advancedTool("suggestReservationImportMapping", "ai_onboarding_migration", "onboarding.ai_map", "high", true),
  advancedTool("suggestGuestDeduplication", "ai_onboarding_migration", "onboarding.ai_map", "high", true),
  advancedTool("detectMigrationConflicts", "ai_onboarding_migration", "onboarding.review", "high", true),
  advancedTool("generateGoLiveChecklist", "ai_onboarding_migration", "onboarding.go_live", "medium", true),
  advancedTool("explainOnboardingIssue", "ai_onboarding_migration", "onboarding.read", "low")
];

export function getToolDefinition(name: HotelOsToolName): ToolDefinition {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Tool ${name} is not registered yet.`);
  }

  return definition;
}

export function canExecuteToolForModules(input: {
  toolName: HotelOsToolName;
  enabledModules: HotelModuleCode[];
  userPermissions: PermissionKey[];
}): { allowed: true } | { allowed: false; reason: string } {
  const definition = getToolDefinition(input.toolName);
  if (!input.enabledModules.includes(definition.moduleCode)) {
    return { allowed: false, reason: `Module ${definition.moduleCode} is disabled.` };
  }

  const missingPermission = definition.requiredPermissions.find((permission) => !input.userPermissions.includes(permission));
  if (missingPermission) {
    return { allowed: false, reason: `Missing permission ${missingPermission}.` };
  }

  return { allowed: true };
}
