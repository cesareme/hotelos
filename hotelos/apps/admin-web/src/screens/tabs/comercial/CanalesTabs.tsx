// Canales de venta — /comercial/canales (Tanda 5 · L1a · lote tabs-b).
//
// Item `ChannelAggregatorHub` of the tree: base tab «Canales de venta» (the
// channel manager) plus Correspondencias (ChannelMappings). Rate Grid v2
// (commit 78edb35) is placed as tabs, functionality untouched; gate
// distribution_hub from nav-tree.generated.json.
//
// L1b registers: screenKey ChannelAggregatorHub · url /comercial/canales · tab
// /comercial/canales/correspondencias (alias keys ChannelManagerDashboard and
// ChannelManagerSettings redirect here).

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  ChannelAggregatorHub: () => import("../../channelManager/ChannelAggregatorHub").then((m) => ({ default: m.ChannelAggregatorHub })),
  ChannelMappings: () => import("../../ChannelMappingsScreen").then((m) => ({ default: m.ChannelMappingsScreen }))
};

function CanalesTabs() {
  return <NavItemTabs screenKey="ChannelAggregatorHub" loaders={LOADERS} subtitle="Tarifas, disponibilidad y reservas de los canales de venta conectados." />;
}

export default CanalesTabs;
