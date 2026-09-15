// Sostenibilidad — /cumplimiento/sostenibilidad (Tanda 5 · L1a · lot tabs-c).
//
// Item `SustainabilityDashboard`: base tab «Panel» (emisiones, agua, residuos) plus
// Informe ESRS (EsrsReportScreen, /cumplimiento/sostenibilidad/esrs; not for mantenimiento).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey SustainabilityDashboard · url /cumplimiento/sostenibilidad · tab /cumplimiento/sostenibilidad/esrs.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed } from "../tab-helpers";

export const loaders: TabLoaders = {
  SustainabilityDashboard: () => import("../../operations/SustainabilityDashboard").then((m) => embed(m.SustainabilityDashboard)),
  EsrsReport: () => import("../../esrs/EsrsReportScreen").then((m) => ({ default: m.EsrsReportScreen }))
};

export default function SostenibilidadTabs() {
  return (
    <NavItemTabs
      screenKey="SustainabilityDashboard"
      loaders={loaders}
      subtitle="Emisiones, consumo de agua y residuos por habitación-noche, e informe de sostenibilidad ESRS."
    />
  );
}
