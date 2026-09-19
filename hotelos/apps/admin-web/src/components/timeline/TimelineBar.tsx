// Live Timeline · bloque de reserva (Tanda TL · lote TL-2).
//
// `role="button"` con aria-label completo (código, huésped, estado, noches,
// habitación y fechas), aria-pressed = seleccionado, foco visible
// (`cocoa-focus-ring`). El color viene del tono (`data-tone` → `--c22-tone*`
// en cocoa-22.css) y el estado visual de `data-kind` / `data-dragging` /
// `data-continues-*`. Los asideros de redimensión son <span> sin foco (la
// misma acción existe por teclado y en el inspector). El teclado (flechas,
// Intro, Espacio, Escape) lo resuelve la parrilla en un único sitio
// (`onKeyDown`). ÚNICO estilo inline del lote: la geometría del bloque como
// variables CSS (el objeto de barVars con cast a CSSProperties), nunca un literal.
//
// memo: la pantalla pinta 120 habitaciones × 31 días; el hover global no debe
// re-renderizar cada bloque (los callbacks deben ser estables en TL-3).

import { memo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { dateRange, money, plural } from "../../lib/format";
import { BAR_KIND_LABEL, type BarGeometry, type BarModel, type DragMode } from "../../screens/timeline/timeline-engine";
import { barVars } from "./timeline-presentation";

export type TimelineBarProps = {
  bar: BarModel;
  geometry: BarGeometry;
  /** Nombre del huésped (o «Sin huésped» / «Huésped pendiente», guestLabel del motor). */
  label: string;
  /** «Hab. 202» o «Sin asignar»: entra en el aria-label. */
  roomLabel?: string;
  selected: boolean;
  dragging: boolean;
  /** Solo el bloque activo es tab stop (roving tabindex de la parrilla). */
  focusable: boolean;
  allowed: { move: boolean; resize: boolean; room: boolean };
  onPointerDown(e: ReactPointerEvent<HTMLElement>, mode: DragMode): void;
  /** Elemento bajo el ratón / con foco (ancla de la tarjeta rápida) o null al salir. */
  onHover(el: HTMLElement | null): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void;
};

const DAY_MONTH = { style: "dayMonth" } as const;

/** «Reserva RA-1 de Ana Pérez, Llega hoy, 3 noches, Hab. 202, 21 sept – 24 sept» (puro). */
export function barAriaLabel(bar: Pick<BarModel, "res" | "kind" | "nights">, label: string, roomLabel?: string): string {
  const parts = [`Reserva ${bar.res.code} de ${label}`, BAR_KIND_LABEL[bar.kind], plural(bar.nights, "noche", "noches")];
  if (roomLabel) parts.push(roomLabel);
  parts.push(dateRange(bar.res.arrivalDate, bar.res.departureDate, DAY_MONTH));
  return parts.join(", ");
}

export const TimelineBar = memo(function TimelineBar(props: TimelineBarProps) {
  const { bar, geometry, label, roomLabel, selected, dragging, focusable, allowed, onPointerDown, onHover, onKeyDown } = props;
  const { res, kind, nights, continuesLeft, continuesRight } = bar;
  const kindLabel = BAR_KIND_LABEL[kind];
  const nightsLabel = plural(nights, "noche", "noches");
  const locked = !allowed.move && !allowed.room;

  return (
    <div
      role="button"
      tabIndex={focusable ? 0 : -1}
      className="tl-bar cocoa-focus-ring"
      data-tone={bar.tone}
      data-kind={kind}
      data-dragging={String(dragging)}
      data-locked={String(locked)}
      data-continues-left={String(continuesLeft)}
      data-continues-right={String(continuesRight)}
      data-reservation-id={bar.id}
      aria-label={barAriaLabel(bar, label, roomLabel)}
      aria-pressed={selected}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onMouseEnter={(e) => onHover(e.currentTarget)}
      onMouseLeave={() => onHover(null)}
      onFocus={(e) => onHover(e.currentTarget)}
      onBlur={() => onHover(null)}
      onKeyDown={onKeyDown}
      style={barVars(geometry) as CSSProperties}
    >
      <strong className="tl-bar__title">
        {continuesLeft ? "‹ " : ""}
        {label}
        {continuesRight ? " ›" : ""}
      </strong>
      <small className="tl-bar__meta">
        {kindLabel} · {nightsLabel} · {money(res.totalAmount, res.currency)}
      </small>
      {allowed.resize ? (
        <>
          <span
            className="tl-bar__handle"
            data-edge="start"
            aria-hidden="true"
            onPointerDown={(e) => {
              e.stopPropagation();
              onPointerDown(e, "resize-start");
            }}
          />
          <span
            className="tl-bar__handle"
            data-edge="end"
            aria-hidden="true"
            onPointerDown={(e) => {
              e.stopPropagation();
              onPointerDown(e, "resize-end");
            }}
          />
        </>
      ) : null}
    </div>
  );
});

export default TimelineBar;
