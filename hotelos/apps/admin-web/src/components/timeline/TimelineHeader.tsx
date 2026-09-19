// Live Timeline · cabecera de días (Tanda TL · lote TL-2).
//
// Fila sticky (`data-sticky-head`, cocoa-22-layout.css) con la esquina de
// recursos fija (`data-sticky-column`) y una celda por columna del rango:
// día de la semana + día/mes, hoy resaltado (aria-current="date") y los
// fines de semana en fondo agrupado. Sin estilos inline: la geometría la pone
// `.tl-grid__head` con `--tl-lead` / `--tl-days` / `--tl-col`.

import { date } from "../../lib/format";
import type { DayColumn } from "../../screens/timeline/timeline-engine";

export type TimelineHeaderProps = {
  columns: DayColumn[];
  /** Título de la columna de recursos (por defecto «Habitación»). */
  leadLabel?: string;
};

export const TIMELINE_LEAD_LABEL = "Habitación";

export function TimelineHeader({ columns, leadLabel = TIMELINE_LEAD_LABEL }: TimelineHeaderProps) {
  return (
    <div className="tl-grid__head" role="row" aria-rowindex={1} data-sticky-head="true">
      <div className="tl-head-cell" role="columnheader" data-sticky-column="true">
        {leadLabel}
      </div>
      {columns.map((col) => (
        <div
          key={col.key}
          className="tl-head-cell"
          role="columnheader"
          aria-current={col.isToday ? "date" : undefined}
          data-today={String(col.isToday)}
          data-weekend={String(col.isWeekend)}
        >
          <span>{date(col.date, "weekdayOnly")}</span>
          <strong>
            {date(col.date, "dayMonth")}
            {col.isToday ? " · hoy" : ""}
          </strong>
        </div>
      ))}
    </div>
  );
}

export default TimelineHeader;
