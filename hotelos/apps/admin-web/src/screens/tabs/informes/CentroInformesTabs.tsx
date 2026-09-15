// Centro de informes — /informes (Tanda 5 · L1a · lote tabs-b).
//
// Item `ReportingCenter` of the tree (one entry, was three): base tab «Centro de
// informes» plus Exportaciones de revenue (RevenueExportCenter, had no URL;
// gated by revenue_profit_engine and revenue/direccion/admin at tab level).
// Labels, URLs, roles and modules come from nav-tree.generated.json.
//
// L1b registers: screenKey ReportingCenter · url /informes · tab
// /informes/exportaciones-revenue.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ReportingCenter: () => import("../../reports/ReportingCenterScreen").then((m) => ({ default: m.ReportingCenterScreen })),
  RevenueExportCenter: () => import("../../revenue/RevenueExportCenter").then((m) => ({ default: m.RevenueExportCenter }))
};

function CentroInformesTabs() {
  return <NavItemTabs screenKey="ReportingCenter" loaders={LOADERS} subtitle="Informes de reservas, facturación y revenue, con sus exportaciones." />;
}

export default CentroInformesTabs;
