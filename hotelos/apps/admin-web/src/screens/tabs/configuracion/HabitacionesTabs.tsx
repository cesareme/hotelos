// Habitaciones y espacios — /configuracion/habitaciones (Tanda 5 · L1a · lot tabs-c).
//
// Item `RoomSetupForm`: base tab «Habitaciones» (inventario) plus Tipos
// (RoomTypeSetupForm, /tipos) and Espacios y recursos (SpaceResourceSetupForm, /espacios).
// The mock ConfigurationRoomForm and the RoomInventoryManager / RoomTypeManager aliases
// retire into this item.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey RoomSetupForm · url /configuracion/habitaciones · tabs
// /configuracion/habitaciones/tipos, /espacios.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  RoomSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.RoomSetupForm })),
  RoomTypeSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.RoomTypeSetupForm })),
  SpaceResourceSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.SpaceResourceSetupForm }))
};

export default function HabitacionesTabs() {
  return (
    <NavItemTabs
      screenKey="RoomSetupForm"
      loaders={loaders}
      subtitle="Inventario de habitaciones, tipos de habitación y salas y recursos reservables."
    />
  );
}
