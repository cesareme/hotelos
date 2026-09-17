// Propiedad — /configuracion/propiedad (Tanda 5 · L1a · lot tabs-c).
//
// Item `PropertyProfileSetupForm`: base tab «Perfil» (datos legales y fiscales) plus
// Edificios · Plantas · Zonas · Departamentos (propertySetup forms), Categorías
// (CategoryManagerScreen), Campos personalizados (CustomFieldSetupForm) and the
// detail sub-URLs Categorías/:codigo (CategoryDetailScreen) and
// Categorías/:codigo/opciones/nueva (CategoryOptionForm): reachable by URL, painted
// only when the URL carries the code, which the screens receive as `categoryCode`.
// The mock ConfigurationPropertyProfileForm / PropertySettings / OrganizationSettings
// retire into this item.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey PropertyProfileSetupForm · url /configuracion/propiedad · tabs
// /configuracion/propiedad/edificios, /plantas, /zonas, /departamentos, /categorias,
// /categorias/:codigo, /categorias/:codigo/opciones/nueva, /campos-personalizados.

import type { ComponentType } from "react";
import { urlForScreen } from "../../../navigation/nav-tree";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { useRouteParam } from "../tab-helpers";

type CategoryScreen = ComponentType<{ categoryCode?: string }>;

/** Detail sub-URL: the category code travels in the URL (`:codigo`) and is re-read on every navigation. */
function CategoryParam({ Screen, screenKey }: { Screen: CategoryScreen; screenKey: string }) {
  const codigo = useRouteParam(urlForScreen(screenKey) ?? "", "codigo");
  return <Screen key={codigo ?? ""} categoryCode={codigo ?? undefined} />;
}

function withCategoryParam(Screen: CategoryScreen, screenKey: string): { default: ComponentType<Record<string, never>> } {
  const Tab = () => <CategoryParam Screen={Screen} screenKey={screenKey} />;
  Tab.displayName = `${screenKey}Tab`;
  return { default: Tab };
}

export const loaders: TabLoaders = {
  PropertyProfileSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.PropertyProfileSetupForm })),
  BuildingSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.BuildingSetupForm })),
  FloorSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.FloorSetupForm })),
  ZoneSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.ZoneSetupForm })),
  DepartmentSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.DepartmentSetupForm })),
  CategoryManagerScreen: () => import("../../backoffice/categories/CategoryManagerScreen").then((m) => ({ default: m.CategoryManagerScreen })),
  CategoryDetailScreen: () => import("../../backoffice/categories/CategoryDetailScreen").then((m) => withCategoryParam(m.CategoryDetailScreen, "CategoryDetailScreen")),
  CategoryOptionForm: () => import("../../backoffice/categories/CategoryOptionForm").then((m) => withCategoryParam(m.CategoryOptionForm, "CategoryOptionForm")),
  CustomFieldSetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.CustomFieldSetupForm }))
};

export default function PropiedadTabs() {
  return (
    <NavItemTabs
      screenKey="PropertyProfileSetupForm"
      loaders={loaders}
      subtitle="Datos legales y fiscales de la propiedad, estructura física y catálogos de configuración."
    />
  );
}
