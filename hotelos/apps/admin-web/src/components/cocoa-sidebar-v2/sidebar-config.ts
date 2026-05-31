/**
 * Sidebar v2 navigation configuration.
 *
 * Eight-group taxonomy following the operational rhythm of a hotel:
 *
 *   home        → role-aware landing zone (always visible).
 *   frontdesk   → reception desk: reservations, check-in/out, guest journey.
 *   groups      → group bookings, allotments, events, sales pipeline.
 *   ops         → housekeeping, maintenance, workforce, safety.
 *   revenue     → revenue management, channel manager, rate plans, forecasts.
 *   finance     → billing, payments, accounting, payroll, tax filings.
 *   compliance  → guest register (SES.HOSPEDAJES), GDPR, audit log.
 *   admin       → users, roles, modules, integrations, developer portal.
 *
 * Each group declares which roles may see it via `rolesAllowed`. If omitted,
 * the group is visible to every role (used for `home`).
 *
 * Each item carries an `id`, a `label`, the target `screen` (matches existing
 * navigation screen identifiers) and an optional `shortcut` (keyboard hint
 * surfaced via the command palette / shortcut help). Shortcuts use the
 * portable `Mod` prefix which Cocoa keybinding helpers map to ⌘ on macOS and
 * Ctrl elsewhere.
 *
 * `defaultOpen` controls whether the group section starts expanded. The
 * `home` and `frontdesk` groups open by default to bias new sessions toward
 * the daily-driver surfaces.
 */

/** Role identifiers consumed by the v2 sidebar gating logic. */
export type SidebarRoleId =
  | "receptionist"
  | "housekeeper"
  | "maintenance"
  | "revenue_manager"
  | "accountant"
  | "manager"
  | "admin"
  | "owner"
  | "developer";

/** Identifier for a navigation group. Stable, used in storage + analytics. */
export type SidebarGroupId =
  | "home"
  | "frontdesk"
  | "groups"
  | "ops"
  | "revenue"
  | "finance"
  | "compliance"
  | "admin";

/** Leaf navigation entry. */
export interface SidebarItem {
  /** Stable id (kebab-case). Used for storage, analytics, search. */
  id: string;
  /** Human-readable label rendered in the sidebar. */
  label: string;
  /** Target screen identifier — matches existing `activeScreen` values. */
  screen: string;
  /**
   * Optional portable keyboard shortcut hint (e.g. `"Mod+K"`, `"Mod+Shift+N"`).
   * Rendered as a hint and registered with the keybinding manager when set.
   */
  shortcut?: string;
}

/** Top-level group rendered as a collapsible section in the sidebar. */
export interface SidebarGroup {
  /** Stable id (matches `SidebarGroupId`). */
  id: SidebarGroupId;
  /** Section heading label. */
  label: string;
  /** Leaf items in display order. */
  items: SidebarItem[];
  /**
   * Roles that may see this group. When omitted, the group is visible to all
   * roles (used for `home`). When set, gating is OR-semantics: the user only
   * needs to hold one of the listed roles.
   */
  rolesAllowed?: SidebarRoleId[];
  /** When true (default false), the group starts expanded on first render. */
  defaultOpen?: boolean;
}

// Role bundles — reused across multiple groups to keep the table readable.
const FRONTDESK_ROLES: SidebarRoleId[] = [
  "receptionist",
  "manager",
  "admin",
  "owner"
];

const OPS_ROLES: SidebarRoleId[] = [
  "housekeeper",
  "maintenance",
  "manager",
  "admin",
  "owner"
];

const REVENUE_ROLES: SidebarRoleId[] = [
  "revenue_manager",
  "manager",
  "admin",
  "owner"
];

const FINANCE_ROLES: SidebarRoleId[] = [
  "accountant",
  "manager",
  "admin",
  "owner"
];

const ADMIN_ROLES: SidebarRoleId[] = ["admin", "owner", "developer"];

/**
 * Sidebar v2 configuration — single source of truth for the new shell.
 *
 * Ordered top-down by daily-use frequency (home/frontdesk first, admin last)
 * to match how operators actually scan the rail.
 */
export const SIDEBAR_V2_CONFIG: SidebarGroup[] = [
  {
    id: "home",
    label: "Home",
    defaultOpen: true,
    items: [
      {
        id: "home-today",
        label: "Mi día",
        screen: "FrontDeskDashboard",
        shortcut: "Mod+1"
      },
      {
        id: "home-inbox",
        label: "Bandeja",
        screen: "ComplianceInbox",
        shortcut: "Mod+Shift+I"
      },
      {
        id: "home-assistant",
        label: "Asistente IA",
        screen: "AssistantChat",
        shortcut: "Mod+J"
      },
      // FIX: target renamed from GlobalSearch to (none) due to App.tsx route change
      // Item temporarily commented: no real "Buscar" screen is registered in
      // SCREEN_COMPONENTS. The Mod+K shortcut is meant to open a command-palette
      // search modal rather than route to a dedicated screen, so a navigation
      // item with screen: "GlobalSearch" produced a dead click.
      // {
      //   id: "home-search",
      //   label: "Buscar",
      //   screen: "GlobalSearch",
      //   shortcut: "Mod+K"
      // },
      {
        id: "home-personas",
        label: "Selector de personas",
        screen: "PersonaLandingScreen"
      }
    ]
  },
  {
    id: "frontdesk",
    label: "Front Desk",
    rolesAllowed: FRONTDESK_ROLES,
    defaultOpen: true,
    items: [
      {
        id: "frontdesk-copilot",
        label: "Copiloto de recepción",
        screen: "ReceptionCopilotScreen",
        shortcut: "Mod+Shift+C"
      },
      {
        id: "frontdesk-reservations",
        label: "Reservas",
        screen: "ReservationWorkspace",
        shortcut: "Mod+R"
      },
      {
        id: "frontdesk-new-reservation",
        label: "Nueva reserva",
        screen: "ReservationCreate",
        shortcut: "Mod+N"
      },
      {
        id: "frontdesk-room-rack",
        label: "Tablero de habitaciones",
        screen: "RoomRackScreen",
        shortcut: "Mod+Shift+R"
      },
      {
        id: "frontdesk-timeline",
        label: "Live Timeline",
        screen: "LiveTimelineWorkspace",
        shortcut: "Mod+L"
      },
      {
        id: "frontdesk-guests",
        label: "Huéspedes",
        screen: "GuestsList",
        shortcut: "Mod+G"
      },
      {
        id: "frontdesk-guest-journey",
        label: "Recorrido del huésped",
        screen: "GuestJourneyWorkspace"
      },
      {
        id: "frontdesk-night-audit",
        label: "Night audit",
        screen: "NightAuditScreen",
        shortcut: "Mod+Shift+A"
      },
      {
        id: "frontdesk-shift",
        label: "Supervisión del turno",
        screen: "ShiftManagerScreen"
      },
      {
        id: "frontdesk-concierge",
        label: "Concierge",
        screen: "ConciergeInboxDashboard"
      }
    ]
  },
  {
    id: "groups",
    label: "Groups & Sales",
    rolesAllowed: [
      "receptionist",
      "revenue_manager",
      "manager",
      "admin",
      "owner"
    ],
    items: [
      {
        id: "groups-dashboard",
        label: "Grupos y eventos",
        screen: "GroupsEventsDashboard",
        shortcut: "Mod+Shift+G"
      },
      {
        id: "groups-calendar",
        label: "Calendario de grupos",
        screen: "GroupsCalendarScreen"
      },
      {
        id: "groups-allotments",
        label: "Cupos (allotments)",
        screen: "Allotments"
      },
      {
        id: "groups-sales-pipeline",
        label: "Pipeline de ventas",
        screen: "SalesPipelineDashboard"
      },
      {
        id: "groups-event-spaces",
        label: "Espacios para eventos",
        screen: "EventSpacesSettings"
      },
      {
        id: "groups-crm",
        label: "CRM",
        screen: "CrmDashboard"
      }
    ]
  },
  {
    id: "ops",
    label: "Operations",
    rolesAllowed: OPS_ROLES,
    items: [
      {
        id: "ops-director",
        label: "Director de operaciones",
        screen: "OperationsDirectorScreen",
        shortcut: "Mod+Shift+O"
      },
      {
        id: "ops-housekeeping",
        label: "Tablero de pisos",
        screen: "HousekeepingDashboard",
        shortcut: "Mod+H"
      },
      {
        id: "ops-housekeeping-mobile",
        label: "Mi turno (HK móvil)",
        screen: "HousekeepingMobileScreen"
      },
      {
        id: "ops-maintenance",
        label: "Tablero de mantenimiento",
        screen: "MaintenanceDashboard",
        shortcut: "Mod+M"
      },
      {
        id: "ops-maintenance-mobile",
        label: "Mis averías (Mant. móvil)",
        screen: "MaintenanceMobileScreen"
      },
      {
        id: "ops-workforce",
        label: "Personal y turnos",
        screen: "WorkforceDashboard"
      },
      {
        id: "ops-safety",
        label: "Seguridad e incidentes",
        screen: "SafetyDashboard"
      },
      {
        id: "ops-fnb",
        label: "F&B / TPV",
        screen: "PosDashboard"
      },
      {
        id: "ops-procurement",
        label: "Compras y proveedores",
        screen: "ProcurementDashboard"
      },
      {
        id: "ops-inventory",
        label: "Inventario operativo",
        screen: "InventoryDashboard"
      },
      {
        id: "ops-energy",
        label: "Energía y agua",
        screen: "EnergyMetering"
      }
    ]
  },
  {
    id: "revenue",
    label: "Revenue",
    rolesAllowed: REVENUE_ROLES,
    items: [
      {
        id: "revenue-home",
        label: "Inicio de revenue",
        screen: "RevenueHomeDashboard",
        shortcut: "Mod+Shift+V"
      },
      {
        id: "revenue-meeting",
        label: "Reunión de revenue",
        screen: "RevenueMeeting"
      },
      {
        id: "revenue-history-forecast",
        label: "Histórico y previsión",
        screen: "RevenueHistoryForecastDashboard"
      },
      {
        id: "revenue-forecast-explorer",
        label: "Explorador de forecast",
        screen: "RevenueForecastExplorer"
      },
      {
        id: "revenue-demand-calendar",
        label: "Calendario de demanda",
        screen: "DemandCalendarAdmin"
      },
      {
        id: "revenue-rate-plans",
        label: "Planes tarifarios",
        screen: "RatePlans"
      },
      {
        id: "revenue-rate-grid",
        label: "Rejilla de tarifas",
        screen: "RevenueRules"
      },
      {
        id: "revenue-rate-shopper",
        label: "Rate shopper",
        screen: "RateShopperSettings"
      },
      {
        id: "revenue-channel-manager",
        label: "Channel Manager",
        screen: "ChannelManagerDashboard"
      },
      {
        id: "revenue-channel-performance",
        label: "Rendimiento de canales",
        screen: "ChannelPerformanceDashboard"
      },
      {
        id: "revenue-comparison",
        label: "Comparación de revenue",
        screen: "RevenueComparisonDashboard"
      },
      {
        id: "revenue-data-quality",
        label: "Calidad de datos",
        screen: "RevenueDataQuality"
      }
    ]
  },
  {
    id: "finance",
    label: "Finance",
    rolesAllowed: FINANCE_ROLES,
    items: [
      {
        id: "finance-fiscal",
        label: "Centro fiscal",
        screen: "FiscalDashboard",
        shortcut: "Mod+Shift+F"
      },
      {
        id: "finance-position",
        label: "Cobros · Pagos · Tesorería",
        screen: "FinancePositionDashboard"
      },
      {
        id: "finance-billing",
        label: "Facturación",
        screen: "BillingCenter",
        shortcut: "Mod+B"
      },
      {
        id: "finance-invoice-rectifications",
        label: "Facturas rectificativas",
        screen: "InvoiceRectificationsScreen"
      },
      {
        id: "finance-folio-routing",
        label: "Folios y enrutamiento",
        screen: "FolioRouting"
      },
      {
        id: "finance-payments",
        label: "Pagos",
        screen: "PaymentSettings"
      },
      {
        id: "finance-bank-reconciliation",
        label: "Conciliación bancaria",
        screen: "BankReconciliationScreen"
      },
      {
        id: "finance-trial-balance",
        label: "Balance de comprobación",
        screen: "TrialBalanceScreen"
      },
      {
        id: "finance-balance-sheet",
        label: "Balance de situación",
        screen: "BalanceSheetScreen"
      },
      {
        id: "finance-cash-flow",
        label: "Flujos de efectivo",
        screen: "CashFlowScreen"
      },
      {
        id: "finance-commissions",
        label: "Comisiones (OTA)",
        screen: "CommissionsScreen"
      },
      {
        id: "finance-payroll",
        label: "Nóminas",
        screen: "PayrollScreen"
      },
      {
        id: "finance-exchange-rates",
        label: "Tipos de cambio",
        screen: "ExchangeRatesScreen"
      },
      {
        id: "finance-year-end-close",
        label: "Cierre de ejercicio",
        screen: "YearEndCloseScreen"
      },
      {
        id: "finance-accounting",
        label: "Contabilidad",
        screen: "AccountingSettings"
      }
    ]
  },
  {
    id: "compliance",
    label: "Compliance",
    rolesAllowed: [
      "receptionist",
      "accountant",
      "manager",
      "admin",
      "owner"
    ],
    items: [
      {
        id: "compliance-inbox",
        label: "Bandeja de cumplimiento",
        screen: "ComplianceInbox"
      },
      {
        id: "compliance-center",
        label: "Centro de cumplimiento",
        screen: "ComplianceCenter"
      },
      {
        id: "compliance-guest-register",
        label: "Registro de huéspedes",
        screen: "GuestRegisterSettings"
      },
      {
        id: "compliance-ses-hospedajes",
        label: "SES.HOSPEDAJES",
        screen: "SesHospedajesSettings"
      },
      {
        id: "compliance-authority-routing",
        label: "Enrutamiento a autoridades",
        screen: "AuthorityRoutingSettings"
      },
      {
        id: "compliance-retention",
        label: "Retención del registro",
        screen: "GuestRegisterRetentionSettings"
      },
      {
        id: "compliance-gdpr",
        label: "Solicitudes RGPD",
        screen: "GdprRequestsScreen"
      },
      {
        id: "compliance-tax-settings",
        label: "Ajustes fiscales",
        screen: "TaxComplianceSettings"
      },
      {
        id: "compliance-tourist-tax",
        label: "Tasa turística (CCAA)",
        screen: "TouristTax"
      },
      {
        id: "compliance-aeat-models",
        label: "Modelos AEAT",
        screen: "FiscalSubmissionsCenter"
      },
      {
        id: "compliance-tbai-foral",
        label: "TicketBAI",
        screen: "TbaiForal"
      },
      {
        id: "compliance-esrs",
        label: "Informe CSRD (sostenibilidad)",
        screen: "EsrsReport"
      },
      {
        id: "compliance-audit-log",
        label: "Registro de auditoría",
        screen: "AuditLogViewer"
      }
    ]
  },
  {
    id: "admin",
    label: "Admin",
    rolesAllowed: ADMIN_ROLES,
    items: [
      {
        id: "admin-users",
        label: "Usuarios y roles",
        screen: "UserRoleManager",
        shortcut: "Mod+Shift+U"
      },
      {
        id: "admin-organization",
        label: "Organización",
        screen: "OrganizationSettings"
      },
      {
        id: "admin-property-settings",
        label: "Ajustes de la propiedad",
        screen: "PropertySettings"
      },
      {
        id: "admin-property-setup",
        label: "Configuración de propiedad",
        screen: "PropertySetupHomeScreen"
      },
      {
        id: "admin-configuration-center",
        label: "Centro de configuración",
        screen: "ConfigurationCenterScreen",
        shortcut: "Mod+,"
      },
      {
        id: "admin-categories",
        label: "Categorías",
        screen: "CategoryManagerScreen"
      },
      {
        id: "admin-custom-fields",
        label: "Campos personalizados",
        screen: "CustomFieldManagerScreen"
      },
      {
        id: "admin-modules",
        label: "Módulos",
        screen: "ModuleManager"
      },
      {
        id: "admin-module-health",
        label: "Salud de módulos",
        screen: "ModuleHealthCenter"
      },
      {
        id: "admin-marketplace",
        label: "Marketplace",
        screen: "IntegrationMarketplaceHome"
      },
      {
        id: "admin-integrations",
        label: "Integraciones",
        screen: "IntegrationManager"
      },
      {
        id: "admin-notifications",
        label: "Notificaciones",
        screen: "NotificationsScreen"
      },
      {
        id: "admin-ai-governance",
        label: "Gobernanza de IA",
        screen: "AiGovernanceScreen"
      },
      {
        id: "admin-ai-setup",
        label: "Configuración de IA",
        screen: "PropertyAiScreen"
      },
      {
        id: "admin-webhooks",
        label: "Webhooks",
        screen: "WebhooksAdmin"
      },
      {
        id: "admin-developer-portal",
        label: "Portal del desarrollador",
        screen: "DeveloperPortal"
      },
      {
        id: "admin-api-reference",
        label: "Referencia API",
        screen: "ApiReferenceScreen"
      }
    ]
  }
];

export default SIDEBAR_V2_CONFIG;
