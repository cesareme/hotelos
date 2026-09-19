// Live Timeline · tarjeta rápida al pasar el ratón (Tanda TL · lote TL-2).
//
// Contenido del CocoaPopover que ancla la pantalla al bloque: iniciales en
// el tono del estado, huésped y código, chips de estado / canal / habitación
// y seis hechos (entrada, salida, noches, ocupación, importe, segmento).
// UX-1 · U9b: con el dedo la tarjeta se abre al mantener pulsado (la misma
// pulsación que arma el arrastre) y la pista lo dice; si la reserva no admite
// cambiar fechas (en el hotel: el API responde 409 REC-03) la tarjeta muestra
// el motivo del motor en vez de callar por qué la barra no tiene asideros.
// Sin estilos inline: `.tl-quick` fija la anchura y `.tl-quick__facts` la rejilla.

import { CocoaBadge, CocoaStat } from "../cocoa";
import { channelLabel, date, marketSegmentLabel, money, plural } from "../../lib/format";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { BAR_KIND_LABEL, BAR_KIND_TONE, nightsOf, type BarKind, type DragPermission } from "../../screens/timeline/timeline-engine";
import type { AdminReservation, AdminRoom } from "../../services/pmsCommerceApi";
import { initials } from "./timeline-presentation";

export type TimelineQuickCardProps = {
  res: AdminReservation;
  /** Nombre del huésped (guestLabel del motor). */
  label: string;
  room?: AdminRoom;
  kind: BarKind;
  /** Permisos del arrastre (dragAllowed): explica por qué no se puede redimensionar o mover. */
  allowed?: Pick<DragPermission, "move" | "resize" | "room" | "reason">;
};

export const NO_ROOM_LABEL = "Sin habitación";
export const QUICK_CARD_HINT = "Haz clic para ver el detalle";
export const QUICK_CARD_HINT_TOUCH = "Toca para abrir el detalle · mantén pulsado y arrastra para mover";

/** Pista de la tarjeta según el puntero (puro). */
export function quickCardHint(coarse: boolean): string {
  return coarse ? QUICK_CARD_HINT_TOUCH : QUICK_CARD_HINT;
}

/** «2 ad.» · «2 ad. · 1 niño» · «1 ad. · 2 niños». */
export function occupancyLabel(adults: number, children: number): string {
  const base = `${adults} ad.`;
  return children > 0 ? `${base} · ${plural(children, "niño", "niños")}` : base;
}

export function TimelineQuickCard({ res, label, room, kind, allowed }: TimelineQuickCardProps) {
  const tone = BAR_KIND_TONE[kind];
  const coarse = useCoarsePointer();
  const restriction = allowed && (!allowed.resize || !allowed.move) ? allowed.reason : undefined;
  return (
    <div className="cocoa-stack tl-quick" data-gap="2">
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <CocoaBadge tone={tone} variant="tinted" aria-label={label}>
          {initials(label)}
        </CocoaBadge>
        <div className="cocoa-stack" data-gap="1">
          <strong>{label}</strong>
          <span className="cocoa-caption">{res.code}</span>
        </div>
      </div>
      <div className="cocoa-row" data-gap="1">
        <CocoaBadge tone={tone} variant="dot" size="small">
          {BAR_KIND_LABEL[kind]}
        </CocoaBadge>
        <CocoaBadge tone="neutral" size="small">
          {channelLabel(res.channel)}
        </CocoaBadge>
        <CocoaBadge tone="neutral" size="small">
          {room ? `Hab. ${room.number}` : NO_ROOM_LABEL}
        </CocoaBadge>
      </div>
      <div className="tl-quick__facts">
        <CocoaStat label="Entrada" value={date(res.arrivalDate, "weekdayShort")} tabular={false} />
        <CocoaStat label="Salida" value={date(res.departureDate, "weekdayShort")} tabular={false} />
        <CocoaStat label="Noches" value={nightsOf(res)} />
        <CocoaStat label="Ocupación" value={occupancyLabel(res.adults, res.children)} tabular={false} />
        <CocoaStat label="Importe" value={money(res.totalAmount, res.currency)} />
        <CocoaStat label="Segmento" value={marketSegmentLabel(res.marketSegment)} tabular={false} />
      </div>
      {restriction ? (
        <CocoaBadge tone="neutral" variant="outline" size="small">
          {restriction}
        </CocoaBadge>
      ) : null}
      <span className="cocoa-caption">{quickCardHint(coarse)}</span>
    </div>
  );
}

export default TimelineQuickCard;
