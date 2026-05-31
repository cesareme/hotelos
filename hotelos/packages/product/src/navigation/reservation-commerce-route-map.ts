export type ReservationCommerceArea = "reservations" | "billing" | "reports";

export type ReservationCommerceRouteItem = {
  code: string;
  area: ReservationCommerceArea;
  label: string;
  description: string;
  adminPath: string;
  mobileRoute?: string;
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
    label: "Reservations Workspace",
    description: "Search, filter and open reservations with guest, journey, folio, compliance and action context.",
    adminPath: "/backoffice/reservations",
    mobileRoute: "Reservations",
    screen: "ReservationWorkspace",
    permission: "pms.reservation.read",
    apiEndpoint: "/properties/:propertyId/reservations",
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios"],
    inputCategories: ["Reservation status", "Channel category", "Market segment", "Guest segment", "Billing status"],
    requiredInputs: ["Stay dates", "Guest or booker", "Room type or resource", "Reservation status"],
    status: "ready"
  },
  {
    code: "reservation_create",
    area: "reservations",
    label: "Create Reservation",
    description: "Create direct, OTA, corporate, group, day-use or resource reservations from availability quote to confirmation.",
    adminPath: "/backoffice/reservations/new",
    mobileRoute: "CreateReservation",
    screen: "ReservationCreate",
    permission: "pms.reservation.create",
    apiEndpoint: "/properties/:propertyId/availability/quote",
    saveEndpoint: "/properties/:propertyId/reservations",
    targetTables: ["reservations", "reservation_guests", "reservation_resources", "folios", "audit_events"],
    inputCategories: [
      "Reservation source",
      "Market segment",
      "Guest details",
      "Stay dates",
      "Room/resource type",
      "Rate plan",
      "Guarantee policy",
      "Billing instruction"
    ],
    requiredInputs: ["Arrival date", "Departure date", "Adults", "Room type", "Primary guest first name", "Primary guest surname"],
    requiresConfirmation: true,
    status: "ready"
  },
  {
    code: "reservation_detail",
    area: "reservations",
    label: "Reservation Detail",
    description: "Manage room/resource assignment, check-in/out, move, cancel, no-show, folio, invoice and audit trail.",
    adminPath: "/backoffice/reservations/:reservationId",
    mobileRoute: "ReservationDetail",
    screen: "ReservationDetailWorkspace",
    permission: "pms.reservation.read",
    apiEndpoint: "/reservations/:id",
    saveEndpoint: "/reservations/:id",
    targetTables: ["reservations", "reservation_resources", "stays", "folios", "folio_lines", "payments", "guest_register_records"],
    inputCategories: ["Guest journey", "Room/resource assignment", "Payments", "Compliance", "Invoice status"],
    requiredInputs: ["Reservation id"],
    status: "ready"
  },
  {
    code: "reservation_categories",
    area: "reservations",
    label: "Reservation Categories",
    description: "Configure source codes, market segments, guarantee policies, cancellation policies and billing instructions.",
    adminPath: "/backoffice/configuration/categories",
    mobileRoute: "CategoryManagerPreview",
    screen: "CategoryManagerScreen",
    permission: "categories.manage",
    apiEndpoint: "/backoffice/properties/:propertyId/configuration/categories",
    saveEndpoint: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options",
    targetTables: ["category_definitions", "property_category_options", "property_custom_field_definitions"],
    inputCategories: ["Reservation source", "Market segment", "Cancellation policy", "Guarantee type", "Billing instruction"],
    requiredInputs: ["Option code", "Option label", "Mode", "Active state"],
    status: "ready"
  },
  {
    code: "folio_billing",
    area: "billing",
    label: "Folio Billing",
    description: "Post charges, capture payments, close folios and prepare invoice drafts from reservation balances.",
    adminPath: "/backoffice/billing/center",
    mobileRoute: "GuestFolio",
    screen: "BillingCenter",
    permission: "billing.compliance.view",
    apiEndpoint: "/reservations/:id/folio",
    saveEndpoint: "/folios/:id/lines",
    targetTables: ["folios", "folio_lines", "payments", "invoices"],
    inputCategories: ["Charge category", "Payment method", "Tax code", "Invoice type", "Cost center"],
    requiredInputs: ["Folio", "Charge or payment amount", "Tax code for charges"],
    requiresConfirmation: true,
    status: "ready"
  },
  {
    code: "invoice_lifecycle",
    area: "billing",
    label: "Invoice Lifecycle",
    description: "Create drafts, issue invoices, cancel issued invoices and create rectifying invoices through compliant workflows.",
    adminPath: "/backoffice/billing/invoices",
    mobileRoute: "Invoices",
    screen: "BillingCenter",
    permission: "invoice.issue",
    apiEndpoint: "/properties/:propertyId/invoices",
    saveEndpoint: "/invoices/drafts",
    targetTables: ["invoices", "invoice_lines", "invoice_sequences", "audit_events"],
    inputCategories: ["Invoice sequence", "Invoice type", "Customer type", "Tax identity", "VERI*FACTU status"],
    requiredInputs: ["Invoice type", "Customer type", "Total", "Tax total"],
    requiresConfirmation: true,
    status: "ready"
  },
  {
    code: "reporting_center",
    area: "reports",
    label: "Reporting Center",
    description: "Operational, reservation, billing, revenue and owner reports with export-ready data.",
    adminPath: "/backoffice/reports",
    mobileRoute: "Reports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/catalog",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["reservations", "folios", "payments", "invoices", "revenue_daily_snapshots", "audit_events"],
    inputCategories: ["Report type", "Date range", "Granularity", "Channel", "Segment", "Export format"],
    requiredInputs: ["Report type", "From date", "To date"],
    reportFormats: ["pdf", "csv", "xlsx", "json"],
    status: "ready"
  },
  {
    code: "reservation_reports",
    area: "reports",
    label: "Reservation Reports",
    description: "Arrivals, departures, cancellations, no-shows, pickup and source/segment reports.",
    adminPath: "/backoffice/reports/reservations",
    mobileRoute: "ReservationReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/reservations",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["reservations", "reservation_guests", "rooms", "room_types"],
    inputCategories: ["Arrival range", "Departure range", "Reservation status", "Channel", "Market segment", "Room type"],
    requiredInputs: ["From date", "To date"],
    reportFormats: ["pdf", "csv", "xlsx", "json"],
    status: "ready"
  },
  {
    code: "billing_reports",
    area: "reports",
    label: "Billing Reports",
    description: "Invoice, payment, folio balance, tax and export audit reports.",
    adminPath: "/backoffice/reports/billing",
    mobileRoute: "BillingReports",
    screen: "ReportingCenter",
    permission: "analytics.read",
    apiEndpoint: "/reports/properties/:propertyId/billing",
    saveEndpoint: "/reports/properties/:propertyId/export",
    targetTables: ["folios", "folio_lines", "payments", "invoices", "invoice_lines"],
    inputCategories: ["Invoice status", "Payment method", "Tax code", "Customer type", "Export format"],
    requiredInputs: ["From date", "To date"],
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
