// Impuestos — /cumplimiento/impuestos (Tanda 5 · L1a · lot tabs-c).
//
// Item `PropertyTaxesScreen`: base tab «IVA, IGIC e IPSI» (tipos por concepto de
// folio) plus Tasa turística (TouristTaxScreen, /cumplimiento/impuestos/tasa-turistica).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey PropertyTaxesScreen · url /cumplimiento/impuestos · tab /cumplimiento/impuestos/tasa-turistica.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  PropertyTaxesScreen: () => import("../../compliance/PropertyTaxesScreen").then((m) => ({ default: m.PropertyTaxesScreen })),
  TouristTax: () => import("../../admin/TouristTaxScreen").then((m) => ({ default: m.TouristTaxScreen }))
};

export default function ImpuestosTabs() {
  return (
    <NavItemTabs
      screenKey="PropertyTaxesScreen"
      loaders={loaders}
      subtitle="Tipos de IVA, IGIC e IPSI por concepto de folio y tasa turística por comunidad autónoma."
    />
  );
}
