// Mi día — /hoy (Tanda 5 · L1a · lote tabs-a).
//
// Item `FrontDeskDashboard` of the tree: base tab «Recepción» (FrontDeskDashboard)
// plus Operaciones (OperationsDirectorScreen, /hoy/operaciones), Dirección
// (GeneralManagerScreen, /hoy/direccion) and Propietario (OwnerHome,
// /hoy/propietario). The landing tab is the role home (§3): recepción stays on
// Recepción, pisos/mantenimiento/fnb land on Operaciones, revenue/finanzas/
// comercial on Dirección, the owner template on Propietario. The base tab is
// painted only for the roles whose day starts at the front desk (§3 lists
// «Mi día [Operaciones]» for pisos and «Mi día [Dirección]» for revenue).
//
// L1b registers: screenKey FrontDeskDashboard · url /hoy · tabs /hoy/operaciones,
// /hoy/direccion, /hoy/propietario.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  FrontDeskDashboard: () => import("../../operations/FrontDeskDashboard").then((m) => ({ default: m.FrontDeskDashboard })),
  OperationsDirectorScreen: () => import("../../operations/OperationsDirectorScreen").then((m) => ({ default: m.OperationsDirectorScreen })),
  GeneralManagerScreen: () => import("../../operations/GeneralManagerScreen").then((m) => ({ default: m.GeneralManagerScreen })),
  OwnerHome: () => import("../../owner/OwnerHomeScreen").then((m) => ({ default: m.OwnerHomeScreen }))
};

/** Roles whose Mi día includes the front-desk view (the rest land on their own tab). */
const BASE_TAB_ROLES = ["recepcion", "direccion", "admin"] as const;

export default function MiDiaTabs() {
  return (
    <NavItemTabs
      screenKey="FrontDeskDashboard"
      loaders={LOADERS}
      baseRoles={BASE_TAB_ROLES}
      subtitle="Lo que pasa hoy en la propiedad, visto desde recepción, operaciones, dirección o propiedad."
    />
  );
}
