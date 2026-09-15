// Modelos AEAT — /cumplimiento/modelos-aeat (Tanda 5 · L1a · lot tabs-c).
//
// Item `Modelo303Screen`: base tab «Modelo 303» plus Modelo 111 · 115 · 180 · 390
// (one screen per model, /cumplimiento/modelos-aeat/<modelo>).
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey Modelo303Screen · url /cumplimiento/modelos-aeat · tabs
// /cumplimiento/modelos-aeat/111, /115, /180, /390.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed } from "../tab-helpers";

export const loaders: TabLoaders = {
  Modelo303Screen: () => import("../../fiscal/Modelo303Screen").then((m) => embed(m.Modelo303Screen)),
  Modelo111Screen: () => import("../../fiscal/Modelo111Screen").then((m) => embed(m.Modelo111Screen)),
  Modelo115Screen: () => import("../../fiscal/Modelo115Screen").then((m) => embed(m.Modelo115Screen)),
  Modelo180Screen: () => import("../../fiscal/Modelo180Screen").then((m) => embed(m.Modelo180Screen)),
  Modelo390Screen: () => import("../../fiscal/Modelo390Screen").then((m) => embed(m.Modelo390Screen))
};

export default function ModelosAeatTabs() {
  return (
    <NavItemTabs
      screenKey="Modelo303Screen"
      loaders={loaders}
      subtitle="Declaraciones de IVA e IRPF calculadas a partir de las facturas y retenciones de la propiedad."
    />
  );
}
