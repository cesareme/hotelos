// RRHH y nóminas — /finanzas/nominas (Tanda RRHH · lote RRHH-11).
//
// Item `PayrollScreen` of the tree: base tab «Nóminas» (contratos · periodos con
// aprobación de dirección · recibos · coste de personal · incidencias del mes)
// plus Plantilla (HrEmployeesScreen, RRHH-8), Previsión de plantilla
// (HrForecastScreen, RRHH-9) and Panel RRHH (HrOverviewScreen, RRHH-9). Labels,
// URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv:
// PayrollScreen keep with baseTab «Nóminas»; merge-into rows orden 1-3); the
// container only supplies the lazy loader of each screen key, as
// TesoreriaTabs does. There is no `/rrhh` category (build-nav-tree CATEGORY_ORDER
// is fixed): RRHH lives as tabs of this Finanzas item, and the role home of the
// `rrhh` token keeps landing here (role-tokens.ts roleHome).
//
// Registered by RRHH-11: screenKey PayrollScreen · url /finanzas/nominas · tabs
// /finanzas/nominas/plantilla · /finanzas/nominas/prevision · /finanzas/nominas/panel.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  PayrollScreen: () => import("../../payroll/PayrollScreen").then((m) => ({ default: m.PayrollScreen })),
  HrEmployeesScreen: () => import("../../hr/HrEmployeesScreen").then((m) => ({ default: m.HrEmployeesScreen })),
  HrForecastScreen: () => import("../../hr/HrForecastScreen").then((m) => ({ default: m.HrForecastScreen })),
  HrOverviewScreen: () => import("../../hr/HrOverviewScreen").then((m) => ({ default: m.HrOverviewScreen }))
};

function NominasTabs() {
  return <NavItemTabs screenKey="PayrollScreen" loaders={LOADERS} subtitle="Nómina mensual con aprobación de dirección e incidencias para la gestoría; expedientes de la plantilla, previsión de personal por ocupación y la foto de RRHH del centro." />;
}

export default NominasTabs;
