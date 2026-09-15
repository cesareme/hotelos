// Módulos e integraciones — /configuracion/modulos (Tanda 5 · L1a · lot tabs-c).
//
// Item `ModuleManager`: base tab «Módulos» (estado por propiedad from GET
// /backoffice/properties/:id/modules and, per module, the menu entries it
// unlocks — read from the tree, never retyped) plus Salud (ModuleHealthCenter,
// /salud) and Integraciones (MarketplaceCatalogScreen, /integraciones). The
// ModuleConfigurationCenter / IntegrationManager / IntegrationMarketplaceHome
// aliases retire into this item. Visible to dirección: L1b's RBAC deltas (§10)
// grant `modules.enable`, so the 13 entries that open 403 today become
// «Activar módulo» here.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey ModuleManager · url /configuracion/modulos · tabs
// /configuracion/modulos/salud, /integraciones.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed } from "../tab-helpers";

export const loaders: TabLoaders = {
  ModuleManager: () => import("../../ModuleManager").then((m) => ({ default: m.ModuleManager })),
  ModuleHealthCenter: () => import("../../ModuleHealthCenter").then((m) => embed(m.ModuleHealthCenter)),
  MarketplaceCatalog: () => import("../../marketplace/MarketplaceCatalogScreen").then((m) => ({ default: m.MarketplaceCatalogScreen }))
};

export default function ModulosTabs() {
  return (
    <NavItemTabs
      screenKey="ModuleManager"
      loaders={loaders}
      subtitle="Módulos activos en la propiedad, qué entradas del menú desbloquea cada uno, su salud y las integraciones disponibles."
    />
  );
}
