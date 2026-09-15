// Mantenimiento — /operaciones/mantenimiento (Tanda 5 · L1a · lote tabs-a).
//
// Item `MaintenanceDashboard`: base tab «Tablero» (órdenes de trabajo), «Mis
// averías» (MaintenanceMobileScreen, /operaciones/mantenimiento/mis-averias —
// the technician's home below 700 px, §3) and «Ajustes» (MaintenanceSetupForm,
// /operaciones/mantenimiento/ajustes; dirección/admin).
//
// L1b registers: screenKey MaintenanceDashboard · url /operaciones/mantenimiento ·
// tabs /operaciones/mantenimiento/mis-averias, /operaciones/mantenimiento/ajustes.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  MaintenanceDashboard: () => import("../../operations/MaintenanceDashboard").then((m) => ({ default: m.MaintenanceDashboard })),
  MaintenanceMobileScreen: () => import("../../operations/MaintenanceMobileScreen").then((m) => ({ default: m.MaintenanceMobileScreen })),
  MaintenanceSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.MaintenanceSetupForm }))
};

export default function MantenimientoTabs() {
  return (
    <NavItemTabs
      screenKey="MaintenanceDashboard"
      loaders={LOADERS}
      subtitle="Órdenes de trabajo, las averías de cada técnico y los ajustes del departamento."
    />
  );
}
