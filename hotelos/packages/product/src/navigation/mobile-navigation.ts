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

// Labels are shown as-is in apps/mobile (internal demo until L7): Spanish, with
// the same wording as the admin menu (pilots/tanda5-nav-tree.csv) where the
// screen exists on both surfaces. `route` values are apps/mobile screen names.
export const MOBILE_NAVIGATION: MobileNavigationItem[] = [
  { tab: "Hoy", label: "Hoy", route: "TodayDashboard", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "Timeline", label: "Cronograma", route: "LiveTimeline", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "Timeline", label: "Planificación", route: "MobilePlanning", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "IA", label: "Centro de mando IA", route: "AICommandCenter", moduleCode: "ai_front_desk", requiredPermissions: ["ai.tool.execute"] },
  { tab: "Operaciones", label: "Pisos", route: "HousekeepingBoard", moduleCode: "housekeeping", requiredPermissions: ["housekeeping.task.manage"] },
  { tab: "Operaciones", label: "Mantenimiento", route: "MaintenanceBoard", moduleCode: "maintenance", requiredPermissions: ["maintenance.workorder.manage"] },
  { tab: "Operaciones", label: "Cumplimiento", route: "ComplianceInbox", moduleCode: "compliance_hub", requiredPermissions: ["compliance.ses.submit"] },
  { tab: "Operaciones", label: "Registro de viajeros", route: "GuestRegisterInbox", moduleCode: "spain_guest_register_compliance", requiredPermissions: ["guest_register.read"] },
  { tab: "Operaciones", label: "Cola SES", route: "SesSubmissionQueue", moduleCode: "spain_guest_register_compliance", requiredPermissions: ["guest_register.submit"] },
  { tab: "Operaciones", label: "Parte de entrada", route: "CheckInGuestRegister", moduleCode: "spain_guest_register_compliance", requiredPermissions: ["guest_register.create"] },
  { tab: "Mas", label: "Reservas", route: "Reservations", moduleCode: "pms_core", requiredPermissions: ["pms.reservation.read"] },
  { tab: "Mas", label: "Pagos", route: "Payments", moduleCode: "payment_vault", requiredPermissions: ["payments.create_link"] },
  { tab: "Mas", label: "Facturas", route: "Invoices", moduleCode: "compliance_billing", requiredPermissions: ["billing.compliance.view"] },
  { tab: "Mas", label: "Contabilidad", route: "AccountingDashboard", moduleCode: "erp_accounting", requiredPermissions: ["accounting.journal.post"] },
  { tab: "Mas", label: "Activos", route: "AssetRegister", moduleCode: "asset_intelligence", requiredPermissions: ["assets.read"] },
  { tab: "Mas", label: "Inversiones", route: "CapexProjects", moduleCode: "capex_manager", requiredPermissions: ["capex.read"] },
  { tab: "Mas", label: "Distribución", route: "DistributionDashboard", moduleCode: "distribution_hub", requiredPermissions: ["distribution.read"] },
  { tab: "Mas", label: "Punto de venta", route: "OutletPOS", moduleCode: "outlet_pos", requiredPermissions: ["pos.order.create"] },
  { tab: "Mas", label: "Integraciones", route: "IntegrationMarketplace", moduleCode: "integration_marketplace", requiredPermissions: ["integrations.read"] },
  { tab: "Mas", label: "Módulos", route: "ModuleMarketplace", moduleCode: "module_marketplace", requiredPermissions: ["modules.read"] },
  { tab: "Mas", label: "Asistente de puesta en marcha", route: "AISetupWizard", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.read"] },
  { tab: "Mas", label: "Proyecto de migración", route: "OnboardingProject", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.read"] },
  { tab: "Mas", label: "Revisión de migración", route: "MigrationReview", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.review"] },
  { tab: "Mas", label: "Salida en vivo", route: "GoLiveReadiness", moduleCode: "ai_onboarding_migration", requiredPermissions: ["onboarding.go_live"] },
  { tab: "Mas", label: "Propietario", route: "OwnerDashboard", moduleCode: "owner_mode", requiredPermissions: ["owner.dashboard.read"] },
  { tab: "Mas", label: "Revenue", route: "RevenueDashboard", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.read"] },
  { tab: "Mas", label: "Histórico y previsión", route: "RevenueHistoryForecast", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.history_forecast.read"] },
  { tab: "Mas", label: "Panel visual de revenue", route: "RevenueVisualDashboard", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.history_forecast.read"] },
  { tab: "Mas", label: "Recomendaciones de revenue", route: "RevenueRecommendations", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.recommend"] },
  { tab: "Mas", label: "Parrilla de tarifas", route: "RateGrid", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.manage_rates"] },
  { tab: "Mas", label: "Calendario de demanda", route: "DemandCalendar", moduleCode: "revenue_profit_engine", requiredPermissions: ["revenue.forecast.read"] },
  { tab: "Mas", label: "Canales de venta", route: "ChannelManagerDashboard", moduleCode: "revenue_profit_engine", requiredPermissions: ["channel_manager.read"] },
  { tab: "Mas", label: "Recorrido del huésped", route: "GuestJourney", moduleCode: "guest_experience", requiredPermissions: ["guest_experience.inbox.read"] },
  { tab: "Mas", label: "Clientes", route: "GuestProfile360", moduleCode: "guest_data_crm_loyalty", requiredPermissions: ["crm.read"] },
  { tab: "Mas", label: "Grupos", route: "GroupsDashboard", moduleCode: "groups_events_sales", requiredPermissions: ["groups.read"] },
  { tab: "Mas", label: "Eventos", route: "EventsCalendar", moduleCode: "groups_events_sales", requiredPermissions: ["events.read"] },
  { tab: "Mas", label: "Personal y turnos", route: "MyShifts", moduleCode: "workforce_labor", requiredPermissions: ["workforce.read"] },
  { tab: "Mas", label: "Inventario", route: "InventoryDashboard", moduleCode: "procurement_inventory", requiredPermissions: ["inventory.read"] },
  { tab: "Mas", label: "Portal del huésped", route: "GuestPortalPreview", moduleCode: "guest_self_service", requiredPermissions: ["guest_self_service.read"] },
  { tab: "Mas", label: "Reputación", route: "ReputationDashboard", moduleCode: "reputation_quality", requiredPermissions: ["reputation.read"] },
  { tab: "Mas", label: "Energía y agua", route: "EnergyDashboard", moduleCode: "energy_sustainability", requiredPermissions: ["energy.read"] },
  { tab: "Mas", label: "Seguridad e incidentes", route: "IncidentLog", moduleCode: "safety_incident_management", requiredPermissions: ["incidents.read"] },
  { tab: "Mas", label: "Analítica", route: "AnalyticsDashboard", moduleCode: "hotel_intelligence_platform", requiredPermissions: ["analytics.read"] },
  { tab: "Mas", label: "Desarrolladores", route: "DeveloperPortal", moduleCode: "developer_platform", requiredPermissions: ["developer.read"] },
  { tab: "Mas", label: "Gobernanza de la IA", route: "AIGovernanceSettings", moduleCode: "ai_governance", requiredPermissions: ["ai_governance.read"] }
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
