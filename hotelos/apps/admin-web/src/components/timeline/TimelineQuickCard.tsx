// Live Timeline · tarjeta rápida al pasar el ratón (Tanda TL · lote TL-2).
//
// Contenido del CocoaPopover que ancla la pantalla al bloque: iniciales en
// el tono del estado, huésped y código, chips de estado / canal / habitación
// y seis hechos (entrada, salida, noches, ocupación, importe, segmento).
// Sin estilos inline: `.tl-quick` fija la anchura y `.tl-quick__facts` la rejilla.

import { CocoaBadge, CocoaStat } from "../cocoa";
import { channelLabel, date, marketSegmentLabel, money, plural } from "../../lib/format";
import { BAR_KIND_LABEL, BAR_KIND_TONE, nightsOf, type BarKind } from "../../screens/timeline/timeline-engine";
import type { AdminReservation, AdminRoom } from "../../services/pmsCommerceApi";
import { initials } from "./timeline-presentation";

export type TimelineQuickCardProps = {
  res: AdminReservation;
  /** Nombre del huésped (guestLabel del motor). */
  label: string;
  room?: AdminRoom;
  kind: BarKind;
};

export const NO_ROOM_LABEL = "Sin habitación";
export const QUICK_CARD_HINT = "Haz clic para ver el detalle";

/** «2 ad.» · «2 ad. · 1 niño» · «1 ad. · 2 niños». */
export function occupancyLabel(adults: number, children: number): string {
  const base = `${adults} ad.`;
  return children > 0 ? `${base} · ${plural(children, "niño", "niños")}` : base;
}

export function TimelineQuickCard({ res, label, room, kind }: TimelineQuickCardProps) {
  const tone = BAR_KIND_TONE[kind];
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
      <span className="cocoa-caption">{QUICK_CARD_HINT}</span>
    </div>
  );
}

export default TimelineQuickCard;
