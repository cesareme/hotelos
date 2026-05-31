import { filterMobileNavigation, type MobileNavigationItem } from "@hotelos/product";
import type { HotelModuleCode } from "@hotelos/product";

export type MobileRouteKey =
  | "today"
  | "timeline"
  | "rooms"
  | "ai"
  | "operations"
  | "tasks"
  | "more"
  | "properties"
  | "pms"
  | "accounting"
  | "assets"
  | "concierge"
  | "compliance"
  | "notifications"
  | "sync"
  | "settings"
  | "owner"
  | "LocalDevLauncher"
  | "BackOfficePreview"
  | "ManualSetupPreview"
  | "SetupCenterPreview"
  | "PropertySetupPreview"
  | "CategoryManagerPreview"
  | "ConfigurationCenter"
  | "PropertyProfileForm"
  | "RoomTypeForm"
  | "RoomForm"
  | "SpaceResourceForm"
  | "CategoryOptionForm"
  | "ModuleMarketplace"
  | "IntegrationMarketplace"
  | "MarketplaceHome"
  | "ModuleVisibilityDebug"
  | "AISetupWizard"
  | "OnboardingProject"
  | "MigrationReview"
  | "GoLiveReadiness"
  | "UploadHotelData"
  | "PropertyBlueprintPreview"
  | "ReviewPendingMappings"
  | "LiveTimeline"
  | "GuestJourney"
  | "RevenueHome"
  | "RevenueDashboard"
  | "RevenueHistoryForecast"
  | "RevenueVisualDashboard"
  | "RevenueKPIDetail"
  | "RevenueForecastGraph"
  | "RevenueReportTable"
  | "RevenueRecommendations"
  | "RateGrid"
  | "DemandCalendar"
  | "ChannelManagerDashboard"
  | "ChannelManagerHome"
  | "ChannelSyncHealth"
  | "RateParityAlerts"
  | "ScenarioSimulator"
  | "RevenueSettings"
  | "modules"
  | "integrations"
  | "revenue"
  | "crm"
  | "groups"
  | "events"
  | "workforce"
  | "inventory"
  | "guestPortal"
  | "reputation"
  | "energy"
  | "safety"
  | "analytics"
  | "developer"
  | "aiGovernance"
  | "guestRegister";

export const DEFAULT_ENABLED_MODULES: HotelModuleCode[] = [
  "pms_core",
  "ai_front_desk",
  "housekeeping",
  "maintenance",
  "erp_accounting",
  "compliance_hub",
  "payment_vault",
  "guest_experience",
  "ai_concierge",
  "asset_intelligence",
  "module_marketplace",
  "integration_marketplace",
  "owner_mode",
  "distribution_hub",
  "compliance_billing",
  "capex_manager",
  "revenue_profit_engine",
  "guest_data_crm_loyalty",
  "groups_events_sales",
  "workforce_labor",
  "procurement_inventory",
  "guest_self_service",
  "reputation_quality",
  "energy_sustainability",
  "safety_incident_management",
  "hotel_intelligence_platform",
  "developer_platform",
  "ai_governance",
  "ai_onboarding_migration",
  "spain_guest_register_compliance"
];

export const DEFAULT_MOBILE_PERMISSIONS = [
  "pms.reservation.read",
  "ai.tool.execute",
  "housekeeping.task.manage",
  "maintenance.workorder.manage",
  "compliance.ses.submit",
  "compliance.ses.export",
  "compliance.ses.configure",
  "guest_register.read",
  "guest_register.create",
  "guest_register.edit",
  "guest_register.sign",
  "guest_register.submit",
  "guest_register.export",
  "guest_register.annul",
  "guest_register.correct",
  "guest_register.view_sensitive",
  "guest_register.configure",
  "modules.read",
  "modules.enable",
  "modules.configure",
  "integrations.read",
  "integrations.connect",
  "accounting.journal.post",
  "assets.read",
  "owner.dashboard.read",
  "revenue.read",
  "revenue.forecast.read",
  "revenue.recommend",
  "revenue.manage_rates",
  "revenue.manage_restrictions",
  "revenue.apply_recommendations",
  "revenue.history_forecast.read",
  "revenue.history_forecast.export",
  "revenue.forecast_confidence.read",
  "revenue.comparison.read",
  "revenue.visual_alerts.read",
  "channel_manager.read",
  "channel_manager.manage",
  "channel_manager.sync",
  "channel_manager.mappings.manage",
  "crm.read",
  "groups.read",
  "events.read",
  "workforce.read",
  "inventory.read",
  "guest_self_service.read",
  "guest_experience.inbox.read",
  "reputation.read",
  "energy.read",
  "incidents.read",
  "analytics.read",
  "developer.read",
  "ai_governance.read",
  "onboarding.read",
  "onboarding.create",
  "onboarding.upload",
  "onboarding.connect_source",
  "onboarding.ai_extract",
  "onboarding.ai_map",
  "onboarding.review",
  "onboarding.apply",
  "onboarding.rollback",
  "onboarding.go_live",
  "onboarding.view_sensitive",
  "onboarding.manage_cutover",
  "backoffice.access",
  "configuration.read",
  "configuration.manage",
  "categories.read",
  "categories.manage",
  "categories.import",
  "categories.export",
  "custom_fields.read",
  "custom_fields.manage",
  "property_profile.edit",
  "room_types.manage",
  "rooms.manage",
  "spaces.manage",
  "departments.manage",
  "operations_setup.manage",
  "revenue_setup.manage",
  "compliance_setup.manage",
  "ai_category_setup.use",
  "property.configure",
  "property.map.read",
  "audit.read"
];

export function getVisibleMobileRoutes(input?: {
  enabledModules?: HotelModuleCode[];
  userPermissions?: string[];
}): MobileNavigationItem[] {
  return filterMobileNavigation({
    enabledModules: input?.enabledModules ?? DEFAULT_ENABLED_MODULES,
    userPermissions: input?.userPermissions ?? DEFAULT_MOBILE_PERMISSIONS
  });
}

export function isRouteVisible(route: string, input?: { enabledModules?: HotelModuleCode[]; userPermissions?: string[] }): boolean {
  return getVisibleMobileRoutes(input).some((item) => item.route === route);
}
