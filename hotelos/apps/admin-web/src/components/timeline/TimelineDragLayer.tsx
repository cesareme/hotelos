// Live Timeline · fantasma del arrastre (Tanda TL · lote TL-3).
//
// Copia del bloque arrastrado (`tl-bar tl-ghost`, aria-hidden, sin foco ni
// puntero) que TimelineGrid monta como `dragChild` DENTRO del `.tl-lane` de
// la fila origen, para que left/top coincidan con la barra original. El
// hook useTimelineDrag la mueve imperativamente con `style.setProperty`
// (`--tl-dx` / `--tl-dy` / anchura en resize) y marca `data-valid` según
// haya fila bajo el puntero. ÚNICO estilo inline: la geometría base como
// variables CSS (barVars de TL-2 con cast a CSSProperties).

import type { CSSProperties, RefObject } from "react";
import { money, plural } from "../../lib/format";
import { BAR_KIND_LABEL, type BarGeometry, type BarModel } from "../../screens/timeline/timeline-engine";
import { barVars } from "./timeline-presentation";

export type TimelineDragLayerProps = {
  ghostRef: RefObject<HTMLDivElement | null>;
  bar: BarModel | null;
  geometry: BarGeometry | null;
  /** Nombre del huésped (guestLabel del motor), como en TimelineBar. */
  label: string;
};

export function TimelineDragLayer({ ghostRef, bar, geometry, label }: TimelineDragLayerProps) {
  if (!bar || !geometry) return null;
  const { res, kind, nights, continuesLeft, continuesRight } = bar;
  return (
    <div
      ref={ghostRef}
      className="tl-bar tl-ghost"
      data-tone={bar.tone}
      data-kind={kind}
      data-continues-left={String(continuesLeft)}
      data-continues-right={String(continuesRight)}
      aria-hidden="true"
      style={barVars(geometry) as CSSProperties}
    >
      <strong className="tl-bar__title">
        {continuesLeft ? "‹ " : ""}
        {label}
        {continuesRight ? " ›" : ""}
      </strong>
      <small className="tl-bar__meta">
        {BAR_KIND_LABEL[kind]} · {plural(nights, "noche", "noches")} · {money(res.totalAmount, res.currency)}
      </small>
    </div>
  );
}

export default TimelineDragLayer;
