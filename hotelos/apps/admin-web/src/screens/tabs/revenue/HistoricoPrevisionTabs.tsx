// Histórico y previsión — /revenue/historico-prevision (Tanda 5 · L1a · lote tabs-b).
//
// Item `RevenueHistoryForecastDashboard` of the tree: base tab «Histórico y
// previsión» (the board) plus Informe (RevenueHistoryForecastReport, had no URL)
// and Explorador (RevenueForecastExplorer, was under Configuración). Gate
// revenue_profit_engine from nav-tree.generated.json.
//
// L1b registers: screenKey RevenueHistoryForecastDashboard · url
// /revenue/historico-prevision · tabs /revenue/historico-prevision/informe, /explorador.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  RevenueHistoryForecastDashboard: () => import("../../revenue/RevenueHistoryForecastDashboard").then((m) => ({ default: m.RevenueHistoryForecastDashboard })),
  RevenueHistoryForecastReport: () => import("../../revenue/RevenueHistoryForecastReport").then((m) => ({ default: m.RevenueHistoryForecastReport })),
  RevenueForecastExplorer: () => import("../../revenue/RevenueForecastExplorer").then((m) => ({ default: m.RevenueForecastExplorer }))
};

function HistoricoPrevisionTabs() {
  return <NavItemTabs screenKey="RevenueHistoryForecastDashboard" loaders={LOADERS} subtitle="Ocupación, ingresos y previsión de la propiedad, con informe detallado y explorador." />;
}

export default HistoricoPrevisionTabs;
