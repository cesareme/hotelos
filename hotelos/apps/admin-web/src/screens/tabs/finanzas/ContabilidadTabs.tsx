// Contabilidad — /finanzas/contabilidad (Tanda 6 · Finanzas · lote nav-services).
//
// Item `JournalScreen` of the tree: base tab «Diario» plus Mayor (LedgerScreen),
// Plan de cuentas (ChartOfAccountsScreen), Ajustes (AccountingSettingsScreen),
// Cierre de ejercicio (YearEndCloseScreen, moved here from Estados contables:
// the year-end regularisation and closing are journal operations), Exportar
// a gestoría (GestoriaExportScreen) and Importar desde Sage 200
// (Sage200ImportScreen, Tanda 7c: wizard per lot kind, reconciliation and
// lot history with reversal). Labels, URLs and roles come from
// nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// Registered: screenKey JournalScreen · url /finanzas/contabilidad · tabs
// /finanzas/contabilidad/mayor, /plan-de-cuentas, /ajustes, /cierre-ejercicio,
// /exportar-gestoria, /importar-sage200. Read routes need
// accounting.reports.read (Recepción does not see the item).

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  JournalScreen: () => import("../../accounting/JournalScreen").then((m) => ({ default: m.JournalScreen })),
  LedgerScreen: () => import("../../accounting/LedgerScreen").then((m) => ({ default: m.LedgerScreen })),
  ChartOfAccountsScreen: () => import("../../accounting/ChartOfAccountsScreen").then((m) => ({ default: m.ChartOfAccountsScreen })),
  AccountingSettingsScreen: () => import("../../accounting/AccountingSettingsScreen").then((m) => ({ default: m.AccountingSettingsScreen })),
  YearEndCloseScreen: () => import("../../finance/YearEndCloseScreen").then((m) => ({ default: m.YearEndCloseScreen })),
  GestoriaExportScreen: () => import("../../accounting/GestoriaExportScreen").then((m) => ({ default: m.GestoriaExportScreen })),
  Sage200ImportScreen: () => import("../../accounting/Sage200ImportScreen").then((m) => ({ default: m.Sage200ImportScreen }))
};

function ContabilidadTabs() {
  return <NavItemTabs screenKey="JournalScreen" loaders={LOADERS} subtitle="Diario, mayor y plan de cuentas del PGC de Pymes; ajustes, cierre del ejercicio y exportación a la gestoría." />;
}

export default ContabilidadTabs;
