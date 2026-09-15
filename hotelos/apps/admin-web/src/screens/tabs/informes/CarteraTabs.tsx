// Cartera de propiedades — /informes/cartera (Tanda 5 · L1a · lote tabs-b).
//
// Item `PortfolioDashboard` of the tree: base tab «Cartera de propiedades» plus
// the detail sub-URL Detalle (PropertyDetailScreen, /informes/cartera/:propiedad;
// painted only while the URL names a property, whose id becomes `propertyId` —
// the screen falls back to the active property). Labels, URLs and roles come
// from nav-tree.generated.json.
//
// L1b registers: screenKey PortfolioDashboard · url /informes/cartera · tab
// /informes/cartera/:propiedad (PortfolioDashboard.openPropertyDetail then
// navigates with openTabPath(fillParams(url, { propiedad })) instead of the
// legacy /backoffice/property-detail).

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import type { ComponentType } from "react";
import { matchPath, urlForScreen } from "../../../navigation/nav-tree";
import { usePathname } from "../usePathname";

const PROPIEDAD_URL = urlForScreen("PropertyDetailScreen") ?? "";

/** `:propiedad` of the sub-URL becomes `propertyId`; keyed by it so another property remounts the screen. */
function PropiedadParam({ Screen }: { Screen: ComponentType<{ propertyId?: string }> }) {
  const pathname = usePathname();
  const propertyId = matchPath(PROPIEDAD_URL, pathname)?.propiedad;
  return <Screen key={propertyId ?? ""} propertyId={propertyId} />;
}

const LOADERS: TabLoaders = {
  PortfolioDashboard: () => import("../../operations/PortfolioDashboard").then((m) => ({ default: m.PortfolioDashboard })),
  PropertyDetailScreen: () => import("../../operations/PropertyDetailScreen").then((m) => ({ default: () => <PropiedadParam Screen={m.PropertyDetailScreen} /> }))
};

function CarteraTabs() {
  return <NavItemTabs screenKey="PortfolioDashboard" loaders={LOADERS} subtitle="Todas las propiedades de la organización y el detalle de cada una." />;
}

export default CarteraTabs;
