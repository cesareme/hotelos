// Huéspedes — /recepcion/huespedes (Tanda 5 · L1a · lote tabs-a).
//
// Item `GuestsList`: base tab «Listado» (GuestsListScreen) and the detail
// sub-URLs Ficha (/recepcion/huespedes/:id → GuestDetail) and Cronología
// (/recepcion/huespedes/:id/cronologia → GuestTimelineScreen, which used to
// need ?guestId). On the list only «Listado» exists, so the strip is hidden;
// on a guest the strip reads Listado · Ficha · Cronología. A guest being
// created (`/new`) has no timeline yet.
//
// L1b registers: screenKey GuestsList · url /recepcion/huespedes · tabs
// /recepcion/huespedes/:id, /recepcion/huespedes/:id/cronologia.

import { useCallback } from "react";
import { CocoaButton } from "../../../components/cocoa/CocoaButton";
import { openTabPath, type CocoaRouteTab } from "../../../components/cocoa/CocoaRouteTabs";
import { newLabel } from "../../../content/actions";
import { matchPath, urlForScreen } from "../../../navigation/nav-tree";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  GuestsList: () => import("../../guests/GuestsListScreen").then((m) => ({ default: m.GuestsListScreen })),
  GuestDetail: () => import("../../guests/GuestProfileScreen").then((m) => ({ default: m.GuestProfileScreen })),
  GuestTimelineScreen: () => import("../../guests/GuestTimelineScreen").then((m) => ({ default: m.GuestTimelineScreen }))
};

/** «Nuevo huésped» opens the empty profile (`GuestDetail` with id `new`, as the legacy /backoffice/guests/new). */
const NEW_GUEST_PATH = urlForScreen("GuestDetail", { id: "new" }) ?? "/recepcion/huespedes/new";
const FICHA_PATTERN = urlForScreen("GuestDetail") ?? "/recepcion/huespedes/:id";
const CRONOLOGIA_PATTERN = urlForScreen("GuestTimelineScreen") ?? "/recepcion/huespedes/:id/cronologia";

/** A guest being created (`/new`, on its Ficha or on the Cronología URL itself) has no timeline yet. */
export function hideTimelineForNewGuest(tab: CocoaRouteTab, params: { pathname: string }): boolean {
  if (tab.key !== "cronologia") return true;
  const match = matchPath(CRONOLOGIA_PATTERN, params.pathname) ?? matchPath(FICHA_PATTERN, params.pathname);
  return match?.id !== "new";
}

export default function HuespedesTabs() {
  const tabFilter = useCallback(hideTimelineForNewGuest, []);
  return (
    <NavItemTabs
      screenKey="GuestsList"
      loaders={LOADERS}
      tabFilter={tabFilter}
      subtitle="Perfiles de huésped con su ficha y su cronología de estancias, pagos e incidencias."
      actions={
        <CocoaButton variant="filled" tone="accent" onClick={() => openTabPath(NEW_GUEST_PATH)}>
          {newLabel("m", "huésped")}
        </CocoaButton>
      }
    />
  );
}
