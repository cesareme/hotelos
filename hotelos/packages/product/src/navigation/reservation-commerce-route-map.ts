// Reservation, billing and reporting flows (Tanda 5 · L1a): each flow names
// the canonical screen of the Tanda 5 tree (`screen`) and its URL (`url`); the
// legacy `/backoffice/*` `adminPath` was retired in L1c (the router redirects
// old paths through NAV_TREE.legacyRoutes). Labels and input names are Spanish
// (they are shown to hoteliers); codes stay stable for the demo and the
// contract tests.

export type ReservationCommerceArea = "reservations" | "billing" | "reports";

export type ReservationCommerceRouteItem = {
  code: string;
  area: ReservationCommerceArea;
  label: string;
  description: string;
  /** Tanda 5 URL of the screen. */
  url: string;
  mobileRoute?: string;
  /** Canonical SCREEN_COMPONENTS key. */
  screen: string;
  permission: string;
  apiEndpoint: string;
  saveEndpoint?: string;
  targetTables: string[];
  inputCategories: string[];
  requiredInputs: string[];
  requiresConfirmation?: boolean;
  reportFormats?: Array<"pdf" | "csv" | "xlsx" | "json">;
  status: "ready" | "needs_setup" | "coming_soon";
};

export const RESERVATION_COMMERCE_ROUTES: ReservationCommerceRouteItem[] = [
  {
    code: "reservation_workspace",
    area: "reservations",
    label: "Reservas",
    description: "Buscar, filtrar y abrir reservas con el contexto de huésped, recorrido, folio, cumplimiento y acciones.",
    url: "/recepcion/reservas",
    mobileRoute: "Reservations",
    screen: "ReservationWorkspace",
    permission: "pms.reservation.read",
    apiEndpoint: "/properties/:propertyId/reservations",
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios"],
    inputCategories: ["Estado de la reserva", "Categoría de canal", "Segmento de mercado", "Segmento de huésped", "Estado de facturación"],
    requiredInputs: ["Fechas de estancia", "Huésped o reservante", "Tipo de habitación o recurso", "Estado de la reserva"],
    status: "ready"
  },
  {
    code: "reservation_create",
    area: "reservations",
    label: "Nueva reserva",
    description: "Crear reservas directas, de OTA, de empresa, de grupo, de uso diurno o de recurso desde la cotización hasta la confirmación.",
    url: "/recepcion/reservas/nueva",
    mobileRoute: "CreateReservation",
    screen: "ReservationCreate",
    permission: "pms.reservation.create",
    apiEndpoint: "/properties/:propertyId/availability/quote",
    saveEndpoint: "/properties/:propertyId/reservations",
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios", "audit_events"],
    inputCategories: [
      "Origen de la reserva",
      "Segmento de mercado",
      "Datos del huésped",
      "Fechas de estancia",
      "Tipo de habitación o recurso",
      "Plan de tarifas",
      "Política de garantía",
      "Instrucción de facturación"
    ],
    requiredInputs: ["Fecha de llegada", "Fecha de salida", "Adultos", "Tipo de habitación", "Nombre del huésped principal", "Apellidos del huésped principal"],
    requiresConfirmation: true,
    status: "ready"
  },
  {
    code: "reservation_detail",
    area: "reservations",
    label: "Detalle de la reserva",
    description: "Asignar habitación o recurso, hacer check-in y check-out, mover, cancelar, marcar no presentado y ver folio, factura y auditoría.",
    url: "/recepcion/reservas/:id",
    mobileRoute: "ReservationDetail",
    screen: "ReservationDetailWorkspace",
    permission: "pms.reservation.read",
    apiEndpoint: "/reservations/:id",
    saveEndpoint: "/reservations/:id",
    targetTables: ["reservations", "reservation_resources", "stays", "folios", "folio_lines", "payments", "guest_register_records"],
    inputCategories: ["Recorrido del huésped", "Asignación de habitación o recurso", "Pagos", "Cumplimiento", "Estado de la factura"],
    requiredInputs: ["Identificador de la reserva"],
    status: "ready"
  },
  {
    code: "reservation_categories",
    area: "reservations",
    label: "Categorías de reserva",
    description: "Configurar códigos de origen, segmentos de mercado, políticas de garantía, políticas de cancelación e instrucciones de facturación.",
    url: "/configuracion/propiedad/categorias",
    mobileRoute: "CategoryManagerPreview",
    screen: "CategoryManagerScreen",
    permission: "categories.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/configuration/categories",
    saveEndpoint: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options",
    targetTables: ["category_definitions", "property_category_options", "property_custom_field_definitions"],
    inputCategories: ["Origen de la reserva", "Segmento de mercado", "Política de cancelación", "Tipo de garantía", "Instrucción de facturación"],
    requiredInputs: ["Código de la opción", "Etiqueta de la opción", "Modo", "Estado activo"],
    status: "ready"
  },
  {
    code: "folio_billing",
    area: "billing",
    label: "Facturación y cobros",
    description: "Anotar cargos, registrar cobros, cerrar folios y preparar borradores de factura a partir de los saldos de la reserva.",
    url: "/finanzas/facturacion",
    mobileRoute: "GuestFolio",
    screen: "BillingCenter",
    permission: "billing.compliance.view",
    apiEndpoint: "/reservations/:id/folio",
    saveEndpoint: "/folios/:id/lines",
    targetTables: ["folios", "folio_lines", "payments", "invoices"],
    inputCategories: ["Categoría del cargo", "Método de pago", "Código de impuesto", "Tipo de factura", "Centro de coste"],
    requiredInputs: ["Folio", "Importe del cargo o del cobro", "Código de impuesto de los cargos"],
    requiresConfirmation: true,
    status: "ready"
  },
  {
    code: "invoice_lifecycle",
    area: "billing",
    label: "Ciclo de la factura",
    description: "Crear borradores, emitir facturas, anular facturas emitidas y crear rectificativas con flujos conformes a la normativa.",
    url: "/finanzas/facturacion",
    mobileRoute: "Invoices",
    screen: "BillingCenter",
    permission: "invoice.issue",
    apiEndpoint: "/properties/:propertyId/invoices",
    saveEndpoint: "/invoices/drafts",
    targetTables: ["invoices", "invoice_lines", "invoice_sequences", "audit_events"],
    inputCategories: ["Serie de facturación", "Tipo de factura", "Tipo de cliente", "Identidad fiscal", "Estado VeriFactu"],
    requiredInputs: ["Tipo de factura", "Tipo de cliente", "Total", "Total de impuestos"],
    requiresConfirmation: true,
    status: "ready"
  },
  {
    code: "reporting_center",
    area: "reports",
    label: "Centro de informes",
    description: "Informes operativos, de reservas, de facturación, de revenue y del propietario con datos listos para exportar.",
    url: "/informes",
    mobileRoute: "Reports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/catalog",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["reservations", "folios", "payments", "invoices", "revenue_daily_snapshots", "audit_events"],
    inputCategories: ["Tipo de informe", "Rango de fechas", "Granularidad", "Canal", "Segmento", "Formato de exportación"],
    requiredInputs: ["Tipo de informe", "Fecha desde", "Fecha hasta"],
    reportFormats: ["pdf", "csv", "xlsx", "json"],
    status: "ready"
  },
  {
    code: "reservation_reports",
    area: "reports",
    label: "Informes de reservas",
    description: "Llegadas, salidas, cancelaciones, no presentados, pickup e informes por origen y segmento.",
    url: "/informes",
    mobileRoute: "ReservationReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/reservations",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["reservations", "reservation_guests", "rooms", "room_types"],
    inputCategories: ["Rango de llegadas", "Rango de salidas", "Estado de la reserva", "Canal", "Segmento de mercado", "Tipo de habitación"],
    requiredInputs: ["Fecha desde", "Fecha hasta"],
    reportFormats: ["pdf", "csv", "xlsx", "json"],
    status: "ready"
  },
  {
    code: "billing_reports",
    area: "reports",
    label: "Informes de facturación",
    description: "Informes de facturas, cobros, saldos de folio, impuestos y auditoría de exportaciones.",
    url: "/informes",
    mobileRoute: "BillingReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/billing",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["folios", "folio_lines", "payments", "invoices", "invoice_lines"],
    inputCategories: ["Estado de la factura", "Método de pago", "Código de impuesto", "Tipo de cliente", "Formato de exportación"],
    requiredInputs: ["Fecha desde", "Fecha hasta"],
    reportFormats: ["pdf", "csv", "xlsx", "json"],
    status: "ready"
  }
];

export function listReservationCommerceRoutes(area?: ReservationCommerceArea) {
  return area ? RESERVATION_COMMERCE_ROUTES.filter((route) => route.area === area) : RESERVATION_COMMERCE_ROUTES;
}

export function getReservationCommerceRoute(code: string) {
  return RESERVATION_COMMERCE_ROUTES.find((route) => route.code === code);
}
