// Nueva reserva — /recepcion/reservas/nueva (Tanda 5 · L1a · lote tabs-a).
//
// Item `ReservationCreate`: base tab «Formulario» (ReservationCreateScreen) and
// «Dictar (IA)» (ReservationAgent, /recepcion/reservas/nueva/dictar), the
// voice/text booking agent as an action inside the creation flow instead of a
// fourth AI chat.
//
// L1b registers: screenKey ReservationCreate · url /recepcion/reservas/nueva ·
// tab /recepcion/reservas/nueva/dictar.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ReservationCreate: () => import("../../reservations/ReservationCreateScreen").then((m) => ({ default: m.ReservationCreateScreen })),
  ReservationAgent: () => import("../../reservations/ReservationAgentScreen").then((m) => ({ default: m.ReservationAgentScreen }))
};

export default function NuevaReservaTabs() {
  return (
    <NavItemTabs
      screenKey="ReservationCreate"
      loaders={LOADERS}
      subtitle="Rellena el formulario o dicta la petición y revisa el borrador antes de confirmar."
    />
  );
}
