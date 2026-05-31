import type { HotelModuleCode } from "../modules/module-codes.js";

export type MobileSuiteTab = "Hoy" | "Timeline" | "IA" | "Operaciones" | "Mas";

export type MobileNavigationItem = {
  tab: MobileSuiteTab;
  label: string;
  route: string;
  moduleCode: HotelModuleCode;
  requiredPermissions: string[];
};

export const MOBILE_SUITE_TABS: MobileSuiteTab[] = ["Hoy", "Timeline", "IA", "Operaciones", "Mas"];

export const MOBILE_NAVIGATION: MobileNavigationItem[] = [
  { tab: "Hoy", label: "Hoy", route: "TodayDashboard", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "Timeline", label: "Live Timeline", route: "LiveTimeline", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "Timeline", label: "Planning", route: "MobilePlanning", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "IA", label: "AI Command Center", route: "AICommandCenter", moduleCode: "ai_front_desk", requiredPermissions: ["ai.tool.execute"] },
  { tab: "Operaciones", label: "Housekeeping", route: "HousekeepingBoard", moduleCode: "housekeeping", requiredPermissions: ["housekeeping.task.manage"] },
  { tab: "Operaciones", label: "Maintenance", route: "MaintenanceBoard", moduleCode: "maintenance", requiredPermissions: ["maintenance.workorder.manage"] },
  { tab: "Operaciones", label: "Compliance", route: "ComplianceInbox", moduleCode: "compliance_hub", requiredPermissions: ["compliance.ses.submit"] },
  { tab: "Operaciones", label: "Guest Register", route: "GuestRegisterInbox", moduleCode: "spain_guest_register_compliance", requiredPermissions: ["guest_register.read"] },
  { tab: "Operaciones", label: "SES Queue", route: "SesSubmissionQueue", moduleCode: "spain_guest_register_compliance", requiredPermissions: ["guest_register.submit"] },
  { tab: "Operaciones", label: "Check-in Register", route: "CheckInGuestRegister", moduleCode: "spain_guest_register_compliance", requiredPermissions: ["guest_register.create"] },
  { tab: "Mas", label: "PMS", route: "Reservations", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "Mas", label: "Payments", route: "Payments", moduleCode: "payment_vault", requiredPermissions: ["payments.create_link"] },
  { tab: "Mas", label: "Invoices", route: "Invoices", moduleCode: "compliance_billing", requiredPermissions: ["billing.compliance.view"] },
  { tab: "Mas", label: "Accounting", route: "AccountingDashboard", moduleCode: "erp_accounting", requiredPermissions: ["accounting.journal.post"] },
  { tab: "Mas", label: "Assets", route: "AssetRegister", moduleCode: "asset_intelligence", requiredPermissions: ["assets.read"] },
  { tab: "Mas", label: "Capex", route: "CapexProjects", moduleCode: "capex_manager", requiredPermissions: ["capex.read"] },
  { tab: "Mas", label: "Distribution", route: "DistributionDashboard", moduleCode: "distribution_hub", requiredPermissions: ["distribution.read"] },
  { tab: "Mas", label: "POS", route: "OutletPOS", moduleCode: "outlet_pos", requiredPermissions: ["pos.order.create"] },
  { tab: "Mas", label: "Integrations", route: "IntegrationMarketplace", moduleCode: "integration_marketplace", requiredPermissions: ["integrations.read"] },
  { tab: "Mas", label: "Modules", route: "ModuleMarketplace", moduleCode: "module_marketplace", requiredPermissions: ["modules.read"] },
  { tab: "Mas", label: "AI Setup Wizard", route: "AISetupWizard", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.read"] },
  { tab: "Mas", label: "Onboarding Project", route: "OnboardingProject", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.read"] },
  { tab: "Mas", label: "Migration Review", route: "MigrationReview", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.review"] },
  { tab: "Mas", label: "Go-Live Readiness", route: "GoLiveReadiness", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.go_live"] },
  { tab: "Mas", label: "Owner Mode", route: "OwnerDashboard", moduleCode: "owner_mode", requiredPermissions: ["owner.dashboard.read"] },
  { tab: "Mas", label: "Revenue", route: "RevenueDashboard", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.read"] },
  { tab: "Mas", label: "History and Forecast", route: "RevenueHistoryForecast", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.history_forecast.read"] },
  { tab: "Mas", label: "Visual Revenue Dashboard", route: "RevenueVisualDashboard", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.history_forecast.read"] },
  { tab: "Mas", label: "Revenue Recommendations", route: "RevenueRecommendations", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.recommend"] },
  { tab: "Mas", label: "Rate Grid", route: "RateGrid", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.manage_rates"] },
  { tab: "Mas", label: "Demand Calendar", route: "DemandCalendar", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.forecast.read"] },
  { tab: "Mas", label: "Channel Manager", route: "ChannelManagerDashboard", moduleCode: "revenue_profit_engine", requiredPermissions: ["channel_manager.read"] },
  { tab: "Mas", label: "Guest Journey", route: "GuestJourney", moduleCode: "guest_experience", requiredPermissions: ["guest_experience.inbox.read"] },
  { tab: "Mas", label: "CRM", route: "GuestProfile360", moduleCode: "guest_data_crm_loyalty", requiredPermissions: ["crm.read"] },
  { tab: "Mas", label: "Groups", route: "GroupsDashboard", moduleCode: "groups_events_sales", requiredPermissions: ["groups.read"] },
  { tab: "Mas", label: "Events", route: "EventsCalendar", moduleCode: "groups_events_sales", requiredPermissions: ["events.read"] },
  { tab: "Mas", label: "Workforce", route: "MyShifts", moduleCode: "workforce_labor", requiredPermissions: ["workforce.read"] },
  { tab: "Mas", label: "Inventory", route: "InventoryDashboard", moduleCode: "procurement_inventory", requiredPermissions: ["inventory.read"] },
  { tab: "Mas", label: "Guest Portal", route: "GuestPortalPreview", moduleCode: "guest_self_service", requiredPermissions: ["guest_self_service.read"] },
  { tab: "Mas", label: "Reputation", route: "ReputationDashboard", moduleCode: "reputation_quality", requiredPermissions: ["reputation.read"] },
  { tab: "Mas", label: "Energy", route: "EnergyDashboard", moduleCode: "energy_sustainability", requiredPermissions: ["energy.read"] },
  { tab: "Mas", label: "Safety", route: "IncidentLog", moduleCode: "safety_incident_management", requiredPermissions: ["incidents.read"] },
  { tab: "Mas", label: "Analytics", route: "AnalyticsDashboard", moduleCode: "hotel_intelligence_platform", requiredPermissions: ["analytics.read"] },
  { tab: "Mas", label: "Developer", route: "DeveloperPortal", moduleCode: "developer_platform", requiredPermissions: ["developer.read"] },
  { tab: "Mas", label: "AI Governance", route: "AIGovernanceSettings", moduleCode: "ai_governance", requiredPermissions: ["ai_governance.read"] }
];

export function filterMobileNavigation(input: {
  enabledModules: HotelModuleCode[];
  userPermissions: string[];
}): MobileNavigationItem[] {
  return MOBILE_NAVIGATION.filter(
    (item) =>
      input.enabledModules.includes(item.moduleCode) &&
      item.requiredPermissions.every((permission) => input.userPermissions.includes(permission))
  );
}
