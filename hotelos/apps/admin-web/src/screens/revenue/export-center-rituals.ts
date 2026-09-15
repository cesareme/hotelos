// Revenue rituals of the Export Center (Informes › Exportaciones de revenue).
// Pure data so the copy budget of the section header is unit-testable.
//
// Each ritual paints a plain CocoaSection: `title` (h2) with `meta` as the
// caption at its right, and `when` as a lead paragraph in the body, above the
// export cards. `meta` is nowrap by the section grammar (COCOA-22.md §3.5:
// «30 días», «vs LY»), so it must stay short — the full sentence lives in
// `when`, which wraps. Measured on 390 × 844 with the sentence in `meta`: the
// header overflowed the 356 px column by 88 px and `main` clipped it (qa#2).

import type { ExportDef } from "../../services/revenueExportApi";

export type Ritual = ExportDef["ritual"];

export type RitualMeta = {
  /** Section heading (h2). */
  title: string;
  /** Caption at the right of the heading: ≤ RITUAL_META_MAX_CHARS, no sentence. */
  meta: string;
  /** Lead sentence under the heading (wraps on phones). */
  when: string;
};

/** Longest caption that fits next to the heading on a 356 px column at 10 px (≈ 5,4 px per character with a 12 px gap). */
export const RITUAL_META_MAX_CHARS = 24;

export const RITUAL_ORDER: Ritual[] = ["diario", "semanal", "mensual"];

export const RITUAL_META: Record<Ritual, RitualMeta> = {
  diario: {
    title: "Ritual diario",
    meta: "7:00 · 15 min",
    when: "Cada mañana a las 7:00: repaso de pickup de 15 minutos para decidir acciones sobre la BAR del día."
  },
  semanal: {
    title: "Ritual semanal",
    meta: "miércoles",
    when: "Miércoles: reunión semanal de revenue con la vista del mes en curso y los tres siguientes."
  },
  mensual: {
    title: "Cierre mensual",
    meta: "día 1 de cada mes",
    when: "Día 1 de cada mes: cierre del mes anterior, día a día y por segmento/canal."
  }
};
