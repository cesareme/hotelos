// Estados contables — /finanzas/estados-contables (Tanda 5 · L1a · lote tabs-b).
//
// Item `TrialBalanceScreen` of the tree: base tab «Balance de comprobación» plus
// Balance de situación (BalanceSheetScreen), Flujos de efectivo (CashFlowScreen)
// and Cierre de ejercicio (YearEndCloseScreen, whose destructive confirmation
// stays inside the screen). Labels, URLs and roles come from
// nav-tree.generated.json.
//
// L1b registers: screenKey TrialBalanceScreen · url /finanzas/estados-contables ·
// tabs /finanzas/estados-contables/balance, /flujos, /cierre-ejercicio.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  TrialBalanceScreen: () => import("../../finance/TrialBalanceScreen").then((m) => ({ default: m.TrialBalanceScreen })),
  BalanceSheetScreen: () => import("../../finance/BalanceSheetScreen").then((m) => ({ default: m.BalanceSheetScreen })),
  CashFlowScreen: () => import("../../finance/CashFlowScreen").then((m) => ({ default: m.CashFlowScreen })),
  YearEndCloseScreen: () => import("../../finance/YearEndCloseScreen").then((m) => ({ default: m.YearEndCloseScreen }))
};

function EstadosContablesTabs() {
  return <NavItemTabs screenKey="TrialBalanceScreen" loaders={LOADERS} subtitle="Balance de comprobación, balance de situación, flujos de efectivo y cierre del ejercicio." />;
}

export default EstadosContablesTabs;
