import { useEffect, useState } from "react";
import { getModuleRouteItems } from "@hotelos/product";
import { getCurrentUserPermissions } from "../services/api-client";
import {
  PERSONA_ROLES,
  ROLES,
  getActiveRole,
  roleHome,
  setActiveRole,
  type Role
} from "./roles";

export type BackOfficeNavItem = {
  label: string;
  screen: string;
  /** Personas that should see this item. Omitted → inherits from subgroup/group. */
  roles?: Role[];
  /**
   * Marks items whose target screen is a `ModuleSettingsPlaceholder` (no real UI
   * yet). These are hidden from operational personas to avoid dead-end clicks,
   * and only shown in the "all" admin view.
   */
  placeholder?: boolean;
};

export type BackOfficeNavSection = {
  title: string;
  items: BackOfficeNavItem[];
};

export type BackOfficeNavSubgroup = {
  title: string;
  items: BackOfficeNavItem[];
  /** Like the group gate: subgroup only shown to users with one of these perms. */
  permissionsAny?: string[];
  /** Default personas for items in this subgroup (item.roles overrides). */
  roles?: Role[];
};

export type BackOfficeNavGroup = {
  title: string;
  badge?: string;
  items?: BackOfficeNavItem[];
  subgroups?: BackOfficeNavSubgroup[];
  /**
   * If set, the whole group is only shown to users holding AT LEAST ONE of these
   * permissions. Used to keep engineer-grade zones (e.g. AI Operations) out of a
   * receptionist's menu. Groups without this field are visible to everyone.
   */
  permissionsAny?: string[];
  /** Default personas for items in this group (subgroup/item roles override). */
  roles?: Role[];
};

// Role shorthands for tagging the nav tree below.
const R_RECEPTION: Role[] = ["reception"];
const R_OPS: Role[] = ["operations"];
const R_ASSET: Role[] = ["asset"];
const R_FRONT: Role[] = ["reception", "operations"];
const R_OPS_ASSET: Role[] = ["operations", "asset"];
const R_ASSET_OWNER: Role[] = ["asset", "owner"];
const R_MGMT: Role[] = ["operations", "asset", "owner"];
const R_ADMIN_ONLY: Role[] = []; // only the "all" admin view

const adminRouteScreenMap: Record<string, string> = {
  "/backoffice/setup": "SetupCenterScreen",
  "/backoffice/manual-setup": "ManualSetupHubScreen",
  "/backoffice/property-setup": "PropertySetupHomeScreen",
  "/backoffice/property-setup/property-profile": "PropertyProfileSetupForm",
  "/backoffice/property-setup/buildings": "BuildingSetupForm",
  "/backoffice/property-setup/floors": "FloorSetupForm",
  "/backoffice/property-setup/zones": "ZoneSetupForm",
  "/backoffice/property-setup/room-types": "RoomTypeSetupForm",
  "/backoffice/property-setup/rooms": "RoomSetupForm",
  "/backoffice/property-setup/spaces-resources": "SpaceResourceSetupForm",
  "/backoffice/property-setup/departments": "DepartmentSetupForm",
  "/backoffice/property-setup/operations": "HousekeepingSetupForm",
  "/backoffice/property-setup/maintenance": "MaintenanceSetupForm",
  "/backoffice/property-setup/revenue": "RevenueCategorySetupForm",
  "/backoffice/property-setup/finance-compliance": "FinanceComplianceSetupForm",
  "/backoffice/property-setup/ai": "AiPropertySetupForm",
  "/backoffice/property-setup/custom-fields": "CustomFieldSetupForm",
  "/backoffice/configuration": "ConfigurationCenterScreen",
  "/backoffice/configuration/property-profile": "ConfigurationCenterScreen",
  "/backoffice/configuration/categories": "CategoryManagerScreen",
  "/backoffice/configuration/categories/:categoryCode": "CategoryDetailScreen",
  "/backoffice/configuration/categories/:categoryCode/options/new": "CategoryOptionForm",
  "/backoffice/configuration/custom-fields": "CustomFieldManagerScreen",
  "/backoffice/configuration/rooms-room-types": "ConfigurationCenterScreen",
  "/backoffice/configuration/spaces-resources": "ConfigurationCenterScreen",
  "/backoffice/configuration/departments": "ConfigurationCenterScreen",
  "/backoffice/configuration/operations": "ConfigurationCenterScreen",
  "/backoffice/configuration/revenue": "ConfigurationCenterScreen",
  "/backoffice/configuration/finance": "ConfigurationCenterScreen",
  "/backoffice/configuration/compliance": "ConfigurationCenterScreen",
  "/backoffice/configuration/ai": "ConfigurationCenterScreen",
  "/backoffice/modules": "ModuleManager",
  "/backoffice/timeline": "LiveTimelineWorkspace",
  "/backoffice/rooms/rack": "RoomRackScreen",
  "/backoffice/housekeeping/mobile": "HousekeepingMobileScreen",
  "/backoffice/guests/timeline": "GuestTimelineScreen",
  "/backoffice/copilot": "FrontDeskCopilotScreen",
  "/backoffice/night-audit": "NightAuditScreen",
  "/backoffice/maintenance/mobile": "MaintenanceMobileScreen",
  "/backoffice/shift-manager": "ShiftManagerScreen",
  "/backoffice/gm": "GeneralManagerScreen",
  "/backoffice/operations-director": "OperationsDirectorScreen",
  "/backoffice/personas": "PersonaLandingScreen",
  "/backoffice/personas/guia": "PersonaGuideScreen",
  "/backoffice/reservations": "ReservationWorkspace",
  "/backoffice/reservations/new": "ReservationCreate",
  "/backoffice/reservations/:reservationId": "ReservationDetailWorkspace",
  "/backoffice/revenue": "RevenueHomeDashboard",
  "/backoffice/revenue/history-forecast": "RevenueHistoryForecastDashboard",
  "/backoffice/revenue/rate-plans": "RevenueSettings",
  "/backoffice/revenue/rate-grid": "RevenueRules",
  "/backoffice/revenue/recommendations": "RevenueRules",
  "/backoffice/revenue/forecast-explorer": "RevenueForecastExplorer",
  "/backoffice/revenue/demand-calendar": "DemandCalendarAdmin",
  "/backoffice/revenue/rate-shopper": "RateShopperSettings",
  "/backoffice/revenue/scenario-simulator": "RevenueAutomationRules",
  "/backoffice/revenue/settings": "RevenueSettings",
  "/backoffice/revenue/data-quality": "RevenueDataQuality",
  "/backoffice/channel-manager": "ChannelManagerDashboard",
  "/backoffice/channel-manager/channels": "ChannelManagerSettings",
  "/backoffice/channel-manager/mappings": "ChannelMappings",
  "/backoffice/channel-manager/sync-health": "ChannelManagerSettings",
  "/backoffice/channel-manager/parity-alerts": "RateShopperSettings",
  "/backoffice/billing": "BillingSettings",
  "/backoffice/billing/center": "BillingCenter",
  "/backoffice/billing/invoices": "BillingCenter",
  "/backoffice/payments": "PaymentSettings",
  "/backoffice/accounting": "AccountingSettings",
  "/backoffice/tax-settings": "TaxComplianceSettings",
  "/backoffice/pos-outlets": "ModuleConfigurationCenter",
  "/backoffice/procurement-inventory": "InventorySettings",
  "/backoffice/assets-capex-energy": "ModuleConfigurationCenter",
  "/backoffice/workforce": "WorkforceSettings",
  "/backoffice/safety-incidents": "SafetySettings",
  "/backoffice/users-roles": "UserRoleManager",
  "/backoffice/compliance/spain-guest-register": "GuestRegisterSettings",
  "/backoffice/compliance/ses-hospedajes": "SesHospedajesSettings",
  "/backoffice/compliance/authority-routing": "AuthorityRoutingSettings",
  "/backoffice/compliance/guest-register-retention": "GuestRegisterRetentionSettings",
  "/backoffice/developer": "DeveloperPortal",
  "/backoffice/guest-journey": "GuestJourneyWorkspace",
  "/backoffice/guest-portal": "GuestPortalSettings",
  "/backoffice/concierge-messaging": "AIGovernanceSettings",
  "/backoffice/analytics-reporting": "AnalyticsSettings",
  "/backoffice/reports": "ReportingCenter",
  "/backoffice/reports/reservations": "ReportingCenter",
  "/backoffice/reports/billing": "ReportingCenter",
  "/backoffice/security": "UserRoleManager",
  "/backoffice/marketplace": "IntegrationMarketplaceHome",
  "/backoffice/ai-governance": "AIGovernanceSettings",
  "/backoffice/ai-setup": "AISetupCenter",
  "/backoffice/onboarding/projects": "OnboardingProjects",
  "/backoffice/onboarding/source-connections": "SourceConnections",
  "/backoffice/onboarding/import-review": "ImportReview",
  "/backoffice/onboarding/property-blueprint": "PropertyBlueprintReview",
  "/backoffice/onboarding/batches": "MigrationBatches",
  "/backoffice/onboarding/go-live": "OnboardingGoLiveReadiness",
  "/backoffice/onboarding/cutover": "CutoverAssistant"
};

const revenueNavigationItems: BackOfficeNavItem[] = getModuleRouteItems("revenue_profit_engine", "admin").map((route) => ({
  label: route.label,
  screen: adminRouteScreenMap[route.path ?? ""] ?? "RevenueHomeDashboard",
  roles: ["asset"] as Role[]
}));

const pmsNavigationItems: BackOfficeNavItem[] = getModuleRouteItems("pms_core", "admin").map((route) => ({
  label: route.label,
  screen: adminRouteScreenMap[route.path ?? ""] ?? "ReservationWorkspace",
  roles: ["reception", "operations"] as Role[]
}));

const channelManagerNavigationItems: BackOfficeNavItem[] = getModuleRouteItems("distribution_hub", "admin").map((route) => ({
  label: route.label,
  screen: adminRouteScreenMap[route.path ?? ""] ?? "ChannelManagerSettings",
  roles: ["operations", "asset"] as Role[]
}));

const billingNavigationItems: BackOfficeNavItem[] = getModuleRouteItems("compliance_billing", "admin").map((route) => ({
  label: route.label,
  screen: adminRouteScreenMap[route.path ?? ""] ?? "BillingCenter",
  roles: ["operations", "asset"] as Role[]
}));

const reportsNavigationItems: BackOfficeNavItem[] = getModuleRouteItems("hotel_intelligence_platform", "admin").map((route) => ({
  label: route.label,
  screen: adminRouteScreenMap[route.path ?? ""] ?? "ReportingCenter",
  roles: ["operations", "asset", "owner"] as Role[]
}));

function dedupe(items: BackOfficeNavItem[]): BackOfficeNavItem[] {
  // Dedupe by destination screen so that "Reservations" (auto from module routes)
  // and "Reservations workspace" (manual override) don't both appear. We keep
  // the FIRST occurrence — manual overrides are spread before auto items, so
  // the curated label/translation wins.
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.screen)) return false;
    seen.add(item.screen);
    return true;
  });
}

export const backOfficeNavigationGroups: BackOfficeNavGroup[] = [
  {
    title: "Operaciones",
    badge: "daily",
    items: [
      { label: "Copiloto de recepción", screen: "ReceptionCopilotScreen", roles: R_RECEPTION },
      { label: "Mi día (recepción)", screen: "FrontDeskDashboard", roles: R_RECEPTION },
      { label: "Mi día (operaciones)", screen: "OperationsHome", roles: R_OPS },
      { label: "Resumen del propietario", screen: "OwnerHome", roles: ["owner"] },
      { label: "Asistente IA (Ask Anfitorio)", screen: "AssistantChat", roles: R_MGMT },
      { label: "Copiloto operativo (IA)", screen: "FrontDeskCopilotScreen", roles: R_FRONT },
      { label: "Night audit (cierre del día)", screen: "NightAuditScreen", roles: R_FRONT },
      { label: "Supervisión del turno", screen: "ShiftManagerScreen", roles: R_FRONT },
      { label: "Dashboard del director (GM)", screen: "GeneralManagerScreen", roles: R_MGMT },
      { label: "Director de operaciones", screen: "OperationsDirectorScreen", roles: R_OPS },
      { label: "Selector de personas", screen: "PersonaLandingScreen" },
      { label: "📖 Guía de uso por persona", screen: "PersonaGuideScreen" },
      { label: "Tablero de habitaciones", screen: "RoomRackScreen", roles: R_FRONT },
      { label: "Live Timeline", screen: "LiveTimelineWorkspace", roles: R_FRONT },
      // NOTE: "Bandeja de cumplimiento" y "Centro de cumplimiento" migraron al
      // nuevo grupo top-level "Cumplimiento" (subgrupos Fiscal / ESG). Ya no se
      // listan aquí para evitar duplicados.
      { label: "Cartera (todas las propiedades)", screen: "PortfolioDashboard", roles: R_MGMT },
      // Per-property drill-down sibling to PortfolioDashboard. Lives at top
      // level so cluster directors can pin a single property's deep view.
      { label: "Detalle de propiedad (cartera)", screen: "PropertyDetailScreen", roles: R_MGMT }
    ],
    subgroups: [
      {
        title: "Reservas y huéspedes",
        roles: R_FRONT,
        items: dedupe([
          { label: "Espacio de reservas", screen: "ReservationWorkspace" },
          { label: "Lista de reservas", screen: "ReservationsListScreen", roles: R_MGMT },
          { label: "Crear reserva", screen: "ReservationCreate" },
          { label: "Agente de reservas (IA)", screen: "ReservationAgent" },
          { label: "Huéspedes", screen: "GuestsList" },
          { label: "Timeline del huésped", screen: "GuestTimelineScreen" },
          { label: "Recorrido del huésped", screen: "GuestJourneyWorkspace" },
          ...pmsNavigationItems
        ])
      },
      {
        title: "Tableros operativos",
        roles: R_OPS,
        items: [
          { label: "Mi turno (HK móvil)", screen: "HousekeepingMobileScreen" },
          { label: "Mis averías (Mant. móvil)", screen: "MaintenanceMobileScreen" },
          { label: "Tablero de pisos", screen: "HousekeepingDashboard" },
          { label: "Tablero de mantenimiento", screen: "MaintenanceDashboard" },
          { label: "Personal y turnos", screen: "WorkforceDashboard" },
          { label: "Seguridad e incidentes", screen: "SafetyDashboard" },
          { label: "Punto de venta (TPV)", screen: "PosDashboard" },
          // ----- Followups migrados desde whitelist (settings-hub) -----
          // Contadores energía/agua — operativa diaria de lecturas y umbrales.
          // TODO: mover a subgrupo Sostenibilidad cuando exista (hoy se anida
          // en Tableros operativos por proximidad funcional con HK/mant.).
          // TODO: mover a subgrupo Sostenibilidad cuando exista
          { label: "Contadores energía y agua", screen: "EnergyMetering", roles: R_OPS_ASSET },
          // Kiosco self check-in — configuración operativa del hardware de
          // recepción; encaja en tableros operativos junto a HK/mant.
          { label: "Kiosco self check-in", screen: "KioskSettingsReal", roles: R_OPS_ASSET }
        ]
      },
      {
        // Grupos & eventos — dedicated subgroup so the full suite (dashboard,
        // calendar, new-group/new-event/import-rooming dialogs, allotments and
        // events spaces) is discoverable instead of buried inside "Comercial".
        // The dashboard is the entry point: it hosts the dialogs directly via
        // hash deep-links (#nuevo-grupo, #nuevo-evento, #importar-rooming) so
        // sidebar clicks land on the right modal without router rewrites.
        title: "Grupos y eventos",
        roles: R_OPS_ASSET,
        items: [
          { label: "Dashboard de grupos", screen: "GroupsEventsDashboard" },
          { label: "Calendario de grupos", screen: "GroupsCalendarScreen" },
          { label: "Nuevo grupo", screen: "GroupsEventsDashboard#nuevo-grupo" },
          { label: "Nuevo evento", screen: "GroupsEventsDashboard#nuevo-evento" },
          { label: "Importar rooming list", screen: "GroupsEventsDashboard#importar-rooming" },
          { label: "Cupos / Allotments", screen: "Allotments" },
          { label: "Pipeline de ventas (B2B)", screen: "SalesPipelineDashboard" },
          { label: "Espacios para eventos", screen: "EventSpacesSettings" }
        ]
      },
      {
        title: "Comercial",
        roles: R_MGMT,
        items: dedupe([
          { label: "Channel Manager (agregador OTA)", screen: "ChannelAggregatorHub", roles: R_OPS_ASSET },
          { label: "Inicio de revenue", screen: "RevenueHomeDashboard", roles: R_MGMT },
          { label: "Panel de reunión de revenue", screen: "RevenueMeeting", roles: R_ASSET_OWNER },
          { label: "Histórico y previsión", screen: "RevenueHistoryForecastDashboard", roles: R_ASSET },
          // Static, owner-friendly version of the histórico/forecast dashboard
          // for board reviews — lives next to its interactive counterpart.
          { label: "Informe histórico/forecast (board)", screen: "RevenueHistoryForecastReport", roles: R_ASSET_OWNER },
          // Cross-period export pipeline for revenue snapshots; consumed by
          // accountants (R_ASSET) feeding external BI / month-end packs.
          { label: "Centro de exportaciones de revenue", screen: "RevenueExportCenter", roles: R_ASSET },
          { label: "Comparación de revenue", screen: "RevenueComparisonDashboard", roles: R_ASSET_OWNER },
          { label: "Rendimiento de canales", screen: "ChannelPerformanceDashboard", roles: R_OPS_ASSET },
          { label: "Rate shopper (comp-set)", screen: "RateShopperSettings", roles: R_ASSET },
          // Pipeline de ventas, Grupos y eventos, Calendario de grupos and
          // Allotments now live in the dedicated "Grupos y eventos" subgroup
          // above so the full suite is discoverable in one place.
          { label: "Planes tarifarios (BAR + variantes)", screen: "RatePlans", roles: R_MGMT },
          { label: "Editor de tarifas (Rate Grid)", screen: "RateGridEditorScreen", roles: R_ASSET_OWNER },
          { label: "Historial de tarifas", screen: "RateJournalScreen", roles: R_ASSET_OWNER },
          { label: "Políticas de cancelación", screen: "CancellationPolicies", roles: R_MGMT },
          { label: "Cartas de Restauración (F&B)", screen: "FnbMenu", roles: R_OPS_ASSET },
          { label: "Inventario F&B (stock + recetas)", screen: "FnbInventory", roles: R_OPS_ASSET },
          { label: "Tasa turística por CCAA", screen: "TouristTax", roles: R_MGMT },
          // ----- Followups migrados desde whitelist (settings-hub) -----
          // "Ajustes de IA" antes vivía aquí como atajo admin; tras consolidar
          // el bloque de IA queda visible como item de primer nivel en
          // "Operaciones de IA" para R_ASSET, así que se ha retirado de la
          // navegación comercial para evitar la entrada duplicada.
          // Banca España queda como atajo comercial para asset/owner que pilotan
          // tesorería desde el cuadro de mando de revenue. TBAI e Informes ESRS
          // han migrado al grupo top-level "Cumplimiento" (Fiscal / ESG) para
          // evitar duplicados.
          { label: "Banca España (CSB-43 + SEPA)", screen: "BankingSpain", roles: R_ASSET_OWNER }
        ])
      },
      {
        title: "Experiencia del huésped",
        roles: ["reception", "operations", "asset", "owner"],
        items: [
          { label: "Bandeja de concierge", screen: "ConciergeInboxDashboard", roles: R_FRONT },
          { label: "Reputación", screen: "ReputationDashboard", roles: R_MGMT },
          { label: "Upsells", screen: "UpsellsDashboard", roles: ["reception", "operations", "asset"] },
          { label: "Encuestas / NPS", screen: "SurveysDashboard", roles: R_MGMT },
          { label: "Casos de calidad", screen: "QualityDashboard", roles: R_OPS_ASSET },
          { label: "CRM", screen: "CrmDashboard", roles: R_OPS_ASSET },
          { label: "Fidelización", screen: "LoyaltyDashboard", roles: R_OPS_ASSET },
          // ----- Followups migrados desde whitelist (settings-hub) -----
          // Pantalla real de ajustes del portal del huésped (no el placeholder
          // del settings hub). Visible para operations/asset que pilotan la
          // experiencia digital.
          { label: "Portal del huésped (ajustes)", screen: "GuestPortalSettingsReal", roles: R_OPS_ASSET },
          // Segmentos CRM — destino real (componente GuestSegmentsScreen) que
          // los equipos de experiencia usan al diseñar campañas y journeys.
          { label: "Segmentos de huéspedes", screen: "GuestSegmentsReal", roles: R_OPS_ASSET },
          // Programa de fidelización — destino real, complementa el dashboard
          // "Fidelización" de arriba con la gestión de tiers y reglas.
          { label: "Programa de fidelización", screen: "LoyaltyProgram", roles: R_OPS_ASSET },
          // Casos de calidad — pantalla real de gestión de incidencias QA
          // separada del dashboard agregado "QualityDashboard".
          { label: "Casos de calidad", screen: "QualityCasesReal", roles: R_OPS_ASSET },
          // Encuestas NPS — destino real para configurar encuestas y revisar
          // resultados detallados (distinto del dashboard agregado).
          { label: "Encuestas NPS", screen: "SurveysNps", roles: R_OPS_ASSET },
          // Ajustes upsells — pantalla real, sustituye al placeholder del
          // settings hub para los equipos que mantienen el catálogo.
          { label: "Ajustes upsells", screen: "UpsellsSettings", roles: R_OPS_ASSET },
          // Campañas de marketing — destino real. TODO: mover a subgrupo
          // "Marketing" cuando exista (hoy se anida bajo Experiencia, que es
          // el grupo natural más cercano para CRM/campañas).
          // TODO: mover a subgrupo Marketing cuando exista
          { label: "Campañas de marketing", screen: "CampaignManagerReal", roles: R_OPS_ASSET }
        ]
      },
      {
        // NOTE: el bloque fiscal/compliance (Centro fiscal, Envíos fiscales,
        // Modelos AEAT 303/111/115/180/390, TicketBAI, Informe CSRD/ESRS) ha
        // migrado al grupo top-level "Cumplimiento" → subgrupos Fiscal / ESG
        // para consolidar la información regulatoria en un solo lugar. Aquí se
        // mantiene solo el bloque puramente financiero (tesorería, contabilidad,
        // nóminas, etc.).
        title: "Finanzas y fiscal",
        roles: R_MGMT,
        items: [
          { label: "Cobros · Pagos · Tesorería", screen: "FinancePositionDashboard", roles: R_ASSET_OWNER },
          { label: "Conciliación bancaria", screen: "BankReconciliationScreen", roles: R_ASSET },
          { label: "Balance de comprobación", screen: "TrialBalanceScreen", roles: R_ASSET },
          { label: "Balance de situación", screen: "BalanceSheetScreen", roles: R_ASSET_OWNER },
          { label: "Estado de flujos de efectivo", screen: "CashFlowScreen", roles: R_ASSET_OWNER },
          { label: "Comisiones (OTA)", screen: "CommissionsScreen", roles: R_OPS_ASSET },
          { label: "Nóminas", screen: "PayrollScreen", roles: R_OPS_ASSET },
          { label: "Tipos de cambio", screen: "ExchangeRatesScreen", roles: R_ASSET },
          { label: "Cierre de ejercicio", screen: "YearEndCloseScreen", roles: R_ASSET },
          { label: "Facturas rectificativas", screen: "InvoiceRectificationsScreen", roles: R_OPS_ASSET },
          { label: "Folios y enrutamiento", screen: "FolioRouting", roles: R_OPS_ASSET },
          { label: "Webhooks (developer)", screen: "WebhooksAdmin", roles: R_ASSET },
          { label: "Catálogo de upsells", screen: "UpsellsSettings", roles: R_OPS_ASSET },
          { label: "Mensajería omnichannel", screen: "MessagingConnections", roles: R_ASSET },
          { label: "Banca España (CSB-43 + SEPA)", screen: "BankingSpain", roles: R_ASSET },
          { label: "Marketplace de apps", screen: "MarketplaceCatalog", roles: R_MGMT },
          { label: "Mis apps (Developer)", screen: "DeveloperApps", roles: R_ASSET },
          { label: "Referencia API (pública)", screen: "ApiReferenceScreen", roles: R_ASSET },
          { label: "CRM · Segmentos", screen: "GuestSegmentsReal", roles: R_OPS_ASSET },
          { label: "Programa de fidelización", screen: "LoyaltyProgram", roles: R_OPS_ASSET },
          { label: "Portal del huésped (ajustes)", screen: "GuestPortalSettingsReal", roles: R_OPS_ASSET },
          { label: "Contadores energía y agua", screen: "EnergyMetering", roles: R_OPS_ASSET },
          { label: "Campañas de marketing", screen: "CampaignManagerReal", roles: R_OPS_ASSET },
          { label: "Kiosco self check-in", screen: "KioskSettingsReal", roles: R_OPS_ASSET },
          { label: "Compras y proveedores", screen: "ProcurementDashboard", roles: R_OPS_ASSET },
          { label: "Inventario operativo", screen: "InventoryDashboard", roles: R_OPS_ASSET }
        ]
      },
      {
        title: "Métricas de plataforma",
        roles: R_MGMT,
        items: dedupe([
          { label: "Centro de analítica", screen: "AnalyticsCenterDashboard", roles: R_MGMT },
          ...reportsNavigationItems,
          { label: "Registro de activos", screen: "AssetsDashboard", roles: R_OPS_ASSET },
          { label: "Rentabilidad por habitación", screen: "RoomProfitabilityDashboard", roles: R_MGMT },
          { label: "Consumo energético", screen: "EnergyDashboard", roles: R_OPS_ASSET }
          // "Sostenibilidad" (SustainabilityDashboard) migró al grupo top-level
          // "Cumplimiento" → subgrupo ESG, donde convive con ESRS dashboard y
          // ESRS evidence.
        ])
      }
    ]
  },
  {
    // Consolida todo el bloque regulatorio en un único grupo de primer nivel,
    // separando los flujos puramente fiscales/tributarios (autoridades AEAT,
    // forales, autonomías, registro de viajeros) del reporting ESG/CSRD
    // (sostenibilidad y trazabilidad ESRS). Esta separación responde a que
    // ambas áreas tienen ownership distinto en el hotel: el equipo financiero
    // pilota Fiscal, mientras que dirección/owner suelen pilotar ESG.
    title: "Cumplimiento",
    badge: "compliance",
    roles: R_MGMT,
    items: [
      { label: "Bandeja de cumplimiento", screen: "ComplianceInbox", roles: R_FRONT },
      { label: "Centro de cumplimiento", screen: "ComplianceCenter", roles: R_MGMT }
    ],
    subgroups: [
      {
        // Fiscal — autoridades tributarias y registro de viajeros. Cubre los
        // flujos VeriFactu (AEAT régimen común), AEAT (modelos 303/111/115/
        // 180/390), TBAI (forales vascos/Navarra), IGIC (Canarias) y registro
        // de huéspedes (SES.HOSPEDAJES + Spain Guest Register). El "Tax
        // calendar" se materializa con FiscalSubmissionsCenter (vista por
        // periodo de todas las submissions a las autoridades).
        title: "Fiscal",
        roles: R_OPS_ASSET,
        items: [
          { label: "VeriFactu", screen: "FiscalDashboard", roles: R_ASSET },
          { label: "AEAT (modelos)", screen: "FiscalDashboard", roles: R_ASSET },
          { label: "Modelo 303 (IVA trimestral)", screen: "Modelo303Screen", roles: R_ASSET },
          { label: "Modelo 111 (IRPF retenciones)", screen: "Modelo111Screen", roles: R_ASSET },
          { label: "Modelo 115 (retenciones arrendamientos)", screen: "Modelo115Screen", roles: R_ASSET },
          { label: "Modelo 180 (resumen anual 115)", screen: "Modelo180Screen", roles: R_ASSET },
          { label: "Modelo 390 (resumen anual IVA)", screen: "Modelo390Screen", roles: R_ASSET },
          { label: "TBAI (territorios forales)", screen: "TbaiForal", roles: R_ASSET },
          { label: "IGIC (Canarias)", screen: "FiscalSubmissionsCenter", roles: R_ASSET },
          { label: "Tax calendar (envíos fiscales)", screen: "FiscalSubmissionsCenter", roles: R_ASSET },
          // Spain Register — bloque del registro de viajeros y SES.HOSPEDAJES
          // (Ministerio del Interior). Se mantiene contiguo a los flujos
          // tributarios porque comparte ownership operativo (recepción cumple,
          // contabilidad supervisa).
          { label: "Spain Register · Registro de huéspedes", screen: "GuestRegisterSettings", roles: R_OPS_ASSET },
          { label: "Spain Register · SES.HOSPEDAJES", screen: "SesHospedajesSettings", roles: R_OPS_ASSET },
          { label: "Spain Register · Enrutamiento a autoridades", screen: "AuthorityRoutingSettings", roles: R_OPS_ASSET },
          { label: "Spain Register · Retención", screen: "GuestRegisterRetentionSettings", roles: R_OPS_ASSET },
          { label: "Spain Register · Mapeo de campos", screen: "GuestRegisterFieldMapping", roles: R_OPS_ASSET },
          { label: "Solicitudes RGPD (derechos del interesado)", screen: "GdprRequestsScreen", roles: R_OPS_ASSET }
        ]
      },
      {
        // ESG — reporting de sostenibilidad y trazabilidad CSRD/ESRS. El
        // dashboard de ESRS, la sección de evidencias (ESRS evidence) y el
        // tablero de Sostenibilidad consolidan KPIs ambientales/sociales para
        // owners y dirección.
        title: "ESG",
        roles: R_ASSET_OWNER,
        items: [
          // ESRS dashboard y evidence comparten destino actual (EsrsReportScreen
          // ya incluye ambas vistas; cuando se separen en pantallas dedicadas se
          // re-puntan los `screen` aquí sin tocar la organización del menú).
          { label: "ESRS dashboard", screen: "EsrsReport", roles: R_ASSET_OWNER },
          { label: "ESRS evidence", screen: "EsrsReport", roles: R_ASSET_OWNER },
          { label: "Sostenibilidad", screen: "SustainabilityDashboard", roles: R_MGMT }
        ]
      }
    ]
  },
  {
    title: "Back Office",
    badge: "settings",
    roles: R_OPS_ASSET,
    items: [
      { label: "Inicio del Back Office", screen: "BackOfficeDashboard", roles: R_OPS_ASSET },
      { label: "Centro de configuración inicial", screen: "SetupCenterScreen", roles: R_OPS_ASSET },
      { label: "Mapeador de propiedad", screen: "PropertyMapper", roles: R_OPS_ASSET },
      { label: "Lista de configuración", screen: "PropertySetupWizard", roles: R_OPS_ASSET }
    ],
    subgroups: [
      {
        title: "Configuración de propiedad",
        roles: R_OPS_ASSET,
        items: [
          { label: "Inicio de configuración", screen: "ConfigurationCenterScreen" },
          { label: "Perfil de la propiedad", screen: "PropertyProfileSetupForm" },
          { label: "Edificios", screen: "BuildingSetupForm" },
          { label: "Plantas", screen: "FloorSetupForm" },
          { label: "Zonas", screen: "ZoneSetupForm" },
          { label: "Tipos de habitación", screen: "RoomTypeSetupForm" },
          { label: "Inventario de habitaciones", screen: "RoomSetupForm" },
          { label: "Espacios y recursos", screen: "SpaceResourceSetupForm" },
          { label: "Departamentos", screen: "DepartmentSetupForm" },
          { label: "Categorías", screen: "CategoryManagerScreen" },
          { label: "Campos personalizados", screen: "CustomFieldManagerScreen" },
          // ----- Followups migrados desde whitelist (settings-hub) -----
          // Gestores legacy en src/screens/{Department,RoomType,RoomInventory,
          // DocumentTemplate}Manager.tsx. Son las pantallas reales (no las
          // formas guiadas del wizard). Se anidan en "Configuración de
          // propiedad" porque no existe un subgrupo "Configuración del hotel".
          // TODO: mover a subgrupo Configuración del hotel cuando exista
          { label: "Gestor de departamentos", screen: "DepartmentManager" },
          // TODO: mover a subgrupo Configuración del hotel cuando exista
          { label: "Gestor de tipos de habitación", screen: "RoomTypeManager" },
          // TODO: mover a subgrupo Configuración del hotel cuando exista
          { label: "Gestor de inventario de habitaciones", screen: "RoomInventoryManager" },
          // Plantillas de documentos — administración de templates (facturas,
          // contratos, etc.). Va bajo Back Office por ser una utilidad admin.
          { label: "Plantillas de documentos", screen: "DocumentTemplateManager" }
        ]
      },
      {
        title: "Ajustes operativos",
        roles: R_OPS,
        items: [
          { label: "Configuración operativa (housekeeping)", screen: "HousekeepingSetupForm" },
          { label: "Configuración de mantenimiento", screen: "MaintenanceSetupForm" },
          { label: "SOPs (configuración del módulo)", screen: "ModuleConfigurationCenter" },
          { label: "Espacios y puntos de venta", screen: "PropertyMapper" }
        ]
      },
      {
        title: "Ajustes comerciales",
        roles: R_ASSET,
        items: dedupe([
          { label: "Configuración de revenue", screen: "RevenueCategorySetupForm" },
          { label: "Ajustes de revenue", screen: "RevenueSettings" },
          ...revenueNavigationItems,
          { label: "Reglas de revenue", screen: "RevenueRules" },
          { label: "Reglas de automatización", screen: "RevenueAutomationRules" },
          { label: "Ajustes de forecast", screen: "ForecastSettings" },
          { label: "Ajustes de channel manager", screen: "ChannelManagerSettings" },
          { label: "Mapeos de canales", screen: "ChannelMappings" },
          { label: "Comp-set de competidores", screen: "CompetitorSet" },
          { label: "Calendario de demanda (admin)", screen: "DemandCalendarAdmin" }
        ])
      },
      {
        title: "Ajustes financieros y fiscales",
        roles: R_ASSET,
        items: dedupe([
          { label: "Configuración de finanzas y cumplimiento", screen: "FinanceComplianceSetupForm" },
          { label: "Contabilidad", screen: "AccountingSettings" },
          ...billingNavigationItems,
          { label: "Ajustes de facturación", screen: "BillingSettings" },
          { label: "Secuencias de facturas", screen: "BillingSettings" },
          { label: "Pagos", screen: "PaymentSettings" },
          { label: "Ajustes fiscales", screen: "TaxComplianceSettings" }
        ])
      },
      // NOTE: el subgrupo "Cumplimiento (España)" (Registro de huéspedes,
      // SES.HOSPEDAJES, Enrutamiento a autoridades, Retención, Mapeo de campos,
      // Solicitudes RGPD) ha migrado al grupo top-level "Cumplimiento" →
      // subgrupo Fiscal, donde convive con VeriFactu/AEAT/TBAI/IGIC y el
      // calendario fiscal.
      {
        title: "Notificaciones",
        roles: R_OPS_ASSET,
        items: [
          { label: "Plantillas y envíos", screen: "NotificationsScreen" }
        ]
      },
      {
        title: "Módulos e integraciones",
        roles: R_ADMIN_ONLY,
        items: [
          { label: "Marketplace de módulos", screen: "ModuleManager" },
          { label: "Módulos activos", screen: "ModuleManager" },
          { label: "Configuración de módulos", screen: "ModuleConfigurationCenter" },
          { label: "Salud de módulos", screen: "ModuleHealthCenter" },
          { label: "Marketplace de integraciones", screen: "IntegrationMarketplaceHome" },
          { label: "Gestor de integraciones", screen: "IntegrationManager" },
          // ----- Followups migrados desde whitelist (settings-hub) -----
          // Catálogo del marketplace de apps de terceros (R_MGMT en Finanzas).
          // Se replica aquí porque su hogar natural es la zona admin "Módulos
          // e integraciones".
          { label: "Marketplace de apps", screen: "MarketplaceCatalog" }
        ]
      },
      {
        title: "Usuarios y seguridad",
        roles: R_OPS_ASSET,
        items: [
          { label: "Usuarios", screen: "UserRoleManager" },
          { label: "Roles", screen: "UserRoleManager" },
          { label: "Permisos", screen: "UserRoleManager" },
          { label: "Seguridad", screen: "UserRoleManager" },
          { label: "Organización", screen: "OrganizationSettings" },
          { label: "Ajustes de la propiedad", screen: "PropertySettings" }
        ]
      },
      {
        title: "Desarrollador y sistema",
        // Technical zone — hidden from front-desk/operational roles. Audit log
        // stays reachable from the "Historial de auditoría" buttons in forms.
        permissionsAny: ["developer.read"],
        roles: R_ADMIN_ONLY,
        items: [
          { label: "Registro de auditoría", screen: "AuditLogViewer" },
          // Consola de tenants — super-admin multi-tenant operations console
          // (manage organisations, users, billing). Empty roles ([]) restricts
          // visibility to the "all" admin view, matching the super-admin scope.
          { label: "Consola de tenants", screen: "TenantAdminConsoleScreen", roles: [] },
          // ----- Followups migrados desde whitelist (settings-hub) -----
          // Webhooks, mis apps y conectores — pantallas reales del portal
          // developer. Ya existen como atajos en "Finanzas y fiscal"; aquí se
          // exponen en su hogar natural (zona admin / developer).
          { label: "Webhooks", screen: "WebhooksAdmin" },
          { label: "Mis apps (Developer)", screen: "DeveloperApps" },
          // Conector de correo entrante (IA) — gestiona buzones que alimentan
          // el agente de reservas. Replica el atajo del grupo IA.
          { label: "Conectores de correo", screen: "EmailConnectors" },
          // Mensajería omnichannel — provisión de canales (WhatsApp, SMS, etc.)
          // gestionada por el equipo developer/integraciones.
          { label: "Mensajería omnichannel", screen: "MessagingConnections" }
        ]
      },
      {
        // CONSOLIDATED Settings placeholders — same pattern as the AI block's
        // "Próximamente Q4 2026" subgroup. The 15 Settings screens below are
        // wired in App.tsx but only render `ModuleSettingsPlaceholder` today,
        // so they're dead ends for operational personas. We tuck them all here
        // with R_ADMIN_ONLY + placeholder=true: itemVisibleForRole filters them
        // out for any non-"all" view, while the admin "all" view keeps them
        // reachable for QA/dev work.
        //
        // Previous homes (now cleaned up):
        // - WorkforceSettings, SafetySettings ← "Ajustes operativos"
        // - GroupSettings, EventSpacesSettings, SalesSettings,
        //   GuestPortalSettings, UpsellSettings, ReputationSettings,
        //   SurveySettings, QualityWorkflowSettings, CRMSettings,
        //   LoyaltySettings ← "Ajustes comerciales"
        // - ProcurementSettings, InventorySettings ← "Ajustes financieros y fiscales"
        // - DeveloperPortal ← "Desarrollador y sistema"
        title: "Configuracion avanzada · Próximamente",
        roles: R_ADMIN_ONLY,
        items: [
          // Operativos (2)
          { label: "Ajustes de personal", screen: "WorkforceSettings", placeholder: true },
          { label: "Ajustes de seguridad", screen: "SafetySettings", placeholder: true },
          // Comerciales (10)
          { label: "Ajustes de grupos", screen: "GroupSettings", placeholder: true },
          { label: "Ajustes de eventos", screen: "EventSpacesSettings", placeholder: true },
          { label: "Ajustes de ventas", screen: "SalesSettings", placeholder: true },
          { label: "Ajustes del portal del huésped", screen: "GuestPortalSettings", placeholder: true },
          { label: "Ajustes de upsells", screen: "UpsellSettings", placeholder: true },
          { label: "Ajustes de reputación", screen: "ReputationSettings", placeholder: true },
          { label: "Ajustes de encuestas", screen: "SurveySettings", placeholder: true },
          { label: "Ajustes del flujo de calidad", screen: "QualityWorkflowSettings", placeholder: true },
          { label: "Ajustes de CRM", screen: "CRMSettings", placeholder: true },
          { label: "Ajustes de fidelización", screen: "LoyaltySettings", placeholder: true },
          // Financieros y fiscales (2)
          { label: "Ajustes de compras", screen: "ProcurementSettings", placeholder: true },
          { label: "Ajustes de inventario", screen: "InventorySettings", placeholder: true },
          // Developer (1)
          { label: "Plataforma de desarrollador", screen: "DeveloperPortal", placeholder: true }
        ]
      }
    ]
  },
  {
    title: "Operaciones de IA",
    badge: "IA",
    // Engineer/management zone — hidden from front-desk roles. Visible to anyone
    // with an AI permission or to owners/directors with the dashboard permission.
    permissionsAny: [
      "ai.configure",
      "ai_governance.read",
      "ai_governance.configure",
      "ai_tool_registry.manage",
      "ai_prompts.manage",
      "ai_incidents.read",
      "owner.dashboard.read"
    ],
    // CONSOLIDATED AI block: only 3 surfaces are real and ready to use today —
    // the conversational assistant (which already lives in Operaciones as
    // "Asistente IA (Ask Anfitorio)"), AI Governance and AI Settings. Everything
    // else (owner summary, pipeline status, tool registry, HITL queue, mapping
    // & extraction screens, etc.) is wired but not yet production-grade UX, so
    // we tuck it behind a "Próximamente Q4 2026" subgroup with placeholder=true
    // and the R_ADMIN_ONLY role tag — meaning operational personas don't see
    // those entries at all (placeholder check in itemVisibleForRole filters
    // them out for any non-"all" view) while the admin "all" view keeps them
    // reachable for QA/dev work.
    roles: R_MGMT,
    items: [
      { label: "Gobernanza de IA", screen: "AiGovernanceScreen", roles: R_ASSET },
      { label: "Ajustes de IA", screen: "AISettings", roles: R_ASSET }
    ],
    subgroups: [
      {
        title: "IA · Próximamente Q4 2026",
        roles: R_ADMIN_ONLY,
        items: [
          { label: "Resumen de IA (dirección)", screen: "AiOwnerSummaryScreen", placeholder: true },
          { label: "Actividad de la IA", screen: "AiPipelineStatusScreen", placeholder: true },
          { label: "Configuración de IA (propiedad)", screen: "PropertyAiScreen", placeholder: true },
          { label: "Centro de setup de IA", screen: "AISetupCenter", placeholder: true },
          { label: "Correo → reservas (IA)", screen: "EmailConnectors", placeholder: true },
          { label: "Catálogo de herramientas", screen: "AiToolRegistryScreen", placeholder: true },
          { label: "Revisión humana (HITL)", screen: "AiHumanReviewQueueScreen", placeholder: true },
          { label: "Mapear propiedad desde documentos", screen: "PropertyMapper", placeholder: true },
          { label: "Subir y clasificar ficheros", screen: "FileUploadAndClassification", placeholder: true },
          { label: "Revisión de extracción (IA)", screen: "AIExtractionReview", placeholder: true },
          { label: "Revisión de mapeo de habitaciones", screen: "RoomMappingReview", placeholder: true }
        ]
      }
    ]
  }
];

export const backOfficeNavigation: BackOfficeNavSection[] = backOfficeNavigationGroups.flatMap((group) => {
  const flat: BackOfficeNavSection[] = [];
  if (group.items?.length) {
    flat.push({ title: group.title, items: group.items });
  }
  for (const sub of group.subgroups ?? []) {
    flat.push({ title: `${group.title} · ${sub.title}`, items: sub.items });
  }
  return flat;
});

function groupContainsActive(group: BackOfficeNavGroup, activeScreen: string): boolean {
  if (group.items?.some((item) => item.screen === activeScreen)) return true;
  return (group.subgroups ?? []).some((sub) => sub.items.some((item) => item.screen === activeScreen));
}

function subgroupContainsActive(sub: BackOfficeNavSubgroup, activeScreen: string): boolean {
  return sub.items.some((item) => item.screen === activeScreen);
}

export function Sidebar(props: {
  activeScreen: string;
  onSelect: (screen: string) => void;
  open?: boolean;
  onClose?: () => void;
}) {
  const initialOpenGroups: Record<string, boolean> = {};
  const initialOpenSubgroups: Record<string, boolean> = {};
  for (const group of backOfficeNavigationGroups) {
    const active = groupContainsActive(group, props.activeScreen);
    initialOpenGroups[group.title] = active || group.title === "Ops";
    for (const sub of group.subgroups ?? []) {
      const subActive = subgroupContainsActive(sub, props.activeScreen);
      initialOpenSubgroups[`${group.title}::${sub.title}`] = subActive;
    }
  }
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(initialOpenGroups);
  const [openSubgroups, setOpenSubgroups] = useState<Record<string, boolean>>(initialOpenSubgroups);
  const [query, setQuery] = useState("");
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [activeRole, setActiveRoleState] = useState<Role>(() => getActiveRole());

  function changeRole(role: Role) {
    setActiveRoleState(role);
    setActiveRole(role); // persist
    const home = roleHome(role);
    if (home) props.onSelect(home); // land on this persona's home
  }

  // Resolve which personas should see an item, with inheritance:
  // item.roles → subgroup.roles → group.roles → all four personas.
  function itemVisibleForRole(
    item: BackOfficeNavItem,
    group: BackOfficeNavGroup,
    sub?: BackOfficeNavSubgroup
  ): boolean {
    if (activeRole === "all") return true;
    // Placeholder items (their target screen is a `ModuleSettingsPlaceholder`)
    // are dead ends for operational personas, so we only surface them in the
    // "all" admin view above. Everyone else gets them filtered out.
    if (item.placeholder) return false;
    const roles = item.roles ?? sub?.roles ?? group.roles ?? PERSONA_ROLES;
    return roles.includes(activeRole);
  }

  useEffect(() => {
    let cancelled = false;
    void getCurrentUserPermissions()
      .then((perms) => {
        if (!cancelled) setPermissions(perms);
      })
      .catch(() => {
        if (!cancelled) setPermissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Permission-gated groups are hidden until permissions are known, then shown
  // only if the user holds at least one of the required permissions.
  function canSeeGroup(group: BackOfficeNavGroup): boolean {
    if (!group.permissionsAny || group.permissionsAny.length === 0) return true;
    if (permissions === null) return false;
    return group.permissionsAny.some((p) => permissions.includes(p));
  }

  // Same gate semantics for subgroups. Critically, this must null-guard
  // `permissions` (it starts null until getCurrentUserPermissions resolves);
  // otherwise `permissions.includes` throws and crashes the whole sidebar on
  // the first render before permissions load.
  function canSeeSubgroup(sub: BackOfficeNavSubgroup): boolean {
    if (!sub.permissionsAny || sub.permissionsAny.length === 0) return true;
    if (permissions === null) return false;
    return sub.permissionsAny.some((p) => permissions.includes(p));
  }

  function toggleGroup(title: string) {
    setOpenGroups((prev) => ({ ...prev, [title]: !prev[title] }));
  }
  function toggleSubgroup(key: string) {
    setOpenSubgroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const q = query.trim().toLowerCase();
  const filterItem = (item: BackOfficeNavItem) => !q || item.label.toLowerCase().includes(q);

  return (
    <aside className={`bo-sidebar${props.open ? " open" : ""}`} aria-label="Navegación del Back Office" data-tour="sidebar">
      <button
        type="button"
        className="bo-sidebar-close"
        aria-label="Cerrar"
        onClick={() => props.onClose?.()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <div className="bo-brand">
        <span>H</span>
        <div>
          <strong>Anfitorio</strong>
          <small>Back Office</small>
        </div>
      </div>
      <div className="bo-role-switcher">
        <label htmlFor="bo-role-select">Vista</label>
        <div className="bo-role-select-wrap">
          <select
            id="bo-role-select"
            value={activeRole}
            onChange={(event) => changeRole(event.target.value as Role)}
            aria-label="Cambiar de perfil (vista del menú)"
          >
            {ROLES.map((role) => (
              <option key={role.id} value={role.id}>{role.label}</option>
            ))}
          </select>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <div className="bo-sidebar-search">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar en el menú"
          aria-label="Buscar en la navegación"
        />
      </div>
      {backOfficeNavigationGroups.map((group) => {
        if (!canSeeGroup(group)) return null;
        const groupItems = (group.items ?? []).filter((item) => filterItem(item) && itemVisibleForRole(item, group));
        const matchingSubgroups = (group.subgroups ?? [])
          .filter(canSeeSubgroup)
          .map((sub) => ({ sub, items: sub.items.filter((item) => filterItem(item) && itemVisibleForRole(item, group, sub)) }))
          .filter((entry) => entry.items.length > 0);
        const hasMatch = groupItems.length > 0 || matchingSubgroups.length > 0;
        // Hide groups with nothing visible for the current role/search.
        if (!hasMatch) return null;
        const isOpen = q ? true : openGroups[group.title] !== false;
        return (
          <section key={group.title} className={`bo-nav-group${isOpen ? " open" : ""}`}>
            <button
              type="button"
              className="bo-nav-group-head"
              onClick={() => toggleGroup(group.title)}
              aria-expanded={isOpen}
            >
              <span className="bo-nav-group-title">{group.title}</span>
              {group.badge ? <span className="bo-nav-group-badge">{group.badge}</span> : null}
              <span className="bo-nav-chevron" aria-hidden>{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen ? (
              <div className="bo-nav-group-body">
                {groupItems.length > 0 ? (
                  <div className="bo-nav-section">
                    {groupItems.map((item) => (
                      <button
                        key={`${group.title}-${item.label}-${item.screen}`}
                        className={`bo-nav-item${props.activeScreen === item.screen ? " active" : ""}`}
                        onClick={() => props.onSelect(item.screen)}
                        type="button"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {matchingSubgroups.map(({ sub, items }) => {
                  const key = `${group.title}::${sub.title}`;
                  const subOpen = q ? true : openSubgroups[key] === true;
                  return (
                    <div key={key} className={`bo-nav-subgroup${subOpen ? " open" : ""}`}>
                      <button
                        type="button"
                        className="bo-nav-subgroup-head"
                        onClick={() => toggleSubgroup(key)}
                        aria-expanded={subOpen}
                      >
                        <span className="bo-nav-chevron" aria-hidden>{subOpen ? "▾" : "▸"}</span>
                        <span>{sub.title}</span>
                        <span className="bo-nav-count">{items.length}</span>
                      </button>
                      {subOpen ? (
                        <div className="bo-nav-section nested">
                          {items.map((item) => (
                            <button
                              key={`${key}-${item.label}-${item.screen}`}
                              className={`bo-nav-item${props.activeScreen === item.screen ? " active" : ""}`}
                              onClick={() => props.onSelect(item.screen)}
                              type="button"
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
    </aside>
  );
}
