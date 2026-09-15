// Pisos — /operaciones/pisos (Tanda 5 · L1a · lote tabs-a).
//
// Item `HousekeepingDashboard`: base tab «Tablero» (estado de cada habitación),
// «Mi turno» (HousekeepingMobileScreen, /operaciones/pisos/mi-turno — the
// housekeeper's home below 700 px, §3) and «Ajustes» (HousekeepingSetupForm,
// /operaciones/pisos/ajustes; dirección/admin).
//
// L1b registers: screenKey HousekeepingDashboard · url /operaciones/pisos · tabs
// /operaciones/pisos/mi-turno, /operaciones/pisos/ajustes.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  HousekeepingDashboard: () => import("../../operations/HousekeepingDashboard").then((m) => ({ default: m.HousekeepingDashboard })),
  HousekeepingMobileScreen: () => import("../../operations/HousekeepingMobileScreen").then((m) => ({ default: m.HousekeepingMobileScreen })),
  HousekeepingSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.HousekeepingSetupForm }))
};

export default function PisosTabs() {
  return (
    <NavItemTabs
      screenKey="HousekeepingDashboard"
      loaders={LOADERS}
      subtitle="Estado de las habitaciones, el turno de cada camarera y los ajustes del departamento."
    />
  );
}
