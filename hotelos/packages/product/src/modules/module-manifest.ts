import type { PermissionKey } from "@hotelos/shared";
import type { HotelModuleCode } from "./module-codes.js";

// Module manifest (Tanda 5 · L1a, lote product-manifest).
//
// `name` and `description` are shown to hoteliers in «Módulos e integraciones»
// (ModuleManager reads GET /backoffice/properties/:id/modules, which spreads
// this manifest), so they are Spanish. Screen keys in `adminRoutes` are the
// canonical keys of pilots/tanda5-nav-tree.csv (aliases, retired and ghost keys
// such as «AIEvals» are gone); `mobileRoutes` are apps/mobile screen names and
// stay as they are. `menuEntries` lists the items and tabs of the Tanda 5
// navigation tree that only show when the module is enabled (§6.2 of
// pilots/tanda5-nav-tree.md): derived from
// apps/admin-web/src/navigation/nav-tree.generated.json and verified against it
// by packages/product/src/__tests__/module-manifest.test.mts.

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

/**
 * A menu item or tab of the Tanda 5 navigation tree that is gated by a module
 * (`modulesAny` in the tree). ModuleManager shows «qué entradas del menú
 * desbloquea» from this list; the front keeps the same data in
 * `menuEntriesUnlockedBy(code)` (apps/admin-web/src/navigation/nav-tree.ts).
 */
export type HotelModuleMenuEntry = {
  kind: "item" | "tab";
  /** Category key of the tree (`hoy`, `recepcion`, `operaciones`, `comercial`, `revenue`, `finanzas`, `cumplimiento`, `informes`, `configuracion`). */
  categoryKey: string;
  /** Category label as shown in the menu. */
  category: string;
  /** SCREEN_COMPONENTS key (canonical, from the CSV). */
  screenKey: string;
  /** Menu label (CSV `etiquetaES`). */
  label: string;
  /** Tanda 5 URL (relative to the shell base path). */
  url: string;
  /** For tabs: the item they hang from. */
  parentLabel?: string;
  parentUrl?: string;
};

export type HotelModuleManifest = {
  code: HotelModuleCode;
  name: string;
  category: HotelModuleCategory;
  description: string;
  /** Cannot be disabled once enabled (only `pms_core`). */
  isCore: boolean;
  /**
   * Starts enabled in a new property (`isCore` or listed in
   * DEFAULT_ENABLED_MODULE_CODES). Unlike `isCore` it can still be disabled.
   */
  enabledByDefault: boolean;
  dependencies: HotelModuleCode[];
  permissions: PermissionKey[];
  /** apps/mobile screen names. */
  mobileRoutes: string[];
  /** apps/admin-web SCREEN_COMPONENTS keys (canonical keys of the Tanda 5 tree). */
  adminRoutes?: string[];
  /** Menu items and tabs of the Tanda 5 tree gated by this module (empty for `core` screens). */
  menuEntries: HotelModuleMenuEntry[];
};

/** Manifest as written by hand; `enabledByDefault` and `menuEntries` are filled in by `finalizeManifest`. */
type HotelModuleManifestInput = Omit<HotelModuleManifest, "enabledByDefault" | "menuEntries">;

// ---------------------------------------------------------------------------
// §14.1 (pilots/tanda5-nav-tree.md) — DECISIÓN REVERSIBLE, PENDIENTE DE CÉSAR
//
// Modules a NEW property starts with. Proposal of the Tanda 5 navigation plan:
// the menu never gates on these (only the API 403 gates listed in §9 do), but
// ModuleManager showed «desactivado» for things that already work
// (Pisos, Mantenimiento, Facturación, Registro de viajeros…) and
// provision-pilot-property created hotels without them.
//
// Reverting the decision = remove codes from this list (or empty it): nothing
// else in the codebase hard-codes the set. `isCore` is intentionally NOT
// touched: these modules remain disable-able in ModuleManager and existing
// PropertyModule rows keep their status (Faranda Rías Altas keeps
// `maintenance` disabled until someone enables it).
// ---------------------------------------------------------------------------
export const DEFAULT_ENABLED_MODULE_CODES: HotelModuleCode[] = [
  "pms_core",
  "housekeeping",
  "maintenance",
  "compliance_hub",
  "compliance_billing",
  "spain_guest_register_compliance",
  "erp_accounting",
  "guest_experience",
  "outlet_pos"
];

/**
 * Menu entries unlocked by each module (§6.2). Generated from
 * apps/admin-web/src/navigation/nav-tree.generated.json: items whose
 * `modulesAny` names the module (with their non-detail tabs) and tabs gated on
 * their own inside a `core` item. Keep in sync by regenerating the JSON
 * (`node scripts/build-nav-tree.mjs`) and running the product unit tests.
 */
export const MODULE_MENU_ENTRIES: Partial<Record<HotelModuleCode, HotelModuleMenuEntry[]>> = {
  outlet_pos: [
    { kind: "item", categoryKey: "operaciones", category: "Operaciones", screenKey: "PosDashboard", label: "Punto de venta", url: "/operaciones/tpv" },
    { kind: "tab", categoryKey: "operaciones", category: "Operaciones", screenKey: "FnbMenu", label: "Cartas", url: "/operaciones/tpv/cartas", parentLabel: "Punto de venta", parentUrl: "/operaciones/tpv" },
    { kind: "tab", categoryKey: "operaciones", category: "Operaciones", screenKey: "FnbInventory", label: "Existencias", url: "/operaciones/tpv/existencias", parentLabel: "Punto de venta", parentUrl: "/operaciones/tpv" }
  ],
  workforce_labor: [
    { kind: "item", categoryKey: "operaciones", category: "Operaciones", screenKey: "WorkforceDashboard", label: "Personal y turnos", url: "/operaciones/personal" }
  ],
  safety_incident_management: [
    { kind: "item", categoryKey: "operaciones", category: "Operaciones", screenKey: "SafetyDashboard", label: "Seguridad e incidentes", url: "/operaciones/seguridad" }
  ],
  procurement_inventory: [
    { kind: "item", categoryKey: "operaciones", category: "Operaciones", screenKey: "ProcurementDashboard", label: "Compras e inventario", url: "/operaciones/compras" },
    { kind: "tab", categoryKey: "operaciones", category: "Operaciones", screenKey: "InventoryDashboard", label: "Inventario", url: "/operaciones/compras/inventario", parentLabel: "Compras e inventario", parentUrl: "/operaciones/compras" }
  ],
  guest_data_crm_loyalty: [
    { kind: "item", categoryKey: "comercial", category: "Comercial", screenKey: "CrmDashboard", label: "Clientes y fidelización", url: "/comercial/clientes" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "GuestSegmentsReal", label: "Segmentos", url: "/comercial/clientes/segmentos", parentLabel: "Clientes y fidelización", parentUrl: "/comercial/clientes" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "LoyaltyDashboard", label: "Fidelización", url: "/comercial/clientes/fidelizacion", parentLabel: "Clientes y fidelización", parentUrl: "/comercial/clientes" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "LoyaltyProgram", label: "Programa", url: "/comercial/clientes/programa", parentLabel: "Clientes y fidelización", parentUrl: "/comercial/clientes" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "CampaignManagerReal", label: "Campañas", url: "/comercial/clientes/campanas", parentLabel: "Clientes y fidelización", parentUrl: "/comercial/clientes" }
  ],
  reputation_quality: [
    { kind: "item", categoryKey: "comercial", category: "Comercial", screenKey: "ReputationDashboard", label: "Reputación y calidad", url: "/comercial/reputacion" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "SurveysDashboard", label: "Encuestas", url: "/comercial/reputacion/encuestas", parentLabel: "Reputación y calidad", parentUrl: "/comercial/reputacion" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "QualityDashboard", label: "Calidad", url: "/comercial/reputacion/calidad", parentLabel: "Reputación y calidad", parentUrl: "/comercial/reputacion" }
  ],
  guest_self_service: [
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "GuestPortalSettingsReal", label: "Portal del huésped", url: "/comercial/ventas-adicionales/portal", parentLabel: "Ventas adicionales", parentUrl: "/comercial/ventas-adicionales" }
  ],
  distribution_hub: [
    { kind: "item", categoryKey: "comercial", category: "Comercial", screenKey: "ChannelAggregatorHub", label: "Canales de venta", url: "/comercial/canales" },
    { kind: "tab", categoryKey: "comercial", category: "Comercial", screenKey: "ChannelMappings", label: "Correspondencias", url: "/comercial/canales/correspondencias", parentLabel: "Canales de venta", parentUrl: "/comercial/canales" }
  ],
  revenue_profit_engine: [
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueHomeDashboard", label: "Panel de revenue", url: "/revenue" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RateGridEditorScreen", label: "Parrilla de tarifas", url: "/revenue/parrilla" },
    { kind: "tab", categoryKey: "revenue", category: "Revenue", screenKey: "RateJournalScreen", label: "Historial", url: "/revenue/parrilla/historial", parentLabel: "Parrilla de tarifas", parentUrl: "/revenue/parrilla" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueRules", label: "Reglas y recomendaciones", url: "/revenue/reglas" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueHistoryForecastDashboard", label: "Histórico y previsión", url: "/revenue/historico-prevision" },
    { kind: "tab", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueHistoryForecastReport", label: "Informe", url: "/revenue/historico-prevision/informe", parentLabel: "Histórico y previsión", parentUrl: "/revenue/historico-prevision" },
    { kind: "tab", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueForecastExplorer", label: "Explorador", url: "/revenue/historico-prevision/explorador", parentLabel: "Histórico y previsión", parentUrl: "/revenue/historico-prevision" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueComparisonDashboard", label: "Comparativa", url: "/revenue/comparativa" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RevenueMeeting", label: "Reunión de revenue", url: "/revenue/reunion" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "RateShopperSettings", label: "Competencia", url: "/revenue/competencia" },
    { kind: "item", categoryKey: "revenue", category: "Revenue", screenKey: "DemandCalendarAdmin", label: "Calendario de demanda", url: "/revenue/calendario-demanda" },
    { kind: "tab", categoryKey: "informes", category: "Informes", screenKey: "RevenueExportCenter", label: "Exportaciones de revenue", url: "/informes/exportaciones-revenue", parentLabel: "Centro de informes", parentUrl: "/informes" }
  ],
  hotel_intelligence_platform: [
    { kind: "item", categoryKey: "informes", category: "Informes", screenKey: "AnalyticsCenterDashboard", label: "Analítica", url: "/informes/analitica" }
  ]
};

function finalizeManifest(input: HotelModuleManifestInput): HotelModuleManifest {
  return {
    ...input,
    enabledByDefault: input.isCore || DEFAULT_ENABLED_MODULE_CODES.includes(input.code),
    menuEntries: MODULE_MENU_ENTRIES[input.code] ?? []
  };
}

const CORE_HOTEL_MODULE_INPUTS: HotelModuleManifestInput[] = [
  {
    code: "pms_core",
    name: "Núcleo PMS",
    category: "core",
    description: "Reservas, habitaciones, huéspedes, estancias, folios y operativa de recepción.",
    isCore: true,
    dependencies: [],
    permissions: ["pms.reservation.read", "pms.reservation.create"],
    mobileRoutes: ["Today", "Rooms", "Reservations"],
    adminRoutes: [
      "FrontDeskDashboard",
      "ShiftManagerScreen",
      "NightAuditScreen",
      "ReservationWorkspace",
      "ReservationsListScreen",
      "LiveTimeline",
      "RoomRackScreen",
      "ReservationDetailWorkspace",
      "ReservationCreate",
      "GuestsList",
      "GuestDetail",
      "GuestTimelineScreen"
    ]
  },
  {
    code: "ai_front_desk",
    name: "Recepción con IA",
    category: "ai",
    description: "Centro de mando por voz, texto y cámara para la operativa de recepción.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["ai.tool.execute", "pms.checkin.execute"],
    mobileRoutes: ["AICommandCenter", "AIConfirmations"],
    adminRoutes: ["AssistantChat", "ReservationAgent", "AiHumanReviewQueueScreen"]
  },
  {
    code: "distribution_hub",
    name: "Canales de venta",
    category: "distribution",
    description: "Disponibilidad, tarifas, restricciones, correspondencias de canales, importación de reservas y registros de sincronización.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["distribution.read", "distribution.manage_rates", "distribution.manage_inventory", "distribution.sync"],
    mobileRoutes: ["DistributionDashboard", "RateGrid", "ChannelSyncLog"],
    adminRoutes: ["ChannelAggregatorHub", "ChannelMappings"]
  },
  {
    code: "ai_booking_engine",
    name: "Motor de reservas con IA",
    category: "distribution",
    description: "Cotizaciones de disponibilidad para el huésped, borradores de reserva, enlaces de pago y confirmaciones.",
    isCore: false,
    dependencies: ["pms_core", "payment_vault"],
    permissions: ["pms.reservation.create", "payments.create_link", "ai.tool.execute"],
    mobileRoutes: ["BookingEngine", "GuestWeb"]
  },
  {
    code: "checkin_online",
    name: "Check-in en línea",
    category: "guest",
    description: "Check-in en línea y asistido con OCR, firma, cola de cumplimiento y traza de auditoría.",
    isCore: false,
    dependencies: ["pms_core", "compliance_hub"],
    permissions: ["pms.checkin.execute", "compliance.ses.submit"],
    mobileRoutes: ["AICommandCenter", "AIConfirmation"]
  },
  {
    code: "housekeeping",
    name: "Pisos",
    category: "operations",
    description: "Tablero de limpieza, inspecciones, notas de minibar, objetos perdidos y sincronización de tareas sin conexión.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["housekeeping.task.manage"],
    mobileRoutes: ["Tasks", "HousekeepingBoard", "MobilePlanning"],
    adminRoutes: ["HousekeepingDashboard", "HousekeepingMobileScreen", "HousekeepingSetupForm"]
  },
  {
    code: "maintenance",
    name: "Mantenimiento",
    category: "operations",
    description: "Partes de avería, bloqueo de habitaciones, adjuntos, mantenimiento preventivo e historial de activos.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["maintenance.workorder.manage"],
    mobileRoutes: ["Tasks", "MaintenanceBoard", "MobilePlanning"],
    adminRoutes: ["MaintenanceDashboard", "MaintenanceMobileScreen", "MaintenanceSetupForm"]
  },
  {
    code: "erp_accounting",
    name: "Contabilidad",
    category: "finance",
    description: "Libro de doble partida, facturas de proveedor, conciliación bancaria, cierre de periodo y cuentas anuales.",
    isCore: false,
    dependencies: [],
    permissions: ["accounting.journal.post"],
    mobileRoutes: ["AccountingDashboard", "SupplierBills", "BankReconciliation"],
    adminRoutes: [
      "AccountingSettings",
      "RevenueCategorySetupForm",
      "FinancePositionDashboard",
      "ExchangeRatesScreen",
      "BankReconciliationScreen",
      "BankingSpain",
      "TrialBalanceScreen",
      "BalanceSheetScreen",
      "CashFlowScreen",
      "YearEndCloseScreen",
      "CommissionsScreen",
      "PayrollScreen"
    ]
  },
  {
    code: "compliance_hub",
    name: "Cumplimiento",
    category: "compliance",
    description: "Registro de viajeros, partes de entrada firmados, cola SES.Hospedajes y bandeja de cumplimiento.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["compliance.ses.submit"],
    mobileRoutes: ["ComplianceInbox"],
    adminRoutes: ["ComplianceInbox", "ComplianceCenter", "FiscalSubmissionsCenter", "GdprRequestsScreen"]
  },
  {
    code: "compliance_billing",
    name: "Facturación fiscal",
    category: "compliance",
    description: "Facturación inmutable, rectificativas, estado preparado para VeriFactu y adaptadores de factura electrónica.",
    isCore: false,
    dependencies: ["pms_core", "erp_accounting", "compliance_hub"],
    permissions: ["billing.invoice.issue", "billing.invoice.cancel", "billing.invoice.rectify", "billing.compliance.view"],
    mobileRoutes: ["Invoices", "InvoiceDetail", "ComplianceInbox"],
    adminRoutes: [
      "BillingCenter",
      "FolioDetail",
      "InvoiceRectificationsScreen",
      "FolioRouting",
      "BillingSettings",
      "TaxComplianceSettings",
      "FiscalDashboard",
      "TbaiForal",
      "Modelo303Screen",
      "Modelo111Screen",
      "Modelo115Screen",
      "Modelo180Screen",
      "Modelo390Screen",
      "PropertyTaxesScreen",
      "TouristTax"
    ]
  },
  {
    code: "payment_vault",
    name: "Pagos",
    category: "finance",
    description: "Conexiones con pasarelas, enlaces de pago, pagos tokenizados, SCA/3DS, depósitos y aprobación de devoluciones.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["payments.create_link", "payments.capture", "payments.refund_request", "payments.refund_approve"],
    mobileRoutes: ["Payments", "PaymentDetail"],
    adminRoutes: ["PaymentSettings"]
  },
  {
    code: "guest_experience",
    name: "Experiencia del huésped",
    category: "guest",
    description: "Bandeja unificada de huéspedes, solicitudes de servicio, sentimiento, encuestas, ventas adicionales y recuperación de quejas.",
    isCore: false,
    dependencies: ["pms_core", "ai_concierge"],
    permissions: ["guest_experience.inbox.read", "guest_experience.message.send", "guest_experience.handoff"],
    mobileRoutes: ["GuestInbox", "ConversationDetail"],
    adminRoutes: ["ConciergeInboxDashboard", "GuestJourneyWorkspace", "UpsellsDashboard", "UpsellsSettings"]
  },
  {
    code: "ai_concierge",
    name: "Conserje con IA",
    category: "ai",
    description: "Respuestas al huésped con IA, recomendaciones locales, creación de solicitudes de servicio y traspaso a una persona.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["guest_experience.ai_reply", "ai.tool.execute"],
    mobileRoutes: ["GuestInbox", "ConversationDetail"],
    adminRoutes: ["ConciergeInboxDashboard"]
  },
  {
    code: "asset_intelligence",
    name: "Activos",
    category: "asset",
    description: "Rentabilidad por habitación, coste de mantenimiento por habitación, garantías, certificados y estado de conservación.",
    isCore: false,
    dependencies: ["maintenance", "erp_accounting"],
    permissions: ["assets.read", "assets.manage"],
    mobileRoutes: ["AssetRegister", "RoomProfitability"],
    adminRoutes: ["AssetsDashboard", "RoomProfitabilityDashboard"]
  },
  {
    code: "capex_manager",
    name: "Inversiones (capex)",
    category: "asset",
    description: "Proyectos de inversión, retorno de reformas, aprobaciones del propietario y planes ligados a habitaciones o activos.",
    isCore: false,
    dependencies: ["asset_intelligence", "erp_accounting"],
    permissions: ["capex.read", "capex.create", "capex.approve"],
    mobileRoutes: ["CapexProjects"],
    adminRoutes: ["AssetsDashboard"]
  },
  {
    code: "outlet_pos",
    name: "Punto de venta",
    category: "finance",
    description: "Pedidos de restaurante, bar, spa, aparcamiento, minibar, eventos, tienda, traslados y cargos a habitación.",
    isCore: false,
    dependencies: ["pms_core", "payment_vault"],
    permissions: ["pos.order.create", "pos.order.charge_to_room", "pos.order.pay"],
    mobileRoutes: ["OutletPOS"],
    adminRoutes: ["PosDashboard", "FnbMenu", "FnbInventory"]
  },
  {
    code: "owner_mode",
    name: "Modo propietario",
    category: "asset",
    description: "Informe del propietario: ocupación, ADR, RevPAR, caja, deudores, mantenimiento, cumplimiento e inversiones.",
    isCore: false,
    dependencies: ["pms_core", "erp_accounting", "maintenance", "asset_intelligence"],
    permissions: ["owner.dashboard.read", "owner.ai_ask"],
    mobileRoutes: ["OwnerDashboard", "OwnerBriefing"],
    adminRoutes: ["OwnerHome", "AiOwnerSummaryScreen", "PortfolioDashboard", "PropertyDetailScreen"]
  },
  {
    code: "integration_marketplace",
    name: "Integraciones",
    category: "integrations",
    description: "Catálogo de proveedores, estado de conexión, prueba de conexión, registros de sincronización y referencias de credenciales.",
    isCore: false,
    dependencies: [],
    permissions: ["integrations.read", "integrations.connect", "integrations.disconnect", "integrations.test"],
    mobileRoutes: ["IntegrationMarketplace"],
    adminRoutes: ["MarketplaceCatalog"]
  },
  {
    code: "module_marketplace",
    name: "Gestor de módulos",
    category: "integrations",
    description: "Catálogo de módulos por propiedad, estado de activación y activación que respeta las dependencias.",
    isCore: false,
    dependencies: ["pms_core"],
    permissions: ["modules.read", "modules.enable", "modules.disable"],
    mobileRoutes: ["ModuleMarketplace"],
    adminRoutes: ["ModuleManager", "ModuleHealthCenter"]
  }
];

const ADVANCED_HOTEL_MODULE_INPUTS: HotelModuleManifestInput[] = [
  {
    code: "revenue_profit_engine",
    name: "Revenue y rentabilidad",
    category: "commercial",
    description:
      "Previsión, precios dinámicos, gestión de canales, restricciones, inteligencia tarifaria, predicción de demanda y optimización del beneficio.",
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
    adminRoutes: [
      "RevenueHomeDashboard",
      "RateGridEditorScreen",
      "RateJournalScreen",
      "RatePlans",
      "RevenueRules",
      "RevenueHistoryForecastDashboard",
      "RevenueHistoryForecastReport",
      "RevenueForecastExplorer",
      "RevenueComparisonDashboard",
      "RevenueMeeting",
      "RateShopperSettings",
      "DemandCalendarAdmin",
      "CancellationPolicies",
      "RevenueExportCenter"
    ]
  },
  {
    code: "guest_data_crm_loyalty",
    name: "Clientes y fidelización",
    category: "guest",
    description: "Perfil único del huésped, segmentación, campañas, fidelización y personalización.",
    isCore: false,
    dependencies: ["pms_core", "guest_experience"],
    permissions: ["crm.read", "crm.manage_profiles", "crm.manage_campaigns", "crm.manage_loyalty"],
    mobileRoutes: ["GuestProfile360", "GuestInsights", "VIPArrivals"],
    adminRoutes: ["CrmDashboard", "GuestSegmentsReal", "LoyaltyDashboard", "LoyaltyProgram", "CampaignManagerReal"]
  },
  {
    code: "groups_events_sales",
    name: "Grupos, eventos y ventas",
    category: "commercial",
    description: "Reservas de grupo, cupos, espacios para eventos, propuestas, órdenes de evento y facturación de grupos.",
    isCore: false,
    dependencies: ["pms_core", "payment_vault", "erp_accounting"],
    permissions: ["groups.read", "groups.manage", "events.read", "events.manage", "sales.pipeline.manage"],
    mobileRoutes: ["GroupsDashboard", "EventsCalendar"],
    adminRoutes: ["GroupsEventsDashboard", "GroupsCalendarScreen", "Allotments", "SalesPipelineDashboard"]
  },
  {
    code: "workforce_labor",
    name: "Personal y turnos",
    category: "operations",
    description: "Cuadrantes, fichajes, previsión de personal, gestión de turnos y productividad.",
    isCore: false,
    dependencies: ["pms_core", "housekeeping", "maintenance"],
    permissions: ["workforce.read", "workforce.schedule.manage", "workforce.timeclock.manage", "workforce.labor_cost.view"],
    mobileRoutes: ["MyShifts", "LaborDashboard"],
    adminRoutes: ["WorkforceDashboard"]
  },
  {
    code: "procurement_inventory",
    name: "Compras e inventario",
    category: "finance",
    description: "Proveedores, pedidos de compra, existencias, lencería, minibar, repuestos y conciliación a tres bandas.",
    isCore: false,
    dependencies: ["erp_accounting", "payment_vault"],
    permissions: ["procurement.read", "procurement.manage", "inventory.read", "inventory.manage", "purchase_orders.approve"],
    mobileRoutes: ["InventoryDashboard", "StockCounts"],
    adminRoutes: ["ProcurementDashboard", "InventoryDashboard"]
  },
  {
    code: "guest_self_service",
    name: "Portal del huésped",
    category: "guest",
    description: "Portal del huésped, check-in y check-out desde el móvil, kiosco, llaves digitales y ventas adicionales.",
    isCore: false,
    dependencies: ["pms_core", "guest_experience", "payment_vault", "checkin_online"],
    permissions: ["guest_portal.configure", "guest_self_service.read", "guest_self_service.manage"],
    mobileRoutes: ["GuestPortalPreview"],
    adminRoutes: ["GuestPortalSettingsReal"]
  },
  {
    code: "reputation_quality",
    name: "Reputación y calidad",
    category: "guest",
    description: "Agregación de reseñas, análisis de sentimiento, encuestas, casos de calidad y recuperación del servicio.",
    isCore: false,
    dependencies: ["guest_experience", "ai_concierge"],
    permissions: ["reputation.read", "reputation.respond", "quality_cases.manage", "surveys.manage"],
    mobileRoutes: ["ReputationDashboard", "QualityCases"],
    adminRoutes: ["ReputationDashboard", "SurveysDashboard", "QualityDashboard"]
  },
  {
    code: "energy_sustainability",
    name: "Energía y sostenibilidad",
    category: "asset",
    description: "Energía, agua, residuos, ESG, contadores inteligentes e informes de sostenibilidad.",
    isCore: false,
    dependencies: ["asset_intelligence", "maintenance"],
    permissions: ["energy.read", "energy.manage", "sustainability.read", "sustainability.report"],
    mobileRoutes: ["EnergyDashboard", "SustainabilityDashboard"],
    adminRoutes: ["EnergyDashboard", "SustainabilityDashboard", "EsrsReport"]
  },
  {
    code: "safety_incident_management",
    name: "Seguridad e incidentes",
    category: "operations",
    description: "Registro de incidentes, protocolos de emergencia, controles de seguridad, evidencias para el seguro y gestión de riesgos.",
    isCore: false,
    dependencies: ["maintenance", "asset_intelligence"],
    permissions: ["incidents.read", "incidents.manage", "safety_checks.manage", "insurance_cases.manage"],
    mobileRoutes: ["IncidentLog", "SafetyChecks"],
    adminRoutes: ["SafetyDashboard"]
  },
  {
    code: "hotel_intelligence_platform",
    name: "Analítica",
    category: "analytics",
    description: "Almacén de datos, métricas semánticas, inteligencia de negocio, detección de anomalías y analítica en lenguaje natural.",
    isCore: false,
    dependencies: ["pms_core", "erp_accounting", "owner_mode"],
    permissions: ["analytics.read", "analytics.export", "analytics.configure", "analytics.ai_ask"],
    mobileRoutes: ["AnalyticsDashboard"],
    adminRoutes: ["AnalyticsCenterDashboard", "ReportingCenter", "ChannelPerformanceDashboard"]
  },
  {
    code: "developer_platform",
    name: "Plataforma para desarrolladores",
    category: "platform",
    description: "API pública, aplicaciones OAuth, webhooks, entorno de pruebas, registros de API y certificación de socios.",
    isCore: false,
    dependencies: ["integration_marketplace"],
    permissions: ["developer.read", "developer.manage_apps", "developer.manage_webhooks", "developer.view_api_logs"],
    mobileRoutes: [],
    adminRoutes: ["DeveloperApps", "WebhooksAdmin", "ApiReferenceScreen"]
  },
  {
    code: "ai_governance",
    name: "Gobernanza de la IA",
    category: "ai",
    description: "Centro de políticas de IA, gobierno de herramientas, evaluaciones, versiones de instrucciones, incidentes de IA y observabilidad.",
    isCore: false,
    dependencies: ["ai_front_desk"],
    permissions: ["ai_governance.read", "ai_governance.configure", "ai_evals.manage", "ai_incidents.manage"],
    mobileRoutes: ["AiIncidentLog", "AiReviewQueue"],
    adminRoutes: ["PropertyAiScreen", "AiToolRegistryScreen", "AiPipelineStatusScreen", "AiGovernanceScreen", "AiPropertySetupForm"]
  },
  {
    code: "spain_guest_register_compliance",
    name: "Registro de viajeros (España)",
    category: "compliance",
    description:
      "Registro de viajeros, partes de entrada, envíos a SES.Hospedajes, ficheros por lotes, firmas, conservación y minimización de datos conforme al RGPD para el alojamiento en España.",
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
    adminRoutes: ["GuestRegisterSettings", "SesHospedajesSettings", "AuthorityRoutingSettings", "GuestRegisterRetentionSettings"]
  },
  {
    code: "ai_onboarding_migration",
    name: "Migración asistida por IA",
    category: "platform",
    description:
      "Puesta en marcha asistida por IA, migración desde otro PMS, mapeo de la propiedad, importación de datos, validación, simulación y preparación para la salida en vivo.",
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
    // PropertyMapper and GoLiveChecklist are `core` tabs of Puesta en marcha; the
    // migration screens are dev-only (/desarrollo/migracion/*) until L6 wires them.
    adminRoutes: ["PropertyMapper", "GoLiveChecklist", "OnboardingProjects", "FileUploadAndClassification", "AIExtractionReview", "MigrationBatches"]
  }
];

export const CORE_HOTEL_MODULES: HotelModuleManifest[] = CORE_HOTEL_MODULE_INPUTS.map(finalizeManifest);

export const ADVANCED_HOTEL_MODULES: HotelModuleManifest[] = ADVANCED_HOTEL_MODULE_INPUTS.map(finalizeManifest);

export const HOTEL_MODULES: HotelModuleManifest[] = [...CORE_HOTEL_MODULES, ...ADVANCED_HOTEL_MODULES];

export function getHotelModuleManifest(code: HotelModuleCode): HotelModuleManifest {
  const manifest = HOTEL_MODULES.find((module) => module.code === code);
  if (!manifest) {
    throw new Error(`Unknown ehotelOS module: ${code}`);
  }

  return manifest;
}

/** Menu items and tabs the module unlocks (§6.2); empty for modules whose screens are `core`. */
export function getModuleMenuEntries(code: HotelModuleCode): HotelModuleMenuEntry[] {
  return MODULE_MENU_ENTRIES[code] ?? [];
}

/** Whether a new property starts with the module enabled (§14.1, reversible decision). */
export function isModuleEnabledByDefault(code: HotelModuleCode): boolean {
  return getHotelModuleManifest(code).enabledByDefault;
}
