// Registro de viajeros — /cumplimiento/registro-viajeros (Tanda 5 · L1a · lot tabs-c).
//
// Item `GuestRegisterSettings` («Spain Register ×4» → one screen): base tab
// «Partes de entrada» (GuestRegisterSettingsScreen) plus SES.Hospedajes
// (SesHospedajesSettingsScreen), Autoridades (AuthorityRoutingSettingsScreen,
// finanzas/direccion/admin) and Conservación (GuestRegisterRetentionSettingsScreen, idem).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey GuestRegisterSettings · url /cumplimiento/registro-viajeros · tabs
// /cumplimiento/registro-viajeros/ses-hospedajes, /autoridades, /conservacion.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  GuestRegisterSettings: () => import("../../compliance/GuestRegisterSettingsScreen").then((m) => ({ default: m.GuestRegisterSettingsScreen })),
  SesHospedajesSettings: () => import("../../compliance/SesHospedajesSettingsScreen").then((m) => ({ default: m.SesHospedajesSettingsScreen })),
  AuthorityRoutingSettings: () => import("../../compliance/AuthorityRoutingSettingsScreen").then((m) => ({ default: m.AuthorityRoutingSettingsScreen })),
  GuestRegisterRetentionSettings: () =>
    import("../../compliance/GuestRegisterRetentionSettingsScreen").then((m) => ({ default: m.GuestRegisterRetentionSettingsScreen }))
};

export default function RegistroViajerosTabs() {
  return (
    <NavItemTabs
      screenKey="GuestRegisterSettings"
      loaders={loaders}
      subtitle="Partes de entrada de viajeros (RD 933/2021), envío a SES.Hospedajes y a las autoridades, y conservación de los datos."
    />
  );
}
