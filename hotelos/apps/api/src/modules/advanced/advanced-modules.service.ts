import { getHotelModuleManifest, type HotelModuleCode } from "@hotelos/product";
import { canExecuteToolForModules, type HotelOsToolName } from "@hotelos/ai-tools";
import type { PermissionKey } from "@hotelos/shared";
import {
  aggregateHistoryForecast,
  type HistoryForecastFilters,
  type HistoryForecastGranularity,
  type HistoryForecastSnapshot
} from "@hotelos/revenue";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore, type UserContext } from "../../lib/demo-store.js";

export const ADVANCED_MODULE_HEALTH_CHECKS: Record<HotelModuleCode, string[]> = {
  pms_core: [],
  ai_front_desk: [],
  distribution_hub: [],
  ai_booking_engine: [],
  checkin_online: [],
  housekeeping: [],
  maintenance: [],
  erp_accounting: [],
  compliance_hub: [],
  compliance_billing: [],
  payment_vault: [],
  guest_experience: [],
  ai_concierge: [],
  asset_intelligence: [],
  capex_manager: [],
  outlet_pos: [],
  owner_mode: [],
  integration_marketplace: [],
  module_marketplace: [],
  revenue_profit_engine: [
    "pms_inventory_ready",
    "rate_plans_configured",
    "rates_configured",
    "inventory_days_generated",
    "restriction_rules_ready",
    "distribution_enabled",
    "channel_mappings_valid",
    "channel_sync_health_ok",
    "competitor_set_configured",
    "historical_booking_data_available",
    "accounting_cost_data_available",
    "forecast_data_quality_ready",
    "automation_rules_safe"
  ],
  guest_data_crm_loyalty: [
    "guest_profiles_available",
    "marketing_consent_configured",
    "email_provider_connected",
    "campaign_templates_configured",
    "loyalty_rules_configured"
  ],
  groups_events_sales: [
    "room_types_configured",
    "event_spaces_configured",
    "billing_rules_configured",
    "deposit_rules_configured",
    "group_inventory_rules_configured"
  ],
  workforce_labor: [
    "departments_configured",
    "staff_profiles_created",
    "shift_rules_configured",
    "time_clock_policy_configured",
    "labor_costs_configured"
  ],
  procurement_inventory: [
    "suppliers_created",
    "stock_locations_created",
    "inventory_items_created",
    "approval_rules_configured",
    "accounting_mapping_configured"
  ],
  guest_self_service: [
    "guest_portal_enabled",
    "payment_provider_connected",
    "checkin_rules_configured",
    "guest_templates_configured",
    "digital_key_optional_configured"
  ],
  reputation_quality: [
    "review_sources_connected",
    "survey_templates_created",
    "quality_workflows_configured",
    "guest_message_provider_connected"
  ],
  energy_sustainability: [
    "utility_meters_created",
    "occupancy_metrics_available",
    "sustainability_targets_configured",
    "capex_link_available"
  ],
  safety_incident_management: [
    "emergency_contacts_configured",
    "safety_checks_created",
    "incident_workflow_configured",
    "evidence_storage_configured"
  ],
  hotel_intelligence_platform: [
    "metric_definitions_created",
    "snapshot_worker_running",
    "data_quality_checks_enabled",
    "owner_reports_configured"
  ],
  developer_platform: [
    "api_scopes_configured",
    "webhook_worker_running",
    "sandbox_property_available",
    "developer_docs_available"
  ],
  ai_governance: [
    "ai_tool_registry_synced",
    "ai_policies_configured",
    "ai_evals_available",
    "guest_disclosure_configured",
    "human_review_queue_enabled"
  ],
  spain_guest_register_compliance: [
    "lodging_legal_profile_configured",
    "authority_reporting_configured",
    "ses_batch_export_enabled",
    "official_schema_or_manual_export_ready",
    "identity_image_storage_disabled",
    "guest_register_retention_configured",
    "authority_routing_rules_configured",
    "compliance_inbox_ready"
  ],
  ai_onboarding_migration: [
    "source_pms_connectors_available",
    "upload_storage_configured",
    "document_extraction_provider_configured",
    "ai_schema_mapping_enabled",
    "human_review_queue_ready",
    "migration_dry_run_required",
    "go_live_readiness_checks_enabled",
    "raw_file_retention_policy_configured"
  ]
};

export const ADVANCED_AUDIT_EVENTS = [
  "RevenueForecastGenerated",
  "RevenueRecommendationCreated",
  "RevenueRecommendationApproved",
  "RevenueRecommendationApplied",
  "RevenueRecommendationRejected",
  "RevenueRecommendationExpired",
  "RateDayUpdated",
  "RestrictionDayUpdated",
  "InventoryDayUpdated",
  "RateGridBulkUpdated",
  "ChannelConnected",
  "ChannelDisconnected",
  "ChannelMappingCreated",
  "ChannelMappingUpdated",
  "ChannelSyncStarted",
  "ChannelSyncSucceeded",
  "ChannelSyncFailed",
  "ExternalReservationImported",
  "ExternalReservationModified",
  "ExternalReservationCancelled",
  "RateParityAlertCreated",
  "CompetitorRateSnapshotCreated",
  "DemandCalendarEventCreated",
  "RevenueScenarioSimulated",
  "RevenueAutomationRuleCreated",
  "RevenueAutomationRuleUpdated",
  "RevenueAutomationRuleTriggered",
  "RevenueAutomationBlocked",
  "RevenueHistoryForecastExported",
  "RevenueReportViewCreated",
  "RevenueHistoryForecastAlertCreated",
  "GuestProfileMerged",
  "GuestSegmentCreated",
  "CampaignCreated",
  "CampaignSent",
  "LoyaltyMembershipCreated",
  "GroupBookingCreated",
  "GroupRoomBlockCreated",
  "GroupRoomBlockReleased",
  "EventCreated",
  "BEOCreated",
  "GroupProposalCreated",
  "ShiftCreated",
  "ShiftUpdated",
  "StaffClockedIn",
  "StaffClockedOut",
  "AbsenceRequested",
  "AbsenceApproved",
  "LaborForecastGenerated",
  "SupplierCreated",
  "PurchaseOrderCreated",
  "PurchaseOrderApproved",
  "PurchaseOrderReceived",
  "StockMovementCreated",
  "StockCountCompleted",
  "GuestPortalSessionCreated",
  "GuestOnlineCheckInCompleted",
  "GuestMobileCheckoutCompleted",
  "GuestUpsellPurchased",
  "DigitalKeyRequested",
  "ReviewReceived",
  "ReviewResponseDrafted",
  "ReviewResponseSent",
  "QualityCaseCreated",
  "QualityCaseResolved",
  "SurveyCreated",
  "SurveyResponseReceived",
  "UtilityMeterCreated",
  "UtilityReadingCreated",
  "EnergyAnomalyDetected",
  "SustainabilityActionCreated",
  "SafetyIncidentCreated",
  "SafetyIncidentUpdated",
  "IncidentEvidenceAdded",
  "SafetyCheckCreated",
  "SafetyCheckCompleted",
  "AnalyticsSnapshotGenerated",
  "AnomalyDetected",
  "ScheduledReportGenerated",
  "MetricDefinitionCreated",
  "DeveloperAppCreated",
  "DeveloperAppSecretRotated",
  "WebhookSubscriptionCreated",
  "WebhookDeliveryFailed",
  "AIPolicyUpdated",
  "AIToolDisabled",
  "AIToolEnabled",
  "AIPromptVersionCreated",
  "AIEvaluationRun",
  "AIIncidentCreated",
  "AIHumanReviewCreated",
  "AIHumanReviewResolved",
  "GuestRegisterRecordCreated",
  "GuestRegisterRecordValidated",
  "GuestRegisterRecordSigned",
  "GuestRegisterIdentityVerified",
  "TemporaryIdScanStarted",
  "TemporaryIdOcrCompleted",
  "IdImageDiscarded",
  "GuestRegisterQueued",
  "AuthorityBatchGenerated",
  "AuthorityBatchDownloaded",
  "AuthorityBatchSubmitted",
  "AuthoritySubmissionAccepted",
  "AuthoritySubmissionRejected",
  "AuthoritySubmissionFailed",
  "AuthoritySubmissionRetried",
  "AuthorityCommunicationAnnulled",
  "GuestRegisterCorrected",
  "GuestRegisterRetentionExpired",
  "GuestRegisterDataDeleted",
  "SensitiveGuestRegisterViewed",
  "OnboardingProjectCreated",
  "OnboardingSourceConnected",
  "OnboardingSourceConnectionTested",
  "OnboardingFileUploaded",
  "OnboardingFileClassified",
  "OnboardingFileExtracted",
  "OnboardingAIAnalysisStarted",
  "OnboardingAIAnalysisCompleted",
  "OnboardingBlueprintGenerated",
  "OnboardingMappingSuggested",
  "OnboardingMappingApproved",
  "OnboardingMappingRejected",
  "OnboardingMappingEdited",
  "OnboardingDryRunStarted",
  "OnboardingDryRunCompleted",
  "OnboardingMigrationBatchApplied",
  "OnboardingMigrationBatchFailed",
  "OnboardingMigrationBatchRolledBack",
  "OnboardingGoLiveReadinessGenerated",
  "OnboardingGoLiveApproved",
  "OnboardingRawFileDeleted",
  "SensitiveOnboardingDataViewed"
] as const;

type AdvancedMutationInput = {
  context: UserContext;
  propertyId: string;
  moduleCode: HotelModuleCode;
  entityType: string;
  auditAction: (typeof ADVANCED_AUDIT_EVENTS)[number];
  payload?: Record<string, unknown>;
  requiredPermissions: PermissionKey[];
  correlationId: string;
};

function requireAdvancedModuleEnabled(propertyId: string, moduleCode: HotelModuleCode) {
  if (!getEnabledModuleCodes(propertyId).includes(moduleCode)) {
    throw new Error(`Module ${moduleCode} is disabled.`);
  }
}

function audit(input: AdvancedMutationInput, entityId: string, afterJson: unknown) {
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.auditAction,
    entityType: input.entityType,
    entityId,
    afterJson,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: input.entityType,
    entityId,
    eventType: input.auditAction,
    payload: input.payload ?? {},
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

function phaseRecordResponse(input: {
  propertyId: string;
  moduleCode: HotelModuleCode;
  recordType: string;
  items: unknown[];
  nextAction: string;
}) {
  return input;
}

function requirePropertyAccess(propertyId: string) {
  if (!demoStore.properties.some((property) => property.id === propertyId)) {
    throw new Error("Property was not found.");
  }
}

const DEFAULT_HISTORY_FORECAST_BUSINESS_DATE = "2026-05-15";

type HistoryForecastQuery = Record<string, unknown>;

function stringQuery(query: HistoryForecastQuery, key: string, fallback: string) {
  const value = query[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function boolQuery(query: HistoryForecastQuery, key: string, fallback = false) {
  const value = query[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return fallback;
}

function parseHistoryForecastFilters(query: HistoryForecastQuery): HistoryForecastFilters {
  const deduct = query.deduct === "true" ? true : query.deduct === "false" ? false : "all";
  const individualGroup =
    query.individualGroup === "individual" || query.individualGroup === "group" ? query.individualGroup : "all";
  const revenueMode = query.revenueMode === "net" ? "net" : "gross";
  const comparisonPeriod =
    query.comparisonPeriod === "previous_period" ||
    query.comparisonPeriod === "same_period_last_year" ||
    query.comparisonPeriod === "custom_period"
      ? query.comparisonPeriod
      : "none";
  return {
    roomClassId: typeof query.roomClassId === "string" ? query.roomClassId : undefined,
    roomTypeId: typeof query.roomTypeId === "string" ? query.roomTypeId : undefined,
    ratePlanId: typeof query.ratePlanId === "string" ? query.ratePlanId : undefined,
    channelId: typeof query.channelId === "string" ? query.channelId : undefined,
    segment: typeof query.segment === "string" ? query.segment : undefined,
    market: typeof query.market === "string" ? query.market : undefined,
    includeHouseUseInOcc: boolQuery(query, "includeHouseUseInOcc", true),
    includeDayUseInOcc: boolQuery(query, "includeDayUseInOcc", false),
    includeNoShowInOcc: boolQuery(query, "includeNoShowInOcc", false),
    excludeOOOFromOcc: boolQuery(query, "excludeOOOFromOcc", true),
    deduct,
    individualGroup,
    revenueMode,
    distributedRevenue: boolQuery(query, "distributedRevenue", true),
    comparisonPeriod,
    customComparisonFromDate: typeof query.customComparisonFromDate === "string" ? query.customComparisonFromDate : undefined,
    customComparisonToDate: typeof query.customComparisonToDate === "string" ? query.customComparisonToDate : undefined
  };
}

function toHistorySnapshot(record: (typeof demoStore.revenueDailySnapshots)[number]): HistoryForecastSnapshot {
  return {
    date: record.snapshotDate,
    totalOcc: record.totalOcc,
    availableRooms: record.availableRooms,
    arrivalRooms: record.arrivalRooms,
    departureRooms: record.departureRooms,
    compRooms: record.compRooms,
    houseUseRooms: record.houseUseRooms,
    dayUseRooms: record.dayUseRooms,
    noShowRooms: record.noShowRooms,
    oooRooms: record.oooRooms,
    deductIndividualRooms: record.deductIndividualRooms,
    nonDeductIndividualRooms: record.nonDeductIndividualRooms,
    deductGroupRooms: record.deductGroupRooms,
    nonDeductGroupRooms: record.nonDeductGroupRooms,
    adultsChildren: record.adultsChildren,
    roomRevenue: record.roomRevenue,
    totalRevenue: record.totalRevenue,
    netRoomRevenue: record.netRoomRevenue,
    grossOperatingProfit: record.grossOperatingProfit,
    confidence: 1,
    drivers: ["Audited historical snapshot"],
    dataQualityScore: 1
  };
}

function toForecastSnapshot(record: (typeof demoStore.revenueForecastSnapshots)[number]): HistoryForecastSnapshot {
  return {
    date: record.forecastDate,
    totalOcc: record.expectedTotalOcc,
    availableRooms: record.availableRooms,
    arrivalRooms: record.expectedArrivalRooms,
    departureRooms: record.expectedDepartureRooms,
    compRooms: record.expectedCompRooms,
    houseUseRooms: record.expectedHouseUseRooms,
    dayUseRooms: record.expectedDayUseRooms,
    noShowRooms: record.expectedNoShowRooms,
    oooRooms: record.expectedOooRooms,
    deductIndividualRooms: record.expectedDeductIndividualRooms,
    nonDeductIndividualRooms: record.expectedNonDeductIndividualRooms,
    deductGroupRooms: record.expectedDeductGroupRooms,
    nonDeductGroupRooms: record.expectedNonDeductGroupRooms,
    adultsChildren: record.expectedAdultsChildren,
    roomRevenue: record.expectedRoomRevenue,
    totalRevenue: record.expectedTotalRevenue,
    netRoomRevenue: record.expectedNetRoomRevenue,
    grossOperatingProfit: record.expectedGrossOperatingProfit,
    confidence: record.confidence,
    confidenceLow: record.confidenceLowJson,
    confidenceHigh: record.confidenceHighJson,
    drivers: record.driversJson,
    dataQualityScore: record.dataQualityScore
  };
}

export function getHistoryForecastReport(propertyId: string, query: HistoryForecastQuery = {}) {
  requirePropertyAccess(propertyId);
  requireAdvancedModuleEnabled(propertyId, "revenue_profit_engine");
  const fromDate = stringQuery(query, "fromDate", "2026-05-01");
  const toDate = stringQuery(query, "toDate", "2026-05-31");
  const requestedGranularity = stringQuery(query, "granularity", "auto") as HistoryForecastGranularity;
  const businessDate = stringQuery(query, "businessDate", DEFAULT_HISTORY_FORECAST_BUSINESS_DATE);
  const filters = parseHistoryForecastFilters(query);
  const propertyName = demoStore.properties.find((property) => property.id === propertyId)?.name ?? "HotelOS property";
  const aggregation = aggregateHistoryForecast({
    propertyId,
    fromDate,
    toDate,
    granularity: requestedGranularity,
    filters,
    businessDate,
    historySnapshots: demoStore.revenueDailySnapshots.filter((snapshot) => snapshot.propertyId === propertyId).map(toHistorySnapshot),
    forecastSnapshots: demoStore.revenueForecastSnapshots.filter((snapshot) => snapshot.propertyId === propertyId).map(toForecastSnapshot)
  });
  const table = [
    { rowType: "section", label: "History", section: "history" },
    ...aggregation.historyRows.map((row) => ({ rowType: "data", ...row })),
    { rowType: "subtotal", section: "history", ...aggregation.historySubtotal, label: "History subtotal" },
    { rowType: "section", label: "Forecast", section: "forecast" },
    ...aggregation.forecastRows.map((row) => ({ rowType: "data", ...row })),
    { rowType: "subtotal", section: "forecast", ...aggregation.forecastSubtotal, label: "Forecast subtotal" },
    { rowType: "total", ...aggregation.total, label: "Total" }
  ];
  return {
    propertyId,
    propertyName,
    businessDate,
    fromDate,
    toDate,
    granularity: aggregation.historyRows[0]?.granularity ?? aggregation.forecastRows[0]?.granularity ?? "daily",
    filters,
    sections: {
      history: { rows: aggregation.historyRows, subtotal: aggregation.historySubtotal },
      forecast: { rows: aggregation.forecastRows, subtotal: aggregation.forecastSubtotal },
      total: aggregation.total
    },
    kpis: aggregation.kpis,
    charts: {
      historyForecast: aggregation.chartSeries,
      occupancyAdr: aggregation.chartSeries.filter((series) => series.key === "occupancy" || series.key === "adr"),
      revenue: aggregation.chartSeries.filter((series) => series.key === "total_revenue"),
      revparProfit: aggregation.chartSeries.filter((series) => series.key === "revpar"),
      confidence: aggregation.chartSeries.find((series) => series.key === "occupancy")?.values.map((value) => ({
        date: value.date,
        section: value.section,
        confidenceLow: value.confidenceLow,
        confidenceHigh: value.confidenceHigh
      }))
    },
    table,
    alerts: aggregation.alerts,
    savedViews: demoStore.revenueReportViews.filter((view) => view.propertyId === propertyId),
    generatedAt: nowIso()
  };
}

export function getHistoryForecastCharts(propertyId: string, query: HistoryForecastQuery = {}) {
  return getHistoryForecastReport(propertyId, query).charts;
}

export function getHistoryForecastKpis(propertyId: string, query: HistoryForecastQuery = {}) {
  return getHistoryForecastReport(propertyId, query).kpis;
}

export function exportHistoryForecastReport(input: {
  context: UserContext;
  propertyId: string;
  payload: HistoryForecastQuery;
  correlationId: string;
}) {
  requirePermissions(input.context, ["revenue.history_forecast.export"]);
  const format = stringQuery(input.payload, "format", "pdf");
  const report = getHistoryForecastReport(input.propertyId, input.payload);
  // Real downloadable artifact: HTML for "pdf" (print-to-PDF in any browser),
  // CSV for "csv"/"xlsx", JSON otherwise. Frontend wraps in a Blob.
  const stamp = new Date().toISOString().slice(0, 10);
  const ext = format === "pdf" ? "html" : format === "xlsx" ? "csv" : format;
  const filename = `history-forecast-${input.propertyId}-${stamp}.${ext}`;
  const reportRows = (report as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  const content = format === "json"
    ? JSON.stringify(report, null, 2)
    : format === "csv" || format === "xlsx"
      ? hfToCsv(reportRows)
      : `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>History &amp; Forecast</title></head><body style="font-family:system-ui,Arial,sans-serif;padding:24px"><h1>History &amp; Forecast — ${input.propertyId}</h1><p>Generado ${new Date().toLocaleDateString("es-ES")}</p><pre style="white-space:pre-wrap;font-size:12px">${JSON.stringify(report.kpis, null, 2)}</pre></body></html>`;
  const exportRecord = {
    id: createId("rhf_export"),
    propertyId: input.propertyId,
    reportName: "History and Forecast",
    format,
    filename,
    contentType: format === "json" ? "application/json;charset=utf-8" : format === "csv" || format === "xlsx" ? "text/csv;charset=utf-8" : "text/html;charset=utf-8",
    includeCharts: boolQuery(input.payload, "includeCharts", true),
    includeTable: boolQuery(input.payload, "includeTable", true),
    includeFilters: boolQuery(input.payload, "includeFilters", true),
    sections: ["KPI cards", "Main History vs Forecast chart", "Revenue chart", "Occupancy + ADR chart", "Full detailed table"],
    generatedAt: nowIso()
  };
  audit(
    {
      context: input.context,
      propertyId: input.propertyId,
      moduleCode: "revenue_profit_engine",
      entityType: "revenue_history_forecast_export",
      auditAction: "RevenueHistoryForecastExported",
      payload: input.payload,
      requiredPermissions: ["revenue.history_forecast.export"],
      correlationId: input.correlationId
    },
    exportRecord.id,
    { exportRecord, reportSummary: report.kpis }
  );
  return { export: exportRecord, report, content };
}

function hfToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "businessDate;type\n";
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(";"), ...rows.map((r) => keys.map((k) => esc(r[k])).join(";"))].join("\n");
}

function getModuleMetricStatus(propertyId: string, moduleCode: HotelModuleCode, checkCode: string) {
  if (moduleCode === "revenue_profit_engine") {
    const statuses: Record<string, boolean> = {
      pms_inventory_ready: demoStore.rooms.some((room) => room.propertyId === propertyId && room.sellable),
      rate_plans_configured: demoStore.ratePlans.some((ratePlan) => ratePlan.propertyId === propertyId && ratePlan.active),
      rates_configured: demoStore.rateDays.some((rateDay) => rateDay.propertyId === propertyId),
      inventory_days_generated: demoStore.inventoryDays.some((inventoryDay) => inventoryDay.propertyId === propertyId),
      restriction_rules_ready: demoStore.restrictionDays.some((restrictionDay) => restrictionDay.propertyId === propertyId),
      distribution_enabled: getEnabledModuleCodes(propertyId).includes("distribution_hub"),
      channel_mappings_valid:
        demoStore.channelRoomMappings.some((mapping) => mapping.status === "active") &&
        demoStore.channelRateMappings.some((mapping) => mapping.status === "active"),
      channel_sync_health_ok: !demoStore.channelSyncJobs.some((job) => job.propertyId === propertyId && job.status === "failed"),
      competitor_set_configured: demoStore.competitorHotels.some((competitor) => competitor.propertyId === propertyId && competitor.active),
      historical_booking_data_available: demoStore.reservations.some((reservation) => reservation.propertyId === propertyId),
      accounting_cost_data_available: demoStore.channelProfitabilitySnapshots.some((snapshot) => snapshot.propertyId === propertyId),
      forecast_data_quality_ready: demoStore.revenueForecasts.some((forecast) => forecast.propertyId === propertyId && forecast.confidence >= 0.75),
      automation_rules_safe: demoStore.revenueAutomationRules.some((rule) => rule.propertyId === propertyId && rule.active)
    };
    return statuses[checkCode] ? "ok" : "needs_configuration";
  }

  if (moduleCode === "guest_data_crm_loyalty") {
    const statuses: Record<string, boolean> = {
      guest_profiles_available: demoStore.guestProfiles.some((profile) => profile.organizationId === demoStore.userContext.organizationId),
      marketing_consent_configured: demoStore.guestProfiles.some((profile) => Boolean(profile.consentJson.marketingEmail)),
      email_provider_connected: demoStore.integrationProviders.some((provider) => provider.categoryId === "icat_guest_messaging"),
      campaign_templates_configured: demoStore.crmCampaigns.some((campaign) => campaign.organizationId === demoStore.userContext.organizationId),
      loyalty_rules_configured: demoStore.loyaltyPrograms.some((program) => program.organizationId === demoStore.userContext.organizationId)
    };
    return statuses[checkCode] ? "ok" : "needs_configuration";
  }

  if (moduleCode === "groups_events_sales") {
    const statuses: Record<string, boolean> = {
      room_types_configured: demoStore.roomTypes.some((roomType) => roomType.propertyId === propertyId),
      event_spaces_configured: demoStore.eventSpaces.some((space) => space.propertyId === propertyId),
      billing_rules_configured: demoStore.groupBookings.some((group) => group.propertyId === propertyId && Object.keys(group.billingRulesJson).length > 0),
      deposit_rules_configured: getEnabledModuleCodes(propertyId).includes("payment_vault"),
      group_inventory_rules_configured: demoStore.groupRoomBlocks.some((block) =>
        demoStore.groupBookings.some((group) => group.id === block.groupBookingId && group.propertyId === propertyId)
      )
    };
    return statuses[checkCode] ? "ok" : "needs_configuration";
  }

  if (moduleCode === "spain_guest_register_compliance") {
    const reporting = demoStore.authorityReportingSettings.find((setting) => setting.propertyId === propertyId);
    const legalProfile = demoStore.lodgingLegalProfiles.find((profile) => profile.propertyId === propertyId);
    const statuses: Record<string, boolean> = {
      lodging_legal_profile_configured: Boolean(legalProfile?.legalName && legalProfile.taxId && legalProfile.fullAddress),
      authority_reporting_configured: Boolean(reporting?.enabled && reporting.authorityType),
      ses_batch_export_enabled: reporting?.batchExportEnabled === true,
      official_schema_or_manual_export_ready: reporting?.batchExportEnabled === true || reporting?.configurationJson.officialSchemaConfigured === true,
      identity_image_storage_disabled: reporting?.configurationJson.storeIdImageDefault === false,
      guest_register_retention_configured: reporting?.configurationJson.retentionYears === 3,
      authority_routing_rules_configured: demoStore.authorityRoutingRules.some((rule) => rule.country === "ES" && rule.active),
      compliance_inbox_ready: demoStore.guestRegisterRecords.some((record) => record.propertyId === propertyId)
    };
    return statuses[checkCode] ? "ok" : "needs_configuration";
  }

  return "needs_configuration";
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
}

function findRateDay(input: { propertyId: string; roomTypeId?: unknown; ratePlanId?: unknown; date?: unknown }) {
  return demoStore.rateDays.find(
    (rateDay) =>
      rateDay.propertyId === input.propertyId &&
      rateDay.roomTypeId === String(input.roomTypeId ?? "rt_double") &&
      rateDay.ratePlanId === String(input.ratePlanId ?? "rp_flexible") &&
      rateDay.date === String(input.date)
  );
}

function findRestrictionDay(input: { propertyId: string; roomTypeId?: unknown; ratePlanId?: unknown; channelId?: unknown; date?: unknown }) {
  return demoStore.restrictionDays.find(
    (restrictionDay) =>
      restrictionDay.propertyId === input.propertyId &&
      restrictionDay.roomTypeId === String(input.roomTypeId ?? "rt_double") &&
      restrictionDay.ratePlanId === String(input.ratePlanId ?? "rp_flexible") &&
      restrictionDay.channelId === (typeof input.channelId === "string" ? input.channelId : undefined) &&
      restrictionDay.date === String(input.date)
  );
}

function applyRateDayUpdates(input: AdvancedMutationInput, updateRecords: Record<string, unknown>[], updatedAt: string) {
  return updateRecords.map((update) => {
    const existing = findRateDay({
      propertyId: input.propertyId,
      roomTypeId: update.roomTypeId,
      ratePlanId: update.ratePlanId,
      date: update.date
    });
    const nextPrice = Number(update.price ?? update.newPrice ?? update.recommendedPrice);
    if (existing?.manuallyOverridden && input.payload?.overrideManual !== true) {
      return { status: "manualOverrideBlocked", update, reason: "Manual override requires explicit manager confirmation." };
    }
    if (existing && Number.isFinite(nextPrice)) {
      const before = { ...existing };
      const minPrice = existing.minPrice ?? Number.NEGATIVE_INFINITY;
      const maxPrice = existing.maxPrice ?? Number.POSITIVE_INFINITY;
      if (nextPrice < minPrice || nextPrice > maxPrice) {
        return { status: "priceLimitBlocked", update, before, reason: "Price outside min/max revenue guardrails." };
      }
      existing.price = nextPrice;
      existing.currency = String(update.currency ?? existing.currency);
      existing.syncStatus = "pending";
      existing.updatedBy = input.context.userId;
      existing.updatedAt = updatedAt;
      return { status: "updated", before, after: { ...existing } };
    }
    const created = {
      id: createId("rate_day"),
      propertyId: input.propertyId,
      roomTypeId: String(update.roomTypeId ?? "rt_double"),
      ratePlanId: String(update.ratePlanId ?? "rp_flexible"),
      date: String(update.date ?? new Date().toISOString().slice(0, 10)),
      price: Number.isFinite(nextPrice) ? nextPrice : 0,
      currency: String(update.currency ?? "EUR"),
      minPrice: typeof update.minPrice === "number" ? update.minPrice : undefined,
      maxPrice: typeof update.maxPrice === "number" ? update.maxPrice : undefined,
      manuallyOverridden: false,
      syncStatus: "pending" as const,
      updatedBy: input.context.userId,
      updatedAt
    };
    demoStore.rateDays.push(created);
    return { status: "created", after: created };
  });
}

function applyRestrictionDayUpdates(input: AdvancedMutationInput, updateRecords: Record<string, unknown>[], updatedAt: string) {
  return updateRecords.map((update) => {
    const existing = findRestrictionDay({
      propertyId: input.propertyId,
      roomTypeId: update.roomTypeId,
      ratePlanId: update.ratePlanId,
      channelId: update.channelId,
      date: update.date
    });
    if (existing) {
      const before = { ...existing };
      existing.minStay = typeof update.minStay === "number" ? update.minStay : existing.minStay;
      existing.maxStay = typeof update.maxStay === "number" ? update.maxStay : existing.maxStay;
      existing.closedToArrival = typeof update.closedToArrival === "boolean" ? update.closedToArrival : existing.closedToArrival;
      existing.closedToDeparture = typeof update.closedToDeparture === "boolean" ? update.closedToDeparture : existing.closedToDeparture;
      existing.stopSell = typeof update.stopSell === "boolean" ? update.stopSell : existing.stopSell;
      existing.restrictionSource = "manual";
      existing.updatedAt = updatedAt;
      return { status: "updated", before, after: { ...existing } };
    }
    const created = {
      id: createId("restriction_day"),
      propertyId: input.propertyId,
      roomTypeId: String(update.roomTypeId ?? "rt_double"),
      ratePlanId: typeof update.ratePlanId === "string" ? update.ratePlanId : "rp_flexible",
      channelId: typeof update.channelId === "string" ? update.channelId : undefined,
      date: String(update.date ?? new Date().toISOString().slice(0, 10)),
      minStay: typeof update.minStay === "number" ? update.minStay : undefined,
      maxStay: typeof update.maxStay === "number" ? update.maxStay : undefined,
      closedToArrival: Boolean(update.closedToArrival ?? false),
      closedToDeparture: Boolean(update.closedToDeparture ?? false),
      stopSell: Boolean(update.stopSell ?? false),
      restrictionSource: "manual" as const,
      updatedAt
    };
    demoStore.restrictionDays.push(created);
    return { status: "created", after: created };
  });
}

function applyInventoryDayUpdates(input: AdvancedMutationInput, updateRecords: Record<string, unknown>[], updatedAt: string) {
  return updateRecords.map((update) => {
    const existing = demoStore.inventoryDays.find(
      (inventoryDay) =>
        inventoryDay.propertyId === input.propertyId &&
        inventoryDay.roomTypeId === String(update.roomTypeId ?? "rt_double") &&
        inventoryDay.date === String(update.date)
    );
    if (existing) {
      const before = { ...existing };
      existing.availableCount = typeof update.availableCount === "number" ? update.availableCount : existing.availableCount;
      existing.totalInventory = typeof update.totalInventory === "number" ? update.totalInventory : existing.totalInventory;
      existing.outOfOrderCount = typeof update.outOfOrderCount === "number" ? update.outOfOrderCount : existing.outOfOrderCount;
      existing.overbookingLimit = typeof update.overbookingLimit === "number" ? update.overbookingLimit : existing.overbookingLimit;
      existing.stopSell = typeof update.stopSell === "boolean" ? update.stopSell : existing.stopSell;
      existing.updatedAt = updatedAt;
      return { status: "updated", before, after: { ...existing } };
    }
    const created = {
      id: createId("inventory_day"),
      propertyId: input.propertyId,
      roomTypeId: String(update.roomTypeId ?? "rt_double"),
      date: String(update.date ?? new Date().toISOString().slice(0, 10)),
      totalInventory: Number(update.totalInventory ?? 0),
      availableCount: Number(update.availableCount ?? 0),
      outOfOrderCount: Number(update.outOfOrderCount ?? 0),
      overbookingLimit: Number(update.overbookingLimit ?? 0),
      stopSell: Boolean(update.stopSell ?? false),
      updatedAt
    };
    demoStore.inventoryDays.push(created);
    return { status: "created", after: created };
  });
}

function applyRevenueRecommendationToRateGrid(input: AdvancedMutationInput & { entityId: string }, updatedAt: string) {
  const recommendation = demoStore.revenueRecommendations.find(
    (candidate) => candidate.id === input.entityId && candidate.propertyId === input.propertyId
  );
  if (!recommendation) {
    throw new Error("Revenue recommendation was not found.");
  }
  if (recommendation.status !== "approved" && input.payload?.forceApply !== true) {
    return {
      status: "approvalRequired",
      recommendation,
      reason: "Recommendation must be approved before it can be applied."
    };
  }

  if (recommendation.recommendationType === "rate") {
    const changes = applyRateDayUpdates(
      input,
      [
        {
          roomTypeId: recommendation.roomTypeId,
          ratePlanId: recommendation.ratePlanId,
          date: recommendation.targetDate,
          price: recommendation.recommendedValueJson.price,
          currency: recommendation.recommendedValueJson.currency
        }
      ],
      updatedAt
    );
    return { status: "applied", recommendation, changes };
  }

  if (recommendation.recommendationType === "min_stay" || recommendation.recommendationType === "restriction" || recommendation.recommendationType === "stop_sell") {
    const changes = applyRestrictionDayUpdates(
      input,
      [
        {
          roomTypeId: recommendation.roomTypeId,
          ratePlanId: recommendation.ratePlanId,
          channelId: recommendation.channelId,
          date: recommendation.targetDate,
          ...recommendation.recommendedValueJson
        }
      ],
      updatedAt
    );
    return { status: "applied", recommendation, changes };
  }

  return { status: "noApplicableGridChange", recommendation };
}

function evaluateChannelSyncSafety(input: AdvancedMutationInput) {
  const channelId = typeof input.payload?.channelId === "string" ? input.payload.channelId : undefined;
  const channel = demoStore.channels.find((candidate) => candidate.id === channelId && candidate.propertyId === input.propertyId);
  const syncType = String(input.payload?.syncType ?? "full");
  const mappingRequired = !["test"].includes(syncType) && channel?.providerCode !== "direct_booking_engine" && channel?.providerCode !== "manual_channel";
  const hasMappings =
    !mappingRequired ||
    (demoStore.channelRoomMappings.some((mapping) => mapping.channelId === channelId && mapping.status === "active") &&
      demoStore.channelRateMappings.some((mapping) => mapping.channelId === channelId && mapping.status === "active"));
  if (!channel) {
    return { status: "blocked" as const, reason: "Channel was not found.", channel };
  }
  if (channel.status !== "active" && syncType !== "test") {
    return { status: "failed" as const, reason: "Channel sync is unhealthy or disabled.", channel };
  }
  if (!hasMappings) {
    return { status: "blocked" as const, reason: "Missing room or rate mapping blocks channel sync.", channel };
  }
  return { status: "succeeded" as const, reason: "Channel sync accepted in mock mode.", channel };
}

export function getAdvancedModuleHealth(propertyId: string, moduleCode: HotelModuleCode) {
  requirePropertyAccess(propertyId);
  return (ADVANCED_MODULE_HEALTH_CHECKS[moduleCode] ?? []).map((checkCode) => ({
    propertyId,
    moduleCode,
    checkCode,
    status: getModuleMetricStatus(propertyId, moduleCode, checkCode),
    severity: getModuleMetricStatus(propertyId, moduleCode, checkCode) === "ok" ? "info" : "warning",
    message:
      getModuleMetricStatus(propertyId, moduleCode, checkCode) === "ok"
        ? `${checkCode} is ready for the Phase 2 demo.`
        : `${checkCode} must be configured before production rollout.`
  }));
}

export function getAdvancedModuleDashboard(propertyId: string, moduleCode: HotelModuleCode) {
  requirePropertyAccess(propertyId);
  requireAdvancedModuleEnabled(propertyId, moduleCode);
  const module = getHotelModuleManifest(moduleCode);
  if (moduleCode === "revenue_profit_engine") {
    const forecasts = demoStore.revenueForecasts.filter((forecast) => forecast.propertyId === propertyId);
    const snapshots = demoStore.channelProfitabilitySnapshots.filter((snapshot) => snapshot.propertyId === propertyId);
    const pendingRecommendations = demoStore.revenueRecommendations.filter(
      (recommendation) => recommendation.propertyId === propertyId && recommendation.status === "pending"
    );
    const parityAlerts = demoStore.rateParityAlerts.filter((alert) => alert.propertyId === propertyId && alert.status === "open");
    const syncJobs = demoStore.channelSyncJobs.filter((job) => job.propertyId === propertyId);
    const failedSyncJobs = syncJobs.filter((job) => job.status === "failed");
    const totalRoomRevenue = forecasts.reduce((sum, forecast) => sum + forecast.expectedRoomRevenue, 0);
    const totalRevenue = forecasts.reduce((sum, forecast) => sum + forecast.expectedTotalRevenue, 0);
    const totalProfit = forecasts.reduce((sum, forecast) => sum + forecast.expectedProfit, 0);
    const forecastOccupancy =
      forecasts.length === 0 ? 0 : Math.round(forecasts.reduce((sum, forecast) => sum + forecast.expectedOccupancy, 0) / forecasts.length);
    const netRevenue = snapshots.reduce((sum, snapshot) => sum + snapshot.netRevenue, 0);
    const averageForecastConfidence =
      forecasts.length === 0 ? 0 : Number((forecasts.reduce((sum, forecast) => sum + forecast.confidence, 0) / forecasts.length).toFixed(2));

    return {
      propertyId,
      module,
      status: "active",
      metrics: {
        forecastOccupancy,
        adr: 136,
        revpar: Math.round(totalRoomRevenue / Math.max(1, demoStore.rooms.filter((room) => room.propertyId === propertyId).length)),
        trevpar: Math.round(totalRevenue / Math.max(1, demoStore.rooms.filter((room) => room.propertyId === propertyId).length)),
        goppar: Math.round(totalProfit / Math.max(1, demoStore.rooms.filter((room) => room.propertyId === propertyId).length)),
        netRevenue,
        netRevpar: Math.round(netRevenue / Math.max(1, demoStore.rooms.filter((room) => room.propertyId === propertyId).length)),
        pickupLast24h: 4,
        paceGap: "+6 room nights vs comparison period",
        recommendationsPending: pendingRecommendations.length,
        channelSyncHealth: failedSyncJobs.length === 0 ? "healthy" : "attention",
        parityAlerts: parityAlerts.length,
        forecastConfidence: averageForecastConfidence
      },
      pendingRecommendations,
      highDemandDates: forecasts.filter((forecast) => forecast.expectedOccupancy >= 85).map((forecast) => forecast.forecastDate),
      lowDemandDates: forecasts.filter((forecast) => forecast.expectedOccupancy < 65).map((forecast) => forecast.forecastDate),
      underpricedDates: pendingRecommendations
        .filter((recommendation) => recommendation.recommendationType === "rate")
        .map((recommendation) => recommendation.targetDate),
      channelProfitability: snapshots,
      parityAlerts,
      channelSyncHealth: {
        failedJobs: failedSyncJobs,
        pendingPushes: syncJobs.filter((job) => job.status === "queued" || job.status === "running")
      },
      healthChecks: getAdvancedModuleHealth(propertyId, moduleCode),
      aiExecutionRule: "AI revenue copilot may recommend rate changes, but applying them requires permission and confirmation."
    };
  }

  if (moduleCode === "guest_data_crm_loyalty") {
    return {
      propertyId,
      module,
      status: "active",
      metrics: {
        profiles: demoStore.guestProfiles.length,
        duplicateCandidates: demoStore.guestProfileLinks.filter((link) => link.linkConfidence < 0.95).length,
        activeSegments: demoStore.crmSegments.filter((segment) => segment.active).length,
        draftCampaigns: demoStore.crmCampaigns.filter((campaign) => campaign.status === "draft").length,
        loyaltyMembers: demoStore.loyaltyMemberships.filter((membership) => membership.status === "active").length
      },
      healthChecks: getAdvancedModuleHealth(propertyId, moduleCode),
      aiExecutionRule: "AI can summarize and draft CRM actions, but campaign sends and profile merges require human confirmation."
    };
  }

  if (moduleCode === "groups_events_sales") {
    return {
      propertyId,
      module,
      status: "active",
      metrics: {
        activeGroups: demoStore.groupBookings.filter((group) => group.propertyId === propertyId && group.status !== "cancelled").length,
        blockedRoomNights: demoStore.groupRoomBlocks
          .filter((block) => demoStore.groupBookings.some((group) => group.id === block.groupBookingId && group.propertyId === propertyId))
          .reduce((sum, block) => sum + block.blockedCount, 0),
        pickupRoomNights: demoStore.groupRoomBlocks
          .filter((block) => demoStore.groupBookings.some((group) => group.id === block.groupBookingId && group.propertyId === propertyId))
          .reduce((sum, block) => sum + block.pickedUpCount, 0),
        eventSpaces: demoStore.eventSpaces.filter((space) => space.propertyId === propertyId && space.active).length,
        pipelineValue: demoStore.salesOpportunities
          .filter((opportunity) => opportunity.propertyId === propertyId && opportunity.stage !== "lost")
          .reduce((sum, opportunity) => sum + opportunity.estimatedValue, 0)
      },
      healthChecks: getAdvancedModuleHealth(propertyId, moduleCode),
      aiExecutionRule: "AI can draft proposals and BEOs, but room blocks and outbound proposals require confirmation."
    };
  }

  return {
    propertyId,
    module,
    status: "scaffolded",
    healthChecks: getAdvancedModuleHealth(propertyId, moduleCode),
    auditability: "exportable_logs",
    aiExecutionRule: "AI tools validate module state, permissions and confirmation before execution."
  };
}

type AdvancedRecordList = {
  propertyId: string;
  moduleCode: HotelModuleCode;
  recordType: string;
  items: unknown[];
  nextAction: string;
};

/**
 * Lists advanced-module records.
 *
 * Returns a hybrid value: a synchronous snapshot (legacy demoStore view, kept
 * for the few call sites that read `.items` without awaiting — e.g. the
 * channel sync-jobs route and getAdvancedRecord, both on non-migrated types)
 * that is ALSO a promise resolving to the Prisma-backed result for migrated
 * record types (workforce/safety/quality/surveys/CRM/loyalty/events). Fastify
 * handlers `return listAdvancedRecords(...)` from async functions, which
 * awaits the promise, so HTTP responses always serve the Prisma-backed data.
 */
export function listAdvancedRecords(
  propertyId: string,
  moduleCode: HotelModuleCode,
  recordType: string
): AdvancedRecordList & Promise<AdvancedRecordList> {
  requirePropertyAccess(propertyId);
  requireAdvancedModuleEnabled(propertyId, moduleCode);
  const groupIds = demoStore.groupBookings.filter((group) => group.propertyId === propertyId).map((group) => group.id);

  const phase2Records: Record<string, unknown[]> = {
    rate_plans: demoStore.ratePlans.filter((ratePlan) => ratePlan.propertyId === propertyId),
    rate_grid: demoStore.rateDays
      .filter((rateDay) => rateDay.propertyId === propertyId)
      .map((rateDay) => ({
        ...rateDay,
        inventory: demoStore.inventoryDays.find((inventoryDay) => inventoryDay.propertyId === propertyId && inventoryDay.roomTypeId === rateDay.roomTypeId && inventoryDay.date === rateDay.date),
        restriction: demoStore.restrictionDays.find((restrictionDay) => restrictionDay.propertyId === propertyId && restrictionDay.roomTypeId === rateDay.roomTypeId && restrictionDay.ratePlanId === rateDay.ratePlanId && restrictionDay.date === rateDay.date),
        recommendations: demoStore.revenueRecommendations.filter((recommendation) => recommendation.propertyId === propertyId && recommendation.roomTypeId === rateDay.roomTypeId && recommendation.ratePlanId === rateDay.ratePlanId && recommendation.targetDate === rateDay.date)
      })),
    inventory_days: demoStore.inventoryDays.filter((inventoryDay) => inventoryDay.propertyId === propertyId),
    restriction_days: demoStore.restrictionDays.filter((restrictionDay) => restrictionDay.propertyId === propertyId),
    channels: demoStore.channels.filter((channel) => channel.propertyId === propertyId),
    channel_room_mappings: demoStore.channelRoomMappings.filter((mapping) =>
      demoStore.channels.some((channel) => channel.id === mapping.channelId && channel.propertyId === propertyId)
    ),
    channel_rate_mappings: demoStore.channelRateMappings.filter((mapping) =>
      demoStore.channels.some((channel) => channel.id === mapping.channelId && channel.propertyId === propertyId)
    ),
    channel_sync_jobs: demoStore.channelSyncJobs.filter((job) => job.propertyId === propertyId),
    sync_health: demoStore.channels
      .filter((channel) => channel.propertyId === propertyId)
      .map((channel) => ({
        channel,
        roomMappings: demoStore.channelRoomMappings.filter((mapping) => mapping.channelId === channel.id),
        rateMappings: demoStore.channelRateMappings.filter((mapping) => mapping.channelId === channel.id),
        failedJobs: demoStore.channelSyncJobs.filter((job) => job.channelId === channel.id && job.status === "failed"),
        lastSyncAt: channel.lastSyncAt,
        health: channel.status === "error" ? "error" : "connected"
      })),
    pickup: [
      {
        propertyId,
        window: "last_24h",
        reservationsCreated: 4,
        roomNightsAdded: 7,
        revenueAdded: 1026,
        cancellations: 1,
        netPickup: 884,
        byChannel: { direct: 2, booking_com_mock: 2 },
        byRoomType: { rt_double: 4 }
      }
    ],
    pace: [
      {
        propertyId,
        comparisonPeriod: "same_weekday_pattern",
        otbThisYear: 44,
        otbComparison: 38,
        forecastedFinalOccupancy: 87,
        paceGap: 6,
        revenueGap: 920
      }
    ],
    forecast_accuracy: [
      {
        propertyId,
        modelVersion: "demo-revenue-v1",
        meanAbsoluteError: 4.8,
        confidenceCalibration: "acceptable",
        drivers: ["limited historical data", "healthy pickup signal", "one channel sync issue"]
      }
    ],
    revenue_forecasts: demoStore.revenueForecasts.filter((forecast) => forecast.propertyId === propertyId),
    revenue_recommendations: demoStore.revenueRecommendations.filter((recommendation) => recommendation.propertyId === propertyId),
    channel_profitability: demoStore.channelProfitabilitySnapshots.filter((snapshot) => snapshot.propertyId === propertyId),
    demand_calendar: demoStore.demandCalendarEvents.filter((event) => event.propertyId === propertyId),
    competitors: demoStore.competitorHotels.filter((competitor) => competitor.propertyId === propertyId),
    competitor_rate_snapshots: demoStore.competitorRateSnapshots.filter((snapshot) => snapshot.propertyId === propertyId),
    parity_alerts: demoStore.rateParityAlerts.filter((alert) => alert.propertyId === propertyId),
    revenue_scenarios: demoStore.revenueScenarios.filter((scenario) => scenario.propertyId === propertyId),
    automation_rules: demoStore.revenueAutomationRules.filter((rule) => rule.propertyId === propertyId),
    external_reservations: demoStore.externalReservations.filter((reservation) => reservation.propertyId === propertyId),
    data_quality: [
      {
        propertyId,
        blocking: [],
        warnings: [
          "Expedia mock channel has one failed sync job.",
          "Accounting operating cost data is seeded, but production should use ledger-backed allocations."
        ],
        checks: getAdvancedModuleHealth(propertyId, "revenue_profit_engine")
      }
    ],
    revenue_alerts: [
      ...demoStore.rateParityAlerts.filter((alert) => alert.propertyId === propertyId),
      ...demoStore.channelSyncJobs
        .filter((job) => job.propertyId === propertyId && job.status === "failed")
        .map((job) => ({
          id: `alert_${job.id}`,
          propertyId,
          alertType: "channel_sync_failed",
          severity: "critical",
          message: job.errorMessage ?? "Channel sync failed.",
          suggestedAction: "Reconnect channel credentials or review mapping before retrying."
        }))
    ],
    history_forecast: [getHistoryForecastReport(propertyId)],
    history_forecast_charts: [getHistoryForecastCharts(propertyId)],
    history_forecast_kpis: [getHistoryForecastKpis(propertyId)],
    revenue_report_views: demoStore.revenueReportViews.filter((view) => view.propertyId === propertyId),
    visual_alerts: getHistoryForecastReport(propertyId).alerts,
    guest_profiles: demoStore.guestProfiles.filter((profile) => profile.organizationId === demoStore.userContext.organizationId),
    duplicate_guests: demoStore.guestProfileLinks
      .filter((link) => link.linkConfidence < 0.95)
      .map((link) => ({
        ...link,
        profile: demoStore.guestProfiles.find((profile) => profile.id === link.guestProfileId),
        guest: demoStore.guests.find((guest) => guest.id === link.guestId),
        requiresConfirmation: true
      })),
    crm_segments: demoStore.crmSegments.filter((segment) => segment.organizationId === demoStore.userContext.organizationId),
    crm_campaigns: demoStore.crmCampaigns.filter((campaign) => campaign.organizationId === demoStore.userContext.organizationId),
    loyalty: demoStore.loyaltyPrograms
      .filter((program) => program.organizationId === demoStore.userContext.organizationId)
      .map((program) => ({
        ...program,
        memberships: demoStore.loyaltyMemberships.filter((membership) => membership.loyaltyProgramId === program.id)
      })),
    sales_accounts: demoStore.salesAccounts.filter((account) => account.organizationId === demoStore.userContext.organizationId),
    sales_opportunities: demoStore.salesOpportunities.filter((opportunity) => opportunity.propertyId === propertyId),
    group_bookings: demoStore.groupBookings
      .filter((group) => group.propertyId === propertyId)
      .map((group) => ({
        ...group,
        roomBlocks: demoStore.groupRoomBlocks.filter((block) => block.groupBookingId === group.id)
      })),
    events_calendar: demoStore.hotelEvents.filter((event) => event.propertyId === propertyId),
    event_spaces: demoStore.eventSpaces.filter((space) => space.propertyId === propertyId),
    event_orders: demoStore.eventOrders.filter((order) => demoStore.hotelEvents.some((event) => event.id === order.eventId && event.propertyId === propertyId)),
    group_room_blocks: demoStore.groupRoomBlocks.filter((block) => groupIds.includes(block.groupBookingId))
  };

  // Merge in generically-persisted records (workforce, safety, etc.) so created
  // records actually appear in the boards. Newest first.
  const generic = genericAdvancedRecords(propertyId, moduleCode, recordType)
    .slice()
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const base = phaseRecordResponse({
    propertyId,
    moduleCode,
    recordType,
    items: [...generic, ...(phase2Records[recordType] ?? [])],
    nextAction:
      phase2Records[recordType] !== undefined
        ? `Review ${recordType} in the Phase 2 demo workspace.`
        : `Configure ${recordType} in Back Office before production use.`
  });

  // Prisma-backed view for migrated record types; resolves to the demoStore
  // snapshot for everything else. Awaited by the HTTP handlers.
  const prismaBacked = (async (): Promise<AdvancedRecordList> => {
    const migratedItems = await listMigratedRecordsFromPrisma(propertyId, moduleCode, recordType);
    if (migratedItems === null) {
      return base;
    }
    return { ...base, items: migratedItems };
  })();
  // Mark potential rejections as handled for the sync-only consumers (they
  // never await); awaiting callers still observe the rejection normally.
  prismaBacked.catch(() => undefined);

  return Object.assign(prismaBacked, base);
}

export function getAdvancedRecord(propertyId: string, moduleCode: HotelModuleCode, recordType: string, recordId: string) {
  // Reads the synchronous snapshot; its only routes serve non-migrated record
  // types (revenue_scenarios, guest_profiles), which live in the demoStore.
  const records = listAdvancedRecords(propertyId, moduleCode, recordType).items;
  const record = records.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || !("id" in candidate)) {
      return false;
    }
    return (candidate as { id?: string }).id === recordId;
  });
  if (!record) {
    throw new Error(`${recordType} record was not found.`);
  }
  return record;
}

export async function createAdvancedRecord(input: AdvancedMutationInput) {
  requirePermissions(input.context, input.requiredPermissions);
  requireAdvancedModuleEnabled(input.propertyId, input.moduleCode);
  const record = {
    id: createId(input.entityType),
    propertyId: input.propertyId,
    moduleCode: input.moduleCode,
    entityType: input.entityType,
    payload: input.payload ?? {},
    createdAt: nowIso()
  };

  // Honest stub: this endpoint never materialised reservations — do not fake
  // success by persisting a record. The rooming-list import is the real flow.
  if (input.moduleCode === "groups_events_sales" && input.entityType === "group_reservation_batch") {
    return {
      status: "not_implemented",
      message: "Usa la importación de rooming-list para materializar reservas.",
      groupId: typeof input.payload?.groupId === "string" ? input.payload.groupId : undefined
    };
  }

  // Dual-write: Prisma first (await — a Prisma failure aborts the request),
  // then the demoStore mirror below keeps the legacy synchronous reads alive.
  await persistAdvancedCreateToPrisma(input, record.id, record.createdAt);

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_forecast") {
    const forecast = {
      id: record.id,
      propertyId: input.propertyId,
      forecastDate: String(input.payload?.forecastDate ?? input.payload?.date ?? new Date().toISOString().slice(0, 10)),
      roomTypeId: typeof input.payload?.roomTypeId === "string" ? input.payload.roomTypeId : "rt_double",
      ratePlanId: typeof input.payload?.ratePlanId === "string" ? input.payload.ratePlanId : "rp_flexible",
      channelId: typeof input.payload?.channelId === "string" ? input.payload.channelId : undefined,
      segment: String(input.payload?.segment ?? "transient"),
      channel: String(input.payload?.channel ?? "blended"),
      expectedOccupancy: Number(input.payload?.expectedOccupancy ?? 86),
      expectedRoomsSold: Number(input.payload?.expectedRoomsSold ?? 44),
      expectedAdr: Number(input.payload?.expectedAdr ?? 142.5),
      expectedRevpar: Number(input.payload?.expectedRevpar ?? 122.55),
      expectedTrevpar: Number(input.payload?.expectedTrevpar ?? 156.4),
      expectedGoppar: Number(input.payload?.expectedGoppar ?? 72.1),
      expectedRoomRevenue: Number(input.payload?.expectedRoomRevenue ?? 18450),
      expectedTotalRevenue: Number(input.payload?.expectedTotalRevenue ?? 21420),
      expectedProfit: Number(input.payload?.expectedProfit ?? 7800),
      cancellationProbability: Number(input.payload?.cancellationProbability ?? 0.08),
      noShowProbability: Number(input.payload?.noShowProbability ?? 0.03),
      confidence: Number(input.payload?.confidence ?? 0.82),
      driversJson: (input.payload?.driversJson as string[] | undefined) ?? ["High pickup last 48h", "Low remaining availability"],
      modelVersion: "demo-revenue-v2",
      createdAt: record.createdAt
    };
    demoStore.revenueForecasts.push(forecast);
    audit(input, forecast.id, forecast);
    return forecast;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_recommendation") {
    const recommendation = {
      id: record.id,
      propertyId: input.propertyId,
      recommendationType: String(input.payload?.recommendationType ?? "rate") as "rate" | "restriction" | "stop_sell" | "min_stay",
      targetDate: String(input.payload?.targetDate ?? new Date().toISOString().slice(0, 10)),
      roomTypeId: typeof input.payload?.roomTypeId === "string" ? input.payload.roomTypeId : "rt_double",
      ratePlanId: typeof input.payload?.ratePlanId === "string" ? input.payload.ratePlanId : "rp_flexible",
      channelId: typeof input.payload?.channelId === "string" ? input.payload.channelId : undefined,
      currentValueJson: (input.payload?.currentValueJson as Record<string, unknown> | undefined) ?? { price: 138, currency: "EUR" },
      recommendedValueJson: (input.payload?.recommendedValueJson as Record<string, unknown> | undefined) ?? { price: 154, currency: "EUR" },
      expectedImpactJson: (input.payload?.expectedImpactJson as Record<string, unknown> | undefined) ?? { revenueLift: 960, profitLift: 710, occupancyRisk: "low" },
      reason: String(input.payload?.reason ?? "Pickup is above pace and competitors are higher."),
      reasonJson: (input.payload?.reasonJson as string[] | undefined) ?? ["Occupancy forecast above 85%", "Competitors 9% higher"],
      confidence: Number(input.payload?.confidence ?? 0.87),
      riskLevel: "high" as const,
      status: "pending" as const,
      createdAt: record.createdAt
    };
    demoStore.revenueRecommendations.push(recommendation);
    audit(input, recommendation.id, recommendation);
    return recommendation;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "channel") {
    const channel = {
      id: record.id,
      propertyId: input.propertyId,
      providerCode: String(input.payload?.providerCode ?? "manual_channel") as "booking_com_mock" | "expedia_mock" | "google_hotels_mock" | "direct_booking_engine" | "manual_channel",
      name: String(input.payload?.name ?? "Manual channel"),
      channelType: String(input.payload?.channelType ?? "manual") as "ota" | "metasearch" | "direct" | "manual",
      status: "active" as const,
      commissionPercent: Number(input.payload?.commissionPercent ?? 0),
      paymentCostPercent: Number(input.payload?.paymentCostPercent ?? 0),
      configurationJson: (input.payload?.configurationJson as Record<string, unknown> | undefined) ?? {},
      credentialsSecretRef: typeof input.payload?.credentialsSecretRef === "string" ? input.payload.credentialsSecretRef : undefined,
      lastSyncAt: undefined,
      createdAt: record.createdAt
    };
    demoStore.channels.push(channel);
    audit(input, channel.id, channel);
    return channel;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "channel_room_mapping") {
    const mapping = {
      id: record.id,
      channelId: String(input.payload?.channelId),
      roomTypeId: String(input.payload?.roomTypeId ?? "rt_double"),
      externalRoomCode: String(input.payload?.externalRoomCode ?? "EXT_ROOM"),
      externalRoomName: typeof input.payload?.externalRoomName === "string" ? input.payload.externalRoomName : undefined,
      status: "active" as const
    };
    demoStore.channelRoomMappings.push(mapping);
    audit(input, mapping.id, mapping);
    return mapping;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "channel_rate_mapping") {
    const mapping = {
      id: record.id,
      channelId: String(input.payload?.channelId),
      ratePlanId: String(input.payload?.ratePlanId ?? "rp_flexible"),
      externalRateCode: String(input.payload?.externalRateCode ?? "EXT_RATE"),
      externalRateName: typeof input.payload?.externalRateName === "string" ? input.payload.externalRateName : undefined,
      status: "active" as const
    };
    demoStore.channelRateMappings.push(mapping);
    audit(input, mapping.id, mapping);
    return mapping;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "channel_sync_job") {
    const safety = evaluateChannelSyncSafety(input);
    const updatedAt = nowIso();
    const syncJob = {
      id: record.id,
      propertyId: input.propertyId,
      channelId: typeof input.payload?.channelId === "string" ? input.payload.channelId : undefined,
      syncType: String(input.payload?.syncType ?? "full") as "availability" | "rates" | "restrictions" | "full" | "reservation_import",
      status: safety.status,
      dateRangeStart: typeof input.payload?.dateRangeStart === "string" ? input.payload.dateRangeStart : undefined,
      dateRangeEnd: typeof input.payload?.dateRangeEnd === "string" ? input.payload.dateRangeEnd : undefined,
      requestPayloadJson: input.payload ?? {},
      responsePayloadJson:
        safety.status === "succeeded"
          ? { accepted: true, exportedAvailability: demoStore.inventoryDays.filter((day) => day.propertyId === input.propertyId).length, exportedRates: demoStore.rateDays.filter((day) => day.propertyId === input.propertyId).length }
          : {},
      errorMessage: safety.status === "succeeded" ? undefined : safety.reason,
      idempotencyKey: `${input.propertyId}:${String(input.payload?.channelId ?? "channel")}:${String(input.payload?.syncType ?? "full")}:${record.createdAt}`,
      startedAt: updatedAt,
      finishedAt: updatedAt,
      createdAt: record.createdAt
    };
    if (safety.status === "succeeded" && safety.channel) {
      safety.channel.lastSyncAt = updatedAt;
    }
    demoStore.channelSyncJobs.push(syncJob);
    audit(
      {
        ...input,
        auditAction: safety.status === "succeeded" ? "ChannelSyncSucceeded" : "ChannelSyncFailed"
      },
      syncJob.id,
      syncJob
    );
    return syncJob;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "external_reservation") {
    const externalReservation = {
      id: record.id,
      propertyId: input.propertyId,
      channelId: typeof input.payload?.channelId === "string" ? input.payload.channelId : undefined,
      externalReservationId: String(input.payload?.externalReservationId ?? `external_${record.id}`),
      status: "imported" as const,
      guestName: String(input.payload?.guestName ?? "Imported OTA guest"),
      arrivalDate: typeof input.payload?.arrivalDate === "string" ? input.payload.arrivalDate : undefined,
      departureDate: typeof input.payload?.departureDate === "string" ? input.payload.departureDate : undefined,
      payloadJson: input.payload ?? {},
      importedAt: record.createdAt
    };
    demoStore.externalReservations.push(externalReservation);
    audit(input, externalReservation.id, externalReservation);
    return externalReservation;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "competitor_hotel") {
    const competitor = {
      id: record.id,
      propertyId: input.propertyId,
      name: String(input.payload?.name ?? "New competitor"),
      locationJson: (input.payload?.locationJson as Record<string, unknown> | undefined) ?? {},
      category: typeof input.payload?.category === "string" ? input.payload.category : undefined,
      starRating: Number(input.payload?.starRating ?? 4),
      comparableScore: Number(input.payload?.comparableScore ?? 0.75),
      active: true,
      createdAt: record.createdAt
    };
    demoStore.competitorHotels.push(competitor);
    audit(input, competitor.id, competitor);
    return competitor;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "competitor_rate_snapshot") {
    const snapshot = {
      id: record.id,
      propertyId: input.propertyId,
      competitorHotelId: typeof input.payload?.competitorHotelId === "string" ? input.payload.competitorHotelId : undefined,
      sourceChannel: String(input.payload?.sourceChannel ?? "manual"),
      shopDate: String(input.payload?.shopDate ?? new Date().toISOString().slice(0, 10)),
      stayDate: String(input.payload?.stayDate ?? new Date().toISOString().slice(0, 10)),
      roomTypeLabel: String(input.payload?.roomTypeLabel ?? "Double Standard"),
      ratePlanLabel: String(input.payload?.ratePlanLabel ?? "Flexible"),
      price: Number(input.payload?.price ?? 0),
      currency: String(input.payload?.currency ?? "EUR"),
      availabilityStatus: String(input.payload?.availabilityStatus ?? "available"),
      cancellationPolicyLabel: typeof input.payload?.cancellationPolicyLabel === "string" ? input.payload.cancellationPolicyLabel : undefined,
      metadataJson: input.payload ?? {},
      createdAt: record.createdAt
    };
    demoStore.competitorRateSnapshots.push(snapshot);
    audit(input, snapshot.id, snapshot);
    return snapshot;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "rate_grid_bulk_update") {
    const confirmed = input.payload?.confirmed === true;
    const rateChanges = asRecordArray(input.payload?.rateChanges ?? input.payload?.rates ?? input.payload?.updates);
    const restrictionChanges = asRecordArray(input.payload?.restrictionChanges ?? input.payload?.restrictions);
    const inventoryChanges = asRecordArray(input.payload?.inventoryChanges ?? input.payload?.inventory);
    const updatedAt = nowIso();
    const preview = {
      rates: rateChanges.map((change) => ({ ...change, before: findRateDay({ propertyId: input.propertyId, roomTypeId: change.roomTypeId, ratePlanId: change.ratePlanId, date: change.date }) })),
      restrictions: restrictionChanges.map((change) => ({
        ...change,
        before: findRestrictionDay({ propertyId: input.propertyId, roomTypeId: change.roomTypeId, ratePlanId: change.ratePlanId, channelId: change.channelId, date: change.date })
      })),
      inventory: inventoryChanges
    };
    const update = {
      id: record.id,
      propertyId: input.propertyId,
      previewRequired: !confirmed,
      requiresConfirmation: true,
      safetyChecks: ["module_enabled", "manual_overrides_respected", "channel_sync_health_checked", "min_max_price_checked"],
      preview,
      appliedChanges: confirmed
        ? {
            rates: applyRateDayUpdates(input, rateChanges, updatedAt),
            restrictions: applyRestrictionDayUpdates(input, restrictionChanges, updatedAt),
            inventory: applyInventoryDayUpdates(input, inventoryChanges, updatedAt)
          }
        : undefined,
      payload: input.payload ?? {},
      createdAt: record.createdAt
    };
    audit(input, update.id, update);
    return update;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "rate_day_update") {
    const updatedAt = nowIso();
    const changes = applyRateDayUpdates(input, asRecordArray(input.payload?.updates ?? [input.payload ?? {}]), updatedAt);
    const update = { id: record.id, propertyId: input.propertyId, affectedDates: input.payload?.dates ?? [], beforeAfterRequired: true, changes, payload: input.payload ?? {}, createdAt: record.createdAt };
    audit(input, update.id, update);
    return update;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "restriction_day_update") {
    const updatedAt = nowIso();
    const changes = applyRestrictionDayUpdates(input, asRecordArray(input.payload?.updates ?? [input.payload ?? {}]), updatedAt);
    const update = { id: record.id, propertyId: input.propertyId, affectedDates: input.payload?.dates ?? [], confirmationRequired: true, changes, payload: input.payload ?? {}, createdAt: record.createdAt };
    audit(input, update.id, update);
    return update;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "inventory_day_update") {
    const updatedAt = nowIso();
    const changes = applyInventoryDayUpdates(input, asRecordArray(input.payload?.updates ?? [input.payload ?? {}]), updatedAt);
    const update = { id: record.id, propertyId: input.propertyId, affectedDates: input.payload?.dates ?? [], overbookingRiskChecked: true, changes, payload: input.payload ?? {}, createdAt: record.createdAt };
    audit(input, update.id, update);
    return update;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_scenario") {
    const scenario = {
      id: record.id,
      propertyId: input.propertyId,
      name: String(input.payload?.name ?? "Revenue scenario"),
      scenarioType: String(input.payload?.scenarioType ?? "rate_change") as "rate_change" | "restriction_change" | "channel_closeout" | "group_displacement",
      inputJson: input.payload ?? {},
      outputJson: {
        expectedOccupancyChange: -0.02,
        expectedAdrChange: 12.3,
        expectedRevparChange: 8.8,
        expectedTotalRevenueChange: 960,
        expectedProfitChange: 710,
        operationalImpact: "low",
        riskLevel: "medium",
        confidence: 0.79
      },
      createdBy: input.context.userId,
      createdAt: record.createdAt
    };
    demoStore.revenueScenarios.push(scenario);
    audit(input, scenario.id, scenario);
    return scenario;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_automation_rule") {
    const rule = {
      id: record.id,
      propertyId: input.propertyId,
      name: String(input.payload?.name ?? "Revenue automation rule"),
      automationLevel: String(input.payload?.automationLevel ?? "approve_required") as "manual_only" | "recommend_only" | "approve_required" | "auto_apply_within_limits" | "auto_apply_low_risk",
      scopeJson: (input.payload?.scopeJson as Record<string, unknown> | undefined) ?? {},
      constraintsJson: {
        neverCloseDirect: true,
        blockIfChannelSyncUnhealthy: true,
        ...(input.payload?.constraintsJson as Record<string, unknown> | undefined)
      },
      active: true,
      createdBy: input.context.userId,
      createdAt: record.createdAt
    };
    demoStore.revenueAutomationRules.push(rule);
    audit(input, rule.id, rule);
    return rule;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "demand_calendar_event") {
    const demandEvent = {
      id: record.id,
      propertyId: input.propertyId,
      name: String(input.payload?.name ?? "New demand event"),
      eventType: String(input.payload?.eventType ?? "manual"),
      startDate: String(input.payload?.startDate ?? new Date().toISOString().slice(0, 10)),
      endDate: String(input.payload?.endDate ?? input.payload?.startDate ?? new Date().toISOString().slice(0, 10)),
      expectedImpact: String(input.payload?.expectedImpact ?? "medium"),
      impactScore: Number(input.payload?.impactScore ?? 0.7),
      source: "manual",
      metadataJson: input.payload ?? {},
      createdAt: record.createdAt
    };
    demoStore.demandCalendarEvents.push(demandEvent);
    audit(input, demandEvent.id, demandEvent);
    return demandEvent;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_report_view") {
    const view = {
      id: record.id,
      propertyId: input.propertyId,
      userId: input.context.userId,
      name: String(input.payload?.name ?? "History & Forecast saved view"),
      reportType: "history_forecast" as const,
      filtersJson: (input.payload?.filtersJson as Record<string, unknown> | undefined) ?? {},
      layoutJson: (input.payload?.layoutJson as Record<string, unknown> | undefined) ?? {},
      isShared: Boolean(input.payload?.isShared ?? false),
      createdAt: record.createdAt
    };
    demoStore.revenueReportViews.push(view);
    audit(input, view.id, view);
    return view;
  }

  if (input.moduleCode === "guest_data_crm_loyalty" && input.entityType === "crm_segment") {
    const segment = {
      id: record.id,
      organizationId: input.context.organizationId,
      name: String(input.payload?.name ?? "New segment"),
      description: typeof input.payload?.description === "string" ? input.payload.description : undefined,
      rulesJson: (input.payload?.rulesJson as Record<string, unknown> | undefined) ?? {},
      active: true,
      createdAt: record.createdAt
    };
    demoStore.crmSegments.push(segment);
    audit(input, segment.id, segment);
    return segment;
  }

  if (input.moduleCode === "guest_data_crm_loyalty" && input.entityType === "crm_campaign") {
    const campaign = {
      id: record.id,
      organizationId: input.context.organizationId,
      name: String(input.payload?.name ?? "New campaign"),
      campaignType: String(input.payload?.campaignType ?? "email"),
      segmentId: typeof input.payload?.segmentId === "string" ? input.payload.segmentId : undefined,
      channel: String(input.payload?.channel ?? "email"),
      status: "draft" as const,
      scheduleJson: (input.payload?.scheduleJson as Record<string, unknown> | undefined) ?? {},
      contentJson: { ...(input.payload?.contentJson as Record<string, unknown> | undefined), consentRequired: true },
      createdAt: record.createdAt
    };
    demoStore.crmCampaigns.push(campaign);
    audit(input, campaign.id, campaign);
    return campaign;
  }

  if (input.moduleCode === "guest_data_crm_loyalty" && input.entityType === "loyalty_program") {
    const program = {
      id: record.id,
      organizationId: input.context.organizationId,
      name: String(input.payload?.name ?? "New loyalty program"),
      configurationJson: (input.payload?.configurationJson as Record<string, unknown> | undefined) ?? {},
      active: true,
      createdAt: record.createdAt
    };
    demoStore.loyaltyPrograms.push(program);
    audit(input, program.id, program);
    return program;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "sales_account") {
    const account = {
      id: record.id,
      organizationId: input.context.organizationId,
      accountType: "company" as const,
      name: String(input.payload?.name ?? "New sales account"),
      taxId: typeof input.payload?.taxId === "string" ? input.payload.taxId : undefined,
      contactJson: (input.payload?.contactJson as Record<string, unknown> | undefined) ?? {},
      billingJson: (input.payload?.billingJson as Record<string, unknown> | undefined) ?? {},
      status: "active" as const,
      createdAt: record.createdAt
    };
    demoStore.salesAccounts.push(account);
    audit(input, account.id, account);
    return account;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "sales_opportunity") {
    const opportunity = {
      id: record.id,
      propertyId: input.propertyId,
      accountId: typeof input.payload?.accountId === "string" ? input.payload.accountId : undefined,
      name: String(input.payload?.name ?? "New opportunity"),
      opportunityType: "group" as const,
      stage: "lead" as const,
      estimatedValue: Number(input.payload?.estimatedValue ?? 0),
      expectedCloseDate: typeof input.payload?.expectedCloseDate === "string" ? input.payload.expectedCloseDate : undefined,
      ownerUserId: input.context.userId,
      createdAt: record.createdAt
    };
    demoStore.salesOpportunities.push(opportunity);
    audit(input, opportunity.id, opportunity);
    return opportunity;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "group_booking") {
    const group = {
      id: record.id,
      propertyId: input.propertyId,
      accountId: typeof input.payload?.accountId === "string" ? input.payload.accountId : undefined,
      opportunityId: typeof input.payload?.opportunityId === "string" ? input.payload.opportunityId : undefined,
      name: String(input.payload?.name ?? "New group booking"),
      status: "draft" as const,
      arrivalDate: String(input.payload?.arrivalDate ?? new Date().toISOString().slice(0, 10)),
      departureDate: String(input.payload?.departureDate ?? new Date().toISOString().slice(0, 10)),
      releaseDate: typeof input.payload?.releaseDate === "string" ? input.payload.releaseDate : undefined,
      masterFolioId: typeof input.payload?.masterFolioId === "string" ? input.payload.masterFolioId : undefined,
      billingRulesJson: (input.payload?.billingRulesJson as Record<string, unknown> | undefined) ?? {},
      createdAt: record.createdAt
    };
    demoStore.groupBookings.push(group);
    audit(input, group.id, group);
    return group;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "group_room_block") {
    const block = {
      id: record.id,
      groupBookingId: String(input.payload?.groupId ?? input.payload?.groupBookingId),
      roomTypeId: String(input.payload?.roomTypeId ?? "rt_double"),
      date: String(input.payload?.date ?? new Date().toISOString().slice(0, 10)),
      blockedCount: Number(input.payload?.blockedCount ?? 1),
      pickedUpCount: Number(input.payload?.pickedUpCount ?? 0),
      rate: Number(input.payload?.rate ?? 0),
      createdAt: record.createdAt
    };
    demoStore.groupRoomBlocks.push(block);
    audit(input, block.id, block);
    return block;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "event_space") {
    const eventSpace = {
      id: record.id,
      propertyId: input.propertyId,
      name: String(input.payload?.name ?? "New event space"),
      spaceId: typeof input.payload?.spaceId === "string" ? input.payload.spaceId : undefined,
      capacityJson: (input.payload?.capacityJson as Record<string, unknown> | undefined) ?? {},
      active: true,
      createdAt: record.createdAt
    };
    demoStore.eventSpaces.push(eventSpace);
    audit(input, eventSpace.id, eventSpace);
    return eventSpace;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "event") {
    const event = {
      id: record.id,
      propertyId: input.propertyId,
      groupBookingId: typeof input.payload?.groupBookingId === "string" ? input.payload.groupBookingId : undefined,
      eventSpaceId: typeof input.payload?.eventSpaceId === "string" ? input.payload.eventSpaceId : undefined,
      name: String(input.payload?.name ?? "New event"),
      eventType: typeof input.payload?.eventType === "string" ? input.payload.eventType : undefined,
      startAt: String(input.payload?.startAt ?? nowIso()),
      endAt: String(input.payload?.endAt ?? nowIso()),
      status: "draft" as const,
      setupJson: (input.payload?.setupJson as Record<string, unknown> | undefined) ?? {},
      cateringJson: (input.payload?.cateringJson as Record<string, unknown> | undefined) ?? {},
      createdAt: record.createdAt
    };
    demoStore.hotelEvents.push(event);
    audit(input, event.id, event);
    return event;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "event_order") {
    const order = {
      id: record.id,
      eventId: String(input.payload?.eventId),
      orderType: "beo" as const,
      contentJson: { ...(input.payload ?? {}), requiresConfirmation: true },
      status: "draft" as const,
      createdAt: record.createdAt
    };
    demoStore.eventOrders.push(order);
    audit(input, order.id, order);
    return order;
  }

  // Generic persistence so non-special-cased modules (workforce, safety, etc.)
  // actually round-trip: create → list → transition all hit demoStore.advancedRecords.
  const stored = {
    ...record,
    status: typeof input.payload?.status === "string" ? input.payload.status : "open",
    updatedAt: record.createdAt
  };
  demoStore.advancedRecords.push(stored);
  audit(input, record.id, record);
  return stored;
}

// Matches a stored entityType against a requested recordType, tolerating the
// singular/plural mismatch in the codebase (entityType "safety_incident" vs
// recordType "safety_incidents").
function matchesRecordType(entityType: string, recordType: string): boolean {
  if (entityType === recordType) return true;
  if (`${entityType}s` === recordType) return true; // incident → incidents
  if (entityType.replace(/y$/, "ies") === recordType) return true; // entry → entries
  if (entityType === recordType.replace(/s$/, "")) return true;
  if (entityType === recordType.replace(/ies$/, "y")) return true;
  return false;
}

function genericAdvancedRecords(propertyId: string, moduleCode: string, recordType: string) {
  return demoStore.advancedRecords.filter(
    (r) => r.propertyId === propertyId && r.moduleCode === moduleCode && matchesRecordType(r.entityType, recordType)
  );
}

// ---------------------------------------------------------------------------
// Prisma persistence for the operations + CRM entity types.
//
// Strategy: dual-write. Prisma is written FIRST (await; a Prisma failure
// aborts the request), then the legacy demoStore mirror is updated so the
// synchronous/legacy readers keep working. Creates use the SAME id in Prisma
// and demoStore (explicit `id` on create) so transitions can find the row in
// both stores. Lists for the migrated record types read from Prisma so the
// records survive restarts and show up in the Prisma-backed dashboards
// (workforce/safety/quality/surveys/crm/loyalty services).
// ---------------------------------------------------------------------------

function toJson(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDate(value: unknown, fallback: Date): Date {
  return toDateOrNull(value) ?? fallback;
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const CLOSED_OPERATIONAL_STATUSES = new Set(["resolved", "closed"]);

/**
 * Resolve the StaffProfile id for workforce writes. The demo UI sends a free
 * text `staffName` (there is no staff picker), so we try, in order:
 * payload.staffProfileId → User.fullName lookup → StaffProfile.employeeCode.
 * Callers fall back to the raw staffName when nothing matches — the schema
 * has no FK on staffProfileId, and using a stable string keeps clock-in/out
 * pairing consistent in the workforce dashboard.
 */
async function resolveStaffProfileId(propertyId: string, payload: Record<string, unknown>): Promise<string | undefined> {
  const direct = optStr(payload.staffProfileId);
  if (direct) return direct;
  const staffName = optStr(payload.staffName)?.trim();
  if (!staffName) return undefined;
  const user = await prisma.user.findFirst({ where: { fullName: staffName }, select: { id: true } });
  if (user) {
    const profile = await prisma.staffProfile.findFirst({ where: { propertyId, userId: user.id }, select: { id: true } });
    if (profile) return profile.id;
  }
  const byCode = await prisma.staffProfile.findFirst({
    where: { propertyId, employeeCode: staffName.toUpperCase() },
    select: { id: true }
  });
  return byCode?.id;
}

async function staffDisplayNamesByProfileId(profileIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(profileIds.filter((id): id is string => typeof id === "string" && id.length > 0)));
  if (unique.length === 0) return new Map();
  const profiles = await prisma.staffProfile.findMany({
    where: { id: { in: unique } },
    select: { id: true, userId: true, employeeCode: true }
  });
  const userIds = Array.from(new Set(profiles.map((profile) => profile.userId)));
  const users = userIds.length === 0
    ? []
    : await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
  const nameByUserId = new Map(users.map((user) => [user.id, user.fullName]));
  const out = new Map<string, string>();
  for (const profile of profiles) {
    out.set(profile.id, nameByUserId.get(profile.userId) ?? profile.employeeCode ?? profile.userId);
  }
  return out;
}

/**
 * Prisma leg of the dual-write for createAdvancedRecord. No-op for entity
 * types that are not (yet) migrated. Throws on Prisma failure so the caller
 * aborts before touching the demoStore mirror.
 */
async function persistAdvancedCreateToPrisma(input: AdvancedMutationInput, recordId: string, createdAtIso: string): Promise<void> {
  const payload = input.payload ?? {};
  const createdAt = toDate(createdAtIso, new Date());
  const key = `${input.moduleCode}:${input.entityType}`;

  switch (key) {
    case "workforce_labor:shift": {
      const startAt = toDate(payload.startAt, createdAt);
      const endAt = toDate(payload.endAt, new Date(startAt.getTime() + 8 * 3_600_000));
      const staffProfileId = (await resolveStaffProfileId(input.propertyId, payload)) ?? optStr(payload.staffName) ?? null;
      await prisma.shift.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          staffProfileId,
          departmentId: optStr(payload.departmentId) ?? null,
          shiftDate: utcDayStart(startAt),
          startAt,
          endAt,
          status: optStr(payload.status) ?? "scheduled",
          roleLabel: optStr(payload.role) ?? optStr(payload.roleLabel) ?? null
        }
      });
      return;
    }
    case "workforce_labor:time_clock_entry": {
      // Clock-in and clock-out are BOTH creates (each clock event is a row;
      // the workforce dashboard pairs consecutive in/out rows per staff
      // profile). The audit action tells us which side this is.
      const action = optStr(payload.action) ?? (input.auditAction === "StaffClockedOut" ? "out" : "in");
      const staffProfileId = (await resolveStaffProfileId(input.propertyId, payload)) ?? optStr(payload.staffName) ?? "unknown";
      await prisma.timeClockEntry.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          staffProfileId,
          clockType: action === "out" ? "out" : "in",
          clockAt: toDate(payload.at ?? payload.clockAt, createdAt),
          source: optStr(payload.source) ?? "api",
          deviceId: input.context.deviceId,
          metadataJson: toJson(payload)
        }
      });
      return;
    }
    case "workforce_labor:absence_request": {
      const staffProfileId = (await resolveStaffProfileId(input.propertyId, payload)) ?? optStr(payload.staffName) ?? "unknown";
      const startDate = toDate(payload.startDate ?? payload.from, utcDayStart(createdAt));
      await prisma.absenceRequest.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          staffProfileId,
          absenceType: optStr(payload.absenceType) ?? optStr(payload.type) ?? "personal",
          startDate,
          endDate: toDate(payload.endDate ?? payload.to, startDate),
          status: optStr(payload.status) ?? "pending"
        }
      });
      return;
    }
    case "safety_incident_management:safety_incident": {
      const location = optStr(payload.location);
      await prisma.safetyIncident.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          incidentType: optStr(payload.incidentType) ?? optStr(payload.type) ?? "general",
          severity: optStr(payload.severity) ?? "medium",
          status: optStr(payload.status) ?? "open",
          title: optStr(payload.title) ?? "Incidente",
          description: optStr(payload.description) ?? null,
          // The UI sends `location` as free text; the schema models locations
          // as entityType/entityId, so we store the label under a "label" kind.
          locationEntityType: location ? "label" : optStr(payload.locationEntityType) ?? null,
          locationEntityId: location ?? optStr(payload.locationEntityId) ?? null,
          guestId: optStr(payload.guestId) ?? null,
          reservationId: optStr(payload.reservationId) ?? null,
          reportedBy: optStr(payload.reportedBy) ?? input.context.userId,
          assignedTo: optStr(payload.assignedTo) ?? null,
          occurredAt: toDateOrNull(payload.occurredAt) ?? createdAt
        }
      });
      return;
    }
    case "safety_incident_management:incident_evidence": {
      // Route quirk: POST /safety/incidents/:id/evidence does not spread the
      // :id param into the payload, so we accept the common body aliases.
      await prisma.incidentEvidence.create({
        data: {
          id: recordId,
          incidentId: optStr(payload.incidentId) ?? optStr(payload.safetyIncidentId) ?? "unknown",
          evidenceType: optStr(payload.evidenceType) ?? optStr(payload.type) ?? "note",
          objectKey: optStr(payload.objectKey) ?? optStr(payload.url) ?? null,
          notes: optStr(payload.notes) ?? optStr(payload.description) ?? null,
          createdBy: optStr(payload.createdBy) ?? input.context.userId
        }
      });
      return;
    }
    case "safety_incident_management:safety_check": {
      await prisma.safetyCheck.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          checkType: optStr(payload.checkType) ?? optStr(payload.type) ?? "general",
          title: optStr(payload.title) ?? optStr(payload.name) ?? "Inspección de seguridad",
          frequency: optStr(payload.frequency) ?? null,
          locationEntityType: optStr(payload.locationEntityType) ?? null,
          locationEntityId: optStr(payload.locationEntityId) ?? optStr(payload.location) ?? null,
          assignedTo: optStr(payload.assignedTo) ?? null,
          nextDueDate: toDateOrNull(payload.nextDueDate ?? payload.dueAt ?? payload.dueDate),
          active: payload.active !== false
        }
      });
      return;
    }
    case "safety_incident_management:safety_check_result": {
      await prisma.safetyCheckResult.create({
        data: {
          id: recordId,
          safetyCheckId: optStr(payload.safetyCheckId) ?? optStr(payload.checkId) ?? "unknown",
          status: optStr(payload.status) ?? optStr(payload.result) ?? "passed",
          notes: optStr(payload.notes) ?? null,
          completedBy: optStr(payload.completedBy) ?? input.context.userId,
          completedAt: toDate(payload.completedAt, createdAt)
        }
      });
      return;
    }
    case "reputation_quality:quality_case": {
      await prisma.qualityCase.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          reservationId: optStr(payload.reservationId) ?? null,
          guestId: optStr(payload.guestId) ?? null,
          roomId: optStr(payload.roomId) ?? null,
          caseType: optStr(payload.caseType) ?? optStr(payload.type) ?? "complaint",
          priority: optStr(payload.priority) ?? optStr(payload.severity) ?? "normal",
          status: optStr(payload.status) ?? "open",
          title: optStr(payload.title) ?? optStr(payload.name) ?? "Caso de calidad",
          description: optStr(payload.description) ?? null,
          ownerUserId: optStr(payload.ownerUserId) ?? input.context.userId,
          slaTargetAt: toDateOrNull(payload.slaTargetAt),
          rootCause: optStr(payload.rootCause) ?? null
        }
      });
      return;
    }
    case "reputation_quality:survey": {
      await prisma.survey.create({
        data: {
          id: recordId,
          propertyId: input.propertyId,
          name: optStr(payload.name) ?? optStr(payload.title) ?? "Encuesta",
          surveyType: optStr(payload.surveyType) ?? optStr(payload.type) ?? "post_stay",
          questionsJson: toJson(payload.questionsJson ?? payload.questions ?? []),
          active: payload.active !== false
        }
      });
      return;
    }
    case "reputation_quality:survey_response": {
      // Route quirk: POST /surveys/:id/responses does not spread the :id param
      // into the payload, so the body must carry surveyId.
      const rawScore = payload.score ?? payload.nps ?? payload.rating;
      const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
      await prisma.surveyResponse.create({
        data: {
          id: recordId,
          surveyId: optStr(payload.surveyId) ?? optStr(payload.survey_id) ?? "unknown",
          reservationId: optStr(payload.reservationId) ?? null,
          guestId: optStr(payload.guestId) ?? null,
          responsesJson: toJson(payload),
          score
        }
      });
      return;
    }
    case "guest_data_crm_loyalty:crm_segment": {
      await prisma.crmSegment.create({
        data: {
          id: recordId,
          organizationId: input.context.organizationId,
          name: String(payload.name ?? "New segment"),
          description: optStr(payload.description) ?? null,
          rulesJson: toJson(payload.rulesJson),
          active: true
        }
      });
      return;
    }
    case "guest_data_crm_loyalty:crm_campaign": {
      await prisma.crmCampaign.create({
        data: {
          id: recordId,
          organizationId: input.context.organizationId,
          name: String(payload.name ?? "New campaign"),
          campaignType: String(payload.campaignType ?? "email"),
          segmentId: optStr(payload.segmentId) ?? null,
          channel: String(payload.channel ?? "email"),
          status: "draft",
          scheduleJson: toJson(payload.scheduleJson),
          contentJson: toJson({ ...(payload.contentJson as Record<string, unknown> | undefined), consentRequired: true })
        }
      });
      return;
    }
    case "guest_data_crm_loyalty:loyalty_program": {
      await prisma.loyaltyProgram.create({
        data: {
          id: recordId,
          organizationId: input.context.organizationId,
          name: String(payload.name ?? "New loyalty program"),
          configurationJson: toJson(payload.configurationJson),
          active: true
        }
      });
      return;
    }
    case "groups_events_sales:event_order": {
      await prisma.eventOrder.create({
        data: {
          id: recordId,
          eventId: String(payload.eventId),
          orderType: "beo",
          contentJson: toJson({ ...payload, requiresConfirmation: true }),
          status: "draft"
        }
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Prisma leg of the dual-write for transitionAdvancedRecord. Uses updateMany
 * (id-scoped) so a record that only exists in the demoStore (legacy seeds)
 * does not make the request fail — the in-memory mutation still applies.
 */
async function persistAdvancedTransitionToPrisma(input: AdvancedMutationInput & { entityId: string; status: string }): Promise<void> {
  const payload = input.payload ?? {};
  const key = `${input.moduleCode}:${input.entityType}`;
  const now = new Date();

  switch (key) {
    case "workforce_labor:shift": {
      const data: Prisma.ShiftUpdateManyMutationInput = {};
      const startAt = toDateOrNull(payload.startAt);
      if (startAt) {
        data.startAt = startAt;
        data.shiftDate = utcDayStart(startAt);
      }
      const endAt = toDateOrNull(payload.endAt);
      if (endAt) data.endAt = endAt;
      const roleLabel = optStr(payload.role) ?? optStr(payload.roleLabel);
      if (roleLabel) data.roleLabel = roleLabel;
      const status = optStr(payload.status);
      if (status) data.status = status;
      const staffProfileId = optStr(payload.staffProfileId);
      if (staffProfileId) data.staffProfileId = staffProfileId;
      if (Object.keys(data).length > 0) {
        await prisma.shift.updateMany({ where: { id: input.entityId }, data });
      }
      return;
    }
    case "workforce_labor:absence_request": {
      const status = optStr(payload.status) ?? input.status;
      await prisma.absenceRequest.updateMany({
        where: { id: input.entityId },
        data: {
          status,
          ...(status === "approved" ? { approvedBy: input.context.userId } : {})
        }
      });
      return;
    }
    case "safety_incident_management:safety_incident": {
      const status = optStr(payload.status) ?? input.status;
      const data: Prisma.SafetyIncidentUpdateManyMutationInput = { status };
      const severity = optStr(payload.severity);
      if (severity) data.severity = severity;
      const title = optStr(payload.title);
      if (title) data.title = title;
      const description = optStr(payload.description);
      if (description) data.description = description;
      const assignedTo = optStr(payload.assignedTo);
      if (assignedTo) data.assignedTo = assignedTo;
      if (CLOSED_OPERATIONAL_STATUSES.has(status)) {
        data.resolvedAt = toDateOrNull(payload.resolvedAt ?? payload.handledAt) ?? now;
      }
      await prisma.safetyIncident.updateMany({ where: { id: input.entityId }, data });
      return;
    }
    case "reputation_quality:quality_case": {
      const status = optStr(payload.status) ?? input.status;
      const data: Prisma.QualityCaseUpdateManyMutationInput = { status };
      const priority = optStr(payload.priority) ?? optStr(payload.severity);
      if (priority) data.priority = priority;
      const title = optStr(payload.title);
      if (title) data.title = title;
      const description = optStr(payload.description);
      if (description) data.description = description;
      const rootCause = optStr(payload.rootCause);
      if (rootCause) data.rootCause = rootCause;
      const ownerUserId = optStr(payload.ownerUserId);
      if (ownerUserId) data.ownerUserId = ownerUserId;
      if (CLOSED_OPERATIONAL_STATUSES.has(status)) {
        data.resolvedAt = toDateOrNull(payload.resolvedAt) ?? now;
      }
      await prisma.qualityCase.updateMany({ where: { id: input.entityId }, data });
      return;
    }
    case "guest_data_crm_loyalty:crm_segment": {
      const data: Prisma.CrmSegmentUpdateManyMutationInput = {};
      const name = optStr(payload.name);
      if (name) data.name = name;
      const description = optStr(payload.description);
      if (description) data.description = description;
      if (typeof payload.active === "boolean") data.active = payload.active;
      if (payload.rulesJson !== undefined) data.rulesJson = toJson(payload.rulesJson);
      if (Object.keys(data).length > 0) {
        await prisma.crmSegment.updateMany({ where: { id: input.entityId }, data });
      }
      return;
    }
    case "guest_data_crm_loyalty:crm_campaign": {
      const data: Prisma.CrmCampaignUpdateManyMutationInput = {};
      const name = optStr(payload.name);
      if (name) data.name = name;
      const campaignType = optStr(payload.campaignType);
      if (campaignType) data.campaignType = campaignType;
      const channel = optStr(payload.channel);
      if (channel) data.channel = channel;
      const segmentId = optStr(payload.segmentId);
      if (segmentId) data.segmentId = segmentId;
      // Mirror of the demoStore rule: the route always sends status "updated",
      // which means "keep"; an explicit payload.status wins.
      const status = optStr(payload.status) ?? (input.status !== "updated" ? input.status : undefined);
      if (status) data.status = status;
      if (payload.scheduleJson !== undefined) data.scheduleJson = toJson(payload.scheduleJson);
      if (payload.contentJson !== undefined) data.contentJson = toJson(payload.contentJson);
      if (Object.keys(data).length > 0) {
        await prisma.crmCampaign.updateMany({ where: { id: input.entityId }, data });
      }
      return;
    }
    case "guest_data_crm_loyalty:loyalty_membership": {
      const data: Prisma.LoyaltyMembershipUpdateManyMutationInput = {};
      const tier = optStr(payload.tier);
      if (tier) data.tier = tier;
      if (typeof payload.pointsBalance === "number" && Number.isFinite(payload.pointsBalance)) {
        data.pointsBalance = Math.round(payload.pointsBalance);
      }
      const status = optStr(payload.status);
      if (status) data.status = status;
      if (Object.keys(data).length > 0) {
        await prisma.loyaltyMembership.updateMany({ where: { id: input.entityId }, data });
      }
      return;
    }
    case "guest_data_crm_loyalty:guest_profile": {
      // Profile merge. Only runs the Prisma leg when both profiles exist in
      // the database (demo-only seed ids are skipped silently — the demoStore
      // branch still merges them in memory).
      const sourceProfileId = optStr(payload.sourceProfileId);
      if (!sourceProfileId) return;
      const [target, source] = await Promise.all([
        prisma.guestProfile.findUnique({ where: { id: input.entityId } }),
        prisma.guestProfile.findUnique({ where: { id: sourceProfileId } })
      ]);
      if (!target || !source) return;
      const sourcePreferences = (source.preferencesJson ?? {}) as Record<string, unknown>;
      const targetPreferences = (target.preferencesJson ?? {}) as Record<string, unknown>;
      await prisma.guestProfile.update({
        where: { id: target.id },
        data: {
          lifetimeValue: { increment: source.lifetimeValue },
          totalStays: { increment: source.totalStays },
          totalNights: { increment: source.totalNights },
          totalSpend: { increment: source.totalSpend },
          preferencesJson: toJson({ ...sourcePreferences, ...targetPreferences, mergedProfileIds: [source.id] })
        }
      });
      await prisma.guestProfile.update({
        where: { id: source.id },
        data: { preferencesJson: toJson({ ...sourcePreferences, mergedInto: target.id }) }
      });
      return;
    }
    default:
      return;
  }
}

type GenericAdvancedItem = {
  id: string;
  propertyId: string;
  moduleCode: string;
  entityType: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function prismaGenericItem(input: {
  id: string;
  propertyId: string;
  moduleCode: HotelModuleCode;
  entityType: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt?: Date | null;
}): GenericAdvancedItem {
  return {
    id: input.id,
    propertyId: input.propertyId,
    moduleCode: input.moduleCode,
    entityType: input.entityType,
    status: input.status,
    payload: input.payload,
    createdAt: input.createdAt.toISOString(),
    updatedAt: (input.updatedAt ?? input.createdAt).toISOString()
  };
}

/**
 * Prisma-backed reads for the migrated record types. Returns null for record
 * types that keep the legacy demoStore behaviour. Items are mapped to the
 * exact shapes the callers already consume: the generic
 * `{ id, status, payload, createdAt }` wrapper for the operations boards, and
 * the typed demoStore record shapes for the CRM/loyalty/events lists.
 */
async function listMigratedRecordsFromPrisma(
  propertyId: string,
  moduleCode: HotelModuleCode,
  recordType: string
): Promise<unknown[] | null> {
  const key = `${moduleCode}:${recordType}`;

  switch (key) {
    case "workforce_labor:schedule": {
      const rows = await prisma.shift.findMany({ where: { propertyId }, orderBy: { startAt: "asc" } });
      const names = await staffDisplayNamesByProfileId(rows.map((row) => row.staffProfileId));
      return rows.map((row) =>
        prismaGenericItem({
          id: row.id,
          propertyId: row.propertyId,
          moduleCode,
          entityType: "shift",
          status: row.status,
          payload: {
            staffProfileId: row.staffProfileId ?? undefined,
            staffName: row.staffProfileId ? names.get(row.staffProfileId) ?? row.staffProfileId : undefined,
            departmentId: row.departmentId ?? undefined,
            role: row.roleLabel ?? undefined,
            roleLabel: row.roleLabel ?? undefined,
            shiftDate: row.shiftDate.toISOString().slice(0, 10),
            startAt: row.startAt.toISOString(),
            endAt: row.endAt.toISOString(),
            status: row.status
          },
          createdAt: row.createdAt
        })
      );
    }
    case "workforce_labor:time_clock_entries": {
      const rows = await prisma.timeClockEntry.findMany({
        where: { propertyId },
        orderBy: { clockAt: "desc" },
        take: 500
      });
      const missingNames = rows
        .filter((row) => {
          const meta = row.metadataJson as Record<string, unknown> | null;
          return !(meta && typeof meta.staffName === "string");
        })
        .map((row) => row.staffProfileId);
      const names = await staffDisplayNamesByProfileId(missingNames);
      return rows.map((row) => {
        const meta = (row.metadataJson ?? {}) as Record<string, unknown>;
        const action = optStr(meta.action) ?? (row.clockType === "out" || row.clockType === "clock_out" || row.clockType === "end" ? "out" : "in");
        return prismaGenericItem({
          id: row.id,
          propertyId: row.propertyId,
          moduleCode,
          entityType: "time_clock_entry",
          status: action,
          payload: {
            ...meta,
            staffName: optStr(meta.staffName) ?? names.get(row.staffProfileId) ?? row.staffProfileId,
            action,
            at: row.clockAt.toISOString(),
            staffProfileId: row.staffProfileId,
            clockType: row.clockType,
            source: row.source ?? undefined
          },
          createdAt: row.createdAt
        });
      });
    }
    case "safety_incident_management:safety_incidents": {
      const rows = await prisma.safetyIncident.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } });
      return rows.map((row) =>
        prismaGenericItem({
          id: row.id,
          propertyId: row.propertyId,
          moduleCode,
          entityType: "safety_incident",
          status: row.status,
          payload: {
            title: row.title,
            severity: row.severity,
            incidentType: row.incidentType,
            description: row.description ?? undefined,
            location: row.locationEntityType === "label" ? row.locationEntityId ?? undefined : undefined,
            locationEntityType: row.locationEntityType ?? undefined,
            locationEntityId: row.locationEntityId ?? undefined,
            guestId: row.guestId ?? undefined,
            reservationId: row.reservationId ?? undefined,
            reportedBy: row.reportedBy ?? undefined,
            assignedTo: row.assignedTo ?? undefined,
            occurredAt: row.occurredAt ? row.occurredAt.toISOString() : undefined,
            resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : undefined,
            status: row.status
          },
          createdAt: row.createdAt,
          updatedAt: row.resolvedAt
        })
      );
    }
    case "safety_incident_management:safety_checks": {
      const rows = await prisma.safetyCheck.findMany({
        where: { propertyId },
        orderBy: [{ nextDueDate: "asc" }, { createdAt: "desc" }]
      });
      return rows.map((row) =>
        prismaGenericItem({
          id: row.id,
          propertyId: row.propertyId,
          moduleCode,
          entityType: "safety_check",
          status: row.active ? "active" : "inactive",
          payload: {
            title: row.title,
            name: row.title,
            checkType: row.checkType,
            frequency: row.frequency ?? undefined,
            locationEntityType: row.locationEntityType ?? undefined,
            locationEntityId: row.locationEntityId ?? undefined,
            assignedTo: row.assignedTo ?? undefined,
            nextDueDate: row.nextDueDate ? row.nextDueDate.toISOString() : undefined,
            active: row.active
          },
          createdAt: row.createdAt
        })
      );
    }
    case "reputation_quality:quality_cases": {
      const rows = await prisma.qualityCase.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } });
      return rows.map((row) =>
        prismaGenericItem({
          id: row.id,
          propertyId: row.propertyId,
          moduleCode,
          entityType: "quality_case",
          status: row.status,
          payload: {
            title: row.title,
            caseType: row.caseType,
            priority: row.priority,
            severity: row.priority,
            description: row.description ?? undefined,
            rootCause: row.rootCause ?? undefined,
            reservationId: row.reservationId ?? undefined,
            guestId: row.guestId ?? undefined,
            roomId: row.roomId ?? undefined,
            ownerUserId: row.ownerUserId ?? undefined,
            slaTargetAt: row.slaTargetAt ? row.slaTargetAt.toISOString() : undefined,
            resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : undefined,
            status: row.status
          },
          createdAt: row.createdAt,
          updatedAt: row.resolvedAt
        })
      );
    }
    case "reputation_quality:surveys": {
      const rows = await prisma.survey.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } });
      return rows.map((row) =>
        prismaGenericItem({
          id: row.id,
          propertyId: row.propertyId,
          moduleCode,
          entityType: "survey",
          status: row.active ? "active" : "archived",
          payload: {
            name: row.name,
            surveyType: row.surveyType,
            questionsJson: (row.questionsJson ?? []) as unknown as Record<string, unknown>,
            active: row.active
          },
          createdAt: row.createdAt
        })
      );
    }
    case "guest_data_crm_loyalty:crm_segments": {
      const rows = await prisma.crmSegment.findMany({
        where: { organizationId: demoStore.userContext.organizationId },
        orderBy: { createdAt: "desc" }
      });
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        description: row.description ?? undefined,
        rulesJson: (row.rulesJson ?? {}) as Record<string, unknown>,
        active: row.active,
        createdAt: row.createdAt.toISOString()
      }));
    }
    case "guest_data_crm_loyalty:crm_campaigns": {
      const rows = await prisma.crmCampaign.findMany({
        where: { organizationId: demoStore.userContext.organizationId },
        orderBy: { createdAt: "desc" }
      });
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        campaignType: row.campaignType,
        segmentId: row.segmentId ?? undefined,
        channel: row.channel,
        status: row.status,
        scheduleJson: (row.scheduleJson ?? {}) as Record<string, unknown>,
        contentJson: (row.contentJson ?? {}) as Record<string, unknown>,
        createdAt: row.createdAt.toISOString()
      }));
    }
    case "guest_data_crm_loyalty:loyalty": {
      const programs = await prisma.loyaltyProgram.findMany({
        where: { organizationId: demoStore.userContext.organizationId },
        orderBy: { createdAt: "desc" }
      });
      const memberships = programs.length === 0
        ? []
        : await prisma.loyaltyMembership.findMany({ where: { loyaltyProgramId: { in: programs.map((program) => program.id) } } });
      return programs.map((program) => ({
        id: program.id,
        organizationId: program.organizationId,
        name: program.name,
        configurationJson: (program.configurationJson ?? {}) as Record<string, unknown>,
        active: program.active,
        createdAt: program.createdAt.toISOString(),
        memberships: memberships
          .filter((membership) => membership.loyaltyProgramId === program.id)
          .map((membership) => ({
            id: membership.id,
            loyaltyProgramId: membership.loyaltyProgramId,
            guestProfileId: membership.guestProfileId,
            tier: membership.tier ?? undefined,
            pointsBalance: membership.pointsBalance,
            status: membership.status,
            joinedAt: membership.joinedAt.toISOString()
          }))
      }));
    }
    case "groups_events_sales:events_calendar": {
      const rows = await prisma.event.findMany({ where: { propertyId }, orderBy: { startAt: "asc" } });
      return rows.map((row) => ({
        id: row.id,
        propertyId: row.propertyId,
        groupBookingId: row.groupBookingId ?? undefined,
        eventSpaceId: row.eventSpaceId ?? undefined,
        name: row.name,
        eventType: row.eventType ?? undefined,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        status: row.status,
        setupJson: (row.setupJson ?? {}) as Record<string, unknown>,
        cateringJson: (row.cateringJson ?? {}) as Record<string, unknown>,
        createdAt: row.createdAt.toISOString()
      }));
    }
    default:
      return null;
  }
}

export async function transitionAdvancedRecord(input: AdvancedMutationInput & { entityId: string; status: string }) {
  requirePermissions(input.context, input.requiredPermissions);
  requireAdvancedModuleEnabled(input.propertyId, input.moduleCode);

  // Dual-write: apply the transition to Prisma first (shift updates, absence
  // approvals, incident/quality resolutions, CRM updates, profile merges…),
  // then run the legacy in-memory mutation below so both views stay in sync.
  await persistAdvancedTransitionToPrisma(input);

  const record = {
    id: input.entityId,
    propertyId: input.propertyId,
    moduleCode: input.moduleCode,
    entityType: input.entityType,
    status: input.status,
    payload: input.payload ?? {},
    updatedAt: nowIso()
  };

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_recommendation") {
    const recommendation = demoStore.revenueRecommendations.find(
      (candidate) => candidate.id === input.entityId && candidate.propertyId === input.propertyId
    );
    if (!recommendation) {
      throw new Error("Revenue recommendation was not found.");
    }
    const previousStatus = recommendation.status;
    if (input.status === "applied") {
      const appliedGridChanges = applyRevenueRecommendationToRateGrid(input, record.updatedAt);
      if (appliedGridChanges.status === "approvalRequired") {
        audit(
          {
            ...input,
            auditAction: "RevenueAutomationBlocked"
          },
          input.entityId,
          { ...recommendation, previousStatus, appliedGridChanges }
        );
        return { ...recommendation, previousStatus, appliedGridChanges };
      }
      recommendation.status = "applied";
      recommendation.appliedAt = record.updatedAt;
      audit(input, input.entityId, { ...recommendation, previousStatus, appliedGridChanges });
      return { ...recommendation, appliedGridChanges };
    }
    recommendation.status = input.status as typeof recommendation.status;
    if (input.status === "approved") {
      recommendation.approvedBy = input.context.userId;
    }
    if (input.status === "rejected") {
      recommendation.rejectedBy = input.context.userId;
    }
    audit(input, input.entityId, recommendation);
    return recommendation;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "revenue_automation_rule") {
    const rule = demoStore.revenueAutomationRules.find((candidate) => candidate.id === input.entityId && candidate.propertyId === input.propertyId);
    if (!rule) {
      throw new Error("Revenue automation rule was not found.");
    }
    if (input.status === "enabled") {
      rule.active = true;
    }
    if (input.status === "disabled") {
      rule.active = false;
    }
    rule.constraintsJson = {
      ...rule.constraintsJson,
      ...(input.payload?.constraintsJson as Record<string, unknown> | undefined)
    };
    audit(input, input.entityId, { ...rule, status: input.status, requiresConfirmation: true });
    return rule;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "channel") {
    const channel = demoStore.channels.find((candidate) => candidate.id === input.entityId && candidate.propertyId === input.propertyId);
    if (!channel) {
      throw new Error("Channel was not found.");
    }
    channel.status = input.status === "disabled" ? "inactive" : channel.status;
    channel.configurationJson = {
      ...channel.configurationJson,
      ...(input.payload?.configurationJson as Record<string, unknown> | undefined)
    };
    audit(input, input.entityId, { ...channel, status: input.status });
    return channel;
  }

  if (input.moduleCode === "revenue_profit_engine" && input.entityType === "demand_calendar_event") {
    const event = demoStore.demandCalendarEvents.find((candidate) => candidate.id === input.entityId && candidate.propertyId === input.propertyId);
    if (!event) {
      throw new Error("Demand calendar event was not found.");
    }
    event.metadataJson = { ...event.metadataJson, status: input.status, ...(input.payload ?? {}) };
    audit(input, input.entityId, event);
    return event;
  }

  if (input.moduleCode === "guest_data_crm_loyalty" && input.entityType === "guest_profile") {
    const targetProfile = demoStore.guestProfiles.find((profile) => profile.id === input.entityId);
    const sourceProfileId = typeof input.payload?.sourceProfileId === "string" ? input.payload.sourceProfileId : undefined;
    const sourceProfile = demoStore.guestProfiles.find((profile) => profile.id === sourceProfileId);
    if (!targetProfile) {
      throw new Error("Guest profile was not found.");
    }
    if (sourceProfile) {
      targetProfile.lifetimeValue += sourceProfile.lifetimeValue;
      targetProfile.totalStays += sourceProfile.totalStays;
      targetProfile.totalNights += sourceProfile.totalNights;
      targetProfile.totalSpend += sourceProfile.totalSpend;
      targetProfile.preferencesJson = {
        ...sourceProfile.preferencesJson,
        ...targetProfile.preferencesJson,
        mergedProfileIds: [sourceProfile.id]
      };
      sourceProfile.preferencesJson = { ...sourceProfile.preferencesJson, mergedInto: targetProfile.id };
    }
    targetProfile.updatedAt = record.updatedAt;
    audit(input, input.entityId, targetProfile);
    return targetProfile;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "group_booking") {
    const group = demoStore.groupBookings.find((candidate) => candidate.id === input.entityId);
    if (!group) {
      throw new Error("Group booking was not found.");
    }
    group.status = input.status as typeof group.status;
    if (input.status === "released") {
      demoStore.groupRoomBlocks
        .filter((block) => block.groupBookingId === group.id)
        .forEach((block) => {
          block.blockedCount = block.pickedUpCount;
        });
    }
    audit(input, input.entityId, group);
    return group;
  }

  if (input.moduleCode === "groups_events_sales" && input.entityType === "event") {
    const event = demoStore.hotelEvents.find((candidate) => candidate.id === input.entityId);
    if (!event) {
      throw new Error("Event was not found.");
    }
    event.status = input.status === "updated" ? event.status : (input.status as typeof event.status);
    event.setupJson = { ...event.setupJson, ...(input.payload?.setupJson as Record<string, unknown> | undefined) };
    event.cateringJson = { ...event.cateringJson, ...(input.payload?.cateringJson as Record<string, unknown> | undefined) };
    audit(input, input.entityId, event);
    return event;
  }

  if (input.moduleCode === "guest_data_crm_loyalty" && input.entityType === "crm_campaign") {
    const campaign = demoStore.crmCampaigns.find((candidate) => candidate.id === input.entityId);
    if (!campaign) {
      throw new Error("CRM campaign was not found.");
    }
    campaign.status = input.status === "updated" ? campaign.status : (input.status as typeof campaign.status);
    audit(input, input.entityId, campaign);
    return campaign;
  }

  // Generic transition: update the persisted advanced record so the change
  // round-trips to the boards (e.g. resolve a safety incident, approve an absence).
  const existing = demoStore.advancedRecords.find((r) => r.id === input.entityId);
  if (existing) {
    existing.status = input.status;
    existing.payload = { ...existing.payload, ...(input.payload ?? {}) };
    existing.updatedAt = record.updatedAt;
    audit(input, input.entityId, existing);
    return existing;
  }

  audit(input, input.entityId, record);
  return record;
}

export function validateAdvancedAiTool(input: {
  propertyId: string;
  toolName: HotelOsToolName;
  userPermissions: PermissionKey[];
}) {
  return canExecuteToolForModules({
    toolName: input.toolName,
    enabledModules: getEnabledModuleCodes(input.propertyId),
    userPermissions: input.userPermissions
  });
}
