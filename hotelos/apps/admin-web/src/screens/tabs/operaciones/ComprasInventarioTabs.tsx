// Compras e inventario — /operaciones/compras (Tanda 5 · L1a · lote tabs-a).
//
// Item `ProcurementDashboard` (module procurement_inventory): base tab
// «Compras» (pedidos y proveedores) and «Inventario» (InventoryDashboard,
// /operaciones/compras/inventario). «Ajustes de compras» and «Ajustes de
// inventario» are dev-only under /desarrollo/* and do not hang here.
//
// L1b registers: screenKey ProcurementDashboard · url /operaciones/compras · tab
// /operaciones/compras/inventario.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ProcurementDashboard: () => import("../../operations/ProcurementDashboard").then((m) => ({ default: m.ProcurementDashboard })),
  InventoryDashboard: () => import("../../operations/InventoryDashboard").then((m) => ({ default: m.InventoryDashboard }))
};

export default function ComprasInventarioTabs() {
  return (
    <NavItemTabs
      screenKey="ProcurementDashboard"
      loaders={LOADERS}
      subtitle="Pedidos de compra, proveedores y niveles de existencias en un mismo flujo."
    />
  );
}
