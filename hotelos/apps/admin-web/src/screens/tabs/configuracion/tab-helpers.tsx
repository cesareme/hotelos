// Compatibility re-export (Tanda 5 · L1c): the helpers moved to
// screens/tabs/tab-helpers.tsx (they are generic, not specific to
// Configuración). Kept only for the screens outside screens/tabs/** that still
// import `pageHead` from here (AccountingSettings, BillingSettings,
// GoLiveChecklist, ModuleManager, PaymentSettings, TaxComplianceSettings,
// admin/TenantAdminConsoleScreen, admin/TenantDetailScreen,
// compliance/AuthorityRoutingSettingsScreen,
// compliance/GuestRegisterRetentionSettingsScreen, compliance/PropertyTaxesScreen):
// re-point those imports to "../tabs/tab-helpers" (or "./tabs/tab-helpers")
// and delete this file.

export { HostedHead, embed, pageHead, shellNavigate, useRouteParam, type EmbeddedProps, type HostedHeadProps } from "../tab-helpers";
