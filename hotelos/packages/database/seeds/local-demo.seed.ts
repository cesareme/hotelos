export const LOCAL_DEMO_USER = {
  email: "admin@hotelos.local",
  password: "admin123",
  role: "Local Super Admin",
  fullName: "HotelOS Local Super Admin"
};

export const LOCAL_DEMO_PROPERTY = {
  name: "HotelOS Demo Hotel",
  code: "HOTELOS_DEMO",
  businessDate: "2026-05-17"
};

export const LOCAL_DEMO_ENABLED_MODULES = [
  "pms_core",
  "backoffice",
  "module_marketplace",
  "integration_marketplace",
  "distribution_hub",
  "revenue_profit_engine",
  "hotel_intelligence_platform",
  "owner_mode",
  "payment_vault",
  "erp_accounting",
  "channel_manager",
  "ai_onboarding_migration",
  "guest_experience",
  "spain_guest_register_compliance",
  "ai_front_desk",
  "ai_governance"
];

export const LOCAL_DEMO_PERMISSIONS = [
  "backoffice.access",
  "property.configure",
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
  "modules.read",
  "modules.enable",
  "modules.configure",
  "integrations.read",
  "integrations.connect",
  "revenue.read",
  "revenue.history_forecast.read",
  "revenue.history_forecast.export",
  "revenue.forecast.read",
  "revenue.recommend",
  "revenue.manage_rates",
  "revenue.manage_restrictions",
  "revenue.apply_recommendations",
  "revenue.automation.manage",
  "channel_manager.read",
  "channel_manager.manage",
  "channel_manager.sync",
  "channel_manager.mappings.manage",
  "guest_experience.inbox.read",
  "analytics.read",
  "owner.dashboard.read",
  "ai.tool.execute",
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
  "onboarding.manage_cutover"
];

export const LOCAL_DEMO_CATEGORY_SETUP = {
  categoryDefinitions: [
    "room_features",
    "bed_types",
    "space_types",
    "housekeeping_task_types",
    "maintenance_issue_types",
    "market_segments",
    "channel_categories",
    "revenue_report_fields",
    "payment_method_categories",
    "invoice_sequence_types",
    "document_types",
    "pos_product_categories",
    "asset_categories",
    "safety_incident_categories"
  ],
  templates: ["Boutique hotel", "Urban business hotel", "Resort", "Rural hotel", "Aparthotel", "Hostel", "Luxury hotel", "Small independent hotel", "Multi-property group"],
  importColumns: ["category_code", "option_code", "label", "description", "parent_option_code", "color_token", "icon_name", "active", "sort_order"],
  aiPreview: {
    prompt: "Create room features for a boutique beach hotel.",
    creates: ["Sea view", "Balcony", "King bed", "Twin beds", "Connecting room", "Pet friendly"],
    requiresConfirmation: true
  }
};

export const LOCAL_DEMO_REVENUE_SETUP = {
  roomTypes: ["Single", "Double Standard", "Superior", "Suite"],
  ratePlans: ["Flexible BAR", "Non-refundable", "Breakfast included"],
  channels: ["Direct", "Booking.com Mock", "Expedia Mock", "Google Hotels Mock"],
  historyForecastSeed: {
    reportName: "History & Forecast",
    fromDate: "2026-05-01",
    toDate: "2026-05-31",
    businessDate: "2026-05-17",
    sections: ["History", "History subtotal", "Forecast", "Forecast subtotal", "Total"],
    columns: [
      "Date",
      "Total Occ.",
      "Arr. Rooms",
      "Comp. Rooms",
      "House Use",
      "Deduct Indiv.",
      "Non-Ded. Indiv.",
      "Deduct Group",
      "Non-Ded. Group",
      "Occ. %",
      "Total Revenue",
      "Average Rate",
      "Dep. Rooms",
      "Day Use Rooms",
      "No Show Rooms",
      "OOO Rooms",
      "Adl. & Chl."
    ],
    generatedRows: 31
  },
  kpis: ["Occupancy %", "ADR", "RevPAR", "Total Revenue", "OOO rooms", "Arrivals", "Departures", "No-shows"],
  channelMappings: [
    { channel: "Booking.com Mock", roomType: "Double Standard", externalRoomCode: "BKG_DBL_STD", externalRateCode: "BKG_BAR" },
    { channel: "Expedia Mock", roomType: "Superior", externalRoomCode: "EXP_SUP", externalRateCode: "EXP_BAR" },
    { channel: "Google Hotels Mock", roomType: "Suite", externalRoomCode: "GOOG_STE", externalRateCode: "GOOG_BAR" }
  ]
};

export const LOCAL_DEMO_INVENTORY_RESOURCES = [
  { name: "Room 401", resourceType: "room", capacity: 2, bookable: true, sellable: true, dailyBookable: true, status: "available" },
  { name: "Room 432", resourceType: "room", capacity: 2, bookable: true, sellable: true, dailyBookable: true, status: "arrival_pending" },
  { name: "Parking P-08", resourceType: "parking_space", capacity: 1, bookable: true, sellable: true, hourlyBookable: true, dailyBookable: true, status: "available" },
  { name: "Meeting Room Sol", resourceType: "meeting_room", capacity: 16, bookable: true, sellable: true, hourlyBookable: true, dailyBookable: true, status: "reserved" },
  { name: "Coworking Desk 12", resourceType: "coworking_desk", capacity: 1, bookable: true, sellable: true, hourlyBookable: true, monthlyBookable: true, status: "available" },
  { name: "Spa Suite Agua", resourceType: "spa_room", capacity: 2, bookable: true, sellable: true, hourlyBookable: true, status: "available" },
  { name: "Event Hall Mar", resourceType: "event_space", capacity: 120, bookable: true, sellable: true, hourlyBookable: true, dailyBookable: true, status: "setup_needed" }
];

export const LOCAL_DEMO_RESERVATIONS = [
  {
    code: "RES-18392",
    guestName: "Maria Lopez Garcia",
    resource: "Room 432",
    startAt: "2026-05-17T15:00:00+02:00",
    endAt: "2026-05-19T11:00:00+02:00",
    status: "arrival_pending",
    balance: "EUR 0",
    guestRegisterStatus: "missing_phone",
    journeyBlockedStep: "Identity verified"
  },
  {
    code: "EVT-2026-014",
    guestName: "Northwind Leadership Offsite",
    resource: "Meeting Room Sol",
    startAt: "2026-05-18T09:00:00+02:00",
    endAt: "2026-05-18T17:00:00+02:00",
    status: "confirmed",
    balance: "EUR 680",
    guestRegisterStatus: "not_required",
    journeyBlockedStep: "Payment verified"
  }
];

export const LOCAL_DEMO_GUEST_JOURNEY = {
  steps: [
    "Booked",
    "Pre-arrival",
    "Online check-in",
    "Identity verified",
    "Payment verified",
    "Room assigned",
    "Arrival",
    "In-house",
    "Service requests",
    "Checkout",
    "Invoice",
    "Review",
    "Post-stay"
  ],
  demoReservationCode: "RES-18392",
  blockedStep: "Identity verified",
  nextBestAction: "Complete missing guest register phone number, capture signature and check in."
};

export const LOCAL_DEMO_MARKETPLACE = {
  categories: [
    "Channel Managers",
    "OTAs",
    "Payments",
    "Locks",
    "Guest Journey",
    "CRM",
    "Revenue",
    "Housekeeping",
    "Accounting",
    "POS",
    "BI",
    "Government Compliance",
    "AI"
  ],
  providers: [
    { name: "Booking.com Mock", category: "OTAs", status: "connected", lastSync: "2026-05-17T10:42:00+02:00" },
    { name: "SES.HOSPEDAJES Export", category: "Government Compliance", status: "needs_setup", lastSync: null },
    { name: "Payment Vault Demo PSP", category: "Payments", status: "connected", lastSync: "2026-05-17T10:58:00+02:00" }
  ]
};

export const LOCAL_DEMO_ONBOARDING_PROJECT = {
  name: "HotelOS Demo Onboarding Project",
  sourceSystem: "generic_csv",
  status: "review_required",
  targetGoLiveDate: "2026-06-01",
  demoFiles: [
    { name: "room_list.csv", detectedDocumentType: "room_list", extractionStatus: "completed", confidence: 0.88 },
    { name: "rate_sheet.xlsx", detectedDocumentType: "rate_sheet", extractionStatus: "completed", confidence: 0.81 },
    { name: "channel_mappings.xlsx", detectedDocumentType: "channel_mapping", extractionStatus: "completed", confidence: 0.77 },
    { name: "future_reservations.csv", detectedDocumentType: "reservation_export", extractionStatus: "completed", confidence: 0.79 },
    { name: "history_forecast_may_2026.xlsx", detectedDocumentType: "revenue_history_forecast_report", extractionStatus: "completed", confidence: 0.91 },
    { name: "floor_plan_main.pdf", detectedDocumentType: "floor_plan", extractionStatus: "needs_review", confidence: 0.64 }
  ],
  extractedEntities: [
    { entityType: "room", sourceIdentifier: "room_list.csv#432", confidence: 0.93 },
    { entityType: "rate_plan", sourceIdentifier: "rate_sheet.xlsx#Flexible BAR", confidence: 0.86 },
    { entityType: "channel_mapping", sourceIdentifier: "channel_mappings.xlsx#Booking.com", confidence: 0.77 },
    { entityType: "reservation", sourceIdentifier: "future_reservations.csv#RES-18392", confidence: 0.82 },
    { entityType: "revenue_snapshot", sourceIdentifier: "history_forecast_may_2026.xlsx#History", confidence: 0.87 }
  ],
  propertyBlueprintPreview: {
    buildings: 1,
    floors: 4,
    zones: ["East Wing", "West Wing", "Public Areas"],
    rooms: 70,
    roomTypes: ["Single", "Double Standard", "Superior", "Suite"],
    nonRoomResources: ["Restaurant", "Parking", "Meeting Room", "Rooftop"],
    requiresHumanApproval: true
  },
  dryRun: {
    willCreate: ["1 building", "4 floors", "70 rooms", "73 inventory resources", "3 channels", "426 future reservations"],
    warnings: ["14 reservations missing email", "3 probable duplicate guests", "2 rate plans have no cancellation policy"],
    blockingIssues: ["SES.HOSPEDAJES settings missing", "History & Forecast totals require validation"]
  },
  readinessScore: 78
};

export function buildLocalDemoSeedSummary() {
  return {
    user: LOCAL_DEMO_USER.email,
    role: LOCAL_DEMO_USER.role,
    property: LOCAL_DEMO_PROPERTY.name,
    enabledModules: LOCAL_DEMO_ENABLED_MODULES,
    permissions: LOCAL_DEMO_PERMISSIONS,
    revenue: LOCAL_DEMO_REVENUE_SETUP,
    inventoryResources: LOCAL_DEMO_INVENTORY_RESOURCES,
    reservations: LOCAL_DEMO_RESERVATIONS,
    guestJourney: LOCAL_DEMO_GUEST_JOURNEY,
    marketplace: LOCAL_DEMO_MARKETPLACE,
    onboarding: LOCAL_DEMO_ONBOARDING_PROJECT
  };
}
