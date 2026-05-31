export type CoreHotelModuleCode =
  | "pms_core"
  | "ai_front_desk"
  | "distribution_hub"
  | "ai_booking_engine"
  | "checkin_online"
  | "housekeeping"
  | "maintenance"
  | "erp_accounting"
  | "compliance_hub"
  | "compliance_billing"
  | "payment_vault"
  | "guest_experience"
  | "ai_concierge"
  | "asset_intelligence"
  | "capex_manager"
  | "outlet_pos"
  | "owner_mode"
  | "integration_marketplace"
  | "module_marketplace";

export type AdvancedHotelModuleCode =
  | "revenue_profit_engine"
  | "guest_data_crm_loyalty"
  | "groups_events_sales"
  | "workforce_labor"
  | "procurement_inventory"
  | "guest_self_service"
  | "reputation_quality"
  | "energy_sustainability"
  | "safety_incident_management"
  | "hotel_intelligence_platform"
  | "developer_platform"
  | "ai_governance"
  | "spain_guest_register_compliance"
  | "ai_onboarding_migration";

export type HotelModuleCode = CoreHotelModuleCode | AdvancedHotelModuleCode;

export const HOTEL_MODULE_CODES: HotelModuleCode[] = [
  "pms_core",
  "ai_front_desk",
  "distribution_hub",
  "ai_booking_engine",
  "checkin_online",
  "housekeeping",
  "maintenance",
  "erp_accounting",
  "compliance_hub",
  "compliance_billing",
  "payment_vault",
  "guest_experience",
  "ai_concierge",
  "asset_intelligence",
  "capex_manager",
  "outlet_pos",
  "owner_mode",
  "integration_marketplace",
  "module_marketplace",
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
  "spain_guest_register_compliance",
  "ai_onboarding_migration"
];
