import type { PermissionKey } from "@hotelos/shared";
import type { HotelModuleCode } from "./module-codes.js";

export type HotelModuleCategory =
  | "core"
  | "ai"
  | "operations"
  | "commercial"
  | "distribution"
  | "finance"
  | "compliance"
  | "guest"
  | "asset"
  | "integrations"
  | "analytics"
  | "platform";

export type HotelModuleManifest = {
  code: HotelModuleCode;
  name: string;
  category: HotelModuleCategory;
  description: string;
  isCore: boolean;
  dependencies: HotelModuleCode[];
  permissions: PermissionKey[];
  mobileRoutes: string[];
  adminRoutes?: string[];
};

export const CORE_HOTEL_MODULES: HotelModuleManifest[] = [
  {
    code: "pms_core",
    name: "PMS Core",
    category: "core",
    description: "Reservations, rooms, guests, stays, folios and front desk operations.",
    isCore: true,
    dependencies: [],
    permissions: ["pms.reservation.read", "pms.reservation.create"],
    mobileRoutes: ["Today", "Rooms", "Reservations"]
  },
  {
    code: "ai_front_desk",
    name: "AI Front Desk",
    category: "ai",
    description: "Voice, text and camera command center for reception operations.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["ai.tool.execute", "pms.checkin.execute"],
    mobileRoutes: ["AICommandCenter", "AIConfirmations"]
  },
  {
    code: "distribution_hub",
    name: "Distribution Hub",
    category: "distribution",
    description: "Availability, rates, restrictions, channel mappings, reservation imports and sync logs.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["distribution.read", "distribution.manage_rates", "distribution.manage_inventory", "distribution.sync"],
    mobileRoutes: ["DistributionDashboard", "RateGrid", "ChannelSyncLog"]
  },
  {
    code: "ai_booking_engine",
    name: "AI Booking Engine",
    category: "distribution",
    description: "Guest-facing availability quotes, reservation drafts, payment links and booking confirmations.",
    isCore: false,
    dependencies: ["pms_core", "payment_vault"],
    permissions: ["pms.reservation.create", "payments.create_link", "ai.tool.execute"],
    mobileRoutes: ["BookingEngine", "GuestWeb"]
  },
  {
    code: "checkin_online",
    name: "AI Check-in",
    category: "guest",
    description: "Online and assisted check-in with OCR, signature, compliance queue and audit trail.",
    isCore: false,
    dependencies: ["pms_core", "compliance_hub"],
    permissions: ["pms.checkin.execute", "compliance.ses.submit"],
    mobileRoutes: ["AICommandCenter", "AIConfirmation"]
  },
  {
    code: "housekeeping",
    name: "Housekeeping",
    category: "operations",
    description: "Room cleaning board, inspections, minibar notes, lost and found and offline task sync.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["housekeeping.task.manage"],
    mobileRoutes: ["Tasks", "HousekeepingBoard", "MobilePlanning"]
  },
  {
    code: "maintenance",
    name: "Maintenance",
    category: "operations",
    description: "Work orders, room blocking, media attachments, preventive maintenance and asset history.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["maintenance.workorder.manage"],
    mobileRoutes: ["Tasks", "MaintenanceBoard", "MobilePlanning"]
  },
  {
    code: "erp_accounting",
    name: "Accounting ERP",
    category: "finance",
    description: "Double-entry ledger, supplier bills, bank reconciliation, period close and annual accounts support.",
    isCore: false,
    dependencies: [],
    permissions: ["accounting.journal.post"],
    mobileRoutes: ["AccountingDashboard", "SupplierBills", "BankReconciliation"]
  },
  {
    code: "compliance_hub",
    name: "Compliance Hub",
    category: "compliance",
    description: "Spain guest register, signed entry forms, SES.HOSPEDAJES queue and compliance inbox.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["compliance.ses.submit"],
    mobileRoutes: ["ComplianceInbox"]
  },
  {
    code: "compliance_billing",
    name: "Compliance Billing",
    category: "compliance",
    description: "Immutable invoicing, rectifying invoices, Veri*FACTU-ready status and e-invoice adapters.",
    isCore: false,
    dependencies: ["pms_core", "erp_accounting", "compliance_hub"],
    permissions: ["billing.invoice.issue", "billing.invoice.cancel", "billing.invoice.rectify", "billing.compliance.view"],
    mobileRoutes: ["Invoices", "InvoiceDetail", "ComplianceInbox"]
  },
  {
    code: "payment_vault",
    name: "Payment Vault",
    category: "finance",
    description: "PSP connections, payment links, tokenized payments, SCA/3DS, deposits and refund approvals.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["payments.create_link", "payments.capture", "payments.refund_request", "payments.refund_approve"],
    mobileRoutes: ["Payments", "PaymentDetail"]
  },
  {
    code: "guest_experience",
    name: "Guest Experience",
    category: "guest",
    description: "Unified guest inbox, service requests, sentiment, surveys, upsells and complaint recovery.",
    isCore: false,
    dependencies: ["pms_core", "ai_concierge"],
    permissions: ["guest_experience.inbox.read", "guest_experience.message.send", "guest_experience.handoff"],
    mobileRoutes: ["GuestInbox", "ConversationDetail"]
  },
  {
    code: "ai_concierge",
    name: "AI Concierge",
    category: "ai",
    description: "Guest-facing AI replies, local recommendations, service request creation and human handoff.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["guest_experience.ai_reply", "ai.tool.execute"],
    mobileRoutes: ["GuestInbox", "ConversationDetail"]
  },
  {
    code: "asset_intelligence",
    name: "Asset Intelligence",
    category: "asset",
    description: "Room profitability, maintenance cost per room, warranties, certificates and condition scoring.",
    isCore: false,
    dependencies: ["maintenance", "erp_accounting"],
    permissions: ["assets.read", "assets.manage"],
    mobileRoutes: ["AssetRegister", "RoomProfitability"]
  },
  {
    code: "capex_manager",
    name: "Capex Manager",
    category: "asset",
    description: "Capex projects, renovation ROI, owner approvals and room or asset-linked investment plans.",
    isCore: false,
    dependencies: ["asset_intelligence", "erp_accounting"],
    permissions: ["capex.read", "capex.create", "capex.approve"],
    mobileRoutes: ["CapexProjects"]
  },
  {
    code: "outlet_pos",
    name: "Outlet POS",
    category: "finance",
    description: "Restaurant, bar, spa, parking, minibar, events, shop, transfers and room-charge orders.",
    isCore: false,
    dependencies: ["pms_core", "payment_vault"],
    permissions: ["pos.order.create", "pos.order.charge_to_room", "pos.order.pay"],
    mobileRoutes: ["OutletPOS"]
  },
  {
    code: "owner_mode",
    name: "Owner Mode",
    category: "asset",
    description: "Owner briefing, occupancy, ADR, RevPAR, cash, debtors, maintenance, compliance and capex summaries.",
    isCore: false,
    dependencies: ["pms_core", "erp_accounting", "maintenance", "asset_intelligence"],
    permissions: ["owner.dashboard.read", "owner.ai_ask"],
    mobileRoutes: ["OwnerDashboard", "OwnerBriefing"]
  },
  {
    code: "integration_marketplace",
    name: "Integration Marketplace",
    category: "integrations",
    description: "Provider catalog, connection status, test connection flow, sync logs and credential references.",
    isCore: false,
    dependencies: [],
    permissions: ["integrations.read", "integrations.connect", "integrations.disconnect", "integrations.test"],
    mobileRoutes: ["IntegrationMarketplace"]
  },
  {
    code: "module_marketplace",
    name: "Module Marketplace",
    category: "integrations",
    description: "Property-level module catalog, activation state and dependency-aware enablement.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["modules.read", "modules.enable", "modules.disable"],
    mobileRoutes: ["ModuleMarketplace"]
  }
];

export const ADVANCED_HOTEL_MODULES: HotelModuleManifest[] = [
  {
    code: "revenue_profit_engine",
    name: "Revenue & Profit Engine",
    category: "commercial",
    description: "Forecasting, dynamic pricing, channel management, restrictions, rate intelligence, demand prediction and profit optimization.",
    isCore: false,
    dependencies: ["pms_core", "distribution_hub", "payment_vault", "erp_accounting", "hotel_intelligence_platform"],
    permissions: [
      "revenue.read",
      "revenue.forecast.read",
      "revenue.recommend",
      "revenue.manage_rates",
      "revenue.manage_restrictions",
      "revenue.apply_recommendations",
      "revenue.automation.manage",
      "revenue.history_forecast.read",
      "revenue.history_forecast.export",
      "revenue.forecast_confidence.read",
      "revenue.comparison.read",
      "revenue.visual_alerts.read",
      "channel_manager.read",
      "channel_manager.manage",
      "channel_manager.sync",
      "channel_manager.mappings.manage"
    ],
    mobileRoutes: ["RevenueDashboard", "RevenueHistoryForecast", "RevenueVisualDashboard", "RevenueRecommendations", "RateGrid", "DemandCalendar", "ChannelManagerDashboard"],
    adminRoutes: ["RevenueSettings", "RevenueHistoryForecastDashboard", "RevenueHistoryForecastReport", "RevenueForecastExplorer", "RevenueComparisonDashboard", "RevenueExportCenter", "RevenueRules", "ChannelMappings", "AutomationRules", "RateShopperSettings"]
  },
  {
    code: "guest_data_crm_loyalty",
    name: "Guest Data, CRM & Loyalty",
    category: "guest",
    description: "Single guest profile, segmentation, campaigns, loyalty and personalization.",
    isCore: false,
    dependencies: ["pms_core", "guest_experience"],
    permissions: ["crm.read", "crm.manage_profiles", "crm.manage_campaigns", "crm.manage_loyalty"],
    mobileRoutes: ["GuestProfile360", "GuestInsights", "VIPArrivals"],
    adminRoutes: ["CRMSettings", "LoyaltySettings"]
  },
  {
    code: "groups_events_sales",
    name: "Groups, Events & Sales",
    category: "commercial",
    description: "Group bookings, allotments, event spaces, proposals, BEO and group billing.",
    isCore: false,
    dependencies: ["pms_core", "payment_vault", "erp_accounting"],
    permissions: ["groups.read", "groups.manage", "events.read", "events.manage", "sales.pipeline.manage"],
    mobileRoutes: ["GroupsDashboard", "EventsCalendar"],
    adminRoutes: ["EventSpacesSettings", "SalesSettings"]
  },
  {
    code: "workforce_labor",
    name: "Workforce & Labor",
    category: "operations",
    description: "Staff scheduling, time clock, labor forecasting, shift management and productivity.",
    isCore: false,
    dependencies: ["pms_core", "housekeeping", "maintenance"],
    permissions: ["workforce.read", "workforce.schedule.manage", "workforce.timeclock.manage", "workforce.labor_cost.view"],
    mobileRoutes: ["MyShifts", "LaborDashboard"],
    adminRoutes: ["WorkforceSettings", "SchedulingRules"]
  },
  {
    code: "procurement_inventory",
    name: "Procurement & Inventory",
    category: "finance",
    description: "Supplier management, purchase orders, stock, linen, minibar, spare parts and 3-way matching.",
    isCore: false,
    dependencies: ["erp_accounting", "payment_vault"],
    permissions: ["procurement.read", "procurement.manage", "inventory.read", "inventory.manage", "purchase_orders.approve"],
    mobileRoutes: ["InventoryDashboard", "StockCounts"],
    adminRoutes: ["ProcurementSettings", "SupplierSettings"]
  },
  {
    code: "guest_self_service",
    name: "Guest Self-Service",
    category: "guest",
    description: "Guest portal, mobile check-in/out, kiosk flows, digital key integrations and upsells.",
    isCore: false,
    dependencies: ["pms_core", "guest_experience", "payment_vault", "checkin_online"],
    permissions: ["guest_portal.configure", "guest_self_service.read", "guest_self_service.manage"],
    mobileRoutes: ["GuestPortalPreview"],
    adminRoutes: ["GuestPortalSettings", "KioskSettings"]
  },
  {
    code: "reputation_quality",
    name: "Reputation & Quality",
    category: "guest",
    description: "Review aggregation, sentiment analysis, surveys, quality cases and service recovery.",
    isCore: false,
    dependencies: ["guest_experience", "ai_concierge"],
    permissions: ["reputation.read", "reputation.respond", "quality_cases.manage", "surveys.manage"],
    mobileRoutes: ["ReputationDashboard", "QualityCases"],
    adminRoutes: ["ReputationSettings", "SurveySettings"]
  },
  {
    code: "energy_sustainability",
    name: "Energy & Sustainability",
    category: "asset",
    description: "Energy, water, waste, ESG, smart meter integrations and sustainability reporting.",
    isCore: false,
    dependencies: ["asset_intelligence", "maintenance"],
    permissions: ["energy.read", "energy.manage", "sustainability.read", "sustainability.report"],
    mobileRoutes: ["EnergyDashboard", "SustainabilityDashboard"],
    adminRoutes: ["EnergySettings", "SustainabilitySettings"]
  },
  {
    code: "safety_incident_management",
    name: "Safety & Incident Management",
    category: "operations",
    description: "Incident logs, emergency workflows, safety checks, insurance evidence and risk management.",
    isCore: false,
    dependencies: ["maintenance", "asset_intelligence"],
    permissions: ["incidents.read", "incidents.manage", "safety_checks.manage", "insurance_cases.manage"],
    mobileRoutes: ["IncidentLog", "SafetyChecks"],
    adminRoutes: ["SafetySettings", "IncidentSettings"]
  },
  {
    code: "hotel_intelligence_platform",
    name: "Hotel Intelligence Platform",
    category: "analytics",
    description: "Data warehouse, semantic metrics, BI, anomaly detection and natural-language analytics.",
    isCore: false,
    dependencies: ["pms_core", "erp_accounting", "owner_mode"],
    permissions: ["analytics.read", "analytics.export", "analytics.configure", "analytics.ai_ask"],
    mobileRoutes: ["AnalyticsDashboard"],
    adminRoutes: ["AnalyticsSettings", "MetricDefinitions"]
  },
  {
    code: "developer_platform",
    name: "Developer Platform",
    category: "platform",
    description: "Public API, OAuth apps, webhooks, sandbox, API logs and partner certification.",
    isCore: false,
    dependencies: ["integration_marketplace"],
    permissions: ["developer.read", "developer.manage_apps", "developer.manage_webhooks", "developer.view_api_logs"],
    mobileRoutes: [],
    adminRoutes: ["DeveloperPortal", "ApiApps", "Webhooks"]
  },
  {
    code: "ai_governance",
    name: "AI Governance",
    category: "ai",
    description: "AI policy center, tool governance, evaluations, prompt versioning, AI incidents and observability.",
    isCore: false,
    dependencies: ["ai_front_desk"],
    permissions: ["ai_governance.read", "ai_governance.configure", "ai_evals.manage", "ai_incidents.manage"],
    mobileRoutes: ["AiIncidentLog", "AiReviewQueue"],
    adminRoutes: ["AIGovernanceSettings", "AIToolRegistry", "AIEvals"]
  },
  {
    code: "spain_guest_register_compliance",
    name: "Spain Guest Register Compliance",
    category: "compliance",
    description:
      "Guest registration, entry forms, SES.HOSPEDAJES submissions, batch files, signatures, retention and GDPR-safe data minimisation for Spanish lodging compliance.",
    isCore: false,
    dependencies: ["pms_core", "checkin_online", "ai_front_desk", "compliance_hub"],
    permissions: [
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
      "compliance.ses.submit",
      "compliance.ses.export",
      "compliance.ses.configure"
    ],
    mobileRoutes: ["GuestRegisterInbox", "CheckInGuestRegister", "SesSubmissionQueue", "GuestRegisterDetail"],
    adminRoutes: [
      "GuestRegisterSettings",
      "SesHospedajesSettings",
      "AuthorityRoutingSettings",
      "GuestRegisterRetentionSettings",
      "GuestRegisterFieldMapping"
    ]
  },
  {
    code: "ai_onboarding_migration",
    name: "AI Onboarding & Migration",
    category: "platform",
    description: "AI-powered hotel setup, PMS migration, property mapping, data import, validation, dry-run and go-live readiness.",
    isCore: false,
    dependencies: ["pms_core", "module_marketplace", "integration_marketplace", "ai_front_desk", "hotel_intelligence_platform"],
    permissions: [
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
      "onboarding.manage_cutover"
    ],
    mobileRoutes: ["AISetupWizard", "OnboardingProject", "MigrationReview", "GoLiveReadiness"],
    adminRoutes: [
      "AISetupCenter",
      "OnboardingProjects",
      "SourceConnections",
      "ImportReview",
      "PropertyBlueprintReview",
      "MigrationBatches",
      "GoLiveReadiness",
      "CutoverAssistant"
    ]
  }
];

export const HOTEL_MODULES: HotelModuleManifest[] = [...CORE_HOTEL_MODULES, ...ADVANCED_HOTEL_MODULES];

export function getHotelModuleManifest(code: HotelModuleCode): HotelModuleManifest {
  const manifest = HOTEL_MODULES.find((module) => module.code === code);
  if (!manifest) {
    throw new Error(`Unknown HotelOS module: ${code}`);
  }

  return manifest;
}
