// Contabilidad y fiscal — /configuracion/contabilidad-fiscal (Tanda 5 · L1a · lot tabs-c).
//
// Item `AccountingSettings`: base tab «Contabilidad» (plan contable y periodos) plus
// Fiscal (TaxComplianceSettings, /fiscal), Perfil inicial (FinanceComplianceSetupForm,
// /perfil-inicial) and Categorías de ingresos (RevenueCategorySetupForm, /categorias-ingresos).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey AccountingSettings · url /configuracion/contabilidad-fiscal · tabs
// /configuracion/contabilidad-fiscal/fiscal, /perfil-inicial, /categorias-ingresos.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  AccountingSettings: () => import("../../AccountingSettings").then((m) => ({ default: m.AccountingSettings })),
  TaxComplianceSettings: () => import("../../TaxComplianceSettings").then((m) => ({ default: m.TaxComplianceSettings })),
  FinanceComplianceSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.FinanceComplianceSetupForm })),
  RevenueCategorySetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.RevenueCategorySetupForm }))
};

export default function ContabilidadFiscalTabs() {
  return (
    <NavItemTabs
      screenKey="AccountingSettings"
      loaders={loaders}
      subtitle="Plan contable y periodos, ajustes fiscales, perfil inicial de finanzas y categorías de ingresos."
    />
  );
}
