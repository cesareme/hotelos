// Clientes y fidelización — /comercial/clientes (Tanda 5 · L1a · lote tabs-b).
//
// Item `CrmDashboard` of the tree: base tab «Clientes» (CrmDashboard) plus
// Segmentos (GuestSegmentsReal), Fidelización (LoyaltyDashboard), Programa
// (LoyaltyProgram) and Campañas (CampaignManagerReal); one item, one gate
// (guest_data_crm_loyalty). Labels, URLs, roles and modules come from
// nav-tree.generated.json; the hosted screens drop their own page header
// through useTabHost().
//
// L1b registers: screenKey CrmDashboard · url /comercial/clientes · tabs
// /comercial/clientes/segmentos, /fidelizacion, /programa, /campanas.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  CrmDashboard: () => import("../../operations/CrmDashboard").then((m) => ({ default: m.CrmDashboard })),
  GuestSegmentsReal: () => import("../../crm/GuestSegmentsScreen").then((m) => ({ default: m.GuestSegmentsScreen })),
  LoyaltyDashboard: () => import("../../operations/LoyaltyDashboard").then((m) => ({ default: m.LoyaltyDashboard })),
  LoyaltyProgram: () => import("../../loyalty/LoyaltyProgramScreen").then((m) => ({ default: m.LoyaltyProgramScreen })),
  CampaignManagerReal: () => import("../../marketing/CampaignManagerScreen").then((m) => ({ default: m.CampaignManagerScreen }))
};

function ClientesTabs() {
  return <NavItemTabs screenKey="CrmDashboard" loaders={LOADERS} subtitle="Contactos, segmentos, fidelización y campañas de la propiedad." />;
}

export default ClientesTabs;
