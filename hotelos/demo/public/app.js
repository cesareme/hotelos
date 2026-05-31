const titles = {
  today: "Hoy",
  ai: "AI Command Center",
  pms: "Live Timeline",
  ops: "Operaciones",
  chat: "Guest chat",
  more: "Mas",
  backoffice: "Back Office setup",
  "manual-setup": "Manual Setup Center",
  "manual-setup-option": "Manual Setup Option",
  "property-setup": "Property Setup",
  "property-form": "Property Setup Form",
  reservations: "Reservations Workspace",
  "reservation-create": "Create Reservation",
  "billing-center": "Billing Center",
  "reports-center": "Reports Center",
  compliance: "Compliance inbox",
  owner: "Owner mode",
  guestportal: "Guest portal",
  revenue: "Revenue & Profit",
  "ai-setup": "AI Setup Wizard"
};

const demoReservationsStorageKey = "hotelos_demo_reservations";
const demoInvoicesStorageKey = "hotelos_demo_invoices";

const timelineSteps = [
  ["Voice captured", "Transcript: Check in this customer in room 432"],
  ["Document scanned", "OCR extracted fields. Source image discarded."],
  ["Audit written", "ID_IMAGE_DISCARDED sealed into the audit chain."],
  ["Reservation matched", "Maria Lopez Garcia matched to RES-18392."],
  ["Room validated", "Room 432 is clean, inspected, sellable, and not blocked."],
  ["Confirmation required", "Signature and staff confirmation are required before execution."]
];

const executedSteps = [
  ["Signature captured", "Entry form signature stored as sig_demo_guest."],
  ["Guest checked in", "RES-18392 status changed to checked_in."],
  ["Room occupied", "Room 432 status changed to occupied."],
  ["Authority queued", "SES.HOSPEDAJES check-in submission queued."],
  ["Welcome sent", "Guest welcome message queued through concierge."],
  ["Chain complete", "Audit events and domain events share correlation corr_demo."]
];

const propertySetupForms = {
  property_profile: {
    title: "Property profile",
    route: "/backoffice/property-setup/property-profile",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/property_profile",
    target: "properties + property_setup_form_submissions",
    categories: ["Property profile", "Legal profile", "Business date rules"],
    fields: ["Property name", "Legal name", "Tax ID", "Address", "Country", "Province", "City", "Timezone", "Currency", "Tax region", "Tourism tax region", "Business date rules"]
  },
  building: {
    title: "Buildings",
    route: "/backoffice/property-setup/buildings",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/building",
    target: "buildings",
    categories: ["Buildings", "Property mapper"],
    fields: ["Building name", "Building code", "Description", "Sort order", "Active"]
  },
  floor: {
    title: "Floors",
    route: "/backoffice/property-setup/floors",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/floor",
    target: "floors",
    categories: ["Floors", "Buildings", "Property mapper"],
    fields: ["Building", "Floor name", "Floor number", "Floor code", "Sort order", "Active"]
  },
  zone: {
    title: "Zones",
    route: "/backoffice/property-setup/zones",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/zone",
    target: "property_zones",
    categories: ["Zones", "Housekeeping sections", "Maintenance areas"],
    fields: ["Building", "Floor", "Zone name", "Zone type", "Code", "Description", "Housekeeping section", "Maintenance area", "Active"]
  },
  room_type: {
    title: "Room types",
    route: "/backoffice/property-setup/room-types",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/room_type",
    target: "room_types",
    categories: ["Room types", "Room features", "Bed types", "View types", "Accessibility features"],
    fields: ["Name", "Code", "Category", "Base occupancy", "Max occupancy", "Default bed setup", "Default features", "Default cleaning category", "Sellable", "Display order"]
  },
  room: {
    title: "Rooms",
    route: "/backoffice/property-setup/rooms",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/room",
    target: "rooms",
    categories: ["Rooms", "Room types", "Buildings", "Floors", "Zones", "Housekeeping sections", "Maintenance areas"],
    fields: ["Room number", "Display name", "Room type", "Building", "Floor", "Zone", "Occupancy", "Beds", "Features", "View", "Square meters", "Sellable", "Active", "Status"]
  },
  space_resource: {
    title: "Spaces and resources",
    route: "/backoffice/property-setup/spaces-resources",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/space_resource",
    target: "property_spaces + property_setup_form_submissions",
    categories: ["Spaces", "Bookable resources", "Resource types", "Space types"],
    fields: ["Name", "Code", "Resource type", "Space type", "Building", "Floor", "Zone", "Capacity", "Hourly bookable", "Daily bookable", "Sellable", "Tax code", "Default rate", "Active"]
  },
  department: {
    title: "Departments",
    route: "/backoffice/property-setup/departments",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/department",
    target: "departments + user_departments",
    categories: ["Departments", "Users", "Roles"],
    fields: ["Name", "Code", "Description", "Manager", "Users", "Active"]
  },
  housekeeping_setup: {
    title: "Housekeeping setup",
    route: "/backoffice/property-setup/operations",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/housekeeping_setup",
    target: "housekeeping_sections + housekeeping_rules",
    categories: ["Housekeeping sections", "Housekeeping task types", "Cleaning schemas"],
    fields: ["Section name", "Task types", "Cleaning schemas", "Default duration", "Inspection required", "Stayover policy", "Departure policy", "Linen rules"]
  },
  maintenance_setup: {
    title: "Maintenance setup",
    route: "/backoffice/property-setup/maintenance",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/maintenance_setup",
    target: "maintenance_areas + maintenance_rules",
    categories: ["Maintenance areas", "Maintenance issue types", "Work order priorities", "Asset categories"],
    fields: ["Area name", "Issue types", "Priority levels", "SLA rules", "Room blocking rules", "Asset categories", "Preventive maintenance categories"]
  },
  revenue_setup: {
    title: "Revenue setup",
    route: "/backoffice/property-setup/revenue",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/revenue_setup",
    target: "property_category_options + property_setup_form_submissions",
    categories: ["Market segments", "Source codes", "Channel categories", "Rate categories", "Forecast driver categories"],
    fields: ["Market segment", "Source code", "Channel category", "Rate category", "Demand event type", "Forecast driver category"]
  },
  finance_compliance_setup: {
    title: "Finance and compliance",
    route: "/backoffice/property-setup/finance-compliance",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/finance_compliance_setup",
    target: "property_compliance_settings + invoice_sequences",
    categories: ["Tax codes", "Payment method categories", "Invoice sequences", "Compliance settings", "Retention rules"],
    fields: ["Tax region", "Authority type", "Payment method category", "Invoice sequence code", "Invoice type", "Retention rule", "Submission mode"]
  },
  ai_setup: {
    title: "AI setup",
    route: "/backoffice/property-setup/ai",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/ai_setup",
    target: "property_ai_settings",
    categories: ["AI settings", "AI governance", "OCR privacy"],
    fields: ["AI enabled", "Default automation level", "Guest-facing disclosure", "Voice locales", "Document image retention policy", "Human review default"]
  },
  custom_field: {
    title: "Custom fields",
    route: "/backoffice/property-setup/custom-fields",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/custom_field",
    target: "property_custom_field_definitions",
    categories: ["Custom fields", "Validation rules", "Visibility rules"],
    fields: ["Entity type", "Field key", "Label", "Description", "Data type", "Required", "Searchable", "Visible in list", "Visible in detail"]
  }
};

const manualSetupOptions = [
  {
    code: "property_profile",
    group: "Property",
    title: "Property Profile",
    route: "/backoffice/property-setup/property-profile",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/property_profile",
    saveEndpoint: "/backoffice/properties/prop_123/property-setup/forms/property_profile",
    permission: "property_profile.edit",
    target: "properties, organizations, property_setup_form_submissions",
    categories: ["Property profile", "Legal profile", "Business date rules"],
    fields: ["Property name", "Legal name", "Tax ID", "Full address", "Country", "Region", "Timezone", "Currency", "Tax region"]
  },
  {
    code: "rooms_room_types",
    group: "Property",
    title: "Rooms & Room Types",
    route: "/backoffice/property-setup/rooms",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/room",
    saveEndpoint: "/backoffice/properties/prop_123/property-setup/forms/room",
    permission: "rooms.manage",
    target: "rooms, room_types, room_features, bed_types",
    categories: ["Rooms", "Room types", "Room features", "Bed types", "Housekeeping sections", "Maintenance areas"],
    fields: ["Room number", "Room type", "Building", "Floor", "Zone", "Occupancy", "Beds", "Features", "Sellable", "Status"]
  },
  {
    code: "spaces_resources",
    group: "Property",
    title: "Spaces & Bookable Resources",
    route: "/backoffice/property-setup/spaces-resources",
    endpoint: "/backoffice/properties/prop_123/property-setup/forms/space_resource",
    saveEndpoint: "/backoffice/properties/prop_123/property-setup/forms/space_resource",
    permission: "spaces.manage",
    target: "property_spaces, inventory_resources",
    categories: ["Spaces", "Bookable resources", "Resource types", "Space types"],
    fields: ["Name", "Code", "Resource type", "Space type", "Building", "Floor", "Capacity", "Bookable mode", "Tax code", "Default rate"]
  },
  {
    code: "category_manager",
    group: "Configuration",
    title: "Category Manager",
    route: "/backoffice/configuration/categories",
    endpoint: "/backoffice/properties/prop_123/configuration/categories",
    saveEndpoint: "/backoffice/properties/prop_123/configuration/categories/:categoryCode/options",
    permission: "categories.manage",
    target: "category_definitions, property_category_options",
    categories: ["Rooms", "Operations", "Revenue", "Distribution", "Finance", "Compliance", "POS", "Assets", "Safety", "AI"],
    fields: ["Category", "Option code", "Label", "Description", "Color token", "Icon", "Parent option", "Sort order", "Active"]
  },
  {
    code: "custom_fields",
    group: "Configuration",
    title: "Custom Fields",
    route: "/backoffice/configuration/custom-fields",
    endpoint: "/backoffice/properties/prop_123/configuration/custom-fields",
    saveEndpoint: "/backoffice/properties/prop_123/configuration/custom-fields",
    permission: "custom_fields.manage",
    target: "property_custom_field_definitions, property_custom_field_values",
    categories: ["Custom fields", "Validation rules", "Visibility rules"],
    fields: ["Entity type", "Field key", "Label", "Data type", "Required", "Searchable", "Visible in list", "Validation JSON"]
  },
  {
    code: "modules",
    group: "Modules",
    title: "Module Setup",
    route: "/backoffice/modules",
    endpoint: "/modules",
    saveEndpoint: "/properties/prop_123/modules/:moduleCode/enable",
    permission: "modules.configure",
    target: "modules, property_modules, module_configuration",
    categories: ["Modules", "Dependencies", "Health", "Setup status"],
    fields: ["Module code", "Enabled state", "Configuration JSON", "Dependency readiness", "Health state"]
  },
  {
    code: "integrations",
    group: "Modules",
    title: "Integration Marketplace",
    route: "/backoffice/marketplace",
    endpoint: "/integrations/properties/prop_123/providers",
    saveEndpoint: "/integrations/properties/prop_123/connect",
    permission: "integrations.connect",
    target: "integration_providers, property_integrations, integration_events",
    categories: ["Providers", "Credentials", "Capabilities", "Health", "Sync settings"],
    fields: ["Provider", "Credential secret ref", "Capabilities", "Test connection", "Sync mode", "Active state"]
  },
  {
    code: "users_roles",
    group: "Configuration",
    title: "Users & Roles",
    route: "/backoffice/users-roles",
    endpoint: "/backoffice/properties/prop_123/users",
    saveEndpoint: "/backoffice/properties/prop_123/users",
    permission: "users.read",
    target: "users, roles, user_departments",
    categories: ["Users", "Roles", "Permissions", "Departments"],
    fields: ["Email", "Full name", "Role", "Department", "Permission set", "MFA required", "Active state"]
  },
  {
    code: "revenue_settings",
    group: "Revenue",
    title: "Revenue Settings",
    route: "/backoffice/revenue/settings",
    endpoint: "/revenue/properties/prop_123/dashboard",
    saveEndpoint: "/revenue/properties/prop_123/automation-rules",
    permission: "revenue.configure",
    target: "rate_plans, rate_days, inventory_days, restriction_days, revenue_automation_rules",
    categories: ["Rate plans", "Restrictions", "Automation", "Approval thresholds"],
    fields: ["Default currency", "Forecast horizon", "Pricing horizon", "Min/max price", "Target occupancy", "Automation level"]
  },
  {
    code: "rate_grid",
    group: "Revenue",
    title: "Rate Grid",
    route: "/backoffice/revenue/rate-grid",
    endpoint: "/revenue/properties/prop_123/rate-grid",
    saveEndpoint: "/revenue/properties/prop_123/rate-grid/bulk-update",
    permission: "revenue.manage_rates",
    target: "rate_days, inventory_days, restriction_days",
    categories: ["Rates", "Inventory", "Restrictions", "Manual overrides"],
    fields: ["Date", "Room type", "Rate plan", "Price", "Available count", "Stop sell", "Min stay", "CTA", "CTD"]
  },
  {
    code: "history_forecast",
    group: "Revenue",
    title: "History & Forecast",
    route: "/backoffice/revenue/history-forecast",
    endpoint: "/revenue/properties/prop_123/history-forecast",
    saveEndpoint: "/revenue/properties/prop_123/history-forecast/saved-views",
    permission: "revenue.history_forecast.read",
    target: "revenue_daily_snapshots, revenue_forecast_snapshots, revenue_report_views",
    categories: ["Revenue snapshots", "Forecast snapshots", "Saved views", "Export settings"],
    fields: ["From date", "To date", "Granularity", "Room type", "Channel", "Comparison period", "Visible KPIs", "Export format"]
  },
  {
    code: "channel_connections",
    group: "Channel Manager",
    title: "Channel Connections",
    route: "/backoffice/channel-manager/channels",
    endpoint: "/channel-manager/properties/prop_123/channels",
    saveEndpoint: "/channel-manager/properties/prop_123/channels",
    permission: "channel_manager.manage",
    target: "channels, channel_sync_jobs",
    categories: ["Channels", "Credentials", "Costs", "Sync settings", "Health"],
    fields: ["Provider code", "Name", "Channel type", "Commission", "Payment cost", "Credentials secret ref", "Status"]
  },
  {
    code: "channel_mappings",
    group: "Channel Manager",
    title: "Channel Mappings",
    route: "/backoffice/channel-manager/mappings",
    endpoint: "/channel-manager/channels/channel_booking_mock/room-mappings",
    saveEndpoint: "/channel-manager/channels/channel_booking_mock/room-mappings",
    permission: "channel_manager.mappings.manage",
    target: "channel_room_mappings, channel_rate_mappings",
    categories: ["Room mappings", "Rate mappings", "Mapping health"],
    fields: ["Channel", "Internal room type", "External room code", "Internal rate plan", "External rate code", "Mapping status"]
  },
  {
    code: "billing",
    group: "Finance",
    title: "Billing & Invoice Sequences",
    route: "/backoffice/billing",
    endpoint: "/backoffice/properties/prop_123/billing-settings",
    saveEndpoint: "/backoffice/properties/prop_123/billing-settings",
    permission: "billing.configure",
    target: "invoice_sequences, property_modules",
    categories: ["Billing", "Invoice sequences", "Tax settings", "Legal numbering"],
    fields: ["Sequence code", "Prefix", "Next number", "Invoice type", "Tax region", "Active state"]
  },
  {
    code: "payments",
    group: "Finance",
    title: "Payment Settings",
    route: "/backoffice/payments",
    endpoint: "/integrations/properties/prop_123/providers",
    saveEndpoint: "/integrations/properties/prop_123/connect",
    permission: "payments.configure",
    target: "property_integrations, payments, payment_intents",
    categories: ["Payment gateways", "Tokenization", "Capture rules", "Refund rules"],
    fields: ["Provider", "Merchant account", "Secret ref", "Capture policy", "Refund policy", "Webhook status"]
  },
  {
    code: "accounting",
    group: "Finance",
    title: "Accounting Settings",
    route: "/backoffice/accounting",
    endpoint: "/backoffice/properties/prop_123/accounting-settings",
    saveEndpoint: "/backoffice/properties/prop_123/accounting-settings",
    permission: "accounting.configure",
    target: "accounting_settings, accounts, journal_entries",
    categories: ["Chart of accounts", "Cost centers", "Exports", "ERP sync"],
    fields: ["Default revenue account", "Tax account", "Payment clearing account", "Cost center rules", "Export format"]
  },
  {
    code: "spain_guest_register",
    group: "Compliance",
    title: "Spain Guest Register",
    route: "/backoffice/compliance/spain-guest-register",
    endpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    permission: "guest_register.configure",
    target: "authority_reporting_settings, lodging_legal_profiles, guest_register_records",
    categories: ["Guest register", "Legal fields", "Signatures", "OCR privacy", "Retention"],
    fields: ["Enable compliance", "Professional activity", "Required fields", "Signature rule", "Identity verification method", "ID image storage policy"]
  },
  {
    code: "ses_hospedajes",
    group: "Compliance",
    title: "SES.HOSPEDAJES Settings",
    route: "/backoffice/compliance/ses-hospedajes",
    endpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    permission: "compliance.ses.configure",
    target: "authority_reporting_settings, authority_submission_batches, authority_submissions",
    categories: ["Authority settings", "SES credentials", "Batch export", "Submission queue", "Official schemas"],
    fields: ["Authority target", "Establishment code", "Landlord code", "Web service username", "Secret ref", "Batch time", "Automatic submission"]
  },
  {
    code: "authority_routing",
    group: "Compliance",
    title: "Authority Routing",
    route: "/backoffice/compliance/authority-routing",
    endpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    permission: "guest_register.configure",
    target: "authority_routing_rules, authority_reporting_settings",
    categories: ["Authority routing", "Region rules", "Adapter configuration"],
    fields: ["Country", "Region code", "Authority type", "Priority", "Enabled", "Override reason"]
  },
  {
    code: "ai_setup",
    group: "AI",
    title: "AI Setup Wizard",
    route: "/backoffice/ai-setup",
    endpoint: "/onboarding/projects",
    saveEndpoint: "/onboarding/projects",
    permission: "onboarding.read",
    target: "onboarding_projects, onboarding_files, onboarding_mapping_suggestions",
    categories: ["Source PMS", "Files", "Blueprint", "Mappings", "Dry-run", "Go-live readiness"],
    fields: ["Source system", "Import method", "Uploaded files", "Human review", "Dry-run approval", "Go-live target date"]
  },
  {
    code: "ai_governance",
    group: "AI",
    title: "AI Governance",
    route: "/backoffice/ai-governance",
    endpoint: "/ai-governance/policies",
    saveEndpoint: "/ai-governance/policies",
    permission: "ai_governance.read",
    target: "ai_policies, ai_tool_registry, ai_prompt_versions, ai_human_review",
    categories: ["AI policies", "Tool registry", "Prompt versions", "Human review", "Incidents"],
    fields: ["Policy", "Tool enablement", "Risk threshold", "Confirmation rule", "Human review role", "Disclosure text"]
  }
];

manualSetupOptions.push(
  {
    code: "rate_plans",
    group: "Revenue",
    title: "Rate Plans & Rate Categories",
    route: "/backoffice/revenue/rate-plans",
    endpoint: "/revenue/properties/prop_123/rate-plans",
    saveEndpoint: "/revenue/properties/prop_123/rate-plans",
    permission: "revenue.manage_rates",
    target: "rate_plans, property_category_options",
    categories: ["Rate plans", "Rate categories", "Derivation rules", "Meal plan", "Cancellation policy"],
    fields: ["Rate plan code", "Name", "Rate plan type", "Parent rate plan", "Derivation rule", "Min price", "Max price", "Active state"]
  },
  {
    code: "forecast_settings",
    group: "Revenue",
    title: "Forecast Settings",
    route: "/backoffice/revenue/forecast-explorer",
    endpoint: "/revenue/properties/prop_123/forecasts",
    saveEndpoint: "/revenue/properties/prop_123/forecasts/generate",
    permission: "revenue.forecast.read",
    target: "revenue_forecasts, revenue_forecast_snapshots",
    categories: ["Forecast horizon", "Confidence thresholds", "Comparison period", "Model inputs", "Data quality"],
    fields: ["Forecast horizon", "Granularity", "Comparison period", "Confidence threshold", "Data quality blocker", "Regeneration schedule"]
  },
  {
    code: "demand_calendar",
    group: "Revenue",
    title: "Demand Calendar",
    route: "/backoffice/revenue/demand-calendar",
    endpoint: "/revenue/properties/prop_123/demand-calendar",
    saveEndpoint: "/revenue/properties/prop_123/demand-calendar",
    permission: "revenue.configure",
    target: "demand_calendar_events, property_category_options",
    categories: ["Demand events", "Event types", "Impact scores", "Source", "Date range"],
    fields: ["Event name", "Event type", "Start date", "End date", "Expected impact", "Impact score", "Source"]
  },
  {
    code: "rate_shopper",
    group: "Revenue",
    title: "Rate Shopper & Competitor Set",
    route: "/backoffice/revenue/rate-shopper",
    endpoint: "/rate-shopper/properties/prop_123/competitors",
    saveEndpoint: "/rate-shopper/properties/prop_123/competitors",
    permission: "revenue.configure",
    target: "competitor_hotels, competitor_rate_snapshots",
    categories: ["Competitor set", "Comparable room types", "Source channels", "Rate snapshots", "Parity alerts"],
    fields: ["Competitor name", "Distance", "Star rating", "Comparable score", "Comparable room type", "Source channel", "Active state"]
  },
  {
    code: "revenue_automation",
    group: "Revenue",
    title: "Recommendation & Automation Rules",
    route: "/backoffice/revenue/scenario-simulator",
    endpoint: "/revenue/properties/prop_123/automation-rules",
    saveEndpoint: "/revenue/properties/prop_123/automation-rules",
    permission: "revenue.automation.manage",
    target: "revenue_automation_rules, revenue_recommendations, revenue_scenarios",
    categories: ["Automation level", "Approval thresholds", "Safety constraints", "Scenario defaults", "Blocked actions"],
    fields: ["Rule name", "Automation level", "Scope", "Min/max price", "Max daily change", "Approval threshold", "Active state"]
  },
  {
    code: "channel_sync_rules",
    group: "Channel Manager",
    title: "Channel Sync Rules & Health",
    route: "/backoffice/channel-manager/sync-health",
    endpoint: "/channel-manager/properties/prop_123/sync-health",
    saveEndpoint: "/channel-manager/properties/prop_123/sync-rules",
    permission: "channel_manager.sync",
    target: "channel_sync_jobs, channels, channel_room_mappings, channel_rate_mappings",
    categories: ["Sync cadence", "Retry policy", "ARI payload rules", "Overbooking protection", "Health alerts"],
    fields: ["Channel", "Sync type", "Cadence", "Retry limit", "Stale-rate guard", "Mapping validation", "Alert recipients"]
  },
  {
    code: "tax_settings",
    group: "Finance",
    title: "Tax, Fees & Tourism Tax Settings",
    route: "/backoffice/tax-settings",
    endpoint: "/backoffice/properties/prop_123/compliance-settings",
    saveEndpoint: "/backoffice/properties/prop_123/compliance-settings",
    permission: "compliance_setup.manage",
    target: "property_compliance_settings, property_category_options",
    categories: ["Tax region", "Tourism tax", "Tax codes", "Fee rules", "Invoice tax behavior"],
    fields: ["Country", "Tax region", "Tax code", "Tax rate", "Tourism tax rule", "Invoice applicability", "Effective date"]
  },
  {
    code: "pos_outlets",
    group: "Finance",
    title: "POS Outlets & Product Categories",
    route: "/backoffice/pos-outlets",
    endpoint: "/backoffice/properties/prop_123/pos-outlets",
    saveEndpoint: "/backoffice/properties/prop_123/pos-outlets",
    permission: "configuration.manage",
    target: "property_spaces, inventory_resources, property_category_options, accounting_settings",
    categories: ["Outlets", "POS product categories", "Tax codes", "Revenue centers", "Posting rules"],
    fields: ["Outlet name", "Outlet code", "Product category", "Tax code", "Revenue account", "Posting rule", "Active state"]
  },
  {
    code: "procurement_inventory",
    group: "Operations",
    title: "Procurement & Inventory Setup",
    route: "/backoffice/procurement-inventory",
    endpoint: "/backoffice/properties/prop_123/procurement-inventory",
    saveEndpoint: "/backoffice/properties/prop_123/procurement-inventory",
    permission: "configuration.manage",
    target: "property_category_options, accounting_settings, property_spaces",
    categories: ["Suppliers", "Stock locations", "Inventory categories", "Reorder rules", "Procurement approvals"],
    fields: ["Supplier", "Stock location", "Product category", "Reorder threshold", "Approval role", "Cost center", "Active state"]
  },
  {
    code: "assets_capex_energy",
    group: "Operations",
    title: "Assets, Capex & Energy Setup",
    route: "/backoffice/assets-capex-energy",
    endpoint: "/backoffice/properties/prop_123/assets-capex-energy",
    saveEndpoint: "/backoffice/properties/prop_123/assets-capex-energy",
    permission: "configuration.manage",
    target: "property_category_options, maintenance_areas, property_spaces",
    categories: ["Asset categories", "Preventive maintenance", "Capex", "Energy meters", "Sustainability"],
    fields: ["Asset category", "Maintenance area", "Preventive schedule", "Capex category", "Meter type", "Reporting owner"]
  },
  {
    code: "workforce_labor",
    group: "Operations",
    title: "Workforce & Labor Setup",
    route: "/backoffice/workforce",
    endpoint: "/backoffice/properties/prop_123/workforce",
    saveEndpoint: "/backoffice/properties/prop_123/workforce",
    permission: "configuration.manage",
    target: "departments, users, user_departments, property_category_options",
    categories: ["Roles", "Shifts", "Scheduling rules", "Labor demand", "Payroll export"],
    fields: ["Role", "Department", "Shift type", "Coverage rule", "Approval role", "Payroll export code", "Active state"]
  },
  {
    code: "safety_incidents",
    group: "Operations",
    title: "Safety & Incident Setup",
    route: "/backoffice/safety-incidents",
    endpoint: "/backoffice/properties/prop_123/safety-incidents",
    saveEndpoint: "/backoffice/properties/prop_123/safety-incidents",
    permission: "operations_setup.manage",
    target: "property_category_options, property_compliance_settings, departments",
    categories: ["Safety incidents", "Severity", "Workflows", "Emergency contacts", "Audit reporting"],
    fields: ["Incident category", "Severity", "Response SLA", "Responsible role", "Emergency contact", "Escalation rule"]
  },
  {
    code: "guest_register_retention",
    group: "Compliance",
    title: "Guest Register Retention & Field Mapping",
    route: "/backoffice/compliance/guest-register-retention",
    endpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/prop_123/guest-register/settings",
    permission: "guest_register.configure",
    target: "guest_register_records, authority_reporting_settings, identity_document_processing_events",
    categories: ["Retention", "Field mapping", "Sensitive access", "Document minimization", "Deletion policy"],
    fields: ["Retention years", "Retention start event", "Sensitive field policy", "Authority field mapping", "Deletion/anonymization rule", "Audit role"]
  },
  {
    code: "guest_portal",
    group: "Guest Experience",
    title: "Guest Portal & Online Check-in",
    route: "/backoffice/guest-portal",
    endpoint: "/guest-self-service/properties/prop_123/settings",
    saveEndpoint: "/guest-self-service/properties/prop_123/settings",
    permission: "guest_portal.configure",
    target: "guest_journey_events, property_modules, property_custom_field_definitions",
    categories: ["Guest portal", "Online check-in", "Payment verification", "Upsells", "Guest disclosures"],
    fields: ["Portal enabled", "Required check-in fields", "Payment verification rule", "Signature rule", "Upsell categories", "Disclosure text"]
  },
  {
    code: "concierge_messaging",
    group: "Guest Experience",
    title: "Concierge & Messaging Templates",
    route: "/backoffice/concierge-messaging",
    endpoint: "/guest-experience/properties/prop_123/messaging-settings",
    saveEndpoint: "/guest-experience/properties/prop_123/messaging-settings",
    permission: "guest_portal.configure",
    target: "property_category_options, property_modules, ai_policies",
    categories: ["Message templates", "Channels", "Guest request categories", "AI disclosure", "Escalation"],
    fields: ["Template name", "Language", "Channel", "Trigger", "Disclosure text", "Escalation owner", "Active state"]
  },
  {
    code: "analytics_owner_reporting",
    group: "Platform",
    title: "Analytics & Owner Reporting",
    route: "/backoffice/analytics-reporting",
    endpoint: "/analytics/properties/prop_123/settings",
    saveEndpoint: "/analytics/properties/prop_123/settings",
    permission: "analytics.read",
    target: "revenue_report_views, property_custom_field_definitions, property_modules",
    categories: ["Metrics", "Saved views", "Scheduled reports", "Owner sections", "Export defaults"],
    fields: ["Metric definition", "Visible dashboard section", "Scheduled report recipient", "Export format", "Owner access role", "Data quality rule"]
  },
  {
    code: "audit_security",
    group: "Platform",
    title: "Audit, Security & Access Policies",
    route: "/backoffice/security",
    endpoint: "/backoffice/properties/prop_123/security-settings",
    saveEndpoint: "/backoffice/properties/prop_123/security-settings",
    permission: "configuration.manage",
    target: "users, roles, audit_events, property_modules",
    categories: ["MFA", "Sensitive access", "Audit retention", "Role review", "Security alerts"],
    fields: ["MFA rule", "Sensitive permission", "Audit retention period", "Role review cadence", "Alert recipient", "Exception approval"]
  }
);

const manualSetupInputMethodCatalog = {
  manual_form: ["Manual form", "Direct form entry with validation and audit trail."],
  guided_wizard: ["Guided wizard", "Step-by-step setup flow for non-technical hotel users."],
  bulk_csv_xlsx: ["CSV/XLSX import", "Spreadsheet upload with preview, create/update/skip counts and confirmation."],
  template_apply: ["Setup template", "Apply hotel-type templates after preview and duplicate checks."],
  ai_assisted: ["AI assisted input", "AI suggests values or mappings; human review is mandatory."],
  api_connector: ["API connector", "Pull setup data from source PMS, provider or channel API."],
  voice_text: ["Voice/text description", "Describe the hotel setup by voice or text, then review structured output."],
  floor_plan_upload: ["Floor plan upload", "Upload floor plans or room maps and confirm extracted rooms/resources."],
  room_walk: ["Room Walk Setup", "Walk through the property and dictate rooms, zones and resource ranges."],
  grid_editor: ["Grid editor", "Dense editable grid for rates, mappings, categories and restrictions."],
  report_upload: ["Report upload", "Upload legacy PMS reports, extract rows and validate totals."],
  credential_secret: ["Credential secret", "Store credentials as secret refs, never plain text."],
  test_connection: ["Test connection", "Validate credentials, mappings and provider health before enabling."],
  dry_run: ["Dry-run preview", "Preview creates, updates, skips and blockers before applying."]
};

function methodLabels(codes) {
  return codes.map((code) => ({ code, label: manualSetupInputMethodCatalog[code][0], detail: manualSetupInputMethodCatalog[code][1] }));
}

function manualSetupInputMethodsFor(option) {
  if (option.code === "ai_setup") return methodLabels(["guided_wizard", "bulk_csv_xlsx", "report_upload", "api_connector", "floor_plan_upload", "voice_text", "dry_run"]);
  if (["rooms_room_types", "spaces_resources"].includes(option.code)) return methodLabels(["manual_form", "guided_wizard", "bulk_csv_xlsx", "room_walk", "floor_plan_upload", "ai_assisted"]);
  if (option.code === "category_manager" || option.code === "custom_fields") return methodLabels(["manual_form", "grid_editor", "bulk_csv_xlsx", "template_apply", "ai_assisted"]);
  if (option.code === "rate_grid") return methodLabels(["grid_editor", "bulk_csv_xlsx", "template_apply", "ai_assisted", "dry_run"]);
  if (option.code === "history_forecast") return methodLabels(["manual_form", "report_upload", "bulk_csv_xlsx", "api_connector", "ai_assisted"]);
  if (option.code === "channel_connections" || option.code === "integrations") return methodLabels(["guided_wizard", "api_connector", "credential_secret", "test_connection", "manual_form"]);
  if (option.code === "channel_mappings") return methodLabels(["grid_editor", "bulk_csv_xlsx", "api_connector", "ai_assisted", "test_connection"]);
  if (option.group === "Channel Manager") return methodLabels(["guided_wizard", "api_connector", "grid_editor", "test_connection", "dry_run"]);
  if (["spain_guest_register", "ses_hospedajes", "authority_routing"].includes(option.code)) return methodLabels(["manual_form", "guided_wizard", "credential_secret", "test_connection", "dry_run"]);
  if (option.group === "Finance") return methodLabels(["manual_form", "guided_wizard", "bulk_csv_xlsx", "api_connector", "test_connection"]);
  if (option.group === "AI") return methodLabels(["manual_form", "guided_wizard", "ai_assisted", "dry_run"]);
  return methodLabels(["manual_form", "guided_wizard", "bulk_csv_xlsx", "ai_assisted"]);
}

function manualSetupCompletionChecksFor(option) {
  const checks = [
    ["blocking", `Required permission ${option.permission} is granted`],
    ["blocking", "All required inputs are present and valid"],
    ["blocking", `Save endpoint ${option.saveEndpoint} is available`],
    ["warning", "Create/update action writes an audit event"]
  ];
  if (option.group === "Revenue" || option.group === "Channel Manager") checks.push(["blocking", "Data quality and mapping blockers are resolved"]);
  if (option.group === "Compliance" || option.group === "Finance") checks.push(["blocking", "Legally controlled values are selected from controlled categories"]);
  if (option.group === "AI") checks.push(["blocking", "AI suggestions require human review before applying"]);
  if (option.categories.some((category) => category.toLowerCase().includes("credential"))) checks.push(["blocking", "Credentials are stored as secret references"]);
  return checks;
}

function manualSetupCoverageIssues() {
  const requiredFields = ["code", "group", "title", "route", "endpoint", "saveEndpoint", "permission", "target"];
  return manualSetupOptions.flatMap((option) => {
    const issues = requiredFields
      .filter((field) => !option[field])
      .map((field) => ({ optionCode: option.code || "unknown", field, severity: "blocking" }));
    if (!option.categories?.length) issues.push({ optionCode: option.code, field: "categories", severity: "blocking" });
    if (!option.fields?.length) issues.push({ optionCode: option.code, field: "fields", severity: "blocking" });
    if (!manualSetupInputMethodsFor(option).length) issues.push({ optionCode: option.code, field: "inputMethods", severity: "blocking" });
    if (!manualSetupCompletionChecksFor(option).length) issues.push({ optionCode: option.code, field: "completionChecks", severity: "blocking" });
    return issues;
  });
}

function manualSetupCoverageSummary() {
  const issues = manualSetupCoverageIssues();
  return {
    totalOptions: manualSetupOptions.length,
    uncheckedOptions: issues.filter((issue) => issue.severity === "blocking").length,
    issues
  };
}

function groupedManualSetupOptions() {
  return manualSetupOptions.reduce((groups, option) => {
    if (!groups[option.group]) groups[option.group] = [];
    groups[option.group].push(option);
    return groups;
  }, {});
}

function renderManualSetupHub() {
  const container = document.getElementById("manualSetupGroups");
  if (!container) return;
  container.innerHTML = "";
  const coverage = manualSetupCoverageSummary();
  const total = document.getElementById("manualSetupCoverageTotal");
  const unchecked = document.getElementById("manualSetupCoverageUnchecked");
  const groupsCount = document.getElementById("manualSetupCoverageGroups");
  if (total) total.textContent = `${coverage.totalOptions} setup routes`;
  if (unchecked) unchecked.textContent = `${coverage.uncheckedOptions} unchecked blockers`;
  if (groupsCount) groupsCount.textContent = `${Object.keys(groupedManualSetupOptions()).length} setup groups`;
  Object.entries(groupedManualSetupOptions()).forEach(([group, options]) => {
    const section = document.createElement("section");
    section.className = "panel";
    section.innerHTML = `<div class="panel-head"><div><p class="eyebrow">Manual setup</p><h2>${group}</h2></div><span class="count-pill">${options.length} routes</span></div>`;
    const grid = document.createElement("div");
    grid.className = "market-grid";
    options.forEach((option) => {
      const card = document.createElement("article");
      card.className = "market-card enabled";
      const methodSummary = manualSetupInputMethodsFor(option).map((method) => method.label).slice(0, 3).join(", ");
      card.innerHTML = `<strong>${option.title}</strong><span>${option.route}<br />Methods: ${methodSummary}<br />${option.fields.slice(0, 4).join(", ")}...</span><button data-manual-setup="${option.code}" type="button">Open setup</button>`;
      grid.appendChild(card);
    });
    section.appendChild(grid);
    container.appendChild(section);
  });
  bindManualSetupButtons();
}

function renderManualSetupOption(optionCode) {
  const option = manualSetupOptions.find((candidate) => candidate.code === optionCode) ?? manualSetupOptions[0];
  window.currentManualSetupOptionCode = option.code;
  document.getElementById("manualSetupOptionTitle").textContent = option.title;
  document.getElementById("manualSetupOptionRoute").textContent = option.route;
  document.getElementById("manualSetupOptionEndpoint").textContent = option.endpoint;
  document.getElementById("manualSetupOptionSaveEndpoint").textContent = option.saveEndpoint;
  document.getElementById("manualSetupOptionPermission").textContent = option.permission;
  document.getElementById("manualSetupOptionTarget").textContent = option.target;
  const categories = document.getElementById("manualSetupOptionCategories");
  categories.innerHTML = "";
  option.categories.forEach((category) => {
    const chip = document.createElement("span");
    chip.className = "status-badge queued";
    chip.textContent = category;
    categories.appendChild(chip);
  });
  const fields = document.getElementById("manualSetupOptionFields");
  fields.innerHTML = "";
  option.fields.forEach((field) => {
    const row = document.createElement("label");
    row.className = "form-line";
    row.innerHTML = `<span>${field}</span><input aria-label="${field}" placeholder="${field}" />`;
    fields.appendChild(row);
  });
  const methods = document.getElementById("manualSetupOptionMethods");
  methods.innerHTML = "";
  manualSetupInputMethodsFor(option).forEach((method) => {
    const card = document.createElement("article");
    card.className = "market-card enabled";
    card.innerHTML = `<strong>${method.label}</strong><span>${method.detail}</span><button type="button">Use ${method.label}</button>`;
    methods.appendChild(card);
  });
  const checks = document.getElementById("manualSetupOptionChecks");
  checks.innerHTML = "";
  manualSetupCompletionChecksFor(option).forEach(([severity, label]) => {
    const row = document.createElement("div");
    row.className = "arrival-row";
    row.innerHTML = `<span class="status-badge ${severity === "blocking" ? "failed" : "review"}">${severity}</span><div><strong>${label}</strong><span>Checked before this setup area can be considered complete.</span></div>`;
    checks.appendChild(row);
  });
  renderManualSetupSaveStatus(option.code);
}

function manualSetupSubmissionStorageKey() {
  return "hotelos.manualSetupSubmissions";
}

function readManualSetupSubmissions() {
  try {
    return JSON.parse(window.localStorage.getItem(manualSetupSubmissionStorageKey()) || "[]");
  } catch {
    return [];
  }
}

function writeManualSetupSubmissions(submissions) {
  window.localStorage.setItem(manualSetupSubmissionStorageKey(), JSON.stringify(submissions));
}

function renderManualSetupSaveStatus(optionCode) {
  const status = document.getElementById("manualSetupOptionSaveStatus");
  if (!status) return;
  const latest = readManualSetupSubmissions().filter((submission) => submission.optionCode === optionCode).at(-1);
  status.textContent = latest
    ? `Saved locally to manual setup submission store at ${latest.createdAt}. API target: ${latest.saveEndpoint}.`
    : "No submission saved in this browser yet.";
}

function saveManualSetupOptionDemo() {
  const optionCode = window.currentManualSetupOptionCode;
  const option = manualSetupOptions.find((candidate) => candidate.code === optionCode);
  if (!option) return;
  const values = {};
  document.querySelectorAll("#manualSetupOptionFields input").forEach((input) => {
    values[input.getAttribute("aria-label")] = input.value;
  });
  const missing = option.fields.filter((field) => !values[field] || !String(values[field]).trim());
  const submission = {
    id: `manual_${Date.now()}`,
    propertyId: "prop_123",
    optionCode: option.code,
    status: missing.length ? "failed" : "saved",
    payloadJson: { values },
    validationErrorsJson: missing.map((field) => `${field} is required.`),
    inputCategories: option.categories,
    targetTables: option.target.split(",").map((table) => table.trim()),
    saveEndpoint: option.saveEndpoint,
    createdAt: new Date().toISOString()
  };
  const submissions = readManualSetupSubmissions();
  submissions.push(submission);
  writeManualSetupSubmissions(submissions);
  const status = document.getElementById("manualSetupOptionSaveStatus");
  if (status) {
    status.textContent = missing.length
      ? `Validation failed: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "..." : ""}`
      : `Saved locally to manual setup submission store. Production endpoint: ${option.saveEndpoint}`;
  }
}

function renderPropertyForm(formCode) {
  const form = propertySetupForms[formCode] ?? propertySetupForms.property_profile;
  window.currentPropertyFormCode = formCode;
  document.getElementById("propertyFormTitle").textContent = form.title;
  document.getElementById("propertyFormRoute").textContent = form.route;
  document.getElementById("propertyFormEndpoint").textContent = form.endpoint;
  document.getElementById("propertyFormTarget").textContent = form.target;
  const categories = document.getElementById("propertyFormCategories");
  categories.innerHTML = "";
  form.categories.forEach((category) => {
    const chip = document.createElement("span");
    chip.className = "status-badge queued";
    chip.textContent = category;
    categories.appendChild(chip);
  });
  const fields = document.getElementById("propertyFormFields");
  fields.innerHTML = "";
  form.fields.forEach((field) => {
    const row = document.createElement("label");
    row.className = "form-line";
    row.innerHTML = `<span>${field}</span><input aria-label="${field}" placeholder="${field}" />`;
    fields.appendChild(row);
  });
  renderPropertyFormSaveStatus(formCode);
}

function propertySetupSubmissionStorageKey() {
  return "hotelos.propertySetupFormSubmissions";
}

function readPropertySetupSubmissions() {
  try {
    return JSON.parse(window.localStorage.getItem(propertySetupSubmissionStorageKey()) || "[]");
  } catch {
    return [];
  }
}

function writePropertySetupSubmissions(submissions) {
  window.localStorage.setItem(propertySetupSubmissionStorageKey(), JSON.stringify(submissions));
}

function renderPropertyFormSaveStatus(formCode) {
  const status = document.getElementById("propertyFormSaveStatus");
  if (!status) return;
  const latest = readPropertySetupSubmissions().filter((submission) => submission.formCode === formCode).at(-1);
  status.textContent = latest
    ? `Saved locally at ${latest.createdAt}. API target: ${latest.endpoint}. Status: ${latest.status}.`
    : "No property setup submission saved in this browser yet.";
}

function savePropertyFormDemo() {
  const formCode = window.currentPropertyFormCode || "property_profile";
  const form = propertySetupForms[formCode] ?? propertySetupForms.property_profile;
  const values = {};
  document.querySelectorAll("#propertyFormFields input").forEach((input) => {
    values[input.getAttribute("aria-label")] = input.value;
  });
  const missing = form.fields.filter((field) => !values[field] || !String(values[field]).trim());
  const submission = {
    id: `property_form_${Date.now()}`,
    propertyId: "prop_123",
    formCode,
    status: missing.length ? "failed" : "saved",
    payloadJson: values,
    validationErrorsJson: missing.map((field) => `${field} is required.`),
    targetEntityType: form.target,
    endpoint: form.endpoint,
    inputCategories: form.categories,
    createdAt: new Date().toISOString()
  };
  const submissions = readPropertySetupSubmissions();
  submissions.push(submission);
  writePropertySetupSubmissions(submissions);
  const status = document.getElementById("propertyFormSaveStatus");
  if (status) {
    status.textContent = missing.length
      ? `Validation failed: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "..." : ""}`
      : `Saved locally to property setup form submissions. Production endpoint: ${form.endpoint}`;
  }
}

function readDemoJson(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function writeDemoJson(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function saveReservationDemo() {
  const fields = ["arrivalDate", "departureDate", "guestFirstName", "guestSurname", "reservationChannel", "reservationSource", "marketSegment", "billingInstruction", "reservationAmount"];
  const payload = Object.fromEntries(fields.map((field) => [field, document.getElementById(field)?.value ?? ""]));
  const missing = ["arrivalDate", "departureDate", "guestFirstName", "guestSurname"].filter((field) => !String(payload[field]).trim());
  const reservation = {
    id: `res_demo_${Date.now()}`,
    code: `RES-DEMO-${Date.now().toString().slice(-5)}`,
    status: missing.length ? "draft" : "confirmed",
    payload,
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios", "audit_events"],
    endpoint: "/properties/prop_123/reservations",
    createdAt: new Date().toISOString()
  };
  const reservations = readDemoJson(demoReservationsStorageKey);
  reservations.push(reservation);
  writeDemoJson(demoReservationsStorageKey, reservations);
  const status = document.getElementById("reservationSaveStatus");
  if (status) {
    status.textContent = missing.length
      ? `Draft saved, missing: ${missing.join(", ")}`
      : `Reservation ${reservation.code} saved locally. Production endpoint: /properties/prop_123/reservations`;
  }
}

function saveInvoiceDemo() {
  const total = document.getElementById("invoiceTotal")?.value || "0";
  const taxTotal = document.getElementById("invoiceTaxTotal")?.value || "0";
  const invoice = {
    id: `inv_demo_${Date.now()}`,
    status: "draft",
    invoiceType: document.getElementById("invoiceType")?.value || "full",
    customerType: document.getElementById("invoiceCustomerType")?.value || "guest",
    total,
    taxTotal,
    endpoint: "/invoices/drafts",
    targetTables: ["invoices", "invoice_lines", "invoice_sequences", "audit_events"],
    createdAt: new Date().toISOString()
  };
  const invoices = readDemoJson(demoInvoicesStorageKey);
  invoices.push(invoice);
  writeDemoJson(demoInvoicesStorageKey, invoices);
  const status = document.getElementById("invoiceSaveStatus");
  if (status) status.textContent = `Invoice draft ${invoice.id} saved locally. Issue route: /invoices/:id/issue`;
}

function generateReportDemo() {
  const status = document.getElementById("reportExportStatus");
  if (status) {
    const reportType = document.getElementById("reportType")?.value || "reservation";
    const format = document.getElementById("reportFormat")?.value || "pdf";
    status.textContent = `Prepared ${reportType} report export as ${format}. Production endpoint: /reports/properties/prop_123/export`;
  }
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === id);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === id);
  });
  document.getElementById("screenTitle").textContent = titles[id] ?? "HotelOS";
}

function updateFlowStep(index) {
  document.querySelectorAll("#flowSteps span").forEach((step) => {
    const stepIndex = Number(step.dataset.step);
    step.classList.toggle("done", stepIndex < index);
    step.classList.toggle("active", stepIndex === index);
  });
}

function renderTimeline(steps) {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";
  steps.forEach(([title, detail]) => {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${title}</strong><span>${detail}</span>`;
    timeline.appendChild(item);
  });
}

function runDemo() {
  showScreen("ai");
  const card = document.getElementById("confirmationCard");
  const confirm = document.getElementById("confirmCheckIn");
  const state = document.getElementById("stateLine");
  card.hidden = true;
  confirm.disabled = true;
  state.textContent = "Listening to receptionist command...";
  document.getElementById("riskBadge").textContent = "Listening";
  updateFlowStep(0);
  renderTimeline([["Listening", "Microphone input started."]]);

  timelineSteps.forEach((step, index) => {
    window.setTimeout(() => {
      renderTimeline(timelineSteps.slice(0, index + 1));
      state.textContent = step[1];
      updateFlowStep(Math.min(index + 1, 5));
      if (index === timelineSteps.length - 1) {
        card.hidden = false;
        confirm.disabled = false;
        document.getElementById("riskBadge").textContent = "Human approval";
      }
    }, 520 * (index + 1));
  });
}

function confirmCheckIn() {
  const state = document.getElementById("stateLine");
  const confirm = document.getElementById("confirmCheckIn");
  confirm.disabled = true;
  state.textContent = "Executing permissioned backend tools...";
  document.getElementById("riskBadge").textContent = "Executing";
  updateFlowStep(5);
  renderTimeline([...timelineSteps, ...executedSteps]);
  window.setTimeout(() => {
    state.textContent = "Checked in, queued for SES.HOSPEDAJES, and audit chain sealed.";
    document.getElementById("riskBadge").textContent = "Completed";
    document.querySelectorAll("#flowSteps span").forEach((step) => {
      step.classList.add("done");
      step.classList.remove("active");
    });
  }, 500);
}

function resetDemo() {
  document.getElementById("confirmationCard").hidden = true;
  document.getElementById("confirmCheckIn").disabled = true;
  document.getElementById("stateLine").textContent = "Ready for voice input.";
  document.getElementById("riskBadge").textContent = "Human approval";
  updateFlowStep(-1);
  renderTimeline([["Ready", "Waiting for command"]]);
}

const pendingAttachments = [];

function renderAttachments() {
  const tray = document.getElementById("attachmentTray");
  tray.innerHTML = "";
  pendingAttachments.forEach((attachment) => {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.textContent = `${attachment.type}: ${attachment.label}`;
    tray.appendChild(chip);
  });
}

function addChatAttachment(type, label, status) {
  pendingAttachments.push({ type, label });
  renderAttachments();
  document.getElementById("chatState").textContent = status;
}

function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const body = input.value.trim();
  if (!body && pendingAttachments.length === 0) {
    document.getElementById("chatState").textContent = "Add text, a photo, a file, or a voice note before sending.";
    return;
  }

  const message = document.createElement("article");
  message.className = "message staff";

  const sender = document.createElement("strong");
  sender.textContent = "Staff";
  const text = document.createElement("p");
  text.textContent = body || "Attachment sent.";
  message.append(sender, text);

  if (pendingAttachments.length) {
    const list = document.createElement("div");
    list.className = "message-attachments";
    pendingAttachments.forEach((attachment) => {
      const item = document.createElement("span");
      item.textContent = `${attachment.type}: ${attachment.label}`;
      list.appendChild(item);
    });
    message.appendChild(list);
  }

  document.getElementById("chatMessages").appendChild(message);
  input.value = "";
  pendingAttachments.splice(0, pendingAttachments.length);
  renderAttachments();
  document.getElementById("chatState").textContent = "Message sent with audited attachment metadata.";
}

function bindManualSetupButtons() {
  document.querySelectorAll("[data-manual-setup]").forEach((button) => {
    if (button.dataset.manualSetupBound === "true") return;
    button.dataset.manualSetupBound = "true";
    button.addEventListener("click", () => {
      renderManualSetupOption(button.dataset.manualSetup);
      showScreen("manual-setup-option");
    });
  });
  const saveButton = document.getElementById("manualSetupOptionSaveButton");
  if (saveButton && saveButton.dataset.manualSetupSaveBound !== "true") {
    saveButton.dataset.manualSetupSaveBound = "true";
    saveButton.addEventListener("click", saveManualSetupOptionDemo);
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.screen));
});

document.querySelectorAll("[data-screen-jump]").forEach((button) => {
  button.addEventListener("click", () => {
    showScreen(button.dataset.screenJump);
    if (button.dataset.screenJump === "ai") {
      runDemo();
    }
  });
});

document.querySelectorAll("[data-property-form]").forEach((button) => {
  button.addEventListener("click", () => {
    renderPropertyForm(button.dataset.propertyForm);
    showScreen("property-form");
  });
});

const propertyFormSaveButton = document.getElementById("propertyFormSaveButton");
if (propertyFormSaveButton) propertyFormSaveButton.addEventListener("click", savePropertyFormDemo);
const reservationSaveButton = document.getElementById("reservationSaveButton");
if (reservationSaveButton) reservationSaveButton.addEventListener("click", saveReservationDemo);
const invoiceSaveButton = document.getElementById("invoiceSaveButton");
if (invoiceSaveButton) invoiceSaveButton.addEventListener("click", saveInvoiceDemo);
const reportExportButton = document.getElementById("reportExportButton");
if (reportExportButton) reportExportButton.addEventListener("click", generateReportDemo);

bindManualSetupButtons();
document.getElementById("runDemo").addEventListener("click", runDemo);
document.getElementById("scanDoc").addEventListener("click", runDemo);
document.getElementById("confirmCheckIn").addEventListener("click", confirmCheckIn);
document.getElementById("resetDemo").addEventListener("click", resetDemo);
document.getElementById("attachPhoto").addEventListener("click", () => {
  addChatAttachment("photo", "lobby-photo.jpg", "Photo attached from library.");
});
document.getElementById("useCamera").addEventListener("click", () => {
  addChatAttachment("camera_photo", "camera-photo.jpg", "Camera photo attached with privacy review.");
});
document.getElementById("attachFile").addEventListener("click", () => {
  addChatAttachment("file", "parking-instructions.pdf", "File attached.");
});
document.getElementById("recordVoiceNote").addEventListener("click", () => {
  addChatAttachment("voice_note", "voice-note 0:12", "Microphone voice note attached.");
});
document.getElementById("sendChatMessage").addEventListener("click", sendChatMessage);

renderPropertyForm("property_profile");
renderManualSetupOption("property_profile");
renderManualSetupHub();
resetDemo();
