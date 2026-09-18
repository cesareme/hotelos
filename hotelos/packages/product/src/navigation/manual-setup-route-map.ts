import type { HotelModuleCode } from "../modules/module-codes.js";

// Manual setup options (Tanda 5 · L1a, lote product-manifest).
//
// Data of the Setup Center («Puesta en marcha», the single configuration hub of
// the Tanda 5 tree): every option a hotel fills in by hand, with the screen
// that edits it, its endpoints, tables and required inputs. Aligned with
// pilots/tanda5-nav-tree.csv:
//   - `screen` is the canonical SCREEN_COMPONENTS key of the destination
//     (retired duplicates such as CustomFieldManagerScreen, the alias keys and
//     the ghost screens POSSettings/AssetSettings/ConciergeSettings are gone);
//   - `url` is the Tanda 5 URL of that screen or tab (the legacy `adminPath`
//     was retired in L1c: the router redirects old `/backoffice/*` paths
//     through NAV_TREE.legacyRoutes and SetupCenterScreen navigates by `url`).
// Options whose destination was a placeholder, a scaffold or a retired hub were
// removed (see RETIRED_MANUAL_SETUP_OPTIONS): the plan forbids «Próximamente»
// cards in front of a hotelier. Labels, descriptions, input names and checks
// are Spanish because the Setup Center and the mobile preview render them.

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

/** Groups of the Setup Center, named after the categories of the Tanda 5 tree. */
export type ManualSetupGroup =
  | "Propiedad"
  | "Configuración"
  | "Módulos e integraciones"
  | "Revenue"
  | "Canales de venta"
  | "Finanzas"
  | "Cumplimiento"
  | "Inteligencia artificial"
  | "Huéspedes"
  | "Operaciones";

export type ManualSetupOption = {
  code: string;
  group: ManualSetupGroup;
  label: string;
  description: string;
  moduleCode?: HotelModuleCode | "backoffice";
  /** Tanda 5 URL of the destination screen or tab. */
  url: string;
  mobileRoute?: string;
  /** Canonical SCREEN_COMPONENTS key of the destination. */
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
    label: "Formulario manual",
    description: "El personal del hotel introduce y edita directamente todos los campos obligatorios."
  },
  guided_wizard: {
    code: "guided_wizard",
    label: "Asistente guiado",
    description: "Flujo paso a paso con validación, campos obligatorios y progreso de la configuración."
  },
  bulk_csv_xlsx: {
    code: "bulk_csv_xlsx",
    label: "Importación CSV/XLSX",
    description: "Subir una hoja de cálculo, previsualizar las filas a crear, actualizar u omitir y aplicar tras confirmar.",
    requiresReview: true
  },
  template_apply: {
    code: "template_apply",
    label: "Plantilla de configuración",
    description: "Aplicar una plantilla por tipo de hotel con previsualización, detección de duplicados y auditoría.",
    requiresReview: true
  },
  ai_assisted: {
    code: "ai_assisted",
    label: "Sugerencia de IA",
    description: "La IA puede proponer categorías, correspondencias o valores, pero no los aplica sin revisión.",
    requiresReview: true
  },
  api_connector: {
    code: "api_connector",
    label: "Conector de API",
    description: "Conectar un sistema de origen o un proveedor y relacionar los datos importados antes de aplicarlos.",
    requiresReview: true
  },
  voice_text: {
    code: "voice_text",
    label: "Descripción por voz o texto",
    description: "El hotel describe lo que necesita por voz o texto y revisa la propuesta estructurada.",
    requiresReview: true
  },
  floor_plan_upload: {
    code: "floor_plan_upload",
    label: "Subida de planos",
    description: "Subir planos o mapas de habitaciones, extraer candidatos y confirmar a mano las etiquetas dudosas.",
    requiresReview: true
  },
  room_walk: {
    code: "room_walk",
    label: "Recorrido por la propiedad",
    description: "Recorrer el hotel dictando habitaciones, zonas, secciones y rangos de recursos.",
    requiresReview: true
  },
  grid_editor: {
    code: "grid_editor",
    label: "Editor en cuadrícula",
    description: "Cuadrícula editable y densa para tarifas, correspondencias, restricciones o taxonomía operativa."
  },
  report_upload: {
    code: "report_upload",
    label: "Subida de informes",
    description: "Subir informes PDF/CSV/XLSX, extraer filas, validar totales y aprobar la importación.",
    requiresReview: true
  },
  credential_secret: {
    code: "credential_secret",
    label: "Credencial secreta",
    description: "Guardar las credenciales del proveedor o de la autoridad como referencias a un secreto, nunca en claro."
  },
  test_connection: {
    code: "test_connection",
    label: "Prueba de conexión",
    description: "Validar credenciales, correspondencias y salud del proveedor antes de activar la sincronización."
  },
  dry_run: {
    code: "dry_run",
    label: "Simulación previa",
    description: "Mostrar los registros que se crearían, actualizarían, omitirían o bloquearían antes de aplicar cambios reales.",
    requiresReview: true
  }
};

/**
 * Options removed in Tanda 5 and what covers them now (for redirects of saved
 * submissions and for the demo). None of them had a real destination: their
 * screens were placeholders, scaffolds, retired hubs or duplicates.
 */
export const RETIRED_MANUAL_SETUP_OPTIONS: ReadonlyArray<{ code: string; coveredBy: string | null; reason: string }> = [
  { code: "revenue_settings", coveredBy: "revenue_recommendation_rules", reason: "Duplicado: la misma pantalla (RevenueRules) que Reglas y recomendaciones." },
  { code: "revenue_data_quality", coveredBy: null, reason: "RevenueDataQuality es un placeholder solo con ?dev=1 (/desarrollo/revenue-calidad-datos)." },
  { code: "channel_sync_rules", coveredBy: "channel_connections", reason: "Duplicado: abre el mismo hub de canales (ChannelAggregatorHub)." },
  { code: "billing_reports", coveredBy: "reservation_reporting", reason: "Duplicado: el Centro de informes es una sola pantalla (ReportingCenter)." },
  { code: "pos_outlets_products", coveredBy: null, reason: "Pantalla POSSettings inexistente y ruta hacia un hub retirado (ConfigurationCenterScreen)." },
  { code: "procurement_inventory", coveredBy: null, reason: "InventorySettings es un placeholder solo con ?dev=1 (/desarrollo/inventario-ajustes)." },
  { code: "asset_capex_energy", coveredBy: null, reason: "Pantalla AssetSettings inexistente y ruta hacia un hub retirado." },
  { code: "workforce_labor", coveredBy: null, reason: "WorkforceSettings es un placeholder solo con ?dev=1 (/desarrollo/personal-ajustes)." },
  { code: "safety_incident_setup", coveredBy: null, reason: "SafetySettings es un placeholder solo con ?dev=1 (/desarrollo/seguridad-ajustes)." },
  { code: "ai_setup_wizard", coveredBy: null, reason: "AISetupCenter se retira; la migración asistida queda solo con ?dev=1 (/desarrollo/migracion)." },
  { code: "guest_journey_settings", coveredBy: null, reason: "Sin backend de ajustes: el recorrido vive en Reservas › Detalle › Recorrido." },
  { code: "concierge_messaging_templates", coveredBy: null, reason: "Pantalla ConciergeSettings inexistente; las plantillas viven en Comunicaciones." },
  { code: "developer_platform", coveredBy: null, reason: "DeveloperPortal se retira; webhooks y aplicaciones son pestañas de Sistema solo para administración." },
  { code: "analytics_owner_reporting", coveredBy: null, reason: "AnalyticsSettings se retira (placeholder sin backend)." },
  { code: "audit_security_settings", coveredBy: "departments_users_roles", reason: "Duplicado: la misma pantalla (UserRoleManager) que Usuarios y roles." }
];

const RAW_MANUAL_SETUP_OPTIONS: RawManualSetupOption[] = [
  {
    code: "property_profile",
    group: "Propiedad",
    label: "Propiedad",
    description: "Identidad legal, dirección, zona horaria, moneda, región fiscal y reglas de fecha de negocio.",
    moduleCode: "backoffice",
    url: "/configuracion/propiedad",
    mobileRoute: "PropertySetupPreview",
    screen: "PropertyProfileSetupForm",
    permission: "property_profile.edit",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/property_profile",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/property_profile",
    targetTables: ["properties", "organizations", "property_setup_form_submissions"],
    inputCategories: ["Perfil de la propiedad", "Perfil legal", "Reglas de fecha de negocio"],
    requiredInputs: ["Nombre de la propiedad", "Razón social", "NIF", "Dirección completa", "País", "Región", "Zona horaria", "Moneda", "Región fiscal"],
    status: "ready"
  },
  {
    code: "buildings_floors_zones",
    group: "Propiedad",
    label: "Edificios, plantas y zonas",
    description: "Jerarquía física que usan habitaciones, recursos, pisos y mantenimiento.",
    moduleCode: "backoffice",
    url: "/configuracion/propiedad/edificios",
    mobileRoute: "PropertySetupPreview",
    screen: "BuildingSetupForm",
    permission: "property.configure",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/building",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/building",
    targetTables: ["buildings", "floors", "property_zones", "property_setup_form_submissions"],
    inputCategories: ["Edificios", "Plantas", "Zonas", "Importar desde documentos"],
    requiredInputs: ["Nombre del edificio", "Código del edificio", "Nombre de la planta", "Número de planta", "Nombre de la zona", "Tipo de zona", "Orden", "Activo"],
    status: "ready"
  },
  {
    code: "rooms_room_types",
    group: "Propiedad",
    label: "Habitaciones y tipos",
    description: "Inventario vendible, tipos de habitación, camas, características, ocupación y secciones operativas.",
    moduleCode: "pms_core",
    url: "/configuracion/habitaciones",
    mobileRoute: "PropertySetupPreview",
    screen: "RoomSetupForm",
    permission: "rooms.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/room",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/room",
    targetTables: ["rooms", "room_types", "room_features", "bed_types", "property_setup_form_submissions"],
    inputCategories: ["Habitaciones", "Tipos de habitación", "Características", "Tipos de cama", "Secciones de pisos", "Áreas de mantenimiento"],
    requiredInputs: ["Número de habitación", "Tipo de habitación", "Edificio", "Planta", "Zona", "Ocupación máxima", "Camas", "Vendible", "Activa", "Estado"],
    status: "ready"
  },
  {
    code: "spaces_resources",
    group: "Propiedad",
    label: "Espacios y recursos",
    description: "Aparcamiento, salas de reuniones, espacios de trabajo, spa, puntos de venta y otro inventario más allá de las habitaciones.",
    moduleCode: "pms_core",
    url: "/configuracion/habitaciones/espacios",
    mobileRoute: "PropertySetupPreview",
    screen: "SpaceResourceSetupForm",
    permission: "spaces.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/space_resource",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/space_resource",
    targetTables: ["property_spaces", "inventory_resources", "property_setup_form_submissions"],
    inputCategories: ["Espacios", "Recursos reservables", "Tipos de recurso", "Tipos de espacio"],
    requiredInputs: ["Nombre", "Código", "Tipo de recurso", "Tipo de espacio", "Edificio", "Planta", "Zona", "Aforo", "Modo de reserva", "Vendible", "Código de impuesto"],
    status: "ready"
  },
  {
    code: "departments_users_roles",
    group: "Configuración",
    label: "Departamentos, usuarios y roles",
    description: "Departamentos, responsables, acceso del personal, roles y asignación de permisos.",
    moduleCode: "backoffice",
    url: "/configuracion/usuarios",
    mobileRoute: "BackOfficePreview",
    screen: "UserRoleManager",
    permission: "users.read",
    apiEndpoint: "/backoffice/properties/:propertyId/users",
    saveEndpoint: "/backoffice/properties/:propertyId/users",
    targetTables: ["departments", "users", "user_departments"],
    inputCategories: ["Departamentos", "Usuarios", "Roles", "Permisos"],
    requiredInputs: ["Nombre del departamento", "Código del departamento", "Correo del usuario", "Rol", "Departamento asignado", "Estado activo"],
    status: "ready"
  },
  {
    code: "category_manager",
    group: "Configuración",
    label: "Categorías",
    description: "Taxonomía operativa: características de habitación, tipos de cama, espacios, pisos, mantenimiento, revenue, TPV, activos, seguridad e IA.",
    moduleCode: "backoffice",
    url: "/configuracion/propiedad/categorias",
    mobileRoute: "CategoryManagerPreview",
    screen: "CategoryManagerScreen",
    permission: "categories.read",
    apiEndpoint: "/backoffice/properties/:propertyId/configuration/categories",
    saveEndpoint: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options",
    targetTables: ["category_definitions", "property_category_options", "property_category_option_translations"],
    inputCategories: ["Propiedad", "Habitaciones", "Operaciones", "Revenue", "Finanzas", "Cumplimiento", "Activos", "Seguridad", "IA"],
    requiredInputs: ["Categoría", "Código de la opción", "Etiqueta", "Descripción", "Color", "Icono", "Opción superior", "Estado activo", "Orden"],
    status: "ready"
  },
  {
    code: "custom_fields",
    group: "Configuración",
    label: "Campos personalizados",
    description: "Campos propios de la propiedad para habitaciones, huéspedes, reservas, activos, tareas y partes de avería.",
    moduleCode: "backoffice",
    url: "/configuracion/propiedad/campos-personalizados",
    mobileRoute: "CategoryManagerPreview",
    screen: "CustomFieldSetupForm",
    permission: "custom_fields.read",
    apiEndpoint: "/backoffice/properties/:propertyId/configuration/custom-fields",
    saveEndpoint: "/backoffice/properties/:propertyId/configuration/custom-fields",
    targetTables: ["property_custom_field_definitions", "property_custom_field_values"],
    inputCategories: ["Campos personalizados", "Reglas de validación", "Reglas de visibilidad"],
    requiredInputs: ["Tipo de entidad", "Clave del campo", "Etiqueta", "Tipo de dato", "Obligatorio", "Buscable", "Visible en lista", "Validación (JSON)"],
    status: "ready"
  },
  {
    code: "reservation_setup",
    group: "Operaciones",
    label: "Nueva reserva",
    description: "Alta manual de reserva con origen, segmento, garantía, cancelación, habitación o recurso y categorías de facturación.",
    moduleCode: "pms_core",
    url: "/recepcion/reservas/nueva",
    mobileRoute: "CreateReservation",
    screen: "ReservationCreate",
    permission: "pms.reservation.create",
    apiEndpoint: "/properties/:propertyId/availability/quote",
    saveEndpoint: "/properties/:propertyId/reservations",
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios", "audit_events"],
    inputCategories: ["Origen de la reserva", "Segmento de mercado", "Datos del huésped", "Fechas de estancia", "Tipo de habitación o recurso", "Política de garantía", "Política de cancelación", "Instrucción de facturación"],
    requiredInputs: ["Fecha de llegada", "Fecha de salida", "Adultos", "Tipo de habitación", "Nombre del huésped principal", "Apellidos del huésped principal", "Código de origen", "Instrucción de facturación"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.guided_wizard, INPUT_METHODS.bulk_csv_xlsx, INPUT_METHODS.ai_assisted],
    completionChecks: [
      { code: "reservation_categories_configured", label: "Categorías de origen, segmento, garantía y facturación configuradas", severity: "blocking" },
      { code: "room_type_available", label: "Existe al menos un tipo de habitación vendible", severity: "blocking" },
      { code: "folio_created_on_reservation", label: "Crear una reserva abre un folio", severity: "blocking" }
    ],
    status: "ready"
  },
  {
    code: "reservation_reporting",
    group: "Operaciones",
    label: "Centro de informes",
    description: "Informes de llegadas, salidas, cancelaciones, no presentados, pickup, canal, segmento y facturación.",
    moduleCode: "hotel_intelligence_platform",
    url: "/informes",
    mobileRoute: "ReservationReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/reservations",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["reservations", "reservation_guests", "rooms", "room_types"],
    inputCategories: ["Tipo de informe", "Rango de fechas", "Estado de la reserva", "Canal", "Segmento de mercado", "Tipo de habitación", "Formato de exportación"],
    requiredInputs: ["Fecha desde", "Fecha hasta", "Tipo de informe", "Formato de exportación"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.grid_editor],
    completionChecks: [
      { code: "reservation_report_route_visible", label: "El Centro de informes es accesible desde el menú", severity: "blocking" },
      { code: "report_export_available", label: "Existe el endpoint de exportación PDF/CSV/XLSX/JSON", severity: "warning" }
    ],
    status: "ready"
  },
  {
    code: "module_setup",
    group: "Módulos e integraciones",
    label: "Módulos e integraciones",
    description: "Activar módulos, revisar dependencias, estado de configuración y salud.",
    moduleCode: "module_marketplace",
    url: "/configuracion/modulos",
    mobileRoute: "ModuleMarketplace",
    screen: "ModuleManager",
    permission: "modules.read",
    apiEndpoint: "/modules/catalog",
    saveEndpoint: "/properties/:propertyId/modules/:moduleCode/enable",
    targetTables: ["modules", "property_modules", "module_configuration"],
    inputCategories: ["Módulos", "Dependencias", "Salud", "Estado de configuración"],
    requiredInputs: ["Código del módulo", "Estado de activación", "Configuración (JSON)", "Dependencias listas", "Estado de salud"],
    status: "ready"
  },
  {
    code: "integrations",
    group: "Módulos e integraciones",
    label: "Integraciones",
    description: "Conectar OTA, pagos, mensajería, cerraduras, adaptadores de administración, inteligencia de negocio y proveedores de IA.",
    moduleCode: "integration_marketplace",
    url: "/configuracion/modulos/integraciones",
    mobileRoute: "MarketplaceHome",
    screen: "MarketplaceCatalog",
    permission: "integrations.read",
    apiEndpoint: "/integrations/providers",
    saveEndpoint: "/backoffice/properties/:propertyId/integrations/:providerCode/connect",
    targetTables: ["integration_providers", "property_integrations", "integration_events"],
    inputCategories: ["Proveedores de integración", "Credenciales", "Capacidades", "Salud", "Ajustes de sincronización"],
    requiredInputs: ["Proveedor", "Referencia del secreto", "Capacidades", "Prueba de conexión", "Modo de sincronización", "Estado activo"],
    status: "ready"
  },
  {
    code: "revenue_rate_plans",
    group: "Revenue",
    label: "Planes de tarifas",
    description: "Crear planes BAR, derivados, no reembolsables, paquetes, de empresa y de grupo con sus restricciones.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/planes",
    mobileRoute: "RevenueSettings",
    screen: "RatePlans",
    permission: "revenue.manage_rates",
    apiEndpoint: "/properties/:propertyId/rate-plans",
    saveEndpoint: "/properties/:propertyId/rate-plans",
    // Tanda L2 (corrector): `revenue_automation_rules` was dropped by 20260918130000_persistencia_l2.
    targetTables: ["rate_plans", "property_category_options"],
    inputCategories: ["Planes de tarifas", "Categorías de tarifa", "Reglas de derivación", "Política de cancelación", "Régimen"],
    requiredInputs: ["Código del plan", "Nombre", "Tipo de plan", "Plan superior", "Regla de derivación", "Política de precio mínimo y máximo", "Estado activo"],
    status: "ready"
  },
  {
    code: "rate_grid",
    group: "Revenue",
    label: "Parrilla de tarifas",
    description: "Tarifas manuales, inventario, cierre de venta, estancia mínima, CTA/CTD y marcas de cambio manual.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/parrilla",
    mobileRoute: "RateGrid",
    screen: "RateGridEditorScreen",
    permission: "revenue.manage_rates",
    apiEndpoint: "/properties/:propertyId/rate-grid",
    saveEndpoint: "/properties/:propertyId/rate-grid/bulk-update",
    targetTables: ["rate_plans", "rate_days", "inventory_days", "restriction_days"],
    inputCategories: ["Tarifas", "Inventario", "Restricciones", "Cambios manuales"],
    requiredInputs: ["Fecha", "Tipo de habitación", "Plan de tarifas", "Precio", "Disponibles", "Cierre de venta", "Estancia mínima", "CTA", "CTD"],
    status: "ready"
  },
  {
    code: "history_forecast",
    group: "Revenue",
    label: "Histórico y previsión",
    description: "Informe por periodo con separación histórico/previsión, tarjetas de indicadores, gráficos, tabla detallada y ajustes de exportación.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/historico-prevision",
    mobileRoute: "RevenueHistoryForecast",
    screen: "RevenueHistoryForecastDashboard",
    permission: "revenue.history_forecast.read",
    apiEndpoint: "/revenue/properties/:propertyId/history-forecast",
    // Tanda L2 (L2-02, corrector): the saved-views routes and `revenue_report_views`
    // were retired; what the hotel configures here is the export (Export Center).
    saveEndpoint: "/revenue/properties/:propertyId/history-forecast/export",
    targetTables: ["revenue_daily_snapshots", "revenue_forecast_snapshots"],
    inputCategories: ["Instantáneas de revenue", "Instantáneas de previsión", "Ajustes de exportación"],
    requiredInputs: ["Fecha desde", "Fecha hasta", "Granularidad", "Filtros", "Periodo de comparación", "Indicadores visibles", "Formato de exportación"],
    status: "ready"
  },
  {
    code: "forecast_settings",
    group: "Revenue",
    label: "Explorador de previsión",
    description: "Horizonte de previsión, umbrales de confianza, periodo de comparación, calidad de datos y entradas del modelo.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/historico-prevision/explorador",
    mobileRoute: "RevenueForecastGraph",
    screen: "RevenueForecastExplorer",
    permission: "revenue.forecast.read",
    apiEndpoint: "/revenue/properties/:propertyId/forecasts",
    saveEndpoint: "/revenue/properties/:propertyId/forecasts/generate",
    targetTables: ["revenue_forecasts", "revenue_forecast_snapshots", "revenue_daily_snapshots"],
    inputCategories: ["Horizonte de previsión", "Umbrales de confianza", "Periodo de comparación", "Entradas del modelo", "Calidad de datos"],
    requiredInputs: ["Horizonte de previsión", "Granularidad por defecto", "Periodo de comparación", "Umbral de confianza", "Bloqueos de calidad de datos", "Calendario de regeneración"],
    status: "ready"
  },
  {
    code: "demand_calendar",
    group: "Revenue",
    label: "Calendario de demanda",
    description: "Eventos locales, festivos, fechas de compresión y puntuación de impacto en la demanda.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/calendario-demanda",
    mobileRoute: "DemandCalendar",
    screen: "DemandCalendarAdmin",
    permission: "revenue.configure",
    apiEndpoint: "/revenue/properties/:propertyId/demand-calendar",
    saveEndpoint: "/revenue/properties/:propertyId/demand-calendar",
    targetTables: ["demand_calendar_events", "property_category_options"],
    inputCategories: ["Eventos de demanda", "Tipos de evento", "Puntuación de impacto", "Origen", "Rango de fechas"],
    requiredInputs: ["Nombre del evento", "Tipo de evento", "Fecha de inicio", "Fecha de fin", "Impacto esperado", "Puntuación de impacto", "Origen"],
    status: "ready"
  },
  {
    code: "rate_shopper_competitors",
    group: "Revenue",
    label: "Competencia",
    description: "Hoteles competidores, correspondencia de habitaciones y tarifas comparables, canales de origen, confianza y comparación de paridad.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/competencia",
    mobileRoute: "RateParityAlerts",
    screen: "RateShopperSettings",
    permission: "revenue.configure",
    apiEndpoint: "/rate-shopper/properties/:propertyId/competitors",
    saveEndpoint: "/rate-shopper/properties/:propertyId/competitors",
    targetTables: ["competitor_hotels", "competitor_rate_snapshots", "property_category_options"],
    inputCategories: ["Conjunto de competidores", "Tipos de habitación comparables", "Canales de origen", "Instantáneas de tarifas", "Alertas de paridad"],
    requiredInputs: ["Nombre del competidor", "Distancia", "Categoría (estrellas)", "Puntuación de comparabilidad", "Tipo de habitación comparable", "Canal de origen", "Estado activo"],
    status: "ready"
  },
  {
    code: "revenue_recommendation_rules",
    group: "Revenue",
    label: "Reglas y recomendaciones",
    description: "Reglas de precio por ocupación, recomendaciones de tarifa y su aprobación o aplicación sobre el tarifario.",
    moduleCode: "revenue_profit_engine",
    url: "/revenue/reglas",
    mobileRoute: "RevenueRecommendations",
    screen: "RevenueRules",
    permission: "revenue.automation.manage",
    // Tanda L2 (L2-02, corrector): `/automation-rules` and the tables
    // `revenue_automation_rules` / `revenue_scenarios` were retired; the screen
    // reads recommendations and saves pricing rules (services/revenueApi.ts).
    apiEndpoint: "/revenue/properties/:propertyId/recommendations",
    saveEndpoint: "/revenue/properties/:propertyId/pricing-rules",
    targetTables: ["pricing_rules", "revenue_recommendations"],
    inputCategories: ["Reglas de precio", "Recomendaciones de tarifa", "Umbrales de aprobación", "Límites de seguridad"],
    requiredInputs: ["Nombre de la regla", "Nivel de automatización", "Ámbito", "Precio mínimo y máximo", "Cambio diario máximo", "Umbral de aprobación", "Estado activo"],
    status: "ready"
  },
  {
    code: "channel_connections",
    group: "Canales de venta",
    label: "Canales de venta",
    description: "Conectar el motor directo, Booking.com, Expedia, Google Hotels y canales manuales.",
    moduleCode: "distribution_hub",
    url: "/comercial/canales",
    mobileRoute: "ChannelManagerHome",
    screen: "ChannelAggregatorHub",
    permission: "channel_manager.manage",
    apiEndpoint: "/properties/:propertyId/channels",
    saveEndpoint: "/channel-manager/channels",
    targetTables: ["channels", "channel_sync_jobs"],
    inputCategories: ["Canales", "Credenciales", "Costes", "Ajustes de sincronización", "Salud"],
    requiredInputs: ["Código del proveedor", "Nombre", "Tipo de canal", "Comisión", "Coste de pago", "Referencia del secreto", "Estado"],
    status: "ready"
  },
  {
    code: "channel_mappings",
    group: "Canales de venta",
    label: "Correspondencias",
    description: "Relacionar habitaciones, recursos y planes de tarifas internos con los códigos de habitación y tarifa de cada OTA antes de enviar ARI.",
    moduleCode: "distribution_hub",
    url: "/comercial/canales/correspondencias",
    mobileRoute: "ChannelManagerHome",
    screen: "ChannelMappings",
    permission: "channel_manager.mappings.manage",
    apiEndpoint: "/channel-manager/channels/:channelId/product-mappings",
    saveEndpoint: "/channel-manager/channels/:channelId/product-mappings",
    targetTables: ["channel_product_mappings", "channel_room_mappings", "channel_rate_mappings"],
    inputCategories: ["Correspondencias de habitación", "Correspondencias de tarifa", "Salud de la correspondencia"],
    requiredInputs: ["Canal", "Tipo de habitación interno", "Código de habitación externo", "Plan de tarifas interno", "Código de tarifa externo", "Estado de la correspondencia"],
    status: "ready"
  },
  {
    code: "billing_invoice_sequences",
    group: "Finanzas",
    label: "Facturación y pagos",
    description: "Series de facturación, numeración legal, comportamiento fiscal y preparación de la facturación conforme.",
    moduleCode: "compliance_billing",
    url: "/configuracion/facturacion-pagos",
    mobileRoute: "BackOfficePreview",
    screen: "BillingSettings",
    permission: "billing.configure",
    apiEndpoint: "/backoffice/properties/:propertyId/billing-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/billing-settings",
    targetTables: ["invoice_sequences", "property_modules"],
    inputCategories: ["Facturación", "Series de facturación", "Ajustes fiscales", "Numeración legal"],
    requiredInputs: ["Código de la serie", "Prefijo", "Siguiente número", "Tipo de factura", "Región fiscal", "Estado activo"],
    status: "needs_setup"
  },
  {
    code: "billing_center",
    group: "Finanzas",
    label: "Facturación y cobros",
    description: "Folios de reserva, cargos, cobros, borradores de factura, emisión e informes de facturación.",
    moduleCode: "compliance_billing",
    url: "/finanzas/facturacion",
    mobileRoute: "Invoices",
    screen: "BillingCenter",
    permission: "billing.compliance.view",
    apiEndpoint: "/reservations/:id/folio",
    saveEndpoint: "/invoices/drafts",
    targetTables: ["folios", "folio_lines", "payments", "invoices", "invoice_lines", "audit_events"],
    inputCategories: ["Folio", "Categoría del cargo", "Método de pago", "Código de impuesto", "Tipo de factura", "Tipo de cliente", "Serie de facturación"],
    requiredInputs: ["Reserva", "Folio", "Tipo de factura", "Tipo de cliente", "Total", "Total de impuestos", "Serie de facturación"],
    inputMethods: [INPUT_METHODS.manual_form, INPUT_METHODS.guided_wizard],
    completionChecks: [
      { code: "invoice_sequence_configured", label: "Existe una serie de facturación activa", severity: "blocking" },
      { code: "tax_settings_configured", label: "Los códigos de impuesto están configurados", severity: "blocking" },
      { code: "invoice_issue_route_protected", label: "La emisión de facturas exige permiso y confirmación", severity: "blocking" }
    ],
    status: "ready"
  },
  {
    code: "payment_settings",
    group: "Finanzas",
    label: "Pagos",
    description: "Pasarela de pago, política de tokens, enlaces de pago, controles de captura y devolución y referencias del PSP.",
    moduleCode: "payment_vault",
    url: "/configuracion/facturacion-pagos/pagos",
    mobileRoute: "BackOfficePreview",
    screen: "PaymentSettings",
    permission: "payments.configure",
    apiEndpoint: "/integrations/providers",
    saveEndpoint: "/backoffice/properties/:propertyId/integrations/:providerCode/connect",
    targetTables: ["property_integrations", "payments", "payment_intents"],
    inputCategories: ["Pasarelas de pago", "Tokenización", "Reglas de captura", "Reglas de devolución"],
    requiredInputs: ["Proveedor", "Cuenta de comercio", "Referencia del secreto", "Política de captura", "Política de devolución", "Estado del webhook"],
    status: "needs_setup"
  },
  {
    code: "accounting_settings",
    group: "Finanzas",
    label: "Contabilidad y fiscal",
    description: "Plan contable, exportes para la gestoría, centros de coste y sincronización con el ERP.",
    moduleCode: "erp_accounting",
    url: "/configuracion/contabilidad-fiscal",
    mobileRoute: "AccountingDashboard",
    screen: "AccountingSettings",
    permission: "accounting.configure",
    apiEndpoint: "/backoffice/properties/:propertyId/accounting-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/accounting-settings",
    targetTables: ["accounting_settings", "accounts", "journal_entries"],
    inputCategories: ["Plan contable", "Centros de coste", "Exportes", "Sincronización con el ERP"],
    requiredInputs: ["Cuenta de ingresos por defecto", "Cuenta de impuestos", "Cuenta puente de cobros", "Reglas de centro de coste", "Formato de exportación"],
    status: "ready"
  },
  {
    code: "tax_settings",
    group: "Finanzas",
    label: "Fiscal",
    description: "Regiones fiscales, tasa turística, reglas de recargos, códigos de impuesto de factura y valores fiscales controlados legalmente.",
    moduleCode: "compliance_billing",
    url: "/configuracion/contabilidad-fiscal/fiscal",
    mobileRoute: "BackOfficePreview",
    screen: "TaxComplianceSettings",
    permission: "compliance_setup.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/compliance-settings",
    saveEndpoint: "/backoffice/properties/:propertyId/compliance-settings",
    targetTables: ["property_compliance_settings", "category_definitions", "property_category_options"],
    inputCategories: ["Región fiscal", "Tasa turística", "Códigos de impuesto", "Reglas de recargos", "Impuestos en factura"],
    requiredInputs: ["País", "Región fiscal", "Código de impuesto", "Tipo impositivo", "Regla de tasa turística", "Aplicación en factura", "Fecha de efecto"],
    status: "ready"
  },
  {
    code: "spain_guest_register",
    group: "Cumplimiento",
    label: "Registro de viajeros",
    description: "Datos del RD 933/2021, firmas, menores, verificación de identidad y valores de privacidad por defecto.",
    moduleCode: "spain_guest_register_compliance",
    url: "/cumplimiento/registro-viajeros",
    mobileRoute: "GuestRegisterInbox",
    screen: "GuestRegisterSettings",
    permission: "guest_register.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["authority_reporting_settings", "lodging_legal_profiles", "guest_register_records"],
    inputCategories: ["Registro de viajeros", "Campos legales", "Firmas", "Privacidad del OCR", "Conservación"],
    requiredInputs: ["Activar el cumplimiento", "Actividad profesional", "Campos obligatorios", "Regla de firma", "Método de verificación de identidad", "Política de almacenamiento de la imagen del documento"],
    status: "needs_setup"
  },
  {
    code: "ses_hospedajes",
    group: "Cumplimiento",
    label: "SES.Hospedajes",
    description: "Credenciales de la autoridad, código de establecimiento, exportación por lotes, servicio web y esquemas oficiales.",
    moduleCode: "spain_guest_register_compliance",
    url: "/cumplimiento/registro-viajeros/ses-hospedajes",
    mobileRoute: "SesSubmissionQueue",
    screen: "SesHospedajesSettings",
    permission: "compliance.ses.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["authority_reporting_settings", "authority_submission_batches", "authority_submissions"],
    inputCategories: ["Ajustes de la autoridad", "Credenciales SES", "Exportación por lotes", "Cola de envíos", "Esquemas oficiales"],
    requiredInputs: ["Autoridad de destino", "Código de establecimiento", "Código de arrendador", "Usuario del servicio web", "Referencia del secreto", "Hora del lote", "Envío automático"],
    status: "needs_setup"
  },
  {
    code: "authority_routing",
    group: "Cumplimiento",
    label: "Autoridades",
    description: "Enviar las propiedades españolas a SES.Hospedajes por defecto y a adaptadores autonómicos, como Mossos, cuando estén configurados.",
    moduleCode: "spain_guest_register_compliance",
    url: "/cumplimiento/registro-viajeros/autoridades",
    mobileRoute: "BackOfficePreview",
    screen: "AuthorityRoutingSettings",
    permission: "guest_register.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["authority_routing_rules", "authority_reporting_settings"],
    inputCategories: ["Enrutamiento a autoridades", "Reglas por región", "Configuración del adaptador"],
    requiredInputs: ["País", "Código de región", "Tipo de autoridad", "Prioridad", "Activo", "Motivo de la excepción"],
    status: "ready"
  },
  {
    code: "guest_register_retention",
    group: "Cumplimiento",
    label: "Conservación",
    description: "Conservación durante tres años, acceso a campos sensibles, correspondencia de campos con la autoridad y categorías legales controladas.",
    moduleCode: "spain_guest_register_compliance",
    url: "/cumplimiento/registro-viajeros/conservacion",
    mobileRoute: "GuestRegisterInbox",
    screen: "GuestRegisterRetentionSettings",
    permission: "guest_register.configure",
    apiEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    saveEndpoint: "/compliance/spain/properties/:propertyId/guest-register/settings",
    targetTables: ["guest_register_records", "authority_reporting_settings", "identity_document_processing_events"],
    inputCategories: ["Conservación", "Correspondencia de campos", "Acceso a datos sensibles", "Minimización de documentos", "Política de borrado"],
    requiredInputs: ["Años de conservación", "Evento de inicio de la conservación", "Política de campos sensibles", "Correspondencia de campos con la autoridad", "Regla de borrado o anonimización", "Rol auditor"],
    status: "ready"
  },
  {
    code: "ai_governance",
    group: "Inteligencia artificial",
    label: "Gobernanza de la IA",
    description: "Políticas, registro de herramientas, instrucciones, evaluaciones, incidentes, revisión humana y reglas de confirmación.",
    moduleCode: "ai_governance",
    url: "/configuracion/ia/gobernanza",
    mobileRoute: "AIGovernanceSettings",
    screen: "AiGovernanceScreen",
    permission: "ai_governance.read",
    // Tanda L2 (L2-02, corrector + integrador): `/ai-governance/*` was retired; `/ai-operations/governance/*` is canonical.
    apiEndpoint: "/ai-operations/governance/policies",
    saveEndpoint: "/ai-operations/governance/policies",
    targetTables: ["ai_policies", "ai_tool_registry", "ai_prompt_versions", "ai_human_review"],
    inputCategories: ["Políticas de IA", "Registro de herramientas", "Versiones de instrucciones", "Revisión humana", "Incidentes"],
    requiredInputs: ["Política", "Activación de herramientas", "Umbral de riesgo", "Regla de confirmación", "Rol de revisión humana", "Texto de aviso"],
    status: "ready"
  },
  {
    code: "guest_portal_online_checkin",
    group: "Huéspedes",
    label: "Portal del huésped",
    description: "Pasos del portal, campos del check-in en línea, verificación del pago, firmas, ventas adicionales y textos de aviso.",
    moduleCode: "guest_self_service",
    url: "/comercial/ventas-adicionales/portal",
    mobileRoute: "GuestJourney",
    screen: "GuestPortalSettingsReal",
    permission: "guest_portal.configure",
    // Tanda L2 (L2-02, corrector): `/guest-self-service/properties/:propertyId/settings`
    // was retired (scaffold without backend; L7 decides). Until then the option
    // reads the property configuration and the real upsell catalogue.
    apiEndpoint: "/backoffice/properties/:propertyId/configuration",
    saveEndpoint: "/properties/:propertyId/upsell-offers",
    targetTables: ["properties", "upsell_offers", "property_modules", "property_custom_field_definitions"],
    inputCategories: ["Portal del huésped", "Check-in en línea", "Verificación del pago", "Ventas adicionales", "Avisos al huésped"],
    requiredInputs: ["Portal activo", "Campos obligatorios del check-in", "Regla de verificación del pago", "Regla de firma", "Categorías de ventas adicionales", "Texto de aviso"],
    status: "needs_setup"
  },
  {
    code: "operations_setup",
    group: "Operaciones",
    label: "Ajustes de pisos y mantenimiento",
    description: "Tipos de tarea, esquemas de limpieza, tipos de avería, prioridades, plazos de respuesta y categorías de incidente.",
    moduleCode: "backoffice",
    url: "/operaciones/pisos/ajustes",
    mobileRoute: "PropertySetupPreview",
    screen: "HousekeepingSetupForm",
    permission: "operations_setup.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/housekeeping_setup",
    saveEndpoint: "/backoffice/properties/:propertyId/property-setup/forms/housekeeping_setup",
    targetTables: ["housekeeping_sections", "housekeeping_rules", "maintenance_areas", "maintenance_rules", "property_category_options"],
    inputCategories: ["Pisos", "Mantenimiento", "Seguridad", "Prioridades de los partes"],
    requiredInputs: ["Tipos de tarea", "Esquemas de limpieza", "Regla de inspección", "Tipos de avería", "Niveles de prioridad", "Plazos de respuesta", "Categorías de incidente"],
    status: "ready"
  }
];

function methods(...codes: ManualSetupInputMethod["code"][]): ManualSetupInputMethod[] {
  return codes.map((code) => INPUT_METHODS[code]);
}

function defaultInputMethods(option: RawManualSetupOption): ManualSetupInputMethod[] {
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
  if (option.group === "Canales de venta") {
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
  if (option.group === "Finanzas") {
    return methods("manual_form", "guided_wizard", "bulk_csv_xlsx", "api_connector", "test_connection");
  }
  if (option.group === "Inteligencia artificial") {
    return methods("manual_form", "guided_wizard", "ai_assisted", "dry_run");
  }
  return methods("manual_form", "guided_wizard", "bulk_csv_xlsx", "ai_assisted");
}

function defaultCompletionChecks(option: RawManualSetupOption): ManualSetupCompletionCheck[] {
  const checks: ManualSetupCompletionCheck[] = [
    { code: `${option.code}_permission`, label: `El permiso ${option.permission} está concedido`, severity: "blocking" },
    { code: `${option.code}_required_inputs`, label: "Todos los campos obligatorios están presentes y son válidos", severity: "blocking" },
    { code: `${option.code}_save_endpoint`, label: `El endpoint de guardado ${option.saveEndpoint ?? option.apiEndpoint ?? "pendiente"} está disponible`, severity: "blocking" },
    { code: `${option.code}_audit`, label: "Crear o actualizar escribe un evento de auditoría", severity: "warning" }
  ];

  if (option.group === "Revenue" || option.group === "Canales de venta") {
    checks.push({ code: `${option.code}_data_quality`, label: "Los bloqueos de calidad de datos y de correspondencias están resueltos antes de sincronizar o recomendar", severity: "blocking" });
  }
  if (option.group === "Cumplimiento" || option.group === "Finanzas") {
    checks.push({ code: `${option.code}_legal_control`, label: "Los valores controlados legalmente se eligen de categorías controladas", severity: "blocking" });
  }
  if (option.group === "Inteligencia artificial") {
    checks.push({ code: `${option.code}_human_review`, label: "Las sugerencias de la IA requieren revisión humana antes de aplicarse", severity: "blocking" });
  }
  if (option.inputCategories.some((category) => category.toLowerCase().includes("credencial"))) {
    checks.push({ code: `${option.code}_secret_ref`, label: "Las credenciales se guardan como referencias a un secreto", severity: "blocking" });
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
  const requiredScalarFields: Array<keyof ManualSetupOption> = ["code", "group", "label", "description", "url", "screen", "permission"];
  const requiredArrayFields: Array<keyof ManualSetupOption> = ["targetTables", "inputCategories", "requiredInputs", "inputMethods", "completionChecks"];

  options.forEach((option) => {
    requiredScalarFields.forEach((field) => {
      if (!option[field]) {
        issues.push({
          optionCode: option.code || "unknown",
          field,
          severity: "blocking",
          message: `La opción de configuración ${option.code || "unknown"} no tiene ${field}.`
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
          message: `La opción de configuración ${option.code} debe definir al menos un valor en ${field}.`
        });
      }
    });

    if (!option.apiEndpoint && !option.saveEndpoint) {
      issues.push({
        optionCode: option.code,
        field: "apiEndpoint",
        severity: "blocking",
        message: `La opción de configuración ${option.code} debe exponer un endpoint de lectura o de guardado para que el formulario esté respaldado por la base de datos.`
      });
    }

    if (!option.saveEndpoint) {
      issues.push({
        optionCode: option.code,
        field: "saveEndpoint",
        severity: "warning",
        message: `La opción de configuración ${option.code} aún no tiene endpoint de guardado; muestra un estado honesto en vez de un enlace muerto.`
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
