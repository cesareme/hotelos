export const PMS_TOOL_NAMES = [
  "findReservation",
  "matchGuestToReservation",
  "validateRoomAssignment",
  "assignRoom",
  "checkInReservation",
  "checkOutReservation",
  "moveRoom",
  "cancelReservation",
  "createReservation",
  "quoteAvailability"
] as const;

export const GUEST_REGISTER_TOOL_NAMES = [
  "extractGuestIdentityFields",
  "prepareGuestRegisterRecord",
  "requestGuestSignature",
  "queueSesHospedajesSubmission",
  "checkGuestRegisterCompleteness",
  "extractGuestIdentityFieldsTemporary",
  "validateSpainGuestRegister",
  "requestGuestRegisterSignature",
  "queueGuestAuthoritySubmission",
  "generateSesBatchFile",
  "summarizeGuestRegisterComplianceIssues",
  "explainSubmissionRejection"
] as const;

export const FOLIO_PAYMENT_INVOICE_TOOL_NAMES = [
  "getFolioBalance",
  "postFolioCharge",
  "createPaymentLink",
  "recordPayment",
  "issueInvoice",
  "createRectifyingInvoice"
] as const;

export const OPERATIONS_TOOL_NAMES = [
  "getHousekeepingBoard",
  "createHousekeepingTask",
  "assignHousekeepingTask",
  "markRoomClean",
  "markRoomInspected",
  "createLostAndFoundRecord",
  "createWorkOrder",
  "attachWorkOrderPhoto",
  "blockRoomForMaintenance",
  "resolveWorkOrder",
  "suggestPreventiveMaintenance"
] as const;

export const ACCOUNTING_ASSET_CONCIERGE_TOOL_NAMES = [
  "extractSupplierBill",
  "suggestAccountingCoding",
  "createSupplierBillDraft",
  "matchBankTransaction",
  "createJournalEntryDraft",
  "explainFinancialVariance",
  "createCapexProject",
  "createCapexItem",
  "linkAssetToRoom",
  "scoreRoomCondition",
  "estimateRenovationImpact",
  "answerGuestQuestion",
  "sendGuestMessage",
  "createServiceRequest",
  "suggestUpsell",
  "handoffToHuman"
] as const;

export const ADVANCED_REVENUE_TOOL_NAMES = [
  "analyzePickup",
  "analyzePace",
  "generateRevenueForecast",
  "recommendRateChanges",
  "recommendRestrictions",
  "analyzeChannelProfitability",
  "detectUnderpricedDates",
  "detectOverpricedDates",
  "simulateRevenueScenario",
  "evaluateGroupDisplacement",
  "analyzeRateParity",
  "recommendChannelCloseout",
  "summarizeRevenueRisks",
  "explainRevenueVariance",
  "explainHistoryForecast",
  "compareRevenuePeriods",
  "explainForecastConfidence",
  "createOwnerRevenueReport",
  "detectHistoryForecastRisks",
  "applyRevenueRecommendation",
  "syncChannelRates",
  "syncChannelAvailability"
] as const;

export const ADVANCED_CRM_TOOL_NAMES = [
  "detectDuplicateGuests",
  "summarizeGuestProfile",
  "recommendGuestSegment",
  "createCampaignDraft",
  "recommendGuestUpsells",
  "calculateGuestLifetimeValue"
] as const;

export const ADVANCED_GROUPS_WORKFORCE_TOOL_NAMES = [
  "createGroupProposalDraft",
  "createRoomBlock",
  "analyzeGroupPickup",
  "generateBEO",
  "recommendEventStaffing",
  "forecastLaborNeeds",
  "createScheduleDraft",
  "detectOvertimeRisk",
  "reassignTasksForAbsence"
] as const;

export const ADVANCED_PLATFORM_TOOL_NAMES = [
  "recommendReorder",
  "createPurchaseOrderDraft",
  "matchSupplierBillToPurchaseOrder",
  "detectPriceVariance",
  "prepareMobileCheckout",
  "answerGuestPortalQuestion",
  "issueDigitalKeyRequest",
  "analyzeReviewSentiment",
  "draftReviewResponse",
  "detectQualityTrends",
  "createRecoveryCase",
  "detectEnergyAnomalies",
  "explainUtilityVariance",
  "recommendSustainabilityActions",
  "calculateEnergyCapexROI",
  "classifyIncidentSeverity",
  "createIncidentReportDraft",
  "recommendIncidentEscalation",
  "generateSafetyChecklist",
  "answerAnalyticsQuestion",
  "explainMetricVariance",
  "detectBusinessAnomalies",
  "generateOwnerReport",
  "compareProperties",
  "explainApiError",
  "suggestWebhookRetry",
  "summarizeApiUsage",
  "runAiSafetyEvaluation",
  "detectAiPolicyViolation",
  "createAiIncident",
  "summarizeAiToolRisk"
] as const;

export const ONBOARDING_MIGRATION_TOOL_NAMES = [
  "classifyOnboardingFile",
  "extractRoomListFromDocument",
  "extractFloorPlanStructure",
  "extractRatePlansFromSheet",
  "extractReservationsFromExport",
  "extractGuestsFromExport",
  "extractChannelMappingsFromExport",
  "extractRevenueHistoryFromReport",
  "generatePropertyBlueprint",
  "suggestRoomTypeMapping",
  "suggestRoomMapping",
  "suggestRatePlanMapping",
  "suggestChannelMapping",
  "suggestReservationImportMapping",
  "suggestGuestDeduplication",
  "detectMigrationConflicts",
  "generateGoLiveChecklist",
  "explainOnboardingIssue"
] as const;

export const ALL_TOOL_NAMES = [
  ...PMS_TOOL_NAMES,
  ...GUEST_REGISTER_TOOL_NAMES,
  ...FOLIO_PAYMENT_INVOICE_TOOL_NAMES,
  ...OPERATIONS_TOOL_NAMES,
  ...ACCOUNTING_ASSET_CONCIERGE_TOOL_NAMES,
  ...ADVANCED_REVENUE_TOOL_NAMES,
  ...ADVANCED_CRM_TOOL_NAMES,
  ...ADVANCED_GROUPS_WORKFORCE_TOOL_NAMES,
  ...ADVANCED_PLATFORM_TOOL_NAMES,
  ...ONBOARDING_MIGRATION_TOOL_NAMES
] as const;

export type HotelOsToolName = (typeof ALL_TOOL_NAMES)[number];
