// Reputación y calidad — /comercial/reputacion (Tanda 5 · L1a · lote tabs-b).
//
// Item `ReputationDashboard` of the tree: base tab «Reseñas» (ReputationDashboard)
// plus Encuestas (SurveysDashboard) and Calidad (QualityDashboard); one item, one
// gate (reputation_quality). Labels, URLs, roles and modules come from
// nav-tree.generated.json.
//
// L1b registers: screenKey ReputationDashboard · url /comercial/reputacion · tabs
// /comercial/reputacion/encuestas, /calidad.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ReputationDashboard: () => import("../../operations/ReputationDashboard").then((m) => ({ default: m.ReputationDashboard })),
  SurveysDashboard: () => import("../../operations/SurveysDashboard").then((m) => ({ default: m.SurveysDashboard })),
  QualityDashboard: () => import("../../operations/QualityDashboard").then((m) => ({ default: m.QualityDashboard }))
};

function ReputacionTabs() {
  return <NavItemTabs screenKey="ReputationDashboard" loaders={LOADERS} subtitle="Reseñas, encuestas y casos de calidad en un solo lugar." />;
}

export default ReputacionTabs;
