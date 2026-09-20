// API Reference service — referencia pública auto-generada del manifest.
//
// Directriz HotelOS (Nov 2026):
//   "HotelOS debe diseñarse como plataforma API-first. Marketplace público
//    OAuth2 + Developer Apps."
//
// Lee `routePermissionManifest` (~950 endpoints) y produce una referencia
// navegable agrupada por categoría con:
//   - método + path
//   - permisos requeridos (deny-list deniega si no se tienen)
//   - nivel de riesgo
//   - categoría inferida (PMS, Folio, HK, Maintenance, Revenue, etc.)
//   - descripción en español generada a partir del path (describeEndpoint)
//
// Esto evita una documentación manual que se desincroniza. El manifest es la
// fuente de verdad: si un endpoint no está en el manifest, no funciona; si
// está, aparece aquí.
//
// Cocoa 22 · ola 11 (qa#17): la descripción se construye con un diccionario
// de segmentos en español (SEGMENT_LABELS / SINGLETON_LABELS / ACTION_LABELS)
// en lugar de repetir el segmento inglés de la ruta; un parámetro final
// («/reservations/:id») describe el recurso anterior en singular y nunca
// aparece como «:id»; la rama PUT existe («Sustituir …») y byMethod la cuenta.

import { routePermissionManifest, type ApiRoutePermission } from "../../security/route-permissions.js";

export type ApiCategory =
  | "auth"
  | "pms_reservations"
  | "pms_rooms"
  | "pms_guests"
  | "folio_billing"
  | "fb_pos"
  | "housekeeping"
  | "maintenance"
  | "compliance_es"
  | "revenue"
  | "marketplace"
  | "dashboards"
  | "ai"
  | "channel_manager"
  | "accounting"
  | "communications"
  | "configuration"
  | "webhooks"
  | "search"
  | "other";

export type ApiEndpointRef = {
  method: string;
  path: string;
  category: ApiCategory;
  permissions: string[];
  riskLevel: string;
  description: string;
};

export type ApiCategoryGroup = {
  category: ApiCategory;
  label: string;
  description: string;
  endpoints: ApiEndpointRef[];
};

export type ApiReferenceResult = {
  generatedAt: string;
  manifestVersion: number;
  totalEndpoints: number;
  publicEndpoints: number;          // sin permissions requeridos
  byMethod: { GET: number; POST: number; PATCH: number; DELETE: number; PUT: number };
  byRisk: { public: number; low: number; medium: number; high: number; critical: number };
  categories: ApiCategoryGroup[];
};

const CATEGORY_META: Record<ApiCategory, { label: string; description: string }> = {
  auth: { label: "Autenticación", description: "Inicio de sesión, sesiones, MFA y dispositivos." },
  pms_reservations: { label: "Reservas", description: "Alta y gestión de reservas, check-in/check-out, asignación de habitación y transiciones de estado." },
  pms_rooms: { label: "Habitaciones", description: "Inventario de habitaciones, tipos de habitación y estados de limpieza." },
  pms_guests: { label: "Huéspedes", description: "Perfiles, identidad para SES.HOSPEDAJES y cronología." },
  folio_billing: { label: "Folios y facturación", description: "Líneas de folio, pagos, facturas y divisiones." },
  fb_pos: { label: "F&B / TPV", description: "Puntos de venta, cartas, comandas y escandallos." },
  housekeeping: { label: "Limpieza", description: "Tareas, eventos, secciones y reglas de limpieza." },
  maintenance: { label: "Mantenimiento", description: "Órdenes de trabajo, archivos multimedia y bloqueos." },
  compliance_es: { label: "Cumplimiento ES", description: "VeriFactu, SES.HOSPEDAJES, TicketBAI, IGIC y modelos de la AEAT." },
  revenue: { label: "Revenue Management", description: "Tarifa BAR, planes de tarifas, captación, previsión y competencia." },
  marketplace: { label: "Marketplace + OAuth2", description: "Fichas, instalaciones, aplicaciones de desarrollador y flujo OAuth." },
  dashboards: { label: "Paneles", description: "Endpoints agregados para las vistas por rol y de operaciones." },
  ai: { label: "IA y copiloto", description: "Asistente, copiloto, pasarela y telemetría." },
  channel_manager: { label: "Channel Manager", description: "OTA (Booking, Expedia, Airbnb…) y correspondencias." },
  accounting: { label: "Contabilidad", description: "Diarios, cuentas, periodos fiscales, norma 43 y SEPA." },
  communications: { label: "Comunicación", description: "Conexiones de correo, WhatsApp, SMS y mensajes." },
  configuration: { label: "Configuración", description: "Establecimiento, módulos, ajustes y permisos." },
  webhooks: { label: "Webhooks", description: "Suscripciones, entregas y tipos de evento." },
  search: { label: "Búsqueda", description: "Búsqueda global e indexadores." },
  other: { label: "Otros", description: "Endpoints sin clasificar." }
};

function categorize(path: string): ApiCategory {
  const p = path.toLowerCase();
  // Orden importa — más específico antes que genérico.
  if (p.startsWith("/auth") || p.includes("/sessions") || p.includes("/mfa")) return "auth";
  // Cumplimiento ES (alta prioridad, captura subpaths)
  if (p.includes("/verifactu") || p.includes("/ses/") || p.includes("/tbai") || p.includes("/igic") || p.includes("/compliance") || p.includes("/modelo") || p.includes("/aeat") || p.includes("/esrs") || p.includes("/sostenibilidad") || p.includes("/gdpr")) return "compliance_es";
  // Channel manager
  if (p.includes("/channel") || p.includes("/booking-com") || p.includes("/expedia") || p.includes("/hotelbeds") || p.includes("/airbnb") || p.includes("/vrbo") || p.includes("/ota") || p.includes("/rate-shop")) return "channel_manager";
  // PMS principales (reserva primero porque suele contener mucho)
  if (p.startsWith("/reservations") || p.includes("/reservations/")) return "pms_reservations";
  if (p.startsWith("/rooms") || p.includes("/rooms/")) return "pms_rooms";
  if (p.startsWith("/guests") || p.includes("/guests/") || p.includes("/loyalty") || p.includes("/crm")) return "pms_guests";
  // Folio/billing
  if (p.includes("/folio") || p.includes("/invoice") || p.includes("/payment") || p.includes("/refund") || p.includes("/charge") || p.includes("/tourist-tax")) return "folio_billing";
  // F&B + POS
  if (p.includes("/menu") || p.includes("/pos") || p.includes("/outlet") || p.includes("/recipe") || p.includes("/inventory") || p.includes("/stock") || p.includes("/procurement")) return "fb_pos";
  // HK
  if (p.includes("/housekeeping") || p.includes("/hk")) return "housekeeping";
  // Maintenance
  if (p.includes("/work-order") || p.includes("/maintenance") || p.includes("/safety") || p.includes("/incident")) return "maintenance";
  // Revenue
  if (p.includes("/rate-plan") || p.includes("/bar") || p.includes("/pickup") || p.includes("/forecast") || p.includes("/revenue") || p.includes("/pricing") || p.includes("/budget") || p.includes("/pace") || p.includes("/segment") || p.includes("/competitor") || p.includes("/displacement") || p.includes("/sales") || p.includes("/groups-events")) return "revenue";
  // Marketplace + developer
  if (p.includes("/marketplace") || p.includes("/oauth") || p.includes("/developer")) return "marketplace";
  // Dashboards
  if (p.includes("/dashboards") || p.includes("/reports") || p.includes("/analytics")) return "dashboards";
  // AI / Copilot
  if (p.includes("/ai/") || p.startsWith("/ai") || p.includes("/copilot") || p.includes("/assistant") || p.includes("/signals") || p.includes("/predict") || p.includes("/workflow")) return "ai";
  // Accounting + banking
  if (p.includes("/accounting") || p.includes("/journal") || p.includes("/account") || p.includes("/banking") || p.includes("/sepa") || p.includes("/csb") || p.includes("/fiscal") || p.includes("/exchange") || p.includes("/year-end") || p.includes("/cost")) return "accounting";
  // Comunicación
  if (p.includes("/email") || p.includes("/whatsapp") || p.includes("/sms") || p.includes("/message") || p.includes("/conversation") || p.includes("/notification") || p.includes("/magic-link")) return "communications";
  // Configuración
  if (p.includes("/configuration") || p.includes("/settings") || p.includes("/setup") || p.includes("/department") || p.includes("/property") || p.includes("/staff") || p.includes("/role") || p.includes("/integration") || p.includes("/module") || p.includes("/asset") || p.includes("/space") || p.includes("/template") || p.includes("/onboarding")) return "configuration";
  if (p.includes("/webhook") || p.includes("/event-type")) return "webhooks";
  if (p.includes("/search") || p.includes("/index")) return "search";
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// Diccionario de segmentos (qa#17). Los valores llevan el artículo definido y el
// sustantivo en singular («la reserva»); el plural se deriva (pluralizePhrase).
// Un artículo plural («los ajustes») marca un sustantivo sin singular.
// ─────────────────────────────────────────────────────────────────────────────

/** Recursos enumerables: GET sin parámetro → «Listar <plural>.»; con parámetro → «Obtener el detalle de <singular>.». */
export const SEGMENT_LABELS: Record<string, string> = {
  // PMS
  reservations: "la reserva",
  rooms: "la habitación",
  "room-types": "el tipo de habitación",
  "room-features": "la característica de habitación",
  "bed-types": "el tipo de cama",
  "room-blocks": "el bloqueo de habitaciones",
  "room-mappings": "la correspondencia de habitaciones",
  guests: "el huésped",
  profiles: "el perfil",
  folios: "el folio",
  invoices: "la factura",
  rectifications: "la rectificación",
  payments: "el pago",
  "payment-links": "el enlace de pago",
  "payment-intents": "la intención de pago",
  "payment-tokens": "el token de pago",
  lines: "la línea",
  groups: "el grupo",
  "event-spaces": "el espacio para eventos",
  allotments: "el cupo",
  "cancellation-policies": "la política de cancelación",
  "tour-operators": "el turoperador",
  contracts: "el contrato",
  // FIX-1 · F10: fichas de personal «/payroll/staff-profiles».
  "staff-profiles": "la ficha de personal",
  upsells: "la venta adicional",
  "upsell-offers": "la oferta de venta adicional",
  "service-requests": "la solicitud de servicio",
  conversations: "la conversación",
  messages: "el mensaje",
  inbound: "el correo entrante",
  connections: "la conexión",
  "source-connections": "la conexión de origen",
  notifications: "la notificación",
  templates: "la plantilla",
  "category-templates": "la plantilla de categoría",
  documents: "el documento",
  files: "el fichero",
  // Documentos y digitalización (Tanda T9): GET …/documents/:id/pages/:n/image.
  pages: "la página",
  // Documentos y digitalización (Tanda T9 · ola 3): recepciones de mercancía (goods-receipts.routes.ts)
  // y valija (workflow.routes.ts: POST …/documents/dispatch-batches, …/:batchId/receive).
  "goods-receipts": "la recepción de mercancía",
  "dispatch-batches": "la valija",
  media: "el archivo multimedia",
  duplicates: "el duplicado",
  // Establecimiento y estructura
  properties: "la propiedad",
  buildings: "el edificio",
  floors: "la planta",
  zones: "la zona",
  spaces: "el espacio",
  "map-positions": "la posición en el mapa",
  departments: "el departamento",
  "legal-entities": "la sociedad",
  installations: "la instalación",
  series: "la serie",
  modules: "el módulo",
  integrations: "la integración",
  providers: "el proveedor de servicio",
  dependencies: "la dependencia",
  users: "el usuario",
  roles: "el rol",
  permissions: "el permiso",
  invitations: "la invitación",
  sessions: "la sesión",
  apps: "la aplicación",
  applications: "la solicitud",
  scopes: "el ámbito de permiso",
  listings: "la ficha del marketplace",
  tenants: "la organización cliente",
  "custom-fields": "el campo personalizado",
  "category-options": "la opción de categoría",
  options: "la opción",
  forms: "el formulario",
  presets: "el ajuste predefinido",
  versions: "la versión",
  "saved-views": "la vista guardada",
  // Operaciones
  tasks: "la tarea",
  incidents: "la incidencia",
  "work-orders": "la orden de trabajo",
  assets: "el activo",
  "fixed-assets": "el activo fijo",
  meters: "el contador",
  readings: "la lectura",
  "housekeeping-sections": "la sección de limpieza",
  "housekeeping-rules": "la regla de limpieza",
  "maintenance-areas": "el área de mantenimiento",
  "maintenance-rules": "la regla de mantenimiento",
  checks: "la comprobación",
  anomalies: "la anomalía",
  actions: "la acción",
  results: "el resultado",
  requests: "la solicitud",
  cases: "el caso",
  surveys: "la encuesta",
  reviews: "la reseña",
  review: "la revisión",
  // Reputación (Tanda T8): /reputation/properties/:propertyId/sources[/:id[/sync]].
  sources: "la fuente de reseñas",
  responses: "la respuesta",
  shifts: "el turno",
  absences: "la ausencia",
  slips: "la nómina",
  // F&B, compras e inventario
  outlets: "el punto de venta",
  "menu-items": "el artículo de la carta",
  recipes: "la receta",
  "menu-recipes": "la receta de la carta",
  tickets: "el tique",
  "cash-closures": "el cierre de caja",
  "inventory-items": "el artículo de inventario",
  "stock-locations": "la ubicación de existencias",
  "stock-movements": "el movimiento de existencias",
  "stock-counts": "el recuento de existencias",
  "stock-balances": "el saldo de existencias",
  "purchase-orders": "el pedido de compra",
  suppliers: "el proveedor",
  "supplier-bills": "la factura de proveedor",
  "supplier-payments": "el pago a proveedor",
  items: "el elemento",
  // Contabilidad y finanzas
  accounts: "la cuenta",
  "journal-entries": "el asiento contable",
  "fiscal-periods": "el periodo fiscal",
  "fiscal-years": "el ejercicio fiscal",
  periods: "el periodo",
  expenses: "el gasto",
  accruals: "el devengo",
  "depreciation-runs": "la ejecución de amortización",
  "capex-projects": "el proyecto de inversión",
  projects: "el proyecto",
  remittances: "la remesa",
  statements: "el extracto",
  "exchange-rates": "el tipo de cambio",
  "cost-imports": "la importación de costes",
  // Sage 200 (Tanda 7c): lotes de importación contable «/accounting/ledger-imports*».
  "ledger-imports": "la importación contable",
  // FIX-1 · F11: directorio de terceros «GET /accounting/ledger-imports/third-parties».
  "third-parties": "el tercero",
  imports: "la importación",
  "gestoria-exports": "la exportación para la gestoría",
  // FIX-1 · F5: «GET /reports/exports/:exportId/download» (Centro de informes sin almacenamiento de objetos).
  exports: "la exportación",
  formats: "el formato",
  "vat-books": "el libro de IVA",
  models: "el modelo",
  taxes: "el impuesto",
  rates: "la tarifa",
  // Revenue y canales
  "rate-plans": "el plan de tarifas",
  "pricing-rules": "la regla de precios",
  "automation-rules": "la regla de automatización",
  "routing-rules": "la regla de enrutamiento",
  rules: "la regla",
  recommendations: "la recomendación",
  suggestions: "la sugerencia",
  // Cocoa 22 · ola 11 · R6: recursos que aún se colaban en inglés como padre o recurso previo de una acción.
  "bank-lines": "la línea bancaria",
  commissions: "la comisión",
  "mobile-keys": "la llave móvil",
  chain: "la cadena de TicketBAI",
  "folio-lines": "la línea de folio",
  batches: "el lote",
  confirmations: "la confirmación",
  "mapping-suggestions": "la sugerencia de correspondencia",
  scenarios: "el escenario",
  forecasts: "la previsión",
  "bar-levels": "el nivel BAR",
  segments: "el segmento",
  "market-segments": "el segmento de mercado",
  competitors: "el competidor",
  "parity-alerts": "la alerta de paridad",
  alerts: "la alerta",
  channels: "el canal",
  "product-mappings": "la correspondencia de productos",
  "rate-mappings": "la correspondencia de tarifas",
  mappings: "la correspondencia",
  "sync-jobs": "el trabajo de sincronización",
  // Tanda L2 (corrector): GET /admin/worker/job-runs (worker_job_runs).
  "job-runs": "la ejecución de trabajo programado",
  deliveries: "la entrega",
  subscriptions: "la suscripción",
  "event-types": "el tipo de evento",
  events: "el evento",
  "audit-events": "el evento de auditoría",
  campaigns: "la campaña",
  opportunities: "la oportunidad",
  programs: "el programa",
  memberships: "la membresía",
  "qr-codes": "el código QR",
  // Cumplimiento
  submissions: "el envío",
  "guest-register-records": "el registro de viajero",
  policies: "la política",
  evaluations: "la evaluación",
  territories: "el territorio",
  "offline-sync-records": "el registro de sincronización sin conexión",
  // IA y desarrollo
  tools: "la herramienta",
  "tool-calls": "la llamada a herramienta",
  calls: "la llamada",
  prompts: "la instrucción de IA",
  runs: "la ejecución",
  drafts: "el borrador",
  "extracted-entities": "la entidad extraída",
  facets: "la faceta",
  metrics: "la métrica",
  indicators: "el indicador",
  reports: "el informe",
  snapshots: "la instantánea",
  charts: "el gráfico",
  kpis: "el KPI",
  categories: "la categoría",
  webhooks: "el webhook",
  "labor-forecast": "la previsión de personal",
  "labor-costs": "el coste de personal",
  // OPERA Cloud modo sombra (Tanda 7b): un lote de ingresos por (hotel, business date).
  revenue: "el lote de ingresos diarios",
  // RBAC por departamento (Tanda 8a · corrector): asignaciones, grupos, aprobaciones, PIN y emergencia.
  assignments: "la asignación de rol",
  "property-groups": "el grupo de hoteles",
  approvals: "la solicitud de aprobación",
  "supervisor-authorizations": "la autorización de supervisor",
  "break-glass": "la sesión de emergencia",
  "rate-changes": "el cambio de tarifa",
  adjustments: "el ajuste",
  // Check-in automatizado (Tanda CHK): llegadas del día y kioscos de autoservicio.
  arrivals: "la llegada",
  kiosks: "el kiosco",
  // Asignación explicable (Tanda CHK · W3-B · pms/room-assignment.routes.ts): sugerencias del motor y habitaciones comunicadas.
  "assignment-suggestions": "la sugerencia de asignación",
  "room-connections": "la conexión de habitaciones (comunicadas o contiguas)"
};

/** Recursos únicos (sin colección): GET → «Obtener <label>.», PUT → «Sustituir <label>.». */
export const SINGLETON_LABELS: Record<string, string> = {
  settings: "los ajustes",
  // Check-in automatizado (Tanda CHK): «/properties/:propertyId/check-in/policy».
  policy: "la política de check-in en línea",
  // Check-in automatizado (Tanda CHK · W3-A): «/guest-portal/check-in/otp/request» y «…/otp/verify».
  otp: "el código de un solo uso (OTP)",
  // Tanda CHK · W4-D (routes/webhooks-whatsapp.routes.ts): «/webhooks/whatsapp» es público (sin JWT).
  whatsapp: "el webhook de WhatsApp",
  // OPERA Cloud modo sombra (Tanda 7b): «/integrations/pms-shadow/ingest» y «…/pms-shadow/reconciliation».
  "pms-shadow": "el modo sombra OPERA",
  reconciliation: "la conciliación diaria",
  // Cocoa 22 · ola 11 · R6: segmentos que aún se colaban en inglés como recurso previo de una acción.
  usali: "el informe USALI",
  tbai: "la factura a TicketBAI",
  csb43: "el extracto CSB43",
  iban: "el IBAN",
  "room-walk": "el recorrido de habitaciones",
  "export-center": "la exportación",
  email: "el correo",
  parity: "la paridad de tarifas",
  "property-map": "el mapa de la propiedad",
  offline: "los cambios sin conexión",
  mapper: "el mapeador",
  "vat-settings": "los ajustes del IVA",
  "property-settings": "los ajustes del establecimiento",
  "housekeeping-settings": "los ajustes de limpieza",
  "maintenance-settings": "los ajustes de mantenimiento",
  "billing-settings": "los ajustes de facturación",
  "accounting-settings": "los ajustes de contabilidad",
  "compliance-settings": "los ajustes de cumplimiento",
  "ai-settings": "los ajustes de IA",
  config: "la configuración",
  configuration: "la configuración",
  "manual-setup": "la configuración manual",
  setup: "la configuración inicial",
  preferences: "las preferencias",
  credentials: "las credenciales",
  status: "el estado",
  "sync-status": "el estado de sincronización",
  "reconciliation-status": "el estado de conciliación",
  "psp-status": "el estado de la pasarela de pago",
  "email-status": "el estado del correo",
  "housekeeping-status": "el estado de limpieza",
  health: "el estado de salud",
  readiness: "la preparación",
  "readiness-v2": "la preparación (versión 2)",
  summary: "el resumen",
  "cash-summary": "el resumen de caja",
  "pickup-summary": "el resumen de captación",
  dashboard: "el panel",
  "owner-dashboard": "el panel del propietario",
  overview: "la visión general",
  "property-overview": "la visión general del establecimiento",
  report: "el informe",
  "cost-report": "el informe de costes",
  stats: "las estadísticas",
  "template-stats": "las estadísticas de plantillas",
  "period-metrics": "las métricas del periodo",
  balance: "el saldo",
  "trial-balance": "el balance de sumas y saldos",
  "balance-sheet": "el balance de situación",
  "cash-flow": "el estado de flujos de efectivo",
  pnl: "la cuenta de resultados",
  pyg: "la cuenta de pérdidas y ganancias",
  ecpn: "el estado de cambios en el patrimonio neto",
  memoria: "la memoria",
  "annual-accounts": "las cuentas anuales",
  ledger: "el libro mayor",
  journal: "el diario contable",
  "rate-journal": "el diario de tarifas",
  chart: "el plan de cuentas",
  allocation: "la asignación contable",
  aging: "el vencimiento de saldos",
  position: "la posición",
  "finance-position": "la posición financiera",
  receivables: "las cuentas a cobrar",
  payables: "las cuentas a pagar",
  "vat-settlement": "la liquidación del IVA",
  regime: "el régimen",
  budget: "el presupuesto",
  forecast: "la previsión",
  "history-forecast": "la previsión histórica",
  "forecast-accuracy": "la precisión de la previsión",
  displacement: "el análisis de desplazamiento",
  pace: "el ritmo de reservas",
  pickup: "la captación",
  "by-segment": "el desglose por segmento",
  "by-property": "el desglose por establecimiento",
  coverage: "la cobertura",
  "product-coverage": "la cobertura de productos",
  "mapping-coverage": "la cobertura de correspondencias",
  "channel-performance": "el rendimiento por canal",
  "channel-profitability": "la rentabilidad por canal",
  "room-profitability": "la rentabilidad por habitación",
  "rate-grid": "la rejilla de tarifas",
  "demand-calendar": "el calendario de demanda",
  calendar: "el calendario",
  schedule: "la planificación",
  "time-clock": "el registro horario",
  board: "el tablero",
  timeline: "la cronología",
  activity: "la actividad",
  audit: "la auditoría",
  "audit-log": "el registro de auditoría",
  integrity: "la comprobación de integridad",
  diff: "la comparación de versiones",
  catalog: "el catálogo",
  structure: "la estructura",
  "asset-register": "el registro de activos",
  capex: "la inversión",
  cost: "el coste",
  inventory: "el panel de inventario",
  stock: "las existencias",
  "low-stock": "las existencias bajas",
  usage: "el uso",
  queue: "la cola",
  // Documentos y digitalización (Tanda T9): GET …/documents/:id/file y …/pages/:n/image.
  file: "el fichero original",
  image: "la imagen",
  // Documentos y digitalización (Tanda T9 · ola 3): GET …/documents/dispatch-batches/:batchId/sheet (una hoja por valija).
  sheet: "la hoja de remesa",
  "human-review": "la revisión humana",
  "human-review-queue": "la cola de revisión humana",
  "data-quality": "la calidad de datos",
  "dry-run-result": "el resultado de la simulación",
  "cutover-plan": "el plan de corte",
  inbox: "la bandeja de entrada",
  attachment: "el adjunto",
  photo: "la foto",
  pdf: "el PDF",
  // Sage 200 (Tanda 7c): «/accounting/ledger-imports/{account-map,analytics-map}» y «…/reconciliation/:id/csv».
  "account-map": "el mapa de cuentas",
  "analytics-map": "el mapa analítico",
  csv: "el CSV",
  "openapi.yaml": "la especificación OpenAPI",
  "api-reference": "la referencia del API",
  evidence: "la evidencia",
  "inspection-folder": "la carpeta de inspección",
  "meeting-pack": "el dosier de reunión",
  variance: "la desviación",
  establishment: "el establecimiento",
  "guest-register": "el registro de viajeros",
  "verifactu-scope": "el alcance de VeriFactu",
  verifactu: "el registro VeriFactu",
  "cancellation-charge": "el cargo de cancelación",
  remaining: "el importe pendiente",
  "remaining-for-day": "el importe pendiente del día",
  // RBAC por departamento (Tanda 8a · corrector): «/rbac/thresholds», «/rbac/pin», «/rbac/access-log».
  rbac: "el control de acceso",
  thresholds: "los umbrales de aprobación",
  pin: "el PIN de supervisor",
  "access-log": "el registro de accesos",
  folio: "el folio",
  "master-folio": "el folio maestro",
  invoice: "la factura",
  "invoice-branding": "la imagen de marca de las facturas",
  reservation: "la reserva",
  "service-request": "la solicitud de servicio",
  session: "la sesión",
  me: "el usuario actual",
  security: "la seguridad",
  "password-policy": "la política de contraseñas",
  challenge: "el desafío MFA",
  mfa: "el código MFA",
  "tourist-tax": "la tasa turística",
  esrs: "el informe ESRS",
  analytics: "la analítica",
  "rooming-list": "la lista de ocupantes (rooming list)",
  template: "la plantilla",
  "business-date": "la fecha de negocio",
  return: "el retorno del pago",
  "authorize-url": "la URL de autorización",
  "wallet-pass": "el pase de cartera digital",
  loyalty: "la fidelización",
  billing: "la facturación",
  profile: "el perfil",
  center: "el centro",
  assistant: "el asistente",
  chat: "la conversación con el asistente",
  search: "la búsqueda",
  "_sandbox": "el entorno de pruebas",
  configured: "las propiedades configuradas",
  sellable: "la venta de la habitación",
  recent: "los elementos recientes",
  map: "el mapa",
  "go-live": "la salida en vivo",
  "modelo-111": "el modelo 111",
  "modelo-115": "el modelo 115",
  "modelo-180": "el modelo 180",
  "modelo-303": "el modelo 303",
  "modelo-390": "el modelo 390",
  // Paneles por rol (/dashboards/*)
  "front-desk": "el panel de recepción",
  "front-desk-queue": "la cola de recepción",
  "room-rack": "el rack de habitaciones",
  housekeeping: "el panel de limpieza",
  "housekeeping-mobile": "el panel móvil de limpieza",
  maintenance: "el panel de mantenimiento",
  "maintenance-mobile": "el panel móvil de mantenimiento",
  "shift-manager": "el panel del jefe de turno",
  "general-manager": "el panel de dirección",
  "operations-director": "el panel del director de operaciones",
  concierge: "el panel de conserjería",
  reputation: "el panel de reputación",
  "sales-pipeline": "el embudo de ventas",
  workforce: "el panel de personal",
  crm: "el panel de CRM",
  quality: "el panel de calidad",
  safety: "el panel de seguridad",
  procurement: "el panel de compras",
  "groups-events": "el panel de grupos y eventos",
  pos: "el panel del TPV",
  energy: "el panel de energía",
  sustainability: "el panel de sostenibilidad",
  "analytics-center": "el centro de analítica",
  portfolio: "el panel de cartera"
};

/**
 * Acciones (normalmente POST …/:id/<acción>). Un infinitivo se compone con el
 * recurso anterior («Aprobar la solicitud.»); una frase que termina en punto
 * se usa tal cual.
 */
export const ACTION_LABELS: Record<string, string> = {
  apply: "Aplicar",
  approve: "Aprobar",
  cancel: "Cancelar",
  confirm: "Confirmar", // Tanda L6a: POST /ai/tool-calls/:id/confirm
  reject: "Rechazar",
  // RBAC por departamento (Tanda 8a · corrector): anulación de tique, solicitudes maker/checker.
  void: "Anular",
  "cancel-request": "Solicitar la anulación de",
  "refund-requests": "Solicitar la devolución de",
  retry: "Reintentar",
  export: "Exportar",
  import: "Importar",
  "import-csv": "Importar un fichero CSV.",
  reverse: "Revertir",
  reclassify: "Reclasificar", // FIX-1 · F2: POST /fiscal/vat-books/reclassify
  revert: "Revertir",
  deactivate: "Desactivar",
  disable: "Desactivar",
  enable: "Activar",
  reactivate: "Reactivar",
  test: "Probar",
  "test-connection": "Probar la conexión.",
  close: "Cerrar",
  reopen: "Reabrir",
  generate: "Generar",
  post: "Contabilizar",
  pay: "Pagar",
  refund: "Reembolsar",
  issue: "Emitir",
  rectify: "Rectificar",
  split: "Dividir",
  transfer: "Transferir",
  download: "Descargar",
  verify: "Verificar",
  validate: "Validar",
  sync: "Sincronizar",
  enqueue: "Encolar",
  submit: "Enviar",
  revoke: "Revocar",
  extract: "Extraer los datos de",
  merge: "Fusionar",
  assign: "Asignar",
  connect: "Conectar",
  match: "Conciliar",
  reconcile: "Conciliar",
  "auto-match": "Conciliar automáticamente.",
  "auto-reconcile": "Conciliar automáticamente.",
  sign: "Firmar",
  correct: "Corregir",
  accrue: "Devengar",
  settle: "Liquidar",
  compare: "Comparar",
  compute: "Calcular",
  calculate: "Calcular",
  recalculate: "Recalcular",
  "recalculate-health": "Recalcular el estado de salud.",
  simulate: "Simular",
  poll: "Sondear",
  check: "Comprobar",
  classify: "Clasificar",
  analyze: "Analizar",
  parse: "Interpretar",
  "ai-parse": "Interpretar con IA.",
  "ai-draft": "Redactar un borrador con IA.",
  "ai-draft-response": "Generar una respuesta con IA.",
  // Reputación (Tanda T8): POST /reputation/reviews/:id/draft y …/quality-case.
  draft: "Redactar un borrador de respuesta a",
  "quality-case": "Abrir un caso de calidad desde",
  // Documentos y digitalización (Tanda T9): transiciones del centro, POST …/documents/:id/send-to-office | recapture.
  "send-to-office": "Enviar el documento a la oficina.",
  recapture: "Recapturar el documento devuelto al centro (fichero nuevo, mismo número de registro).",
  // Documentos y digitalización (Tanda T9 · ola 3): POST …/goods-receipts/:id/dispute.
  dispute: "Poner en disputa",
  // Documentos y digitalización (Tanda T9 · ola 4): retención del archivo, POST …/documents/:id/block | unblock | purge (documents.admin).
  block: "Bloquear el documento por retención (solo lectura; opcionalmente con retención legal).",
  unblock: "Desbloquear el documento retenido.",
  purge: "Purgar el documento bloqueado (borrado definitivo del fichero; 409 con retención legal).",
  query: "Consultar",
  edit: "Editar",
  publish: "Publicar",
  push: "Publicar en el canal",
  archive: "Archivar",
  reorder: "Reordenar",
  commit: "Confirmar",
  execute: "Ejecutar",
  undo: "Deshacer",
  rebuild: "Reconstruir",
  receive: "Recibir",
  purchase: "Comprar",
  respond: "Responder a",
  review: "Revisar",
  escalate: "Escalar",
  dispatch: "Despachar",
  capture: "Capturar",
  provision: "Provisionar",
  annul: "Anular",
  return: "Devolver",
  acknowledge: "Confirmar la recepción de",
  active: "Activar o desactivar",
  bulk: "Procesar en bloque",
  "bulk-update": "Actualizar en bloque.",
  "dry-run": "Simular sin aplicar cambios.",
  seed: "Cargar datos de ejemplo.",
  "seed-defaults": "Cargar los valores por defecto.",
  "release-expired": "Liberar los cupos vencidos.",
  "release-unsold": "Liberar las habitaciones no vendidas.",
  "reset-password": "Restablecer la contraseña.",
  "forgot-password": "Solicitar el restablecimiento de la contraseña.",
  "change-password": "Cambiar la contraseña.",
  login: "Iniciar sesión.",
  "accept-invite": "Aceptar la invitación.",
  "reissue-invite": "Reenviar la invitación.",
  invite: "Invitar a un usuario.",
  bootstrap: "Inicializar la organización.",
  "register-device": "Registrar el dispositivo.",
  authorize: "Autorizar la aplicación (OAuth2).",
  token: "Emitir el token OAuth2.",
  challenge: "Iniciar el desafío MFA.",
  callback: "Procesar la respuesta de OAuth.",
  read: "Marcar como leída.",
  "generate-blueprint": "Generar el plano de migración.",
  "generate-mappings": "Generar las correspondencias.",
  "suggest-mapping": "Sugerir la correspondencia.",
  "suggest-categories": "Sugerir categorías.",
  "apply-preview": "Previsualizar la aplicación de cambios.",
  rollback: "Deshacer la migración.",
  "migrate-legacy": "Migrar los datos heredados.",
  "pull-reservations": "Traer las reservas del canal al buzón de reservas externas (no crea reservas; en modo de pruebas vienen del simulador).",
  "push-rates": "Publicar las tarifas en el canal.",
  "push-availability": "Publicar la disponibilidad en el canal.",
  "push-restrictions": "Publicar las restricciones en el canal.",
  ingest: "Cargar los datos de",
  "ingest-all": "Cargar los datos de todos los canales.",
  shop: "Consultar las tarifas de la competencia.",
  rederive: "Recalcular las tarifas derivadas.",
  drain: "Vaciar la cola.",
  replay: "Reprocesar los asientos.",
  "clock-in": "Fichar la entrada.",
  "clock-out": "Fichar la salida.",
  "sign-in": "Registrar la entrada.",
  "sign-out": "Registrar la salida.",
  "create-reservations": "Crear las reservas del grupo.",
  "generate-beo": "Generar la orden de evento (BEO).",
  "invoice-request": "Solicitar la factura.",
  "pre-check-in": "Realizar el registro previo a la llegada.",
  quote: "Calcular la cotización.",
  "move-charges": "Mover los cargos.",
  "mark-paid": "Marcar como pagada.",
  "mark-clean": "Marcar como limpia.",
  "mark-inspected": "Marcar como inspeccionada.",
  "mark-identity-verified": "Marcar la identidad como verificada.",
  "mark-manually-uploaded": "Marcar como subido manualmente.",
  "send-email": "Enviar por correo electrónico.",
  "block-room": "Bloquear la habitación.",
  "extract-dates": "Extraer las fechas.",
  "apply-cancellation-fee": "Aplicar la tarifa de cancelación.",
  "apply-no-show-fee": "Aplicar la tarifa de no presentado.",
  "queue-submission": "Encolar el envío.",
  "queue-ses": "Encolar el envío a SES.HOSPEDAJES.",
  "temporary-scan": "Registrar un escaneo temporal.",
  "discard-event": "Descartar el evento.",
  "fulfill-dsar": "Atender la solicitud de acceso a datos (RGPD).",
  "execute-erasure": "Ejecutar el borrado de datos (RGPD).",
  "pii-backfill": "Cifrar los datos personales pendientes.",
  "check-in-from-scan": "Hacer check-in desde el escaneo.",
  "scan-id-document": "Escanear el documento de identidad.",
  dispose: "Dar de baja el activo.",
  ask: "Preguntar al asistente.",
  chat: "Conversar con el asistente.",
  search: "Buscar.",
  photo: "Subir una foto.",
  invoice: "Emitir la factura.",
  sellable: "Cambiar si la habitación es vendible.",
  "go-live": "Aprobar la salida en vivo.",
  "master-folio": "Abrir el folio maestro.",
  // Check-in automatizado (Tanda CHK · modules/checkin/checkin.routes.ts).
  mrz: "Leer la zona MRZ del documento de identidad de",
  complete: "Completar el check-in en línea del huésped.",
  claim: "Emparejar el kiosco con su código de 8 dígitos y obtener el token del dispositivo.",
  resend: "Reenviar la invitación de",
  pair: "Generar el código de emparejamiento de",
  // Tanda CHK · W3-A: captura, firma, pago, OTP y llegada del huésped («/guest-portal/check-in/…»).
  document: "Capturar el documento de identidad de",
  signature: "Registrar la firma de",
  request: "Solicitar",
  "payment-link": "Generar el enlace de pago del saldo o depósito del check-in en línea (sin PSP: se cobra en recepción).",
  arrive: "Registrar la llegada del huésped (móvil o kiosco) y completar el check-in en línea.",
  // Tanda CHK · corrector (REV3-04): recepción resuelve la derivación (handed_off) y reabre la sesión.
  "resolve-handoff": "Resolver la derivación a recepción de la sesión de check-in en línea (vuelve a lista para llegar o en curso)."
};

/** Segmentos que delimitan el alcance («/properties/:propertyId/…») y no describen el recurso. */
const SCOPE_SEGMENTS = new Set(["properties", "organizations", "tenants", "backoffice", "admin", "property", "organization"]);

const PREPOSITIONS = new Set(["de", "del", "a", "al", "en", "por", "para", "con", "sin", "y", "e", "o"]);
const PLURAL_EXCEPTIONS: Record<string, string> = { orden: "órdenes", régimen: "regímenes", resumen: "resúmenes", KPI: "KPI", PDF: "PDF" };
const FEMININE_WITH_EL = new Set(["área", "agua", "aula", "alta"]);

function pluralizeWord(word: string): string {
  const fixed = PLURAL_EXCEPTIONS[word];
  if (fixed) return fixed;
  if (/^[A-Z0-9.]+$/.test(word) || /\d$/.test(word) || word.startsWith("(")) return word;
  if (/[aeiouáéó]$/.test(word)) return `${word}s`;
  if (/[íú]$/.test(word)) return `${word}es`;
  if (/z$/.test(word)) return `${word.slice(0, -1)}ces`;
  const accented = word.match(/^(.*)([áéíóú])(n|s)$/);
  if (accented) {
    const plain: Record<string, string> = { á: "a", é: "e", í: "i", ó: "o", ú: "u" };
    // «almacén» → «almacenes», «interés» → «intereses»; «país» → «países» conserva la tilde.
    const keep = accented[2] === "í" || accented[2] === "ú";
    return `${accented[1]}${keep ? accented[2] : plain[accented[2]!]}${accented[3]}es`;
  }
  if (/s$/.test(word)) return word; // «crisis», «lunes»
  return `${word}es`;
}

/** «la orden de trabajo» → «las órdenes de trabajo»; «el campo personalizado» → «los campos personalizados». */
export function pluralizePhrase(label: string): string {
  const words = label.split(" ");
  const article = words[0]!;
  if (article === "los" || article === "las") return label;
  const noun = words[1] ?? "";
  const feminine = article === "la" || FEMININE_WITH_EL.has(noun);
  const out: string[] = [feminine ? "las" : "los"];
  let stop = false;
  for (const word of words.slice(1)) {
    if (stop || PREPOSITIONS.has(word)) {
      stop = true;
      out.push(word);
    } else {
      out.push(pluralizeWord(word));
    }
  }
  return out.join(" ");
}

/** Sustantivo sin artículo: «la reserva» → «reserva». */
function bare(label: string): string {
  return label.replace(/^(el|la|los|las) /, "");
}

/** Artículo indefinido: «la reserva» → «una reserva»; «el área» → «un área». */
function indefinite(label: string): string {
  const [article, ...rest] = label.split(" ");
  if (article === "los" || article === "las") return label;
  return `${article === "la" && !FEMININE_WITH_EL.has(rest[0] ?? "") ? "una" : "un"} ${rest.join(" ")}`;
}

/** «de» + sintagma con contracción: «de el folio» → «del folio». */
function ofPhrase(label: string): string {
  return label.startsWith("el ") ? `del ${label.slice(3)}` : `de ${label}`;
}

function humanizeRaw(segment: string): string {
  return segment.replace(/-/g, " ");
}

type Resource = { singular: string; plural: string; singleton: boolean; translated: boolean };

/** Etiqueta de un segmento de ruta (nunca un parámetro). */
export function resourceLabel(segment: string): Resource {
  const singleton = SINGLETON_LABELS[segment];
  if (singleton) return { singular: singleton, plural: singleton, singleton: true, translated: true };
  const countable = SEGMENT_LABELS[segment];
  if (countable) return { singular: countable, plural: pluralizePhrase(countable), singleton: false, translated: true };
  if (segment.endsWith("-settings")) {
    const owner = resourceLabel(segment.slice(0, -"-settings".length));
    const label = `los ajustes ${owner.translated ? ofPhrase(owner.singular) : `de ${humanizeRaw(segment.slice(0, -"-settings".length))}`}`;
    return { singular: label, plural: label, singleton: true, translated: owner.translated };
  }
  const raw = humanizeRaw(segment);
  return { singular: raw, plural: raw, singleton: false, translated: false };
}

function isParam(segment: string | undefined): segment is string {
  return typeof segment === "string" && segment.startsWith(":");
}

/**
 * Recurso padre de un segmento en la posición `index` («/reservations/:id/folio»
 * → «la reserva»). Se omite el alcance («/properties/:propertyId/…»).
 */
function parentLabel(parts: string[], index: number): string | null {
  if (index < 2 || !isParam(parts[index - 1])) return null;
  const parent = parts[index - 2]!;
  if (isParam(parent) || SCOPE_SEGMENTS.has(parent)) return null;
  const label = resourceLabel(parent);
  return label.singular;
}

/** «Cargar los datos de» + «el canal» → «Cargar los datos del canal». */
function joinAction(action: string, target: string): string {
  return action.endsWith(" de") ? `${action.slice(0, -3)} ${ofPhrase(target)}` : `${action} ${target}`;
}

function withParent(sentence: string, parent: string | null): string {
  return parent ? `${sentence} ${ofPhrase(parent)}` : sentence;
}

/**
 * Descripción en español de un endpoint del manifest. Exportada (y no llamada
 * `describe`) para que los tests la importen sin chocar con node:test.
 *
 *   describeEndpoint("GET", "/reservations")              → «Listar reservas.»
 *   describeEndpoint("GET", "/reservations/:id")          → «Obtener el detalle de la reserva.»
 *   describeEndpoint("PUT", "/fiscal/vat-settings")        → «Sustituir los ajustes del IVA.»
 *   describeEndpoint("POST", "/reservations/:id/cancel")   → «Cancelar la reserva (aplica política de cancelación).»
 */
export function describeEndpoint(method: string, path: string): string {
  const parts = path.split("/").filter(Boolean);
  const verb = method.toUpperCase();
  const lastIndex = parts.length - 1;
  const last = parts[lastIndex] ?? path;

  // Acciones específicas con frase propia.
  // Check-in automatizado (Tanda CHK): la sesión del portal del huésped no es el check-in de la
  // reserva, y «POST …/check-in/sessions» invita a la reserva (crea la sesión y envía el enlace).
  if (last === "check-in" && parts[0] === "guest-portal") {
    return verb === "PATCH"
      ? "Actualizar la sesión de check-in en línea del huésped (hora de llegada, preferencias y consentimiento)."
      : "Obtener la sesión de check-in en línea del huésped.";
  }
  if (last === "sessions" && parts[lastIndex - 1] === "check-in" && verb === "POST") return "Invitar a la reserva al check-in en línea (crea la sesión y envía el enlace).";
  // Tanda CHK · W3-A (checkin.routes.ts): vista y pasos de recepción sobre la reserva («/reservations/:id/check-in[/<paso>]»).
  if (parts[0] === "reservations" && parts[2] === "check-in" && parts.length <= 4) {
    if (verb === "GET" && parts.length === 3) return "Obtener el estado del check-in de la reserva (sesión, viajeros, capturas y firmas sin datos personales).";
    if (last === "scan") return "Escanear el documento de identidad de un viajero en recepción (MRZ o visión).";
    if (last === "signature") return "Registrar la firma del viajero en recepción.";
    if (last === "verify-identity") return "Marcar la identidad del viajero como verificada en recepción.";
    if (last === "complete") return "Completar el check-in de la reserva desde recepción (habitación, check-in anticipado y motivo de excepción).";
  }
  // Tanda CHK · W3-B (room-assignment.routes.ts): «POST …/assignment-suggestions» ejecuta el motor explicable.
  if (verb === "POST" && last === "assignment-suggestions" && parts[0] === "reservations") return "Generar la sugerencia de asignación de habitación de la reserva (motor explicable, con motivo).";
  // Tanda CHK · W4-D (routes/webhooks-whatsapp.routes.ts): GET verifica la suscripción en Meta y POST recibe los mensajes para el bot del huésped.
  if (last === "whatsapp" && parts[lastIndex - 1] === "webhooks") {
    return verb === "GET"
      ? "Verificar la suscripción del webhook de WhatsApp (reto de Meta: responde hub.challenge)."
      : "Recibir los mensajes entrantes de WhatsApp (firma HMAC de Meta; se entregan al bot del huésped).";
  }
  if (last === "check-in") return "Hacer check-in de la reserva.";
  if (last === "check-out") return "Hacer check-out de la reserva (cierra el folio y crea la tarea de limpieza de salida).";
  if (last === "assign-room") return "Asignar o reasignar habitación a la reserva.";
  if (last === "cancel" && parts[lastIndex - 2] === "reservations") return "Cancelar la reserva (aplica política de cancelación).";
  if (last === "no-show") return "Marcar la reserva como no presentado.";
  if (last === "resolve") return "Marcar como resuelto y cerrar.";
  if (last === "transition") return "Cambiar estado siguiendo el flujo permitido.";
  if (last === "preflight") return "Pre-chequeo de bloqueos antes del cierre del día.";
  if (last === "run") return "Ejecutar el proceso.";
  if (last === "preview") return "Vista previa sin persistir.";
  // Sage 200 (Tanda 7c): la reconciliación contable no es la conciliación diaria de OPERA.
  if (last === "reconciliation" && parts[lastIndex - 1] === "ledger-imports") {
    return verb === "POST" ? "Reconciliar el diario con el balance de sumas y saldos de Sage 200." : "Listar las reconciliaciones contables.";
  }
  if (last === "csv" && parts[lastIndex - 2] === "reconciliation") return "Descargar el CSV de la reconciliación contable.";
  if (isParam(last) && parts[lastIndex - 1] === "reconciliation" && parts[lastIndex - 2] === "ledger-imports") {
    return "Obtener el detalle de la reconciliación contable.";
  }
  // RBAC por departamento (Tanda 8a · corrector): la asignación se revoca (no se borra) y la emergencia se abre.
  if (verb === "DELETE" && isParam(last) && parts[lastIndex - 1] === "assignments" && parts[lastIndex - 2] === "rbac") return "Revocar la asignación de rol (con motivo).";
  if (verb === "POST" && last === "break-glass" && parts[lastIndex - 1] === "rbac") return "Abrir una sesión de emergencia auditada.";
  if (last === "rotate-secret") return "Rotar el secreto OAuth2 de la aplicación de desarrollador.";
  if (last === "install") return "Instalar la aplicación del marketplace en una propiedad.";
  if (last === "uninstall") return "Desinstalar la aplicación del marketplace.";
  // Cocoa 22 · ola 11 · R6: DELETE sobre una conciliación la deshace (no «Conciliar»); «/ai/analyze» analiza el proyecto con IA.
  if (verb === "DELETE" && (last === "match" || last === "reconcile")) return `${withParent("Deshacer la conciliación", parentLabel(parts, lastIndex))}.`;
  if (last === "analyze" && parts[lastIndex - 1] === "ai") return "Analizar el proyecto con IA.";
  // Tanda CIERRE-1 (webhooks.service.ts deleteSubscription): el borrado de la suscripción arrastra sus entregas
  // (webhook_deliveries, sin cascade en el esquema) en la misma transacción y la respuesta añade `deliveriesDeleted`.
  // Caso fijo: la regla genérica de DELETE sobre «/…/:id» («Eliminar <recurso>.») no cambia para el resto de rutas.
  if (verb === "DELETE" && isParam(last) && parts[lastIndex - 1] === "subscriptions" && parts[lastIndex - 2] === "webhooks") {
    return "Eliminar la suscripción y sus entregas (webhook_deliveries); responde { ok, id, deliveriesDeleted }.";
  }

  // Parámetro final: describe el recurso anterior en singular («/reservations/:id»).
  if (isParam(last)) {
    const resourceIndex = lastIndex - 1;
    const resourceSegment = resourceIndex >= 0 ? parts[resourceIndex]! : "";
    const resource = resourceSegment && !isParam(resourceSegment) ? resourceLabel(resourceSegment) : null;
    const parent = resourceIndex >= 0 ? parentLabel(parts, resourceIndex) : null;
    const target = resource ? resource.singular : "el recurso";
    if (verb === "GET") return `${withParent(resource?.singleton ? `Obtener ${target}` : `Obtener el detalle ${ofPhrase(target)}`, parent)}.`;
    if (verb === "PATCH") return `${withParent(`Actualizar ${target}`, parent)}.`;
    if (verb === "PUT") return `${withParent(`Sustituir ${target}`, parent)}.`;
    if (verb === "DELETE") return `${withParent(`Eliminar ${target}`, parent)}.`;
    if (verb === "POST") return `${withParent(`Guardar ${target}`, parent)}.`;
    return `${withParent(`Operar sobre ${target}`, parent)}.`;
  }

  const parent = parentLabel(parts, lastIndex);
  const action = ACTION_LABELS[last];
  const resource = resourceLabel(last);

  // Acción (POST …/:id/<acción>); en GET el recurso gana si existe («/…/map»).
  if (action && (verb !== "GET" || !resource.translated)) {
    if (action.endsWith(".")) return action;
    if (parent) return `${joinAction(action, parent)}.`;
    const previous = lastIndex >= 1 ? parts[lastIndex - 1]! : "";
    if (previous && !isParam(previous) && !SCOPE_SEGMENTS.has(previous)) {
      const previousLabel = resourceLabel(previous);
      return `${joinAction(action, previousLabel.plural)}.`;
    }
    return `${action}.`;
  }

  // CRUD genérico por método + recurso.
  if (verb === "GET") {
    if (resource.singleton) return `${withParent(`Obtener ${resource.singular}`, parent)}.`;
    return `${withParent(`Listar ${resource.translated ? bare(resource.plural) : resource.plural}`, parent)}.`;
  }
  if (verb === "POST") {
    if (resource.singleton) return `${withParent(`Guardar ${resource.singular}`, parent)}.`;
    return `${withParent(`Crear o registrar ${resource.translated ? indefinite(resource.singular) : resource.plural}`, parent)}.`;
  }
  if (verb === "PATCH") return `${withParent(`Actualizar ${resource.singleton ? resource.singular : resource.plural}`, parent)}.`;
  if (verb === "PUT") return `${withParent(`Sustituir ${resource.singleton ? resource.singular : resource.plural}`, parent)}.`;
  if (verb === "DELETE") return `${withParent(`Eliminar ${resource.singleton ? resource.singular : resource.plural}`, parent)}.`;
  return `${withParent(`Operar sobre ${resource.singular}`, parent)}.`;
}

export function buildApiReference(): ApiReferenceResult {
  const endpoints: ApiEndpointRef[] = (routePermissionManifest as ApiRoutePermission[]).map((r) => ({
    method: r.method,
    path: r.path,
    category: categorize(r.path),
    permissions: [...r.permissions],
    riskLevel: r.riskLevel,
    description: describeEndpoint(r.method, r.path)
  }));

  // Agrupa por categoría preservando orden CATEGORY_META.
  const groups: ApiCategoryGroup[] = (Object.keys(CATEGORY_META) as ApiCategory[]).map((category) => {
    const list = endpoints.filter((e) => e.category === category);
    list.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
    return {
      category,
      label: CATEGORY_META[category].label,
      description: CATEGORY_META[category].description,
      endpoints: list
    };
  }).filter((g) => g.endpoints.length > 0);

  const byMethod = { GET: 0, POST: 0, PATCH: 0, DELETE: 0, PUT: 0 };
  const byRisk = { public: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const e of endpoints) {
    if (e.method in byMethod) (byMethod as Record<string, number>)[e.method]++;
    if (e.riskLevel in byRisk) (byRisk as Record<string, number>)[e.riskLevel]++;
  }
  const publicEndpoints = endpoints.filter((e) => e.permissions.length === 0).length;

  return {
    generatedAt: new Date().toISOString(),
    manifestVersion: 1,
    totalEndpoints: endpoints.length,
    publicEndpoints,
    byMethod,
    byRisk,
    categories: groups
  };
}
