// Proveedores y gastos — /finanzas/proveedores (Tanda 6 · Finanzas · lote nav-services).
//
// Item `SupplierBillsScreen` of the tree: base tab «Facturas recibidas» plus
// Gastos (ExpensesScreen), Proveedores (SuppliersScreen, /directorio) and
// Inmovilizado (FixedAssetsScreen). Labels, URLs and roles come from
// nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// Registered: screenKey SupplierBillsScreen · url /finanzas/proveedores · tabs
// /finanzas/proveedores/gastos, /directorio, /inmovilizado.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  SupplierBillsScreen: () => import("../../payables/SupplierBillsScreen").then((m) => ({ default: m.SupplierBillsScreen })),
  ExpensesScreen: () => import("../../payables/ExpensesScreen").then((m) => ({ default: m.ExpensesScreen })),
  SuppliersScreen: () => import("../../payables/SuppliersScreen").then((m) => ({ default: m.SuppliersScreen })),
  FixedAssetsScreen: () => import("../../payables/FixedAssetsScreen").then((m) => ({ default: m.FixedAssetsScreen }))
};

function ProveedoresTabs() {
  return <NavItemTabs screenKey="SupplierBillsScreen" loaders={LOADERS} subtitle="Facturas recibidas por líneas, gastos menores, directorio de proveedores e inmovilizado con su amortización." />;
}

export default ProveedoresTabs;
