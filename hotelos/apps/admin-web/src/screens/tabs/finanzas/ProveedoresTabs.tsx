// Proveedores y gastos — /finanzas/proveedores (Tanda 6 · Finanzas · lote nav-services).
//
// Item `SupplierBillsScreen` of the tree: base tab «Facturas recibidas» plus
// Gastos (ExpensesScreen), Proveedores (SuppliersScreen, /directorio),
// Inmovilizado (FixedAssetsScreen) and, since Tanda T9 (lote T9-12), Documentos
// (IncomingDocumentsScreen, /documentos: office tray and side-by-side review of
// the digitised documents) and Archivo (DocumentArchiveScreen, /archivo: legal
// archive with full-text search). Labels, URLs and roles come from
// nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// Registered: screenKey SupplierBillsScreen · url /finanzas/proveedores · tabs
// /finanzas/proveedores/gastos, /directorio, /inmovilizado, /documentos, /archivo.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  SupplierBillsScreen: () => import("../../payables/SupplierBillsScreen").then((m) => ({ default: m.SupplierBillsScreen })),
  ExpensesScreen: () => import("../../payables/ExpensesScreen").then((m) => ({ default: m.ExpensesScreen })),
  SuppliersScreen: () => import("../../payables/SuppliersScreen").then((m) => ({ default: m.SuppliersScreen })),
  FixedAssetsScreen: () => import("../../payables/FixedAssetsScreen").then((m) => ({ default: m.FixedAssetsScreen })),
  IncomingDocumentsScreen: () => import("../../documents/IncomingDocumentsScreen").then((m) => ({ default: m.IncomingDocumentsScreen })),
  DocumentArchiveScreen: () => import("../../documents/DocumentArchiveScreen").then((m) => ({ default: m.DocumentArchiveScreen }))
};

function ProveedoresTabs() {
  return <NavItemTabs screenKey="SupplierBillsScreen" loaders={LOADERS} subtitle="Facturas recibidas por líneas, gastos menores, directorio de proveedores, inmovilizado con su amortización y los documentos digitalizados con su archivo legal." />;
}

export default ProveedoresTabs;
