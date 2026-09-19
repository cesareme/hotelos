// Live Timeline · leyenda de colores por estado (Tanda TL · lote TL-2).
//
// Un CocoaBadge por cada entrada de LEGEND_ITEMS (los 8 BarKind con el tono
// de BAR_KIND_TONE + la habitación bloqueada). Sin estilos inline.

import { CocoaBadge } from "../cocoa";
import { LEGEND_ITEMS } from "./timeline-presentation";

export function TimelineLegend() {
  return (
    <div className="tl-legend" role="list" aria-label="Leyenda">
      {LEGEND_ITEMS.map((item) => (
        <span key={item.kind} role="listitem">
          <CocoaBadge size="small" tone={item.tone} variant={item.variant}>
            {item.label}
          </CocoaBadge>
        </span>
      ))}
    </div>
  );
}

export default TimelineLegend;
