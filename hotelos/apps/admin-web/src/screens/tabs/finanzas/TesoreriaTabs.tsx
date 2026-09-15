// Tesorería — /finanzas/tesoreria (Tanda 5 · L1a · lote tabs-b).
//
// Item `FinancePositionDashboard` of the tree: base tab «Tesorería» (cobros ·
// pagos · posición) plus Tipos de cambio (ExchangeRatesScreen). Labels, URLs
// and roles come from nav-tree.generated.json.
//
// L1b registers: screenKey FinancePositionDashboard · url /finanzas/tesoreria ·
// tab /finanzas/tesoreria/tipos-de-cambio.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  FinancePositionDashboard: () => import("../../operations/FinancePositionDashboard").then((m) => ({ default: m.FinancePositionDashboard })),
  ExchangeRatesScreen: () => import("../../finance/ExchangeRatesScreen").then((m) => ({ default: m.ExchangeRatesScreen }))
};

function TesoreriaTabs() {
  return <NavItemTabs screenKey="FinancePositionDashboard" loaders={LOADERS} subtitle="Cobros, pagos y posición de tesorería; tipos de cambio para facturas en otra divisa." />;
}

export default TesoreriaTabs;
