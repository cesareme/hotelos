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
// Eager imports: critical-path screens and screens referenced at module scope
// (FiscalDashboard / ComplianceInbox are wrapped in module-scope wired
// components). Everything else is loaded lazily by route to keep the main
// bundle small.
import { BackOfficeDashboard } from "./screens/BackOfficeDashboard";
import { ComplianceInbox } from "./screens/fiscal/ComplianceInbox";
import { FiscalDashboard } from "./screens/fiscal/FiscalDashboard";
import { RoomRackScreen } from "./screens/operations/RoomRackScreen";
import { PersonaLandingScreen } from "./screens/operations/PersonaLandingScreen";
import { OperationsHomeScreen } from "./screens/operations/OperationsHomeScreen";
import { OwnerHomeScreen } from "./screens/owner/OwnerHomeScreen";
import { getActiveRole, roleHome } from "./navigation/roles";
import { BACKOFFICE_ROUTES } from "./routes/backoffice.routes";
import { makeModulePlaceholder } from "./screens/ModuleSettingsPlaceholder";
import { ToastProvider, ToastHost } from "./components/Toast";
import { CocoaGlobalProvider } from "./providers/CocoaGlobalProvider";
import { LoadingBlock } from "./components/States";
import "./styles.css";

// --- Lazy screen loaders ------------------------------------------------
// Helper to lazy-load a named export. We default it via .then() so React's
// lazy() (which expects { default: Component }) accepts it.
const lazyNamed = <T,>(loader: () => Promise<Record<string, T>>, name: string) =>
  lazy(() => loader().then((m) => ({ default: m[name] as unknown as ComponentType<unknown> })));

// settings / admin
const AccountingSettings = lazyNamed(() => import("./screens/AccountingSettings"), "AccountingSettings");
const AISettings = lazyNamed(() => import("./screens/AISettings"), "AISettings");
const AuditLogViewer = lazyNamed(() => import("./screens/AuditLogViewer"), "AuditLogViewer");
const BillingSettings = lazyNamed(() => import("./screens/BillingSettings"), "BillingSettings");
const GoLiveChecklist = lazyNamed(() => import("./screens/GoLiveChecklist"), "GoLiveChecklist");
const ModuleHealthCenter = lazyNamed(() => import("./screens/ModuleHealthCenter"), "ModuleHealthCenter");
const ModuleManager = lazyNamed(() => import("./screens/ModuleManager"), "ModuleManager");
const PaymentSettings = lazyNamed(() => import("./screens/PaymentSettings"), "PaymentSettings");
const PropertyMapper = lazyNamed(() => import("./screens/PropertyMapper"), "PropertyMapper");
const PropertySetupWizard = lazyNamed(() => import("./screens/PropertySetupWizard"), "PropertySetupWizard");
const TaxComplianceSettings = lazyNamed(() => import("./screens/TaxComplianceSettings"), "TaxComplianceSettings");
const UserRoleManager = lazyNamed(() => import("./screens/UserRoleManager"), "UserRoleManager");
const ChannelMappingsScreen = lazyNamed(() => import("./screens/ChannelMappingsScreen"), "ChannelMappingsScreen");
const DemandCalendarAdminScreen = lazyNamed(() => import("./screens/DemandCalendarAdminScreen"), "DemandCalendarAdminScreen");
const RateShopperSettingsScreen = lazyNamed(() => import("./screens/RateShopperSettingsScreen"), "RateShopperSettingsScreen");
const RevenueRulesScreen = lazyNamed(() => import("./screens/RevenueRulesScreen"), "RevenueRulesScreen");

// fiscal
const FiscalSubmissionsCenter = lazyNamed(() => import("./screens/fiscal/FiscalSubmissionsCenter"), "FiscalSubmissionsCenter");
const Modelo111Screen = lazyNamed(() => import("./screens/fiscal/Modelo111Screen"), "Modelo111Screen");
const Modelo115Screen = lazyNamed(() => import("./screens/fiscal/Modelo115Screen"), "Modelo115Screen");
const Modelo180Screen = lazyNamed(() => import("./screens/fiscal/Modelo180Screen"), "Modelo180Screen");
const Modelo303Screen = lazyNamed(() => import("./screens/fiscal/Modelo303Screen"), "Modelo303Screen");
const Modelo390Screen = lazyNamed(() => import("./screens/fiscal/Modelo390Screen"), "Modelo390Screen");
const TbaiForalScreen = lazyNamed(() => import("./screens/fiscal/TbaiForalScreen"), "TbaiForalScreen");

// operations (non-critical)
const FrontDeskDashboard = lazyNamed(() => import("./screens/operations/FrontDeskDashboard"), "FrontDeskDashboard");
const GroupsCalendarScreen = lazyNamed(() => import("./screens/operations/GroupsCalendarScreen"), "GroupsCalendarScreen");
const HousekeepingDashboard = lazyNamed(() => import("./screens/operations/HousekeepingDashboard"), "HousekeepingDashboard");
const MaintenanceDashboard = lazyNamed(() => import("./screens/operations/MaintenanceDashboard"), "MaintenanceDashboard");
const FinancePositionDashboard = lazyNamed(() => import("./screens/operations/FinancePositionDashboard"), "FinancePositionDashboard");
const ConciergeInboxDashboard = lazyNamed(() => import("./screens/operations/ConciergeInboxDashboard"), "ConciergeInboxDashboard");
const ReceptionCopilotScreen = lazyNamed(() => import("./screens/operations/ReceptionCopilotScreen"), "ReceptionCopilotScreen");
const ReputationDashboard = lazyNamed(() => import("./screens/operations/ReputationDashboard"), "ReputationDashboard");
const SalesPipelineDashboard = lazyNamed(() => import("./screens/operations/SalesPipelineDashboard"), "SalesPipelineDashboard");
const WorkforceDashboard = lazyNamed(() => import("./screens/operations/WorkforceDashboard"), "WorkforceDashboard");
const CrmDashboard = lazyNamed(() => import("./screens/operations/CrmDashboard"), "CrmDashboard");
const LoyaltyDashboard = lazyNamed(() => import("./screens/operations/LoyaltyDashboard"), "LoyaltyDashboard");
const UpsellsDashboard = lazyNamed(() => import("./screens/operations/UpsellsDashboard"), "UpsellsDashboard");
const SurveysDashboard = lazyNamed(() => import("./screens/operations/SurveysDashboard"), "SurveysDashboard");
const QualityDashboard = lazyNamed(() => import("./screens/operations/QualityDashboard"), "QualityDashboard");
const SafetyDashboard = lazyNamed(() => import("./screens/operations/SafetyDashboard"), "SafetyDashboard");
const InventoryDashboard = lazyNamed(() => import("./screens/operations/InventoryDashboard"), "InventoryDashboard");
const ProcurementDashboard = lazyNamed(() => import("./screens/operations/ProcurementDashboard"), "ProcurementDashboard");
const GroupsEventsDashboard = lazyNamed(() => import("./screens/operations/GroupsEventsDashboard"), "GroupsEventsDashboard");
const PosDashboard = lazyNamed(() => import("./screens/operations/PosDashboard"), "PosDashboard");
const ChannelPerformanceDashboard = lazyNamed(() => import("./screens/operations/ChannelPerformanceDashboard"), "ChannelPerformanceDashboard");
const EnergyDashboard = lazyNamed(() => import("./screens/operations/EnergyDashboard"), "EnergyDashboard");
const SustainabilityDashboard = lazyNamed(() => import("./screens/operations/SustainabilityDashboard"), "SustainabilityDashboard");
const AssetsDashboard = lazyNamed(() => import("./screens/operations/AssetsDashboard"), "AssetsDashboard");
const RoomProfitabilityDashboard = lazyNamed(() => import("./screens/operations/RoomProfitabilityDashboard"), "RoomProfitabilityDashboard");
const AnalyticsCenterDashboard = lazyNamed(() => import("./screens/operations/AnalyticsCenterDashboard"), "AnalyticsCenterDashboard");
const HousekeepingMobileScreen = lazyNamed(() => import("./screens/operations/HousekeepingMobileScreen"), "HousekeepingMobileScreen");
const FrontDeskCopilotScreen = lazyNamed(() => import("./screens/operations/FrontDeskCopilotScreen"), "FrontDeskCopilotScreen");
const NightAuditScreen = lazyNamed(() => import("./screens/operations/NightAuditScreen"), "NightAuditScreen");
const MaintenanceMobileScreen = lazyNamed(() => import("./screens/operations/MaintenanceMobileScreen"), "MaintenanceMobileScreen");
const ShiftManagerScreen = lazyNamed(() => import("./screens/operations/ShiftManagerScreen"), "ShiftManagerScreen");
const GeneralManagerScreen = lazyNamed(() => import("./screens/operations/GeneralManagerScreen"), "GeneralManagerScreen");
const OperationsDirectorScreen = lazyNamed(() => import("./screens/operations/OperationsDirectorScreen"), "OperationsDirectorScreen");
const PersonaGuideScreen = lazyNamed(() => import("./screens/operations/PersonaGuideScreen"), "PersonaGuideScreen");
const PortfolioDashboard = lazyNamed(() => import("./screens/operations/PortfolioDashboard"), "PortfolioDashboard");
const PropertyDetailScreen = lazyNamed(() => import("./screens/operations/PropertyDetailScreen"), "PropertyDetailScreen");

// guests / banking / finance / commissions / payroll / notifications
const GuestTimelineScreen = lazyNamed(() => import("./screens/guests/GuestTimelineScreen"), "GuestTimelineScreen");
const BankReconciliationScreen = lazyNamed(() => import("./screens/banking/BankReconciliationScreen"), "BankReconciliationScreen");
const TrialBalanceScreen = lazyNamed(() => import("./screens/finance/TrialBalanceScreen"), "TrialBalanceScreen");
const BalanceSheetScreen = lazyNamed(() => import("./screens/finance/BalanceSheetScreen"), "BalanceSheetScreen");
const CashFlowScreen = lazyNamed(() => import("./screens/finance/CashFlowScreen"), "CashFlowScreen");
const CommissionsScreen = lazyNamed(() => import("./screens/commissions/CommissionsScreen"), "CommissionsScreen");
const PayrollScreen = lazyNamed(() => import("./screens/payroll/PayrollScreen"), "PayrollScreen");
const ExchangeRatesScreen = lazyNamed(() => import("./screens/finance/ExchangeRatesScreen"), "ExchangeRatesScreen");
const YearEndCloseScreen = lazyNamed(() => import("./screens/finance/YearEndCloseScreen"), "YearEndCloseScreen");
const NotificationsScreen = lazyNamed(() => import("./screens/notifications/NotificationsScreen"), "NotificationsScreen");

// channel manager / compliance / admin
const ChannelAggregatorHub = lazyNamed(() => import("./screens/channelManager/ChannelAggregatorHub"), "ChannelAggregatorHub");
const GdprRequestsScreen = lazyNamed(() => import("./screens/compliance/GdprRequestsScreen"), "GdprRequestsScreen");
const ComplianceCenterScreen = lazyNamed(() => import("./screens/compliance/ComplianceCenterScreen"), "ComplianceCenterScreen");
const CancellationPoliciesScreen = lazyNamed(() => import("./screens/admin/CancellationPoliciesScreen"), "CancellationPoliciesScreen");
const AllotmentsScreen = lazyNamed(() => import("./screens/admin/AllotmentsScreen"), "AllotmentsScreen");
const FnbInventoryScreen = lazyNamed(() => import("./screens/admin/FnbInventoryScreen"), "FnbInventoryScreen");
const FnbMenuScreen = lazyNamed(() => import("./screens/admin/FnbMenuScreen"), "FnbMenuScreen");
const FolioRoutingScreen = lazyNamed(() => import("./screens/admin/FolioRoutingScreen"), "FolioRoutingScreen");
const TouristTaxScreen = lazyNamed(() => import("./screens/admin/TouristTaxScreen"), "TouristTaxScreen");
const RatePlansScreen = lazyNamed(() => import("./screens/admin/RatePlansScreen"), "RatePlansScreen");
const TenantAdminConsoleScreen = lazyNamed(() => import("./screens/admin/TenantAdminConsoleScreen"), "TenantAdminConsoleScreen");
// TenantDetailScreen takes required props (`orgId`, `onClose`), so we lazy-load
// it with its real type instead of using `lazyNamed` (which erases props to
// ComponentType<unknown>). The wrapper below feeds the props from the URL hash.
const TenantDetailScreen = lazy(() =>
  import("./screens/admin/TenantDetailScreen").then((m) => ({ default: m.TenantDetailScreen }))
);
const AssistantChatScreen = lazyNamed(() => import("./screens/assistant/AssistantChatScreen"), "AssistantChatScreen");

// developer / marketplace
const WebhooksAdminScreen = lazyNamed(() => import("./screens/developer/WebhooksAdminScreen"), "WebhooksAdminScreen");
const ApiReferenceScreen = lazyNamed(() => import("./screens/developer/ApiReferenceScreen"), "ApiReferenceScreen");
const DeveloperAppsScreen = lazyNamed(() => import("./screens/developer/DeveloperAppsScreen"), "DeveloperAppsScreen");
const MarketplaceCatalogScreen = lazyNamed(() => import("./screens/marketplace/MarketplaceCatalogScreen"), "MarketplaceCatalogScreen");

// modules / sustainability / fiscal / etc
const UpsellsSettingsScreen = lazyNamed(() => import("./screens/upsells/UpsellsSettingsScreen"), "UpsellsSettingsScreen");
const MessagingConnectionsScreen = lazyNamed(() => import("./screens/messaging/MessagingConnectionsScreen"), "MessagingConnectionsScreen");
const EsrsReportScreen = lazyNamed(() => import("./screens/esrs/EsrsReportScreen"), "EsrsReportScreen");
const BankingSpainScreen = lazyNamed(() => import("./screens/banking/BankingSpainScreen"), "BankingSpainScreen");
const GuestSegmentsScreen = lazyNamed(() => import("./screens/crm/GuestSegmentsScreen"), "GuestSegmentsScreen");
const LoyaltyProgramScreen = lazyNamed(() => import("./screens/loyalty/LoyaltyProgramScreen"), "LoyaltyProgramScreen");
const GuestPortalSettingsScreen = lazyNamed(() => import("./screens/guest-portal/GuestPortalSettingsScreen"), "GuestPortalSettingsScreen");
const EnergyMeteringScreen = lazyNamed(() => import("./screens/energy/EnergyMeteringScreen"), "EnergyMeteringScreen");
const CampaignManagerScreen = lazyNamed(() => import("./screens/marketing/CampaignManagerScreen"), "CampaignManagerScreen");
const SurveysNpsScreen = lazyNamed(() => import("./screens/surveys/SurveysNpsScreen"), "SurveysNpsScreen");
const QualityCasesScreen = lazyNamed(() => import("./screens/quality/QualityCasesScreen"), "QualityCasesScreen");
const KioskSettingsScreen = lazyNamed(() => import("./screens/kiosk/KioskSettingsScreen"), "KioskSettingsScreen");
const InvoiceRectificationsScreen = lazyNamed(() => import("./screens/invoicing/InvoiceRectificationsScreen"), "InvoiceRectificationsScreen");

// aiOperations
const AiToolRegistryScreen = lazyNamed(() => import("./screens/aiOperations/AiToolRegistryScreen"), "AiToolRegistryScreen");
const AiPipelineStatusScreen = lazyNamed(() => import("./screens/aiOperations/AiPipelineStatusScreen"), "AiPipelineStatusScreen");
const AiGovernanceScreen = lazyNamed(() => import("./screens/aiOperations/AiGovernanceScreen"), "AiGovernanceScreen");
const AiHumanReviewQueueScreen = lazyNamed(() => import("./screens/aiOperations/AiHumanReviewQueueScreen"), "AiHumanReviewQueueScreen");
const PropertyAiScreen = lazyNamed(() => import("./screens/aiOperations/PropertyAiScreen"), "PropertyAiScreen");
const AiOwnerSummaryScreen = lazyNamed(() => import("./screens/aiOperations/AiOwnerSummaryScreen"), "AiOwnerSummaryScreen");
const EmailConnectorsScreen = lazyNamed(() => import("./screens/aiOperations/EmailConnectorsScreen"), "EmailConnectorsScreen");

// revenue (feature dir → its own chunk)
const RevenueComparisonDashboard = lazyNamed(() => import("./screens/revenue/RevenueComparisonDashboard"), "RevenueComparisonDashboard");
const RevenueExportCenter = lazyNamed(() => import("./screens/revenue/RevenueExportCenter"), "RevenueExportCenter");
const RevenueForecastExplorer = lazyNamed(() => import("./screens/revenue/RevenueForecastExplorer"), "RevenueForecastExplorer");
const RevenueHistoryForecastDashboard = lazyNamed(() => import("./screens/revenue/RevenueHistoryForecastDashboard"), "RevenueHistoryForecastDashboard");
const RevenueHistoryForecastReport = lazyNamed(() => import("./screens/revenue/RevenueHistoryForecastReport"), "RevenueHistoryForecastReport");
const RevenueHomeDashboard = lazyNamed(() => import("./screens/revenue/RevenueHomeDashboard"), "RevenueHomeDashboard");
const RevenueMeetingScreen = lazyNamed(() => import("./screens/revenue/RevenueMeetingScreen"), "RevenueMeetingScreen");
const RateGridEditorScreen = lazyNamed(() => import('./screens/revenue/RateGridEditorScreen'), 'RateGridEditorScreen');
const RateJournalScreen = lazyNamed(() => import('./screens/revenue/RateJournalScreen'), 'RateJournalScreen');

// backoffice
const SetupCenterScreen = lazyNamed(() => import("./screens/backoffice/SetupCenterScreen"), "SetupCenterScreen");
const ConfigurationCenterScreen = lazyNamed(() => import("./screens/backoffice/ConfigurationCenterScreen"), "ConfigurationCenterScreen");
const ConfigurationPropertyProfileForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/PropertyProfileForm"), "PropertyProfileForm");
const ConfigurationBuildingForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/BuildingForm"), "BuildingForm");
const ConfigurationFloorForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/FloorForm"), "FloorForm");
const ConfigurationZoneForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/ZoneForm"), "ZoneForm");
const ConfigurationRoomTypeForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/RoomTypeForm"), "RoomTypeForm");
const ConfigurationRoomForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/RoomForm"), "RoomForm");
const ConfigurationSpaceResourceForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/SpaceResourceForm"), "SpaceResourceForm");
const ConfigurationDepartmentForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/DepartmentForm"), "DepartmentForm");
const ConfigurationHousekeepingSetupForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/HousekeepingSetupForm"), "HousekeepingSetupForm");
const ConfigurationMaintenanceSetupForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/MaintenanceSetupForm"), "MaintenanceSetupForm");
const ConfigurationRevenueCategorySetupForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/RevenueCategorySetupForm"), "RevenueCategorySetupForm");
const ConfigurationComplianceSetupForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/ComplianceSetupForm"), "ComplianceSetupForm");
const ConfigurationAISetupForm = lazyNamed(() => import("./screens/backoffice/configuration/forms/AISetupForm"), "AISetupForm");
const CustomFieldManagerScreen = lazyNamed(() => import("./screens/backoffice/CustomFieldManagerScreen"), "CustomFieldManagerScreen");
const CategoryManagerScreen = lazyNamed(() => import("./screens/backoffice/categories/CategoryManagerScreen"), "CategoryManagerScreen");
const CategoryDetailScreen = lazyNamed(() => import("./screens/backoffice/categories/CategoryDetailScreen"), "CategoryDetailScreen");
const CategoryOptionForm = lazyNamed(() => import("./screens/backoffice/categories/CategoryOptionForm"), "CategoryOptionForm");

// guest journey / timeline / setup / billing / reports / reservations
const GuestJourneyWorkspace = lazyNamed(() => import("./screens/guestJourney/GuestJourneyWorkspace"), "GuestJourneyWorkspace");
const LiveTimelineWorkspace = lazyNamed(() => import("./screens/timeline/LiveTimelineWorkspace"), "LiveTimelineWorkspace");
const ManualSetupHubScreen = lazyNamed(() => import("./screens/manualSetup/ManualSetupHubScreen"), "ManualSetupHubScreen");
const BillingCenterScreen = lazyNamed(() => import("./screens/billing/BillingCenterScreen"), "BillingCenterScreen");
const FolioDetailScreen = lazyNamed(() => import("./screens/billing/FolioDetailScreen"), "FolioDetailScreen");
const ReportingCenterScreen = lazyNamed(() => import("./screens/reports/ReportingCenterScreen"), "ReportingCenterScreen");
const ReservationCreateScreen = lazyNamed(() => import("./screens/reservations/ReservationCreateScreen"), "ReservationCreateScreen");
const ReservationWorkspaceScreen = lazyNamed(() => import("./screens/reservations/ReservationWorkspaceScreen"), "ReservationWorkspaceScreen");
const ReservationDetailWorkspaceScreen = lazyNamed(() => import("./screens/reservations/ReservationWorkspaceScreen"), "ReservationDetailWorkspaceScreen");
const ReservationsListScreen = lazyNamed(() => import("./screens/reservations/ReservationsListScreen"), "ReservationsListScreen");
const GuestsListScreen = lazyNamed(() => import("./screens/guests/GuestsListScreen"), "GuestsListScreen");
const GuestProfileScreen = lazyNamed(() => import("./screens/guests/GuestProfileScreen"), "GuestProfileScreen");
const ReservationAgentScreen = lazyNamed(() => import("./screens/reservations/ReservationAgentScreen"), "ReservationAgentScreen");

// property-setup multi-export module (one chunk for all forms)
const PropertySetupHomeScreen = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "PropertySetupHomeScreen");
const PropertyProfileSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "PropertyProfileSetupForm");
const BuildingSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "BuildingSetupForm");
const FloorSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "FloorSetupForm");
const ZoneSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "ZoneSetupForm");
const RoomTypeSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "RoomTypeSetupForm");
const RoomSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "RoomSetupForm");
const SpaceResourceSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "SpaceResourceSetupForm");
const DepartmentSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "DepartmentSetupForm");
const HousekeepingSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "HousekeepingSetupForm");
const MaintenanceSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "MaintenanceSetupForm");
const RevenueCategorySetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "RevenueCategorySetupForm");
const FinanceComplianceSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "FinanceComplianceSetupForm");
const AiPropertySetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "AiPropertySetupForm");
const CustomFieldSetupForm = lazyNamed(() => import("./screens/propertySetup/PropertySetupForms"), "CustomFieldSetupForm");

// compliance secondary
const AuthorityRoutingSettingsScreen = lazyNamed(() => import("./screens/compliance/AuthorityRoutingSettingsScreen"), "AuthorityRoutingSettingsScreen");
const GuestRegisterRetentionSettingsScreen = lazyNamed(() => import("./screens/compliance/GuestRegisterRetentionSettingsScreen"), "GuestRegisterRetentionSettingsScreen");
const GuestRegisterSettingsScreen = lazyNamed(() => import("./screens/compliance/GuestRegisterSettingsScreen"), "GuestRegisterSettingsScreen");
const SesHospedajesSettingsScreen = lazyNamed(() => import("./screens/compliance/SesHospedajesSettingsScreen"), "SesHospedajesSettingsScreen");
// Tanda 3 (lote front-fiscal): IVA/IGIC/IPSI profile per property.
const PropertyTaxesScreen = lazyNamed(() => import("./screens/compliance/PropertyTaxesScreen"), "PropertyTaxesScreen");

// onboarding multi-export module (one chunk for all onboarding screens)
const AIExtractionReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "AIExtractionReviewScreen");
const AISetupCenterScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "AISetupCenterScreen");
const ChannelMappingReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "ChannelMappingReviewScreen");
const ComplianceSetupReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "ComplianceSetupReviewScreen");
const CutoverAssistantScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "CutoverAssistantScreen");
const DataQualityReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "DataQualityReviewScreen");
const DryRunResultScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "DryRunResultScreen");
const FileUploadAndClassificationScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "FileUploadAndClassificationScreen");
const GuestImportReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "GuestImportReviewScreen");
const MigrationBatchScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "MigrationBatchScreen");
const OnboardingProjectDetailScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "OnboardingProjectDetailScreen");
const OnboardingProjectListScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "OnboardingProjectListScreen");
const PropertyBlueprintReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "PropertyBlueprintReviewScreen");
const RatePlanMappingReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "RatePlanMappingReviewScreen");
const ReservationImportReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "ReservationImportReviewScreen");
const RevenueHistoryImportReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "RevenueHistoryImportReviewScreen");
const RoomMappingReviewScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "RoomMappingReviewScreen");
const SourceConnectionScreen = lazyNamed(() => import("./screens/onboarding/OnboardingScreens"), "SourceConnectionScreen");

const SETUP_AI_LABEL = "Abrir configuración de IA";
const CRMSettingsModule = makeModulePlaceholder({ moduleName: "CRM", dashboardScreen: "CrmDashboard", dashboardLabel: "Abrir tablero CRM", relatedScreens: [{ label: "Configuración de huéspedes", screen: "PropertyProfileSetupForm" }] });
const LoyaltySettingsModule = makeModulePlaceholder({ moduleName: "Fidelización", dashboardScreen: "LoyaltyDashboard", dashboardLabel: "Abrir tablero de fidelización" });
const DuplicateGuestReviewModule = makeModulePlaceholder({ moduleName: "Revisión de duplicados", dashboardScreen: "CrmDashboard", dashboardLabel: "Abrir tablero CRM", setupScreen: "AISetupCenter", setupLabel: SETUP_AI_LABEL });
const SalesPipelineModule = makeModulePlaceholder({ moduleName: "Pipeline de ventas", dashboardScreen: "SalesPipelineDashboard", dashboardLabel: "Abrir pipeline de ventas" });
const CorporateAccountsModule = makeModulePlaceholder({ moduleName: "Cuentas corporativas", dashboardScreen: "SalesPipelineDashboard", dashboardLabel: "Abrir pipeline de ventas" });
const GroupSettingsModule = makeModulePlaceholder({ moduleName: "Grupos", dashboardScreen: "GroupsEventsDashboard", dashboardLabel: "Abrir grupos y eventos" });
const EventSpacesSettingsModule = makeModulePlaceholder({ moduleName: "Espacios para eventos", dashboardScreen: "GroupsEventsDashboard", dashboardLabel: "Abrir grupos y eventos" });
const SalesSettingsModule = makeModulePlaceholder({ moduleName: "Ajustes de ventas", dashboardScreen: "SalesPipelineDashboard", dashboardLabel: "Abrir pipeline de ventas" });
const WorkforceSettingsModule = makeModulePlaceholder({ moduleName: "Personal", dashboardScreen: "WorkforceDashboard", dashboardLabel: "Abrir tablero de personal", setupScreen: "DepartmentSetupForm", setupLabel: "Configurar departamentos" });
const SchedulingRulesModule = makeModulePlaceholder({ moduleName: "Reglas de turnos", dashboardScreen: "WorkforceDashboard", dashboardLabel: "Abrir tablero de personal" });
const PayrollExportSettingsModule = makeModulePlaceholder({ moduleName: "Exportación de nóminas", dashboardScreen: "WorkforceDashboard", dashboardLabel: "Abrir tablero de personal" });
const SupplierSettingsModule = makeModulePlaceholder({ moduleName: "Proveedores", dashboardScreen: "ProcurementDashboard", dashboardLabel: "Abrir tablero de compras" });
const InventorySettingsModule = makeModulePlaceholder({ moduleName: "Inventario", dashboardScreen: "InventoryDashboard", dashboardLabel: "Abrir tablero de inventario" });
const ProcurementSettingsModule = makeModulePlaceholder({ moduleName: "Compras", dashboardScreen: "ProcurementDashboard", dashboardLabel: "Abrir tablero de compras" });
const ProcurementRulesModule = makeModulePlaceholder({ moduleName: "Reglas de compras", dashboardScreen: "ProcurementDashboard", dashboardLabel: "Abrir tablero de compras" });
const DigitalKeySettingsModule = makeModulePlaceholder({ moduleName: "Llave digital", dashboardScreen: "GuestJourneyWorkspace", dashboardLabel: "Abrir recorrido del huésped" });
const ReputationSettingsModule = makeModulePlaceholder({ moduleName: "Reputación", dashboardScreen: "ReputationDashboard", dashboardLabel: "Abrir tablero de reputación" });
const SurveySettingsModule = makeModulePlaceholder({ moduleName: "Encuestas", dashboardScreen: "SurveysDashboard", dashboardLabel: "Abrir Encuestas / NPS" });
const QualityWorkflowSettingsModule = makeModulePlaceholder({ moduleName: "Flujo de calidad", dashboardScreen: "QualityDashboard", dashboardLabel: "Abrir casos de calidad" });
const EnergySettingsModule = makeModulePlaceholder({ moduleName: "Energía", dashboardScreen: "EnergyDashboard", dashboardLabel: "Abrir tablero de energía" });
const MeterSettingsModule = makeModulePlaceholder({ moduleName: "Contadores", dashboardScreen: "EnergyDashboard", dashboardLabel: "Abrir tablero de energía" });
const SustainabilitySettingsModule = makeModulePlaceholder({ moduleName: "Sostenibilidad", dashboardScreen: "SustainabilityDashboard", dashboardLabel: "Abrir tablero de sostenibilidad" });
const SafetySettingsModule = makeModulePlaceholder({ moduleName: "Seguridad", dashboardScreen: "SafetyDashboard", dashboardLabel: "Abrir tablero de seguridad" });
const IncidentSettingsModule = makeModulePlaceholder({ moduleName: "Incidentes", dashboardScreen: "SafetyDashboard", dashboardLabel: "Abrir tablero de seguridad" });
const IncidentWorkflowSettingsModule = makeModulePlaceholder({ moduleName: "Flujo de incidentes", dashboardScreen: "SafetyDashboard", dashboardLabel: "Abrir tablero de seguridad" });
const EmergencyContactsSettingsModule = makeModulePlaceholder({ moduleName: "Contactos de emergencia", dashboardScreen: "SafetyDashboard", dashboardLabel: "Abrir tablero de seguridad" });
const AnalyticsSettingsModule = makeModulePlaceholder({ moduleName: "Analítica", dashboardScreen: "AnalyticsCenterDashboard", dashboardLabel: "Abrir centro de analítica" });
const MetricDefinitionsModule = makeModulePlaceholder({ moduleName: "Definiciones de métricas", dashboardScreen: "AnalyticsCenterDashboard", dashboardLabel: "Abrir centro de analítica" });
const ScheduledReportsModule = makeModulePlaceholder({ moduleName: "Informes programados", dashboardScreen: "AnalyticsCenterDashboard", dashboardLabel: "Abrir centro de analítica", relatedScreens: [{ label: "Centro de informes", screen: "ReportingCenter" }] });
const DeveloperPortalModule = makeModulePlaceholder({ moduleName: "Plataforma de desarrollador", dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría", status: "warn", statusLabel: "vista previa" });
const ApiAppsModule = makeModulePlaceholder({ moduleName: "Apps de API", dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría", status: "warn", statusLabel: "vista previa" });
const WebhooksModule = makeModulePlaceholder({ moduleName: "Webhooks", dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría", status: "warn", statusLabel: "vista previa" });
const WebhookSubscriptionsModule = makeModulePlaceholder({ moduleName: "Suscripciones de webhooks", dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría", status: "warn", statusLabel: "vista previa" });
const ApiUsageLogsModule = makeModulePlaceholder({ moduleName: "Registros de uso de API", dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría" });
const PartnerCertificationModule = makeModulePlaceholder({ moduleName: "Certificación de partners", dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría", status: "warn", statusLabel: "vista previa" });
const AIToolRegistryModule = makeModulePlaceholder({ moduleName: "Catálogo de herramientas de IA", setupScreen: "AISetupCenter", setupLabel: SETUP_AI_LABEL });
const AIPromptVersionsModule = makeModulePlaceholder({ moduleName: "Versiones de prompts de IA", setupScreen: "AISetupCenter", setupLabel: SETUP_AI_LABEL });
const AIEvaluationsModule = makeModulePlaceholder({ moduleName: "Evaluaciones de IA", setupScreen: "AISetupCenter", setupLabel: SETUP_AI_LABEL });
const AIIncidentLogModule = makeModulePlaceholder({ moduleName: "Registro de incidentes de IA", setupScreen: "AISetupCenter", setupLabel: SETUP_AI_LABEL, dashboardScreen: "AuditLogViewer", dashboardLabel: "Abrir registro de auditoría" });
const AIHumanReviewQueueModule = makeModulePlaceholder({ moduleName: "Cola de revisión humana", setupScreen: "AISetupCenter", setupLabel: SETUP_AI_LABEL });
const AICostDashboardModule = makeModulePlaceholder({ moduleName: "Costes de IA", dashboardScreen: "AnalyticsCenterDashboard", dashboardLabel: "Abrir centro de analítica" });
// Tanda 3: former ScreenScaffold stubs (English copy + invented status) with no
// backing endpoint yet. They are honest placeholders now (admin-only entries in
// Sidebar "Configuracion avanzada · Próximamente") that point at the real
// revenue surfaces. Scaffold files RevenueAutomationRulesScreen.tsx,
// RevenueDataQualityScreen.tsx and ForecastSettingsScreen.tsx are no longer
// imported.
const RevenueAutomationRulesModule = makeModulePlaceholder({ moduleName: "Reglas de automatización de revenue", summary: "Automatización de tarifas y restricciones con umbrales de aprobación. Hoy las reglas se gestionan desde Reglas de revenue.", dashboardScreen: "RevenueRules", dashboardLabel: "Abrir reglas de revenue" });
const RevenueDataQualityModule = makeModulePlaceholder({ moduleName: "Calidad de datos de revenue", summary: "Comprobaciones de preparación (snapshots, mapeos, planes tarifarios, confianza del forecast) antes de emitir recomendaciones.", dashboardScreen: "RevenueHomeDashboard", dashboardLabel: "Abrir inicio de revenue" });
const ForecastSettingsModule = makeModulePlaceholder({ moduleName: "Ajustes de forecast", summary: "Horizonte, modelo y umbrales de confianza de la previsión. La precisión del forecast se consulta en el explorador.", dashboardScreen: "RevenueForecastExplorer", dashboardLabel: "Abrir explorador de forecast" });

const FiscalDashboardWired = () => <FiscalDashboard onNavigate={(s) => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: s }))} />;
const ComplianceInboxWired = () => <ComplianceInbox onNavigate={(s) => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: s }))} />;
// TenantDetailScreen requires an `orgId` prop (the tenant to display). When
// landed on directly from a sidebar entry / deep link we read the id from the
// URL hash (e.g. `#org=abc-123`); without one we surface a notice that points
// users back to the Tenant Admin Console, which is how this drawer normally
// opens. `onClose` navigates back to the console.
const TenantDetailScreenWired = () => {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const match = /[#&]org=([^&]+)/.exec(hash);
  const orgId = match ? decodeURIComponent(match[1]) : "";
  const goBack = () => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "TenantAdminConsoleScreen" }));
  if (!orgId) {
    return (
      <div style={{ padding: "24px" }}>
        <p>Selecciona un tenant desde la Consola de tenants para ver su detalle.</p>
        <button type="button" onClick={goBack}>Abrir Consola de tenants</button>
      </div>
    );
  }
  return <TenantDetailScreen orgId={orgId} onClose={goBack} />;
};

const SCREEN_COMPONENTS = {
  LoginScreen,
  ForgotPasswordScreen,
  AccountingSettings,
  AISettings,
  AuditLogViewer,
  BackOfficeDashboard,
  ComplianceInbox: ComplianceInboxWired,
  FiscalDashboard: FiscalDashboardWired,
  FiscalSubmissionsCenter,
  Modelo111Screen,
  Modelo115Screen,
  Modelo180Screen,
  Modelo303Screen,
  Modelo390Screen,
  RoomRackScreen,
  HousekeepingMobileScreen,
  GuestTimelineScreen,
  FrontDeskCopilotScreen,
  NightAuditScreen,
  MaintenanceMobileScreen,
  ShiftManagerScreen,
  GeneralManagerScreen,
  OperationsDirectorScreen,
  PersonaLandingScreen,
  PersonaGuideScreen,
  HousekeepingDashboard,
  MaintenanceDashboard,
  FinancePositionDashboard,
  ConciergeInboxDashboard,
  ReceptionCopilotScreen,
  ReputationDashboard,
  SalesPipelineDashboard,
  WorkforceDashboard,
  CrmDashboard,
  LoyaltyDashboard,
  UpsellsDashboard,
  SurveysDashboard,
  QualityDashboard,
  SafetyDashboard,
  InventoryDashboard,
  ProcurementDashboard,
  GroupsEventsDashboard,
  GroupsCalendarScreen,
  PosDashboard,
  ChannelPerformanceDashboard,
  EnergyDashboard,
  SustainabilityDashboard,
  AssetsDashboard,
  RoomProfitabilityDashboard,
  AnalyticsCenterDashboard,
  FrontDeskDashboard,
  OperationsHome: OperationsHomeScreen,
  OwnerHome: OwnerHomeScreen,
  PortfolioDashboard,
  PropertyDetailScreen,
  BankReconciliationScreen,
  TrialBalanceScreen,
  BalanceSheetScreen,
  CashFlowScreen,
  CommissionsScreen,
  PayrollScreen,
  ExchangeRatesScreen,
  YearEndCloseScreen,
  NotificationsScreen,
  ChannelAggregatorHub,
  GdprRequestsScreen,
  ComplianceCenter: ComplianceCenterScreen,
  CancellationPolicies: CancellationPoliciesScreen,
  Allotments: AllotmentsScreen,
  FnbInventory: FnbInventoryScreen,
  FnbMenu: FnbMenuScreen,
  FolioRouting: FolioRoutingScreen,
  TouristTax: TouristTaxScreen,
  RatePlans: RatePlansScreen,
  TenantAdminConsoleScreen,
  TenantDetailScreen: TenantDetailScreenWired,
  AssistantChat: AssistantChatScreen,
  WebhooksAdmin: WebhooksAdminScreen,
  ApiReferenceScreen: ApiReferenceScreen,
  UpsellsSettings: UpsellsSettingsScreen,
  PropertyTaxesScreen,
  MessagingConnections: MessagingConnectionsScreen,
  MarketplaceCatalog: MarketplaceCatalogScreen,
  DeveloperApps: DeveloperAppsScreen,
  EsrsReport: EsrsReportScreen,
  TbaiForal: TbaiForalScreen,
  BankingSpain: BankingSpainScreen,
  GuestSegmentsReal: GuestSegmentsScreen,
  LoyaltyProgram: LoyaltyProgramScreen,
  GuestPortalSettingsReal: GuestPortalSettingsScreen,
  EnergyMetering: EnergyMeteringScreen,
  CampaignManagerReal: CampaignManagerScreen,
  SurveysNps: SurveysNpsScreen,
  QualityCasesReal: QualityCasesScreen,
  KioskSettingsReal: KioskSettingsScreen,
  InvoiceRectificationsScreen,
  AiToolRegistryScreen,
  AiPipelineStatusScreen,
  AiGovernanceScreen,
  AiHumanReviewQueueScreen,
  PropertyAiScreen,
  AiOwnerSummaryScreen,
  EmailConnectors: EmailConnectorsScreen,
  BillingSettings,
  GoLiveChecklist,
  ModuleHealthCenter,
  ModuleManager,
  PaymentSettings,
  PropertyMapper,
  PropertySetupWizard,
  PropertySetupHomeScreen,
  PropertyProfileSetupForm,
  BuildingSetupForm,
  FloorSetupForm,
  ZoneSetupForm,
  RoomTypeSetupForm,
  RoomSetupForm,
  SpaceResourceSetupForm,
  DepartmentSetupForm,
  HousekeepingSetupForm,
  MaintenanceSetupForm,
  RevenueCategorySetupForm,
  FinanceComplianceSetupForm,
  AiPropertySetupForm,
  CustomFieldSetupForm,
  ManualSetupHubScreen,
  ReservationWorkspace: ReservationWorkspaceScreen,
  ReservationCreate: ReservationCreateScreen,
  ReservationDetailWorkspace: ReservationDetailWorkspaceScreen,
  ReservationsListScreen,
  GuestsList: GuestsListScreen,
  GuestDetail: GuestProfileScreen,
  ReservationAgent: ReservationAgentScreen,
  BillingCenter: BillingCenterScreen,
  FolioDetail: FolioDetailScreen,
  ReportingCenter: ReportingCenterScreen,
  TaxComplianceSettings,
  UserRoleManager,
  SetupCenterScreen,
  ConfigurationCenterScreen,
  ConfigurationPropertyProfileForm,
  ConfigurationBuildingForm,
  ConfigurationFloorForm,
  ConfigurationZoneForm,
  ConfigurationRoomTypeForm,
  ConfigurationRoomForm,
  ConfigurationSpaceResourceForm,
  ConfigurationDepartmentForm,
  ConfigurationHousekeepingSetupForm,
  ConfigurationMaintenanceSetupForm,
  ConfigurationRevenueCategorySetupForm,
  ConfigurationComplianceSetupForm,
  ConfigurationAISetupForm,
  CategoryManagerScreen,
  CategoryDetailScreen,
  CategoryOptionForm,
  CustomFieldManagerScreen,
  LiveTimelineWorkspace,
  GuestJourneyWorkspace,
  // "Channel manager dashboard" was a mock duplicate of the real Channel Manager
  // (OTA aggregator). The key is kept pointing at the real screen so any
  // existing deep-link still resolves.
  ChannelManagerDashboard: ChannelAggregatorHub,
  RevenueHomeDashboard,
  RevenueMeeting: RevenueMeetingScreen,
  RateGridEditorScreen: RateGridEditorScreen,
  RateJournalScreen: RateJournalScreen,
  RevenueHistoryForecastDashboard,
  RevenueHistoryForecastReport,
  RevenueForecastExplorer,
  RevenueComparisonDashboard,
  RevenueExportCenter,
  RevenueRules: RevenueRulesScreen,
  RevenueAutomationRules: RevenueAutomationRulesModule,
  AutomationRules: RevenueAutomationRulesModule,
  ChannelMappings: ChannelMappingsScreen,
  RateShopperSettings: RateShopperSettingsScreen,
  DemandCalendarAdmin: DemandCalendarAdminScreen,
  ForecastSettings: ForecastSettingsModule,
  RevenueDataQuality: RevenueDataQualityModule,
  RevenueRecommendationRules: RevenueRulesScreen,
  GuestRegisterSettings: GuestRegisterSettingsScreen,
  SesHospedajesSettings: SesHospedajesSettingsScreen,
  AuthorityRoutingSettings: AuthorityRoutingSettingsScreen,
  GuestRegisterRetentionSettings: GuestRegisterRetentionSettingsScreen,
  AISetupCenter: AISetupCenterScreen,
  OnboardingProjects: OnboardingProjectListScreen,
  OnboardingProjectDetail: OnboardingProjectDetailScreen,
  SourceConnections: SourceConnectionScreen,
  FileUploadAndClassification: FileUploadAndClassificationScreen,
  AIExtractionReview: AIExtractionReviewScreen,
  ImportReview: AIExtractionReviewScreen,
  PropertyBlueprintReview: PropertyBlueprintReviewScreen,
  RoomMappingReview: RoomMappingReviewScreen,
  RatePlanMappingReview: RatePlanMappingReviewScreen,
  ReservationImportReview: ReservationImportReviewScreen,
  GuestImportReview: GuestImportReviewScreen,
  ChannelMappingReview: ChannelMappingReviewScreen,
  RevenueHistoryImportReview: RevenueHistoryImportReviewScreen,
  ComplianceSetupReview: ComplianceSetupReviewScreen,
  OnboardingDataQualityReview: DataQualityReviewScreen,
  DryRunResult: DryRunResultScreen,
  MigrationBatches: MigrationBatchScreen,
  // Every "go-live readiness" link (BackOfficeDashboard, guide, cutover stub)
  // lands on the real checklist instead of the "Pantalla en construcción" stub.
  OnboardingGoLiveReadiness: GoLiveChecklist,
  CutoverAssistant: CutoverAssistantScreen,
  CRMSettings: CRMSettingsModule,
  LoyaltySettings: LoyaltySettingsModule,
  DuplicateGuestReview: DuplicateGuestReviewModule,
  SalesPipeline: SalesPipelineModule,
  CorporateAccounts: CorporateAccountsModule,
  GroupSettings: GroupSettingsModule,
  EventSpacesSettings: EventSpacesSettingsModule,
  SalesSettings: SalesSettingsModule,
  WorkforceSettings: WorkforceSettingsModule,
  SchedulingRules: SchedulingRulesModule,
  PayrollExportSettings: PayrollExportSettingsModule,
  SupplierSettings: SupplierSettingsModule,
  InventorySettings: InventorySettingsModule,
  ProcurementSettings: ProcurementSettingsModule,
  ProcurementRules: ProcurementRulesModule,
  DigitalKeySettings: DigitalKeySettingsModule,
  ReputationSettings: ReputationSettingsModule,
  SurveySettings: SurveySettingsModule,
  QualityWorkflowSettings: QualityWorkflowSettingsModule,
  EnergySettings: EnergySettingsModule,
  MeterSettings: MeterSettingsModule,
  SustainabilitySettings: SustainabilitySettingsModule,
  SafetySettings: SafetySettingsModule,
  IncidentSettings: IncidentSettingsModule,
  IncidentWorkflowSettings: IncidentWorkflowSettingsModule,
  EmergencyContactsSettings: EmergencyContactsSettingsModule,
  AnalyticsSettings: AnalyticsSettingsModule,
  MetricDefinitions: MetricDefinitionsModule,
  ScheduledReports: ScheduledReportsModule,
  DeveloperPortal: DeveloperPortalModule,
  ApiApps: ApiAppsModule,
  Webhooks: WebhooksModule,
  WebhookSubscriptions: WebhookSubscriptionsModule,
  ApiUsageLogs: ApiUsageLogsModule,
  PartnerCertification: PartnerCertificationModule,
  AIToolRegistry: AIToolRegistryModule,
  AIPromptVersions: AIPromptVersionsModule,
  AIEvaluations: AIEvaluationsModule,
  AIIncidentLog: AIIncidentLogModule,
  AIHumanReviewQueue: AIHumanReviewQueueModule,
  AICostDashboard: AICostDashboardModule,
  // ---------------------------------------------------------------------------
  // Tanda 3 · retired keys kept as aliases of the REAL screen (same pattern as
  // ChannelManagerDashboard above): deep links, FrontDeskDashboard first-run
  // chips, guide tours and the v2 sidebar config still resolve. The scaffold
  // files behind them (ScreenScaffold stubs with invented status and English
  // copy: DepartmentManager.tsx, RoomTypeManager.tsx, RoomInventoryManager.tsx,
  // DocumentTemplateManager.tsx, PropertySettings.tsx, OrganizationSettings.tsx,
  // ChannelManagerSettingsScreen.tsx, CompetitorSetScreen.tsx,
  // RevenueSettingsScreen.tsx, IntegrationManager.tsx,
  // marketplace/IntegrationMarketplaceHome.tsx, ModuleConfigurationCenter.tsx,
  // compliance/GuestRegisterFieldMappingScreen.tsx) were deleted.
  DepartmentManager: DepartmentSetupForm,
  RoomTypeManager: RoomTypeSetupForm,
  RoomInventoryManager: RoomSetupForm,
  DocumentTemplateManager: NotificationsScreen,
  PropertySettings: PropertyProfileSetupForm,
  OrganizationSettings: PropertyProfileSetupForm,
  ChannelManagerSettings: ChannelAggregatorHub,
  CompetitorSet: RateShopperSettingsScreen,
  RevenueSettings: RatePlansScreen,
  IntegrationManager: MarketplaceCatalogScreen,
  IntegrationMarketplaceHome: MarketplaceCatalogScreen,
  ModuleConfigurationCenter: ModuleManager,
  GuestRegisterFieldMapping: GuestRegisterSettingsScreen,
  // Former makeModulePlaceholder duplicates of screens that already exist for
  // real under the "*Real" keys: resolve straight to the real screen.
  GuestSegments: GuestSegmentsScreen,
  CampaignManager: CampaignManagerScreen,
  GuestPortalSettings: GuestPortalSettingsScreen,
  KioskSettings: KioskSettingsScreen,
  UpsellSettings: UpsellsSettingsScreen,
  AIGovernanceSettings: AiGovernanceScreen
};

// Type-only export: the registry itself stays private so no module can import
// it as a value (App.tsx imports every screen, which would be a real cycle).
// `lib/navigate.ts` re-exports this type for the typed `navigateTo` helper.
export type ScreenKey = keyof typeof SCREEN_COMPONENTS;

function routeMatches(pattern: string, pathname: string) {
  const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/]+")}$`);
  return regex.test(pathname);
}

function screenFromPathname(pathname: string): keyof typeof SCREEN_COMPONENTS {
  const route = BACKOFFICE_ROUTES.find((candidate) => routeMatches(candidate.path, pathname));
  return (route?.screen as keyof typeof SCREEN_COMPONENTS | undefined) ?? "FrontDeskDashboard";
}

// On the generic root path, land on the active persona's home panel so an owner
// or operator doesn't open onto the receptionist's "Mi día".
function initialScreen(): keyof typeof SCREEN_COMPONENTS {
  const path = window.location.pathname;
  if (path === "/" || path === "/backoffice" || path === "/backoffice/") {
    const home = roleHome(getActiveRole());
    if (home && home in SCREEN_COMPONENTS) return home as keyof typeof SCREEN_COMPONENTS;
  }
  return screenFromPathname(path);
}

function pathForScreen(screen: keyof typeof SCREEN_COMPONENTS) {
  return BACKOFFICE_ROUTES.find((route) => route.screen === screen && !route.path.includes(":"))?.path;
}

// Nav targets may carry a `#hash` deep-link ("GroupsEventsDashboard#nuevo-grupo"):
// only the base screen is a SCREEN_COMPONENTS key; the hash is handed to the
// screen through the URL (see syncLocation).
function resolveScreenTarget(target: string): { screen: keyof typeof SCREEN_COMPONENTS; hash: string } | null {
  const at = target.indexOf("#");
  const screen = at === -1 ? target : target.slice(0, at);
  const hash = at === -1 ? "" : target.slice(at);
  if (!(screen in SCREEN_COMPONENTS)) {
    if (import.meta.env.DEV) {
      console.warn(`[hotelos-nav] Unknown screen "${screen}" (target "${target}") is not registered in SCREEN_COMPONENTS`);
    }
    return null;
  }
  return { screen: screen as keyof typeof SCREEN_COMPONENTS, hash };
}

// Must run before the screen state update so a freshly mounted screen finds
// the hash on mount. When the path does not change the screen may already be
// mounted, so the hash is assigned (fires `hashchange`) rather than replaced;
// a stale hash from an earlier deep-link is dropped when the target has none.
function syncLocation(screen: keyof typeof SCREEN_COMPONENTS, hash: string) {
  const nextPath = pathForScreen(screen);
  if (nextPath && window.location.pathname !== nextPath) {
    window.history.pushState(null, "", nextPath + hash);
    return;
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

// Result of validating the stored active property for a given user. Keyed by
// userId so a fresh login (or a different user) always starts in "checking"
// on its very first render and the shell never mounts against a stale scope.
type ActivePropertyGate = { userId: string; status: "ready" | "empty" };

/**
 * AuthGate
 * --------
 * Reads the persisted user from auth-storage on mount and re-checks whenever a
 * "hotelos-auth-changed" event fires (login from LoginScreen, logout from
 * TopBar, or a 401 propagated from api-client). When there is no user we
 * render the LoginScreen / ForgotPasswordScreen instead of the protected app.
 *
 * Once a user is present, the stored active property is validated against
 * GET /users/me/properties (ensureActiveProperty) BEFORE the children mount:
 * screens read the property id at module-evaluation time and four of them are
 * imported eagerly above, so a corrected selection requires a full reload.
 * The reload only fires when the persisted scope actually changed, and a
 * failed list request degrades to the stored value so login is never blocked.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getUser());
  const [authScreen, setAuthScreen] = useState<"LoginScreen" | "ForgotPasswordScreen">("LoginScreen");
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

  if (!user) {
    if (authScreen === "ForgotPasswordScreen") {
      return <ForgotPasswordScreen onNavigate={(screen) => {
        if (screen === "LoginScreen") setAuthScreen("LoginScreen");
      }} />;
    }
    return <LoginScreen onNavigate={(screen) => {
      if (screen === "ForgotPasswordScreen") setAuthScreen("ForgotPasswordScreen");
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

export function App() {
  const [activeScreen, setActiveScreen] = useState<keyof typeof SCREEN_COMPONENTS>(() => initialScreen());
  const ActiveScreen = useMemo(() => SCREEN_COMPONENTS[activeScreen] ?? FrontDeskDashboard, [activeScreen]);

  useEffect(() => {
    function handlePopState() {
      setActiveScreen(screenFromPathname(window.location.pathname));
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
        setActiveScreen(target.screen);
      });
    }
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hotelos-nav", handleHotelosNav);
    return () => {
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

  // Public auth flows (invitation acceptance, password reset, forced password
  // change) render INSTEAD of the protected shell: PublicAuthRoutes owns the
  // pathname/session check and only renders its children (the AuthGate) when
  // no public screen applies.
  return (
    // ⌘K belongs to the shell's CommandPalette (BackOfficeLayout); the Cocoa
    // palette must not open on top of it (cierre 2026-09-15).
    <CocoaGlobalProvider commandPaletteHotkey={false}>
      <ToastProvider>
        <PublicAuthRoutes>
          <AuthGate>
            <BackOfficeLayout activeScreen={activeScreen} onSelect={selectScreen}>
              <Suspense fallback={<LoadingBlock label="Cargando pantalla…" />}>
                <ActiveScreen />
              </Suspense>
            </BackOfficeLayout>
          </AuthGate>
        </PublicAuthRoutes>
        <ToastHost />
      </ToastProvider>
    </CocoaGlobalProvider>
  );
}

export default App;
