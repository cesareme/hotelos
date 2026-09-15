// RateGridDemandStrip — thin demand layer under the date header.
//
// Per visible date: occupancy % on the books (bold), forecast / pickup 7d
// beneath, and a tiny bar coloured by pressure (>85 % hot, >65 % warm).
// Compset median and STLY are exposed in the tooltip, not drawn, to keep
// the strip legible at 68–84 px per column.

import { memo } from "react";
import type { RateGridDemandDay } from "@hotelos/shared";
import { formatDateLong, formatMoney } from "./helpers";
import type { RateGridDemandStripProps } from "./types";

function tooltip(d: RateGridDemandDay): string {
  const parts = [formatDateLong(d.date), `Ocupación OTB: ${Math.round(d.occPct)} % (${d.otbRooms} hab.)`];
  if (d.fcOccPct !== null && d.fcOccPct !== undefined) parts.push(`Previsión: ${Math.round(d.fcOccPct)} %${d.fcSource ? ` (${d.fcSource})` : ""}`);
  if (d.pickup7 !== null && d.pickup7 !== undefined) parts.push(`Pickup 7 días: ${d.pickup7 >= 0 ? "+" : ""}${d.pickup7}`);
  if (d.stlyOccPct !== null && d.stlyOccPct !== undefined) parts.push(`Mismo día año anterior: ${Math.round(d.stlyOccPct)} %${d.stlyAdr ? ` · ADR ${formatMoney(d.stlyAdr)}` : ""}`);
  if (d.compsetMedian !== null && d.compsetMedian !== undefined) parts.push(`Mediana compset: ${formatMoney(d.compsetMedian)}`);
  for (const e of d.events) parts.push(`Evento: ${e.name}${e.impact ? ` (${e.impact})` : ""}`);
  return parts.join("\n");
}

function RateGridDemandStripImpl({ dates, demand, cellWidth, labelWidth, colStart, colEnd, height }: RateGridDemandStripProps) {
  const byDate = new Map(demand.map((d) => [d.date, d]));
  const cells = [];
  for (let i = colStart; i <= colEnd && i < dates.length; i++) {
    const d = byDate.get(dates[i]);
    const occ = d ? Math.round(d.occPct) : null;
    const cls = ["crg__demand-cell"];
    if (occ !== null && occ >= 85) cls.push("crg__demand-cell--hot");
    else if (occ !== null && occ >= 65) cls.push("crg__demand-cell--warm");
    cells.push(
      <div key={dates[i]} className={cls.join(" ")} style={{ left: labelWidth + i * cellWidth }} title={d ? tooltip(d) : "Sin datos de demanda"} aria-label={d ? tooltip(d).replace(/\n/g, ". ") : undefined}>
        {d ? (
          <>
            <span className="crg__demand-occ">{occ} %</span>
            <span>
              {d.fcOccPct !== null && d.fcOccPct !== undefined ? `prev ${Math.round(d.fcOccPct)}` : d.pickup7 !== null && d.pickup7 !== undefined ? `pickup ${d.pickup7 >= 0 ? "+" : ""}${d.pickup7}` : "—"}
            </span>
            <span className="crg__demand-bar" aria-hidden="true">
              <i style={{ width: `${Math.max(0, Math.min(100, occ ?? 0))}%` }} />
            </span>
          </>
        ) : (
          <span>—</span>
        )}
      </div>
    );
  }
  return (
    <div className="crg__demand" style={{ height }} role="presentation">
      {cells}
    </div>
  );
}

export const RateGridDemandStrip = memo(RateGridDemandStripImpl);
export default RateGridDemandStrip;
