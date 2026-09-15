// Puesta en marcha — /configuracion/puesta-en-marcha (Tanda 5 · L1a · lot tabs-c).
//
// The ONLY configuration hub (ConfigurationCenter, ManualSetupHub, PropertySetupHome,
// PropertySetupWizard and BackOfficeDashboard retire into it). Item
// `SetupCenterScreen`: base tab «Resumen» (SetupCenter) plus Salida en vivo
// (GoLiveChecklist, /salida-en-vivo) and Importar desde documentos (PropertyMapper,
// /importar-documentos). The dev-only «Migración asistida (dev)» hangs from this
// item in the tree at /desarrollo/migracion: it is not a tab of the strip but a
// header link painted only with dev mode on (?dev=1 or localStorage anfitorio.dev=1);
// the /desarrollo/* guard (admin token) is L1b's.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey SetupCenterScreen · url /configuracion/puesta-en-marcha · tabs
// /configuracion/puesta-en-marcha/salida-en-vivo, /importar-documentos · dev-only /desarrollo/migracion.

import { useMemo } from "react";
import { CocoaButton } from "../../../components/cocoa/CocoaButton";
import { openTabPath } from "../../../components/cocoa/CocoaRouteTabs";
import { DEV_MODE_STORAGE_KEY, NAV_TREE, isDevModeEnabled } from "../../../navigation/nav-tree";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed } from "../tab-helpers";

export const loaders: TabLoaders = {
  SetupCenterScreen: () => import("../../backoffice/SetupCenterScreen").then((m) => embed(m.SetupCenterScreen)),
  GoLiveChecklist: () => import("../../GoLiveChecklist").then((m) => ({ default: m.GoLiveChecklist })),
  PropertyMapper: () => import("../../PropertyMapper").then((m) => ({ default: m.PropertyMapper }))
};

/** Dev-only child of the item in the tree (`OnboardingProjects` → /desarrollo/migracion). */
export const migrationDevScreen = NAV_TREE.devOnly.find((screen) => screen.screenKey === "OnboardingProjects" && screen.parent === "SetupCenterScreen") ?? null;

function readDevStorage(): string | null {
  try {
    return window.localStorage.getItem(DEV_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function useDevMode(): boolean {
  return useMemo(() => (typeof window === "undefined" ? false : isDevModeEnabled({ search: window.location.search, storageValue: readDevStorage() })), []);
}

export default function PuestaEnMarchaTabs() {
  const devMode = useDevMode();
  const migration = devMode ? migrationDevScreen : null;
  return (
    <NavItemTabs
      screenKey="SetupCenterScreen"
      loaders={loaders}
      subtitle="Estado de la configuración de la propiedad, lista de comprobación para salir en vivo e importación asistida desde documentos."
      actions={
        migration ? (
          <CocoaButton variant="bordered" tone="neutral" onClick={() => openTabPath(migration.url)}>
            {migration.label}
          </CocoaButton>
        ) : undefined
      }
    />
  );
}
