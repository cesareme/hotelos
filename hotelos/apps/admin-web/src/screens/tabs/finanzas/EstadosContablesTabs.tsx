// Estados contables — /finanzas/estados-contables (Tanda 5 · L1a · lote tabs-b;
// Tanda 6 · lote nav-services: PGC Pymes statements + USALI).
//
// Item `TrialBalanceScreen` of the tree: base tab «Sumas y saldos» plus
// Balance de situación (BalanceSheetScreen), Pérdidas y ganancias
// (ProfitAndLossScreen), Flujos de efectivo (CashFlowScreen), Cuentas anuales
// (AnnualAccountsScreen) and USALI (UsaliScreen). Cierre de ejercicio
// (YearEndCloseScreen) moved to Contabilidad (ContabilidadTabs) in Tanda 6.
// Labels, URLs and roles come from nav-tree.generated.json.
//
// Registered: screenKey TrialBalanceScreen · url /finanzas/estados-contables ·
// tabs /finanzas/estados-contables/balance, /perdidas-y-ganancias, /flujos,
// /cuentas-anuales, /usali.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  TrialBalanceScreen: () => import("../../finance/TrialBalanceScreen").then((m) => ({ default: m.TrialBalanceScreen })),
  BalanceSheetScreen: () => import("../../finance/BalanceSheetScreen").then((m) => ({ default: m.BalanceSheetScreen })),
  ProfitAndLossScreen: () => import("../../finance/ProfitAndLossScreen").then((m) => ({ default: m.ProfitAndLossScreen })),
  CashFlowScreen: () => import("../../finance/CashFlowScreen").then((m) => ({ default: m.CashFlowScreen })),
  AnnualAccountsScreen: () => import("../../finance/AnnualAccountsScreen").then((m) => ({ default: m.AnnualAccountsScreen })),
  UsaliScreen: () => import("../../finance/UsaliScreen").then((m) => ({ default: m.UsaliScreen }))
};

function EstadosContablesTabs() {
  return <NavItemTabs screenKey="TrialBalanceScreen" loaders={LOADERS} subtitle="Sumas y saldos, balance, pérdidas y ganancias, flujos de efectivo, cuentas anuales del modelo Pymes y presentación USALI." />;
}

export default EstadosContablesTabs;
