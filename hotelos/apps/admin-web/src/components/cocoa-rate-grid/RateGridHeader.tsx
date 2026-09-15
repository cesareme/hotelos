// RateGridHeader — sticky date header of the rate grid (virtualised columns).
//
// One absolutely positioned column header per VISIBLE date (colStart..colEnd)
// inside a sticky-top strip. Click selects the whole column (shift/ctrl
// extend). Shows weekday + day, month on the 1st, a "hoy" pill, weekend
// tint and an amber dot when the demand layer reports an event that day.

import { memo, type ReactElement } from "react";
import type { RateGridDemandDay } from "@hotelos/shared";
import { formatDateHeader, formatDateLong, isWeekend } from "./helpers";
import { RateGridDemandStrip } from "./RateGridDemandStrip";
import type { RateGridHeaderProps } from "./types";

function RateGridHeaderImpl(props: RateGridHeaderProps) {
  const { dates, today, demand, selectedColumns, onSelectColumn, cellWidth, labelWidth, headerHeight, colStart, colEnd, totalWidth, showDemand, demandStripHeight } = props;
  const demandByDate = new Map<string, RateGridDemandDay>();
  if (demand) for (const d of demand) demandByDate.set(d.date, d);
  const cols: ReactElement[] = [];
  for (let i = colStart; i <= colEnd && i < dates.length; i++) {
    const iso = dates[i];
    const { weekday, day, month, isFirstOfMonth } = formatDateHeader(iso);
    const weekend = isWeekend(iso);
    const isToday = iso === today;
    const events = demandByDate.get(iso)?.events ?? [];
    const cls = ["crg__colhead"];
    if (weekend) cls.push("crg__colhead--weekend");
    if (isToday) cls.push("crg__colhead--today");
    if (selectedColumns.has(i)) cls.push("crg__colhead--selected");
    const title = [formatDateLong(iso), isToday ? "hoy" : null, ...events.map((e) => `${e.name}${e.impact ? ` (${e.impact})` : ""}`)].filter(Boolean).join("\n");
    cols.push(
      <div
        key={iso}
        role="columnheader"
        aria-colindex={i + 2}
        aria-label={`${formatDateLong(iso)}${isToday ? ", hoy" : ""}${events.length ? `, ${events.length} evento${events.length === 1 ? "" : "s"}` : ""}. Clic para seleccionar la columna`}
        className={cls.join(" ")}
        style={{ left: labelWidth + i * cellWidth }}
        title={title}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          onSelectColumn(i, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
        }}
      >
        <span className="crg__colhead-wd">{weekday}</span>
        <span className="crg__colhead-day">{day}</span>
        {isFirstOfMonth || i === colStart ? <span className="crg__colhead-month">{month}</span> : null}
        {events.length ? <span className="crg__colhead-event" aria-hidden="true" /> : null}
      </div>
    );
  }
  return (
    <div role="row" aria-rowindex={1} className={`crg__header${showDemand ? " crg__header--demand" : ""}`} style={{ width: totalWidth, height: headerHeight + (showDemand ? demandStripHeight : 0) }}>
      <div role="columnheader" aria-colindex={1} className="crg__corner">
        <span>Tipo · plan</span>
        {showDemand ? <span style={{ fontSize: 10 }}>Ocupación · pickup 7d</span> : null}
      </div>
      {cols}
      {showDemand && demand ? <RateGridDemandStrip dates={dates} demand={demand} cellWidth={cellWidth} labelWidth={labelWidth} colStart={colStart} colEnd={colEnd} height={demandStripHeight} /> : null}
    </div>
  );
}

export const RateGridHeader = memo(RateGridHeaderImpl);
export default RateGridHeader;
