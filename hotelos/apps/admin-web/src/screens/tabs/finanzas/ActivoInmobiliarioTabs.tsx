// Activo inmobiliario — /finanzas/activo-inmobiliario (Tanda ACT · lote F4).
//
// Ítem `RealEstateAssetScreen` del árbol: pestaña base «Ficha» (finca del
// centro: unidades registrales y catastrales, cargas, tenencia vigente,
// valoraciones y alertas) más Documentación (RealEstateDocumentsScreen,
// /documentacion), Tributos (RealEstateTaxesScreen, /tributos), Obras
// (RealEstateWorksScreen, /obras), Inspecciones y seguros
// (RealEstateInspectionsScreen, /inspecciones) y Grupo (RealEstateGroupScreen,
// /grupo). Etiquetas, URL y roles salen de nav-tree.generated.json
// (pilots/tanda5-nav-tree.csv); aquí solo viven los cargadores perezosos.
//
// Registrado: screenKey RealEstateAssetScreen · url /finanzas/activo-inmobiliario ·
// pestañas /documentacion, /tributos, /obras, /inspecciones, /grupo.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  RealEstateAssetScreen: () => import("../../realEstate/RealEstateAssetScreen").then((m) => ({ default: m.RealEstateAssetScreen })),
  RealEstateDocumentsScreen: () => import("../../realEstate/RealEstateDocumentsScreen").then((m) => ({ default: m.RealEstateDocumentsScreen })),
  RealEstateTaxesScreen: () => import("../../realEstate/RealEstateTaxesScreen").then((m) => ({ default: m.RealEstateTaxesScreen })),
  RealEstateWorksScreen: () => import("../../realEstate/RealEstateWorksScreen").then((m) => ({ default: m.RealEstateWorksScreen })),
  RealEstateInspectionsScreen: () => import("../../realEstate/RealEstateInspectionsScreen").then((m) => ({ default: m.RealEstateInspectionsScreen })),
  RealEstateGroupScreen: () => import("../../realEstate/RealEstateGroupScreen").then((m) => ({ default: m.RealEstateGroupScreen }))
};

function ActivoInmobiliarioTabs() {
  return <NavItemTabs screenKey="RealEstateAssetScreen" loaders={LOADERS} subtitle="La finca de cada centro: unidades registrales y catastrales, cargas y tenencia, documentación con vigencia, tributos con su asiento propuesto, obras capitalizables, inspecciones y pólizas, y la vista del grupo." />;
}

export default ActivoInmobiliarioTabs;
