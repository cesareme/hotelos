// Ventas adicionales — /comercial/ventas-adicionales (Tanda 5 · L1a · lote tabs-b).
//
// Item `UpsellsDashboard` of the tree: base tab «Ventas adicionales» (results,
// reception sells them at check-in) plus Ofertas (UpsellsSettings, the
// catalogue) and Portal del huésped (GuestPortalSettingsReal, gated by
// guest_self_service at tab level). Labels, URLs, roles and modules come from
// nav-tree.generated.json.
//
// L1b registers: screenKey UpsellsDashboard · url /comercial/ventas-adicionales ·
// tabs /comercial/ventas-adicionales/ofertas, /portal.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  UpsellsDashboard: () => import("../../operations/UpsellsDashboard").then((m) => ({ default: m.UpsellsDashboard })),
  UpsellsSettings: () => import("../../upsells/UpsellsSettingsScreen").then((m) => ({ default: m.UpsellsSettingsScreen })),
  GuestPortalSettingsReal: () => import("../../guest-portal/GuestPortalSettingsScreen").then((m) => ({ default: m.GuestPortalSettingsScreen }))
};

function VentasAdicionalesTabs() {
  return <NavItemTabs screenKey="UpsellsDashboard" loaders={LOADERS} subtitle="Resultados de las ofertas, su catálogo y el portal del huésped." />;
}

export default VentasAdicionalesTabs;
