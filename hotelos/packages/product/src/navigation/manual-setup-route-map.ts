import type { HotelModuleCode } from "../modules/module-codes.js";

export type ManualSetupStatus = "ready" | "needs_setup" | "coming_soon";

export type ManualSetupInputMethod = {
  code:
    | "manual_form"
    | "guided_wizard"
    | "bulk_csv_xlsx"
    | "template_apply"
    | "ai_assisted"
    | "api_connector"
    | "voice_text"
    | "floor_plan_upload"
    | "room_walk"
    | "grid_editor"
    | "report_upload"
    | "credential_secret"
    | "test_connection"
    | "dry_run";
  label: string;
  description: string;
  requiresReview?: boolean;
};

export type ManualSetupCompletionCheck = {
  code: string;
  label: string;
  severity: "blocking" | "warning" | "info";
};

export type ManualSetupOption = {
  code: string;
  group:
    | "Property"
    | "Configuration"
    | "Modules"
    | "Revenue"
    | "Channel Manager"
    | "Finance"
    | "Compliance"
    | "AI"
    | "Guest Experience"
    | "Platform"
    | "Operations";
  label: string;
  description: string;
  moduleCode?: HotelModuleCode | "backoffice";
  adminPath: string;
  mobileRoute?: string;
  screen: string;
  permission: string;
  apiEndpoint?: string;
  saveEndpoint?: string;
  targetTables: string[];
  inputCategories: string[];
  requiredInputs: string[];
  inputMethods: ManualSetupInputMethod[];
  completionChecks: ManualSetupCompletionCheck[];
  status: ManualSetupStatus;
};

export type ManualSetupCoverageIssue = {
  optionCode: string;
  field: string;
  severity: "blocking" | "warning";
  message: string;
};

type RawManualSetupOption = Omit<ManualSetupOption, "inputMethods" | "completionChecks"> & {
  inputMethods?: ManualSetupInputMethod[];
  completionChecks?: ManualSetupCompletionCheck[];
};

const INPUT_METHODS: Record<ManualSetupInputMethod["code"], ManualSetupInputMethod> = {
  manual_form: {
    code: "manual_form",
    label: "Manual form",
    description: "Hotel staff can enter and edit every required field directly."
  },
  guided_wizard: {
    code: "guided_wizard",
    label: "Guided wizard",
    description: "Step-by-step flow with validation, required fields and setup progress."
  },
  bulk_csv_xlsx: {
    code: "bulk_csv_xlsx",
    label: "CSV/XLSX import",
    description: "Upload spreadsheet data, preview create/update/skip rows, then apply after confirmation.",
    requiresReview: true
  },
  template_apply: {
    code: "template_apply",
    label: "Setup template",
    description: "Apply a hotel-type template with preview, duplicate detection and audit events.",
    requiresReview: true
  },
  ai_assisted: {
    code: "ai_assisted",
    label: "AI assisted input",
    description: "AI can suggest categories, mappings or setup values, but cannot apply without review.",
    requiresReview: true
  },
  api_connector: {
    code: "api_connector",
    label: "API connector",
    description: "Connect a source system or provider and map imported data before applying.",
    requiresReview: true
  },
  voice_text: {
    code: "voice_text",
    label: "Voice/text description",
    description: "Hotel can describe setup needs by voice or text and review the structured preview.",
    requiresReview: true
  },
  floor_plan_upload: {
    code: "floor_plan_upload",
    label: "Floor plan upload",
    description: "Upload floor plans or room maps, extract candidates and manually confirm uncertain labels.",
    requiresReview: true
  },
  room_walk: {
    code: "room_walk",
    label: "Room Walk Setup",
    description: "Walk through the property and dictate rooms, zones, sections and resource ranges.",
    requiresReview: true
  },
  grid_editor: {
    code: "grid_editor",
    label: "Grid editor",
    description: "Dense editable grid for rates, mappings, restrictions or operational taxonomy."
  },
  report_upload: {
    code: "report_upload",
    label: "Report upload",
    description: "Upload PDF/CSV/XLSX reports, extract rows, validate totals and approve import.",
    requiresReview: true
  },
  credential_secret: {
    code: "credential_secret",
    label: "Credential secret",
    description: "Store provider or authority credentials as secret references, never plain text."
  },
  test_connection: {
    code: "test_connection",
    label: "Test connection",
    description: "Validate provider credentials, mappings and health before enabling sync."
  },
  dry_run: {
    code: "dry_run",
    label: "Dry-run preview",
    description: "Show records to create, update, skip and block before applying live changes.",
    requiresReview: true
  }
};

const RAW_MANUAL_SETUP_OPTIONS: RawManualSetupOption[] = [
  {
    code: "property_profile",
    group: "Property",
    label: "Property Profile",
    description: "Legal identity, address, timezone, currency, tax region and business date rules.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/property-setup/property-profile",
    mobileRoute: "PropertySetupPreview",
    screen: "PropertyProfileSetupForm",
    permission: "property_profile.edit",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/property_profile",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/property_profile",
    targetTables: ["properties", "organizations", "property_setup_form_submissions"],
    inputCategories: ["Property profile", "Legal profile", "Business date rules"],
    requiredInputs: ["Property name", "Legal name", "Tax ID", "Full address", "Country", "Region", "Timezone", "Currency", "Tax region"],
    status: "ready"
  },
  {
    code: "buildings_floors_zones",
    group: "Property",
    label: "Buildings, Floors & Zones",
    description: "Physical map hierarchy used by rooms, resources, housekeeping and maintenance.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/property-setup/buildings",
    mobileRoute: "PropertySetupPreview",
    screen: "BuildingSetupForm",
    permission: "property.configure",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/building",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/building",
    targetTables: ["buildings", "floors", "property_zones", "property_setup_form_submissions"],
    inputCategories: ["Buildings", "Floors", "Zones", "Property mapper"],
    requiredInputs: ["Building name", "Building code", "Floor name", "Floor number", "Zone name", "Zone type", "Sort order", "Active"],
    status: "ready"
  },
  {
    code: "rooms_room_types",
    group: "Property",
    label: "Rooms & Room Types",
    description: "Sellable room inventory, room types, bed setup, features, occupancy and operational sections.",
    moduleCode: "pms_core",
    adminPath: "/backoffice/property-setup/rooms",
    mobileRoute: "PropertySetupPreview",
    screen: "RoomSetupForm",
    permission: "rooms.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/room",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/room",
    targetTables: ["rooms", "room_types", "room_features", "bed_types", "property_setup_form_submissions"],
    inputCategories: ["Rooms", "Room types", "Room features", "Bed types", "Housekeeping sections", "Maintenance areas"],
    requiredInputs: ["Room number", "Room type", "Building", "Floor", "Zone", "Max occupancy", "Beds", "Sellable", "Active", "Status"],
    status: "ready"
  },
  {
    code: "spaces_resources",
    group: "Property",
    label: "Spaces & Bookable Resources",
    description: "Parking, meeting rooms, coworking, spa, outlets and other inventory beyond bedrooms.",
    moduleCode: "pms_core",
    adminPath: "/backoffice/property-setup/spaces-resources",
    mobileRoute: "PropertySetupPreview",
    screen: "SpaceResourceSetupForm",
    permission: "spaces.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/space_resource",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/space_resource",
    targetTables: ["property_spaces", "inventory_resources", "property_setup_form_submissions"],
    inputCategories: ["Spaces", "Bookable resources", "Resource types", "Space types"],
    requiredInputs: ["Name", "Code", "Resource type", "Space type", "Building", "Floor", "Zone", "Capacity", "Bookable mode", "Sellable", "Tax code"],
    status: "ready"
  },
  {
    code: "departments_users_roles",
    group: "Configuration",
    label: "Departments, Users & Roles",
    description: "Departments, managers, staff access, roles and permission assignment.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/users-roles",
    mobileRoute: "BackOfficePreview",
    screen: "UserRoleManager",
    permission: "users.read",
    apiEndpoint: "/backoffice/properties/:propertyId/users",
    saveEndpoint: "/backoffice/properties/:propertyId/users",
    targetTables: ["departments", "users", "user_departments"],
    inputCategories: ["Departments", "Users", "Roles", "Permissions"],
    requiredInputs: ["Department name", "Department code", "User email", "Role", "Department assignment", "Active state"],
    status: "ready"
  },
  {
    code: "category_manager",
    group: "Configuration",
    label: "Category Manager",
    description: "Operational taxonomy: room features, bed types, spaces, housekeeping, maintenance, revenue, POS, assets, safety and AI categories.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/configuration/categories",
    mobileRoute: "CategoryManagerPreview",
    screen: "CategoryManagerScreen",
    permission: "categories.read",
    apiEndpoint: "/backoffice/properties/:propertyId/configuration/categories",
    saveEndpoint: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options",
    targetTables: ["category_definitions", "property_category_options", "property_category_option_translations"],
    inputCategories: ["Property", "Rooms", "Operations", "Revenue", "Finance", "Compliance", "Assets", "Safety", "AI"],
    requiredInputs: ["Category", "Option code", "Label", "Description", "Color token", "Icon", "Parent option", "Active state", "Sort order"],
    status: "ready"
  },
  {
    code: "custom_fields",
    group: "Configuration",
    label: "Custom Fields",
    description: "Property-specific fields for rooms, guests, reservations, assets, tasks and work orders.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/configuration/custom-fields",
    mobileRoute: "CategoryManagerPreview",
    screen: "CustomFieldManagerScreen",
    permission: "custom_fields.read",
    apiEndpoint: "/backoffice/properties/:propertyId/configuration/custom-fields",
    saveEndpoint: "/backoffice/properties/:propertyId/configuration/custom-fields",
    targetTables: ["property_custom_field_definitions", "property_custom_field_values"],
    inputCategories: ["Custom fields", "Validation rules", "Visibility rules"],
    requiredInputs: ["Entity type", "Field key", "Label", "Data type", "Required", "Searchable", "Visible in list", "Validation JSON"],
    status: "ready"
  },
  {
    code: "reservation_setup",
    group: "Operations",
    label: "Reservation Setup & Creation",
    description: "Manual reservation input route with source, segment, guarantee, cancellation, room/resource and billing categories.",
    moduleCode: "pms_core",
    adminPath: "/backoffice/reservations/new",
    mobileRoute: "CreateReservation",
    screen: "ReservationCreate",
    permission: "pms.reservation.create",
    apiEndpoint: "/properties/:propertyId/availability/quote",
    saveEndpoint: "/properties/:propertyId/reservations",
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios", "audit_events"],
    inputCategories: ["Reservation source", "Market segment", "Guest details", "Stay dates", "Room/resource type", "Guarantee policy", "Cancellation policy", "Billing instruction"],
    requiredInputs: ["Arrival date", "Departure date", "Adults", "Room type", "Primary guest first name", "Primary guest surname", "Source code", "Billing instruction"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.guided_wizard, INPUT_METHODS.bulk_csv_xlsx, INPUT_METHODS.ai_assisted],
    completionChecks: [
      { code: "reservation_categories_configured", label: "Reservation source, segment, guarantee and billing categories configured", severity: "blocking" },
      { code: "room_type_available", label: "At least one sellable room type exists", severity: "blocking" },
      { code: "folio_created_on_reservation", label: "Reservation creation opens a folio", severity: "blocking" }
    ],
    status: "ready"
  },
  {
    code: "reservation_reporting",
    group: "Operations",
    label: "Reservation Reports",
    description: "Arrivals, departures, cancellations, no-shows, pickup, channel and market-segment reports.",
    moduleCode: "hotel_intelligence_platform",
    adminPath: "/backoffice/reports/reservations",
    mobileRoute: "ReservationReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/reservations",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["reservations", "reservation_guests", "rooms", "room_types"],
    inputCategories: ["Report type", "Date range", "Reservation status", "Channel", "Market segment", "Room type", "Export format"],
    requiredInputs: ["From date", "To date", "Report type", "Export format"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.grid_editor],
    completionChecks: [
      { code: "reservation_report_route_visible", label: "Reservation report route is visible from Back Office", severity: "blocking" },
      { code: "report_export_available", label: "PDF/CSV/XLSX/JSON export endpoint exists", severity: "warning" }
    ],
    status: "ready"
  },
  {
    code: "module_setup",
    group: "Modules",
    label: "Module Setup",
    description: "Enable modules, configure dependencies, review setup status and module health.",
    moduleCode: "module_marketplace",
    adminPath: "/backoffice/modules",
    mobileRoute: "ModuleMarketplace",
    screen: "ModuleManager",
    permission: "modules.read",
    apiEndpoint: "/modules",
    saveEndpoint: "/properties/:propertyId/modules/:moduleCode/enable",
    targetTables: ["modules", "property_modules", "module_configuration"],
    inputCategories: ["Modules", "Dependencies", "Health", "Setup status"],
    requiredInputs: ["Module code", "Enabled state", "Configuration JSON", "Dependency readiness", "Health state"],
    status: "ready"
  },
  {
    code: "integrations",
    group: "Modules",
    label: "Integration Marketplace",
    description: "Connect OTAs, payments, messaging, locks, government adapters, BI and AI providers.",
    moduleCode: "integration_marketplace",
    adminPath: "/backoffice/marketplace",
    mobileRoute: "MarketplaceHome",
    screen: "IntegrationMarketplaceHome",
    permission: "integrations.read",
    apiEndpoint: "/integrations/properties/:propertyId/providers",
    saveEndpoint: "/integrations/properties/:propertyId/connect",
    targetTables: ["integration_providers", "property_integrations", "integration_events"],
    inputCategories: ["Integration providers", "Credentials", "Capabilities", "Health", "Sync settings"],
    requiredInputs: ["Provider", "Credential secret ref", "Capabilities", "Test connection", "Sync mode", "Active state"],
    status: "ready"
  },
  {
    code: "revenue_settings",
    group: "Revenue",
    label: "Revenue Settings",
    description: "Forecast horizon, pricing constraints, target occupancy, ADR/profit targets and automation levels.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/settings",
    mobileRoute: "RevenueSettings",
    screen: "RevenueSettings",
    permission: "revenue.configure",
    apiEndpoint: "/revenue/properties/:propertyId/dashboard",
    saveEndpoint: "/revenue/properties/:propertyId/automation-rules",
    targetTables: ["revenue_automation_rules", "rate_plans", "rate_days", "inventory_days", "restriction_days"],
    inputCategories: ["Revenue settings", "Rate plans", "Restrictions", "Automation", "Approval thresholds"],
    requiredInputs: ["Default currency", "Forecast horizon", "Pricing horizon", "Min/max price", "Max daily change", "Target occupancy", "Automation level"],
    status: "ready"
  },
  {
    code: "revenue_rate_plans",
    group: "Revenue",
    label: "Rate Plans & Rate Categories",
    description: "Create BAR, derived, non-refundable, package, corporate and group rate plans with constraints.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/rate-plans",
    mobileRoute: "RevenueSettings",
    screen: "RevenueSettings",
    permission: "revenue.manage_rates",
    apiEndpoint: "/revenue/properties/:propertyId/rate-plans",
    saveEndpoint: "/revenue/properties/:propertyId/rate-plans",
    targetTables: ["rate_plans", "property_category_options", "revenue_automation_rules"],
    inputCategories: ["Rate plans", "Rate categories", "Derivation rules", "Cancellation policy", "Meal plan"],
    requiredInputs: ["Rate plan code", "Name", "Rate plan type", "Parent rate plan", "Derivation rule", "Min/max price policy", "Active state"],
    status: "ready"
  },
  {
    code: "rate_grid",
    group: "Revenue",
    label: "Rate Grid",
    description: "Manual rates, inventory, stop sell, min stay, CTA/CTD and override markers.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/rate-grid",
    mobileRoute: "RateGrid",
    screen: "RevenueRules",
    permission: "revenue.manage_rates",
    apiEndpoint: "/revenue/properties/:propertyId/rate-grid",
    saveEndpoint: "/revenue/properties/:propertyId/rate-grid/bulk-update",
    targetTables: ["rate_plans", "rate_days", "inventory_days", "restriction_days"],
    inputCategories: ["Rates", "Inventory", "Restrictions", "Manual overrides"],
    requiredInputs: ["Date", "Room type", "Rate plan", "Price", "Available count", "Stop sell", "Min stay", "CTA", "CTD"],
    status: "ready"
  },
  {
    code: "history_forecast",
    group: "Revenue",
    label: "History & Forecast",
    description: "Period report with history/forecast split, KPI cards, charts, detailed table and export settings.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/history-forecast",
    mobileRoute: "RevenueHistoryForecast",
    screen: "RevenueHistoryForecastDashboard",
    permission: "revenue.history_forecast.read",
    apiEndpoint: "/revenue/properties/:propertyId/history-forecast",
    saveEndpoint: "/revenue/properties/:propertyId/history-forecast/saved-views",
    targetTables: ["revenue_daily_snapshots", "revenue_forecast_snapshots", "revenue_report_views"],
    inputCategories: ["Revenue snapshots", "Forecast snapshots", "Saved views", "Export settings"],
    requiredInputs: ["From date", "To date", "Granularity", "Filters", "Comparison period", "Visible KPIs", "Export format"],
    status: "ready"
  },
  {
    code: "forecast_settings",
    group: "Revenue",
    label: "Forecast Settings",
    description: "Forecast horizon, confidence thresholds, comparison period, data quality thresholds and model inputs.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/forecast-explorer",
    mobileRoute: "RevenueForecastGraph",
    screen: "ForecastSettings",
    permission: "revenue.forecast.read",
    apiEndpoint: "/revenue/properties/:propertyId/forecasts",
    saveEndpoint: "/revenue/properties/:propertyId/forecasts/generate",
    targetTables: ["revenue_forecasts", "revenue_forecast_snapshots", "revenue_daily_snapshots"],
    inputCategories: ["Forecast horizon", "Confidence thresholds", "Comparison period", "Model inputs", "Data quality"],
    requiredInputs: ["Forecast horizon", "Default granularity", "Comparison period", "Confidence threshold", "Data quality blockers", "Regeneration schedule"],
    status: "ready"
  },
  {
    code: "demand_calendar",
    group: "Revenue",
    label: "Demand Calendar",
    description: "Local events, holidays, compression dates, weather placeholders and demand impact scores.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/demand-calendar",
    mobileRoute: "DemandCalendar",
    screen: "DemandCalendarAdmin",
    permission: "revenue.configure",
    apiEndpoint: "/revenue/properties/:propertyId/demand-calendar",
    saveEndpoint: "/revenue/properties/:propertyId/demand-calendar",
    targetTables: ["demand_calendar_events", "property_category_options"],
    inputCategories: ["Demand events", "Event types", "Impact scores", "Source", "Date range"],
    requiredInputs: ["Event name", "Event type", "Start date", "End date", "Expected impact", "Impact score", "Source"],
    status: "ready"
  },
  {
    code: "rate_shopper_competitors",
    group: "Revenue",
    label: "Rate Shopper & Competitor Set",
    description: "Competitor hotels, comparable room/rate mapping, source channels, confidence and parity comparison.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/rate-shopper",
    mobileRoute: "RateParityAlerts",
    screen: "RateShopperSettings",
    permission: "revenue.configure",
    apiEndpoint: "/rate-shopper/properties/:propertyId/competitors",
    saveEndpoint: "/rate-shopper/properties/:propertyId/competitors",
    targetTables: ["competitor_hotels", "competitor_rate_snapshots", "property_category_options"],
    inputCategories: ["Competitor set", "Comparable room types", "Source channels", "Rate snapshots", "Parity alerts"],
    requiredInputs: ["Competitor name", "Distance", "Star rating", "Comparable score", "Comparable room type", "Source channel", "Active state"],
    status: "ready"
  },
  {
    code: "revenue_recommendation_rules",
    group: "Revenue",
    label: "Recommendation & Automation Rules",
    description: "Approval thresholds, low-risk automation, min/max price constraints, channel health gates and blocked actions.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/scenario-simulator",
    mobileRoute: "ScenarioSimulator",
    screen: "RevenueAutomationRules",
    permission: "revenue.automation.manage",
    apiEndpoint: "/revenue/properties/:propertyId/automation-rules",
    saveEndpoint: "/revenue/properties/:propertyId/automation-rules",
    targetTables: ["revenue_automation_rules", "revenue_recommendations", "revenue_scenarios"],
    inputCategories: ["Automation level", "Approval thresholds", "Safety constraints", "Scenario defaults", "Blocked actions"],
    requiredInputs: ["Rule name", "Automation level", "Scope", "Min/max price", "Max daily change", "Approval threshold", "Active state"],
    status: "ready"
  },
  {
    code: "revenue_data_quality",
    group: "Revenue",
    label: "Revenue Data Quality",
    description: "Data quality blockers for rate plans, inventory, future rates, channel mappings, competitors and snapshots.",
    moduleCode: "revenue_profit_engine",
    adminPath: "/backoffice/revenue/data-quality",
    mobileRoute: "RevenueHome",
    screen: "RevenueDataQuality",
    permission: "revenue.read",
    apiEndpoint: "/revenue/properties/:propertyId/data-quality",
    saveEndpoint: "/revenue/properties/:propertyId/data-quality/acknowledge",
    targetTables: ["rate_plans", "rate_days", "inventory_days", "channel_room_mappings", "revenue_daily_snapshots"],
    inputCategories: ["Data quality checks", "Blockers", "Warnings", "Acknowledgements", "Setup readiness"],
    requiredInputs: ["Check code", "Severity", "Affected entity", "Resolution owner", "Acknowledgement", "Due date"],
    status: "ready"
  },
  {
    code: "channel_connections",
    group: "Channel Manager",
    label: "Channel Connections",
    description: "Connect direct engine, Booking.com, Expedia, Google Hotels and manual/mock channels.",
    moduleCode: "distribution_hub",
    adminPath: "/backoffice/channel-manager/channels",
    mobileRoute: "ChannelManagerHome",
    screen: "ChannelManagerSettings",
    permission: "channel_manager.manage",
    apiEndpoint: "/channel-manager/properties/:propertyId/channels",
    saveEndpoint: "/channel-manager/properties/:propertyId/channels",
    targetTables: ["channels", "channel_sync_jobs"],
    inputCategories: ["Channels", "Credentials", "Costs", "Sync settings", "Health"],
    requiredInputs: ["Provider code", "Name", "Channel type", "Commission", "Payment cost", "Credentials secret ref", "Status"],
    status: "ready"
  },
  {
    code: "channel_mappings",
    group: "Channel Manager",
    label: "Channel Mappings",
    description: "Map internal room/resource and rate plans to OTA room and rate codes before any ARI push.",
    moduleCode: "distribution_hub",
    adminPath: "/backoffice/channel-manager/mappings",
    mobileRoute: "ChannelManagerHome",
    screen: "ChannelMappings",
    permission: "channel_manager.mappings.manage",
    apiEndpoint: "/channel-manager/channels/:channelId/room-mappings",
    saveEndpoint: "/channel-manager/channels/:channelId/room-mappings",
    targetTables: ["channel_room_mappings", "channel_rate_mappings"],
    inputCategories: ["Room mappings", "Rate mappings", "Mapping health"],
    requiredInputs: ["Channel", "Internal room type", "External room code", "Internal rate plan", "External rate code", "Mapping status"],
    status: "ready"
  },
  {
    code: "channel_sync_rules",
    group: "Channel Manager",
    label: "Channel Sync Rules & Health",
    description: "ARI sync cadence, retry behavior, stale-rate protection, overbooking protection and health alerts.",
    moduleCode: "distribution_hub",
    adminPath: "/backoffice/channel-manager/sync-health",
    mobileRoute: "ChannelSyncHealth",
    screen: "ChannelManagerSettings",
    permission: "channel_manager.sync",
    apiEndpoint: "/channel-manager/properties/:propertyId/sync-health",
    saveEndpoint: "/channel-manager/properties/:propertyId/sync-rules",
    targetTables: ["channel_sync_jobs", "channels", "channel_room_mappings", "channel_rate_mappings"],
    inputCategories: ["Sync cadence", "Retry policy", "ARI payload rules", "Overbooking protection", "Health alerts"],
    requiredInputs: ["Channel", "Sync type", "Cadence", "Retry limit", "Stale-rate guard", "Mapping validation", "Alert recipients"],
    status: "ready"
  },
  {
    code: "billing_invoice_sequences",
    group: "Finance",
    label: "Billing & Invoice Sequences",
    description: "Invoice prefixes, legal numbering, tax behavior and compliance billing readiness.",
    moduleCode: "compliance_billing",
    adminPath: "/backoffice/billing",
    mobileRoute: "BackOfficePreview",
    screen: "BillingSettings",
    permission: "billing.configure",
    apiEndpoint: "/backoffice/properties/:propertyId/billing-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/billing-settings",
    targetTables: ["invoice_sequences", "property_modules"],
    inputCategories: ["Billing", "Invoice sequences", "Tax settings", "Legal numbering"],
    requiredInputs: ["Sequence code", "Prefix", "Next number", "Invoice type", "Tax region", "Active state"],
    status: "needs_setup"
  },
  {
    code: "billing_center",
    group: "Finance",
    label: "Billing Center",
    description: "Reservation folios, charges, payments, invoice drafts, issue workflow and billing reports.",
    moduleCode: "compliance_billing",
    adminPath: "/backoffice/billing/center",
    mobileRoute: "Invoices",
    screen: "BillingCenter",
    permission: "billing.compliance.view",
    apiEndpoint: "/reservations/:id/folio",
    saveEndpoint: "/invoices/drafts",
    targetTables: ["folios", "folio_lines", "payments", "invoices", "invoice_lines", "audit_events"],
    inputCategories: ["Folio", "Charge category", "Payment method", "Tax code", "Invoice type", "Customer type", "Invoice sequence"],
    requiredInputs: ["Reservation", "Folio", "Invoice type", "Customer type", "Total", "Tax total", "Invoice sequence"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.guided_wizard],
    completionChecks: [
      { code: "invoice_sequence_configured", label: "Active invoice sequence exists", severity: "blocking" },
      { code: "tax_settings_configured", label: "Tax codes are configured", severity: "blocking" },
      { code: "invoice_issue_route_protected", label: "Invoice issue route is permission and confirmation protected", severity: "blocking" }
    ],
    status: "ready"
  },
  {
    code: "billing_reports",
    group: "Finance",
    label: "Billing Reports",
    description: "Invoice, payment, folio balance, tax and export audit reports.",
    moduleCode: "hotel_intelligence_platform",
    adminPath: "/backoffice/reports/billing",
    mobileRoute: "BillingReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/billing",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["folios", "folio_lines", "payments", "invoices", "invoice_lines"],
    inputCategories: ["Date range", "Invoice status", "Payment method", "Tax code", "Customer type", "Export format"],
    requiredInputs: ["From date", "To date", "Report type", "Export format"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.grid_editor],
    completionChecks: [
      { code: "billing_report_route_visible", label: "Billing report route is visible from Back Office", severity: "blocking" },
      { code: "invoice_data_available", label: "Invoice or folio data exists for reporting", severity: "warning" }
    ],
    status: "ready"
  },
  {
    code: "payment_settings",
    group: "Finance",
    label: "Payment Settings",
    description: "Payment gateway, token policy, payment links, capture/refund controls and PSP reference mapping.",
    moduleCode: "payment_vault",
    adminPath: "/backoffice/payments",
    mobileRoute: "BackOfficePreview",
    screen: "PaymentSettings",
    permission: "payments.configure",
    apiEndpoint: "/integrations/properties/:propertyId/providers",
    saveEndpoint: "/integrations/properties/:propertyId/connect",
    targetTables: ["property_integrations", "payments", "payment_intents"],
    inputCategories: ["Payment gateways", "Tokenization", "Capture rules", "Refund rules"],
    requiredInputs: ["Provider", "Merchant account", "Secret ref", "Capture policy", "Refund policy", "Webhook status"],
    status: "needs_setup"
  },
  {
    code: "accounting_settings",
    group: "Finance",
    label: "Accounting Settings",
    description: "Chart of accounts mapping, owner exports, cost centers and ERP sync options.",
    moduleCode: "erp_accounting",
    adminPath: "/backoffice/accounting",
    mobileRoute: "AccountingDashboard",
    screen: "AccountingSettings",
    permission: "accounting.configure",
    apiEndpoint: "/backoffice/properties/:propertyId/accounting-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/accounting-settings",
    targetTables: ["accounting_settings", "accounts", "journal_entries"],
    inputCategories: ["Chart of accounts", "Cost centers", "Exports", "ERP sync"],
    requiredInputs: ["Default revenue account", "Tax account", "Payment clearing account", "Cost center rules", "Export format"],
    status: "ready"
  },
  {
    code: "tax_settings",
    group: "Finance",
    label: "Tax, Fees & Tourism Tax Settings",
    description: "Tax regions, tourism tax, fee rules, invoice tax codes and legally controlled fiscal values.",
    moduleCode: "compliance_billing",
    adminPath: "/backoffice/tax-settings",
    mobileRoute: "BackOfficePreview",
    screen: "TaxComplianceSettings",
    permission: "compliance_setup.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/compliance-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/compliance-settings",
    targetTables: ["property_compliance_settings", "category_definitions", "property_category_options"],
    inputCategories: ["Tax region", "Tourism tax", "Tax codes", "Fee rules", "Invoice tax behavior"],
    requiredInputs: ["Country", "Tax region", "Tax code", "Tax rate", "Tourism tax rule", "Invoice applicability", "Effective date"],
    status: "ready"
  },
  {
    code: "pos_outlets_products",
    group: "Finance",
    label: "POS Outlets & Product Categories",
    description: "Restaurant, bar, minibar and outlet setup with product categories, tax codes and revenue mapping.",
    moduleCode: "outlet_pos",
    adminPath: "/backoffice/pos-outlets",
    mobileRoute: "BackOfficePreview",
    screen: "POSSettings",
    permission: "configuration.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/pos-outlets",
    saveEndpoint: "/backoffice/properties/:propertyId/pos-outlets",
    targetTables: ["property_spaces", "inventory_resources", "property_category_options", "accounting_settings"],
    inputCategories: ["Outlets", "POS product categories", "Tax codes", "Revenue centers", "Posting rules"],
    requiredInputs: ["Outlet name", "Outlet code", "Product category", "Tax code", "Revenue account", "Posting rule", "Active state"],
    status: "coming_soon"
  },
  {
    code: "procurement_inventory",
    group: "Operations",
    label: "Procurement & Inventory Setup",
    description: "Suppliers, stock locations, product categories, reorder rules, procurement approvals and cost centers.",
    moduleCode: "procurement_inventory",
    adminPath: "/backoffice/procurement-inventory",
    mobileRoute: "BackOfficePreview",
    screen: "InventorySettings",
    permission: "configuration.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/procurement-inventory",
    saveEndpoint: "/backoffice/properties/:propertyId/procurement-inventory",
    targetTables: ["property_category_options", "accounting_settings", "property_spaces"],
    inputCategories: ["Suppliers", "Stock locations", "Inventory categories", "Reorder rules", "Procurement approvals"],
    requiredInputs: ["Supplier", "Stock location", "Product category", "Reorder threshold", "Approval role", "Cost center", "Active state"],
    status: "coming_soon"
  },
  {
    code: "asset_capex_energy",
    group: "Operations",
    label: "Assets, Capex & Energy Setup",
    description: "Asset register categories, preventive maintenance, capex planning, meters and sustainability reporting.",
    moduleCode: "asset_intelligence",
    adminPath: "/backoffice/assets-capex-energy",
    mobileRoute: "BackOfficePreview",
    screen: "AssetSettings",
    permission: "configuration.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/assets-capex-energy",
    saveEndpoint: "/backoffice/properties/:propertyId/assets-capex-energy",
    targetTables: ["property_category_options", "maintenance_areas", "property_spaces"],
    inputCategories: ["Asset categories", "Preventive maintenance", "Capex", "Energy meters", "Sustainability"],
    requiredInputs: ["Asset category", "Maintenance area", "Preventive schedule", "Capex category", "Meter type", "Reporting owner"],
    status: "coming_soon"
  },
  {
    code: "workforce_labor",
    group: "Operations",
    label: "Workforce & Labor Setup",
    description: "Departments, roles, shifts, labor rules, scheduling constraints and payroll export mapping.",
    moduleCode: "workforce_labor",
    adminPath: "/backoffice/workforce",
    mobileRoute: "BackOfficePreview",
    screen: "WorkforceSettings",
    permission: "configuration.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/workforce",
    saveEndpoint: "/backoffice/properties/:propertyId/workforce",
    targetTables: ["departments", "users", "user_departments", "property_category_options"],
    inputCategories: ["Roles", "Shifts", "Scheduling rules", "Labor demand", "Payroll export"],
    requiredInputs: ["Role", "Department", "Shift type", "Coverage rule", "Approval role", "Payroll export code", "Active state"],
    status: "coming_soon"
  },
  {
    code: "safety_incident_setup",
    group: "Operations",
    label: "Safety & Incident Setup",
    description: "Incident categories, severity levels, response workflows, emergency contacts and reporting rules.",
    moduleCode: "safety_incident_management",
    adminPath: "/backoffice/safety-incidents",
    mobileRoute: "BackOfficePreview",
    screen: "SafetySettings",
    permission: "operations_setup.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/safety-incidents",
    saveEndpoint: "/backoffice/properties/:propertyId/safety-incidents",
    targetTables: ["property_category_options", "property_compliance_settings", "departments"],
    inputCategories: ["Safety incidents", "Severity", "Workflows", "Emergency contacts", "Audit reporting"],
    requiredInputs: ["Incident category", "Severity", "Response SLA", "Responsible role", "Emergency contact", "Escalation rule"],
    status: "ready"
  },
  {
    code: "spain_guest_register",
    group: "Compliance",
    label: "Spain Guest Register",
    description: "RD 933/2021 guest data, signatures, minors, identity verification and privacy defaults.",
    moduleCode: "spain_guest_register_compliance",
    adminPath: "/backoffice/compliance/spain-guest-register",
    mobileRoute: "GuestRegisterInbox",
    screen: "GuestRegisterSettings",
    permission: "guest_register.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["authority_reporting_settings", "lodging_legal_profiles", "guest_register_records"],
    inputCategories: ["Guest register", "Legal fields", "Signatures", "OCR privacy", "Retention"],
    requiredInputs: ["Enable compliance", "Professional activity", "Required fields", "Signature rule", "Identity verification method", "ID image storage policy"],
    status: "needs_setup"
  },
  {
    code: "ses_hospedajes",
    group: "Compliance",
    label: "SES.HOSPEDAJES Settings",
    description: "Authority credentials, establishment code, batch export, web service placeholder and official schema loader.",
    moduleCode: "spain_guest_register_compliance",
    adminPath: "/backoffice/compliance/ses-hospedajes",
    mobileRoute: "SesSubmissionQueue",
    screen: "SesHospedajesSettings",
    permission: "compliance.ses.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["authority_reporting_settings", "authority_submission_batches", "authority_submissions"],
    inputCategories: ["Authority settings", "SES credentials", "Batch export", "Submission queue", "Official schemas"],
    requiredInputs: ["Authority target", "Establishment code", "Landlord code", "Web service username", "Secret ref", "Batch time", "Automatic submission"],
    status: "needs_setup"
  },
  {
    code: "authority_routing",
    group: "Compliance",
    label: "Authority Routing",
    description: "Route Spanish properties to SES.HOSPEDAJES by default and regional adapters such as Mossos when configured.",
    moduleCode: "spain_guest_register_compliance",
    adminPath: "/backoffice/compliance/authority-routing",
    mobileRoute: "BackOfficePreview",
    screen: "AuthorityRoutingSettings",
    permission: "guest_register.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["authority_routing_rules", "authority_reporting_settings"],
    inputCategories: ["Authority routing", "Region rules", "Adapter configuration"],
    requiredInputs: ["Country", "Region code", "Authority type", "Priority", "Enabled", "Override reason"],
    status: "ready"
  },
  {
    code: "guest_register_retention",
    group: "Compliance",
    label: "Guest Register Retention & Field Mapping",
    description: "Three-year retention, sensitive field access, authority field mapping and controlled legal categories.",
    moduleCode: "spain_guest_register_compliance",
    adminPath: "/backoffice/compliance/guest-register-retention",
    mobileRoute: "GuestRegisterInbox",
    screen: "GuestRegisterRetentionSettings",
    permission: "guest_register.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["guest_register_records", "authority_reporting_settings", "identity_document_processing_events"],
    inputCategories: ["Retention", "Field mapping", "Sensitive access", "Document minimization", "Deletion policy"],
    requiredInputs: ["Retention years", "Retention start event", "Sensitive field policy", "Authority field mapping", "Deletion/anonymization rule", "Audit role"],
    status: "ready"
  },
  {
    code: "ai_setup_wizard",
    group: "AI",
    label: "AI Setup Wizard",
    description: "Upload exports, classify files, generate property blueprint, review mappings, dry-run and go-live readiness.",
    moduleCode: "ai_onboarding_migration",
    adminPath: "/backoffice/ai-setup",
    mobileRoute: "AISetupWizard",
    screen: "AISetupCenter",
    permission: "onboarding.read",
    apiEndpoint: "/onboarding/projects",
    saveEndpoint: "/onboarding/projects",
    targetTables: ["onboarding_projects", "onboarding_files", "onboarding_mapping_suggestions", "onboarding_migration_batches"],
    inputCategories: ["Source PMS", "Files", "Blueprint", "Mappings", "Dry-run", "Go-live readiness"],
    requiredInputs: ["Source system", "Import method", "Uploaded files", "Human review", "Dry-run approval", "Go-live target date"],
    status: "ready"
  },
  {
    code: "ai_governance",
    group: "AI",
    label: "AI Governance",
    description: "Policies, tool registry, prompts, evaluations, incidents, human review and confirmation rules.",
    moduleCode: "ai_governance",
    adminPath: "/backoffice/ai-governance",
    mobileRoute: "AIGovernanceSettings",
    screen: "AIGovernanceSettings",
    permission: "ai_governance.read",
    apiEndpoint: "/ai-governance/policies",
    saveEndpoint: "/ai-governance/policies",
    targetTables: ["ai_policies", "ai_tool_registry", "ai_prompt_versions", "ai_human_review"],
    inputCategories: ["AI policies", "Tool registry", "Prompt versions", "Human review", "Incidents"],
    requiredInputs: ["Policy", "Tool enablement", "Risk threshold", "Confirmation rule", "Human review role", "Disclosure text"],
    status: "ready"
  },
  {
    code: "guest_journey_settings",
    group: "Guest Experience",
    label: "Guest Journey Settings",
    description: "Booked-to-post-stay steps, blocked states, automation and guest-facing message settings.",
    moduleCode: "guest_experience",
    adminPath: "/backoffice/guest-journey",
    mobileRoute: "GuestJourney",
    screen: "GuestJourneyWorkspace",
    permission: "guest_experience.inbox.read",
    apiEndpoint: "/guest-self-service/properties/:propertyId/settings",
    saveEndpoint: "/guest-self-service/properties/:propertyId/settings",
    targetTables: ["guest_journey_events", "property_modules"],
    inputCategories: ["Journey steps", "Guest portal", "Automation", "Message templates"],
    requiredInputs: ["Enabled steps", "Blocked-state rules", "Online check-in policy", "Payment verification", "Message templates"],
    status: "coming_soon"
  },
  {
    code: "guest_portal_online_checkin",
    group: "Guest Experience",
    label: "Guest Portal & Online Check-in",
    description: "Guest portal steps, online check-in fields, payment verification, signatures, upsells and disclosure text.",
    moduleCode: "guest_self_service",
    adminPath: "/backoffice/guest-portal",
    mobileRoute: "GuestJourney",
    screen: "GuestPortalSettings",
    permission: "guest_portal.configure",
    apiEndpoint: "/guest-self-service/properties/:propertyId/settings",
    saveEndpoint: "/guest-self-service/properties/:propertyId/settings",
    targetTables: ["guest_journey_events", "property_modules", "property_custom_field_definitions"],
    inputCategories: ["Guest portal", "Online check-in", "Payment verification", "Upsells", "Guest disclosures"],
    requiredInputs: ["Portal enabled", "Required check-in fields", "Payment verification rule", "Signature rule", "Upsell categories", "Disclosure text"],
    status: "coming_soon"
  },
  {
    code: "concierge_messaging_templates",
    group: "Guest Experience",
    label: "Concierge & Messaging Templates",
    description: "Message templates, channels, AI concierge rules, escalation states and guest request categories.",
    moduleCode: "ai_concierge",
    adminPath: "/backoffice/concierge-messaging",
    mobileRoute: "GuestJourney",
    screen: "ConciergeSettings",
    permission: "guest_portal.configure",
    apiEndpoint: "/guest-experience/properties/:propertyId/messaging-settings",
    saveEndpoint: "/guest-experience/properties/:propertyId/messaging-settings",
    targetTables: ["property_category_options", "property_modules", "ai_policies"],
    inputCategories: ["Message templates", "Channels", "Guest request categories", "AI disclosure", "Escalation"],
    requiredInputs: ["Template name", "Language", "Channel", "Trigger", "Disclosure text", "Escalation owner", "Active state"],
    status: "coming_soon"
  },
  {
    code: "developer_platform",
    group: "Platform",
    label: "Developer Platform",
    description: "API apps, webhooks, usage logs, scopes and partner certification settings.",
    moduleCode: "developer_platform",
    adminPath: "/backoffice/developer",
    mobileRoute: "BackOfficePreview",
    screen: "DeveloperPortal",
    permission: "developer.manage_apps",
    apiEndpoint: "/developer/apps",
    saveEndpoint: "/developer/apps",
    targetTables: ["developer_apps", "webhook_subscriptions", "webhook_deliveries"],
    inputCategories: ["API apps", "Webhooks", "Scopes", "Usage logs"],
    requiredInputs: ["App name", "Scopes", "Webhook URL", "Signing secret", "Event subscriptions", "Test status"],
    status: "coming_soon"
  },
  {
    code: "analytics_owner_reporting",
    group: "Platform",
    label: "Analytics & Owner Reporting",
    description: "Metric definitions, saved views, scheduled reports, owner sections, data quality center and export defaults.",
    moduleCode: "hotel_intelligence_platform",
    adminPath: "/backoffice/analytics-reporting",
    mobileRoute: "OwnerDashboard",
    screen: "AnalyticsSettings",
    permission: "analytics.read",
    apiEndpoint: "/analytics/properties/:propertyId/settings",
    saveEndpoint: "/analytics/properties/:propertyId/settings",
    targetTables: ["revenue_report_views", "property_custom_field_definitions", "property_modules"],
    inputCategories: ["Metrics", "Saved views", "Scheduled reports", "Owner sections", "Export defaults"],
    requiredInputs: ["Metric definition", "Visible dashboard section", "Scheduled report recipient", "Export format", "Owner access role", "Data quality rule"],
    status: "coming_soon"
  },
  {
    code: "audit_security_settings",
    group: "Platform",
    label: "Audit, Security & Access Policies",
    description: "MFA requirements, sensitive access policies, audit retention, role review and security alerts.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/security",
    mobileRoute: "BackOfficePreview",
    screen: "UserRoleManager",
    permission: "configuration.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/security-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/security-settings",
    targetTables: ["users", "roles", "audit_events", "property_modules"],
    inputCategories: ["MFA", "Sensitive access", "Audit retention", "Role review", "Security alerts"],
    requiredInputs: ["MFA rule", "Sensitive permission", "Audit retention period", "Role review cadence", "Alert recipient", "Exception approval"],
    status: "ready"
  },
  {
    code: "operations_setup",
    group: "Operations",
    label: "Housekeeping, Maintenance & Safety Setup",
    description: "Task types, cleaning schemas, maintenance issue types, priorities, SLAs and incident categories.",
    moduleCode: "backoffice",
    adminPath: "/backoffice/property-setup/operations",
    mobileRoute: "PropertySetupPreview",
    screen: "HousekeepingSetupForm",
    permission: "operations_setup.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/housekeeping_setup",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/housekeeping_setup",
    targetTables: ["housekeeping_sections", "housekeeping_rules", "maintenance_areas", "maintenance_rules", "property_category_options"],
    inputCategories: ["Housekeeping", "Maintenance", "Safety", "Work order priorities"],
    requiredInputs: ["Task types", "Cleaning schemas", "Inspection rule", "Issue types", "Priority levels", "SLA rules", "Safety incident categories"],
    status: "ready"
  }
];

function methods(...codes: ManualSetupInputMethod["code"][]): ManualSetupInputMethod[] {
  return codes.map((code) => INPUT_METHODS[code]);
}

function defaultInputMethods(option: RawManualSetupOption): ManualSetupInputMethod[] {
  if (option.code === "ai_setup_wizard") {
    return methods("guided_wizard", "bulk_csv_xlsx", "report_upload", "api_connector", "floor_plan_upload", "voice_text", "dry_run");
  }
  if (option.code === "buildings_floors_zones") {
    return methods("manual_form", "guided_wizard", "bulk_csv_xlsx", "floor_plan_upload", "room_walk", "ai_assisted");
  }
  if (option.code === "rooms_room_types" || option.code === "spaces_resources") {
    return methods("manual_form", "guided_wizard", "bulk_csv_xlsx", "room_walk", "floor_plan_upload", "ai_assisted");
  }
  if (option.code === "category_manager" || option.code === "custom_fields") {
    return methods("manual_form", "grid_editor", "bulk_csv_xlsx", "template_apply", "ai_assisted");
  }
  if (option.code === "integrations" || option.code === "channel_connections") {
    return methods("guided_wizard", "api_connector", "credential_secret", "test_connection", "manual_form");
  }
  if (option.code === "channel_mappings") {
    return methods("grid_editor", "bulk_csv_xlsx", "api_connector", "ai_assisted", "test_connection");
  }
  if (option.group === "Channel Manager") {
    return methods("guided_wizard", "api_connector", "grid_editor", "test_connection", "dry_run");
  }
  if (option.code === "rate_grid") {
    return methods("grid_editor", "bulk_csv_xlsx", "template_apply", "ai_assisted", "dry_run");
  }
  if (option.code === "history_forecast") {
    return methods("manual_form", "report_upload", "bulk_csv_xlsx", "api_connector", "ai_assisted");
  }
  if (option.group === "Revenue") {
    return methods("manual_form", "guided_wizard", "grid_editor", "bulk_csv_xlsx", "ai_assisted");
  }
  if (option.code === "spain_guest_register" || option.code === "ses_hospedajes" || option.code === "authority_routing") {
    return methods("manual_form", "guided_wizard", "credential_secret", "test_connection", "dry_run");
  }
  if (option.group === "Finance") {
    return methods("manual_form", "guided_wizard", "bulk_csv_xlsx", "api_connector", "test_connection");
  }
  if (option.group === "AI") {
    return methods("manual_form", "guided_wizard", "ai_assisted", "dry_run");
  }
  if (option.group === "Platform") {
    return methods("manual_form", "guided_wizard", "api_connector", "credential_secret", "test_connection");
  }
  return methods("manual_form", "guided_wizard", "bulk_csv_xlsx", "ai_assisted");
}

function defaultCompletionChecks(option: RawManualSetupOption): ManualSetupCompletionCheck[] {
  const checks: ManualSetupCompletionCheck[] = [
    { code: `${option.code}_permission`, label: `Required permission ${option.permission} is granted`, severity: "blocking" },
    { code: `${option.code}_required_inputs`, label: "All required inputs are present and valid", severity: "blocking" },
    { code: `${option.code}_save_endpoint`, label: `Save endpoint ${option.saveEndpoint ?? option.apiEndpoint ?? "coming soon"} is available`, severity: "blocking" },
    { code: `${option.code}_audit`, label: "Create/update action writes an audit event", severity: "warning" }
  ];

  if (option.group === "Revenue" || option.group === "Channel Manager") {
    checks.push({ code: `${option.code}_data_quality`, label: "Data quality and mapping blockers are resolved before sync or recommendations", severity: "blocking" });
  }
  if (option.group === "Compliance" || option.group === "Finance") {
    checks.push({ code: `${option.code}_legal_control`, label: "Legally controlled values are selected from controlled categories", severity: "blocking" });
  }
  if (option.group === "AI") {
    checks.push({ code: `${option.code}_human_review`, label: "AI suggestions require human review before applying", severity: "blocking" });
  }
  if (option.inputCategories.some((category) => category.toLowerCase().includes("credential"))) {
    checks.push({ code: `${option.code}_secret_ref`, label: "Credentials are stored as secret references", severity: "blocking" });
  }
  return checks;
}

export const MANUAL_SETUP_OPTIONS: ManualSetupOption[] = RAW_MANUAL_SETUP_OPTIONS.map((option) => ({
  ...option,
  inputMethods: option.inputMethods ?? defaultInputMethods(option),
  completionChecks: option.completionChecks ?? defaultCompletionChecks(option)
}));

export function listManualSetupOptions(): ManualSetupOption[] {
  return MANUAL_SETUP_OPTIONS;
}

export function getManualSetupOption(code: string): ManualSetupOption | undefined {
  return MANUAL_SETUP_OPTIONS.find((option) => option.code === code);
}

export function getManualSetupOptionsByGroup(): Record<ManualSetupOption["group"], ManualSetupOption[]> {
  return MANUAL_SETUP_OPTIONS.reduce((groups, option) => {
    groups[option.group] ??= [];
    groups[option.group].push(option);
    return groups;
  }, {} as Record<ManualSetupOption["group"], ManualSetupOption[]>);
}

export function validateManualSetupCoverage(options: ManualSetupOption[] = MANUAL_SETUP_OPTIONS): ManualSetupCoverageIssue[] {
  const issues: ManualSetupCoverageIssue[] = [];
  const requiredScalarFields: Array<keyof ManualSetupOption> = ["code", "group", "label", "description", "adminPath", "screen", "permission"];
  const requiredArrayFields: Array<keyof ManualSetupOption> = ["targetTables", "inputCategories", "requiredInputs", "inputMethods", "completionChecks"];

  options.forEach((option) => {
    requiredScalarFields.forEach((field) => {
      if (!option[field]) {
        issues.push({
          optionCode: option.code || "unknown",
          field,
          severity: "blocking",
          message: `Manual setup option ${option.code || "unknown"} is missing ${field}.`
        });
      }
    });

    requiredArrayFields.forEach((field) => {
      const value = option[field];
      if (!Array.isArray(value) || value.length === 0) {
        issues.push({
          optionCode: option.code,
          field,
          severity: "blocking",
          message: `Manual setup option ${option.code} must define at least one ${field}.`
        });
      }
    });

    if (!option.apiEndpoint && !option.saveEndpoint) {
      issues.push({
        optionCode: option.code,
        field: "apiEndpoint",
        severity: "blocking",
        message: `Manual setup option ${option.code} must expose a read or save endpoint so the form is database-backed.`
      });
    }

    if (!option.saveEndpoint) {
      issues.push({
        optionCode: option.code,
        field: "saveEndpoint",
        severity: "warning",
        message: `Manual setup option ${option.code} has no save endpoint yet; show an in-progress placeholder instead of a dead link.`
      });
    }
  });

  return issues;
}

const manualSetupCoverageIssues = validateManualSetupCoverage();

export const MANUAL_SETUP_COVERAGE_SUMMARY = {
  totalOptions: MANUAL_SETUP_OPTIONS.length,
  uncheckedOptions: manualSetupCoverageIssues.filter((issue) => issue.severity === "blocking").length,
  warningOptions: manualSetupCoverageIssues.filter((issue) => issue.severity === "warning").length,
  issues: manualSetupCoverageIssues
};
