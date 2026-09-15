import type { HotelModuleCode } from "../modules/module-codes.js";

// Module route map (Tanda 5 · L1a, lote product-manifest).
//
// Two surfaces per module: `mobile` (apps/mobile screen names in `route`) and
// `admin` (apps/admin-web screens). Admin entries are aligned with the Tanda 5
// navigation tree (pilots/tanda5-nav-tree.csv → nav-tree.generated.json):
//   - `label`  = the CSV label (`etiquetaES`), one entry per screen;
//   - `url`    = the Tanda 5 URL of that row;
//   - `screen` = the canonical SCREEN_COMPONENTS key of that row;
//   - `tab`    = the tab label when the row is a `merge-into` (tab of `parent`).
// The legacy `/backoffice/*` `path` of each entry was retired in L1c: the
// router (routes/backoffice.routes.tsx) redirects every old path through
// NAV_TREE.legacyRoutes and every consumer navigates by `url`/`screen`.
// Screens the CSV retires are gone; dev-only placeholders (/desarrollo/*) carry
// `devOnly: true` and `status: "coming_soon"` so consumers hide them outside
// `?dev=1`. Duplicated entries for the same screen were collapsed
// («una pantalla = una entrada = una URL»).

export type ModuleRouteMapItem = {
  label: string;
  /** Mobile surface: apps/mobile screen name. */
  route?: string;
  /** Admin surface: Tanda 5 URL (relative to the shell base path). */
  url?: string;
  /** Admin surface: canonical SCREEN_COMPONENTS key. */
  screen?: string;
  /** Admin surface: tab label when the screen is a tab of `parent`. */
  tab?: string;
  /** Admin surface: label of the menu item a tab hangs from. */
  parent?: string;
  /** Admin surface: only reachable with `?dev=1` + platform admin (under /desarrollo/*). */
  devOnly?: boolean;
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
      { label: "Reservas", route: "Reservations", permission: "pms.reservation.read", description: "Crear y gestionar estancias, huéspedes, folios y estado operativo.", status: "ready" },
      { label: "Nueva reserva", route: "CreateReservation", permission: "pms.reservation.create", description: "Cotizar disponibilidad, elegir habitación o recurso, tomar los datos del huésped y confirmar.", status: "ready" },
      { label: "Informes de reservas", route: "ReservationReports", permission: "analytics.read", description: "Llegadas, salidas, cancelaciones, no presentados y pickup.", status: "ready" }
    ],
    admin: [
      {
        label: "Reservas",
       
        url: "/recepcion/reservas",
        screen: "ReservationWorkspace",
        permission: "pms.reservation.read",
        description: "Espacio de reservas con lista, cronograma, tablero de habitaciones y detalle.",
        status: "ready"
      },
      {
        label: "Nueva reserva",
       
        url: "/recepcion/reservas/nueva",
        screen: "ReservationCreate",
        permission: "pms.reservation.create",
        description: "Alta manual de reserva conectada al PMS, con precio de tarifa y categorías.",
        status: "ready"
      }
    ]
  },
  compliance_billing: {
    mobile: [
      { label: "Facturas", route: "Invoices", permission: "billing.compliance.view", description: "Revisión de folios, facturas y cumplimiento fiscal.", status: "ready" },
      { label: "Informes de facturación", route: "BillingReports", permission: "analytics.read", description: "Informes de facturas, cobros y saldos.", status: "ready" }
    ],
    admin: [
      {
        label: "Facturación y cobros",
       
        url: "/finanzas/facturacion",
        screen: "BillingCenter",
        permission: "billing.compliance.view",
        description: "Cargos de folio, cobros, borradores de factura y emisión; folio, rectificativas y enrutamiento como pestañas.",
        status: "ready"
      }
    ]
  },
  hotel_intelligence_platform: {
    mobile: [
      { label: "Informes", route: "Reports", permission: "analytics.read", description: "Informes operativos, de revenue, de facturación y del propietario.", status: "ready" }
    ],
    admin: [
      {
        label: "Centro de informes",
       
        url: "/informes",
        screen: "ReportingCenter",
        permission: "analytics.read",
        description: "Catálogo de informes, datos y exportación.",
        status: "ready"
      },
      {
        label: "Analítica",
       
        url: "/informes/analitica",
        screen: "AnalyticsCenterDashboard",
        permission: "analytics.read",
        description: "Indicadores, consultas y detección de anomalías.",
        status: "ready"
      }
    ]
  },
  backoffice: {
    mobile: [
      { label: "Configuración", route: "BackOfficePreview", permission: "backoffice.access", description: "Configurar la propiedad, los módulos, las integraciones, el cumplimiento y los usuarios.", status: "ready" },
      { label: "Puesta en marcha", route: "SetupCenterPreview", permission: "backoffice.access", description: "Progreso guiado, elementos pendientes, salud de módulos y preparación para la salida en vivo.", status: "ready" },
      { label: "Opciones de configuración", route: "ManualSetupPreview", permission: "configuration.read", description: "Todas las opciones de configuración introducidas por el hotel con ruta, endpoint, permiso y campos obligatorios.", status: "ready" },
      { label: "Centro de configuración", route: "ConfigurationCenter", permission: "configuration.read", description: "Categorías, campos personalizados, habitaciones, recursos, departamentos y formularios de configuración.", status: "ready" },
      { label: "Categorías", route: "CategoryManagerPreview", permission: "categories.read", description: "Gestionar la taxonomía operativa, plantillas, importación y exportación y sugerencias de IA.", status: "ready" },
      { label: "Propiedad", route: "PropertySetupPreview", permission: "property.configure", description: "Introducir los datos del hotel a mano: perfil legal, categorías, habitaciones, espacios y recursos.", status: "ready" },
      { label: "Módulos", route: "ModuleMarketplace", permission: "modules.read", description: "Activar, configurar y comprobar la salud de los módulos.", status: "ready" },
      { label: "Integraciones", route: "MarketplaceHome", permission: "integrations.read", description: "Conectar canales, pagos, mensajería y adaptadores de administración.", status: "ready" },
      { label: "Usuarios y roles", route: "BackOfficePreview", permission: "users.read", description: "Invitar usuarios y revisar el acceso por rol.", status: "needs_setup" }
    ],
    // Configuración category of the Tanda 5 tree (items and their tabs).
    admin: [
      { label: "Puesta en marcha", url: "/configuracion/puesta-en-marcha", screen: "SetupCenterScreen", permission: "backoffice.access", description: "Único centro de configuración: progreso, elementos pendientes y salida en vivo.", status: "ready" },
      { label: "Salida en vivo", url: "/configuracion/puesta-en-marcha/salida-en-vivo", screen: "GoLiveChecklist", tab: "Salida en vivo", parent: "Puesta en marcha", permission: "backoffice.access", description: "Lista de comprobación y estado de preparación para la salida en vivo.", status: "ready" },
      { label: "Importar desde documentos", url: "/configuracion/puesta-en-marcha/importar-documentos", screen: "PropertyMapper", tab: "Importar desde documentos", parent: "Puesta en marcha", permission: "property.map.read", description: "Extracción con IA de la estructura de la propiedad a partir de documentos.", status: "ready" },
      { label: "Propiedad", url: "/configuracion/propiedad", screen: "PropertyProfileSetupForm", permission: "property_profile.edit", description: "Perfil legal y fiscal, dirección y reglas de fecha de negocio.", status: "ready" },
      { label: "Edificios", url: "/configuracion/propiedad/edificios", screen: "BuildingSetupForm", tab: "Edificios", parent: "Propiedad", permission: "property.configure", description: "Edificios de la propiedad.", status: "ready" },
      { label: "Plantas", url: "/configuracion/propiedad/plantas", screen: "FloorSetupForm", tab: "Plantas", parent: "Propiedad", permission: "property.configure", description: "Plantas por edificio.", status: "ready" },
      { label: "Zonas", url: "/configuracion/propiedad/zonas", screen: "ZoneSetupForm", tab: "Zonas", parent: "Propiedad", permission: "property.configure", description: "Zonas operativas.", status: "ready" },
      { label: "Departamentos", url: "/configuracion/propiedad/departamentos", screen: "DepartmentSetupForm", tab: "Departamentos", parent: "Propiedad", permission: "departments.manage", description: "Departamentos y responsables.", status: "ready" },
      { label: "Categorías", url: "/configuracion/propiedad/categorias", screen: "CategoryManagerScreen", tab: "Categorías", parent: "Propiedad", permission: "categories.read", description: "Opciones de categoría, plantillas, importación y exportación.", status: "ready" },
      { label: "Campos personalizados", url: "/configuracion/propiedad/campos-personalizados", screen: "CustomFieldSetupForm", tab: "Campos personalizados", parent: "Propiedad", permission: "custom_fields.read", description: "Campos propios de la propiedad para habitaciones, huéspedes, reservas y activos.", status: "ready" },
      { label: "Habitaciones y espacios", url: "/configuracion/habitaciones", screen: "RoomSetupForm", permission: "rooms.manage", description: "Inventario de habitaciones; tipos y espacios como pestañas.", status: "ready" },
      { label: "Tipos", url: "/configuracion/habitaciones/tipos", screen: "RoomTypeSetupForm", tab: "Tipos", parent: "Habitaciones y espacios", permission: "room_types.manage", description: "Tipos de habitación, camas y ocupación.", status: "ready" },
      { label: "Espacios y recursos", url: "/configuracion/habitaciones/espacios", screen: "SpaceResourceSetupForm", tab: "Espacios y recursos", parent: "Habitaciones y espacios", permission: "spaces.manage", description: "Aparcamiento, salas, puntos de venta y otros recursos reservables.", status: "ready" },
      { label: "Usuarios y roles", url: "/configuracion/usuarios", screen: "UserRoleManager", permission: "users.read", description: "Usuarios, roles, permisos y seguridad.", status: "ready" },
      { label: "Comunicaciones", url: "/configuracion/comunicaciones", screen: "NotificationsScreen", permission: "backoffice.access", description: "Plantillas, envíos y estado de los canales.", status: "ready" },
      { label: "Correo entrante", url: "/configuracion/comunicaciones/correo-entrante", screen: "EmailConnectors", tab: "Correo entrante", parent: "Comunicaciones", permission: "ai_governance.read", description: "Conectores de correo que convierten mensajes en reservas.", status: "ready" },
      { label: "Facturación y pagos", url: "/configuracion/facturacion-pagos", screen: "BillingSettings", permission: "billing.configure", description: "Series de facturación, marca y numeración legal.", status: "ready" },
      { label: "Pagos", url: "/configuracion/facturacion-pagos/pagos", screen: "PaymentSettings", tab: "Pagos", parent: "Facturación y pagos", permission: "payments.configure", description: "Pasarela y métodos de pago.", status: "ready" },
      { label: "Contabilidad y fiscal", url: "/configuracion/contabilidad-fiscal", screen: "AccountingSettings", permission: "accounting.configure", description: "Plan contable, periodos y exportes.", status: "ready" },
      { label: "Fiscal", url: "/configuracion/contabilidad-fiscal/fiscal", screen: "TaxComplianceSettings", tab: "Fiscal", parent: "Contabilidad y fiscal", permission: "compliance_setup.manage", description: "Región fiscal, tipos impositivos y VeriFactu.", status: "ready" },
      { label: "Perfil inicial", url: "/configuracion/contabilidad-fiscal/perfil-inicial", screen: "FinanceComplianceSetupForm", tab: "Perfil inicial", parent: "Contabilidad y fiscal", permission: "compliance_setup.manage", description: "Puesta en marcha de finanzas y cumplimiento.", status: "ready" },
      { label: "Categorías de ingresos", url: "/configuracion/contabilidad-fiscal/categorias-ingresos", screen: "RevenueCategorySetupForm", tab: "Categorías de ingresos", parent: "Contabilidad y fiscal", permission: "revenue_setup.manage", description: "Categorías de ingresos y su cuenta contable.", status: "ready" },
      { label: "Módulos e integraciones", url: "/configuracion/modulos", screen: "ModuleManager", permission: "modules.read", description: "Activación de módulos, salud e integraciones.", status: "ready" },
      { label: "Salud", url: "/configuracion/modulos/salud", screen: "ModuleHealthCenter", tab: "Salud", parent: "Módulos e integraciones", permission: "modules.read", description: "Comprobaciones de salud por módulo.", status: "ready" },
      { label: "Integraciones", url: "/configuracion/modulos/integraciones", screen: "MarketplaceCatalog", tab: "Integraciones", parent: "Módulos e integraciones", permission: "integrations.read", description: "Proveedores, conexión y estado leído del API.", status: "ready" },
      { label: "Inteligencia artificial", url: "/configuracion/ia", screen: "PropertyAiScreen", permission: "ai_governance.read", description: "Ajustes de IA de la propiedad; herramientas, actividad, gobernanza y alta como pestañas.", status: "ready" },
      { label: "Herramientas", url: "/configuracion/ia/herramientas", screen: "AiToolRegistryScreen", tab: "Herramientas", parent: "Inteligencia artificial", permission: "ai_governance.read", description: "Catálogo de herramientas y nivel de automatización.", status: "ready" },
      { label: "Actividad", url: "/configuracion/ia/actividad", screen: "AiPipelineStatusScreen", tab: "Actividad", parent: "Inteligencia artificial", permission: "ai_governance.read", description: "Telemetría y coste de las llamadas de IA.", status: "ready" },
      { label: "Gobernanza", url: "/configuracion/ia/gobernanza", screen: "AiGovernanceScreen", tab: "Gobernanza", parent: "Inteligencia artificial", permission: "ai_governance.read", description: "Políticas, instrucciones, evaluaciones e incidentes.", status: "ready" },
      { label: "Alta de IA", url: "/configuracion/ia/alta", screen: "AiPropertySetupForm", tab: "Alta de IA", parent: "Inteligencia artificial", permission: "ai_category_setup.use", description: "Paso de IA de la puesta en marcha.", status: "ready" },
      { label: "Sistema", url: "/configuracion/sistema", screen: "AuditLogViewer", permission: "audit.read", description: "Auditoría; webhooks, aplicaciones, API y organizaciones como pestañas.", status: "ready" }
    ]
  },
  revenue_profit_engine: {
    mobile: [
      { label: "Revenue", route: "RevenueHome", permission: "revenue.read", description: "Previsiones, indicadores, recomendaciones y precios.", status: "ready" },
      { label: "Histórico y previsión", route: "RevenueHistoryForecast", permission: "revenue.history_forecast.read", description: "Rendimiento pasado y futuro por periodo.", status: "ready" },
      { label: "Parrilla de tarifas", route: "RateGrid", permission: "revenue.manage_rates", description: "Gestionar precios, disponibilidad y restricciones.", status: "ready" },
      { label: "Previsión", route: "RevenueForecastGraph", permission: "revenue.forecast.read", description: "Gráficos de previsión y factores de confianza.", status: "ready" },
      { label: "Recomendaciones", route: "RevenueRecommendations", permission: "revenue.recommend", description: "Revisar las acciones de revenue propuestas por la IA antes de aplicarlas.", status: "ready" },
      { label: "Canales de venta", route: "ChannelManagerHome", permission: "channel_manager.read", description: "Sincronizar tarifas, inventario y reservas de OTA.", status: "ready" },
      { label: "Correspondencias", route: "ChannelManagerHome", permission: "channel_manager.mappings.manage", description: "Relacionar recursos y planes de tarifas internos con los códigos de habitación y tarifa de cada OTA.", status: "ready" },
      { label: "Calendario de demanda", route: "DemandCalendar", permission: "revenue.forecast.read", description: "Eventos, fechas de compresión y señales de demanda.", status: "ready" },
      { label: "Competencia", route: "RateParityAlerts", permission: "revenue.read", description: "Seguimiento de competidores y de paridad.", status: "needs_setup" },
      { label: "Alertas de paridad", route: "RateParityAlerts", permission: "channel_manager.read", description: "Alertas de precio distinto entre OTA y venta directa.", status: "ready" },
      { label: "Simulador de escenarios", route: "ScenarioSimulator", permission: "revenue.recommend", description: "Análisis de precios y restricciones «qué pasaría si».", status: "ready" },
      { label: "Calidad de datos", route: "RevenueSettings", permission: "revenue.read", description: "Comprobaciones de preparación: instantáneas, correspondencias, planes de tarifas y confianza de la previsión.", status: "ready" }
    ],
    // Revenue category of the Tanda 5 tree. Sidebar.tsx spreads this list into
    // «Revenue / Tarifas» (dedupe by screen) and RevenueHomeDashboard renders one
    // card per entry, both navigating by `path`.
    admin: [
      { label: "Panel de revenue", url: "/revenue", screen: "RevenueHomeDashboard", permission: "revenue.read", description: "Centro de mando comercial.", status: "ready" },
      { label: "Parrilla de tarifas", url: "/revenue/parrilla", screen: "RateGridEditorScreen", permission: "revenue.manage_rates", description: "Tarifas, inventario y restricciones (parrilla v2).", status: "ready" },
      { label: "Historial", url: "/revenue/parrilla/historial", screen: "RateJournalScreen", tab: "Historial", parent: "Parrilla de tarifas", permission: "revenue.manage_rates", description: "Historial de cambios de tarifa con diferencia por celda y reversión.", status: "ready" },
      { label: "Reglas y recomendaciones", url: "/revenue/reglas", screen: "RevenueRules", permission: "revenue.recommend", description: "Reglas, umbrales de automatización y recomendaciones para aprobar, rechazar o simular.", status: "ready" },
      { label: "Histórico y previsión", url: "/revenue/historico-prevision", screen: "RevenueHistoryForecastDashboard", permission: "revenue.history_forecast.read", description: "Tarjetas de indicadores, gráficos y tabla del informe.", status: "ready" },
      { label: "Explorador", url: "/revenue/historico-prevision/explorador", screen: "RevenueForecastExplorer", tab: "Explorador", parent: "Histórico y previsión", permission: "revenue.forecast.read", description: "Confianza de la previsión y sus factores.", status: "ready" },
      { label: "Comparativa", url: "/revenue/comparativa", screen: "RevenueComparisonDashboard", permission: "revenue.comparison.read", description: "Comparación entre periodos y propiedades.", status: "ready" },
      { label: "Reunión de revenue", url: "/revenue/reunion", screen: "RevenueMeeting", permission: "revenue.read", description: "Panel semanal de la reunión de revenue.", status: "ready" },
      { label: "Competencia", url: "/revenue/competencia", screen: "RateShopperSettings", permission: "revenue.read", description: "Conjunto de competidores y comparación de tarifas.", status: "ready" },
      { label: "Calendario de demanda", url: "/revenue/calendario-demanda", screen: "DemandCalendarAdmin", permission: "revenue.forecast.read", description: "Eventos de demanda y señales de mercado.", status: "ready" }
    ]
  },
  distribution_hub: {
    mobile: [
      { label: "Canales de venta", route: "ChannelManagerHome", permission: "channel_manager.read", description: "Canales conectados, correspondencias y salud de la sincronización.", status: "ready" },
      { label: "Salud de sincronización", route: "ChannelSyncHealth", permission: "channel_manager.read", description: "Envíos fallidos, reintentos y bloqueos de correspondencia.", status: "ready" },
      { label: "Alertas de paridad", route: "RateParityAlerts", permission: "channel_manager.read", description: "Alertas de paridad de precios y de precios por debajo del directo.", status: "ready" }
    ],
    admin: [
      { label: "Canales de venta", url: "/comercial/canales", screen: "ChannelAggregatorHub", permission: "channel_manager.read", description: "Canales, sincronización de tarifas e inventario, cola de envíos y alertas de paridad.", status: "ready" },
      { label: "Correspondencias", url: "/comercial/canales/correspondencias", screen: "ChannelMappings", tab: "Correspondencias", parent: "Canales de venta", permission: "channel_manager.mappings.manage", description: "Correspondencia entre habitaciones y planes de tarifas internos y los códigos de cada canal.", status: "ready" }
    ]
  },
  guest_experience: {
    mobile: [
      { label: "Recorrido del huésped", route: "GuestJourney", permission: "guest_experience.inbox.read", description: "Recorrido desde la reserva hasta después de la estancia, pasos bloqueados y siguientes acciones.", status: "ready" },
      { label: "Mensajes de huéspedes", route: "concierge", permission: "guest_experience.inbox.read", description: "Mensajes de huéspedes, aviso de IA y traspaso a una persona.", status: "ready" }
    ],
    admin: [
      { label: "Mensajes de huéspedes", url: "/recepcion/mensajes", screen: "ConciergeInboxDashboard", permission: "guest_experience.inbox.read", description: "Bandeja de mensajes con borrador de IA y auditoría.", status: "ready" },
      { label: "Recorrido", url: "/recepcion/reservas/:id/recorrido", screen: "GuestJourneyWorkspace", tab: "Recorrido", parent: "Reservas", permission: "guest_experience.inbox.read", description: "Recorrido de una reserva desde antes de la llegada hasta la salida.", status: "ready" }
    ]
  },
  integration_marketplace: {
    mobile: [
      { label: "Integraciones", route: "MarketplaceHome", permission: "integrations.read", description: "Módulos e integraciones como superficies de producto de primer nivel.", status: "ready" }
    ],
    admin: [
      { label: "Integraciones", url: "/configuracion/modulos/integraciones", screen: "MarketplaceCatalog", tab: "Integraciones", parent: "Módulos e integraciones", permission: "integrations.read", description: "Categorías de integración, proveedores y asistentes de configuración.", status: "ready" }
    ]
  },
  ai_onboarding_migration: {
    mobile: [
      { label: "Asistente de puesta en marcha", route: "AISetupWizard", permission: "onboarding.read", description: "Sube lo que tengas: la IA extrae, relaciona y muestra la configuración antes de aprobarla.", status: "ready" },
      { label: "Proyecto de migración", route: "OnboardingProject", permission: "onboarding.read", description: "Revisar ficheros de origen, entidades extraídas, correspondencias y progreso de la migración.", status: "ready" },
      { label: "Revisión de migración", route: "MigrationReview", permission: "onboarding.review", description: "Aprobar, rechazar o editar las correspondencias de baja confianza antes de la simulación.", status: "ready" },
      { label: "Salida en vivo", route: "GoLiveReadiness", permission: "onboarding.go_live", description: "Bloqueos, lista de comprobación del corte y estado de la aprobación final.", status: "ready" }
    ],
    // The migration screens are scaffolds: dev-only under /desarrollo/migracion/*
    // until L6 wires the 37 /onboarding/* routes. Never shown to hoteliers.
    admin: [
      { label: "Migración asistida (dev)", url: "/desarrollo/migracion", screen: "OnboardingProjects", devOnly: true, permission: "onboarding.read", description: "Proyectos de migración, sistemas de origen y fechas de salida en vivo.", status: "coming_soon" },
      { label: "Subida y clasificación (dev)", url: "/desarrollo/migracion/ficheros", screen: "FileUploadAndClassification", devOnly: true, permission: "onboarding.upload", description: "Ficheros clasificados, tablas extraídas y referencias al origen.", status: "coming_soon" },
      { label: "Revisión de extracción (dev)", url: "/desarrollo/migracion/revision", screen: "AIExtractionReview", devOnly: true, permission: "onboarding.review", description: "Estructura, habitaciones, tarifas, reservas, huéspedes y calidad de datos de la extracción.", status: "coming_soon" },
      { label: "Lotes de migración (dev)", url: "/desarrollo/migracion/lotes", screen: "MigrationBatches", devOnly: true, permission: "onboarding.apply", description: "Simulación, aplicación y reversión de los lotes de migración.", status: "coming_soon" }
    ]
  }
};

export function getModuleRouteItems(moduleCode: HotelModuleCode | "backoffice", surface: "mobile" | "admin"): ModuleRouteMapItem[] {
  return MODULE_ROUTE_MAP[moduleCode]?.[surface] ?? [];
}
