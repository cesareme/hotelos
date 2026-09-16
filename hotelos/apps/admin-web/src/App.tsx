import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { BackOfficeLayout } from "./layouts/BackOfficeLayout";
import { LoginScreen } from "./screens/auth/LoginScreen";
import { ForgotPasswordScreen } from "./screens/auth/ForgotPasswordScreen";
// Public (unauthenticated) routes — /accept-invite, /reset-password — and the
// forced password rotation (ChangePasswordScreen). Rendered as a wrapper around
// the AuthGate (contract I): it shows the public screen instead of the shell
// when the pathname matches, and its children (the protected app) otherwise.
import { PublicAuthRoutes } from "./auth/PublicAuthRoutes";
import { clearSession, getUser, onAuthChange, type AuthUser } from "./services/auth-storage";
import { ensureActiveProperty } from "./services/activeProperty";
import { getSessionRoleSnapshot } from "./services/usersApi";
// Eager import: ComplianceInbox is wrapped in a module-scope wired component.
// Everything else is loaded lazily by route to keep the main bundle small.
import { ComplianceInbox } from "./screens/fiscal/ComplianceInbox";
import {
  findLegacyId,
  isDevOnlyScreen,
  isDevRouteAllowed,
  isLegacyPath,
  pathForScreen,
  pathnameBelongsToScreen,
  itemUrlForScreen,
  resolveLegacyLocation,
  resolveLocation,
  retiredScreenUrl,
  screenFromPathname,
  stripLegacyId,
  urlForScreenWithParams,
  urlPatternForScreen,
  type DevGuardInput
} from "./routes/backoffice.routes";
import { FALLBACK_LANDING_SCREEN, devQueryFrom, normalizePathname, type LandingTarget } from "./navigation/nav-tree";
import { readDevModeStorage, syncDevModeFromLocation } from "./navigation/dev-mode";
import { useSessionLanding } from "./navigation/useEnabledModules";
import { makeModulePlaceholder } from "./screens/ModuleSettingsPlaceholder";
import { ToastProvider, ToastHost } from "./components/Toast";
import { CocoaGlobalProvider } from "./providers/CocoaGlobalProvider";
import { LoadingBlock } from "./components/States";
import { CocoaButton } from "./components/cocoa/CocoaButton";
import "./styles.css";

// --- Lazy screen loaders ------------------------------------------------
// Helper to lazy-load a named export. We default it via .then() so React's
// lazy() (which expects { default: Component }) accepts it.
const lazyNamed = <T,>(loader: () => Promise<Record<string, T>>, name: string) =>
  lazy(() => loader().then((m) => ({ default: m[name] as unknown as ComponentType<unknown> })));

// Tab containers (Tanda 5 · L1a): one routed container per menu item with
// tabs, exported from screens/tabs/index.ts. The container resolves the active
// tab from the URL and loads each tab lazily, so the item key AND every tab key
// of the tree map to the SAME component below (no remount when switching tabs).
type TabContainers = typeof import("./screens/tabs");
const lazyTab = <K extends keyof TabContainers>(name: K) =>
  lazy(() => import("./screens/tabs").then((m) => ({ default: m[name] as unknown as ComponentType<unknown> })));

const MiDiaTabs = lazyTab("MiDiaTabs");
const ReservasTabs = lazyTab("ReservasTabs");
const NuevaReservaTabs = lazyTab("NuevaReservaTabs");
const HuespedesTabs = lazyTab("HuespedesTabs");
const GruposEventosTabs = lazyTab("GruposEventosTabs");
const PisosTabs = lazyTab("PisosTabs");
const MantenimientoTabs = lazyTab("MantenimientoTabs");
const PuntoVentaTabs = lazyTab("PuntoVentaTabs");
const ComprasInventarioTabs = lazyTab("ComprasInventarioTabs");
const ClientesTabs = lazyTab("ClientesTabs");
const ReputacionTabs = lazyTab("ReputacionTabs");
const VentasAdicionalesTabs = lazyTab("VentasAdicionalesTabs");
const CanalesTabs = lazyTab("CanalesTabs");
const ParrillaTabs = lazyTab("ParrillaTabs");
const HistoricoPrevisionTabs = lazyTab("HistoricoPrevisionTabs");
const FacturacionTabs = lazyTab("FacturacionTabs");
const TesoreriaTabs = lazyTab("TesoreriaTabs");
const ConciliacionTabs = lazyTab("ConciliacionTabs");
const EstadosContablesTabs = lazyTab("EstadosContablesTabs");
const ContabilidadTabs = lazyTab("ContabilidadTabs");
const ProveedoresTabs = lazyTab("ProveedoresTabs");
const VerifactuTabs = lazyTab("VerifactuTabs");
const ModelosAeatTabs = lazyTab("ModelosAeatTabs");
const ImpuestosTabs = lazyTab("ImpuestosTabs");
const RegistroViajerosTabs = lazyTab("RegistroViajerosTabs");
const SostenibilidadTabs = lazyTab("SostenibilidadTabs");
const CentroInformesTabs = lazyTab("CentroInformesTabs");
const CarteraTabs = lazyTab("CarteraTabs");
const PuestaEnMarchaTabs = lazyTab("PuestaEnMarchaTabs");
const PropiedadTabs = lazyTab("PropiedadTabs");
const HabitacionesTabs = lazyTab("HabitacionesTabs");
const ComunicacionesTabs = lazyTab("ComunicacionesTabs");
const FacturacionPagosTabs = lazyTab("FacturacionPagosTabs");
const ContabilidadFiscalTabs = lazyTab("ContabilidadFiscalTabs");
const ModulosTabs = lazyTab("ModulosTabs");
const InteligenciaArtificialTabs = lazyTab("InteligenciaArtificialTabs");
const SistemaTabs = lazyTab("SistemaTabs");

// Standalone screens (menu items without tabs).
const AssistantChatScreen = lazyNamed(() => import("./screens/assistant/AssistantChatScreen"), "AssistantChatScreen");
const ShiftManagerScreen = lazyNamed(() => import("./screens/operations/ShiftManagerScreen"), "ShiftManagerScreen");
const NightAuditScreen = lazyNamed(() => import("./screens/operations/NightAuditScreen"), "NightAuditScreen");
const AiOwnerSummaryScreen = lazyNamed(() => import("./screens/aiOperations/AiOwnerSummaryScreen"), "AiOwnerSummaryScreen");
const AiHumanReviewQueueScreen = lazyNamed(() => import("./screens/aiOperations/AiHumanReviewQueueScreen"), "AiHumanReviewQueueScreen");
const ConciergeInboxDashboard = lazyNamed(() => import("./screens/operations/ConciergeInboxDashboard"), "ConciergeInboxDashboard");
const WorkforceDashboard = lazyNamed(() => import("./screens/operations/WorkforceDashboard"), "WorkforceDashboard");
const SafetyDashboard = lazyNamed(() => import("./screens/operations/SafetyDashboard"), "SafetyDashboard");
const AssetsDashboard = lazyNamed(() => import("./screens/operations/AssetsDashboard"), "AssetsDashboard");
const EnergyDashboard = lazyNamed(() => import("./screens/operations/EnergyDashboard"), "EnergyDashboard");
const SalesPipelineDashboard = lazyNamed(() => import("./screens/operations/SalesPipelineDashboard"), "SalesPipelineDashboard");
const RevenueHomeDashboard = lazyNamed(() => import("./screens/revenue/RevenueHomeDashboard"), "RevenueHomeDashboard");
const RatePlansScreen = lazyNamed(() => import("./screens/admin/RatePlansScreen"), "RatePlansScreen");
const RevenueRulesScreen = lazyNamed(() => import("./screens/RevenueRulesScreen"), "RevenueRulesScreen");
const RevenueComparisonDashboard = lazyNamed(() => import("./screens/revenue/RevenueComparisonDashboard"), "RevenueComparisonDashboard");
const RevenueMeetingScreen = lazyNamed(() => import("./screens/revenue/RevenueMeetingScreen"), "RevenueMeetingScreen");
const RateShopperSettingsScreen = lazyNamed(() => import("./screens/RateShopperSettingsScreen"), "RateShopperSettingsScreen");
const DemandCalendarAdminScreen = lazyNamed(() => import("./screens/DemandCalendarAdminScreen"), "DemandCalendarAdminScreen");
const CancellationPoliciesScreen = lazyNamed(() => import("./screens/admin/CancellationPoliciesScreen"), "CancellationPoliciesScreen");
const CommissionsScreen = lazyNamed(() => import("./screens/commissions/CommissionsScreen"), "CommissionsScreen");
const PayrollScreen = lazyNamed(() => import("./screens/payroll/PayrollScreen"), "PayrollScreen");
const ComplianceCenterScreen = lazyNamed(() => import("./screens/compliance/ComplianceCenterScreen"), "ComplianceCenterScreen");
const FiscalSubmissionsCenter = lazyNamed(() => import("./screens/fiscal/FiscalSubmissionsCenter"), "FiscalSubmissionsCenter");
const GdprRequestsScreen = lazyNamed(() => import("./screens/compliance/GdprRequestsScreen"), "GdprRequestsScreen");
const AnalyticsCenterDashboard = lazyNamed(() => import("./screens/operations/AnalyticsCenterDashboard"), "AnalyticsCenterDashboard");
const RoomProfitabilityDashboard = lazyNamed(() => import("./screens/operations/RoomProfitabilityDashboard"), "RoomProfitabilityDashboard");
const ChannelPerformanceDashboard = lazyNamed(() => import("./screens/operations/ChannelPerformanceDashboard"), "ChannelPerformanceDashboard");
const UserRoleManager = lazyNamed(() => import("./screens/UserRoleManager"), "UserRoleManager");

// Dev-only migration screens (/desarrollo/migracion/*): one chunk for the module.
const OnboardingProjectListScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "OnboardingProjectListScreen");
const FileUploadAndClassificationScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "FileUploadAndClassificationScreen");
const AIExtractionReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "AIExtractionReviewScreen");
const MigrationBatchScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "MigrationBatchScreen");

// Dev-only Cocoa 22 style guide (/desarrollo/guia-estilo): every primitive in
// every state and tone, with copyable samples and the migration checklist.
const StyleGuideScreen = lazyNamed(() => import("./screens/dev/StyleGuideScreen"), "StyleGuideScreen");

// Not-found page (unknown URL): a real screen with a way back, never a silent fallback.
const CocoaNotFoundScreen = lazyNamed(() => import("./screens/errors/CocoaNotFoundScreen"), "CocoaNotFoundScreen");

// Dev-only placeholders (Tanda 5 · §4.3): the 16 module settings screens without
// a backing endpoint live under /desarrollo/* and are only reachable with
// `?dev=1` (or localStorage anfitorio.dev=1) AND the platform admin. Each one
// points at the real surface of its module. They are the ONLY
// makeModulePlaceholder calls left (scripts/check-placeholder-budget.mjs).
const CRMSettingsModule = makeModulePlaceholder({ moduleName: "CRM", dashboardScreen: "CrmDashboard", dashboardLabel: "Abrir tablero CRM", relatedScreens: [{ label: "Configuración de huéspedes", screen: "PropertyProfileSetupForm" }] });
const LoyaltySettingsModule = makeModulePlaceholder({ moduleName: "Fidelización", dashboardScreen: "LoyaltyDashboard", dashboardLabel: "Abrir tablero de fidelización" });
const GroupSettingsModule = makeModulePlaceholder({ moduleName: "Grupos", dashboardScreen: "GroupsEventsDashboard", dashboardLabel: "Abrir grupos y eventos" });
const SalesSettingsModule = makeModulePlaceholder({ moduleName: "Ajustes de ventas", dashboardScreen: "SalesPipelineDashboard", dashboardLabel: "Abrir pipeline de ventas" });
const WorkforceSettingsModule = makeModulePlaceholder({ moduleName: "Personal", dashboardScreen: "WorkforceDashboard", dashboardLabel: "Abrir tablero de personal", setupScreen: "DepartmentSetupForm", setupLabel: "Configurar departamentos" });
const InventorySettingsModule = makeModulePlaceholder({ moduleName: "Inventario", dashboardScreen: "InventoryDashboard", dashboardLabel: "Abrir tablero de inventario" });
const ProcurementSettingsModule = makeModulePlaceholder({ moduleName: "Compras", dashboardScreen: "ProcurementDashboard", dashboardLabel: "Abrir tablero de compras" });
const ReputationSettingsModule = makeModulePlaceholder({ moduleName: "Reputación", dashboardScreen: "ReputationDashboard", dashboardLabel: "Abrir tablero de reputación" });
const SurveySettingsModule = makeModulePlaceholder({ moduleName: "Encuestas", dashboardScreen: "SurveysDashboard", dashboardLabel: "Abrir Encuestas / NPS" });
const QualityWorkflowSettingsModule = makeModulePlaceholder({ moduleName: "Flujo de calidad", dashboardScreen: "QualityDashboard", dashboardLabel: "Abrir casos de calidad" });
const EnergySettingsModule = makeModulePlaceholder({ moduleName: "Energía", dashboardScreen: "EnergyDashboard", dashboardLabel: "Abrir tablero de energía" });
const SafetySettingsModule = makeModulePlaceholder({ moduleName: "Seguridad", dashboardScreen: "SafetyDashboard", dashboardLabel: "Abrir tablero de seguridad" });
const ScheduledReportsModule = makeModulePlaceholder({ moduleName: "Informes programados", dashboardScreen: "AnalyticsCenterDashboard", dashboardLabel: "Abrir centro de analítica", relatedScreens: [{ label: "Centro de informes", screen: "ReportingCenter" }] });
const RevenueAutomationRulesModule = makeModulePlaceholder({ moduleName: "Reglas de automatización de revenue", summary: "Automatización de tarifas y restricciones con umbrales de aprobación. Hoy las reglas se gestionan desde Reglas de revenue.", dashboardScreen: "RevenueRules", dashboardLabel: "Abrir reglas de revenue" });
const RevenueDataQualityModule = makeModulePlaceholder({ moduleName: "Calidad de datos de revenue", summary: "Comprobaciones de preparación (snapshots, mapeos, planes tarifarios, confianza del forecast) antes de emitir recomendaciones.", dashboardScreen: "RevenueHomeDashboard", dashboardLabel: "Abrir inicio de revenue" });
const ForecastSettingsModule = makeModulePlaceholder({ moduleName: "Ajustes de forecast", summary: "Horizonte, modelo y umbrales de confianza de la previsión. La precisión del forecast se consulta en el explorador.", dashboardScreen: "RevenueForecastExplorer", dashboardLabel: "Abrir explorador de forecast" });

const ComplianceInboxWired = () => <ComplianceInbox onNavigate={(s) => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: s }))} />;

// Screen registry (Tanda 5 · L1b). One entry per screen key of
// navigation/nav-tree.generated.json — 66 items, 94 tabs, 20 dev-only and 2
// public — plus the 24 aliases (LEGACY_SCREEN_KEYS). A tab key maps to the
// container of its item; the 72 retired keys are gone (an orphan `hotelos-nav`
// to one of them is redirected by `resolveScreenTarget`). Every key has a URL
// (routes/backoffice.routes.tsx) and scripts/check-route-validity.mjs keeps the
// registry and the tree in sync.
const SCREEN_COMPONENTS = {
  // --- Públicas (fuera del shell) ---
  LoginScreen,
  ForgotPasswordScreen,
  // --- Hoy ---
  FrontDeskDashboard: MiDiaTabs,
  OperationsDirectorScreen: MiDiaTabs,
  GeneralManagerScreen: MiDiaTabs,
  OwnerHome: MiDiaTabs,
  AssistantChat: AssistantChatScreen,
  ShiftManagerScreen,
  NightAuditScreen,
  AiOwnerSummaryScreen,
  AiHumanReviewQueueScreen,
  // --- Recepción ---
  ReservationWorkspace: ReservasTabs,
  ReservationsListScreen: ReservasTabs,
  LiveTimelineWorkspace: ReservasTabs,
  RoomRackScreen: ReservasTabs,
  ReservationDetailWorkspace: ReservasTabs,
  GuestJourneyWorkspace: ReservasTabs,
  ReservationCreate: NuevaReservaTabs,
  ReservationAgent: NuevaReservaTabs,
  GuestsList: HuespedesTabs,
  GuestDetail: HuespedesTabs,
  GuestTimelineScreen: HuespedesTabs,
  ConciergeInboxDashboard,
  GroupsEventsDashboard: GruposEventosTabs,
  GroupsCalendarScreen: GruposEventosTabs,
  Allotments: GruposEventosTabs,
  // --- Operaciones ---
  HousekeepingDashboard: PisosTabs,
  HousekeepingMobileScreen: PisosTabs,
  HousekeepingSetupForm: PisosTabs,
  MaintenanceDashboard: MantenimientoTabs,
  MaintenanceMobileScreen: MantenimientoTabs,
  MaintenanceSetupForm: MantenimientoTabs,
  PosDashboard: PuntoVentaTabs,
  FnbMenu: PuntoVentaTabs,
  FnbInventory: PuntoVentaTabs,
  CashClosureScreen: PuntoVentaTabs,
  WorkforceDashboard,
  SafetyDashboard,
  ProcurementDashboard: ComprasInventarioTabs,
  InventoryDashboard: ComprasInventarioTabs,
  AssetsDashboard,
  EnergyDashboard,
  // --- Comercial ---
  CrmDashboard: ClientesTabs,
  GuestSegmentsReal: ClientesTabs,
  LoyaltyDashboard: ClientesTabs,
  LoyaltyProgram: ClientesTabs,
  CampaignManagerReal: ClientesTabs,
  ReputationDashboard: ReputacionTabs,
  SurveysDashboard: ReputacionTabs,
  QualityDashboard: ReputacionTabs,
  UpsellsDashboard: VentasAdicionalesTabs,
  UpsellsSettings: VentasAdicionalesTabs,
  GuestPortalSettingsReal: VentasAdicionalesTabs,
  SalesPipelineDashboard,
  ChannelAggregatorHub: CanalesTabs,
  ChannelMappings: CanalesTabs,
  // --- Revenue ---
  RevenueHomeDashboard,
  RateGridEditorScreen: ParrillaTabs,
  RateJournalScreen: ParrillaTabs,
  RatePlans: RatePlansScreen,
  RevenueRules: RevenueRulesScreen,
  RevenueHistoryForecastDashboard: HistoricoPrevisionTabs,
  RevenueHistoryForecastReport: HistoricoPrevisionTabs,
  RevenueForecastExplorer: HistoricoPrevisionTabs,
  RevenueComparisonDashboard,
  RevenueMeeting: RevenueMeetingScreen,
  RateShopperSettings: RateShopperSettingsScreen,
  DemandCalendarAdmin: DemandCalendarAdminScreen,
  CancellationPolicies: CancellationPoliciesScreen,
  // --- Finanzas ---
  BillingCenter: FacturacionTabs,
  FolioDetail: FacturacionTabs,
  InvoiceRectificationsScreen: FacturacionTabs,
  FolioRouting: FacturacionTabs,
  FinancePositionDashboard: TesoreriaTabs,
  ExchangeRatesScreen: TesoreriaTabs,
  BankReconciliationScreen: ConciliacionTabs,
  BankingSpain: ConciliacionTabs,
  // Contabilidad (Tanda 6): diario · mayor · plan · ajustes · cierre de ejercicio · gestoría
  JournalScreen: ContabilidadTabs,
  LedgerScreen: ContabilidadTabs,
  ChartOfAccountsScreen: ContabilidadTabs,
  AccountingSettingsScreen: ContabilidadTabs,
  YearEndCloseScreen: ContabilidadTabs,
  GestoriaExportScreen: ContabilidadTabs,
  TrialBalanceScreen: EstadosContablesTabs,
  BalanceSheetScreen: EstadosContablesTabs,
  ProfitAndLossScreen: EstadosContablesTabs,
  CashFlowScreen: EstadosContablesTabs,
  AnnualAccountsScreen: EstadosContablesTabs,
  UsaliScreen: EstadosContablesTabs,
  // Proveedores y gastos (Tanda 6): facturas recibidas · gastos · proveedores · inmovilizado
  SupplierBillsScreen: ProveedoresTabs,
  ExpensesScreen: ProveedoresTabs,
  SuppliersScreen: ProveedoresTabs,
  FixedAssetsScreen: ProveedoresTabs,
  CommissionsScreen,
  PayrollScreen,
  // --- Cumplimiento ---
  ComplianceInbox: ComplianceInboxWired,
  ComplianceCenter: ComplianceCenterScreen,
  FiscalDashboard: VerifactuTabs,
  TbaiForal: VerifactuTabs,
  FiscalSubmissionsCenter,
  Modelo303Screen: ModelosAeatTabs,
  Modelo111Screen: ModelosAeatTabs,
  Modelo115Screen: ModelosAeatTabs,
  Modelo180Screen: ModelosAeatTabs,
  Modelo390Screen: ModelosAeatTabs,
  Modelo347Screen: ModelosAeatTabs,
  VatBooksScreen: ModelosAeatTabs,
  VatSettlementScreen: ModelosAeatTabs,
  PropertyTaxesScreen: ImpuestosTabs,
  TouristTax: ImpuestosTabs,
  GuestRegisterSettings: RegistroViajerosTabs,
  SesHospedajesSettings: RegistroViajerosTabs,
  AuthorityRoutingSettings: RegistroViajerosTabs,
  GuestRegisterRetentionSettings: RegistroViajerosTabs,
  GdprRequestsScreen,
  SustainabilityDashboard: SostenibilidadTabs,
  EsrsReport: SostenibilidadTabs,
  // --- Informes ---
  ReportingCenter: CentroInformesTabs,
  RevenueExportCenter: CentroInformesTabs,
  AnalyticsCenterDashboard,
  RoomProfitabilityDashboard,
  PortfolioDashboard: CarteraTabs,
  PropertyDetailScreen: CarteraTabs,
  ChannelPerformanceDashboard,
  // --- Configuración ---
  SetupCenterScreen: PuestaEnMarchaTabs,
  GoLiveChecklist: PuestaEnMarchaTabs,
  PropertyMapper: PuestaEnMarchaTabs,
  PropertyProfileSetupForm: PropiedadTabs,
  BuildingSetupForm: PropiedadTabs,
  FloorSetupForm: PropiedadTabs,
  ZoneSetupForm: PropiedadTabs,
  DepartmentSetupForm: PropiedadTabs,
  CategoryManagerScreen: PropiedadTabs,
  CategoryDetailScreen: PropiedadTabs,
  CategoryOptionForm: PropiedadTabs,
  CustomFieldSetupForm: PropiedadTabs,
  RoomSetupForm: HabitacionesTabs,
  RoomTypeSetupForm: HabitacionesTabs,
  SpaceResourceSetupForm: HabitacionesTabs,
  UserRoleManager,
  NotificationsScreen: ComunicacionesTabs,
  EmailConnectors: ComunicacionesTabs,
  BillingSettings: FacturacionPagosTabs,
  PaymentSettings: FacturacionPagosTabs,
  AccountingSettings: ContabilidadFiscalTabs,
  TaxComplianceSettings: ContabilidadFiscalTabs,
  FinanceComplianceSetupForm: ContabilidadFiscalTabs,
  RevenueCategorySetupForm: ContabilidadFiscalTabs,
  ModuleManager: ModulosTabs,
  ModuleHealthCenter: ModulosTabs,
  MarketplaceCatalog: ModulosTabs,
  PropertyAiScreen: InteligenciaArtificialTabs,
  AiToolRegistryScreen: InteligenciaArtificialTabs,
  AiPipelineStatusScreen: InteligenciaArtificialTabs,
  AiGovernanceScreen: InteligenciaArtificialTabs,
  AiPropertySetupForm: InteligenciaArtificialTabs,
  AuditLogViewer: SistemaTabs,
  WebhooksAdmin: SistemaTabs,
  DeveloperApps: SistemaTabs,
  ApiReferenceScreen: SistemaTabs,
  TenantAdminConsoleScreen: SistemaTabs,
  TenantDetailScreen: SistemaTabs,
  // --- Desarrollo (/desarrollo/*, guard isDevRouteAllowed) ---
  RevenueAutomationRules: RevenueAutomationRulesModule,
  ForecastSettings: ForecastSettingsModule,
  RevenueDataQuality: RevenueDataQualityModule,
  OnboardingProjects: OnboardingProjectListScreen,
  FileUploadAndClassification: FileUploadAndClassificationScreen,
  AIExtractionReview: AIExtractionReviewScreen,
  MigrationBatches: MigrationBatchScreen,
  CRMSettings: CRMSettingsModule,
  LoyaltySettings: LoyaltySettingsModule,
  GroupSettings: GroupSettingsModule,
  SalesSettings: SalesSettingsModule,
  WorkforceSettings: WorkforceSettingsModule,
  InventorySettings: InventorySettingsModule,
  ProcurementSettings: ProcurementSettingsModule,
  ReputationSettings: ReputationSettingsModule,
  SurveySettings: SurveySettingsModule,
  QualityWorkflowSettings: QualityWorkflowSettingsModule,
  EnergySettings: EnergySettingsModule,
  SafetySettings: SafetySettingsModule,
  ScheduledReports: ScheduledReportsModule,
  StyleGuideScreen,
  // ---------------------------------------------------------------------------
  // LEGACY_SCREEN_KEYS · the 24 aliases of NAV_TREE.aliases: old keys that deep
  // links, first-run chips and guide tours still emit, resolved to the SAME
  // component as their canonical key (routes/backoffice.routes.tsx maps them to
  // the canonical URL). tests/nav-tree-contract.test.mjs checks this block
  // against the tree.
  ChannelManagerDashboard: CanalesTabs,
  AutomationRules: RevenueAutomationRulesModule,
  RevenueRecommendationRules: RevenueRulesScreen,
  ImportReview: AIExtractionReviewScreen,
  OnboardingGoLiveReadiness: PuestaEnMarchaTabs,
  DepartmentManager: PropiedadTabs,
  RoomTypeManager: HabitacionesTabs,
  RoomInventoryManager: HabitacionesTabs,
  DocumentTemplateManager: ComunicacionesTabs,
  PropertySettings: PropiedadTabs,
  OrganizationSettings: PropiedadTabs,
  ChannelManagerSettings: CanalesTabs,
  CompetitorSet: RateShopperSettingsScreen,
  RevenueSettings: RatePlansScreen,
  IntegrationManager: ModulosTabs,
  IntegrationMarketplaceHome: ModulosTabs,
  ModuleConfigurationCenter: ModulosTabs,
  GuestRegisterFieldMapping: RegistroViajerosTabs,
  GuestSegments: ClientesTabs,
  CampaignManager: ClientesTabs,
  GuestPortalSettings: VentasAdicionalesTabs,
  KioskSettings: VentasAdicionalesTabs,
  UpsellSettings: VentasAdicionalesTabs,
  AIGovernanceSettings: InteligenciaArtificialTabs
};

// Type-only export: the registry itself stays private so no module can import
// it as a value (App.tsx imports every screen, which would be a real cycle).
// `lib/navigate.ts` re-exports this type for the typed `navigateTo` helper.
export type ScreenKey = keyof typeof SCREEN_COMPONENTS;

function isScreenKey(value: string): value is ScreenKey {
  return Object.prototype.hasOwnProperty.call(SCREEN_COMPONENTS, value);
}

// --- Session helpers ------------------------------------------------------

/**
 * Input of the /desarrollo/* guard for the current window and session: the
 * dev mode of the tab (`?dev=1`, tab flag or localStorage, navigation/dev-mode.ts)
 * and the real platform-admin flag of the role snapshot (never inferred from
 * permissions). The landing of the session lives in `useSessionLanding`
 * (navigation/useEnabledModules.ts): real tokens of the ACTIVE property.
 */
function devGuard(): DevGuardInput {
  return { search: window.location.search, storageValue: readDevModeStorage(), isPlatformAdmin: getSessionRoleSnapshot().isPlatformAdmin };
}

// --- Location → active route ----------------------------------------------

type ActiveRoute =
  | { kind: "screen"; screen: ScreenKey }
  /** `/`, `/backoffice` or a public URL: the shell lands on the role home once the session tokens are known. */
  | { kind: "landing"; pathname: string }
  | { kind: "dev-locked"; pathname: string }
  | { kind: "not-found"; pathname: string };

function screenRoute(screen: string, pathname: string): ActiveRoute {
  if (isScreenKey(screen)) return { kind: "screen", screen };
  if (import.meta.env.DEV) {
    console.warn(`[router] La URL "${pathname}" apunta a la clave "${screen}", que no está en SCREEN_COMPONENTS`);
  }
  return { kind: "not-found", pathname };
}

/**
 * Resolves window.location into the screen to render. Legacy /backoffice/*
 * paths are rewritten with replaceState (client-side 308, the old URL never
 * stays in history) without the `?query`/`#hash` id the new URL consumed;
 * `/`, `/backoffice` and public URLs resolve to `landing`: the URL is left
 * untouched here (AuthGate must still read /acceso/recuperar-contrasena when
 * there is no session) and the App writes the role home once
 * `useSessionLanding` knows the real tokens.
 */
function routeFromLocation(): ActiveRoute {
  const { pathname, search, hash } = window.location;
  syncDevModeFromLocation(search);
  const resolution = resolveLocation({ pathname, search, hash }, devGuard());
  if (resolution.kind === "home" || (resolution.kind === "screen" && resolution.route.public)) {
    return { kind: "landing", pathname };
  }
  if (resolution.kind === "screen") {
    if (resolution.redirect && normalizePathname(pathname) !== resolution.redirect) {
      const rest = stripLegacyId(search, hash, resolution.consumed);
      window.history.replaceState(null, "", resolution.redirect + rest.search + rest.hash);
    }
    return screenRoute(resolution.screen, resolution.redirect ?? pathname);
  }
  if (resolution.kind === "dev-locked") return { kind: "dev-locked", pathname: resolution.pathname };
  return { kind: "not-found", pathname: resolution.pathname };
}

/**
 * Nav targets may carry a `#hash` deep-link ("GroupsEventsDashboard#nuevo-grupo"):
 * only the base screen is a SCREEN_COMPONENTS key; the hash is handed to the
 * screen through the URL (see syncLocation). A retired key (the 72 of
 * NAV_TREE.retired) is redirected to the screen that covers it; a dev-only key
 * is refused outside dev mode; anything else warns and is dropped.
 */
function resolveScreenTarget(target: string): { screen: ScreenKey; hash: string } | null {
  const at = target.indexOf("#");
  const requested = at === -1 ? target : target.slice(0, at);
  const hash = at === -1 ? "" : target.slice(at);
  let screen = requested;
  if (!isScreenKey(screen)) {
    const cover = retiredScreenUrl(screen);
    const covering = cover ? screenFromPathname(cover) : null;
    if (covering && isScreenKey(covering)) {
      if (import.meta.env.DEV) {
        console.warn(`[hotelos-nav] La pantalla "${requested}" está retirada; se abre "${covering}" (${cover})`);
      }
      screen = covering;
    } else {
      if (import.meta.env.DEV) {
        console.warn(`[hotelos-nav] Unknown screen "${requested}" (target "${target}") is not registered in SCREEN_COMPONENTS`);
      }
      return null;
    }
  }
  if (isDevOnlyScreen(screen) && !isDevRouteAllowed(devGuard())) {
    if (import.meta.env.DEV) {
      console.warn(`[hotelos-nav] La pantalla "${screen}" solo está disponible en modo desarrollo para el administrador de la plataforma`);
    }
    return null;
  }
  if (!isScreenKey(screen)) return null;
  return { screen, hash };
}

// Must run before the screen state update so a freshly mounted screen finds
// the hash on mount. When the path does not change the screen may already be
// mounted, so the hash is assigned (fires `hashchange`) rather than replaced;
// a stale hash from an earlier deep-link is dropped when the target has none.
//
// A screen that pushed a legacy `/backoffice/*` path before dispatching
// `hotelos-nav` (old deep-link flows) gets the Tanda 5 URL written with
// replaceState: the old path never stays in history (client-side 308).
//
// The query is dropped on purpose (a filter of one screen means nothing on
// another) except `?dev=1`, which travels with every URL written by key so
// the «Desarrollo» group stays reachable (navigation/dev-mode.ts).
function syncLocation(screen: ScreenKey, hash: string) {
  const { pathname, search } = window.location;
  const dev = devQueryFrom(search);
  const nextPath = pathForScreen(screen);
  if (nextPath) {
    if (normalizePathname(pathname) !== nextPath) {
      if (isLegacyPath(pathname)) window.history.replaceState(null, "", nextPath + dev + hash);
      else window.history.pushState(null, "", nextPath + dev + hash);
      return;
    }
  } else {
    // Detail screen (`:id` URL): the caller wrote the concrete URL itself.
    const legacy = isLegacyPath(pathname) ? resolveLegacyLocation({ pathname, search, hash }) : null;
    if (legacy) {
      const rest = stripLegacyId(search, hash, legacy.consumed);
      window.history.replaceState(null, "", legacy.pathname + rest.search + rest.hash);
      return;
    }
    if (!pathnameBelongsToScreen(pathname, screen)) {
      // An old-style deep link carries the id in the query/hash
      // ("TenantDetailScreen#org=abc", "?guestId=…"): fill the sub-URL with the
      // key that names its entity (never a guest id into `:propiedad`).
      const pattern = urlPatternForScreen(screen);
      const firstParam = pattern?.match(/:([A-Za-z0-9_]+)/)?.[1] ?? null;
      const match = firstParam ? findLegacyId(search, hash, { param: firstParam, targetUrl: pattern }) : null;
      const concrete = match && firstParam ? urlForScreenWithParams(screen, { [firstParam]: match.value }) : null;
      if (concrete) {
        window.history.pushState(null, "", concrete + dev);
        return;
      }
      // Nothing concrete to show: land on the menu item that owns the screen.
      const itemUrl = itemUrlForScreen(screen);
      if (itemUrl && normalizePathname(pathname) !== itemUrl) {
        window.history.pushState(null, "", itemUrl + dev + hash);
        return;
      }
    }
  }
  if (window.location.hash === hash) return;
  if (hash) {
    window.location.hash = hash;
  } else {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

// Rendered instead of the shell when /users/me/properties is empty for the
// logged-in user: nothing is persisted, so we never fall back to the demo
// default property (which would 404 on every request).
function NoPropertiesScreen({ user }: { user: AuthUser }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24
      }}
    >
      <div role="status" style={{ maxWidth: 440, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Sin propiedades asignadas</h1>
        <p style={{ margin: "0 0 16px", opacity: 0.8, lineHeight: 1.5 }}>
          Tu usuario ({user.email ?? user.fullName}) no tiene acceso a ninguna propiedad. Pide a un
          administrador que te asigne una y vuelve a iniciar sesión.
        </p>
        <button type="button" className="bo-button-link" onClick={() => clearSession()}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

// /desarrollo/* reached without dev mode or without the platform admin: an
// honest notice with a way back (never a 403 and never a silent fallback).
function DevOnlyLockedScreen({ onHome }: { onHome: () => void }) {
  return (
    <div role="status" style={{ maxWidth: 520, margin: "48px auto", textAlign: "center", display: "grid", gap: 12 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Pantalla en desarrollo</h1>
      <p style={{ margin: 0, opacity: 0.8, lineHeight: 1.5 }}>
        Esta pantalla solo está disponible en modo desarrollo para el administrador de la plataforma.
      </p>
      <div>
        <CocoaButton variant="filled" tone="accent" onClick={onHome}>
          Ir a Mi día
        </CocoaButton>
      </div>
    </div>
  );
}

// Result of validating the stored active property for a given user. Keyed by
// userId so a fresh login (or a different user) always starts in "checking"
// on its very first render and the shell never mounts against a stale scope.
type ActivePropertyGate = { userId: string; status: "ready" | "empty" };

const PUBLIC_LOGIN_PATH = "/acceso";
const PUBLIC_FORGOT_PATH = "/acceso/recuperar-contrasena";

function initialAuthScreen(): "LoginScreen" | "ForgotPasswordScreen" {
  return normalizePathname(window.location.pathname) === PUBLIC_FORGOT_PATH ? "ForgotPasswordScreen" : "LoginScreen";
}

/**
 * AuthGate
 * --------
 * Reads the persisted user from auth-storage on mount and re-checks whenever a
 * "hotelos-auth-changed" event fires (login from LoginScreen, logout from
 * TopBar, or a 401 propagated from api-client). When there is no user we
 * render the LoginScreen / ForgotPasswordScreen instead of the protected app;
 * the two public URLs (/acceso, /acceso/recuperar-contrasena) pick the screen
 * on load, and switching between them writes the public URL only when the
 * location is already public, so a protected deep link survives the login.
 *
 * Once a user is present, the stored active property is validated against
 * GET /users/me/properties (ensureActiveProperty) BEFORE the children mount:
 * screens read the property id at module-evaluation time and some are
 * imported eagerly above, so a corrected selection requires a full reload.
 * The reload only fires when the persisted scope actually changed, and a
 * failed list request degrades to the stored value so login is never blocked.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getUser());
  const [authScreen, setAuthScreen] = useState<"LoginScreen" | "ForgotPasswordScreen">(() => initialAuthScreen());
  const [propertyGate, setPropertyGate] = useState<ActivePropertyGate | null>(null);
  const userId = user?.userId ?? null;

  useEffect(() => {
    return onAuthChange(() => setUser(getUser()));
  }, []);

  useEffect(() => {
    if (!userId) {
      setPropertyGate(null);
      return;
    }
    const current = getUser();
    if (!current || current.userId !== userId) return;
    let cancelled = false;
    ensureActiveProperty(current)
      .then((result) => {
        if (cancelled) return;
        if (result.changed) {
          window.location.reload();
          return;
        }
        setPropertyGate({ userId, status: result.empty ? "empty" : "ready" });
      })
      .catch(() => {
        // ensureActiveProperty already degrades to the stored value; this
        // guard only keeps an unexpected throw from locking the user out.
        if (!cancelled) setPropertyGate({ userId, status: "ready" });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function showAuthScreen(next: "LoginScreen" | "ForgotPasswordScreen") {
    setAuthScreen(next);
    const current = normalizePathname(window.location.pathname);
    if (current === PUBLIC_LOGIN_PATH || current === PUBLIC_FORGOT_PATH) {
      window.history.replaceState(null, "", next === "ForgotPasswordScreen" ? PUBLIC_FORGOT_PATH : PUBLIC_LOGIN_PATH);
    }
  }

  if (!user) {
    if (authScreen === "ForgotPasswordScreen") {
      return <ForgotPasswordScreen onNavigate={(screen) => {
        if (screen === "LoginScreen") showAuthScreen("LoginScreen");
      }} />;
    }
    return <LoginScreen onNavigate={(screen) => {
      if (screen === "ForgotPasswordScreen") showAuthScreen("ForgotPasswordScreen");
    }} />;
  }

  if (!propertyGate || propertyGate.userId !== user.userId) {
    return <LoadingBlock label="Comprobando tu propiedad…" />;
  }
  if (propertyGate.status === "empty") {
    return <NoPropertiesScreen user={user} />;
  }

  return <>{children}</>;
}

/**
 * Reports the role home of the session to the App. Mounted INSIDE the AuthGate
 * (a session exists and its active property is validated), so GET /users/me
 * is never requested before the login; unmounting (logout) clears the landing
 * so the next session never inherits the previous user's home.
 */
function SessionLandingSync({ onLanding }: { onLanding: (landing: LandingTarget | null) => void }) {
  const landing = useSessionLanding();
  useEffect(() => {
    onLanding(landing);
  }, [landing, onLanding]);
  useEffect(() => () => onLanding(null), [onLanding]);
  return null;
}

export function App() {
  const [route, setRoute] = useState<ActiveRoute>(() => routeFromLocation());
  const activeScreen = route.kind === "screen" ? route.screen : null;
  const ActiveScreen = useMemo(() => (activeScreen ? SCREEN_COMPONENTS[activeScreen] : null), [activeScreen]);
  // Role home of the session (§3), reported by <SessionLandingSync> from
  // inside the AuthGate: null without a session or while the profile of a
  // fresh login loads; a `landing` route waits for it instead of rewriting the
  // URL with the no-role home (Tanda 5 · L1c).
  const [landing, setLanding] = useState<LandingTarget | null>(null);

  useEffect(() => {
    if (route.kind !== "landing" || !landing) return;
    const { pathname, search, hash } = window.location;
    if (normalizePathname(pathname) !== landing.url) window.history.replaceState(null, "", landing.url + search + hash);
    setRoute(screenRoute(landing.screenKey, landing.url));
  }, [route, landing]);

  useEffect(() => {
    function handlePopState() {
      setRoute(routeFromLocation());
    }
    function handleHotelosNav(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      if (!detail) return;
      const target = resolveScreenTarget(detail);
      if (!target) return;
      // Screen guards (e.g. the rate grid editor with an unsaved draft) veto
      // a navigation with preventDefault (cancelable events from selectScreen)
      // or stopImmediatePropagation (any emitter). The event is dispatched on
      // `window` itself, so at-target listeners run in REGISTRATION order —
      // this listener (mounted with the shell) runs before any lazily mounted
      // screen's, capture flag or not. Decide once the synchronous dispatch is
      // over, when every listener has had its say.
      queueMicrotask(() => {
        if (event.defaultPrevented || event.cancelBubble) return;
        syncLocation(target.screen, target.hash);
        setRoute({ kind: "screen", screen: target.screen });
      });
    }
    // A login on a public URL (or on a protected deep link) re-resolves the
    // location once the session exists: /acceso lands on the role home.
    const unsubscribeAuth = onAuthChange(() => {
      if (getUser()) setRoute(routeFromLocation());
    });
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hotelos-nav", handleHotelosNav);
    return () => {
      unsubscribeAuth();
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hotelos-nav", handleHotelosNav);
    };
  }, []);

  // Sidebar / ⌘K / persona home: every shell-driven navigation goes through
  // the same `hotelos-nav` channel as `navigateTo()` so screen guards can
  // intercept it (RateGridEditorScreen cancels it while a draft is pending and
  // re-dispatches the same target once the user confirms). The listener above
  // performs the real switch (unknown screens still warn in resolveScreenTarget).
  function selectScreen(rawTarget: string) {
    window.dispatchEvent(new CustomEvent<string>("hotelos-nav", { detail: rawTarget, cancelable: true }));
  }

  let body: ReactNode;
  if (ActiveScreen) {
    body = <ActiveScreen />;
  } else if (route.kind === "landing") {
    body = <LoadingBlock label="Abriendo tu página de inicio…" />;
  } else if (route.kind === "dev-locked") {
    body = <DevOnlyLockedScreen onHome={() => selectScreen(landing?.screenKey ?? FALLBACK_LANDING_SCREEN)} />;
  } else {
    body = <CocoaNotFoundScreen />;
  }

  // Public auth flows (invitation acceptance, password reset, forced password
  // change) render INSTEAD of the protected shell: PublicAuthRoutes owns the
  // pathname/session check and only renders its children (the AuthGate) when
  // no public screen applies. The Cocoa global chrome (notification center,
  // preferences, about…) lives INSIDE the session: it unmounts on logout, so
  // no panel outlives the session on top of the login form and nothing polls
  // /notifications without a token.
  return (
    <ToastProvider>
      <PublicAuthRoutes>
        <AuthGate>
          <SessionLandingSync onLanding={setLanding} />
          {/* ⌘K belongs to the shell's CommandPalette (BackOfficeLayout); the Cocoa
              palette must not open on top of it (cierre 2026-09-15). */}
          <CocoaGlobalProvider commandPaletteHotkey={false}>
            <BackOfficeLayout activeScreen={activeScreen ?? ""} onSelect={selectScreen}>
              <Suspense fallback={<LoadingBlock label="Cargando pantalla…" />}>{body}</Suspense>
            </BackOfficeLayout>
          </CocoaGlobalProvider>
        </AuthGate>
      </PublicAuthRoutes>
      <ToastHost />
    </ToastProvider>
  );
}

export default App;
