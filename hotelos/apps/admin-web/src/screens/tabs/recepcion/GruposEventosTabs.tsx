// Grupos y eventos — /recepcion/grupos (Tanda 5 · L1a · lote tabs-a).
//
// Item `GroupsEventsDashboard`: base tab «Resumen» (bloques, pickup, eventos),
// «Calendario» (GroupsCalendarScreen, /recepcion/grupos/calendario) and
// «Cupos» (Allotments, /recepcion/grupos/cupos; comercial/dirección/admin, the
// tour-operator API needs channel_manager.read). «Ajustes de grupos» is
// dev-only under /desarrollo/grupos-ajustes and does not hang here.
//
// L1b registers: screenKey GroupsEventsDashboard · url /recepcion/grupos · tabs
// /recepcion/grupos/calendario, /recepcion/grupos/cupos.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  GroupsEventsDashboard: () => import("../../operations/GroupsEventsDashboard").then((m) => ({ default: m.GroupsEventsDashboard })),
  GroupsCalendarScreen: () => import("../../operations/GroupsCalendarScreen").then((m) => ({ default: m.GroupsCalendarScreen })),
  Allotments: () => import("../../admin/AllotmentsScreen").then((m) => ({ default: m.AllotmentsScreen }))
};

export default function GruposEventosTabs() {
  return (
    <NavItemTabs
      screenKey="GroupsEventsDashboard"
      loaders={LOADERS}
      subtitle="Bloques de grupo, eventos con espacio y cupos de tour operadores."
    />
  );
}
