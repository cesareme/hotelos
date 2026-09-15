// Conciliación bancaria — /finanzas/conciliacion (Tanda 5 · L1a · lote tabs-b).
//
// Item `BankReconciliationScreen` of the tree: base tab «Conciliación bancaria»
// plus Extractos y remesas (BankingSpain: CSB-43 statements and SEPA batches
// feed the reconciliation). Labels, URLs and roles come from
// nav-tree.generated.json.
//
// L1b registers: screenKey BankReconciliationScreen · url /finanzas/conciliacion ·
// tab /finanzas/conciliacion/extractos-remesas.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  BankReconciliationScreen: () => import("../../banking/BankReconciliationScreen").then((m) => ({ default: m.BankReconciliationScreen })),
  BankingSpain: () => import("../../banking/BankingSpainScreen").then((m) => ({ default: m.BankingSpainScreen }))
};

function ConciliacionTabs() {
  return <NavItemTabs screenKey="BankReconciliationScreen" loaders={LOADERS} subtitle="Extractos bancarios frente a los pagos del hotel, con importación CSB-43 y remesas SEPA." />;
}

export default ConciliacionTabs;
