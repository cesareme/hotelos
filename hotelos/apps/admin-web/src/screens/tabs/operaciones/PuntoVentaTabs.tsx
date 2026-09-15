// Punto de venta — /operaciones/tpv (Tanda 5 · L1a · lote tabs-a).
//
// Item `PosDashboard` (module outlet_pos): base tab «Comandas» (tickets, cargo
// a habitación, cierre de caja), «Cartas» (FnbMenu, /operaciones/tpv/cartas;
// fnb/dirección/admin) and «Existencias» (FnbInventory,
// /operaciones/tpv/existencias; fnb/dirección/finanzas/admin). Recepción sees
// only Comandas (§3).
//
// L1b registers: screenKey PosDashboard · url /operaciones/tpv · tabs
// /operaciones/tpv/cartas, /operaciones/tpv/existencias.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  PosDashboard: () => import("../../operations/PosDashboard").then((m) => ({ default: m.PosDashboard })),
  FnbMenu: () => import("../../admin/FnbMenuScreen").then((m) => ({ default: m.FnbMenuScreen })),
  FnbInventory: () => import("../../admin/FnbInventoryScreen").then((m) => ({ default: m.FnbInventoryScreen }))
};

export default function PuntoVentaTabs() {
  return (
    <NavItemTabs
      screenKey="PosDashboard"
      loaders={LOADERS}
      subtitle="Comandas abiertas y cobros, cartas por punto de venta y existencias con sus recetas."
    />
  );
}
