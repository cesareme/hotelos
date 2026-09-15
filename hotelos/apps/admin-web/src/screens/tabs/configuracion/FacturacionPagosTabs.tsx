// Facturación y pagos — /configuracion/facturacion-pagos (Tanda 5 · L1a · lot tabs-c).
//
// Item `BillingSettings`: base tab «Facturación» (series y registro VeriFactu) plus
// Pagos (PaymentSettings, /pagos: PSP y métodos de pago, honest «Ningún PSP conectado»).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey BillingSettings · url /configuracion/facturacion-pagos · tab
// /configuracion/facturacion-pagos/pagos.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  BillingSettings: () => import("../../BillingSettings").then((m) => ({ default: m.BillingSettings })),
  PaymentSettings: () => import("../../PaymentSettings").then((m) => ({ default: m.PaymentSettings }))
};

export default function FacturacionPagosTabs() {
  return (
    <NavItemTabs
      screenKey="BillingSettings"
      loaders={loaders}
      subtitle="Series de facturación, estado del registro VeriFactu y proveedores de pago de la propiedad."
    />
  );
}
