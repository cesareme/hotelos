// Parrilla de tarifas — /revenue/parrilla (Tanda 5 · L1a · lote tabs-b).
//
// Item `RateGridEditorScreen` of the tree: base tab «Parrilla de tarifas» (the
// editor) plus Historial (RateJournalScreen, the same HistoryDrawer). Rate Grid
// v2 (commit 78edb35) is placed as tabs, functionality untouched: the editor
// vetoes `hotelos-tab-nav` while a draft is pending exactly like `hotelos-nav`
// and commits the tab switch once the user confirms. Gate revenue_profit_engine.
//
// L1b registers: screenKey RateGridEditorScreen · url /revenue/parrilla · tab
// /revenue/parrilla/historial.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  RateGridEditorScreen: () => import("../../revenue/RateGridEditorScreen").then((m) => ({ default: m.RateGridEditorScreen })),
  RateJournalScreen: () => import("../../revenue/RateJournalScreen").then((m) => ({ default: m.RateJournalScreen }))
};

function ParrillaTabs() {
  return <NavItemTabs screenKey="RateGridEditorScreen" loaders={LOADERS} subtitle="Tarifas por fecha, tipo de habitación y plan, con el historial de cada cambio." />;
}

export default ParrillaTabs;
