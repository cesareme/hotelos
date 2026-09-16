// Estructura societaria — /configuracion/estructura-societaria (Tanda 6b · L6).
//
// Item `StructureScreen`: base tab «Datos fiscales» (StructureScreen) plus Centros
// (StructurePropertiesTab, /centros), Series y VeriFactu (StructureSeriesTab,
// /series-verifactu), IVA y ejercicio (StructureVatTab, /iva-ejercicio) and
// Reparto (StructureAllocationTab, /reparto). Labels, URLs and roles come from
// nav-tree.generated.json (pilots/tanda5-nav-tree.csv): finanzas · direccion ·
// admin (finanzas reads; the write controls are gated inside each page with the
// real grants: organization.structure.manage, accounting.configure,
// billing.configure, ai.high_risk.confirm).
//
// Every tab is a CocoaPage hosted here that loads the same
// GET /organizations/me/structure (screens/structure/structure-model.ts) and
// paints the same split: sociedad card · detail (design §5.3). A hotel individual
// sees the same item with the card «Tu sociedad» (design §5.6).
//
// Registered in App.tsx: screenKey StructureScreen · url /configuracion/estructura-societaria ·
// tabs /centros, /series-verifactu, /iva-ejercicio, /reparto.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  StructureScreen: () => import("../../structure/StructureScreen").then((m) => ({ default: m.StructureScreen })),
  StructurePropertiesTab: () => import("../../structure/PropertiesTable").then((m) => ({ default: m.StructurePropertiesTab })),
  StructureSeriesTab: () => import("../../structure/SeriesAndInstallationsTab").then((m) => ({ default: m.StructureSeriesTab })),
  StructureVatTab: () => import("../../structure/VatAndFiscalYearTab").then((m) => ({ default: m.StructureVatTab })),
  StructureAllocationTab: () => import("../../structure/AllocationTab").then((m) => ({ default: m.StructureAllocationTab }))
};

export default function EstructuraSocietariaTabs() {
  return <NavItemTabs screenKey="StructureScreen" loaders={loaders} subtitle="Quién factura y dónde se trabaja: la sociedad (NIF, razón social, régimen) y sus centros de trabajo, series e instalaciones VeriFactu." />;
}
