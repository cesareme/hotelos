// Punto de venta — /operaciones/tpv (Tanda 5 · L1a · lote tabs-a; Tanda 6 ·
// lote nav-services: Cierre de caja).
//
// Item `PosDashboard` (module outlet_pos): base tab «Comandas» (tickets, cargo
// a habitación, ventas al contado), «Cartas» (FnbMenu, /operaciones/tpv/cartas;
// fnb/dirección/admin), «Existencias» (FnbInventory,
// /operaciones/tpv/existencias; fnb/dirección/finanzas/admin) and «Cierre de
// caja» (CashClosureScreen, /operaciones/tpv/cierre-de-caja; every role of the
// item — recepción closes the reception cash). Recepción sees Comandas and
// Cierre de caja (§3).
//
// Registered: screenKey PosDashboard · url /operaciones/tpv · tabs
// /operaciones/tpv/cartas, /operaciones/tpv/existencias, /operaciones/tpv/cierre-de-caja.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  PosDashboard: () => import("../../operations/PosDashboard").then((m) => ({ default: m.PosDashboard })),
  FnbMenu: () => import("../../admin/FnbMenuScreen").then((m) => ({ default: m.FnbMenuScreen })),
  FnbInventory: () => import("../../admin/FnbInventoryScreen").then((m) => ({ default: m.FnbInventoryScreen })),
  CashClosureScreen: () => import("../../pos/CashClosureScreen").then((m) => ({ default: m.CashClosureScreen }))
};

export default function PuntoVentaTabs() {
  return (
    <NavItemTabs
      screenKey="PosDashboard"
      loaders={LOADERS}
      subtitle="Comandas abiertas y cobros, cartas por punto de venta, existencias con sus recetas y cierre de caja del día."
    />
  );
}
