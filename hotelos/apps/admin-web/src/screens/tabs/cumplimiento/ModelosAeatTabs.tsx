// Modelos AEAT — /cumplimiento/modelos-aeat (Tanda 5 · L1a · lot tabs-c;
// Tanda 6 · lote nav-services: 347, libros de IVA y liquidación; Cocoa 22 ·
// ola 8 · lote 8-B: every screen reads useTabHost(), no embed() bridge left).
//
// Item `Modelo303Screen`: base tab «Modelo 303» plus Modelo 390 · 347 · 111 ·
// 115 · 180 (one screen per model, /cumplimiento/modelos-aeat/<modelo>),
// Libros de IVA (VatBooksScreen, /libros-iva) and Liquidación de IVA
// (VatSettlementScreen, /liquidacion-iva). Labels, URLs, roles and order come
// from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// Registered: screenKey Modelo303Screen · url /cumplimiento/modelos-aeat · tabs
// /cumplimiento/modelos-aeat/390, /347, /111, /115, /180, /libros-iva, /liquidacion-iva.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

export const loaders: TabLoaders = {
  Modelo303Screen: () => import("../../fiscal/Modelo303Screen").then((m) => ({ default: m.Modelo303Screen })),
  Modelo390Screen: () => import("../../fiscal/Modelo390Screen").then((m) => ({ default: m.Modelo390Screen })),
  Modelo347Screen: () => import("../../fiscal/Modelo347Screen").then((m) => ({ default: m.Modelo347Screen })),
  Modelo111Screen: () => import("../../fiscal/Modelo111Screen").then((m) => ({ default: m.Modelo111Screen })),
  Modelo115Screen: () => import("../../fiscal/Modelo115Screen").then((m) => ({ default: m.Modelo115Screen })),
  Modelo180Screen: () => import("../../fiscal/Modelo180Screen").then((m) => ({ default: m.Modelo180Screen })),
  VatBooksScreen: () => import("../../fiscal/VatBooksScreen").then((m) => ({ default: m.VatBooksScreen })),
  VatSettlementScreen: () => import("../../fiscal/VatSettlementScreen").then((m) => ({ default: m.VatSettlementScreen }))
};

export default function ModelosAeatTabs() {
  return (
    <NavItemTabs
      screenKey="Modelo303Screen"
      loaders={loaders}
      subtitle="Modelos de IVA e IRPF calculados desde los libros registro y las retenciones de la organización, con resumen para la presentación manual en la sede de la AEAT."
    />
  );
}
