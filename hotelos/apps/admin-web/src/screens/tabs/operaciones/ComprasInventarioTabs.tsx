// Compras e inventario — /operaciones/compras (Tanda 5 · L1a · lote tabs-a).
//
// Item `ProcurementDashboard` (module procurement_inventory): base tab
// «Compras» (pedidos y proveedores), «Inventario» (InventoryDashboard,
// /operaciones/compras/inventario) and, since Tanda T9 (lote T9-12),
// «Recepciones» (GoodsReceiptsScreen, /operaciones/compras/recepciones: goods
// receipts and their matching with supplier bills). «Ajustes de compras» and
// «Ajustes de inventario» are dev-only under /desarrollo/* and do not hang here.
//
// L1b registers: screenKey ProcurementDashboard · url /operaciones/compras · tabs
// /operaciones/compras/inventario, /operaciones/compras/recepciones.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ProcurementDashboard: () => import("../../operations/ProcurementDashboard").then((m) => ({ default: m.ProcurementDashboard })),
  InventoryDashboard: () => import("../../operations/InventoryDashboard").then((m) => ({ default: m.InventoryDashboard })),
  GoodsReceiptsScreen: () => import("../../documents/GoodsReceiptsScreen").then((m) => ({ default: m.GoodsReceiptsScreen }))
};

export default function ComprasInventarioTabs() {
  return (
    <NavItemTabs
      screenKey="ProcurementDashboard"
      loaders={LOADERS}
      subtitle="Pedidos de compra, proveedores, recepciones de mercancía cotejadas con las facturas y niveles de existencias en un mismo flujo."
    />
  );
}
