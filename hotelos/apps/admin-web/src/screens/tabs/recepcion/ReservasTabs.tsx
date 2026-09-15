// Reservas — /recepcion/reservas (Tanda 5 · L1a · lote tabs-a).
//
// Item `ReservationWorkspace` of the tree. The workspace IS the container: the
// tree names no base tab, so the item URL lands on the first tab visible for
// the role (Lista for recepción/dirección/comercial/revenue, Cronograma for
// pisos). Tabs: Lista (ReservationsListScreen), Cronograma (LiveTimelineWorkspace),
// Tablero de habitaciones (RoomRackScreen) and the detail sub-URLs Detalle
// (/recepcion/reservas/:id → ReservationDetailWorkspace) and Recorrido
// (/recepcion/reservas/:id/recorrido → GuestJourneyWorkspace), painted only
// while the URL carries a reservation.
//
// L1b registers: screenKey ReservationWorkspace · url /recepcion/reservas · tabs
// /recepcion/reservas/lista, /cronograma, /tablero, /:id, /:id/recorrido.

import { CocoaButton } from "../../../components/cocoa/CocoaButton";
import { newLabel } from "../../../content/actions";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ReservationsListScreen: () => import("../../reservations/ReservationsListScreen").then((m) => ({ default: m.ReservationsListScreen })),
  LiveTimelineWorkspace: () => import("../../timeline/LiveTimelineWorkspace").then((m) => ({ default: m.LiveTimelineWorkspace })),
  RoomRackScreen: () => import("../../operations/RoomRackScreen").then((m) => ({ default: m.RoomRackScreen })),
  ReservationDetailWorkspace: () =>
    import("../../reservations/ReservationWorkspaceScreen").then((m) => ({ default: m.ReservationDetailWorkspaceScreen })),
  GuestJourneyWorkspace: () => import("../../guestJourney/GuestJourneyWorkspace").then((m) => ({ default: m.GuestJourneyWorkspace }))
};

function openNewReservation() {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ReservationCreate" }));
}

export default function ReservasTabs() {
  return (
    <NavItemTabs
      screenKey="ReservationWorkspace"
      loaders={LOADERS}
      subtitle="Lista, cronograma y tablero de habitaciones; cada reserva abre su detalle y su recorrido."
      actions={
        <CocoaButton variant="filled" tone="accent" onClick={openNewReservation}>
          {newLabel("f", "reserva")}
        </CocoaButton>
      }
    />
  );
}
