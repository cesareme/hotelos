// Reservas — /recepcion/reservas (Tanda 5 · L1a · lote tabs-a).
//
// Item `ReservationWorkspace` of the tree. The workspace IS the container: the
// tree names no base tab, so the item URL lands on the first tab visible for
// the role (Lista for recepción/dirección/comercial/revenue, Tablero for
// pisos). Tabs: Lista (ReservationsListScreen), Tablero de habitaciones (RoomRackScreen), Importar (ReservationImportScreen,
// Tanda 7: importación masiva desde CSV o XLSX) and the detail sub-URLs Detalle
// (/recepcion/reservas/:id → ReservationDetailWorkspace) and Recorrido
// (/recepcion/reservas/:id/recorrido → GuestJourneyWorkspace), painted only
// while the URL carries a reservation.
//
// L1b registers: screenKey ReservationWorkspace · url /recepcion/reservas · tabs
// /recepcion/reservas/lista, /tablero, /importar, /:id, /:id/recorrido. Tanda TL: la
// pestaña Cronograma pasó a Hoy › Live Timeline (/hoy/live-timeline, LiveTimeline.tsx);
// la clave LiveTimelineWorkspace queda como alias en App.tsx.

import { CocoaButton } from "../../../components/cocoa/CocoaButton";
import { openTabPath } from "../../../components/cocoa/CocoaRouteTabs";
import { UploadIcon } from "../../../components/cocoa-icons/ActionIcons";
import { newLabel } from "../../../content/actions";
import { findByScreen, urlForScreen } from "../../../navigation/nav-tree";
import { useNavGate } from "../../../navigation/useEnabledModules";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ReservationsListScreen: () => import("../../reservations/ReservationsListScreen").then((m) => ({ default: m.ReservationsListScreen })),
  RoomRackScreen: () => import("../../operations/RoomRackScreen").then((m) => ({ default: m.RoomRackScreen })),
  ReservationImportScreen: () => import("../../reservations/ReservationImportScreen").then((m) => ({ default: m.ReservationImportScreen })),
  ReservationDetailWorkspace: () =>
    import("../../reservations/ReservationWorkspaceScreen").then((m) => ({ default: m.ReservationDetailWorkspaceScreen })),
  GuestJourneyWorkspace: () => import("../../guestJourney/GuestJourneyWorkspace").then((m) => ({ default: m.GuestJourneyWorkspace }))
};

/** «Importar reservas» opens the Importar tab (Tanda 7): the wizard lives at its own URL of the tree. */
const IMPORT_PATH = urlForScreen("ReservationImportScreen") ?? "/recepcion/reservas/importar";
/** The Importar tab of the tree (roles recepción/dirección/comercial/admin): its gate decides who gets the header action. */
const IMPORT_TAB = findByScreen("ReservationImportScreen");

function openNewReservation() {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ReservationCreate" }));
}

export default function ReservasTabs() {
  // FUX-09: the header action only for the roles that see the Importar tab; pisos
  // (no tab) lands on Tablero and must not get a button that leads nowhere.
  const gate = useNavGate();
  const canSeeImport = IMPORT_TAB?.kind === "tab" && gate.isVisible(IMPORT_TAB.tab);
  return (
    <NavItemTabs
      screenKey="ReservationWorkspace"
      loaders={LOADERS}
      subtitle="Lista, tablero de habitaciones e importación masiva; cada reserva abre su detalle y su recorrido (el cronograma vive en Hoy › Live Timeline)."
      actions={
        <>
          {canSeeImport ? (
            <CocoaButton variant="bordered" tone="neutral" icon={<UploadIcon size={16} aria-hidden="true" />} onClick={() => openTabPath(IMPORT_PATH)}>
              Importar reservas
            </CocoaButton>
          ) : null}
          <CocoaButton variant="filled" tone="accent" onClick={openNewReservation}>
            {newLabel("f", "reserva")}
          </CocoaButton>
        </>
      }
    />
  );
}
