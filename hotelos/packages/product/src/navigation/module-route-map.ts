import type { HotelModuleCode } from "../modules/module-codes.js";

export type ModuleRouteMapItem = {
  label: string;
  route?: string;
  path?: string;
  permission: string;
  description?: string;
  status?: "ready" | "needs_setup" | "coming_soon";
};

export type ModuleRouteMapEntry = {
  mobile: ModuleRouteMapItem[];
  admin: ModuleRouteMapItem[];
};

export const MODULE_ROUTE_MAP: Partial<Record<HotelModuleCode | "backoffice", ModuleRouteMapEntry>> = {
  pms_core: {
    mobile: [
      { label: "Reservations", route: "Reservations", permission: "pms.reservation.read", description: "Create and manage stays, guests, folios and operational status.", status: "ready" },
      { label: "Create Reservation", route: "CreateReservation", permission: "pms.reservation.create", description: "Quote availability, select room/resource, capture guest details and confirm.", status: "ready" },
      { label: "Reservation Reports", route: "ReservationReports", permission: "analytics.read", description: "Arrivals, departures, cancellations, no-shows and pickup.", status: "ready" }
    ],
    admin: [
      { label: "Reservations", path: "/backoffice/reservations", permission: "pms.reservation.read", description: "Reservation workspace with guest, journey, folio and actions.", status: "ready" },
      { label: "Create Reservation", path: "/backoffice/reservations/new", permission: "pms.reservation.create", description: "Manual reservation creation connected to PMS APIs and categories.", status: "ready" },
      { label: "Reservation Reports", path: "/backoffice/reports/reservations", permission: "analytics.read", description: "Operational reservation reporting and export.", status: "ready" }
    ]
  },
  compliance_billing: {
    mobile: [
      { label: "Invoices", route: "Invoices", permission: "billing.compliance.view", description: "Folio, invoice and tax compliance review.", status: "ready" },
      { label: "Billing Reports", route: "BillingReports", permission: "analytics.read", description: "Invoice, payment and balance reporting.", status: "ready" }
    ],
    admin: [
      { label: "Billing Center", path: "/backoffice/billing/center", permission: "billing.compliance.view", description: "Folio charges, payments, invoice drafts and issue workflow.", status: "ready" },
      { label: "Invoices", path: "/backoffice/billing/invoices", permission: "invoice.issue", description: "Invoice draft, issue, cancel and rectifying workflow.", status: "ready" },
      { label: "Billing Reports", path: "/backoffice/reports/billing", permission: "analytics.read", description: "Billing reports and exports.", status: "ready" }
    ]
  },
  hotel_intelligence_platform: {
    mobile: [
      { label: "Reports", route: "Reports", permission: "analytics.read", description: "Operational, revenue, billing and owner reports.", status: "ready" }
    ],
    admin: [
      { label: "Reports Center", path: "/backoffice/reports", permission: "analytics.read", description: "All report catalogs, report data and export workflow.", status: "ready" },
      { label: "Reservation Reports", path: "/backoffice/reports/reservations", permission: "analytics.read", description: "Reservation KPIs and detailed reporting.", status: "ready" },
      { label: "Billing Reports", path: "/backoffice/reports/billing", permission: "analytics.read", description: "Invoices, payments, folio balances and tax totals.", status: "ready" }
    ]
  },
  backoffice: {
    mobile: [
      { label: "Back Office", route: "BackOfficePreview", permission: "backoffice.access", description: "Configure property, modules, integrations, compliance and users.", status: "ready" },
      { label: "Setup Center", route: "SetupCenterPreview", permission: "backoffice.access", description: "Guided setup progress, missing items, module health and go-live readiness.", status: "ready" },
      { label: "Manual Setup Center", route: "ManualSetupPreview", permission: "configuration.read", description: "All hotel-entered setup options with route, endpoint, permission and required fields.", status: "ready" },
      { label: "Configuration Center", route: "ConfigurationCenter", permission: "configuration.read", description: "Categories, custom fields, rooms, resources, departments and setup forms.", status: "ready" },
      { label: "Category Manager", route: "CategoryManagerPreview", permission: "categories.read", description: "Manage operational taxonomy, templates, import/export and AI category previews.", status: "ready" },
      { label: "Manual Setup / Property Setup", route: "PropertySetupPreview", permission: "property.configure", description: "Enter hotel data manually: legal profile, mapper input categories, rooms, spaces and resources.", status: "ready" },
      { label: "Module Marketplace", route: "ModuleMarketplace", permission: "modules.read", description: "Enable, configure and check module health.", status: "ready" },
      { label: "Integration Marketplace", route: "MarketplaceHome", permission: "integrations.read", description: "Connect channels, payments, messaging and government adapters.", status: "ready" },
      { label: "Users & Roles", route: "BackOfficePreview", permission: "users.read", description: "Invite users and review role access.", status: "needs_setup" }
    ],
    admin: [
      { label: "Dashboard", path: "/backoffice", permission: "backoffice.access", description: "Hotel setup and go-live control center.", status: "ready" },
      { label: "Setup Center", path: "/backoffice/setup", permission: "backoffice.access", description: "Guided setup center with readiness and health.", status: "ready" },
      { label: "Manual Setup Center", path: "/backoffice/manual-setup", permission: "configuration.read", description: "Every manual hotel input route, endpoint, permission and target table.", status: "ready" },
      { label: "Configuration Center", path: "/backoffice/configuration", permission: "configuration.read", description: "Property forms, categories, custom fields and data quality.", status: "ready" },
      { label: "Category Manager", path: "/backoffice/configuration/categories", permission: "categories.read", description: "Manage category options, templates and import/export.", status: "ready" },
      { label: "Custom Fields", path: "/backoffice/configuration/custom-fields", permission: "custom_fields.read", description: "Property-specific fields for rooms, guests, reservations and assets.", status: "ready" },
      { label: "Property Setup", path: "/backoffice/property-setup", permission: "property.configure", description: "Manual setup forms for property, rooms, resources, operations, revenue and compliance.", status: "ready" },
      { label: "Property Profile Form", path: "/backoffice/property-setup/property-profile", permission: "property_profile.edit", description: "Legal profile, tax identity, address and business date rules.", status: "ready" },
      { label: "Room Forms", path: "/backoffice/property-setup/rooms", permission: "rooms.manage", description: "Create rooms and map them to type, building, floor and zone.", status: "ready" },
      { label: "Space & Resource Forms", path: "/backoffice/property-setup/spaces-resources", permission: "spaces.manage", description: "Create parking, meeting rooms, outlets and other resources.", status: "ready" },
      { label: "Module Manager", path: "/backoffice/modules", permission: "modules.read", description: "Marketplace, active modules and health.", status: "ready" },
      { label: "Integration Marketplace", path: "/backoffice/marketplace", permission: "integrations.read", description: "Provider categories, setup wizard and health.", status: "ready" }
    ]
  },
  revenue_profit_engine: {
    mobile: [
      { label: "Revenue Management", route: "RevenueHome", permission: "revenue.read", description: "Forecasts, KPIs, recommendations and pricing.", status: "ready" },
      { label: "History & Forecast", route: "RevenueHistoryForecast", permission: "revenue.history_forecast.read", description: "Historical and future performance by period.", status: "ready" },
      { label: "Rate Grid", route: "RateGrid", permission: "revenue.manage_rates", description: "Manage prices, availability and restrictions.", status: "ready" },
      { label: "Forecast", route: "RevenueForecastGraph", permission: "revenue.forecast.read", description: "Forecast graphs and confidence drivers.", status: "ready" },
      { label: "Recommendations", route: "RevenueRecommendations", permission: "revenue.recommend", description: "Review AI revenue actions before applying.", status: "ready" },
      { label: "Channel Manager", route: "ChannelManagerHome", permission: "channel_manager.read", description: "Sync rates, inventory and OTA reservations.", status: "ready" },
      { label: "Channel Mappings", route: "ChannelManagerHome", permission: "channel_manager.mappings.manage", description: "Map internal resources and rate plans to OTA room and rate codes.", status: "ready" },
      { label: "Demand Calendar", route: "DemandCalendar", permission: "revenue.forecast.read", description: "Events, compression dates and demand signals.", status: "ready" },
      { label: "Rate Shopper", route: "RateParityAlerts", permission: "revenue.read", description: "Competitor and parity monitoring.", status: "needs_setup" },
      { label: "Parity Alerts", route: "RateParityAlerts", permission: "channel_manager.read", description: "OTA/direct price mismatch alerts.", status: "ready" },
      { label: "Scenario Simulator", route: "ScenarioSimulator", permission: "revenue.recommend", description: "What-if pricing and restriction analysis.", status: "ready" },
      { label: "Data Quality", route: "RevenueSettings", permission: "revenue.read", description: "Readiness checks for snapshots, mappings, rate plans and forecast confidence.", status: "ready" }
    ],
    admin: [
      { label: "Revenue Management", path: "/backoffice/revenue", permission: "revenue.read", description: "Commercial command center.", status: "ready" },
      { label: "History & Forecast", path: "/backoffice/revenue/history-forecast", permission: "revenue.history_forecast.read", description: "KPI cards, charts and report table.", status: "ready" },
      { label: "Rate Grid", path: "/backoffice/revenue/rate-grid", permission: "revenue.manage_rates", description: "Rates, inventory and restrictions.", status: "ready" },
      { label: "Recommendations", path: "/backoffice/revenue/recommendations", permission: "revenue.recommend", description: "Approve, reject and simulate recommendations.", status: "ready" },
      { label: "Forecast Explorer", path: "/backoffice/revenue/forecast-explorer", permission: "revenue.forecast.read", description: "Forecast confidence and drivers.", status: "ready" },
      { label: "Demand Calendar", path: "/backoffice/revenue/demand-calendar", permission: "revenue.forecast.read", description: "Demand events and market signals.", status: "ready" },
      { label: "Scenario Simulator", path: "/backoffice/revenue/scenario-simulator", permission: "revenue.recommend", description: "What-if commercial analysis.", status: "coming_soon" },
      { label: "Revenue Settings", path: "/backoffice/revenue/settings", permission: "revenue.configure", description: "Rules, constraints and automation thresholds.", status: "ready" },
      { label: "Data Quality", path: "/backoffice/revenue/data-quality", permission: "revenue.read", description: "Readiness checks before recommendations.", status: "ready" }
    ]
  },
  distribution_hub: {
    mobile: [
      { label: "Channel Manager", route: "ChannelManagerHome", permission: "channel_manager.read", description: "Connected channels, mappings and sync health.", status: "ready" },
      { label: "Channel Sync Health", route: "ChannelSyncHealth", permission: "channel_manager.read", description: "Failed pushes, retries and mapping blockers.", status: "ready" },
      { label: "Parity Alerts", route: "RateParityAlerts", permission: "channel_manager.read", description: "Price parity and undercutting alerts.", status: "ready" }
    ],
    admin: [
      { label: "Channel Manager", path: "/backoffice/channel-manager", permission: "channel_manager.read", description: "Channels, mappings and ARI sync.", status: "ready" },
      { label: "Channels", path: "/backoffice/channel-manager/channels", permission: "channel_manager.manage", description: "Connect Booking.com, Expedia, Google and direct.", status: "ready" },
      { label: "Mappings", path: "/backoffice/channel-manager/mappings", permission: "channel_manager.mappings.manage", description: "Internal room/rate plan to OTA mapping.", status: "ready" },
      { label: "Sync Health", path: "/backoffice/channel-manager/sync-health", permission: "channel_manager.read", description: "ARI jobs, retry queue and failures.", status: "ready" },
      { label: "Parity Alerts", path: "/backoffice/channel-manager/parity-alerts", permission: "channel_manager.read", description: "Direct vs OTA price mismatch alerts.", status: "ready" }
    ]
  },
  guest_experience: {
    mobile: [
      { label: "Guest Journey", route: "GuestJourney", permission: "guest_experience.inbox.read", description: "Booked to post-stay journey, blocked steps and next best actions.", status: "ready" },
      { label: "Guest Inbox", route: "concierge", permission: "guest_experience.inbox.read", description: "Guest messages, AI disclosure and handoff.", status: "ready" }
    ],
    admin: [
      { label: "Guest Journey", path: "/backoffice/guest-journey", permission: "guest_experience.inbox.read", description: "Portfolio-grade guest journey workspace.", status: "ready" }
    ]
  },
  integration_marketplace: {
    mobile: [
      { label: "Marketplace", route: "MarketplaceHome", permission: "integrations.read", description: "Modules and integrations as first-class product surfaces.", status: "ready" }
    ],
    admin: [
      { label: "Marketplace", path: "/backoffice/marketplace", permission: "integrations.read", description: "Integration categories, provider cards and setup wizards.", status: "ready" }
    ]
  },
  ai_onboarding_migration: {
    mobile: [
      { label: "AI Setup Wizard", route: "AISetupWizard", permission: "onboarding.read", description: "Upload what you have. HotelOS AI extracts, maps and previews setup before approval.", status: "ready" },
      { label: "Onboarding Project", route: "OnboardingProject", permission: "onboarding.read", description: "Review source files, extracted entities, mappings and migration progress.", status: "ready" },
      { label: "Migration Review", route: "MigrationReview", permission: "onboarding.review", description: "Approve, reject or edit low-confidence mappings before dry-run.", status: "ready" },
      { label: "Go-Live Readiness", route: "GoLiveReadiness", permission: "onboarding.go_live", description: "Blocking issues, cutover checklist and final approval status.", status: "ready" }
    ],
    admin: [
      { label: "AI Setup Center", path: "/backoffice/ai-setup", permission: "onboarding.read", description: "AI onboarding command center and project overview.", status: "ready" },
      { label: "Onboarding Projects", path: "/backoffice/onboarding/projects", permission: "onboarding.read", description: "All migration projects, source systems and go-live targets.", status: "ready" },
      { label: "Source Connections", path: "/backoffice/onboarding/source-connections", permission: "onboarding.connect_source", description: "Mews, OPERA/OHIP, Cloudbeds, Apaleo and generic import connectors.", status: "ready" },
      { label: "Import Review", path: "/backoffice/onboarding/import-review", permission: "onboarding.review", description: "Classified files, extracted tables and source references.", status: "ready" },
      { label: "Property Blueprint Review", path: "/backoffice/onboarding/property-blueprint", permission: "onboarding.review", description: "Buildings, floors, rooms, spaces, inventory resources and room types.", status: "ready" },
      { label: "Migration Batches", path: "/backoffice/onboarding/batches", permission: "onboarding.apply", description: "Dry-run, apply and rollback eligible migration batches.", status: "ready" },
      { label: "Go-Live Readiness", path: "/backoffice/onboarding/go-live", permission: "onboarding.go_live", description: "Readiness score, blocking issues, freeze window and cutover checklist.", status: "ready" },
      { label: "Cutover Assistant", path: "/backoffice/onboarding/cutover", permission: "onboarding.manage_cutover", description: "T-30 to T+1 cutover plan, delta import, freeze window and rollback notes.", status: "ready" }
    ]
  }
};

export function getModuleRouteItems(moduleCode: HotelModuleCode | "backoffice", surface: "mobile" | "admin"): ModuleRouteMapItem[] {
  return MODULE_ROUTE_MAP[moduleCode]?.[surface] ?? [];
}
