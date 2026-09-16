// VeriFactu — /cumplimiento/verifactu (Tanda 5 · L1a · lot tabs-c).
//
// Item `FiscalDashboard`: base tab «VeriFactu» (FiscalDashboard: envíos VeriFactu
// y certificados) plus TicketBAI (forales) (TbaiForalScreen, /cumplimiento/verifactu/ticketbai).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey FiscalDashboard · url /cumplimiento/verifactu · tab /cumplimiento/verifactu/ticketbai.
//
// Cocoa 22 · ola 8 · lote 8-B: both screens are Cocoa 22 (FiscalDashboard on
// pageHead(embedded) + Cocoa body, TbaiForalScreen on CocoaPage). FiscalDashboard
// keeps the `embed()` bridge (EMBED_BRIDGE of cumplimiento-tabs.test.mts and
// TabHost.tsx) until the integrator retires it; the host context already decides.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed, shellNavigate } from "../tab-helpers";

export const loaders: TabLoaders = {
  FiscalDashboard: () => import("../../fiscal/FiscalDashboard").then((m) => embed(m.FiscalDashboard, { onNavigate: shellNavigate })),
  TbaiForal: () => import("../../fiscal/TbaiForalScreen").then((m) => ({ default: m.TbaiForalScreen }))
};

export default function VerifactuTabs() {
  return (
    <NavItemTabs
      screenKey="FiscalDashboard"
      loaders={loaders}
      subtitle="Envíos VeriFactu a la AEAT, estado de los certificados y TicketBAI para los territorios forales."
    />
  );
}
