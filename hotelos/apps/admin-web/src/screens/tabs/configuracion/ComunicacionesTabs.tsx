// Comunicaciones — /configuracion/comunicaciones (Tanda 5 · L1a · lot tabs-c).
//
// Item `NotificationsScreen`: base tab «Plantillas y envíos» plus Correo entrante
// (EmailConnectorsScreen, /correo-entrante; direccion/admin: the real AI screen
// «correo → reserva» that used to hide behind a placeholder flag). The mock
// MessagingConnections and the DocumentTemplateManager alias retire into this item.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey NotificationsScreen · url /configuracion/comunicaciones · tab
// /configuracion/comunicaciones/correo-entrante.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed } from "../tab-helpers";

export const loaders: TabLoaders = {
  NotificationsScreen: () => import("../../notifications/NotificationsScreen").then((m) => embed(m.NotificationsScreen)),
  EmailConnectors: () => import("../../aiOperations/EmailConnectorsScreen").then((m) => ({ default: m.EmailConnectorsScreen }))
};

export default function ComunicacionesTabs() {
  return (
    <NavItemTabs
      screenKey="NotificationsScreen"
      loaders={loaders}
      subtitle="Plantillas y envíos por correo, SMS y WhatsApp, y buzones de correo entrante que la IA convierte en reservas."
    />
  );
}
