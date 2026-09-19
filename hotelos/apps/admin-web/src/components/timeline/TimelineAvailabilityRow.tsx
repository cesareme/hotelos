// Live Timeline · fila de disponibilidad por tipo (Tanda TL · lote TL-2).
//
// Fila de grupo (`tl-row--group`) con la celda de recursos fija: nombre del
// tipo, número de habitaciones y, si es colapsable, el botón Desplegar/Plegar
// (aria-expanded + aria-label con el nombre del tipo; sin aria-controls: las
// filas que pliega son varias y viven en una ventana virtual, así que no hay
// un único elemento al que apuntar). Una celda por día con las libres,
// coloreada por nivel (none/low/ok, availabilityLevel). Con `sticky` se pega
// bajo la cabecera (fila global «libres por tipo» de la pantalla).
// `aria-rowindex` es la posición absoluta en la parrilla. Sin estilos inline.

import { CocoaButton } from "../cocoa";
import { A11Y_LABELS } from "../../content/actions";
import { plural } from "../../lib/format";
import { availabilityLevel } from "./timeline-presentation";

export type TimelineAvailabilityRowProps = {
  label: string;
  /** Libres por columna del rango (puede ser negativo en overbooking). */
  counts: number[];
  /** Habitaciones vendibles del tipo (umbral del nivel «low»). */
  sellable: number;
  sticky?: boolean;
  collapsible?: { collapsed: boolean; onToggle(): void; roomCount: number };
  id?: string;
  /** aria-rowindex (1-based) de la fila en la parrilla. */
  rowIndex?: number;
};

/** «Desplegar Doble» / «Plegar Doble» (puro). */
export function toggleGroupLabel(collapsed: boolean, label: string): string {
  return `${collapsed ? A11Y_LABELS.expand : A11Y_LABELS.collapse} ${label}`;
}

export function TimelineAvailabilityRow({ label, counts, sellable, sticky = false, collapsible, id, rowIndex }: TimelineAvailabilityRowProps) {
  const className = "tl-row tl-row--group tl-avail" + (sticky ? " tl-avail--sticky" : "");
  return (
    <div className={className} role="row" id={id} aria-rowindex={rowIndex} data-collapsed={collapsible ? String(collapsible.collapsed) : undefined}>
      <div className="tl-lead" role="rowheader" data-sticky-column="true">
        {collapsible ? (
          <div className="cocoa-row" data-gap="1" data-wrap="nowrap">
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              aria-expanded={!collapsible.collapsed}
              aria-label={toggleGroupLabel(collapsible.collapsed, label)}
              onClick={collapsible.onToggle}
            >
              {collapsible.collapsed ? "›" : "⌄"}
            </CocoaButton>
            <strong>{label}</strong>
            <span className="cocoa-caption">{plural(collapsible.roomCount, "habitación", "habitaciones")}</span>
          </div>
        ) : (
          <strong>{label}</strong>
        )}
      </div>
      {counts.map((n, index) => (
        <span key={index} role="gridcell" className="tl-avail__cell cocoa-tabular" data-level={availabilityLevel(n, sellable)} aria-label={`${n} libres`}>
          {n}
        </span>
      ))}
    </div>
  );
}

export default TimelineAvailabilityRow;
