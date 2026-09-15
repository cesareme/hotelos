// Facturación y cobros — /finanzas/facturacion (Tanda 5 · L1a · lote tabs-b).
//
// Item `BillingCenter` of the tree: base tab «Facturación y cobros» (the billing
// centre, 1.592 lines: lazy like every tab) plus the detail sub-URL Folio
// (FolioDetail, /finanzas/facturacion/folios/:id — was an orphan screen; painted
// only while the URL carries a folio), Rectificativas
// (InvoiceRectificationsScreen) and Enrutamiento de folios (FolioRouting).
// Labels, URLs and roles come from nav-tree.generated.json.
//
// L1b registers: screenKey BillingCenter · url /finanzas/facturacion · tabs
// /finanzas/facturacion/folios/:id, /rectificativas, /enrutamiento.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import type { ComponentType } from "react";
import { matchPath, urlForScreen } from "../../../navigation/nav-tree";
import { usePathname } from "../usePathname";

const FOLIO_URL = urlForScreen("FolioDetail") ?? "";

/** `:id` of the sub-URL becomes `folioId`; keyed by it so another folio remounts the screen. */
function FolioParam({ Screen }: { Screen: ComponentType<{ folioId?: string }> }) {
  const pathname = usePathname();
  const folioId = matchPath(FOLIO_URL, pathname)?.id;
  return <Screen key={folioId ?? ""} folioId={folioId} />;
}

const LOADERS: TabLoaders = {
  BillingCenter: () => import("../../billing/BillingCenterScreen").then((m) => ({ default: m.BillingCenterScreen })),
  FolioDetail: () => import("../../billing/FolioDetailScreen").then((m) => ({ default: () => <FolioParam Screen={m.FolioDetailScreen} /> })),
  InvoiceRectificationsScreen: () => import("../../invoicing/InvoiceRectificationsScreen").then((m) => ({ default: m.InvoiceRectificationsScreen })),
  FolioRouting: () => import("../../admin/FolioRoutingScreen").then((m) => ({ default: m.FolioRoutingScreen }))
};

function FacturacionTabs() {
  return <NavItemTabs screenKey="BillingCenter" loaders={LOADERS} subtitle="Folios, facturas y cobros; rectificativas y enrutamiento de cargos." />;
}

export default FacturacionTabs;
